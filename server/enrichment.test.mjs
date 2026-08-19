import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveCreatorPersona,
  normalizeEnrichmentTarget,
  profileCaptureTransportError,
  selectEnrichmentTargets,
} from './enrichment.mjs';

const discoveryCreator = {
  id: 'douyin-creator-a',
  channel: 'douyin',
  platform: 'Douyin',
  sourceUrl: 'https://www.douyin.com/user/creator-a?from=search',
  identityKey: 'douyin:creator-a',
  name: 'Creator A',
  handle: 'creator-a',
  niche: 'skin care',
  angle: 'ingredient review',
  fit: 87,
  sampleCount: 4,
  interactions: 1200,
};

test('selectEnrichmentTargets only returns profile-linked creators from the saved discovery task', () => {
  const discoveryJob = {
    results: [
      discoveryCreator,
      {
        id: 'invalid',
        channel: 'douyin',
        sourceUrl: 'https://www.douyin.com/video/123',
        identityKey: '',
      },
    ],
  };

  const selected = selectEnrichmentTargets(discoveryJob, ['douyin-creator-a'], 240);
  assert.equal(selected.availableCount, 1);
  assert.equal(selected.targets.length, 1);
  assert.equal(selected.targets[0].sourceUrl, 'https://www.douyin.com/user/creator-a');
  assert.equal(selected.targets[0].identityKey, 'douyin:creator-a');

  const all = selectEnrichmentTargets(discoveryJob, null, 240);
  assert.equal(all.targets.length, 1);
  assert.deepEqual(selectEnrichmentTargets(discoveryJob, ['missing'], 240).missingIds, ['missing']);
});

test('enrichment excludes saved gateway error records and falls back from a malformed profile name', () => {
  const errorCreator = {
    ...discoveryCreator,
    id: 'douyin-error-page',
    name: '504 Gateway Time-out',
    sourceUrl: 'https://www.douyin.com/user/error-page',
    identityKey: 'douyin:error-page',
  };
  const selected = selectEnrichmentTargets({ results: [discoveryCreator, errorCreator] }, null, 240);
  assert.equal(selected.availableCount, 1);
  assert.deepEqual(selected.targets.map((creator) => creator.id), [discoveryCreator.id]);

  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      observed_name: '502 Bad Gateway',
      author_profile: 'https://www.douyin.com/user/creator-a',
      follower_count: '12.3w',
    }],
    capturedAt: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(persona.name, 'Creator A');
  assert.equal(persona.profile.displayName, 'Creator A');
  assert.deepEqual(persona.provenance.dimensions.account.displayName.sourcePaths, ['saved_discovery.name']);
});

test('profile transport errors stop confirmation even when a saved-looking creator name is present', () => {
  const titleError = profileCaptureTransportError([{
    title: '502 Bad Gateway',
    observed_name: 'Creator A',
    author_profile: 'https://www.douyin.com/user/creator-a',
  }]);
  assert.equal(titleError?.code, 'PROFILE_TRANSPORT_ERROR');
  assert.equal(titleError?.retryable, true);
  assert.deepEqual(titleError?.evidence, {
    sourcePath: 'title',
    value: '502 Bad Gateway',
  });

  const bodyError = profileCaptureTransportError([{
    title: 'Creator A',
    observed_name: 'Creator A',
    body: '504 Gateway Time-out\nnginx',
  }]);
  assert.equal(bodyError?.retryable, true);
  assert.equal(bodyError?.evidence.sourcePath, 'body');

  assert.equal(profileCaptureTransportError([{
    title: 'Creator A',
    observed_name: 'Creator A',
    body: 'Public profile body.',
  }]), null);
});

