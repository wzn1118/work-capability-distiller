import fs from 'node:fs/promises';
import path from 'node:path';

export const VIDEO_VISION_SCHEMA_VERSION = 'video-vision/v2';

const MAX_FRAMES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MIN_CONTEXT_LENGTH = 4_096;
const MAX_CONTEXT_LENGTH = 8_192;
const MIN_OUTPUT_TOKENS = 1_200;
const OUTPUT_TOKENS_PER_FRAME = 325;
const MAX_OUTPUT_TOKENS = 2_000;
const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const OUTPUT_KEYS = [
  'summary',
  'visualThemes',
  'sceneTypes',
  'onScreenTextSignals',
  'productSignals',
  'visibleBrandSignals',
  'commercialSignals',
  'reviewSignals',
  // Kept in the persisted shape so v1 callers can still read a v2 artifact.
  // New model responses are instructed to leave this legacy field empty.
  'brandSafetyFlags',
  'frameObservations',
  'confidence',
];
const REVIEW_SIGNAL_KEYS = [
  'category',
  'severity',
  'description',
  'frameIndexes',
];
const REVIEW_SIGNAL_CATEGORIES = new Set([
  'medical_or_efficacy_claim',
  'financial_claim',
  'sweepstake_or_promotion',
  'regulated_product',
  'sensitive_content',
  'other_review',
]);
const REVIEW_SIGNAL_SEVERITIES = new Set(['low', 'medium', 'high']);
const FRAME_OBSERVATION_KEYS = [
  'frameIndex',
  'description',
  'visualSignals',
  'textSignals',
  'productSignals',
];

export const OLLAMA_VIDEO_VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: OUTPUT_KEYS,
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 900 },
    visualThemes: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
    sceneTypes: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
    onScreenTextSignals: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 180 } },
    productSignals: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 160 } },
    visibleBrandSignals: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 160 } },
    commercialSignals: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 160 } },
    reviewSignals: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: REVIEW_SIGNAL_KEYS,
        properties: {
          category: { type: 'string', enum: [...REVIEW_SIGNAL_CATEGORIES] },
          severity: { type: 'string', enum: [...REVIEW_SIGNAL_SEVERITIES] },
          description: { type: 'string', minLength: 1, maxLength: 240 },
          frameIndexes: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_FRAMES,
            uniqueItems: true,
            items: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    brandSafetyFlags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 160 } },
    frameObservations: {
      type: 'array',
      maxItems: MAX_FRAMES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: FRAME_OBSERVATION_KEYS,
        properties: {
          frameIndex: { type: 'integer', minimum: 1 },
          description: { type: 'string', minLength: 1, maxLength: 600 },
          visualSignals: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
          textSignals: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 160 } },
          productSignals: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 160 } },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

function plainText(value, maximum = 360) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function cleanText(value, maximum = 360) {
  return plainText(value, maximum).replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[link omitted]').slice(0, maximum);
}

function configuredModel(value) {
  const model = cleanText(value, 180);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/.test(model) && !model.includes('://') ? model : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function normaliseBaseUrl(value) {
  try {
    const parsed = new URL(plainText(value, 1_000));
    const host = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(host)) return '';
    return parsed.origin.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeStringArray(value, maximumItems, maximumText) {
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== 'string')) return null;
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const cleaned = cleanText(item, maximumText);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    output.push(cleaned);
  }
  return output;
}

function isNegativeReviewStatement(value) {
  const normalized = cleanText(value, 240)
    .toLowerCase()
    .replace(/[\s._,;:!?()\[\]{}-]+/g, ' ')
    .trim();
  const compactChinese = normalized.replace(/\s+/g, '');
  if (!normalized) return true;
  if (/^(?:none|n a|not applicable|no issues?|no flags?|no risks?|no concerns?)$/.test(normalized)) return true;
  if (/\b(?:no|none|without|not|zero)\b.{0,80}\b(?:brand\s+)?(?:safety\s+)?(?:flag|flags|risk|risks|issue|issues|concern|concerns|violation|violations)\b/.test(normalized)) return true;
  if (/^(?:\u65e0|\u6ca1\u6709|\u672a\u53d1\u73b0|\u672a\u89c2\u5bdf\u5230|\u672a\u68c0\u6d4b\u5230|\u672a\u89c1|\u4e0d\u5b58\u5728)$/.test(compactChinese)) return true;
  return /^(?:\u65e0|\u6ca1\u6709|\u672a\u53d1\u73b0|\u672a\u89c2\u5bdf\u5230|\u672a\u68c0\u6d4b\u5230|\u672a\u89c1|\u4e0d\u5b58\u5728).{0,48}(?:\u98ce\u9669|\u5b89\u5168|\u95ee\u9898|\u8fdd\u89c4|\u654f\u611f|\u6807\u8bb0)/.test(compactChinese);
}

