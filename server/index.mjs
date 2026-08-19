import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, DOUYIN_RELAY_PORT, publicPlatformConfig, relayPortForPlatform } from './config.mjs';
import { JobStore } from './store.mjs';
import { ConnectorError, collectPlatform, getConnectorHealth } from './connectors.mjs';
import { readRelaySessionRetention } from './relay-session-state.mjs';
import { recoverRelay } from './relay-recovery.mjs';
import {
  deriveCreatorPersona,
  normalizeEnrichmentTarget,
  profileCaptureTransportError,
  selectEnrichmentTargets,
} from './enrichment.mjs';
import {
  contentCollectionFollowUpPhase,
  contentCollectionReportedPhase,
  contentCollectionWorkerCount,
  contentDetailPriorityOrder,
  contentCaptureVisibleSampleCount,
  contentResumeCompletedPhases,
  discoveryCardProfileBaselineResult,
  deriveCreatorContentCapture,
  mergeCreatorContentCaptures,
} from './content-collection.mjs';
import {
  analyzeCreatorContentWithFallback,
  contentAnalysisRoles,
  contentInputFingerprint,
  deriveContentAnalysis,
} from './content-analysis.mjs';
import {
  buildEvidenceLockedOutreachDraftBatch,
  updateEvidenceLockedOutreachDraft,
} from './outreach-drafts.mjs';
import {
  candidateImageUrl,
  candidateMediaUrl,
  collectVideoEvidence,
  createVideoProcessingResources,
  mediaRequestHeaders,
} from './video-analysis.mjs';
import { getToolchainHealth } from './tool-adapters.mjs';
import { AudienceInsightsError, deriveAudienceInsights } from './audience-insights.mjs';
import { createRandomIntervalController, normalizeRandomInterval } from './collection-timing.mjs';
import {
  canonicalCreatorIdentity,
  dedupeCreators,
  isProfileSourceUrl,
  isUsableCreatorName,
  normalizeBilibiliCreators,
  normalizeDouyinCreators,
  normalizePartnerItems,
  normalizeXiaohongshuNotes,
} from './normalizer.mjs';
import {
  mergePostSearchResults,
  normalizePostSearchComments,
  normalizePostSearchRecord,
  normalizePostSearchResults,
} from './post-search.mjs';
import { derivePostCommentSummary } from './post-comment-summary.mjs';
import { deliverOutreachMessage, deliveryConfigSummary, OutreachDeliveryError } from './outreach-delivery.mjs';
import { deliverDouyinFollowViaRelay, OutreachRelayError } from './outreach-relay.mjs';
import { DouyinCommentJobController } from './douyin-comments/controller.mjs';
import { ensureDouyinRelay } from './douyin-comments/relay-bootstrap.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '..', 'dist');
const supportedPlatforms = new Set(['xiaohongshu', 'douyin', 'bilibili']);
const store = new JobStore(config.dataDir, { sanitizeJob: sanitizePersistedJob });
const douyinCommentJobs = new DouyinCommentJobController({
  dataDir: config.dataDir,
  cdpUrl: `http://127.0.0.1:${DOUYIN_RELAY_PORT}`,
  forceBackupCdn: process.env.KOLFORGE_DOUYIN_FORCE_BACKUP_CDN === 'true',
  ensureBrowser: () => ensureDouyinRelay({ port: DOUYIN_RELAY_PORT, dataDir: config.dataDir }),
});
let primaryStoreReady = false;
let primaryStoreInitializationError = null;
// A follow-up task can address the complete saved discovery result. The
// discovery ceiling itself remains the operational boundary, so a UI page or
// selection viewport can never silently cut down a content/analysis run.
const MAX_FOLLOW_UP_TARGETS = Math.max(
  1,
  config.collection.maxDiscoveryCandidatesPerChannel * supportedPlatforms.size,
);
const MAX_VERIFICATION_TARGETS = Math.min(
  config.collection.maxDiscoveryCandidatesPerChannel * supportedPlatforms.size,
  MAX_FOLLOW_UP_TARGETS,
);
const MAX_ENRICHMENT_TARGETS = MAX_VERIFICATION_TARGETS;
const MAX_CONTENT_COLLECTION_TARGETS = MAX_VERIFICATION_TARGETS;
const MAX_CONTENT_ANALYSIS_TARGETS = MAX_CONTENT_COLLECTION_TARGETS;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_POST_SEARCH_RESULTS = 10_000;
const DEFAULT_POST_SEARCH_LIMIT = 100;
const DEFAULT_POST_SEARCH_CONTINUATION_BATCH = 100;
// Artifact scans run after a collector returns. Keep their filesystem work
// bounded, but do not make the next Browser Relay capture wait on one file at
// a time when a profile emits several public-data artifacts.
const ARTIFACT_MANIFEST_IO_CONCURRENCY = 4;
const ARTIFACT_EXTENSIONS = new Set(['.json', '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm']);
const ARTIFACT_CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const LOCAL_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CONNECTION_WAIT_CODES = new Set(['RELAY_NOT_READY', 'LOGIN_REQUIRED', 'PLATFORM_VERIFICATION_REQUIRED']);
const CONFIGURATION_WAIT_CODES = new Set([
  'CONNECTOR_NOT_CONFIGURED',
  'PARTNER_AUTH_FAILED',
  'DOUYIN_TOKEN_FAILED',
  'DOUYIN_API_AUTH_FAILED',
  'DIRECT_PROFILE_UNSUPPORTED',
]);
const LOCAL_DEV_ORIGINS = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:4174',
  'http://localhost:4174',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
]);

// One attached browser session can safely run only one temporary collection tab at a time.
let browserRelayQueue = Promise.resolve();

function runWithBrowserRelayLock(task) {
  const run = browserRelayQueue.then(task, task);
  browserRelayQueue = run.catch(() => undefined);
  return run;
}

function createAsyncPool(limit) {
  const concurrency = Math.max(1, Number.parseInt(limit, 10) || 1);
  let active = 0;
  const queued = [];
  const drain = () => {
    while (active < concurrency && queued.length) {
      const next = queued.shift();
      active += 1;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queued.push({ task, resolve, reject });
    drain();
  });
}

// Local inference remains serial to avoid starving the workstation. Remote
// Responses work has separate creator and request limits so multiple creators
// can progress without opening an unbounded burst of specialist calls.
const runLocalContentModel = createAsyncPool(1);
const runRemoteContentModel = createAsyncPool(config.analysis.content.remoteConcurrency);
const runRemoteContentRequest = createAsyncPool(config.analysis.content.requestConcurrency);
const HEALTH_CONNECTOR_STATUS_TIMEOUT_MS = 3_000;

function runContentModelMatrix(modelConfig, task) {
  if (!modelConfig?.enabled) return task();
  return modelConfig.provider === 'ollama' ? runLocalContentModel(task) : runRemoteContentModel(task);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendJsonDownload(response, filename, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  response.end(body);
}

function sendError(response, statusCode, code, message, action = '') {
  sendJson(response, statusCode, { error: { code, message, action } });
}

function allowLocalDevCors(request, response) {
  const origin = request.headers.origin;
  if (!LOCAL_DEV_ORIGINS.has(origin)) return false;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, idempotency-key, last-event-id');
  response.setHeader('vary', 'Origin');
  return true;
}

async function readRequestJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 256 * 1024) throw new ConnectorError('PAYLOAD_TOO_LARGE', 'Request body exceeds 256 KB.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConnectorError('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function normalizeTarget(target) {
  const channel = supportedPlatforms.has(target?.channel) ? target.channel : '';
  const targetId = String(target?.targetId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160);
  const name = String(target?.name || '').trim().slice(0, 120);
  const sourceUrl = channel ? isProfileSourceUrl(channel, String(target?.sourceUrl || '').trim().slice(0, 800)) : '';
  if (!channel || !targetId || !name) {
    throw new ConnectorError('TARGET_INVALID', 'Each verification target needs an id, platform, and creator name.');
  }
  if (!sourceUrl || !canonicalCreatorIdentity(channel, sourceUrl)) {
    throw new ConnectorError('TARGET_SOURCE_INVALID', 'Each verification target needs a valid platform profile URL.');
  }
  return { targetId, channel, name, sourceUrl };
}

function normalizeLocalId(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  return LOCAL_ID_PATTERN.test(raw) ? raw : '';
}

function compactDiscoveryQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function uniqueDiscoveryQueries(values, maximum = config.collection.maxDiscoveryQueryVariants) {
  const queries = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const query = compactDiscoveryQuery(value);
    const identity = query.toLocaleLowerCase();
    if (!query || seen.has(identity)) continue;
    seen.add(identity);
    queries.push(query);
    if (queries.length >= maximum) break;
  }
  return queries;
}

function buildDiscoveryQueryPlan(query, seeds = []) {
  const primary = compactDiscoveryQuery(query);
  const maximum = config.collection.maxDiscoveryQueryVariants;
  const supplied = uniqueDiscoveryQueries([primary, ...seeds], maximum);
  if (!primary || supplied.length >= maximum) return supplied;
  const suffixes = /[\u3400-\u9fff]/u.test(primary)
    ? ['达人', '博主', '测评', '内容分享', '好物分享', '种草', '实测', '开箱', '教程', '经验分享', '推荐', '避坑', '清单', '案例', '攻略']
    : ['creators', 'influencer', 'review', 'content', 'recommendation', 'unboxing', 'tutorial', 'tips', 'routine', 'guide', 'community', 'comparison', 'favorites', 'case study', 'how to'];
  return uniqueDiscoveryQueries([
    ...supplied,
    ...suffixes.map((suffix) => `${primary} ${suffix}`),
  ], maximum);
}

function normalizeDiscoveryContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    product: compactDiscoveryQuery(context.product),
    objective: compactDiscoveryQuery(context.objective),
    audience: compactDiscoveryQuery(context.audience),
    market: compactDiscoveryQuery(context.market),
  };
}

function discoveryIntentTerms(primary) {
  return /[\u3400-\u9fff]/u.test(primary)
    ? [
      '\u8fbe\u4eba', '\u535a\u4e3b', '\u6d4b\u8bc4', '\u5b9e\u6d4b', '\u4f7f\u7528\u4f53\u9a8c', '\u79cd\u8349', '\u6e05\u5355', '\u6559\u7a0b',
      '\u63a8\u8350', '\u5f00\u7bb1', '\u5bf9\u6bd4', '\u653b\u7565', '\u907f\u5751', '\u65e5\u5e38', '\u6848\u4f8b', '\u597d\u7269\u5206\u4eab',
    ]
    : [
      'creator', 'influencer', 'review', 'real use', 'recommendation', 'tutorial', 'comparison', 'routine',
      'unboxing', 'tips', 'guide', 'favorites', 'case study', 'community', 'how to', 'experience',
    ];
}

function buildDiscoveryQueryMatrix(query, seeds = [], context = {}, targetLimit = null) {
  const primary = compactDiscoveryQuery(query);
  const normalizedContext = normalizeDiscoveryContext(context);
  const configuredMaximum = config.collection.maxDiscoveryQueryVariants;
  const supplied = uniqueDiscoveryQueries([primary, ...seeds], configuredMaximum);
  if (!primary) return supplied;

  // Large requests use more independent public-search routes; explicit seeds
  // remain first so a caller's deliberate route plan is never discarded.
  const requestedRoutes = Math.ceil(Math.max(1, Number(targetLimit) || 0) / 750);
  const maximum = Math.min(configuredMaximum, Math.max(supplied.length, requestedRoutes, 1));
  if (supplied.length >= maximum) return supplied;

  const secondaryRoots = uniqueDiscoveryQueries([normalizedContext.product], 2)
    .filter((value) => value.toLocaleLowerCase() !== primary.toLocaleLowerCase());
  const contextualQueries = [
    normalizedContext.audience ? `${primary} ${normalizedContext.audience}` : '',
    normalizedContext.objective ? `${primary} ${normalizedContext.objective}` : '',
    normalizedContext.market ? `${primary} ${normalizedContext.market}` : '',
    ...secondaryRoots.flatMap((root) => [
      root,
      ...discoveryIntentTerms(root).slice(0, 6).map((term) => `${root} ${term}`),
    ]),
  ];
  return uniqueDiscoveryQueries([
    ...supplied,
    ...contextualQueries,
    ...discoveryIntentTerms(primary).map((term) => `${primary} ${term}`),
  ], maximum);
}

function validateCollectionRequest(body) {
  const type = body.type === 'verify' ? 'verify' : 'discover';
  const channelSet = new Set(
    (Array.isArray(body.channels) ? body.channels : []).filter((id) => supportedPlatforms.has(id)),
  );
  const query = compactDiscoveryQuery(body.query);
  const querySeeds = uniqueDiscoveryQueries(body.querySeeds);
  const parsedLimit = Number.parseInt(body.limit, 10);
  const defaultLimit = type === 'discover' ? config.collection.maxDiscoveryCandidatesPerChannel : 8;
  const maxLimit = type === 'discover' ? config.collection.maxDiscoveryCandidatesPerChannel : 12;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, maxLimit)) : defaultLimit;
  const discoveryContext = type === 'discover' ? normalizeDiscoveryContext(body.discoveryContext) : null;
  const queryPlan = type === 'discover'
    ? buildDiscoveryQueryMatrix(query, querySeeds, discoveryContext, limit)
    : [];
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  if (type === 'verify' && rawTargets.length > MAX_VERIFICATION_TARGETS) {
    throw new ConnectorError('TARGET_LIMIT_EXCEEDED', `A verification run supports up to ${MAX_VERIFICATION_TARGETS} selected creators.`, 'Split the selected creators into separate verification runs.');
  }
  const targets = type === 'verify' ? rawTargets.map(normalizeTarget) : [];
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) {
    throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  }
  const rawDiscoveryJobId = body.discoveryJobId === undefined || body.discoveryJobId === null ? '' : String(body.discoveryJobId).trim();
  const discoveryJobId = normalizeLocalId(rawDiscoveryJobId);
  if (rawDiscoveryJobId && !discoveryJobId) {
    throw new ConnectorError('DISCOVERY_JOB_INVALID', 'Discovery job id must be a valid local collection identifier.');
  }

  for (const target of targets) channelSet.add(target.channel);
  if (!channelSet.size) throw new ConnectorError('CHANNEL_REQUIRED', 'Select at least one supported platform.');
  if (type === 'discover' && !query) throw new ConnectorError('QUERY_REQUIRED', 'Enter a product, topic, or creator query before collecting.');
  if (type === 'verify' && !targets.length) throw new ConnectorError('TARGET_REQUIRED', 'Select one or more discovered creators before verification.');
  if (new Set(targets.map((target) => target.targetId)).size !== targets.length) {
    throw new ConnectorError('TARGET_ID_DUPLICATE', 'Verification target ids must be unique.');
  }
  return {
    channels: [...channelSet], query, type, limit, targets,
    querySeeds,
    discoveryContext,
    queryPlan,
    campaignId: campaignId || null,
    discoveryJobId: type === 'verify' ? discoveryJobId || null : null,
  };
}

function compactText(value, maximum = 600) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function validateRandomInterval(body) {
  const raw = body?.randomInterval;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new ConnectorError('RANDOM_INTERVAL_INVALID', 'randomInterval must be an object with minSeconds and maxSeconds.');
  }
  const source = raw || {
    minMs: config.collection.randomIntervalMinMs,
    maxMs: config.collection.randomIntervalMaxMs,
  };
  const minMs = source.minMs !== undefined
    ? source.minMs
    : source.minSeconds !== undefined
      ? Number(source.minSeconds) * 1_000
      : config.collection.randomIntervalMinMs;
  const maxMs = source.maxMs !== undefined
    ? source.maxMs
    : source.maxSeconds !== undefined
      ? Number(source.maxSeconds) * 1_000
      : config.collection.randomIntervalMaxMs;
  return normalizeRandomInterval({ minMs, maxMs }, {
    defaultMinMs: config.collection.randomIntervalMinMs,
    defaultMaxMs: config.collection.randomIntervalMaxMs,
  });
}

function validateModelPreferences(body) {
  const contentModelPreference = body?.contentModelPreference || body?.modelPreference || 'configured';
  const videoVisionPreference = body?.videoVisionPreference || 'configured';
  if (!['configured', 'evidence_matrix'].includes(contentModelPreference)) {
    throw new ConnectorError('CONTENT_MODEL_PREFERENCE_INVALID', 'Choose a supported content analysis model mode.');
  }
  if (!['configured', 'keyframes_only'].includes(videoVisionPreference)) {
    throw new ConnectorError('VIDEO_VISION_PREFERENCE_INVALID', 'Choose a supported video analysis mode.');
  }
  return { contentModelPreference, videoVisionPreference };
}

function validatePostSearchRequest(body) {
  const query = compactText(body.query, 180).replace(/\s+/g, ' ');
  if (!query) throw new ConnectorError('POST_SEARCH_QUERY_REQUIRED', '请输入帖子搜索关键词。');
  const parsedLimit = Number.parseInt(body.limit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_POST_SEARCH_RESULTS))
    : DEFAULT_POST_SEARCH_LIMIT;
  return { query, limit, randomInterval: validateRandomInterval(body) };
}

function validatePostSearchContinuationRequest(body) {
  const parsedLimit = Number.parseInt(body?.additionalLimit ?? body?.limit, 10);
  const additionalLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_POST_SEARCH_RESULTS))
    : DEFAULT_POST_SEARCH_CONTINUATION_BATCH;
  return { additionalLimit, randomInterval: validateRandomInterval(body || {}) };
}

function validatePostSendRequest(body) {
  const messageBody = compactText(body.messageBody ?? body.message, 1200);
  if (!messageBody) throw new ConnectorError('MESSAGE_REQUIRED', '请输入站内信内容。');
  if (!body.post || typeof body.post !== 'object' || Array.isArray(body.post)) {
    throw new ConnectorError('POST_SEARCH_POST_REQUIRED', '请选择一个帖子后再发送站内信。');
  }
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  return {
    messageBody,
    campaignId: campaignId || null,
    query: compactText(body.query, 180),
    sourceUrl: compactText(body.sourceUrl, 800),
    post: body.post,
  };
}

function validatePostFollowRequest(body) {
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  const supplied = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
    ? body.profile
    : body;
  const sourceUrl = isProfileSourceUrl('douyin', compactText(
    supplied.sourceUrl || supplied.authorProfile || supplied.profileUrl,
    1200,
  ));
  if (!sourceUrl) {
    throw new ConnectorError('POST_PROFILE_SOURCE_INVALID', 'The selected Douyin creator does not contain a valid public profile URL.');
  }
  return {
    campaignId: campaignId || null,
    query: compactText(body.query, 180),
    sourceUrl,
    profile: {
      id: canonicalCreatorIdentity('douyin', sourceUrl),
      targetId: canonicalCreatorIdentity('douyin', sourceUrl),
      name: compactText(supplied.name || supplied.authorName, 120) || 'Douyin creator',
      channel: 'douyin',
      platform: 'douyin',
      sourceUrl,
      authorProfile: sourceUrl,
      avatar: compactText(supplied.avatar, 1200),
    },
  };
}

function validatePostMediaRequest(body) {
  if (!body.post || typeof body.post !== 'object' || Array.isArray(body.post)) {
    throw new ConnectorError('POST_SEARCH_POST_REQUIRED', 'A post is required before extracting video frames.');
  }
  return {
    query: compactText(body.query, 180),
    sourceUrl: compactText(body.sourceUrl, 800),
    post: body.post,
  };
}

function validatePostCommentsRequest(body) {
  if (!body.post || typeof body.post !== 'object' || Array.isArray(body.post)) {
    throw new ConnectorError('POST_SEARCH_POST_REQUIRED', 'A post is required before reading hot comments.');
  }
  const parsedLimit = Number.parseInt(body.limit, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 10)) : 10;
  return {
    query: compactText(body.query, 180),
    sourceUrl: compactText(body.sourceUrl, 800),
    limit,
    randomInterval: validateRandomInterval(body),
    post: body.post,
  };
}

function validatePostProfileAnalysisRequest(body) {
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) {
    throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  }
  if (!Array.isArray(body.profiles)) {
    throw new ConnectorError('POST_PROFILE_SELECTION_REQUIRED', 'Select one or more creator profiles from the selected posts.');
  }
  if (body.profiles.length > MAX_CONTENT_COLLECTION_TARGETS) {
    throw new ConnectorError(
      'POST_PROFILE_TARGET_LIMIT',
      `A post profile analysis batch supports up to ${MAX_CONTENT_COLLECTION_TARGETS} creator profiles.`,
      'Split the selected profiles into separate analysis batches.',
    );
  }
  const profiles = body.profiles.map((profile, index) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    const channel = ['douyin', 'xiaohongshu'].includes(profile.channel) ? profile.channel : '';
    const sourceUrl = channel ? isProfileSourceUrl(channel, compactText(profile.sourceUrl, 1200)) : '';
    const identityKey = canonicalCreatorIdentity(channel, sourceUrl);
    const name = compactText(profile.name, 120) || `Creator ${index + 1}`;
    if (!channel || !sourceUrl || !identityKey || !isUsableCreatorName(name)) return null;
    return {
      id: identityKey,
      targetId: identityKey,
      name,
      channel,
      platform: channel,
      sourceUrl,
      identityKey,
      handle: compactText(profile.handle, 140),
      avatar: compactText(profile.avatar, 1200),
      sourcePostIds: uniqueStringList(profile.postIds, 40),
    };
  }).filter(Boolean);
  const uniqueProfiles = [...new Map(profiles.map((profile) => [profile.identityKey, profile])).values()];
  if (!uniqueProfiles.length) {
    throw new ConnectorError('POST_PROFILE_SELECTION_REQUIRED', 'The selected posts do not contain valid creator profile links.');
  }
  return {
    campaignId: campaignId || null,
    query: compactText(body.query, 180),
    profiles: uniqueProfiles,
    contentLimit: Math.min(
      Math.max(1, Number.isInteger(Number(body.contentLimit)) ? Number(body.contentLimit) : config.collection.defaultContentSamplesPerCreator),
      config.collection.maxContentSamplesPerCreator,
    ),
    randomInterval: validateRandomInterval(body),
    ...validateModelPreferences(body),
  };
}

function uniqueStringList(value, maximum = MAX_VERIFICATION_TARGETS) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => compactText(String(item || ''), 180))
    .filter(Boolean))]
    .slice(0, maximum);
}

function validateEnrichmentRequest(body) {
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) {
    throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  }
  const rawDiscoveryJobId = body.discoveryJobId === undefined || body.discoveryJobId === null ? '' : String(body.discoveryJobId).trim();
  const discoveryJobId = normalizeLocalId(rawDiscoveryJobId);
  if (!discoveryJobId) {
    throw new ConnectorError(
      'DISCOVERY_JOB_REQUIRED',
      'A persona task needs the saved discovery task that produced its creators.',
      'Restore a discovery task before enriching creators.',
    );
  }
  const hasCreatorIds = Object.hasOwn(body, 'creatorIds');
  if (hasCreatorIds && !Array.isArray(body.creatorIds)) {
    throw new ConnectorError('CREATOR_IDS_INVALID', 'creatorIds must be an array of discovered creator ids.');
  }
  if (Array.isArray(body.creatorIds) && body.creatorIds.length > MAX_ENRICHMENT_TARGETS) {
    throw new ConnectorError(
      'ENRICHMENT_TARGET_LIMIT',
      'A persona task supports up to ' + MAX_ENRICHMENT_TARGETS + ' discovered creators.',
      'Split the selected creators into separate persona tasks.',
    );
  }
  const creatorIds = hasCreatorIds ? uniqueStringList(body.creatorIds, MAX_ENRICHMENT_TARGETS) : null;
  if (hasCreatorIds && !creatorIds.length) {
    throw new ConnectorError('TARGET_REQUIRED', 'Select one or more discovered creators for persona enrichment.');
  }
  return { campaignId: campaignId || null, discoveryJobId, creatorIds };
}

function validateContentCollectionRequest(body) {
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) {
    throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  }
  const rawDiscoveryJobId = body.discoveryJobId === undefined || body.discoveryJobId === null ? '' : String(body.discoveryJobId).trim();
  const discoveryJobId = normalizeLocalId(rawDiscoveryJobId);
  if (!discoveryJobId) {
    throw new ConnectorError(
      'DISCOVERY_JOB_REQUIRED',
      'A content collection task needs the saved discovery task that produced its creators.',
      'Restore a discovery task before collecting creator content.',
    );
  }
  const hasCreatorIds = Object.hasOwn(body, 'creatorIds');
  const hasAllDiscoveredCandidates = Object.hasOwn(body, 'allDiscoveredCandidates');
  if (hasAllDiscoveredCandidates && typeof body.allDiscoveredCandidates !== 'boolean') {
    throw new ConnectorError('CONTENT_TARGET_SCOPE_INVALID', 'allDiscoveredCandidates must be a boolean.');
  }
  if (body.allDiscoveredCandidates === true && hasCreatorIds) {
    throw new ConnectorError(
      'CONTENT_TARGET_SCOPE_CONFLICT',
      'Choose either all discovered creators or an explicit creator selection.',
    );
  }
  if (hasCreatorIds && !Array.isArray(body.creatorIds)) {
    throw new ConnectorError('CREATOR_IDS_INVALID', 'creatorIds must be an array of discovered creator ids.');
  }
  if (Array.isArray(body.creatorIds) && body.creatorIds.length > MAX_CONTENT_COLLECTION_TARGETS) {
    throw new ConnectorError(
      'CONTENT_TARGET_LIMIT',
      'A content collection task supports up to ' + MAX_CONTENT_COLLECTION_TARGETS + ' discovered creators.',
      'Split the selected creators into separate content collection tasks.',
    );
  }
  const creatorIds = hasCreatorIds ? uniqueStringList(body.creatorIds, MAX_CONTENT_COLLECTION_TARGETS) : null;
  if (hasCreatorIds && !creatorIds.length) {
    throw new ConnectorError('TARGET_REQUIRED', 'Select one or more discovered creators before collecting content.');
  }
  const hasContentLimit = Object.hasOwn(body, 'contentLimit');
  const parsedContentLimit = Number(body.contentLimit);
  if (hasContentLimit && (!Number.isInteger(parsedContentLimit)
    || parsedContentLimit < 1
    || parsedContentLimit > config.collection.maxContentSamplesPerCreator)) {
    throw new ConnectorError(
      'CONTENT_SAMPLE_LIMIT_INVALID',
      `contentLimit must be an integer from 1 to ${config.collection.maxContentSamplesPerCreator}.`,
      'Choose a bounded visible-content sample limit and run the task again.',
    );
  }
  const strategy = compactText(body.strategy, 80) || 'standard';
  if (!['standard', 'breadth_first_full'].includes(strategy)) {
    throw new ConnectorError(
      'CONTENT_STRATEGY_INVALID',
      'strategy must be standard or breadth_first_full.',
      'Use breadth_first_full for profile-first full-catalog collection.',
    );
  }
  return {
    campaignId: campaignId || null,
    discoveryJobId,
    creatorIds,
    targetScope: creatorIds === null ? 'all_discovered_candidates' : 'selected_creators',
    contentLimit: hasContentLimit ? parsedContentLimit : config.collection.defaultContentSamplesPerCreator,
    strategy,
    randomInterval: validateRandomInterval(body),
  };
}

function validateContentAnalysisRequest(body) {
  const rawCampaignId = body.campaignId === undefined || body.campaignId === null ? '' : String(body.campaignId).trim();
  const campaignId = normalizeLocalId(rawCampaignId);
  if (rawCampaignId && !campaignId) {
    throw new ConnectorError('CAMPAIGN_INVALID', 'Campaign id must be a valid local campaign identifier.');
  }
  const rawContentJobId = body.contentJobId === undefined || body.contentJobId === null ? '' : String(body.contentJobId).trim();
  const contentJobId = normalizeLocalId(rawContentJobId);
  if (!contentJobId) {
    throw new ConnectorError(
      'CONTENT_SOURCE_JOB_REQUIRED',
      'A content analysis task needs a saved creator content collection task.',
      'Collect visible creator content before running the analysis matrix.',
    );
  }
  const hasCreatorIds = Object.hasOwn(body, 'creatorIds');
  const hasAllCapturedCreators = Object.hasOwn(body, 'allCapturedCreators');
  if (hasAllCapturedCreators && typeof body.allCapturedCreators !== 'boolean') {
    throw new ConnectorError('CONTENT_ANALYSIS_TARGET_SCOPE_INVALID', 'allCapturedCreators must be a boolean.');
  }
  if (body.allCapturedCreators === true && hasCreatorIds) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_TARGET_SCOPE_CONFLICT',
      'Choose either all collected creator captures or an explicit creator selection.',
    );
  }
  if (hasCreatorIds && !Array.isArray(body.creatorIds)) {
    throw new ConnectorError('CREATOR_IDS_INVALID', 'creatorIds must be an array of content-capture creator ids.');
  }
  if (Array.isArray(body.creatorIds) && body.creatorIds.length > MAX_CONTENT_ANALYSIS_TARGETS) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_TARGET_LIMIT',
      'A content analysis task supports up to ' + MAX_CONTENT_ANALYSIS_TARGETS + ' creator captures.',
      'Split the selected creator captures into separate analysis tasks.',
    );
  }
  const creatorIds = hasCreatorIds ? uniqueStringList(body.creatorIds, MAX_CONTENT_ANALYSIS_TARGETS) : null;
  if (hasCreatorIds && !creatorIds.length) {
    throw new ConnectorError('TARGET_REQUIRED', 'Select one or more creator content captures for analysis.');
  }
  return {
    campaignId: campaignId || null,
    contentJobId,
    creatorIds,
    targetScope: creatorIds === null ? 'all_captured_creators' : 'selected_creators',
    ...validateModelPreferences(body),
  };
}

