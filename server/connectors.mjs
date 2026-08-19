import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, publicPlatformConfig, relayPortForPlatform } from './config.mjs';
import { relaySessionStateFile } from './relay-session-state.mjs';
import { normalizeRandomInterval } from './collection-timing.mjs';

const RELAY_TIMEOUT_MS = 12_000;
// CDP attachment is allowed up to eight seconds by the preflight script.
// Leave a small process-start margin so a healthy persistent profile is not
// misreported as logged out while the Relay is still attaching.
const RELAY_HEALTH_TIMEOUT_MS = 12_000;
const PARTNER_TIMEOUT_MS = 90_000;
const OFFICIAL_API_TIMEOUT_MS = 30_000;
// Discovery now persists small route checkpoints, but a route can still carry
// rich visible-card metadata. Keep the transport bounded without truncating a
// legitimate high-volume public result shard.
const MAX_REMOTE_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_COLLECTOR_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_COLLECTOR_METADATA_BYTES = 256 * 1024;
const MAX_PROCESS_OUTPUT_CHARS = 128 * 1024;
const DOUYIN_VIDEO_SEARCH_URL = 'https://open.douyin.com/dy_open_api/v2/search/video/';
const DOUYIN_CLIENT_TOKEN_URL = 'https://open.douyin.com/oauth/client_token/';

const douyinTokenCache = { accessToken: '', expiresAt: 0, pending: null };

// Public health endpoints must remain fresh. This cache is used only by the
// collector path after a successful Relay check. The collector still checks
// the rendered page and invalidates the entry on every process failure.
export function createRelayPreflightCache({ ttlMs = 0, now = () => Date.now() } = {}) {
  const ttl = Math.max(0, Number.parseInt(ttlMs, 10) || 0);
  const entries = new Map();

  return {
    get(platformId) {
      if (!ttl) return null;
      const entry = entries.get(platformId);
      if (!entry || entry.expiresAt <= now()) {
        entries.delete(platformId);
        return null;
      }
      return { ...entry.health };
    },
    remember(platformId, health) {
      if (!ttl || health?.status !== 'relay_connected') {
        entries.delete(platformId);
        return;
      }
      entries.set(platformId, {
        expiresAt: now() + ttl,
        health: { ...health },
      });
    },
    invalidate(platformId) {
      entries.delete(platformId);
    },
  };
}

const relayPreflightCache = createRelayPreflightCache({ ttlMs: config.relay.preflightCacheMs });
let relayCollectorTail = Promise.resolve();

async function withRelayNavigationOwnership(operation) {
  const previous = relayCollectorTail;
  let release;
  relayCollectorTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

export class ConnectorError extends Error {
  constructor(code, message, action = '') {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.action = action;
  }
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function runProcess(command, args, { timeoutMs, onLine, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env });
    const lines = [];
    let stdout = '';
    let stderr = '';
    let timer;
    let timedOut = false;
    let settled = false;
    const lineBuffers = { stdout: '', stderr: '' };
    const emitLine = (line, target) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      lines.push(trimmed);
      if (lines.length > 100) lines.shift();
      onLine?.(trimmed, target);
      onProgress?.(trimmed, target);
    };
    const flushLines = () => {
      for (const target of ['stdout', 'stderr']) {
        if (lineBuffers[target]) emitLine(lineBuffers[target], target);
        lineBuffers[target] = '';
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const capture = (chunk, target) => {
      const text = chunk.toString();
      if (target === 'stdout') stdout = `${stdout}${text}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
      else stderr = `${stderr}${text}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
      const completeLines = `${lineBuffers[target]}${text}`.split(/\r?\n/);
      lineBuffers[target] = completeLines.pop() || '';
      completeLines.forEach((line) => emitLine(line, target));
    };
    child.stdout?.on('data', (chunk) => capture(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => capture(chunk, 'stderr'));
    child.once('error', (error) => {
      fail(error);
    });
    child.once('exit', (code, signal) => {
      flushLines();
      finish({ code: code ?? -1, signal, stdout, stderr, lines, timedOut });
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        finish({ code: -1, signal: 'SIGTERM', stdout, stderr, lines, timedOut: true });
      }, timeoutMs);
    }
  });
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // The preflight script can print diagnostic lines before its JSON result.
    }
  }
  return null;
}

