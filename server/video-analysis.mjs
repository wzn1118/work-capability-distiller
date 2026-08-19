import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeVideoFrames } from './video-vision.mjs';
import { acquireExternalVideoEvidence, enrichExternalVideoEvidence } from './tool-adapters.mjs';

const SCHEMA_VERSION = 'video-evidence/v2';
const MAX_OCR_TEXT = 1_200;
const MAX_TRANSCRIPT_TEXT = 6_000;
const MAX_TRANSCRIPT_SEGMENTS = 120;
const MAX_TRANSCRIPT_SEGMENT_TEXT = 480;
const MAX_COMMAND_OUTPUT = 512 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 86_400;
const VIDEO_CHECKPOINT_FILE = 'video-evidence-checkpoint.json';
const VIDEO_CHECKPOINT_SCHEMA_VERSION = 'video-evidence-checkpoint/v1';
const DEFAULT_DOUYIN_MEDIA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

const MEDIA_HOST_SUFFIXES = {
  douyin: ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'ibytedtos.com', 'zjcdn.com', 'bytecdn.cn', 'byteimg.com', 'bytedance.com', 'volces.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com', 'xhscdn.net', 'xhslink.com'],
  bilibili: ['bilibili.com', 'bilivideo.com', 'biliapi.net', 'biliimg.com'],
};

function text(value, maximum = 360) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function finite(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
}

function roundedSeconds(value) {
  const seconds = finite(value, MAX_VIDEO_DURATION_SECONDS);
  return seconds === null ? null : Math.round(seconds * 100) / 100;
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = finite(value, maximum);
  return number === null ? null : Math.floor(number);
}

function sourceUrl(value) {
  const raw = text(value, 2_000);
  return /^https:\/\//i.test(raw) ? raw : '';
}

export function scrubRuntimeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || !parsed.hostname) return '';
    return `https://${parsed.host}${parsed.pathname || '/'}`;
  } catch {
    return '';
  }
}