test('deriveCreatorPersona keeps observed public profile fields separate from derived signals', () => {
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      handle: 'creator-a-public',
      follower_count: '12.3w',
      following_count: '56',
      like_count: '45.6w',
      work_count: '128',
      bio: 'Ingredient-first beauty reviews #skincare #serum',
      location: 'Shanghai',
      verified: true,
      account_created_at: '2025-07-21T00:00:00.000Z',
      homepage_url: 'https://www.douyin.com/user/creator-a',
      profile_title: 'Creator A - Douyin',
      profile_text: 'Creator A\nIP\u5c5e\u5730\uff1a\u4e0a\u6d77\n\u7c89\u4e1d 12.3w',
      tags: 'skincare|serum',
      risk_flags: ['Public compliance label'],
      profile: {
        profile_tags: ['beauty', 'ingredient review'],
        account_type: 'creator',
        visible_metrics: ['12.3w followers', '45.6w likes'],
        public_audience_signals: ['Fan club visible'],
        latest_samples: [{
          note_url: 'https://www.douyin.com/video/123',
          title: 'Serum routine',
          body: 'A concise public content sample.',
          cover_url: 'https://example.test/cover.jpg',
          content_type: 'video',
          hashtags: ['#skincare', '#serum'],
          published_at: '2026-07-20',
          duration_seconds: 45,
          is_pinned: true,
          commercial_markers: ['paid partnership'],
          brand_mentions: ['Brand A'],
          statistics: {
            digg_count: '1.2w',
            collect_count: 560,
            comment_count: 34,
            share_count: 7,
          },
          interaction_availability: {
            likes: { state: 'count_observed', source: 'rendered_detail' },
            collects: { state: 'count_observed', source: 'rendered_detail' },
          },
        }, {
          note_url: 'https://www.douyin.com/video/456',
          title: 'Makeup base comparison',
          body: 'A second public content sample.',
          content_type: 'image',
          hashtags: ['#serum', '#makeup'],
          published_at: '2026-07-12',
          duration_seconds: 90,
          is_pinned: false,
          statistics: {
            digg_count: 1600,
            collect_count: 80,
            comment_count: 20,
            share_count: 3,
          },
        }],
        content_summary: {
          visible_sample_count: 2,
          sample_interactions: { digg_count: 13600, collect_count: 640, comment_count: 54, share_count: 10 },
          sample_interaction_coverage: { likes: 2, collects: 2, comments: 2, shares: 2 },
          sample_hashtags: ['skincare', 'serum', 'makeup'],
          sample_commercial_markers: ['paid partnership'],
          sample_commercial_disclosure_count: 1,
          sampled_from_public_profile: true,
        },
      },
      scraped_at: '2026-07-21T00:00:00.000Z',
    }],
    source: 'browser_relay',
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.status, 'enriched');
  assert.equal(persona.schemaVersion, 4);
  assert.equal(persona.sourceUrl, 'https://www.douyin.com/user/creator-a');
  assert.equal(persona.profile.followerCount, 123000);
  assert.equal(persona.profile.followingCount, 56);
  assert.equal(persona.profile.totalLikes, 456000);
  assert.equal(persona.profile.workCount, 128);
  assert.equal(persona.profile.verified, true);
  assert.equal(persona.profile.accountType, 'creator');
  assert.equal(persona.profile.homepageUrl, 'https://www.douyin.com/user/creator-a');
  assert.equal(persona.profile.profileTitle, 'Creator A - Douyin');
  assert.equal(persona.profile.profileText, 'Creator A IP\u5c5e\u5730\uff1a\u4e0a\u6d77 \u7c89\u4e1d 12.3w');
  assert.equal(persona.handle, 'creator-a-public');
  assert.equal(persona.profile.accountAgeDays, 365);
  assert.equal(persona.commercial.creatorTier, 'macro');
  assert.deepEqual(persona.content.primaryTopics.slice(0, 2), ['skincare', 'serum']);
  assert.deepEqual(persona.profile.visibleMetrics, ['12.3w followers', '45.6w likes']);
  assert.deepEqual(persona.profile.publicAudienceSignals, ['Fan club visible']);
  assert.equal(persona.content.visibleSampleCount, 2);
  assert.equal(persona.content.reportedVisibleSampleCount, 2);
  assert.equal(persona.content.retainedVisibleSampleCount, 2);
  assert.equal(persona.content.coverage.collectionStatus, 'partial_against_current_public_work_count');
  assert.equal(persona.content.coverage.retentionStatus, 'retained_reported_visible_samples');
  assert.equal(persona.content.visibleSamples[0].sourceUrl, 'https://www.douyin.com/video/123');
  assert.equal(persona.content.visibleSamples[0].interactions.likes, 12000);
  assert.deepEqual(persona.content.visibleSamples[0].interactionAvailability, {
    likes: { state: 'count_observed', source: 'rendered_detail' },
    collects: { state: 'count_observed', source: 'rendered_detail' },
  });
  assert.deepEqual(persona.content.sampleInteractions, { likes: 13600, collects: 640, comments: 54, shares: 10 });
  assert.deepEqual(persona.content.verticals.publicProfileTags, ['beauty', 'ingredient review']);
  assert.equal(persona.content.contentMix.duration.averageSeconds, 67.5);
  assert.equal(persona.content.contentMix.pinned.pinnedSampleCount, 1);
  assert.equal(persona.content.contentMix.media.videoSampleCount, 1);
  assert.equal(persona.content.postingCadence.status, 'observed');
  assert.equal(persona.content.postingCadence.estimatedPostsPer30Days, 3.75);
  assert.equal(persona.performance.engagement.interactionObservedSampleCount, 2);
  assert.equal(persona.performance.engagement.interactionCoverage.likes, 2);
  assert.ok(persona.performance.engagement.audienceEngagementRate > 0);
  assert.equal(persona.performance.engagement.observedPerSampleInteractionActions.observedCount, 2);
  assert.ok(persona.performance.engagement.averageActionRatePerFollower.likes > 0);
  assert.equal(persona.content.contentStrategy.formats.uniqueFormatCount, 2);
  assert.equal(persona.content.contentStrategy.presentationCoverage.titleObservedSampleCount, 2);
  assert.equal(persona.content.contentStrategy.publishing.newestContentAgeDays, 1);
  assert.equal(persona.commercial.explicitDisclosure.status, 'observed');
  assert.deepEqual(persona.commercial.brandMentions.labels, ['Brand A']);
  assert.equal(persona.commercial.coverage.markerObservedSampleCount, 1);
  assert.equal(persona.audience.aggregate, null);
  assert.equal(persona.audience.availability.publicProfileSignals, 'observed');
  assert.equal(persona.audience.availability.demographicAggregate, 'not_provided');
  assert.equal(persona.audience.coverage.publicProfileSignals.status, 'observed');
  assert.equal(persona.audience.coverage.aggregateAudience.status, 'not_attached');
  assert.equal(persona.audience.coverage.individualFanRecords.status, 'not_collected');
  assert.equal(persona.growth.status, 'insufficient_history');
  assert.equal(persona.growth.velocity.status, 'not_computable');
  assert.equal(persona.risk.assessment, null);
  assert.deepEqual(persona.risk.sourceBreakdown.publicProfileLabels, ['Public compliance label']);
  assert.equal(persona.dimensions.account.scale.followerCount, 123000);
  assert.equal(persona.dimensions.account.ratios.likesPerWork, 3562.5);
  assert.equal(persona.profile.coverage.status, 'partial');
  assert.equal(persona.dimensions.dataQuality.dimensionAvailability.account, 'observed');
  assert.equal(persona.provenance.schemaVersion, 1);
  assert.deepEqual(persona.provenance.dimensions.account.followers.sourcePaths, ['follower_count']);
  assert.equal(persona.provenance.dimensions.contentStrategy.visibleSamples.sampleCount, 2);
  assert.equal(persona.provenance.dimensions.contentStrategy.captureCoverage.status, 'observed');
  assert.equal('body' in persona.content.visibleSamples[0], false);
  assert.ok(persona.quality.observedFields.includes('visibleContent'));
  assert.ok(persona.quality.observedFields.includes('contentTimestamps'));
  assert.equal(persona.evidence.source, 'browser_relay');
  assert.ok(persona.quality.observedFields.includes('followers'));
});

