/**
 * Read public, rendered video metadata through the attached Browser Relay.
 *
 * The persisted artifact deliberately excludes signed media query strings.
 * A runtime media URL is returned only in the one JSON object written to
 * stdout, so the caller can consume it in memory for the current job.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REQUIRE = createRequire(import.meta.url);

const LOGIN_MARKERS = [
  '\u767b\u5f55\u540e\u67e5\u770b',
  '\u624b\u673a\u53f7\u767b\u5f55',
  '\u8bf7\u767b\u5f55',
  '\u767b\u5f55\u5373\u53ef',
  '\u767b\u5f55\u67e5\u770b\u66f4\u591a',
];
const VERIFICATION_MARKERS = [
  '\u4eba\u673a\u9a8c\u8bc1',
  '\u5b89\u5168\u9a8c\u8bc1',
  '\u8bf7\u5b8c\u6210\u9a8c\u8bc1',
  '\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41',
  '\u5f02\u5e38\u8bbf\u95ee',
];
const PLATFORM_DOMAINS = Object.freeze({
  douyin: 'douyin.com',
  xiaohongshu: 'xiaohongshu.com',
  bilibili: 'bilibili.com',
});

const EXIT_SUCCESS = 0;
const EXIT_LOGIN_REQUIRED = 2;
const EXIT_VERIFICATION_REQUIRED = 3;
const EXIT_MEDIA_NOT_RENDERED = 4;
const EXIT_INVALID_INPUT = 5;
const EXIT_RELAY_ERROR = 6;
const MAX_VIDEO_DURATION_SECONDS = 86_400;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isRelayPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function stringPort(value) {
  return /^\d{1,5}$/.test(String(value || '')) ? Number(value) : null;
}

export function isPlatformUrl(platform, value) {
  const domain = PLATFORM_DOMAINS[platform];
  if (!domain || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && Boolean(host) && (host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function scrubHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || !parsed.hostname) return '';
    const host = parsed.hostname.toLowerCase();
    const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `https://${hostPart}${port}${parsed.pathname || '/'}`;
  } catch {
    return '';
  }
}

function finiteNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
}

function nonNegativeInt(value, maximum = 20_000) {
  const number = finiteNumber(value, maximum);
  return number !== null && number > 0 ? Math.trunc(number) : null;
}

export function accessState(pageUrl, visibleText) {
  const url = typeof pageUrl === 'string' ? pageUrl.toLowerCase() : '';
  const content = typeof visibleText === 'string' ? visibleText.toLowerCase() : '';
  if (['/captcha', '/security/verify', '/website-login/captcha'].some((marker) => url.includes(marker))) {
    return 'verification_required';
  }
  if (VERIFICATION_MARKERS.some((marker) => content.includes(marker.toLowerCase()))) return 'verification_required';
  if (LOGIN_MARKERS.some((marker) => content.includes(marker.toLowerCase()))) return 'login_required';
  return '';
}

function candidateRuntimeUrls(candidate) {
  const values = [candidate?.currentSrc, candidate?.src];
  if (Array.isArray(candidate?.sourceUrls)) values.push(...candidate.sourceUrls);
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    const runtimeUrl = text(value);
    if (!runtimeUrl || !scrubHttpsUrl(runtimeUrl) || seen.has(runtimeUrl)) continue;
    seen.add(runtimeUrl);
    urls.push(runtimeUrl);
  }
  return urls;
}

export function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.visible) return null;
  const runtimeMediaUrl = candidateRuntimeUrls(candidate)[0];
  if (!runtimeMediaUrl) return null;
  return {
    elementIndex: Number.isInteger(candidate.elementIndex) && candidate.elementIndex >= 0 ? candidate.elementIndex : null,
    runtimeMediaUrl,
    mediaUrl: scrubHttpsUrl(runtimeMediaUrl),
    posterUrl: scrubHttpsUrl(candidate.poster),
    durationSeconds: finiteNumber(candidate.duration, MAX_VIDEO_DURATION_SECONDS),
    dimensions: {
      width: nonNegativeInt(candidate.width),
      height: nonNegativeInt(candidate.height),
    },
    readyState: nonNegativeInt(candidate.readyState, 4),
    evidence: 'rendered_visible_video_element',
  };
}

export function selectMediaCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  const cleaned = candidates.map(cleanCandidate).filter(Boolean);
  if (!cleaned.length) return null;
  return cleaned.reduce((best, candidate) => {
    const score = (item) => [
      item.durationSeconds ? 1 : 0,
      item.dimensions.width && item.dimensions.height ? 1 : 0,
      item.readyState || 0,
    ];
    const bestScore = score(best);
    const candidateScore = score(candidate);
    for (let index = 0; index < bestScore.length; index += 1) {
      if (candidateScore[index] !== bestScore[index]) return candidateScore[index] > bestScore[index] ? candidate : best;
    }
    return best;
  });
}

function framePoints(durationSeconds, count) {
  const frameCount = Math.max(1, Math.min(Number(count) || 1, 4));
  if (!durationSeconds || durationSeconds <= 0) return [0];
  const fractions = frameCount === 2
    ? [0.18, 0.78]
    : frameCount === 3
      ? [0.14, 0.5, 0.86]
      : frameCount === 4
        ? [0.12, 0.38, 0.64, 0.9]
        : [0.5];
  return [...new Set(fractions.map((fraction) => Math.max(0, Math.min(durationSeconds - 0.08, durationSeconds * fraction))))];
}

function frameTimelineAnchor(index, count) {
  if (count <= 1) return 'midpoint';
  if (index === 0) return 'opening';
  if (index === count - 1) return 'closing';
  const position = index / (count - 1);
  return position < 0.34 ? 'early' : position <= 0.67 ? 'middle' : 'late';
}

function requestedFrameCount(value) {
  const count = finiteNumber(value, 4);
  return count === null ? 0 : Math.min(Math.trunc(count), 4);
}

function persistedBrowserFrames(capture) {
  const frames = Array.isArray(capture?.frames) ? capture.frames : [];
  return {
    status: text(capture?.status) || 'not_requested',
    frames: frames.slice(0, 4).map((frame, index) => ({
      index: Number.isInteger(frame?.index) && frame.index > 0 ? frame.index : index + 1,
      filename: text(frame?.filename),
      timeSeconds: finiteNumber(frame?.timeSeconds, MAX_VIDEO_DURATION_SECONDS),
      timelineAnchor: text(frame?.timelineAnchor),
      samplingReason: text(frame?.samplingReason),
    })).filter((frame) => frame.filename),
  };
}

export function artifactPayload(platform, contentUrl, status, observedAt, media = null, errorCode = '', browserFrames = null) {
  const payload = {
    schemaVersion: 1,
    platform,
    contentUrl: scrubHttpsUrl(contentUrl),
    status,
    observedAt,
  };
  if (errorCode) payload.errorCode = errorCode;
  if (media) {
    payload.media = {
      mediaUrl: media.mediaUrl,
      posterUrl: media.posterUrl,
      durationSeconds: media.durationSeconds,
      dimensions: media.dimensions,
      readyState: media.readyState,
      evidence: media.evidence,
    };
  }
  if (browserFrames) payload.browserFrames = persistedBrowserFrames(browserFrames);
  return payload;
}

export function stdoutPayload(status, outputFile, media = null, errorCode = '', recording = null) {
  const payload = { status, outputFile: String(outputFile || '') };
  if (errorCode) payload.errorCode = errorCode;
  if (media) {
    payload.runtimeMediaUrl = media.runtimeMediaUrl;
    payload.mediaUrl = media.mediaUrl;
    payload.durationSeconds = media.durationSeconds;
    payload.dimensions = media.dimensions;
  }
  if (recording?.status) payload.recordingStatus = recording.status;
  if (recording?.runtimeRecordingPath) payload.runtimeRecordingPath = recording.runtimeRecordingPath;
  return payload;
}

async function writeArtifact(outputFile, payload) {
  const target = path.resolve(outputFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(payload), 'utf8');
}

function tokenFromConfig(payload) {
  const value = payload?.gateway?.auth?.token;
  return typeof value === 'string' ? value.trim() : '';
}

async function getGatewayToken() {
  const environmentToken = text(process.env.OPENCLAW_GATEWAY_TOKEN);
  if (environmentToken) return environmentToken;

  const openclawDirectory = path.join(os.homedir(), '.openclaw');
  try {
    const payload = JSON.parse(await fs.readFile(path.join(openclawDirectory, 'openclaw.json'), 'utf8'));
    const configToken = tokenFromConfig(payload);
    if (configToken) return configToken;
  } catch {
    // Fall through to the generated gateway command file.
  }

  try {
    const command = await fs.readFile(path.join(openclawDirectory, 'gateway.cmd'), 'utf8');
    const match = command.match(/OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)/);
    const commandToken = text(match?.[1]);
    if (commandToken) return commandToken;
  } catch {
    // The token is intentionally never included in an error payload.
  }
  throw new Error('Browser Relay gateway token is unavailable.');
}

function relayHeaders(port, token) {
  const relayToken = createHmac('sha256', token)
    .update(`openclaw-extension-relay-v1:${port}`)
    .digest('hex');
  return { 'x-openclaw-relay-token': relayToken };
}

async function modulePaths(configuredPath) {
  const paths = [];
  const addResolved = (base) => {
    if (!base) return;
    try {
      const resolver = createRequire(path.join(base, 'relay-loader.cjs'));
      paths.push(resolver.resolve('playwright'));
    } catch {
      // Try a pnpm virtual-store root or another supported local module root.
    }
  };
  const addPnpmVirtualStorePaths = async (base) => {
    if (!base) return;
    let entries = [];
    try {
      entries = await fs.readdir(path.join(base, '.pnpm'), { withFileTypes: true });
    } catch {
      return;
    }
    const playwrightEntries = entries
      .filter((entry) => entry.isDirectory() && /^playwright@/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 4);
    for (const entry of playwrightEntries) {
      addResolved(path.join(base, '.pnpm', entry, 'node_modules'));
    }
  };
  try {
    paths.push(REQUIRE.resolve('playwright'));
  } catch {
    // The workspace does not have a Playwright package installed.
  }
  const supplied = text(configuredPath);
  if (!supplied) return paths;

  const target = path.resolve(supplied);
  addResolved(target);
  addResolved(path.dirname(target));
  await addPnpmVirtualStorePaths(target);
  await addPnpmVirtualStorePaths(path.dirname(target));
  if (/\.(?:cjs|mjs|js)$/i.test(target)) paths.push(target);
  return [...new Set(paths)];
}

async function loadPlaywright(configuredPath) {
  for (const modulePath of await modulePaths(configuredPath)) {
    try {
      const imported = await import(pathToFileURL(modulePath).href);
      const playwright = imported?.chromium ? imported : imported?.default;
      if (playwright?.chromium?.connectOverCDP) return playwright;
    } catch {
      // A configured optional module may not be a compatible Playwright build.
    }
  }
  throw new Error('Playwright module is unavailable.');
}

async function readRenderedVideos(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0;
    };
    return Array.from(document.querySelectorAll('video')).map((video, elementIndex) => ({
      elementIndex,
      visible: visible(video),
      currentSrc: video.currentSrc || '',
      src: video.src || '',
      sourceUrls: Array.from(video.querySelectorAll('source')).map((source) => source.src || '').filter(Boolean),
      poster: video.poster || '',
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: Number.isFinite(video.videoWidth) ? video.videoWidth : null,
      height: Number.isFinite(video.videoHeight) ? video.videoHeight : null,
      readyState: Number.isFinite(video.readyState) ? video.readyState : null,
    })).filter((candidate) => candidate.visible);
  });
}

async function nudgePageForMedia(page, attempt) {
  try {
    await page.evaluate(async ({ attemptNumber }) => {
      const videos = Array.from(document.querySelectorAll('video'));
      for (const video of videos) {
        try {
          video.muted = true;
          video.playsInline = true;
          const maybePromise = video.play?.();
          if (maybePromise?.catch) await maybePromise.catch(() => {});
        } catch {
          // User gesture or platform policy may block autoplay; a visible click is tried below.
        }
      }
      if (!videos.length && attemptNumber > 1) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.55), left: 0, behavior: 'instant' });
      } else if (attemptNumber > 2) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.18), left: 0, behavior: 'instant' });
      }
    }, { attemptNumber: attempt });
  } catch {
    // Best-effort only; the following read still determines the outcome.
  }

  if (attempt === 2 || attempt === 4) {
    try {
      const viewport = page.viewportSize?.();
      const x = Math.max(80, Math.round((viewport?.width || 1280) / 2));
      const y = Math.max(120, Math.round((viewport?.height || 720) / 2));
      await page.mouse.click(x, y, { delay: 20 });
    } catch {
      // Some relayed browser contexts may not expose mouse events reliably.
    }
  }
}

async function waitForRenderedMedia(page) {
  const attempts = [1_000, 1_500, 2_000, 2_500, 3_000, 4_000];
  let best = null;
  for (let index = 0; index < attempts.length; index += 1) {
    await nudgePageForMedia(page, index + 1);
    await page.waitForTimeout(attempts[index]);
    const media = selectMediaCandidate(await readRenderedVideos(page));
    if (media) return media;
    const candidates = await readRenderedVideos(page).catch(() => []);
    if (candidates.length && !best) best = selectMediaCandidate(candidates);
  }
  return best;
}

async function captureRenderedFrames(page, media, frameDirectory, count) {
  const frameCount = requestedFrameCount(count);
  const elementIndex = Number.isInteger(media?.elementIndex) ? media.elementIndex : -1;
  if (!frameDirectory || !frameCount || elementIndex < 0) return { status: 'not_requested', frames: [] };

  const points = framePoints(media.durationSeconds, frameCount);
  const video = page.locator('video').nth(elementIndex);
  const frames = [];
  try {
    await fs.mkdir(frameDirectory, { recursive: true });
    await video.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    for (let index = 0; index < points.length; index += 1) {
      const targetTime = points[index];
      await page.evaluate(async ({ selectedIndex, requestedTime }) => {
        const candidate = document.querySelectorAll('video')[selectedIndex];
        if (!candidate) return false;
        const duration = Number.isFinite(candidate.duration) ? candidate.duration : 0;
        if (!duration || requestedTime <= 0) return true;
        const target = Math.max(0, Math.min(duration - 0.08, requestedTime));
        if (Math.abs(candidate.currentTime - target) < 0.12) return true;
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            candidate.removeEventListener('seeked', onSeeked);
            resolve(value);
          };
          const onSeeked = () => finish(true);
          candidate.addEventListener('seeked', onSeeked, { once: true });
          try {
            candidate.currentTime = target;
          } catch {
            finish(false);
            return;
          }
          setTimeout(() => finish(false), 3_000);
        });
      }, { selectedIndex: elementIndex, requestedTime: targetTime }).catch(() => false);

      const filename = `browser-frame-${String(index + 1).padStart(2, '0')}.jpg`;
      const outputFile = path.join(frameDirectory, filename);
      try {
        await video.screenshot({ path: outputFile, type: 'jpeg', quality: 80, timeout: 10_000 });
      } catch {
        continue;
      }
      if (!(await fs.stat(outputFile).then((stat) => stat.isFile() && stat.size > 0).catch(() => false))) continue;
      frames.push({
        index: index + 1,
        filename,
        timeSeconds: Math.round(targetTime * 100) / 100,
        timelineAnchor: frameTimelineAnchor(index, points.length),
        samplingReason: 'browser_rendered_timeline_anchor',
      });
    }
  } catch {
    return { status: 'capture_failed', frames: [] };
  }
  return { status: frames.length ? 'completed' : 'capture_failed', frames };
}

async function readAccessState(page) {
  let visibleText = '';
  try {
    visibleText = (await page.locator('body').innerText({ timeout: 3_000 })).slice(0, 8_000);
  } catch {
    // An unavailable body does not imply an access wall.
  }
  return accessState(page.url(), visibleText);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const known = new Set(['--platform', '--content-url', '--relay-port', '--output-file', '--playwright-module-path', '--frame-directory', '--frame-count', '--recording-file']);
  for (const argument of argv) {
    if (argument.startsWith('--') && !known.has(argument)) throw new Error('Invalid argument.');
  }
  const platform = text(optionValue(argv, '--platform'));
  const contentUrl = text(optionValue(argv, '--content-url'));
  const outputFile = text(optionValue(argv, '--output-file'));
  const configuredModulePath = text(optionValue(argv, '--playwright-module-path'))
    || text(process.env.KOLFORGE_VIDEO_PLAYWRIGHT_MODULE_PATH);
  const frameDirectory = text(optionValue(argv, '--frame-directory'));
  const recordingFile = text(optionValue(argv, '--recording-file'));
  const frameCount = argv.includes('--frame-count') ? requestedFrameCount(optionValue(argv, '--frame-count')) : 0;
  const relayPort = argv.includes('--relay-port') ? stringPort(optionValue(argv, '--relay-port')) : 18_800;
  if (!platform || !contentUrl || !outputFile || !isRelayPort(relayPort)) throw new Error('Invalid required input.');
  return { platform, contentUrl, relayPort, outputFile, configuredModulePath, frameDirectory, recordingFile, frameCount, help: false };
}

function usage() {
  return [
    'Usage: node collect_video_media_relay.mjs --platform douyin|xiaohongshu|bilibili --content-url https://... --output-file result.json',
    '       [--relay-port 18800] [--playwright-module-path C:\\path\\to\\node_modules]',
    '       [--frame-directory C:\\path\\to\\derived-frames --frame-count 1..4] [--recording-file C:\\path\\to\\recording.webm]',
  ].join('\n');
}

async function complete(outputFile, artifact, runtime, exitCode) {
  try {
    await writeArtifact(outputFile, artifact);
  } catch {
    process.stdout.write(`${JSON.stringify(stdoutPayload('relay_error', outputFile, null, 'ARTIFACT_WRITE_FAILED'))}\n`);
    return EXIT_RELAY_ERROR;
  }
  process.stdout.write(`${JSON.stringify(runtime)}\n`);
  return exitCode;
}

function relayErrorCode(stage) {
  return {
    playwright_load: 'PLAYWRIGHT_UNAVAILABLE',
    relay_connect: 'RELAY_CONNECTION_FAILED',
    relay_context: 'RELAY_CONTEXT_UNAVAILABLE',
    page_open: 'PAGE_OPEN_FAILED',
    page_navigation: 'PAGE_NAVIGATION_FAILED',
    access_state: 'ACCESS_STATE_READ_FAILED',
    media_read: 'RENDERED_MEDIA_READ_FAILED',
  }[stage] || 'BROWSER_RELAY_ERROR';
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    const outputFile = optionValue(argv, '--output-file');
    if (!outputFile) {
      process.stdout.write(`${JSON.stringify(stdoutPayload('invalid_input', '', null, 'INVALID_ARGUMENTS'))}\n`);
      return EXIT_INVALID_INPUT;
    }
    const platform = text(optionValue(argv, '--platform'));
    const contentUrl = text(optionValue(argv, '--content-url'));
    return complete(
      outputFile,
      artifactPayload(platform, contentUrl, 'invalid_input', utcNow(), null, 'INVALID_ARGUMENTS'),
      stdoutPayload('invalid_input', outputFile, null, 'INVALID_ARGUMENTS'),
      EXIT_INVALID_INPUT,
    );
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_SUCCESS;
  }

  const observedAt = utcNow();
  if (!isPlatformUrl(args.platform, args.contentUrl)) {
    return complete(
      args.outputFile,
      artifactPayload(args.platform, args.contentUrl, 'invalid_input', observedAt, null, 'INVALID_PLATFORM_CONTENT_URL'),
      stdoutPayload('invalid_input', args.outputFile, null, 'INVALID_PLATFORM_CONTENT_URL'),
      EXIT_INVALID_INPUT,
    );
  }

  let browser = null;
  let page = null;
  let stage = 'playwright_load';
  try {
    const [playwright, gatewayToken] = await Promise.all([
      loadPlaywright(args.configuredModulePath),
      getGatewayToken(),
    ]);
    stage = 'relay_connect';
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${args.relayPort}`, {
      headers: relayHeaders(args.relayPort, gatewayToken),
      timeout: 20_000,
    });
    stage = 'relay_context';
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browser Relay has no reusable context.');
    stage = 'page_open';
    page = await context.newPage();
    await page.bringToFront();
    stage = 'page_navigation';
    await page.goto(args.contentUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    await page.bringToFront();
    await page.waitForTimeout(3_000);

    stage = 'access_state';
    const state = await readAccessState(page);
    if (state) {
      const exitCode = state === 'login_required' ? EXIT_LOGIN_REQUIRED : EXIT_VERIFICATION_REQUIRED;
      return complete(
        args.outputFile,
        artifactPayload(args.platform, args.contentUrl, state, observedAt, null, state.toUpperCase()),
        stdoutPayload(state, args.outputFile, null, state.toUpperCase()),
        exitCode,
      );
    }

    stage = 'media_read';
    const media = await waitForRenderedMedia(page);
    if (!media) {
      return complete(
        args.outputFile,
        artifactPayload(args.platform, args.contentUrl, 'media_not_rendered', observedAt, null, 'MEDIA_NOT_RENDERED'),
        stdoutPayload('media_not_rendered', args.outputFile, null, 'MEDIA_NOT_RENDERED'),
        EXIT_MEDIA_NOT_RENDERED,
      );
    }
    const browserFrames = await captureRenderedFrames(page, media, args.frameDirectory, args.frameCount);
    const recording = await captureRenderedRecording(page, media, args.recordingFile);
    return complete(
      args.outputFile,
      artifactPayload(args.platform, args.contentUrl, 'media_ready', observedAt, media, '', browserFrames),
      stdoutPayload('media_ready', args.outputFile, media, '', recording),
      EXIT_SUCCESS,
    );
  } catch {
    const errorCode = relayErrorCode(stage);
    return complete(
      args.outputFile,
      artifactPayload(args.platform, args.contentUrl, 'relay_error', observedAt, null, errorCode),
      stdoutPayload('relay_error', args.outputFile, null, errorCode),
      EXIT_RELAY_ERROR,
    );
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function captureRenderedRecording(page, media, recordingFile) {
  const elementIndex = Number.isInteger(media?.elementIndex) ? media.elementIndex : -1;
  if (!recordingFile || elementIndex < 0) return { status: 'not_requested' };
  try {
    const capture = await Promise.race([
      page.evaluate(async ({ selectedIndex }) => {
      const video = Array.from(document.querySelectorAll('video'))[selectedIndex];
      if (!video) return { status: 'video_not_found' };
      const captureStream = video.captureStream || video.mozCaptureStream;
      if (typeof captureStream !== 'function' || typeof MediaRecorder === 'undefined') return { status: 'capture_unsupported' };
      const stream = captureStream.call(video);
      if (!stream || (!stream.getAudioTracks().length && !stream.getVideoTracks().length)) return { status: 'stream_unavailable' };
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
      let recorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        return { status: 'recorder_unavailable' };
      }
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      try {
        video.muted = false;
        video.volume = 1;
        await video.play().catch(() => {});
        recorder.start(250);
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        if (recorder.state !== 'inactive') recorder.stop();
        await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      if (!blob.size) return { status: 'empty_recording' };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const step = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += step) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
      }
      return { status: 'completed', mimeType: blob.type || recorder.mimeType || mimeType || 'video/webm', dataBase64: btoa(binary) };
      }, { selectedIndex: elementIndex }),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'recording_timed_out' }), 8_000)),
    ]);
    if (capture?.status !== 'completed' || !capture.dataBase64) return { status: text(capture?.status) || 'recording_failed' };
    const target = path.resolve(recordingFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload = Buffer.from(capture.dataBase64, 'base64');
    if (!payload.length) return { status: 'empty_recording' };
    await fs.writeFile(target, payload);
    return { status: 'completed', runtimeRecordingPath: target, byteLength: payload.length, mimeType: text(capture.mimeType) };
  } catch {
    return { status: 'recording_failed' };
  }
}

const launchedAsScript = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (launchedAsScript) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