function allowedRuntimeMediaUrl(platform, value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (MEDIA_HOST_SUFFIXES[platform] || []).some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function candidateMediaUrl(platform, value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return '';
    if (!allowedRuntimeMediaUrl(platform, parsed.toString())) return '';
    const pathname = parsed.pathname.toLowerCase();
    if (platform === 'douyin'
      && !/\.(?:mp4|webm)(?:$|\/)/i.test(pathname)
      && !pathname.includes('/video/tos/')
      && !pathname.includes('/aweme/')) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function candidateImageUrl(platform, value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || !allowedRuntimeMediaUrl(platform, parsed.toString())) return '';
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(?:mp4|webm)(?:$|\/)/i.test(pathname) || pathname.includes('/video/tos/') || pathname.includes('/aweme/')) return '';
    if (platform === 'douyin'
      && (parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com'))
      && !/\.(?:avif|gif|jpe?g|png|webp)(?:$|\/)/i.test(pathname)
      && !pathname.includes('/image/')
      && !pathname.includes('image-cut')) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function mediaRequestHeaders(platform, value, options = {}) {
  const runtimeUrl = options.kind === 'image'
    ? candidateImageUrl(platform, value)
    : candidateMediaUrl(platform, value);
  if (!runtimeUrl || platform !== 'douyin') return {};
  return {
    Referer: 'https://www.douyin.com/',
    Origin: 'https://www.douyin.com',
    'User-Agent': DEFAULT_DOUYIN_MEDIA_USER_AGENT,
  };
}

export function mediaRequestArgs(platform, value) {
  const runtimeUrl = candidateMediaUrl(platform, value);
  if (!runtimeUrl || platform !== 'douyin') return [];
  const headers = mediaRequestHeaders(platform, runtimeUrl);
  return [
    '-user_agent', headers['User-Agent'],
    '-headers', `Referer: ${headers.Referer}\r\nOrigin: ${headers.Origin}\r\n`,
  ];
}

function interactionTotal(sample) {
  const interactions = sample?.interactions && typeof sample.interactions === 'object' && !Array.isArray(sample.interactions)
    ? sample.interactions
    : {};
  const values = Object.values(interactions).map((value) => finite(value)).filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : -1;
}

function observedPublishedAt(sample) {
  const raw = text(
    sample?.publishedAtIso
      ?? sample?.publishedAt
      ?? sample?.published_at
      ?? sample?.createdAt
      ?? sample?.created_at,
    120,
  );
  if (!raw) return { value: null, timestamp: null };
  const timestamp = Date.parse(raw);
  return {
    value: raw,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

function observedPinned(sample) {
  return sample?.isPinned === true || sample?.is_pinned === true || sample?.pinned === true;
}

function videoSelectionSorter(left, right) {
  return right.score - left.score || left.index - right.index;
}

export function isVideoContentSample(sample, platform = '') {
  const type = text(sample?.contentType, 120).toLowerCase();
  if (/video|\u89c6\u9891/.test(type)) return true;
  const url = sourceUrl(sample?.sourceUrl).toLowerCase();
  return (platform === 'douyin' || platform === 'bilibili') && /\/video\//.test(url);
}

function preferredVideoCandidate(left, right) {
  if (left.isPinned !== right.isPinned) return left.isPinned ? left : right;
  if (left.publishedAtTimestamp !== right.publishedAtTimestamp) {
    if (left.publishedAtTimestamp === null) return right;
    if (right.publishedAtTimestamp === null) return left;
    return left.publishedAtTimestamp > right.publishedAtTimestamp ? left : right;
  }
  if (left.score !== right.score) return left.score > right.score ? left : right;
  return left.index <= right.index ? left : right;
}

// A profile can render a pinned post again in its normal feed. Use the public
// page URL as the identity so the same video is not observed and transcribed
// twice while preserving the strongest visible metadata for the single record.
export function videoCandidateSummary(capture, platform) {
  const samples = Array.isArray(capture?.content?.visibleSamples) ? capture.content.visibleSamples : [];
  const observedCandidates = samples
    .map((sample, index) => {
      const published = observedPublishedAt(sample);
      const visibleSourceUrl = sourceUrl(sample?.sourceUrl);
      return {
        sample,
        index,
        sourceUrl: scrubRuntimeUrl(visibleSourceUrl),
        score: interactionTotal(sample),
        isPinned: observedPinned(sample),
        publishedAt: published.value,
        publishedAtTimestamp: published.timestamp,
      };
    })
    .filter(({ sample, sourceUrl: visibleSourceUrl }) => isVideoContentSample(sample, platform) && visibleSourceUrl);
  const uniqueBySourceUrl = new Map();
  for (const candidate of observedCandidates) {
    const current = uniqueBySourceUrl.get(candidate.sourceUrl);
    uniqueBySourceUrl.set(candidate.sourceUrl, current ? preferredVideoCandidate(current, candidate) : candidate);
  }
  const candidates = [...uniqueBySourceUrl.values()].sort((left, right) => left.index - right.index);
  return {
    observedVideoSampleCount: observedCandidates.length,
    eligibleVideoSampleCount: candidates.length,
    duplicateVisibleReferenceCount: Math.max(0, observedCandidates.length - candidates.length),
    candidates,
  };
}

export function selectVideoSamples(capture, platform, maximum = 0) {
  const { candidates } = videoCandidateSummary(capture, platform);
  // The normal product path is full interpretation of every public video in
  // the captured source set. A positive maximum is retained only as an
  // explicit operational override for constrained runs.
  const requestedMaximum = Number(maximum);
  const limit = Number.isFinite(requestedMaximum) && requestedMaximum > 0
    ? Math.min(Math.floor(requestedMaximum), candidates.length)
    : candidates.length;
  const selected = [];
  const selectedIndexes = new Set();
  const pickFirst = (entries, selectionReason) => {
    const candidate = entries.find((entry) => !selectedIndexes.has(entry.index));
    if (!candidate || selected.length >= limit) return;
    selectedIndexes.add(candidate.index);
    selected.push({ ...candidate, selectionReason });
  };

  // A single visible pinned item and a single recent item make the video
  // evidence less likely to represent only historical high-engagement posts.
  // The remaining capacity keeps the established interaction-first ordering.
  pickFirst(candidates.filter((entry) => entry.isPinned).sort(videoSelectionSorter), 'observed_pinned_sample');
  pickFirst(
    candidates
      .filter((entry) => entry.publishedAtTimestamp !== null)
      .sort((left, right) => right.publishedAtTimestamp - left.publishedAtTimestamp || videoSelectionSorter(left, right)),
    'observed_recent_sample',
  );
  for (const candidate of [...candidates].sort(videoSelectionSorter)) {
    pickFirst([candidate], candidate.score >= 0 ? 'observed_interaction_rank' : 'visible_source_order_fallback');
  }
  const ranked = selected.slice(0, limit).map((entry, selectionIndex) => ({
    ...entry,
    selectionRank: selectionIndex + 1,
  }));
  return ranked
    .sort((left, right) => left.index - right.index)
    .map(({ sample, index, sourceUrl: visibleSourceUrl, score, isPinned, publishedAt, selectionRank, selectionReason }) => ({
      sampleIndex: index + 1,
      sourceUrl: visibleSourceUrl,
      contentType: text(sample?.contentType, 80),
      title: text(sample?.title, 180),
      summary: text(sample?.summary, 600),
      isPinned,
      publishedAt,
      observedInteractions: interactionTotal(sample) >= 0 ? interactionTotal(sample) : null,
      selectionRank,
      selectionReason,
      selectionObservedInteractionScore: score >= 0 ? score : null,
      playbackUrl: candidateMediaUrl(platform, sample?.playbackUrl ?? sample?.videoUrl ?? sample?.video_url ?? sample?.mediaUrl),
    }));
}

function candidateVideoCount(capture, platform) {
  return videoCandidateSummary(capture, platform).eligibleVideoSampleCount;
}

function commandResult(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => (current.length >= MAX_COMMAND_OUTPUT
      ? current
      : (current + chunk.toString('utf8')).slice(0, MAX_COMMAND_OUTPUT));
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1_000, timeoutMs || 60_000));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function parseLastJson(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
    const value = line.trim();
    if (!value.startsWith('{')) continue;
    try {
      return JSON.parse(value);
    } catch {
      // Continue looking in case a dependency emitted a non-JSON line.
    }
  }
  return null;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function mapWithConcurrency(items, requestedConcurrency, mapper) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return [];
  const requested = Number(requestedConcurrency);
  const workerCount = Math.max(
    1,
    Math.min(values.length, Number.isFinite(requested) ? Math.floor(requested) : 1),
  );
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  const worker = async () => {
    while (!firstError && nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await mapper(values[currentIndex], currentIndex);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

export function parseTranscriptArtifact(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const segments = [];
    for (const line of source.split(/\r?\n/)) {
      const fragment = line.trim();
      if (!fragment) continue;
      try {
        const parsed = JSON.parse(fragment);
        if (Array.isArray(parsed)) segments.push(...parsed);
        else if (parsed && typeof parsed === 'object') segments.push(parsed);
        else return null;
      } catch {
        return null;
      }
    }
    return segments.length ? segments : null;
  }
}

async function readTranscriptArtifact(filePath) {
  try {
    return parseTranscriptArtifact(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativeArtifactPath(rootDirectory, filePath) {
  const relative = path.relative(rootDirectory, filePath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : '';
}

async function retainPlaybackArtifact({ candidates, sampleDirectory, artifactRootDirectory, maxBytes }) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const source = String(candidate || '');
    if (!path.isAbsolute(source) || !(await fileExists(source))) continue;
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile() || (Number.isFinite(Number(maxBytes)) && stat.size > Number(maxBytes))) continue;
    const extension = path.extname(source).toLowerCase() === '.webm' ? '.webm' : '.mp4';
    const destination = path.join(sampleDirectory, `playback${extension}`);
    if (path.resolve(source) !== path.resolve(destination)) {
      await fs.copyFile(source, destination);
    }
    return relativeArtifactPath(artifactRootDirectory, destination);
  }
  return '';
}

function boundedTimeout(deadline, maximum = 60_000) {
  const remaining = deadline - Date.now();
  return remaining > 1_000 ? Math.min(remaining, maximum) : 0;
}

function pointInTime(durationSeconds, count) {
  if (!durationSeconds || durationSeconds <= 0) return [0];
  const fractions = count === 2
    ? [0.18, 0.78]
    : count === 3
      ? [0.14, 0.5, 0.86]
      : count === 4
        ? [0.12, 0.38, 0.64, 0.9]
        : Array.from({ length: count }, (_, index) => (index + 0.5) / count);
  return [...new Set(fractions.map((fraction) => Math.max(0, Math.min(durationSeconds - 0.08, durationSeconds * fraction))))];
}

export function timelineAnchor(index, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count <= 1) return 'midpoint';
  if (index === 0) return 'opening';
  if (index === count - 1) return 'closing';
  const position = index / (count - 1);
  if (position < 0.34) return 'early';
  if (position <= 0.67) return 'middle';
  return 'late';
}

function safeMediaMetadata(value) {
  const dimensions = value?.dimensions && typeof value.dimensions === 'object' ? value.dimensions : {};
  return {
    durationSeconds: finite(value?.durationSeconds, MAX_VIDEO_DURATION_SECONDS),
    dimensions: {
      width: positiveInteger(dimensions.width, 10_000),
      height: positiveInteger(dimensions.height, 10_000),
    },
    evidence: text(value?.evidence, 120) || 'rendered_visible_video_element',
  };
}

function safeBrowserFrameMetadata(value) {
  const frames = Array.isArray(value?.frames) ? value.frames : [];
  return {
    status: text(value?.status, 80) || 'not_requested',
    frames: frames.slice(0, 4).map((frame, index) => {
      const filename = text(frame?.filename, 160);
      if (!/^browser-frame-\d{2}\.jpg$/i.test(filename)) return null;
      return {
        index: positiveInteger(frame?.index, 100) || index + 1,
        filename,
        timeSeconds: roundedSeconds(frame?.timeSeconds),
        timelineAnchor: text(frame?.timelineAnchor, 40) || 'midpoint',
        samplingReason: text(frame?.samplingReason, 120) || 'browser_rendered_timeline_anchor',
      };
    }).filter(Boolean),
  };
}

async function browserRenderedFrameFallback(relay, videoDirectory, artifactRootDirectory) {
  const metadata = safeBrowserFrameMetadata(relay?.browserFrames);
  const framesDirectory = path.join(videoDirectory, 'browser-frames');
  const frames = [];
  for (const frame of metadata.frames) {
    const outputFile = path.join(framesDirectory, frame.filename);
    if (!(await fileExists(outputFile))) continue;
    frames.push({
      ...frame,
      artifactPath: relativeArtifactPath(artifactRootDirectory, outputFile),
      ocrText: '',
    });
  }
  return { status: metadata.status, frames, framesDirectory };
}

async function relayObservationResult(processResult, outputFile, artifactRootDirectory) {
  const output = parseLastJson(processResult.stdout);
  const artifact = await readJson(outputFile);
  const status = text(output?.status || artifact?.status, 80) || (processResult.timedOut ? 'timed_out' : 'relay_error');
  return {
    status: processResult.timedOut ? 'timed_out' : status,
    runtimeMediaUrl: text(output?.runtimeMediaUrl, 4_000),
    runtimeRecordingPath: text(output?.runtimeRecordingPath, 2_000),
    recordingStatus: text(output?.recordingStatus, 80),
    rendered: safeMediaMetadata(artifact?.media || output),
    browserFrames: safeBrowserFrameMetadata(artifact?.browserFrames),
    observationArtifactPath: relativeArtifactPath(artifactRootDirectory, outputFile),
  };
}

async function runNodeRelayObservation({ platform, contentUrl, outputFile, videoConfig, relayPort, deadline }) {
  const timeoutMs = boundedTimeout(deadline, 180_000);
  const observationArtifactPath = relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile);
  if (!timeoutMs) return { status: 'timed_out', observationArtifactPath };
  if (!text(videoConfig?.node, 1_000) || !text(videoConfig?.relayNodeScript, 2_000)) {
    return { status: 'tooling_unavailable', observationArtifactPath };
  }
  const args = [
    videoConfig.relayNodeScript,
    '--platform', platform,
    '--content-url', contentUrl,
    '--relay-port', String(relayPort),
    '--output-file', outputFile,
  ];
  const playwrightModulePath = text(videoConfig.playwrightModulePath, 2_000);
  if (playwrightModulePath) args.push('--playwright-module-path', playwrightModulePath);
  const browserFrameCount = Math.max(0, Math.min(Math.floor(Number(videoConfig?.framesPerVideo) || 0), 4));
  if (browserFrameCount) {
    args.push(
      '--frame-directory', path.join(path.dirname(outputFile), 'browser-frames'),
      '--frame-count', String(browserFrameCount),
    );
  }
  if (videoConfig?.browserRecordingFallback === true
    && transcriptProcessor(videoConfig) !== 'not_configured'
    && transcriptProcessor(videoConfig) !== 'funasr_not_configured') {
    args.push('--recording-file', path.join(path.dirname(outputFile), 'browser-recording.webm'));
  }
  try {
    const processResult = await commandResult(videoConfig.node, args, { timeoutMs });
    return relayObservationResult(processResult, outputFile, videoConfig.artifactRootDirectory);
  } catch {
    return { status: 'tooling_unavailable', observationArtifactPath };
  }
}

async function runRelayObservation({ platform, contentUrl, videoDirectory, videoConfig, relayPort, deadline }) {
  const outputFile = path.join(videoDirectory, 'media-observation.json');
  const timeoutMs = boundedTimeout(deadline, 90_000);
  const observationArtifactPath = relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile);
  if (!timeoutMs) return { status: 'timed_out', observationArtifactPath };

  // The Node adapter can derive keyframes directly from the page's rendered
  // video element. Prefer it whenever available, and retain the Python relay
  // as a compatibility fallback for environments without local Playwright.
  if (text(videoConfig?.node, 1_000) && text(videoConfig?.relayNodeScript, 2_000)) {
    const nodeObservation = await runNodeRelayObservation({
      platform,
      contentUrl,
      outputFile,
      videoConfig,
      relayPort,
      deadline,
    });
    if (!['relay_error', 'tooling_unavailable'].includes(nodeObservation.status)) return nodeObservation;
  }

  let processResult;
  try {
    processResult = await commandResult(videoConfig.python, [
      ...(Array.isArray(videoConfig.pythonArgs) ? videoConfig.pythonArgs : []),
      videoConfig.relayScript,
      '--platform', platform,
      '--content-url', contentUrl,
      '--relay-port', String(relayPort),
      '--output-file', outputFile,
    ], { timeoutMs });
  } catch {
    return { status: 'tooling_unavailable', observationArtifactPath };
  }
  const pythonObservation = await relayObservationResult(processResult, outputFile, videoConfig.artifactRootDirectory);
  // If the optional Node adapter was not configured, a Python tooling failure
  // can still use it as a final compatibility attempt. Platform access states
  // are meaningful evidence and are never retried against another adapter.
  if (!processResult.timedOut
    && !text(videoConfig?.node, 1_000)
    && ['relay_error', 'tooling_unavailable'].includes(pythonObservation.status)) {
    return runNodeRelayObservation({ platform, contentUrl, outputFile, videoConfig, relayPort, deadline });
  }
  return pythonObservation;
}

async function probeMedia(runtimeMediaUrl, videoConfig, deadline, platform = '') {
  const timeoutMs = boundedTimeout(deadline, 45_000);
  if (!timeoutMs) return { status: 'timed_out' };
  let processResult;
  try {
    processResult = await commandResult(videoConfig.ffprobe, [
      '-v', 'error', ...mediaRequestArgs(platform, runtimeMediaUrl),
      '-print_format', 'json', '-show_format', '-show_streams', runtimeMediaUrl,
    ], { timeoutMs });
  } catch {
    return { status: 'tooling_unavailable' };
  }
  if (processResult.timedOut) return { status: 'timed_out' };
  if (processResult.code !== 0) return { status: 'probe_failed' };
  let payload;
  try {
    payload = JSON.parse(processResult.stdout);
  } catch {
    return { status: 'probe_failed' };
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video') || {};
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || null;
  return {
    status: 'completed',
    durationSeconds: finite(payload?.format?.duration, MAX_VIDEO_DURATION_SECONDS),
    width: positiveInteger(video?.width, 10_000),
    height: positiveInteger(video?.height, 10_000),
    videoCodec: text(video?.codec_name, 80) || null,
    audioCodec: text(audio?.codec_name, 80) || null,
    hasAudio: Boolean(audio),
  };
}

function localMediaCacheLimit(videoConfig) {
  const requested = Number(videoConfig?.localMediaCache?.maxBytes);
  if (!Number.isFinite(requested)) return 192 * 1024 * 1024;
  return Math.max(16 * 1024 * 1024, Math.min(Math.floor(requested), 512 * 1024 * 1024));
}

async function cacheRenderedMedia(runtimeMediaUrl, videoDirectory, videoConfig, deadline, platform = '') {
  if (videoConfig?.localMediaCache?.enabled === false) return { status: 'disabled', localPath: '', byteLength: null };
  const outputFile = path.join(videoDirectory, 'source-media.mp4');
  const timeoutMs = boundedTimeout(deadline, 100_000);
  if (!timeoutMs) return { status: 'timed_out', localPath: '', byteLength: null };
  let processResult;
  try {
    processResult = await commandResult(videoConfig.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', ...mediaRequestArgs(platform, runtimeMediaUrl),
      '-i', runtimeMediaUrl,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-y', outputFile,
    ], { timeoutMs });
  } catch {
    return { status: 'tooling_unavailable', localPath: '', byteLength: null };
  }
  if (processResult.timedOut || processResult.code !== 0) {
    await fs.rm(outputFile, { force: true }).catch(() => {});
    return { status: processResult.timedOut ? 'timed_out' : 'cache_failed', localPath: '', byteLength: null };
  }
  try {
    const stat = await fs.stat(outputFile);
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty local media cache');
    if (stat.size > localMediaCacheLimit(videoConfig)) {
      await fs.rm(outputFile, { force: true }).catch(() => {});
      return { status: 'size_limit_exceeded', localPath: '', byteLength: stat.size };
    }
    return { status: 'completed', localPath: outputFile, byteLength: stat.size };
  } catch {
    await fs.rm(outputFile, { force: true }).catch(() => {});
    return { status: 'cache_failed', localPath: '', byteLength: null };
  }
}

// The local cache is derived from the same rendered, short-lived media URL.
// Once it exists, its probe is both faster and more stable than opening that
// remote URL a second time. Retain the remote probe for cache or local-probe
// failures so direct-media processing stays available.
export async function resolveCachedMediaProbe({
  localMedia,
  runtimeMediaUrl,
  videoConfig,
  deadline,
  platform = '',
  runtimeDeadline = deadline,
  probe = probeMedia,
  removeFile = (filePath) => fs.rm(filePath, { force: true }),
}) {
  const resolvedMedia = { ...(localMedia || {}) };
  const directInput = text(runtimeMediaUrl, 4_000);
  if (resolvedMedia.status === 'completed' && resolvedMedia.localPath) {
    const localProbe = await probe(resolvedMedia.localPath, videoConfig, deadline, platform);
    if (localProbe?.status === 'completed') {
      return {
        localMedia: resolvedMedia,
        probe: localProbe,
        processingInput: resolvedMedia.localPath,
        usedCachedMedia: true,
      };
    }
    await Promise.resolve(removeFile(resolvedMedia.localPath)).catch(() => {});
    resolvedMedia.status = 'local_probe_failed';
    resolvedMedia.localPath = '';
  }
  return {
    localMedia: resolvedMedia,
    probe: await probe(directInput, videoConfig, runtimeDeadline, platform),
    processingInput: directInput,
    usedCachedMedia: false,
  };
}

async function extractFrames(runtimeMediaUrl, durationSeconds, videoDirectory, videoConfig, deadline, platform = '') {
  const framesDirectory = path.join(videoDirectory, 'frames');
  await fs.mkdir(framesDirectory, { recursive: true });
  const points = pointInTime(durationSeconds, videoConfig.framesPerVideo);
  const frames = [];
  for (let index = 0; index < points.length; index += 1) {
    const timeoutMs = boundedTimeout(deadline, 45_000);
    if (!timeoutMs) break;
    const filename = `frame-${String(index + 1).padStart(2, '0')}.jpg`;
    const outputFile = path.join(framesDirectory, filename);
    let processResult;
    try {
      processResult = await commandResult(videoConfig.ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', ...mediaRequestArgs(platform, runtimeMediaUrl),
        '-ss', points[index].toFixed(3), '-i', runtimeMediaUrl,
        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', outputFile,
      ], { timeoutMs });
    } catch {
      continue;
    }
    if (processResult.code !== 0 || processResult.timedOut || !(await fileExists(outputFile))) continue;
    frames.push({
      index: index + 1,
      filename,
      timeSeconds: Math.round(points[index] * 100) / 100,
      timelineAnchor: timelineAnchor(index, points.length),
      samplingReason: 'uniform_timeline_anchor',
      artifactPath: relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile),
      ocrText: '',
    });
  }
  return { frames, framesDirectory };
}

