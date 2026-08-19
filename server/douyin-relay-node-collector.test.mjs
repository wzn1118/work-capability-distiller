import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalDouyinContentUrl,
  canonicalDouyinUrl,
  applySearchDetailEnrichment,
  catalogCheckpointSamples,
  detailWorkerCount,
  finishVisibleDetailSummary,
  hasVisibleProfileCore,
  hasCompleteVisibleDetailFields,
  isVerificationFrameUrl,
  isRelayBlankPageTarget,
  markVisibleDetailBlocked,
  mergeDouyinVisibleSamples,
  mergeVisibleSearchCards,
  pageAccessState,
  parseArgs,
  profilePhaseObservation,
  profileMetricFromVisibleText,
  profileRecord,
  profileCollectionCoverage,
  profileIdleStopReason,
  profileSurfaceProgressed,
  readVisibleProfileSamples,
  sampleFromCard,
  searchIdleStopReason,
  shouldRetryVisibleDetail,
  shouldBlockSearchAccess,
  shouldRetrySearchPageLoad,
  visibleProfileSignalCount,
  visibleDetailQueuePlan,
} from './scripts/collect_douyin_relay.mjs';

test('only an actual Chrome new-tab page is eligible for Relay cleanup', () => {
  assert.equal(isRelayBlankPageTarget({ type: 'page', url: 'chrome://newtab/' }), true);
  assert.equal(isRelayBlankPageTarget({ type: 'page', url: 'chrome://newtab' }), true);
  assert.equal(isRelayBlankPageTarget({ type: 'page', url: 'https://www.douyin.com/search/short-hair' }), false);
  assert.equal(isRelayBlankPageTarget({ type: 'iframe', url: 'chrome://newtab/' }), false);
});

test('only canonical Douyin video and note URLs enter the content ledger', () => {
  assert.equal(canonicalDouyinContentUrl('https://www.douyin.com/video/123?from=profile'), 'https://www.douyin.com/video/123');
  assert.equal(canonicalDouyinContentUrl('https://www.douyin.com/note/abc_123#detail'), 'https://www.douyin.com/note/abc_123');
  assert.equal(canonicalDouyinContentUrl('https://www.douyin.com/search/skincare'), '');
  assert.equal(sampleFromCard({ note_url: 'https://www.douyin.com/search/skincare', published_at_text: '22.5' }).note_url, '');
});

test('verification iframe URLs are classified as platform verification', () => {
  assert.equal(isVerificationFrameUrl('https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/index.html'), true);
  assert.equal(isVerificationFrameUrl('https://www.douyin.com/security/verify'), true);
  assert.equal(isVerificationFrameUrl('https://www.douyin.com/search/short-hair'), false);
});

