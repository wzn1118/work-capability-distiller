import { sha256, stableStringify } from './trace-ir.mjs';

export const CAPABILITY_IR_SCHEMA_VERSION = 'capability-ir/v1';

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function text(value, fallback = '', maximum = 1200) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

function object(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function slug(value) {
  const normalized = text(value, 'capability').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `capability-${sha256(value).slice(0, 12)}`;
}

function normalizeStep(step, index) {
  const value = object(step);
  return {
    id: text(value.id, `step-${String(index + 1).padStart(2, '0')}`, 80),
    instruction: text(value.instruction ?? value.action ?? value.description, '执行该步骤。', 1600),
    toolContract: object(value.toolContract, { tools: array(value.tools).map((item) => text(item, '', 120)) }),
    evidenceRefs: array(value.evidenceRefs ?? value.evidence).map((item) => text(typeof item === 'object' ? item.id : item, '', 180)).filter(Boolean),
    confidence: object(value.confidence, { level: '待确认', score: 0 }),
    onFailure: text(value.onFailure ?? value.recovery, '保留现场，记录失败原因并等待重新执行。', 800),
  };
}

export function capabilityFingerprint(capability) {
  const semantic = {
    id: capability.id,
    title: capability.title,
    triggers: capability.triggers,
    preconditions: capability.preconditions,
    inputSchema: capability.inputSchema,
    steps: capability.steps,
    outputSchema: capability.outputSchema,
    acceptance: capability.acceptance,
    recovery: capability.recovery,
    security: capability.security,
  };
  return sha256(stableStringify(semantic));
}

export function createCapabilityIR({
  id,
  version = '0.1.0',
  title,
  summary,
  triggers = [],
  preconditions = [],
  inputSchema = {},
  steps = [],
  outputSchema = {},
  acceptance = [],
  recovery = [],
  security = {},
  provenance = {},
  evaluation = {},
} = {}) {
  const capability = {
    schemaVersion: CAPABILITY_IR_SCHEMA_VERSION,
    id: slug(id ?? title),
    version: text(version, '0.1.0', 40),
    title: text(title, '未命名专属能力', 240),
    summary: text(summary, '从可追溯会话证据中提炼出的可执行能力。', 1800),
    triggers: array(triggers).map((item) => text(typeof item === 'object' ? item.description ?? item.name : item, '', 600)).filter(Boolean),
    preconditions: array(preconditions).map((item) => text(typeof item === 'object' ? item.description ?? item.name : item, '', 600)).filter(Boolean),
    inputSchema: object(inputSchema),
    steps: array(steps).map(normalizeStep),
    outputSchema: object(outputSchema),
    acceptance: array(acceptance).map((item) => text(typeof item === 'object' ? item.description ?? item.name : item, '', 800)).filter(Boolean),
    recovery: array(recovery).map((item) => text(typeof item === 'object' ? item.description ?? item.name : item, '', 800)).filter(Boolean),
    security: {
      filesystem: array(security.filesystem).map((item) => text(item, '', 260)).filter(Boolean),
      commands: array(security.commands).map((item) => text(item, '', 260)).filter(Boolean),
      network: array(security.network).map((item) => text(item, '', 260)).filter(Boolean),
      secrets: text(security.secrets, '密钥只在运行时使用，不写入产物。', 400),
    },
    provenance: {
      sourceSessions: array(provenance.sourceSessions).map((item) => text(item, '', 120)).filter(Boolean),
      projectFingerprints: array(provenance.projectFingerprints).map((item) => text(item, '', 160)).filter(Boolean),
      evidenceGraphHash: provenance.evidenceGraphHash ?? null,
      evidenceRefs: array(provenance.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id : item, '', 180)).filter(Boolean),
    },
    evaluation: {
      static: evaluation.static ?? 'pending',
      contract: evaluation.contract ?? 'pending',
      replay: evaluation.replay ?? 'pending',
      heldout: evaluation.heldout ?? 'pending',
      canary: evaluation.canary ?? 'pending',
    },
  };
  capability.fingerprint = capabilityFingerprint(capability);
  return capability;
}

export function validateCapabilityIR(capability) {
  const errors = [];
  if (!capability || typeof capability !== 'object') errors.push('Capability IR 必须是对象。');
  if (capability?.schemaVersion !== CAPABILITY_IR_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${CAPABILITY_IR_SCHEMA_VERSION}。`);
  for (const field of ['id', 'version', 'title', 'summary']) if (!capability?.[field]) errors.push(`缺少 ${field}。`);
  if (!Array.isArray(capability?.steps) || capability.steps.length === 0) errors.push('steps 至少需要一个执行步骤。');
  for (const [index, step] of (capability?.steps ?? []).entries()) {
    if (!step.id || !step.instruction) errors.push(`步骤 ${index + 1} 缺少 id 或 instruction。`);
    if (!Array.isArray(step.evidenceRefs) || step.evidenceRefs.length === 0) errors.push(`步骤 ${index + 1} 缺少 evidenceRefs。`);
  }
  if (!capability?.provenance?.sourceSessions?.length) errors.push('provenance.sourceSessions 不能为空。');
  if (!capability?.fingerprint) errors.push('缺少 fingerprint。');
  return { valid: errors.length === 0, errors };
}
