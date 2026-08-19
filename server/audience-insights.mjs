const SCHEMA_VERSION = 'audience-insights/v1';

const AGGREGATE_SOURCE_TYPES = new Set([
  'official_export',
  'official_api_export',
  'authorized_export',
  'authorized_partner_export',
  'partner_authorized_export',
]);

const DETAIL_COLLECTION_KEYS = new Set([
  'fans',
  'fan_details',
  'fandetails',
  'follower_details',
  'followerdetails',
  'audience_details',
  'audiencedetails',
  'user_list',
  'userlist',
  'individuals',
  'members',
]);

const PERSON_IDENTIFIER_KEYS = new Set([
  'uid',
  'user_id',
  'userid',
  'open_id',
  'openid',
  'union_id',
  'unionid',
  'phone',
  'mobile',
  'email',
  'id_card',
  'idcard',
]);

const SOURCE_LABELS = {
  official_export: '\u5b98\u65b9\u6570\u636e\u5bfc\u51fa',
  official_api_export: '\u5b98\u65b9 API \u6c47\u603b\u5bfc\u51fa',
  authorized_export: '\u5df2\u6388\u6743\u6570\u636e\u5bfc\u51fa',
  authorized_partner_export: '\u5df2\u6388\u6743\u5408\u4f5c\u65b9\u5bfc\u51fa',
  partner_authorized_export: '\u5df2\u6388\u6743\u5408\u4f5c\u65b9\u5bfc\u51fa',
};

const CITY_TIER_LABELS = {
  tier_1: '\u4e00\u7ebf\u57ce\u5e02',
  new_tier_1: '\u65b0\u4e00\u7ebf\u57ce\u5e02',
  tier_2: '\u4e8c\u7ebf\u57ce\u5e02',
  other: '\u5176\u4ed6\u57ce\u5e02\u7ea7\u522b',
};

const CITY_TIER_1 = new Set([
  '\u5317\u4eac', '\u5317\u4eac\u5e02', 'beijing',
  '\u4e0a\u6d77', '\u4e0a\u6d77\u5e02', 'shanghai',
  '\u5e7f\u5dde', '\u5e7f\u5dde\u5e02', 'guangzhou',
  '\u6df1\u5733', '\u6df1\u5733\u5e02', 'shenzhen',
]);

const CITY_NEW_TIER_1 = new Set([
  '\u6210\u90fd', '\u6210\u90fd\u5e02', 'chengdu',
  '\u676d\u5dde', '\u676d\u5dde\u5e02', 'hangzhou',
  '\u91cd\u5e86', '\u91cd\u5e86\u5e02', 'chongqing',
  '\u6b66\u6c49', '\u6b66\u6c49\u5e02', 'wuhan',
  '\u82cf\u5dde', '\u82cf\u5dde\u5e02', 'suzhou',
  '\u897f\u5b89', '\u897f\u5b89\u5e02', 'xi\'an', 'xian',
  '\u5357\u4eac', '\u5357\u4eac\u5e02', 'nanjing',
  '\u5929\u6d25', '\u5929\u6d25\u5e02', 'tianjin',
  '\u90d1\u5dde', '\u90d1\u5dde\u5e02', 'zhengzhou',
  '\u957f\u6c99', '\u957f\u6c99\u5e02', 'changsha',
  '\u4e1c\u839e', '\u4e1c\u839e\u5e02', 'dongguan',
  '\u5b81\u6ce2', '\u5b81\u6ce2\u5e02', 'ningbo',
  '\u9752\u5c9b', '\u9752\u5c9b\u5e02', 'qingdao',
  '\u6c88\u9633', '\u6c88\u9633\u5e02', 'shenyang',
  '\u5408\u80a5', '\u5408\u80a5\u5e02', 'hefei',
  '\u4f5b\u5c71', '\u4f5b\u5c71\u5e02', 'foshan',
  '\u6d4e\u5357', '\u6d4e\u5357\u5e02', 'jinan',
  '\u5927\u8fde', '\u5927\u8fde\u5e02', 'dalian',
]);