function validateAudienceInsightRequest(body) {
  const rawDiscoveryJobId = body.discoveryJobId === undefined || body.discoveryJobId === null
    ? ''
    : String(body.discoveryJobId).trim();
  const discoveryJobId = normalizeLocalId(rawDiscoveryJobId);
  if (!discoveryJobId) {
    throw new ConnectorError(
      'DISCOVERY_JOB_REQUIRED',
      'An audience insight import must be linked to the saved discovery task that produced its creator.',
      'Restore a discovery task before importing an audience insight.',
    );
  }
  const creatorId = compactText(body.creatorId, 180);
  if (!creatorId) {
    throw new ConnectorError(
      'CREATOR_ID_REQUIRED',
      'Select a discovered creator before importing an audience insight.',
      'Open the creator detail panel and choose its aggregate audience export.',
    );
  }
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new ConnectorError(
      'AUDIENCE_INPUT_INVALID',
      'Audience insight imports require one JSON object containing an aggregate source and distributions.',
      'Upload an official or authorized aggregate audience export JSON object.',
    );
  }
  return { discoveryJobId, creatorId, payload: body.payload };
}

function normalizeCampaignPatch(body = {}) {
  const patch = {};
  if (Object.hasOwn(body, 'brief')) {
    const brief = body.brief && typeof body.brief === 'object' ? body.brief : {};
    patch.brief = Object.fromEntries([
      'brand', 'product', 'objective', 'audience', 'budget', 'market', 'tone', 'avoid',
    ].map((key) => [key, compactText(brief[key])]).filter(([, value]) => value));
  }
  if (Object.hasOwn(body, 'channels')) {
    patch.channels = [...new Set((Array.isArray(body.channels) ? body.channels : [])
      .filter((channel) => supportedPlatforms.has(channel)))];
  }
  if (Object.hasOwn(body, 'discoveryJobId')) {
    const jobId = compactText(body.discoveryJobId, 64);
    patch.discoveryJobId = jobId || null;
  }
  if (Object.hasOwn(body, 'contentAnalysisJobId')) {
    const jobId = compactText(body.contentAnalysisJobId, 64);
    patch.contentAnalysisJobId = jobId || null;
  }
  if (Object.hasOwn(body, 'selectedCreatorIds')) patch.selectedCreatorIds = uniqueStringList(body.selectedCreatorIds);
  if (Object.hasOwn(body, 'sentCreatorIds')) patch.sentCreatorIds = uniqueStringList(body.sentCreatorIds);
  if (Object.hasOwn(body, 'generated')) patch.generated = Boolean(body.generated);
  if (Object.hasOwn(body, 'currentStep')) {
    const step = Number.parseInt(body.currentStep, 10);
    patch.currentStep = Number.isFinite(step) ? Math.max(1, Math.min(step, 6)) : 1;
  }
  return patch;
}

function assertDiscoveryJob(jobId) {
  if (!jobId) return null;
  const discoveryJob = store.get(jobId);
  if (!discoveryJob || discoveryJob.type !== 'discover') {
    throw new ConnectorError(
      'DISCOVERY_JOB_INVALID',
      'The selected discovery task does not exist or is not a discovery collection.',
      'Select a saved discovery task before attaching it to a project.',
    );
  }
  return discoveryJob;
}

function assertContentAnalysisJob(jobId) {
  if (!jobId) return null;
  const contentAnalysisJob = store.get(jobId);
  if (!contentAnalysisJob || contentAnalysisJob.type !== 'content_analysis') {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_JOB_INVALID',
      'The selected content analysis task does not exist or is not a content analysis task.',
      'Select a saved content analysis task before attaching it to a project.',
    );
  }
  return contentAnalysisJob;
}

function selectedDiscoveryCreator(discoveryJob, creatorId) {
  const selection = selectEnrichmentTargets(discoveryJob, [creatorId], 1);
  if (selection.missingIds.length || !selection.targets.length) {
    throw new ConnectorError(
      'CREATOR_NOT_FOUND',
      'The selected creator was not found in the saved discovery task.',
      'Refresh the candidate list and import the audience export from that creator detail panel.',
    );
  }
  return selection.targets[0];
}

function isAggregateAudienceInsight(insight) {
  return Boolean(insight)
    && typeof insight === 'object'
    && !Array.isArray(insight)
    && Boolean(compactText(insight.creatorId, 180))
    && insight.source?.dataScope === 'aggregate';
}

function audienceInsightsForDiscovery(discoveryJobId, creatorId = '') {
  const newestByCreator = new Map();
  for (const job of store.listAll({ type: 'audience' })) {
    const insight = job.audienceInsight;
    if (job.status !== 'succeeded' || job.discoveryJobId !== discoveryJobId || !isAggregateAudienceInsight(insight)) continue;
    if (creatorId && insight.creatorId !== creatorId) continue;
    if (!newestByCreator.has(insight.creatorId)) newestByCreator.set(insight.creatorId, insight);
  }
  return [...newestByCreator.values()].sort((left, right) => (
    String(left.creatorName || left.creatorId).localeCompare(String(right.creatorName || right.creatorId), 'zh-CN')
  ));
}

function aggregateAudienceForCreator(discoveryJobId, creatorId) {
  if (!discoveryJobId || !creatorId) return null;
  return audienceInsightsForDiscovery(discoveryJobId, creatorId)[0] || null;
}

function hydratePersonaAudience(persona, discoveryJobId) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return persona;
  const existingAudience = persona.audience && typeof persona.audience === 'object' && !Array.isArray(persona.audience)
    ? persona.audience
    : {};
  const creatorId = compactText(persona.targetId || persona.discoveryCreatorId, 180);
  const publicSignals = Array.isArray(existingAudience.publicSignals)
    ? existingAudience.publicSignals
    : Array.isArray(persona.profile?.publicAudienceSignals)
      ? persona.profile.publicAudienceSignals
      : [];
  const aggregate = aggregateAudienceForCreator(discoveryJobId, creatorId) || existingAudience.aggregate || null;
  const existingCoverage = existingAudience.coverage && typeof existingAudience.coverage === 'object'
    && !Array.isArray(existingAudience.coverage)
    ? existingAudience.coverage
    : {};
  return {
    ...persona,
    schemaVersion: Number.isFinite(persona.schemaVersion) ? persona.schemaVersion : 1,
    audience: {
      ...existingAudience,
      dataScope: compactText(existingAudience.dataScope, 80) || 'public_profile_signals',
      publicSignals,
      aggregate,
      coverage: {
        ...existingCoverage,
        ...(aggregate ? {
          aggregateAudience: {
            ...(existingCoverage.aggregateAudience && typeof existingCoverage.aggregateAudience === 'object'
              ? existingCoverage.aggregateAudience
              : {}),
            status: 'attached',
          },
        } : {}),
      },
    },
  };
}

function hydrateJobPersonas(job) {
  if (!job || job.type !== 'enrich') return job;
  return {
    ...job,
    results: Array.isArray(job.results)
      ? job.results.map((persona) => hydratePersonaAudience(persona, job.discoveryJobId))
      : [],
  };
}

function contentAnalysisFindingCount(analyses) {
  return (Array.isArray(analyses) ? analyses : []).reduce((total, entry) => (
    total + (Array.isArray(entry?.analysis?.roles)
      ? entry.analysis.roles.reduce((roleTotal, role) => (
        roleTotal + (Array.isArray(role?.findings) ? role.findings.length : 0)
      ), 0)
      : 0)
  ), 0);
}

function jobSummary(job) {
  if (!job) return null;
  const metrics = job.type === 'content_analysis'
    ? { ...(job.metrics || {}), findings: contentAnalysisFindingCount(job.results) }
    : (job.metrics || {});
  const selectedCreatorIds = Array.isArray(job.selectedCreatorIds) ? job.selectedCreatorIds : [];
  const fullCardCoverageCount = Number(job.metrics?.fullCardCoverageCount) || 0;
  const totalCardCount = Number(job.metrics?.targetCreators) || selectedCreatorIds.length;
  const remainingCardCount = job.metrics?.remainingCardCount == null
    ? Math.max(0, totalCardCount - fullCardCoverageCount)
    : Math.max(0, Number(job.metrics.remainingCardCount) || 0);
  const channelResultEntries = Object.entries(job.channelResults || {});
  const compactContentResults = job.type === 'content' && channelResultEntries.length > 25;
  const summarizedChannelResults = compactContentResults
    ? Object.fromEntries(channelResultEntries.filter(([, result]) => (
      result?.error
      || ['failed', 'retryable', 'waiting_for_connection', 'waiting_for_storage'].includes(result?.status)
    )).slice(-25))
    : Object.fromEntries(channelResultEntries);
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    query: job.query,
    querySeeds: Array.isArray(job.querySeeds) ? job.querySeeds : [],
    discoveryContext: job.discoveryContext || null,
    queryPlan: Array.isArray(job.queryPlan) ? job.queryPlan : [],
    limit: Number.isFinite(job.limit) ? job.limit : null,
    requestedTotal: Number.isFinite(job.requestedTotal) ? job.requestedTotal : null,
    requestedBatchLimit: Number.isFinite(job.requestedBatchLimit) ? job.requestedBatchLimit : null,
    collectedTotal: Number.isFinite(job.collectedTotal) ? job.collectedTotal : null,
    continuationCount: Number(job.continuationCount) || 0,
    lastAdded: Number(job.lastAdded) || 0,
    duplicateCount: Number(job.duplicateCount) || 0,
    lastBatchDuplicates: Number(job.lastBatchDuplicates) || 0,
    resultCount: Array.isArray(job.results)
      ? job.results.length
      : Number(job.resultStorage?.resultCount)
        || Number(job.metrics?.resultCount)
        || Number(job.metrics?.contentCaptures)
        || 0,
    channels: job.channels,
    campaignId: job.campaignId || null,
    discoveryJobId: job.discoveryJobId || null,
    contentJobId: job.contentJobId || null,
    selectedCreatorIds: selectedCreatorIds.length <= 100 ? selectedCreatorIds : [],
    selectedCreatorCount: selectedCreatorIds.length,
    contentLimit: Number.isFinite(job.contentLimit) ? job.contentLimit : null,
    strategy: job.strategy || null,
    phase: job.phase || null,
    collectionProgress: job.collectionProgress || null,
    profileCoverageCount: Number(job.metrics?.profileCoverageCount) || 0,
    profileResolvedCount: Number(job.metrics?.profileResolvedCount) || 0,
    profileValueCoverageCount: Number(job.metrics?.profileValueCoverageCount) || 0,
    catalogCoverageCount: Number(job.metrics?.catalogCoverageCount) || 0,
    uniqueContentCount: Number(job.metrics?.uniqueContentCount ?? job.metrics?.visibleContentSamples) || 0,
    detailCoverageCount: Number(job.metrics?.detailCoverageCount) || 0,
    fullCardCoverageCount,
    remainingCardCount,
    retryCount: Number(job.metrics?.retryCount ?? job.metrics?.retryableContentCaptures) || 0,
    storageWaterline: job.metrics?.storageWaterline || store.health().waterline || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    metrics,
    channelResults: summarizedChannelResults,
    channelResultCount: channelResultEntries.length,
    channelResultsTruncated: Object.keys(summarizedChannelResults).length < channelResultEntries.length,
    error: job.error || null,
  };
}

function campaignPayload(campaign) {
  if (!campaign) return null;
  const discoveryJob = campaign.discoveryJobId ? store.get(campaign.discoveryJobId) : null;
  const verificationJobs = (campaign.verificationJobIds || []).map((id) => store.get(id)).filter(Boolean);
  const enrichmentJobs = (campaign.enrichmentJobIds || []).map((id) => store.get(id)).filter(Boolean);
  const contentJobs = (campaign.contentJobIds || []).map((id) => store.get(id)).filter(Boolean);
  const contentAnalysisJobs = (campaign.contentAnalysisJobIds || []).map((id) => store.get(id)).filter(Boolean);
  const currentVerificationJob = verificationJobs
    .filter((job) => job.discoveryJobId === campaign.discoveryJobId)
    .at(-1) || null;
  const currentEnrichmentJob = enrichmentJobs
    .filter((job) => job.discoveryJobId === campaign.discoveryJobId)
    .at(-1) || null;
  const currentContentJob = contentJobs
    .filter((job) => job.discoveryJobId === campaign.discoveryJobId)
    .at(-1) || null;
  const linkedContentAnalysisJob = campaign.contentAnalysisJobId
    ? store.get(campaign.contentAnalysisJobId)
    : null;
  const latestContentAnalysisJob = contentAnalysisJobs
    .filter((job) => job.discoveryJobId === campaign.discoveryJobId)
    .sort((left, right) => String(left.updatedAt || left.createdAt)
      .localeCompare(String(right.updatedAt || right.createdAt)))
    .at(-1) || null;
  const currentContentAnalysisJob = linkedContentAnalysisJob?.type === 'content_analysis'
    && linkedContentAnalysisJob.discoveryJobId === campaign.discoveryJobId
    ? linkedContentAnalysisJob
    : latestContentAnalysisJob;
  return {
    campaign,
    discoveryJob: jobSummary(discoveryJob),
    verificationJobs: verificationJobs.map(jobSummary),
    currentVerificationJob: jobSummary(currentVerificationJob),
    enrichmentJobs: enrichmentJobs.map(jobSummary),
    currentEnrichmentJob: jobSummary(currentEnrichmentJob),
    contentJobs: contentJobs.map(jobSummary),
    currentContentJob: jobSummary(currentContentJob),
    contentAnalysisJobs: contentAnalysisJobs.map(jobSummary),
    currentContentAnalysisJob: jobSummary(currentContentAnalysisJob),
  };
}

function campaignOutreachCreators(campaign, contentAnalysisJob) {
  const discoveryJob = campaign?.discoveryJobId ? store.get(campaign.discoveryJobId) : null;
  const selectedIds = new Set(uniqueStringList(
    campaign?.selectedCreatorIds?.length ? campaign.selectedCreatorIds : contentAnalysisJob?.selectedCreatorIds,
    MAX_CONTENT_ANALYSIS_TARGETS,
  ));
  const creators = Array.isArray(discoveryJob?.results) ? discoveryJob.results : [];
  return creators.filter((creator) => selectedIds.has(compactText(creator?.id || creator?.targetId, 180)));
}

function assertCampaignContentAnalysisJob(campaign, requestedJobId = '') {
  const requestedId = normalizeLocalId(requestedJobId);
  const jobId = requestedId || campaign?.contentAnalysisJobId;
  const contentAnalysisJob = assertContentAnalysisJob(jobId);
  if (!contentAnalysisJob) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_JOB_REQUIRED',
      'A completed content analysis task is required before generating outreach drafts.',
      'Run content analysis for the selected creators before opening the outreach workspace.',
    );
  }
  if (campaign?.discoveryJobId && contentAnalysisJob.discoveryJobId
    && campaign.discoveryJobId !== contentAnalysisJob.discoveryJobId) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_CAMPAIGN_MISMATCH',
      'The selected content analysis task belongs to a different discovery task.',
      'Use the content analysis task created from this campaign discovery task.',
    );
  }
  if (contentAnalysisJob.campaignId && campaign?.id && contentAnalysisJob.campaignId !== campaign.id) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_CAMPAIGN_MISMATCH',
      'The selected content analysis task belongs to a different campaign.',
      'Restore the campaign that created this analysis task or run a new analysis.',
    );
  }
  return contentAnalysisJob;
}

function outreachDraftSummary(drafts) {
  return (Array.isArray(drafts) ? drafts : []).reduce((summary, draft) => {
    const status = compactText(draft?.status, 40) || 'blocked';
    const reviewStatus = compactText(draft?.review?.status, 40) || 'draft';
    summary.total += 1;
    summary[status] = (summary[status] || 0) + 1;
    summary.review[reviewStatus] = (summary.review[reviewStatus] || 0) + 1;
    if (draft?.multimodalManifest) summary.multimodal += 1;
    return summary;
  }, {
    total: 0,
    ready: 0,
    blocked: 0,
    stale: 0,
    multimodal: 0,
    review: { draft: 0, approved: 0, sent: 0 },
  });
}

function mergeFreshOutreachDrafts({ campaign, batch, regenerate = false }) {
  const existingByTargetId = new Map((Array.isArray(campaign?.outreachDrafts) ? campaign.outreachDrafts : [])
    .map((draft) => [compactText(draft?.targetId, 180), draft])
    .filter(([targetId]) => Boolean(targetId)));
  return batch.drafts.map((freshDraft) => {
    const existing = existingByTargetId.get(freshDraft.targetId);
    const sameInput = existing?.schemaVersion === freshDraft.schemaVersion
      && compactText(existing?.source?.inputFingerprint, 128)
      && compactText(existing?.source?.inputFingerprint, 128) === compactText(freshDraft?.source?.inputFingerprint, 128);
    if (regenerate || !sameInput || freshDraft.status !== 'ready' || existing?.status !== 'ready') return freshDraft;
    return {
      ...freshDraft,
      message: {
        ...freshDraft.message,
        body: compactText(existing?.message?.body, 6000) || freshDraft.message.body,
        updatedAt: compactText(existing?.message?.updatedAt, 80) || freshDraft.message.updatedAt,
      },
      review: {
        ...freshDraft.review,
        ...(existing?.review || {}),
      },
      updatedAt: compactText(existing?.updatedAt, 80) || freshDraft.updatedAt,
    };
  });
}

async function resolveCampaignOutreachDraftBatch(campaign, { contentAnalysisJobId = '', regenerate = false } = {}) {
  const contentAnalysisJob = assertCampaignContentAnalysisJob(campaign, contentAnalysisJobId);
  const currentContentJob = contentAnalysisJob.contentJobId ? store.get(contentAnalysisJob.contentJobId) : null;
  const currentCaptures = currentContentJob?.id
    ? await store.loadContentCaptures(currentContentJob.id)
    : [];
  const batch = buildEvidenceLockedOutreachDraftBatch({
    campaign,
    contentAnalysisJob,
    creators: campaignOutreachCreators(campaign, contentAnalysisJob),
    analysisRows: contentAnalysisRowsWithFreshness(contentAnalysisJob),
    currentCaptures,
  });
  return {
    contentAnalysisJob,
    drafts: mergeFreshOutreachDrafts({ campaign, batch, regenerate }),
  };
}

function persistCampaignOutreachDrafts(campaign, { contentAnalysisJob, drafts }) {
  const summary = outreachDraftSummary(drafts);
  const sentCreatorIds = drafts
    .filter((draft) => draft?.review?.status === 'sent')
    .map((draft) => compactText(draft?.targetId, 180))
    .filter(Boolean);
  const currentStep = Math.max(
    Number.isFinite(Number(campaign?.currentStep)) ? Number(campaign.currentStep) : 1,
    summary.ready ? 6 : 5,
  );
  return {
    campaign: store.patchCampaign(campaign.id, {
      outreachDrafts: drafts,
      sentCreatorIds,
      generated: summary.ready > 0,
      currentStep: Math.min(6, currentStep),
      contentAnalysisJobId: contentAnalysisJob.id,
    }),
    summary,
  };
}

function contentAnalysisTarget(capture) {
  return {
    targetId: compactText(capture?.targetId || capture?.discoveryCreatorId, 180),
    channel: supportedPlatforms.has(capture?.channel) ? capture.channel : '',
    name: compactText(capture?.name, 120),
    sourceUrl: compactText(capture?.sourceUrl, 1200),
    identityKey: compactText(capture?.identityKey, 240),
  };
}

function contentAnalysisRecord({ initial, capture, analysis, analyzedAt }) {
  const target = contentAnalysisTarget(capture);
  return {
    schemaVersion: 1,
    id: `content-analysis-${target.targetId}`,
    targetId: target.targetId,
    discoveryCreatorId: compactText(capture.discoveryCreatorId || target.targetId, 180),
    channel: target.channel,
    platform: target.channel,
    name: target.name,
    sourceUrl: target.sourceUrl,
    identityKey: target.identityKey,
    sourceContentJobId: initial.contentJobId,
    sourceContentCapturedAt: compactText(capture.capturedAt, 80) || null,
    analyzedAt,
    status: analysis.status,
    analysis,
  };
}

function jobWorkItems(job) {
  if (job.type === 'verify' || job.type === 'enrich' || job.type === 'content') {
    return (Array.isArray(job.targets) ? job.targets : []).map((savedTarget) => {
      const target = normalizeEnrichmentTarget(savedTarget) || savedTarget;
      return {
        platform: target.channel,
        query: target.name,
        target: { ...target, targetId: target.targetId || target.id },
      };
    });
  }
  if (job.type === 'content_analysis') {
    return (Array.isArray(job.sourceCaptures) ? job.sourceCaptures : [])
      .map((capture) => contentAnalysisTarget(capture))
      .filter((target) => target.channel && target.targetId && target.name && target.sourceUrl)
      .map((target) => ({ platform: target.channel, query: target.name, target }));
  }
  if (job.type === 'discover') {
    const queries = uniqueDiscoveryQueries(job.queryPlan);
    const queryPlan = queries.length
      ? queries
      : buildDiscoveryQueryMatrix(job.query, job.querySeeds, job.discoveryContext, job.limit);
    const routeLimit = Math.max(1, Math.ceil(Math.max(1, Number(job.limit) || 1) / Math.max(1, queryPlan.length)));
    return job.channels.flatMap((platform) => queryPlan.map((query, index) => ({
      platform,
      query,
      target: null,
      route: {
        index,
        total: queryPlan.length,
        limit: routeLimit,
      },
    })));
  }
  return job.channels.map((platform) => ({ platform, query: job.query, target: null }));
}

async function analysisSourceCaptures(contentJob, creatorIds) {
  if (!contentJob || contentJob.type !== 'content') {
    throw new ConnectorError(
      'CONTENT_SOURCE_JOB_INVALID',
      'The selected source task is not a creator content collection task.',
      'Select a saved creator content collection task before running the analysis matrix.',
    );
  }
  const storedCaptures = await store.loadContentCaptures(contentJob.id, creatorIds);
  const captures = storedCaptures
    .filter((capture) => isValidCreatorRecord(capture))
    .filter((capture) => {
      const target = contentAnalysisTarget(capture);
      return target.targetId && target.channel && target.name && target.sourceUrl;
    });
  if (!captures.length) {
    throw new ConnectorError(
      'CONTENT_ANALYSIS_SOURCE_EMPTY',
      'The source content task has no valid creator content captures to analyze.',
      'Collect visible creator content successfully, then run the analysis matrix.',
    );
  }
  if (!creatorIds) return captures.slice(0, MAX_CONTENT_ANALYSIS_TARGETS);
  const captureByTargetId = new Map(captures.map((capture) => [compactText(capture.targetId || capture.discoveryCreatorId, 180), capture]));
  const missingIds = creatorIds.filter((creatorId) => !captureByTargetId.has(creatorId));
  if (missingIds.length) {
    throw new ConnectorError(
      'CONTENT_CAPTURE_NOT_FOUND',
      'One or more selected creator captures were not found in the source content task.',
      'Refresh the collected content list and select creators from that task.',
    );
  }
  return creatorIds.map((creatorId) => captureByTargetId.get(creatorId));
}

function normalizeResult(platform, source, records, query) {
  if (source === 'partner_http') return normalizePartnerItems(platform, records, query, source);
  if (platform === 'xiaohongshu') return normalizeXiaohongshuNotes(records, query, source);
  if (platform === 'bilibili') return normalizeBilibiliCreators(records, query, source);
  return normalizeDouyinCreators(records, query, source);
}

function discoveryQueriesForInput(input) {
  const supplied = uniqueDiscoveryQueries(input.queryPlan);
  return supplied.length ? supplied : buildDiscoveryQueryPlan(input.query);
}

async function collectDiscoveryQueryPlan(item, input) {
  const queries = discoveryQueriesForInput(input);
  if (queries.length <= 1) return collectPlatform(item.platform, input);

  // Split the channel target across related routes so a broad query does not
  // monopolize a single scroll path. Browser Relay remains serial per channel.
  const routeLimit = Math.max(1, Math.ceil(Math.max(1, input.limit) / queries.length));
  const records = [];
  const routeResults = [];
  let normalizedCreators = [];
  let source = '';
  let sourceUrl = '';
  let truncated = false;

  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const routeDirectory = path.join(input.outputDir, `query-${String(index + 1).padStart(2, '0')}`);
    await fs.mkdir(routeDirectory, { recursive: true });
    input.emit?.({
      message: `${config.platforms[item.platform].label} discovery route ${index + 1}/${queries.length} started (${routeLimit} candidates): ${query}`,
    });

    let collected;
    try {
      collected = await collectPlatform(item.platform, {
        ...input,
        query,
        limit: routeLimit,
        outputDir: routeDirectory,
        queryPlan: undefined,
      });
    } catch (error) {
      routeResults.push({
        query,
        requestedLimit: routeLimit,
        sourceRecords: 0,
        normalizedCreators: 0,
        uniqueCreators: normalizedCreators.length,
        outcome: 'failed',
        error: error?.code || error?.message || 'UNEXPECTED_CONNECTOR_ERROR',
      });
      input.emit?.({
        level: 'warn',
        message: `${config.platforms[item.platform].label} discovery route ${index + 1}/${queries.length} did not complete; retained the prior route results.`,
      });
      if (!normalizedCreators.length) throw error;
      break;
    }

    const routeRecords = Array.isArray(collected.records) ? collected.records : [];
    const routeCreators = normalizeResult(item.platform, collected.source, routeRecords, query);
    records.push(...routeRecords);
    normalizedCreators = dedupeCreators([...normalizedCreators, ...routeCreators]);
    if (!source) source = collected.source;
    if (!sourceUrl) sourceUrl = collected.sourceUrl || '';
    truncated = truncated || Boolean(collected.truncated);
    routeResults.push({
      query,
      requestedLimit: routeLimit,
      sourceRecords: routeRecords.length,
      normalizedCreators: routeCreators.length,
      uniqueCreators: normalizedCreators.length,
      sourceUrl: collected.sourceUrl || null,
      stopReason: collected.collectionMeta?.stop_reason || collected.outcome || null,
      outcome: collected.outcome,
    });
    input.emit?.({
      message: `${config.platforms[item.platform].label} discovery route ${index + 1}/${queries.length} returned ${routeRecords.length} source record(s), ${normalizedCreators.length} unique creator(s).`,
    });
  }

  const creators = normalizedCreators.slice(0, input.limit);
  const lastRoute = routeResults.at(-1);
  return {
    records,
    normalizedCreators: creators,
    source: source || config.platforms[item.platform]?.mode || 'browser_relay',
    sourceUrl,
    collectionMeta: {
      mode: 'multi_query_discovery',
      requested_limit: input.limit,
      query_count: routeResults.length,
      query_plan: routeResults,
      raw_source_records: records.length,
      unique_creators: normalizedCreators.length,
      returned_creators: creators.length,
      sourceSearchUrl: sourceUrl || null,
      stop_reason: creators.length >= input.limit
        ? 'requested_limit_reached'
        : lastRoute?.stopReason || 'query_plan_exhausted',
    },
    outcome: creators.length ? 'succeeded' : 'completed_empty',
    truncated: truncated || normalizedCreators.length > creators.length,
  };
}

function classifyFailure(error) {
  if (CONNECTION_WAIT_CODES.has(error.code)) return 'waiting_for_connection';
  if (CONFIGURATION_WAIT_CODES.has(error.code)) return 'waiting_for_configuration';
  return 'failed';
}

function discoveryStopReason(result) {
  return compactText(
    result?.collectionMeta?.stop_reason || result?.collectionMeta?.stopReason || result?.outcome,
    120,
  ).toLocaleLowerCase();
}

function retryableDiscoveryRoute(result, creatorCount, requestedLimit) {
  if (creatorCount >= requestedLimit) return false;
  const stopReason = discoveryStopReason(result);
  return stopReason.endsWith('_retryable') || new Set([
    'scroll_control_failed',
    'scroll_budget_exhausted',
    'collection_deadline_reached',
    'time_budget_exhausted',
    'navigation_timeout',
    'no_new_unique',
    'no_new_results',
  ]).has(stopReason);
}

