import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeVideoFrames, validateVideoVisionOutput } from './video-vision.mjs';

function modelOutput(frameIndexes = [1]) {
  return {
    summary: 'A presenter speaks directly to camera beside a visible product label.',
    visualThemes: ['talking head'],
    sceneTypes: ['indoor close-up'],
    onScreenTextSignals: ['skin care'],
    productSignals: ['bottle visible'],
    visibleBrandSignals: [],
    commercialSignals: [],
    reviewSignals: [],
    brandSafetyFlags: [],
    frameObservations: frameIndexes.map((frameIndex) => ({
      frameIndex,
      description: `Frame ${frameIndex} shows the presenter and a caption.` ,
      visualSignals: ['presenter'],
      textSignals: ['caption'],
      productSignals: [],
    })),
    confidence: 0.86,
  };
}

async function withFrames(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-video-vision-'));
  const framesDirectory = path.join(root, 'frames');
  const videoDirectory = path.join(root, 'video');
  await fs.mkdir(framesDirectory, { recursive: true });
  await fs.mkdir(videoDirectory, { recursive: true });
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(path.join(framesDirectory, `frame-${String(index).padStart(2, '0')}.jpg`), Buffer.from([0xff, 0xd8, index, 0xff, 0xd9]));
  }
  try {
    return await run({
      root,
      framesDirectory,
      videoDirectory,
      frames: Array.from({ length: 5 }, (_, offset) => ({
        index: offset + 1,
        filename: `frame-${String(offset + 1).padStart(2, '0')}.jpg`,
        artifactPath: `analysis/video/frames/frame-${String(offset + 1).padStart(2, '0')}.jpg?temporary=secret`,
      })),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('strict video vision output validation rejects unknown fields and scrubs URLs', () => {
  const valid = modelOutput([1]);
  valid.summary = 'Visible caption https://media.example/clip?temporary=secret';
  const sanitized = validateVideoVisionOutput(valid, [1]);
  assert.ok(sanitized);
  assert.equal(sanitized.summary.includes('temporary=secret'), false);
  assert.equal(sanitized.summary.includes('[link omitted]'), true);
  assert.equal(validateVideoVisionOutput({ ...modelOutput([1]), extra: true }, [1]), null);
  assert.equal(validateVideoVisionOutput(modelOutput([2]), [1]), null);
});

test('video vision keeps review signals separate and drops negative legacy safety statements', () => {
  const output = modelOutput([1]);
  output.visibleBrandSignals = ['Visible Acme logo'];
  output.commercialSignals = ['Visible paid partnership disclosure'];
  output.reviewSignals = [
    {
      category: 'medical_or_efficacy_claim',
      severity: 'medium',
      description: 'Visible before-and-after efficacy claim text.',
      frameIndexes: [1],
    },
    {
      category: 'other_review',
      severity: 'low',
      description: 'No brand safety flags detected.',
      frameIndexes: [1],
    },
  ];
  output.brandSafetyFlags = [
    'No brand safety flags detected.',
    'none',
    '\u672a\u53d1\u73b0\u54c1\u724c\u5b89\u5168\u98ce\u9669',
  ];

  const normalized = validateVideoVisionOutput(output, [1]);

  assert.ok(normalized);
  assert.deepEqual(normalized.visibleBrandSignals, ['Visible Acme logo']);
  assert.deepEqual(normalized.commercialSignals, ['Visible paid partnership disclosure']);
  assert.deepEqual(normalized.reviewSignals, [{
    category: 'medical_or_efficacy_claim',
    severity: 'medium',
    description: 'Visible before-and-after efficacy claim text.',
    frameIndexes: [1],
  }]);
  assert.deepEqual(normalized.brandSafetyFlags, []);
});

test('video vision derives an aggregate only from non-empty model frame observations', () => {
  const output = modelOutput([1]);
  output.summary = '';
  const normalized = validateVideoVisionOutput(output, [1]);
  assert.ok(normalized);
  assert.match(normalized.summary, /Frame 1 shows/);
  output.frameObservations[0].description = '';
  assert.equal(validateVideoVisionOutput(output, [1]), null);
});

test('video vision drops model observations for frames that were never submitted', () => {
  const output = modelOutput([1, 2]);
  output.summary = 'Aggregate mentions an unsubmitted frame.';
  const normalized = validateVideoVisionOutput(output, [1]);

  assert.ok(normalized);
  assert.deepEqual(normalized.frameObservations.map((observation) => observation.frameIndex), [1]);
  assert.match(normalized.summary, /Frame 1 shows/);
});

test('video vision makes no request until an explicit model is configured', async () => {
  let calls = 0;
  const result = await analyzeVideoFrames({
    frames: [],
    framesDirectory: '',
    videoDirectory: '',
    artifactRootDirectory: '',
    platform: 'douyin',
    visionConfig: { baseUrl: 'http://127.0.0.1:11434' },
    fetchImpl: async () => { calls += 1; throw new Error('should not run'); },
  });
  assert.equal(result.status, 'not_configured');
  assert.equal(calls, 0);
});

test('video vision uses at most four local base64 frames and persists only sanitized output', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    let request;
    const output = modelOutput([1, 2, 3, 4]);
    output.summary = 'Visible care routine https://runtime.example/video?temporary=secret';
    const result = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: {
        model: 'qwen2.5vl:3b',
        baseUrl: 'http://127.0.0.1:11434',
        maxFrames: 99,
        timeoutMs: 5_000,
      },
      deadline: Date.now() + 10_000,
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ message: { content: JSON.stringify(output) } }),
        };
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.submittedFrameCount, 4);
    assert.deepEqual(result.submittedFrameIndexes, [1, 2, 3, 4]);
    assert.deepEqual(result.frameIndexes, [1, 2, 3, 4]);
    assert.equal(result.analyzedFrameCount, 4);
    assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(request.body.format.additionalProperties, false);
    assert.equal(request.body.options.num_ctx, 8192);
    assert.equal(request.body.options.num_predict, 2_000);
    assert.equal(request.body.messages[0].images.length, 4);
    assert.equal(request.body.messages[0].images[0].startsWith('/9g'), true);
    assert.equal(JSON.stringify(request.body).includes('temporary=secret'), false);
    const artifact = await fs.readFile(path.join(videoDirectory, 'visual-semantics.json'), 'utf8');
    assert.equal(artifact.includes('temporary=secret'), false);
    assert.equal(artifact.includes('[link omitted]'), true);
  });
});

