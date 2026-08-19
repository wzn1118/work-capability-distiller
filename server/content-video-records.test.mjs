import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveContentAnalysis } from './content-analysis.mjs';

function captureWithSamples(samples, videoEvidence = undefined, channel = 'douyin') {
  return {
    id: 'capture-video-records',
    targetId: 'creator-video-records',
    channel,
    name: 'Video Record Creator',
    sourceUrl: channel === 'xiaohongshu'
      ? 'https://www.xiaohongshu.com/user/profile/video-records'
      : 'https://www.douyin.com/user/video-records',
    capturedAt: '2026-07-23T08:00:00.000Z',
    evidence: { publicDataScope: 'profile_and_visible_content' },
    content: {
      visibleSamples: samples,
      ...(videoEvidence === undefined ? {} : { videoEvidence }),
    },
  };
}

function assertReferencesResolve(analysis) {
  const evidenceIds = new Set(analysis.evidence.map((entry) => entry.id));
  for (const item of analysis.videoAnalysis.items) {
    assert.ok(item.evidenceIds.length > 0);
    assert.ok(item.evidenceIds.every((id) => evidenceIds.has(id)));
    assert.ok(item.contentInterpretation.evidenceIds.every((id) => evidenceIds.has(id)));
    assert.ok(item.signals.every((signal) => signal.evidenceIds.every((id) => item.evidenceIds.includes(id))));
    assert.ok(item.findings.every((finding) => finding.evidenceIds.every((id) => item.evidenceIds.includes(id))));
    assert.ok(evidenceIds.has(item.selection.evidenceId));
  }
  assert.ok(analysis.videoAnalysis.rollup.evidenceIds.every((id) => evidenceIds.has(id)));
  assert.ok(analysis.videoAnalysis.rollup.contentInterpretation.evidenceIds.every((id) => evidenceIds.has(id)));
  assert.ok(analysis.videoAnalysis.rollup.signals.every((signal) => signal.evidenceIds.every((id) => evidenceIds.has(id))));
}

test('video analysis records every selected public video without the legacy six-item truncation', () => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    sourceUrl: `https://www.douyin.com/video/full-${index + 1}`,
    title: `Public video ${index + 1}`,
    summary: `Visible content summary ${index + 1}.`,
    contentType: 'video',
    interactions: { digg_count: 100 - index },
  }));
  const videoEvidence = {
    schemaVersion: 'video-evidence/v2',
    status: 'completed',
    coverage: {
      eligibleVideoSampleCount: 8,
      selectedVideoSampleCount: 8,
      selectedSampleIndexes: samples.map((_, index) => index + 1),
      renderedMediaSampleCount: 8,
      sampledFrameCount: 1,
      ocrTextFrameCount: 1,
      transcriptAvailableSampleCount: 1,
      visualSemanticSampleCount: 1,
      externalSummarySampleCount: 1,
    },
    videos: samples.map((sample, index) => ({
      sampleIndex: index + 1,
      sourceUrl: sample.sourceUrl,
      contentType: 'video',
      status: 'completed',
      selectionRank: index + 1,
      selectionReason: 'visible_source_order_fallback',
      rendered: {
        durationSeconds: 20 + index,
        dimensions: { width: 1080, height: 1920 },
        evidence: 'rendered_visible_video_element',
      },
      frames: index === 0 ? [{
        index: 1,
        timeSeconds: 10,
        artifactPath: 'analysis/video-records/frame-01.jpg',
        ocrText: 'Observed screen text',
      }] : [],
      ocr: { status: index === 0 ? 'completed' : 'not_available' },
      transcript: index === 0 ? {
        status: 'completed',
        provider: 'funasr',
        text: 'Observed local audio transcript.',
        segments: [{ startSeconds: 0, endSeconds: 4, text: 'Observed local audio transcript.' }],
      } : { status: 'not_available' },
      vision: index === 0 ? {
        status: 'completed',
        provider: 'ollama',
        model: 'vision-model',
        analyzedFrameCount: 1,
        frameIndexes: [1],
        result: {
          summary: 'A visible product demonstration frame.',
          confidence: 0.82,
          visualThemes: ['product demonstration'],
          sceneTypes: ['talking head'],
          productSignals: ['hand-held product'],
          frameObservations: [{
            frameIndex: 1,
            description: 'A presenter holds a product.',
            visualSignals: ['presenter'],
            productSignals: ['product'],
          }],
        },
      } : { status: 'not_available' },
      externalEvidence: index === 0 ? [{
        provider: '302_video_summary',
        status: 'completed',
        signals: { comments: 'Observed external context.' },
      }] : [],
      summary: index === 0 ? {
        provider: '302_video_summary',
        summary: 'Observed structured provider summary.',
        keypoints: ['provider keypoint'],
      } : null,
    })),
    limitations: [],
  };

  const analysis = deriveContentAnalysis({ capture: captureWithSamples(samples, videoEvidence) });
  const records = analysis.videoAnalysis.items;
  const rollup = analysis.videoAnalysis.rollup;

  assert.equal(analysis.video.videos.length, 8);
  assert.equal(records.length, 8);
  assert.deepEqual(records.map((item) => item.sampleIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(records.every((item) => item.status === 'completed'), true);
  assert.equal(records[7].selection.selectionRank, 8);
  assert.ok(analysis.evidence.some((entry) => entry.id === 'video:sample:8:eligibility'));
  assert.ok(records[0].signals.some((signal) => signal.id === 'screen-text'));
  assert.ok(records[0].signals.some((signal) => signal.id === 'visual-semantics'));
  assert.ok(records[0].signals.some((signal) => signal.id === 'audio-transcript'));
  assert.ok(records[0].signals.some((signal) => signal.id === 'external-summary'));
  assert.match(records[0].summary, /内容解读/);
  assert.match(records[0].summary, /Observed structured provider summary/);
  assert.ok(records[0].contentInterpretation.sourceKinds.includes('external_summary'));
  assert.ok(records[0].signals.some((signal) => (
    signal.id === 'content-interpretation'
      && signal.label === '内容解读'
      && signal.evidenceIds.includes('video:sample:1:provider-summary')
  )));
  assert.equal(rollup.status, 'completed');
  assert.equal(rollup.coverage.eligibleVideoCount, 8);
  assert.equal(rollup.coverage.selectedVideoCount, 8);
  assert.equal(rollup.coverage.completedVideoCount, 8);
  assert.equal(rollup.coverage.analysisScope, 'all_visible_video_samples');
  assert.match(rollup.summary, /代表性内容线索/);
  assert.ok(rollup.signals.some((signal) => signal.label === '达人视频内容概览'));
  assertReferencesResolve(analysis);
});