function terminalStatus({ successCount, emptyCount, connectionWaitCount, configurationWaitCount, failureCount, retryableCount = 0 }) {
  if (connectionWaitCount) return 'waiting_for_connection';
  if (configurationWaitCount) return 'waiting_for_configuration';
  if (retryableCount) return successCount ? 'partial_success' : 'interrupted';
  if (successCount && !emptyCount && !failureCount) return 'succeeded';
  if (successCount) return 'partial_success';
  if (emptyCount && !failureCount) return 'completed_empty';
  return 'failed';
}

const contentContinuationResumeStates = new Set([
  'continuation_recommended',
  'retryable',
  'resume_recommended',
  'resumable',
  'pending_continuation',
]);

function contentCaptureContinuation(capture) {
  const coverage = capture?.content?.collectionCoverage;
  const completion = compactText(coverage?.completion, 80).toLocaleLowerCase();
  const resumeState = compactText(coverage?.resumeState || coverage?.resume_state, 80).toLocaleLowerCase();
  const continuationRecommended = coverage?.continuationRecommended === true
    || coverage?.continuation_recommended === true;
  return {
    coverage: coverage && typeof coverage === 'object' ? coverage : null,
    completion: completion || null,
    resumeState: resumeState || null,
    continuationRecommended,
    resumable: completion === 'retryable'
      || continuationRecommended
      || contentContinuationResumeStates.has(resumeState),
  };
}

function contentCaptureWorkItemState(capture, visibleContentSamples) {
  const continuation = contentCaptureContinuation(capture);
  if (continuation.resumable) {
    return {
      ...continuation,
      status: 'retryable',
      outcome: 'retryable',
    };
  }
  return {
    ...continuation,
    status: visibleContentSamples ? 'succeeded' : 'completed_empty',
    outcome: visibleContentSamples ? 'succeeded' : 'completed_empty',
  };
}

function isValidCreatorRecord(creator) {
  const identityKey = canonicalCreatorIdentity(creator?.channel, creator?.sourceUrl);
  return Boolean(identityKey)
    && identityKey === creator?.identityKey
    && isUsableCreatorName(creator?.name);
}

function sanitizePersistedJob(job) {
  const savedResults = Array.isArray(job?.results) ? job.results : [];
  const results = savedResults.filter(isValidCreatorRecord);
  if (results.length === savedResults.length) return { job, changed: false };

  const now = new Date().toISOString();
  const resultCountKey = job.type === 'enrich'
    ? 'personas'
    : job.type === 'content'
      ? 'contentCaptures'
      : job.type === 'content_analysis'
        ? 'analyses'
      : 'creators';
  const channelResults = Object.fromEntries(Object.entries(job.channelResults || {}).map(([key, result]) => {
    const matchingCreators = results.filter((creator) => creator.channel === result?.platform
      && (!result?.targetId || creator.targetId === result.targetId));
    const priorCount = Number(result?.[resultCountKey] ?? result?.creators ?? 0);
    const invalidated = priorCount > matchingCreators.length;
    const next = {
      ...result,
      creators: matchingCreators.length,
      ...(job.type === 'enrich' ? { personas: matchingCreators.length } : {}),
      ...(job.type === 'content' ? {
        contentCaptures: matchingCreators.length,
        visibleContentSamples: matchingCreators.reduce(
          (total, creator) => total + contentCaptureVisibleSampleCount(creator),
          0,
        ),
      } : {}),
      ...(job.type === 'content_analysis' ? {
        analyses: matchingCreators.length,
        visibleContentSamples: matchingCreators.reduce(
          (total, creator) => total + (creator.analysis?.coverage?.visibleSampleCount || 0),
          0,
        ),
      } : {}),
    };
    if (invalidated && result?.status === 'succeeded' && !matchingCreators.length) {
      next.status = 'completed_empty';
      next.outcome = 'completed_empty';
      next.error = {
        code: 'HISTORICAL_CREATOR_INVALIDATED',
        message: 'Historical candidate records no longer pass creator profile validation.',
        action: 'Run the collection again to obtain current candidate records.',
      };
    }
    return [key, next];
  }));
  const values = Object.values(channelResults);
  const jobStatus = values.length ? terminalStatus({
    successCount: values.filter((result) => result.status === 'succeeded').length,
    emptyCount: values.filter((result) => result.status === 'completed_empty').length,
    connectionWaitCount: values.filter((result) => result.status === 'waiting_for_connection').length,
    configurationWaitCount: values.filter((result) => result.status === 'waiting_for_configuration').length,
    retryableCount: values.filter((result) => result.status === 'retryable').length,
    failureCount: values.filter((result) => result.status === 'failed').length,
  }) : job.status;
  const events = [...(Array.isArray(job.events) ? job.events : [])];
  events.push({
    at: now,
    level: 'warn',
    message: `Discarded ${savedResults.length - results.length} historical creator record(s) without a valid platform profile identity.`,
  });
  if (events.length > 180) events.splice(0, events.length - 180);
  return {
    job: {
      ...job,
      status: jobStatus,
      results,
      channelResults,
      metrics: {
        ...(job.metrics || {}),
        creators: results.length,
        verifiedCreators: job.type === 'verify' ? results.length : 0,
        verifiedTargets: job.type === 'verify' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
        enrichedCreators: job.type === 'enrich' ? results.length : 0,
        enrichedTargets: job.type === 'enrich' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
        contentCaptures: job.type === 'content' ? results.length : 0,
        contentTargets: job.type === 'content' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
        visibleContentSamples: job.type === 'content'
          ? results.reduce((total, creator) => total + contentCaptureVisibleSampleCount(creator), 0)
          : job.type === 'content_analysis'
            ? results.reduce((total, creator) => total + (creator.analysis?.coverage?.visibleSampleCount || 0), 0)
          : 0,
        analyzedCreators: job.type === 'content_analysis' ? results.length : 0,
        analysisTargets: job.type === 'content_analysis' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
        channelsSucceeded: values.filter((result) => result.status === 'succeeded').length,
        channelsEmpty: values.filter((result) => result.status === 'completed_empty').length,
        retryableRoutes: job.type === 'discover'
          ? values.filter((result) => result.status === 'retryable').length
          : 0,
      },
      events,
      updatedAt: now,
    },
    changed: true,
  };
}

function channelResultKey(item) {
  if (item.route) return `${item.platform}:route:${item.route.index + 1}`;
  return item.target ? `${item.platform}:${item.target.targetId}` : item.platform;
}

function verifiedTargetCreators(platform, target, creators) {
  const targetIdentity = canonicalCreatorIdentity(platform, target.sourceUrl);
  if (!targetIdentity) return [];
  return creators
    .filter((creator) => creator.identityKey === targetIdentity)
    .map((creator) => ({
      ...creator,
      targetId: target.targetId,
      targetSourceUrl: target.sourceUrl,
      verification: {
        status: 'verified',
        targetId: target.targetId,
        identityKey: targetIdentity,
        expectedName: target.name,
        observedName: creator.name,
        matchMethod: 'direct_profile_url',
      },
    }));
}

async function collectWorkItem(item, input) {
  const mode = config.platforms[item.platform]?.mode;
  const invoke = () => (
    input.mode === 'discover' && !item.target && !item.route
      ? collectDiscoveryQueryPlan(item, input)
      : collectPlatform(item.platform, input)
  );
  return mode === 'browser_relay' ? runWithBrowserRelayLock(invoke) : invoke();
}

const completedWorkItemStatuses = new Set(['succeeded', 'completed_empty']);

function completedWorkItem(result) {
  return completedWorkItemStatuses.has(result?.status);
}

function pendingWorkItems(job) {
  const channelResults = job?.channelResults || {};
  return jobWorkItems(job).filter((item) => !completedWorkItem(channelResults[channelResultKey(item)]));
}

function workItemResultValues(job, channelResults) {
  const results = channelResults || {};
  return jobWorkItems(job)
    .map((item) => results[channelResultKey(item)])
    .filter(Boolean);
}

function collectionCounts(channelResults) {
  const results = Array.isArray(channelResults) ? channelResults : Object.values(channelResults || {});
  return {
    successCount: results.filter((result) => result.status === 'succeeded').length,
    emptyCount: results.filter((result) => result.status === 'completed_empty').length,
    connectionWaitCount: results.filter((result) => result.status === 'waiting_for_connection').length,
    configurationWaitCount: results.filter((result) => result.status === 'waiting_for_configuration').length,
    retryableCount: results.filter((result) => result.status === 'retryable').length,
    failureCount: results.filter((result) => result.status === 'failed').length,
  };
}

function collectionMetrics(job, channelResults, results) {
  const values = workItemResultValues(job, channelResults);
  return {
    sourceRecords: values.reduce((total, result) => total + (result.records || 0), 0),
    ...(job.type === 'discover' ? {
      requestedCandidates: Math.max(0, Number(job.limit) || 0) * Math.max(1, Array.isArray(job.channels) ? job.channels.length : 1),
      connectorCandidateBudget: values.reduce((total, result) => total + (Number(result.requestedLimit) || 0), 0),
      // A route that was skipped after its channel reached the requested
      // unique-account target is a completed checkpoint, not an additional
      // search request. Keep the live coverage counter honest about browser
      // work that was actually performed.
      queryRoutes: values.reduce((total, result) => {
        const count = Number(result.queryCount);
        return total + (Number.isFinite(count) ? Math.max(0, count) : 1);
      }, 0),
      plannedQueryRoutes: jobWorkItems(job).filter((item) => item.route).length,
      skippedTargetReachedRoutes: values.filter((result) => result.skipped === true).length,
      uniqueSourceRecords: values.reduce((total, result) => total + (Number(result.uniqueSourceRecords) || result.creators || 0), 0),
      publicPageCards: values.reduce((total, result) => total + (Number(result.collectionMeta?.cumulative_public_page_cards) || 0), 0),
      publicUniqueAccounts: values.reduce((total, result) => total + (Number(result.collectionMeta?.cumulative_unique_accounts) || 0), 0),
      newUniqueCreators: values.reduce((total, result) => total + (Number(result.newUniqueCreators) || 0), 0),
      duplicateWithinRoutes: values.reduce((total, result) => total + (Number(result.duplicateWithinRoute) || 0), 0),
      duplicateAcrossRoutes: values.reduce((total, result) => total + (Number(result.duplicateFromPreviousRoutes) || 0), 0),
      retryableRoutes: values.filter((result) => result.status === 'retryable').length,
      exhaustedRoutes: values.filter((result) => result.completionReason === 'page_exhausted').length,
    } : {}),
    creators: results.length,
    verifiedCreators: job.type === 'verify' ? results.length : 0,
    verifiedTargets: job.type === 'verify' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
    enrichedCreators: job.type === 'enrich' ? results.length : 0,
    enrichedTargets: job.type === 'enrich' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
    contentCaptures: job.type === 'content' ? results.length : 0,
    contentTargets: job.type === 'content' ? new Set(results.map((creator) => creator.targetId).filter(Boolean)).size : 0,
    visibleContentSamples: job.type === 'content'
      ? results.reduce((total, creator) => total + contentCaptureVisibleSampleCount(creator), 0)
      : 0,
    retryableContentCaptures: job.type === 'content'
      ? values.filter((result) => result.status === 'retryable').length
      : 0,
        channelsSucceeded: values.filter((result) => result.status === 'succeeded' && result.skipped !== true).length,
    channelsEmpty: values.filter((result) => result.status === 'completed_empty').length,
    pendingWorkItems: pendingWorkItems({ ...job, channelResults }).length,
    completedAt: new Date().toISOString(),
  };
}

function contentCaptureForChannelResult(captures, channelResult) {
  const targetId = compactText(channelResult?.targetId, 180);
  const sourceUrl = compactText(channelResult?.targetSourceUrl, 800);
  return (Array.isArray(captures) ? captures : []).find((capture) => (
    (targetId && capture?.targetId === targetId)
    || (!targetId && sourceUrl && capture?.sourceUrl === sourceUrl)
  )) || null;
}

function contentCaptureProfileMetricCount(capture) {
  const profile = capture?.profile || {};
  return [profile.followerCount, profile.followingCount, profile.totalLikes, profile.workCount]
    .filter(Number.isFinite).length;
}

const fullCardProfileFields = [
  ['followerCount', 'followers'],
  ['totalLikes', 'totalLikes'],
  ['workCount', 'works'],
];

function contentCaptureProfileResolution(capture) {
  const profile = capture?.profile || {};
  const missingReasons = profile.missingReasons || {};
  const resolvedFields = fullCardProfileFields.filter(([valueKey, reasonKey]) => (
    Number.isFinite(profile[valueKey]) || Boolean(compactText(missingReasons[reasonKey], 180))
  )).length;
  const valueFields = fullCardProfileFields.filter(([valueKey]) => Number.isFinite(profile[valueKey])).length;
  return {
    resolved: resolvedFields === fullCardProfileFields.length,
    resolvedFields,
    valueFields,
  };
}

function contentCardCoverageMetrics(captures, channelResults, targetCount = 0) {
  const captureList = Array.isArray(captures) ? captures : [...(captures?.values?.() || [])];
  const resultValues = Object.values(channelResults || {});
  let profileResolvedCount = 0;
  let profileValueCoverageCount = 0;
  let catalogCoverageCount = 0;
  let detailCoverageCount = 0;
  let fullCardCoverageCount = 0;

  for (const result of resultValues) {
    const capture = contentCaptureForChannelResult(captureList, result);
    if (!capture) continue;
    const profileResolution = contentCaptureProfileResolution(capture);
    const completedPhases = new Set(Array.isArray(result?.completedPhases) ? result.completedPhases : []);
    const continuation = contentCaptureContinuation(capture);
    const profileResolved = completedPhases.has('profile') && profileResolution.resolved;
    const catalogResolved = completedPhases.has('catalog') && !continuation.resumable;
    const detailResolved = completedPhases.has('detail');
    const terminal = completedWorkItem(result);
    if (profileResolved) profileResolvedCount += 1;
    if (profileResolution.valueFields === fullCardProfileFields.length) profileValueCoverageCount += 1;
    if (catalogResolved) catalogCoverageCount += 1;
    if (detailResolved) detailCoverageCount += 1;
    if (profileResolved && catalogResolved && detailResolved && terminal) fullCardCoverageCount += 1;
  }

  const total = Math.max(0, Number(targetCount) || resultValues.length || captureList.length);
  return {
    profileResolvedCount,
    profileValueCoverageCount,
    catalogCoverageCount,
    detailCoverageCount,
    fullCardCoverageCount,
    remainingCardCount: Math.max(0, total - fullCardCoverageCount),
  };
}

function recoverContentContinuationState(job) {
  if (job?.type !== 'content') return { changed: false, job };
  const captures = Array.isArray(job.results) ? job.results : [];
  const channelResults = { ...(job.channelResults || {}) };
  const resumedTargetIds = [];
  let changed = false;

  for (const [key, result] of Object.entries(channelResults)) {
    const capture = contentCaptureForChannelResult(captures, result);
    const continuation = contentCaptureContinuation(capture);
    if (!continuation.resumable) continue;
    const completedPhases = contentResumeCompletedPhases({
      strategy: job.strategy,
      completedPhases: result.completedPhases,
      resumable: continuation.resumable,
    });
    const next = {
      ...result,
      completedPhases,
      status: 'retryable',
      outcome: 'retryable',
      retryable: true,
      contentCollectionCoverage: continuation.coverage,
      completion: continuation.completion,
      resumeState: continuation.resumeState,
      continuationRecommended: continuation.continuationRecommended,
    };
    const needsUpdate = result.status !== next.status
      || result.outcome !== next.outcome
      || result.retryable !== next.retryable
      || result.completion !== next.completion
      || result.resumeState !== next.resumeState
      || result.continuationRecommended !== next.continuationRecommended
      || result.contentCollectionCoverage?.completion !== next.contentCollectionCoverage?.completion
      || result.contentCollectionCoverage?.resumeState !== next.contentCollectionCoverage?.resumeState
      || JSON.stringify(result.completedPhases || []) !== JSON.stringify(next.completedPhases);
    if (!needsUpdate) continue;
    channelResults[key] = next;
    resumedTargetIds.push(result.targetId || key);
    changed = true;
  }

  if (!changed) return { changed: false, job };
  const metrics = collectionMetrics({ ...job, channelResults }, channelResults, captures);
  return {
    changed: true,
    resumedTargetIds,
    job: {
      ...job,
      status: terminalStatus(collectionCounts(channelResults)),
      channelResults,
      metrics,
      error: null,
    },
  };
}

function contentAnalysisMetrics(job, channelResults, analyses) {
  const values = Object.values(channelResults || {});
  const modelStatuses = analyses.map((entry) => entry?.analysis?.model?.status).filter(Boolean);
  const modes = analyses.map((entry) => entry?.analysis?.mode).filter(Boolean);
  const videoCoverage = analyses.map((entry) => entry?.analysis?.video?.coverage || {});
  const orchestrations = analyses.map((entry) => entry?.analysis?.orchestration).filter(Boolean);
  const agentRuns = orchestrations.flatMap((entry) => [
    ...(Array.isArray(entry?.agents) ? entry.agents : []),
    ...(entry?.synthesis ? [entry.synthesis] : []),
  ]);
  return {
    targetCreators: Array.isArray(job.sourceCaptures) ? job.sourceCaptures.length : 0,
    analyzedCreators: analyses.length,
    analysisTargets: new Set(analyses.map((entry) => entry.targetId).filter(Boolean)).size,
    findings: contentAnalysisFindingCount(analyses),
    visibleContentSamples: analyses.reduce(
      (total, entry) => total + (entry?.analysis?.coverage?.visibleSampleCount || 0),
      0,
    ),
    channelsSucceeded: values.filter((result) => result.status === 'succeeded').length,
    channelsEmpty: values.filter((result) => result.status === 'completed_empty').length,
    modelCompletedCreators: modelStatuses.filter((status) => status === 'completed').length,
    deterministicCreators: modes.filter((mode) => mode === 'deterministic_evidence_matrix').length,
    modelFallbackCreators: modelStatuses.filter((status) => status === 'fallback').length,
    codexMultiAgentCreators: orchestrations.filter((entry) => entry.id === 'codex_multi_agent').length,
    completedAgentRuns: agentRuns.filter((entry) => ['completed', 'completed_cached'].includes(entry.status)).length,
    activeAgentRuns: agentRuns.filter((entry) => entry.status === 'running').length,
    eligibleVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.eligibleVideoSampleCount || 0), 0),
    selectedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.selectedVideoSampleCount || 0), 0),
    processedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.processedVideoSampleCount || coverage.selectedVideoSampleCount || 0), 0),
    checkpointReusedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.checkpointReusedSampleCount || 0), 0),
    unprocessedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.unprocessedVideoSampleCount || 0), 0),
    fullVideoCoverageCreators: videoCoverage.filter((coverage) => coverage.analysisScope === 'all_visible_video_samples').length,
    renderedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.renderedMediaSampleCount || 0), 0),
    sampledVideoFrames: videoCoverage.reduce((total, coverage) => total + (coverage.sampledFrameCount || 0), 0),
    ocrTextFrames: videoCoverage.reduce((total, coverage) => total + (coverage.ocrTextFrameCount || 0), 0),
    visualSemanticVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.visualSemanticSampleCount || 0), 0),
    visualSemanticFrames: videoCoverage.reduce((total, coverage) => total + (coverage.visualSemanticFrameCount || 0), 0),
    transcribedVideoSamples: videoCoverage.reduce((total, coverage) => total + (coverage.transcriptAvailableSampleCount || 0), 0),
    pendingWorkItems: pendingWorkItems({ ...job, channelResults }).length,
    sourceContentJobId: job.contentJobId || null,
    completedAt: new Date().toISOString(),
  };
}

function contentAgentRuntime(analysisConfig = config.analysis.content) {
  const remote = analysisConfig.provider === 'openai_responses';
  const evidenceOnly = !analysisConfig.enabled && analysisConfig.orchestration === 'evidence_matrix';
  const id = evidenceOnly
    ? 'evidence_matrix'
    : remote && analysisConfig.orchestration !== 'evidence_matrix'
      ? 'codex_multi_agent'
      : remote
        ? 'openai_responses_matrix'
        : 'ollama_local_matrix';
  return {
    id,
    label: id === 'evidence_matrix'
      ? '证据矩阵'
      : id === 'codex_multi_agent'
      ? 'Codex \u591a Agent'
      : id === 'ollama_local_matrix'
        ? '\u672c\u5730\u6a21\u578b\u77e9\u9635'
        : 'Responses \u8bc1\u636e\u77e9\u9635',
    configured: Boolean(analysisConfig.enabled),
    provider: analysisConfig.provider,
    model: analysisConfig.model || null,
    specialistAgentCount: contentAnalysisRoles.length,
    creatorConcurrency: remote ? analysisConfig.remoteConcurrency : 1,
    requestConcurrency: remote ? analysisConfig.requestConcurrency : 1,
  };
}

function contentAnalysisRuntimeConfig(job) {
  const content = job?.contentModelPreference === 'evidence_matrix'
    ? {
      ...config.analysis.content,
      enabled: false,
      model: '',
      orchestration: 'evidence_matrix',
    }
    : config.analysis.content;
  const video = job?.videoVisionPreference === 'keyframes_only'
    ? {
      ...config.analysis.video,
      vision: {
        ...config.analysis.video.vision,
        enabled: false,
        model: '',
      },
    }
    : config.analysis.video;
  return { content, video };
}

function normalizedResults(job, allCreators) {
  return job.type === 'verify' ? allCreators : dedupeCreators(allCreators);
}

function uniqueCreatorCountForPlatform(identities, platform) {
  const prefix = `${platform}:`;
  let count = 0;
  for (const identity of identities) {
    if (String(identity || '').startsWith(prefix)) count += 1;
  }
  return count;
}

function discoveryRouteSchedule({ job, item, position, pendingItems, channelResults, knownCreatorIdentities }) {
  if (job.type !== 'discover' || !item.route) {
    return {
      requestedLimit: job.type === 'verify' ? Math.min(job.limit, 8) : job.limit,
      remainingTarget: null,
      remainingRoutes: null,
      shouldSkip: false,
    };
  }

  const target = Math.max(1, Number(job.limit) || 1);
  const collectedUnique = uniqueCreatorCountForPlatform(knownCreatorIdentities, item.platform);
  const remainingTarget = Math.max(0, target - collectedUnique);
  const remainingRoutes = pendingItems
    .slice(position)
    .filter((entry) => entry.item.platform === item.platform && entry.item.route)
    .length;
  if (!remainingTarget) {
    return { requestedLimit: 0, remainingTarget, remainingRoutes, shouldSkip: true };
  }

  // Give every route a stable share of a bounded duplicate headroom. Stable
  // quotas keep retries idempotent and prevent sparse early routes from making
  // the final route absorb the entire unresolved unique-creator target.
  const plannedBudget = Math.ceil(Number((target * config.collection.discoveryRouteOverfetchRatio).toFixed(6)));
  const routeCount = Math.max(1, Number(item.route.total) || remainingRoutes);
  const requestedLimit = Math.max(1, Math.ceil(plannedBudget / routeCount));

  return { requestedLimit, remainingTarget, remainingRoutes, shouldSkip: false };
}

async function collectArtifactManifest(rootDirectory, directory = rootDirectory) {
  const directories = [directory];
  const artifacts = [];

  // A breadth-first, fixed-size batch prevents a profile with many screenshots
  // or raw JSON files from serializing every stat/read/hash operation.
  while (directories.length) {
    const directoryBatch = directories.splice(0, ARTIFACT_MANIFEST_IO_CONCURRENCY);
    const listings = await Promise.all(directoryBatch.map(async (currentDirectory) => {
      try {
        return {
          directory: currentDirectory,
          entries: await fs.readdir(currentDirectory, { withFileTypes: true }),
        };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }));
    const files = [];
    for (const listing of listings) {
      if (!listing) continue;
      for (const entry of listing.entries) {
        const filePath = path.join(listing.directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(filePath);
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !ARTIFACT_EXTENSIONS.has(extension)) continue;
        files.push({ filePath, name: entry.name });
      }
    }

    while (files.length) {
      const fileBatch = files.splice(0, ARTIFACT_MANIFEST_IO_CONCURRENCY);
      const metadata = await Promise.all(fileBatch.map(async ({ filePath, name }) => {
        const id = path.relative(rootDirectory, filePath).split(path.sep).join('/');
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_ARTIFACT_BYTES) {
          return {
            id,
            name,
            bytes: stat.size,
            collectedAt: stat.mtime.toISOString(),
            schemaVersion: 1,
            downloadable: false,
            unavailableReason: `The raw source file exceeds the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB product download limit.`,
          };
        }
        const content = await fs.readFile(filePath);
        return {
          id,
          name,
          bytes: stat.size,
          sha256: createHash('sha256').update(content).digest('hex'),
          collectedAt: stat.mtime.toISOString(),
          schemaVersion: 1,
          downloadable: true,
        };
      }));
      artifacts.push(...metadata);
    }
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id));
}

async function artifactsForJob(job) {
  const persisted = Object.values(job.channelResults || {})
    .flatMap((result) => Array.isArray(result.artifacts) ? result.artifacts : []);
  const scanned = await collectArtifactManifest(store.jobsDirectory(job.id));
  const artifacts = new Map(persisted.map((artifact) => [artifact.id, artifact]));
  for (const artifact of scanned) artifacts.set(artifact.id, artifact);
  return [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id)).map((artifact) => ({
    ...artifact,
    downloadUrl: artifact.downloadable === false ? null : `/api/jobs/${encodeURIComponent(job.id)}/artifacts/${artifact.id.split('/').map(encodeURIComponent).join('/')}`,
  }));
}

function mergedEvidenceForVideoProjection(existingEvidence, projectedEvidence) {
  const rowsById = new Map();
  [...(Array.isArray(projectedEvidence) ? projectedEvidence : []), ...(Array.isArray(existingEvidence) ? existingEvidence : [])]
    .forEach((entry, index) => {
      const id = compactText(entry?.id, 240) || `projection-evidence-${index + 1}`;
      rowsById.set(id, entry);
    });
  return [...rowsById.values()];
}

function withVideoAnalysisProjection(record, capture) {
  const analysis = record?.analysis;
  if (!analysis || !capture) return analysis;
  const existingVideoAnalysis = analysis.videoAnalysis;
  if (Array.isArray(existingVideoAnalysis?.items) && existingVideoAnalysis?.rollup) return analysis;

  const videoEvidence = analysis.video || capture?.content?.videoEvidence || null;
  const captureWithSavedVideoEvidence = {
    ...capture,
    content: {
      ...(capture.content || {}),
      ...(videoEvidence ? { videoEvidence } : {}),
    },
  };
  const projected = deriveContentAnalysis({
    capture: captureWithSavedVideoEvidence,
    capturedAt: compactText(analysis.capturedAt || record.analyzedAt || capture.capturedAt, 80) || new Date().toISOString(),
  });

  return {
    ...analysis,
    video: analysis.video || projected.video,
    evidence: mergedEvidenceForVideoProjection(analysis.evidence, projected.evidence),
    videoAnalysis: projected.videoAnalysis,
  };
}

function contentAnalysisRowsWithFreshness(job) {
  const sourceJob = job?.contentJobId ? store.get(job.contentJobId) : null;
  const sourceByTargetId = new Map((Array.isArray(sourceJob?.results) ? sourceJob.results : [])
    .map((capture) => [compactText(capture?.targetId || capture?.discoveryCreatorId, 180), capture]));
  const savedSourceByTargetId = new Map((Array.isArray(job?.sourceCaptures) ? job.sourceCaptures : [])
    .map((capture) => [compactText(capture?.targetId || capture?.discoveryCreatorId, 180), capture]));
  return (Array.isArray(job?.results) ? job.results : []).map((record) => {
    const targetId = compactText(record?.targetId, 180);
    const currentCapture = sourceByTargetId.get(targetId);
    const projectionCapture = savedSourceByTargetId.get(targetId) || currentCapture || null;
    const priorFingerprint = compactText(record?.analysis?.source?.inputFingerprint, 128);
    const currentFingerprint = currentCapture
      ? compactText(currentCapture.inputFingerprint, 128) || contentInputFingerprint(currentCapture)
      : '';
    const freshness = !currentCapture
      ? 'source_capture_unavailable'
      : !priorFingerprint
        ? 'input_fingerprint_unavailable'
        : currentFingerprint === priorFingerprint
          ? 'current_snapshot'
          : 'stale_source_changed';
    return {
      ...record,
      analysis: {
        ...withVideoAnalysisProjection(record, projectionCapture),
        source: {
          ...(record.analysis?.source || {}),
          freshness,
          currentContentCapturedAt: currentCapture ? compactText(currentCapture.capturedAt, 80) || null : null,
        },
      },
    };
  });
}

const CONTENT_HISTORY_MAX_PAGE_LIMIT = 200;

function contentHistoryRecordId(recordType, jobId, targetId = '') {
  return `${recordType}:${jobId}:${encodeURIComponent(targetId || '')}`;
}