const OCR_STAGE_STATUSES = new Set([
  'completed',
  'dependency_unavailable',
  'model_unavailable',
  'ocr_failed',
]);

function ocrRuntimeDiagnostic(payload, fallback = {}) {
  const raw = payload?.availability && typeof payload.availability === 'object' && !Array.isArray(payload.availability)
    ? payload.availability
    : {};
  const state = text(raw.state || fallback.state, 80);
  const code = text(raw.code || fallback.code, 120);
  const engine = text(raw.engine || fallback.engine, 120);
  const processedFrameCount = positiveInteger(raw.processedFrameCount ?? fallback.processedFrameCount, 100);
  const recognizedFrameCount = positiveInteger(raw.recognizedFrameCount ?? fallback.recognizedFrameCount, 100);
  const failedFrameCount = positiveInteger(raw.failedFrameCount ?? fallback.failedFrameCount, 100);
  if (!state && !code && !engine && processedFrameCount === null && recognizedFrameCount === null && failedFrameCount === null) {
    return null;
  }
  return {
    state: state || 'unknown',
    code: code || 'OCR_RUNTIME_UNKNOWN',
    engine: engine || null,
    processedFrameCount,
    recognizedFrameCount,
    failedFrameCount,
  };
}

function ocrRuntimeLimitation(diagnostics) {
  if (!diagnostics || diagnostics.state === 'ready' || diagnostics.state === 'not_applicable') return '';
  if (diagnostics.state === 'degraded') {
    return `OCR retained usable text but ${diagnostics.failedFrameCount || 0} sampled frame(s) could not be recognized.`;
  }
  const code = text(diagnostics.code, 120);
  return code ? `OCR runtime status: ${code}.` : 'OCR runtime did not return usable screen text.';
}

export async function ocrFrames(frames, framesDirectory, videoDirectory, videoConfig, deadline) {
  if (!frames.length) {
    return {
      status: 'not_applicable',
      frames,
      diagnostics: ocrRuntimeDiagnostic(null, { state: 'not_applicable', code: 'OCR_NO_FRAMES' }),
    };
  }
  const outputFile = path.join(videoDirectory, 'frame-ocr.json');
  const timeoutMs = boundedTimeout(deadline, 60_000);
  if (!timeoutMs) {
    return {
      status: 'timed_out',
      frames,
      diagnostics: ocrRuntimeDiagnostic(null, { state: 'timed_out', code: 'OCR_DEADLINE_EXHAUSTED' }),
    };
  }
  let processResult;
  try {
    processResult = await commandResult(videoConfig.python, [
      ...(Array.isArray(videoConfig.pythonArgs) ? videoConfig.pythonArgs : []),
      videoConfig.ocrScript,
      '--input-dir', framesDirectory,
      '--output-file', outputFile,
    ], { timeoutMs });
  } catch {
    return {
      status: 'tooling_unavailable',
      frames,
      diagnostics: ocrRuntimeDiagnostic(null, { state: 'unavailable', code: 'OCR_RUNTIME_UNAVAILABLE' }),
    };
  }
  if (processResult.timedOut) {
    return {
      status: 'timed_out',
      frames,
      diagnostics: ocrRuntimeDiagnostic(null, { state: 'timed_out', code: 'OCR_RUNTIME_TIMED_OUT' }),
    };
  }
  const payload = await readJson(outputFile);
  const artifactPath = payload ? relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile) : '';
  const payloadStatus = text(payload?.status, 80).toLowerCase();
  const diagnostics = ocrRuntimeDiagnostic(payload, processResult.code === 0
    ? { state: 'failed', code: 'OCR_OUTPUT_INVALID' }
    : { state: 'failed', code: 'OCR_PROCESS_FAILED' });
  if (!payload || !Array.isArray(payload.frames)) {
    return { status: 'ocr_failed', frames, artifactPath, diagnostics };
  }
  if (processResult.code !== 0 || !OCR_STAGE_STATUSES.has(payloadStatus) || payloadStatus !== 'completed') {
    return {
      status: OCR_STAGE_STATUSES.has(payloadStatus) ? payloadStatus : 'ocr_failed',
      frames,
      artifactPath,
      diagnostics,
    };
  }
  const byName = new Map(payload.frames.map((entry) => [text(entry?.file, 160), text(entry?.text, MAX_OCR_TEXT)]));
  const withOcr = frames.map((frame) => ({ ...frame, ocrText: byName.get(frame.filename) || '' }));
  return {
    status: 'completed',
    frames: withOcr,
    artifactPath,
    diagnostics,
  };
}

function escapeFilterValue(value) {
  return String(value || '').replace(/\\/g, '/').replace(/([:\\,'])/g, '\\$1');
}

function ffmpegFilterPath(value) {
  const raw = text(value, 2_000);
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  if (!path.isAbsolute(raw)) return escapeFilterValue(normalized);
  const relative = path.relative(process.cwd(), raw).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return escapeFilterValue(relative);
  return escapeFilterValue(normalized);
}

function transcriptSegmentSource(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.segments)) return payload.segments;
  if (Array.isArray(payload.chunks)) return payload.chunks;
  return [];
}

function transcriptSegmentText(segment) {
  if (!segment || typeof segment !== 'object') return '';
  return text(segment.text || segment.transcription || segment.content, MAX_TRANSCRIPT_SEGMENT_TEXT);
}

function transcriptSegmentTimestamp(segment, names, timestampIndex, unit = 'seconds') {
  const timestamps = Array.isArray(segment?.timestamp) ? segment.timestamp : [];
  const value = names
    .map((name) => segment?.[name])
    .find((candidate) => candidate !== undefined && candidate !== null);
  const raw = finite(value ?? timestamps[timestampIndex]);
  if (raw === null) return null;
  return roundedSeconds(unit === 'milliseconds' ? raw / 1000 : raw);
}

function normalizedTranscriptSegments(payload, { timestampUnit = 'seconds' } = {}) {
  const segments = [];
  let remainingCharacters = MAX_TRANSCRIPT_TEXT;
  // Bound both the input traversal and retained text so a malformed Whisper
  // artifact cannot inflate a durable job artifact.
  for (const rawSegment of transcriptSegmentSource(payload).slice(0, MAX_TRANSCRIPT_SEGMENTS * 4)) {
    if (remainingCharacters <= 0 || segments.length >= MAX_TRANSCRIPT_SEGMENTS) break;
    const rawText = transcriptSegmentText(rawSegment);
    if (!rawText) continue;
    const segmentText = rawText.slice(0, remainingCharacters).trim();
    if (!segmentText) continue;
    const startSeconds = transcriptSegmentTimestamp(
      rawSegment,
      ['startSeconds', 'start', 'start_time', 'from'],
      0,
      timestampUnit,
    );
    const proposedEndSeconds = transcriptSegmentTimestamp(
      rawSegment,
      ['endSeconds', 'end', 'end_time', 'to'],
      1,
      timestampUnit,
    );
    segments.push({
      index: segments.length + 1,
      startSeconds,
      endSeconds: startSeconds !== null && proposedEndSeconds !== null && proposedEndSeconds < startSeconds
        ? null
        : proposedEndSeconds,
      text: segmentText,
    });
    remainingCharacters -= segmentText.length;
  }
  return segments;
}

function transcriptText(payload, segments) {
  if (typeof payload === 'string') return text(payload, MAX_TRANSCRIPT_TEXT);
  if (Array.isArray(payload)) return text(segments.map((item) => item.text).join(' '), MAX_TRANSCRIPT_TEXT);
  if (payload && typeof payload === 'object') {
    const directText = text(payload.text || payload.transcription, MAX_TRANSCRIPT_TEXT);
    return directText || text(segments.map((item) => item.text).join(' '), MAX_TRANSCRIPT_TEXT);
  }
  return '';
}

export function normalizeTranscript(payload, options = {}) {
  const segments = normalizedTranscriptSegments(payload, options);
  return {
    text: transcriptText(payload, segments),
    segments,
  };
}

function transcriptProvider(videoConfig) {
  return text(videoConfig?.transcript?.provider, 80).toLowerCase() === 'funasr' ? 'funasr' : 'ffmpeg_whisper';
}

function transcriptProcessor(videoConfig) {
  const provider = transcriptProvider(videoConfig);
  if (provider === 'funasr') return text(videoConfig?.transcript?.funasrModelDir, 2_000) ? 'funasr_local_model' : 'funasr_not_configured';
  return text(videoConfig?.whisperModelPath, 2_000) ? 'ffmpeg_whisper' : 'not_configured';
}

function transcriptRuntimeLimitation(transcript, { frameSource = 'none', hasMediaInput = false } = {}) {
  const status = text(transcript?.status, 80);
  if (!status || status === 'completed' || status === 'not_applicable') return '';
  const provider = text(transcript?.provider, 80) === 'funasr' ? 'FunASR' : 'FFmpeg Whisper';
  if (status === 'not_available' && !hasMediaInput && frameSource === 'browser_rendered') {
    return 'Audio transcription was skipped because only browser-rendered keyframes were retained; OCR and visual analysis continue from those frames.';
  }
  if (status === 'not_configured') return `${provider} is not configured for this local video pipeline.`;
  if (status === 'model_unavailable') return `${provider} could not find its configured local model; reprocess the retained evidence after the model is available.`;
  if (status === 'tooling_unavailable') return `${provider} tooling is not available in the local runtime; reprocess the retained evidence after the runtime is restored.`;
  if (status === 'timed_out') return `${provider} exceeded the local processing deadline; reprocess the retained evidence to retry audio transcription.`;
  if (status === 'no_audio_stream') return 'No audio stream was present in the locally processed media.';
  if (status === 'transcript_empty') return `${provider} completed but did not identify usable speech in the retained media.`;
  if (status === 'local_media_unavailable') return 'Audio transcription requires a local media input, but only derived evidence was retained.';
  if (status === 'audio_extract_failed' || status === 'transcript_failed') return `${provider} did not produce a usable local transcript; reprocess the retained evidence to retry.`;
  return 'Audio transcript is not available for this sample.';
}

export function shouldAttemptTranscript(probe, browserFrames, videoConfig) {
  if (probe?.hasAudio === true) return true;
  if (probe?.status === 'completed') return false;
  return Boolean(
    Array.isArray(browserFrames?.frames)
    && browserFrames.frames.length
    && transcriptProcessor(videoConfig) !== 'not_configured'
    && transcriptProcessor(videoConfig) !== 'funasr_not_configured'
  );
}

async function transcribeWithWhisper(mediaInput, videoDirectory, videoConfig, deadline) {
  const modelPath = text(videoConfig.whisperModelPath, 2_000);
  if (!modelPath) return { status: 'not_configured', provider: 'ffmpeg_whisper' };
  if (!(await fileExists(modelPath))) return { status: 'model_unavailable', provider: 'ffmpeg_whisper' };
  const outputFile = path.join(videoDirectory, 'audio-transcript.json');
  const timeoutMs = boundedTimeout(deadline, 90_000);
  if (!timeoutMs) return { status: 'timed_out', provider: 'ffmpeg_whisper' };
  const filter = [
    `model=${ffmpegFilterPath(modelPath)}`,
    `language=${escapeFilterValue(videoConfig.whisperLanguage || 'zh')}`,
    `destination=${ffmpegFilterPath(outputFile)}`,
    'format=json',
  ].join(':');
  let processResult;
  try {
    processResult = await commandResult(videoConfig.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', mediaInput, '-map', '0:a:0?', '-af', `whisper=${filter}`, '-f', 'null', '-',
    ], { timeoutMs });
  } catch {
    return { status: 'tooling_unavailable', provider: 'ffmpeg_whisper' };
  }
  if (processResult.timedOut) return { status: 'timed_out', provider: 'ffmpeg_whisper' };
  if (processResult.code !== 0) return { status: 'transcript_failed', provider: 'ffmpeg_whisper' };
  const payload = await readTranscriptArtifact(outputFile);
  // FFmpeg's whisper filter writes JSONL start/end offsets in milliseconds.
  const transcript = normalizeTranscript(payload, { timestampUnit: 'milliseconds' });
  return transcript.text
    ? {
      status: 'completed',
      provider: 'ffmpeg_whisper',
      text: transcript.text,
      segments: transcript.segments,
      artifactPath: relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile),
    }
    : { status: 'transcript_empty', provider: 'ffmpeg_whisper' };
}