const DIMENSIONS = {
  gender: {
    aliases: ['gender', 'genders', 'genderDistribution', 'gender_distribution'],
    rowAliases: ['gender', '\u6027\u522b'],
  },
  age: {
    aliases: ['age', 'ages', 'ageBands', 'ageDistribution', 'age_distribution'],
    rowAliases: ['age', 'age_band', '\u5e74\u9f84'],
  },
  city: {
    aliases: ['city', 'cities', 'cityDistribution', 'city_distribution', 'locations'],
    rowAliases: ['city', 'city_tier', '\u57ce\u5e02', '\u57ce\u5e02\u7ea7\u522b'],
  },
  interests: {
    aliases: ['interests', 'interest', 'interestDistribution', 'interest_distribution'],
    rowAliases: ['interest', 'interests', '\u5174\u8da3'],
  },
  activeHours: {
    aliases: ['activeHours', 'active_hours', 'activePeriods', 'active_periods', 'activityHours', 'activity_hours'],
    rowAliases: ['activehour', 'active_hours', 'active_period', 'activity_hour', '\u6d3b\u8dc3\u65f6\u95f4', '\u6d3b\u8dc3\u65f6\u6bb5'],
  },
};

const EXTRA_DIMENSION_LABELS = {
  city: '\u57ce\u5e02',
  province: '\u7701\u4efd',
  region: '\u5730\u57df',
  device: '\u8bbe\u5907\u7c7b\u578b',
  operatingsystem: '\u64cd\u4f5c\u7cfb\u7edf',
  consumptionpower: '\u6d88\u8d39\u80fd\u529b',
  shoppingpower: '\u6d88\u8d39\u80fd\u529b',
  income: '\u6536\u5165\u6c34\u5e73',
  occupation: '\u804c\u4e1a',
  education: '\u5b66\u5386',
  lifestage: '\u4eba\u751f\u9636\u6bb5',
  maritalstatus: '\u5a5a\u59fb\u72b6\u6001',
  parenthood: '\u5bb6\u5ead\u9636\u6bb5',
  residence: '\u5c45\u4f4f\u5730',
};

const EXTRA_DIMENSION_KEYS = {
  cities: 'city',
  city: 'city',
  provinces: 'province',
  province: 'province',
  locations: 'region',
  location: 'region',
  regions: 'region',
  region: 'region',
  devices: 'device',
  devicetype: 'device',
  devicetypes: 'device',
  device: 'device',
  os: 'operatingsystem',
  operatingos: 'operatingsystem',
  operatingsystem: 'operatingsystem',
  consumptionability: 'consumptionpower',
  consumptionpower: 'consumptionpower',
  shoppingpower: 'shoppingpower',
  occupations: 'occupation',
  occupation: 'occupation',
  educations: 'education',
  education: 'education',
  lifestage: 'lifestage',
  lifestages: 'lifestage',
};

const EXTRA_DIMENSION_RESERVED_KEYS = new Set([
  'id', 'discoveryjobid', 'creatorid', 'creatorname', 'channel', 'capturedat',
  'source', 'exportsource', 'metadata', 'profile', 'coverage', 'rows', 'records',
  'data', 'audience', 'dimensions', 'distributions', 'summary', 'total',
  'totalaudience', 'samplesize', 'coveragerate', 'sourceurl',
]);

