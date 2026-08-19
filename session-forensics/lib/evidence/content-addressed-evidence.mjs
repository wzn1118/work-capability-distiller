import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const EVIDENCE_LEDGER_SCHEMA_VERSION = 'evidence-ledger/v2';
export const EVIDENCE_TRANSFORM_VERSION = 'work-capability-evidence/v2';

function text(value, fallback = '', maximum = 4096) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').trim();
  return (normalized || fallback).slice(0, maximum);
}

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

export function contentAddressedEvidenceId({
  sourceHash,
  recordKey,
  transformVersion = EVIDENCE_TRANSFORM_VERSION,
  claimType,
} = {}) {
  const identity = {
    sourceHash: text(sourceHash, 'unknown-source', 256),
    recordKey: text(recordKey, 'unknown-record', 1024),
    transformVersion: text(transformVersion, EVIDENCE_TRANSFORM_VERSION, 256),
    claimType: text(claimType, 'observation', 256),
  };
  return `ev-${sha256(stableStringify(identity))}`;
}

export function createEvidenceRecord({
  sourceHash,
  recordKey,
  transformVersion = EVIDENCE_TRANSFORM_VERSION,
  claimType = 'observation',
  sourceType = 'unknown',
  sourceRef = null,
  excerpt = null,
  metadata = {},
  links = [],
} = {}) {
  const evidenceId = contentAddressedEvidenceId({ sourceHash, recordKey, transformVersion, claimType });
  return {
    schemaVersion: EVIDENCE_LEDGER_SCHEMA_VERSION,
    evidenceId,
    sourceHash: text(sourceHash, 'unknown-source', 256),
    recordKey: text(recordKey, 'unknown-record', 1024),
    transformVersion: text(transformVersion, EVIDENCE_TRANSFORM_VERSION, 256),
    claimType: text(claimType, 'observation', 256),
    sourceType: text(sourceType, 'unknown', 128),
    sourceRef,
    excerpt: excerpt === null ? null : text(excerpt, '', 12000),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
    links: [...new Set(array(links).map((item) => text(typeof item === 'object' ? item.evidenceId ?? item.id : item, '', 96)).filter(Boolean))],
  };
}

export function buildEvidenceLedger(records = []) {
  const byId = new Map();
  for (const record of array(records)) {
    const normalized = record?.evidenceId ? record : createEvidenceRecord(record);
    if (!byId.has(normalized.evidenceId)) byId.set(normalized.evidenceId, normalized);
  }
  const entries = [...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  return {
    schemaVersion: EVIDENCE_LEDGER_SCHEMA_VERSION,
    addressing: 'sha256(sourceHash + recordKey + transformVersion + claimType)',
    recordCount: entries.length,
    entries,
    fingerprint: sha256(stableStringify(entries)),
  };
}

export function validateEvidenceLedger(ledger) {
  const errors = [];
  if (ledger?.schemaVersion !== EVIDENCE_LEDGER_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${EVIDENCE_LEDGER_SCHEMA_VERSION}。`);
  if (!Array.isArray(ledger?.entries)) errors.push('entries 必须是数组。');
  const ids = new Set();
  for (const [index, entry] of (ledger?.entries ?? []).entries()) {
    const expected = contentAddressedEvidenceId(entry);
    if (entry.evidenceId !== expected) errors.push(`第 ${index + 1} 条证据的 evidenceId 与内容地址不一致。`);
    if (ids.has(entry.evidenceId)) errors.push(`第 ${index + 1} 条证据的 evidenceId 重复。`);
    ids.add(entry.evidenceId);
  }
  return { valid: errors.length === 0, errors };
}
