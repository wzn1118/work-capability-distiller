/**
 * Collect public, rendered Douyin creator and content cards through the
 * attached Browser Relay. This intentionally observes the visible page only:
 * it never exports browser credentials, reads private follower lists, or
 * intercepts platform API payloads.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOUYIN_RELAY_PORT } from '../config.mjs';
import { createRandomIntervalController, normalizeRandomInterval } from '../collection-timing.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REQUIRE = createRequire(import.meta.url);
const PLATFORM_HOST = 'douyin.com';
const MAX_DISCOVERY_RESULTS = 10_000;
const MAX_PROFILE_SAMPLES = 10_000;
// Two temporary public detail tabs keep the attached interactive session
// responsive while avoiding a large navigation burst against the platform.
const MAX_CONCURRENT_VISIBLE_DETAIL_PAGES = 2;
const DETAIL_PAGE_OPEN_TIMEOUT_MS = 12_000;
// The previous 500ms fixed settle plus this selector wait totaled 3 seconds
// for a slow page. Wait for the visible marker immediately instead: fast pages
// proceed as soon as they render, while slow pages retain the same window.
const DETAIL_PAGE_READY_TIMEOUT_MS = 3_000;
const DETAIL_PAGE_RETRY_DELAY_MS = 1_000;
const DETAIL_PAGE_RETRY_TIMEOUT_MS = 2_500;
// Different rendered detail layouts expose either the publish-time element or
// the detail-info/action surface first.  Treat both as readiness so a valid
// visible detail page is not held behind a selector that this layout omits.
const VISIBLE_DETAIL_READY_SELECTOR = [
  '[data-e2e="detail-video-publish-time"]',
  '[data-e2e*=detail-video-info]',
  '[data-e2e*=detail-video] [data-e2e*=share]',
  '[class*=video-detail] video',
  '[class*=VideoDetail] video',
].join(', ');
const MAX_DISCOVERY_SCROLLS = 1_800;
const MAX_PROFILE_SCROLLS = 2_500;
const MAX_IDLE_SCROLLS = 8;
const MAX_PROFILE_IDLE_SCROLLS = 5;
const RELAY_ATTACH_ATTEMPTS = 2;
const RELAY_ATTACH_TIMEOUT_MS = 30_000;
const RELAY_TARGET_CLEANUP_TIMEOUT_MS = 2_500;
const PAGE_OPEN_ATTEMPTS = 3;
const SEARCH_HYDRATION_ATTEMPTS = 12;
const SEARCH_HYDRATION_DELAY_MS = 400;
const PROFILE_HYDRATION_ATTEMPTS = 12;
// Some profile grids remain empty until their first user-visible scroll. Keep
// the pre-scroll check short; collectProfile continues with the full bounded
// scroll path when this window expires.
const PROFILE_EARLY_HYDRATION_ATTEMPTS = 4;
const PROFILE_HYDRATION_DELAY_MS = 400;
const MAX_SEARCH_PAGE_LOADS = 2;
const SEARCH_RELOAD_DELAY_MS = 1_000;
const LOGIN_MARKERS = [
  '\u8bf7\u767b\u5f55',
  '\u7acb\u5373\u767b\u5f55',
  '\u626b\u7801\u767b\u5f55',
  '\u624b\u673a\u53f7\u767b\u5f55',
  '\u767b\u5f55\u540e\u67e5\u770b',
  '\u767b\u5f55\u540e\u53ef\u89c1',
];
const VERIFICATION_MARKERS = [
  '\u5b89\u5168\u9a8c\u8bc1',
  '\u6ed1\u52a8\u9a8c\u8bc1',
  '\u4eba\u673a\u9a8c\u8bc1',
  '\u5b8c\u6210\u9a8c\u8bc1',
  '\u5f02\u5e38\u8bbf\u95ee',
  '\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41',
];

const EXIT_SUCCESS = 0;
const EXIT_EMPTY = 1;
const EXIT_LOGIN_REQUIRED = 2;
const EXIT_RELAY_ERROR = 3;
const EXIT_VERIFICATION_REQUIRED = 4;
const EXIT_INVALID_INPUT = 5;

function text(value, maximum = 0) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return maximum > 0 ? normalized.slice(0, maximum) : normalized;
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function relayPort(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

export function isDouyinUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === PLATFORM_HOST || host.endsWith(`.${PLATFORM_HOST}`));
  } catch {
    return false;
  }
}

export function canonicalDouyinUrl(value, { retainSearch = false } = {}) {
  if (!isDouyinUrl(value)) return '';
  const parsed = new URL(value);
  parsed.hash = '';
  if (!retainSearch) parsed.search = '';
  return parsed.toString();
}

export function canonicalDouyinContentUrl(value) {
  const canonical = canonicalDouyinUrl(value);
  if (!canonical) return '';
  const parsed = new URL(canonical);
  const match = parsed.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
  return match ? `https://www.${PLATFORM_HOST}/${match[1].toLowerCase()}/${match[2]}` : '';
}

function publicText(value, maximum = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value, maximum);
}

function publicMetric(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  const normalized = publicText(value, 64).replace(/,/g, '');
  return /^[0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?$/i.test(normalized) ? normalized : '';
}

function publicPublishedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const normalized = publicText(value, 80);
  if (/^\d{10,13}$/.test(normalized)) return Number(normalized);
  return /^20\d{2}[./-]\d{1,2}[./-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized)
    ? normalized
    : '';
}

function publicDurationSeconds(value) {
  const clock = publicText(value, 32).match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const hours = Number(clock[3] || 0);
    const minutes = Number(clock[1]);
    const seconds = Number(clock[2]);
    const total = clock[3] ? (hours * 3_600) + (minutes * 60) + seconds : (minutes * 60) + seconds;
    return total > 0 && total <= 86_400 ? total : null;
  }
  const milliseconds = typeof value === 'number' ? value : Number(publicText(value, 32));
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const seconds = milliseconds > 86_400 ? Math.round(milliseconds / 1_000) : Math.round(milliseconds);
  return seconds > 0 && seconds <= 86_400 ? seconds : null;
}

function publicLeadingMetric(value) {
  const match = publicText(value, 900).match(/^\s*(?:\d{1,3}:\d{2}(?::\d{2})?|\u56fe\u6587|\u56fe\u96c6|\u56fe\u7247)\s+([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)/i);
  return match ? match[1] : '';
}

function publicStatistics(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fields = [
    'digg_count', 'collect_count', 'comment_count', 'share_count', 'forward_count', 'play_count',
  ];
  const statistics = {};
  for (const field of fields) {
    const metric = publicMetric(source[field]);
    if (metric !== '') statistics[field] = metric;
  }
  return statistics;
}

function publicInteractionAvailability(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const name of ['likes', 'collects', 'comments', 'shares']) {
    const entry = source[name];
    const rawState = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry.state
      : entry;
    const state = text(rawState, 64);
    if (!['count_observed', 'action_visible_count_not_shown', 'not_visible'].includes(state)) continue;
    const rawSource = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry.source
      : '';
    result[name] = {
      state,
      ...(text(rawSource, 64) ? { source: text(rawSource, 64) } : {}),
    };
  }
  return result;
}

export function mergeDouyinVisibleSamples(existing, incoming) {
  const current = existing && typeof existing === 'object' ? existing : {};
  const candidate = incoming && typeof incoming === 'object' ? incoming : {};
  const currentAvailability = publicInteractionAvailability(current.interaction_availability);
  const candidateAvailability = publicInteractionAvailability(candidate.interaction_availability);
  const mergedAvailability = { ...currentAvailability, ...candidateAvailability };
  const merged = { ...current };
  for (const [key, value] of Object.entries(candidate)) {
    if (key === 'statistics') {
      const statistics = { ...publicStatistics(current.statistics), ...publicStatistics(value) };
      // Detail pages are the source of truth for action counts. If a visible
      // action has no number, remove any card-level residue instead of showing
      // an unsupported zero or a shifted neighboring count.
      const metricByAction = {
        likes: 'digg_count',
        comments: 'comment_count',
        collects: 'collect_count',
        shares: 'share_count',
      };
      for (const [action, metric] of Object.entries(metricByAction)) {
        if (candidateAvailability[action]?.state === 'action_visible_count_not_shown') delete statistics[metric];
      }
      merged.statistics = statistics;
      continue;
    }
    if (key === 'interaction_availability') {
      merged.interaction_availability = mergedAvailability;
      continue;
    }
    if (Array.isArray(value)) {
      const retained = Array.isArray(current[key]) ? current[key] : [];
      merged[key] = [...new Set([...retained, ...value].filter(Boolean))];
      continue;
    }
    const present = value !== null && value !== undefined && value !== '';
    if ((merged[key] === null || merged[key] === undefined || merged[key] === '') && present) merged[key] = value;
  }
  return merged;
}

export function scrubDouyinMediaUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    const allowed = [
      'douyin.com',
      'douyinpic.com',
      'byteimg.com',
      'ibytedtos.com',
      'bytedance.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (parsed.protocol !== 'https:' || !allowed) return '';
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function scrubDouyinPlaybackUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    const allowed = [
      'douyin.com',
      'douyinvod.com',
      'douyinpic.com',
      'bytecdn.cn',
      'byteimg.com',
      'ibytedtos.com',
      'bytedance.com',
      'volces.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (parsed.protocol !== 'https:' || !allowed) return '';
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
      const mediaPath = /(?:\.mp4|\.webm|\/aweme\/|\/video\/tos\/)/i.test(parsed.pathname);
      if (!mediaPath) return '';
    }
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function pageAccessState(pageUrl, visibleText, visiblePublicEvidence = 0) {
  const url = text(pageUrl).toLowerCase();
  const body = text(visibleText, 3_000).toLowerCase();
  if (isVerificationFrameUrl(url) || url.includes('/website-login/captcha')) {
    return 'verification_required';
  }
  if (VERIFICATION_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) return 'verification_required';
  if (LOGIN_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) {
    // Logged-out Douyin pages keep a navigation-level login action visible even
    // while the public profile, search cards, or work detail is fully readable.
    return Number(visiblePublicEvidence || 0) > 0 ? '' : 'login_required';
  }
  return '';
}

export function isVerificationFrameUrl(value) {
  const url = text(value).toLowerCase();
  return ['captcha', 'security/verify', 'rc-verifycenter'].some((marker) => url.includes(marker));
}

export function shouldBlockSearchAccess(accessState, visibleCardCount) {
  if (accessState === 'verification_required') return true;
  return accessState === 'login_required' && Number(visibleCardCount || 0) === 0;
}

export function profileMetricFromVisibleText(visibleText, labels = [], { accountId = '' } = {}) {
  const body = text(visibleText, 5_000);
  const metric = '([0-9]+(?:\\.[0-9]+)?(?:[wk\\u4e07\\u4ebf])?)';
  const normalizedAccountId = text(accountId, 80).replace(/[^a-z0-9._-]/gi, '').toLowerCase();
  const metricCandidate = (match, valueIndex) => {
    if (!match) return '';
    const value = match[valueIndex];
    const normalizedValue = text(value, 80).replace(/[^a-z0-9._-]/gi, '').toLowerCase();
    if (normalizedAccountId && normalizedValue === normalizedAccountId) return '';
    const prefix = body.slice(Math.max(0, (match.index || 0) - 24), match.index || 0);
    if (/(?:\u6296\u97f3\u53f7|dy\s*id|(?:^|\s)id)\s*[:\uff1a]?\s*$/i.test(prefix)) return '';
    return value;
  };
  for (const label of labels) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const labelFirst = body.match(new RegExp(`${escaped}\\s*${metric}`, 'i'));
    const labelFirstValue = metricCandidate(labelFirst, 1);
    if (labelFirstValue) return labelFirstValue;
    const valueFirst = body.match(new RegExp(`${metric}\\s*${escaped}`, 'i'));
    const valueFirstValue = metricCandidate(valueFirst, 1);
    if (valueFirstValue) return valueFirstValue;
  }
  return '';
}

export function visibleProfileSignalCount(profile) {
  const metricCount = Object.values(profile?.metrics || {}).filter((value) => text(value)).length;
  return metricCount
    + Number(Boolean(text(profile?.author)))
    + Number(Boolean(text(profile?.accountId)))
    + Number(Boolean(text(profile?.bio)))
    + Number(Boolean(text(profile?.avatar_url)));
}

export function hasVisibleProfileCore(profile) {
  return Boolean(
    text(profile?.metrics?.followers)
    || text(profile?.metrics?.following)
    || text(profile?.metrics?.likes)
    || text(profile?.bio)
    || text(profile?.avatar_url)
    || text(profile?.accountId)
    || text(profile?.handle)
    || text(profile?.location)
    || typeof profile?.verified === 'boolean'
  );
}

export function profilePhaseObservation(profile) {
  const observed = hasVisibleProfileCore(profile);
  return {
    observed,
    stopReason: observed ? 'profile_fields_observed' : 'profile_fields_unavailable_retryable',
    completion: observed ? 'profile_observed' : 'profile_not_observed',
    continuationRecommended: !observed,
  };
}

export function shouldRetrySearchPageLoad(collection) {
  return collection?.records?.length === 0
    && collection?.status?.stop_reason === 'public_results_unavailable_retryable';
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const valued = new Set([
    '--query', '--profile-url', '--post-url', '--expected-name', '--profile-sample-limit', '--detail-sample-limit',
    '--relay-port', '--limit', '--search-url-template', '--output-dir', '--checkpoint-file', '--playwright-module-path', '--collection-phase',
    '--catalog-input-file', '--min-interval-ms', '--max-interval-ms',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    if (!valued.has(item) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Invalid collector input.');
    }
    index += 1;
  }
  const query = text(optionValue(argv, '--query'), 300);
  const profileUrl = text(optionValue(argv, '--profile-url'));
  const postUrl = text(optionValue(argv, '--post-url'));
  const outputDir = text(optionValue(argv, '--output-dir'));
  const checkpointFile = text(optionValue(argv, '--checkpoint-file'));
  const requestedPort = optionValue(argv, '--relay-port');
  if (requestedPort && relayPort(requestedPort) !== DOUYIN_RELAY_PORT) {
    throw new Error('Douyin Relay port is fixed at 18801.');
  }
  const port = DOUYIN_RELAY_PORT;
  if ((!query && !profileUrl && !postUrl) || (profileUrl && postUrl) || !outputDir || !port) throw new Error('Invalid required collector input.');
  if (profileUrl && !isDouyinUrl(profileUrl)) throw new Error('Invalid profile URL.');
  if (postUrl && !canonicalDouyinContentUrl(postUrl)) throw new Error('Invalid post URL.');
  const collectionPhase = text(optionValue(argv, '--collection-phase'), 24) || 'detail';
  if (!['profile', 'catalog', 'detail'].includes(collectionPhase)) throw new Error('Invalid collection phase.');
  const limit = positiveInteger(optionValue(argv, '--limit'), MAX_DISCOVERY_RESULTS, MAX_DISCOVERY_RESULTS);
  const profileSampleLimit = positiveInteger(optionValue(argv, '--profile-sample-limit'), 10_000, MAX_PROFILE_SAMPLES);
  // Detail enrichment is scoped to this same visible-profile request unless a
  // caller explicitly asks for a smaller subset. It can never exceed the
  // collected profile sample set, so the Relay does not navigate beyond the
  // request's public-content boundary.
  const detailSampleLimit = positiveInteger(
    optionValue(argv, '--detail-sample-limit'),
    profileSampleLimit,
    profileSampleLimit,
  );
  const minIntervalMs = optionValue(argv, '--min-interval-ms');
  const maxIntervalMs = optionValue(argv, '--max-interval-ms') || minIntervalMs;
  const randomInterval = normalizeRandomInterval({ minMs: minIntervalMs, maxMs: maxIntervalMs });
  const searchUrlTemplate = text(optionValue(argv, '--search-url-template'), 2_000)
    || 'https://www.douyin.com/search/{query}?type=user';
  if (!searchUrlTemplate.includes('{query}') || !isDouyinUrl(searchUrlTemplate.replace('{query}', 'probe'))) {
    throw new Error('Invalid search URL template.');
  }
  return {
    help: false,
    query,
    profileUrl: canonicalDouyinUrl(profileUrl),
    postUrl: canonicalDouyinContentUrl(postUrl),
    expectedName: text(optionValue(argv, '--expected-name'), 160),
    collectionPhase,
    profileSampleLimit,
    detailSampleLimit,
    randomInterval,
    timing: createRandomIntervalController(randomInterval),
    relayPort: port,
    limit,
    searchUrlTemplate,
    outputDir: path.resolve(outputDir),
    checkpointFile: checkpointFile ? path.resolve(checkpointFile) : '',
    catalogInputFile: text(optionValue(argv, '--catalog-input-file'))
      ? path.resolve(text(optionValue(argv, '--catalog-input-file')))
      : '',
    playwrightModulePath: text(optionValue(argv, '--playwright-module-path'))
      || text(process.env.KOLFORGE_RELAY_PLAYWRIGHT_MODULE_PATH),
  };
}

export async function readSearchCheckpoint(checkpointFile) {
  if (!checkpointFile) return { loaded: false, skipPostUrls: [], previousCount: 0 };
  const payload = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
  const values = Array.isArray(payload)
    ? payload
    : [payload?.skipPostUrls, payload?.skip_post_urls, payload?.postUrls]
      .find((candidate) => Array.isArray(candidate)) || [];
  const skipPostUrls = [...new Set(values
    .map((value) => canonicalDouyinContentUrl(value))
    .filter(Boolean))];
  return {
    loaded: true,
    skipPostUrls,
    previousCount: Number(payload?.previousCount ?? payload?.previous_count) || skipPostUrls.length,
  };
}

function usage() {
  return [
    'Usage: node collect_douyin_relay.mjs --query QUERY --output-dir DIRECTORY',
    '       [--limit 3000] [--relay-port 18801] [--search-url-template URL] [--checkpoint-file FILE]',
    '       node collect_douyin_relay.mjs --profile-url URL --output-dir DIRECTORY',
    '       [--profile-sample-limit 10000] [--detail-sample-limit N] [--catalog-input-file FILE] [--expected-name NAME]',
    '       [--min-interval-ms 0] [--max-interval-ms 0]',
    '       node collect_douyin_relay.mjs --post-url URL --output-dir DIRECTORY [--limit 10]',
  ].join('\n');
}

async function getGatewayToken() {
  const environmentToken = text(process.env.OPENCLAW_GATEWAY_TOKEN);
  if (environmentToken) return environmentToken;
  const openclawDirectory = path.join(os.homedir(), '.openclaw');
  try {
    const payload = JSON.parse(await fs.readFile(path.join(openclawDirectory, 'openclaw.json'), 'utf8'));
    const token = text(payload?.gateway?.auth?.token);
    if (token) return token;
  } catch {
    // The browser-local secret is deliberately absent from diagnostics.
  }
  try {
    const command = await fs.readFile(path.join(openclawDirectory, 'gateway.cmd'), 'utf8');
    const token = text(command.match(/OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)/)?.[1]);
    if (token) return token;
  } catch {
    // The generated launcher is optional.
  }
  throw new Error('Gateway token unavailable.');
}

function relayHeaders(port, token) {
  return {
    'x-openclaw-relay-token': createHmac('sha256', token)
      .update(`openclaw-extension-relay-v1:${port}`)
      .digest('hex'),
  };
}

export function isRelayBlankPageTarget(target) {
  if (target?.type !== 'page' || typeof target?.url !== 'string') return false;
  return /^chrome:\/\/newtab\/?$/i.test(target.url.trim());
}

async function closeStaleRelayBlankPages(port, token) {
  try {
    const headers = relayHeaders(port, token);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      headers,
      signal: AbortSignal.timeout(RELAY_TARGET_CLEANUP_TIMEOUT_MS),
    });
    if (!response.ok) return 0;
    const targets = await response.json();
    if (!Array.isArray(targets)) return 0;
    // A blank tab is only disposable when the Relay already has the requested
    // public Douyin page. This keeps a user's initial blank browser session
    // intact while removing the extra target that stalls CDP attachment.
    const hasDouyinPage = targets.some((target) => target?.type === 'page' && isDouyinUrl(target.url));
    if (!hasDouyinPage) return 0;
    const blankPages = targets.filter(isRelayBlankPageTarget);
    let closed = 0;
    for (const target of blankPages) {
      if (!target.id) continue;
      const closeResponse = await fetch(
        `http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`,
        { headers, signal: AbortSignal.timeout(RELAY_TARGET_CLEANUP_TIMEOUT_MS) },
      );
      if (closeResponse.ok) closed += 1;
    }
    return closed;
  } catch {
    return 0;
  }
}

async function playwrightModulePaths(configuredPath) {
  const modulePaths = [];
  const addResolved = (base) => {
    if (!base) return;
    try {
      const resolver = createRequire(path.join(base, 'relay-loader.cjs'));
      modulePaths.push(resolver.resolve('playwright'));
    } catch {
      // Continue through supported local module locations.
    }
  };
  const addPnpmStore = async (base) => {
    if (!base) return;
    try {
      const entries = await fs.readdir(path.join(base, '.pnpm'), { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory() && /^playwright@/i.test(item.name)).slice(0, 4)) {
        addResolved(path.join(base, '.pnpm', entry.name, 'node_modules'));
      }
    } catch {
      // A non-pnpm module root needs no additional lookup.
    }
  };
  try {
    modulePaths.push(REQUIRE.resolve('playwright'));
  } catch {
    // Playwright is intentionally supplied by the local adapter when available.
  }
  const supplied = text(configuredPath);
  if (supplied) {
    const target = path.resolve(supplied);
    addResolved(target);
    addResolved(path.dirname(target));
    await addPnpmStore(target);
    await addPnpmStore(path.dirname(target));
    if (/\.(?:cjs|mjs|js)$/i.test(target)) modulePaths.push(target);
  }
  return [...new Set(modulePaths)];
}

async function loadPlaywright(configuredPath) {
  for (const modulePath of await playwrightModulePaths(configuredPath)) {
    try {
      const imported = await import(pathToFileURL(modulePath).href);
      const playwright = imported?.chromium ? imported : imported?.default;
      if (playwright?.chromium?.connectOverCDP) return playwright;
    } catch {
      // Try the next allowed local module path.
    }
  }
  throw new Error('Playwright unavailable.');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function attachRelay(playwright, port, token) {
  let lastError = null;
  await closeStaleRelayBlankPages(port, token);
  for (let attempt = 0; attempt < RELAY_ATTACH_ATTEMPTS; attempt += 1) {
    try {
      return await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        headers: relayHeaders(port, token),
        timeout: RELAY_ATTACH_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      await closeStaleRelayBlankPages(port, token);
      if (attempt < RELAY_ATTACH_ATTEMPTS - 1) await delay(500 * (attempt + 1));
    }
  }
  throw lastError || new Error('Relay attachment unavailable.');
}

async function openVisiblePage(page, targetUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < PAGE_OPEN_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PAGE_OPEN_ATTEMPTS - 1) await delay(700 * (attempt + 1));
    }
  }
  throw lastError || new Error('Public platform page unavailable.');
}

async function renderedAccessState(page) {
  let visibleText = '';
  let visiblePublicEvidence = 0;
  let frameUrls = [];
  try {
    visibleText = await page.locator('body').innerText({ timeout: 2_500 });
    frameUrls = page.frames().map((frame) => frame.url());
    visiblePublicEvidence = await page.evaluate(() => {
      const pathname = location.pathname || '';
      const canonicalLinks = Array.from(document.querySelectorAll('a[href]')).filter((node) => {
        try {
          const parsed = new URL(node.href || '', location.href);
          return /\/(?:user|video|note)\/[^/?#]+/.test(parsed.pathname);
        } catch {
          return false;
        }
      }).length;
      const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ');
      const visibleProfileMetrics = pathname.startsWith('/user/')
        && /[0-9]+(?:\.[0-9]+)?(?:[wk\u4e07\u4ebf])?\s*(?:\u7c89\u4e1d|\u83b7\u8d5e|\u5173\u6ce8)/i.test(bodyText);
      const visibleDetail = /^\/(?:video|note)\/[^/?#]+/.test(pathname)
        && Boolean(document.querySelector('video, [data-e2e*=video], [data-e2e*=detail]'));
      const visibleSearchCards = Array.from(document.querySelectorAll(
        '#search-result-container .search-result-card, [id^="waterfall_item_"] .search-result-card',
      )).filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }).length;
      return canonicalLinks + Number(visibleProfileMetrics) + Number(visibleDetail) + visibleSearchCards;
    });
  } catch {
    return 'unknown';
  }
  // Douyin may mount an invisible verification iframe alongside an otherwise
  // readable public search surface. Treat an iframe as blocking only when no
  // public evidence is visible; a visible challenge page still blocks below.
  if (frameUrls.some((frameUrl) => isVerificationFrameUrl(frameUrl)) && visiblePublicEvidence === 0) {
    return 'verification_required';
  }
  return pageAccessState(page.url(), visibleText, visiblePublicEvidence);
}

function searchUrl(args) {
  return args.searchUrlTemplate.replace('{query}', encodeURIComponent(args.query));
}

async function waitForVisibleSearchResults(page) {
  let last = { profileCards: 0, attempts: 0 };
  for (let attempt = 0; attempt < SEARCH_HYDRATION_ATTEMPTS; attempt += 1) {
    const access = await renderedAccessState(page);
    if (access === 'verification_required') return { access, ...last };
    let cards = [];
    try {
      // Readiness must use the same public-card qualification as collection so
      // navigation links never count as a hydrated search result.
      cards = await readVisibleSearchCards(page, 1);
    } catch {
      cards = [];
    }
    last = { profileCards: cards.length, attempts: attempt + 1 };
    if (last.profileCards > 0) return { access: '', ...last };
    if (shouldBlockSearchAccess(access, last.profileCards)) return { access, ...last };
    if (attempt < SEARCH_HYDRATION_ATTEMPTS - 1) await page.waitForTimeout(SEARCH_HYDRATION_DELAY_MS);
  }
  return { access: '', ...last };
}

async function waitForVisibleProfileSamples(page, attemptLimit = PROFILE_HYDRATION_ATTEMPTS) {
  const attempts = Number.isFinite(Number(attemptLimit))
    ? Math.max(1, Math.min(PROFILE_HYDRATION_ATTEMPTS, Math.floor(Number(attemptLimit))))
    : PROFILE_HYDRATION_ATTEMPTS;
  let last = { contentCards: 0, profileSignals: 0, attempts: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const access = await renderedAccessState(page);
    if (access === 'verification_required') return { access, ...last };
    let cards = [];
    let profile = null;
    try {
      // Profile grids hydrate after the header. Do not scroll an empty surface
      // before the visible work links have had a chance to render.
      [cards, profile] = await Promise.all([
        readVisibleProfileSamples(page, 1),
        readVisibleProfile(page, ''),
      ]);
    } catch {
      cards = [];
      profile = null;
    }
    last = {
      contentCards: cards.length,
      profileSignals: visibleProfileSignalCount(profile),
      attempts: attempt + 1,
    };
    if (hasVisibleProfileCore(profile)) return { access: '', ...last };
    if (access === 'login_required') return { access, ...last };
    if (attempt < attempts - 1) await page.waitForTimeout(PROFILE_HYDRATION_DELAY_MS);
  }
  return { access: '', ...last };
}

async function scrollVisibleSurface(page) {
  try {
    const action = await page.evaluate(() => {
      const candidates = [
        document.scrollingElement,
        ...document.querySelectorAll('[class*=scroll], [class*=Scroll], [data-e2e*=scroll]'),
      ]
        .filter((node) => node && node.scrollHeight > node.clientHeight + 20)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
      const target = candidates[0] || document.scrollingElement;
      if (!target || typeof target.scrollBy !== 'function') return { available: false, moved: false, x: 0, y: 0 };
      const before = target.scrollTop;
      target.scrollBy({ top: Math.max(720, Math.floor(window.innerHeight * 0.82)), left: 0, behavior: 'instant' });
      const rect = target.getBoundingClientRect();
      return {
        available: true,
        moved: target.scrollTop > before + 2,
        x: Math.max(1, Math.min(window.innerWidth - 1, Math.floor(rect.left + (rect.width / 2)))),
        y: Math.max(1, Math.min(window.innerHeight - 1, Math.floor(rect.top + Math.min(rect.height / 2, 180)))),
      };
    });
    if (action.moved) return true;
    // Some search surfaces use a nested virtual scroller that responds to a
    // user-visible wheel event rather than Element#scrollBy.
    if (action.x && action.y) await page.mouse.move(action.x, action.y);
    const viewport = page.viewportSize();
    await page.mouse.wheel(0, Math.max(720, Math.floor((viewport?.height || 900) * 0.82)));
    return true;
  } catch {
    return false;
  }
}

async function visibleSurfaceFingerprint(page) {
  try {
    return await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="/user/"], a[href*="/video/"], a[href*="/note/"]'))
        .map((node) => node.href || '')
        .filter(Boolean)
        .slice(0, 160);
      const fingerprint = hrefs.reduce((hash, value) => {
        for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
        return hash;
      }, 0);
      const scrollTargets = [
        document.scrollingElement,
        ...document.querySelectorAll('[class*=scroll], [class*=Scroll], [data-e2e*=scroll]'),
      ]
        .filter((node) => node && node.scrollHeight > node.clientHeight + 20)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
      const root = scrollTargets[0] || document.scrollingElement;
      return {
        fingerprint: String(fingerprint),
        top: root?.scrollTop || window.scrollY || 0,
        height: root?.scrollHeight || document.body?.scrollHeight || 0,
      };
    });
  } catch {
    return { fingerprint: '', top: 0, height: 0 };
  }
}

function surfaceProgressed(before, after) {
  return before.fingerprint !== after.fingerprint || after.top > before.top + 8 || after.height > before.height + 20;
}

// Profile grids can remain at a new scroll position while rendering the same
// virtualized cards. A moved scrollTop is useful for discovery search, but it
// must not keep a profile collection alive indefinitely. Profile progress is
// therefore evidence of a new visible card identity or a material grid growth.
export function profileSurfaceProgressed(before, after) {
  return before.fingerprint !== after.fingerprint || after.height > before.height + 20;
}

async function waitForVisibleContentMutation(page, beforeSurface, timeout) {
  const baseline = {
    fingerprint: String(beforeSurface?.fingerprint || ''),
  };
  try {
    await page.waitForFunction(({ fingerprint }) => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="/user/"], a[href*="/video/"], a[href*="/note/"]'))
        .map((node) => node.href || '')
        .filter(Boolean)
        .slice(0, 160);
      const current = hrefs.reduce((hash, value) => {
        for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
        return hash;
      }, 0);
      // A height-only change can be a loading skeleton. Advance early only
      // when the actual public card links change; otherwise retain the full
      // bounded settle window and avoid skipping a virtualized card batch.
      return String(current) !== fingerprint;
    }, baseline, { timeout: Math.max(1, Number(timeout) || 0) });
  } catch {
    // The existing bounded settle window is intentionally retained on a slow
    // or unchanged public surface.
  }
  return visibleSurfaceFingerprint(page);
}

async function readVisibleSearchCards(page, maximum) {
  return page.evaluate((limit) => {
    const clean = (value, max = 0) => {
      const result = String(value || '').replace(/\s+/g, ' ').trim();
      return max ? result.slice(0, max) : result;
    };
    const looksLikeImageNote = (value) => /^\s*(?:\u56fe\u6587|\u56fe\u96c6|\u56fe\u7247)(?:\s|$)/.test(String(value || ''));
    const absolute = (value) => {
      try { return new URL(value || '', location.href).href; } catch { return ''; }
    };
    const canonicalContentUrl = (value) => {
      try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const match = parsed.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
        if (parsed.protocol !== 'https:' || !(host === 'douyin.com' || host.endsWith('.douyin.com')) || !match) return '';
        return `https://www.douyin.com/${match[1].toLowerCase()}/${match[2]}`;
      } catch { return ''; }
    };
    const mediaUrl = (value, preserveQuery = true) => {
      try {
        const parsed = new URL(value || '', location.href);
        const host = parsed.hostname.toLowerCase();
        const domains = [
          'douyin.com',
          'douyinvod.com',
          'douyinpic.com',
          'bytecdn.cn',
          'byteimg.com',
          'ibytedtos.com',
          'bytedance.com',
          'volces.com',
        ];
        if (parsed.protocol !== 'https:' || !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
        parsed.username = '';
        parsed.password = '';
        if (!preserveQuery) parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch { return ''; }
    };
    const playbackMediaUrl = (value) => {
      const normalized = mediaUrl(value, true);
      if (!normalized) return '';
      try {
        const parsed = new URL(normalized);
        if ((parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com'))
          && !/(?:\.mp4|\.webm|\/aweme\/|\/video\/tos\/)/i.test(parsed.pathname)) return '';
        return parsed.toString();
      } catch { return ''; }
    };
    const playbackUrlFromRoot = (root) => {
      const candidates = Array.from(root?.querySelectorAll('video, video source') || [])
        .flatMap((video) => [video.currentSrc, video.src, video.getAttribute('src')]);
      return candidates.map(playbackMediaUrl).find(Boolean) || '';
    };
    const contentImageUrls = (root) => [...new Set(Array.from(root?.querySelectorAll('img') || [])
      .filter((image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`))
      .map((image) => mediaUrl(image.currentSrc || image.getAttribute('src')))
      .filter(Boolean))].slice(0, 8);
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const profileId = (url) => {
      try {
        const match = new URL(url).pathname.replace(/\/+$/, '').match(/^\/(?:user|share\/user)\/([^/]+)$/i);
        return match ? decodeURIComponent(match[1]).toLowerCase() : '';
      } catch { return ''; }
    };
    const allowed = (value) => {
      try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && (host === 'douyin.com' || host.endsWith('.douyin.com'));
      } catch { return false; }
    };
    const rootFor = (node) => node.closest([
      'article', 'li', '[data-e2e*=search-card]', '[data-e2e*=search-result]',
      '[class*=search-card]', '[class*=SearchCard]', '[class*=feed-card]', '[class*=FeedCard]', '[class*=card]', '[class*=Card]',
    ].join(','));
    const isNavigation = (node) => Boolean(node.closest('nav, header, [role=navigation], [data-e2e*=nav], [class*=nav], [class*=Nav]'));
    const reserved = new Set(['self', 'login', 'search', 'discover', 'following', 'follower']);
    const output = [];
    const seen = new Set();
    for (const anchor of Array.from(document.querySelectorAll('a[href*="/user/"], a[href*="share/user/"]'))) {
      const authorProfile = absolute(anchor.getAttribute('href'));
      const id = profileId(authorProfile);
      const root = rootFor(anchor);
      if (!id || reserved.has(id) || !root || !visible(root) || isNavigation(anchor) || !allowed(authorProfile)) continue;
      const contentLink = root.querySelector('a[href*="/video/"], a[href*="/note/"]');
      const contentCandidate = absolute(contentLink?.getAttribute('href'));
      // User-search cards expose a public profile but deliberately do not
      // contain a video link. Keep them as candidates; profile collection
      // supplies their visible content samples in the next stage.
      const noteUrl = allowed(contentCandidate) ? contentCandidate : '';
      const rootText = clean(root.innerText, 900);
      const author = clean(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title'), 120)
        || clean(root.querySelector('[class*=author], [class*=name], [class*=Name], [data-e2e*=author]')?.textContent, 120);
      if (!author || author.length > 120) continue;
      const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent, 300);
      const cover = Array.from(root.querySelectorAll('img'))
        .find((image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`));
      const imageUrls = contentImageUrls(root);
      const hashtags = [...new Set((rootText.match(/#[^\s#]{1,80}/g) || []).slice(0, 12))];
      const visibleMetrics = [...new Set((rootText.match(/\d+(?:\.\d+)?(?:[wWkK\u4e07\u4ebf])?\s*(?:\u70b9\u8d5e|\u8d5e|\u8bc4\u8bba|\u6536\u85cf|\u8f6c\u53d1|\u5206\u4eab|\u64ad\u653e|\u89c2\u770b|\u559c\u6b22)/g) || []).map((value) => clean(value, 40)))].slice(0, 16);
      const publishedAt = clean((rootText.match(/(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}|\d+(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d|\u6628\u5929|\u524d\u5929)/) || [])[0], 32);
      const duration = clean((rootText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0], 32);
      const videoUrl = playbackUrlFromRoot(root);
      const hasVideo = !looksLikeImageNote(rootText) && Boolean(videoUrl || duration || root.querySelector('video'));
      const key = `${authorProfile}|${noteUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        author,
        author_profile: authorProfile,
        note_url: noteUrl,
        title,
        body: rootText,
        cover_url: mediaUrl(cover?.currentSrc || cover?.getAttribute('src')),
        video_url: videoUrl,
        image_urls: imageUrls,
        content_image_count: imageUrls.length,
        hashtags,
        visible_metrics: visibleMetrics,
        published_at_text: publishedAt,
        duration_text: duration,
        content_type: noteUrl ? (hasVideo ? 'video' : 'image_or_note') : 'profile',
        content_format: noteUrl ? (hasVideo ? 'video' : 'image') : 'profile_card',
        has_video: hasVideo,
      });
      if (output.length >= limit) break;
    }
    // General search pages expose content links before profile links. Keep a
    // second pass so a post-search request can return the visible content
    // card itself while preserving the existing profile-search pass above.
    for (const contentAnchor of Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))) {
      if (output.length >= limit) break;
      const root = rootFor(contentAnchor);
      if (!root || !visible(root) || isNavigation(contentAnchor)) continue;
      const authorAnchor = root.querySelector('a[href*="/user/"], a[href*="share/user/"]');
      const authorProfile = absolute(authorAnchor?.getAttribute('href'));
      const id = profileId(authorProfile);
      if (!id || reserved.has(id) || !allowed(authorProfile)) continue;
      const contentCandidate = absolute(contentAnchor.getAttribute('href'));
      const noteUrl = allowed(contentCandidate) ? contentCandidate : '';
      if (!noteUrl) continue;
      const rootText = clean(root.innerText, 900);
      const author = clean(authorAnchor?.textContent || authorAnchor?.getAttribute('aria-label') || authorAnchor?.getAttribute('title'), 120)
        || clean(root.querySelector('[class*=author], [class*=name], [class*=Name], [data-e2e*=author]')?.textContent, 120);
      if (!author || author.length > 120) continue;
      const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent, 300);
      const cover = Array.from(root.querySelectorAll('img'))
        .find((image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`));
      const imageUrls = contentImageUrls(root);
      const hashtags = [...new Set((rootText.match(/#[^\s#]{1,80}/g) || []).slice(0, 12))];
      const visibleMetrics = [...new Set((rootText.match(/\d+(?:\.\d+)?(?:[wWkK\u4e07\u4ebf])?\s*(?:\u70b9\u8d5e|\u8d5e|\u8bc4\u8bba|\u6536\u85cf|\u8f6c\u53d1|\u5206\u4eab|\u64ad\u653e|\u89c2\u770b|\u559c\u6b22)/g) || []).map((value) => clean(value, 40)))].slice(0, 16);
      const publishedAt = clean((rootText.match(/(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}|\d+(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d|\u6628\u5929|\u524d\u5929)/) || [])[0], 32);
      const duration = clean((rootText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0], 32);
      const videoUrl = playbackUrlFromRoot(root);
      const hasVideo = !looksLikeImageNote(rootText) && Boolean(videoUrl || duration || root.querySelector('video'));
      const key = `${authorProfile}|${noteUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        author,
        author_profile: authorProfile,
        note_url: noteUrl,
        title,
        body: rootText,
        cover_url: mediaUrl(cover?.currentSrc || cover?.getAttribute('src')),
        video_url: videoUrl,
        image_urls: imageUrls,
        content_image_count: imageUrls.length,
        hashtags,
        visible_metrics: visibleMetrics,
        published_at_text: publishedAt,
        duration_text: duration,
        content_type: hasVideo ? 'video' : 'image_or_note',
        content_format: hasVideo ? 'video' : 'image',
        has_video: hasVideo,
      });
    }

    // Current general-search cards navigate on click and expose their public
    // Aweme data through React props instead of content/profile anchors.
    const fiberFor = (node) => {
      let current = node;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const key = Object.keys(current).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
        if (key) return current[key];
      }
      return null;
    };
    const awemeFor = (waterfall) => {
      const waterfallId = String(waterfall?.id || '').replace(/^waterfall_item_/, '');
      let fiber = fiberFor(waterfall);
      const visited = new Set();
      for (let depth = 0; fiber && depth < 16 && !visited.has(fiber); depth += 1, fiber = fiber.return) {
        visited.add(fiber);
        if (!Array.isArray(fiber.memoizedProps)) continue;
        const element = fiber.memoizedProps.find((entry) => {
          const item = entry?.props?.item;
          const info = item?.awemeInfo;
          if (!info) return false;
          return [info.awemeId, info.groupId, item.docId, item.key]
            .some((value) => String(value || '').includes(waterfallId));
        });
        if (element?.props?.item?.awemeInfo) return element.props.item.awemeInfo;
      }
      return null;
    };
    const imageUrlsFromAweme = (aweme) => {
      const images = Array.isArray(aweme?.images) ? aweme.images : [];
      return [...new Set(images.flatMap((image) => {
        const candidates = image?.url_list || image?.urlList || image?.urls || [];
        return (Array.isArray(candidates) ? candidates : [candidates]).map(mediaUrl).filter(Boolean);
      }))].slice(0, 8);
    };
    const playbackUrlFromAweme = (aweme) => {
      const flatten = (value) => {
        if (Array.isArray(value)) return value.flatMap(flatten);
        if (value && typeof value === 'object') return [value.url, value.src, value.uri, value.playAddr, value.play_addr].flatMap(flatten);
        return [value];
      };
      const candidates = [
        aweme?.video?.playAddr, aweme?.video?.play_addr,
        aweme?.video?.downloadAddr, aweme?.video?.download_addr,
        aweme?.video?.url, aweme?.video?.url_list, aweme?.video?.urlList,
      ].flatMap(flatten);
      return candidates.map(playbackMediaUrl).find(Boolean) || '';
    };
    const playbackUrlFromCard = (card) => {
      return playbackUrlFromRoot(card);
    };
    const statisticsFromCard = (card) => {
      const selectors = {
        digg_count: '[data-e2e="video-player-digg"]',
        comment_count: '[data-e2e="feed-comment-icon"]',
        collect_count: '[data-e2e="video-player-collect"]',
        share_count: '[data-e2e="video-player-share"]',
      };
      return Object.fromEntries(Object.entries(selectors)
        .map(([field, selector]) => [field, clean(card.querySelector(selector)?.textContent, 40)])
        .filter(([, value]) => Boolean(value)));
    };
    for (const card of Array.from(document.querySelectorAll(
      '#search-result-container .search-result-card, [id^="waterfall_item_"] .search-result-card, .search-result-card',
    ))) {
      if (output.length >= limit || !visible(card)) continue;
      const waterfall = card.closest('[id^="waterfall_item_"]') || card;
      const aweme = awemeFor(waterfall);
      const authorInfo = aweme?.authorInfo || aweme?.author || {};
      const authorAnchors = Array.from(card.querySelectorAll('a[href*="/user/"], a[href*="share/user/"]'));
      const authorAnchor = authorAnchors.find((anchor) => profileId(absolute(anchor.getAttribute('href') || ''))
        && clean(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title'), 120))
        || authorAnchors.find((anchor) => profileId(absolute(anchor.getAttribute('href') || '')))
        || authorAnchors[0];
      const domAuthor = clean(authorAnchor?.textContent || authorAnchor?.getAttribute('aria-label') || authorAnchor?.getAttribute('title'), 120);
      const domAuthorProfile = absolute(authorAnchor?.getAttribute('href') || '');
      const contentNode = card.querySelector('[data-e2e-vid], [id^="sliderVideo"]');
      const domContentId = String(contentNode?.getAttribute('data-e2e-vid') || contentNode?.id || '')
        .replace(/^sliderVideo|^video_|^waterfall_item_/, '');
      const author = clean(authorInfo.nickname || authorInfo.name, 120) || domAuthor;
      const authorProfile = [
        authorInfo.url,
        authorInfo.homepageUrl,
        ...authorAnchors.map((anchor) => anchor.getAttribute('href') || ''),
      ].map(absolute).find((candidate) => profileId(candidate)) || '';
      const contentId = String(aweme?.awemeId || aweme?.groupId || domContentId || waterfall.id || '')
        .replace(/^waterfall_item_/, '');
      const rawContentUrl = absolute(aweme?.video?.url || aweme?.note?.url || '');
      const noteUrl = canonicalContentUrl(rawContentUrl)
        || (contentId ? `https://www.douyin.com/video/${encodeURIComponent(contentId)}` : '');
      if (!author || !allowed(authorProfile) || !noteUrl || seen.has(`${authorProfile}|${noteUrl}`)) continue;
      const rootText = clean(card.innerText, 900);
      const lines = rootText.split(/\r?\n/).map((line) => clean(line, 300)).filter(Boolean);
      const description = clean(aweme?.desc || aweme?.description, 300)
        || lines.find((line) => line !== author
          && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)
          && !/^\d+(?:\.\d+)?(?:[wWkK\u4e07\u4ebf])?$/.test(line)
          && !/^·?\d+(?:分钟|小时|天|周|月|年)前$/.test(line)
          && !/^\d{1,2}月\d{1,2}日$/.test(line))
        || '';
      const imageUrls = [...new Set([...contentImageUrls(card), ...imageUrlsFromAweme(aweme)])].slice(0, 8);
      const coverUrl = mediaUrl(
        aweme?.video?.cover || aweme?.video?.originCover || aweme?.cover?.url_list?.[0] || imageUrls[0],
      );
      const visibleMetrics = [...new Set((rootText.match(/\d+(?:\.\d+)?(?:[wWkK\u4e07\u4ebf])?\s*(?:\u70b9\u8d5e|\u8d5e|\u8bc4\u8bba|\u6536\u85cf|\u8f6c\u53d1|\u5206\u4eab|\u64ad\u653e|\u89c2\u770b|\u559c\u6b22)/g) || []).map((value) => clean(value, 40)))].slice(0, 16);
      const hashtags = [...new Set(((description || rootText).match(/#[^\s#]{1,80}/g) || []).slice(0, 12))];
      const videoUrl = playbackUrlFromAweme(aweme) || playbackUrlFromCard(card);
      const duration = clean((rootText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0], 32);
      const hasVideo = !looksLikeImageNote(rootText)
        && Boolean(duration || aweme?.video?.playAddr || aweme?.video?.url || videoUrl || card.querySelector('video') || contentNode?.getAttribute('data-e2e') === 'feed-active-video');
      seen.add(`${authorProfile}|${noteUrl}`);
      output.push({
        author,
        author_profile: authorProfile,
        note_url: noteUrl,
        title: description || clean(rootText.split(/\r?\n/)[0], 300),
        body: rootText || description,
        cover_url: coverUrl,
        video_url: videoUrl,
        image_urls: imageUrls,
        content_image_count: imageUrls.length,
        hashtags,
        statistics: statisticsFromCard(card),
        visible_metrics: visibleMetrics,
        published_at_text: '',
        duration_text: duration,
        content_type: hasVideo ? 'video' : (imageUrls.length ? 'image_or_note' : 'unknown'),
        content_format: hasVideo ? 'video' : (imageUrls.length ? 'image' : 'unknown'),
        has_video: hasVideo,
      });
    }
    return output;
  }, maximum);
}

async function readVisibleProfile(page, expectedName) {
  const observed = await page.evaluate((expected) => {
    const clean = (value, max = 0) => {
      const result = String(value || '').replace(/\s+/g, ' ').trim();
      return max ? result.slice(0, max) : result;
    };
    const absolute = (value) => {
      try { return new URL(value || '', location.href).href; } catch { return ''; }
    };
    const mediaUrl = (value, preserveQuery = true) => {
      try {
        const parsed = new URL(value || '', location.href);
        const host = parsed.hostname.toLowerCase();
        const domains = ['douyin.com', 'douyinpic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com'];
        if (parsed.protocol !== 'https:' || !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
        parsed.username = '';
        parsed.password = '';
        if (preserveQuery === false) parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch { return ''; }
    };
    const root = document.querySelector('[data-e2e*=user-detail], [data-e2e*=user-info], [data-e2e*=user-page], [class*=profile-header], [class*=ProfileHeader], [class*=user-info]')
      || document.querySelector('main') || document.body;
    const rootText = clean(root?.innerText, 5_000);
    const userInfo = root?.querySelector('[data-e2e="user-info"]') || root;
    const userInfoLines = String(userInfo?.innerText || '').split(/\r?\n/).map((line) => clean(line)).filter(Boolean);
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nodeMeta = (node) => [
      typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
      node?.getAttribute?.('data-e2e') || '',
      node?.getAttribute?.('aria-label') || '',
      node?.getAttribute?.('title') || '',
    ].join(' ').toLowerCase();
    const firstFieldText = (selectors) => clean(
      Array.from(userInfo?.querySelectorAll(selectors) || []).find(visible)?.textContent,
      240,
    );
    const fieldAfterLabel = (patterns, maximum = 180) => {
      for (let index = 0; index < userInfoLines.length; index += 1) {
        const line = userInfoLines[index];
        const pattern = patterns.find((candidate) => candidate.test(line));
        if (!pattern) continue;
        const inline = line.match(pattern);
        const value = clean(inline?.[1] || userInfoLines[index + 1], maximum);
        if (value) return value;
      }
      return '';
    };
    const title = clean(document.querySelector('meta[property="og:title"]')?.getAttribute('content'), 180);
    const name = clean(userInfo?.querySelector('h1, h2, [class*=nickname], [class*=name], [class*=Name]')?.textContent, 120)
      || clean(title.replace(/\s*[-_|].*$/, ''), 120)
      || clean(expected, 120);
    const explicitBio = clean(userInfo?.querySelector('[data-e2e*=user-bio], [class*=signature], [class*=Signature], [class*=bio], [class*=Bio]')?.textContent, 500);
    const regionIndex = userInfoLines.findIndex((line) => /^IP\u5c5e\u5730[\uff1a:]/.test(line));
    const inferredBio = regionIndex >= 0
      ? userInfoLines.slice(regionIndex + 1).find((line) => line !== '\u66f4\u591a' && line.length >= 4) || ''
      : '';
    const bio = explicitBio || clean(inferredBio, 500);
    const avatar = Array.from(root?.querySelectorAll('img') || [])
      .find((image) => /(?:\u5934\u50cf|avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`));
    const avatarSource = avatar?.currentSrc || avatar?.getAttribute('src') || '';
    const attributeText = [
      ...userInfoLines,
      ...Array.from(userInfo?.querySelectorAll('[aria-label], [title]') || [])
        .filter(visible)
        .flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('title')].map((value) => clean(value, 160))),
    ].filter(Boolean);
    const handle = firstFieldText('[data-e2e*=user-id], [data-e2e*=douyin-id], [class*=user-id], [class*=userId], [class*=douyin-id], [class*=douyinId], [class*=account-id]')
      || fieldAfterLabel([/\u6296\u97f3\u53f7\s*[\uff1a:]?\s*(\S+)/i, /(?:DY\s*ID|ID)\s*[\uff1a:]\s*(\S+)/i], 140);
    const profileLocation = fieldAfterLabel([/(?:IP\s*\u5c5e\u5730|\u5730\u533a|\u5730\u57df|location)\s*[\uff1a:]?\s*(.*)$/i], 120);
    const verifiedLabel = attributeText.find((line) => /(?:\u5df2\u8ba4\u8bc1|\u8ba4\u8bc1|verified|official)/i.test(line)) || '';
    const verified = verifiedLabel
      ? !/(?:\u672a\u8ba4\u8bc1|\u672a\u9a8c\u8bc1|unverified)/i.test(verifiedLabel)
      : null;
    const accountType = attributeText.find((line) => /(?:\u4f01\u4e1a\u8ba4\u8bc1|\u4e2a\u4eba\u8ba4\u8bc1|\u673a\u6784|\u521b\u4f5c\u8005|\u8fbe\u4eba|creator|business)/i.test(line)
      && line.length <= 100) || '';
    const metricPattern = /[0-9]+(?:\.[0-9]+)?(?:[wk\u4e07\u4ebf])?\s*(?:\u7c89\u4e1d|\u5173\u6ce8|\u83b7\u8d5e|\u4f5c\u54c1|followers|following|likes|works)/i;
    const visibleMetrics = [...new Set(attributeText.filter((line) => metricPattern.test(line)))].slice(0, 16);
    const profileContentAncestorSelector = [
      '[data-e2e*=aweme]', '[data-e2e*=video-card]', '[data-e2e*=note-card]',
      '[class*=video-card]', '[class*=VideoCard]', '[class*=feed-card]', '[class*=FeedCard]',
      'a[href*="/video/"]', 'a[href*="/note/"]',
    ].join(',');
    const profileTagNoisePattern = /^(?:\d+(?:\.\d+)?|\d{1,2}:\d{2}|\u5468[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]|\u7f6e\u9876|\u76f4\u64ad|\u56fe\u6587|\u89c6\u9891|\u5c55\u5f00|\u6536\u8d77)$/i;
    const profileTags = [...new Set(Array.from(root?.querySelectorAll(
      '[data-e2e*=tag], [data-e2e*=badge], [class*=tag], [class*=Tag], [class*=badge], [class*=Badge], a[href*=challenge], a[href*=topic]',
    ) || []).filter(visible).map((node) => {
      if (node.closest(profileContentAncestorSelector)) return '';
      const value = clean(node.textContent, 48);
      if (!value || value === name || value === handle || profileTagNoisePattern.test(value) || metricPattern.test(value)) return '';
      return value;
    }).filter(Boolean))].slice(0, 16);
    const audiencePattern = /(?:\u7c89\u4e1d(?:\u7fa4|\u56e2|\u724c)|\u94c1\u7c89|\u7c89\u4e1d\u6807\u7b7e|fans?\s*(?:group|club))/i;
    const audienceShellPattern = /(?:\u767b\u5f55|\u6ce8\u518c|\u8d26\u53f7|\u8d26\u6237|\u4e2a\u4eba\u4e2d\u5fc3|\u9000\u51fa|\u5ba2\u6237\u7aef|\u8ba2\u5355|\u89c2\u770b\u5386\u53f2|\u7a0d\u540e\u518d\u770b|\u5145\u94bb\u77f3|\u94b1\u5305|\u901a\u77e5|\u6d88\u606f|\u6295\u7a3f)/i;
    const audienceCtaPattern = /(?:\u79c1\u4fe1|\u8fdb\u7fa4|\u8054\u7cfb|\u54a8\u8be2|\u6dfb\u52a0|\u5fae\u4fe1|\bvx\b)/i;
    const audienceFreeTextPattern = /[,.\uff0c\u3002!\uff01?\uff1f;\uff1b:\uff1a]/;
    const publicAudienceSignals = [...new Set(userInfoLines.map((line) => {
      const normalized = clean(line, 48)
        .replace(/(?:\s*(?:\.\.\.|\u2026))?\s*(?:\u66f4\u591a|\u5c55\u5f00|\u6536\u8d77)?\s*$/i, '')
        .replace(/(?:\.\.\.|\u2026)\s*$/, '');
      if (!normalized || !audiencePattern.test(normalized) || audienceShellPattern.test(normalized)
        || audienceCtaPattern.test(normalized) || audienceFreeTextPattern.test(normalized)) return '';
      if (/^(?:\u7c89\u4e1d\u7fa4|\u7c89\u4e1d\u56e2|\u7c89\u4e1d\u724c|\u94c1\u7c89|\u7c89\u4e1d\u6807\u7b7e|fans?\s*(?:group|club))$/i.test(normalized)) return '';
      return normalized;
    }).filter(Boolean))].slice(0, 8);
    return {
      author: name,
      bio,
      avatar_url: avatarSource ? mediaUrl(avatarSource) : '',
      handle,
      location: profileLocation,
      verified,
      verified_label: clean(verifiedLabel, 120),
      account_type: clean(accountType, 100),
      profile_tags: profileTags,
      public_audience_signals: publicAudienceSignals,
      visible_metrics: visibleMetrics,
      profile_text: rootText,
      profile_title: title,
      homepage_url: absolute(window.location.href),
      rootText,
    };
  }, expectedName);
  const accountId = observed.rootText.match(/\u6296\u97f3\u53f7[\uff1a:]\s*([^\s]+)/i)?.[1] || text(observed.handle, 120);
  const metrics = {
    followers: profileMetricFromVisibleText(observed.rootText, ['\u7c89\u4e1d', 'fans'], { accountId }),
    following: profileMetricFromVisibleText(observed.rootText, ['\u5173\u6ce8', 'following'], { accountId }),
    likes: profileMetricFromVisibleText(observed.rootText, ['\u83b7\u8d5e', 'likes'], { accountId }),
    works: profileMetricFromVisibleText(observed.rootText, ['\u4f5c\u54c1', 'works'], { accountId }),
  };
  const metricLabels = { followers: '\u7c89\u4e1d', following: '\u5173\u6ce8', likes: '\u83b7\u8d5e', works: '\u4f5c\u54c1' };
  const visibleMetrics = [...new Set([
    ...(Array.isArray(observed.visible_metrics) ? observed.visible_metrics : []),
    ...Object.entries(metrics).filter(([, value]) => text(value)).map(([key, value]) => `${metricLabels[key]} ${value}`),
  ])].slice(0, 16);
  return {
    author: observed.author,
    accountId,
    bio: observed.bio,
    avatar_url: observed.avatar_url,
    handle: text(observed.handle, 140) || accountId,
    location: text(observed.location, 120),
    verified: typeof observed.verified === 'boolean' ? observed.verified : null,
    verified_label: text(observed.verified_label, 120),
    account_type: text(observed.account_type, 100),
    profile_tags: Array.isArray(observed.profile_tags) ? observed.profile_tags : [],
    public_audience_signals: Array.isArray(observed.public_audience_signals) ? observed.public_audience_signals : [],
    visible_metrics: visibleMetrics,
    profile_text: text(observed.profile_text || observed.rootText, 5_000),
    profile_title: text(observed.profile_title, 180),
    homepage_url: text(observed.homepage_url, 1_200),
    metrics,
  };
}

export async function readVisibleProfileSamples(page, maximum) {
  return page.evaluate((limit) => {
    const clean = (value, max = 0) => {
      const result = String(value || '').replace(/\s+/g, ' ').trim();
      return max ? result.slice(0, max) : result;
    };
    const absolute = (value) => {
      try { return new URL(value || '', location.href).href; } catch { return ''; }
    };
    const canonicalContentUrl = (value) => {
      try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const match = parsed.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
        if (parsed.protocol !== 'https:' || !(host === 'douyin.com' || host.endsWith('.douyin.com')) || !match) return '';
        return `https://www.douyin.com/${match[1].toLowerCase()}/${match[2]}`;
      } catch { return ''; }
    };
    const allowed = (value) => {
      try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && (host === 'douyin.com' || host.endsWith('.douyin.com'));
      } catch { return false; }
    };
    const mediaUrl = (value, preserveQuery = true) => {
      try {
        const parsed = new URL(value || '', location.href);
        const host = parsed.hostname.toLowerCase();
        const domains = ['douyin.com', 'douyinpic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com'];
        if (parsed.protocol !== 'https:' || !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
        parsed.username = '';
        parsed.password = '';
        if (preserveQuery === false) parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch { return ''; }
    };
    const contentImageUrls = (root) => [...new Set(Array.from(root?.querySelectorAll('img') || [])
      .filter((image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`))
      .map((image) => mediaUrl(image.currentSrc || image.getAttribute('src')))
      .filter(Boolean))].slice(0, 8);
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nodeMeta = (node) => [
      typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
      node?.getAttribute?.('data-e2e') || '',
      node?.getAttribute?.('aria-label') || '',
      node?.getAttribute?.('title') || '',
    ].join(' ').toLowerCase();
    const metricToken = (value) => {
      const compact = clean(value, 80).replace(/,/g, '').replace(/\s+/g, '');
      const match = compact.match(/^([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)$/i);
      return match ? match[1] : '';
    };
    const labeledMetric = (value, labels) => {
      const source = clean(value, 160);
      for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const number = '([0-9]+(?:\\.[0-9]+)?(?:[wk]|\\u4e07|\\u4ebf)?)';
        const before = source.match(new RegExp(`${number}\\s*${escaped}`, 'i'));
        if (before) return metricToken(before[1]);
        const after = source.match(new RegExp(`${escaped}\\s*[:\\uff1a]?\\s*${number}`, 'i'));
        if (after) return metricToken(after[1]);
      }
      return '';
    };
    const cardMetric = (root, labels, metadataTokens = []) => {
      const normalizedLabels = labels.map((label) => label.toLowerCase());
      const normalizedMetadata = [...normalizedLabels, ...metadataTokens.map((token) => token.toLowerCase())];
      const nodes = Array.from(root.querySelectorAll(
        'button, span, strong, em, b, i, [aria-label], [title], [data-e2e], [class]'
      )).slice(0, 900);
      for (const node of nodes) {
        if (!visible(node)) continue;
        const value = clean(node.innerText || node.textContent, 180);
        if (!value) continue;
        const labeled = labeledMetric(value, labels);
        if (labeled) return labeled;
        const meta = nodeMeta(node);
        if (!normalizedMetadata.some((token) => meta.includes(token))) continue;
        const direct = metricToken(value)
          || metricToken(node.getAttribute?.('aria-label'))
          || metricToken(node.getAttribute?.('title'));
        if (direct) return direct;
        for (const child of Array.from(node.querySelectorAll('span, strong, em, b, i, [class*=count], [class*=Count]')).slice(0, 80)) {
          if (!visible(child)) continue;
          const nested = metricToken(child.innerText || child.textContent);
          if (nested) return nested;
        }
      }
      return '';
    };
    const durationSeconds = (value) => {
      const match = clean(value, 48).match(/^(?:(\d{1,2}):)?([0-5]\d):([0-5]\d)$/);
      if (!match) return null;
      const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    };
    const rootFor = (node) => node.closest([
      'article', 'li', '[data-e2e*=aweme]', '[data-e2e*=video-card]', '[data-e2e*=note-card]',
      '[class*=video-card]', '[class*=VideoCard]', '[class*=feed-card]', '[class*=FeedCard]', '[class*=card]', '[class*=Card]',
    ].join(','));
    const output = [];
    const seen = new Set();
    for (const link of Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))) {
      const noteUrl = canonicalContentUrl(absolute(link.getAttribute('href')));
      const root = rootFor(link);
      if (!noteUrl || !root || !visible(root) || seen.has(noteUrl)) continue;
      seen.add(noteUrl);
      const body = clean(root.innerText, 900);
      const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent, 300);
      const cover = Array.from(root.querySelectorAll('img'))
        .find((image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`));
      const hashtags = [...new Set((body.match(/#[^\s#]{1,80}/g) || []).slice(0, 12))];
      const visibleMetrics = [...new Set((body.match(/\d+(?:\.\d+)?(?:[wWkK\u4e07\u4ebf])?\s*(?:\u70b9\u8d5e|\u8d5e|\u8bc4\u8bba|\u6536\u85cf|\u8f6c\u53d1|\u5206\u4eab|\u64ad\u653e|\u89c2\u770b|\u559c\u6b22)/g) || []).map((value) => clean(value, 40)))].slice(0, 16);
      const publishedAt = clean((body.match(/(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}|\d+(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d|\u6628\u5929|\u524d\u5929)/) || [])[0], 32);
      const duration = clean((body.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0], 32);
      const looksLikeImageNote = /^\s*(?:\u56fe\u6587|\u56fe\u96c6|\u56fe\u7247)(?:\s|$)/.test(body);
      const hasVideo = !looksLikeImageNote && Boolean(duration || root.querySelector('video') || /\/video\//i.test(noteUrl));
      const statistics = {
        digg_count: cardMetric(root, ['\u70b9\u8d5e', '\u8d5e', 'like', 'digg'], ['like', 'digg', 'favor']),
        collect_count: cardMetric(root, ['\u6536\u85cf', 'collect', 'favorite'], ['collect', 'favorite', 'favour']),
        comment_count: cardMetric(root, ['\u8bc4\u8bba', 'comment'], ['comment']),
        share_count: cardMetric(root, ['\u5206\u4eab', '\u8f6c\u53d1', 'share', 'forward'], ['share', 'forward']),
        play_count: cardMetric(root, ['\u64ad\u653e', '\u64ad\u653e\u91cf', '\u89c2\u770b', 'view', 'views', 'play'], ['play', 'view']),
      };
      const nonEmptyStatistics = Object.fromEntries(Object.entries(statistics).filter(([, value]) => value));
      const interactionAvailability = Object.fromEntries([
        ['likes', 'digg_count'],
        ['collects', 'collect_count'],
        ['comments', 'comment_count'],
        ['shares', 'share_count'],
      ].filter(([, metric]) => nonEmptyStatistics[metric]).map(([action]) => [action, {
        state: 'count_observed',
        source: 'rendered_profile_card',
      }]));
      const imageCount = Array.from(root.querySelectorAll('img')).filter(
        (image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`)
      ).length;
      const imageUrls = contentImageUrls(root);
      const isPinned = /(?:^|\s)(?:\u7f6e\u9876|pinned)(?:\s|$)/i.test(body);
      output.push({
        note_url: noteUrl,
        title,
        body,
        cover_url: mediaUrl(cover?.currentSrc || cover?.getAttribute('src')),
        image_urls: imageUrls,
        hashtags,
        visible_metrics: visibleMetrics,
        published_at: /^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/.test(publishedAt) ? publishedAt : '',
        published_at_text: publishedAt,
        duration_text: duration,
        duration_seconds: durationSeconds(duration),
        content_image_count: Math.max(imageCount, imageUrls.length),
        is_pinned: isPinned || null,
        statistics: nonEmptyStatistics,
        interaction_availability: interactionAvailability,
        content_type: hasVideo ? 'video' : 'image_or_note',
        content_format: hasVideo ? 'video' : 'unknown',
        has_video: hasVideo,
      });
      if (output.length >= limit) break;
    }
    return output;
  }, maximum);
}

async function readVisibleVideoDetail(page) {
  return page.evaluate(() => {
    const clean = (value, maximum = 0) => {
      const result = String(value || '').replace(/\s+/g, ' ').trim();
      return maximum ? result.slice(0, maximum) : result;
    };
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nodeMeta = (node) => [
      typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
      node?.getAttribute?.('data-e2e') || '',
      node?.getAttribute?.('aria-label') || '',
      node?.getAttribute?.('title') || '',
    ].join(' ').toLowerCase();
    const metricToken = (value) => {
      const compact = clean(value, 80).replace(/,/g, '').replace(/\s+/g, '');
      const match = compact.match(/^([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)$/i);
      return match ? match[1] : '';
    };
    const labeledMetric = (value, labels) => {
      const source = clean(value, 180);
      for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const number = '([0-9]+(?:\\.[0-9]+)?(?:[wk]|\\u4e07|\\u4ebf)?)';
        const before = source.match(new RegExp(`${number}\\s*${escaped}`, 'i'));
        if (before) return metricToken(before[1]);
        const after = source.match(new RegExp(`${escaped}\\s*[:\\uff1a]?\\s*${number}`, 'i'));
        if (after) return metricToken(after[1]);
      }
      return '';
    };
    const mediaUrl = (value) => {
      try {
        const parsed = new URL(value || '', location.href);
        const host = parsed.hostname.toLowerCase();
        const domains = ['douyin.com', 'douyinpic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com'];
        if (parsed.protocol !== 'https:' || !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch {
        return '';
      }
    };
    const detailInfo = Array.from(document.querySelectorAll(
      '[data-e2e="detail-video-info"], [data-e2e*=detail-video-info]',
    )).find(visible) || null;
    const rootCandidates = Array.from(document.querySelectorAll([
      '[data-e2e*=video-detail]', '[data-e2e*=aweme-detail]', '[data-e2e*=detail-container]',
      '[class*=video-detail]', '[class*=VideoDetail]', '[class*=aweme-detail]', '[class*=AwemeDetail]',
      '[class*=detail-container]', '[class*=DetailContainer]', 'main',
    ].join(','))).filter(visible);
    const rootScore = (node) => {
      const meta = nodeMeta(node);
      const rendered = clean(node.innerText, 3_500);
      return (/(?:video|aweme).*(?:detail)|detail.*(?:video|aweme)/i.test(meta) ? 100 : 0)
        + (node.querySelector('video') ? 20 : 0)
        + (/(?:\u53d1\u5e03|20\d{2}[./\-\u5e74])/i.test(rendered) ? 5 : 0)
        + Math.min(Math.floor(rendered.length / 500), 4);
    };
    const root = detailInfo || rootCandidates.sort((left, right) => rootScore(right) - rootScore(left))[0] || document.body;
    const rootText = clean(root.innerText, 6_000);
    const metric = (labels, metadataTokens) => {
      const selectors = 'button, [role=button], span, strong, em, b, i, [aria-label], [title], [data-e2e], [class]';
      const nodes = [root, ...Array.from(root.querySelectorAll(selectors)).slice(0, 1_600)];
      for (const node of nodes) {
        if (!visible(node)) continue;
        const rendered = clean(node.innerText || node.textContent, 180);
        const aria = clean(node.getAttribute?.('aria-label'), 180);
        const title = clean(node.getAttribute?.('title'), 180);
        for (const source of [rendered, aria, title]) {
          const labeled = labeledMetric(source, labels);
          if (labeled) return labeled;
        }
        const meta = nodeMeta(node);
        if (!metadataTokens.some((token) => meta.includes(token))) continue;
        for (const source of [rendered, aria, title]) {
          const direct = metricToken(source);
          if (direct) return direct;
        }
        const nearby = [node.parentElement, node.nextElementSibling]
          .filter((candidate) => candidate && visible(candidate));
        for (const candidate of nearby) {
          const candidateText = clean(candidate.innerText || candidate.textContent, 180);
          const labeled = labeledMetric(candidateText, labels);
          if (labeled) return labeled;
          const direct = metricToken(candidateText);
          if (direct) return direct;
          for (const child of Array.from(candidate.querySelectorAll('span, strong, em, b, i, [class*=count], [class*=Count]')).slice(0, 40)) {
            if (!visible(child)) continue;
            const nested = metricToken(child.innerText || child.textContent);
            if (nested) return nested;
          }
        }
      }
      return '';
    };
    const orderedActionStatistics = () => {
      if (!detailInfo) return { matched: false, statistics: {} };
      const shareAction = Array.from(detailInfo.querySelectorAll('[data-e2e*=share]')).find(visible);
      const actionRow = shareAction?.parentElement;
      if (!actionRow || !visible(actionRow)) return { matched: false, statistics: {} };
      const actionNodes = Array.from(actionRow.children).filter(visible);
      const shareIndex = actionNodes.findIndex((node) => node === shareAction || node.contains(shareAction));
      if (shareIndex !== 3 || actionNodes.length < 4) return { matched: false, statistics: {} };
      const actionValue = (node) => {
        const direct = metricToken(node.innerText || node.textContent);
        if (direct) return direct;
        for (const child of Array.from(node.querySelectorAll('span, strong, em, b, i')).slice(0, 16)) {
          if (!visible(child)) continue;
          const nested = metricToken(child.innerText || child.textContent);
          if (nested) return nested;
        }
        return '';
      };
      const values = actionNodes.slice(0, 3).map(actionValue);
      const shareValue = actionValue(actionNodes[shareIndex]);
      const availability = Object.fromEntries([
        ['likes', values[0]],
        ['comments', values[1]],
        ['collects', values[2]],
        ['shares', shareValue],
      ].map(([name, value]) => [name, {
        state: value ? 'count_observed' : 'action_visible_count_not_shown',
        source: 'rendered_detail',
      }]));
      return {
        matched: true,
        // The public action row is ordered as like, comment, collect, share.
        // Some cards render a CTA label (for example, "collect") without a count;
        // retain only the numbers actually shown instead of shifting a neighbor.
        statistics: Object.fromEntries([
          ['digg_count', values[0]],
          ['comment_count', values[1]],
          ['collect_count', values[2]],
          ['share_count', shareValue],
        ].filter(([, value]) => value)),
        availability,
      };
    };
    const firstVisibleText = (selector, maximum) => {
      for (const node of Array.from(root.querySelectorAll(selector))) {
        if (!visible(node)) continue;
        const result = clean(node.innerText || node.textContent, maximum);
        if (result) return result;
      }
      return '';
    };
    const publicationSource = firstVisibleText([
      'time', '[data-e2e*=publish]', '[data-e2e*=time]', '[data-e2e*=date]',
      '[class*=publish]', '[class*=Publish]', '[class*=time]', '[class*=Time]', '[class*=date]', '[class*=Date]',
    ].join(','), 300) || rootText;
    const rawPublication = (publicationSource.match(/20\d{2}(?:[./\-]|\u5e74)\d{1,2}(?:[./\-]|\u6708)\d{1,2}(?:\u65e5)?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/) || [])[0] || '';
    const publishedAt = clean(rawPublication
      .replace(/[./\u5e74]/g, '-')
      .replace(/\u6708/g, '-')
      .replace(/\u65e5/g, ''), 32);
    const detailText = firstVisibleText([
      '[data-e2e*=video-desc]', '[data-e2e*=desc]', '[class*=video-desc]', '[class*=VideoDesc]',
      '[class*=caption]', '[class*=Caption]', '[class*=description]', '[class*=Description]', 'h1',
    ].join(','), 1_200);
    const title = firstVisibleText('h1, [data-e2e*=video-title], [class*=video-title], [class*=VideoTitle]', 300)
      || detailText.split(/\r?\n/, 1)[0] || '';
    const video = Array.from(document.querySelectorAll('video')).find(visible) || null;
    const cover = mediaUrl(video?.getAttribute('poster')) || mediaUrl(
      Array.from(root.querySelectorAll('img')).find(
        (image) => !/(?:avatar|head|user|author|profile)/i.test(`${image.alt || ''} ${image.className || ''}`),
      )?.currentSrc,
    );
    // Detail metadata includes the publication time. Do not treat that time of
    // day as a video duration when the player does not expose a duration value.
    const durationText = '';
    const durationSeconds = Number.isFinite(video?.duration) && video.duration > 0
      ? Math.round(video.duration)
      : null;
    const hasVideo = Boolean(video);
    const orderedActionResult = orderedActionStatistics();
    const orderedStatistics = orderedActionResult.statistics;
    const statistics = {
      digg_count: orderedActionResult.matched
        ? orderedStatistics.digg_count || ''
        : metric(['\u70b9\u8d5e', '\u8d5e', 'like', 'digg'], ['like', 'digg']),
      collect_count: orderedActionResult.matched
        ? orderedStatistics.collect_count || ''
        : metric(['\u6536\u85cf', 'collect', 'favorite', 'favourite'], ['collect', 'favorite', 'favour']),
      comment_count: orderedActionResult.matched
        ? orderedStatistics.comment_count || ''
        : metric(['\u8bc4\u8bba', 'comment'], ['comment']),
      share_count: orderedActionResult.matched
        ? orderedStatistics.share_count || ''
        : metric(['\u5206\u4eab', '\u8f6c\u53d1', 'share', 'forward'], ['share', 'forward']),
      play_count: metric(['\u64ad\u653e', '\u64ad\u653e\u91cf', '\u89c2\u770b', 'view', 'views', 'play'], ['play', 'view']),
    };
    return {
      title,
      body: detailText,
      cover_url: cover,
      published_at: publishedAt,
      published_at_text: rawPublication,
      duration_text: durationText,
      duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      statistics: Object.fromEntries(Object.entries(statistics).filter(([, value]) => value)),
      interaction_availability: orderedActionResult.availability || {},
      content_type: hasVideo ? 'video' : 'image_or_note',
      content_format: hasVideo ? 'video' : 'unknown',
      has_video: hasVideo,
    };
  });
}

function visibleDetailFieldCount(sample) {
  const statistics = publicStatistics(sample?.statistics);
  return Number(publicPublishedAt(sample?.published_at ?? sample?.publishedAt) !== '') + Object.keys(statistics).length;
}

function needsDetailRetry(sample) {
  return publicPublishedAt(sample?.published_at ?? sample?.publishedAt) === ''
    || Object.keys(publicInteractionAvailability(
      sample?.interaction_availability ?? sample?.interactionAvailability,
    )).length === 0;
}

export function detailWorkerCount(queuedSampleCount) {
  const count = Number.isFinite(Number(queuedSampleCount))
    ? Math.max(0, Math.floor(Number(queuedSampleCount)))
    : 0;
  return Math.min(MAX_CONCURRENT_VISIBLE_DETAIL_PAGES, count);
}

export function markVisibleDetailBlocked(summary, index) {
  summary.detail_attempted_count = Math.max(0, summary.detail_attempted_count - 1);
  summary.detail_skipped_count += 1;
  summary.detail_blocked_count += 1;
  summary.detail_blocked_sample_indexes.push(index);
}

async function waitForVisibleDetailMarker(page, timeout) {
  await page.waitForSelector(VISIBLE_DETAIL_READY_SELECTOR, {
    state: 'visible',
    timeout,
  }).catch(() => undefined);
}

function isDouyinVideoUrl(value) {
  const canonical = canonicalDouyinUrl(value);
  try {
    return Boolean(canonical) && new URL(canonical).pathname.startsWith('/video/');
  } catch {
    return false;
  }
}

const REQUIRED_DETAIL_ACTIONS = ['likes', 'collects', 'comments', 'shares'];

export function hasCompleteVisibleDetailFields(sample) {
  if (publicPublishedAt(sample?.published_at ?? sample?.publishedAt) === '') return false;
  const availability = publicInteractionAvailability(
    sample?.interaction_availability ?? sample?.interactionAvailability,
  );
  return REQUIRED_DETAIL_ACTIONS.every((action) => [
    'count_observed',
    'action_visible_count_not_shown',
  ].includes(availability[action]?.state));
}

// Profile cards and their public detail pages often hydrate complementary
// fields. Avoid a fixed retry only after their merged record is already
// complete, so this never trades timestamp or action coverage for throughput.
export function shouldRetryVisibleDetail(profileSample, detailSample) {
  return needsDetailRetry(detailSample)
    && !hasCompleteVisibleDetailFields(mergeDouyinVisibleSamples(profileSample, detailSample));
}

export function visibleDetailQueuePlan(samples, detailSampleLimit, { includeAllContent = false } = {}) {
  const source = Array.isArray(samples) ? samples : [];
  const videoIndexes = source
    .map((sample, index) => (isDouyinVideoUrl(sample?.note_url) ? index : -1))
    .filter((index) => index >= 0);
  const candidateIndexes = includeAllContent
    ? source
      .map((sample, index) => (canonicalDouyinContentUrl(sample?.note_url) ? index : -1))
      .filter((index) => index >= 0)
    : videoIndexes;
  const requested = Number(detailSampleLimit);
  const requestedSampleLimit = Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : source.length;
  const effectiveSampleLimit = Math.min(requestedSampleLimit, candidateIndexes.length);
  const boundedIndexes = candidateIndexes.slice(0, effectiveSampleLimit);
  const deferredIndexes = candidateIndexes.slice(effectiveSampleLimit);
  // Search detail enrichment also owns top-comment collection, so a card with
  // complete action counts still needs one detail visit for its comment panel.
  const cardCompleteIndexes = includeAllContent
    ? []
    : boundedIndexes.filter((index) => hasCompleteVisibleDetailFields(source[index]));
  // This path can receive all 10,000 visible works. A Set keeps complete-card
  // filtering linear instead of scanning the complete list for every work.
  const completeIndexSet = new Set(cardCompleteIndexes);
  const queuedIndexes = boundedIndexes.filter((index) => !completeIndexSet.has(index));
  const deferredCardCompleteIndexes = deferredIndexes
    .filter((index) => hasCompleteVisibleDetailFields(source[index]));
  const deferredIncompleteIndexes = deferredIndexes
    .filter((index) => !hasCompleteVisibleDetailFields(source[index]));
  return {
    videoIndexes,
    candidateIndexes,
    requestedSampleLimit,
    effectiveSampleLimit,
    boundedIndexes,
    deferredIndexes,
    cardCompleteIndexes,
    queuedIndexes,
    deferredCardCompleteIndexes,
    deferredIncompleteIndexes,
  };
}

export function finishVisibleDetailSummary(summary) {
  const deferredIncompleteCount = Math.max(0, Number(summary.detail_deferred_incomplete_count) || 0);
  const navigationFailedCount = Math.max(0, Number(summary.detail_navigation_failed_count) || 0);
  const blockedCount = Math.max(0, Number(summary.detail_blocked_count) || 0);
  const incompleteAfterEnrichmentCount = Math.max(0, Number(summary.detail_incomplete_after_enrichment_count) || 0);
  const reportedUncoveredCount = Number(summary.detail_uncovered_incomplete_count);
  const candidateCount = Math.max(0, Number(summary.detail_url_candidate_count) || 0);
  summary.detail_uncovered_incomplete_count = Number.isFinite(reportedUncoveredCount) && reportedUncoveredCount >= 0
    ? Math.floor(reportedUncoveredCount)
    : Math.max(0, Number(summary.detail_skipped_count) || 0) + navigationFailedCount;
  summary.detail_complete_record_count = Math.max(
    0,
    candidateCount - summary.detail_uncovered_incomplete_count,
  );
  summary.detail_coverage_state = blockedCount
    ? 'platform_action_required'
    : navigationFailedCount
      ? 'detail_navigation_retryable'
      : deferredIncompleteCount
        ? 'requested_detail_limit_reached'
        : incompleteAfterEnrichmentCount
          ? 'public_fields_incomplete'
          : 'requested_scope_covered';
  summary.detail_continuation_recommended = blockedCount > 0
    || navigationFailedCount > 0
    || deferredIncompleteCount > 0;
  summary.detail_next_action = blockedCount
    ? 'restore_relay_session'
    : navigationFailedCount
      ? 'retry_detail_collection'
      : deferredIncompleteCount
        ? 'increase_detail_sample_limit'
        : 'none';
  return summary;
}

async function enrichVisibleVideoDetails(profilePage, samples, detailSampleLimit, timing = null, options = {}) {
  const enrichedSamples = Array.isArray(samples) ? samples.slice() : [];
  const includeAllContent = Boolean(options.includeAllContent);
  const collectTopComments = Boolean(options.collectTopComments);
  const commentLimit = Math.max(1, Math.min(10, Number(options.commentLimit) || 10));
  const detailPlan = visibleDetailQueuePlan(enrichedSamples, detailSampleLimit, { includeAllContent });
  const {
    videoIndexes,
    candidateIndexes,
    requestedSampleLimit,
    effectiveSampleLimit,
    boundedIndexes,
    deferredIndexes,
    cardCompleteIndexes,
    queuedIndexes,
    deferredCardCompleteIndexes,
    deferredIncompleteIndexes,
  } = detailPlan;
  const workerCount = detailWorkerCount(queuedIndexes.length);
  const summary = {
    detail_url_candidate_count: candidateIndexes.length,
    detail_sample_limit: requestedSampleLimit,
    detail_requested_sample_limit: requestedSampleLimit,
    detail_effective_candidate_limit: effectiveSampleLimit,
    detail_deferred_count: deferredIndexes.length,
    detail_deferred_complete_card_count: deferredCardCompleteIndexes.length,
    detail_deferred_incomplete_count: deferredIncompleteIndexes.length,
    detail_card_complete_count: cardCompleteIndexes.length,
    detail_card_complete_total_count: cardCompleteIndexes.length + deferredCardCompleteIndexes.length,
    detail_queued_count: queuedIndexes.length,
    detail_worker_count: workerCount,
    detail_wait_strategy: 'domcontentloaded_then_visible_detail_surface_no_fixed_settle',
    detail_fixed_settle_delay_ms: 0,
    detail_ready_timeout_ms: DETAIL_PAGE_READY_TIMEOUT_MS,
    detail_attempted_count: 0,
    detail_enriched_sample_count: 0,
    detail_fields_unavailable_count: 0,
    detail_navigation_failed_count: 0,
    detail_retry_count: 0,
    detail_retry_recovered_count: 0,
    detail_retry_avoided_by_profile_fields_count: 0,
    detail_incomplete_after_enrichment_count: 0,
    // A complete public profile card is already sufficient. Only deferred
    // records with missing date or action coverage count as incomplete.
    detail_skipped_count: deferredIncompleteIndexes.length,
    detail_blocked_count: 0,
    detail_blocked_sample_indexes: [],
    detail_access_state: '',
    comment_collection_enabled: collectTopComments,
    comment_limit: collectTopComments ? commentLimit : 0,
    comment_attempted_count: 0,
    comment_collected_count: 0,
    comment_empty_count: 0,
    comment_failed_count: 0,
  };
  const unresolvedSampleIndexes = new Set(deferredIncompleteIndexes);
  const refreshUncoveredCount = () => {
    summary.detail_uncovered_incomplete_count = unresolvedSampleIndexes.size;
  };
  if (!queuedIndexes.length) {
    refreshUncoveredCount();
    return { samples: enrichedSamples, summary: finishVisibleDetailSummary(summary) };
  }

  let nextPosition = 0;
  let accessBlocked = false;
  const claimNext = () => {
    if (accessBlocked || nextPosition >= queuedIndexes.length) return null;
    const position = nextPosition;
    nextPosition += 1;
    return { position, index: queuedIndexes[position] };
  };

  const enrichOnPage = async (detailPage) => {
    while (true) {
      const claimed = claimNext();
      if (!claimed) return;
      const { index } = claimed;
      const sample = enrichedSamples[index];
      summary.detail_attempted_count += 1;
      try {
        if (timing) await timing.wait();
        await detailPage.goto(sample.note_url, { waitUntil: 'domcontentloaded', timeout: DETAIL_PAGE_OPEN_TIMEOUT_MS });
        await waitForVisibleDetailMarker(detailPage, DETAIL_PAGE_READY_TIMEOUT_MS);
        const access = await renderedAccessState(detailPage);
        if (access === 'login_required' || access === 'verification_required') {
          summary.detail_access_state = access;
          accessBlocked = true;
          // The visible gate means this work was not collected. Keep it in the
          // skipped set so a resumed task can collect it after the session is
          // restored, rather than reporting it as a completed attempt.
          markVisibleDetailBlocked(summary, index);
          unresolvedSampleIndexes.add(index);
          return;
        }
        let detail = sampleFromCard({ ...await readVisibleVideoDetail(detailPage), note_url: sample.note_url });
        let mergedSample = mergeDouyinVisibleSamples(sample, detail);
        // Some pages finish their basic navigation before the visible detail
        // panel mounts. Retry only the incomplete item so normal throughput is
        // unaffected while dates and action availability remain per-work data.
        if (shouldRetryVisibleDetail(sample, detail)) {
          summary.detail_retry_count += 1;
          await detailPage.waitForTimeout(DETAIL_PAGE_RETRY_DELAY_MS);
          await waitForVisibleDetailMarker(detailPage, DETAIL_PAGE_RETRY_TIMEOUT_MS);
          const retriedDetail = sampleFromCard({ ...await readVisibleVideoDetail(detailPage), note_url: sample.note_url });
          if (!needsDetailRetry(retriedDetail)) summary.detail_retry_recovered_count += 1;
          detail = mergeDouyinVisibleSamples(detail, retriedDetail);
          mergedSample = mergeDouyinVisibleSamples(sample, detail);
        } else if (needsDetailRetry(detail)) {
          summary.detail_retry_avoided_by_profile_fields_count += 1;
        }
        if (visibleDetailFieldCount(detail) > 0) summary.detail_enriched_sample_count += 1;
        else summary.detail_fields_unavailable_count += 1;
        if (collectTopComments) {
          summary.comment_attempted_count += 1;
          try {
            const commentCollection = await collectComments(detailPage, {
              limit: commentLimit,
              timing,
            });
            const comments = Array.isArray(commentCollection.records)
              ? commentCollection.records.slice(0, commentLimit)
              : [];
            detail = { ...detail, comments };
            summary.comment_collected_count += comments.length;
            if (!comments.length) summary.comment_empty_count += 1;
          } catch {
            summary.comment_failed_count += 1;
          }
        }
        mergedSample = mergeDouyinVisibleSamples(sample, detail);
        if (!hasCompleteVisibleDetailFields(mergedSample)) {
          summary.detail_incomplete_after_enrichment_count += 1;
          unresolvedSampleIndexes.add(index);
        }
        enrichedSamples[index] = mergedSample;
      } catch {
        summary.detail_navigation_failed_count += 1;
        unresolvedSampleIndexes.add(index);
      }
      options.onProgress?.({
        attempted: summary.detail_attempted_count,
        total: queuedIndexes.length,
        enriched: summary.detail_enriched_sample_count,
        commentsAttempted: summary.comment_attempted_count,
        commentsCollected: summary.comment_collected_count,
      });
    }
  };

  let detailPages = [];
  try {
    const context = profilePage.context();
    for (let worker = 0; worker < workerCount; worker += 1) {
      detailPages.push(await context.newPage());
    }
    await Promise.all(detailPages.map((detailPage) => enrichOnPage(detailPage)));
    // A visible login or verification gate stops new work immediately. Pages
    // already in flight are allowed to finish; record only the unclaimed work
    // as skipped so the task remains honestly resumable.
    summary.detail_skipped_count += Math.max(0, queuedIndexes.length - nextPosition);
    for (const index of queuedIndexes.slice(nextPosition)) unresolvedSampleIndexes.add(index);
  } catch {
    summary.detail_navigation_failed_count += 1;
    summary.detail_skipped_count = Math.max(
      summary.detail_skipped_count,
      deferredIncompleteIndexes.length + queuedIndexes.length,
    );
    for (const index of queuedIndexes) unresolvedSampleIndexes.add(index);
  } finally {
    await Promise.all(detailPages.map(async (detailPage) => {
      try {
        await detailPage.close();
      } catch {
        // A closed Relay detail tab requires no recovery work.
      }
    }));
  }
  refreshUncoveredCount();
  return { samples: enrichedSamples, summary: finishVisibleDetailSummary(summary) };
}

export function sampleFromCard(card) {
  const publishedAt = publicPublishedAt(card?.published_at ?? card?.publishedAt);
  const durationSeconds = publicDurationSeconds(
    card?.duration_seconds ?? card?.durationSeconds ?? card?.duration_text ?? card?.durationText,
  );
  const videoUrl = scrubDouyinPlaybackUrl(card?.video_url);
  const rawContentType = text(card?.content_type, 32) || 'unknown';
  const hasVideo = Boolean(card?.has_video || videoUrl || durationSeconds !== null || rawContentType === 'video');
  const imageCount = Number(card?.content_image_count ?? card?.contentImageCount);
  const statistics = publicStatistics(card?.statistics);
  if (statistics.digg_count === undefined) {
    const leadingMetric = publicLeadingMetric(card?.body);
    if (leadingMetric) statistics.digg_count = leadingMetric;
  }
  const interactionAvailability = publicInteractionAvailability(
    card?.interaction_availability ?? card?.interactionAvailability,
  );
  const sample = {
    note_url: canonicalDouyinContentUrl(card.note_url),
    title: text(card.title, 300),
    body: text(card.body, 900),
    cover_url: scrubDouyinMediaUrl(card.cover_url),
    image_urls: Array.isArray(card.image_urls)
      ? card.image_urls.map((value) => scrubDouyinMediaUrl(value)).filter(Boolean).slice(0, 8)
      : [],
    video_url: videoUrl,
    content_type: hasVideo ? 'video' : rawContentType,
    content_format: hasVideo ? 'video' : text(card.content_format, 32) || 'unknown',
    has_video: hasVideo,
    hashtags: Array.isArray(card.hashtags) ? card.hashtags.map((tag) => text(tag, 80)).filter(Boolean).slice(0, 12) : [],
    visible_metrics: Array.isArray(card.visible_metrics) ? card.visible_metrics.map((metric) => text(metric, 40)).filter(Boolean).slice(0, 16) : [],
    published_at_text: text(card.published_at_text, 32),
    duration_text: text(card.duration_text, 32),
  };
  if (publishedAt !== '') sample.published_at = publishedAt;
  if (durationSeconds !== null) sample.duration_seconds = durationSeconds;
  if (Number.isFinite(imageCount) && imageCount >= 0) sample.content_image_count = Math.trunc(imageCount);
  if (card?.is_pinned === true) sample.is_pinned = true;
  if (Object.keys(statistics).length) sample.statistics = statistics;
  if (Object.keys(interactionAvailability).length) sample.interaction_availability = interactionAvailability;
  return sample;
}

export function mergeVisibleSearchCards(existing, cards, sourceSearchUrl) {
  const records = existing instanceof Map ? existing : new Map();
  for (const card of cards || []) {
    const profileUrl = canonicalDouyinUrl(card?.author_profile);
    const author = text(card?.author, 120);
    if (!profileUrl || !author) continue;
    const sample = sampleFromCard(card);
    const current = records.get(profileUrl);
    if (!current) {
      const samples = sample.note_url ? [sample] : [];
      records.set(profileUrl, {
        author: { nickname: author },
        observed_name: author,
        author_profile: profileUrl,
        source_profile_url: profileUrl,
        note_url: sample.note_url,
        title: sample.title,
        body: sample.body,
        cover_url: sample.cover_url,
        latest_samples: samples,
        profile: {
          nickname: author,
          latest_samples: samples,
          content_summary: { visible_sample_count: samples.length, sampled_from_public_search: true },
        },
        content_summary: { visible_sample_count: samples.length, sampled_from_public_search: true },
        public_data_scope: 'visible_public_search_cards',
        scraped_at: utcNow(),
        source_search_url: sourceSearchUrl,
      });
      continue;
    }
    if (sample.note_url && !current.latest_samples.some((item) => item.note_url === sample.note_url)) {
      current.latest_samples.push(sample);
      current.profile.latest_samples = current.latest_samples;
      current.profile.content_summary.visible_sample_count = current.latest_samples.length;
      current.content_summary.visible_sample_count = current.latest_samples.length;
    }
  }
  return records;
}

export function searchIdleStopReason(recordCount) {
  return recordCount > 0 ? 'page_exhausted' : 'public_results_unavailable_retryable';
}

export function profileIdleStopReason(lastScrollControlSucceeded) {
  return lastScrollControlSucceeded === true
    ? 'profile_page_exhausted'
    : 'public_profile_settled_retryable';
}

export function profileCollectionCoverage({
  stopReason,
  requestedLimit,
  returnedVisibleSampleCount,
  lastScrollControlSucceeded = null,
} = {}) {
  const normalizedStopReason = text(stopReason, 120).toLowerCase();
  const limit = Number(requestedLimit);
  const requestedContentSampleLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : null;
  const returned = Number(returnedVisibleSampleCount);
  const returnedVisibleContentSamples = Number.isFinite(returned) && returned >= 0 ? Math.trunc(returned) : 0;
  const publicProfilePagesExhausted = [
    'page_exhausted',
    'profile_page_exhausted',
    'public_page_exhausted',
  ].includes(normalizedStopReason);
  const requestedLimitReached = [
    'target_reached',
    'sample_limit_reached',
    'profile_sample_limit_reached',
    'requested_limit_reached',
  ].includes(normalizedStopReason)
    || (requestedContentSampleLimit !== null && returnedVisibleContentSamples >= requestedContentSampleLimit);
  const retryableStop = normalizedStopReason === 'bounded_scan_limit'
    || normalizedStopReason === 'scroll_control_unavailable'
    || normalizedStopReason.endsWith('_retryable');
  const continuationRecommended = !publicProfilePagesExhausted
    && !requestedLimitReached
    && !normalizedStopReason.startsWith('platform_')
    && (retryableStop || lastScrollControlSucceeded === false);
  const coverageState = continuationRecommended
    ? 'resumable'
    : publicProfilePagesExhausted
      ? 'page_exhausted'
      : requestedLimitReached
        ? 'requested_limit_reached'
        : returnedVisibleContentSamples
          ? 'terminal_state_unconfirmed'
          : 'no_visible_content_returned';
  return {
    requested_content_sample_limit: requestedContentSampleLimit,
    returned_visible_content_samples: returnedVisibleContentSamples,
    requested_limit_reached: requestedLimitReached,
    public_profile_pages_exhausted: publicProfilePagesExhausted,
    more_public_content_may_be_available: publicProfilePagesExhausted
      ? false
      : (requestedLimitReached || continuationRecommended ? true : null),
    continuation_recommended: continuationRecommended,
    coverage_state: coverageState,
    next_collection_action: continuationRecommended
      ? 'resume_collection'
      : requestedLimitReached && !publicProfilePagesExhausted
        ? 'increase_sample_limit'
        : publicProfilePagesExhausted
          ? 'none'
          : 'inspect_stop_evidence',
  };
}

function stopEvidence(stopReason, continuationRecommended, extra = {}) {
  return {
    classification: ['target_reached', 'requested_limit_reached', 'sample_limit_reached'].includes(stopReason)
      ? 'target_reached'
      : stopReason === 'page_exhausted'
        ? 'page_exhausted'
      : stopReason.startsWith('platform_')
        ? 'platform_action_required'
        : stopReason === 'bounded_scan_limit'
          ? 'bounded_scan_limit'
          : 'retryable_collection_gap',
    continuation_recommended: continuationRecommended,
    ...extra,
  };
}

function collectionStatus({
  mode,
  requestedLimit,
  records,
  stopReason,
  sourceUrl,
  scrolls,
  scrollBudget,
  continuationRecommended,
  coverage = {},
  publicDataScope = '',
  extra = {},
}) {
  const uniqueProfiles = new Set(records.map((record) => record.author_profile).filter(Boolean)).size;
  const visibleCardCount = records.reduce((total, record) => total + (record.latest_samples?.length || 0), 0);
  const status = {
    schema_version: 2,
    mode,
    requested_limit: requestedLimit,
    records_collected: records.length,
    unique_profiles: uniqueProfiles,
    cumulative_public_page_cards: visibleCardCount,
    cumulative_unique_accounts: uniqueProfiles,
    scrolls_attempted: scrolls,
    scroll_budget: scrollBudget,
    stop_reason: stopReason,
    ...coverage,
    scroll_progress: { scrolls_attempted: scrolls, scroll_budget: scrollBudget },
    stop_evidence: stopEvidence(stopReason, continuationRecommended, extra),
    public_data_scope: publicDataScope || (mode === 'profile'
      ? 'profile_and_visible_content'
      : mode === 'comments' ? 'visible_public_comments' : 'visible_public_search_cards'),
    completed_at: utcNow(),
  };
  if (mode === 'profile') status.source_profile_url = sourceUrl;
  else if (mode === 'comments') status.source_post_url = sourceUrl;
  else status.source_search_url = sourceUrl;
  return status;
}

export function applySearchDetailEnrichment(records, enrichedSamples) {
  const byUrl = new Map(
    (Array.isArray(enrichedSamples) ? enrichedSamples : [])
      .map((sample) => [canonicalDouyinContentUrl(sample?.note_url), sample])
      .filter(([url]) => Boolean(url)),
  );
  return (Array.isArray(records) ? records : []).map((record) => {
    const currentSamples = Array.isArray(record?.latest_samples) ? record.latest_samples : [];
    const samples = currentSamples.map((sample) => {
      const enriched = byUrl.get(canonicalDouyinContentUrl(sample?.note_url));
      return enriched || sample;
    });
    const profile = record?.profile && typeof record.profile === 'object'
      ? {
        ...record.profile,
        latest_samples: samples,
        content_summary: {
          ...(record.profile.content_summary || {}),
          visible_sample_count: samples.length,
        },
      }
      : record?.profile;
    return {
      ...record,
      latest_samples: samples,
      ...(profile ? { profile } : {}),
      content_summary: {
        ...(record?.content_summary || {}),
        visible_sample_count: samples.length,
      },
      public_data_scope: 'visible_public_search_cards_and_post_details',
    };
  });
}

export function filterKnownSearchRecords(records, skipPostUrls = []) {
  const skipped = new Set((Array.isArray(skipPostUrls) ? skipPostUrls : [...(skipPostUrls || [])])
    .map((value) => canonicalDouyinContentUrl(value))
    .filter(Boolean));
  if (!skipped.size) return Array.isArray(records) ? records : [];
  return (Array.isArray(records) ? records : []).map((record) => {
    const samples = Array.isArray(record?.latest_samples) ? record.latest_samples : [];
    const freshSamples = samples.filter((sample) => !skipped.has(canonicalDouyinContentUrl(sample?.note_url)));
    if (!freshSamples.length) return null;
    return searchRecordWithSamples(record, freshSamples);
  }).filter(Boolean);
}

function searchRecordWithSamples(record, samples) {
  if (!record || !Array.isArray(samples) || !samples.length) return null;
  const profile = record?.profile && typeof record.profile === 'object'
    ? {
      ...record.profile,
      latest_samples: samples,
      content_summary: {
        ...(record.profile.content_summary || {}),
        visible_sample_count: samples.length,
      },
    }
    : record?.profile;
  return {
    ...record,
    latest_samples: samples,
    ...(profile ? { profile } : {}),
    content_summary: {
      ...(record?.content_summary || {}),
      visible_sample_count: samples.length,
    },
    public_data_scope: 'visible_public_search_cards_and_post_details',
  };
}

async function collectSearch(page, args, initialReadiness = {}) {
  const sourceUrl = canonicalDouyinUrl(page.url(), { retainSearch: true }) || searchUrl(args);
  const isPostSearch = /(?:[?&])type=general(?:&|$)/i.test(sourceUrl);
  const skipPostUrls = new Set((args.skipPostUrls || [])
    .map((value) => canonicalDouyinContentUrl(value))
    .filter(Boolean));
  const recordsByProfile = new Map();
  const visibleSampleCount = () => [...recordsByProfile.values()].reduce((total, record) => (
    total + (Array.isArray(record?.latest_samples) ? record.latest_samples.length : 0)
  ), 0);
  const visibleNewSampleCount = () => [...recordsByProfile.values()].reduce((total, record) => (
    total + (Array.isArray(record?.latest_samples)
      ? record.latest_samples.filter((sample) => !skipPostUrls.has(canonicalDouyinContentUrl(sample?.note_url))).length
      : 0)
  ), 0);
  const scrollBudget = Math.max(8, Math.min(MAX_DISCOVERY_SCROLLS, Math.ceil(args.limit / 6) + 8));
  let stopReason = 'bounded_scan_limit';
  let scrolls = 0;
  let idleScrolls = 0;
  const reportSearchProgress = (phase = 'search', extra = {}) => {
    const visible = visibleSampleCount();
    const newPosts = visibleNewSampleCount();
    process.stderr.write(`SEARCH_PROGRESS phase=${phase} scrolls=${scrolls} scroll_budget=${scrollBudget} visible=${visible} new_posts=${newPosts} limit=${args.limit} idle=${idleScrolls}${extra.attempted === undefined ? '' : ` attempted=${extra.attempted} total=${extra.total || 0} enriched=${extra.enriched || 0} comments_attempted=${extra.commentsAttempted || 0} comments_collected=${extra.commentsCollected || 0}`}\n`);
  };
  reportSearchProgress();
  for (let step = 0; step < scrollBudget; step += 1) {
    const access = await renderedAccessState(page);
    if (access === 'verification_required') {
      stopReason = `platform_${access}`;
      break;
    }
    const beforeSize = recordsByProfile.size;
    const beforeSampleCount = isPostSearch ? visibleNewSampleCount() : visibleSampleCount();
    const visibleCards = await readVisibleSearchCards(page, Math.max(args.limit * 2, 120));
    mergeVisibleSearchCards(recordsByProfile, visibleCards, sourceUrl);
    reportSearchProgress();
    if (shouldBlockSearchAccess(access, visibleCards.length)) {
      stopReason = `platform_${access}`;
      break;
    }
    const availableCount = isPostSearch ? visibleNewSampleCount() : recordsByProfile.size;
    if (availableCount >= args.limit) {
      stopReason = 'target_reached';
      break;
    }
    const beforeSurface = await visibleSurfaceFingerprint(page);
    await args.timing.wait();
    if (!await scrollVisibleSurface(page)) {
      stopReason = 'scroll_control_failed_retryable';
      break;
    }
    scrolls += 1;
    const afterSurface = await waitForVisibleContentMutation(page, beforeSurface, 550);
    mergeVisibleSearchCards(recordsByProfile, await readVisibleSearchCards(page, Math.max(args.limit * 2, 120)), sourceUrl);
    const grew = (isPostSearch ? visibleNewSampleCount() : recordsByProfile.size) > (isPostSearch ? beforeSampleCount : beforeSize)
      || surfaceProgressed(beforeSurface, afterSurface);
    idleScrolls = grew ? 0 : idleScrolls + 1;
    reportSearchProgress();
    if (idleScrolls >= MAX_IDLE_SCROLLS) {
      stopReason = searchIdleStopReason(isPostSearch ? visibleNewSampleCount() : recordsByProfile.size);
      break;
    }
  }
  mergeVisibleSearchCards(recordsByProfile, await readVisibleSearchCards(page, Math.max(args.limit * 2, 120)), sourceUrl);
  const filteredRecords = filterKnownSearchRecords([...recordsByProfile.values()], skipPostUrls)
    .filter((record) => !isPostSearch || (Array.isArray(record?.latest_samples) && record.latest_samples.length > 0))
  const discoveredRecords = isPostSearch
    ? (() => {
      let selectedCount = 0;
      return filteredRecords.reduce((output, record) => {
        const remaining = args.limit - selectedCount;
        if (remaining <= 0) return output;
        const selected = record.latest_samples.slice(0, remaining);
        if (selected.length) {
          output.push(searchRecordWithSamples(record, selected));
          selectedCount += selected.length;
        }
        return output;
      }, []);
    })()
    : filteredRecords.slice(0, args.limit);
  const searchSamples = discoveredRecords.flatMap((record) => (
    Array.isArray(record.latest_samples) ? record.latest_samples : []
  ));
  reportSearchProgress('detail', { attempted: 0, total: searchSamples.length });
  const detailEnrichment = await enrichVisibleVideoDetails(
    page,
    searchSamples,
    searchSamples.length,
    args.timing,
    {
      includeAllContent: true,
      collectTopComments: true,
      commentLimit: 10,
      onProgress: (detailProgress) => reportSearchProgress('detail', detailProgress),
    },
  );
  reportSearchProgress('complete', {
    attempted: detailEnrichment.summary.detail_attempted_count,
    total: searchSamples.length,
    enriched: detailEnrichment.summary.detail_enriched_sample_count,
    commentsAttempted: detailEnrichment.summary.comment_attempted_count,
    commentsCollected: detailEnrichment.summary.comment_collected_count,
  });
  const records = applySearchDetailEnrichment(discoveredRecords, detailEnrichment.samples);
  const continuationRecommended = !['target_reached', 'page_exhausted'].includes(stopReason)
    && !stopReason.startsWith('platform_');
  return {
    records,
    sourceUrl,
    status: collectionStatus({
      mode: 'search', requestedLimit: args.limit, records, stopReason, sourceUrl, scrolls, scrollBudget, continuationRecommended,
      publicDataScope: 'visible_public_search_cards_and_post_details',
      extra: {
        idle_scrolls: idleScrolls,
        initial_search_hydration: initialReadiness,
        detail_enrichment: detailEnrichment.summary,
        checkpoint: {
          mode: skipPostUrls.size ? 'skip_known_post_urls' : 'initial_search',
          skipped_post_count: skipPostUrls.size,
          new_post_count: searchSamples.length,
        },
      },
    }),
  };
}

export function profileRecord(profileUrl, profile, samples) {
  const publicMetrics = Object.fromEntries(Object.entries(profile.metrics || {}).filter(([, value]) => text(value)));
  const accountId = text(profile.accountId, 120);
  const handle = text(profile.handle, 140) || accountId;
  const profileTags = Array.isArray(profile.profile_tags)
    ? [...new Set(profile.profile_tags.map((value) => text(value, 80)).filter(Boolean))].slice(0, 16)
    : [];
  const publicAudienceSignals = Array.isArray(profile.public_audience_signals)
    ? [...new Set(profile.public_audience_signals.map((value) => text(value, 120)).filter(Boolean))].slice(0, 8)
    : [];
  const visibleMetrics = [...new Set([
    ...(Array.isArray(profile.visible_metrics) ? profile.visible_metrics.map((value) => text(value, 120)) : []),
    ...Object.values(publicMetrics).map((value) => text(value, 120)),
  ].filter(Boolean))].slice(0, 16);
  const profileText = text(profile.profile_text, 5_000);
  const profileTitle = text(profile.profile_title, 180);
  const homepageUrl = text(profile.homepage_url, 1_200) || profileUrl;
  const profileFields = {
    nickname: text(profile.author, 120),
    ...(handle ? { handle, unique_id: handle } : {}),
    bio: text(profile.bio, 500),
    location: text(profile.location, 120),
    ...(typeof profile.verified === 'boolean' ? { verified: profile.verified } : {}),
    ...(text(profile.verified_label, 120) ? { verified_label: text(profile.verified_label, 120) } : {}),
    ...(text(profile.account_type, 100) ? { account_type: text(profile.account_type, 100) } : {}),
    avatar: scrubDouyinMediaUrl(profile.avatar_url),
    metrics: publicMetrics,
    visible_metrics: visibleMetrics,
    profile_tags: profileTags,
    public_audience_signals: publicAudienceSignals,
    ...(profileText ? { profile_text: profileText } : {}),
    ...(profileTitle ? { profile_title: profileTitle } : {}),
    homepage_url: homepageUrl,
    latest_samples: samples,
    content_summary: { visible_sample_count: samples.length, sampled_from_public_profile: true },
  };
  return {
    author: {
      nickname: text(profile.author, 120),
      ...(handle ? { unique_id: handle } : {}),
      ...(text(profile.location, 120) ? { location: text(profile.location, 120) } : {}),
      ...(typeof profile.verified === 'boolean' ? { verified: profile.verified } : {}),
    },
    observed_name: text(profile.author, 120),
    ...(handle ? { handle, unique_id: handle } : {}),
    author_profile: profileUrl,
    source_profile_url: profileUrl,
    homepage_url: homepageUrl,
    bio: text(profile.bio, 500),
    location: text(profile.location, 120),
    ...(typeof profile.verified === 'boolean' ? { verified: profile.verified } : {}),
    ...(text(profile.verified_label, 120) ? { verified_label: text(profile.verified_label, 120) } : {}),
    ...(text(profile.account_type, 100) ? { account_type: text(profile.account_type, 100) } : {}),
    avatar_url: scrubDouyinMediaUrl(profile.avatar_url),
    profile_tags: profileTags,
    public_audience_signals: publicAudienceSignals,
    visible_metrics: visibleMetrics,
    ...(profileText ? { profile_text: profileText } : {}),
    ...(profileTitle ? { profile_title: profileTitle } : {}),
    latest_samples: samples,
    profile: profileFields,
    content_summary: { visible_sample_count: samples.length, sampled_from_public_profile: true },
    public_data_scope: 'profile_and_visible_content',
    scraped_at: utcNow(),
  };
}

export function catalogCheckpointSamples(payload, profileUrl, sampleLimit = MAX_PROFILE_SAMPLES) {
  const records = Array.isArray(payload) ? payload : [payload];
  const canonicalProfileUrl = canonicalDouyinUrl(profileUrl);
  const record = records.find((candidate) => (
    canonicalDouyinUrl(candidate?.source_profile_url || candidate?.author_profile) === canonicalProfileUrl
  ));
  if (!record) throw new Error('Catalog checkpoint does not match the requested profile.');
  const samplesByUrl = new Map();
  for (const item of Array.isArray(record.latest_samples) ? record.latest_samples : []) {
    const sample = sampleFromCard(item);
    if (sample.note_url) samplesByUrl.set(sample.note_url, sample);
    if (samplesByUrl.size >= sampleLimit) break;
  }
  return [...samplesByUrl.values()];
}

async function readCatalogCheckpoint(inputFile, profileUrl, sampleLimit) {
  const payload = JSON.parse(await fs.readFile(inputFile, 'utf8'));
  return catalogCheckpointSamples(payload, profileUrl, sampleLimit);
}

async function collectProfile(page, args, initialReadiness = {}) {
  const profileUrl = canonicalDouyinUrl(page.url()) || args.profileUrl;
  const profile = await readVisibleProfile(page, args.expectedName);
  if (args.collectionPhase === 'profile') {
    const observation = profilePhaseObservation(profile);
    const record = profileRecord(profileUrl, profile, []);
    const records = record.author_profile && record.observed_name ? [record] : [];
    return {
      records,
      sourceUrl: profileUrl,
      status: collectionStatus({
        mode: 'profile', requestedLimit: args.profileSampleLimit, records,
        stopReason: observation.stopReason, sourceUrl: profileUrl,
        scrolls: 0, scrollBudget: 0, continuationRecommended: observation.continuationRecommended,
        coverage: {
          scope: 'profile_fields_only',
          completion: observation.completion,
          requested_limit: args.profileSampleLimit,
          returned_visible_sample_count: 0,
          continuation_recommended: observation.continuationRecommended,
        },
        extra: { collection_phase: 'profile', initial_profile_hydration: initialReadiness },
      }),
    };
  }
  const samplesByUrl = new Map();
  // This is a safety guard, not a conversion of the requested sample count
  // into a fixed number of scrolls. A profile with a stable rendered grid
  // stops through the idle rule below, even when its requested limit is 10k.
  const scrollBudget = MAX_PROFILE_SCROLLS;
  let stopReason = 'bounded_scan_limit';
  let scrolls = 0;
  let idleScrolls = 0;
  let lastScrollControlSucceeded = null;
  let catalogCheckpointReused = false;
  const progressSampleInterval = Math.max(25, Math.ceil(args.profileSampleLimit / 50));
  let lastProgressSampleCount = 0;
  let lastProgressScrolls = 0;
  const reportProfileProgress = (force = false) => {
    const visible = samplesByUrl.size;
    if (!force && visible < lastProgressSampleCount + progressSampleInterval && scrolls < lastProgressScrolls + 100) return;
    process.stderr.write(`PROFILE_PROGRESS scrolls=${scrolls}/${scrollBudget} visible=${visible} phase=grid idle=${idleScrolls}\n`);
    lastProgressSampleCount = visible;
    lastProgressScrolls = scrolls;
  };
  if (args.collectionPhase === 'detail' && args.catalogInputFile) {
    for (const sample of await readCatalogCheckpoint(args.catalogInputFile, profileUrl, args.profileSampleLimit)) {
      samplesByUrl.set(sample.note_url, sample);
    }
    stopReason = 'profile_page_exhausted';
    lastScrollControlSucceeded = true;
    catalogCheckpointReused = true;
  } else {
    for (let step = 0; step < scrollBudget; step += 1) {
      const access = await renderedAccessState(page);
      if (access === 'login_required' || access === 'verification_required') {
        stopReason = `platform_${access}`;
        break;
      }
      for (const item of await readVisibleProfileSamples(page, args.profileSampleLimit)) {
        const sample = sampleFromCard(item);
        if (sample.note_url) samplesByUrl.set(sample.note_url, sample);
      }
      reportProfileProgress();
      if (samplesByUrl.size >= args.profileSampleLimit) {
        stopReason = 'requested_limit_reached';
        break;
      }
      const sampleCountBeforeScroll = samplesByUrl.size;
      const beforeSurface = await visibleSurfaceFingerprint(page);
      await args.timing.wait();
      if (!await scrollVisibleSurface(page)) {
        lastScrollControlSucceeded = false;
        stopReason = 'scroll_control_unavailable';
        break;
      }
      lastScrollControlSucceeded = true;
      scrolls += 1;
      const afterSurface = await waitForVisibleContentMutation(page, beforeSurface, 500);
      for (const item of await readVisibleProfileSamples(page, args.profileSampleLimit)) {
        const sample = sampleFromCard(item);
        if (sample.note_url) samplesByUrl.set(sample.note_url, sample);
      }
      if (samplesByUrl.size >= args.profileSampleLimit) {
        stopReason = 'requested_limit_reached';
        break;
      }
      const madeProfileProgress = samplesByUrl.size > sampleCountBeforeScroll
        || profileSurfaceProgressed(beforeSurface, afterSurface);
      idleScrolls = madeProfileProgress ? 0 : idleScrolls + 1;
      reportProfileProgress();
      if (idleScrolls >= MAX_PROFILE_IDLE_SCROLLS) {
        // Five successful scrolls without a new canonical work URL or any
        // rendered grid mutation are the terminal evidence for this public
        // profile snapshot. Treating the same stable surface as retryable made
        // full-card jobs loop forever even after reaching the end of the grid.
        stopReason = profileIdleStopReason(lastScrollControlSucceeded);
        break;
      }
    }
  }
  if (!catalogCheckpointReused) {
    for (const item of await readVisibleProfileSamples(page, args.profileSampleLimit)) {
      const sample = sampleFromCard(item);
      if (sample.note_url) samplesByUrl.set(sample.note_url, sample);
    }
  }
  reportProfileProgress(true);
  const visibleSamples = [...samplesByUrl.values()].slice(0, args.profileSampleLimit);
  const detailEnrichment = args.collectionPhase === 'catalog'
    ? {
      samples: visibleSamples,
      summary: {
        requested: 0,
        attempted: 0,
        enriched: 0,
        skipped: visibleSamples.length,
        collection_phase: 'catalog',
      },
    }
    : await enrichVisibleVideoDetails(page, visibleSamples, args.detailSampleLimit, args.timing);
  const record = profileRecord(profileUrl, profile, detailEnrichment.samples);
  const records = record.author_profile && record.observed_name ? [record] : [];
  const coverage = profileCollectionCoverage({
    stopReason,
    requestedLimit: args.profileSampleLimit,
    returnedVisibleSampleCount: visibleSamples.length,
    lastScrollControlSucceeded,
  });
  const continuationRecommended = coverage.continuation_recommended;
  return {
    records,
    sourceUrl: profileUrl,
    status: collectionStatus({
      mode: 'profile', requestedLimit: args.profileSampleLimit, records, stopReason, sourceUrl: profileUrl,
      scrolls, scrollBudget, continuationRecommended, coverage, extra: {
        idle_scrolls: idleScrolls,
        last_scroll_control_succeeded: lastScrollControlSucceeded,
        profile_progress_signal: 'visible_content_links_or_surface_growth',
        content_sample_limit: args.profileSampleLimit,
        collection_phase: args.collectionPhase,
        catalog_checkpoint_reused: catalogCheckpointReused,
        catalog_checkpoint_sample_count: catalogCheckpointReused ? visibleSamples.length : 0,
        initial_profile_hydration: initialReadiness,
        detail_enrichment: detailEnrichment.summary,
      },
    }),
  };
}

async function writeJson(target, payload) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
}

function attachSearchLoadEvidence(collection, hydrationHistory) {
  return {
    ...collection,
    status: {
      ...collection.status,
      stop_evidence: {
        ...collection.status.stop_evidence,
        search_page_load_attempts: hydrationHistory.length,
        search_hydration_history: hydrationHistory,
      },
    },
  };
}

function errorCodeForStage(stage) {
  return {
    checkpoint_load: 'CHECKPOINT_READ_FAILED',
    playwright_load: 'PLAYWRIGHT_UNAVAILABLE',
    gateway_token: 'GATEWAY_TOKEN_UNAVAILABLE',
    relay_connect: 'RELAY_CONNECTION_FAILED',
    page_open: 'PLATFORM_PAGE_OPEN_FAILED',
    page_read: 'PUBLIC_PAGE_READ_FAILED',
    write_output: 'LOCAL_OUTPUT_WRITE_FAILED',
  }[stage] || 'DOUYIN_RELAY_COLLECTOR_FAILED';
}

async function readVisiblePostComments(page, maximum) {
  return page.evaluate((limit) => {
    const clean = (value, length = 0) => {
      const result = String(value || '').replace(/\s+/g, ' ').trim();
      return length ? result.slice(0, length) : result;
    };
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nodeMeta = (node) => [
      typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
      node?.getAttribute?.('data-e2e') || '',
      node?.getAttribute?.('aria-label') || '',
      node?.getAttribute?.('title') || '',
    ].join(' ').toLowerCase();
    const metricToken = (value) => {
      const compact = clean(value, 80).replace(/,/g, '').replace(/\s+/g, '');
      const match = compact.match(/^([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)$/i);
      return match ? match[1] : '';
    };
    const metric = (root, labels) => {
      const nodes = [root, ...Array.from(root.querySelectorAll('button, span, strong, em, b, i, [aria-label], [title], [data-e2e], [class]')).slice(0, 450)];
      for (const node of nodes) {
        if (!visible(node)) continue;
        const value = clean(`${node.innerText || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`, 160);
        const meta = nodeMeta(node);
        if (!labels.some((label) => value.toLowerCase().includes(label) || meta.includes(label))) continue;
        const after = value.match(/(?:\u70b9\u8d5e|\u8bc4\u8bba|\u56de\u590d|like|likes|comment|reply|digg)\s*[:\uff1a]?\s*([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)/i);
        const before = value.match(/([0-9]+(?:\.[0-9]+)?(?:[wk]|\u4e07|\u4ebf)?)\s*(?:\u70b9\u8d5e|\u8bc4\u8bba|\u56de\u590d|like|likes|comment|reply|digg)/i);
        const direct = metricToken(after?.[1] || before?.[1] || value);
        if (direct) return direct;
      }
      if (labels.includes('like') || labels.includes('likes') || labels.includes('digg')) {
        const unlabeledLike = root.querySelector('[class*=comment-item-stats-container] p, [data-e2e*=comment-item] p');
        const direct = metricToken(unlabeledLike?.innerText || unlabeledLike?.textContent || '');
        if (direct) return direct;
      }
      return '';
    };
    const itemSelector = [
      '[data-e2e*=comment-item]', '[data-e2e*=commentItem]', '[class*=comment-item]', '[class*=CommentItem]',
    ].join(',');
    const fallbackSelector = [
      '[data-e2e*=comment-content]', '[data-e2e*=commentContent]', '[class*=comment-content]', '[class*=CommentContent]',
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(itemSelector)).filter(visible);
    const nodes = (candidates.length ? candidates : Array.from(document.querySelectorAll(fallbackSelector)).filter(visible))
      .filter((node, index, all) => all.findIndex((candidate) => candidate === node || candidate.contains(node)) === index);
    const timePattern = /^(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d+(?:\u5206\u949f|\u5c0f\u65f6|\u5929|\u5468|\u6708|\u5e74)\u524d|\u6628\u5929|\u524d\u5929)(?:\u00b7.*)?$/;
    const commentBodyNode = (root) => {
      const explicit = root.querySelector('[data-e2e*=comment-content], [data-e2e*=commentContent], [class*=comment-content], [class*=CommentContent]');
      if (explicit) return explicit;
      const timeLeaf = Array.from(root.querySelectorAll('*')).filter(visible).find((node) => {
        const value = clean(node.innerText || node.textContent, 100);
        if (!timePattern.test(value)) return false;
        const previous = node.parentElement?.previousElementSibling;
        if (!previous) return false;
        return !/(?:comment-item-stats|stats|reply|share)/i.test(nodeMeta(previous));
      });
      return timeLeaf?.parentElement?.previousElementSibling || null;
    };
    const output = [];
    const seen = new Set();
    for (const root of nodes) {
      const bodyNode = commentBodyNode(root);
      const body = clean(bodyNode?.innerText || bodyNode?.textContent || root.innerText, 1_200);
      const userLinks = Array.from(root.querySelectorAll('a[href]')).filter((link) => /\/user\//i.test(link.getAttribute('href') || ''));
      const userLink = userLinks.find((link) => clean(link.innerText || link.textContent, 120)) || userLinks[0];
      const author = clean(
        root.querySelector('[data-e2e*=user-name], [data-e2e*=nickname], [class*=nickname], [class*=Nickname], [class*=user-name], [class*=UserName]')?.textContent
          || userLink?.innerText
          || userLink?.textContent,
        120,
      );
      if (!body) continue;
      const identity = `${author}|${body}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const timeNode = root.querySelector('time, [data-e2e*=time], [class*=time], [class*=Time]');
      const fullText = clean(root.innerText, 1_500);
      const commentId = clean(root.getAttribute('data-comment-id') || root.getAttribute('data-cid') || root.id || '', 160);
      const authorProfile = userLink ? (() => {
        try {
          const url = new URL(userLink.href || '', location.href);
          return /^https:$/.test(url.protocol) && /(?:^|\.)douyin\.com$/i.test(url.hostname)
            ? url.href.split('#')[0]
            : '';
        } catch {
          return '';
        }
      })() : '';
      output.push({
        comment_id: commentId,
        author_name: author,
        author_profile: authorProfile,
        text: body,
        like_count: metric(root, ['\u70b9\u8d5e', 'like', 'likes', 'digg']),
        reply_count: metric(root, ['\u56de\u590d', 'reply']),
        published_at_text: clean(timeNode?.textContent || (fullText.match(/(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d+(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d|\u6628\u5929|\u524d\u5929)/) || [])[0], 60),
        is_hot: /(?:\u70ed\u8bc4|\u7f6e\u9876|pinned|hot)/i.test(fullText),
      });
      if (output.length >= limit) break;
    }
    return output;
  }, Math.max(1, Math.min(10, Number(maximum) || 10)));
}

async function clickVisibleCommentTrigger(page) {
  try {
    return await page.evaluate(() => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const target = Array.from(document.querySelectorAll('button, [role=button], [data-e2e]'))
        .filter(visible)
        .find((node) => /(?:\u8bc4\u8bba|comment)/i.test(`${node.innerText || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-e2e') || ''}`));
      if (!target) return false;
      target.click();
      return true;
    });
  } catch {
    return false;
  }
}

async function scrollVisibleCommentSurface(page) {
  try {
    await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('[class*=comment], [class*=Comment], [data-e2e*=comment], [data-e2e*=Comment]'),
        document.scrollingElement,
      ].filter((node) => node && node.scrollHeight > node.clientHeight + 20)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
      const target = candidates[0] || document.scrollingElement;
      target?.scrollBy?.({ top: Math.max(420, Math.floor(window.innerHeight * 0.65)), left: 0, behavior: 'instant' });
    });
    return true;
  } catch {
    return false;
  }
}

async function collectComments(page, args) {
  const sourceUrl = canonicalDouyinContentUrl(page.url()) || args.postUrl;
  let comments = [];
  let triggerClicked = false;
  let scrolls = 0;
  // Douyin renders the comment list asynchronously after the detail surface
  // is ready; keep the automatic search enrichment alive until that list has
  // had time to mount before classifying it as unavailable.
  const attempts = 16;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!triggerClicked) triggerClicked = await clickVisibleCommentTrigger(page);
    await page.waitForTimeout(900);
    comments = await readVisiblePostComments(page, args.limit);
    if (comments.length >= args.limit) break;
    await args.timing.wait();
    if (!await scrollVisibleCommentSurface(page)) break;
    scrolls += 1;
    await page.waitForTimeout(450);
  }
  const stopReason = comments.length >= args.limit
    ? 'requested_limit_reached'
    : comments.length ? 'comments_exhausted' : 'comments_unavailable_retryable';
  const continuationRecommended = stopReason.endsWith('retryable');
  return {
    records: comments,
    sourceUrl,
    status: {
      schema_version: 2,
      mode: 'comments',
      requested_limit: args.limit,
      records_collected: comments.length,
      unique_profiles: new Set(comments.map((comment) => comment.author_profile).filter(Boolean)).size,
      cumulative_public_page_cards: comments.length,
      cumulative_unique_accounts: new Set(comments.map((comment) => comment.author_name).filter(Boolean)).size,
      scrolls_attempted: scrolls,
      scroll_budget: attempts,
      stop_reason: stopReason,
      scroll_progress: { scrolls_attempted: scrolls, scroll_budget: attempts },
      stop_evidence: stopEvidence(stopReason, continuationRecommended, {
        comment_surface_trigger_clicked: triggerClicked,
        comment_read_attempts: attempts,
      }),
      public_data_scope: 'visible_public_comments',
      source_post_url: sourceUrl,
      completed_at: utcNow(),
    },
  };
}

function blockedStatus(args, mode, state, sourceUrl) {
  const stopReason = `platform_${state}`;
  return collectionStatus({
    mode,
    requestedLimit: mode === 'profile' ? args.profileSampleLimit : args.limit,
    records: [],
    stopReason,
    sourceUrl,
    scrolls: 0,
    scrollBudget: 0,
    continuationRecommended: false,
    extra: {
      observed_access_state: state,
      random_interval: args.timing?.snapshot?.() || args.randomInterval || null,
    },
  });
}

function attachCollectionTimingEvidence(collection, args) {
  return {
    ...collection,
    status: {
      ...collection.status,
      random_interval: args.timing?.snapshot?.() || args.randomInterval || null,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    process.stdout.write(`${JSON.stringify({ event: 'collector_failed', code: 'INVALID_INPUT' })}\n`);
    return EXIT_INVALID_INPUT;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_SUCCESS;
  }

  const mode = args.postUrl ? 'comments' : args.profileUrl ? 'profile' : 'search';
  const outputPath = path.join(args.outputDir, mode === 'comments' ? 'douyin_comments_latest.json' : 'douyin_creators_latest.json');
  const statusPath = path.join(args.outputDir, mode === 'comments' ? 'douyin_comments_status.json' : 'douyin_collection_status.json');
  if (mode === 'search' && args.checkpointFile) {
    try {
      args.checkpoint = await readSearchCheckpoint(args.checkpointFile);
      args.skipPostUrls = args.checkpoint.skipPostUrls;
    } catch {
      process.stdout.write(`${JSON.stringify({ event: 'collector_failed', code: 'CHECKPOINT_READ_FAILED' })}\n`);
      return EXIT_INVALID_INPUT;
    }
  } else {
    args.checkpoint = { loaded: false, skipPostUrls: [], previousCount: 0 };
    args.skipPostUrls = [];
  }
  let browser = null;
  let page = null;
  let stage = 'playwright_load';
  try {
    const playwright = await loadPlaywright(args.playwrightModulePath);
    stage = 'gateway_token';
    const token = await getGatewayToken();
    stage = 'relay_connect';
    browser = await attachRelay(playwright, args.relayPort, token);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Relay context unavailable.');
    stage = 'page_open';
    page = await context.newPage();
    const targetUrl = args.postUrl || args.profileUrl || searchUrl(args);
    await openVisiblePage(page, targetUrl);
    // Readiness probes start immediately and retain bounded polling for slow renders.
    let readiness = mode === 'search'
      ? await waitForVisibleSearchResults(page)
      : mode === 'profile'
        ? await waitForVisibleProfileSamples(
        page,
        args.collectionPhase === 'profile' ? PROFILE_HYDRATION_ATTEMPTS : PROFILE_EARLY_HYDRATION_ATTEMPTS,
        )
        : { access: await renderedAccessState(page), attempts: 1 };
    let access = readiness.access;
    if (access === 'login_required' || access === 'verification_required') {
      const sourceUrl = mode === 'profile'
        ? canonicalDouyinUrl(page.url()) || args.profileUrl
        : mode === 'comments'
          ? canonicalDouyinContentUrl(page.url()) || args.postUrl
          : canonicalDouyinUrl(page.url(), { retainSearch: true }) || targetUrl;
      await writeJson(statusPath, blockedStatus(args, mode, access, sourceUrl));
      process.stdout.write(`${JSON.stringify({ event: 'collector_blocked', code: access.toUpperCase() })}\n`);
      return access === 'login_required' ? EXIT_LOGIN_REQUIRED : EXIT_VERIFICATION_REQUIRED;
    }
    stage = 'page_read';
    let collection = mode === 'profile'
      ? await collectProfile(page, args, readiness)
      : mode === 'comments'
        ? await collectComments(page, args)
        : await collectSearch(page, args, readiness);
    const hydrationHistory = mode === 'search' ? [readiness] : [];
    for (let loadAttempt = 1; mode === 'search'
      && loadAttempt < MAX_SEARCH_PAGE_LOADS
      && shouldRetrySearchPageLoad(collection); loadAttempt += 1) {
      await page.waitForTimeout(SEARCH_RELOAD_DELAY_MS);
      stage = 'page_open';
      await openVisiblePage(page, targetUrl);
      readiness = await waitForVisibleSearchResults(page);
      hydrationHistory.push(readiness);
      access = readiness.access;
      if (access === 'login_required' || access === 'verification_required') {
        const sourceUrl = canonicalDouyinUrl(page.url(), { retainSearch: true }) || targetUrl;
        await writeJson(statusPath, blockedStatus(args, mode, access, sourceUrl));
        process.stdout.write(`${JSON.stringify({ event: 'collector_blocked', code: access.toUpperCase() })}\n`);
        return access === 'login_required' ? EXIT_LOGIN_REQUIRED : EXIT_VERIFICATION_REQUIRED;
      }
      stage = 'page_read';
      collection = await collectSearch(page, args, readiness);
    }
    if (mode === 'search') collection = attachSearchLoadEvidence(collection, hydrationHistory);
    collection = attachCollectionTimingEvidence(collection, args);
    stage = 'write_output';
    await writeJson(outputPath, collection.records);
    await writeJson(statusPath, collection.status);
    process.stdout.write(`${JSON.stringify({
      event: 'collector_complete',
      mode,
      records_collected: collection.records.length,
      stop_reason: collection.status.stop_reason,
    })}\n`);
    return collection.records.length ? EXIT_SUCCESS : EXIT_EMPTY;
  } catch (error) {
    const errorCode = errorCodeForStage(stage);
    const errorMessage = text(error?.message || String(error), 500);
    try {
      await writeJson(statusPath, {
        schema_version: 1,
        mode,
        requested_limit: mode === 'profile' ? args.profileSampleLimit : args.limit,
        records_collected: 0,
        unique_profiles: 0,
        stop_reason: errorCode.toLowerCase(),
        stop_evidence: {
          classification: 'retryable_collection_gap',
          continuation_recommended: true,
          error_code: errorCode,
          error_message: errorMessage || null,
        },
        random_interval: args.timing?.snapshot?.() || args.randomInterval || null,
        public_data_scope: mode === 'profile'
          ? 'profile_and_visible_content'
          : mode === 'comments' ? 'visible_public_comments' : 'visible_public_search_cards',
        completed_at: utcNow(),
      });
    } catch {
      // A filesystem failure is reported only through the stable failure code.
    }
    process.stdout.write(`${JSON.stringify({ event: 'collector_failed', code: errorCode, message: errorMessage || null })}\n`);
    return EXIT_RELAY_ERROR;
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

const launchedAsScript = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (launchedAsScript) process.exitCode = await main();
