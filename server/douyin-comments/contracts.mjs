import { createHash } from 'node:crypto';

export const DOUYIN_COMMENT_JOB_VERSION = 1;
export const DOUYIN_COMMENT_MAX_LANES = 10;
export const DOUYIN_COMMENT_LANE_PRESETS = [1, 2, 4, 6, 8, 10];
export const DOUYIN_COMMENT_DEFAULT_LANES = 8;
export const DOUYIN_COMMENT_PAGE_SIZE = 50;
export const DOUYIN_COMMENT_LEASE_MS = 45_000;
export const DOUYIN_COMMENT_HEARTBEAT_MS = 10_000;

export class DouyinCommentError extends Error {
  constructor(code, message, statusCode = 400, action = '') {
    super(message);
    this.name = 'DouyinCommentError';
    this.code = code;
    this.statusCode = statusCode;
    this.action = action;
  }
}

export function asText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function asId(value) {
  return String(value ?? '').trim();
}

export function asInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function isoNow(now = new Date()) {
  return now.toISOString();
}

export function ensureJobId(value) {
  const id = asText(value);
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/i.test(id)) {
    throw new DouyinCommentError('JOB_ID_INVALID', 'The comment collection job id is invalid.');
  }
  return id;
}

export function normalizeConcurrency(input = {}) {
  const requestedMode = asText(input.mode, 'adaptive').toLowerCase();
  const mode = requestedMode === 'fixed' ? 'fixed' : 'adaptive';
  const requested = asInteger(input.maxLanes ?? input.lanes, DOUYIN_COMMENT_DEFAULT_LANES);
  const nearest = DOUYIN_COMMENT_LANE_PRESETS.includes(requested)
    ? requested
    : DOUYIN_COMMENT_LANE_PRESETS.reduce((best, candidate) => (
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
    ), DOUYIN_COMMENT_DEFAULT_LANES);
  return { mode, maxLanes: Math.min(DOUYIN_COMMENT_MAX_LANES, nearest) };
}

export function normalizeProfileUrl(value) {
  const raw = asText(value);
  if (!raw) {
    throw new DouyinCommentError('PROFILE_URL_REQUIRED', 'Enter a Douyin creator profile URL.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DouyinCommentError('PROFILE_URL_INVALID', 'The profile URL is not a valid URL.');
  }
  const hostname = url.hostname.toLowerCase();
  const supportedHost = hostname === 'douyin.com' || hostname.endsWith('.douyin.com');
  if (url.protocol !== 'https:' || !supportedHost || !/^\/user\//.test(url.pathname)) {
    throw new DouyinCommentError(
      'PROFILE_URL_INVALID',
      'Use a public https://www.douyin.com/user/... profile URL.',
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeDouyinSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DouyinCommentError('PROFILE_URL_INVALID', 'The profile URL is not a valid URL.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(hostname === 'douyin.com' || hostname.endsWith('.douyin.com'))) {
    throw new DouyinCommentError('PROFILE_URL_INVALID', 'Use an HTTPS Douyin creator link.');
  }
  return url.toString();
}

export function normalizeProfileInput(value) {
  const profileInput = asText(value).slice(0, 500);
  if (!profileInput) {
    throw new DouyinCommentError('PROFILE_INPUT_REQUIRED', 'Enter a Douyin creator name or profile URL.');
  }
  if (/^https?:\/\//i.test(profileInput)) {
    try {
      return { profileInput, profileUrl: normalizeProfileUrl(profileInput), profileName: '', profileSourceUrl: '' };
    } catch (error) {
      if (!(error instanceof DouyinCommentError) || error.code !== 'PROFILE_URL_INVALID') throw error;
      return { profileInput, profileUrl: '', profileName: '', profileSourceUrl: normalizeDouyinSourceUrl(profileInput) };
    }
  }
  const profileName = profileInput.replace(/^@+/, '').trim();
  if (!profileName) {
    throw new DouyinCommentError('PROFILE_INPUT_INVALID', 'Enter a valid Douyin creator name or profile URL.');
  }
  return { profileInput, profileUrl: '', profileName: profileName.slice(0, 120), profileSourceUrl: '' };
}

export function normalizeCreateRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DouyinCommentError('REQUEST_INVALID', 'The collection request must be a JSON object.');
  }
  if (input.downloadMedia === true || input.includeMedia === true) {
    throw new DouyinCommentError(
      'MEDIA_DOWNLOAD_FORBIDDEN',
      'This workflow stores comment data only and never downloads media.',
    );
  }
  const target = normalizeProfileInput(input.profileInput || input.profileUrl);
  const expectedCreatorName = asText(input.expectedCreatorName || target.profileName).slice(0, 120);
  const label = asText(input.label || target.profileName).slice(0, 120);
  const seedVideoId = asId(input.seedVideoId);
  if (seedVideoId && !/^\d{10,32}$/.test(seedVideoId)) {
    throw new DouyinCommentError('SEED_VIDEO_ID_INVALID', 'The optional seed video id must contain digits only.');
  }
  return {
    ...target,
    expectedCreatorName,
    label,
    seedVideoId,
    concurrency: normalizeConcurrency(input.concurrency),
    autoResume: input.autoResume !== false,
    mediaPolicy: 'forbidden',
  };
}

export function normalizeConcurrencyUpdate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DouyinCommentError('CONCURRENCY_INVALID', 'Concurrency settings must be a JSON object.');
  }
  return normalizeConcurrency(input);
}

