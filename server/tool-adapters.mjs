import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';

const MAX_COMMAND_OUTPUT = 512 * 1024;
const MAX_TEXT = 6_000;
const MAX_SEGMENTS = 120;
const MAX_SUMMARY_POINTS = 12;
const MAX_DISCOVERED_FILES = 24;

const MEDIA_HOST_SUFFIXES = {
  douyin: ['douyin.com', 'douyinvod.com', 'zjcdn.com', 'bytecdn.cn', 'byteimg.com', 'bytedance.com', 'volces.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com', 'xhscdn.net', 'xhslink.com'],
  bilibili: ['bilibili.com', 'bilivideo.com', 'biliapi.net', 'biliimg.com'],
};

function text(value, maximum = 360) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function number(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function sourceUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return '';
    return `https://${parsed.host}${parsed.pathname || '/'}`;
  } catch {
    return '';
  }
}

function mediaUrl(value, platform) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    const allowed = (MEDIA_HOST_SUFFIXES[platform] || []).some((suffix) => (
      host === suffix || host.endsWith(`.${suffix}`)
    ));
    if (!allowed) return '';
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

function unique(values, maximum = 24) {
  return [...new Set(values.map((value) => text(value, 640)).filter(Boolean))].slice(0, maximum);
}

function pathValue(value, candidates) {
  for (const candidate of candidates) {
    let current = value;
    for (const key of candidate.split('.')) current = current?.[key];
    if (typeof current === 'string' && current.trim()) return current.trim();
  }
  return '';
}

function firstObject(value, candidates) {
  for (const candidate of candidates) {
    let current = value;
    for (const key of candidate.split('.')) current = current?.[key];
    if (current && typeof current === 'object') return current;
  }
  return null;
}

function safeArtifactPath(rootDirectory, candidate) {
  if (!candidate || !rootDirectory) return '';
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return resolved;
}

function relativeArtifactPath(rootDirectory, filePath) {
  if (!rootDirectory || !filePath) return '';
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : '';
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function commandResult(command, args, { cwd, timeoutMs, onLine, env: adapterEnv } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const runtimeEnv = Object.fromEntries(
        Object.entries(adapterEnv || {}).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'),
      );
      const inheritedEnv = { ...process.env };
      // The 302 credential is intentionally opt-in per adapter process. A key
      // supplied to the server environment must not be inherited by download,
      // OCR, or generic-summary helpers.
      if (!Object.hasOwn(runtimeEnv, 'KOLFORGE_302_VIDEO_SUMMARY_API_KEY')) {
        delete inheritedEnv.KOLFORGE_302_VIDEO_SUMMARY_API_KEY;
      }
      child = spawn(command, args, {
        cwd,
        env: { ...inheritedEnv, ...runtimeEnv },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
    const consume = (chunk, stream) => {
      if (stream === 'stdout') stdout = append(stdout, chunk);
      else stderr = append(stderr, chunk);
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const compact = text(line, 320);
        if (compact) onLine?.(compact, stream);
      }
    };
    child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1_000, Number(timeoutMs) || 60_000));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, timedOut, stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout) {
  const compact = String(stdout || '').trim();
  if (!compact) return null;
  try {
    return JSON.parse(compact);
  } catch {
    // bilicli emits its JSON on stdout, but dependencies can add diagnostic
    // lines around it. Accept one complete JSON line as a compatibility path.
  }
  for (const line of compact.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep searching upward for the final parseable item.
    }
  }
  return null;
}

function normalizedSegment(segment, index) {
  const item = segment && typeof segment === 'object' ? segment : {};
  const rawText = typeof segment === 'string' ? segment : pathValue(item, ['text', 'content', 'sentence', 'value']);
  const segmentText = text(rawText, 480);
  if (!segmentText) return null;
  const start = number(item.startSeconds ?? item.start ?? item.start_time ?? item.begin, 86_400);
  const end = number(item.endSeconds ?? item.end ?? item.end_time ?? item.finish, 86_400);
  return {
    index: number(item.index, 10_000) ?? index + 1,
    startSeconds: start,
    endSeconds: end,
    text: segmentText,
  };
}

