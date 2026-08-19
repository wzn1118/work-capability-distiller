import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const COVERAGE_MATRIX_SCHEMA_VERSION = 'coverage-matrix/v2';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, fallback = '', maximum = 1600) {
  const normalized = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

export function evaluateMetricEligibility(metric = {}, options = {}) {
  const numerator = Math.max(0, number(metric.numerator ?? metric.available ?? metric.observed, 0));
  const denominator = Math.max(0, number(metric.denominator ?? metric.total, 0));
  const coverage = denominator > 0 ? Math.min(1, numerator / denominator) : null;
  const publishThreshold = Math.min(1, Math.max(0, number(metric.publishThreshold ?? options.publishThreshold, 0.95)));
  const restrictedThreshold = Math.min(publishThreshold, Math.max(0, number(metric.restrictedThreshold ?? options.restrictedThreshold, 0.5)));
  const requiresCompleteCoverage = Boolean(metric.requiresCompleteCoverage ?? options.requiresCompleteCoverage);
  let eligibility = 'unknown';
  let reason = '分母为空，尚未建立指标覆盖口径。';
  if (coverage !== null) {
    if (requiresCompleteCoverage && coverage < 1) {
      eligibility = coverage >= restrictedThreshold ? 'restricted' : 'blocked';
      reason = `该指标要求完整覆盖，当前覆盖 ${(coverage * 100).toFixed(2)}%。`;
    } else if (coverage >= publishThreshold) {
      eligibility = 'eligible';
      reason = `覆盖率达到发布阈值 ${(publishThreshold * 100).toFixed(0)}%。`;
    } else if (coverage >= restrictedThreshold) {
      eligibility = 'restricted';
      reason = `仅允许在已覆盖的 ${numerator}/${denominator} 个样本范围内使用。`;
    } else {
      eligibility = 'blocked';
      reason = `覆盖率低于最低可用阈值 ${(restrictedThreshold * 100).toFixed(0)}%。`;
    }
  }
  return {
    metricId: text(metric.metricId ?? metric.id ?? metric.name, `metric-${sha256(metric).slice(0, 12)}`, 180),
    name: text(metric.name ?? metric.title ?? metric.metricId, '未命名指标', 320),
    value: metric.value ?? null,
    numerator,
    denominator,
    coverage,
    coveragePercent: coverage === null ? null : Number((coverage * 100).toFixed(4)),
    scope: text(metric.scope, denominator > 0 ? `${numerator}/${denominator} 个样本` : '范围待确认', 800),
    method: text(metric.method, '按可用记录数除以目标记录数计算覆盖率。', 1200),
    eligibility,
    reason,
    evidenceRefs: [...new Set(array(metric.evidenceRefs).map((item) => text(typeof item === 'object' ? item.id ?? item.evidenceId : item, '', 128)).filter(Boolean))],
    limitations: [...new Set(array(metric.limitations).map((item) => text(item, '', 1200)).filter(Boolean))],
    affectedCapabilities: [...new Set(array(metric.affectedCapabilities).map((item) => text(item, '', 240)).filter(Boolean))],
  };
}

export function buildCoverageMatrix(metrics = [], options = {}) {
  const entries = array(metrics).map((metric) => evaluateMetricEligibility(metric, options));
  const counts = entries.reduce((result, entry) => {
    result[entry.eligibility] = (result[entry.eligibility] ?? 0) + 1;
    return result;
  }, { eligible: 0, restricted: 0, blocked: 0, unknown: 0 });
  const matrix = {
    schemaVersion: COVERAGE_MATRIX_SCHEMA_VERSION,
    entries,
    summary: {
      metricCount: entries.length,
      counts,
      releaseImpact: counts.blocked > 0 ? 'blocked' : counts.restricted > 0 || counts.unknown > 0 ? 'restricted' : 'clear',
    },
  };
  return { ...matrix, fingerprint: sha256(stableStringify(matrix)) };
}