function safeReviewSignals(value, allowedIndexes) {
  if (!Array.isArray(value) || value.length > 8) return null;
  const seen = new Set();
  const output = [];
  for (const signal of value) {
    if (!exactKeys(signal, REVIEW_SIGNAL_KEYS)) return null;
    const category = cleanText(signal.category, 80);
    const severity = cleanText(signal.severity, 20);
    const description = cleanText(signal.description, 240);
    if (!REVIEW_SIGNAL_CATEGORIES.has(category) || !REVIEW_SIGNAL_SEVERITIES.has(severity)
      || !description || !Array.isArray(signal.frameIndexes) || !signal.frameIndexes.length
      || signal.frameIndexes.length > MAX_FRAMES) return null;
    const frameIndexes = [];
    const frameSeen = new Set();
    for (const index of signal.frameIndexes) {
      if (!Number.isInteger(index) || !allowedIndexes.has(index) || frameSeen.has(index)) return null;
      frameSeen.add(index);
      frameIndexes.push(index);
    }
    // A model sometimes narrates the absence of a flag as an array item. It is
    // not a review signal and must not become a downstream safety finding.
    if (isNegativeReviewStatement(description)) continue;
    const key = `${category}|${severity}|${description.toLowerCase()}|${frameIndexes.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ category, severity, description, frameIndexes });
  }
  return output;
}

/**
 * Accept only the fixed output shape requested from the local vision model.
 * The model receives no runtime URL, and sanitizing text again prevents one
 * embedded in a frame from becoming a durable evidence value.
 */
export function validateVideoVisionOutput(value, frameIndexes) {
  if (!exactKeys(value, OUTPUT_KEYS)) return null;
  const allowedIndexes = new Set((Array.isArray(frameIndexes) ? frameIndexes : [])
    .filter((index) => Number.isInteger(index) && index > 0));
  const visualThemes = safeStringArray(value.visualThemes, 8, 120);
  const sceneTypes = safeStringArray(value.sceneTypes, 8, 120);
  const onScreenTextSignals = safeStringArray(value.onScreenTextSignals, 8, 180);
  const productSignals = safeStringArray(value.productSignals, 8, 160);
  const visibleBrandSignals = safeStringArray(value.visibleBrandSignals, 8, 160);
  const commercialSignals = safeStringArray(value.commercialSignals, 8, 160);
  const legacyBrandSafetyFlags = safeStringArray(value.brandSafetyFlags, 8, 160);
  const reviewSignals = safeReviewSignals(value.reviewSignals, allowedIndexes);
  if (!visualThemes || !sceneTypes || !onScreenTextSignals || !productSignals || !visibleBrandSignals
    || !commercialSignals || !legacyBrandSafetyFlags || !reviewSignals) return null;
  if (!Array.isArray(value.frameObservations) || value.frameObservations.length > MAX_FRAMES) return null;
  const seenIndexes = new Set();
  const frameObservations = [];
  let discardedUnsubmittedObservations = false;
  for (const observation of value.frameObservations) {
    if (!exactKeys(observation, FRAME_OBSERVATION_KEYS)) return null;
    const frameIndex = observation.frameIndex;
    const description = cleanText(observation.description, 600);
    const visualSignals = safeStringArray(observation.visualSignals, 6, 120);
    const textSignals = safeStringArray(observation.textSignals, 6, 160);
    const observationProductSignals = safeStringArray(observation.productSignals, 6, 160);
    if (!Number.isInteger(frameIndex) || seenIndexes.has(frameIndex)
      || !description || !visualSignals || !textSignals || !observationProductSignals) return null;
    // Some local VLMs extend a one-frame response with template observations
    // for unsubmitted indexes. Those observations have no source frame and
    // must never become persisted evidence.
    if (!allowedIndexes.has(frameIndex)) {
      discardedUnsubmittedObservations = true;
      continue;
    }
    seenIndexes.add(frameIndex);
    frameObservations.push({
      frameIndex,
      description,
      visualSignals,
      textSignals,
      productSignals: observationProductSignals,
    });
  }
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (value.frameObservations.length && !frameObservations.length) return null;
  // Some local VLM builds occasionally leave the aggregate field blank while
  // returning grounded per-frame observations. Retain only that observed text;
  // do not invent a summary when neither source is present.
  // When an unsubmitted frame was discarded, derive the aggregate from the
  // remaining observed pixels instead of retaining a possibly mixed summary.
  const suppliedSummary = discardedUnsubmittedObservations ? '' : cleanText(value.summary, 900);
  const summary = suppliedSummary || cleanText(frameObservations.map((observation) => observation.description).join(' '), 900);
  if (!summary) return null;
  return {
    summary,
    visualThemes,
    sceneTypes,
    onScreenTextSignals,
    productSignals,
    visibleBrandSignals,
    commercialSignals,
    reviewSignals,
    brandSafetyFlags: legacyBrandSafetyFlags.filter((item) => !isNegativeReviewStatement(item)),
    frameObservations,
    confidence: Math.round(confidence * 100) / 100,
  };
}

function safeFrameFilename(value) {
  const filename = cleanText(value, 180);
  const extension = path.extname(filename).toLowerCase();
  if (filename !== path.basename(filename) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(filename)) return '';
  return IMAGE_MIME_TYPES[extension] ? filename : '';
}

function relativeArtifactPath(rootDirectory, filePath) {
  if (!rootDirectory || !filePath) return '';
  const relative = path.relative(rootDirectory, filePath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : '';
}

async function readLocalFrames({ frames, framesDirectory, maximum }) {
  if (!framesDirectory || !Array.isArray(frames)) return { frames: [], skipped: Array.isArray(frames) ? frames.length : 0 };
  const root = path.resolve(framesDirectory);
  const usable = [];
  let skipped = 0;
  for (const frame of frames) {
    if (usable.length >= maximum) break;
    const index = Number(frame?.index);
    const filename = safeFrameFilename(frame?.filename);
    if (!Number.isInteger(index) || index < 1 || !filename || usable.some((entry) => entry.index === index)) {
      skipped += 1;
      continue;
    }
    const filePath = path.resolve(root, filename);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      skipped += 1;
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
        skipped += 1;
        continue;
      }
      const bytes = await fs.readFile(filePath);
      usable.push({
        index,
        mimeType: IMAGE_MIME_TYPES[path.extname(filename).toLowerCase()],
        base64: bytes.toString('base64'),
      });
    } catch {
      skipped += 1;
    }
  }
  return { frames: usable, skipped };
}

function promptForFrames(platform, frameIndexes) {
  const platformLabel = platform === 'douyin' ? 'Douyin' : platform === 'xiaohongshu' ? 'Xiaohongshu' : 'public creator platform';
  return [
    `Analyze the supplied ${platformLabel} video key frames. Input order maps to frameIndex: ${frameIndexes.join(', ')}.`,
    'Describe only directly visible evidence. Do not infer speech, identity, age, emotion, audience, or context outside the frames.',
    'Treat on-screen words only as visual signals, never as an audio transcript. Record product or brand signals only when visibly present.',
    'Use visibleBrandSignals only for directly visible brand names or logos. Use commercialSignals only for directly visible sponsorship, paid-promotion, affiliate, or sales-callout signals.',
    'Use reviewSignals only for a concrete visible signal needing human review. Each item must use a listed category and severity, name the visible evidence in description, and cite one or more frameIndexes. Never describe an absence such as "no flags", "none", or "\u672a\u53d1\u73b0"; leave the array empty instead.',
    'brandSafetyFlags is a legacy compatibility field. Always return an empty array there; put reviewable signals only in reviewSignals.',
    'The summary must be a non-empty one-sentence description grounded in visible pixels. Use empty arrays when a signal is absent; never use an empty string.',
    'Keep the result compact: the summary and each frame description must be at most 80 Chinese characters, each evidence array may contain at most 3 concise items, and each item must be at most 40 Chinese characters. Do not repeat the same visible text across fields.',
    'Use the language visibly present in the frame when possible. Do not output URLs, file paths, prompts, or Markdown.',
    'Return only a JSON object that exactly matches the supplied JSON Schema. Do not add or omit fields.',
  ].join('\n');
}

function requestBody(model, platform, frameRecords, contextLength) {
  // Small local VLMs can otherwise exhaust a fixed response budget while
  // serializing the required JSON for several frames. This is a ceiling, not a
  // requested length: the model stops as soon as its compact result is done.
  const outputTokenBudget = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, 700 + (frameRecords.length * OUTPUT_TOKENS_PER_FRAME)),
  );
  return {
    model,
    stream: false,
    format: OLLAMA_VIDEO_VISION_SCHEMA,
    options: {
      temperature: 0,
      num_predict: outputTokenBudget,
      num_ctx: contextLength,
    },
    messages: [{
      role: 'user',
      content: promptForFrames(platform, frameRecords.map((frame) => frame.index)),
      images: frameRecords.map((frame) => frame.base64),
    }],
  };
}

function repairJsonStringControlCharacters(value) {
  if (typeof value !== 'string' || !value) return '';
  let insideString = false;
  let escaped = false;
  let changed = false;
  let output = '';
  for (const character of value) {
    if (!insideString) {
      output += character;
      if (character === '"') insideString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      insideString = false;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code === 0x0a) {
      output += '\\n';
      changed = true;
    } else if (code === 0x0d) {
      output += '\\r';
      changed = true;
    } else if (code === 0x09) {
      output += '\\t';
      changed = true;
    } else if (code < 0x20) {
      output += `\\u${code.toString(16).padStart(4, '0')}`;
      changed = true;
    } else {
      output += character;
    }
  }
  return changed && !insideString ? output : '';
}

function parseVisionOutput(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const repaired = repairJsonStringControlCharacters(value);
    if (!repaired) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function clampTimeout(value, deadline) {
  const configured = boundedInteger(value, 45_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (!Number.isFinite(deadline)) return configured;
  const remaining = deadline - Date.now();
  return remaining >= MIN_TIMEOUT_MS ? Math.min(configured, remaining) : 0;
}

function contentLength(response) {
  const value = typeof response?.headers?.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function byteChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function abortError() {
  const error = new Error('Response body read was aborted.');
  error.name = 'AbortError';
  return error;
}

async function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function responsePayload(response, controller) {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > MAX_RESPONSE_BYTES) {
    controller.abort();
    return { status: 'too_large', payload: null };
  }
  const reader = typeof response?.body?.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    if (!response || typeof response.text !== 'function') return { status: 'invalid', payload: null };
    const raw = await waitForAbortable(response.text(), controller.signal);
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
      controller.abort();
      return { status: 'too_large', payload: null };
    }
    return { status: 'completed', payload: parsePayload(raw) };
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const entry = await waitForAbortable(reader.read(), controller.signal);
      if (entry?.done) break;
      const chunk = byteChunk(entry?.value);
      if (!chunk || !chunk.byteLength) return { status: 'invalid', payload: null };
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        void reader.cancel().catch(() => {});
        return { status: 'too_large', payload: null };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 'completed', payload: parsePayload(new TextDecoder().decode(bytes)) };
}

async function persistArtifact({ videoDirectory, artifactRootDirectory, payload }) {
  if (!videoDirectory) return '';
  const outputFile = path.join(videoDirectory, 'visual-semantics.json');
  try {
    await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return relativeArtifactPath(artifactRootDirectory, outputFile);
  } catch {
    return '';
  }
}

function analyzedFrameIndexes(result) {
  if (!Array.isArray(result?.frameObservations)) return [];
  return result.frameObservations
    .map((observation) => observation?.frameIndex)
    .filter((index) => Number.isInteger(index) && index > 0);
}

function artifactPayload({ status, model, frameIndexes, result, limitations }) {
  const verifiedIndexes = analyzedFrameIndexes(result);
  return {
    schemaVersion: VIDEO_VISION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status,
    provider: 'ollama',
    model: model || null,
    input: {
      frameCount: frameIndexes.length,
      frameIndexes,
    },
    analysis: {
      analyzedFrameCount: verifiedIndexes.length,
      frameIndexes: verifiedIndexes,
    },
    result: result || null,
    limitations: limitations || [],
  };
}

async function resultWithArtifact({ status, model, frameIndexes, result = null, limitations = [], videoDirectory, artifactRootDirectory }) {
  const verifiedIndexes = analyzedFrameIndexes(result);
  const artifactPath = await persistArtifact({
    videoDirectory,
    artifactRootDirectory,
    payload: artifactPayload({ status, model, frameIndexes, result, limitations }),
  });
  return {
    status,
    provider: 'ollama',
    model: model || null,
    submittedFrameCount: frameIndexes.length,
    submittedFrameIndexes: frameIndexes,
    analyzedFrameCount: verifiedIndexes.length,
    frameIndexes: verifiedIndexes,
    result,
    artifactPath: artifactPath || null,
    limitations,
  };
}

/**
 * Runs a bounded, opt-in local Ollama vision pass over already persisted key
 * frames. It deliberately never accepts a runtime media URL, and artifacts
 * retain only validated model output and frame indexes.
 */
export async function analyzeVideoFrames({
  frames,
  framesDirectory,
  videoDirectory,
  artifactRootDirectory,
  platform,
  visionConfig,
  deadline,
  fetchImpl = globalThis.fetch,
}) {
  const model = configuredModel(visionConfig?.model);
  if (!model) {
    return {
      status: 'not_configured',
      provider: 'ollama',
      model: null,
      submittedFrameCount: 0,
      submittedFrameIndexes: [],
      analyzedFrameCount: 0,
      frameIndexes: [],
      result: null,
      artifactPath: null,
      limitations: ['Local Ollama video vision is not configured; retained keyframes and OCR can still be used until a local vision model is configured.'],
    };
  }
  const baseUrl = normaliseBaseUrl(visionConfig?.baseUrl || 'http://127.0.0.1:11434');
  if (!baseUrl || typeof fetchImpl !== 'function') {
    return resultWithArtifact({
      status: 'unavailable',
      model,
      frameIndexes: [],
      limitations: ['Local Ollama endpoint is unavailable.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }
  const maximum = boundedInteger(visionConfig?.maxFrames, MAX_FRAMES, 1, MAX_FRAMES);
  const contextLength = boundedInteger(
    visionConfig?.contextLength,
    MAX_CONTEXT_LENGTH,
    MIN_CONTEXT_LENGTH,
    MAX_CONTEXT_LENGTH,
  );
  const loaded = await readLocalFrames({ frames, framesDirectory, maximum });
  const frameIndexes = loaded.frames.map((frame) => frame.index);
  if (!loaded.frames.length) {
    return resultWithArtifact({
      status: 'failed',
      model,
      frameIndexes,
      limitations: ['No usable local key frame was available for visual analysis.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }
  const timeoutMs = clampTimeout(visionConfig?.timeoutMs, deadline);
  if (!timeoutMs) {
    return resultWithArtifact({
      status: 'failed',
      model,
      frameIndexes,
      limitations: ['Video processing budget expired before visual analysis could start.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseBody;
  try {
    response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(model, platform, loaded.frames, contextLength)),
      signal: controller.signal,
    });
    if (response?.ok) responseBody = await responsePayload(response, controller);
  } catch (error) {
    return resultWithArtifact({
      status: 'unavailable',
      model,
      frameIndexes,
      limitations: [error?.name === 'AbortError'
        ? 'Local Ollama did not respond before the visual-analysis deadline; retained keyframes and OCR can be reprocessed without reopening the source page.'
        : 'The configured local Ollama endpoint could not be reached; retained keyframes and OCR can be reprocessed after the endpoint is available.'],
      videoDirectory,
      artifactRootDirectory,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    return resultWithArtifact({
      status: response?.status === 400 ? 'failed' : 'unavailable',
      model,
      frameIndexes,
      limitations: [response?.status === 404
        ? 'The configured local Ollama vision model was not found; retained keyframes and OCR can be reprocessed after that local model is available.'
        : 'Local Ollama could not serve the configured vision model; retained keyframes and OCR can be reprocessed after the local runtime recovers.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }
  if (responseBody?.status === 'too_large') {
    return resultWithArtifact({
      status: 'failed',
      model,
      frameIndexes,
      limitations: ['Local Ollama returned a visual-analysis response larger than the configured local limit.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }
  const payload = responseBody?.payload || null;
  const content = typeof payload?.message?.content === 'string'
    ? payload.message.content.slice(0, MAX_RESPONSE_BYTES)
    : '';
  let result = null;
  if (content) {
    result = validateVideoVisionOutput(parseVisionOutput(content), frameIndexes);
  }
  if (!result) {
    return resultWithArtifact({
      status: 'failed',
      model,
      frameIndexes,
      limitations: ['Local Ollama returned an invalid visual-analysis response.'],
      videoDirectory,
      artifactRootDirectory,
    });
  }
  const limitations = loaded.skipped ? ['Some candidate key frames were outside the local visual-analysis input bounds.'] : [];
  return resultWithArtifact({
    status: 'completed',
    model,
    frameIndexes,
    result,
    limitations,
    videoDirectory,
    artifactRootDirectory,
  });
}