test('video vision repairs literal control characters inside an otherwise valid model JSON string', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    const output = modelOutput([1]);
    output.frameObservations[0].description = 'First visible line\nSecond visible line.';
    const malformedJson = JSON.stringify(output).replace('\\n', '\n');
    const result = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', maxFrames: 1, timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: { content: malformedJson } }),
      }),
    });

    assert.equal(result.status, 'completed');
    assert.match(result.result.frameObservations[0].description, /First visible line Second visible line/);
  });
});

test('video vision keeps its timeout active while a response body is stalled', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    let aborted = false;
    const result = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 1_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async (_url, options) => {
        const body = new ReadableStream({
          start(controller) {
            options.signal.addEventListener('abort', () => {
              aborted = true;
              controller.error(new Error('body aborted'));
            }, { once: true });
          },
        });
        return { ok: true, status: 200, headers: new Headers(), body };
      },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(aborted, true);
  });
});

test('video vision rejects an oversized declared response before reading its body', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    let aborted = false;
    let readerRequested = false;
    const result = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async (_url, options) => {
        options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '99999' }),
          body: {
            getReader() {
              readerRequested = true;
              throw new Error('body must not be read');
            },
          },
        };
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(aborted, true);
    assert.equal(readerRequested, false);
  });
});

test('video vision aborts a streamed response once the actual byte cap is exceeded', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    let aborted = false;
    let cancelled = false;
    const result = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async (_url, options) => {
        options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(100_000)));
          },
          cancel() {
            cancelled = true;
          },
        });
        return { ok: true, status: 200, headers: new Headers(), body };
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(aborted, true);
    assert.equal(cancelled, true);
  });
});

test('video vision reports verified observations separately from submitted frames', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    const partial = modelOutput([2]);
    const partialResult = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: { content: JSON.stringify(partial) } }),
      }),
    });
    assert.equal(partialResult.status, 'completed');
    assert.equal(partialResult.submittedFrameCount, 4);
    assert.deepEqual(partialResult.submittedFrameIndexes, [1, 2, 3, 4]);
    assert.equal(partialResult.analyzedFrameCount, 1);
    assert.deepEqual(partialResult.frameIndexes, [2]);
    const partialArtifact = JSON.parse(await fs.readFile(path.join(videoDirectory, 'visual-semantics.json'), 'utf8'));
    assert.deepEqual(partialArtifact.input, { frameCount: 4, frameIndexes: [1, 2, 3, 4] });
    assert.deepEqual(partialArtifact.analysis, { analyzedFrameCount: 1, frameIndexes: [2] });

    const empty = modelOutput([]);
    const emptyResult = await analyzeVideoFrames({
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'douyin',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: { content: JSON.stringify(empty) } }),
      }),
    });
    assert.equal(emptyResult.status, 'completed');
    assert.equal(emptyResult.submittedFrameCount, 4);
    assert.equal(emptyResult.analyzedFrameCount, 0);
    assert.deepEqual(emptyResult.frameIndexes, []);
  });
});

test('video vision distinguishes unavailable Ollama from malformed model output', async () => {
  await withFrames(async ({ root, framesDirectory, videoDirectory, frames }) => {
    const options = {
      frames,
      framesDirectory,
      videoDirectory,
      artifactRootDirectory: root,
      platform: 'xiaohongshu',
      visionConfig: { model: 'qwen2.5vl:3b', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 5_000 },
      deadline: Date.now() + 10_000,
    };
    const unavailable = await analyzeVideoFrames({
      ...options,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(unavailable.status, 'unavailable');
    assert.match(unavailable.limitations[0], /endpoint could not be reached/);
    const malformed = await analyzeVideoFrames({
      ...options,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"message":{"content":"not-json"}}' }),
    });
    assert.equal(malformed.status, 'failed');
  });
});
