import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const SOURCE_IDENTITY_SCHEMA_VERSION = 'source-identity/v2';

function text(value, fallback = '', maximum = 1200) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

function object(value) {
  if (typeof value === 'string') return { name: value };
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function comparable(value) {
  return text(value).toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeSubject(value) {
  const subject = object(value);
  return {
    platform: text(subject.platform, '', 120) || null,
    accountName: text(subject.accountName ?? subject.account_name, '', 240) || null,
    accountId: text(subject.accountId ?? subject.account_id, '', 240) || null,
    businessObject: text(subject.businessObject ?? subject.object, '', 320) || null,
    batchId: text(subject.batchId ?? subject.batch, '', 240) || null,
    name: text(subject.name ?? subject.title ?? subject.businessObject ?? subject.accountName, '', 320) || null,
    aliases: [...new Set(array(subject.aliases).map((item) => text(item, '', 240)).filter(Boolean))],
    evidenceRefs: [...new Set(array(subject.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean))],
  };
}

function identityValues(subject) {
  return [subject.accountId, subject.name, subject.accountName, subject.businessObject, ...subject.aliases].map(comparable).filter(Boolean);
}

export function resolveSourceIdentity({ requested = null, observed = null, sources = [] } = {}) {
  const requestedSubject = normalizeSubject(requested);
  const observedSubject = normalizeSubject(observed);
  const requestedValues = identityValues(requestedSubject);
  const observedValues = identityValues(observedSubject);
  const hasRequested = requestedValues.length > 0;
  const hasObserved = observedValues.length > 0;
  let match = null;
  let reason = '缺少目标对象或实际对象，需补充身份信息后发布。';
  if (hasRequested && hasObserved) {
    const requestedAccountId = comparable(requestedSubject.accountId);
    const observedAccountId = comparable(observedSubject.accountId);
    if (requestedAccountId && observedAccountId) {
      match = requestedAccountId === observedAccountId;
      reason = match ? '请求账号 ID 与实际账号 ID 一致。' : '请求账号 ID 与实际账号 ID 不一致。';
    } else {
      match = requestedValues.some((value) => observedValues.includes(value));
      reason = match ? '请求对象与实际对象的标准名称或别名一致。' : '请求对象与实际对象的名称、账号或别名均不一致。';
    }
  }
  const decision = match === true
    ? 'IDENTITY_MATCH'
    : match === false
      ? 'BLOCKED_IDENTITY_MISMATCH'
      : 'IDENTITY_REVIEW_REQUIRED';
  const identity = {
    schemaVersion: SOURCE_IDENTITY_SCHEMA_VERSION,
    requestedSubject,
    observedSubject,
    match,
    decision,
    reason,
    sourceCount: array(sources).length,
    sourceRefs: array(sources).map((item) => ({
      type: text(item?.type ?? item?.sourceType, 'unknown', 120),
      ref: text(item?.ref ?? item?.path ?? item?.sourcePath, '', 1200) || null,
      sha256: text(item?.sha256 ?? item?.sourceHash, '', 128) || null,
    })),
  };
  return { ...identity, fingerprint: sha256(stableStringify(identity)) };
}

export function assertIdentityForNaming(identity) {
  if (identity?.decision === 'BLOCKED_IDENTITY_MISMATCH') {
    throw new Error(`数据身份不一致：${identity.reason}`);
  }
  const subject = identity?.observedSubject ?? {};
  return subject.businessObject || subject.name || subject.accountName || '待确认业务对象';
}