test('deriveCreatorPersona normalizes explicitly labeled public card metrics and publication aliases', () => {
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      profile: {
        latest_samples: [{
          note_url: 'https://www.douyin.com/video/labeled-1',
          body: 'Public card one.',
          content_type: 'video',
          published_at_text: '2026-07-20',
          duration_text: '01:30',
          visible_metrics: ['1.2w\u70b9\u8d5e', '300\u6536\u85cf', '18\u8bc4\u8bba', '6\u5206\u4eab'],
        }, {
          note_url: 'https://www.douyin.com/video/labeled-2',
          body: 'Public card two.',
          content_type: 'video',
          published_time_text: '07-10',
          visibleMetrics: ['0\u70b9\u8d5e', '50\u6536\u85cf'],
        }, {
          note_url: 'https://www.douyin.com/video/unlabeled-number',
          body: 'A number without an observed metric label.',
          content_type: 'video',
          visible_metrics: ['900'],
        }],
        content_summary: { visible_sample_count: 3 },
      },
    }],
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.content.visibleSamples[0].publishedAt, '2026-07-20');
  assert.equal(persona.content.visibleSamples[0].publishedAtIso, '2026-07-20T00:00:00.000Z');
  assert.equal(persona.content.visibleSamples[0].durationSeconds, 90);
  assert.deepEqual(persona.content.visibleSamples[0].interactions, {
    likes: 12000,
    collects: 300,
    comments: 18,
    shares: 6,
  });
  assert.equal(persona.content.visibleSamples[1].publishedAtIso, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(persona.content.visibleSamples[1].interactions, { likes: 0, collects: 50 });
  assert.deepEqual(persona.content.visibleSamples[2].interactions, {});
  assert.equal(persona.content.postingCadence.status, 'observed');
  assert.equal(persona.content.postingCadence.estimatedPostsPer30Days, 3);
  assert.equal(persona.performance.engagement.interactionCoverage.likes, 2);
  assert.equal(persona.performance.engagement.interactionCoverage.collects, 2);
  assert.equal(persona.performance.engagement.averages.likes, 6000);
  assert.equal(persona.performance.engagement.averages.collects, 175);
});