async function relayPreflight(platformId) {
  const relayPort = relayPortForPlatform(platformId);
  if (!await probePort(relayPort)) {
    return { reachable: false, pageCount: 0, platformTabs: 0, reason: '浏览器 Relay 未附着。' };
  }
  if (!await commandExists(config.relay.node)) {
    return { reachable: false, pageCount: 0, platformTabs: 0, reason: `未找到 ${config.relay.node}。` };
  }
  try {
    const args = [
      config.relay.preflightScript,
      '--relay-port', String(relayPort),
      '--platform', platformId,
      '--state-file', relaySessionStateFile(config.relay.sessionStateDir, platformId),
    ];
    if (config.relay.playwrightModulePath) {
      args.push('--playwright-module-path', config.relay.playwrightModulePath);
    }
    // CDP can briefly reject an attachment while a relayed tab is settling.
    // Retry only that known transient condition; login and verification states
    // remain visible to the user and are never retried or bypassed here.
    let payload = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runProcess(config.relay.node, args, { timeoutMs: RELAY_HEALTH_TIMEOUT_MS });
      payload = lastJsonLine(result.stdout);
      if (payload?.reachable || payload?.error_code !== 'RELAY_CONNECTION_FAILED' || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (!payload?.reachable) {
      return { reachable: false, pageCount: 0, platformTabs: 0, reason: payload?.error || 'Relay 预检失败。' };
    }
    return {
      reachable: true,
      pageCount: payload.page_count || 0,
      platformTabs: payload.platform_tab_count || 0,
      sessionState: payload.platform_session_state || 'not_checked',
      sessionStatePersisted: Boolean(payload.session_state_persisted),
      reason: '',
    };
  } catch {
    return { reachable: false, pageCount: 0, platformTabs: 0, reason: 'Relay preflight process could not start.' };
  }
}

function relayAttachAction(platform) {
  return `启动 Browser Relay，并在已登录的浏览器 profile 中打开 ${platform.label} 页面后重试。`;
}

function relayAction(platform) {
  return `在当前附着的浏览器 profile 中完成 ${platform.label} 登录或平台验证后重试。`;
}

function officialDouyinAction() {
  return '检查 .env 中的 DOUYIN_CLIENT_KEY、DOUYIN_CLIENT_SECRET、DOUYIN_DEVICE_ID 与已获批的视频搜索权限。';
}

export async function getConnectorHealth(platformId) {
  const platform = config.platforms[platformId];
  if (!platform) throw new ConnectorError('UNKNOWN_PLATFORM', '未识别的平台。');
  const base = publicPlatformConfig(platformId);
  if (platform.mode === 'partner_http') {
    if (!platform.partnerUrl) {
      return { ...base, status: 'unconfigured', detail: '未填写合作方数据接口地址。', action: '在 .env 配置合作方 URL 和令牌。' };
    }
    return { ...base, status: 'ready', detail: '合作方 HTTP 连接器已配置。', action: '' };
  }
  if (platformId === 'douyin' && platform.mode === 'official_api') {
    if (!platform.clientKey || !platform.clientSecret || !platform.deviceId) {
      return { ...base, status: 'unconfigured', detail: '抖音官方 API 缺少应用凭据或 device_id。', action: officialDouyinAction() };
    }
    return { ...base, status: 'ready', detail: '抖音官方视频搜索已配置，运行时会校验权限。', action: '' };
  }
  if (platform.mode !== 'browser_relay') {
    return { ...base, status: 'unconfigured', detail: `不支持的连接器模式：${platform.mode}`, action: '使用 browser_relay、official_api（仅抖音）或 partner_http。' };
  }
  try {
    await fs.access(platform.relayScript);
  } catch {
    return { ...base, status: 'unconfigured', detail: '本地采集脚本不存在。', action: `检查 ${platform.relayScript}` };
  }
  const relay = await relayPreflight(platformId);
  if (!relay.reachable) {
    return { ...base, status: 'auth_required', detail: relay.reason, action: relayAttachAction(platform), pageCount: relay.pageCount, platformTabs: relay.platformTabs };
  }
  return {
    ...base,
    status: 'relay_connected',
    detail: relay.platformTabs > 0
      ? '浏览器 Relay 已附着到平台页面；登录与页面可采集状态将在任务中验证。'
      : '浏览器 Relay 已连接；采集器会使用临时标签页验证登录状态。',
    action: relay.platformTabs > 0
      ? '启动一次真实采集，验证当前会话的登录与页面可读取状态。'
      : relayAction(platform),
    pageCount: relay.pageCount,
    platformTabs: relay.platformTabs,
    sessionState: relay.sessionState || 'not_checked',
    sessionStatePersisted: Boolean(relay.sessionStatePersisted),
  };
}

async function assertRelay(platformId) {
  const health = relayPreflightCache.get(platformId) || await getConnectorHealth(platformId);
  if (health.status === 'unconfigured') {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', health.detail, health.action);
  }
  if (!['ready', 'relay_connected'].includes(health.status)) {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError('RELAY_NOT_READY', health.detail, health.action);
  }
  relayPreflightCache.remember(platformId, health);
  return { platform: config.platforms[platformId], health };
}

function validTargetUrl(platformId, value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const domains = platformId === 'xiaohongshu'
      ? ['xiaohongshu.com']
      : platformId === 'douyin'
        ? ['douyin.com', 'iesdouyin.com']
        : ['bilibili.com'];
    const validHost = domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    return url.protocol === 'https:' && validHost ? url.toString() : '';
  } catch {
    return '';
  }
}