test('video analysis keeps an evidence-linked record for eligible videos outside a bounded processing subset', () => {
  const samples = [
    {
      sourceUrl: 'https://www.douyin.com/video/selected',
      summary: 'Selected video summary.',
      contentType: 'video',
      interactions: { digg_count: 50 },
    },
    {
      sourceUrl: 'https://www.douyin.com/video/not-selected',
      summary: 'Unselected video summary.',
      contentType: 'video',
      interactions: { digg_count: 25 },
    },
    {
      sourceUrl: 'https://www.douyin.com/note/image-only',
      summary: 'Image post.',
      contentType: 'image',
    },
  ];
  const videoEvidence = {
    schemaVersion: 'video-evidence/v2',
    status: 'completed',
    coverage: {
      eligibleVideoSampleCount: 2,
      selectedVideoSampleCount: 1,
      selectedSampleIndexes: [1],
      renderedMediaSampleCount: 1,
    },
    videos: [{
      sampleIndex: 1,
      sourceUrl: samples[0].sourceUrl,
      contentType: 'video',
      status: 'completed',
      selectionRank: 1,
      selectionReason: 'observed_interaction_rank',
      rendered: {
        durationSeconds: 24,
        dimensions: { width: 1080, height: 1920 },
        evidence: 'rendered_visible_video_element',
      },
      frames: [],
      transcript: { status: 'not_available' },
      vision: { status: 'not_available' },
      limitations: [],
    }],
    limitations: ['Video analysis used an explicit operational subset.'],
  };

  const analysis = deriveContentAnalysis({ capture: captureWithSamples(samples, videoEvidence) });
  const [selected, notSelected] = analysis.videoAnalysis.items;

  assert.equal(analysis.videoAnalysis.items.length, 2);
  assert.equal(selected.status, 'completed');
  assert.equal(selected.selection.selectedForProcessing, true);
  assert.equal(notSelected.status, 'not_selected');
  assert.equal(notSelected.selection.selectedForProcessing, false);
  assert.ok(notSelected.evidenceIds.includes('video:sample:2:eligibility'));
  assert.ok(notSelected.evidenceIds.includes('sample:2:text'));
  assert.ok(notSelected.limitations.some((item) => /尚未处理该条/.test(item)));
  assert.equal(analysis.videoAnalysis.rollup.coverage.selectedVideoCount, 1);
  assert.equal(analysis.videoAnalysis.rollup.coverage.notSelectedVideoCount, 1);
  assert.equal(analysis.videoAnalysis.rollup.coverage.analysisScope, 'configured_subset');
  assert.ok(analysis.videoAnalysis.rollup.limitations.some((item) => /每条符合规则/.test(item)));
  assertReferencesResolve(analysis);
});

test('video analysis reconstructs a historical eligible-video record when no video-evidence payload was saved', () => {
  const samples = [{
    sourceUrl: 'https://www.xiaohongshu.com/explore/historical-video',
    title: 'Historical visible video',
    summary: 'Historical visible content summary.',
    contentType: 'video',
  }];
  const analysis = deriveContentAnalysis({ capture: captureWithSamples(samples, undefined, 'xiaohongshu') });
  const [record] = analysis.videoAnalysis.items;

  assert.equal(analysis.video, null);
  assert.equal(analysis.videoAnalysis.items.length, 1);
  assert.equal(record.status, 'not_collected');
  assert.equal(record.selection.eligible, true);
  assert.equal(record.selection.selectedForProcessing, false);
  assert.equal(record.selection.processingStatus, 'not_collected');
  assert.ok(record.evidenceIds.includes('video:sample:1:eligibility'));
  assert.ok(record.limitations.some((item) => /未附带视频证据结果/.test(item)));
  assert.equal(analysis.videoAnalysis.rollup.coverage.eligibleVideoCount, 1);
  assert.equal(analysis.videoAnalysis.rollup.coverage.incompleteVideoCount, 1);
  assert.equal(analysis.videoAnalysis.rollup.coverage.reportedEligibleVideoSampleCount, null);
  assertReferencesResolve(analysis);
});