async function extractAudioForFunasr(localMediaPath, videoDirectory, videoConfig, deadline) {
  if (!path.isAbsolute(localMediaPath) || !(await fileExists(localMediaPath))) {
    return { status: 'local_media_unavailable', audioPath: '' };
  }
  const audioPath = path.join(videoDirectory, 'audio-asr.wav');
  const timeoutMs = boundedTimeout(deadline, 75_000);
  if (!timeoutMs) return { status: 'timed_out', audioPath: '' };
  let processResult;
  try {
    processResult = await commandResult(videoConfig.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', localMediaPath,
      '-map', '0:a:0?', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', audioPath,
    ], { timeoutMs });
  } catch {
    return { status: 'tooling_unavailable', audioPath: '' };
  }
  if (processResult.timedOut) return { status: 'timed_out', audioPath: '' };
  if (processResult.code !== 0 || !(await fileExists(audioPath))) return { status: 'audio_extract_failed', audioPath: '' };
  return { status: 'completed', audioPath };
}

async function transcribeWithFunasr(localMediaPath, videoDirectory, videoConfig, deadline) {
  const transcriptConfig = videoConfig?.transcript || {};
  const modelDir = text(transcriptConfig.funasrModelDir, 2_000);
  const script = text(transcriptConfig.funasrScript, 2_000);
  if (!modelDir || !script) return { status: 'not_configured', provider: 'funasr' };
  if (!(await fileExists(modelDir)) || !(await fileExists(script))) return { status: 'model_unavailable', provider: 'funasr' };
  const audio = await extractAudioForFunasr(localMediaPath, videoDirectory, videoConfig, deadline);
  if (audio.status !== 'completed') return { status: audio.status, provider: 'funasr' };
  const outputFile = path.join(videoDirectory, 'audio-transcript.json');
  const timeoutMs = boundedTimeout(deadline, 120_000);
  if (!timeoutMs) {
    await fs.rm(audio.audioPath, { force: true }).catch(() => {});
    return { status: 'timed_out', provider: 'funasr' };
  }
  let processResult;
  try {
    processResult = await commandResult(videoConfig.python, [
      ...(Array.isArray(videoConfig.pythonArgs) ? videoConfig.pythonArgs : []),
      script,
      '--input-file', audio.audioPath,
      '--output-file', outputFile,
      '--model-dir', modelDir,
      '--device', text(transcriptConfig.funasrDevice, 80) || 'auto',
      '--language', text(videoConfig.whisperLanguage, 40) || 'zh',
    ], { timeoutMs });
  } catch {
    await fs.rm(audio.audioPath, { force: true }).catch(() => {});
    return { status: 'tooling_unavailable', provider: 'funasr' };
  }
  await fs.rm(audio.audioPath, { force: true }).catch(() => {});
  if (processResult.timedOut) return { status: 'timed_out', provider: 'funasr' };
  const payload = await readJson(outputFile);
  const status = text(payload?.status, 80);
  if (processResult.code !== 0 || status !== 'completed') {
    return { status: status || 'transcript_failed', provider: 'funasr' };
  }
  const transcript = normalizeTranscript(payload);
  return transcript.text
    ? {
      status: 'completed',
      provider: 'funasr',
      text: transcript.text,
      segments: transcript.segments,
      artifactPath: relativeArtifactPath(videoConfig.artifactRootDirectory, outputFile),
    }
    : { status: 'transcript_empty', provider: 'funasr' };
}

async function transcribeAudio(mediaInput, videoDirectory, videoConfig, deadline) {
  return transcriptProvider(videoConfig) === 'funasr'
    ? transcribeWithFunasr(mediaInput, videoDirectory, videoConfig, deadline)
    : transcribeWithWhisper(mediaInput, videoDirectory, videoConfig, deadline);
}

function videoFingerprint(platform, samples) {
  return createHash('sha256').update(JSON.stringify({
    platform,
    samples: samples.map((sample) => ({
      sampleIndex: sample.sampleIndex,
      sourceUrl: scrubRuntimeUrl(sample.sourceUrl),
      contentType: sample.contentType,
      isPinned: Boolean(sample.isPinned),
      publishedAt: text(sample.publishedAt, 120) || null,
      selectionRank: positiveInteger(sample.selectionRank),
      selectionReason: text(sample.selectionReason, 80) || null,
    })),
  })).digest('hex');
}

const RETRYABLE_VIDEO_RECORD_STATUSES = new Set([
  'pending',
  'processing_failed',
  'relay_error',
  'tooling_unavailable',
  'timed_out',
  'media_not_rendered',
  'media_host_not_allowed',
  'media_processed_without_frames',
  'media_probe_failed',
  'login_required',
  'verification_required',
]);

const REOBSERVATION_VIDEO_RECORD_STATUSES = new Set([
  'pending',
  'processing_failed',
  'relay_error',
  'timed_out',
  'media_not_rendered',
  'media_host_not_allowed',
  'media_processed_without_frames',
  'media_probe_failed',
  'login_required',
  'verification_required',
]);

const RETRYABLE_VIDEO_STAGE_STATUSES = new Set([
  'timed_out',
  'transcript_failed',
  'ocr_failed',
  'dependency_unavailable',
  'tooling_unavailable',
  'model_unavailable',
  'local_media_unavailable',
  'audio_extract_failed',
  'processing_failed',
  'failed',
]);

const REOBSERVATION_VIDEO_STAGE_STATUSES = new Set([
  'timed_out',
  'transcript_failed',
  'local_media_unavailable',
  'audio_extract_failed',
  'processing_failed',
  'failed',
]);

const INACCESSIBLE_VIDEO_RECORD_STATUSES = new Set([
  'login_required',
  'verification_required',
  'media_not_rendered',
  'media_host_not_allowed',
]);

function videoRecordRetryable(record) {
  const status = text(record?.status, 80);
  if (RETRYABLE_VIDEO_RECORD_STATUSES.has(status)) return true;
  return [
    text(record?.ocr?.status, 80),
    text(record?.transcript?.status, 80),
    text(record?.vision?.status, 80),
  ].some((value) => RETRYABLE_VIDEO_STAGE_STATUSES.has(value));
}

function videoRecordRequiresReobservation(record) {
  const status = text(record?.status, 80);
  if (REOBSERVATION_VIDEO_RECORD_STATUSES.has(status)) return true;
  return [
    text(record?.ocr?.status, 80),
    text(record?.transcript?.status, 80),
    text(record?.vision?.status, 80),
  ].some((value) => REOBSERVATION_VIDEO_STAGE_STATUSES.has(value));
}

function decorateVideoRecordState(record) {
  if (!record || typeof record !== 'object') return record;
  const status = text(record.status, 80) || 'processing_failed';
  const inaccessible = INACCESSIBLE_VIDEO_RECORD_STATUSES.has(status);
  const retryable = videoRecordRetryable(record);
  const requiresReobservation = videoRecordRequiresReobservation(record);
  const limitations = Array.isArray(record.limitations) ? record.limitations : [];
  record.availability = {
    scope: 'public_rendered_video_page',
    status: inaccessible
      ? (retryable ? 'not_accessible_retryable' : 'not_accessible')
      : retryable
        ? 'retryable'
        : (Array.isArray(record.frames) && record.frames.length) || record.transcript?.status === 'completed' || record.summary
          ? 'completed'
          : 'partial',
    retryable,
    retryMode: !retryable
      ? null
      : requiresReobservation
        ? 'reobserve_public_page'
        : 'reprocess_retained_evidence_or_reconfigure',
    inaccessible,
    reason: text(limitations[0], 360) || null,
  };
  return record;
}