function directTargetOrThrow(platformId, target) {
  const sourceUrl = validTargetUrl(platformId, target?.sourceUrl || '');
  if (!sourceUrl) {
    throw new ConnectorError('TARGET_SOURCE_REQUIRED', '核验需要候选账号的原始平台资料链接。', '回到候选列表，选择带有来源链接的账号后重新核验。');
  }
  return sourceUrl;
}

function xiaohongshuSearchUrl(query) {
  const url = new URL('https://www.xiaohongshu.com/search_result/');
  url.searchParams.set('keyword', query);
  url.searchParams.set('source', 'web_note_detail_r10');
  url.searchParams.set('type', '51');
  return url.toString();
}

function encodeSearchQuery(value) {
  return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function buildDouyinSearchUrl(searchUrlTemplate, query) {
  return String(searchUrlTemplate || '').replaceAll('{query}', encodeSearchQuery(query));
}

export function buildBilibiliSearchUrl(searchUrlTemplate, query) {
  return String(searchUrlTemplate || '').replaceAll('{query}', encodeSearchQuery(query));
}

function collectorOutcome(records) {
  return records.length ? 'succeeded' : 'completed_empty';
}

async function readCollectorOutput({ outputPath, result, platformLabel }) {
  if (result.timedOut) {
    throw new ConnectorError('COLLECTOR_TIMEOUT', `${platformLabel} 采集器超时。`, '检查浏览器会话与网络后重试。');
  }
  try {
    const metadata = await fs.stat(outputPath);
    if (metadata.size > MAX_COLLECTOR_OUTPUT_BYTES) {
      throw new ConnectorError('COLLECTOR_OUTPUT_TOO_LARGE', `${platformLabel} collector output exceeds the local size limit.`, 'Reduce the collection limit and run again.');
    }
    const records = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    if (!Array.isArray(records)) {
      throw new ConnectorError('OUTPUT_SCHEMA_ERROR', `${platformLabel} 采集器输出不是记录数组。`, '检查采集器日志后重试。');
    }
    return records;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (result.code === 1) return [];
    throw new ConnectorError('OUTPUT_MISSING', `${platformLabel} 采集器没有生成可读取的数据文件。`, '检查采集器日志后重试。');
  }
}

export async function readCollectorMetadata({ outputDir, metadataFile, platformLabel, required = false }) {
  if (!metadataFile) return null;
  const metadataPath = path.join(outputDir, metadataFile);
  let metadata;
  try {
    metadata = await fs.stat(metadataPath);
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw new ConnectorError(
      'COLLECTOR_METADATA_MISSING',
      `${platformLabel} collector did not produce ${metadataFile}.`,
      'Check the collector logs and run the collection again.',
    );
  }
  if (metadata.size > MAX_COLLECTOR_METADATA_BYTES) {
    throw new ConnectorError(
      'COLLECTOR_METADATA_TOO_LARGE',
      `${platformLabel} collector metadata exceeds the local size limit.`,
      'Reduce the collection limit and run again.',
    );
  }
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Metadata must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(
      'COLLECTOR_METADATA_INVALID',
      `${platformLabel} collector metadata is not valid JSON.`,
      'Check the collector logs and run the collection again.',
    );
  }
}