export class AudienceInsightsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AudienceInsightsError';
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maximum = 180) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizedKey(value) {
  return text(value, 160).toLowerCase().replace(/[\s_-]+/g, '');
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const candidate = text(value, 80).replace(/,/g, '');
  if (!candidate) return null;
  const parsed = Number(candidate.replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function firstValue(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const key of path.split('.')) value = value?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toPercent(value) {
  const number = finiteNumber(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number <= 1 ? number * 100 : number;
}

function assertAggregateOnly(value, path = 'input', depth = 0) {
  if (depth > 7 || value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const keys = Object.keys(item).map(normalizedKey);
        if (keys.some((key) => PERSON_IDENTIFIER_KEYS.has(key))) {
          throw new AudienceInsightsError(
            'AUDIENCE_DETAIL_NOT_ALLOWED',
            'Audience insight imports only accept aggregate distributions, not individual fan records.',
          );
        }
      }
      assertAggregateOnly(item, path, depth + 1);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (DETAIL_COLLECTION_KEYS.has(normalized) && (Array.isArray(child) || isRecord(child))) {
      throw new AudienceInsightsError(
        'AUDIENCE_DETAIL_NOT_ALLOWED',
        'Audience insight imports only accept aggregate distributions, not individual fan records.',
      );
    }
    assertAggregateOnly(child, `${path}.${key}`, depth + 1);
  }
}

function normalizeSource(input) {
  const sourceInput = input.source ?? input.exportSource ?? input.metadata?.source;
  const source = isRecord(sourceInput) ? sourceInput : { type: sourceInput };
  const type = text(firstValue(source, ['type', 'kind', 'sourceType']), 80).toLowerCase();
  if (!AGGREGATE_SOURCE_TYPES.has(type)) {
    throw new AudienceInsightsError(
      'AGGREGATE_SOURCE_REQUIRED',
      'Audience insight imports require an official or authorized aggregate export source.',
    );
  }
  const capturedAt = text(firstValue(source, ['capturedAt', 'exportedAt', 'generatedAt', 'createdAt']), 64)
    || text(input.capturedAt, 64)
    || new Date().toISOString();
  return {
    type,
    label: text(source.label, 120) || SOURCE_LABELS[type],
    capturedAt,
    dataScope: 'aggregate',
    reportId: text(firstValue(source, ['reportId', 'exportId', 'id']), 160),
  };
}

function topLevelContainers(input) {
  return [
    input,
    isRecord(input.audience) ? input.audience : null,
    isRecord(input.distributions) ? input.distributions : null,
    isRecord(input.dimensions) ? input.dimensions : null,
    isRecord(input.data) ? input.data : null,
  ].filter(Boolean);
}

function rowMatchesDimension(row, aliases) {
  const dimension = normalizedKey(firstValue(row, ['dimension', 'dimensionName', 'metric', 'type']));
  return aliases.some((alias) => normalizedKey(alias) === dimension);
}

function findDimensionInput(input, definition) {
  for (const container of topLevelContainers(input)) {
    for (const alias of definition.aliases) {
      if (container[alias] !== undefined) return container[alias];
    }
  }

  const rows = Array.isArray(input.rows) ? input.rows : Array.isArray(input.records) ? input.records : [];
  const matched = rows.filter((row) => isRecord(row) && rowMatchesDimension(row, definition.rowAliases));
  return matched.length ? matched : [];
}

function rowsFromValue(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['items', 'rows', 'data', 'buckets', 'values']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.entries(value)
    .filter(([key]) => !['total', 'totalAudience', 'sampleSize', 'coverageRate'].includes(key))
    .map(([label, metric]) => isRecord(metric) ? { label, ...metric } : { label, value: metric });
}

function labelFromRow(row, dimension, index) {
  const value = firstValue(row, [
    'label', 'name', 'bucket', 'category', 'group', 'key', 'title', 'period', 'timeSlot', 'hour',
  ]);
  const label = text(value, 120);
  if (!label) return `${dimension}-${index + 1}`;
  if (dimension !== 'activeHours') return label;

  const range = label.match(/(\d{1,2})(?::\d{2})?\s*(?:-|~|\u81f3|\u5230)\s*(\d{1,2})(?::\d{2})?/);
  if (range) return `${String(Number(range[1])).padStart(2, '0')}:00-${String(Number(range[2])).padStart(2, '0')}:00`;
  const hour = label.match(/^(\d{1,2})(?::\d{2})?(?:\u70b9|h)?$/i);
  if (hour && Number(hour[1]) <= 23) {
    const start = Number(hour[1]);
    return `${String(start).padStart(2, '0')}:00-${String((start + 1) % 24).padStart(2, '0')}:00`;
  }
  return label;
}

function rawBuckets(value, dimension) {
  return rowsFromValue(value).map((item, index) => {
    const row = isRecord(item) ? item : { label: `${dimension}-${index + 1}`, value: item };
    return {
      label: labelFromRow(row, dimension, index),
      explicitCount: finiteNumber(firstValue(row, ['count', 'audienceCount', 'userCount', 'fans', 'total'])),
      explicitPercent: toPercent(firstValue(row, ['percent', 'percentage', 'share', 'ratio', 'proportion'])),
      value: finiteNumber(row.value),
    };
  }).filter((bucket) => bucket.label && (Number.isFinite(bucket.explicitCount)
    || Number.isFinite(bucket.explicitPercent) || Number.isFinite(bucket.value)));
}

function mergeRawBuckets(buckets, labelTransformer = (label) => label) {
  const merged = new Map();
  for (const bucket of buckets) {
    const label = labelTransformer(bucket.label);
    const key = normalizedKey(label) || label;
    const current = merged.get(key) || {
      label,
      explicitCount: 0,
      hasExplicitCount: false,
      explicitPercent: 0,
      hasExplicitPercent: false,
      value: 0,
      hasValue: false,
    };
    if (Number.isFinite(bucket.explicitCount)) {
      current.explicitCount += bucket.explicitCount;
      current.hasExplicitCount = true;
    }
    if (Number.isFinite(bucket.explicitPercent)) {
      current.explicitPercent += bucket.explicitPercent;
      current.hasExplicitPercent = true;
    }
    if (Number.isFinite(bucket.value)) {
      current.value += bucket.value;
      current.hasValue = true;
    }
    merged.set(key, current);
  }
  return [...merged.values()];
}

function distributionFromRaw(buckets, { totalAudience = null, labelTransformer } = {}) {
  const merged = mergeRawBuckets(buckets, labelTransformer);
  const noExplicitMetrics = merged.every((bucket) => !bucket.hasExplicitCount && !bucket.hasExplicitPercent);
  const totalAmbiguousValue = merged.reduce((sum, bucket) => sum + (bucket.hasValue ? bucket.value : 0), 0);
  const valuesLookLikePercent = noExplicitMetrics
    && totalAmbiguousValue > 0
    && totalAmbiguousValue <= 100.001
    && (!Number.isFinite(totalAudience) || totalAudience > 100);

  const rows = merged.map((bucket) => {
    const count = bucket.hasExplicitCount
      ? bucket.explicitCount
      : !bucket.hasExplicitPercent && bucket.hasValue && !valuesLookLikePercent
        ? bucket.value
        : null;
    const rawPercent = bucket.hasExplicitPercent
      ? bucket.explicitPercent
      : bucket.hasValue && valuesLookLikePercent
        ? bucket.value <= 1 ? bucket.value * 100 : bucket.value
        : null;
    return { label: bucket.label, value: Number.isFinite(count) ? round(count, 4) : null, rawPercent };
  }).filter((bucket) => bucket.label && (Number.isFinite(bucket.value) || Number.isFinite(bucket.rawPercent)));

  const valueTotal = rows.reduce((sum, bucket) => sum + (Number.isFinite(bucket.value) ? bucket.value : 0), 0);
  const percentTotal = rows.reduce((sum, bucket) => sum + (Number.isFinite(bucket.rawPercent) ? bucket.rawPercent : 0), 0);
  const useValues = valueTotal > 0;
  const usePercents = !useValues && percentTotal > 0;
  const denominator = useValues ? valueTotal : usePercents ? percentTotal : 0;

  return {
    rows: rows.map((bucket) => ({
      label: bucket.label,
      value: bucket.value ?? (Number.isFinite(totalAudience) && Number.isFinite(bucket.rawPercent)
        ? Math.round(totalAudience * bucket.rawPercent / 100)
        : null),
      percent: denominator > 0
        ? round(((useValues ? (bucket.value || 0) : (bucket.rawPercent || 0)) / denominator) * 100)
        : null,
    })).sort((left, right) => (right.percent || 0) - (left.percent || 0) || left.label.localeCompare(right.label)),
    diagnostics: {
      bucketCount: rows.length,
      valueTotal: useValues ? round(valueTotal, 4) : null,
      sourcePercentTotal: usePercents ? round(percentTotal) : null,
      sourcePercentConsistent: !usePercents || Math.abs(percentTotal - 100) <= 1,
      isComplete: rows.length > 0 && denominator > 0,
    },
  };
}

function standardDimensionName(value) {
  const normalized = normalizedKey(value);
  if (!normalized) return '';
  for (const [name, definition] of Object.entries(DIMENSIONS)) {
    const aliases = [...definition.aliases, ...definition.rowAliases];
    if (aliases.some((alias) => normalizedKey(alias) === normalized)) return name;
  }
  return '';
}

function extraDimensionKey(value) {
  const normalized = normalizedKey(value)
    .replace(/(?:distributions?|breakdowns?|buckets?|segments?)$/, '');
  return EXTRA_DIMENSION_KEYS[normalized] || normalized || 'dimension';
}

function extraDimensionLabel(key, value) {
  const source = isRecord(value) ? value : {};
  return text(firstValue(source, ['dimensionLabel', 'dimensionName', 'displayName', 'title']), 120)
    || EXTRA_DIMENSION_LABELS[key]
    || text(key, 120);
}

function aggregateDimensionContainers(input) {
  const data = isRecord(input.data) ? input.data : {};
  return [
    input,
    input.audience,
    input.distributions,
    input.dimensions,
    data,
    data.audience,
    data.distributions,
    data.dimensions,
  ].filter(isRecord);
}

function extraDimensionCandidates(input) {
  const candidates = [];
  for (const container of aggregateDimensionContainers(input)) {
    for (const [key, value] of Object.entries(container)) {
      if (EXTRA_DIMENSION_RESERVED_KEYS.has(normalizedKey(key))) continue;
      if (!Array.isArray(value) && !isRecord(value)) continue;
      candidates.push({ key, value });
    }
  }

  const rowCollections = [
    input.rows,
    input.records,
    input.data?.rows,
    input.data?.records,
  ].filter(Array.isArray);
  const rowsByDimension = new Map();
  for (const rows of rowCollections) {
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const key = text(firstValue(row, ['dimension', 'dimensionName', 'metric', 'type']), 120);
      if (!key) continue;
      const normalized = extraDimensionKey(key);
      const current = rowsByDimension.get(normalized) || { key, rows: [] };
      current.rows.push(row);
      rowsByDimension.set(normalized, current);
    }
  }
  for (const { key, rows } of rowsByDimension.values()) candidates.push({ key, value: rows });
  return candidates;
}

function extraAudienceDimensions(input, totalAudience) {
  const dimensions = new Map();
  for (const candidate of extraDimensionCandidates(input)) {
    const standardName = standardDimensionName(candidate.key);
    if (standardName && standardName !== 'city') continue;
    const key = standardName === 'city' ? 'city' : extraDimensionKey(candidate.key);
    if (EXTRA_DIMENSION_RESERVED_KEYS.has(key)) continue;
    const distribution = distributionFromRaw(rawBuckets(candidate.value, key), { totalAudience });
    if (!distribution.rows.length) continue;
    const current = dimensions.get(key);
    if (!current || distribution.rows.length > current.rows.length) {
      dimensions.set(key, {
        label: extraDimensionLabel(key, candidate.value),
        rows: distribution.rows,
        diagnostics: distribution.diagnostics,
      });
    }
  }
  return Object.fromEntries(dimensions.entries());
}

function normalizedGenderLabel(label) {
  const key = normalizedKey(label);
  if (['female', 'f', '\u5973', '\u5973\u6027'].includes(key)) return '\u5973\u6027';
  if (['male', 'm', '\u7537', '\u7537\u6027'].includes(key)) return '\u7537\u6027';
  if (['unknown', 'unknow', 'notprovided', '\u672a\u77e5', '\u672a\u586b\u5199'].includes(key)) return '\u672a\u77e5';
  if (['other', 'nonbinary', '\u5176\u4ed6'].includes(key)) return '\u5176\u4ed6';
  return text(label, 120);
}

function cityTierFor(label) {
  const key = normalizedKey(label);
  if (key.includes('\u65b0\u4e00\u7ebf') || key === 'newtier1') return 'new_tier_1';
  if (key.includes('\u4e00\u7ebf') || key === 'tier1') return 'tier_1';
  if (key.includes('\u4e8c\u7ebf') || key === 'tier2') return 'tier_2';
  if (CITY_TIER_1.has(key)) return 'tier_1';
  if (CITY_NEW_TIER_1.has(key)) return 'new_tier_1';
  return 'other';
}

function cityTierDistribution(cityDistribution) {
  const grouped = new Map();
  for (const city of cityDistribution.rows) {
    const tier = cityTierFor(city.label);
    const current = grouped.get(tier) || { label: CITY_TIER_LABELS[tier], value: 0, hasValue: false, percent: 0, hasPercent: false };
    if (Number.isFinite(city.value)) {
      current.value += city.value;
      current.hasValue = true;
    }
    if (Number.isFinite(city.percent)) {
      current.percent += city.percent;
      current.hasPercent = true;
    }
    grouped.set(tier, current);
  }
  return [...grouped.values()].map((bucket) => ({
    label: bucket.label,
    value: bucket.hasValue ? round(bucket.value, 4) : null,
    percent: bucket.hasPercent ? round(bucket.percent) : null,
  })).sort((left, right) => (right.percent || 0) - (left.percent || 0) || left.label.localeCompare(right.label));
}

function scalarMetric(input, paths) {
  const value = finiteNumber(firstValue(input, paths));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function coverageRate(input) {
  const value = firstValue(input, ['coverage.coverageRate', 'coverage.rate', 'coverageRate', 'profile.coverageRate']);
  const number = finiteNumber(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return round(number <= 1 ? number * 100 : number);
}

function buildCoverage({ distributions, extraDimensions = {}, totalAudience, input, source }) {
  const names = ['gender', 'age', 'city', 'interests', 'activeHours'];
  const observed = names.filter((name) => distributions[name].diagnostics.isComplete);
  const inconsistent = names.filter((name) => !distributions[name].diagnostics.sourcePercentConsistent);
  const completeness = clamp(Math.round(
    (observed.length / names.length) * 75
    + (Number.isFinite(totalAudience) ? 10 : 0)
    + (source.reportId ? 5 : 0)
    + (coverageRate(input) !== null ? 10 : 0)
    - inconsistent.length * 4,
  ), 0, 100);
  const confidence = completeness >= 85 ? 'high' : completeness >= 55 ? 'medium' : 'low';
  const sampleSize = scalarMetric(input, [
    'coverage.sampleSize', 'sampleSize', 'profile.sampleSize', 'profile.totalAudience', 'totalAudience', 'audience.totalAudience',
  ]) ?? totalAudience;
  const warnings = names.filter((name) => !distributions[name].diagnostics.isComplete)
    .map((name) => `${name}_missing_or_empty`);
  warnings.push(...inconsistent.map((name) => `${name}_source_percent_total_inconsistent`));
  const dimensionEvidence = {
    ...Object.fromEntries(names.map((name) => [name, distributions[name].diagnostics])),
    ...Object.fromEntries(Object.entries(extraDimensions).map(([name, dimension]) => [name, dimension.diagnostics])),
  };
  return {
    coverage: {
      sampleSize: Number.isFinite(sampleSize) ? round(sampleSize, 4) : null,
      coverageRate: coverageRate(input),
      completeness,
      confidence,
    },
    evidence: {
      schemaVersion: SCHEMA_VERSION,
      sourceReportId: source.reportId || null,
      dimensions: dimensionEvidence,
      warnings,
    },
  };
}

/**
 * Validates and normalizes an official or authorized aggregate audience export.
 * It intentionally rejects payloads that contain individual audience records.
 */
export function normalizeAudienceAggregate(input) {
  if (!isRecord(input)) {
    throw new AudienceInsightsError('AUDIENCE_INPUT_INVALID', 'Audience insight input must be a normalized object.');
  }
  assertAggregateOnly(input);
  const source = normalizeSource(input);
  const totalAudience = scalarMetric(input, [
    'profile.totalAudience', 'totalAudience', 'audience.totalAudience', 'audience.total', 'summary.totalAudience',
  ]);
  const distributions = Object.fromEntries(Object.entries(DIMENSIONS).map(([name, definition]) => {
    const raw = rawBuckets(findDimensionInput(input, definition), name);
    const transformer = name === 'gender' ? normalizedGenderLabel : undefined;
    return [name, distributionFromRaw(raw, { totalAudience, labelTransformer: transformer })];
  }));
  const extraDimensions = extraAudienceDimensions(input, totalAudience);
  return { input, source, totalAudience, distributions, extraDimensions };
}

/**
 * Builds the stable audience insight schema consumed by the API import route.
 */
export function deriveAudienceInsights(input) {
  const normalized = normalizeAudienceAggregate(input);
  const { source, totalAudience, distributions, extraDimensions } = normalized;
  const metadata = {
    id: text(input.id, 180) || undefined,
    discoveryJobId: text(input.discoveryJobId, 180) || undefined,
    creatorId: text(input.creatorId, 180) || undefined,
    creatorName: text(input.creatorName, 160) || undefined,
    channel: text(input.channel, 60) || undefined,
    capturedAt: text(input.capturedAt, 64) || source.capturedAt,
  };
  const { coverage, evidence } = buildCoverage({ distributions, extraDimensions, totalAudience, input, source });

  return {
    ...metadata,
    source: {
      type: source.type,
      label: source.label,
      capturedAt: source.capturedAt,
      dataScope: 'aggregate',
    },
    profile: {
      totalAudience: Number.isFinite(totalAudience) ? round(totalAudience, 4) : null,
    },
    gender: distributions.gender.rows,
    age: distributions.age.rows,
    cityTier: cityTierDistribution(distributions.city),
    interests: distributions.interests.rows,
    activeHours: distributions.activeHours.rows,
    dimensions: Object.fromEntries(Object.entries(extraDimensions).map(([name, dimension]) => [name, {
      label: dimension.label,
      rows: dimension.rows,
    }])),
    coverage,
    evidence,
  };
}

export const buildAudienceInsights = deriveAudienceInsights;