test('profile-card URL normalization is self-contained inside the browser evaluation callback', async () => {
  let evaluated = false;
  const page = {
    async evaluate(callback, limit) {
      evaluated = true;
      const browserSource = String(callback);
      assert.match(browserSource, /const canonicalContentUrl\s*=/);
      assert.match(browserSource, /canonicalContentUrl\(absolute\(/);
      assert.equal(limit, 10_000);
      return [];
    },
  };

  assert.deepEqual(await readVisibleProfileSamples(page, 10_000), []);
  assert.equal(evaluated, true);
});

test('label-first public profile text yields account metrics and hydration evidence', () => {
  const visible = '\u4e38\u7f8e\u62a4\u80a4\u65d7\u8230\u5e97 \u5173\u6ce8 65 \u7c89\u4e1d 95.8\u4e07 \u83b7\u8d5e 64.0\u4e07 \u4f5c\u54c1 1696';
  const profile = {
    author: '\u4e38\u7f8e\u62a4\u80a4\u65d7\u8230\u5e97',
    accountId: 'b215033795',
    metrics: {
      followers: profileMetricFromVisibleText(visible, ['\u7c89\u4e1d']),
      likes: profileMetricFromVisibleText(visible, ['\u83b7\u8d5e']),
      works: profileMetricFromVisibleText(visible, ['\u4f5c\u54c1']),
    },
  };

  assert.equal(profile.metrics.followers, '95.8\u4e07');
  assert.equal(profile.metrics.likes, '64.0\u4e07');
  assert.equal(profile.metrics.works, '1696');
  assert.equal(visibleProfileSignalCount(profile), 5);
  assert.equal(hasVisibleProfileCore(profile), true);
  assert.equal(hasVisibleProfileCore({ author: profile.author, metrics: { works: '1696' } }), false);
});

test('public profile metric parsing never treats the Douyin account id as following count', () => {
  const accountId = '30810775501';
  const visible = `\u6960\u6960\u8349\u672c\u62a4\u80a4 \u6296\u97f3\u53f7: ${accountId} \u5173\u6ce8 28 \u7c89\u4e1d 34 \u83b7\u8d5e 120`;
  const compactVisible = `\u6960\u6960\u8349\u672c\u62a4\u80a4 \u6296\u97f3\u53f7: ${accountId}\u5173\u6ce8`;

  assert.equal(profileMetricFromVisibleText(visible, ['\u5173\u6ce8'], { accountId }), '28');
  assert.equal(profileMetricFromVisibleText(compactVisible, ['\u5173\u6ce8'], { accountId }), '');
  assert.equal(profileMetricFromVisibleText(visible, ['\u7c89\u4e1d'], { accountId }), '34');
  assert.equal(profileMetricFromVisibleText(visible, ['\u83b7\u8d5e'], { accountId }), '120');
});

test('profile records retain the complete public homepage snapshot', () => {
  const record = profileRecord('https://www.douyin.com/user/creator-a', {
    author: 'Creator A',
    accountId: 'creator_a',
    handle: 'creator_a',
    bio: 'Public creator bio',
    location: 'Shanghai',
    verified: true,
    verified_label: 'Enterprise verified',
    account_type: 'creator',
    public_audience_signals: ['粉丝团入口'],
    avatar_url: 'https://p3.douyinpic.com/avatar.jpg',
    profile_tags: ['beauty', 'skincare'],
    visible_metrics: ['粉丝 12.3w', '作品 128'],
    profile_text: 'Creator A\n粉丝 12.3w\n作品 128',
    profile_title: 'Creator A - Douyin',
    homepage_url: 'https://www.douyin.com/user/creator-a',
    metrics: { followers: '12.3w', following: '56', likes: '45.6w', works: '128' },
  }, []);

  assert.equal(record.homepage_url, 'https://www.douyin.com/user/creator-a');
  assert.equal(record.handle, 'creator_a');
  assert.equal(record.location, 'Shanghai');
  assert.equal(record.verified, true);
  assert.equal(record.verified_label, 'Enterprise verified');
  assert.equal(record.account_type, 'creator');
  assert.deepEqual(record.public_audience_signals, ['粉丝团入口']);
  assert.deepEqual(record.profile_tags, ['beauty', 'skincare']);
  assert.equal(record.profile.profile_text, 'Creator A 粉丝 12.3w 作品 128');
  assert.deepEqual(record.profile.metrics, { followers: '12.3w', following: '56', likes: '45.6w', works: '128' });
  assert.deepEqual(record.profile.profile_tags, ['beauty', 'skincare']);
  assert.deepEqual(record.profile.public_audience_signals, ['粉丝团入口']);
});

test('profile-only phase does not report a fallback name as observed profile data', () => {
  assert.deepEqual(profilePhaseObservation({ author: 'Fallback target name', metrics: {} }), {
    observed: false,
    stopReason: 'profile_fields_unavailable_retryable',
    completion: 'profile_not_observed',
    continuationRecommended: true,
  });
  assert.equal(profilePhaseObservation({
    author: 'Observed creator',
    metrics: { followers: '10.5万', likes: '22.5万' },
  }).completion, 'profile_observed');
});

test('the Node Relay collector accepts the existing Douyin discovery argument contract', () => {
  const args = parseArgs([
    '--relay-port', '18801',
    '--limit', '240',
    '--search-url-template', 'https://www.douyin.com/search/{query}?type=general',
    '--output-dir', '.kolforge-runtime/test-output',
    '--query', 'skin care',
  ]);
  assert.equal(args.relayPort, 18801);
  assert.throws(
    () => parseArgs([
      '--relay-port', '18800',
      '--output-dir', '.kolforge-runtime/test-output',
      '--query', 'skin care',
    ]),
    /fixed at 18801/,
  );
  assert.equal(args.limit, 240);
  assert.equal(args.query, 'skin care');
  assert.equal(args.profileUrl, '');
  assert.equal(args.detailSampleLimit, 10_000);
  const paced = parseArgs([
    '--output-dir', '.kolforge-runtime/test-output',
    '--query', 'skin care',
    '--min-interval-ms', '1200',
    '--max-interval-ms', '3450',
  ]);
  assert.deepEqual(paced.randomInterval, { minMs: 1200, maxMs: 3450 });
  assert.deepEqual(paced.timing.snapshot(), {
    minMs: 1200,
    maxMs: 3450,
    waitCount: 0,
    totalWaitMs: 0,
    lastWaitMs: 0,
  });
  const minOnly = parseArgs([
    '--output-dir', '.kolforge-runtime/test-output',
    '--query', 'skin care',
    '--min-interval-ms', '1200',
  ]);
  assert.deepEqual(minOnly.randomInterval, { minMs: 1200, maxMs: 1200 });
  const defaults = parseArgs([
    '--output-dir', '.kolforge-runtime/test-output',
    '--query', 'skin care',
  ]);
  assert.equal(defaults.searchUrlTemplate, 'https://www.douyin.com/search/{query}?type=user');
  assert.equal(defaults.detailSampleLimit, defaults.profileSampleLimit);
  const inheritedProfileArgs = parseArgs([
    '--output-dir', '.kolforge-runtime/test-output',
    '--profile-url', 'https://www.douyin.com/user/creator',
    '--profile-sample-limit', '80',
  ]);
  assert.equal(inheritedProfileArgs.profileSampleLimit, 80);
  assert.equal(inheritedProfileArgs.detailSampleLimit, 80);
  assert.equal(inheritedProfileArgs.collectionPhase, 'detail');
  const profileArgs = parseArgs([
    '--output-dir', '.kolforge-runtime/test-output',
    '--profile-url', 'https://www.douyin.com/user/creator',
    '--profile-sample-limit', '80',
    '--detail-sample-limit', '40',
    '--collection-phase', 'catalog',
    '--catalog-input-file', '.kolforge-runtime/catalog.json',
  ]);
  assert.equal(profileArgs.profileSampleLimit, 80);
  assert.equal(profileArgs.detailSampleLimit, 40);
  assert.equal(profileArgs.collectionPhase, 'catalog');
  assert.equal(profileArgs.catalogInputFile, path.resolve('.kolforge-runtime/catalog.json'));
});

test('the Node Relay collector accepts a bounded post-comment argument contract', () => {
  const args = parseArgs([
    '--relay-port', '18801',
    '--limit', '25',
    '--output-dir', '.kolforge-runtime/test-output',
    '--post-url', 'https://www.douyin.com/video/123456789?from=search',
  ]);
  assert.equal(args.postUrl, 'https://www.douyin.com/video/123456789');
  assert.equal(args.profileUrl, '');
  assert.equal(args.query, '');
  assert.equal(args.limit, 25);
});

test('detail collection reuses only the matching canonical catalog checkpoint', () => {
  const profileUrl = 'https://www.douyin.com/user/creator?from=search';
  const samples = catalogCheckpointSamples([
    {
      source_profile_url: 'https://www.douyin.com/user/other',
      latest_samples: [{ note_url: 'https://www.douyin.com/video/ignored' }],
    },
    {
      source_profile_url: profileUrl,
      latest_samples: [
        { note_url: 'https://www.douyin.com/video/100?from=profile', title: 'older' },
        { note_url: 'https://www.douyin.com/video/100', title: 'newer' },
        { note_url: 'https://www.douyin.com/search/skincare' },
        { note_url: 'https://www.douyin.com/note/200#detail' },
      ],
    },
  ], profileUrl, 10);

  assert.deepEqual(samples.map((sample) => sample.note_url), [
    'https://www.douyin.com/video/100',
    'https://www.douyin.com/note/200',
  ]);
  assert.equal(samples[0].title, 'newer');
  assert.throws(
    () => catalogCheckpointSamples([], profileUrl),
    /does not match the requested profile/,
  );
});

test('the public detail collector uses at most two temporary tabs per profile', () => {
  assert.equal(detailWorkerCount(0), 0);
  assert.equal(detailWorkerCount(1), 1);
  assert.equal(detailWorkerCount(24), 2);
  assert.equal(detailWorkerCount(10_000), 2);
  assert.equal(detailWorkerCount('not-a-number'), 0);
});

test('complete public profile cards bypass detail navigation while incomplete cards remain queued', () => {
  const completeCard = {
    note_url: 'https://www.douyin.com/video/100',
    published_at: '2026-07-24 09:00',
    interaction_availability: {
      likes: { state: 'count_observed', source: 'rendered_profile_card' },
      collects: { state: 'count_observed', source: 'rendered_profile_card' },
      comments: { state: 'count_observed', source: 'rendered_profile_card' },
      shares: { state: 'action_visible_count_not_shown', source: 'rendered_profile_card' },
    },
  };
  const incompleteCard = {
    note_url: 'https://www.douyin.com/video/101',
    published_at: '2026-07-24 10:00',
    interaction_availability: {
      likes: { state: 'count_observed', source: 'rendered_profile_card' },
    },
  };
  const missingDateCard = {
    note_url: 'https://www.douyin.com/video/102',
    interaction_availability: completeCard.interaction_availability,
  };

  assert.equal(hasCompleteVisibleDetailFields(completeCard), true);
  assert.equal(hasCompleteVisibleDetailFields(incompleteCard), false);
  assert.equal(hasCompleteVisibleDetailFields(missingDateCard), false);

  const plan = visibleDetailQueuePlan([completeCard, incompleteCard, missingDateCard, {
    note_url: 'https://www.douyin.com/note/103',
  }]);
  assert.deepEqual(plan.videoIndexes, [0, 1, 2]);
  assert.deepEqual(plan.cardCompleteIndexes, [0]);
  assert.deepEqual(plan.queuedIndexes, [1, 2]);
  assert.deepEqual(plan.deferredIndexes, []);
});

test('detail enrichment expands with the requested content scope instead of a fixed 24-work window', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({
    note_url: `https://www.douyin.com/video/${index + 1}`,
  }));
  const fullScope = visibleDetailQueuePlan(samples, 40);
  assert.equal(fullScope.requestedSampleLimit, 40);
  assert.equal(fullScope.effectiveSampleLimit, 40);
  assert.equal(fullScope.queuedIndexes.length, 40);
  assert.deepEqual(fullScope.deferredIndexes, []);

  const deliberatelyBounded = visibleDetailQueuePlan(samples, 24);
  assert.equal(deliberatelyBounded.effectiveSampleLimit, 24);
  assert.equal(deliberatelyBounded.queuedIndexes.length, 24);
  assert.deepEqual(deliberatelyBounded.deferredIndexes, Array.from({ length: 16 }, (_, index) => index + 24));
  assert.equal(deliberatelyBounded.deferredIncompleteIndexes.length, 16);
});