function postSearchHistorySnapshot(job) {
  if (job?.type !== 'post_search') return null;
  const result = job?.result && typeof job.result === 'object' ? job.result : {};
  const posts = Array.isArray(result.posts) ? result.posts : [];
  const total = Number.isFinite(Number(result.total)) ? Number(result.total) : posts.length;
  return {
    ...result,
    query: result.query || job.query || '',
    posts,
    total,
    capturedAt: result.capturedAt || job.finishedAt || job.updatedAt || job.createdAt || null,
  };
}

function postSearchJobRecord(job) {
  const result = job?.result && typeof job.result === 'object' ? job.result : {};
  const target = job?.target && typeof job.target === 'object' ? job.target : {};
  const post = (result.post && typeof result.post === 'object' ? result.post : null)
    || (target.post && typeof target.post === 'object' ? target.post : null)
    || {};
  const posts = Array.isArray(result.posts) ? result.posts : [];
  const comments = Array.isArray(result.comments) ? result.comments : [];
  const frames = Array.isArray(result.video?.frames) ? result.video.frames : [];
  const hotCommentCount = posts.reduce((total, item) => total + (Array.isArray(item?.comments) ? Math.min(10, item.comments.length) : 0), 0);
  const commentedPostCount = posts.reduce((total, item) => total + (Array.isArray(item?.comments) && item.comments.length ? 1 : 0), 0);
  const postId = compactText(result.postId || post.postId || target.postId, 180);
  const sourceUrl = compactText(
    result.sourceUrl || result.postUrl || post.contentUrl || post.sourceUrl || target.postUrl,
    1200,
  );
  const sampleCount = job.type === 'post_search'
    ? posts.length
    : job.type === 'post_search_comments'
      ? comments.length
      : frames.length;
  const name = job.type === 'post_search'
    ? `搜索：${job.query || '未设置关键词'}`
    : job.type === 'post_search_comments'
      ? `热评：${post.title || post.authorName || postId || '选定帖子'}`
      : `关键帧：${post.title || post.authorName || postId || '选定视频'}`;
  return {
    targetId: postId,
    name,
    handle: compactText(post.authorName || target.authorName, 120),
    sourceUrl,
    sampleCount,
    postCount: posts.length,
    commentCount: job.type === 'post_search' ? hotCommentCount : comments.length,
    hotCommentCount,
    commentedPostCount,
    frameCount: frames.length,
    post,
  };
}

function contentHistoryMatches(record, job, query, channel) {
  if (channel && record?.channel !== channel) return false;
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const postSearch = ['post_search', 'post_search_comments', 'post_search_media'].includes(job?.type)
    ? postSearchJobRecord(job)
    : null;
  return [
    job?.query,
    record?.targetId,
    record?.name,
    record?.handle,
    record?.sourceUrl,
    record?.platform,
    postSearch?.name,
    postSearch?.post?.title,
    postSearch?.post?.authorName,
  ].some((value) => String(value || '').toLowerCase().includes(needle));
}

function contentHistorySummary(job, record, recordType) {
  const isPostSearchJob = recordType === 'job'
    && ['post_search', 'post_search_comments', 'post_search_media'].includes(job?.type);
  const postSearch = isPostSearchJob ? postSearchJobRecord(job) : null;
  const targetId = compactText(record?.targetId || record?.discoveryCreatorId || postSearch?.targetId, 180);
  const isAnalysis = recordType === 'analysis';
  const analysis = isAnalysis ? record?.analysis || null : null;
  const sampleCount = isAnalysis
    ? Number(analysis?.coverage?.summaryObservedSampleCount ?? analysis?.contentItems?.length) || 0
    : isPostSearchJob ? postSearch.sampleCount : Number(record?.content?.visibleSampleCount) || 0;
  return {
    id: contentHistoryRecordId(recordType, job.id, targetId),
    recordType,
    jobId: job.id,
    sourceContentJobId: isAnalysis ? record?.sourceContentJobId || null : job.id,
    query: job.query || '',
    channel: record?.channel || record?.platform || job.channels?.[0] || null,
    platform: record?.platform || record?.channel || job.channels?.[0] || null,
    jobType: job.type || null,
    taskLabel: isPostSearchJob ? postSearchJobRecord(job).name : null,
    targetId: targetId || null,
    name: record?.name || postSearch?.name || null,
    handle: record?.handle || record?.profile?.handle || postSearch?.handle || null,
    sourceUrl: record?.sourceUrl || postSearch?.sourceUrl || null,
    capturedAt: record?.capturedAt || record?.analyzedAt || job.updatedAt || job.createdAt || null,
    updatedAt: job.updatedAt || job.createdAt || null,
    status: record?.status || job.status || null,
    sampleCount,
    findingCount: isAnalysis ? contentAnalysisFindingCount([record]) : 0,
    profile: record?.profile || null,
    content: record?.content || null,
    postSearch: postSearch ? {
      postCount: postSearch.postCount,
      commentCount: postSearch.commentCount,
      hotCommentCount: postSearch.hotCommentCount,
      commentedPostCount: postSearch.commentedPostCount,
      frameCount: postSearch.frameCount,
      postId: postSearch.targetId || null,
    } : null,
    analysis: isAnalysis ? {
      mode: analysis?.mode || null,
      freshness: analysis?.source?.freshness || null,
      roleCount: Array.isArray(analysis?.roles) ? analysis.roles.length : 0,
    } : null,
    job: jobSummary(job),
  };
}

async function contentHistoryRecords({ query = '', channel = '', recordType = 'all', includeDetails = false, recordId = '' } = {}) {
  const records = [];
  const jobs = store.listAll();
  for (const job of jobs) {
    if (['post_search', 'post_search_comments', 'post_search_media'].includes(job.type)
      && ['all', 'job'].includes(recordType)) {
      const current = contentHistorySummary(job, null, 'job');
      if ((!recordId || current.id === recordId) && contentHistoryMatches(current, job, query, channel)) {
        records.push({
          record: current,
          ...(includeDetails ? {
            content: null,
            analysis: null,
            job,
            postSearchSnapshot: postSearchHistorySnapshot(job),
          } : {}),
        });
      }
    }
    if (!['content', 'content_analysis'].includes(job.type)) continue;
    if (job.type === 'content' && ['all', 'content', 'job'].includes(recordType)) {
      const summaries = store.listAllContent(job.id);
      for (const summary of summaries) {
        const current = contentHistorySummary(job, summary, 'content');
        if (!contentHistoryMatches(current, job, query, channel)) continue;
        if (recordId && current.id !== recordId) continue;
        const capture = includeDetails
          ? (await store.loadContentCaptures(job.id, [current.targetId]))[0] || null
          : null;
        records.push({
          record: current,
          ...(includeDetails ? { content: capture, analysis: null, job: null } : {}),
        });
      }
      if (!summaries.length && ['all', 'job'].includes(recordType)) {
        const current = contentHistorySummary(job, null, 'job');
        if ((!recordId || current.id === recordId) && contentHistoryMatches(current, job, query, channel)) records.push({ record: current, ...(includeDetails ? { content: null, analysis: null, job } : {}) });
      }
    }
    if (job.type === 'content_analysis' && ['all', 'analysis', 'job'].includes(recordType)) {
      const analyses = contentAnalysisRowsWithFreshness(job);
      for (const analysisRecord of analyses) {
        const current = contentHistorySummary(job, analysisRecord, 'analysis');
        if (!contentHistoryMatches(current, job, query, channel)) continue;
        if (recordId && current.id !== recordId) continue;
        let sourceCapture = null;
        if (includeDetails && analysisRecord.sourceContentJobId && current.targetId) {
          sourceCapture = (await store.loadContentCaptures(analysisRecord.sourceContentJobId, [current.targetId]))[0] || null;
        }
        records.push({
          record: current,
          ...(includeDetails ? { content: sourceCapture, analysis: analysisRecord, job: null } : {}),
        });
      }
      if (!analyses.length && ['all', 'job'].includes(recordType)) {
        const current = contentHistorySummary(job, null, 'job');
        if ((!recordId || current.id === recordId) && contentHistoryMatches(current, job, query, channel)) records.push({ record: current, ...(includeDetails ? { content: null, analysis: null, job } : {}) });
      }
    }
  }
  records.sort((left, right) => String(right.record.updatedAt || right.record.capturedAt || '').localeCompare(String(left.record.updatedAt || left.record.capturedAt || '')));
  return records;
}

function artifactPathFor(jobId, artifactId) {
  let decoded;
  try {
    decoded = decodeURIComponent(artifactId || '');
  } catch {
    return '';
  }
  if (!decoded || decoded.includes('\0') || !ARTIFACT_EXTENSIONS.has(path.extname(decoded).toLowerCase())) return '';
  const root = path.resolve(store.jobsDirectory(jobId));
  const candidate = path.resolve(root, decoded);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : '';
}

function artifactDownloadUrl(jobId, artifactPath) {
  if (!jobId || typeof artifactPath !== 'string') return '';
  const segments = artifactPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) return '';
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

async function proxyPostSearchMedia(response, request, platform, value, kind = 'video') {
  const isImage = kind === 'image';
  const remoteUrl = isImage ? candidateImageUrl(platform, value) : candidateMediaUrl(platform, value);
  if (!remoteUrl) {
    sendError(response, 400, 'POST_MEDIA_URL_INVALID', `The requested platform ${isImage ? 'image' : 'video'} URL is not allowed.`);
    return;
  }
  const headers = mediaRequestHeaders(platform, remoteUrl, { kind });
  const range = String(request.headers.range || '').trim();
  if (/^bytes=\d*-\d*(?:,\d*-\d*)?$/.test(range)) headers.Range = range;
  let upstream;
  try {
    upstream = await fetch(remoteUrl, { headers, redirect: 'follow' });
  } catch {
    sendError(response, 502, 'POST_MEDIA_PROXY_FAILED', 'The platform media stream could not be reached.');
    return;
  }
  if (!upstream.ok && upstream.status !== 206) {
    sendError(response, 502, 'POST_MEDIA_PROXY_FAILED', 'The platform media stream did not return playable media.');
    return;
  }
  const contentType = upstream.headers.get('content-type') || (isImage ? 'image/jpeg' : 'video/mp4');
  if (isImage && !contentType.toLowerCase().startsWith('image/')) {
    sendError(response, 502, 'POST_MEDIA_PROXY_FAILED', 'The platform image URL did not return an image.');
    return;
  }
  const responseHeaders = {
    'content-type': contentType,
    'cache-control': 'private, max-age=60',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
  };
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const headerValue = upstream.headers.get(name);
    if (headerValue) responseHeaders[name] = headerValue;
  }
  allowLocalDevCors(request, response);
  response.writeHead(upstream.status, responseHeaders);
  if (request.method === 'HEAD' || !upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
}

async function runCollection(jobId, { resume = false } = {}) {
  const initial = store.get(jobId);
  if (!initial) return;
  const allWorkItems = jobWorkItems(initial);
  const channelResults = resume ? { ...(initial.channelResults || {}) } : {};
  const allCreators = resume ? [...(initial.results || [])] : [];
  const knownCreatorIdentities = new Set(allCreators
    .map((creator) => creator?.identityKey || canonicalCreatorIdentity(creator?.channel, creator?.sourceUrl))
    .filter(Boolean));
  const pendingItems = allWorkItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !resume || !completedWorkItem(channelResults[channelResultKey(item)]));
  const completedItems = allWorkItems.length - pendingItems.length;
  let connectionPause = null;

  store.patch(jobId, {
    status: 'running',
    progress: allWorkItems.length ? Math.max(3, Math.round((completedItems / allWorkItems.length) * 92)) : 3,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
  store.addEvent(jobId, { message: `${resume ? 'Collection resumed' : 'Collection started'} with ${pendingItems.length} pending connector work item(s).` });

  for (let position = 0; position < pendingItems.length; position += 1) {
    const { item, index } = pendingItems[position];
    const platform = config.platforms[item.platform];
    const key = channelResultKey(item);
    const routeSchedule = discoveryRouteSchedule({
      job: initial,
      item,
      position,
      pendingItems,
      channelResults,
      knownCreatorIdentities,
    });

    if (routeSchedule.shouldSkip) {
      channelResults[key] = {
        platform: item.platform,
        label: platform.label,
        targetId: null,
        targetName: null,
        targetSourceUrl: null,
        records: 0,
        creators: 0,
        requestedLimit: 0,
        queryCount: 0,
        rawSourceRecords: 0,
        uniqueSourceRecords: 0,
        newUniqueCreators: 0,
        duplicateWithinRoute: 0,
        duplicateFromPreviousRoutes: 0,
        completionReason: 'channel_target_reached',
        stopEvidence: {
          classification: 'target_reached',
          target,
          uniqueCreators: uniqueCreatorCountForPlatform(knownCreatorIdentities, item.platform),
        },
        attempt: Number(channelResults[key]?.attempt || 0),
        status: 'succeeded',
        skipped: true,
        sourceUrls: [],
        route: { ...item.route, query: item.query, limit: 0 },
        artifacts: [],
        outcome: 'skipped_target_reached',
        truncated: false,
        error: null,
      };
      store.addEvent(jobId, {
        channel: item.platform,
        level: 'success',
        message: `${platform.label} already reached ${initial.limit} unique creator(s); skipped discovery route ${item.route.index + 1}/${item.route.total}.`,
      });
      const results = normalizedResults(initial, allCreators);
      const metrics = collectionMetrics(initial, channelResults, results);
      store.patch(jobId, {
        channelResults,
        results,
        metrics,
        progress: allWorkItems.length ? Math.round((((completedItems + position + 1) / allWorkItems.length) * 92)) + 8 : 100,
      });
      await store.flush();
      continue;
    }

    const directory = path.join(store.jobsDirectory(jobId), item.platform, String(index + 1));
    await fs.mkdir(directory, { recursive: true });
    store.addEvent(jobId, { channel: item.platform, targetId: item.target?.targetId, message: `${platform.label} connector started${item.target ? ` for ${item.target.name}` : ''}.` });

    try {
      const result = await collectWorkItem(item, {
        query: item.query,
        limit: routeSchedule.requestedLimit,
        mode: initial.type,
        queryPlan: initial.type === 'discover' ? initial.queryPlan : undefined,
        target: item.target,
        outputDir: directory,
        emit: (event) => store.addEvent(jobId, { channel: item.platform, targetId: item.target?.targetId, ...event }),
      });
      const sourceRecords = Array.isArray(result.records) ? result.records : [];
      const profileTransportError = item.target ? profileCaptureTransportError(sourceRecords) : null;
      const normalized = profileTransportError
        ? []
        : Array.isArray(result.normalizedCreators)
          ? result.normalizedCreators
          : normalizeResult(item.platform, result.source, sourceRecords, item.query);
      const creators = item.target
        ? verifiedTargetCreators(item.platform, item.target, normalized)
        : normalized;
      const routeIdentities = new Set();
      let duplicateWithinRoute = 0;
      let duplicateFromPreviousRoutes = 0;
      let newUniqueCreators = 0;
      for (const creator of creators) {
        const identity = creator?.identityKey || canonicalCreatorIdentity(creator?.channel, creator?.sourceUrl);
        if (!identity || routeIdentities.has(identity)) {
          duplicateWithinRoute += 1;
          continue;
        }
        routeIdentities.add(identity);
        if (knownCreatorIdentities.has(identity)) duplicateFromPreviousRoutes += 1;
        else {
          knownCreatorIdentities.add(identity);
          newUniqueCreators += 1;
        }
      }
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
      const recordCount = sourceRecords.length;
      const completionReason = discoveryStopReason(result);
      const routeRequestedLimit = initial.type === 'discover' ? routeSchedule.requestedLimit : null;
      const shouldRetryRoute = initial.type === 'discover'
        && retryableDiscoveryRoute(result, creators.length, routeRequestedLimit);
      let status = shouldRetryRoute
        ? 'retryable'
        : result.outcome === 'completed_empty' || !creators.length ? 'completed_empty' : 'succeeded';
      let itemError = null;
      if (profileTransportError) {
        status = 'failed';
        itemError = profileTransportError;
      } else if (item.target && !creators.length) {
        status = 'failed';
        itemError = {
          code: 'TARGET_NOT_CONFIRMED',
          message: 'The target profile did not yield a confirmed creator identity.',
          action: 'Open the source profile, confirm the signed-in session, then resume this verification.',
        };
      } else if (shouldRetryRoute) {
        itemError = {
          code: 'DISCOVERY_ROUTE_RETRYABLE',
          message: `Discovery route stopped before its target (${completionReason || 'temporary_stop'}).`,
          action: 'Resume this collection to retry only this route; already saved candidates remain available.',
        };
      } else if (!item.target && recordCount && !creators.length) {
        itemError = {
          code: 'NO_USABLE_CREATOR',
          message: 'Source records were returned but no valid platform creator profile could be normalized.',
          action: 'Inspect the source record schema and connector mapping.',
        };
      }
      const channelResult = {
        platform: item.platform,
        label: platform.label,
        targetId: item.target?.targetId || null,
        targetName: item.target?.name || null,
        targetSourceUrl: item.target?.sourceUrl || null,
        records: recordCount,
        creators: creators.length,
        requestedLimit: routeRequestedLimit,
        queryCount: initial.type === 'discover'
          ? item.route
            ? 1
            : Math.max(1, Number(result.collectionMeta?.query_count) || initial.queryPlan?.length || 1)
          : null,
        rawSourceRecords: initial.type === 'discover'
          ? Number(result.collectionMeta?.raw_source_records ?? recordCount)
          : null,
        uniqueSourceRecords: initial.type === 'discover'
          ? Number(result.collectionMeta?.unique_creators ?? creators.length)
          : null,
        newUniqueCreators: initial.type === 'discover' ? newUniqueCreators : null,
        duplicateWithinRoute: initial.type === 'discover' ? duplicateWithinRoute : null,
        duplicateFromPreviousRoutes: initial.type === 'discover' ? duplicateFromPreviousRoutes : null,
        completionReason: initial.type === 'discover' ? completionReason || null : null,
        stopEvidence: initial.type === 'discover' ? result.collectionMeta?.stop_evidence || null : null,
        attempt: Number(channelResults[key]?.attempt || 0) + 1,
        status,
        source: result.source,
        sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl].filter(Boolean))],
        collectionMeta: result.collectionMeta || null,
        ...(item.route ? { route: { ...item.route, query: item.query, limit: routeSchedule.requestedLimit } } : {}),
        artifacts,
        outcome: profileTransportError ? 'failed' : result.outcome,
        truncated: Boolean(result.truncated),
        ...((profileTransportError || shouldRetryRoute) ? { retryable: true } : {}),
        error: itemError,
      };
      channelResults[key] = channelResult;
      allCreators.push(...creators);
      store.addEvent(jobId, {
        channel: item.platform,
        targetId: item.target?.targetId,
        level: status === 'succeeded' ? 'success' : 'warn',
        message: `${platform.label} returned ${recordCount} source record(s), ${creators.length} usable creator(s), ${newUniqueCreators} new unique creator(s).`,
      });
    } catch (error) {
      const problem = error instanceof ConnectorError
        ? error
        : new ConnectorError('UNEXPECTED_CONNECTOR_ERROR', error.message || 'The connector returned an unexpected error.', 'Inspect the collection log and run again.');
      const status = classifyFailure(problem);
      if (status === 'waiting_for_connection') {
        connectionPause = {
          code: problem.code,
          message: problem.message,
          action: problem.action,
        };
      }
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory).catch(() => []);
      const channelResult = {
        platform: item.platform,
        label: platform.label,
        targetId: item.target?.targetId || null,
        targetName: item.target?.name || null,
        targetSourceUrl: item.target?.sourceUrl || null,
        records: 0,
        creators: 0,
        requestedLimit: initial.type === 'discover' ? routeSchedule.requestedLimit : null,
        queryCount: initial.type === 'discover' ? (item.route ? 1 : null) : null,
        rawSourceRecords: initial.type === 'discover' ? 0 : null,
        uniqueSourceRecords: initial.type === 'discover' ? 0 : null,
        newUniqueCreators: initial.type === 'discover' ? 0 : null,
        duplicateWithinRoute: initial.type === 'discover' ? 0 : null,
        duplicateFromPreviousRoutes: initial.type === 'discover' ? 0 : null,
        completionReason: initial.type === 'discover' ? String(problem.code || 'failed').toLocaleLowerCase() : null,
        stopEvidence: null,
        attempt: Number(channelResults[key]?.attempt || 0) + 1,
        status,
        sourceUrls: [],
        ...(item.route ? { route: { ...item.route, query: item.query, limit: routeSchedule.requestedLimit } } : {}),
        artifacts,
        error: { code: problem.code, message: problem.message, action: problem.action },
      };
      channelResults[key] = channelResult;
      store.addEvent(jobId, {
        channel: item.platform,
        targetId: item.target?.targetId,
        level: status.startsWith('waiting') ? 'warn' : 'error',
        message: `${platform.label} did not complete: ${problem.message}`,
        action: problem.action,
      });
    }
    const results = normalizedResults(initial, allCreators);
    const metrics = collectionMetrics(initial, channelResults, results);
    store.patch(jobId, {
      channelResults,
      results,
      metrics,
      progress: allWorkItems.length ? Math.round((((completedItems + position + 1) / allWorkItems.length) * 92)) + 8 : 100,
    });
    await store.flush();
    if (connectionPause) {
      store.patch(jobId, {
        status: 'waiting_for_connection',
        finishedAt: null,
        error: connectionPause,
      });
      store.addEvent(jobId, {
        level: 'warn',
        message: 'Collection paused after the first Browser Relay connection or session failure; completed route checkpoints were retained.',
        action: connectionPause.action,
      });
      await store.flush();
      return;
    }
  }

  const results = normalizedResults(initial, allCreators);
  const jobStatus = terminalStatus(collectionCounts(workItemResultValues(initial, channelResults)));
  const metrics = collectionMetrics(initial, channelResults, results);
  store.patch(jobId, {
    status: jobStatus,
    progress: 100,
    finishedAt: new Date().toISOString(),
    channelResults,
    results,
    metrics,
    error: jobStatus === 'failed'
      ? { code: 'COLLECTION_FAILED', message: 'Every connector work item failed.', action: 'Inspect each connector result and run again.' }
      : null,
  });
  store.addEvent(jobId, {
    level: jobStatus === 'succeeded' ? 'success' : jobStatus === 'partial_success' ? 'warn' : 'error',
    message: `Collection finished with ${metrics.sourceRecords} source record(s), ${metrics.creators} creator(s), status ${jobStatus}.`,
  });
  await store.flush();
}

function replacePersona(personas, persona) {
  return [
    ...personas.filter((entry) => entry?.targetId !== persona.targetId),
    persona,
  ];
}

function replaceContentCapture(captures, capture) {
  return [
    ...captures.filter((entry) => entry?.targetId !== capture.targetId),
    capture,
  ];
}

function replaceContentAnalysis(analyses, analysis) {
  return [
    ...analyses.filter((entry) => entry?.targetId !== analysis.targetId),
    analysis,
  ];
}

function personaHistoryKey(targetId, identityKey) {
  return `${compactText(targetId, 180)}\u0000${compactText(identityKey, 220)}`;
}

function latestHistoricalPersonas(discoveryJobId, currentJobId) {
  const newestByCreator = new Map();
  for (const job of store.listAll({ type: 'enrich' })) {
    if (job.id === currentJobId || job.discoveryJobId !== discoveryJobId) continue;
    for (const persona of Array.isArray(job.results) ? job.results : []) {
      const targetId = compactText(persona?.targetId, 180);
      const identityKey = compactText(persona?.identityKey, 220);
      const capturedAt = compactText(persona?.capturedAt, 80);
      const timestamp = Date.parse(capturedAt);
      if (!targetId || !identityKey || !Number.isFinite(timestamp)) continue;
      const key = personaHistoryKey(targetId, identityKey);
      const existing = newestByCreator.get(key);
      if (!existing || timestamp > existing.timestamp) newestByCreator.set(key, { persona, timestamp });
    }
  }
  return new Map([...newestByCreator.entries()].map(([key, value]) => [key, value.persona]));
}

async function writePersonaArtifact(directory, persona) {
  const payload = {
    schemaVersion: Number.isFinite(persona?.schemaVersion) ? persona.schemaVersion : 2,
    generatedAt: new Date().toISOString(),
    persona,
  };
  await fs.writeFile(
    path.join(directory, 'creator_persona_latest.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

async function writeContentCaptureArtifact(directory, capture) {
  const payload = {
    schemaVersion: Number.isFinite(capture?.schemaVersion) ? capture.schemaVersion : 1,
    generatedAt: new Date().toISOString(),
    capture,
  };
  await fs.writeFile(
    path.join(directory, 'creator_content_latest.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

async function writeContentAnalysisArtifact(directory, analysis) {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    analysis,
  };
  await fs.writeFile(
    path.join(directory, 'creator_content_analysis_latest.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

async function writeAudienceInsightArtifact(jobId, audienceInsight) {
  const directory = store.jobsDirectory(jobId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'audience_insight_latest.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      audienceInsight,
    }, null, 2),
    'utf8',
  );
}

async function runEnrichment(jobId, { resume = false } = {}) {
  const initial = store.get(jobId);
  if (!initial || initial.type !== 'enrich') return;
  const allWorkItems = jobWorkItems(initial);
  const historicalPersonas = latestHistoricalPersonas(initial.discoveryJobId, jobId);
  const channelResults = resume ? { ...(initial.channelResults || {}) } : {};
  let personas = resume ? [...(initial.results || [])] : [];
  const pendingItems = allWorkItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !resume || !completedWorkItem(channelResults[channelResultKey(item)]));
  const completedItems = allWorkItems.length - pendingItems.length;

  store.patch(jobId, {
    status: 'running',
    progress: allWorkItems.length ? Math.max(3, Math.round((completedItems / allWorkItems.length) * 92)) : 3,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
  store.addEvent(jobId, {
    message: (resume ? 'Persona enrichment resumed' : 'Persona enrichment started')
      + ' with ' + pendingItems.length + ' pending public profile(s).',
  });

  for (let position = 0; position < pendingItems.length; position += 1) {
    const { item, index } = pendingItems[position];
    const platform = config.platforms[item.platform];
    const key = channelResultKey(item);
    const directory = path.join(store.jobsDirectory(jobId), 'profiles', item.platform, String(index + 1));
    await fs.mkdir(directory, { recursive: true });
    store.addEvent(jobId, {
      channel: item.platform,
      targetId: item.target.targetId,
      message: platform.label + ' public profile capture started for ' + item.target.name + '.',
    });

    try {
      const result = await collectWorkItem(item, {
        query: item.query,
        limit: 1,
        mode: 'verify',
        target: item.target,
        outputDir: directory,
        emit: (event) => store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          ...event,
        }),
      });
      const profileTransportError = profileCaptureTransportError(result.records);
      if (profileTransportError) {
        const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: item.target.targetId,
          targetName: item.target.name,
          targetSourceUrl: item.target.sourceUrl,
          records: result.records.length,
          creators: 0,
          personas: 0,
          status: 'failed',
          source: result.source,
          sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
          collectionMeta: result.collectionMeta || null,
          artifacts,
          outcome: 'failed',
          truncated: Boolean(result.truncated),
          retryable: true,
          error: profileTransportError,
        };
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          level: 'warn',
          message: platform.label + ' returned a retryable transport error for ' + item.target.name + '.',
          action: profileTransportError.action,
        });
      } else {
        const normalized = normalizeResult(item.platform, result.source, result.records, item.query);
        const confirmed = verifiedTargetCreators(item.platform, item.target, normalized);
        if (!confirmed.length) {
        const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: item.target.targetId,
          targetName: item.target.name,
          targetSourceUrl: item.target.sourceUrl,
          records: result.records.length,
          creators: 0,
          personas: 0,
          status: 'failed',
          source: result.source,
          sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
          collectionMeta: result.collectionMeta || null,
          artifacts,
          outcome: result.outcome,
          truncated: Boolean(result.truncated),
          error: {
            code: 'PROFILE_NOT_CONFIRMED',
            message: 'The public profile did not yield a confirmed creator identity.',
            action: 'Open the source profile, confirm the signed-in session, then resume this persona task.',
          },
        };
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          level: 'warn',
          message: platform.label + ' did not yield a confirmed public profile for ' + item.target.name + '.',
        });
        } else {
        const capturedAt = new Date().toISOString();
        const persona = deriveCreatorPersona({
          creator: item.target,
          records: result.records,
          source: result.source,
          collectionMeta: result.collectionMeta,
          historicalPersona: historicalPersonas.get(personaHistoryKey(item.target.targetId, item.target.identityKey)) || null,
          capturedAt,
        });
        persona.profileConfirmation = {
          status: 'confirmed',
          expectedName: item.target.name,
          observedName: confirmed[0].name,
          matchMethod: 'direct_profile_url',
        };
        await writePersonaArtifact(directory, persona);
        const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
        personas = replacePersona(personas, persona);
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: item.target.targetId,
          targetName: item.target.name,
          targetSourceUrl: item.target.sourceUrl,
          records: result.records.length,
          creators: 1,
          personas: 1,
          status: 'succeeded',
          source: result.source,
          sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
          collectionMeta: result.collectionMeta || null,
          artifacts,
          outcome: result.outcome,
          truncated: Boolean(result.truncated),
          error: null,
        };
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          level: 'success',
          message: platform.label + ' persona saved for ' + item.target.name + '.',
        });
        }
      }
    } catch (error) {
      const problem = error instanceof ConnectorError
        ? error
        : new ConnectorError('UNEXPECTED_CONNECTOR_ERROR', error.message || 'The profile connector returned an unexpected error.', 'Inspect the persona task log and resume it.');
      const status = classifyFailure(problem);
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory).catch(() => []);
      channelResults[key] = {
        platform: item.platform,
        label: platform.label,
        targetId: item.target.targetId,
        targetName: item.target.name,
        targetSourceUrl: item.target.sourceUrl,
        records: 0,
        creators: 0,
        personas: 0,
        status,
        sourceUrls: [item.target.sourceUrl],
        artifacts,
        error: { code: problem.code, message: problem.message, action: problem.action },
      };
      store.addEvent(jobId, {
        channel: item.platform,
        targetId: item.target.targetId,
        level: status.startsWith('waiting') ? 'warn' : 'error',
        message: platform.label + ' profile capture did not complete: ' + problem.message,
        action: problem.action,
      });
    }
    const metrics = collectionMetrics(initial, channelResults, personas);
    store.patch(jobId, {
      channelResults,
      results: personas,
      metrics,
      progress: allWorkItems.length ? Math.round(((completedItems + position + 1) / allWorkItems.length) * 92) + 8 : 100,
    });
    await store.flush();
  }

  const jobStatus = terminalStatus(collectionCounts(channelResults));
  const metrics = collectionMetrics(initial, channelResults, personas);
  store.patch(jobId, {
    status: jobStatus,
    progress: 100,
    finishedAt: new Date().toISOString(),
    channelResults,
    results: personas,
    metrics,
    error: jobStatus === 'failed'
      ? { code: 'PERSONA_ENRICHMENT_FAILED', message: 'Every public profile capture failed.', action: 'Inspect each profile result and resume the task.' }
      : null,
  });
  store.addEvent(jobId, {
    level: jobStatus === 'succeeded' ? 'success' : jobStatus === 'partial_success' ? 'warn' : 'error',
    message: 'Persona enrichment finished with ' + metrics.enrichedCreators + ' saved persona(s), status ' + jobStatus + '.',
  });
  await store.flush();
}