test('deriveCreatorPersona keeps public play metrics separate from interaction actions and records absent audience aggregates', () => {
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      follower_count: 20000,
      work_count: 2,
      profile: {
        latest_samples: [{
          note_url: 'https://www.douyin.com/video/view-1',
          title: 'Public video',
          content_type: 'video',
          content_format: 'video',
          has_video: true,
          content_image_count: 0,
          statistics: { digg_count: 100, play_count: 10000 },
        }, {
          note_url: 'https://www.douyin.com/video/view-2',
          title: 'Public carousel',
          content_type: 'image',
          content_format: 'image_carousel',
          has_video: false,
          content_image_count: 3,
          statistics: { digg_count: 50, play_count: 5000 },
        }],
        content_summary: { visible_sample_count: 2 },
      },
    }],
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.performance.engagement.totalObservedInteractionActions, 150);
  assert.equal(persona.performance.engagement.viewPerformance.status, 'observed');
  assert.equal(persona.performance.engagement.viewPerformance.totalObservedPlays, 15000);
  assert.equal(persona.performance.engagement.viewPerformance.actionRatePer100Plays.likes, 1);
  assert.equal(persona.content.contentMix.media.videoSampleCount, 1);
  assert.equal(persona.content.contentMix.media.imageBearingSampleCount, 1);
  assert.equal(persona.audience.coverage.publicProfileSignals.status, 'not_visible_on_captured_public_profile');
  assert.equal(persona.audience.coverage.aggregateAudience.status, 'not_attached');
  assert.equal(persona.audience.scale.status, 'observed');
  assert.equal(persona.content.coverage.collectionStatus, 'reported_visible_samples_match_or_exceed_current_public_work_count');
});

test('deriveCreatorPersona retains up to ten thousand public content samples and exposes capture truncation', () => {
  const rawSamples = Array.from({ length: 10_005 }, (_, index) => ({
    note_url: `https://www.douyin.com/video/${index}`,
    title: `Public content ${index}`,
    content_type: 'video',
  }));
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      work_count: 10_005,
      profile: {
        latest_samples: rawSamples,
        content_summary: { visible_sample_count: 10_005 },
      },
    }],
    collectionMeta: {
      content_sample_limit: 10_000,
      stop_reason: 'sample_limit_reached',
      public_data_scope: 'public_profile_visible_content',
    },
    visibleContentSampleLimit: 10_000,
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.content.visibleSamples.length, 10_000);
  assert.equal(persona.content.reportedVisibleSampleCount, 10_005);
  assert.equal(persona.content.retainedVisibleSampleCount, 10_000);
  assert.equal(persona.content.coverage.collectorSampleLimit, 10_000);
  assert.equal(persona.content.coverage.stopReason, 'sample_limit_reached');
  assert.equal(persona.content.coverage.retentionStatus, 'retained_subset_of_reported_visible_samples');
  assert.equal(persona.content.coverage.collectionStatus, 'reported_visible_samples_match_or_exceed_current_public_work_count');
  assert.ok(persona.quality.limitations.includes('persona_retains_a_bounded_subset_of_visible_content_samples'));
});