export function normalizeExternalTranscript(value) {
  if (typeof value === 'string') {
    const transcriptText = text(value, MAX_TEXT);
    return transcriptText ? { text: transcriptText, segments: [] } : { text: '', segments: [] };
  }
  const payload = value && typeof value === 'object' ? value : {};
  const rawSegments = Array.isArray(payload.segments)
    ? payload.segments
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.sentences)
        ? payload.sentences
        : Array.isArray(payload.result?.segments)
          ? payload.result.segments
          : [];
  const segments = rawSegments.map(normalizedSegment).filter(Boolean).slice(0, MAX_SEGMENTS);
  const transcriptText = text(
    pathValue(payload, ['text', 'transcript', 'content', 'result.text', 'data.text'])
      || segments.map((segment) => segment.text).join(' '),
    MAX_TEXT,
  );
  return { text: transcriptText, segments };
}

function parseSrt(raw) {
  const segments = [];
  const blocks = String(raw || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timestampLine = lines.find((line) => line.includes('-->'));
    const transcriptLines = timestampLine ? lines.slice(lines.indexOf(timestampLine) + 1) : lines;
    const transcriptText = text(transcriptLines.join(' '), 480);
    if (!transcriptText) continue;
    const parts = timestampLine ? timestampLine.split('-->').map((part) => part.trim()) : [];
    const toSeconds = (value) => {
      const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
      if (!match) return null;
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
    };
    segments.push({
      index: segments.length + 1,
      startSeconds: toSeconds(parts[0]),
      endSeconds: toSeconds(parts[1]),
      text: transcriptText,
    });
    if (segments.length >= MAX_SEGMENTS) break;
  }
  return {
    text: text(segments.map((segment) => segment.text).join(' '), MAX_TEXT),
    segments,
  };
}

async function filesWithExtensions(rootDirectory, extensions, maximum = MAX_DISCOVERED_FILES) {
  const found = [];
  const visit = async (directory, depth) => {
    if (depth > 3 || found.length >= maximum) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maximum) return;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, depth + 1);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        found.push(filePath);
      }
    }
  };
  await visit(rootDirectory, 0);
  return found;
}

function compactProviderResult(provider, status, extra = {}) {
  return {
    provider,
    status,
    ...extra,
  };
}