test('search detail enrichment queues every public post type for metrics and hot comments', () => {
  const samples = [
    { note_url: 'https://www.douyin.com/video/100', title: 'video' },
    { note_url: 'https://www.douyin.com/note/101', title: 'image note' },
    { note_url: 'https://www.douyin.com/search/ignored', title: 'not a post' },
  ];
  const plan = visibleDetailQueuePlan(samples, samples.length, { includeAllContent: true });
  assert.deepEqual(plan.candidateIndexes, [0, 1]);
  assert.deepEqual(plan.queuedIndexes, [0, 1]);
  assert.deepEqual(plan.cardCompleteIndexes, []);
});

test('search detail enrichment writes merged samples back into the historical search record', () => {
  const records = [{
    author_profile: 'https://www.douyin.com/user/creator-1',
    latest_samples: [{ note_url: 'https://www.douyin.com/video/100', title: 'card title' }],
    profile: { latest_samples: [] },
  }];
  const enriched = [{
    note_url: 'https://www.douyin.com/video/100',
    title: 'detail title',
    statistics: { digg_count: '8.3万', comment_count: '797', collect_count: '7540', share_count: '1.4万' },
    comments: [{ text: 'top comment', like_count: '88' }],
  }];
  const [record] = applySearchDetailEnrichment(records, enriched);
  assert.equal(record.latest_samples[0].title, 'detail title');
  assert.equal(record.latest_samples[0].statistics.comment_count, '797');
  assert.equal(record.latest_samples[0].comments[0].text, 'top comment');
  assert.equal(record.profile.latest_samples[0].title, 'detail title');
  assert.equal(record.public_data_scope, 'visible_public_search_cards_and_post_details');
});