function observedSearchUrl(platformId, collectionMeta, fallbackUrl) {
  const observed = typeof collectionMeta?.source_search_url === 'string'
    ? validTargetUrl(platformId, collectionMeta.source_search_url)
    : '';
  return observed || fallbackUrl;
}

function parseCollectorProgress(line) {
  const match = String(line || '').match(/^(SEARCH_PROGRESS|DETAIL_PROGRESS)\s+(.+)$/);
  if (!match) return null;
  const fields = Object.fromEntries(match[2].split(/\s+/)
    .map((part) => part.split('='))
    .filter(([key, value]) => key && value !== undefined));
  const numberValue = (key) => {
    const value = Number(fields[key]);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  };
  return {
    phase: match[1] === 'DETAIL_PROGRESS' ? 'detail' : (fields.phase || 'search'),
    scrolls: numberValue('scrolls'),
    scrollBudget: numberValue('scroll_budget'),
    visible: numberValue('visible'),
    newPosts: numberValue('new_posts'),
    limit: numberValue('limit'),
    attempted: numberValue('attempted'),
    total: numberValue('total'),
    enriched: numberValue('enriched'),
    commentsAttempted: numberValue('comments_attempted'),
    commentsCollected: numberValue('comments_collected'),
  };
}

async function runBrowserCollectorUnserialized(platformId, input, { outputFile, metadataFile, timeoutMs, buildArgs }) {
  const { platform, health } = await assertRelay(platformId);
  const targetUrl = input.mode === 'verify' || input.mode === 'content' || input.mode === 'comments'
    ? directTargetOrThrow(platformId, input.target)
    : '';
  const nodeCollector = /\.(?:mjs|cjs|js)$/i.test(platform.relayScript);
  const args = buildArgs(platform, targetUrl);
  if (nodeCollector && config.relay.playwrightModulePath && !args.includes('--playwright-module-path')) {
    args.push('--playwright-module-path', config.relay.playwrightModulePath);
  }
  let result;
  try {
    result = await runProcess(nodeCollector ? config.relay.node : config.relay.python, args, {
      timeoutMs,
      onLine: (line, stream) => input.emit?.({ level: stream === 'stderr' ? 'warn' : 'info', message: line.slice(0, 320) }),
      onProgress: (line) => {
        const progress = parseCollectorProgress(line);
        if (progress) input.onProgress?.(progress);
      },
    });
  } catch (error) {
    relayPreflightCache.invalidate(platformId);
    throw error;
  }
  if (result.timedOut) {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError('COLLECTOR_TIMEOUT', `${platform.label} 采集器超时。`, '检查浏览器会话与网络后重试。');
  }
  if (result.code === 2) {
    relayPreflightCache.invalidate(platformId);
    const output = `${result.stdout}\n${result.stderr}`;
    if (/unrecognized arguments|usage:/i.test(output)) {
      throw new ConnectorError('COLLECTOR_ARGUMENT_ERROR', `${platform.label} collector does not support the requested mode.`, 'Check the configured local collector script and its supported arguments.');
    }
    throw new ConnectorError('LOGIN_REQUIRED', `${platform.label} 会话要求登录。`, relayAction(platform));
  }
  if (result.code === 4) {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError('PLATFORM_VERIFICATION_REQUIRED', `${platform.label} 页面要求完成平台验证后才能继续读取。`, relayAction(platform));
  }
  if (result.code === 3 && lastJsonLine(result.stdout)?.code === 'RELAY_CONNECTION_FAILED') {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError(
      'RELAY_NOT_READY',
      `${platform.label} Browser Relay connection was interrupted before collection started.`,
      relayAttachAction(platform),
    );
  }
  if (result.code !== 0 && result.code !== 1) {
    relayPreflightCache.invalidate(platformId);
    throw new ConnectorError('COLLECTOR_FAILED', result.lines.at(-1) || `${platform.label} 采集器异常退出。`, '检查浏览器会话与采集器日志后重试。');
  }
  const collectedRecords = await readCollectorOutput({
    outputPath: path.join(input.outputDir, outputFile),
    result,
    platformLabel: platform.label,
  });
  const collectionMeta = await readCollectorMetadata({
    outputDir: input.outputDir,
    metadataFile,
    platformLabel: platform.label,
    required: input.mode === 'discover',
  });
  const records = collectedRecords.slice(0, Math.max(1, input.limit));
  // The collector just completed the stronger rendered-page validation. Keep
  // the positive preflight warm for the next serialized creator task.
  relayPreflightCache.remember(platformId, health);
  return {
    records,
    source: 'browser_relay',
    sourceUrl: targetUrl,
    collectionMeta,
    outcome: collectorOutcome(records),
    truncated: collectedRecords.length > records.length,
  };
}

