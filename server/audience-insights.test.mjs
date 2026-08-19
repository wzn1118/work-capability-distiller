import assert from 'node:assert/strict';
import test from 'node:test';
import { AudienceInsightsError, deriveAudienceInsights, normalizeAudienceAggregate } from './audience-insights.mjs';

const officialExport = {
  id: 'audience-export-001',
  discoveryJobId: 'discovery-001',
  creatorId: 'creator-001',
  creatorName: 'Creator A',
  channel: 'douyin',
  capturedAt: '2026-07-21T12:00:00.000Z',
  source: {
    type: 'official_export',
    label: 'Douyin creator center audience export',
    capturedAt: '2026-07-21T11:59:00.000Z',
    reportId: 'report-001',
  },
  profile: { totalAudience: 10000 },
  coverage: { sampleSize: 10000, coverageRate: 0.92 },
  audience: {
    gender: [
      { label: '\u5973', value: 6400 },
      { label: '\u7537', value: 3200 },
      { label: '\u672a\u77e5', value: 400 },
    ],
    ageBands: [
      { label: '18-23', count: 3500 },
      { label: '24-30', count: 4500 },
      { label: '31-40', count: 2000 },
    ],
    cities: [
      { label: '\u5317\u4eac', count: 2500 },
      { label: '\u4e0a\u6d77', count: 1500 },
      { label: '\u6210\u90fd', count: 2000 },
      { label: '\u676d\u5dde', count: 1000 },
      { label: '\u6b66\u6c49', count: 500 },
      { label: '\u5e38\u5dde', count: 2500 },
    ],
    devices: [
      { label: 'iOS', count: 6100 },
      { label: 'Android', count: 3900 },
    ],
    consumptionPower: [
      { label: '\u4e2d', count: 5200 },
      { label: '\u9ad8', count: 3100 },
      { label: '\u4f4e', count: 1700 },
    ],
    interests: [
      { label: '\u62a4\u80a4', count: 4000 },
      { label: '\u7f8e\u5986', count: 3500 },
      { label: '\u5065\u5eb7\u751f\u6d3b', count: 2500 },
    ],
    activeHours: [
      { hour: 20, count: 3600 },
      { label: '21:00-22:00', count: 3200 },
      { label: '12\u70b9', count: 3200 },
    ],
  },
};

test('deriveAudienceInsights creates the API import schema from aggregate export data', () => {
  const insight = deriveAudienceInsights(officialExport);

  assert.equal(insight.id, 'audience-export-001');
  assert.equal(insight.discoveryJobId, 'discovery-001');
  assert.equal(insight.creatorId, 'creator-001');
  assert.equal(insight.creatorName, 'Creator A');
  assert.equal(insight.channel, 'douyin');
  assert.deepEqual(insight.source, {
    type: 'official_export',
    label: 'Douyin creator center audience export',
    capturedAt: '2026-07-21T11:59:00.000Z',
    dataScope: 'aggregate',
  });
  assert.equal(insight.profile.totalAudience, 10000);
  assert.deepEqual(insight.gender, [
    { label: '\u5973\u6027', value: 6400, percent: 64 },
    { label: '\u7537\u6027', value: 3200, percent: 32 },
    { label: '\u672a\u77e5', value: 400, percent: 4 },
  ]);
  assert.deepEqual(insight.cityTier, [
    { label: '\u4e00\u7ebf\u57ce\u5e02', value: 4000, percent: 40 },
    { label: '\u65b0\u4e00\u7ebf\u57ce\u5e02', value: 3500, percent: 35 },
    { label: '\u5176\u4ed6\u57ce\u5e02\u7ea7\u522b', value: 2500, percent: 25 },
  ]);
  assert.equal(insight.dimensions.city.label, '\u57ce\u5e02');
  assert.deepEqual(Object.fromEntries(insight.dimensions.city.rows.map(({ label, value, percent }) => [label, { value, percent }])), {
    '\u5317\u4eac': { value: 2500, percent: 25 },
    '\u4e0a\u6d77': { value: 1500, percent: 15 },
    '\u6210\u90fd': { value: 2000, percent: 20 },
    '\u676d\u5dde': { value: 1000, percent: 10 },
    '\u6b66\u6c49': { value: 500, percent: 5 },
    '\u5e38\u5dde': { value: 2500, percent: 25 },
  });
  assert.deepEqual(insight.dimensions.device, {
    label: '\u8bbe\u5907\u7c7b\u578b',
    rows: [
      { label: 'iOS', value: 6100, percent: 61 },
      { label: 'Android', value: 3900, percent: 39 },
    ],
  });
  assert.equal(insight.dimensions.consumptionpower.rows.length, 3);
  assert.equal(insight.evidence.dimensions.device.bucketCount, 2);
  assert.deepEqual(insight.activeHours.map(({ label, percent }) => ({ label, percent })), [
    { label: '20:00-21:00', percent: 36 },
    { label: '12:00-13:00', percent: 32 },
    { label: '21:00-22:00', percent: 32 },
  ]);
  assert.deepEqual(insight.coverage, {
    sampleSize: 10000,
    coverageRate: 92,
    completeness: 100,
    confidence: 'high',
  });
  assert.equal(insight.evidence.schemaVersion, 'audience-insights/v1');
  assert.deepEqual(insight.evidence.warnings, []);
});

test('normalizeAudienceAggregate accepts normalized CSV rows and derives percentages without exposing rows', () => {
  const normalized = normalizeAudienceAggregate({
    source: 'authorized_export',
    capturedAt: '2026-07-21T13:00:00.000Z',
    totalAudience: 200,
    rows: [
      { dimension: 'gender', label: 'female', percent: 0.6 },
      { dimension: 'gender', label: 'male', percent: 0.4 },
      { dimension: 'age', label: '18-23', value: 80 },
      { dimension: 'age', label: '24-30', value: 120 },
      { dimension: 'city', label: 'Beijing', count: 80 },
      { dimension: 'city', label: 'Suzhou', count: 120 },
      { dimension: 'interest', label: 'skin care', count: 120 },
      { dimension: 'interest', label: 'fitness', count: 80 },
      { dimension: 'activehour', label: '22', count: 110 },
      { dimension: 'activehour', label: '23', count: 90 },
    ],
  });

  assert.equal(normalized.source.type, 'authorized_export');
  assert.equal(normalized.distributions.gender.rows[0].label, '\u5973\u6027');
  assert.equal(normalized.distributions.gender.rows[0].value, 120);
  assert.equal(normalized.distributions.age.rows[0].percent, 60);
  assert.equal(normalized.distributions.activeHours.rows[0].label, '22:00-23:00');
});

test('deriveAudienceInsights rejects individual fan lists and unapproved sources', () => {
  assert.throws(
    () => deriveAudienceInsights({
      source: 'official_export',
      fans: [{ uid: 'fan-1', label: 'not an aggregate' }],
    }),
    (error) => error instanceof AudienceInsightsError && error.code === 'AUDIENCE_DETAIL_NOT_ALLOWED',
  );
  assert.throws(
    () => deriveAudienceInsights({
      source: { type: 'browser_relay' },
      audience: { gender: [{ label: 'female', count: 1 }] },
    }),
    (error) => error instanceof AudienceInsightsError && error.code === 'AGGREGATE_SOURCE_REQUIRED',
  );
});