async function runVideoBatchDownload({ adapter, source, directory, artifactRootDirectory, emit }) {
  const provider = 'video_batch_download';
  const root = path.resolve(directory, provider);
  const outputDirectory = path.join(root, 'output');
  const inputFile = path.join(root, 'urls.txt');
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(inputFile, `${source}\n`, 'utf8');
  let result;
  try {
    emit?.(`启动 ${provider} 下载与转写。`);
    result = await commandResult(adapter.command, [
      ...adapter.args,
      '--input', inputFile,
      '--output', outputDirectory,
    ], {
      cwd: adapter.cwd,
      timeoutMs: adapter.timeoutMs,
      env: adapter.env,
      onLine: (line, stream) => emit?.(`${provider}/${stream}: ${line}`),
    });
  } catch (error) {
    return compactProviderResult(provider, 'tooling_unavailable', { detail: text(error.message, 320) });
  }
  if (result.timedOut) return compactProviderResult(provider, 'timed_out');
  if (result.code !== 0) return compactProviderResult(provider, 'failed', { detail: text(result.stderr || result.stdout, 320) });
  const summaryPath = path.join(outputDirectory, 'download-summary.json');
  const summary = await readJson(summaryPath);
  const firstResult = Array.isArray(summary?.results) ? summary.results.find((item) => item && typeof item === 'object') : null;
  const metadataReference = pathValue(firstResult, ['jsonPath', 'json_path', 'metadataPath', 'metadata_path']);
  const metadataPath = safeArtifactPath(outputDirectory, metadataReference);
  const metadata = metadataPath && await fileExists(metadataPath) ? await readJson(metadataPath) : firstResult;
  if (!metadata || typeof metadata !== 'object') {
    return compactProviderResult(provider, 'output_missing', {
      artifactPath: relativeArtifactPath(artifactRootDirectory, summaryPath),
    });
  }
  const mediaReference = pathValue(metadata, ['video_file', 'videoFile', 'media.file', 'media_info.video_file'])
    || pathValue(firstResult, ['video_file', 'videoFile']);
  const mediaPath = safeArtifactPath(outputDirectory, mediaReference);
  const transcript = normalizeExternalTranscript(
    firstObject(metadata, ['transcript', 'asr', 'subtitle', 'subtitles']) || pathValue(metadata, ['transcript', 'text']),
  );
  if (!transcript.text) {
    const textFiles = await filesWithExtensions(outputDirectory, ['.txt'], 8);
    const transcriptFile = textFiles.find((filePath) => /transcript|subtitle|asr/i.test(path.basename(filePath))) || textFiles[0];
    if (transcriptFile) {
      const raw = await fs.readFile(transcriptFile, 'utf8').catch(() => '');
      const parsed = normalizeExternalTranscript(raw);
      transcript.text = parsed.text;
      transcript.segments = parsed.segments;
    }
  }
  return compactProviderResult(provider, 'completed', {
    artifactPath: relativeArtifactPath(artifactRootDirectory, summaryPath),
    mediaPath: mediaPath && await fileExists(mediaPath) ? mediaPath : '',
    transcript: transcript.text ? {
      status: 'completed',
      provider,
      ...transcript,
      artifactPath: relativeArtifactPath(artifactRootDirectory, metadataPath || summaryPath),
    } : null,
  });
}

function bilicliTranscript(payload) {
  const candidates = [
    firstObject(payload, ['asr', 'transcript', 'subtitle', 'subtitles', 'analysis.transcript']),
    pathValue(payload, ['asr_text', 'transcript_text', 'subtitle_text']),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const transcript = normalizeExternalTranscript(candidate);
    if (transcript.text) return transcript;
  }
  return { text: '', segments: [] };
}

function bilicliSignals(payload) {
  const comments = firstObject(payload, ['comments', 'comment_summary', 'analysis.comments']);
  const danmaku = firstObject(payload, ['danmaku', 'danmakus', 'analysis.danmaku']);
  const ocr = firstObject(payload, ['ocr', 'screen_text', 'analysis.ocr']);
  return {
    comments: text(typeof comments === 'string' ? comments : comments?.summary || comments?.text, 1_200),
    danmaku: text(typeof danmaku === 'string' ? danmaku : danmaku?.summary || danmaku?.text, 1_200),
    ocr: text(typeof ocr === 'string' ? ocr : ocr?.text || ocr?.summary, 1_200),
    degraded: unique(Array.isArray(payload?.degraded) ? payload.degraded : [payload?.degraded], 12),
  };
}

