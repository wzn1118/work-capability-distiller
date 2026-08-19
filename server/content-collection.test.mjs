import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicContentItemLedger,
  contentCollectionFollowUpPhase,
  contentCollectionReportedPhase,
  contentCollectionWorkerCount,
  contentDetailPriorityOrder,
  contentResumeCompletedPhases,
  deriveCreatorContentCapture,
  discoveryCardProfileBaselineResult,
  mergeCreatorContentCaptures,
} from './content-collection.mjs';
import { deriveCreatorPersona } from './enrichment.mjs';
import { canonicalCreatorIdentity } from './normalizer.mjs';

const sourceUrl = 'https://www.douyin.com/user/content-creator';
const creator = {
  id: 'douyin-content-creator',
  channel: 'douyin',
  platform: 'Douyin',
  name: 'Content Creator',
  sourceUrl,
  identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
  niche: 'skin care',
  angle: 'ingredient review',
};

const detailedVisibleBody = 'Detailed public content context for semantic interpretation. '.repeat(12).trim();

test('breadth-first full collection closes each card after its catalog phase', () => {
  assert.equal(contentCollectionReportedPhase('breadth_first_full', 'catalog'), 'catalog_detail');
  assert.equal(contentCollectionReportedPhase('breadth_first_full', 'profile'), 'profile');
  assert.equal(contentCollectionReportedPhase('standard', 'catalog'), 'content');
  assert.equal(contentCollectionFollowUpPhase({
    strategy: 'breadth_first_full',
    phase: 'catalog',
    completedPhases: ['profile', 'catalog'],
  }), 'detail');
  assert.equal(contentCollectionFollowUpPhase({
    strategy: 'breadth_first_full',
    phase: 'catalog',
    completedPhases: ['profile', 'catalog', 'detail'],
  }), null);
  assert.equal(contentCollectionFollowUpPhase({
    strategy: 'breadth_first_full',
    phase: 'catalog',
    connectionPaused: true,
    completedPhases: ['profile', 'catalog'],
  }), null);
});

test('detail closure prioritizes smaller saved catalogs without dropping or reshuffling ties', () => {
  const items = [
    { item: { target: { targetId: 'large' } }, index: 0 },
    { item: { target: { targetId: 'empty-a' } }, index: 1 },
    { item: { target: { targetId: 'unknown' } }, index: 2 },
    { item: { target: { targetId: 'small-a' } }, index: 3 },
    { item: { target: { targetId: 'empty-b' } }, index: 4 },
    { item: { target: { targetId: 'small-b' } }, index: 5 },
  ];
  const counts = new Map([
    ['large', 106],
    ['empty-a', 0],
    ['small-a', 3],
    ['empty-b', 0],
    ['small-b', 3],
  ]);

  assert.deepEqual(
    contentDetailPriorityOrder(items, counts).map(({ item }) => item.target.targetId),
    ['empty-a', 'empty-b', 'small-a', 'small-b', 'large', 'unknown'],
  );
  assert.equal(items[0].item.target.targetId, 'large');
});

test('browser relay content collection keeps a single navigation owner', () => {
  assert.equal(contentCollectionWorkerCount({
    requested: 4,
    pendingCount: 794,
    platformModes: ['browser_relay'],
  }), 1);
  assert.equal(contentCollectionWorkerCount({
    requested: 4,
    pendingCount: 3,
    platformModes: ['partner_api'],
  }), 3);
  assert.equal(contentCollectionWorkerCount({
    requested: 2,
    pendingCount: 10,
    platformModes: ['partner_api', 'browser_relay'],
  }), 1);
});

test('breadth-first resume keeps profile checkpoints but requeues catalog and detail', () => {
  assert.deepEqual(contentResumeCompletedPhases({
    strategy: 'breadth_first_full',
    completedPhases: ['profile', 'catalog', 'detail'],
    resumable: true,
  }), ['profile']);
  assert.deepEqual(contentResumeCompletedPhases({
    strategy: 'standard',
    completedPhases: ['detail'],
    resumable: true,
  }), ['detail']);
  assert.deepEqual(contentResumeCompletedPhases({
    strategy: 'breadth_first_full',
    completedPhases: ['profile', 'catalog'],
    resumable: false,
  }), ['profile', 'catalog']);
});

