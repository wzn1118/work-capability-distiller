import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  candidateImageUrl,
  collectVideoEvidence,
  createAsyncQueue,
  createVideoProcessingResources,
  isVideoContentSample,
  mapWithConcurrency,
  mediaRequestArgs,
  mediaRequestHeaders,
  normalizeTranscript,
  ocrFrames,
  parseTranscriptArtifact,
  resolveCachedMediaProbe,
  shouldAttemptTranscript,
  scrubRuntimeUrl,
  selectVideoSamples,
  timelineAnchor,
  videoCandidateSummary,
} from './video-analysis.mjs';

test('bounded video mapper preserves source order and enforces the requested worker ceiling', async () => {
  let active = 0;
  let highestActive = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    highestActive = Math.max(highestActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 12 : 4));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(values, [10, 20, 30, 40, 50, 60]);
  assert.equal(highestActive, 2);
});

test('bounded async queue preserves producer order, capacity, and close semantics', async () => {
  const queue = createAsyncQueue(1);
  assert.equal(await queue.push('one'), true);
  const second = queue.push('two');
  const third = queue.push('three');
  let thirdSettled = false;
  void third.then(() => {
    thirdSettled = true;
  });

  assert.equal(await queue.take(), 'one');
  assert.equal(await second, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdSettled, false);
  assert.equal(await queue.take(), 'two');
  assert.equal(await third, true);
  assert.equal(await queue.take(), 'three');

  const blocked = queue.push('four');
  const blockedBehind = queue.push('five');
  queue.close();
  assert.equal(await blocked, true);
  assert.equal(await blockedBehind, false);
  assert.equal(await queue.take(), 'four');
  assert.equal(await queue.take(), null);
});

test('video sample selection is platform-aware, bounded, and ordered by the visible source list', () => {
  const capture = {
    content: {
      visibleSamples: [
        { sourceUrl: 'https://www.douyin.com/video/one', contentType: 'video', interactions: { digg_count: 1 } },
        { sourceUrl: 'https://www.douyin.com/video/two', contentType: 'video', interactions: { digg_count: 50, comment_count: 2 } },
        { sourceUrl: 'https://www.douyin.com/video/three', contentType: 'video', interactions: { digg_count: 30 } },
        { sourceUrl: 'https://www.douyin.com/note/four', contentType: 'image', interactions: { digg_count: 90 } },
      ],
    },
  };

  const selected = selectVideoSamples(capture, 'douyin', 2);

  assert.deepEqual(selected.map((sample) => sample.sampleIndex), [2, 3]);
  assert.deepEqual(selected.map((sample) => sample.sourceUrl), [
    'https://www.douyin.com/video/two',
    'https://www.douyin.com/video/three',
  ]);
  assert.deepEqual(selected.map((sample) => sample.selectionRank), [1, 2]);
  assert.deepEqual(selected.map((sample) => sample.selectionReason), [
    'observed_interaction_rank',
    'observed_interaction_rank',
  ]);
  assert.deepEqual(selected.map((sample) => sample.selectionObservedInteractionScore), [52, 30]);
  assert.equal(isVideoContentSample(capture.content.visibleSamples[3], 'douyin'), false);
  assert.equal(isVideoContentSample({
    sourceUrl: 'https://www.bilibili.com/video/BV1fixture',
    contentType: 'video',
  }, 'bilibili'), true);
});

test('video sample selection preserves an allowed signed playback URL for direct media acquisition', () => {
  const playbackUrl = 'https://v26-web.douyinvod.com/video/tos/cn/fixture/?token=keep-me&mime_type=video_mp4';
  const selected = selectVideoSamples({
    content: {
      visibleSamples: [{
        sourceUrl: 'https://www.douyin.com/video/fixture',
        contentType: 'video',
        videoUrl: playbackUrl,
      }],
    },
  }, 'douyin');

  assert.equal(selected[0].playbackUrl, playbackUrl);
});

