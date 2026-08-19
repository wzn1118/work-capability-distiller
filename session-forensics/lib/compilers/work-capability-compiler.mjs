import { evaluateWorkCapabilityGates } from '../evaluation/work-gates.mjs';
import { validateWorkCapabilityIR } from '../ir/work-capability-ir.mjs';

export const WORK_COMPILER_TARGETS = Object.freeze(['skill', 'mcp', 'agent-ui']);

const TARGET_FILES = Object.freeze({
  skill: ['skill/SKILL.md'],
  mcp: ['mcp/server.mjs', 'mcp/tool-schema.json'],
  'agent-ui': ['agent/agent-server.mjs', 'agent/ui/index.html', 'agent/ui/app.js', 'agent/ui/styles.css', 'agent/ui/work-capability.json'],
});

function runtimeContract(workCapability, evaluation) {
  return {
    schemaVersion: 'work-capability-runtime/v2',
    workCapabilitySchemaVersion: workCapability.schemaVersion,
    runId: workCapability.runId,
    fingerprint: workCapability.fingerprint,
    releaseDecision: evaluation.releaseDecision,
    sharedArtifacts: {
      workCapability: 'work-capability-ir.v2.json',
      coverageMatrix: 'coverage-matrix.json',
      evidenceLedger: 'work-evidence-ledger.ndjson',
      executionGraph: 'execution-graph.json',
      releaseDecision: 'release-decision.json',
      coverageGaps: 'coverage-gaps.json',
      semanticEvaluationPlan: 'semantic-evaluation-plan.json',
      deterministicReplay: 'deterministic-replay.json',
      originalTaskReplay: 'original-task-replay.json',
      heldOutEvaluation: 'held-out-evaluation.json',
      isolatedAgentValidation: 'isolated-agent-validation.json',
    },
    loop: ['理解任务', '校验数据身份', '读取工作区', '执行任务图', '验证产物', '保留恢复点'],
  };
}

function targetPayload(workCapability, target, runtime) {
  const common = {
    target,
    files: TARGET_FILES[target],
    workCapabilityId: workCapability.runId,
    workCapabilityFingerprint: workCapability.fingerprint,
    source: { schemaVersion: workCapability.schemaVersion, provenance: workCapability.provenance },
    runtime,
    domainProfile: workCapability.domainProfile,
  };
  if (target === 'skill') return {
    ...common,
    entry: {
      name: workCapability.domainProfile?.slug || workCapability.runId,
      description: workCapability.userGoal,
      capabilities: workCapability.capabilities,
      executionGraph: workCapability.executionGraph,
    },
  };
  if (target === 'mcp') return {
    ...common,
    service: {
      name: workCapability.domainProfile?.slug || workCapability.runId,
      tools: workCapability.capabilities.map((item) => ({ name: item.id, description: item.summary, priority: item.priority })),
      resources: runtime.sharedArtifacts,
    },
  };
  return {
    ...common,
    viewModel: {
      title: workCapability.domainProfile?.title || workCapability.userGoal,
      summary: workCapability.domainProfile?.summary || workCapability.userGoal,
      visualProfile: workCapability.domainProfile?.visualProfile || { density: 'operational', accent: 'teal' },
      pages: [
        { id: 'overview', title: '能力总览', purpose: '直白展示这个能力包能做什么、适用范围和发布状态。' },
        { id: 'inputs', title: '输入与身份', purpose: '选择输入并确认实际业务对象，避免对象误标。' },
        { id: 'execute', title: '执行任务', purpose: '按任务图读取文件、执行命令、修改文件并显示实时状态。' },
        { id: 'evidence', title: '证据与差异', purpose: '从结论查看原始记录、文件版本、哈希和验证结果。' },
        { id: 'deliverables', title: '产物与恢复', purpose: '打开生成文件、查看验收结果并使用检查点恢复。' },
      ],
      capabilities: workCapability.capabilities,
      identity: workCapability.subjectIdentity,
      coverage: workCapability.coverageMatrix,
      executionGraph: workCapability.executionGraph,
      releaseDecision: runtime.releaseDecision,
    },
  };
}

export function compileWorkCapabilityTargets({ workCapability, targets = WORK_COMPILER_TARGETS, evaluationContext = {} } = {}) {
  const validation = validateWorkCapabilityIR(workCapability);
  if (!validation.valid) throw new Error(`Work Capability IR v2 未通过编译前校验：${validation.errors.join('；')}`);
  const evaluation = evaluateWorkCapabilityGates(workCapability, evaluationContext);
  const selectedTargets = [...new Set(targets)].filter((target) => WORK_COMPILER_TARGETS.includes(target));
  const runtime = runtimeContract(workCapability, evaluation);
  const compiled = selectedTargets.map((target) => targetPayload(workCapability, target, runtime));
  return {
    schemaVersion: 'work-capability-compiler-result/v2',
    workCapability: { ...workCapability, releaseDecision: evaluation.releaseDecision },
    evaluation,
    runtime,
    targets: compiled,
    summary: {
      targetCount: compiled.length,
      targetKinds: selectedTargets,
      capabilityCount: workCapability.capabilities.length,
      releaseStatus: evaluation.releaseDecision.status,
    },
  };
}