test('detail status exposes deferred and still-incomplete works without fabricating field coverage', () => {
  const summary = finishVisibleDetailSummary({
    detail_url_candidate_count: 40,
    detail_deferred_incomplete_count: 16,
    detail_skipped_count: 16,
    detail_navigation_failed_count: 0,
    detail_blocked_count: 0,
    detail_incomplete_after_enrichment_count: 0,
    detail_uncovered_incomplete_count: 16,
  });
  assert.equal(summary.detail_coverage_state, 'requested_detail_limit_reached');
  assert.equal(summary.detail_continuation_recommended, true);
  assert.equal(summary.detail_next_action, 'increase_detail_sample_limit');
  assert.equal(summary.detail_complete_record_count, 24);

  const publicFieldsMissing = finishVisibleDetailSummary({
    detail_url_candidate_count: 3,
    detail_deferred_incomplete_count: 0,
    detail_skipped_count: 0,
    detail_navigation_failed_count: 0,
    detail_blocked_count: 0,
    detail_incomplete_after_enrichment_count: 1,
    detail_uncovered_incomplete_count: 1,
  });
  assert.equal(publicFieldsMissing.detail_coverage_state, 'public_fields_incomplete');
  assert.equal(publicFieldsMissing.detail_complete_record_count, 2);
});