const samples = Array.from({ length: 24 }, (_, index) => ({
  note_url: `https://www.douyin.com/video/${1000 + index}`,
  title: `Public sample ${index + 1}`,
  body: index === 0 ? detailedVisibleBody : `Visible public content sample ${index + 1}.`,
  content_type: index % 2 ? 'video' : 'image',
  hashtags: ['skincare', `topic-${index + 1}`],
  published_at: `2026-07-${String((index % 20) + 1).padStart(2, '0')}`,
  duration_seconds: 42.5 + index,
  is_pinned: index === 0,
  commercial_markers: index === 0 ? ['paid partnership'] : [],
  brand_mentions: index === 0 ? ['Example Brand'] : [],
  statistics: { digg_count: 100 + index, comment_count: 5 + index, share_count: 2 + index, play_count: 1000 + index },
  interaction_availability: index === 0 ? {
    likes: { state: 'count_observed', source: 'rendered_detail' },
    collects: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
  } : {},
}));

const records = [{
  author: 'Content Creator',
  observed_name: 'Content Creator',
  author_profile: sourceUrl,
  follower_count: '12.3w',
  profile: {
    public_audience_signals: ['skin-care learners'],
    commercial_signals: ['brand collaboration visible'],
    latest_samples: samples,
    content_summary: {
      visible_sample_count: samples.length,
      sampled_from_public_profile: true,
    },
  },
}];

test('content refresh merges new evidence without replacing saved samples with an empty retry', () => {
  const previous = deriveCreatorContentCapture({
    creator: { ...creator, followers: 105000, profileLikes: 225000 },
    records: [{
      ...records[0],
      profile: { ...records[0].profile, latest_samples: samples.slice(0, 2) },
    }],
    requestedContentLimit: 10000,
    capturedAt: '2026-07-26T00:00:00.000Z',
  });
  const emptyRetry = deriveCreatorContentCapture({
    creator,
    records: [{ author: creator.name, author_profile: creator.sourceUrl, profile: { latest_samples: [] } }],
    collectionMeta: { stop_reason: 'public_profile_settled_retryable', continuation_recommended: true },
    requestedContentLimit: 10000,
    capturedAt: '2026-07-26T01:00:00.000Z',
  });

  const merged = mergeCreatorContentCaptures(previous, emptyRetry);
  assert.equal(merged.content.visibleSampleCount, 2);
  assert.equal(merged.content.itemLedger.uniquePublicContentCount, 2);
  assert.equal(merged.profile.followerCount, 123000);
  assert.equal(merged.content.collectionCoverage.continuationRecommended, true);
  assert.equal(merged.status, 'collected');
});

test('saved discovery metrics form a traceable profile baseline without inventing content', () => {
  const baseline = discoveryCardProfileBaselineResult({
    ...creator,
    handle: 'content_creator',
    followers: 105000,
    profileLikes: 225000,
  }, '2026-07-26T00:00:00.000Z');
  const capture = deriveCreatorContentCapture({
    creator: { ...creator, handle: 'content_creator', followers: 105000, profileLikes: 225000 },
    ...baseline,
    requestedContentLimit: 10000,
    capturedAt: '2026-07-26T00:00:00.000Z',
  });

  assert.equal(baseline.source, 'saved_discovery_public_card');
  assert.equal(capture.profile.followerCount, 105000);
  assert.equal(capture.profile.totalLikes, 225000);
  assert.equal(capture.profile.metricSources.followers, 'saved_discovery.followers');
  assert.equal(capture.profile.metricSources.totalLikes, 'saved_discovery.profileLikes');
  assert.equal(capture.content.visibleSampleCount, 0);
  assert.equal(capture.evidence.publicDataScope, 'discovery_card');
  assert.equal(capture.profileConfirmation.matchMethod, 'saved_discovery_profile_identity');
});

