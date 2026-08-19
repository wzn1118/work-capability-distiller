import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(serverDir, '..');

function readEnvFile() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return {};

  const values = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const env = { ...readEnvFile(), ...process.env };

function numberValue(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function jsonStringList(value) {
  const source = stringValue(value);
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

function fromProject(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function profileAlias(value) {
  const normalized = stringValue(value, 'attached-browser')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'attached-browser';
}

function toolAdapterConfig(prefix, defaultTimeoutMs = 240_000) {
  const command = stringValue(env[`${prefix}_COMMAND`]);
  return {
    enabled: Boolean(command) && env[`${prefix}_ENABLED`] !== 'false',
    command,
    args: jsonStringList(env[`${prefix}_ARGS`]),
    cwd: fromProject(stringValue(env[`${prefix}_CWD`])) || projectRoot,
    timeoutMs: Math.max(
      10_000,
      Math.min(numberValue(env[`${prefix}_TIMEOUT_MS`], defaultTimeoutMs), 900_000),
    ),
  };
}

const maxContentSamplesPerCreator = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_MAX_CONTENT_SAMPLES_PER_CREATOR, 10_000), 10_000),
);
const defaultContentSamplesPerCreator = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_DEFAULT_CONTENT_SAMPLES_PER_CREATOR, 10_000), maxContentSamplesPerCreator),
);
// Browser Relay work remains globally serialized, but a small creator worker
// pool lets non-browser connectors and artifact work overlap safely.
const contentCollectionConcurrency = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_CONTENT_COLLECTION_CONCURRENCY, 2), 4),
);
const collectionRandomIntervalMinCandidateMs = Math.max(
  0,
  Math.min(numberValue(env.KOLFORGE_COLLECTION_RANDOM_INTERVAL_MIN_MS, 0), 10 * 60 * 1_000),
);
const collectionRandomIntervalMaxCandidateMs = Math.max(
  0,
  Math.min(numberValue(env.KOLFORGE_COLLECTION_RANDOM_INTERVAL_MAX_MS, collectionRandomIntervalMinCandidateMs), 10 * 60 * 1_000),
);
const collectionRandomIntervalMinMs = Math.min(collectionRandomIntervalMinCandidateMs, collectionRandomIntervalMaxCandidateMs);
const collectionRandomIntervalMaxMs = Math.max(collectionRandomIntervalMinCandidateMs, collectionRandomIntervalMaxCandidateMs);
const requestedContentAnalysisProvider = stringValue(env.KOLFORGE_CONTENT_ANALYSIS_PROVIDER, 'openai_responses').toLowerCase();
const contentAnalysisProvider = ['ollama', 'openai_responses'].includes(requestedContentAnalysisProvider)
  ? requestedContentAnalysisProvider
  : 'openai_responses';
const remoteContentAnalysisModel = stringValue(env.KOLFORGE_CONTENT_ANALYSIS_MODEL);
const contentAnalysisApiKey = stringValue(env.KOLFORGE_CONTENT_ANALYSIS_API_KEY || env.OPENAI_API_KEY);
const remoteContentAnalysisBaseUrl = stringValue(
  env.KOLFORGE_CONTENT_ANALYSIS_BASE_URL || env.OPENAI_BASE_URL,
  'https://api.openai.com/v1',
);
const localContentAnalysisModel = stringValue(env.KOLFORGE_CONTENT_ANALYSIS_OLLAMA_MODEL);
const localContentAnalysisBaseUrl = stringValue(env.KOLFORGE_CONTENT_ANALYSIS_OLLAMA_BASE_URL, 'http://127.0.0.1:11434');
const contentAnalysisModel = contentAnalysisProvider === 'ollama'
  ? localContentAnalysisModel
  : remoteContentAnalysisModel;
const contentAnalysisBaseUrl = contentAnalysisProvider === 'ollama'
  ? localContentAnalysisBaseUrl
  : remoteContentAnalysisBaseUrl;