test('a complete profile-detail fusion skips only a redundant detail retry', () => {
  const profileCard = sampleFromCard({
    note_url: 'https://www.douyin.com/video/104',
    published_at: '2026-07-24 11:00',
  });
  const detailCardWithAllActions = sampleFromCard({
    note_url: 'https://www.douyin.com/video/104',
    interaction_availability: {
      likes: { state: 'count_observed', source: 'rendered_detail' },
      collects: { state: 'count_observed', source: 'rendered_detail' },
      comments: { state: 'count_observed', source: 'rendered_detail' },
      shares: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
    },
  });
  const stillIncompleteDetail = sampleFromCard({
    note_url: 'https://www.douyin.com/video/104',
    interaction_availability: {
      likes: { state: 'count_observed', source: 'rendered_detail' },
    },
  });

  assert.equal(shouldRetryVisibleDetail(profileCard, detailCardWithAllActions), false);
  assert.equal(shouldRetryVisibleDetail(profileCard, stillIncompleteDetail), true);
});

test('a visible detail access gate remains skipped and resumable', () => {
  const summary = {
    detail_attempted_count: 2,
    detail_skipped_count: 4,
    detail_blocked_count: 0,
    detail_blocked_sample_indexes: [],
  };

  markVisibleDetailBlocked(summary, 7);

  assert.equal(summary.detail_attempted_count, 1);
  assert.equal(summary.detail_skipped_count, 5);
  assert.equal(summary.detail_blocked_count, 1);
  assert.deepEqual(summary.detail_blocked_sample_indexes, [7]);
});

test('the Node Relay collector rejects non-Douyin direct targets and detects user-visible gates', () => {
  assert.throws(
    () => parseArgs(['--profile-url', 'https://example.test/user/a', '--output-dir', '.tmp']),
    /Invalid profile URL/,
  );
  assert.equal(pageAccessState('https://www.douyin.com/', '\u8bf7\u767b\u5f55'), 'login_required');
  assert.equal(
    pageAccessState(
      'https://www.douyin.com/user/public-creator',
      '\u767b\u5f55 95.8\u4e07\u7c89\u4e1d 64.0\u4e07\u83b7\u8d5e',
      12,
    ),
    '',
  );
  assert.equal(pageAccessState('https://www.douyin.com/', '\u5b89\u5168\u9a8c\u8bc1'), 'verification_required');
  assert.equal(
    pageAccessState('https://www.douyin.com/security/verify', '\u767b\u5f55 public cards', 12),
    'verification_required',
  );
  assert.equal(pageAccessState('https://www.douyin.com/', 'public page'), '');
  assert.equal(shouldBlockSearchAccess('login_required', 0), true);
  assert.equal(shouldBlockSearchAccess('login_required', 1), false);
  assert.equal(shouldBlockSearchAccess('verification_required', 1), true);
});