function videoCoverage(eligibleVideoSampleCount, videos, {
  checkpointReusedSampleCount = 0,
  observedVideoSampleCount = eligibleVideoSampleCount,
} = {}) {
  const records = videos.map((video) => decorateVideoRecordState(video));
  const frames = records.flatMap((video) => Array.isArray(video.frames) ? video.frames : []);
  const completedVision = records.filter((video) => video.vision?.status === 'completed');
  const transcriptSegments = records.flatMap((video) => Array.isArray(video.transcript?.segments) ? video.transcript.segments : []);
  const externalEvidence = records.flatMap((video) => Array.isArray(video.externalEvidence) ? video.externalEvidence : []);
  const selectionReasonCounts = records.reduce((counts, video) => {
    const reason = text(video?.selectionReason, 80);
    if (reason) counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
  return {
    eligibleVideoSampleCount,
    observedVideoSampleCount: Math.max(eligibleVideoSampleCount, observedVideoSampleCount),
    duplicateVisibleVideoReferenceCount: Math.max(0, observedVideoSampleCount - eligibleVideoSampleCount),
    selectedVideoSampleCount: records.length,
    processedVideoSampleCount: records.length,
    checkpointReusedSampleCount,
    unprocessedVideoSampleCount: Math.max(0, eligibleVideoSampleCount - records.length),
    completedVideoSampleCount: records.filter((video) => video.availability?.status === 'completed').length,
    retryableVideoSampleCount: records.filter((video) => video.availability?.retryable).length,
    inaccessibleVideoSampleCount: records.filter((video) => video.availability?.inaccessible).length,
    partialVideoSampleCount: records.filter((video) => video.availability?.status === 'partial').length,
    analysisScope: records.length >= eligibleVideoSampleCount ? 'all_visible_video_samples' : 'configured_subset',
    selectedSampleIndexes: records.map((video) => positiveInteger(video?.sampleIndex)).filter((value) => value !== null),
    selectionReasonCounts,
    renderedMediaSampleCount: records.filter((video) => video.rendered).length,
    probedVideoSampleCount: records.filter((video) => video.probe?.status === 'completed').length,
    sampledFrameCount: frames.length,
    timelineFrameCount: frames.filter((frame) => roundedSeconds(frame?.timeSeconds) !== null).length,
    timelineAnchors: [...new Set(frames.map((frame) => text(frame?.timelineAnchor, 40)).filter(Boolean))],
    ocrTextFrameCount: frames.filter((frame) => text(frame?.ocrText, MAX_OCR_TEXT)).length,
    transcriptAvailableSampleCount: records.filter((video) => video.transcript?.status === 'completed').length,
    transcriptSegmentCount: transcriptSegments.length,
    timestampedTranscriptSegmentCount: transcriptSegments.filter((segment) => roundedSeconds(segment?.startSeconds) !== null).length,
    visualSemanticSampleCount: completedVision.length,
    visualSemanticFrameCount: completedVision.reduce(
      (total, video) => total + (Number.isInteger(video.vision?.analyzedFrameCount) ? video.vision.analyzedFrameCount : 0),
      0,
    ),
    externalProviderCompletedCount: externalEvidence.filter((entry) => entry?.status === 'completed').length,
    externalSummarySampleCount: records.filter((video) => video?.summary?.summary || video?.summary?.keypoints?.length || video?.summary?.mindmap).length,
  };
}

function analysisStatus(coverage) {
  if (!coverage.selectedVideoSampleCount) return 'not_applicable';
  if (!coverage.renderedMediaSampleCount) {
    return coverage.externalProviderCompletedCount || coverage.transcriptAvailableSampleCount || coverage.externalSummarySampleCount
      ? 'external_evidence_completed'
      : 'media_unavailable';
  }
  if (!coverage.sampledFrameCount) return 'media_partial';
  return coverage.renderedMediaSampleCount === coverage.selectedVideoSampleCount ? 'completed' : 'partial';
}

function analysisLimitations(coverage, videos, videoConfig = {}) {
  const configuredTranscriptProvider = transcriptProvider(videoConfig) === 'funasr' ? 'FunASR' : 'Whisper';
  return [
    !coverage.eligibleVideoSampleCount ? 'No visible content sample was identified as a public video.' : '',
    coverage.selectedVideoSampleCount < coverage.eligibleVideoSampleCount ? 'Video analysis used an explicit operational subset of the captured public video samples.' : '',
    coverage.renderedMediaSampleCount < coverage.selectedVideoSampleCount ? 'Some video pages did not expose a rendered playable media element in the attached browser session.' : '',
    coverage.sampledFrameCount < coverage.renderedMediaSampleCount ? 'Some rendered videos did not yield usable sampled frames within the local processing budget.' : '',
    coverage.retryableVideoSampleCount ? 'Some public video records have a retryable local collection or interpretation stage and remain eligible for resume.' : '',
    coverage.inaccessibleVideoSampleCount ? 'Some public video pages were not accessible in the currently attached browser session; their per-item reason is retained.' : '',
    !coverage.visualSemanticSampleCount && coverage.sampledFrameCount ? 'Local visual-language analysis is unavailable until an Ollama vision model is configured and ready.' : '',
    !coverage.transcriptAvailableSampleCount && videos.some((video) => video.rendered) ? `Audio transcription is unavailable until a local ${configuredTranscriptProvider} model is configured.` : '',
    coverage.transcriptAvailableSampleCount && !coverage.timestampedTranscriptSegmentCount ? 'Available audio transcripts did not contain usable timestamped segments.' : '',
  ].filter(Boolean);
}

function boundedVideoProcessingConcurrency(value) {
  const requested = Number(value);
  return Math.max(1, Math.min(4, Number.isFinite(requested) ? Math.floor(requested) : 2));
}

function videoCheckpointConfigFingerprint(videoConfig) {
  const enabledToolchain = Object.entries(videoConfig?.toolchain || {})
    .filter(([, adapter]) => Boolean(adapter?.enabled))
    .map(([id, adapter]) => ({
      id,
      command: text(adapter?.command, 2_000),
      args: Array.isArray(adapter?.args) ? adapter.args.map((value) => text(value, 2_000)) : [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify({
    // Revision 3 permits browser-retained keyframes to complete OCR and
    // visual analysis even when no reusable media URL was observed.
    pipelineRevision: 3,
    framesPerVideo: positiveInteger(videoConfig?.framesPerVideo),
    transcriptProvider: transcriptProvider(videoConfig),
    transcriptConfigured: transcriptProcessor(videoConfig),
    whisperLanguage: text(videoConfig?.whisperLanguage, 40),
    whisperModelPath: text(videoConfig?.whisperModelPath, 2_000),
    funasrModelDir: text(videoConfig?.transcript?.funasrModelDir, 2_000),
    funasrScript: text(videoConfig?.transcript?.funasrScript, 2_000),
    localMediaCacheEnabled: videoConfig?.localMediaCache?.enabled !== false,
    browserRecordingFallback: videoConfig?.browserRecordingFallback === true,
    ffmpeg: text(videoConfig?.ffmpeg, 2_000),
    ffprobe: text(videoConfig?.ffprobe, 2_000),
    python: text(videoConfig?.python, 2_000),
    ocrScript: text(videoConfig?.ocrScript, 2_000),
    visionModel: text(videoConfig?.vision?.model, 240),
    visionBaseUrl: text(videoConfig?.vision?.baseUrl, 2_000),
    visionFrames: positiveInteger(videoConfig?.vision?.maxFrames),
    externalToolchain: enabledToolchain,
  })).digest('hex');
}

function checkpointPathForSample(sampleDirectory) {
  return path.join(sampleDirectory, VIDEO_CHECKPOINT_FILE);
}

function reusableCheckpointRecord(record, selectedSample) {
  const expectedSourceUrl = scrubRuntimeUrl(selectedSample?.sourceUrl);
  const status = text(record?.status, 80);
  return Boolean(
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && positiveInteger(record.sampleIndex) === positiveInteger(selectedSample?.sampleIndex)
    && record.sourceUrl === expectedSourceUrl
    && status
    && !videoRecordRequiresReobservation(record)
  );
}

async function readVideoCheckpoint(sampleDirectory, platform, selectedSample, configFingerprint) {
  const checkpoint = await readJson(checkpointPathForSample(sampleDirectory));
  if (
    checkpoint?.schemaVersion !== VIDEO_CHECKPOINT_SCHEMA_VERSION
    || checkpoint?.platform !== platform
    || checkpoint?.configFingerprint !== configFingerprint
    || !reusableCheckpointRecord(checkpoint?.record, selectedSample)
  ) {
    return null;
  }
  return checkpoint.record;
}

async function writeVideoCheckpoint(sampleDirectory, platform, configFingerprint, record) {
  const outputPath = checkpointPathForSample(sampleDirectory);
  const temporaryPath = outputPath + '.tmp';
  const payload = {
    schemaVersion: VIDEO_CHECKPOINT_SCHEMA_VERSION,
    completedAt: new Date().toISOString(),
    platform,
    configFingerprint,
    record,
  };
  await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(temporaryPath, outputPath);
}

function createTaskLimiter(requestedConcurrency) {
  const concurrency = Math.max(1, Number.isFinite(Number(requestedConcurrency))
    ? Math.floor(Number(requestedConcurrency))
    : 1);
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && queue.length) {
      const next = queue.shift();
      running += 1;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

export function createAsyncQueue(capacity = Number.POSITIVE_INFINITY) {
  const items = [];
  const itemWaiters = [];
  const pushWaiters = [];
  const maximum = Number.isFinite(Number(capacity))
    ? Math.max(1, Math.floor(Number(capacity)))
    : Number.POSITIVE_INFINITY;
  let closed = false;
  const drain = () => {
    while (pushWaiters.length) {
      const next = pushWaiters[0];
      const itemWaiter = itemWaiters.shift();
      if (itemWaiter) {
        pushWaiters.shift();
        itemWaiter(next.item);
        next.resolve(true);
        continue;
      }
      if (items.length >= maximum) return;
      pushWaiters.shift();
      items.push(next.item);
      next.resolve(true);
    }
  };
  return {
    push(item) {
      if (closed) return Promise.resolve(false);
      return new Promise((resolve) => {
        pushWaiters.push({ item, resolve });
        drain();
      });
    },
    close() {
      closed = true;
      while (pushWaiters.length) pushWaiters.shift().resolve(false);
      while (itemWaiters.length) itemWaiters.shift()(null);
    },
    take() {
      if (items.length) {
        const item = items.shift();
        drain();
        return item;
      }
      if (closed) return null;
      return new Promise((resolve) => {
        itemWaiters.push(resolve);
        drain();
      });
    },
  };
}

export function createVideoProcessingResources(requestedConcurrency) {
  const concurrency = boundedVideoProcessingConcurrency(requestedConcurrency);
  const ocrConcurrency = Math.min(4, concurrency);
  const transcriptConcurrency = Math.min(2, concurrency);
  const visionConcurrency = Math.min(2, concurrency);
  return {
    ocr: createTaskLimiter(ocrConcurrency),
    transcript: createTaskLimiter(transcriptConcurrency),
    vision: createTaskLimiter(visionConcurrency),
    limits: {
      ocr: ocrConcurrency,
      transcript: transcriptConcurrency,
      vision: visionConcurrency,
    },
  };
}

function initialVideoRecord(selectedSample, scopedConfig) {
  return {
    sampleIndex: selectedSample.sampleIndex,
    sourceUrl: scrubRuntimeUrl(selectedSample.sourceUrl),
    contentType: selectedSample.contentType || null,
    observedInteractions: selectedSample.observedInteractions,
    isPinned: selectedSample.isPinned,
    publishedAt: selectedSample.publishedAt || null,
    selectionRank: selectedSample.selectionRank,
    selectionReason: selectedSample.selectionReason,
    selectionObservedInteractionScore: selectedSample.selectionObservedInteractionScore,
    status: 'pending',
    observationArtifactPath: null,
    rendered: null,
    probe: null,
    mediaCache: { status: 'not_applicable', byteLength: null, artifactPath: null },
    frameSource: 'none',
    frames: [],
    transcript: { status: 'not_applicable', provider: transcriptProvider(scopedConfig) },
    vision: { status: scopedConfig?.vision?.model ? 'failed' : 'not_configured' },
    externalEvidence: [],
    summary: null,
    limitations: [],
  };
}

async function observeVideoSample({
  selectedSample,
  platform,
  artifactDirectory,
  artifactRootDirectory,
  relayPort,
  videoConfig,
  runWithRelayLock,
}) {
  const deadline = Date.now() + Math.max(30_000, Number(videoConfig.timeoutMs) || 180_000);
  const sampleDirectory = path.join(artifactDirectory, 'video', 'sample-' + String(selectedSample.sampleIndex).padStart(2, '0'));
  await fs.mkdir(sampleDirectory, { recursive: true });
  const scopedConfig = { ...videoConfig, artifactRootDirectory };
  try {
    const relay = await runWithRelayLock(() => runRelayObservation({
      platform,
      contentUrl: selectedSample.sourceUrl,
      videoDirectory: sampleDirectory,
      videoConfig: scopedConfig,
      relayPort,
      deadline,
    }));
    return { sampleDirectory, relay };
  } catch {
    return {
      sampleDirectory,
      relay: { status: 'relay_error', observationArtifactPath: '' },
    };
  }
}

async function processVideoSample({
  selectedSample,
  platform,
  artifactDirectory,
  artifactRootDirectory,
  relayPort,
  videoConfig,
  runWithRelayLock,
  processingResources,
  observation = null,
}) {
  const deadline = Date.now() + Math.max(30_000, Number(videoConfig.timeoutMs) || 180_000);
  const sampleDirectory = observation?.sampleDirectory
    || path.join(artifactDirectory, 'video', 'sample-' + String(selectedSample.sampleIndex).padStart(2, '0'));
  await fs.mkdir(sampleDirectory, { recursive: true });
  const scopedConfig = { ...videoConfig, artifactRootDirectory };
  const record = initialVideoRecord(selectedSample, scopedConfig);
  const directPlaybackUrl = candidateMediaUrl(platform, selectedSample.playbackUrl);
  let localMedia = { status: 'not_applicable', localPath: '', byteLength: null };
  let runtimeRecordingPath = '';
  let externalCleanupPaths = [];

  try {
    let relay = observation?.relay;
    if (!relay) {
      try {
        relay = await runWithRelayLock(() => runRelayObservation({
          platform,
          contentUrl: selectedSample.sourceUrl,
          videoDirectory: sampleDirectory,
          videoConfig: scopedConfig,
          relayPort,
          deadline,
        }));
      } catch {
        relay = { status: 'relay_error', observationArtifactPath: '' };
      }
    }
    record.status = relay.status || 'relay_error';
    record.observationArtifactPath = relay.observationArtifactPath || null;
    const relayMediaReady = relay.status === 'media_ready'
      && Boolean(relay.runtimeMediaUrl)
      && allowedRuntimeMediaUrl(platform, relay.runtimeMediaUrl);
    // The relay can retain rendered keyframes even when the browser does not
    // expose a reusable media URL. Resolve those frames before deciding that
    // the sample has no usable local evidence.
    const frameFallback = await browserRenderedFrameFallback(relay, sampleDirectory, artifactRootDirectory);
    const browserFrames = Array.isArray(frameFallback?.frames)
      ? frameFallback
      : { frames: [], framesDirectory: path.join(sampleDirectory, 'frames') };
    const externalAcquisition = await acquireExternalVideoEvidence({
      platform,
      sourceUrl: record.sourceUrl,
      mediaUrl: selectedSample.playbackUrl,
      videoDirectory: sampleDirectory,
      artifactRootDirectory,
      toolchain: scopedConfig.toolchain,
      includeVideoBatchDownload: !relayMediaReady && !directPlaybackUrl,
    });
    record.externalEvidence.push(...(Array.isArray(externalAcquisition?.providers) ? externalAcquisition.providers : []));
    const externalTranscript = externalAcquisition?.transcript || null;
    externalCleanupPaths = Array.isArray(externalAcquisition?.cleanupPaths) ? externalAcquisition.cleanupPaths : [];

    if (!relayMediaReady && !externalAcquisition?.mediaPath && !directPlaybackUrl && !browserFrames.frames.length) {
      record.status = relay.status === 'media_ready' ? 'media_host_not_allowed' : relay.status;
      record.limitations.push(relay.status === 'media_ready'
        ? 'The rendered media host did not match the selected public platform allowlist.'
        : 'No playable media URL was retained because this public page did not render a usable video element.');
      if (externalTranscript?.text) {
        record.transcript = externalTranscript;
        const externalEnhancement = await enrichExternalVideoEvidence({
          sourceUrl: record.sourceUrl,
          mediaPath: '',
          transcript: record.transcript,
          ocrText: '',
          videoDirectory: sampleDirectory,
          artifactRootDirectory,
          toolchain: scopedConfig.toolchain,
        });
        record.externalEvidence.push(...(Array.isArray(externalEnhancement?.providers) ? externalEnhancement.providers : []));
        record.summary = externalEnhancement?.summary || null;
        record.status = record.summary ? 'external_evidence_completed' : 'external_transcript_completed';
      }
      return { record, sampleDirectory };
    }

    if (relayMediaReady) record.rendered = relay.rendered;
    let probe = { status: 'not_available' };
    let processingInput = text(externalAcquisition?.mediaPath, 2_000) || directPlaybackUrl;
    if (relayMediaReady) {
      const directMediaDeadline = browserFrames.frames.length
        ? Math.min(deadline, Date.now() + 20_000)
        : deadline;
      processingInput = relay.runtimeMediaUrl;
      // A successful cache already proves that FFmpeg could read the rendered
      // stream. Probe that local copy first, avoiding a second signed-stream
      // round trip before frame extraction and ASR can start. A failed cache
      // retains the direct runtime probe as the compatibility fallback.
      const cacheDeadline = browserFrames.frames.length
        ? Math.min(deadline, Date.now() + 30_000)
        : deadline;
      localMedia = await cacheRenderedMedia(relay.runtimeMediaUrl, sampleDirectory, scopedConfig, cacheDeadline, platform);
      const resolvedMedia = await resolveCachedMediaProbe({
        localMedia,
        runtimeMediaUrl: relay.runtimeMediaUrl,
        videoConfig: scopedConfig,
        deadline,
        platform,
        runtimeDeadline: directMediaDeadline,
      });
      localMedia = resolvedMedia.localMedia;
      probe = resolvedMedia.probe;
      processingInput = resolvedMedia.processingInput;
      runtimeRecordingPath = text(relay.runtimeRecordingPath, 2_000);
      if (runtimeRecordingPath && await fileExists(runtimeRecordingPath)) {
        const recordingProbe = await probeMedia(runtimeRecordingPath, scopedConfig, deadline, platform);
        if (recordingProbe.status === 'completed') {
          processingInput = runtimeRecordingPath;
          probe = recordingProbe;
        }
      }
    } else {
      const externalStat = path.isAbsolute(processingInput)
        ? await fs.stat(processingInput).catch(() => null)
        : null;
      localMedia = {
        status: externalStat?.isFile()
          ? 'external_download_completed'
          : directPlaybackUrl
            ? 'direct_playback_url'
            : 'external_media_missing',
        localPath: externalStat?.isFile() ? processingInput : '',
        byteLength: externalStat?.isFile() ? externalStat.size : null,
      };
      if (localMedia.localPath) probe = await probeMedia(localMedia.localPath, scopedConfig, deadline, platform);
      else if (directPlaybackUrl) probe = await probeMedia(directPlaybackUrl, scopedConfig, deadline, platform);
      record.rendered = {
        durationSeconds: probe.durationSeconds || null,
        dimensions: { width: probe.width || null, height: probe.height || null },
        evidence: localMedia.localPath
          ? 'external_public_video_download'
          : directPlaybackUrl
            ? 'captured_public_video_playback_url'
            : 'browser_rendered_keyframes',
      };
      if (!localMedia.localPath && browserFrames.frames.length) {
        localMedia.status = 'browser_frames_only';
      }
    }
    record.probe = probe;
    record.mediaCache = {
      status: localMedia.status,
      byteLength: localMedia.byteLength ?? null,
      artifactPath: null,
    };
    if (scopedConfig?.retainMediaArtifact === true) {
      record.mediaCache.artifactPath = await retainPlaybackArtifact({
        candidates: [localMedia.localPath, runtimeRecordingPath, processingInput],
        sampleDirectory,
        artifactRootDirectory,
        maxBytes: scopedConfig.retainMediaMaxBytes,
      }) || null;
    }

    const durationSeconds = probe.durationSeconds || relay.rendered?.durationSeconds || null;
    let extracted = { frames: [], framesDirectory: path.join(sampleDirectory, 'frames') };
    let frameSource = 'none';
    if (probe.status === 'completed' || !browserFrames.frames.length) {
      extracted = await extractFrames(processingInput, durationSeconds, sampleDirectory, scopedConfig, deadline, platform);
      if (extracted.frames.length) frameSource = 'ffmpeg';
    }
    if (!extracted.frames.length && browserFrames.frames.length) {
      extracted = browserFrames;
      frameSource = 'browser_rendered';
    }

    const noTranscript = {
      status: probe.status === 'completed' ? 'no_audio_stream' : 'not_available',
      provider: transcriptProvider(scopedConfig),
    };
    const [ocr, vision, transcript] = await Promise.all([
      processingResources.ocr(() => ocrFrames(
        extracted.frames,
        extracted.framesDirectory,
        sampleDirectory,
        scopedConfig,
        deadline,
      )).catch(() => ({
        status: 'ocr_failed',
        frames: extracted.frames,
        artifactPath: '',
        diagnostics: ocrRuntimeDiagnostic(null, { state: 'failed', code: 'OCR_STAGE_EXCEPTION' }),
      })),
      processingResources.vision(() => analyzeVideoFrames({
        frames: extracted.frames,
        framesDirectory: extracted.framesDirectory,
        videoDirectory: sampleDirectory,
        artifactRootDirectory,
        platform,
        visionConfig: scopedConfig.vision,
        deadline,
      })).catch(() => ({ status: scopedConfig?.vision?.model ? 'failed' : 'not_configured' })),
      Boolean(processingInput) && shouldAttemptTranscript(probe, browserFrames, scopedConfig)
        ? processingResources.transcript(() => transcribeAudio(processingInput, sampleDirectory, scopedConfig, deadline))
          .catch(() => ({ status: 'transcript_failed', provider: transcriptProvider(scopedConfig) }))
        : Promise.resolve(noTranscript),
    ]);
    record.frames = ocr.frames;
    record.frameSource = frameSource;
    record.ocr = {
      status: ocr.status,
      artifactPath: ocr.artifactPath || null,
      diagnostics: ocr.diagnostics || null,
    };
    record.vision = vision;
    record.transcript = transcript;
    if (record.transcript.status !== 'completed' && externalTranscript?.text) {
      record.transcript = externalTranscript;
    }
    const externalEnhancement = await enrichExternalVideoEvidence({
      sourceUrl: record.sourceUrl,
      mediaPath: path.isAbsolute(processingInput) ? processingInput : '',
      transcript: record.transcript,
      ocrText: record.frames.map((frame) => frame.ocrText || '').join(' '),
      videoDirectory: sampleDirectory,
      artifactRootDirectory,
      toolchain: scopedConfig.toolchain,
    });
    record.externalEvidence.push(...(Array.isArray(externalEnhancement?.providers) ? externalEnhancement.providers : []));
    if (record.transcript.status !== 'completed' && externalEnhancement?.transcript?.text) {
      record.transcript = externalEnhancement.transcript;
    }
    record.summary = externalEnhancement?.summary || null;
    record.status = record.frames.length
      ? (frameSource === 'browser_rendered'
        ? (ocr.status === 'completed' ? 'browser_frames_completed' : 'browser_frames_completed_ocr_unavailable')
        : (ocr.status === 'completed' ? 'completed' : 'frames_completed_ocr_unavailable'))
      : (probe.status === 'completed' ? 'media_processed_without_frames' : 'media_probe_failed');
    if (probe.status !== 'completed') record.limitations.push('Media stream metadata could not be fully probed.');
    if (frameSource === 'browser_rendered') record.limitations.push('Derived keyframes were captured from the browser-rendered video because direct media processing was unavailable.');
    if (!record.frames.length) record.limitations.push('No sampled frame was produced within the local processing budget.');
    const ocrLimitation = ocrRuntimeLimitation(ocr.diagnostics);
    if (ocrLimitation) record.limitations.push(ocrLimitation);
    if (record.vision.status !== 'completed') {
      const visionLimitation = Array.isArray(record.vision.limitations)
        ? record.vision.limitations.find(Boolean)
        : '';
      record.limitations.push(visionLimitation || 'Local visual analysis did not return a validated result for the retained keyframes.');
    }
    const transcriptLimitation = transcriptRuntimeLimitation(record.transcript, {
      frameSource,
      hasMediaInput: Boolean(processingInput),
    });
    if (transcriptLimitation) record.limitations.push(transcriptLimitation);
  } catch {
    record.status = 'processing_failed';
    record.limitations.push('Video evidence processing stopped before all local steps completed.');
  } finally {
    if (localMedia.localPath) await fs.rm(localMedia.localPath, { force: true }).catch(() => {});
    if (runtimeRecordingPath) await fs.rm(runtimeRecordingPath, { force: true }).catch(() => {});
    for (const mediaPath of externalCleanupPaths) {
      if (mediaPath && mediaPath !== localMedia.localPath) await fs.rm(mediaPath, { force: true }).catch(() => {});
    }
  }
  return { record, sampleDirectory };
}

async function collectVideoEvidenceSerialLegacy({
  capture,
  platform,
  artifactDirectory,
  artifactRootDirectory,
  relayPort,
  videoConfig,
  runWithRelayLock = (task) => task(),
}) {
  const candidateSummary = videoCandidateSummary(capture, platform);
  const selected = selectVideoSamples(capture, platform, videoConfig?.maxVideosPerCreator);
  const eligibleVideoSampleCount = candidateSummary.eligibleVideoSampleCount;
  const base = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: 'not_applicable',
    sourceFingerprint: videoFingerprint(platform, selected),
    processor: {
      renderedMedia: 'browser_relay',
      visualFrames: 'ffmpeg_or_browser_rendered',
      frameSampling: 'uniform_timeline_anchors',
      screenText: 'rapidocr_onnxruntime',
      audioTranscript: transcriptProcessor(videoConfig),
      localMediaCache: videoConfig?.localMediaCache?.enabled === false ? 'disabled' : 'transient_local_copy',
      visualSemantics: videoConfig?.vision?.model ? 'ollama' : 'not_configured',
      externalToolchain: Object.values(videoConfig?.toolchain || {}).some((adapter) => adapter?.enabled)
        ? 'configured_optional_adapters'
        : 'not_configured',
    },
    coverage: videoCoverage(eligibleVideoSampleCount, [], {
      observedVideoSampleCount: candidateSummary.observedVideoSampleCount,
    }),
    videos: [],
    limitations: [],
  };
  if (!videoConfig?.enabled) {
    return { ...base, status: 'disabled', limitations: ['Video analysis is disabled by local configuration.'] };
  }
  if (!selected.length) {
    return { ...base, limitations: analysisLimitations(base.coverage, [], videoConfig) };
  }

  const videos = [];
  for (const selectedSample of selected) {
    const deadline = Date.now() + Math.max(30_000, Number(videoConfig.timeoutMs) || 180_000);
    const sampleDirectory = path.join(artifactDirectory, 'video', `sample-${String(selectedSample.sampleIndex).padStart(2, '0')}`);
    await fs.mkdir(sampleDirectory, { recursive: true });
    const scopedConfig = { ...videoConfig, artifactRootDirectory };
    let relay;
    try {
      relay = await runWithRelayLock(() => runRelayObservation({
        platform,
        contentUrl: selectedSample.sourceUrl,
        videoDirectory: sampleDirectory,
        videoConfig: scopedConfig,
        relayPort,
        deadline,
      }));
    } catch {
      relay = { status: 'relay_error', observationArtifactPath: '' };
    }
    const record = {
      sampleIndex: selectedSample.sampleIndex,
      sourceUrl: scrubRuntimeUrl(selectedSample.sourceUrl),
      contentType: selectedSample.contentType || null,
      observedInteractions: selectedSample.observedInteractions,
      isPinned: selectedSample.isPinned,
      publishedAt: selectedSample.publishedAt || null,
      selectionRank: selectedSample.selectionRank,
      selectionReason: selectedSample.selectionReason,
      selectionObservedInteractionScore: selectedSample.selectionObservedInteractionScore,
      status: relay.status,
      observationArtifactPath: relay.observationArtifactPath || null,
      rendered: null,
      probe: null,
      mediaCache: { status: 'not_applicable', byteLength: null },
      frameSource: 'none',
      frames: [],
      transcript: { status: 'not_applicable', provider: transcriptProvider(scopedConfig) },
      vision: { status: videoConfig?.vision?.model ? 'failed' : 'not_configured' },
      externalEvidence: [],
      summary: null,
      limitations: [],
    };
    const relayMediaReady = relay.status === 'media_ready'
      && Boolean(relay.runtimeMediaUrl)
      && allowedRuntimeMediaUrl(platform, relay.runtimeMediaUrl);
    const externalAcquisition = await acquireExternalVideoEvidence({
      platform,
      sourceUrl: record.sourceUrl,
      mediaUrl: selectedSample.playbackUrl,
      videoDirectory: sampleDirectory,
      artifactRootDirectory,
      toolchain: scopedConfig.toolchain,
      includeVideoBatchDownload: !relayMediaReady,
    });
    record.externalEvidence.push(...externalAcquisition.providers);
    let externalTranscript = externalAcquisition.transcript;
    const externalCleanupPaths = [...externalAcquisition.cleanupPaths];
    if (!relayMediaReady && !externalAcquisition.mediaPath) {
      record.status = relay.status === 'media_ready' ? 'media_host_not_allowed' : relay.status;
      record.limitations.push(relay.status === 'media_ready'
        ? 'The rendered media host did not match the selected public platform allowlist.'
        : 'No playable media URL was retained because this public page did not render a usable video element.');
      if (externalTranscript?.text) {
        record.transcript = externalTranscript;
        const externalEnhancement = await enrichExternalVideoEvidence({
          sourceUrl: record.sourceUrl,
          mediaPath: '',
          transcript: record.transcript,
          ocrText: '',
          videoDirectory: sampleDirectory,
          artifactRootDirectory,
          toolchain: scopedConfig.toolchain,
        });
        record.externalEvidence.push(...externalEnhancement.providers);
        record.summary = externalEnhancement.summary;
        record.status = record.summary ? 'external_evidence_completed' : 'external_transcript_completed';
      }
      videos.push(decorateVideoRecordState(record));
      continue;
    }
    if (relayMediaReady) record.rendered = relay.rendered;
    const browserFrames = await browserRenderedFrameFallback(relay, sampleDirectory, artifactRootDirectory);
    let localMedia = { status: 'not_applicable', localPath: '', byteLength: null };
    let probe = { status: 'not_available' };
    let processingInput = externalAcquisition.mediaPath;
    let runtimeRecordingPath = '';
    if (relayMediaReady) {
      // Browser frames are already visible in the authenticated page. When they
      // exist, bound direct-stream work tightly so a transient signed stream
      // cannot consume the whole job before the derived evidence is analyzed.
      const directMediaDeadline = browserFrames.frames.length
        ? Math.min(deadline, Date.now() + 20_000)
        : deadline;
      const runtimeProbe = await probeMedia(relay.runtimeMediaUrl, scopedConfig, directMediaDeadline, platform);
      localMedia = { status: 'not_attempted_after_probe_failure', localPath: '', byteLength: null };
      if (runtimeProbe.status === 'completed' || scopedConfig?.localMediaCache?.enabled === false) {
        const cacheDeadline = browserFrames.frames.length
          ? Math.min(deadline, Date.now() + 30_000)
          : deadline;
        localMedia = await cacheRenderedMedia(relay.runtimeMediaUrl, sampleDirectory, scopedConfig, cacheDeadline, platform);
      }
      probe = runtimeProbe;
      processingInput = relay.runtimeMediaUrl;
      runtimeRecordingPath = text(relay.runtimeRecordingPath, 2_000);
      if (runtimeRecordingPath && await fileExists(runtimeRecordingPath)) {
        processingInput = runtimeRecordingPath;
        const recordingProbe = await probeMedia(runtimeRecordingPath, scopedConfig, deadline, platform);
        if (recordingProbe.status === 'completed') probe = recordingProbe;
      }
      if (localMedia.status === 'completed' && localMedia.localPath) {
        const localProbe = await probeMedia(localMedia.localPath, scopedConfig, deadline, platform);
        if (localProbe.status === 'completed') {
          probe = localProbe;
          processingInput = localMedia.localPath;
        } else {
          localMedia.status = 'local_probe_failed';
          await fs.rm(localMedia.localPath, { force: true }).catch(() => {});
          localMedia.localPath = '';
        }
      }
    } else {
      const externalStat = await fs.stat(processingInput).catch(() => null);
      localMedia = {
        status: externalStat?.isFile() ? 'external_download_completed' : 'external_media_missing',
        localPath: externalStat?.isFile() ? processingInput : '',
        byteLength: externalStat?.isFile() ? externalStat.size : null,
      };
      if (localMedia.localPath) probe = await probeMedia(localMedia.localPath, scopedConfig, deadline, platform);
      record.rendered = {
        durationSeconds: probe.durationSeconds || null,
        dimensions: { width: probe.width || null, height: probe.height || null },
        evidence: 'external_public_video_download',
      };
    }
    record.probe = probe;
    record.mediaCache = {
      status: localMedia.status,
      byteLength: localMedia.byteLength ?? null,
    };
    try {
      const durationSeconds = probe.durationSeconds || relay.rendered?.durationSeconds || null;
      let extracted = { frames: [], framesDirectory: path.join(sampleDirectory, 'frames') };
      let frameSource = 'none';
      if (probe.status === 'completed' || !browserFrames.frames.length) {
        extracted = await extractFrames(processingInput, durationSeconds, sampleDirectory, scopedConfig, deadline, platform);
        if (extracted.frames.length) frameSource = 'ffmpeg';
      }
      if (!extracted.frames.length && browserFrames.frames.length) {
        extracted = browserFrames;
        frameSource = 'browser_rendered';
      }
      const ocr = await ocrFrames(extracted.frames, extracted.framesDirectory, sampleDirectory, scopedConfig, deadline);
      record.frames = ocr.frames;
      record.frameSource = frameSource;
      record.ocr = {
        status: ocr.status,
        artifactPath: ocr.artifactPath || null,
        diagnostics: ocr.diagnostics || null,
      };
      record.vision = await analyzeVideoFrames({
        frames: record.frames,
        framesDirectory: extracted.framesDirectory,
        videoDirectory: sampleDirectory,
        artifactRootDirectory,
        platform,
        visionConfig: scopedConfig.vision,
        deadline,
      });
      record.transcript = shouldAttemptTranscript(probe, browserFrames, scopedConfig)
        ? await transcribeAudio(processingInput, sampleDirectory, scopedConfig, deadline)
        : {
          status: probe.status === 'completed' ? 'no_audio_stream' : 'not_available',
          provider: transcriptProvider(scopedConfig),
        };
      if (record.transcript.status !== 'completed' && externalTranscript?.text) {
        record.transcript = externalTranscript;
      }
      const externalEnhancement = await enrichExternalVideoEvidence({
        sourceUrl: record.sourceUrl,
        mediaPath: path.isAbsolute(processingInput) ? processingInput : '',
        transcript: record.transcript,
        ocrText: record.frames.map((frame) => frame.ocrText || '').join(' '),
        videoDirectory: sampleDirectory,
        artifactRootDirectory,
        toolchain: scopedConfig.toolchain,
      });
      record.externalEvidence.push(...externalEnhancement.providers);
      if (record.transcript.status !== 'completed' && externalEnhancement.transcript?.text) {
        record.transcript = externalEnhancement.transcript;
      }
      record.summary = externalEnhancement.summary;
      record.status = record.frames.length
        ? (frameSource === 'browser_rendered'
          ? (ocr.status === 'completed' ? 'browser_frames_completed' : 'browser_frames_completed_ocr_unavailable')
          : (ocr.status === 'completed' ? 'completed' : 'frames_completed_ocr_unavailable'))
        : (probe.status === 'completed' ? 'media_processed_without_frames' : 'media_probe_failed');
      if (probe.status !== 'completed') record.limitations.push('Media stream metadata could not be fully probed.');
      if (frameSource === 'browser_rendered') record.limitations.push('Derived keyframes were captured from the browser-rendered video because direct media processing was unavailable.');
      if (!record.frames.length) record.limitations.push('No sampled frame was produced within the local processing budget.');
      const ocrLimitation = ocrRuntimeLimitation(ocr.diagnostics);
      if (ocrLimitation) record.limitations.push(ocrLimitation);
      const transcriptLimitation = transcriptRuntimeLimitation(record.transcript, {
        frameSource,
        hasMediaInput: Boolean(processingInput),
      });
      if (transcriptLimitation) record.limitations.push(transcriptLimitation);
    } finally {
      // Source media is a transient local processing input. Retain only
      // derived frame, OCR, vision, and transcript evidence in the job artifact.
      if (localMedia.localPath) await fs.rm(localMedia.localPath, { force: true }).catch(() => {});
      if (runtimeRecordingPath) await fs.rm(runtimeRecordingPath, { force: true }).catch(() => {});
      for (const mediaPath of externalCleanupPaths) {
        if (mediaPath && mediaPath !== localMedia.localPath) await fs.rm(mediaPath, { force: true }).catch(() => {});
      }
    }
    videos.push(decorateVideoRecordState(record));
  }

  const coverage = videoCoverage(eligibleVideoSampleCount, videos, {
    observedVideoSampleCount: candidateSummary.observedVideoSampleCount,
  });
  return {
    ...base,
    status: analysisStatus(coverage),
    coverage,
    videos,
    limitations: analysisLimitations(coverage, videos, videoConfig),
  };
}

export async function collectVideoEvidence({
  capture,
  platform,
  artifactDirectory,
  artifactRootDirectory,
  relayPort,
  videoConfig,
  runWithRelayLock = (task) => task(),
  resume = false,
  onProgress = null,
  processingResources: sharedProcessingResources = null,
}) {
  const candidateSummary = videoCandidateSummary(capture, platform);
  const selected = selectVideoSamples(capture, platform, videoConfig?.maxVideosPerCreator);
  const eligibleVideoSampleCount = candidateSummary.eligibleVideoSampleCount;
  const processingConcurrency = boundedVideoProcessingConcurrency(videoConfig?.concurrency);
  const processingResources = sharedProcessingResources || createVideoProcessingResources(processingConcurrency);
  const resourceLimits = {
    ocr: Math.max(1, Math.min(4, Number(processingResources?.limits?.ocr) || processingConcurrency)),
    transcript: Math.max(1, Math.min(2, Number(processingResources?.limits?.transcript) || processingConcurrency)),
    vision: Math.max(1, Math.min(2, Number(processingResources?.limits?.vision) || processingConcurrency)),
  };
  // Keep a small bounded look-ahead window so serial page observation can
  // continue while completed pages are handled by local OCR, ASR, and vision.
  const observationQueueCapacity = Math.max(2, Math.min(12, processingConcurrency * 3));
  const configFingerprint = videoCheckpointConfigFingerprint(videoConfig);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: 'not_applicable',
    sourceFingerprint: videoFingerprint(platform, selected),
    processor: {
      renderedMedia: 'browser_relay',
      browserObservationConcurrency: 1,
      localProcessingConcurrency: processingConcurrency,
      observationQueueCapacity,
      screenTextConcurrency: resourceLimits.ocr,
      audioTranscriptConcurrency: resourceLimits.transcript,
      visualSemanticsConcurrency: resourceLimits.vision,
      visualFrames: 'ffmpeg_or_browser_rendered',
      frameSampling: 'uniform_timeline_anchors',
      screenText: 'rapidocr_onnxruntime',
      audioTranscript: transcriptProcessor(videoConfig),
      localMediaCache: videoConfig?.localMediaCache?.enabled === false ? 'disabled' : 'transient_local_copy',
      visualSemantics: videoConfig?.vision?.model ? 'ollama' : 'not_configured',
      externalToolchain: Object.values(videoConfig?.toolchain || {}).some((adapter) => adapter?.enabled)
        ? 'configured_optional_adapters'
        : 'not_configured',
    },
    coverage: videoCoverage(eligibleVideoSampleCount, [], {
      observedVideoSampleCount: candidateSummary.observedVideoSampleCount,
    }),
    videos: [],
    limitations: [],
  };
  if (!videoConfig?.enabled) {
    return { ...base, status: 'disabled', limitations: ['Video analysis is disabled by local configuration.'] };
  }
  if (!selected.length) {
    return { ...base, limitations: analysisLimitations(base.coverage, [], videoConfig) };
  }

  const checkpointedBySampleIndex = new Map();
  const pendingSamples = [];
  if (resume) {
    for (const selectedSample of selected) {
      const sampleDirectory = path.join(
        artifactDirectory,
        'video',
        'sample-' + String(selectedSample.sampleIndex).padStart(2, '0'),
      );
      const checkpoint = await readVideoCheckpoint(
        sampleDirectory,
        platform,
        selectedSample,
        configFingerprint,
      );
      if (checkpoint) checkpointedBySampleIndex.set(selectedSample.sampleIndex, checkpoint);
      else pendingSamples.push(selectedSample);
    }
  } else {
    pendingSamples.push(...selected);
  }

  let completed = checkpointedBySampleIndex.size;
  let observed = checkpointedBySampleIndex.size;
  let transcribed = [...checkpointedBySampleIndex.values()]
    .filter((record) => record?.transcript?.status === 'completed').length;
  let active = 0;
  const reportProgress = async (record, resumed) => {
    if (typeof onProgress !== 'function') return;
    try {
      await Promise.resolve(onProgress({
        completed,
        total: selected.length,
        sampleIndex: positiveInteger(record?.sampleIndex),
        status: text(record?.status, 80) || 'processing',
        resumed: Boolean(resumed),
        concurrency: processingConcurrency,
        observed,
        active,
        pending: Math.max(0, selected.length - completed - active),
        transcribed,
        eligibleVideoSampleCount,
        observedVideoSampleCount: candidateSummary.observedVideoSampleCount,
        duplicateVisibleVideoReferenceCount: candidateSummary.duplicateVisibleReferenceCount,
        observationQueueCapacity,
        percent: selected.length ? Math.round((completed / selected.length) * 100) : 100,
      }));
    } catch {
      // Job progress reporting must not interrupt the independently checkpointed pipeline.
    }
  };
  if (completed) {
    await reportProgress({
      sampleIndex: null,
      status: 'checkpoint_reused',
    }, true);
  }

  // Page observation stays serial for the attached browser session. Once a
  // page has exposed its media element, local work proceeds independently so
  // the next observation does not wait for Whisper, OCR, or a vision model.
  const observationQueue = createAsyncQueue(observationQueueCapacity);
  const processedRecords = [];
  const observePendingSamples = async () => {
    try {
      for (const selectedSample of pendingSamples) {
        let observation;
        try {
          observation = await observeVideoSample({
            selectedSample,
            platform,
            artifactDirectory,
            artifactRootDirectory,
            relayPort,
            videoConfig,
            runWithRelayLock,
          });
        } catch {
          observation = {
            sampleDirectory: path.join(
              artifactDirectory,
              'video',
              'sample-' + String(selectedSample.sampleIndex).padStart(2, '0'),
            ),
            relay: { status: 'relay_error', observationArtifactPath: '' },
          };
        }
        await observationQueue.push({ selectedSample, observation });
        observed += 1;
        await reportProgress({
          sampleIndex: selectedSample.sampleIndex,
          status: 'observed',
        }, false);
      }
    } finally {
      observationQueue.close();
    }
  };
  const processObservedSamples = async () => {
    while (true) {
      const queued = await observationQueue.take();
      if (!queued) return;
      active += 1;
      await reportProgress({
        sampleIndex: queued.selectedSample.sampleIndex,
        status: 'local_processing',
      }, false);
      let processed;
      try {
        processed = await processVideoSample({
          selectedSample: queued.selectedSample,
          platform,
          artifactDirectory,
          artifactRootDirectory,
          relayPort,
          videoConfig,
          runWithRelayLock,
          processingResources,
          observation: queued.observation,
        });
      } catch {
        const record = initialVideoRecord(queued.selectedSample, {
          ...videoConfig,
          artifactRootDirectory,
        });
        record.status = 'processing_failed';
        record.limitations.push('Video evidence processing stopped before all local steps completed.');
        processed = {
          record,
          sampleDirectory: queued.observation?.sampleDirectory || path.join(
            artifactDirectory,
            'video',
            'sample-' + String(queued.selectedSample.sampleIndex).padStart(2, '0'),
          ),
        };
      }
      decorateVideoRecordState(processed.record);
      try {
        await writeVideoCheckpoint(
          processed.sampleDirectory,
          platform,
          configFingerprint,
          processed.record,
        );
      } catch {
        processed.record.limitations.push('The per-video resume checkpoint could not be saved for this sample.');
        decorateVideoRecordState(processed.record);
      }
      active -= 1;
      completed += 1;
      if (processed.record.transcript?.status === 'completed') transcribed += 1;
      await reportProgress(processed.record, false);
      processedRecords.push(processed.record);
    }
  };
  await Promise.all([
    observePendingSamples(),
    ...Array.from({ length: Math.min(processingConcurrency, pendingSamples.length) }, () => processObservedSamples()),
  ]);
  const recordsBySampleIndex = new Map(checkpointedBySampleIndex);
  for (const record of processedRecords) {
    if (record) recordsBySampleIndex.set(record.sampleIndex, record);
  }
  const videos = selected
    .map((selectedSample) => recordsBySampleIndex.get(selectedSample.sampleIndex))
    .filter(Boolean);
  const coverage = videoCoverage(eligibleVideoSampleCount, videos, {
    checkpointReusedSampleCount: checkpointedBySampleIndex.size,
    observedVideoSampleCount: candidateSummary.observedVideoSampleCount,
  });
  return {
    ...base,
    status: analysisStatus(coverage),
    coverage,
    videos,
    limitations: analysisLimitations(coverage, videos, videoConfig),
  };
}