const contentAnalysisTimeoutMs = Math.max(
  1_000,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_TIMEOUT_MS, 30_000), 120_000),
);
const contentAnalysisContextLength = Math.max(
  4_096,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_CONTEXT_LENGTH, 8_192), 8_192),
);
const requestedContentAnalysisOrchestration = stringValue(
  env.KOLFORGE_CONTENT_ANALYSIS_ORCHESTRATION,
  'codex_multi_agent',
).toLowerCase();
const contentAnalysisOrchestration = ['codex_multi_agent', 'evidence_matrix'].includes(
  requestedContentAnalysisOrchestration,
)
  ? requestedContentAnalysisOrchestration
  : 'codex_multi_agent';
const contentAnalysisRemoteConcurrency = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_REMOTE_CONCURRENCY, 2), 8),
);
const contentAnalysisRequestConcurrency = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_REQUEST_CONCURRENCY, 6), 16),
);
const contentAnalysisMultimodalMaxImages = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGES, 8), 16),
);
const contentAnalysisMultimodalMaxImageBytes = Math.max(
  64 * 1024,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_IMAGE_BYTES, 4 * 1024 * 1024), 8 * 1024 * 1024),
);
const contentAnalysisMultimodalMaxTotalBytes = Math.max(
  256 * 1024,
  Math.min(numberValue(env.KOLFORGE_CONTENT_ANALYSIS_MULTIMODAL_MAX_TOTAL_BYTES, 16 * 1024 * 1024), 32 * 1024 * 1024),
);
// Video interpretation is complete for the visible capture by default.  A
// positive value remains available as an explicit operational override, but
// an omitted, zero, or "all" value means every captured public video.
const requestedVideoAnalysisSamplesPerCreator = stringValue(env.KOLFORGE_VIDEO_ANALYSIS_SAMPLES_PER_CREATOR, 'all').toLowerCase();
const videoAnalysisSamplesPerCreator = ['all', 'full', '0'].includes(requestedVideoAnalysisSamplesPerCreator)
  ? 0
  : Math.max(
    1,
    Math.min(numberValue(requestedVideoAnalysisSamplesPerCreator, maxContentSamplesPerCreator), maxContentSamplesPerCreator),
  );
const videoAnalysisFramesPerVideo = Math.max(
  2,
  Math.min(numberValue(env.KOLFORGE_VIDEO_ANALYSIS_FRAMES_PER_VIDEO, 4), 8),
);
const videoAnalysisTimeoutMs = Math.max(
  30_000,
  Math.min(numberValue(env.KOLFORGE_VIDEO_ANALYSIS_TIMEOUT_MS, 180_000), 480_000),
);
// The attached browser is deliberately observed one page at a time, but the
// local media, OCR, and ASR stages can overlap after each observation is done.
const videoAnalysisConcurrency = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_VIDEO_ANALYSIS_CONCURRENCY, 2), 4),
);
// Two creator pipelines let the next profile page be observed while the
// previous creator's local media work is still running. Browser navigation and
// the CPU/GPU-intensive substeps retain their own global limits.
const videoCreatorConcurrency = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_VIDEO_CREATOR_CONCURRENCY, 2), 4),
);
// Recording the rendered element is useful on a small number of pages where a
// direct media probe fails, but it adds a fixed wait to every video. Keep it
// opt-in so the normal full-catalog path favors throughput.
const videoBrowserRecordingFallback = stringValue(env.KOLFORGE_VIDEO_BROWSER_RECORDING_FALLBACK).toLowerCase() === 'true';
const videoVisionModel = stringValue(env.KOLFORGE_VIDEO_VISION_MODEL);
const videoVisionBaseUrl = stringValue(env.KOLFORGE_VIDEO_VISION_BASE_URL, 'http://127.0.0.1:11434');
const videoVisionMaxFrames = Math.max(
  1,
  Math.min(numberValue(env.KOLFORGE_VIDEO_VISION_MAX_FRAMES, 4), 4),
);
const videoVisionTimeoutMs = Math.max(
  1_000,
  Math.min(numberValue(env.KOLFORGE_VIDEO_VISION_TIMEOUT_MS, 45_000), 120_000),
);
const videoVisionContextLength = Math.max(
  4_096,
  Math.min(numberValue(env.KOLFORGE_VIDEO_VISION_CONTEXT_LENGTH, 8_192), 8_192),
);
const requestedVideoTranscriptProvider = stringValue(env.KOLFORGE_VIDEO_TRANSCRIPT_PROVIDER, 'ffmpeg_whisper').toLowerCase();
const videoTranscriptProvider = ['ffmpeg_whisper', 'funasr'].includes(requestedVideoTranscriptProvider)
  ? requestedVideoTranscriptProvider
  : 'ffmpeg_whisper';
