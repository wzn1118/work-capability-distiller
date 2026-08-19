import { createEvidenceRecord } from './evidence/content-addressed-evidence.mjs';
import { compileWorkCapabilityTargets } from './compilers/work-capability-compiler.mjs';
import { createWorkCapabilityIR } from './ir/work-capability-ir.mjs';
import { buildCoverageGaps } from './quality/coverage-gap-state-machine.mjs';
import { buildSemanticEvaluationPlan } from './quality/semantic-evaluation-plan.mjs';
import { sha256 } from './ir/trace-ir.mjs';

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function text(value, fallback = '', maximum = 4000) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

function sessionScope(sourceSet, projectPortfolio) {
  const sessions = Number(sourceSet?.sessionCount || sourceSet?.sessions?.length || 0);
  const projects = Number(projectPortfolio?.projects?.length || 0);
  if (projects > 1) return 'multi-project';
  if (projects === 1) return 'project';
  return sessions > 1 ? 'multi-conversation' : 'single-conversation';
}

function sourceContracts(sourceSet, projectKnowledgeV4) {
  const sessions = array(sourceSet?.sessions).map((session, index) => ({
    id: `conversation-${String(index + 1).padStart(3, '0')}`,
    type: 'conversation',
    role: '来源会话',
    ref: session.sourcePath || session.sessionId,
    sha256: session.sha256 || null,
    format: session.sourcePath?.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'conversation-records',
    required: true,
    status: session.sessionId && session.sha256 ? 'satisfied' : 'missing',
    fields: ['用户目标', '最新修正', '工具调用', '文件变化', '验证结果'],
  }));
  const files = array(projectKnowledgeV4?.fileChangeMatrix).slice(0, 500).map((file, index) => {
    const fileHash = file.currentHash || file.sha256 || file.hash || null;
    return {
      id: `project-file-${String(index + 1).padStart(4, '0')}`,
      type: 'project-file',
      role: '关联项目文件',
      ref: file.path || file.currentPath || null,
      sha256: fileHash,
      required: false,
      status: file.path || file.currentPath ? 'satisfied' : 'missing',
      limitations: fileHash ? [] : ['当前记录没有文件哈希，仅作为关联线索。'],
    };
  });
  return [...sessions, ...files];
}

function stableEvidence(recommendation, sourceSet) {
  const sessions = new Map(array(sourceSet?.sessions).map((session) => [session.sessionId, session]));
  const mapping = new Map();
  const records = array(recommendation?.evidence).map((evidence) => {
    const session = sessions.get(evidence.sessionId);
    const sourceHash = session?.sha256 || sha256({ type: evidence.type, source: evidence.path || evidence.sessionId || evidence.id });
    const record = createEvidenceRecord({
      sourceHash,
      recordKey: evidence.id || evidence.path || evidence.title,
      claimType: evidence.type || 'observation',
      sourceType: evidence.type || 'recommendation',
      sourceRef: evidence.path || evidence.sessionId || evidence.id || null,
      excerpt: [evidence.title, evidence.detail].filter(Boolean).join('：'),
      metadata: { ...evidence, legacyEvidenceId: evidence.id || null },
    });
    if (evidence.id) mapping.set(evidence.id, record.evidenceId);
    return record;
  });
  return { records, mapping };
}

function coverageMetrics(recommendation, sourceSet, projectKnowledgeV4) {
  const sessions = array(sourceSet?.sessions);
  const priorities = array(recommendation?.priorities);
  const files = array(projectKnowledgeV4?.fileChangeMatrix);
  const metrics = [
    {
      metricId: 'conversation-source-integrity',
      name: '会话来源完整性',
      numerator: sessions.filter((item) => item.sessionId && item.sha256 && Number(item.recordCount || 0) > 0).length,
      denominator: sessions.length,
      scope: '本次选择的全部会话',
      method: '会话编号、来源哈希和记录数均存在时计为完整。',
      requiresCompleteCoverage: true,
    },
    {
      metricId: 'capability-evidence-linkage',
      name: '能力证据关联率',
      numerator: priorities.filter((item) => array(item.evidenceIds).length > 0).length,
      denominator: priorities.length,
      scope: '本次蒸馏出的全部 P0-P3 能力',
      method: '每项能力至少关联一条可寻址证据时计为完成。',
      requiresCompleteCoverage: true,
    },
  ];
  if (files.length) metrics.push({
    metricId: 'project-file-version-coverage',
    name: '项目文件版本证据覆盖率',
    numerator: files.filter((item) => item.currentHash || item.sha256 || item.hash || item.originalHash || item.gitStatus).length,
    denominator: files.length,
    scope: '蒸馏器识别的关联项目文件',
    method: '存在当前哈希、原始哈希或 Git 状态时计为具备版本证据。',
    limitations: ['此指标只评价关联文件，不代表项目目录中的所有文件。'],
  });
  return metrics;
}

function capabilities(recommendation, evidenceMapping) {
  return array(recommendation?.priorities).map((priority) => ({
    id: priority.id,
    priority: priority.distillationPriority?.level || priority.level || 'P2',
    title: priority.title,
    summary: priority.purpose || priority.expectedOutput,
    status: priority.distillationPriority?.level === 'P3' ? 'optional' : 'candidate',
    evidenceRefs: array(priority.evidenceIds).map((id) => evidenceMapping.get(id)).filter(Boolean),
    inputs: array(priority.affectedFiles),
    outputs: [priority.expectedOutput].filter(Boolean),
    limitations: array(priority.why).filter((item) => /缺少|未发现|失败|待确认/.test(item)),
  }));
}