function benchmarkFirstOrder(items, sampleSize = 25) {
  if (!Array.isArray(items) || items.length <= sampleSize) return Array.isArray(items) ? items : [];
  const sampledIndexes = new Set(Array.from({ length: sampleSize }, (_, index) => (
    Math.round((index * (items.length - 1)) / Math.max(1, sampleSize - 1))
  )));
  return [
    ...[...sampledIndexes].map((index) => items[index]),
    ...items.filter((_, index) => !sampledIndexes.has(index)),
  ];
}

async function runContentCollection(jobId, { resume = false } = {}) {
  let initial = store.get(jobId);
  if (!initial || initial.type !== 'content') return;
  const normalizedTargets = (Array.isArray(initial.targets) ? initial.targets : [])
    .map((target) => normalizeEnrichmentTarget(target) || target)
    .map((target) => ({ ...target, targetId: target.targetId || target.id }));
  if (JSON.stringify(normalizedTargets) !== JSON.stringify(initial.targets || [])) {
    await store.initializeContentJob(jobId, normalizedTargets);
    initial = store.get(jobId);
    store.addEvent(jobId, {
      level: 'info',
      message: `Re-normalized ${normalizedTargets.length} saved discovery cards before continuing the full content flow.`,
    });
    await store.flush();
  }
  if (initial.strategy === 'breadth_first_full') {
    await store.refreshStorageWaterline();
    const freeBytes = Number(store.health().waterline?.freeBytes);
    const minimumFreeBytes = 50 * 1024 ** 3;
    if (Number.isFinite(freeBytes) && freeBytes < minimumFreeBytes) {
      store.patch(jobId, {
        status: 'waiting_for_storage',
        phase: initial.phase || 'profile',
        error: {
          code: 'STORAGE_WATERLINE_REACHED',
          message: 'The content task paused before collection because the protected free-space waterline was reached.',
          action: 'Move the data directory to a volume with at least 50 GB free, then resume this task.',
        },
        metrics: { ...(initial.metrics || {}), storageWaterline: store.health().waterline },
      });
      await store.flush();
      return;
    }
  }
  const allWorkItems = jobWorkItems(initial);
  const channelResults = resume ? { ...(initial.channelResults || {}) } : {};
  const captures = new Map((resume ? (initial.results || []) : [])
    .map((capture) => [compactText(capture?.targetId || capture?.discoveryCreatorId, 180), capture])
    .filter(([targetId]) => targetId));
  const visibleCountByTarget = new Map([...captures.entries()].map(([targetId, capture]) => (
    [targetId, contentCaptureVisibleSampleCount(capture)]
  )));
  let visibleContentTotal = [...visibleCountByTarget.values()].reduce((total, count) => total + count, 0);
  const basePendingItems = allWorkItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !resume || !completedWorkItem(channelResults[channelResultKey(item)]));
  const completedItems = allWorkItems.length - basePendingItems.length;
  const configuredCollectionConcurrency = Number(config.collection.contentCollectionConcurrency);
  const collectionConcurrency = contentCollectionWorkerCount({
    requested: configuredCollectionConcurrency,
    pendingCount: basePendingItems.length,
    platformModes: basePendingItems.map(({ item }) => config.platforms[item.platform]?.mode),
  });
  let completedFinalItems = 0;
  let completedPhaseItems = 0;
  let connectionPause = null;
  let stateQueue = Promise.resolve();
  let lastMetadataPersistedAt = Date.now();
  let completedSinceMetadataPersist = 0;
  const benchmarkMode = 'saved_discovery_profile_baseline_v1';
  const continuingCurrentBenchmark = initial.metrics?.benchmarkMode === benchmarkMode;
  let benchmarkProfiles = continuingCurrentBenchmark
    ? Math.min(25, Math.max(0, Number(initial.metrics?.benchmarkProfiles) || 0))
    : 0;
  const initialBenchmarkActiveSeconds = continuingCurrentBenchmark
    ? Math.max(0, Number(initial.metrics?.benchmarkActiveSeconds) || 0)
    : 0;
  const benchmarkRunStartedAt = Date.now();
  let benchmarkProfilesPerMinute = continuingCurrentBenchmark && Number(initial.metrics?.benchmarkProfilesPerMinute) > 0
    ? Number(initial.metrics.benchmarkProfilesPerMinute)
    : null;
  let benchmarkCompletedAt = continuingCurrentBenchmark ? initial.metrics?.benchmarkCompletedAt || null : null;
  let profileBaselineReuseCount = Object.values(channelResults)
    .filter((result) => result?.source === 'saved_discovery_public_card').length;
  if (benchmarkProfiles >= 25 && !benchmarkCompletedAt) {
    benchmarkCompletedAt = initial.updatedAt || initial.startedAt || initial.createdAt || new Date().toISOString();
  }
  const runWithStateLock = (task) => {
    const run = stateQueue.then(task, task);
    stateQueue = run.catch(() => undefined);
    return run;
  };
  const collectionTiming = createRandomIntervalController(
    initial.randomInterval || {
      minMs: config.collection.randomIntervalMinMs,
      maxMs: config.collection.randomIntervalMaxMs,
    },
  );
  let collectionRequestCount = 0;
  const waitBeforeCollection = async () => {
    const shouldWait = await runWithStateLock(() => {
      const wait = collectionRequestCount > 0;
      collectionRequestCount += 1;
      return wait;
    });
    if (shouldWait) await collectionTiming.wait();
  };

  store.patch(jobId, {
    status: 'running',
    progress: allWorkItems.length ? Math.max(3, Math.round((completedItems / allWorkItems.length) * 92)) : 3,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    randomInterval: collectionTiming.snapshot(),
  });
  store.addEvent(jobId, {
    message: (resume ? 'Content collection resumed' : 'Content collection started')
      + ' with ' + basePendingItems.length + ' pending public profile(s) and '
      + collectionConcurrency + ' bounded creator worker(s).',
  });
  if (collectionTiming.enabled) {
    store.addEvent(jobId, {
      level: 'info',
      message: 'Random collection interval enabled: '
        + `${collectionTiming.range.minMs}-${collectionTiming.range.maxMs} ms between collection requests.`,
    });
  }

  const processPendingItem = async (phase, pendingItems, position, phaseIndex, phaseCount, reportedPhase = null) => {
    const { item, index } = pendingItems[position];
    const platform = config.platforms[item.platform];
    const key = channelResultKey(item);
    const previousChannelResult = channelResults[key] || null;
    const completedPhases = new Set(Array.isArray(previousChannelResult?.completedPhases) ? previousChannelResult.completedPhases : []);
    const directory = path.join(
      store.jobsDirectory(jobId),
      'content',
      item.platform,
      String(index + 1),
      ...(initial.strategy === 'breadth_first_full' ? [phase] : []),
    );
    await fs.mkdir(directory, { recursive: true });
    const catalogCheckpointFile = phase === 'detail' && item.platform === 'douyin'
      ? path.join(
        store.jobsDirectory(jobId),
        'content',
        item.platform,
        String(index + 1),
        'catalog',
        'douyin_creators_latest.json',
      )
      : '';
    const catalogInputFile = catalogCheckpointFile && await fs.access(catalogCheckpointFile)
      .then(() => catalogCheckpointFile)
      .catch(() => '');
    await runWithStateLock(() => {
      store.addEventTransient(jobId, {
        channel: item.platform,
        targetId: item.target.targetId,
        message: platform.label + ' public content capture started for ' + item.target.name + '.',
      });
    });

    let captureToCommit = null;
    let usedDiscoveryProfileBaseline = false;
    try {
      const baselineResult = phase === 'profile'
        ? discoveryCardProfileBaselineResult(item.target)
        : null;
      usedDiscoveryProfileBaseline = Boolean(baselineResult);
      if (!baselineResult) await waitBeforeCollection();
      const result = baselineResult || await collectWorkItem(item, {
          query: item.query,
          limit: 1,
          mode: 'content',
          contentLimit: initial.contentLimit,
          strategy: initial.strategy || 'standard',
          collectionPhase: phase,
          catalogInputFile,
          randomInterval: collectionTiming.range,
          target: item.target,
          outputDir: directory,
          emit: (event) => runWithStateLock(() => {
            store.addEventTransient(jobId, {
              channel: item.platform,
              targetId: item.target.targetId,
              ...event,
            });
          }),
        });
      const profileTransportError = profileCaptureTransportError(result.records);
      if (profileTransportError) {
        const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
        await runWithStateLock(() => {
          channelResults[key] = {
            platform: item.platform,
            label: platform.label,
            targetId: item.target.targetId,
            targetName: item.target.name,
            targetSourceUrl: item.target.sourceUrl,
            completedPhases: [...completedPhases],
            records: result.records.length,
            creators: 0,
            contentCaptures: 0,
            visibleContentSamples: 0,
            contentLimit: initial.contentLimit,
            status: 'failed',
            source: result.source,
            sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
            collectionMeta: result.collectionMeta || null,
            artifacts,
            outcome: 'failed',
            truncated: Boolean(result.truncated),
            retryable: true,
            error: profileTransportError,
          };
          store.addEventTransient(jobId, {
            channel: item.platform,
            targetId: item.target.targetId,
            level: 'warn',
            message: platform.label + ' returned a retryable transport error for ' + item.target.name + '.',
            action: profileTransportError.action,
          });
        });
      } else {
        const normalized = normalizeResult(item.platform, result.source, result.records, item.query);
        const confirmed = verifiedTargetCreators(item.platform, item.target, normalized);
        if (!confirmed.length) {
          const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
          await runWithStateLock(() => {
            channelResults[key] = {
              platform: item.platform,
              label: platform.label,
              targetId: item.target.targetId,
              targetName: item.target.name,
              targetSourceUrl: item.target.sourceUrl,
              completedPhases: [...completedPhases],
              records: result.records.length,
              creators: 0,
              contentCaptures: 0,
              visibleContentSamples: 0,
              contentLimit: initial.contentLimit,
              status: 'failed',
              source: result.source,
              sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
              collectionMeta: result.collectionMeta || null,
              artifacts,
              outcome: result.outcome,
              truncated: Boolean(result.truncated),
              error: {
                code: 'PROFILE_NOT_CONFIRMED',
                message: 'The public profile did not yield a confirmed creator identity.',
                action: 'Open the source profile, confirm the signed-in session, then resume this content task.',
              },
            };
            store.addEventTransient(jobId, {
              channel: item.platform,
              targetId: item.target.targetId,
              level: 'warn',
              message: platform.label + ' did not yield a confirmed public profile for ' + item.target.name + '.',
            });
          });
        } else {
          const capturedAt = new Date().toISOString();
          const freshCapture = deriveCreatorContentCapture({
            creator: item.target,
            records: result.records,
            source: result.source,
            collectionMeta: result.collectionMeta,
            confirmation: result.confirmation || confirmed[0].verification,
            requestedContentLimit: initial.contentLimit,
            capturedAt,
          });
          let previousCapture = captures.get(item.target.targetId) || null;
          if (
            previousCapture
            && contentCaptureVisibleSampleCount(previousCapture) > 0
            && !Array.isArray(previousCapture?.content?.visibleSamples)
          ) {
            const [storedCapture] = await store.loadContentCaptures(jobId, [item.target.targetId]);
            previousCapture = storedCapture || previousCapture;
          }
          const capture = mergeCreatorContentCaptures(previousCapture, freshCapture);
          const visibleContentSamples = contentCaptureVisibleSampleCount(capture);
          const profileMetricCount = contentCaptureProfileMetricCount(capture);
          const workItemState = contentCaptureWorkItemState(capture, visibleContentSamples);
          const nextCompletedPhases = new Set(completedPhases);
          if (phase !== 'detail' || !workItemState.resumable) nextCompletedPhases.add(phase);
          const profileResolution = contentCaptureProfileResolution(capture);
          capture.pipeline = {
            phase,
            completedPhases: [...nextCompletedPhases],
            profileResolved: nextCompletedPhases.has('profile') && profileResolution.resolved,
            catalogResolved: nextCompletedPhases.has('catalog') && !workItemState.resumable,
            detailResolved: nextCompletedPhases.has('detail'),
            fullCardComplete: nextCompletedPhases.has('profile')
              && profileResolution.resolved
              && nextCompletedPhases.has('catalog')
              && nextCompletedPhases.has('detail')
              && !workItemState.resumable,
            updatedAt: capturedAt,
          };
          await writeContentCaptureArtifact(directory, capture);
          const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
          await runWithStateLock(() => {
            completedPhases.clear();
            for (const completedPhase of nextCompletedPhases) completedPhases.add(completedPhase);
            captureToCommit = capture;
            captures.set(capture.targetId, capture);
            channelResults[key] = {
              platform: item.platform,
              label: platform.label,
              targetId: item.target.targetId,
              targetName: item.target.name,
              targetSourceUrl: item.target.sourceUrl,
              completedPhases: [...completedPhases],
              records: result.records.length,
              creators: 1,
              contentCaptures: 1,
              visibleContentSamples,
              contentLimit: initial.contentLimit,
              profileObservedDirectly: result.collectionMeta?.completion === 'profile_observed',
              profileMetricCount,
              profileDataAvailable: profileMetricCount > 0,
              status: phase === 'detail' ? workItemState.status : 'phase_complete',
              source: result.source,
              sourceUrls: [...new Set([result.sourceUrl, result.collectionMeta?.sourceSearchUrl, item.target.sourceUrl].filter(Boolean))],
              collectionMeta: result.collectionMeta || null,
              contentCollectionCoverage: workItemState.coverage,
              completion: workItemState.completion,
              resumeState: workItemState.resumeState,
              continuationRecommended: workItemState.continuationRecommended,
              artifacts,
              outcome: workItemState.outcome,
              truncated: Boolean(result.truncated),
              retryable: workItemState.resumable,
              error: null,
            };
            store.addEventTransient(jobId, {
              channel: item.platform,
              targetId: item.target.targetId,
              level: workItemState.resumable ? 'warn' : visibleContentSamples ? 'success' : 'warn',
              message: platform.label + ' saved ' + visibleContentSamples + ' visible public content sample(s) for ' + item.target.name
                + (workItemState.resumable
                  ? '; the collector recommends a continuation, so this profile remains resumable.'
                  : '.'),
            });
          });
        }
      }
    } catch (error) {
      const problem = error instanceof ConnectorError
        ? error
        : new ConnectorError('UNEXPECTED_CONNECTOR_ERROR', error.message || 'The content connector returned an unexpected error.', 'Inspect the content task log and resume it.');
      const status = classifyFailure(problem);
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory).catch(() => []);
      await runWithStateLock(() => {
        if (status === 'waiting_for_connection' && !connectionPause) {
          connectionPause = {
            code: problem.code,
            message: problem.message,
            action: problem.action,
          };
        }
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: item.target.targetId,
          targetName: item.target.name,
          targetSourceUrl: item.target.sourceUrl,
          completedPhases: [...completedPhases],
          records: 0,
          creators: 0,
          contentCaptures: 0,
          visibleContentSamples: 0,
          contentLimit: initial.contentLimit,
          status,
          sourceUrls: [item.target.sourceUrl],
          artifacts,
          error: { code: problem.code, message: problem.message, action: problem.action },
        };
        store.addEventTransient(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          level: status.startsWith('waiting') ? 'warn' : 'error',
          message: platform.label + ' content capture did not complete: ' + problem.message,
          action: problem.action,
        });
      });
    } finally {
      await runWithStateLock(async () => {
        const committedResult = channelResults[key] || null;
        await store.commitContentResult(jobId, {
          capture: captureToCommit,
          targetId: item.target.targetId,
          channelResult: committedResult,
        });
        if (captureToCommit) {
          const previousVisibleCount = visibleCountByTarget.get(item.target.targetId) || 0;
          const nextVisibleCount = contentCaptureVisibleSampleCount(captureToCommit);
          visibleCountByTarget.set(item.target.targetId, nextVisibleCount);
          visibleContentTotal += nextVisibleCount - previousVisibleCount;
        }
        completedPhaseItems += 1;
        if (phase === 'detail') completedFinalItems += 1;
        if (usedDiscoveryProfileBaseline && captureToCommit) profileBaselineReuseCount += 1;
        completedSinceMetadataPersist += 1;
        const resultValues = Object.values(channelResults);
        if (!benchmarkCompletedAt && phase === 'profile' && captureToCommit) {
          benchmarkProfiles = Math.min(25, benchmarkProfiles + 1);
        }
        const benchmarkActiveSeconds = benchmarkCompletedAt
          ? initialBenchmarkActiveSeconds
          : Math.max(0.001, initialBenchmarkActiveSeconds + ((Date.now() - benchmarkRunStartedAt) / 1000));
        if (!benchmarkCompletedAt && benchmarkProfiles >= 25) {
          benchmarkProfilesPerMinute = Number(((benchmarkProfiles / benchmarkActiveSeconds) * 60).toFixed(2));
          benchmarkCompletedAt = new Date().toISOString();
        } else if (!benchmarkProfilesPerMinute && benchmarkProfiles > 0) {
          benchmarkProfilesPerMinute = Number(((benchmarkProfiles / benchmarkActiveSeconds) * 60).toFixed(2));
        }
        const metrics = {
          ...(initial.metrics || {}),
          targetCreators: allWorkItems.length,
          contentCaptures: captures.size,
          contentTargets: captures.size,
          creators: captures.size,
          visibleContentSamples: visibleContentTotal,
          uniqueContentCount: visibleContentTotal,
          profileCoverageCount: [...captures.values()].filter((capture) => contentCaptureProfileMetricCount(capture) > 0).length,
          ...contentCardCoverageMetrics(captures, channelResults, allWorkItems.length),
          retryableContentCaptures: resultValues.filter((result) => result?.status === 'retryable').length,
          retryCount: resultValues.filter((result) => result?.retryable === true || result?.status === 'retryable').length,
          pendingWorkItems: Math.max(0, basePendingItems.length - completedFinalItems),
          benchmarkProfiles,
          benchmarkMode,
          benchmarkActiveSeconds: Number(benchmarkActiveSeconds.toFixed(3)),
          benchmarkProfilesPerMinute,
          benchmarkCompletedAt,
          profileBaselineReuseCount,
          storageWaterline: store.health().waterline,
        };
        const durableCheckpointDue = completedSinceMetadataPersist >= 25 || Date.now() - lastMetadataPersistedAt >= 2_000;
        const patchValues = {
          phase: reportedPhase || contentCollectionReportedPhase(initial.strategy, phase),
          metrics,
          progress: allWorkItems.length
            ? Math.min(99, Math.round(((completedItems + (completedPhaseItems / phaseCount)) / allWorkItems.length) * 92) + 8)
            : 100,
        };
        if (durableCheckpointDue) {
          await store.refreshStorageWaterline();
          patchValues.metrics.storageWaterline = store.health().waterline;
          store.patch(jobId, patchValues);
          await store.flush();
          completedSinceMetadataPersist = 0;
          lastMetadataPersistedAt = Date.now();
        } else {
          store.patchTransient(jobId, patchValues);
        }
      });
    }
  };

  const phasePlan = initial.strategy === 'breadth_first_full'
    ? ['profile', 'catalog', 'detail']
    : ['detail'];
  for (let phaseIndex = 0; phaseIndex < phasePlan.length; phaseIndex += 1) {
    const phase = phasePlan[phaseIndex];
    const requiredPriorPhases = phasePlan.slice(0, phaseIndex);
    let pendingItems = basePendingItems.filter(({ item }) => {
      if (initial.strategy !== 'breadth_first_full') return phase === 'detail';
      if (item.platform !== 'douyin') return phase === 'detail';
      const result = channelResults[channelResultKey(item)];
      const phases = Array.isArray(result?.completedPhases) ? result.completedPhases : [];
      const phaseComplete = phase === 'profile'
        ? phases.includes(phase) && result?.profileDataAvailable === true
        : phases.includes(phase);
      return !phaseComplete && requiredPriorPhases.every((required) => phases.includes(required));
    });
    if (phase === 'profile') pendingItems = benchmarkFirstOrder(pendingItems, 25);
    if (phase === 'detail') pendingItems = contentDetailPriorityOrder(pendingItems, visibleCountByTarget);
    const reportedPhase = contentCollectionReportedPhase(initial.strategy, phase);
    store.patch(jobId, { phase: reportedPhase });
    store.addEvent(jobId, {
      message: `Content collection phase ${phase} started for ${pendingItems.length} pending public profile(s).`,
    });
    await store.flush();
    for (let batchStart = 0; batchStart < pendingItems.length;) {
      const batchSize = phase === 'profile' && batchStart === 0 ? 25 : 100;
      const batch = pendingItems.slice(batchStart, batchStart + batchSize);
      if (initial.strategy === 'breadth_first_full') {
        await store.refreshStorageWaterline();
        const freeBytes = Number(store.health().waterline?.freeBytes);
        if (Number.isFinite(freeBytes) && freeBytes < 50 * 1024 ** 3) {
          store.patch(jobId, {
            status: 'waiting_for_storage',
            phase,
            error: {
              code: 'STORAGE_WATERLINE_REACHED',
              message: 'The content task paused between batches at the protected free-space waterline.',
              action: 'Free storage or move the data directory, then resume from the saved per-target checkpoints.',
            },
            metrics: { ...(store.get(jobId)?.metrics || {}), storageWaterline: store.health().waterline },
          });
          await store.flush();
          return;
        }
      }
      let nextBatchPosition = 0;
      const workers = Array.from({ length: Math.min(collectionConcurrency, Math.max(1, batch.length)) }, async () => {
        while (true) {
          const batchPosition = await runWithStateLock(() => {
            if (connectionPause) return null;
            if (nextBatchPosition >= batch.length) return null;
            const next = nextBatchPosition;
            nextBatchPosition += 1;
            return next;
          });
          if (batchPosition === null) return;
          await processPendingItem(phase, batch, batchPosition, phaseIndex, phasePlan.length, reportedPhase);
          const batchEntry = batch[batchPosition];
          const followUpPhase = contentCollectionFollowUpPhase({
            strategy: initial.strategy,
            phase,
            connectionPaused: Boolean(connectionPause),
            completedPhases: channelResults[channelResultKey(batchEntry.item)]?.completedPhases,
          });
          if (followUpPhase) {
            await processPendingItem(
              followUpPhase,
              [batchEntry],
              0,
              phasePlan.indexOf(followUpPhase),
              phasePlan.length,
              reportedPhase,
            );
          }
        }
      });
      await Promise.all(workers);
      if (connectionPause) {
        await store.refreshStorageWaterline();
        store.patch(jobId, {
          status: 'waiting_for_connection',
          phase,
          finishedAt: null,
          error: connectionPause,
          metrics: {
            ...(store.get(jobId)?.metrics || {}),
            storageWaterline: store.health().waterline,
          },
        });
        store.addEvent(jobId, {
          level: 'warn',
          message: 'Content collection paused after the first Browser Relay connection failure; completed checkpoints were retained.',
          action: connectionPause.action,
        });
        await store.flush();
        return;
      }
      batchStart += batch.length;
    }
  }

  const jobStatus = terminalStatus(collectionCounts(channelResults));
  await store.refreshStorageWaterline();
  const metrics = collectionMetrics(initial, channelResults, [...captures.values()]);
  metrics.profileCoverageCount = [...captures.values()].filter((capture) => contentCaptureProfileMetricCount(capture) > 0).length;
  metrics.uniqueContentCount = visibleContentTotal;
  Object.assign(metrics, contentCardCoverageMetrics(captures, channelResults, allWorkItems.length));
  metrics.retryCount = Object.values(channelResults).filter((result) => result?.retryable === true || result?.status === 'retryable').length;
  metrics.storageWaterline = store.health().waterline;
  metrics.randomInterval = collectionTiming.snapshot();
  store.patch(jobId, {
    status: jobStatus,
    progress: 100,
    finishedAt: new Date().toISOString(),
    channelResults,
    results: [...captures.values()],
    phase: jobStatus === 'succeeded' ? 'complete' : 'waiting_or_failed',
    randomInterval: collectionTiming.snapshot(),
    metrics,
    error: jobStatus === 'failed'
      ? { code: 'CONTENT_COLLECTION_FAILED', message: 'Every public content capture failed.', action: 'Inspect each profile result and resume the task.' }
      : null,
  });
  store.addEvent(jobId, {
    level: jobStatus === 'succeeded' ? 'success' : jobStatus === 'partial_success' ? 'warn' : 'error',
    message: 'Content collection finished with ' + metrics.contentCaptures + ' creator capture(s), '
      + metrics.visibleContentSamples + ' visible public sample(s), status ' + jobStatus + '.',
  });
  await store.flush();
}