test('visible search cards are deduplicated by public profile while retaining visible content samples', () => {
  const records = mergeVisibleSearchCards(new Map(), [
    {
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a?from=search',
      note_url: 'https://www.douyin.com/video/100?from=search',
      title: 'Visible card one',
      body: 'Visible public card text.',
      cover_url: 'https://p3.douyinpic.com/visible-cover.jpg?temporary=value',
      visible_metrics: ['12.3w \u8d5e'],
      published_at_text: '\u6628\u5929',
      duration_text: '00:18',
      content_type: 'video',
      content_format: 'video',
      has_video: true,
    },
    {
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      note_url: 'https://www.douyin.com/video/101',
      title: 'Visible card two',
      body: 'A second public card.',
      content_type: 'video',
      content_format: 'video',
      has_video: true,
    },
  ], 'https://www.douyin.com/search/skincare?type=general');

  assert.equal(records.size, 1);
  const record = records.get('https://www.douyin.com/user/creator-a');
  assert.equal(record.author.nickname, 'Creator A');
  assert.equal(record.latest_samples.length, 2);
  assert.equal(record.profile.latest_samples.length, 2);
  assert.equal(record.public_data_scope, 'visible_public_search_cards');
  assert.equal(canonicalDouyinUrl(record.latest_samples[0].note_url), 'https://www.douyin.com/video/100');
  assert.equal(record.latest_samples[0].cover_url, 'https://p3.douyinpic.com/visible-cover.jpg?temporary=value');
  assert.deepEqual(record.latest_samples[0].visible_metrics, ['12.3w \u8d5e']);
  assert.equal(record.latest_samples[0].published_at_text, '\u6628\u5929');
  assert.equal(record.latest_samples[0].duration_text, '00:18');
  assert.equal('cookies' in record, false);
});

test('visible user-search cards become profile candidates when no video link is present', () => {
  const records = mergeVisibleSearchCards(new Map(), [{
    author: 'Creator B',
    author_profile: 'https://www.douyin.com/user/creator-b?from=search',
    note_url: '',
    title: 'Public account card',
    body: 'Visible account card text.',
    content_type: 'profile',
    content_format: 'profile_card',
    has_video: false,
  }], 'https://www.douyin.com/search/skincare?type=user');

  assert.equal(records.size, 1);
  const record = records.get('https://www.douyin.com/user/creator-b');
  assert.equal(record.observed_name, 'Creator B');
  assert.equal(record.latest_samples.length, 0);
  assert.equal(record.profile.latest_samples.length, 0);
  assert.equal(record.content_summary.visible_sample_count, 0);
});

test('visible profile and detail fields survive normalization and detail metrics take precedence', () => {
  const profileCard = sampleFromCard({
    note_url: 'https://www.douyin.com/video/100?from=profile',
    title: 'Visible video',
    body: 'Visible card body',
    has_video: true,
    content_type: 'video',
    content_format: 'video',
    statistics: { digg_count: 12, collect_count: 77 },
  });
  const detailCard = sampleFromCard({
    note_url: 'https://www.douyin.com/video/100',
    published_at: 1_720_000_000,
    duration_seconds: 46,
    content_image_count: 0,
    is_pinned: true,
    statistics: {
      digg_count: 99,
      comment_count: 4,
      share_count: 2,
    },
    interaction_availability: {
      likes: { state: 'count_observed', source: 'rendered_detail' },
      collects: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
    },
    has_video: true,
    content_type: 'video',
    content_format: 'video',
  });

  assert.equal(detailCard.published_at, 1_720_000_000);
  assert.equal(detailCard.duration_seconds, 46);
  assert.equal(detailCard.content_image_count, 0);
  assert.equal(detailCard.is_pinned, true);
  assert.deepEqual(detailCard.statistics, {
    digg_count: 99,
    comment_count: 4,
    share_count: 2,
  });
  assert.deepEqual(detailCard.interaction_availability, {
    likes: { state: 'count_observed', source: 'rendered_detail' },
    collects: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
  });

  const merged = mergeDouyinVisibleSamples(profileCard, detailCard);
  assert.equal(merged.published_at, 1_720_000_000);
  assert.equal(merged.duration_seconds, 46);
  assert.equal(merged.content_image_count, 0);
  assert.equal(merged.is_pinned, true);
  assert.deepEqual(merged.statistics, {
    digg_count: 99,
    comment_count: 4,
    share_count: 2,
  });
  assert.deepEqual(merged.interaction_availability, {
    likes: { state: 'count_observed', source: 'rendered_detail' },
    collects: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
  });
});

