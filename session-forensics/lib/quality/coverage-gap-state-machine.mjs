import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const COVERAGE_GAP_SCHEMA_VERSION = 'coverage-gap/v2';

export const COVERAGE_GAP_ACTIONS = Object.freeze({
  queue: { label: '补充数据并重新生成', target: 'queued' },
  collect: { label: '开始补充数据', target: 'collecting' },
  reconcile: { label: '开始对账', target: 'reconciling' },
  recompute: { label: '重新计算', target: 'recomputing' },
  resolve: { label: '标记为已解决', target: 'resolved' },
  lock: { label: '按当前数据锁定口径', target: 'locked' },
  exclude: { label: '暂不纳入能力包', target: 'excluded' },
  fail: { label: '记录处理失败', target: 'failed' },
  retry: { label: '重试', target: 'queued' },
});

const TRANSITIONS = Object.freeze({
  detected: new Set(['queue', 'lock', 'exclude']),
  queued: new Set(['collect', 'lock', 'exclude', 'fail']),
  collecting: new Set(['reconcile', 'fail']),
  reconciling: new Set(['recompute', 'fail']),
  recomputing: new Set(['resolve', 'fail']),
  failed: new Set(['retry', 'lock', 'exclude']),
  locked: new Set(['queue', 'exclude']),
  excluded: new Set(['queue']),
  resolved: new Set([]),
});

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function unique(values) {
  return [...new Set(array(values).map((item) => String(item || '').trim()).filter(Boolean))];
}

function availableActions(status) {
  return [...(TRANSITIONS[status] || new Set())].map((action) => ({ action, ...COVERAGE_GAP_ACTIONS[action] }));
}

export function coverageGapId(entry = {}) {
  return `gap-${sha256(stableStringify({
    metricId: entry.metricId || entry.id || entry.name,
    numerator: Number(entry.numerator || 0),
    denominator: Number(entry.denominator || 0),
    scope: entry.scope || '',
  })).slice(0, 24)}`;
}

export function buildCoverageGaps(coverageMatrix = {}, capabilities = []) {
  const capabilityIds = new Set(array(capabilities).map((item) => item?.id).filter(Boolean));
  const gaps = array(coverageMatrix?.entries)
    .filter((entry) => ['restricted', 'blocked', 'unknown'].includes(entry?.eligibility))
    .map((entry) => {
      const affectedCapabilities = unique(entry.affectedCapabilities).filter((id) => !capabilityIds.size || capabilityIds.has(id));
      const gap = {
        schemaVersion: COVERAGE_GAP_SCHEMA_VERSION,
        gapId: coverageGapId(entry),
        metricId: entry.metricId,
        title: `${entry.name || entry.metricId}需要处理`,
        status: 'detected',
        severity: entry.eligibility === 'blocked' ? 'blocking' : 'restricted',
        eligibility: entry.eligibility,
        numerator: Number(entry.numerator || 0),
        denominator: Number(entry.denominator || 0),
        coveragePercent: entry.coveragePercent ?? null,
        scope: entry.scope || '范围待确认',
        reason: entry.reason || '覆盖范围不足，发布前需要选择处理方式。',
        limitations: unique(entry.limitations),
        evidenceRefs: unique(entry.evidenceRefs),
        affectedCapabilities,
        impact: affectedCapabilities.length
          ? `影响 ${affectedCapabilities.length} 项能力的发布范围。`
          : '影响该指标对应结论的发布范围。',
        history: [],
      };
      return { ...gap, availableActions: availableActions(gap.status) };
    });
  return {
    schemaVersion: 'coverage-gap-register/v2',
    gaps,
    summary: summarizeCoverageGaps(gaps),
    fingerprint: sha256(stableStringify(gaps.map(({ history, availableActions: actions, ...gap }) => gap))),
  };
}

export function transitionCoverageGap(gap, action, { note = '', evidenceRefs = [], at = new Date().toISOString() } = {}) {
  if (!gap || typeof gap !== 'object') throw new Error('缺口记录不存在。');
  const definition = COVERAGE_GAP_ACTIONS[action];
  if (!definition) throw new Error(`未知缺口操作：${action}`);
  const allowed = TRANSITIONS[gap.status] || new Set();
  if (!allowed.has(action)) throw new Error(`当前状态“${gap.status}”不能执行“${definition.label}”。`);
  const event = {
    action,
    label: definition.label,
    from: gap.status,
    to: definition.target,
    at,
    note: String(note || '').trim() || null,
    evidenceRefs: unique(evidenceRefs),
  };
  const updated = {
    ...gap,
    status: definition.target,
    updatedAt: at,
    history: [...array(gap.history), event],
  };
  return { ...updated, availableActions: availableActions(updated.status) };
}

export function summarizeCoverageGaps(gaps = []) {
  const counts = { detected: 0, queued: 0, collecting: 0, reconciling: 0, recomputing: 0, resolved: 0, locked: 0, excluded: 0, failed: 0 };
  for (const gap of array(gaps)) counts[gap.status] = (counts[gap.status] || 0) + 1;
  const active = array(gaps).filter((gap) => !['resolved', 'locked', 'excluded'].includes(gap.status));
  return {
    total: array(gaps).length,
    active: active.length,
    blocking: active.filter((gap) => gap.severity === 'blocking').length,
    restricted: active.filter((gap) => gap.severity === 'restricted').length,
    counts,
  };
}