async function runContentAnalysis(jobId, { resume = false } = {}) {
  const initial = store.get(jobId);
  if (!initial || initial.type !== 'content_analysis') return;
  const analysisRuntime = contentAnalysisRuntimeConfig(initial);
  const agentRuntime = contentAgentRuntime(analysisRuntime.content);
  const allWorkItems = jobWorkItems(initial);
  const captureByTargetId = new Map((Array.isArray(initial.sourceCaptures) ? initial.sourceCaptures : [])
    .map((capture) => [compactText(capture?.targetId || capture?.discoveryCreatorId, 180), capture]));
  const channelResults = resume ? { ...(initial.channelResults || {}) } : {};
  let analyses = resume ? [...(initial.results || [])] : [];
  const pendingItems = allWorkItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !resume || !completedWorkItem(channelResults[channelResultKey(item)]));
  const completedItems = allWorkItems.length - pendingItems.length;
  const sharedVideoProcessingResources = createVideoProcessingResources(analysisRuntime.video.concurrency);
  const configuredCreatorConcurrency = Number(config.analysis.video.creatorConcurrency);
  const creatorConcurrency = Math.min(
    Math.max(1, Number.isFinite(configuredCreatorConcurrency) ? Math.floor(configuredCreatorConcurrency) : 1),
    Math.max(1, pendingItems.length),
  );
  const activeVideoProgressByTarget = new Map();
  let latestVideoProgressKey = '';
  let completedPendingItems = 0;
  let nextPendingPosition = 0;
  let stateQueue = Promise.resolve();
  const runWithStateLock = (task) => {
    const run = stateQueue.then(task, task);
    stateQueue = run.catch(() => undefined);
    return run;
  };
  const publishVideoProgress = (key, progress) => runWithStateLock(() => {
    if (progress) {
      activeVideoProgressByTarget.set(key, progress);
      latestVideoProgressKey = key;
    } else {
      activeVideoProgressByTarget.delete(key);
      if (latestVideoProgressKey === key) {
        latestVideoProgressKey = [...activeVideoProgressByTarget.keys()].at(-1) || '';
      }
    }
    const activeCreators = activeVideoProgressByTarget.size;
    const videoProgressByTarget = Object.fromEntries(
      [...activeVideoProgressByTarget.entries()].map(([progressKey, value]) => [progressKey, {
        ...value,
        activeCreators,
        creatorConcurrency,
      }]),
    );
    store.patchTransient(jobId, {
      videoProgress: videoProgressByTarget[latestVideoProgressKey]
        || Object.values(videoProgressByTarget).at(-1)
        || null,
      videoProgressByTarget,
    });
  });

  store.patch(jobId, {
    status: 'running',
    progress: allWorkItems.length ? Math.max(3, Math.round((completedItems / allWorkItems.length) * 92)) : 3,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    videoProgress: null,
    videoProgressByTarget: {},
    agentRuntime,
    error: null,
  });
  store.addEvent(jobId, {
    message: (resume ? 'Content analysis resumed' : 'Content analysis started')
      + ' with ' + pendingItems.length + ' pending creator capture(s).',
  });

  const processPendingItem = async (position) => {
    const { item, index } = pendingItems[position];
    const platform = config.platforms[item.platform];
    const key = channelResultKey(item);
    const directory = path.join(store.jobsDirectory(jobId), 'analysis', item.platform, String(index + 1));
    const capture = captureByTargetId.get(item.target.targetId);
    await fs.mkdir(directory, { recursive: true });
    await runWithStateLock(() => {
      store.addEvent(jobId, {
        channel: item.platform,
        targetId: item.target.targetId,
        message: platform.label + ' content evidence analysis started for ' + item.target.name + '.',
      });
    });

    try {
      if (!capture) throw new Error('CONTENT_CAPTURE_SNAPSHOT_MISSING');
      const analyzedAt = new Date().toISOString();
      const target = contentAnalysisTarget(capture);
      const videoProgressForTarget = (progress) => ({
        targetId: target.targetId,
        targetName: target.name,
        channel: item.platform,
        ...progress,
      });
      await publishVideoProgress(key, videoProgressForTarget({
        completed: 0,
        total: 0,
        status: 'starting',
        concurrency: analysisRuntime.video.concurrency || 2,
      }));
      const videoEvidence = await collectVideoEvidence({
        capture,
        platform: item.platform,
        artifactDirectory: directory,
        artifactRootDirectory: store.jobsDirectory(jobId),
        relayPort: relayPortForPlatform(item.platform),
        videoConfig: analysisRuntime.video,
        runWithRelayLock: runWithBrowserRelayLock,
        resume,
        processingResources: sharedVideoProcessingResources,
        onProgress: async ({
          completed,
          total,
          sampleIndex,
          status,
          resumed,
          concurrency,
          observed,
          active,
          pending,
          transcribed,
          percent,
        }) => {
          await publishVideoProgress(key, videoProgressForTarget({
            completed,
            total,
            sampleIndex,
            status,
            resumed,
            concurrency,
            observed,
            active,
            pending,
            transcribed,
            percent,
          }));
          if (!['observed', 'local_processing'].includes(status)
            && total > 0
            && (completed === total || completed === 1 || completed % 5 === 0)) {
            await runWithStateLock(() => {
              store.addEvent(jobId, {
                channel: item.platform,
                targetId: target.targetId,
                message: platform.label + ' processed ' + completed + '/' + total
                  + ' visible public video item(s) for ' + target.name
                  + (resumed ? ' from saved checkpoints.' : '.'),
              });
            });
          }
        },
      });
      const captureWithVideoEvidence = {
        ...capture,
        content: {
          ...(capture.content || {}),
          videoEvidence,
        },
      };
      // Both passes must resolve artifacts from the analysis job, never from
      // a caller-controlled location or the original collection job.
      const contentModelConfig = {
        ...analysisRuntime.content,
        artifactRootDirectory: store.jobsDirectory(jobId),
      };
      const evidenceAnalysis = deriveContentAnalysis({
        capture: captureWithVideoEvidence,
        campaignBrief: initial.campaignBrief || null,
        capturedAt: analyzedAt,
        modelConfig: contentModelConfig,
      });
      const provisionalRecord = contentAnalysisRecord({
        initial,
        capture,
        analysis: evidenceAnalysis,
        analyzedAt,
      });
      await writeContentAnalysisArtifact(directory, provisionalRecord);
      const provisionalArtifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
      await runWithStateLock(() => {
        analyses = replaceContentAnalysis(analyses, provisionalRecord);
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: target.targetId,
          targetName: target.name,
          targetSourceUrl: target.sourceUrl,
          records: 0,
          creators: 1,
          analyses: 1,
          visibleContentSamples: evidenceAnalysis.coverage.visibleSampleCount,
          eligibleVideoSamples: evidenceAnalysis.video?.coverage?.eligibleVideoSampleCount || 0,
          selectedVideoSamples: evidenceAnalysis.video?.coverage?.selectedVideoSampleCount || 0,
          processedVideoSamples: evidenceAnalysis.video?.coverage?.processedVideoSampleCount
            || evidenceAnalysis.video?.coverage?.selectedVideoSampleCount || 0,
          unprocessedVideoSamples: evidenceAnalysis.video?.coverage?.unprocessedVideoSampleCount || 0,
          videoAnalysisScope: evidenceAnalysis.video?.coverage?.analysisScope || 'not_applicable',
          renderedVideoSamples: evidenceAnalysis.video?.coverage?.renderedMediaSampleCount || 0,
          sampledVideoFrames: evidenceAnalysis.video?.coverage?.sampledFrameCount || 0,
          ocrTextFrames: evidenceAnalysis.video?.coverage?.ocrTextFrameCount || 0,
          transcribedVideoSamples: evidenceAnalysis.video?.coverage?.transcriptAvailableSampleCount || 0,
          videoAnalysisStatus: evidenceAnalysis.video?.status || 'not_applicable',
          // Keep the item resumable while optional model enrichment is running.
          status: 'running',
          sourceUrls: [target.sourceUrl],
          artifacts: provisionalArtifacts,
          analysisMode: evidenceAnalysis.mode,
          modelStatus: 'evidence_ready',
          agentOrchestration: evidenceAnalysis.orchestration,
          error: null,
        };
        store.patch(jobId, {
          channelResults,
          results: analyses,
          metrics: contentAnalysisMetrics(initial, channelResults, analyses),
          progress: allWorkItems.length
            ? Math.min(95, Math.round(((completedItems + completedPendingItems + 0.5) / allWorkItems.length) * 92) + 3)
            : 75,
        });
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          message: platform.label + ' saved ' + evidenceAnalysis.contentItems.length
            + ' per-content evidence interpretation(s) and '
            + (evidenceAnalysis.video?.coverage?.processedVideoSampleCount || 0)
            + ' per-video interpretation record(s) for ' + target.name + '; '
            + (agentRuntime.configured
              ? agentRuntime.label + ' enrichment is running.'
              : 'the evidence matrix is ready and model enrichment is not configured.'),
        });
      });
      await store.flush();

      await publishVideoProgress(key, videoProgressForTarget({
        completed: videoEvidence.coverage?.processedVideoSampleCount || 0,
        total: videoEvidence.coverage?.selectedVideoSampleCount || 0,
        status: 'model_enrichment',
        concurrency: videoEvidence.processor?.localProcessingConcurrency || analysisRuntime.video.concurrency || 2,
      }));
      const analysis = await runContentModelMatrix(contentModelConfig, () => analyzeCreatorContentWithFallback({
        capture: captureWithVideoEvidence,
        campaignBrief: initial.campaignBrief || null,
        capturedAt: analyzedAt,
        modelConfig: contentModelConfig,
        precomputedBaseline: evidenceAnalysis,
        runModelRequest: contentModelConfig.provider === 'openai_responses'
          ? runRemoteContentRequest
          : null,
        onAgentEvent: async (event) => {
          await runWithStateLock(() => {
            const current = analyses.find((entry) => entry?.targetId === target.targetId);
            if (!current?.analysis || !event?.orchestration) return;
            const modelStatus = event.status === 'fallback' ? 'fallback' : 'running';
            const nextAnalysis = {
              ...current.analysis,
              status: event.status === 'fallback' ? 'fallback_model_error' : 'running',
              orchestration: event.orchestration,
              model: {
                ...(current.analysis.model || {}),
                status: modelStatus,
              },
            };
            analyses = replaceContentAnalysis(analyses, {
              ...current,
              status: nextAnalysis.status,
              analysis: nextAnalysis,
            });
            channelResults[key] = {
              ...channelResults[key],
              agentOrchestration: event.orchestration,
              modelStatus,
            };
            store.patchTransient(jobId, {
              channelResults,
              results: analyses,
              metrics: contentAnalysisMetrics(initial, channelResults, analyses),
            });
          });
        },
      }));
      const record = contentAnalysisRecord({ initial, capture, analysis, analyzedAt });
      await writeContentAnalysisArtifact(directory, record);
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory);
      const analysisStatus = analysis.status === 'completed_empty' ? 'completed_empty' : 'succeeded';
      await runWithStateLock(() => {
        analyses = replaceContentAnalysis(analyses, record);
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: target.targetId,
          targetName: target.name,
          targetSourceUrl: target.sourceUrl,
          records: 0,
          creators: 1,
          analyses: 1,
          visibleContentSamples: analysis.coverage.visibleSampleCount,
          eligibleVideoSamples: analysis.video?.coverage?.eligibleVideoSampleCount || 0,
          selectedVideoSamples: analysis.video?.coverage?.selectedVideoSampleCount || 0,
          processedVideoSamples: analysis.video?.coverage?.processedVideoSampleCount
            || analysis.video?.coverage?.selectedVideoSampleCount || 0,
          unprocessedVideoSamples: analysis.video?.coverage?.unprocessedVideoSampleCount || 0,
          videoAnalysisScope: analysis.video?.coverage?.analysisScope || 'not_applicable',
          renderedVideoSamples: analysis.video?.coverage?.renderedMediaSampleCount || 0,
          sampledVideoFrames: analysis.video?.coverage?.sampledFrameCount || 0,
          ocrTextFrames: analysis.video?.coverage?.ocrTextFrameCount || 0,
          transcribedVideoSamples: analysis.video?.coverage?.transcriptAvailableSampleCount || 0,
          videoAnalysisStatus: analysis.video?.status || 'not_applicable',
          status: analysisStatus,
          sourceUrls: [target.sourceUrl],
          artifacts,
          analysisMode: analysis.mode,
          modelStatus: analysis.model?.status || 'not_configured',
          agentOrchestration: analysis.orchestration,
          error: null,
        };
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: target.targetId,
          level: analysisStatus === 'succeeded' ? 'success' : 'warn',
          message: platform.label + ' saved an evidence-grounded content analysis for ' + target.name
            + ' with ' + (analysis.video?.coverage?.sampledFrameCount || 0) + ' sampled video frame(s).',
        });
      });
    } catch {
      const artifacts = await collectArtifactManifest(store.jobsDirectory(jobId), directory).catch(() => []);
      await runWithStateLock(() => {
        channelResults[key] = {
          platform: item.platform,
          label: platform.label,
          targetId: item.target.targetId,
          targetName: item.target.name,
          targetSourceUrl: item.target.sourceUrl,
          records: 0,
          creators: 0,
          analyses: 0,
          visibleContentSamples: 0,
          status: 'failed',
          sourceUrls: [item.target.sourceUrl],
          artifacts,
          error: {
            code: 'CONTENT_ANALYSIS_FAILED',
            message: 'The content analysis matrix could not complete for this creator.',
            action: 'Review the saved public content capture and resume the analysis task.',
          },
        };
        store.addEvent(jobId, {
          channel: item.platform,
          targetId: item.target.targetId,
          level: 'error',
          message: platform.label + ' content analysis did not complete for ' + item.target.name + '.',
        });
      });
    } finally {
      await publishVideoProgress(key, null);
      await runWithStateLock(() => {
        completedPendingItems += 1;
        const metrics = contentAnalysisMetrics(initial, channelResults, analyses);
        store.patch(jobId, {
          channelResults,
          results: analyses,
          metrics,
          progress: allWorkItems.length
            ? Math.min(99, Math.round(((completedItems + completedPendingItems) / allWorkItems.length) * 92) + 8)
            : 100,
        });
      });
      await store.flush();
    }
  };

  const workers = Array.from({ length: creatorConcurrency }, async () => {
    while (true) {
      const position = await runWithStateLock(() => {
        if (nextPendingPosition >= pendingItems.length) return null;
        const next = nextPendingPosition;
        nextPendingPosition += 1;
        return next;
      });
      if (position === null) return;
      await processPendingItem(position);
    }
  });
  await Promise.all(workers);

  const jobStatus = terminalStatus(collectionCounts(channelResults));
  const metrics = contentAnalysisMetrics(initial, channelResults, analyses);
  store.patch(jobId, {
    status: jobStatus,
    progress: 100,
    finishedAt: new Date().toISOString(),
    channelResults,
    results: analyses,
    metrics,
    videoProgress: null,
    videoProgressByTarget: {},
    error: jobStatus === 'failed'
      ? {
        code: 'CONTENT_ANALYSIS_FAILED',
        message: 'Every creator content analysis failed.',
        action: 'Review saved public content captures and resume the analysis task.',
      }
      : null,
  });
  store.addEvent(jobId, {
    level: jobStatus === 'succeeded' ? 'success' : jobStatus === 'partial_success' ? 'warn' : 'error',
    message: 'Content analysis finished with ' + metrics.analyzedCreators + ' evidence matrix result(s), status ' + jobStatus + '.',
  });
  await store.flush();
}

function scheduleCollection(jobId, options = {}) {
  void runCollection(jobId, options).catch((error) => {
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: { code: 'SCHEDULER_FAILED', message: error.message || 'Collection scheduler failed.' },
    });
    store.addEvent(jobId, { level: 'error', message: `Collection scheduler failed: ${error.message || error}` });
    return store.flush().catch((flushError) => console.error('Could not persist collection failure:', flushError));
  });
}

function scheduleEnrichment(jobId, options = {}) {
  void runEnrichment(jobId, options).catch((error) => {
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: { code: 'PERSONA_SCHEDULER_FAILED', message: error.message || 'Persona task scheduler failed.' },
    });
    store.addEvent(jobId, { level: 'error', message: 'Persona task scheduler failed: ' + (error.message || error) });
    return store.flush().catch((flushError) => console.error('Could not persist persona task failure:', flushError));
  });
}

function scheduleContentCollection(jobId, options = {}) {
  void runContentCollection(jobId, options).catch((error) => {
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: { code: 'CONTENT_SCHEDULER_FAILED', message: error.message || 'Content task scheduler failed.' },
    });
    store.addEvent(jobId, { level: 'error', message: 'Content task scheduler failed: ' + (error.message || error) });
    return store.flush().catch((flushError) => console.error('Could not persist content task failure:', flushError));
  });
}

function scheduleContentAnalysis(jobId, options = {}) {
  void runContentAnalysis(jobId, options).catch(() => {
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: {
        code: 'CONTENT_ANALYSIS_SCHEDULER_FAILED',
        message: 'Content analysis scheduler failed.',
        action: 'Resume the analysis task after reviewing its saved content capture.',
      },
    });
    store.addEvent(jobId, { level: 'error', message: 'Content analysis scheduler failed.' });
    return store.flush().catch((flushError) => console.error('Could not persist content analysis failure:', flushError));
  });
}

async function connectorHealth() {
  const entries = await Promise.all([...supportedPlatforms].map(async (platform) => [platform, await getConnectorHealth(platform)]));
  return Object.fromEntries(entries);
}

async function connectorStatusPayload() {
  const connectors = await connectorHealth();
  const connectionRetention = await readRelaySessionRetention({
    sessionStateDir: config.relay.sessionStateDir,
    platformIds: [...supportedPlatforms],
    profileAlias: config.relay.profileAlias,
  });
  return {
    connectors,
    connectionRetention: {
      ...connectionRetention,
      checkedAt: new Date().toISOString(),
    },
  };
}

function connectorStatusTimeoutPayload() {
  return {
    connectors: Object.fromEntries([...supportedPlatforms].map((platform) => [platform, {
      ...publicPlatformConfig(platform),
      status: 'checking',
      detail: 'Connector health check is still running.',
      action: 'Open the connector status view again to refresh the detailed result.',
    }])),
    connectionRetention: {
      mechanism: 'attached_browser_profile',
      profileAlias: config.relay.profileAlias,
      status: 'checking',
      checkedAt: new Date().toISOString(),
    },
  };
}