const videoFunasrModelDir = fromProject(stringValue(env.KOLFORGE_VIDEO_FUNASR_MODEL_DIR));
const videoFunasrScript = fromProject(
  stringValue(env.KOLFORGE_VIDEO_FUNASR_SCRIPT, 'server/scripts/transcribe_video_funasr.py'),
);
const videoFunasrDevice = stringValue(env.KOLFORGE_VIDEO_FUNASR_DEVICE, 'auto');
const videoPlaywrightModulePath = fromProject(stringValue(env.KOLFORGE_VIDEO_PLAYWRIGHT_MODULE_PATH));
// video-batch-download is an optional local integration, but when it is
// present its Playwright runtime is also suitable for the browser Relay health
// check. Keeping the default local avoids depending on a global Python setup.
const bundledRelayPlaywrightModulePath = fromProject('.kolforge-tools/video-batch-download/node_modules');
const relayPlaywrightModulePath = fromProject(stringValue(
  env.KOLFORGE_RELAY_PLAYWRIGHT_MODULE_PATH,
  fs.existsSync(path.join(bundledRelayPlaywrightModulePath, 'playwright'))
    ? bundledRelayPlaywrightModulePath
    : '',
));
const bundledRuntimePython = fromProject('.kolforge-runtime/python/Scripts/python.exe');
const bundledDependencyPython = path.join(
  process.env.USERPROFILE || '',
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'python',
  'python.exe',
);
const defaultVideoPython = fs.existsSync(bundledRuntimePython)
  ? bundledRuntimePython
  : (fs.existsSync(bundledDependencyPython) ? bundledDependencyPython : 'py');
const defaultVideoPythonArgs = defaultVideoPython === 'py' ? ['-3'] : [];
const defaultWhisperModelPath = fromProject('.kolforge-models/whisper/ggml-base.bin');
const fallbackWhisperModelPath = fromProject('.kolforge-models/whisper/ggml-tiny.bin');
const detectedWhisperModelPath = fs.existsSync(defaultWhisperModelPath)
  ? defaultWhisperModelPath
  : (fs.existsSync(fallbackWhisperModelPath) ? fallbackWhisperModelPath : '');
const videoLocalMediaCacheMaxBytes = Math.max(
  16 * 1024 * 1024,
  Math.min(numberValue(env.KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE_MAX_BYTES, 192 * 1024 * 1024), 512 * 1024 * 1024),
);
const videoPythonArgs = typeof env.KOLFORGE_VIDEO_PYTHON_ARGS === 'string'
  ? env.KOLFORGE_VIDEO_PYTHON_ARGS.trim().split(/\s+/).filter(Boolean)
  : defaultVideoPythonArgs;