test('deriveCreatorPersona calculates growth only against an older matching public snapshot', () => {
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      follower_count: 125000,
      like_count: 480000,
      work_count: 130,
    }],
    historicalPersona: {
      identityKey: 'douyin:creator-a',
      capturedAt: '2026-07-01T00:00:00.000Z',
      profile: {
        followerCount: 120000,
        totalLikes: 450000,
        workCount: 126,
      },
    },
    capturedAt: '2026-07-11T00:00:00.000Z',
  });

  assert.equal(persona.growth.status, 'observed');
  assert.equal(persona.growth.observationWindowDays, 10);
  assert.deepEqual(persona.growth.metrics.followers, {
    current: 125000,
    previous: 120000,
    change: 5000,
    changePercent: 4.166667,
  });
  assert.equal(persona.growth.metrics.totalLikes.change, 30000);
  assert.equal(persona.growth.metrics.works.change, 4);
  assert.equal(persona.growth.velocity.status, 'observed');
  assert.equal(persona.growth.velocity.perDay.followers, 500);
});

test('deriveCreatorPersona leaves bio and public metrics unprovided when only content body is available', () => {
  const body = 'Campaign review: followers: 12.3w; following: 56; likes: 45.6w.';
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      body,
    }],
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.profile.bio, '');
  assert.equal(persona.content.contentSample, body);
  assert.equal(persona.profile.followerCount, null);
  assert.equal(persona.profile.followingCount, null);
  assert.equal(persona.profile.totalLikes, null);
  assert.equal(persona.profile.followerLabel, '\u672a\u63d0\u4f9b');
  assert.equal(persona.profile.followingLabel, '\u672a\u63d0\u4f9b');
  assert.equal(persona.profile.totalLikesLabel, '\u672a\u63d0\u4f9b');
  assert.equal(persona.performance.engagement.audienceEngagementRate, null);
  assert.equal(persona.content.postingCadence.status, 'insufficient_observed_timestamps');
  assert.equal(persona.growth.status, 'insufficient_history');
  assert.equal(persona.audience.availability.demographicAggregate, 'not_provided');
  assert.equal(persona.provenance.dimensions.account.followers.status, 'not_provided');
  assert.equal(persona.provenance.dimensions.engagement.followerNormalizedRates.status, 'not_computable');
});

test('deriveCreatorPersona maps collector profile.metrics without using content text fallbacks', () => {
  const persona = deriveCreatorPersona({
    creator: discoveryCreator,
    records: [{
      author: 'Creator A',
      author_profile: 'https://www.douyin.com/user/creator-a',
      body: 'A content sample with unrelated numbers 2026 and 3.',
      profile: {
        bio: 'Public profile bio.',
        metrics: {
          followers: '12.3w',
          following: '56',
          likes: '45.6w',
        },
      },
    }],
    capturedAt: '2026-07-21T00:00:00.000Z',
  });

  assert.equal(persona.profile.bio, 'Public profile bio.');
  assert.equal(persona.profile.followerCount, 123000);
  assert.equal(persona.profile.followingCount, 56);
  assert.equal(persona.profile.totalLikes, 456000);
});

test('saved Douyin discovery cards repair identity metrics and backfill missing profile fields with provenance', () => {
  const compactLabel = '小赵哥达人关注抖音号: jingjing_lang22.5万获赞10.5万粉丝小赵哥 （抖音达人）小赵哥达人';
  const repaired = normalizeEnrichmentTarget({
    id: 'douyin-xiaozhao',
    channel: 'douyin',
    platform: '抖音',
    name: compactLabel,
    handle: '/user/MS4wLjABAAAAlit400',
    sourceUrl: 'https://www.douyin.com/user/MS4wLjABAAAAlit400',
    followers: null,
    followersLabel: '未提供',
  });
  assert.equal(repaired.name, '小赵哥达人');
  assert.equal(repaired.handle, 'jingjing_lang');
  assert.equal(repaired.followers, 105000);
  assert.equal(repaired.profileLikes, 225000);

  const persona = deriveCreatorPersona({
    creator: repaired,
    records: [{
      observed_name: '小赵哥达人',
      author_profile: repaired.sourceUrl,
      profile: { metrics: {} },
    }],
    capturedAt: '2026-07-26T12:00:00.000Z',
  });
  assert.equal(persona.profile.followerCount, 105000);
  assert.equal(persona.profile.totalLikes, 225000);
  assert.equal(persona.profile.metricSources.followers, 'saved_discovery.followers');
  assert.equal(persona.profile.metricSources.totalLikes, 'saved_discovery.profileLikes');
});