async function runBilicli({ adapter, source, directory, artifactRootDirectory, emit }) {
  const provider = 'bilicli';
  const root = path.resolve(directory, provider);
  await fs.mkdir(root, { recursive: true });
  let result;
  try {
    emit?.('启动 bilicli B站内容增强。');
    result = await commandResult(adapter.command, [
      ...adapter.args,
      '--json', 'analyze', source,
      '--output', root,
    ], {
      cwd: adapter.cwd,
      timeoutMs: adapter.timeoutMs,
      env: adapter.env,
      onLine: (line, stream) => emit?.(`${provider}/${stream}: ${line}`),
    });
  } catch (error) {
    return compactProviderResult(provider, 'tooling_unavailable', { detail: text(error.message, 320) });
  }
  if (result.timedOut) return compactProviderResult(provider, 'timed_out');
  if (result.code !== 0) return compactProviderResult(provider, 'failed', { detail: text(result.stderr || result.stdout, 320) });
  const payload = parseJsonOutput(result.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return compactProviderResult(provider, 'output_invalid');
  const transcript = bilicliTranscript(payload);
  const signals = bilicliSignals(payload);
  const normalizedPath = path.join(root, 'bilicli.normalized.json');
  await writeJson(normalizedPath, { provider, transcript, signals });
  return compactProviderResult(provider, 'completed', {
    artifactPath: relativeArtifactPath(artifactRootDirectory, normalizedPath),
    transcript: transcript.text ? {
      status: 'completed',
      provider,
      ...transcript,
      artifactPath: relativeArtifactPath(artifactRootDirectory, normalizedPath),
    } : null,
    signals,
  });
}

async function runVideoCopyAnalyzer({ adapter, mediaPath, directory, artifactRootDirectory, emit }) {
  const provider = 'video_copy_analyzer';
  const localMediaPath = mediaPath ? path.resolve(mediaPath) : '';
  if (!localMediaPath || !(await fileExists(localMediaPath))) return compactProviderResult(provider, 'local_media_unavailable');
  const root = path.resolve(directory, provider);
  await fs.mkdir(root, { recursive: true });
  let result;
  try {
    emit?.('启动 video-copy-analyzer 本地字幕增强。');
    result = await commandResult(adapter.command, [...adapter.args, localMediaPath, root], {
      cwd: adapter.cwd,
      timeoutMs: adapter.timeoutMs,
      env: adapter.env,
      onLine: (line, stream) => emit?.(`${provider}/${stream}: ${line}`),
    });
  } catch (error) {
    return compactProviderResult(provider, 'tooling_unavailable', { detail: text(error.message, 320) });
  }
  if (result.timedOut) return compactProviderResult(provider, 'timed_out');
  if (result.code !== 0) return compactProviderResult(provider, 'failed', { detail: text(result.stderr || result.stdout, 320) });
  const srtFiles = await filesWithExtensions(root, ['.srt'], 8);
  const textFiles = await filesWithExtensions(root, ['.txt', '.md'], 12);
  const subtitleFile = srtFiles[0];
  let transcript = { text: '', segments: [] };
  let transcriptFile = subtitleFile || textFiles.find((filePath) => /transcript|subtitle|asr/i.test(path.basename(filePath))) || textFiles[0];
  if (subtitleFile) transcript = parseSrt(await fs.readFile(subtitleFile, 'utf8').catch(() => ''));
  if (!transcript.text && transcriptFile) transcript = normalizeExternalTranscript(await fs.readFile(transcriptFile, 'utf8').catch(() => ''));
  const normalizedPath = path.join(root, 'video-copy-analyzer.normalized.json');
  await writeJson(normalizedPath, { provider, transcript, transcriptFile: transcriptFile ? path.basename(transcriptFile) : null });
  return compactProviderResult(provider, transcript.text ? 'completed' : 'transcript_empty', {
    artifactPath: relativeArtifactPath(artifactRootDirectory, normalizedPath),
    transcript: transcript.text ? {
      status: 'completed',
      provider,
      ...transcript,
      artifactPath: relativeArtifactPath(artifactRootDirectory, transcriptFile || normalizedPath),
    } : null,
  });
}

function normalizedMindmap(value, depth = 0, state = { count: 0 }) {
  if (depth > 4 || state.count >= 48) return null;
  if (typeof value === 'string') {
    const label = text(value, 180);
    if (!label) return null;
    state.count += 1;
    return { label, children: [] };
  }
  if (!value || typeof value !== 'object') return null;
  const label = text(value.label ?? value.name ?? value.title ?? value.topic, 180);
  const rawChildren = Array.isArray(value.children) ? value.children : Array.isArray(value.nodes) ? value.nodes : [];
  const children = rawChildren.map((item) => normalizedMindmap(item, depth + 1, state)).filter(Boolean).slice(0, 12);
  if (!label && !children.length) return null;
  if (label) state.count += 1;
  return { label: label || 'untitled', children };
}

export function normalizeExternalSummary(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const rawPoints = Array.isArray(payload.keypoints)
    ? payload.keypoints
    : Array.isArray(payload.highlights)
      ? payload.highlights
      : Array.isArray(payload.points)
        ? payload.points
        : [];
  return {
    summary: text(payload.summary ?? payload.content ?? payload.overview, 1_800),
    keypoints: unique(rawPoints.map((item) => (typeof item === 'string' ? item : item?.text ?? item?.label ?? item?.content)), MAX_SUMMARY_POINTS),
    mindmap: normalizedMindmap(payload.mindmap ?? payload.mindMap ?? payload.outline ?? payload.tree),
  };
}

async function runSummaryBridge({ provider = 'video_summary_bridge', adapter, source, transcript, ocrText, directory, artifactRootDirectory, emit }) {
  const root = path.resolve(directory, provider);
  const inputPath = path.join(root, 'input.json');
  const outputPath = path.join(root, 'output.json');
  const input = {
    sourceUrl: source,
    transcript: transcript?.text || '',
    transcriptSegments: Array.isArray(transcript?.segments) ? transcript.segments : [],
    ocrText: text(ocrText, 4_800),
  };
  await writeJson(inputPath, input);
  let result;
  try {
    emit?.(`Starting ${provider} summary bridge.`);
    result = await commandResult(adapter.command, [
      ...adapter.args,
      '--input', inputPath,
      '--output', outputPath,
    ], {
      cwd: adapter.cwd,
      timeoutMs: adapter.timeoutMs,
      env: adapter.env,
      onLine: (line, stream) => emit?.(`${provider}/${stream}: ${line}`),
    });
  } catch (error) {
    return compactProviderResult(provider, 'tooling_unavailable', { detail: text(error.message, 320) });
  }
  if (result.timedOut) return compactProviderResult(provider, 'timed_out');
  if (result.code !== 0) return compactProviderResult(provider, 'failed', { detail: text(result.stderr || result.stdout, 320) });
  const payload = await readJson(outputPath) || parseJsonOutput(result.stdout);
  const summary = normalizeExternalSummary(payload);
  const providerTranscript = normalizeExternalTranscript(payload?.transcript);
  if (!summary.summary && !summary.keypoints.length && !summary.mindmap) return compactProviderResult(provider, 'output_invalid');
  await writeJson(outputPath, {
    provider,
    ...summary,
    ...(providerTranscript.text ? { transcript: providerTranscript } : {}),
  });
  return compactProviderResult(provider, 'completed', {
    artifactPath: relativeArtifactPath(artifactRootDirectory, outputPath),
    summary: { ...summary, provider },
    transcript: providerTranscript.text ? {
      status: 'completed',
      provider,
      ...providerTranscript,
      artifactPath: relativeArtifactPath(artifactRootDirectory, outputPath),
    } : null,
  });
}

function configuredAdapter(adapter) {
  return Boolean(adapter?.enabled && text(adapter.command, 2_000));
}

function adapterHealth(key, adapter, { platform = '' } = {}) {
  if (adapter?.command && Array.isArray(adapter?.missingConfiguration) && adapter.missingConfiguration.length) {
    return { id: key, status: 'credentials_missing', missing: adapter.missingConfiguration };
  }
  if (!configuredAdapter(adapter)) return { id: key, status: 'not_configured' };
  if (key === 'bilicli' && platform && platform !== 'bilibili') return { id: key, status: 'not_applicable' };
  return { id: key, status: 'configured' };
}

export function getToolchainHealth(toolchain = config.analysis.video.toolchain) {
  return {
    videoBatchDownload: adapterHealth('video_batch_download', toolchain?.videoBatchDownload),
    bilicli: adapterHealth('bilicli', toolchain?.bilicli),
    videoCopyAnalyzer: adapterHealth('video_copy_analyzer', toolchain?.videoCopyAnalyzer),
    videoSummary302: adapterHealth('302_video_summary', toolchain?.videoSummary302),
    videoSummary: adapterHealth('video_summary_bridge', toolchain?.videoSummary),
  };
}

export async function acquireExternalVideoEvidence({
  platform,
  sourceUrl: rawSourceUrl,
  mediaUrl: rawMediaUrl,
  videoDirectory,
  artifactRootDirectory,
  toolchain = config.analysis.video.toolchain,
  includeVideoBatchDownload = true,
  emit,
}) {
  const source = sourceUrl(rawSourceUrl);
  const preferredMedia = mediaUrl(rawMediaUrl, platform);
  const providers = [];
  let mediaPath = '';
  let transcript = null;
  if (!source) return { providers, mediaPath, transcript, cleanupPaths: [] };
  if (includeVideoBatchDownload && configuredAdapter(toolchain?.videoBatchDownload)) {
    const result = await runVideoBatchDownload({
      adapter: toolchain.videoBatchDownload,
      source: preferredMedia || source,
      directory: videoDirectory,
      artifactRootDirectory,
      emit,
    });
    providers.push(result);
    mediaPath = result.mediaPath || '';
    transcript = result.transcript || null;
  }
  if (platform === 'bilibili' && configuredAdapter(toolchain?.bilicli)) {
    const result = await runBilicli({
      adapter: toolchain.bilicli,
      source,
      directory: videoDirectory,
      artifactRootDirectory,
      emit,
    });
    providers.push(result);
    if (!transcript && result.transcript) transcript = result.transcript;
  }
  return {
    providers,
    mediaPath,
    transcript,
    cleanupPaths: mediaPath ? [mediaPath] : [],
  };
}

export async function enrichExternalVideoEvidence({
  sourceUrl: rawSourceUrl,
  mediaPath,
  transcript,
  ocrText,
  videoDirectory,
  artifactRootDirectory,
  toolchain = config.analysis.video.toolchain,
  emit,
}) {
  const source = sourceUrl(rawSourceUrl);
  const providers = [];
  let enrichedTranscript = null;
  let summary = null;
  if (configuredAdapter(toolchain?.videoCopyAnalyzer) && mediaPath && (!transcript?.text || !transcript?.segments?.length)) {
    const result = await runVideoCopyAnalyzer({
      adapter: toolchain.videoCopyAnalyzer,
      mediaPath,
      directory: videoDirectory,
      artifactRootDirectory,
      emit,
    });
    providers.push(result);
    enrichedTranscript = result.transcript || null;
  }
  const usableTranscript = transcript?.text ? transcript : enrichedTranscript;
  if (configuredAdapter(toolchain?.videoSummary302) && source) {
    const result = await runSummaryBridge({
      provider: '302_video_summary',
      adapter: toolchain.videoSummary302,
      source,
      transcript: usableTranscript,
      ocrText,
      directory: videoDirectory,
      artifactRootDirectory,
      emit,
    });
    providers.push(result);
    summary = result.summary || null;
    if (!enrichedTranscript && result.transcript) enrichedTranscript = result.transcript;
  }
  const summaryTranscript = transcript?.text ? transcript : enrichedTranscript;
  if (!summary && configuredAdapter(toolchain?.videoSummary) && source && (summaryTranscript?.text || ocrText)) {
    const result = await runSummaryBridge({
      adapter: toolchain.videoSummary,
      source,
      transcript: summaryTranscript,
      ocrText,
      directory: videoDirectory,
      artifactRootDirectory,
      emit,
    });
    providers.push(result);
    summary = result.summary || null;
  }
  return { providers, transcript: enrichedTranscript, summary };
}