async function runBrowserCollector(platformId, input, options) {
  return withRelayNavigationOwnership(
    () => runBrowserCollectorUnserialized(platformId, input, options),
  );
}

async function collectXiaohongshu(input) {
  const searchUrl = xiaohongshuSearchUrl(input.query);
  const result = await runBrowserCollector('xiaohongshu', input, {
    outputFile: 'xiaohongshu_notes_latest.json',
    metadataFile: 'xiaohongshu_collection_summary.json',
    timeoutMs: config.collection.browserRelayCollectionTimeoutMs,
    buildArgs: (platform, targetUrl) => {
      const args = [
        platform.relayScript,
        '--relay-port', String(relayPortForPlatform('xiaohongshu')),
        '--limit', String(input.limit),
        '--output-dir', input.outputDir,
      ];
      if (targetUrl) {
        args.push('--profile-url', targetUrl, '--expected-name', input.target?.name || '');
        if (Number.isFinite(input.contentLimit)) args.push('--profile-sample-limit', String(input.contentLimit));
      }
      else args.push('--search-url', searchUrl);
      return args;
    },
  });
  return { ...result, sourceUrl: result.sourceUrl || searchUrl };
}

function appendDouyinCollectionTiming(args, input) {
  const requested = input.randomInterval === undefined
    ? { minMs: config.collection.randomIntervalMinMs, maxMs: config.collection.randomIntervalMaxMs }
    : input.randomInterval;
  const interval = normalizeRandomInterval(requested, {
    defaultMinMs: config.collection.randomIntervalMinMs,
    defaultMaxMs: config.collection.randomIntervalMaxMs,
  });
  args.push('--min-interval-ms', String(interval.minMs), '--max-interval-ms', String(interval.maxMs));
  return args;
}

