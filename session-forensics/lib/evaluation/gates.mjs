import { validateCapabilityIR } from '../ir/capability-ir.mjs';

export const GATE_ORDER = Object.freeze(['G0', 'G1', 'G2', 'G3', 'G4', 'G5']);

function result(status, reason, evidence = []) {
  return { status, reason, evidence: [...new Set(evidence.filter(Boolean))] };
}

function hasEvidence(capability) {
  return (capability?.steps || []).every((step) => Array.isArray(step.evidenceRefs) && step.evidenceRefs.length > 0)
    && (capability?.provenance?.sourceSessions || []).length > 0;
}

function hasExecutableContract(capability) {
  return (capability?.steps || []).length > 0
    && typeof capability?.inputSchema === 'object'
    && typeof capability?.outputSchema === 'object'
    && (capability?.acceptance || []).length > 0;
}

function suppliedGate(context, name) {
  const value = context?.results?.[name];
  if (!value) return null;
  if (typeof value === 'string') return result(value, `外部评估结果：${value}`);
  return result(value.status || 'pending', value.reason || `外部评估结果：${name}`, value.evidence || []);
}

export function evaluateCapabilityGates(capability, context = {}) {
  const validation = validateCapabilityIR(capability);
  const gates = {
    G0: validation.valid
      ? result('pass', 'Capability IR 结构、版本和指纹符合当前契约。', ['schemaVersion', 'fingerprint'])
      : result('fail', `Capability IR 结构校验失败：${validation.errors.join('；')}`, validation.errors),
    G1: validation.valid && hasEvidence(capability)
      ? result('pass', '每个执行步骤都能回指来源会话或证据，且来源会话已登记。', capability.provenance?.evidenceRefs || [])
      : result('fail', '步骤证据或来源会话登记不完整，先补齐证据再发布。'),
    G2: validation.valid && hasExecutableContract(capability)
      ? result('pass', '输入、步骤、输出和验收条件已经形成可执行契约。', capability.acceptance || [])
      : result('fail', '输入、输出或验收条件缺少一项，暂不作为默认执行能力。'),
    G3: suppliedGate(context, 'G3') || result('pending', '尚未执行原会话回放；当前结果保留为候选能力。'),
    G4: suppliedGate(context, 'G4') || result('pending', '尚未提供留出任务集；需要用未参与蒸馏的新任务验证。'),
    G5: suppliedGate(context, 'G5') || result('pending', '尚未进行真实工作区灰度执行；需要在可回滚工作区中验证。'),
  };
  const failed = GATE_ORDER.filter((name) => gates[name].status === 'fail');
  const pending = GATE_ORDER.filter((name) => gates[name].status === 'pending');
  const publishability = failed.length ? 'blocked' : pending.length ? 'candidate' : 'publishable';
  return {
    schemaVersion: 'capability-evaluation/v1',
    gates,
    failed,
    pending,
    publishability,
    defaultExecutionAllowed: publishability === 'publishable',
    evaluatedAt: new Date().toISOString(),
  };
}

export function applyCapabilityEvaluation(capability, context = {}) {
  const evaluation = evaluateCapabilityGates(capability, context);
  return {
    ...capability,
    evaluation: {
      static: evaluation.gates.G0.status,
      contract: evaluation.gates.G2.status,
      replay: evaluation.gates.G3.status,
      heldout: evaluation.gates.G4.status,
      canary: evaluation.gates.G5.status,
    },
    evaluationDetail: evaluation,
  };
}