const videoSummary302ApiKey = stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_API_KEY);
const videoSummary302ApiUrl = stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_API_URL, 'https://api.302.ai');
const videoSummary302Model = stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_MODEL, 'gpt-4o');
const videoSummary302Language = stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_LANGUAGE, 'zh');
const videoSummary302RequestTimeoutMs = Math.max(
  10_000,
  Math.min(numberValue(env.KOLFORGE_302_VIDEO_SUMMARY_REQUEST_TIMEOUT_MS, 180_000), 300_000),
);
const videoSummary302MaxTokens = Math.max(
  128,
  Math.min(numberValue(env.KOLFORGE_302_VIDEO_SUMMARY_MAX_TOKENS, 900), 2_048),
);
// Keep the built-in provider visible in health checks by default. A supplied
// key activates it automatically; set ENABLED=false to turn it off entirely.
const videoSummary302Requested = env.KOLFORGE_302_VIDEO_SUMMARY_ENABLED !== 'false';
const videoSummary302MissingConfiguration = videoSummary302Requested && !videoSummary302ApiKey
  ? ['api_key']
  : [];
const videoSummary302Adapter = {
  enabled: videoSummary302Requested
    && env.KOLFORGE_302_VIDEO_SUMMARY_ENABLED !== 'false'
    && !videoSummary302MissingConfiguration.length,
  command: stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_COMMAND, process.execPath),
  args: jsonStringList(env.KOLFORGE_302_VIDEO_SUMMARY_ARGS).length
    ? jsonStringList(env.KOLFORGE_302_VIDEO_SUMMARY_ARGS)
    : [path.join(serverDir, 'scripts', 'summarize_video_302.mjs')],
  cwd: fromProject(stringValue(env.KOLFORGE_302_VIDEO_SUMMARY_CWD)) || projectRoot,
  timeoutMs: Math.max(
    10_000,
    Math.min(numberValue(env.KOLFORGE_302_VIDEO_SUMMARY_TIMEOUT_MS, 250_000), 900_000),
  ),
  missingConfiguration: videoSummary302MissingConfiguration,
  // The child bridge receives only its own runtime settings. Parsed .env values
  // are otherwise not present in process.env for spawned adapter processes.
  env: {
    KOLFORGE_302_VIDEO_SUMMARY_API_URL: videoSummary302ApiUrl,
    KOLFORGE_302_VIDEO_SUMMARY_API_KEY: videoSummary302ApiKey,
    KOLFORGE_302_VIDEO_SUMMARY_MODEL: videoSummary302Model,
    KOLFORGE_302_VIDEO_SUMMARY_LANGUAGE: videoSummary302Language,
    KOLFORGE_302_VIDEO_SUMMARY_REQUEST_TIMEOUT_MS: String(videoSummary302RequestTimeoutMs),
    KOLFORGE_302_VIDEO_SUMMARY_MAX_TOKENS: String(videoSummary302MaxTokens),
  },
};

const dataDir = fromProject(env.KOLFORGE_DATA_DIR || '.kolforge-data');
const relaySessionStateDir = fromProject(stringValue(
  env.KOLFORGE_BROWSER_SESSION_STATE_DIR,
  path.join(dataDir, 'browser-sessions'),
));
const browserProfileAlias = profileAlias(env.KOLFORGE_BROWSER_PROFILE_ALIAS);
// Successful collectors validate the rendered page themselves. Keep their
// preceding Relay preflight warm briefly so a continuous creator batch does
// not spawn another CDP probe for every profile.
const relayPreflightCacheMs = Math.max(
  0,
  Math.min(numberValue(env.KOLFORGE_RELAY_PREFLIGHT_CACHE_MS, 120_000), 300_000),
);
const outreachMode = ['local_outbox', 'partner_http', 'browser_relay'].includes(
  stringValue(env.DOUYIN_MESSAGE_CONNECTOR, 'local_outbox').toLowerCase(),
)
  ? stringValue(env.DOUYIN_MESSAGE_CONNECTOR, 'local_outbox').toLowerCase()
  : 'local_outbox';