async function collectDouyin(input) {
  const commentsMode = input.mode === 'comments';
  const searchUrlTemplate = input.searchUrlTemplate || config.platforms.douyin.searchUrlTemplate;
  const searchUrl = commentsMode ? '' : buildDouyinSearchUrl(searchUrlTemplate, input.query);
  const result = await runBrowserCollector('douyin', input, {
    outputFile: commentsMode ? 'douyin_comments_latest.json' : 'douyin_creators_latest.json',
    metadataFile: commentsMode ? 'douyin_comments_status.json' : 'douyin_collection_status.json',
    timeoutMs: config.collection.browserRelayCollectionTimeoutMs,
    buildArgs: (platform, targetUrl) => {
      const args = [
        platform.relayScript,
        '--relay-port', String(relayPortForPlatform('douyin')),
        '--limit', String(input.limit),
        '--search-url-template', searchUrlTemplate,
        '--output-dir', input.outputDir,
      ];
      appendDouyinCollectionTiming(args, input);
      if (input.checkpointFile) args.push('--checkpoint-file', input.checkpointFile);
      if (commentsMode) {
        args.push('--post-url', targetUrl);
      } else if (targetUrl) {
        args.push('--profile-url', targetUrl, '--expected-name', input.target?.name || '');
        if (Number.isFinite(input.contentLimit)) args.push('--profile-sample-limit', String(input.contentLimit));
        if (input.collectionPhase) args.push('--collection-phase', input.collectionPhase);
        if (input.catalogInputFile) args.push('--catalog-input-file', input.catalogInputFile);
      }
      else args.push('--query', input.query);
      return args;
    },
  });
  return {
    ...result,
    sourceUrl: result.sourceUrl || (commentsMode ? input.target?.sourceUrl || '' : observedSearchUrl('douyin', result.collectionMeta, searchUrl)),
  };
}

async function collectBilibili(input) {
  const searchUrl = buildBilibiliSearchUrl(config.platforms.bilibili.searchUrlTemplate, input.query);
  const result = await runBrowserCollector('bilibili', input, {
    outputFile: 'bilibili_creators_latest.json',
    metadataFile: 'bilibili_collection_status.json',
    timeoutMs: config.collection.browserRelayCollectionTimeoutMs,
    buildArgs: (platform, targetUrl) => {
      const args = [
        platform.relayScript,
        '--relay-port', String(relayPortForPlatform('bilibili')),
        '--limit', String(input.limit),
        '--search-url-template', platform.searchUrlTemplate,
        '--output-dir', input.outputDir,
      ];
      if (targetUrl) {
        args.push('--profile-url', targetUrl, '--expected-name', input.target?.name || '');
        if (Number.isFinite(input.contentLimit)) args.push('--profile-sample-limit', String(input.contentLimit));
      } else {
        args.push('--query', input.query);
      }
      return args;
    },
  });
  return {
    ...result,
    sourceUrl: result.sourceUrl || observedSearchUrl('bilibili', result.collectionMeta, searchUrl),
  };
}

async function responseJson(response, sourceLabel) {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_RESPONSE_BYTES) {
    throw new ConnectorError('REMOTE_PAYLOAD_TOO_LARGE', `${sourceLabel} response exceeds the local size limit.`, 'Reduce the requested limit or inspect the provider response.');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ConnectorError('REMOTE_PAYLOAD_TOO_LARGE', `${sourceLabel} response exceeds the local size limit.`, 'Reduce the requested limit or inspect the provider response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getDouyinClientToken() {
  if (douyinTokenCache.accessToken && douyinTokenCache.expiresAt > Date.now() + 60_000) return douyinTokenCache.accessToken;
  if (douyinTokenCache.pending) return douyinTokenCache.pending;
  douyinTokenCache.pending = (async () => {
    const platform = config.platforms.douyin;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OFFICIAL_API_TIMEOUT_MS);
    try {
      const response = await fetch(DOUYIN_CLIENT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credential', client_key: platform.clientKey, client_secret: platform.clientSecret }),
        signal: controller.signal,
      });
      const payload = await responseJson(response, 'Douyin token service');
      if (!response.ok || !payload || typeof payload !== 'object') {
        throw new ConnectorError('DOUYIN_TOKEN_FAILED', '抖音官方 API 未接受当前应用凭据。', officialDouyinAction());
      }
      const data = payload.data || payload;
      const accessToken = data.access_token || data.accessToken || '';
      if (!accessToken) {
        throw new ConnectorError('DOUYIN_TOKEN_FAILED', '抖音官方 API 未返回可用的 client token。', officialDouyinAction());
      }
      const expiresIn = Number.parseInt(data.expires_in || data.expiresIn, 10);
      douyinTokenCache.accessToken = accessToken;
      douyinTokenCache.expiresAt = Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 7_000) * 1000;
      return accessToken;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error.name === 'AbortError') throw new ConnectorError('DOUYIN_TOKEN_TIMEOUT', '抖音官方 API token 请求超时。', '确认网络连接后重试。');
      throw new ConnectorError('DOUYIN_TOKEN_UNREACHABLE', '无法连接到抖音官方 API 的 token 服务。', '确认网络连接后重试。');
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    douyinTokenCache.pending = null;
  });
  return douyinTokenCache.pending;
}