function executionGraph(recommendation, evidenceMapping) {
  const priorities = array(recommendation?.priorities);
  return {
    steps: priorities.map((priority, index) => ({
      id: `execute-${String(index + 1).padStart(3, '0')}`,
      title: `${priority.distillationPriority?.level || priority.level || 'P2'}｜${priority.title}`,
      instruction: priority.agentExecutionPriority?.reason || priority.nextAction || priority.purpose,
      dependsOn: index ? [`execute-${String(index).padStart(3, '0')}`] : [],
      inputs: array(priority.affectedFiles),
      outputs: [priority.expectedOutput].filter(Boolean),
      evidenceRefs: array(priority.evidenceIds).map((id) => evidenceMapping.get(id)).filter(Boolean),
      retry: { maximumAttempts: 2, preserveFailedOutput: true },
      checkpoint: `checkpoint-${String(index + 1).padStart(3, '0')}`,
      rollback: '恢复到本步骤开始前的检查点，保留失败命令、文件差异和验证输出。',
    })),
    acceptance: ['产物存在且可打开。', '文件差异与用户目标一致。', '验证命令有明确结果。', '失败时存在可恢复检查点。'],
  };
}

export function buildPackageWorkCapability({
  runId,
  identity,
  requestedSubject = null,
  sourceSet,
  extraction,
  recommendation,
  projectKnowledgeV4,
  projectUnderstanding,
  projectPortfolio,
  ui,
  evaluationContext = {},
} = {}) {
  const evidence = stableEvidence(recommendation, sourceSet);
  const capabilityList = capabilities(recommendation, evidence.mapping);
  const workCapability = createWorkCapabilityIR({
    runId,
    scope: sessionScope(sourceSet, projectPortfolio),
    userGoal: recommendation?.summary?.headline || identity?.name,
    latestCorrections: array(extraction?.corrections),
    requestedSubject: requestedSubject || { name: identity?.name },
    observedSubject: { name: identity?.name, businessObject: identity?.naming?.contentTopics?.[0], evidenceRefs: evidence.records.slice(0, 5).map((item) => item.evidenceId) },
    sourceContracts: sourceContracts(sourceSet, projectKnowledgeV4),
    observations: array(recommendation?.priorities).map((priority) => ({
      id: priority.id,
      title: priority.title,
      priority: priority.distillationPriority,
      confidence: priority.evidenceConfidence,
      expectedOutput: priority.expectedOutput,
    })),
    coverageMetrics: coverageMetrics(recommendation, sourceSet, projectKnowledgeV4),
    conflicts: array(projectUnderstanding?.conflictRegister),
    evidence: evidence.records,
    executionGraph: executionGraph(recommendation, evidence.mapping),
    semanticEvaluation: {
      required: Boolean(ui?.semanticQuality?.requiresModelEvaluation),
      status: ui?.semanticQuality?.evaluationStatus || 'not-evaluated',
      ruleVersion: ui?.schemaVersion || null,
      modelVersion: ui?.ai?.model || null,
      correctionCount: array(extraction?.corrections).length,
    },
    portability: {
      packageRelativePathsOnly: true,
      externalDependencies: array(sourceSet?.sessions).map((item) => ({ type: 'source-conversation', ref: item.sourcePath, sha256: item.sha256 })),
      missingResources: [],
      absoluteRuntimePaths: [],
      secretsDetected: [],
      rebuildConditions: ['来源会话哈希一致', '项目文件变化时重新蒸馏', '身份或字段覆盖变化时重新评估发布门'],
    },
    capabilities: capabilityList,
    domainProfile: {
      slug: identity?.id,
      title: identity?.name,
      summary: recommendation?.summary?.headline,
      topics: identity?.naming?.contentTopics || [],
      visualProfile: ui?.visual || {},
      experience: ui?.experience || {},
      semanticEvaluationRequired: Boolean(ui?.semanticQuality?.requiresModelEvaluation),
    },
    provenance: {
      sourceSessions: array(sourceSet?.sessions).map((item) => ({ sessionId: item.sessionId, sha256: item.sha256, recordCount: item.recordCount })),
      recommendationSchemaVersion: recommendation?.schemaVersion || null,
      projectKnowledgeSchemaVersion: projectKnowledgeV4?.schemaVersion || null,
    },
  });
  const coverageGaps = buildCoverageGaps(workCapability.coverageMatrix, workCapability.capabilities);
  const semanticEvaluationPlan = buildSemanticEvaluationPlan(workCapability);
  return {
    ...compileWorkCapabilityTargets({ workCapability, evaluationContext }),
    coverageGaps,
    semanticEvaluationPlan,
  };
}

export function evidenceLedgerNdjson(workCapability) {
  return `${array(workCapability?.evidenceGraph?.entries).map((entry) => JSON.stringify(entry)).join('\n')}${workCapability?.evidenceGraph?.entries?.length ? '\n' : ''}`;
}