const outreachTimeoutMs = Math.max(
  1_000,
  Math.min(numberValue(env.DOUYIN_MESSAGE_TIMEOUT_MS, 30_000), 120_000),
);
const defaultRelayPort = numberValue(env.BROWSER_RELAY_PORT, 18800);
// Douyin owns a dedicated Relay process. Keep this port in code so an env
// override cannot accidentally route Douyin traffic through another platform.
export const DOUYIN_RELAY_PORT = 18801;
const douyinMessageRelayPort = DOUYIN_RELAY_PORT;

export const config = {
  host: '127.0.0.1',
  port: numberValue(env.KOLFORGE_PORT, 8787),
  dataDir,
  collection: {
    // Browser Relay uses a real, interactive platform session. Keep full-mode
    // discovery bounded, but large enough to build a useful candidate pool.
    maxDiscoveryCandidatesPerChannel: Math.max(30, Math.min(numberValue(env.KOLFORGE_MAX_DISCOVERY_PER_CHANNEL, 15_000), 20_000)),
    // A discovery job keeps a reserve of low-overlap search routes. Routes are
    // consumed only while the per-channel target remains short, so a strong
    // early route does not turn into needless browser work.
    maxDiscoveryQueryVariants: Math.max(1, Math.min(numberValue(env.KOLFORGE_DISCOVERY_QUERY_VARIANTS, 16), 16)),
    // Leave headroom for account-level duplicates. The scheduler recomputes
    // the current route quota from observed unique creators after every route.
    discoveryRouteOverfetchRatio: Math.max(
      1,
      Math.min(Number(env.KOLFORGE_DISCOVERY_ROUTE_OVERFETCH_RATIO) || 1.35, 3),
    ),
    // High-volume browser collection needs more time than a profile verification.
    // Clamp the override so a stale Relay session cannot keep a job open forever.
    browserRelayCollectionTimeoutMs: Math.max(
      120_000,
      Math.min(numberValue(env.KOLFORGE_BROWSER_RELAY_COLLECTION_TIMEOUT_MS, 1_800_000), 4_200_000),
    ),
    // Content refreshes are intentionally bounded to cards visibly rendered on
    // a public profile. This is an upper bound, not a claim of full history.
    maxContentSamplesPerCreator,
    defaultContentSamplesPerCreator,
    contentCollectionConcurrency,
    randomIntervalMinMs: collectionRandomIntervalMinMs,
    randomIntervalMaxMs: collectionRandomIntervalMaxMs,
  },
  // Model enrichment is explicit. Local Ollama is an opt-in, localhost-only
  // inference path; remote responses still require an explicit API key.
  analysis: {
    content: {
      provider: contentAnalysisProvider,
      baseUrl: contentAnalysisBaseUrl,
      apiKey: contentAnalysisProvider === 'ollama' ? '' : contentAnalysisApiKey,
      model: contentAnalysisModel,
      timeoutMs: contentAnalysisTimeoutMs,
      contextLength: contentAnalysisContextLength,
      orchestration: contentAnalysisOrchestration,
      remoteConcurrency: contentAnalysisRemoteConcurrency,
      requestConcurrency: contentAnalysisRequestConcurrency,
      multimodalMaxImages: contentAnalysisMultimodalMaxImages,
      multimodalMaxImageBytes: contentAnalysisMultimodalMaxImageBytes,
      multimodalMaxTotalBytes: contentAnalysisMultimodalMaxTotalBytes,
      enabled: contentAnalysisProvider === 'ollama'
        ? Boolean(contentAnalysisModel && contentAnalysisBaseUrl)
        : Boolean(contentAnalysisModel && contentAnalysisApiKey && contentAnalysisBaseUrl),
    },
    video: {
      // This pipeline works only with a media URL rendered in the user's attached
      // browser session. It never substitutes a cover image for the actual video.
      enabled: env.KOLFORGE_VIDEO_ANALYSIS_ENABLED !== 'false',
      maxVideosPerCreator: videoAnalysisSamplesPerCreator,
      framesPerVideo: videoAnalysisFramesPerVideo,
      timeoutMs: videoAnalysisTimeoutMs,
      concurrency: videoAnalysisConcurrency,
      creatorConcurrency: videoCreatorConcurrency,
      browserRecordingFallback: videoBrowserRecordingFallback,
      ffmpeg: stringValue(env.KOLFORGE_VIDEO_FFMPEG_PATH, 'ffmpeg'),
      ffprobe: stringValue(env.KOLFORGE_VIDEO_FFPROBE_PATH, 'ffprobe'),
      python: stringValue(env.KOLFORGE_VIDEO_PYTHON, defaultVideoPython),
      pythonArgs: videoPythonArgs,
      relayScript: path.join(serverDir, 'scripts', 'collect_video_media_relay.py'),
      // Prefer the local Node Relay because it can capture derived frames from
      // the attached browser. The Python relay remains a compatibility fallback.
      node: stringValue(env.KOLFORGE_VIDEO_NODE_PATH, process.execPath),
      relayNodeScript: path.join(serverDir, 'scripts', 'collect_video_media_relay.mjs'),
      playwrightModulePath: videoPlaywrightModulePath,
      ocrScript: path.join(serverDir, 'scripts', 'video_frame_ocr.py'),
      whisperModelPath: fromProject(stringValue(env.KOLFORGE_VIDEO_WHISPER_MODEL_PATH, detectedWhisperModelPath)),
      whisperLanguage: stringValue(env.KOLFORGE_VIDEO_WHISPER_LANGUAGE, 'zh'),
      // The browser relay observes the playable media element. Once it has
      // passed the platform allowlist, the rest of the processing chain works
      // from a bounded local copy that is deleted after analysis.
      localMediaCache: {
        enabled: env.KOLFORGE_VIDEO_LOCAL_MEDIA_CACHE !== 'false',
        maxBytes: videoLocalMediaCacheMaxBytes,
      },
      // Keep Whisper as the compatibility default. FunASR is a local-only
      // sidecar for Chinese ASR/VAD/punctuation and must be configured with a
      // model directory explicitly; it never receives a runtime media URL.
      transcript: {
        provider: videoTranscriptProvider,
        funasrScript: videoFunasrScript,
        funasrModelDir: videoFunasrModelDir,
        funasrDevice: videoFunasrDevice,
      },
      // Visual semantics remain opt-in: no local Ollama request is made until
      // the caller deliberately configures a model name.
      vision: {
        provider: 'ollama',
        model: videoVisionModel,
        baseUrl: videoVisionBaseUrl,
        maxFrames: videoVisionMaxFrames,
        timeoutMs: videoVisionTimeoutMs,
        contextLength: videoVisionContextLength,
        enabled: Boolean(videoVisionModel),
      },
      // Optional, separately installed upstream tools. They are always invoked
      // as bounded subprocesses and their output is normalized before it reaches
      // creator analysis. No platform session data is passed through this config.
      toolchain: {
        videoBatchDownload: toolAdapterConfig('KOLFORGE_VIDEO_BATCH_DOWNLOAD', 420_000),
        bilicli: toolAdapterConfig('KOLFORGE_BILICLI', 360_000),
        videoCopyAnalyzer: toolAdapterConfig('KOLFORGE_VIDEO_COPY_ANALYZER', 300_000),
        videoSummary302: videoSummary302Adapter,
        videoSummary: toolAdapterConfig('KOLFORGE_VIDEO_SUMMARY', 120_000),
      },
    },
  },
  relay: {
    // OpenClaw's attached browser exposes CDP on 18800. Keep this overrideable
    // for another local browser profile or an explicitly configured relay.
    port: defaultRelayPort,
    python: env.KOLFORGE_PYTHON || 'python',
    node: stringValue(env.KOLFORGE_RELAY_NODE_PATH, process.execPath),
    preflightScript: path.join(serverDir, 'scripts', 'browser_relay_preflight.mjs'),
    preflightCacheMs: relayPreflightCacheMs,
    playwrightModulePath: relayPlaywrightModulePath,
    sessionStateDir: relaySessionStateDir,
    profileAlias: browserProfileAlias,
  },
  outreach: {
    douyin: {
      mode: outreachMode,
      url: stringValue(env.DOUYIN_MESSAGE_API_URL),
      token: stringValue(env.DOUYIN_MESSAGE_API_TOKEN),
      timeoutMs: outreachTimeoutMs,
      node: stringValue(env.DOUYIN_MESSAGE_NODE_PATH, process.execPath),
      script: path.join(serverDir, 'scripts', 'send_douyin_message_relay.mjs'),
      relayPort: douyinMessageRelayPort,
      playwrightModulePath: relayPlaywrightModulePath,
    },
  },
  platforms: {
    xiaohongshu: {
      id: 'xiaohongshu',
      label: '小红书',
      mode: env.XIAOHONGSHU_CONNECTOR || 'browser_relay',
      relayPort: numberValue(env.XIAOHONGSHU_RELAY_PORT, defaultRelayPort),
      relayScript: fromProject(env.XIAOHONGSHU_RELAY_SCRIPT || 'server/scripts/collect_xiaohongshu_relay.py'),
      partnerUrl: env.XIAOHONGSHU_PARTNER_URL || '',
      partnerToken: env.XIAOHONGSHU_PARTNER_TOKEN || '',
    },
    douyin: {
      id: 'douyin',
      label: '抖音',
      mode: env.DOUYIN_CONNECTOR || 'browser_relay',
      relayPort: DOUYIN_RELAY_PORT,
      // The Node collector attaches to the same visible browser Relay as the
      // preflight check, so discovery does not depend on an ambient Python
      // Playwright installation. An explicit DOUYIN_RELAY_SCRIPT override can
      // still select a compatible local collector.
      relayScript: fromProject(env.DOUYIN_RELAY_SCRIPT || 'server/scripts/collect_douyin_relay.mjs'),
      // Account search exposes direct public profile links, while the general
      // search grid is made of click-only video cards without stable links.
      // Deployments can still override this with DOUYIN_SEARCH_URL_TEMPLATE.
      searchUrlTemplate: env.DOUYIN_SEARCH_URL_TEMPLATE || 'https://www.douyin.com/search/{query}?type=user',
      postSearchUrlTemplate: env.DOUYIN_POST_SEARCH_URL_TEMPLATE || 'https://www.douyin.com/search/{query}?type=general',
      partnerUrl: env.DOUYIN_PARTNER_URL || '',
      partnerToken: env.DOUYIN_PARTNER_TOKEN || '',
      clientKey: env.DOUYIN_CLIENT_KEY || '',
      clientSecret: env.DOUYIN_CLIENT_SECRET || '',
      deviceId: env.DOUYIN_DEVICE_ID || '',
      sortType: numberValue(env.DOUYIN_SORT_TYPE, 1),
      publishTime: numberValue(env.DOUYIN_PUBLISH_TIME, 0),
    },
    bilibili: {
      id: 'bilibili',
      label: 'B\u7ad9',
      mode: env.BILIBILI_CONNECTOR || 'browser_relay',
      relayScript: fromProject(env.BILIBILI_RELAY_SCRIPT || 'server/scripts/collect_bilibili_relay.py'),
      searchUrlTemplate: env.BILIBILI_SEARCH_URL_TEMPLATE || 'https://search.bilibili.com/upuser?keyword={query}',
      partnerUrl: env.BILIBILI_PARTNER_URL || '',
      partnerToken: env.BILIBILI_PARTNER_TOKEN || '',
    },
  },
};

export function publicPlatformConfig(platformId) {
  const platform = config.platforms[platformId];
  if (!platform) return null;
  return {
    id: platform.id,
    label: platform.label,
    mode: platform.mode,
    relayPort: platform.relayPort || config.relay.port,
  };
}

export function relayPortForPlatform(platformId) {
  return config.platforms[platformId]?.relayPort || config.relay.port;
}
