import { validateEvidenceLedger } from '../evidence/content-addressed-evidence.mjs';
import { validateWorkCapabilityIR } from '../ir/work-capability-ir.mjs';

export const WORK_GATE_ORDER = Object.freeze(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9']);

function result(status, reason, evidence = []) {
  return { status, reason, evidence: [...new Set((evidence || []).filter(Boolean))] };
}

function suppliedGate(context, name, fallbackReason) {
  const value = context?.results?.[name];
  if (!value) return result('pending', fallbackReason);
  if (typeof value === 'string') return result(value, `外部评估结果：${value}`);
  return result(value.status || 'pending', value.reason || fallbackReason, value.evidence || []);
}

function sourceContractGate(workCapability) {
  const contracts = workCapability?.sourceContracts ?? [];
  const missing = contracts.filter((item) => item.required && item.status !== 'satisfied');
  const unhashed = contracts.filter((item) => item.required && item.type === 'file' && !item.sha256);
  if (missing.length || unhashed.length) {
    return result('fail', `输入契约未满足：缺失 ${missing.length} 项，缺少哈希 ${unhashed.length} 项。`, [...missing, ...unhashed].map((item) => item.id));
  }
  return result('pass', '必需输入、格式和来源哈希已满足契约。', contracts.map((item) => item.id));
}

function evidenceGate(workCapability) {
  const validation = validateEvidenceLedger(workCapability?.evidenceGraph);
  const entries = workCapability?.evidenceGraph?.entries ?? [];
  const ids = new Set(entries.map((entry) => entry.evidenceId));
  const unresolved = [];
  for (const step of workCapability?.executionGraph?.steps ?? []) {
    for (const evidenceRef of step.evidenceRefs ?? []) if (!ids.has(evidenceRef)) unresolved.push(evidenceRef);
  }
  if (!validation.valid || unresolved.length) {
    return result('fail', '存在无效、漂移或无法解析的内容寻址证据。', [...validation.errors, ...unresolved]);
  }
  if (!entries.length) return result('pending', '证据账本为空，当前能力只能作为候选。');
  return result('pass', '结论和执行步骤可解析到稳定的内容寻址证据。', entries.map((entry) => entry.evidenceId));
}

function semanticGate(workCapability, context) {
  const evaluation = workCapability?.semanticEvaluation ?? {};
  const required = Boolean(workCapability?.domainProfile?.semanticEvaluationRequired || evaluation.required);
  if (!required) return result('pass', '当前能力不依赖模型语义结论，语义评估不适用。');
  const supplied = context?.results?.G5;
  if (supplied) return suppliedGate(context, 'G5', '语义评估等待外部结果。');
  if (evaluation.status === 'pass') return result('pass', '语义评估达到能力声明要求。', evaluation.evidenceRefs || []);
  if (evaluation.status === 'restricted') return result('restricted', '语义评估仅支持受限范围，能力声明已同步降级。', evaluation.evidenceRefs || []);
  if (evaluation.status === 'fail') return result('fail', '语义评估未达到能力声明要求。', evaluation.evidenceRefs || []);
  return result('pending', '语义能力尚未完成分层抽样、人工修正和评估。');
}

function portabilityGate(workCapability) {
  const portability = workCapability?.portability ?? {};
  const blockers = [
    ...(portability.missingResources ?? []).map((item) => `缺失资源：${typeof item === 'object' ? item.ref ?? item.id : item}`),
    ...(portability.absoluteRuntimePaths ?? []).map((item) => `绝对运行路径：${typeof item === 'object' ? item.ref ?? item.path : item}`),
    ...(portability.secretsDetected ?? []).map((item) => `检测到密钥：${typeof item === 'object' ? item.ref ?? item.type : item}`),
  ];
  if (portability.packageRelativePathsOnly === false) blockers.push('包内运行路径不是相对路径');
  return blockers.length
    ? result('fail', '能力包存在不可移植资源、绝对运行路径或敏感信息。', blockers)
    : result('pass', '包内路径可移植，未登记缺失资源或敏感信息。');
}

export function evaluateWorkCapabilityGates(workCapability, context = {}) {
  const validation = validateWorkCapabilityIR(workCapability);
  const identity = workCapability?.subjectIdentity ?? {};
  const gates = {
    G0: validation.valid
      ? result('pass', 'Work Capability IR v2 结构和指纹有效。', ['schemaVersion', 'fingerprint'])
      : result('fail', `Work Capability IR v2 校验失败：${validation.errors.join('；')}`, validation.errors),
    G1: identity.match === true
      ? result('pass', '实际数据身份与用户目标一致。', identity.observedSubject?.evidenceRefs || [])
      : identity.match === false
        ? result('fail', `实际数据身份与用户目标不一致：${identity.reason || '身份冲突'}`, identity.observedSubject?.evidenceRefs || [])
        : result('pending', '数据身份尚未同时获得请求对象和实际对象，发布前需要确认。'),
    G2: sourceContractGate(workCapability),
    G3: evidenceGate(workCapability),
    G4: suppliedGate(context, 'G4', '尚未执行确定性统计复跑。'),
    G5: semanticGate(workCapability, context),
    G6: suppliedGate(context, 'G6', '尚未回放原会话中的成功任务。'),
    G7: suppliedGate(context, 'G7', '尚未使用未参与蒸馏的新任务或新数据验收。'),
    G8: portabilityGate(workCapability),
    G9: suppliedGate(context, 'G9', '尚未在隔离工作区验证独立 Agent 的读取、修改、验证和恢复闭环。'),
  };
  const failed = WORK_GATE_ORDER.filter((name) => gates[name].status === 'fail');
  const pending = WORK_GATE_ORDER.filter((name) => gates[name].status === 'pending');
  const restrictedGates = WORK_GATE_ORDER.filter((name) => gates[name].status === 'restricted');
  const coverageImpact = workCapability?.coverageMatrix?.summary?.releaseImpact ?? 'clear';
  const status = failed.length || coverageImpact === 'blocked'
    ? 'blocked'
    : pending.length
      ? 'candidate'
      : restrictedGates.length || coverageImpact === 'restricted'
        ? 'restricted'
        : 'publishable';
  const releaseDecision = {
    schemaVersion: 'release-decision/v2',
    status,
    reason: status === 'publishable'
      ? 'G0-G9 全部通过，指标覆盖满足声明。'
      : status === 'blocked'
        ? '存在硬阻断，能力包不得按目标对象发布。'
        : status === 'restricted'
          ? '基础门禁通过，但部分指标或语义能力仅限受控范围使用。'
          : '仍有待完成的回放、留出任务或隔离执行验证。',
    blockers: failed,
    pending,
    restrictions: [...restrictedGates, ...(coverageImpact === 'restricted' ? ['coverageMatrix'] : [])],
    evaluatedAt: new Date().toISOString(),
  };
  return {
    schemaVersion: 'work-capability-evaluation/v2',
    gates,
    failed,
    pending,
    restricted: restrictedGates,
    releaseDecision,
    defaultExecutionAllowed: status === 'publishable' || status === 'restricted',
  };
}

export function applyWorkCapabilityEvaluation(workCapability, context = {}) {
  const evaluation = evaluateWorkCapabilityGates(workCapability, context);
  const evaluated = { ...workCapability, releaseDecision: evaluation.releaseDecision, evaluationDetail: evaluation };
  return evaluated;
}