function officialRecords(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload?.data?.data,
    payload?.data?.list,
    payload?.data?.videos,
    payload?.data?.aweme_list,
    payload?.data,
    payload?.items,
    payload?.results,
  ];
  return candidates.find(Array.isArray) ?? null;
}

async function writeRawOutput(outputDir, fileName, payload) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, fileName), JSON.stringify(payload, null, 2), 'utf8');
}

async function collectDouyinOfficial({ query, limit, outputDir, emit, target }) {
  const platform = config.platforms.douyin;
  if (target?.sourceUrl) {
    throw new ConnectorError('DIRECT_PROFILE_UNSUPPORTED', '抖音官方视频搜索接口不能核验指定的个人主页链接。', '将抖音连接器切换为 browser_relay 或 partner_http 后重新核验。');
  }
  if (!platform.clientKey || !platform.clientSecret || !platform.deviceId) {
    throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', '抖音官方 API 缺少应用凭据或 device_id。', officialDouyinAction());
  }
  emit?.({ message: '正在请求抖音官方 client token。' });
  const accessToken = await getDouyinClientToken();
  const searchUrl = new URL(DOUYIN_VIDEO_SEARCH_URL);
  searchUrl.searchParams.set('keyword', query);
  searchUrl.searchParams.set('count', String(Math.max(1, Math.min(limit, 30))));
  searchUrl.searchParams.set('cursor', '0');
  searchUrl.searchParams.set('device_id', platform.deviceId);
  if (Number.isFinite(platform.sortType)) searchUrl.searchParams.set('sort_type', String(platform.sortType));
  if (platform.publishTime > 0) searchUrl.searchParams.set('publish_time', String(platform.publishTime));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICIAL_API_TIMEOUT_MS);
  try {
    emit?.({ message: '正在调用抖音官方视频搜索接口。' });
    const response = await fetch(searchUrl, { headers: { 'access-token': accessToken }, signal: controller.signal });
    const payload = await responseJson(response, 'Douyin official API');
    await writeRawOutput(outputDir, 'douyin_official_search_latest.json', { retrievedAt: new Date().toISOString(), query, response: payload });
    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError('DOUYIN_API_AUTH_FAILED', '抖音官方 API 拒绝了当前应用或视频搜索权限。', officialDouyinAction());
    }
    if (response.status === 429) {
      throw new ConnectorError('RATE_LIMITED', '抖音官方 API 触发限流。', '等待平台允许的重试窗口后再运行。');
    }
    if (!response.ok) {
      throw new ConnectorError('DOUYIN_API_ERROR', `抖音官方视频搜索返回 HTTP ${response.status}。`, '检查平台服务状态和应用权限后重试。');
    }
    if (!payload || typeof payload !== 'object') {
      throw new ConnectorError('DOUYIN_API_SCHEMA_ERROR', '抖音官方视频搜索未返回 JSON 数据。', '检查接口版本和应用权限后重试。');
    }
    const apiCode = payload?.data?.error_code ?? payload?.error_code;
    if (apiCode !== undefined && String(apiCode) !== '0') {
      throw new ConnectorError('DOUYIN_API_ERROR', '抖音官方视频搜索返回了业务错误。', officialDouyinAction());
    }
    const records = officialRecords(payload);
    if (records === null) {
      throw new ConnectorError('DOUYIN_API_SCHEMA_ERROR', '抖音官方视频搜索返回的结构不包含候选数组。', '检查接口版本并更新连接器映射。');
    }
    const boundedRecords = records.slice(0, Math.max(1, limit));
    await writeRawOutput(outputDir, 'douyin_official_search_latest.json', { retrievedAt: new Date().toISOString(), query, records: boundedRecords, truncated: records.length > boundedRecords.length, response: payload });
    return {
      records: boundedRecords,
      source: 'official_api',
      sourceUrl: DOUYIN_VIDEO_SEARCH_URL,
      outcome: collectorOutcome(boundedRecords),
      truncated: records.length > boundedRecords.length,
    };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error.name === 'AbortError') throw new ConnectorError('DOUYIN_API_TIMEOUT', '抖音官方视频搜索请求超时。', '确认网络连接后重试。');
    throw new ConnectorError('DOUYIN_API_UNREACHABLE', '无法连接到抖音官方视频搜索接口。', '确认网络连接后重试。');
  } finally {
    clearTimeout(timeout);
  }
}

