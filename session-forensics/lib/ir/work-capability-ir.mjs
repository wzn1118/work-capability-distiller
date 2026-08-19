import { buildEvidenceLedger, validateEvidenceLedger } from '../evidence/content-addressed-evidence.mjs';
import { buildCoverageMatrix } from '../quality/metric-eligibility-engine.mjs';
import { resolveSourceIdentity } from '../source-adapters/source-identity-resolver.mjs';
import { sha256, stableStringify } from './trace-ir.mjs';

export const WORK_CAPABILITY_IR_SCHEMA_VERSION = 'work-capability-ir/v2';

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function object(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function text(value, fallback = '', maximum = 12000) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

function normalizeSourceContract(contract, index) {
  const value = object(contract);
  const required = value.required !== false;
  const status = text(value.status, value.available === false ? 'missing' : 'satisfied', 60);
  return {
    id: text(value.id, `source-${String(index + 1).padStart(3, '0')}`, 180),
    type: text(value.type ?? value.sourceType, 'file', 120),
    role: text(value.role, '工作输入', 240),
    ref: text(value.ref ?? value.path ?? value.sourcePath, '', 2000) || null,
    packageRef: text(value.packageRef ?? value.relativePath, '', 1200) || null,
    sha256: text(value.sha256 ?? value.sourceHash, '', 128) || null,
    format: text(value.format, '', 120) || null,
    required,
    status,
    fields: array(value.fields).map((item) => text(item, '', 240)).filter(Boolean),
    limitations: array(value.limitations).map((item) => text(item, '', 1200)).filter(Boolean),
    evidenceRefs: array(value.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean),
  };
}

function normalizeExecutionGraph(graph, fallbackCapabilities = []) {
  const value = object(graph);
  const steps = array(value.steps).map((step, index) => ({
    id: text(step?.id, `step-${String(index + 1).padStart(3, '0')}`, 180),
    title: text(step?.title ?? step?.name ?? step?.instruction, `执行步骤 ${index + 1}`, 320),
    instruction: text(step?.instruction ?? step?.description ?? step?.action, '按证据执行并记录结果。', 4000),
    dependsOn: array(step?.dependsOn).map((item) => text(item, '', 180)).filter(Boolean),
    inputs: array(step?.inputs).map((item) => text(typeof item === 'object' ? item.id ?? item.ref : item, '', 500)).filter(Boolean),
    outputs: array(step?.outputs).map((item) => text(typeof item === 'object' ? item.id ?? item.ref : item, '', 500)).filter(Boolean),
    commands: array(step?.commands).map((item) => text(item, '', 2000)).filter(Boolean),
    evidenceRefs: array(step?.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean),
    retry: object(step?.retry, { maximumAttempts: 1 }),
    checkpoint: text(step?.checkpoint, '', 320) || null,
    rollback: text(step?.rollback ?? step?.onFailure, '保留现场并回到最近检查点。', 1200),
  }));
  return {
    schemaVersion: 'execution-graph/v2',
    steps: steps.length ? steps : array(fallbackCapabilities).map((capability, index) => ({
      id: `step-${String(index + 1).padStart(3, '0')}`,
      title: text(capability?.title ?? capability?.name, `执行能力 ${index + 1}`, 320),
      instruction: text(capability?.summary ?? capability?.description, '执行该能力并验证产物。', 4000),
      dependsOn: index ? [`step-${String(index).padStart(3, '0')}`] : [],
      inputs: [], outputs: [], commands: [],
      evidenceRefs: array(capability?.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean),
      retry: { maximumAttempts: 1 }, checkpoint: null,
      rollback: '保留现场并回到最近检查点。',
    })),
    acceptance: array(value.acceptance).map((item) => text(item, '', 1600)).filter(Boolean),
    checkpoints: array(value.checkpoints),
  };
}

export function workCapabilityFingerprint(workCapability) {
  const semantic = { ...workCapability };
  delete semantic.generatedAt;
  delete semantic.fingerprint;
  delete semantic.releaseDecision;
  delete semantic.evaluationDetail;
  return sha256(stableStringify(semantic));
}

export function createWorkCapabilityIR({
  runId,
  scope = 'single-conversation',
  userGoal,
  latestCorrections = [],
  requestedSubject = null,
  observedSubject = null,
  subjectIdentity = null,
  sourceContracts = [],
  observations = [],
  coverageMetrics = [],
  coverageMatrix = null,
  conflicts = [],
  evidence = [],
  evidenceGraph = null,
  executionGraph = null,
  semanticEvaluation = {},
  portability = {},
  releaseDecision = {},
  capabilities = [],
  domainProfile = {},
  provenance = {},
} = {}) {
  const normalizedSources = array(sourceContracts).map(normalizeSourceContract);
  const identity = subjectIdentity ?? resolveSourceIdentity({ requested: requestedSubject, observed: observedSubject, sources: normalizedSources });
  const ledger = evidenceGraph?.entries ? buildEvidenceLedger(evidenceGraph.entries) : buildEvidenceLedger(evidence);
  const matrix = coverageMatrix?.entries ? buildCoverageMatrix(coverageMatrix.entries) : buildCoverageMatrix(coverageMetrics);
  const normalizedCapabilities = array(capabilities).map((capability, index) => ({
    id: text(capability?.id, `capability-${String(index + 1).padStart(3, '0')}`, 180),
    priority: text(capability?.priority, 'P2', 16),
    title: text(capability?.title ?? capability?.name, `能力 ${index + 1}`, 320),
    summary: text(capability?.summary ?? capability?.description, '从真实工作运行中提炼的能力。', 3000),
    status: text(capability?.status, 'candidate', 80),
    evidenceRefs: array(capability?.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean),
    inputs: array(capability?.inputs),
    outputs: array(capability?.outputs),
    limitations: array(capability?.limitations).map((item) => text(item, '', 1200)).filter(Boolean),
  }));
  const workCapability = {
    schemaVersion: WORK_CAPABILITY_IR_SCHEMA_VERSION,
    runId: text(runId, `run-${sha256({ userGoal, sourceContracts }).slice(0, 20)}`, 180),
    generatedAt: new Date().toISOString(),
    scope: ['single-conversation', 'multi-conversation', 'project', 'multi-project'].includes(scope) ? scope : 'single-conversation',
    userGoal: text(userGoal, '从真实工作运行中提炼可执行能力。', 8000),
    latestCorrections: array(latestCorrections).map((item) => text(typeof item === 'object' ? item.text ?? item.content ?? item.description : item, '', 4000)).filter(Boolean),
    subjectIdentity: identity,
    sourceContracts: normalizedSources,
    observations: array(observations),
    coverageMatrix: matrix,
    conflicts: array(conflicts),
    evidenceGraph: ledger,
    executionGraph: normalizeExecutionGraph(executionGraph, normalizedCapabilities),
    semanticEvaluation: {
      status: text(semanticEvaluation.status, 'not-evaluated', 80),
      ruleVersion: text(semanticEvaluation.ruleVersion, '', 120) || null,
      modelVersion: text(semanticEvaluation.modelVersion, '', 240) || null,
      sampleSet: object(semanticEvaluation.sampleSet),
      metrics: object(semanticEvaluation.metrics),
      correctionCount: Number(semanticEvaluation.correctionCount || 0),
      evidenceRefs: array(semanticEvaluation.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean),
    },
    portability: {
      packageRelativePathsOnly: portability.packageRelativePathsOnly !== false,
      externalDependencies: array(portability.externalDependencies),
      missingResources: array(portability.missingResources),
      absoluteRuntimePaths: array(portability.absoluteRuntimePaths),
      secretsDetected: array(portability.secretsDetected),
      rebuildConditions: array(portability.rebuildConditions),
    },
    releaseDecision: {
      status: text(releaseDecision.status, 'candidate', 80),
      reason: text(releaseDecision.reason, '等待 G0-G9 发布门评估。', 1600),
      blockers: array(releaseDecision.blockers),
      restrictions: array(releaseDecision.restrictions),
    },
    capabilities: normalizedCapabilities,
    domainProfile: object(domainProfile),
    provenance: object(provenance),
  };
  return { ...workCapability, fingerprint: workCapabilityFingerprint(workCapability) };
}

export function validateWorkCapabilityIR(workCapability) {
  const errors = [];
  if (!workCapability || typeof workCapability !== 'object') errors.push('Work Capability IR 必须是对象。');
  if (workCapability?.schemaVersion !== WORK_CAPABILITY_IR_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${WORK_CAPABILITY_IR_SCHEMA_VERSION}。`);
  for (const field of ['runId', 'scope', 'userGoal', 'subjectIdentity', 'coverageMatrix', 'evidenceGraph', 'executionGraph', 'portability', 'releaseDecision', 'fingerprint']) {
    if (workCapability?.[field] === undefined || workCapability?.[field] === null || workCapability?.[field] === '') errors.push(`缺少 ${field}。`);
  }
  if (!Array.isArray(workCapability?.sourceContracts)) errors.push('sourceContracts 必须是数组。');
  const ledgerValidation = validateEvidenceLedger(workCapability?.evidenceGraph);
  errors.push(...ledgerValidation.errors);
  const evidenceIds = new Set((workCapability?.evidenceGraph?.entries ?? []).map((item) => item.evidenceId));
  for (const step of workCapability?.executionGraph?.steps ?? []) {
    for (const evidenceRef of step.evidenceRefs ?? []) if (!evidenceIds.has(evidenceRef)) errors.push(`执行步骤 ${step.id} 引用了不存在的证据 ${evidenceRef}。`);
  }
  if (workCapability?.fingerprint !== workCapabilityFingerprint(workCapability)) errors.push('fingerprint 与 IR 内容不一致。');
  return { valid: errors.length === 0, errors };
}
