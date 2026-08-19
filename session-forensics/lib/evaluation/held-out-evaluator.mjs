import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const HELD_OUT_EVALUATION_SCHEMA_VERSION = 'held-out-evaluation/v2';

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function sourceHashes(workCapability) {
  return new Set([
    ...array(workCapability?.provenance?.sourceSessions).map((item) => item?.sha256),
    ...array(workCapability?.sourceContracts).map((item) => item?.sha256),
  ].filter(Boolean).map(String));
}

export function evaluateHeldOutCandidate(workCapability = {}, candidate = null) {
  if (!candidate) return {
    schemaVersion: HELD_OUT_EVALUATION_SCHEMA_VERSION,
    status: 'pending',
    reason: '尚未提供未参与蒸馏的新任务或新数据。',
    requirements: ['独立来源哈希', '至少一项匹配能力', '实际输出', '验证通过结果'],
  };
  const sourceHash = String(candidate.sourceHash || '').trim();
  const overlaps = sourceHash && sourceHashes(workCapability).has(sourceHash);
  const capabilityIds = new Set(array(workCapability.capabilities).map((item) => item.id));
  const matchedCapabilities = [...new Set(array(candidate.matchedCapabilities).map(String).filter((id) => capabilityIds.has(id)))];
  const outputs = array(candidate.outputs).filter(Boolean);
  const checks = {
    sourceHashPresent: /^[a-f0-9]{64}$/i.test(sourceHash),
    sourceIndependent: Boolean(sourceHash) && !overlaps,
    capabilityMatched: matchedCapabilities.length > 0,
    outputProduced: outputs.length > 0,
    verificationPassed: candidate?.verification?.passed === true,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const result = {
    schemaVersion: HELD_OUT_EVALUATION_SCHEMA_VERSION,
    candidateId: candidate.id || `held-out-${sha256({ sourceHash, matchedCapabilities, outputs }).slice(0, 20)}`,
    sourceHash: sourceHash || null,
    sourceIndependent: checks.sourceIndependent,
    matchedCapabilities,
    outputs,
    verification: candidate.verification || null,
    checks,
    failedChecks,
    status: failedChecks.length ? 'fail' : 'pass',
    reason: failedChecks.length
      ? overlaps
        ? '留出输入与蒸馏来源哈希重复，不能作为新任务验收。'
        : `留出任务未满足：${failedChecks.join('、')}。`
      : '未参与蒸馏的新来源已完成能力匹配、产物生成和验证。',
  };
  return { ...result, fingerprint: sha256(stableStringify(result)) };
}

export const HELD_OUT_SUITE_SCHEMA_VERSION = 'held-out-suite/v3';

export function evaluateHeldOutSuite(workCapability = {}, candidates = []) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : candidates ? [candidates] : [];
  const requiredCapabilities = (Array.isArray(workCapability.capabilities) ? workCapability.capabilities : [])
    .filter((item) => ['P0', 'P1'].includes(String(item?.priority || '').toUpperCase()))
    .map((item) => ({ id: String(item.id || ''), priority: item.priority, title: item.title }))
    .filter((item) => item.id);
  const required = requiredCapabilities.length ? requiredCapabilities : (workCapability.capabilities || []).map((item) => ({ id: String(item.id || ''), priority: item.priority, title: item.title })).filter((item) => item.id);
  const evaluations = list.map((candidate) => evaluateHeldOutCandidate(workCapability, candidate));
  const passed = evaluations.filter((item) => item.status === 'pass');
  const validatedCapabilityIds = [...new Set(passed.flatMap((item) => item.matchedCapabilities || []))];
  const requiredIds = required.map((item) => item.id);
  const missingCapabilityIds = requiredIds.filter((id) => !validatedCapabilityIds.includes(id));
  const status = !evaluations.length
    ? 'pending'
    : missingCapabilityIds.length === 0 && passed.length > 0
      ? 'pass'
      : passed.length > 0
        ? 'pending'
        : 'fail';
  const reason = !evaluations.length
    ? '尚未提供未参与蒸馏的新任务或新数据。'
    : status === 'pass'
      ? `已用 ${passed.length} 项独立任务覆盖全部 ${required.length} 项核心能力。`
      : passed.length > 0
        ? `已通过 ${validatedCapabilityIds.length}/${required.length} 项核心能力，仍缺少 ${missingCapabilityIds.length} 项独立任务验证。`
        : '已提交的独立任务均未同时满足独立来源、真实产物和验证通过条件。';
  const result = {
    schemaVersion: HELD_OUT_SUITE_SCHEMA_VERSION,
    status,
    reason,
    requiredCapabilities: required,
    validatedCapabilityIds,
    missingCapabilityIds,
    coverage: { validated: validatedCapabilityIds.length, required: required.length, candidateCount: evaluations.length, passedCandidateCount: passed.length },
    candidates: evaluations,
  };
  return { ...result, fingerprint: sha256(stableStringify(result)) };
}