async function collectPartnerHttp(platformId, { query, limit, mode, outputDir, target, contentLimit }) {
  const platform = config.platforms[platformId];
  if (!platform.partnerUrl) {
    throw new ConnectorError('CONNECTOR_NOT_CONFIGURED', `${platform.label} 合作方接口尚未配置。`, '在 .env 填写合作方 URL 和访问令牌。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PARTNER_TIMEOUT_MS);
  try {
    const response = await fetch(platform.partnerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(platform.partnerToken ? { authorization: `Bearer ${platform.partnerToken}` } : {}) },
      body: JSON.stringify({
        platform: platformId,
        query,
        limit,
        mode,
        target: target || null,
        ...(Number.isFinite(contentLimit) ? { contentLimit } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await responseJson(response, `${platform.label} partner API`);
    await writeRawOutput(outputDir, 'partner_response_latest.json', { retrievedAt: new Date().toISOString(), query, mode, target: target || null, response: payload });
    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError('PARTNER_AUTH_FAILED', `${platform.label} 合作方接口拒绝了当前凭据。`, '更新 .env 中的合作方访问令牌。');
    }
    if (response.status === 429) {
      throw new ConnectorError('RATE_LIMITED', `${platform.label} 合作方接口触发限流。`, '等待接口允许的重试窗口后再运行。');
    }
    if (!response.ok) {
      throw new ConnectorError('PARTNER_HTTP_ERROR', `${platform.label} 合作方接口返回 HTTP ${response.status}。`, '检查供应商状态和请求模板。');
    }
    if (!payload || typeof payload !== 'object') {
      throw new ConnectorError('PARTNER_SCHEMA_ERROR', '合作方接口未返回 JSON 数据。', '调整合作方返回结构。');
    }
    const records = Array.isArray(payload) ? payload : payload.items || payload.data || payload.results;
    if (!Array.isArray(records)) {
      throw new ConnectorError('PARTNER_SCHEMA_ERROR', '合作方接口未返回数组型候选数据。', '将返回结构调整为 items、data、results 或数组。');
    }
    const boundedRecords = records.slice(0, Math.max(1, limit));
    return {
      records: boundedRecords,
      source: 'partner_http',
      sourceUrl: platform.partnerUrl,
      collectionMeta: payload.collectionMeta && typeof payload.collectionMeta === 'object'
        ? payload.collectionMeta
        : null,
      outcome: collectorOutcome(boundedRecords),
      truncated: records.length > boundedRecords.length,
    };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error.name === 'AbortError') throw new ConnectorError('PARTNER_TIMEOUT', `${platform.label} 合作方接口请求超时。`, '确认网络连接后重试。');
    throw new ConnectorError('PARTNER_UNREACHABLE', `无法连接到 ${platform.label} 合作方接口。`, '确认网络连接和接口地址后重试。');
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectPlatform(platformId, input) {
  const mode = config.platforms[platformId]?.mode;
  if (mode === 'partner_http') return collectPartnerHttp(platformId, input);
  if (platformId === 'douyin' && mode === 'official_api') return collectDouyinOfficial(input);
  if (platformId === 'xiaohongshu' && mode === 'browser_relay') return collectXiaohongshu(input);
  if (platformId === 'douyin' && mode === 'browser_relay') return collectDouyin(input);
  if (platformId === 'bilibili' && mode === 'browser_relay') return collectBilibili(input);
  throw new ConnectorError('UNKNOWN_PLATFORM', '未识别的平台或连接器模式。');
}