export function taskIdFor(kind, videoId, rootCommentId = '') {
  const source = [kind, asId(videoId), asId(rootCommentId)].join(':');
  return createHash('sha256').update(source).digest('hex').slice(0, 32);
}

export function normalizeCatalogVideo(candidate) {
  const rawUrl = asText(candidate?.video_url || candidate?.url || candidate?.href);
  const match = rawUrl.match(/\/(video|note)\/(\d{10,32})(?:[/?#]|$)/);
  const videoId = asId(candidate?.video_id || match?.[2]);
  if (!videoId || !/^\d{10,32}$/.test(videoId)) return null;
  const contentType = candidate?.content_type === 'note' || match?.[1] === 'note' ? 'note' : 'video';
  return {
    video_id: videoId,
    content_type: contentType,
    url: rawUrl || `https://www.douyin.com/${contentType}/${videoId}`,
    video_url: rawUrl || `https://www.douyin.com/${contentType}/${videoId}`,
    card_text: asText(candidate?.card_text || candidate?.title || candidate?.text),
    video_title: asText(candidate?.video_title || candidate?.title || candidate?.card_text),
  };
}

export function sortCatalogVideos(videos) {
  return [...videos].sort((left, right) => left.video_id.localeCompare(right.video_id));
}

export function summarizeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    version: job.version,
    status: job.status,
    phase: job.phase,
    profileUrl: job.profileUrl,
    profileInput: job.profileInput || job.profileUrl,
    profileName: job.profileName || '',
    profileSourceUrl: job.profileSourceUrl || '',
    expectedCreatorName: job.expectedCreatorName,
    label: job.label,
    concurrency: job.concurrency,
    autoResume: job.autoResume !== false,
    effectiveLanes: job.effectiveLanes,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || '',
    completedAt: job.completedAt || '',
    pausedAt: job.pausedAt || '',
    nextAutoResumeAt: job.nextAutoResumeAt || '',
    connectionRecoveryAttempts: Number(job.connectionRecoveryAttempts || 0),
    lastError: job.lastError || null,
    artifacts: job.artifacts || [],
  };
}

export function isTerminalJobStatus(status) {
  return ['complete', 'public_api_complete_with_gap', 'cancelled', 'failed'].includes(status);
}

export function isTerminalTaskStatus(status) {
  return ['complete', 'public_api_complete_with_gap', 'cancelled', 'failed'].includes(status);
}

export function publicError(error) {
  if (error instanceof DouyinCommentError) return error;
  const message = error instanceof Error ? error.message : String(error || 'Unexpected collection error.');
  return new DouyinCommentError('DOUYIN_COMMENT_INTERNAL', message, 500);
}