async function boundedConnectorStatusPayload() {
  let timer = null;
  try {
    return await Promise.race([
      connectorStatusPayload(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(connectorStatusTimeoutPayload()), HEALTH_CONNECTOR_STATUS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runtimeConfigPayload() {
  const contentModel = config.analysis.content;
  const videoVision = config.analysis.video.vision;
  const platform = (platformId) => {
    const configured = config.platforms[platformId];
    return {
      ...publicPlatformConfig(platformId),
      searchUrlTemplate: configured?.searchUrlTemplate || '',
      postSearchUrlTemplate: configured?.postSearchUrlTemplate || '',
    };
  };
  return {
    relay: {
      defaultPort: config.relay.port,
      profileAlias: config.relay.profileAlias,
      douyinPort: DOUYIN_RELAY_PORT,
      douyinFixed: true,
    },
    browser: {
      sessionMode: 'attached_browser_profile',
      profileAlias: config.relay.profileAlias,
    },
    channels: [platform('xiaohongshu'), platform('douyin')],
    models: {
      content: {
        provider: contentModel.provider,
        model: contentModel.model || '',
        enabled: Boolean(contentModel.enabled),
        orchestration: contentModel.orchestration,
        options: [
          {
            id: 'configured',
            label: contentModel.model
              ? `服务端模型 · ${contentModel.model}`
              : '服务端模型 · 尚未配置',
            description: contentModel.enabled
              ? `${contentModel.provider} / ${contentModel.orchestration}`
              : '模型未就绪时保留证据矩阵结果',
            enabled: Boolean(contentModel.enabled),
          },
          {
            id: 'evidence_matrix',
            label: '证据矩阵 · 仅本地证据',
            description: '保留图文、关键帧、OCR 与转写证据，不调用模型',
            enabled: true,
          },
        ],
      },
      videoVision: {
        provider: videoVision.provider,
        model: videoVision.model || '',
        enabled: Boolean(videoVision.enabled),
        options: [
          {
            id: 'configured',
            label: videoVision.model
              ? `视频视觉 · ${videoVision.model}`
              : '视频视觉 · 尚未配置',
            description: videoVision.enabled ? `${videoVision.provider} 关键帧语义` : '未配置视频视觉模型',
            enabled: Boolean(videoVision.enabled),
          },
          {
            id: 'keyframes_only',
            label: '关键帧 / OCR / 转写',
            description: '保留视频关键帧与本地处理结果，不调用视觉模型',
            enabled: true,
          },
        ],
      },
    },
  };
}

let cachedConnectorStatus = connectorStatusTimeoutPayload();
let connectorStatusRefresh = null;

function refreshConnectorStatusInBackground() {
  if (connectorStatusRefresh) return connectorStatusRefresh;
  connectorStatusRefresh = boundedConnectorStatusPayload()
    .then((payload) => {
      cachedConnectorStatus = payload;
      return payload;
    })
    .finally(() => {
      connectorStatusRefresh = null;
    });
  return connectorStatusRefresh;
}

async function runPostSearchMedia(jobId, post) {
  const jobRoot = store.jobsDirectory(jobId);
  const artifactDirectory = path.join(jobRoot, 'media');
  const sourceVideoConfig = config.analysis.video || {};
  const videoConfig = {
    ...sourceVideoConfig,
    artifactRootDirectory: jobRoot,
    maxVideosPerCreator: 1,
    framesPerVideo: Math.max(1, Math.min(Number(sourceVideoConfig.framesPerVideo) || 4, 4)),
    concurrency: 1,
    creatorConcurrency: 1,
    retainMediaArtifact: true,
    retainMediaMaxBytes: MAX_ARTIFACT_BYTES,
  };
  const capture = {
    content: {
      visibleSamples: [{
        sampleIndex: 1,
        sourceUrl: post.contentUrl,
        contentType: 'video',
        playbackUrl: post.videoUrl || null,
        title: post.title,
        summary: post.body,
        observedInteractions: Object.values(post.metrics || {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
        publishedAt: post.publishedAt || post.publishedAtText || null,
      }],
    },
  };
  try {
    await fs.mkdir(artifactDirectory, { recursive: true });
    const evidence = await collectVideoEvidence({
      capture,
      platform: 'douyin',
      artifactDirectory,
      artifactRootDirectory: jobRoot,
      relayPort: relayPortForPlatform('douyin'),
      videoConfig,
      runWithRelayLock: runWithBrowserRelayLock,
      processingResources: createVideoProcessingResources(1),
    });
    const video = Array.isArray(evidence.videos) ? evidence.videos[0] : null;
    const frames = Array.isArray(video?.frames)
      ? video.frames.map((frame) => ({
        ...frame,
        frameUrl: artifactDownloadUrl(jobId, frame.artifactPath),
      }))
      : [];
    const playbackArtifactPath = video?.mediaCache?.artifactPath || '';
    const result = {
      jobId,
      postId: post.postId,
      status: evidence.status,
      video: video
        ? { ...video, frames, playbackUrl: artifactDownloadUrl(jobId, playbackArtifactPath) || null }
        : { status: evidence.status, frames, playbackUrl: null },
      limitations: evidence.limitations || [],
    };
    const finalStatus = frames.length
      ? 'succeeded'
      : evidence.status === 'not_applicable' ? 'completed_empty' : 'failed';
    store.patch(jobId, {
      status: finalStatus,
      progress: 100,
      finishedAt: new Date().toISOString(),
      metrics: { requested: 1, completed: 1, frames: frames.length, resultCount: frames.length },
      result,
      error: frames.length || finalStatus === 'completed_empty' ? null : {
        code: 'POST_SEARCH_MEDIA_EMPTY',
        message: 'No displayable video frames were returned.',
      },
    });
    store.addEvent(jobId, {
      level: frames.length ? 'success' : 'warn',
      message: frames.length ? 'Video keyframes are ready.' : 'Video processing finished without displayable keyframes.',
    });
    await store.flush();
  } catch (error) {
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      finishedAt: new Date().toISOString(),
      metrics: { requested: 1, completed: 1, frames: 0, resultCount: 0 },
      error: { code: 'POST_SEARCH_MEDIA_FAILED', message: 'Video keyframe extraction failed.' },
    });
    store.addEvent(jobId, { level: 'error', message: 'Video keyframe extraction failed.' });
    await store.flush();
    console.warn(`[post-search-media:${jobId}]`, error?.message || error);
  }
}

function postSearchOutputDirectory(jobId) {
  return path.join(config.dataDir, 'post-search', jobId);
}

function postSearchCheckpointUrl(value) {
  const candidate = compactText(value, 1_200);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    const match = parsed.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
    if (parsed.protocol !== 'https:' || !(host === 'douyin.com' || host.endsWith('.douyin.com')) || !match) return '';
    return `https://www.douyin.com/${match[1].toLowerCase()}/${match[2]}`;
  } catch {
    return '';
  }
}

function postSearchCheckpointUrls(posts) {
  return [...new Set((Array.isArray(posts) ? posts : [])
    .map((post) => postSearchCheckpointUrl(post?.contentUrl || post?.content_url || post?.url))
    .filter(Boolean))];
}

function postSearchCollectionMeta({ previousMeta, incomingMeta, requestedTotal, requestedBatchLimit, previousCount, incomingCount, total, added, continuationCount, checkpoint }) {
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : {};
  const incoming = incomingMeta && typeof incomingMeta === 'object' ? incomingMeta : {};
  const priorDuplicateCount = Number(previous.cumulative_duplicates ?? previous.cumulativeDuplicates) || 0;
  const lastBatchDuplicates = Math.max(0, incomingCount - added);
  const cumulativeDuplicates = priorDuplicateCount + lastBatchDuplicates;
  const targetReached = total >= requestedTotal;
  return {
    ...incoming,
    requested_limit: requestedTotal,
    requested_batch_limit: requestedBatchLimit,
    records_collected: total,
    previous_result_count: previousCount,
    last_batch_count: incomingCount,
    last_batch_added: added,
    last_batch_duplicates: lastBatchDuplicates,
    cumulative_duplicates: cumulativeDuplicates,
    continuation_count: continuationCount,
    checkpoint: checkpoint || incoming.checkpoint || null,
    target_reached: targetReached,
    continuation_recommended: targetReached
      ? false
      : incoming.continuation_recommended !== false,
  };
}

async function runPostSearchCollection(jobId, requestBody, { continuation = false, additionalLimit = 0 } = {}) {
  const current = store.get(jobId);
  if (!current || current.type !== 'post_search') {
    throw new ConnectorError('POST_SEARCH_JOB_NOT_FOUND', 'The post search task was not found.');
  }
  const priorResult = current.result && typeof current.result === 'object' ? current.result : {};
  const priorPosts = Array.isArray(priorResult.posts) ? priorResult.posts : [];
  const priorRequestedLimit = Number(priorResult.requestedTotal ?? current.requestedTotal) || 0;
  const requestedLimit = continuation
    ? Math.min(MAX_POST_SEARCH_RESULTS, Math.max(priorRequestedLimit, priorPosts.length) + Math.max(1, additionalLimit))
    : Math.min(MAX_POST_SEARCH_RESULTS, requestBody.limit);
  const collectorLimit = continuation
    ? Math.max(1, Math.min(MAX_POST_SEARCH_RESULTS, Math.max(1, additionalLimit)))
    : requestedLimit;
  const startedAt = new Date().toISOString();
  const continuationCount = Number(current.continuationCount) || 0;
  const updateCollectionProgress = (event = {}) => {
    const currentJob = store.get(jobId);
    if (!currentJob) return;
    const previous = currentJob.collectionProgress && typeof currentJob.collectionProgress === 'object'
      ? currentJob.collectionProgress
      : {};
    const phase = String(event.phase || previous.phase || 'search');
    const scrolls = Number.isFinite(event.scrolls) ? event.scrolls : previous.scrolls;
    const scrollBudget = Number.isFinite(event.scrollBudget) ? event.scrollBudget : previous.scrollBudget;
    const visible = Number.isFinite(event.visible) ? event.visible : previous.visible;
    const newPosts = Number.isFinite(event.newPosts) ? event.newPosts : previous.newPosts;
    const attempted = Number.isFinite(event.attempted) ? event.attempted : previous.attempted;
    const total = Number.isFinite(event.total) ? event.total : previous.total;
    const enriched = Number.isFinite(event.enriched) ? event.enriched : previous.enriched;
    const commentsAttempted = Number.isFinite(event.commentsAttempted)
      ? event.commentsAttempted
      : previous.commentsAttempted;
    const commentsCollected = Number.isFinite(event.commentsCollected)
      ? event.commentsCollected
      : previous.commentsCollected;
    const searchRatio = Number.isFinite(scrolls) && Number.isFinite(scrollBudget) && scrollBudget > 0
      ? Math.min(1, scrolls / scrollBudget)
      : 0;
    const detailRatio = Number.isFinite(attempted) && Number.isFinite(total) && total > 0
      ? Math.min(1, attempted / total)
      : 0;
    const progress = phase === 'complete'
      ? 92
      : phase === 'detail'
        ? 48 + Math.round(detailRatio * 40)
        : 5 + Math.round(searchRatio * 40);
    const nextProgress = {
      ...previous,
      phase,
      progress: Math.max(1, Math.min(92, progress)),
      updatedAt: new Date().toISOString(),
      ...(Number.isFinite(scrolls) ? { scrolls } : {}),
      ...(Number.isFinite(scrollBudget) ? { scrollBudget } : {}),
      ...(Number.isFinite(visible) ? { visible } : {}),
      ...(Number.isFinite(newPosts) ? { newPosts } : {}),
      ...(Number.isFinite(attempted) ? { attempted } : {}),
      ...(Number.isFinite(total) ? { total } : {}),
      ...(Number.isFinite(enriched) ? { enriched } : {}),
      ...(Number.isFinite(commentsAttempted) ? { commentsAttempted } : {}),
      ...(Number.isFinite(commentsCollected) ? { commentsCollected } : {}),
    };
    store.patchTransient(jobId, {
      status: 'running',
      progress: nextProgress.progress,
      phase,
      collectionProgress: nextProgress,
      metrics: {
        ...currentJob.metrics,
        stage: phase,
        ...(Number.isFinite(visible) ? { visibleCards: visible } : {}),
        ...(Number.isFinite(newPosts) ? { newPosts } : {}),
        ...(Number.isFinite(attempted) ? { detailAttempted: attempted } : {}),
        ...(Number.isFinite(total) ? { detailTotal: total } : {}),
        ...(Number.isFinite(commentsAttempted) ? { commentsAttempted } : {}),
        ...(Number.isFinite(commentsCollected) ? { commentsCollected } : {}),
      },
    });
  };
  store.patch(jobId, {
    status: 'running',
    progress: 1,
    phase: 'connecting',
    collectionProgress: {
      phase: 'connecting',
      progress: 1,
      updatedAt: startedAt,
      visible: 0,
      newPosts: 0,
      attempted: 0,
      total: 0,
      enriched: 0,
      commentsAttempted: 0,
      commentsCollected: 0,
    },
    startedAt,
    finishedAt: null,
    limit: requestedLimit,
    randomInterval: requestBody.randomInterval,
    continuationCount: continuation ? continuationCount + 1 : continuationCount,
    requestedTotal: requestedLimit,
    requestedBatchLimit: collectorLimit,
    collectedTotal: priorPosts.length,
    lastAdded: 0,
    lastBatchDuplicates: 0,
    error: null,
  });
  store.addEvent(jobId, {
    message: continuation
      ? `Post search continuation started for ${requestBody.query} (target ${requestedLimit}).`
      : `Post search started for ${requestBody.query}.`,
  });
  await store.flush();
  const outputDir = postSearchOutputDirectory(jobId);
  await fs.mkdir(outputDir, { recursive: true });
  const checkpointPath = path.join(outputDir, 'post-search-checkpoint.json');
  const skipPostUrls = continuation ? postSearchCheckpointUrls(priorPosts) : [];
  if (continuation) {
    await fs.writeFile(checkpointPath, JSON.stringify({
      schema_version: 1,
      query: requestBody.query,
      previousCount: priorPosts.length,
      skipPostUrls,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  }
  try {
    const collection = await runWithBrowserRelayLock(() => collectPlatform('douyin', {
      query: requestBody.query,
      limit: collectorLimit,
      randomInterval: requestBody.randomInterval,
      outputDir,
      searchUrlTemplate: config.platforms.douyin.postSearchUrlTemplate,
      checkpointFile: continuation ? checkpointPath : '',
      onProgress: updateCollectionProgress,
    }));
    store.patchTransient(jobId, {
      progress: 94,
      phase: 'saving',
      collectionProgress: {
        ...(store.get(jobId)?.collectionProgress || {}),
        phase: 'saving',
        progress: 94,
        updatedAt: new Date().toISOString(),
      },
    });
    const incomingPosts = normalizePostSearchResults(collection.records, requestBody.query, collection.sourceUrl || '');
    const posts = mergePostSearchResults(continuation ? priorPosts : [], incomingPosts);
    const priorKeys = new Set(priorPosts.map((post) => post.contentUrl || post.postId || post.id).filter(Boolean));
    const added = posts.filter((post) => !priorKeys.has(post.contentUrl || post.postId || post.id)).length;
    const incomingCount = incomingPosts.length;
    const duplicateCount = Math.max(0, incomingCount - added);
    const fetchedAt = new Date().toISOString();
    const nextContinuationCount = continuation ? continuationCount + 1 : continuationCount;
    const collectionMeta = postSearchCollectionMeta({
      previousMeta: priorResult.collectionMeta,
      incomingMeta: collection.collectionMeta,
      requestedTotal: requestedLimit,
      requestedBatchLimit: collectorLimit,
      previousCount: priorPosts.length,
      incomingCount,
      total: posts.length,
      added,
      continuationCount: nextContinuationCount,
      checkpoint: {
        mode: continuation ? 'skip_known_post_urls' : 'initial_search',
        file: continuation ? 'post-search-checkpoint.json' : null,
        skippedPostCount: skipPostUrls.length,
        collectorRequestedLimit: collectorLimit,
        resumedFrom: priorPosts.length,
      },
    });
    const result = {
      query: requestBody.query,
      posts,
      total: posts.length,
      source: collection.source || priorResult.source || config.platforms.douyin.mode,
      sourceUrl: collection.sourceUrl || priorResult.sourceUrl || '',
      collectionMeta,
      fetchedAt,
      capturedAt: fetchedAt,
      continuationCount: nextContinuationCount,
      lastAdded: continuation ? added : posts.length,
      lastBatchCount: incomingCount,
      lastBatchDuplicates: duplicateCount,
      cumulativeDuplicates: collectionMeta.cumulative_duplicates,
      targetReached: collectionMeta.target_reached,
      requestedTotal: requestedLimit,
      requestedBatchLimit: collectorLimit,
      checkpoint: {
        mode: continuation ? 'skip_known_post_urls' : 'initial_search',
        skippedPostCount: skipPostUrls.length,
        collectorRequestedLimit: collectorLimit,
        resumedFrom: priorPosts.length,
      },
    };
    const status = posts.length ? 'succeeded' : 'completed_empty';
    store.patch(jobId, {
      status,
      progress: 100,
      finishedAt: fetchedAt,
      result,
      phase: 'completed',
      collectionProgress: {
        ...(store.get(jobId)?.collectionProgress || {}),
        phase: 'completed',
        progress: 100,
        updatedAt: fetchedAt,
        visible: posts.length,
        newPosts: added,
        skipped: duplicateCount,
        duplicates: collectionMeta.cumulative_duplicates,
      },
      requestedTotal: requestedLimit,
      requestedBatchLimit: collectorLimit,
      collectedTotal: posts.length,
      lastAdded: result.lastAdded,
      duplicateCount: collectionMeta.cumulative_duplicates,
      lastBatchDuplicates: duplicateCount,
      metrics: {
        requested: requestedLimit,
        posts: posts.length,
        resultCount: posts.length,
        added,
        duplicates: duplicateCount,
        cumulativeDuplicates: collectionMeta.cumulative_duplicates,
        previousCount: priorPosts.length,
        continuationCount: result.continuationCount,
        requestedTotal: requestedLimit,
        requestedBatchLimit: collectorLimit,
        collectedTotal: posts.length,
        targetReached: collectionMeta.target_reached,
      },
      error: null,
    });
    store.addEvent(jobId, {
      level: posts.length ? 'success' : 'warn',
      message: continuation
        ? `Post search continuation added ${added} result(s) and skipped ${duplicateCount} duplicate result(s); ${posts.length} total result(s) are saved on this task.`
        : `Post search finished with ${posts.length} result(s).`,
    });
    await store.flush();
    return {
      ...result,
      jobId,
      continuation,
      added,
      job: jobSummary(store.get(jobId)),
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    store.patch(jobId, {
      status: 'failed',
      progress: 100,
      phase: 'failed',
      collectionProgress: {
        ...(store.get(jobId)?.collectionProgress || {}),
        phase: 'failed',
        progress: 100,
        updatedAt: finishedAt,
      },
      finishedAt,
      result: priorResult,
      metrics: {
      requested: requestedLimit,
      posts: priorPosts.length,
      resultCount: priorPosts.length,
      added: 0,
      duplicates: 0,
      cumulativeDuplicates: Number(priorResult.cumulativeDuplicates || priorResult.collectionMeta?.cumulative_duplicates) || 0,
      continuationCount: continuation ? continuationCount + 1 : continuationCount,
      requestedTotal: requestedLimit,
      collectedTotal: priorPosts.length,
      },
      error: { code: error.code || 'POST_SEARCH_FAILED', message: error.message || 'Post search failed.' },
    });
    store.addEvent(jobId, {
      level: 'error',
      message: continuation
        ? 'Post search continuation failed; the saved results remain available on this task.'
        : 'Post search failed.',
    });
    await store.flush();
    throw error;
  }
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(distDir, `.${requested}`);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) return false;
  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.woff2': 'font/woff2',
    };
    response.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream', 'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=3600' });
    response.end(content);
    return true;
  } catch {
    if (path.extname(filePath)) return false;
    try {
      const index = await fs.readFile(path.join(distDir, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      response.end(index);
      return true;
    } catch {
      return false;
    }
  }
}

async function handle(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || config.host}`);
  const pathname = url.pathname;
  try {
    if (await douyinCommentJobs.handleHttpRequest({
      request,
      response,
      url,
      pathname,
      readRequestJson,
      sendJson,
      sendError,
    })) return;
    if (request.method === 'GET' && pathname === '/api/health') {
      const connectorStatus = cachedConnectorStatus;
      void refreshConnectorStatusInBackground().catch(() => {});
      sendJson(response, 200, {
        status: primaryStoreReady && store.health().status === 'ready' ? 'ok' : 'degraded',
        ...connectorStatus,
        toolchain: getToolchainHealth(),
        storage: {
          ...store.health(),
          initialization: primaryStoreInitializationError ? 'failed' : primaryStoreReady ? 'ready' : 'loading',
          initializationError: primaryStoreInitializationError?.message || null,
        },
        api: { host: config.host, port: config.port },
        now: new Date().toISOString(),
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/runtime-config') {
      sendJson(response, 200, runtimeConfigPayload());
      return;
    }
    if (!primaryStoreReady) {
      sendError(
        response,
        503,
        primaryStoreInitializationError ? 'SERVER_INITIALIZATION_FAILED' : 'SERVER_INITIALIZING',
        primaryStoreInitializationError
          ? 'The primary task store did not initialize.'
          : 'The primary task store is still loading. The Douyin comment workspace is already available.',
        primaryStoreInitializationError ? primaryStoreInitializationError.message : 'Retry this request shortly.',
      );
      return;
    }
    if ((request.method === 'GET' && pathname === '/api/connectors')
      || (request.method === 'POST' && pathname === '/api/connectors/recheck')) {
      cachedConnectorStatus = await boundedConnectorStatusPayload();
      sendJson(response, 200, cachedConnectorStatus);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/connectors/recover') {
      const body = await readRequestJson(request);
      const platform = typeof body?.platform === 'string' ? body.platform.trim().toLowerCase() : '';
      if (!supportedPlatforms.has(platform)) {
        sendError(response, 400, 'PLATFORM_REQUIRED', 'Choose one supported platform to recover.');
        return;
      }
      let recovery;
      try {
        recovery = await runWithBrowserRelayLock(() => recoverRelay({
          platformId: platform,
          port: relayPortForPlatform(platform),
          profile: config.relay.profileAlias,
          connectionChecker: async ({ platformId }) => {
            const health = await getConnectorHealth(platformId);
            return { ok: ['ready', 'relay_connected'].includes(health.status), health };
          },
        }));
      } catch (error) {
        throw new ConnectorError(
          'RELAY_RECOVERY_FAILED',
          error.message || 'Relay recovery failed.',
          'Refresh the connector status and confirm the attached browser profile is open.',
        );
      }
      cachedConnectorStatus = await boundedConnectorStatusPayload();
      sendJson(response, recovery.ok ? 200 : 409, {
        ...cachedConnectorStatus,
        platform,
        recovery,
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/post-search/send-config') {
      sendJson(response, 200, { platform: 'douyin', ...deliveryConfigSummary(config.outreach.douyin) });
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/api/post-search/media/stream') {
      await proxyPostSearchMedia(
        response,
        request,
        url.searchParams.get('platform') || 'douyin',
        url.searchParams.get('url') || '',
        url.searchParams.get('kind') === 'image' ? 'image' : 'video',
      );
      return;
    }
    if (request.method === 'POST' && pathname === '/api/post-search') {
      const requestBody = validatePostSearchRequest(await readRequestJson(request));
      const job = store.create({
        type: 'post_search',
        status: 'queued',
        progress: 0,
        channel: 'douyin',
        channels: ['douyin'],
        query: requestBody.query,
        limit: requestBody.limit,
        randomInterval: requestBody.randomInterval,
        source: 'direct_content_search',
        result: null,
        requestedTotal: requestBody.limit,
        collectedTotal: 0,
        continuationCount: 0,
        lastAdded: 0,
        duplicateCount: 0,
        lastBatchDuplicates: 0,
        metrics: {
          requested: requestBody.limit,
          requestedTotal: requestBody.limit,
          posts: 0,
          resultCount: 0,
          added: 0,
          duplicates: 0,
          continuationCount: 0,
        },
        finishedAt: null,
      });
      await store.flush();
      const result = await runPostSearchCollection(job.id, requestBody);
      sendJson(response, 200, result);
      return;
    }
    const postSearchContinuationMatch = pathname.match(/^\/api\/post-search\/([^/]+)\/continue$/);
    if (postSearchContinuationMatch && request.method === 'POST') {
      const jobId = decodeURIComponent(postSearchContinuationMatch[1]);
      const job = store.get(jobId);
      if (!job || job.type !== 'post_search') {
        sendError(response, 404, 'POST_SEARCH_JOB_NOT_FOUND', 'The post search task was not found.');
        return;
      }
      if (['queued', 'running'].includes(job.status)) {
        sendError(response, 409, 'POST_SEARCH_JOB_BUSY', 'The post search task is still running.');
        return;
      }
      const continuation = validatePostSearchContinuationRequest(await readRequestJson(request));
      const continuationPromise = runPostSearchCollection(job.id, {
        query: job.query,
        limit: job.limit || continuation.additionalLimit,
        randomInterval: continuation.randomInterval,
      }, {
        continuation: true,
        additionalLimit: continuation.additionalLimit,
      });
      void continuationPromise.catch((error) => {
        console.warn(`[post-search:${job.id}] continuation failed: ${error?.message || error}`);
      });
      sendJson(response, 202, {
        accepted: true,
        continuation: true,
        jobId: job.id,
        job: jobSummary(store.get(job.id)),
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/post-search/comments') {
      const requestBody = validatePostCommentsRequest(await readRequestJson(request));
      const post = normalizePostSearchRecord(requestBody.post, requestBody.query, requestBody.sourceUrl);
      if (!post || !post.contentUrl) {
        throw new ConnectorError('POST_SEARCH_POST_INVALID', 'The selected post does not contain a public URL for comment reading.');
      }
      const job = store.create({
        type: 'post_search_comments',
        status: 'queued',
        progress: 0,
        channel: 'douyin',
        channels: ['douyin'],
        query: requestBody.query,
        limit: requestBody.limit,
        randomInterval: requestBody.randomInterval,
        target: { postId: post.postId, postUrl: post.contentUrl, authorName: post.authorName, post },
        source: 'direct_content_comments',
        result: null,
        metrics: { requested: requestBody.limit, comments: 0, resultCount: 0 },
        finishedAt: null,
      });
      await store.flush();
      const outputDir = path.join(config.dataDir, 'post-search', randomUUID());
      await fs.mkdir(outputDir, { recursive: true });
      try {
        const collection = await runWithBrowserRelayLock(() => collectPlatform('douyin', {
          mode: 'comments',
          query: requestBody.query,
          limit: requestBody.limit,
          randomInterval: requestBody.randomInterval,
          outputDir,
          target: { sourceUrl: post.contentUrl, name: post.authorName },
        }));
        const comments = normalizePostSearchComments(collection.records, requestBody.limit);
        const summary = derivePostCommentSummary({ post, comments });
        const result = {
          postId: post.postId,
          postUrl: post.contentUrl,
          post,
          comments,
          summary,
          total: comments.length,
          requestedLimit: requestBody.limit,
          source: collection.source || config.platforms.douyin.mode,
          sourceUrl: collection.sourceUrl || post.contentUrl,
          collectionMeta: collection.collectionMeta || null,
          fetchedAt: new Date().toISOString(),
        };
        const status = comments.length ? 'succeeded' : 'completed_empty';
        store.patch(job.id, {
          status,
          progress: 100,
          finishedAt: result.fetchedAt,
          result,
          metrics: { requested: requestBody.limit, comments: comments.length, resultCount: comments.length },
          error: null,
        });
        store.addEvent(job.id, { level: comments.length ? 'success' : 'warn', message: `Comment collection finished with ${comments.length} result(s).` });
        await store.flush();
        sendJson(response, 200, { ...result, jobId: job.id, job: jobSummary(store.get(job.id)) });
      } catch (error) {
        store.patch(job.id, {
          status: 'failed',
          progress: 100,
          finishedAt: new Date().toISOString(),
          error: { code: error.code || 'POST_SEARCH_COMMENTS_FAILED', message: error.message || 'Comment collection failed.' },
        });
        store.addEvent(job.id, { level: 'error', message: 'Comment collection failed.' });
        await store.flush();
        throw error;
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/post-search/media') {
      const requestBody = validatePostMediaRequest(await readRequestJson(request));
      const post = normalizePostSearchRecord(requestBody.post, requestBody.query, requestBody.sourceUrl);
      if (!post || !post.contentUrl || !post.hasVideo) {
        throw new ConnectorError('POST_SEARCH_POST_INVALID', 'The selected post does not contain a public video URL.');
      }
      const job = store.create({
        type: 'post_search_media',
        status: 'queued',
        progress: 0,
        channel: 'douyin',
        channels: ['douyin'],
        query: requestBody.query,
        target: { postId: post.postId, postUrl: post.contentUrl, authorName: post.authorName, post },
        source: 'direct_content_media',
        result: null,
        metrics: { requested: 1, completed: 0, frames: 0, resultCount: 0 },
        finishedAt: null,
      });
      await store.flush();
      void runPostSearchMedia(job.id, post);
      sendJson(response, 202, {
        jobId: job.id,
        postId: post.postId,
        status: job.status,
        job: jobSummary(job),
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/post-search/profile-analysis') {
      const requestBody = validatePostProfileAnalysisRequest(await readRequestJson(request));
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const targets = requestBody.profiles.map((profile) => ({
        ...profile,
        targetId: profile.targetId || profile.id,
      }));
      const job = store.create({
        type: 'content',
        status: 'queued',
        progress: 0,
        query: requestBody.query || 'post search profile analysis',
        channels: [...new Set(targets.map((target) => target.channel))],
        campaignId: campaign?.id || null,
        discoveryJobId: null,
        targetScope: 'selected_post_authors',
        selectedCreatorIds: targets.map((target) => target.targetId),
        targets,
        contentLimit: requestBody.contentLimit,
        randomInterval: requestBody.randomInterval,
        contentModelPreference: requestBody.contentModelPreference,
        videoVisionPreference: requestBody.videoVisionPreference,
        strategy: 'standard',
        phase: 'content',
        source: 'post_search',
        metrics: {
          targetCreators: targets.length,
          contentLimit: requestBody.contentLimit,
          sourceRecords: 0,
          creators: 0,
          contentCaptures: 0,
          contentTargets: 0,
          visibleContentSamples: 0,
          pendingWorkItems: targets.length,
          profileCoverageCount: 0,
          profileResolvedCount: 0,
          profileValueCoverageCount: 0,
          catalogCoverageCount: 0,
          uniqueContentCount: 0,
          detailCoverageCount: 0,
          fullCardCoverageCount: 0,
          remainingCardCount: targets.length,
          retryCount: 0,
          storageWaterline: store.health().waterline,
        },
      });
      await store.initializeContentJob(job.id, targets);
      if (campaign) {
        store.patchCampaign(campaign.id, {
          contentJobIds: [...new Set([...(campaign.contentJobIds || []), job.id])],
          currentStep: Math.max(Number(campaign.currentStep) || 1, 4),
        });
      }
      await store.flush();
      scheduleContentCollection(job.id);
      sendJson(response, 202, {
        job: store.get(job.id),
        profiles: targets.map((target) => ({
          id: target.id,
          targetId: target.targetId,
          name: target.name,
          channel: target.channel,
          sourceUrl: target.sourceUrl,
          sourcePostIds: target.sourcePostIds,
        })),
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/post-search/follow') {
      const requestBody = validatePostFollowRequest(await readRequestJson(request));
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const now = new Date().toISOString();
      const action = {
        id: randomUUID(),
        action: 'follow',
        status: 'queued',
        delivery: 'browser_relay',
        platform: 'douyin',
        campaignId: campaign?.id || null,
        profileId: requestBody.profile.id,
        profileUrl: requestBody.profile.sourceUrl,
        authorName: requestBody.profile.name,
        query: requestBody.query,
        createdAt: now,
      };
      const persistedCampaign = campaign
        ? store.patchCampaign(campaign.id, {
          outreachFollows: [...(Array.isArray(campaign.outreachFollows) ? campaign.outreachFollows : []), action],
        })
        : null;
      const job = store.create({
        type: 'outreach_follow',
        status: 'queued',
        progress: 0,
        campaignId: campaign?.id || null,
        channel: 'douyin',
        query: requestBody.query,
        target: { profileId: action.profileId, profileUrl: action.profileUrl, authorName: action.authorName },
        result: action,
        metrics: { queued: 1, followed: 0, alreadyFollowing: 0 },
      });
      let followResult;
      try {
        followResult = await runWithBrowserRelayLock(() => deliverDouyinFollowViaRelay(
          requestBody.profile,
          config.outreach.douyin,
        ));
      } catch (error) {
        if (!(error instanceof OutreachRelayError)) throw error;
        const failedAction = {
          ...action,
          status: 'failed',
          error: { code: error.code, message: error.message },
          finishedAt: new Date().toISOString(),
        };
        store.patch(job.id, {
          status: 'failed',
          progress: 100,
          finishedAt: failedAction.finishedAt,
          metrics: { queued: 1, followed: 0, alreadyFollowing: 0, failed: 1 },
          result: failedAction,
          error: { code: error.code, message: error.message },
        });
        if (persistedCampaign) {
          const failedFollows = (persistedCampaign.outreachFollows || []).map((item) => item.id === action.id ? failedAction : item);
          store.patchCampaign(persistedCampaign.id, { outreachFollows: failedFollows });
        }
        await store.flush();
        sendJson(response, error.status || 502, {
          error: { code: error.code, message: error.message },
          follow: failedAction,
          job: jobSummary(store.get(job.id)),
          campaign: persistedCampaign ? campaignPayload(store.getCampaign(persistedCampaign.id)) : null,
        });
        return;
      }
      const finishedAt = new Date().toISOString();
      const followedAction = {
        ...action,
        status: followResult.status,
        delivery: followResult.delivery,
        provider: followResult.provider,
        finishedAt,
      };
      store.patch(job.id, {
        status: 'succeeded',
        progress: 100,
        finishedAt,
        metrics: {
          queued: 1,
          followed: followResult.status === 'followed' ? 1 : 0,
          alreadyFollowing: followResult.status === 'already_following' ? 1 : 0,
        },
        result: followedAction,
      });
      if (persistedCampaign) {
        const followedFollows = (persistedCampaign.outreachFollows || []).map((item) => item.id === action.id ? followedAction : item);
        store.patchCampaign(persistedCampaign.id, { outreachFollows: followedFollows });
      }
      await store.flush();
      sendJson(response, 202, {
        follow: followedAction,
        job: jobSummary(store.get(job.id)),
        campaign: persistedCampaign ? campaignPayload(store.getCampaign(persistedCampaign.id)) : null,
      });
      return;
    }
    const postSearchSendMatch = pathname.match(/^\/api\/post-search\/([^/]+)\/send$/);
    if (postSearchSendMatch && request.method === 'POST') {
      const requestBody = validatePostSendRequest(await readRequestJson(request));
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const post = normalizePostSearchRecord(requestBody.post, requestBody.query, requestBody.sourceUrl);
      if (!post || !post.contentUrl) {
        throw new ConnectorError('POST_SEARCH_POST_INVALID', 'The selected post does not contain a sendable public URL.');
      }
      const now = new Date().toISOString();
      const delivery = deliveryConfigSummary(config.outreach.douyin);
      const message = {
        id: randomUUID(),
        status: 'queued',
        delivery: delivery.deliveryLabel,
        platform: 'douyin',
        campaignId: campaign?.id || null,
        postId: post.postId,
        postUrl: post.contentUrl,
        authorName: post.authorName,
        authorProfile: post.authorProfile,
        messageBody: requestBody.messageBody,
        query: requestBody.query,
        sourceUrl: requestBody.sourceUrl,
        createdAt: now,
      };
      const persistedCampaign = campaign
        ? store.patchCampaign(campaign.id, {
          outreachMessages: [...(Array.isArray(campaign.outreachMessages) ? campaign.outreachMessages : []), message],
        })
        : null;
      const job = store.create({
        type: 'outreach_send',
        status: 'queued',
        progress: 0,
        campaignId: campaign?.id || null,
        channel: 'douyin',
        query: requestBody.query,
        target: { postId: post.postId, postUrl: post.contentUrl, authorName: post.authorName },
        result: message,
        metrics: { queued: 1, sent: 0 },
        finishedAt: null,
      });
      let deliveryResult;
      try {
        deliveryResult = config.outreach.douyin.mode === 'browser_relay'
          ? await runWithBrowserRelayLock(() => deliverOutreachMessage(message, config.outreach.douyin))
          : await deliverOutreachMessage(message, config.outreach.douyin);
      } catch (error) {
        if (!(error instanceof OutreachDeliveryError)) throw error;
        const failedMessage = {
          ...message,
          status: 'failed',
          error: { code: error.code, message: error.message },
          finishedAt: new Date().toISOString(),
        };
        store.patch(job.id, {
          status: 'failed',
          progress: 100,
          finishedAt: failedMessage.finishedAt,
          metrics: { queued: 1, sent: 0, failed: 1 },
          result: failedMessage,
          error: { code: error.code, message: error.message },
        });
        if (persistedCampaign) {
          const failedMessages = (persistedCampaign.outreachMessages || []).map((item) => item.id === message.id ? failedMessage : item);
          store.patchCampaign(persistedCampaign.id, { outreachMessages: failedMessages });
        }
        await store.flush();
        sendJson(response, error.status || 502, {
          error: { code: error.code, message: error.message },
          message: failedMessage,
          job: jobSummary(store.get(job.id)),
          campaign: persistedCampaign ? campaignPayload(store.getCampaign(persistedCampaign.id)) : null,
        });
        return;
      }
      const finishedAt = new Date().toISOString();
      const deliveredMessage = {
        ...message,
        status: deliveryResult.status,
        delivery: deliveryResult.delivery,
        provider: deliveryResult.provider,
        sentAt: deliveryResult.status === 'sent' ? finishedAt : null,
      };
      store.patch(job.id, {
        status: deliveryResult.status === 'sent' ? 'succeeded' : 'queued',
        progress: deliveryResult.status === 'sent' ? 100 : 0,
        finishedAt: deliveryResult.status === 'sent' ? finishedAt : null,
        metrics: { queued: 1, sent: deliveryResult.status === 'sent' ? 1 : 0 },
        result: deliveredMessage,
      });
      if (persistedCampaign) {
        const deliveredMessages = (persistedCampaign.outreachMessages || []).map((item) => item.id === message.id ? deliveredMessage : item);
        store.patchCampaign(persistedCampaign.id, { outreachMessages: deliveredMessages });
      }
      await store.flush();
      sendJson(response, 202, {
        message: deliveredMessage,
        job: jobSummary(store.get(job.id)),
        delivery: deliveryConfigSummary(config.outreach.douyin),
        campaign: persistedCampaign ? campaignPayload(store.getCampaign(persistedCampaign.id)) : null,
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/campaigns') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '12', 10);
      const campaigns = store.listCampaigns({ limit }).map((campaign) => campaignPayload(campaign));
      sendJson(response, 200, { campaigns });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/campaigns') {
      const patch = normalizeCampaignPatch(await readRequestJson(request));
      if (patch.discoveryJobId) assertDiscoveryJob(patch.discoveryJobId);
      if (patch.contentAnalysisJobId) assertContentAnalysisJob(patch.contentAnalysisJobId);
      const campaign = store.createCampaign(patch);
      await store.flush();
      sendJson(response, 201, campaignPayload(campaign));
      return;
    }
    const outreachDraftCollectionMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/outreach-drafts$/);
    if (outreachDraftCollectionMatch && request.method === 'GET') {
      const campaign = store.getCampaign(decodeURIComponent(outreachDraftCollectionMatch[1]));
      if (!campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const { contentAnalysisJob, drafts } = await resolveCampaignOutreachDraftBatch(campaign, {
        contentAnalysisJobId: url.searchParams.get('contentAnalysisJobId') || '',
      });
      sendJson(response, 200, {
        campaign: campaignPayload(campaign).campaign,
        contentAnalysisJob: jobSummary(contentAnalysisJob),
        drafts,
        summary: outreachDraftSummary(drafts),
      });
      return;
    }
    if (outreachDraftCollectionMatch && request.method === 'POST') {
      const campaign = store.getCampaign(decodeURIComponent(outreachDraftCollectionMatch[1]));
      if (!campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const body = await readRequestJson(request);
      const { contentAnalysisJob, drafts } = await resolveCampaignOutreachDraftBatch(campaign, {
        contentAnalysisJobId: body.contentAnalysisJobId || '',
        regenerate: Boolean(body.regenerate),
      });
      const persisted = persistCampaignOutreachDrafts(campaign, { contentAnalysisJob, drafts });
      await store.flush();
      sendJson(response, 201, {
        campaign: campaignPayload(persisted.campaign).campaign,
        contentAnalysisJob: jobSummary(contentAnalysisJob),
        drafts,
        summary: persisted.summary,
      });
      return;
    }
    const outreachDraftItemMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/outreach-drafts\/([^/]+)$/);
    if (outreachDraftItemMatch && request.method === 'PATCH') {
      const campaign = store.getCampaign(decodeURIComponent(outreachDraftItemMatch[1]));
      if (!campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const targetId = compactText(decodeURIComponent(outreachDraftItemMatch[2]), 180);
      const body = await readRequestJson(request);
      const unsupportedFields = Object.keys(body).filter((field) => !['messageBody', 'reviewStatus'].includes(field));
      if (unsupportedFields.length) {
        sendError(
          response,
          400,
          'OUTREACH_DRAFT_PATCH_INVALID',
          `Only messageBody and reviewStatus may be changed. Unsupported fields: ${unsupportedFields.join(', ')}.`,
        );
        return;
      }
      const { contentAnalysisJob, drafts: currentDrafts } = await resolveCampaignOutreachDraftBatch(campaign);
      const currentDraft = currentDrafts.find((draft) => draft.targetId === targetId);
      if (!currentDraft) {
        sendError(response, 404, 'OUTREACH_DRAFT_NOT_FOUND', 'Outreach draft was not found for this creator.');
        return;
      }
      if (currentDraft.status !== 'ready') {
        sendError(
          response,
          409,
          'OUTREACH_DRAFT_NOT_READY',
          currentDraft.reason?.message || 'The evidence-locked draft must be refreshed before it can be edited or sent.',
        );
        return;
      }
      const patch = {};
      if (Object.hasOwn(body, 'messageBody')) patch.messageBody = body.messageBody;
      if (Object.hasOwn(body, 'reviewStatus')) patch.reviewStatus = body.reviewStatus;
      let updatedDraft;
      try {
        updatedDraft = updateEvidenceLockedOutreachDraft(currentDraft, patch);
      } catch (error) {
        const code = compactText(error?.message, 120) || 'OUTREACH_DRAFT_UPDATE_INVALID';
        const statusCode = code === 'OUTREACH_DRAFT_NOT_READY' ? 409 : 400;
        sendError(response, statusCode, code, 'The outreach draft update is not valid for its evidence-locked state.');
        return;
      }
      const drafts = currentDrafts.map((draft) => (draft.targetId === targetId ? updatedDraft : draft));
      const persisted = persistCampaignOutreachDrafts(campaign, { contentAnalysisJob, drafts });
      await store.flush();
      sendJson(response, 200, {
        campaign: campaignPayload(persisted.campaign).campaign,
        draft: updatedDraft,
        drafts,
        summary: persisted.summary,
      });
      return;
    }
    const campaignMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
    if (campaignMatch && request.method === 'GET') {
      const campaign = store.getCampaign(decodeURIComponent(campaignMatch[1]));
      if (!campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      sendJson(response, 200, campaignPayload(campaign));
      return;
    }
    if (campaignMatch && request.method === 'PATCH') {
      const campaignId = decodeURIComponent(campaignMatch[1]);
      if (!store.getCampaign(campaignId)) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      const patch = normalizeCampaignPatch(await readRequestJson(request));
      if (patch.discoveryJobId) assertDiscoveryJob(patch.discoveryJobId);
      if (patch.contentAnalysisJobId) assertContentAnalysisJob(patch.contentAnalysisJobId);
      const campaign = store.patchCampaign(campaignId, patch);
      await store.flush();
      sendJson(response, 200, campaignPayload(campaign));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/content-history/detail') {
      const recordId = String(url.searchParams.get('id') || '').trim();
      if (!recordId) {
        sendError(response, 400, 'CONTENT_HISTORY_RECORD_REQUIRED', 'A content history record id is required.');
        return;
      }
      const matches = await contentHistoryRecords({
        query: url.searchParams.get('q') || '',
        channel: url.searchParams.get('channel') || '',
        recordType: url.searchParams.get('type') || 'all',
        includeDetails: true,
        recordId,
      });
      if (!matches.length) {
        sendError(response, 404, 'CONTENT_HISTORY_RECORD_NOT_FOUND', 'The content history record was not found.');
        return;
      }
      sendJson(response, 200, matches[0]);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/content-history/export') {
      const filters = {
        query: url.searchParams.get('q') || '',
        channel: url.searchParams.get('channel') || '',
        recordType: url.searchParams.get('type') || 'all',
      };
      const records = await contentHistoryRecords({ ...filters, includeDetails: true });
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) || 'export';
      sendJsonDownload(response, `content-history-${timestamp}.json`, {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        total: records.length,
        filters,
        records,
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/content-history') {
      const requestedCursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const cursor = Number.isFinite(requestedCursor) ? Math.max(0, requestedCursor) : 0;
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, CONTENT_HISTORY_MAX_PAGE_LIMIT)) : 50;
      const records = await contentHistoryRecords({
        query: url.searchParams.get('q') || '',
        channel: url.searchParams.get('channel') || '',
        recordType: url.searchParams.get('type') || 'all',
      });
      const page = records.slice(cursor, cursor + limit).map(({ record }) => record);
      const nextCursor = cursor + page.length < records.length ? String(cursor + page.length) : null;
      sendJson(response, 200, {
        records: page,
        cursor: String(cursor),
        nextCursor,
        total: records.length,
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/jobs') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '12', 10);
      const type = url.searchParams.get('type') || '';
      sendJson(response, 200, { jobs: store.list({ limit, type }).map(jobSummary) });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/collect') {
      const requestBody = validateCollectionRequest(await readRequestJson(request));
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      if (requestBody.type === 'verify') {
        const linkedDiscoveryJobId = requestBody.discoveryJobId || campaign?.discoveryJobId || null;
        if (campaign && !linkedDiscoveryJobId) {
          throw new ConnectorError(
            'DISCOVERY_JOB_REQUIRED',
            'A verification task must be attached to the discovery task that produced its selected creators.',
            'Restore or run a discovery task before verifying creators.',
          );
        }
        if (linkedDiscoveryJobId) {
          const linkedDiscovery = assertDiscoveryJob(linkedDiscoveryJobId);
          if (campaign && campaign.discoveryJobId !== linkedDiscovery.id) {
            throw new ConnectorError(
              'DISCOVERY_JOB_MISMATCH',
              'The verification targets do not belong to this project\'s active discovery task.',
              'Restore the matching discovery task or create a new project from it.',
            );
          }
          requestBody.discoveryJobId = linkedDiscovery.id;
        }
      }
      const job = store.create(requestBody);
      if (campaign) {
        if (requestBody.type === 'discover') {
          store.patchCampaign(campaign.id, {
            channels: requestBody.channels,
            discoveryJobId: job.id,
            selectedCreatorIds: [],
            generated: false,
            sentCreatorIds: [],
            currentStep: 3,
          });
        } else {
          store.patchCampaign(campaign.id, {
            verificationJobIds: [...new Set([...(campaign.verificationJobIds || []), job.id])],
            currentStep: 4,
          });
        }
      }
      await store.flush();
      scheduleCollection(job.id);
      sendJson(response, 202, { job });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/enrich') {
      const requestBody = validateEnrichmentRequest(await readRequestJson(request));
      const discoveryJob = assertDiscoveryJob(requestBody.discoveryJobId);
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      if (campaign && campaign.discoveryJobId && campaign.discoveryJobId !== discoveryJob.id) {
        throw new ConnectorError(
          'DISCOVERY_JOB_MISMATCH',
          'The selected creators do not belong to this project\'s active discovery task.',
          'Restore the matching discovery task or create a new project from it.',
        );
      }
      const selection = selectEnrichmentTargets(
        discoveryJob,
        requestBody.creatorIds,
        MAX_ENRICHMENT_TARGETS,
      );
      if (selection.missingIds.length) {
        throw new ConnectorError(
          'CREATOR_NOT_FOUND',
          'One or more selected creators were not found in the saved discovery task.',
          'Refresh the candidate list and select creators from that discovery task.',
        );
      }
      if (!selection.targets.length) {
        throw new ConnectorError(
          'TARGET_REQUIRED',
          'The saved discovery task has no valid creator profile records to enrich.',
          'Run or restore a discovery task with profile-linked creators first.',
        );
      }
      if (selection.truncated) {
        throw new ConnectorError(
          'ENRICHMENT_TARGET_LIMIT',
          'The selected persona batch exceeds the supported target count.',
          'Split the selected creators into separate persona tasks.',
        );
      }
      const targets = selection.targets.map((creator) => ({ ...creator, targetId: creator.id }));
      const job = store.create({
        type: 'enrich',
        status: 'queued',
        progress: 0,
        query: discoveryJob.query,
        channels: [...new Set(targets.map((target) => target.channel))],
        campaignId: campaign?.id || null,
        discoveryJobId: discoveryJob.id,
        selectedCreatorIds: targets.map((target) => target.id),
        targets,
        sourceDiscoveryMetrics: {
          sourceRecords: discoveryJob.metrics?.sourceRecords || 0,
          creators: discoveryJob.metrics?.creators || discoveryJob.results?.length || 0,
        },
        metrics: {
          targetCreators: targets.length,
          sourceRecords: 0,
          creators: 0,
          enrichedCreators: 0,
          enrichedTargets: 0,
          pendingWorkItems: targets.length,
        },
      });
      if (campaign) {
        store.patchCampaign(campaign.id, {
          enrichmentJobIds: [...new Set([...(campaign.enrichmentJobIds || []), job.id])],
          currentStep: Math.max(Number(campaign.currentStep) || 1, 4),
        });
      }
      await store.flush();
      scheduleEnrichment(job.id);
      sendJson(response, 202, { job: store.get(job.id) });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/content-collect') {
      const requestBody = validateContentCollectionRequest(await readRequestJson(request));
      const discoveryJob = assertDiscoveryJob(requestBody.discoveryJobId);
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      if (campaign && campaign.discoveryJobId && campaign.discoveryJobId !== discoveryJob.id) {
        throw new ConnectorError(
          'DISCOVERY_JOB_MISMATCH',
          'The selected creators do not belong to this project\'s active discovery task.',
          'Restore the matching discovery task or create a new project from it.',
        );
      }
      const selection = selectEnrichmentTargets(
        discoveryJob,
        requestBody.creatorIds,
        MAX_CONTENT_COLLECTION_TARGETS,
      );
      if (selection.missingIds.length) {
        throw new ConnectorError(
          'CREATOR_NOT_FOUND',
          'One or more selected creators were not found in the saved discovery task.',
          'Refresh the candidate list and select creators from that discovery task.',
        );
      }
      if (!selection.targets.length) {
        throw new ConnectorError(
          'TARGET_REQUIRED',
          'The saved discovery task has no valid creator profile records for content collection.',
          'Run or restore a discovery task with profile-linked creators first.',
        );
      }
      if (selection.truncated) {
        throw new ConnectorError(
          'CONTENT_TARGET_LIMIT',
          'The selected content batch exceeds the supported target count.',
          'Split the selected creators into separate content collection tasks.',
        );
      }
      const targets = selection.targets.map((creator) => ({ ...creator, targetId: creator.id }));
      const job = store.create({
        type: 'content',
        status: 'queued',
        progress: 0,
        query: discoveryJob.query,
        channels: [...new Set(targets.map((target) => target.channel))],
        campaignId: campaign?.id || null,
        discoveryJobId: discoveryJob.id,
        targetScope: requestBody.targetScope,
        selectedCreatorIds: targets.map((target) => target.id),
        targets,
        contentLimit: requestBody.contentLimit,
        randomInterval: requestBody.randomInterval,
        strategy: requestBody.strategy,
        phase: requestBody.strategy === 'breadth_first_full' ? 'profile' : 'content',
        sourceDiscoveryMetrics: {
          sourceRecords: discoveryJob.metrics?.sourceRecords || 0,
          creators: discoveryJob.metrics?.creators || discoveryJob.results?.length || 0,
        },
        metrics: {
          targetCreators: targets.length,
          contentLimit: requestBody.contentLimit,
          sourceRecords: 0,
          creators: 0,
          contentCaptures: 0,
          contentTargets: 0,
          visibleContentSamples: 0,
          pendingWorkItems: targets.length,
          profileCoverageCount: 0,
          profileResolvedCount: 0,
          profileValueCoverageCount: 0,
          catalogCoverageCount: 0,
          uniqueContentCount: 0,
          detailCoverageCount: 0,
          fullCardCoverageCount: 0,
          remainingCardCount: targets.length,
          retryCount: 0,
          storageWaterline: store.health().waterline,
        },
      });
      await store.initializeContentJob(job.id, targets);
      if (campaign) {
        store.patchCampaign(campaign.id, {
          contentJobIds: [...new Set([...(campaign.contentJobIds || []), job.id])],
          currentStep: Math.max(Number(campaign.currentStep) || 1, 4),
        });
      }
      await store.flush();
      scheduleContentCollection(job.id);
      sendJson(response, 202, { job: store.get(job.id) });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/content-analysis') {
      const requestBody = validateContentAnalysisRequest(await readRequestJson(request));
      const contentJob = store.get(requestBody.contentJobId);
      if (!contentJob || contentJob.type !== 'content') {
        throw new ConnectorError(
          'CONTENT_SOURCE_JOB_INVALID',
          'The selected source task is not a creator content collection task.',
          'Select a completed creator content collection task before running the analysis matrix.',
        );
      }
      if (['queued', 'running', 'interrupted'].includes(contentJob.status)) {
        sendError(response, 409, 'CONTENT_SOURCE_JOB_ACTIVE', 'The source content task is still active.', 'Wait for its saved content captures before starting the analysis matrix.');
        return;
      }
      const campaign = requestBody.campaignId ? store.getCampaign(requestBody.campaignId) : null;
      if (requestBody.campaignId && !campaign) {
        sendError(response, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
        return;
      }
      if (campaign && campaign.discoveryJobId && campaign.discoveryJobId !== contentJob.discoveryJobId) {
        throw new ConnectorError(
          'DISCOVERY_JOB_MISMATCH',
          'The source content task does not belong to this project\'s active discovery task.',
          'Select a content task created from this project\'s active discovery task.',
        );
      }
      const sourceCaptures = await analysisSourceCaptures(contentJob, requestBody.creatorIds);
      const targets = sourceCaptures.map(contentAnalysisTarget);
      const sourceVisibleContentSamples = sourceCaptures.reduce(
        (total, capture) => total + contentCaptureVisibleSampleCount(capture),
        0,
      );
      const job = store.create({
        type: 'content_analysis',
        status: 'queued',
        progress: 0,
        query: contentJob.query,
        channels: [...new Set(targets.map((target) => target.channel))],
        campaignId: campaign?.id || null,
        discoveryJobId: contentJob.discoveryJobId || null,
        contentJobId: contentJob.id,
        targetScope: requestBody.targetScope,
        selectedCreatorIds: targets.map((target) => target.targetId),
        sourceCaptures,
        campaignBrief: campaign?.brief || {},
        contentModelPreference: requestBody.contentModelPreference,
        videoVisionPreference: requestBody.videoVisionPreference,
        sourceContentMetrics: {
          contentCaptures: contentJob.metrics?.contentCaptures || sourceCaptures.length,
          visibleContentSamples: sourceVisibleContentSamples,
        },
        metrics: {
          targetCreators: sourceCaptures.length,
          analyzedCreators: 0,
          analysisTargets: 0,
          visibleContentSamples: 0,
          sourceContentJobId: contentJob.id,
          sourceVisibleContentSamples,
          pendingWorkItems: sourceCaptures.length,
        },
      });
      if (campaign) {
        store.patchCampaign(campaign.id, {
          contentAnalysisJobIds: [...new Set([...(campaign.contentAnalysisJobIds || []), job.id])],
          contentAnalysisJobId: job.id,
          currentStep: Math.max(Number(campaign.currentStep) || 1, 4),
        });
      }
      await store.flush();
      scheduleContentAnalysis(job.id);
      sendJson(response, 202, { job: store.get(job.id) });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/audience-insights') {
      const rawDiscoveryJobId = url.searchParams.get('discoveryJobId') || '';
      const discoveryJobId = normalizeLocalId(rawDiscoveryJobId);
      if (!discoveryJobId) {
        throw new ConnectorError(
          'DISCOVERY_JOB_REQUIRED',
          'Select a saved discovery task before reading audience insights.',
          'Restore a discovery task and open its creator detail panel.',
        );
      }
      const creatorId = compactText(url.searchParams.get('creatorId') || '', 180);
      assertDiscoveryJob(discoveryJobId);
      sendJson(response, 200, {
        discoveryJobId,
        audienceInsights: audienceInsightsForDiscovery(discoveryJobId, creatorId),
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/audience-insights/import') {
      const requestBody = validateAudienceInsightRequest(await readRequestJson(request));
      const discoveryJob = assertDiscoveryJob(requestBody.discoveryJobId);
      const creator = selectedDiscoveryCreator(discoveryJob, requestBody.creatorId);
      let audienceInsight;
      try {
        audienceInsight = deriveAudienceInsights({
          ...requestBody.payload,
          discoveryJobId: discoveryJob.id,
          creatorId: creator.id,
          creatorName: creator.name,
          channel: creator.channel,
        });
      } catch (error) {
        if (error instanceof AudienceInsightsError) {
          throw new ConnectorError(
            error.code,
            error.message,
            'Use an official or authorized aggregate audience export without individual fan records.',
          );
        }
        throw error;
      }

      const previous = store.listAll({ type: 'audience' }).find((job) => (
        job.discoveryJobId === discoveryJob.id
        && job.audienceInsight?.creatorId === creator.id
      ));
      const completedAt = new Date().toISOString();
      const fields = {
        type: 'audience',
        status: 'succeeded',
        progress: 100,
        query: discoveryJob.query,
        channels: [creator.channel],
        discoveryJobId: discoveryJob.id,
        selectedCreatorIds: [creator.id],
        results: [],
        audienceInsight,
        metrics: {
          audienceInsights: 1,
          totalAudience: audienceInsight.profile?.totalAudience ?? null,
          dimensions: [
            ['gender', audienceInsight.gender],
            ['age', audienceInsight.age],
            ['cityTier', audienceInsight.cityTier],
            ['interests', audienceInsight.interests],
            ['activeHours', audienceInsight.activeHours],
            ...Object.entries(audienceInsight.dimensions || {}).map(([name, dimension]) => [name, dimension?.rows]),
          ].filter(([, rows]) => Array.isArray(rows) && rows.length).map(([name]) => name),
          sourceType: audienceInsight.source.type,
          capturedAt: audienceInsight.capturedAt,
        },
        startedAt: completedAt,
        finishedAt: completedAt,
        error: null,
      };
      const job = previous ? store.patch(previous.id, fields) : store.create(fields);
      store.addEvent(job.id, {
        level: 'success',
        message: `Aggregate audience insight imported for ${creator.name}.`,
      });
      await writeAudienceInsightArtifact(job.id, audienceInsight);
      await store.flush();
      sendJson(response, previous ? 200 : 201, {
        job: jobSummary(store.get(job.id)),
        audienceInsight,
        artifactsUrl: `/api/jobs/${encodeURIComponent(job.id)}/artifacts`,
      });
      return;
    }
    const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
    if (resumeMatch && request.method === 'POST') {
      const jobId = decodeURIComponent(resumeMatch[1]);
      let job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      const recoveredContinuation = recoverContentContinuationState(job);
      if (recoveredContinuation.changed) {
        store.patch(job.id, {
          status: recoveredContinuation.job.status,
          channelResults: recoveredContinuation.job.channelResults,
          metrics: recoveredContinuation.job.metrics,
          error: null,
        });
        store.addEvent(job.id, {
          level: 'warn',
          message: 'Recovered ' + recoveredContinuation.resumedTargetIds.length
            + ' saved public content capture(s) marked continuation-recommended; only those profile(s) remain queued for resume.',
        });
        await store.flush();
        job = store.get(job.id);
      }
      if (['queued', 'running'].includes(job.status)) {
        sendError(response, 409, 'JOB_ACTIVE', 'Collection job is already running.');
        return;
      }
      if (!['interrupted', 'failed', 'waiting_for_connection', 'waiting_for_configuration', 'partial_success'].includes(job.status)) {
        sendError(response, 409, 'JOB_NOT_RESUMABLE', 'This collection job has no unfinished connector work item to resume.');
        return;
      }
      if (!pendingWorkItems(job).length) {
        sendError(response, 409, 'JOB_NOT_RESUMABLE', 'This collection job has no unfinished connector work item to resume.');
        return;
      }
      store.patch(job.id, { status: 'queued', progress: Math.min(Number(job.progress) || 0, 95), finishedAt: null, error: null });
      store.addEvent(job.id, { level: 'info', message: 'Collection queued for resume; completed connector items will be retained.' });
      await store.flush();
      if (job.type === 'enrich') scheduleEnrichment(job.id, { resume: true });
      else if (job.type === 'content') scheduleContentCollection(job.id, { resume: true });
      else if (job.type === 'content_analysis') scheduleContentAnalysis(job.id, { resume: true });
      else scheduleCollection(job.id, { resume: true });
      sendJson(response, 202, { job: store.get(job.id) });
      return;
    }
    const personasMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/personas$/);
    if (personasMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(personasMatch[1]);
      const job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (job.type !== 'enrich') {
        sendError(response, 400, 'PERSONA_JOB_REQUIRED', 'This endpoint is available for persona enrichment tasks.');
        return;
      }
      const hydratedJob = hydrateJobPersonas(job);
      sendJson(response, 200, {
        job: jobSummary(job),
        personas: hydratedJob.results || [],
        artifactsUrl: '/api/jobs/' + encodeURIComponent(job.id) + '/artifacts',
      });
      return;
    }
    const contentMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/content$/);
    if (contentMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(contentMatch[1]);
      const job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (job.type !== 'content') {
        sendError(response, 400, 'CONTENT_JOB_REQUIRED', 'This endpoint is available for creator content collection tasks.');
        return;
      }
      const hasPagination = url.searchParams.has('cursor') || url.searchParams.has('limit');
      const page = store.listContent(job.id, {
        cursor: url.searchParams.get('cursor') || '0',
        limit: url.searchParams.get('limit') || '50',
      });
      const content = hasPagination ? page.content : await store.loadContentCaptures(job.id);
      sendJson(response, 200, {
        job: jobSummary(job),
        content,
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        total: page.total,
        artifactsUrl: '/api/jobs/' + encodeURIComponent(job.id) + '/artifacts',
      });
      return;
    }
    const contentSamplesMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/content\/([^/]+)\/samples$/);
    if (contentSamplesMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(contentSamplesMatch[1]);
      const targetId = decodeURIComponent(contentSamplesMatch[2]);
      const job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (job.type !== 'content') {
        sendError(response, 400, 'CONTENT_JOB_REQUIRED', 'This endpoint is available for creator content collection tasks.');
        return;
      }
      const page = await store.listContentSamples(job.id, targetId, {
        cursor: url.searchParams.get('cursor') || '0',
        limit: url.searchParams.get('limit') || '50',
      });
      if (!page.target) {
        sendError(response, 404, 'CONTENT_TARGET_NOT_FOUND', 'The creator content capture was not found.');
        return;
      }
      sendJson(response, 200, page);
      return;
    }
    const contentAnalysisMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/content-analysis$/);
    if (contentAnalysisMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(contentAnalysisMatch[1]);
      const job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (job.type !== 'content_analysis') {
        sendError(response, 400, 'CONTENT_ANALYSIS_JOB_REQUIRED', 'This endpoint is available for creator content analysis tasks.');
        return;
      }
      sendJson(response, 200, {
        job: jobSummary(job),
        analyses: contentAnalysisRowsWithFreshness(job),
        artifactsUrl: '/api/jobs/' + encodeURIComponent(job.id) + '/artifacts',
      });
      return;
    }
    const artifactMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/artifacts(?:\/(.*))?$/);
    if (artifactMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(artifactMatch[1]);
      const job = store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (!artifactMatch[2]) {
        sendJson(response, 200, { jobId, artifacts: await artifactsForJob(job) });
        return;
      }
      const artifactPath = artifactPathFor(jobId, artifactMatch[2]);
      if (!artifactPath) {
        sendError(response, 400, 'ARTIFACT_INVALID', 'Artifact path is not valid.');
        return;
      }
      let stat;
      try {
        stat = await fs.stat(artifactPath);
      } catch {
        sendError(response, 404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.');
        return;
      }
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
        sendError(response, 413, 'ARTIFACT_UNAVAILABLE', 'Artifact is not available for product download.');
        return;
      }
      const content = await fs.readFile(artifactPath);
      const extension = path.extname(artifactPath).toLowerCase();
      const contentType = ARTIFACT_CONTENT_TYPES[extension] || 'application/octet-stream';
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': content.length,
        'cache-control': 'no-store',
        'content-disposition': contentType.startsWith('image/') || contentType.startsWith('video/')
          ? `inline; filename="${path.basename(artifactPath)}"`
          : `attachment; filename="${path.basename(artifactPath)}"`,
      });
      response.end(content);
      return;
    }
    const candidatesMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/candidates$/);
    if (candidatesMatch && request.method === 'GET') {
      const job = store.get(decodeURIComponent(candidatesMatch[1]));
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      if (job.type !== 'discover') {
        sendError(response, 400, 'DISCOVERY_JOB_REQUIRED', 'Candidate pages are available only for discovery tasks.');
        return;
      }
      const requestedOffset = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
      const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '1000', 10);
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 1000));
      const allCandidates = Array.isArray(job.results) ? job.results : [];
      const candidates = allCandidates.slice(offset, offset + limit);
      const nextOffset = offset + candidates.length;
      sendJson(response, 200, {
        job: jobSummary(job),
        candidates,
        offset,
        limit,
        total: allCandidates.length,
        nextCursor: nextOffset < allCandidates.length ? String(nextOffset) : null,
      });
      return;
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(jobMatch[1]);
      const summaryOnly = url.searchParams.get('summary') === '1';
      const job = summaryOnly ? store.inspect(jobId) : store.get(jobId);
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Collection job was not found.');
        return;
      }
      sendJson(response, 200, {
        job: summaryOnly ? jobSummary(job) : hydrateJobPersonas(job),
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendError(response, 404, 'API_NOT_FOUND', 'API endpoint was not found.');
      return;
    }
    if (await serveStatic(request, response, pathname)) return;
    sendError(response, 404, 'NOT_FOUND', 'Page was not found.');
  } catch (error) {
    const problem = error instanceof ConnectorError
      ? error
      : error instanceof AudienceInsightsError
        ? new ConnectorError(error.code, error.message, 'Use an official or authorized aggregate audience export without individual fan records.')
        : new ConnectorError('INTERNAL_ERROR', error.message || 'Server request failed.');
    const statusCode = CONNECTION_WAIT_CODES.has(problem.code)
      ? 409
      : [
      'INVALID_JSON', 'CHANNEL_REQUIRED', 'QUERY_REQUIRED', 'TARGET_REQUIRED', 'TARGET_INVALID',
      'TARGET_SOURCE_INVALID', 'TARGET_ID_DUPLICATE', 'TARGET_LIMIT_EXCEEDED', 'CAMPAIGN_INVALID',
      'DISCOVERY_JOB_INVALID', 'DISCOVERY_JOB_REQUIRED', 'DISCOVERY_JOB_MISMATCH', 'PAYLOAD_TOO_LARGE',
      'CREATOR_IDS_INVALID', 'CREATOR_NOT_FOUND', 'ENRICHMENT_TARGET_LIMIT', 'PERSONA_JOB_REQUIRED',
      'CONTENT_TARGET_LIMIT', 'CONTENT_SAMPLE_LIMIT_INVALID', 'CONTENT_JOB_REQUIRED',
      'CONTENT_SOURCE_JOB_REQUIRED', 'CONTENT_SOURCE_JOB_INVALID', 'CONTENT_ANALYSIS_TARGET_LIMIT',
      'CONTENT_ANALYSIS_SOURCE_EMPTY', 'CONTENT_CAPTURE_NOT_FOUND', 'CONTENT_ANALYSIS_JOB_REQUIRED',
      'CREATOR_ID_REQUIRED', 'AUDIENCE_INPUT_INVALID', 'AGGREGATE_SOURCE_REQUIRED', 'AUDIENCE_DETAIL_NOT_ALLOWED',
      'POST_SEARCH_QUERY_REQUIRED', 'POST_SEARCH_POST_REQUIRED', 'POST_SEARCH_POST_INVALID', 'MESSAGE_REQUIRED',
      'POST_PROFILE_SOURCE_INVALID', 'POST_PROFILE_SELECTION_REQUIRED', 'POST_PROFILE_TARGET_LIMIT',
      ].includes(problem.code) ? 400 : 500;
    sendError(response, statusCode, problem.code, problem.message, problem.action);
  }
}

await douyinCommentJobs.init();
const primaryStoreInitialization = store.init()
  .then(() => {
    primaryStoreReady = true;
  })
  .catch((error) => {
    primaryStoreInitializationError = error;
    console.error('Primary task store initialization failed:', error);
  });
const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS' && allowLocalDevCors(request, response)) {
    response.writeHead(204);
    response.end();
    return;
  }
  allowLocalDevCors(request, response);
  void handle(request, response);
});
server.listen(config.port, config.host, () => {
  console.log(`KOL collection API listening on http://${config.host}:${config.port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await douyinCommentJobs.shutdown();
  await primaryStoreInitialization;
  await store.flush();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