test('Douyin direct media commands carry browser-origin headers without changing the signed URL', () => {
  const playbackUrl = 'https://v26-web.douyinvod.com/video/tos/cn/fixture/?token=keep-me&mime_type=video_mp4';
  const args = mediaRequestArgs('douyin', playbackUrl);

  assert.equal(args[0], '-user_agent');
  assert.match(args[1], /^Mozilla\/5\.0/);
  assert.equal(args[2], '-headers');
  assert.match(args[3], /Referer: https:\/\/www\.douyin\.com\//);
  assert.match(args[3], /Origin: https:\/\/www\.douyin\.com(?:\r?\n|$)/);
  assert.deepEqual(mediaRequestArgs('douyin', 'https://www.douyin.com/video/fixture'), []);
});

test('Douyin image candidates stay on image CDN paths and carry browser-origin headers', () => {
  const imageUrl = 'https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/fixture~tplv-dy-resize-origshort-autoq-75:330.jpeg?token=keep-me';
  assert.equal(candidateImageUrl('douyin', imageUrl), imageUrl);
  assert.match(mediaRequestHeaders('douyin', imageUrl, { kind: 'image' }).Referer, /douyin\.com/);
  assert.equal(candidateImageUrl('douyin', 'https://www.douyin.com/video/fixture'), '');
  assert.equal(candidateImageUrl('douyin', 'https://v26-web.douyinvod.com/video/tos/cn/fixture.mp4'), '');
});

test('video sample selection records visible-source fallback when interaction counts are absent', () => {
  const selected = selectVideoSamples({
    content: {
      visibleSamples: [
        { sourceUrl: 'https://www.douyin.com/video/one', contentType: 'video' },
        { sourceUrl: 'https://www.douyin.com/video/two', contentType: 'video' },
      ],
    },
  }, 'douyin', 1);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].sampleIndex, 1);
  assert.equal(selected[0].selectionRank, 1);
  assert.equal(selected[0].selectionReason, 'visible_source_order_fallback');
  assert.equal(selected[0].selectionObservedInteractionScore, null);
});

test('video sample selection reserves visible pinned and recent evidence before interaction-ranked coverage', () => {
  const selected = selectVideoSamples({
    content: {
      visibleSamples: [
        { sourceUrl: 'https://www.douyin.com/video/old', contentType: 'video', interactions: { digg_count: 90 } },
        { sourceUrl: 'https://www.douyin.com/video/high', contentType: 'video', interactions: { digg_count: 500 } },
        { sourceUrl: 'https://www.douyin.com/video/pinned', contentType: 'video', isPinned: true, interactions: { digg_count: 2 } },
        { sourceUrl: 'https://www.douyin.com/video/recent', contentType: 'video', publishedAtIso: '2026-07-22T09:00:00.000Z', interactions: { digg_count: 5 } },
      ],
    },
  }, 'douyin', 3);

  assert.deepEqual(selected.map((sample) => sample.sampleIndex), [2, 3, 4]);
  assert.deepEqual(selected.map((sample) => sample.selectionRank), [3, 1, 2]);
  assert.deepEqual(selected.map((sample) => sample.selectionReason), [
    'observed_interaction_rank',
    'observed_pinned_sample',
    'observed_recent_sample',
  ]);
  assert.equal(selected[1].isPinned, true);
  assert.equal(selected[2].publishedAt, '2026-07-22T09:00:00.000Z');
});

test('video sample selection covers every captured public video by default', () => {
  const visibleSamples = Array.from({ length: 24 }, (_, index) => ({
    sourceUrl: `https://www.douyin.com/video/${index + 1}`,
    contentType: 'video',
    interactions: { digg_count: 24 - index },
  }));
  const selected = selectVideoSamples({ content: { visibleSamples } }, 'douyin');

  assert.equal(selected.length, 24);
  assert.deepEqual(selected.map((sample) => sample.sampleIndex), Array.from({ length: 24 }, (_, index) => index + 1));
  assert.equal(new Set(selected.map((sample) => sample.selectionRank)).size, 24);
});

test('video candidate summary de-duplicates public references and retains the strongest visible record', () => {
  const capture = {
    content: {
      visibleSamples: [
        {
          sourceUrl: 'https://www.douyin.com/video/repeated?from=feed',
          contentType: 'video',
          interactions: { likes: 12 },
        },
        {
          sourceUrl: 'https://www.douyin.com/video/repeated?from=pinned',
          contentType: 'video',
          isPinned: true,
          interactions: { likes: 1 },
        },
        {
          sourceUrl: 'https://www.douyin.com/video/unique',
          contentType: 'video',
          interactions: { likes: 8 },
        },
      ],
    },
  };

  const summary = videoCandidateSummary(capture, 'douyin');
  const selected = selectVideoSamples(capture, 'douyin');

  assert.equal(summary.observedVideoSampleCount, 3);
  assert.equal(summary.eligibleVideoSampleCount, 2);
  assert.equal(summary.duplicateVisibleReferenceCount, 1);
  assert.deepEqual(selected.map((sample) => sample.sampleIndex), [2, 3]);
  assert.deepEqual(selected.map((sample) => sample.sourceUrl), [
    'https://www.douyin.com/video/repeated',
    'https://www.douyin.com/video/unique',
  ]);
});