test('a stable public result surface is completed while a missing result surface stays resumable', () => {
  assert.equal(searchIdleStopReason(12), 'page_exhausted');
  assert.equal(searchIdleStopReason(0), 'public_results_unavailable_retryable');
});

test('a stable profile grid completes only after successful scroll evidence', () => {
  assert.equal(profileIdleStopReason(true), 'profile_page_exhausted');
  assert.equal(profileIdleStopReason(false), 'public_profile_settled_retryable');
  assert.equal(profileIdleStopReason(null), 'public_profile_settled_retryable');
});

test('profile coverage separates a requested content cap from exhaustion and a resumable scan', () => {
  const capped = profileCollectionCoverage({
    stopReason: 'requested_limit_reached',
    requestedLimit: 24,
    returnedVisibleSampleCount: 24,
  });
  assert.equal(capped.requested_content_sample_limit, 24);
  assert.equal(capped.returned_visible_content_samples, 24);
  assert.equal(capped.requested_limit_reached, true);
  assert.equal(capped.public_profile_pages_exhausted, false);
  assert.equal(capped.more_public_content_may_be_available, true);
  assert.equal(capped.continuation_recommended, false);
  assert.equal(capped.coverage_state, 'requested_limit_reached');
  assert.equal(capped.next_collection_action, 'increase_sample_limit');

  const exhausted = profileCollectionCoverage({
    stopReason: 'page_exhausted',
    requestedLimit: 1500,
    returnedVisibleSampleCount: 137,
  });
  assert.equal(exhausted.public_profile_pages_exhausted, true);
  assert.equal(exhausted.more_public_content_may_be_available, false);
  assert.equal(exhausted.continuation_recommended, false);
  assert.equal(exhausted.coverage_state, 'page_exhausted');

  const resumable = profileCollectionCoverage({
    stopReason: 'bounded_scan_limit',
    requestedLimit: 1500,
    returnedVisibleSampleCount: 812,
  });
  assert.equal(resumable.public_profile_pages_exhausted, false);
  assert.equal(resumable.more_public_content_may_be_available, true);
  assert.equal(resumable.continuation_recommended, true);
  assert.equal(resumable.coverage_state, 'resumable');
  assert.equal(resumable.next_collection_action, 'resume_collection');
});

test('profile collection ignores scroll position alone when deciding whether the grid progressed', () => {
  const before = { fingerprint: 'first', top: 0, height: 1200 };
  assert.equal(profileSurfaceProgressed(before, { fingerprint: 'first', top: 900, height: 1200 }), false);
  assert.equal(profileSurfaceProgressed(before, { fingerprint: 'second', top: 900, height: 1200 }), true);
  assert.equal(profileSurfaceProgressed(before, { fingerprint: 'first', top: 900, height: 1240 }), true);
});

test('only an empty retryable search result triggers one normal page reload', () => {
  assert.equal(shouldRetrySearchPageLoad({
    records: [],
    status: { stop_reason: 'public_results_unavailable_retryable' },
  }), true);
  assert.equal(shouldRetrySearchPageLoad({
    records: [{ author_profile: 'https://www.douyin.com/user/creator-a' }],
    status: { stop_reason: 'page_exhausted' },
  }), false);
  assert.equal(shouldRetrySearchPageLoad({
    records: [],
    status: { stop_reason: 'platform_verification_required' },
  }), false);
});