test('content collection preserves the requested bounded visible sample count without changing normal persona defaults', () => {
  const ordinaryPersona = deriveCreatorPersona({
    creator,
    records,
    capturedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(ordinaryPersona.content.visibleSamples.length, 12);

  const capture = deriveCreatorContentCapture({
    creator,
    records,
    source: 'browser_relay',
    requestedContentLimit: 24,
    confirmation: {
      expectedName: 'Content Creator',
      observedName: 'Content Creator',
      matchMethod: 'direct_profile_url',
    },
    capturedAt: '2026-07-22T00:00:00.000Z',
  });

  assert.equal(capture.status, 'collected');
  assert.equal(capture.content.requestedSampleLimit, 24);
  assert.equal(capture.content.visibleSampleCount, 24);
  assert.equal(capture.content.reportedVisibleSampleCount, 24);
  assert.equal(capture.content.visibleSamples.length, 24);
  assert.equal(capture.content.visibleSamples.at(-1).sourceUrl, 'https://www.douyin.com/video/1023');
  assert.equal('body' in capture.content.visibleSamples[0], false);
  assert.equal(capture.content.visibleSamples[0].detailText, detailedVisibleBody);
  assert.equal(capture.content.visibleSamples[0].durationSeconds, 42.5);
  assert.equal(capture.content.visibleSamples[0].isPinned, true);
  assert.equal(capture.content.visibleSamples[0].publishedAt, '2026-07-01');
  assert.equal(capture.content.visibleSamples[0].publishedAtIso, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(capture.content.visibleSamples[0].commercialMarkers, ['paid partnership']);
  assert.deepEqual(capture.content.visibleSamples[0].brandMentions, ['Example Brand']);
  assert.deepEqual(capture.content.visibleSamples[0].interactions, { likes: 100, comments: 5, shares: 2, plays: 1000 });
  assert.deepEqual(capture.content.visibleSamples[0].interactionAvailability, {
    likes: { state: 'count_observed', source: 'rendered_detail' },
    collects: { state: 'action_visible_count_not_shown', source: 'rendered_detail' },
  });
  assert.equal(capture.profile.followerCount, 123000);
  assert.deepEqual(capture.audience.publicSignals, ['skin-care learners']);
  assert.equal(capture.performance.engagement.interactionObservedSampleCount, 24);
  assert.deepEqual(capture.commercial.signals, ['brand collaboration visible']);
  assert.equal(capture.evidence.publicDataScope, 'profile_and_visible_content');
});

test('content collection retains a 500-item public content batch for later per-item analysis', () => {
  const highVolumeSamples = Array.from({ length: 500 }, (_, index) => ({
    note_url: `https://www.douyin.com/video/${2000 + index}`,
    title: `High-volume public sample ${index + 1}`,
    body: `Public content evidence ${index + 1}.`,
    content_type: index % 2 ? 'video' : 'image',
    hashtags: ['skincare', `batch-${index + 1}`],
    statistics: { digg_count: 1000 + index },
  }));
  const highVolumeRecords = [{
    ...records[0],
    profile: {
      ...records[0].profile,
      latest_samples: highVolumeSamples,
      content_summary: {
        visible_sample_count: highVolumeSamples.length,
        sampled_from_public_profile: true,
      },
    },
  }];

  const capture = deriveCreatorContentCapture({
    creator,
    records: highVolumeRecords,
    source: 'browser_relay',
    requestedContentLimit: 500,
    capturedAt: '2026-07-23T00:00:00.000Z',
  });

  assert.equal(capture.status, 'collected');
  assert.equal(capture.content.requestedSampleLimit, 500);
  assert.equal(capture.content.visibleSampleCount, 500);
  assert.equal(capture.content.visibleSamples.length, 500);
  assert.equal(capture.content.visibleSamples.at(-1).sourceUrl, 'https://www.douyin.com/video/2499');
  assert.equal(capture.performance.engagement.interactionObservedSampleCount, 500);
});

test('content collection exposes a per-item public ledger with dedupe and resumable coverage states', () => {
  const ledger = buildPublicContentItemLedger({
    channel: 'douyin',
    requestedContentLimit: 3,
    samples: [
      {
        sourceUrl: 'https://www.douyin.com/video/one?from=profile',
        contentType: 'video',
        title: 'Canonical public video',
        interactions: { likes: 25, comments: 3 },
      },
      {
        sourceUrl: 'https://www.douyin.com/video/one?from=pinned',
        contentType: 'video',
        title: 'Repeated visible reference',
      },
      {
        contentType: 'video',
        title: 'Rendered row without a public URL',
      },
    ],
  });

  assert.equal(ledger.uniquePublicContentCount, 1);
  assert.equal(ledger.duplicateVisibleReferenceCount, 1);
  assert.equal(ledger.unavailableContentCount, 1);
  assert.equal(ledger.publicVideoCandidateCount, 1);
  assert.equal(ledger.items[0].status, 'collected');
  assert.equal(ledger.items[0].sourceUrl, 'https://www.douyin.com/video/one');
  assert.equal(ledger.items[1].status, 'duplicate_visible_reference');
  assert.equal(ledger.items[1].duplicateOfSampleIndex, 1);
  assert.equal(ledger.items[1].duplicateOfContentItemId, ledger.items[0].id);
  assert.notEqual(ledger.items[0].id, ledger.items[1].id);
  assert.equal(ledger.items[1].canonicalContentId, ledger.items[0].canonicalContentId);
  assert.equal(ledger.items[2].status, 'unavailable_source_url');
  assert.equal(ledger.items[2].analysisStatus, 'not_available');
  assert.ok(ledger.items.every((item) => Array.isArray(item.semanticSegments)));
  assert.ok(ledger.items.every((item) => item.semanticSegments.every((segment) => segment.id && segment.status === 'observed')));

  const retryable = deriveCreatorContentCapture({
    creator,
    records,
    requestedContentLimit: 24,
    collectionMeta: {
      stop_reason: 'retryable',
      continuation_recommended: true,
    },
    capturedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(retryable.content.collectionCoverage.completion, 'retryable');
  assert.equal(retryable.content.collectionCoverage.continuationRecommended, true);
  assert.equal(retryable.content.collectionCoverage.continuationEvidenceSource, 'collection_meta.continuation_recommended');
  assert.equal(retryable.content.collectionCoverage.resumeState, 'continuation_recommended');
  assert.equal(retryable.content.collectionCoverage.coverageState, 'resumable');
  assert.equal(retryable.content.collectionCoverage.morePublicContentMayBeAvailable, true);
  assert.equal(retryable.content.collectionCoverage.nextCollectionAction, 'resume_collection');

  const nestedRetryable = deriveCreatorContentCapture({
    creator,
    records,
    requestedContentLimit: 24,
    collectionMeta: {
      stop_reason: 'public_profile_settled',
      stop_evidence: {
        classification: 'retryable_collection_gap',
        continuation_recommended: true,
      },
    },
    capturedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(nestedRetryable.content.collectionCoverage.completion, 'retryable');
  assert.equal(nestedRetryable.content.collectionCoverage.continuationRecommended, true);
  assert.equal(nestedRetryable.content.collectionCoverage.continuationEvidenceSource, 'stop_evidence.continuation_recommended');
  assert.equal(nestedRetryable.content.collectionCoverage.resumeState, 'continuation_recommended');

  const exhausted = deriveCreatorContentCapture({
    creator,
    records,
    requestedContentLimit: 24,
    collectionMeta: { stopReason: 'page_exhausted' },
    capturedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(exhausted.content.collectionCoverage.completion, 'page_exhausted');
  assert.equal(exhausted.content.collectionCoverage.resumeState, 'not_recommended');
  assert.equal(exhausted.content.collectionCoverage.coverageState, 'page_exhausted');
  assert.equal(exhausted.content.collectionCoverage.pageExhausted, true);
  assert.equal(exhausted.content.collectionCoverage.morePublicContentMayBeAvailable, false);

  const limited = deriveCreatorContentCapture({
    creator,
    records,
    requestedContentLimit: 24,
    collectionMeta: { completionReason: 'sample_limit_reached' },
    capturedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(limited.content.collectionCoverage.completion, 'sample_limit_reached');
  assert.equal(limited.content.collectionCoverage.coverageState, 'requested_limit_reached');
  assert.equal(limited.content.collectionCoverage.returnedVisibleSampleCount, 24);
  assert.equal(limited.content.collectionCoverage.requestedSampleLimit, 24);
  assert.equal(limited.content.collectionCoverage.requestedLimitReached, true);
  assert.equal(limited.content.collectionCoverage.pageExhausted, false);
  assert.equal(limited.content.collectionCoverage.morePublicContentMayBeAvailable, true);
  assert.equal(limited.content.collectionCoverage.resumeState, 'increase_sample_limit_to_continue');
  assert.equal(limited.content.collectionCoverage.nextCollectionAction, 'increase_sample_limit');

  const relayReportedLimit = deriveCreatorContentCapture({
    creator,
    records,
    collectionMeta: {
      stop_reason: 'requested_limit_reached',
      requested_content_sample_limit: 24,
      returned_visible_content_samples: 24,
      public_profile_pages_exhausted: false,
    },
    capturedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(relayReportedLimit.content.collectionCoverage.requestedSampleLimit, 24);
  assert.equal(relayReportedLimit.content.collectionCoverage.sourceReportedVisibleSampleCount, 24);
  assert.equal(relayReportedLimit.content.collectionCoverage.coverageState, 'requested_limit_reached');
});

test('content collection persists deterministic evidence-only semantic segments for every captured item', () => {
  const input = {
    creator,
    records,
    source: 'browser_relay',
    requestedContentLimit: 24,
    capturedAt: '2026-07-24T00:00:00.000Z',
  };
  const capture = deriveCreatorContentCapture(input);
  const firstSample = capture.content.visibleSamples[0];
  const bodySegments = firstSample.contentSegments.filter((segment) => segment.kind === 'body_sentence');

  assert.equal(firstSample.segmentStatus, 'segmented');
  assert.equal(firstSample.segmentCount, firstSample.contentSegments.length);
  assert.equal(capture.content.itemLedger.items, undefined);
  assert.equal(bodySegments.length, 12);
  assert.equal(bodySegments[0].text, 'Detailed public content context for semantic interpretation.');
  assert.deepEqual(bodySegments[0].sourceFields, ['detailText']);
  assert.equal(bodySegments[0].sequence, 2);
  assert.equal(bodySegments[0].startSeconds, null);
  assert.equal(bodySegments[0].endSeconds, null);
  assert.equal(bodySegments[0].status, 'observed');
  assert.ok(firstSample.contentSegments.some((segment) => segment.kind === 'title' && segment.text === 'Public sample 1'));
  assert.ok(firstSample.contentSegments.some((segment) => segment.kind === 'hashtag' && segment.text === 'skincare'));
  assert.ok(firstSample.contentSegments.some((segment) => segment.kind === 'metadata'
    && segment.metadataKey === 'duration_seconds' && segment.text === '42.5'));
  assert.ok(firstSample.contentSegments.every((segment) => /^public-content-segment-/.test(segment.id)));

  const videoSample = capture.content.visibleSamples[1];
  assert.equal(videoSample.videoAnalysisStatus, 'pending');
  assert.equal(videoSample.segmentStatus, 'segmented');
  assert.equal(videoSample.timedSegmentStatus, 'pending_video_evidence');
  assert.equal(videoSample.timedSegmentCount, 0);
  assert.ok(videoSample.contentSegments.length > 0);
  assert.ok(videoSample.contentSegments.every((segment) => segment.startSeconds === null && segment.endSeconds === null));

  assert.equal(capture.content.itemLedger.segmentedItemCount, 24);
  assert.equal(capture.content.itemLedger.unsegmentedItemCount, 0);
  assert.equal(capture.content.itemLedger.pendingTimedExpansionItemCount,
    capture.content.itemLedger.publicVideoCandidateCount);
  assert.equal(capture.content.itemLedger.totalSegmentCount,
    capture.content.visibleSamples.reduce((sum, item) => sum + item.segmentCount, 0));
  assert.equal(capture.content.itemLedger.segmentKindCounts.body_sentence, 35);

  const repeated = deriveCreatorContentCapture(input);
  assert.deepEqual(repeated.content.itemLedger, capture.content.itemLedger);
  assert.deepEqual(
    repeated.content.visibleSamples.map((sample) => ({
      contentItemId: sample.contentItemId,
      contentSegments: sample.contentSegments,
      segmentStatus: sample.segmentStatus,
      segmentCount: sample.segmentCount,
      timedSegmentStatus: sample.timedSegmentStatus,
    })),
    capture.content.visibleSamples.map((sample) => ({
      contentItemId: sample.contentItemId,
      contentSegments: sample.contentSegments,
      segmentStatus: sample.segmentStatus,
      segmentCount: sample.segmentCount,
      timedSegmentStatus: sample.timedSegmentStatus,
    })),
  );
});