test('video processing resources keep local OCR, ASR, and vision concurrency bounded', () => {
  const resources = createVideoProcessingResources(9);
  assert.deepEqual(resources.limits, { ocr: 4, transcript: 2, vision: 2 });
});

async function writeOcrRunner(root, name, payload, exitCode = 0) {
  const runner = path.join(root, `${name}.mjs`);
  await fs.writeFile(runner, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    `const payload = ${JSON.stringify(payload)};`,
    `const exitCode = ${Number(exitCode)};`,
    "const outputIndex = process.argv.indexOf('--output-file');",
    "const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : '';",
    "if (!outputFile) process.exit(91);",
    "await fs.mkdir(path.dirname(outputFile), { recursive: true });",
    "await fs.writeFile(outputFile, JSON.stringify(payload), 'utf8');",
    "process.exit(exitCode);",
  ].join('\n'), 'utf8');
  return runner;
}

test('OCR stage retains precise runtime diagnostics for usable and unavailable local engines', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-ocr-stage-'));
  const framesDirectory = path.join(root, 'frames');
  await fs.mkdir(framesDirectory, { recursive: true });
  await fs.writeFile(path.join(framesDirectory, 'frame-01.jpg'), 'fixture');
  const frames = [{ filename: 'frame-01.jpg', ocrText: '', artifactPath: 'frames/frame-01.jpg' }];
  const baseConfig = {
    python: process.execPath,
    ocrScript: 'ignored-ocr-script.py',
    artifactRootDirectory: root,
  };

  try {
    const successRunner = await writeOcrRunner(root, 'ocr-success', {
      schemaVersion: 2,
      status: 'completed',
      frames: [{ file: 'frame-01.jpg', text: 'Visible product routine' }],
      availability: {
        state: 'ready',
        code: 'RAPIDOCR_READY',
        engine: 'rapidocr_onnxruntime',
        processedFrameCount: 1,
        recognizedFrameCount: 1,
        failedFrameCount: 0,
      },
    });
    const completed = await ocrFrames(
      frames,
      framesDirectory,
      path.join(root, 'success'),
      { ...baseConfig, pythonArgs: [successRunner] },
      Date.now() + 10_000,
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.frames[0].ocrText, 'Visible product routine');
    assert.equal(completed.diagnostics?.code, 'RAPIDOCR_READY');
    assert.equal(completed.diagnostics?.engine, 'rapidocr_onnxruntime');
    assert.match(completed.artifactPath, /frame-ocr\.json$/);

    const unavailableRunner = await writeOcrRunner(root, 'ocr-unavailable', {
      schemaVersion: 2,
      status: 'dependency_unavailable',
      frames: [],
      availability: {
        state: 'dependency_unavailable',
        code: 'ONNXRUNTIME_UNAVAILABLE',
        processedFrameCount: 0,
        recognizedFrameCount: 0,
        failedFrameCount: 0,
      },
    }, 3);
    const unavailable = await ocrFrames(
      frames,
      framesDirectory,
      path.join(root, 'unavailable'),
      { ...baseConfig, pythonArgs: [unavailableRunner] },
      Date.now() + 10_000,
    );
    assert.equal(unavailable.status, 'dependency_unavailable');
    assert.equal(unavailable.diagnostics?.code, 'ONNXRUNTIME_UNAVAILABLE');
    assert.match(unavailable.artifactPath, /frame-ocr\.json$/);
    assert.equal(unavailable.frames[0].ocrText, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cached media probes locally before retrying a signed runtime URL', async () => {
  const runtimeUrl = 'https://v3-dy-o.zjcdn.com/media/clip.mp4?token=transient';
  const localPath = 'C:/temp/kolforge/source-media.mp4';
  const successfulCalls = [];
  const cached = await resolveCachedMediaProbe({
    localMedia: { status: 'completed', localPath, byteLength: 42 },
    runtimeMediaUrl: runtimeUrl,
    videoConfig: {},
    deadline: Date.now() + 30_000,
    probe: async (input) => {
      successfulCalls.push(input);
      return { status: 'completed', hasAudio: true };
    },
  });

  assert.deepEqual(successfulCalls, [localPath]);
  assert.equal(cached.processingInput, localPath);
  assert.equal(cached.probe.status, 'completed');
  assert.equal(cached.usedCachedMedia, true);

  const fallbackCalls = [];
  const removedPaths = [];
  const fallback = await resolveCachedMediaProbe({
    localMedia: { status: 'completed', localPath, byteLength: 42 },
    runtimeMediaUrl: runtimeUrl,
    videoConfig: {},
    deadline: Date.now() + 30_000,
    probe: async (input) => {
      fallbackCalls.push(input);
      return input === localPath ? { status: 'probe_failed' } : { status: 'completed', hasAudio: true };
    },
    removeFile: async (filePath) => {
      removedPaths.push(filePath);
    },
  });

  assert.deepEqual(fallbackCalls, [localPath, runtimeUrl]);
  assert.deepEqual(removedPaths, [localPath]);
  assert.equal(fallback.localMedia.status, 'local_probe_failed');
  assert.equal(fallback.localMedia.localPath, '');
  assert.equal(fallback.processingInput, runtimeUrl);
  assert.equal(fallback.usedCachedMedia, false);
});

test('Whisper artifacts retain bounded timeline segments without durable error fields', () => {
  const transcript = normalizeTranscript({
    error: 'upstream diagnostic must not be retained in evidence',
    segments: [
      { start: 0, end: 2.345, text: '  开场钩子  ' },
      { timestamp: [2.4, 5.678], text: '产品演示' },
      { start: 8, end: 7, text: '保留文本但不保留倒置区间' },
      { start: 9, end: 10, text: '' },
    ],
  });

  assert.equal(transcript.text, '开场钩子 产品演示 保留文本但不保留倒置区间');
  assert.deepEqual(transcript.segments, [
    { index: 1, startSeconds: 0, endSeconds: 2.35, text: '开场钩子' },
    { index: 2, startSeconds: 2.4, endSeconds: 5.68, text: '产品演示' },
    { index: 3, startSeconds: 8, endSeconds: null, text: '保留文本但不保留倒置区间' },
  ]);
  assert.equal(JSON.stringify(transcript).includes('upstream diagnostic'), false);
});

test('Whisper transcript artifacts accept both a JSON document and FFmpeg JSON lines', () => {
  assert.deepEqual(parseTranscriptArtifact('{"segments":[{"start":0,"end":1,"text":"document"}]}'), {
    segments: [{ start: 0, end: 1, text: 'document' }],
  });
  assert.deepEqual(parseTranscriptArtifact([
    '{"start":0,"end":1.2,"text":"first"}',
    '{"start":1.2,"end":2.4,"text":"second"}',
  ].join('\n')), [
    { start: 0, end: 1.2, text: 'first' },
    { start: 1.2, end: 2.4, text: 'second' },
  ]);
  assert.equal(parseTranscriptArtifact('{"start":0}\nnot-json'), null);
});

test('FFmpeg Whisper JSONL millisecond offsets normalize to evidence seconds', () => {
  const transcript = normalizeTranscript(parseTranscriptArtifact([
    '{"start":0,"end":1600,"text":"first"}',
    '{"start":1600,"end":3600,"text":"second"}',
  ].join('\n')), { timestampUnit: 'milliseconds' });

  assert.deepEqual(transcript.segments, [
    { index: 1, startSeconds: 0, endSeconds: 1.6, text: 'first' },
    { index: 2, startSeconds: 1.6, endSeconds: 3.6, text: 'second' },
  ]);
});

test('transcript segment retention is capped and frame anchors cover the timeline deterministically', () => {
  const transcript = normalizeTranscript({
    segments: Array.from({ length: 150 }, (_, index) => ({
      start: index,
      end: index + 0.5,
      text: `segment-${index}`,
    })),
  });

  assert.equal(transcript.segments.length, 120);
  assert.ok(transcript.text.length <= 6_000);
  assert.deepEqual([0, 1, 2, 3, 4].map((index) => timelineAnchor(index, 5)), [
    'opening', 'early', 'middle', 'late', 'closing',
  ]);
  assert.equal(timelineAnchor(0, 1), 'midpoint');
});

test('video evidence retains selection audit coverage even when the browser has no playable media', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-video-evidence-'));
  try {
    const evidence = await collectVideoEvidence({
      capture: {
        content: {
          visibleSamples: [
            { sourceUrl: 'https://www.douyin.com/video/low', contentType: 'video', interactions: { digg_count: 1 } },
            { sourceUrl: 'https://www.douyin.com/video/high', contentType: 'video', interactions: { digg_count: 20 } },
          ],
        },
      },
      platform: 'douyin',
      artifactDirectory: root,
      artifactRootDirectory: root,
      relayPort: 18800,
      videoConfig: {
        enabled: true,
        maxVideosPerCreator: 1,
        framesPerVideo: 1,
        timeoutMs: 30_000,
        python: 'kolforge-test-missing-python',
        pythonArgs: [],
        relayScript: 'unused.py',
        vision: { model: '' },
      },
    });

    assert.equal(evidence.schemaVersion, 'video-evidence/v2');
    assert.equal(evidence.status, 'media_unavailable');
    assert.equal(evidence.videos.length, 1);
    assert.equal(evidence.videos[0].sampleIndex, 2);
    assert.equal(evidence.videos[0].selectionReason, 'observed_interaction_rank');
    assert.deepEqual(evidence.coverage.selectedSampleIndexes, [2]);
    assert.deepEqual(evidence.coverage.selectionReasonCounts, { observed_interaction_rank: 1 });
    assert.equal(evidence.coverage.observedVideoSampleCount, 2);
    assert.equal(evidence.coverage.retryableVideoSampleCount, 1);
    assert.equal(evidence.videos[0].availability.status, 'retryable');
    assert.equal(evidence.videos[0].availability.retryMode, 'reprocess_retained_evidence_or_reconfigure');
    assert.equal(evidence.coverage.timelineFrameCount, 0);
    assert.equal(evidence.coverage.transcriptSegmentCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('video evidence creates one processing record for every eligible visible video by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-video-full-coverage-'));
  try {
    const evidence = await collectVideoEvidence({
      capture: {
        content: {
          visibleSamples: [
            { sourceUrl: 'https://www.douyin.com/video/one', contentType: 'video' },
            { sourceUrl: 'https://www.douyin.com/video/two', contentType: 'video' },
            { sourceUrl: 'https://www.douyin.com/note/three', contentType: 'image' },
          ],
        },
      },
      platform: 'douyin',
      artifactDirectory: root,
      artifactRootDirectory: root,
      relayPort: 18800,
      videoConfig: {
        enabled: true,
        framesPerVideo: 1,
        timeoutMs: 30_000,
        python: 'kolforge-test-missing-python',
        pythonArgs: [],
        relayScript: 'unused.py',
        vision: { model: '' },
      },
    });

    assert.deepEqual(evidence.videos.map((video) => video.sampleIndex), [1, 2]);
    assert.equal(evidence.coverage.eligibleVideoSampleCount, 2);
    assert.equal(evidence.coverage.processedVideoSampleCount, 2);
    assert.equal(evidence.coverage.unprocessedVideoSampleCount, 0);
    assert.equal(evidence.coverage.analysisScope, 'all_visible_video_samples');
    assert.equal(evidence.processor.observationQueueCapacity, 6);
    assert.deepEqual(evidence.videos.map((video) => video.availability.status), ['retryable', 'retryable']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('video evidence resume reuses completed per-video checkpoints without reopening pages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-video-checkpoint-'));
  try {
    const relayNodeScript = path.join(root, 'relay-node.mjs');
    await fs.writeFile(relayNodeScript, `
import fs from 'node:fs/promises';
import path from 'node:path';

const outputFile = process.argv[process.argv.indexOf('--output-file') + 1];
const frameDirectory = process.argv[process.argv.indexOf('--frame-directory') + 1];
await fs.mkdir(frameDirectory, { recursive: true });
await fs.writeFile(path.join(frameDirectory, 'browser-frame-01.jpg'), 'derived-frame', 'utf8');
await fs.writeFile(outputFile, JSON.stringify({
  status: 'media_ready',
  media: {
    mediaUrl: 'https://v3-dy-o.zjcdn.com/media/clip.mp4',
    durationSeconds: 12,
    dimensions: { width: 576, height: 1024 },
    readyState: 4,
  },
  browserFrames: {
    status: 'completed',
    frames: [{
      index: 1,
      filename: 'browser-frame-01.jpg',
      timeSeconds: 2,
      timelineAnchor: 'midpoint',
      samplingReason: 'browser_rendered_timeline_anchor',
    }],
  },
}), 'utf8');
console.log(JSON.stringify({
  status: 'media_ready',
  runtimeMediaUrl: 'https://v3-dy-o.zjcdn.com/media/clip.mp4?token=transient',
  durationSeconds: 12,
  dimensions: { width: 576, height: 1024 },
}));
`, 'utf8');
    const request = {
      capture: {
        content: {
          visibleSamples: [
            { sourceUrl: 'https://www.douyin.com/video/one', contentType: 'video' },
            { sourceUrl: 'https://www.douyin.com/video/two', contentType: 'video' },
          ],
        },
      },
      platform: 'douyin',
      artifactDirectory: root,
      artifactRootDirectory: root,
      relayPort: 18800,
      videoConfig: {
        enabled: true,
        concurrency: 2,
        framesPerVideo: 1,
        timeoutMs: 30_000,
        python: process.execPath,
        pythonArgs: [],
        relayScript: 'unused.py',
        node: process.execPath,
        relayNodeScript,
        ffprobe: 'kolforge-test-missing-ffprobe',
        ffmpeg: 'kolforge-test-missing-ffmpeg',
        localMediaCache: { enabled: false },
        vision: { model: '' },
      },
    };
    const first = await collectVideoEvidence(request);
    assert.equal(first.coverage.checkpointReusedSampleCount, 0);
    assert.equal(first.coverage.retryableVideoSampleCount, 2);
    assert.equal(first.videos[0].availability.retryMode, 'reprocess_retained_evidence_or_reconfigure');
    let reopenedPages = 0;
    const resumed = await collectVideoEvidence({
      ...request,
      resume: true,
      runWithRelayLock: async () => {
        reopenedPages += 1;
        throw new Error('checkpointed samples must not reopen pages');
      },
    });

    assert.equal(reopenedPages, 0);
    assert.equal(resumed.coverage.checkpointReusedSampleCount, 2);
    assert.deepEqual(resumed.videos.map((video) => video.sampleIndex), [1, 2]);

    const checkpointPath = path.join(root, 'video', 'sample-01', 'video-evidence-checkpoint.json');
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    assert.equal(checkpoint.record.availability.retryable, true);
    assert.equal(checkpoint.record.availability.retryMode, 'reprocess_retained_evidence_or_reconfigure');
    checkpoint.record.transcript = { status: 'timed_out', provider: 'fixture' };
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
    let retriedPages = 0;
    const retried = await collectVideoEvidence({
      ...request,
      resume: true,
      runWithRelayLock: async (task) => {
        retriedPages += 1;
        return task();
      },
    });

    assert.equal(retriedPages, 1);
    assert.equal(retried.coverage.checkpointReusedSampleCount, 1);
    assert.deepEqual(retried.videos.map((video) => video.sampleIndex), [1, 2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('video evidence prefers the local Node relay without persisting runtime media tokens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-video-node-relay-'));
  const relayNodeScript = path.join(root, 'relay-node.mjs');
  const pythonRelayScript = path.join(root, 'python-relay.mjs');
  try {
    await fs.writeFile(pythonRelayScript, `
import fs from 'node:fs/promises';
import path from 'node:path';

const outputFile = process.argv[process.argv.indexOf('--output-file') + 1];
await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, JSON.stringify({ status: 'media_not_rendered' }), 'utf8');
console.log(JSON.stringify({ status: 'media_not_rendered' }));
`, 'utf8');
    await fs.writeFile(relayNodeScript, `
import fs from 'node:fs/promises';
import path from 'node:path';

const outputFile = process.argv[process.argv.indexOf('--output-file') + 1];
const frameDirectory = process.argv.includes('--frame-directory')
  ? process.argv[process.argv.indexOf('--frame-directory') + 1]
  : '';
await fs.mkdir(path.dirname(outputFile), { recursive: true });
if (frameDirectory) {
  await fs.mkdir(frameDirectory, { recursive: true });
  await fs.writeFile(path.join(frameDirectory, 'browser-frame-01.jpg'), 'derived-frame', 'utf8');
}
await fs.writeFile(outputFile, JSON.stringify({
  schemaVersion: 1,
  platform: 'douyin',
  contentUrl: 'https://www.douyin.com/video/fallback',
  status: 'media_ready',
  observedAt: '2026-07-22T00:00:00Z',
  media: {
    mediaUrl: 'https://v3-dy-o.zjcdn.com/media/clip.mp4',
    posterUrl: '',
    durationSeconds: 12,
    dimensions: { width: 576, height: 1024 },
    readyState: 4,
    evidence: 'rendered_visible_video_element',
  },
  browserFrames: {
    status: 'completed',
    frames: [{
      index: 1,
      filename: 'browser-frame-01.jpg',
      timeSeconds: 2.16,
      timelineAnchor: 'midpoint',
      samplingReason: 'browser_rendered_timeline_anchor',
    }],
  },
}), 'utf8');
console.log(JSON.stringify({
  status: 'media_ready',
  runtimeMediaUrl: 'https://v3-dy-o.zjcdn.com/media/clip.mp4?token=transient',
  durationSeconds: 12,
  dimensions: { width: 576, height: 1024 },
}));
`, 'utf8');
    const evidence = await collectVideoEvidence({
      capture: {
        content: {
          visibleSamples: [
            { sourceUrl: 'https://www.douyin.com/video/fallback', contentType: 'video', interactions: { digg_count: 7 } },
          ],
        },
      },
      platform: 'douyin',
      artifactDirectory: root,
      artifactRootDirectory: root,
      relayPort: 18800,
      videoConfig: {
        enabled: true,
        maxVideosPerCreator: 1,
        framesPerVideo: 1,
        timeoutMs: 30_000,
        python: process.execPath,
        pythonArgs: [],
        relayScript: pythonRelayScript,
        node: process.execPath,
        relayNodeScript,
        ffprobe: 'kolforge-test-missing-ffprobe',
        ffmpeg: 'kolforge-test-missing-ffmpeg',
        localMediaCache: { enabled: false },
        vision: { model: '' },
      },
    });

    const video = evidence.videos[0];
    assert.equal(video.rendered?.durationSeconds, 12);
    assert.equal(video.rendered?.dimensions?.height, 1024);
    assert.equal(video.mediaCache.status, 'disabled');
    assert.equal(video.status, 'browser_frames_completed_ocr_unavailable');
    assert.equal(video.frameSource, 'browser_rendered');
    assert.equal(video.frames.length, 1);
    assert.equal(video.frames[0].samplingReason, 'browser_rendered_timeline_anchor');
    assert.equal(video.frames[0].artifactPath, 'video/sample-01/browser-frames/browser-frame-01.jpg');
    assert.equal(video.observationArtifactPath, 'video/sample-01/media-observation.json');
    const artifact = await fs.readFile(path.join(root, video.observationArtifactPath), 'utf8');
    assert.equal(artifact.includes('token=transient'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser-rendered video attempts configured transcript when direct probe is unavailable', () => {
  assert.equal(shouldAttemptTranscript(
    { status: 'tooling_unavailable', hasAudio: false },
    { frames: [{ filename: 'browser-frame-01.jpg' }] },
    { whisperModelPath: 'C:/models/ggml-base.bin', transcript: { provider: 'ffmpeg_whisper' } },
  ), true);
  assert.equal(shouldAttemptTranscript(
    { status: 'completed', hasAudio: false },
    { frames: [{ filename: 'browser-frame-01.jpg' }] },
    { whisperModelPath: 'C:/models/ggml-base.bin', transcript: { provider: 'ffmpeg_whisper' } },
  ), false);
  assert.equal(shouldAttemptTranscript(
    { status: 'tooling_unavailable', hasAudio: false },
    { frames: [{ filename: 'browser-frame-01.jpg' }] },
    { whisperModelPath: '', transcript: { provider: 'ffmpeg_whisper' } },
  ), false);
});

test('browser-rendered keyframes complete OCR and visual analysis without a reusable media URL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-browser-frames-only-'));
  let visionServer;
  try {
    const relayNodeScript = path.join(root, 'relay-node.mjs');
    const ocrRunner = await writeOcrRunner(root, 'ocr-browser-frames', {
      schemaVersion: 2,
      status: 'completed',
      frames: [{ file: 'browser-frame-01.jpg', text: 'Visible product launch caption' }],
      availability: {
        state: 'ready',
        code: 'RAPIDOCR_READY',
        engine: 'rapidocr_onnxruntime',
        processedFrameCount: 1,
        recognizedFrameCount: 1,
        failedFrameCount: 0,
      },
    });
    await fs.writeFile(relayNodeScript, `
import fs from 'node:fs/promises';
import path from 'node:path';

const outputFile = process.argv[process.argv.indexOf('--output-file') + 1];
const frameDirectory = process.argv[process.argv.indexOf('--frame-directory') + 1];
await fs.mkdir(frameDirectory, { recursive: true });
await fs.writeFile(path.join(frameDirectory, 'browser-frame-01.jpg'), 'derived-frame', 'utf8');
await fs.writeFile(outputFile, JSON.stringify({
  status: 'media_not_rendered',
  browserFrames: {
    status: 'completed',
    frames: [{
      index: 1,
      filename: 'browser-frame-01.jpg',
      timeSeconds: 1.5,
      timelineAnchor: 'midpoint',
      samplingReason: 'browser_rendered_timeline_anchor',
    }],
  },
}), 'utf8');
console.log(JSON.stringify({ status: 'media_not_rendered' }));
`, 'utf8');

    let visionRequests = 0;
    const visionOutput = {
      summary: 'Frame one shows a creator introducing a visible product launch.',
      visualThemes: ['creator introduction'],
      sceneTypes: ['talking head'],
      onScreenTextSignals: ['product launch'],
      productSignals: ['product label'],
      visibleBrandSignals: [],
      commercialSignals: [],
      reviewSignals: [],
      brandSafetyFlags: [],
      frameObservations: [{
        frameIndex: 1,
        description: 'The creator is speaking beside a product label.',
        visualSignals: ['creator'],
        textSignals: ['product launch'],
        productSignals: ['product label'],
      }],
      confidence: 0.85,
    };
    visionServer = http.createServer((request, response) => {
      visionRequests += 1;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ message: { content: JSON.stringify(visionOutput) } }));
    });
    await new Promise((resolve) => visionServer.listen(0, '127.0.0.1', resolve));
    const address = visionServer.address();
    const evidence = await collectVideoEvidence({
      capture: {
        content: {
          visibleSamples: [
            { sourceUrl: 'https://www.douyin.com/video/browser-frames-only', contentType: 'video' },
          ],
        },
      },
      platform: 'douyin',
      artifactDirectory: root,
      artifactRootDirectory: root,
      relayPort: 18800,
      videoConfig: {
        enabled: true,
        framesPerVideo: 1,
        timeoutMs: 30_000,
        python: process.execPath,
        pythonArgs: [ocrRunner],
        ocrScript: 'unused-ocr-script.py',
        relayScript: 'unused.py',
        node: process.execPath,
        relayNodeScript,
        ffprobe: 'kolforge-test-missing-ffprobe',
        ffmpeg: 'kolforge-test-missing-ffmpeg',
        localMediaCache: { enabled: false },
        whisperModelPath: 'C:/models/ggml-base.bin',
        transcript: { provider: 'ffmpeg_whisper' },
        vision: {
          model: 'qwen2.5vl:3b',
          baseUrl: `http://127.0.0.1:${address.port}`,
          maxFrames: 1,
          timeoutMs: 5_000,
        },
      },
    });

    const video = evidence.videos[0];
    assert.equal(video.status, 'browser_frames_completed');
    assert.equal(video.mediaCache.status, 'browser_frames_only');
    assert.equal(video.frameSource, 'browser_rendered');
    assert.equal(video.ocr.status, 'completed');
    assert.equal(video.frames[0].ocrText, 'Visible product launch caption');
    assert.equal(video.vision.status, 'completed');
    assert.equal(video.vision.result?.summary, visionOutput.summary);
    assert.equal(video.transcript.status, 'not_available');
    assert.equal(video.limitations.some((item) => item.includes('Audio transcription was skipped')), true);
    assert.equal(visionRequests, 1);
  } finally {
    if (visionServer) {
      visionServer.closeAllConnections?.();
      await new Promise((resolve) => visionServer.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime media URLs are scrubbed before they can become durable evidence', () => {
  assert.equal(
    scrubRuntimeUrl('https://v3-dy-o.zjcdn.com/media/clip.mp4?token=temporary#fragment'),
    'https://v3-dy-o.zjcdn.com/media/clip.mp4',
  );
  assert.equal(scrubRuntimeUrl('http://v3-dy-o.zjcdn.com/media/clip.mp4'), '');
  assert.equal(scrubRuntimeUrl('not-a-url'), '');
});
