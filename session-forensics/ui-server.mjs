import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_ROOT, writeAnalysisArtifacts } from './lib/session-forensics.mjs';
import { describeSessionFile, discoverSessionSources, preflightSessionSources, resolveSessionSources } from './lib/session-source-index.mjs';
import { CONVERSATION_PACKAGES_ROOT, packageConversation } from './lib/conversation-packager.mjs';
import { packageConversationV2, previewConversationCapabilityV2 } from './lib/root-capability-packager.mjs';
import {
  attachPackageToRun,
  createDistillationRun,
  readDistillationRun,
  readRunArtifact,
  reprioritizeDistillationRun,
} from './lib/distillation-run-store.mjs';
import { projectDiscoveryMarkdown, projectPortfolioMarkdown } from './lib/project-discovery.mjs';
import { projectEvidenceMarkdown } from './lib/project-evidence.mjs';
import { projectUnderstandingMarkdown } from './lib/project-understanding.mjs';
import { knowledgeV4Markdown, ndjson } from './lib/project-knowledge-v4.mjs';
import { availablePathPickerKinds, selectLocalPaths } from './lib/local-path-picker.mjs';
import { buildPortableWorkbench, PORTABLE_WORKBENCH_OUTPUT_ROOT } from './lib/portable-workbench.mjs';
import { createChatGptWebBridge } from './templates/root-capability/agent/runtime/chatgpt-web-link.mjs';
import { createWorkspaceSelection, discoverWorkspaceCatalog } from './lib/workspace-session-index.mjs';
import { normalizeScopePolicy } from './lib/scope-policy.mjs';
import {
  importChatGPTExport,
  listChatGPTExportRecords,
  reconcileChatGPTRecords,
  writeChatGPTReconciliation,
} from './lib/chatgpt-export-store.mjs';
import {
  checkpointChatGPTSyncJob,
  planChatGPTIncrementalSync,
  registerChatGPTSyncJob,
  commitChatGPTSyncJob,
  readChatGPTSyncState,
  updateChatGPTSyncRun,
} from './lib/chatgpt-incremental-sync.mjs';
import {
  syncCodexSessionIndex,
  readCodexSessionIndex,
  readCodexSessionFromIndex,
  codexCoverage,
} from './lib/codex-session-sync-store.mjs';
import { normalizeSessionSearchQuery, searchSessionSourcesContent } from './lib/session-content-search.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'output', 'session-forensics');
const WEB_CHAT_IMPORT_ROOT = path.join(OUTPUT_ROOT, 'web-chat-imports');
const CHATGPT_STORE_ROOT = path.join(OUTPUT_ROOT, 'chatgpt');
const CODEX_STORE_ROOT = path.join(OUTPUT_ROOT, 'codex');
const SESSION_SEARCH_CACHE_ROOT = path.join(OUTPUT_ROOT, 'search-cache');
const HOST = process.env.CODEX_SESSION_FORENSICS_HOST || '127.0.0.1';
const PORT = Number(process.env.CODEX_SESSION_FORENSICS_PORT || 8794);
const JSON_LIMIT = 256 * 1024;
const WEB_CHAT_JSON_LIMIT = 16 * 1024 * 1024;
const CHATGPT_EXPORT_LIMIT = 768 * 1024 * 1024;
const OUTPUT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_LIST_LIMIT = 5000;
const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_SEARCH_CACHE_TTL_MS = 30_000;
const SESSION_SEARCH_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SEARCH_CACHE_VERSION = 1;
const AGENT_LOG_LIMIT = 240;
const WEB_CHAT_PLATFORM_NAMES = { chatgpt: 'ChatGPT', deepseek: 'DeepSeek', gemini: 'Gemini', doubao: '豆包' };
const WEB_CHAT_ROUTE_PREFIXES = ['/api/web-chat', '/api/runtime/chatgpt-web'];
const sessionListCache = new Map();
const workspaceCatalogCache = new Map();
const sessionContentSearchCache = new Map();
let webChatPersistedSourcesCache = null;
const launchedPackageAgents = new Map();
const webChatImports = new Map();
let server = null;
const chatGptWeb = createChatGptWebBridge({
  companionRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'root-capability', 'agent', 'chatgpt-companion'),
  getAgentUrl: () => {
    const address = server?.address();
    const activePort = address && typeof address === 'object' ? address.port : PORT;
    return `http://127.0.0.1:${activePort}`;
  },
});
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
};

function sessionSearchFingerprint(sources) {
  return crypto.createHash('sha256').update((sources || []).map((source) => [
    source.sourceKey || source.sessionId || source.sourcePath,
    source.bytes || 0,
    source.modifiedAt || '',
  ].join('|')).join('\n')).digest('hex').slice(0, 24);
}

function sessionSearchCacheKey({ scope, sources, query, limit }) {
  return `${scope}|${limit}|${normalizeSessionSearchQuery(query)}|${sessionSearchFingerprint(sources)}`;
}

function sessionSearchCachePath(cacheKey) {
  return path.join(SESSION_SEARCH_CACHE_ROOT, `${crypto.createHash('sha256').update(cacheKey).digest('hex')}.json`);
}

async function readSessionSearchDiskCache(cacheKey) {
  try {
    const parsed = JSON.parse(await fsp.readFile(sessionSearchCachePath(cacheKey), 'utf8'));
    if (parsed?.version !== SESSION_SEARCH_CACHE_VERSION || !parsed.value || Date.now() - Number(parsed.createdAt || 0) > SESSION_SEARCH_DISK_CACHE_TTL_MS) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

async function writeSessionSearchDiskCache(cacheKey, value) {
  try {
    await fsp.mkdir(SESSION_SEARCH_CACHE_ROOT, { recursive: true });
    const target = sessionSearchCachePath(cacheKey);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ version: SESSION_SEARCH_CACHE_VERSION, createdAt: Date.now(), value })}\n`, 'utf8');
    await fsp.rename(temporary, target);
  } catch {
    // 搜索缓存只是性能优化，写入失败不能影响搜索结果。
  }
}

async function searchSessionSourcesCached({ scope, sources, query, limit }) {
  const normalizedQuery = normalizeSessionSearchQuery(query);
  const cacheKey = sessionSearchCacheKey({ scope, sources, query: normalizedQuery, limit });
  const cached = sessionContentSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SESSION_SEARCH_CACHE_TTL_MS) return { ...cached.value, cached: true };
  const diskCached = await readSessionSearchDiskCache(cacheKey);
  if (diskCached) {
    sessionContentSearchCache.set(cacheKey, { createdAt: Date.now(), value: diskCached });
    return { ...diskCached, cached: true, persistentCache: true };
  }
  const value = await searchSessionSourcesContent({ sources, query, limit });
  sessionContentSearchCache.set(cacheKey, { createdAt: Date.now(), value });
  void writeSessionSearchDiskCache(cacheKey, value);
  if (sessionContentSearchCache.size > 80) sessionContentSearchCache.delete(sessionContentSearchCache.keys().next().value);
  return { ...value, cached: false };
}

function webChatRecordText(record) {
  const content = record?.payload?.content;
  if (Array.isArray(content)) {
    return redactImportedWebChatText(content.map((item) => item?.text || item?.content || '').filter(Boolean).join('\n'));
  }
  return redactImportedWebChatText(content);
}

function webChatTitleIsPlaceholder(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !title || /\?{2,}/.test(title) || /^(?:ChatGPT|DeepSeek|Gemini|豆包)$/i.test(title);
}

function chooseWebChatTitle(candidate, firstUser, platformName) {
  const title = redactImportedWebChatText(candidate, 300).replace(/[\r\n]+/g, ' ').trim();
  if (!webChatTitleIsPlaceholder(title)) return { title, titleSource: '网页页面标题' };
  const request = redactImportedWebChatText(firstUser, 300).replace(/[\r\n]+/g, ' ').trim();
  if (!webChatTitleIsPlaceholder(request)) return { title: request, titleSource: '首条用户消息' };
  return { title: `${platformName} 网页对话（标题未读取）`, titleSource: '平台页面未提供标题' };
}

async function readPersistedWebChatDetails(sourcePath, platform) {
  const platformName = WEB_CHAT_PLATFORM_NAMES[platform] || '网页端';
  try {
    const records = (await fsp.readFile(sourcePath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const meta = records.find((record) => record?.type === 'session_meta')?.payload || {};
    const messages = records.filter((record) => record?.type === 'response_item' && record?.payload?.type === 'message');
    const userPreview = messages.map(webChatRecordText).find((value, index) => String(messages[index]?.payload?.role || '') === 'user' && value) || '';
    const assistantPreview = messages.map(webChatRecordText).find((value, index) => String(messages[index]?.payload?.role || '') === 'assistant' && value) || '';
    const chosen = chooseWebChatTitle(meta.title, userPreview, platformName);
    const url = String(meta.url || '').trim();
    const conversationId = String(meta.conversation_id || '').trim() || chatGptConversationIdFromUrl(url) || null;
    return {
      title: chosen.title,
      titleSource: chosen.titleSource,
      origin: String(meta.import_kind || 'web-chat'),
      messageCount: messages.length,
      userPreview: userPreview.slice(0, 220),
      assistantPreview: assistantPreview.slice(0, 220),
      url,
      conversationId,
      version: Number(meta.version || 1),
      hasRealConversation: Boolean(url)
        || !webChatTitleIsPlaceholder(meta.title)
        || !webChatTitleIsPlaceholder(userPreview),
    };
  } catch {
    return { title: `${platformName} 网页对话（标题未读取）`, titleSource: '历史快照无法解析', messageCount: 0, userPreview: '', assistantPreview: '', url: '', hasRealConversation: false };
  }
}

async function listPersistedWebChatImports(limit) {
  const sourcePaths = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jsonl') sourcePaths.push(entryPath);
      if (sourcePaths.length >= limit) return;
    }
  }

  await visit(WEB_CHAT_IMPORT_ROOT);
  const described = await Promise.all(sourcePaths.slice(0, limit).map(async (sourcePath) => {
    const item = await describeSessionFile(sourcePath, { discoveredBy: '主工作台网页端对话导入' });
    if (!item.source) return item;
    const filename = path.basename(item.source.sourcePath).toLowerCase();
    const platform = Object.keys(WEB_CHAT_PLATFORM_NAMES).find((key) => filename.startsWith(`${key}-`)) || 'chatgpt';
    const details = await readPersistedWebChatDetails(sourcePath, platform);
    return {
      ...item,
      source: {
        ...item.source,
        ...(details.title ? { title: details.title, titleSource: details.titleSource || '网页页面标题' } : {}),
        webChatDetails: details,
      },
    };
  }));
  return described.flatMap((item) => {
    if (!item.source) return [];
    const filename = path.basename(item.source.sourcePath).toLowerCase();
    const platform = Object.keys(WEB_CHAT_PLATFORM_NAMES).find((key) => filename.startsWith(`${key}-`)) || 'chatgpt';
    const { webChatDetails, ...baseSource } = item.source;
    if (!webChatDetails?.hasRealConversation) return [];
    return [{
      ...baseSource,
      importKind: 'web-chat',
      webChat: {
        platform,
        platformName: WEB_CHAT_PLATFORM_NAMES[platform],
        origin: webChatDetails?.origin || 'web-chat',
        capturedAt: item.source.modifiedAt,
        messageCount: webChatDetails?.messageCount ?? Math.max(0, Number(item.source.recordCount || 1) - 1),
        titleSource: webChatDetails?.titleSource || item.source.titleSource || '网页页面标题',
        userPreview: webChatDetails?.userPreview || '',
        assistantPreview: webChatDetails?.assistantPreview || '',
        url: webChatDetails?.url || '',
        conversationId: webChatDetails?.conversationId || null,
        version: Number(webChatDetails?.version || 1),
      },
    }];
  });
}

async function listSessionsCached({ roots = [], limit = SESSION_LIST_LIMIT, force = false } = {}) {
  const normalizedRoots = [...new Set(roots.map((root) => String(root || '').trim()).filter(Boolean))].sort();
  const safeLimit = Math.max(1, Math.min(Number(limit) || SESSION_LIST_LIMIT, SESSION_LIST_LIMIT));
  const cacheKey = JSON.stringify({ roots: normalizedRoots, limit: safeLimit });
  const now = Date.now();
  const cached = sessionListCache.get(cacheKey);
  if (!force && cached && (cached.pending || now - cached.updatedAt < SESSION_CACHE_TTL_MS)) {
    return cached.value;
  }
  const pending = Promise.all([
    discoverSessionSources({ roots: normalizedRoots, limit: safeLimit }),
    listPersistedWebChatImports(safeLimit),
  ]).then(([sessions, importedWebChats]) => {
    const merged = new Map();
    for (const source of [...sessions, ...importedWebChats]) {
      const key = String(source.sourcePath || source.sourceKey || '').toLowerCase();
      if (key) merged.set(key, source);
    }
    return [...merged.values()]
      .sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0))
      .slice(0, safeLimit);
  });
  sessionListCache.set(cacheKey, { value: pending, pending: true, updatedAt: now });
  try {
    const sessions = await pending;
    sessionListCache.set(cacheKey, { value: sessions, pending: false, updatedAt: Date.now() });
    return sessions;
  } catch (error) {
    sessionListCache.delete(cacheKey);
    throw error;
  }
}

async function workspaceCatalogCached({ roots = [], force = false } = {}) {
  const normalizedRoots = [...new Set(roots.map((root) => String(root || '').trim()).filter(Boolean))].sort();
  const cacheKey = JSON.stringify({ roots: normalizedRoots });
  const now = Date.now();
  const cached = workspaceCatalogCache.get(cacheKey);
  if (!force && cached && (cached.pending || now - cached.updatedAt < SESSION_CACHE_TTL_MS)) return cached.value;
  const pending = discoverWorkspaceCatalog({ roots: normalizedRoots });
  workspaceCatalogCache.set(cacheKey, { value: pending, pending: true, updatedAt: now });
  try {
    const catalog = await pending;
    workspaceCatalogCache.set(cacheKey, { value: catalog, pending: false, updatedAt: Date.now() });
    return catalog;
  } catch (error) {
    workspaceCatalogCache.delete(cacheKey);
    throw error;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function isLoopbackRequest(request) {
  const address = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function webChatRoutePath(pathname) {
  for (const prefix of WEB_CHAT_ROUTE_PREFIXES) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return null;
}

function applyWebChatCompanionCors(request, response, url) {
  if (webChatRoutePath(url.pathname) === null) return false;
  const origin = String(request.headers.origin || '');
  if (/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'origin');
    response.setHeader('access-control-allow-headers', 'content-type, authorization');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }
  return false;
}

function redactImportedWebChatText(value, maxLength = 32_000) {
  return String(value || '')
    .slice(0, maxLength)
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, '$1[已隐藏]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/ig, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏的密钥样式文本]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/ig, (match, secret) => match.replace(secret, '[已隐藏]'))
    .trim();
}

function safeWebChatTitle(value, fallback) {
  const title = redactImportedWebChatText(value, 300).replace(/[\r\n]+/g, ' ').trim();
  return webChatTitleIsPlaceholder(title) ? fallback : title;
}

function clientWebChatJob(job) {
  if (!job) return job;
  const snapshot = job?.result?.snapshot;
  const history = job?.result?.history;
  const captures = job?.result?.captures;
  return {
    ...job,
    result: snapshot ? {
      snapshot: {
        platform: snapshot.platform,
        platformName: snapshot.platformName,
        title: safeWebChatTitle(snapshot.title, '未命名网页对话'),
        url: snapshot.url || '',
        conversationId: snapshot.conversationId || null,
        createdAt: snapshot.createdAt || null,
        updatedAt: snapshot.updatedAt || null,
        projectId: snapshot.projectId || null,
        projectTitle: snapshot.projectTitle || null,
        capturedAt: snapshot.capturedAt,
        messageCount: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0,
      },
    } : history ? {
      history: {
        platform: history.platform,
        platformName: history.platformName,
        capturedAt: history.capturedAt,
        currentUrl: history.currentUrl || '',
        scan: history.scan || null,
        conversations: (history.conversations || []).map((item) => ({
          conversationId: item.conversationId || null,
          title: safeWebChatTitle(item.title, '未命名网页对话'),
          url: item.url || '',
          current: Boolean(item.current),
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null,
          archived: Boolean(item.archived),
          projectId: item.projectId || null,
          projectTitle: item.projectTitle || null,
        })),
      },
    } : Array.isArray(captures) ? {
      captures: captures.map((item) => ({
        platform: item.platform,
        platformName: item.platformName,
        title: safeWebChatTitle(item.title, '未命名网页对话'),
        url: item.url || '',
        conversationId: item.conversationId || null,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
        projectId: item.projectId || null,
        projectTitle: item.projectTitle || null,
        capturedAt: item.capturedAt || null,
        messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
      })),
      capturedCount: Number(job.result.capturedCount || captures.length),
      failedCount: Number(job.result.failedCount || 0),
      totalCount: Number(job.result.totalCount || captures.length),
    } : job.result,
  };
}

function stableLocalSessionId(value) {
  const hash = crypto.createHash('sha256').update(String(value || '')).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function webChatConversationId(snapshot = {}) {
  const explicit = String(snapshot.conversationId || snapshot.conversation_id || '').trim();
  if (explicit) return explicit;
  return chatGptConversationIdFromUrl(snapshot.url) || '';
}

function webChatPersistenceKey(platform, conversationId, url, title, firstUserMessage) {
  const normalizedUrl = String(url || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();
  if (normalizedConversationId) return `${platform}:conversation:${normalizedConversationId}`;
  if (normalizedUrl) return `${platform}:url:${normalizedUrl}`;
  return `${platform}:content:${String(title || '').trim()}|${String(firstUserMessage || '').trim().slice(0, 500)}`;
}

async function findPersistedWebChatSource({ platform, conversationId = '', url = '', originMode = 'any' } = {}) {
  const normalizedUrl = String(url || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedUrl && !normalizedConversationId) return null;
  const sources = await listPersistedWebChatImports(50_000);
  return sources.find((source) => {
    if (source.webChat?.platform !== platform) return false;
    const origin = String(source.webChat?.origin || '').trim();
    if (originMode === 'web' && origin === 'chatgpt-export') return false;
    if (originMode === 'export' && origin !== 'chatgpt-export') return false;
    const sourceConversationId = String(source.webChat?.conversationId || '').trim();
    const sourceUrl = String(source.webChat?.url || '').trim();
    return (normalizedConversationId && sourceConversationId === normalizedConversationId)
      || (normalizedUrl && sourceUrl === normalizedUrl);
  }) || null;
}

async function persistWebChatSnapshot(snapshot, {
  cacheKey = '',
  sessionId: requestedSessionId = '',
  targetDirectory: requestedTargetDirectory = '',
  existingSources = null,
  allowEmpty = false,
} = {}) {
  const normaliseMessage = (item = {}) => {
    const content = redactImportedWebChatText(item?.content);
    const contentParts = Array.isArray(item?.contentParts) ? item.contentParts : [];
    const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    return {
      role: ['user', 'assistant', 'system', 'tool'].includes(item?.role) ? item.role : 'user',
      content,
      contentParts,
      messageId: item?.messageId || null,
      nodeId: item?.nodeId || null,
      parentNodeId: item?.parentNodeId || null,
      childNodeIds: Array.isArray(item?.childNodeIds) ? item.childNodeIds : [],
      createdAt: item?.createdAt || null,
      model: item?.model || null,
      recipient: item?.recipient || null,
      contentType: item?.contentType || null,
      eventType: item?.eventType || 'message',
      metadata,
    };
  };
  const incomingMessages = Array.isArray(snapshot?.messages)
    ? snapshot.messages.map(normaliseMessage).filter((item) => item.content || item.contentParts.length || item.recipient || Object.keys(item.metadata).length)
    : [];

  const platform = Object.hasOwn(WEB_CHAT_PLATFORM_NAMES, snapshot?.platform) ? snapshot.platform : 'chatgpt';
  const platformName = WEB_CHAT_PLATFORM_NAMES[platform];
  const capturedAt = String(snapshot?.capturedAt || new Date().toISOString());
  const conversationId = webChatConversationId(snapshot);
  const originMode = String(snapshot?.importKind || '').trim() === 'chatgpt-export' ? 'export' : 'web';
  const existing = Array.isArray(existingSources)
    ? existingSources.find((source) => {
      if (source.webChat?.platform !== platform) return false;
      const origin = String(source.webChat?.origin || '').trim();
      if (originMode === 'web' && origin === 'chatgpt-export') return false;
      if (originMode === 'export' && origin !== 'chatgpt-export') return false;
      const sourceConversationId = String(source.webChat?.conversationId || '').trim();
      const sourceUrl = String(source.webChat?.url || '').trim();
      return (conversationId && sourceConversationId === conversationId)
        || (snapshot?.url && sourceUrl === String(snapshot.url).trim());
    }) || null
    : await findPersistedWebChatSource({ platform, conversationId, url: snapshot?.url, originMode });
  const existingPath = String(existing?.sourcePath || '').trim();
  let existingRows = [];
  let existingMeta = {};
  let existingMessages = [];
  let existingEvents = [];
  let existingAssets = [];
  let existingNodes = [];
  let existingRawPayload = null;
  if (existingPath) {
    try {
      existingRows = (await fsp.readFile(existingPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      existingMeta = existingRows.find((row) => row?.type === 'session_meta')?.payload || {};
      existingMessages = existingRows.filter((row) => row?.type === 'response_item' && row?.payload?.type === 'message').map((row) => normaliseMessage({
        ...row.payload,
        content: webChatRecordText(row),
        contentParts: row.payload.content_parts || [],
        messageId: row.payload.message_id,
        nodeId: row.payload.node_id,
        parentNodeId: row.payload.parent_node_id,
        childNodeIds: row.payload.child_node_ids,
        createdAt: row.payload.created_at,
        model: row.payload.model,
        recipient: row.payload.recipient,
        contentType: row.payload.content_type,
        eventType: row.payload.event_type,
        metadata: row.payload.metadata,
      })).filter((item) => item.content || item.contentParts.length || item.recipient || Object.keys(item.metadata).length);
      existingEvents = existingRows.filter((row) => row?.type === 'web_event').map((row) => row.payload).filter(Boolean);
      existingAssets = existingRows.filter((row) => row?.type === 'web_asset').map((row) => row.payload).filter(Boolean);
      existingNodes = existingRows.filter((row) => row?.type === 'web_node').map((row) => row.payload).filter(Boolean);
      existingRawPayload = existingRows.find((row) => row?.type === 'web_raw_detail')?.payload || null;
    } catch {}
  }
  const messages = incomingMessages.length ? incomingMessages : existingMessages;
  if (!messages.length && !allowEmpty) throw new Error('网页中没有发现可导入的聊天内容。请打开具体对话后，再点击“读取当前聊天”。');
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content || '';
  const chosenTitle = chooseWebChatTitle(snapshot?.title || existing?.title, firstUserMessage, platformName);
  const title = chosenTitle.title;
  const persistenceKey = webChatPersistenceKey(platform, conversationId, snapshot?.url, title, firstUserMessage);
  const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestedSessionId)
    ? requestedSessionId
    : existing?.sessionId || stableLocalSessionId(persistenceKey);
  const safeDate = capturedAt.slice(0, 10).replace(/[^0-9-]/g, '') || 'unknown-date';
  const targetDirectory = requestedTargetDirectory
    || (existingPath ? path.dirname(existingPath) : path.join(WEB_CHAT_IMPORT_ROOT, 'persistent', platform));
  const sourcePath = existingPath || path.join(targetDirectory, `${platform}-${sessionId}.jsonl`);
  const events = Array.isArray(snapshot?.events) && snapshot.events.length ? snapshot.events : existingEvents;
  const assets = Array.isArray(snapshot?.assets) && snapshot.assets.length ? snapshot.assets : existingAssets;
  const nodes = Array.isArray(snapshot?.nodes) && snapshot.nodes.length ? snapshot.nodes : existingNodes;
  const branches = snapshot?.branches && typeof snapshot.branches === 'object' && Object.keys(snapshot.branches).length
    ? snapshot.branches
    : (existingMeta.branches || {});
  const rawPayload = snapshot?.rawPayload || existingRawPayload;
  const contentEnvelope = { messages, events, assets, nodes, branches };
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(contentEnvelope)).digest('hex');
  const previousHash = String(existingMeta.content_hash || '').trim();
  const version = Math.max(1, Number(existingMeta.version || 0) + (previousHash && previousHash !== contentHash ? 1 : existingMeta.version ? 0 : 1));
  const versions = Array.isArray(existingMeta.versions) ? existingMeta.versions.slice(-19) : [];
  if (previousHash && previousHash !== contentHash) versions.push({ contentHash: previousHash, messageCount: existingMessages.length, capturedAt: existingMeta.captured_at || null });
  const origin = String(snapshot?.importKind || '').trim() === 'chatgpt-export'
    ? 'chatgpt-export'
    : messages.length ? 'web-chat' : 'web-chat-history';
  const records = [
    {
      type: 'session_meta',
      timestamp: capturedAt,
      payload: {
        id: sessionId,
        session_id: sessionId,
         title: `${platformName}｜${title}`,
         source: snapshot?.importKind === 'chatgpt-export' ? 'ChatGPT 官方导出导入' : '网页端对话导入',
         platform,
         import_kind: String(snapshot?.importKind || 'web-chat'),
         conversation_id: conversationId,
         version,
         content_hash: contentHash,
         message_count: messages.length,
         node_count: nodes.length,
         event_count: events.length,
         asset_count: assets.length,
         completeness: snapshot?.completeness || existingMeta.completeness || { index: true, messages: Boolean(messages.length), branches: Boolean(nodes.length), tools: true, assets: true, raw: Boolean(rawPayload) },
         branches,
         raw_payload_hash: rawPayload ? crypto.createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex') : null,
         previous_content_hash: previousHash || null,
         versions,
         captured_at: capturedAt,
         url: String(snapshot?.url || existing?.webChat?.url || '').trim(),
         title_source: chosenTitle.titleSource,
         source_created_at: snapshot?.createdAt || existingMeta.source_created_at || null,
         source_updated_at: snapshot?.updatedAt || existingMeta.source_updated_at || null,
         project_id: snapshot?.projectId || existingMeta.project_id || null,
         project_title: snapshot?.projectTitle || existingMeta.project_title || null,
      },
    },
    ...messages.map((message, index) => ({
      type: 'response_item',
      timestamp: capturedAt,
      payload: {
        type: 'message',
        role: message.role,
        content: message.contentParts.length ? message.contentParts : [{ type: 'input_text', text: message.content }],
        channel: 'web-chat-import',
        message_index: index + 1,
        message_id: message.messageId,
        node_id: message.nodeId,
        parent_node_id: message.parentNodeId,
        child_node_ids: message.childNodeIds,
        created_at: message.createdAt,
        model: message.model,
        recipient: message.recipient,
        content_type: message.contentType,
        event_type: message.eventType,
        metadata: message.metadata,
      },
    })),
    ...events.map((event) => ({ type: 'web_event', timestamp: capturedAt, payload: event })),
    ...assets.map((asset) => ({ type: 'web_asset', timestamp: capturedAt, payload: asset })),
    ...nodes.map((node) => ({ type: 'web_node', timestamp: capturedAt, payload: node })),
    ...(Object.keys(rawPayload || {}).length ? [{ type: 'web_raw_detail', timestamp: capturedAt, payload: rawPayload }] : []),
  ];
  await fsp.mkdir(targetDirectory, { recursive: true });
  await fsp.writeFile(sourcePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const described = await describeSessionFile(sourcePath, { discoveredBy: `网页端 ${platformName} 对话导入` });
  if (!described.source) throw new Error(described.state?.message || '网页对话已读取，但未能转换为可蒸馏会话。');
  const source = {
    ...described.source,
    title,
    titleSource: chosenTitle.titleSource,
    importKind: 'web-chat',
    webChat: {
      platform,
      platformName,
      origin,
      capturedAt,
      messageCount: messages.length,
      nodeCount: nodes.length,
      eventCount: events.length,
      assetCount: assets.length,
      completeness: snapshot?.completeness || existing?.webChat?.completeness || existingMeta.completeness || null,
      conversationId: conversationId || existing?.webChat?.conversationId || null,
      projectId: snapshot?.projectId || existing?.webChat?.projectId || null,
      projectTitle: snapshot?.projectTitle || existing?.webChat?.projectTitle || null,
      sourceCreatedAt: snapshot?.createdAt || existing?.webChat?.sourceCreatedAt || null,
      sourceUpdatedAt: snapshot?.updatedAt || existing?.webChat?.sourceUpdatedAt || null,
      version,
      updateMode: existing ? 'updated' : 'created',
      titleSource: chosenTitle.titleSource,
      userPreview: firstUserMessage.slice(0, 220),
      assistantPreview: messages.find((message) => message.role === 'assistant')?.content?.slice(0, 220) || '',
      url: String(snapshot?.url || existing?.webChat?.url || '').trim(),
    },
  };
  if (cacheKey) webChatImports.set(cacheKey, source);
  sessionListCache.clear();
  return source;
}

async function importWebChatJob(jobId) {
  const key = String(jobId || '').trim();
  if (!key) throw new Error('缺少网页对话读取任务编号。');
  if (webChatImports.has(key)) return webChatImports.get(key);
  const job = chatGptWeb.getJob(key);
  if (job.type !== 'capture' || job.status !== '完成') throw new Error('当前网页对话尚未读取完成，请先点击“读取当前聊天”。');
  return persistWebChatSnapshot(job?.result?.snapshot, { cacheKey: key });
}

async function importWebChatHistoryJob(jobId) {
  const key = String(jobId || '').trim();
  if (!key) throw new Error('缺少网页历史读取任务编号。');
  const job = chatGptWeb.getJob(key);
  if (job.type !== 'history-index' || job.status !== '完成') throw new Error('网页历史目录尚未读取完成，请先点击“读取全部真实会话列表”。');
  const history = job?.result?.history || {};
  const conversations = Array.isArray(history.conversations) ? history.conversations : [];
  const sources = [];
  const errors = [];
  let existingSources = await listPersistedWebChatImports(50_000);
  for (const [index, conversation] of conversations.entries()) {
    try {
      sources.push(await persistWebChatSnapshot({
        platform: history.platform || job.platform || 'chatgpt',
        importKind: 'web-chat-history',
        title: conversation.title,
        url: conversation.url,
        conversationId: conversation.conversationId || chatGptConversationIdFromUrl(conversation.url),
        createdAt: conversation.createdAt || null,
        updatedAt: conversation.updatedAt || null,
        projectId: conversation.projectId || null,
        projectTitle: conversation.projectTitle || null,
        capturedAt: history.capturedAt || new Date().toISOString(),
        messages: [],
      }, { allowEmpty: true, existingSources }));
      existingSources = [sources.at(-1), ...existingSources.filter((item) => item.sourcePath !== sources.at(-1).sourcePath)];
    } catch (error) {
      errors.push({ index, title: conversation.title || null, message: error.message });
    }
  }
  if (!sources.length && conversations.length) throw new Error(errors[0]?.message || '没有保存到可用的网页历史会话。');
  return {
    platform: history.platform || job.platform || 'chatgpt',
    sources,
    errors,
    totalCount: conversations.length,
    savedCount: sources.length,
    updatedCount: sources.filter((source) => source.webChat?.updateMode === 'updated').length,
    createdCount: sources.filter((source) => source.webChat?.updateMode === 'created').length,
  };
}

async function importWebChatBatchJob(jobId) {
  const key = String(jobId || '').trim();
  if (!key) throw new Error('缺少网页批量读取任务编号。');
  const job = chatGptWeb.getJob(key);
  if (job.type !== 'capture-all' || job.status !== '完成') throw new Error('网页批量读取尚未完成，请稍候再试。');
  const captures = Array.isArray(job?.result?.captures) ? job.result.captures : [];
  const sources = [];
  const errors = [];
  let existingSources = await listPersistedWebChatImports(50_000);
  for (const [index, snapshot] of captures.entries()) {
    try {
      const source = await persistWebChatSnapshot(snapshot, { existingSources });
      sources.push(source);
      existingSources = [source, ...existingSources.filter((item) => item.sourcePath !== source.sourcePath)];
    } catch (error) {
      errors.push({ index, message: error.message });
    }
  }
  const sync = await commitChatGPTSyncJob({
    root: CHATGPT_STORE_ROOT,
    jobId: key,
    captures,
    error: errors.map((item) => item.message).filter(Boolean).join('；'),
  });
  return { sources, errors, totalCount: job.totalCount || captures.length, capturedCount: sources.length, failedCount: (job.failedCount || 0) + errors.length, sync };
}

function chatGptConversationIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/c\/([^/]+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

async function readPersistedChatGptEdgeRecord(source) {
  const sourcePath = String(source?.sourcePath || '').trim();
  if (!sourcePath) return null;
  try {
    const rows = (await fsp.readFile(sourcePath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const meta = rows.find((row) => row?.type === 'session_meta')?.payload || {};
    const messages = rows.filter((row) => row?.type === 'response_item' && row?.payload?.type === 'message').map((row, index) => ({
      index,
      role: ['user', 'assistant', 'system', 'tool'].includes(row?.payload?.role) ? row.payload.role : 'unknown',
      content: webChatRecordText(row),
      messageId: row?.payload?.message_id || null,
      createdAt: row?.timestamp || null,
    })).filter((item) => item.content || item.role !== 'unknown');
    const events = rows.filter((row) => row?.type === 'web_event').map((row) => row.payload).filter(Boolean);
    const assets = rows.filter((row) => row?.type === 'web_asset').map((row) => row.payload).filter(Boolean);
    const nodes = rows.filter((row) => row?.type === 'web_node').map((row) => row.payload).filter(Boolean);
    const url = String(meta.url || source?.webChat?.url || '').trim();
    const conversationId = chatGptConversationIdFromUrl(url) || String(meta.conversation_id || '').trim() || null;
    const title = safeWebChatTitle(source?.title || meta.title, '未命名 ChatGPT 网页对话');
    const record = {
      conversationId,
      title,
      createdAt: meta.source_created_at || rows[0]?.timestamp || null,
      updatedAt: meta.source_updated_at || rows.at(-1)?.timestamp || rows[0]?.timestamp || null,
      capturedAt: meta.captured_at || rows.at(-1)?.timestamp || new Date().toISOString(),
      url,
      messages,
      messageCount: messages.length,
      eventCount: Number(meta.event_count || events.length),
      assetCount: Number(meta.asset_count || assets.length),
      nodeCount: Number(meta.node_count || nodes.length),
      events,
      assets,
      nodes,
      branches: meta.branches || null,
      completenessDetails: meta.completeness || null,
      sourceType: 'chatgpt-edge',
      sourcePath,
      completeness: messages.length ? (events.length || nodes.length || assets.length ? 'complete-edge-lossless' : 'complete-edge') : 'index-only',
    };
    record.contentHash = crypto.createHash('sha256').update(JSON.stringify({ messages, events, assets, nodes, branches: record.branches })).digest('hex');
    return record;
  } catch {
    return null;
  }
}

async function readPersistedWebChatRows(conversationId) {
  const normalized = String(conversationId || '').trim();
  if (!normalized) return null;
  const sources = await listPersistedWebChatImports(50_000);
  const source = sources.find((item) => item.webChat?.platform === 'chatgpt' && String(item.webChat?.conversationId || '') === normalized);
  if (!source?.sourcePath) return null;
  const rows = (await fsp.readFile(source.sourcePath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { source, rows, meta: rows.find((row) => row?.type === 'session_meta')?.payload || {} };
}

async function readChatGPTReconciliation() {
  const exportRecords = await listChatGPTExportRecords(CHATGPT_STORE_ROOT);
  const imported = await listPersistedWebChatImports(50_000);
  const edgeRecordsRaw = (await Promise.all(imported
    .filter((source) => source.webChat?.platform === 'chatgpt' && source.webChat?.origin !== 'chatgpt-export')
    .map(readPersistedChatGptEdgeRecord))).filter(Boolean);
  // 网页端同一会话可能被重复读取；对账前按会话编号保留最新一次完整快照，避免覆盖率被重复记录放大。
  const edgeByConversation = new Map();
  for (const record of edgeRecordsRaw) {
    const key = record.conversationId || record.url || record.sourcePath;
    const previous = edgeByConversation.get(key);
    const previousTime = Date.parse(previous?.capturedAt || previous?.updatedAt || 0) || 0;
    const currentTime = Date.parse(record.capturedAt || record.updatedAt || 0) || 0;
    if (!previous || currentTime >= previousTime || (record.messages?.length || 0) > (previous.messages?.length || 0)) edgeByConversation.set(key, record);
  }
  const edgeRecords = [...edgeByConversation.values()];
  const reconciliation = reconcileChatGPTRecords(exportRecords, edgeRecords);
  await writeChatGPTReconciliation(CHATGPT_STORE_ROOT, reconciliation);
  return { ...reconciliation, exportCount: exportRecords.length, edgeCount: edgeRecords.length };
}

async function chatGPTCoveragePayload() {
  const reconciliation = await readChatGPTReconciliation();
  const syncState = await readChatGPTSyncState(CHATGPT_STORE_ROOT);
  const syncEntries = Object.values(syncState.conversations || {});
  const runs = Object.values(syncState.runs || {}).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
  const incremental = {
    totalTracked: syncEntries.length,
    pending: syncEntries.filter((item) => item.status === 'pending').length,
    success: syncEntries.filter((item) => item.status === 'success').length,
    failed: syncEntries.filter((item) => item.status === 'failed').length,
    statePath: path.join(CHATGPT_STORE_ROOT, 'incremental-sync-state.json'),
    runs: runs.slice(0, 20),
    active: runs.filter((item) => ['queued', 'running', 'paused', 'partial'].includes(item.status)).slice(0, 10),
  };
  const edgeDetails = reconciliation.records.filter((item) => item.sourceTypes?.includes('chatgpt-edge')).reduce((acc, item) => ({
    eventCount: acc.eventCount + Number(item.eventCount || 0),
    assetCount: acc.assetCount + Number(item.assetCount || 0),
    nodeCount: acc.nodeCount + Number(item.nodeCount || 0),
    lossless: acc.lossless + (item.completeness === 'complete-edge-lossless' ? 1 : 0),
  }), { eventCount: 0, assetCount: 0, nodeCount: 0, lossless: 0 });
  return {
    schemaVersion: 'chatgpt-coverage-v2',
    generatedAt: new Date().toISOString(),
    sourceTypes: ['chatgpt-export', 'chatgpt-edge'],
    counts: reconciliation.counts,
    exportCount: reconciliation.exportCount,
    edgeCount: reconciliation.edgeCount,
    details: edgeDetails,
    incremental,
    records: reconciliation.records.map((item) => ({
      conversationId: item.conversationId,
      title: item.title,
      url: item.url,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || item.capturedAt || null,
      messageCount: item.messageCount || item.messages?.length || 0,
      sourceTypes: item.sourceTypes || [item.sourceType],
      status: item.status,
      completeness: item.completeness,
      contentHash: item.contentHash || null,
    })),
  };
}

function compactProjectEvidence(projectEvidence) {
  if (!projectEvidence) return null;
  const compactFiles = (files) => (files || []).slice(0, 160).map((item) => ({
    path: item.path,
    kind: item.kind || null,
    language: item.language || null,
    changeState: item.changeState || item.status || null,
    projectRole: item.projectRole || null,
    gitStatus: item.gitStatus || null,
    originalAvailable: Boolean(item.original || item.originalAvailable),
    hasDiff: Boolean(item.diffExcerpt || item.hasDiff),
    observedInConversation: Boolean(item.observedInConversation),
  }));
  return {
    discovery: projectEvidence.discovery || null,
    project: projectEvidence.project,
    scan: projectEvidence.scan,
    architecture: projectEvidence.architecture,
    git: projectEvidence.git,
    summary: projectEvidence.summary,
    modifiedFiles: compactFiles(projectEvidence.modifiedFiles),
    generatedFiles: compactFiles(projectEvidence.generatedFiles),
    originalFiles: compactFiles(projectEvidence.originalFiles),
    conversationLinks: compactFiles(projectEvidence.conversationLinks),
  };
}

function compactProjectPortfolio(projectPortfolio) {
  if (!projectPortfolio) return null;
  return {
    schemaVersion: projectPortfolio.schemaVersion || null,
    generatedAt: projectPortfolio.generatedAt || null,
    mode: projectPortfolio.mode || '未发现',
    recommendedMode: projectPortfolio.recommendedMode || null,
    crossProject: Boolean(projectPortfolio.crossProject),
    projects: (projectPortfolio.projects || []).map((item) => ({
      projectId: item.projectId || null,
      name: item.name || null,
      root: item.root || null,
      score: Number(item.score || 0),
      confidence: item.confidence || '未知',
      git: Boolean(item.git),
      markers: item.markers || [],
      linkedFiles: Number(item.linkedFiles || 0),
      sessionCount: Number(item.sessionCount || item.sessions?.length || 0),
      sessionIds: item.sessionIds || (item.sessions || []).map((session) => session.sessionId).filter(Boolean),
      sessions: item.sessions || [],
      relatedFiles: (item.relatedFiles || []).slice(0, 160),
      evidenceSummary: item.evidenceSummary || item.evidence?.summary || null,
      evidence: compactProjectEvidence(item.evidence),
      evidenceError: item.evidenceError || null,
    })),
    sessionAssignments: projectPortfolio.sessionAssignments || [],
    unassignedSessions: projectPortfolio.unassignedSessions || [],
  };
}

function compactProjectUnderstanding(understanding) {
  if (!understanding) return null;
  const compactEvidence = (items, limit = 12) => (items || []).slice(0, limit).map((item) => ({
    id: item.id || null,
    stage: item.stage || null,
    stageTitle: item.stageTitle || null,
    sessionTitle: item.sessionTitle || null,
    action: item.action || null,
    command: item.command || null,
    verification: Boolean(item.verification),
    eventIndex: item.eventIndex ?? null,
  }));
  return {
    schemaVersion: understanding.schemaVersion || null,
    purpose: understanding.purpose || null,
    project: understanding.project || null,
    scope: understanding.scope || {},
    projectCognition: understanding.projectCognition || {},
    evidenceGraph: understanding.evidenceGraph?.statistics || null,
    fileEvolution: (understanding.fileEvolution || []).map((item) => ({
      id: item.id,
      path: item.path,
      kind: item.kind,
      projectRole: item.projectRole || null,
      language: item.language || null,
      changeState: item.changeState || null,
      observedInConversation: Boolean(item.observedInConversation),
      gitStatus: item.gitStatus || null,
      current: { available: Boolean(item.current?.available) },
      original: { available: Boolean(item.original?.available) },
      diff: { available: Boolean(item.diff?.available) },
      confidence: item.confidence || null,
      conversationEvidence: compactEvidence(item.conversationEvidence),
      commands: compactEvidence(item.commands),
      lineage: (item.lineage || []).slice(0, 16),
      dependencies: item.dependencies || { imports: [], importedBy: [] },
      evidenceIds: (item.evidenceIds || []).slice(0, 32),
    })),
    conflictRegister: (understanding.conflictRegister || []).slice(0, 80),
    activeReadPlan: (understanding.activeReadPlan || []).slice(0, 120),
  };
}

function compactProjectKnowledgeV4(knowledge) {
  if (!knowledge) return null;
  return {
    schemaVersion: knowledge.schemaVersion || null,
    generatedAt: knowledge.generatedAt || null,
    name: knowledge.name || '多会话项目知识包 V4',
    summary: knowledge.summary || {},
    semanticStages: (knowledge.semanticStages || []).map((stage) => ({
      id: stage.id,
      phase: stage.phase,
      priority: stage.priority,
      title: stage.title,
      purpose: stage.purpose,
      sessions: stage.sessions || [],
      sourceStageIndexes: stage.sourceStageIndexes || [],
      occurrences: stage.occurrences || [],
      files: stage.files || [],
      tools: stage.tools || [],
      evidenceIds: stage.evidenceIds || [],
    })),
    projectModel: knowledge.projectModel || null,
    projectGraph: knowledge.projectGraph?.statistics ? { statistics: knowledge.projectGraph.statistics } : null,
    fileVersions: (knowledge.fileVersions || []).map((item) => ({
      versionId: item.versionId,
      path: item.path,
      order: item.order,
      kind: item.kind,
      revision: item.revision,
      parentVersionId: item.parentVersionId,
      contentAvailable: Boolean(item.contentAvailable),
      changeState: item.changeState || null,
      gitStatus: item.gitStatus || null,
      action: item.action || null,
      evidenceIds: item.evidenceIds || [],
    })),
    artifactLineage: knowledge.artifactLineage || [],
    crossSessionTimeline: knowledge.crossSessionTimeline || [],
    fileChangeMatrix: knowledge.fileChangeMatrix || [],
    dependencyImpact: knowledge.dependencyImpact || null,
    artifactReproducibility: knowledge.artifactReproducibility || [],
    projectSnapshot: knowledge.projectSnapshot || null,
    openEvidenceQuestions: knowledge.openEvidenceQuestions || [],
    decisionConflicts: knowledge.decisionConflicts || [],
    coverage: knowledge.coverage || null,
    activeReadLog: knowledge.activeReadLog || [],
  };
}

const KNOWLEDGE_V4_ARTIFACTS = [
  'project-knowledge-v4.json',
  'project-knowledge-v4.md',
  'semantic-stages.json',
  'evidence-ledger.ndjson',
  'project-model.json',
  'project-graph.json',
  'file-versions.ndjson',
  'artifact-lineage.json',
  'cross-session-timeline.ndjson',
  'file-change-matrix.json',
  'dependency-impact.json',
  'artifact-reproducibility.json',
  'project-snapshot.json',
  'open-evidence-questions.json',
  'decision-conflicts.json',
  'coverage.json',
  'active-read-log.ndjson',
];

function knowledgeV4Links(link) {
  return {
    projectKnowledgeV4: link('project-knowledge-v4.json'),
    projectKnowledgeV4Markdown: link('project-knowledge-v4.md'),
    semanticStages: link('semantic-stages.json'),
    evidenceLedger: link('evidence-ledger.ndjson'),
    projectModel: link('project-model.json'),
    projectGraph: link('project-graph.json'),
    fileVersions: link('file-versions.ndjson'),
    artifactLineage: link('artifact-lineage.json'),
    crossSessionTimeline: link('cross-session-timeline.ndjson'),
    fileChangeMatrix: link('file-change-matrix.json'),
    dependencyImpact: link('dependency-impact.json'),
    artifactReproducibility: link('artifact-reproducibility.json'),
    projectSnapshot: link('project-snapshot.json'),
    openEvidenceQuestions: link('open-evidence-questions.json'),
    decisionConflicts: link('decision-conflicts.json'),
    knowledgeCoverage: link('coverage.json'),
    activeReadLog: link('active-read-log.ndjson'),
  };
}

async function writeProjectKnowledgeV4Artifacts(outputDir, knowledge) {
  if (!knowledge) return;
  await Promise.all([
    fsp.writeFile(path.join(outputDir, 'project-knowledge-v4.json'), JSON.stringify(knowledge, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-knowledge-v4.md'), knowledgeV4Markdown(knowledge), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'semantic-stages.json'), JSON.stringify(knowledge.semanticStages || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'evidence-ledger.ndjson'), ndjson(knowledge.evidenceLedger), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-model.json'), JSON.stringify(knowledge.projectModel || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-graph.json'), JSON.stringify(knowledge.projectGraph || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'file-versions.ndjson'), ndjson(knowledge.fileVersions), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'artifact-lineage.json'), JSON.stringify(knowledge.artifactLineage || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'cross-session-timeline.ndjson'), ndjson(knowledge.crossSessionTimeline), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'file-change-matrix.json'), JSON.stringify(knowledge.fileChangeMatrix || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'dependency-impact.json'), JSON.stringify(knowledge.dependencyImpact || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'artifact-reproducibility.json'), JSON.stringify(knowledge.artifactReproducibility || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-snapshot.json'), JSON.stringify(knowledge.projectSnapshot || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'open-evidence-questions.json'), JSON.stringify(knowledge.openEvidenceQuestions || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'decision-conflicts.json'), JSON.stringify(knowledge.decisionConflicts || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify(knowledge.coverage || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'active-read-log.ndjson'), ndjson(knowledge.activeReadLog), 'utf8'),
  ]);
}

async function writePreviewEvidence(preview, outputDir) {
  const artifacts = await writeAnalysisArtifacts(preview.parsed, preview.analysis, outputDir);
  await Promise.all([
    fsp.writeFile(path.join(outputDir, 'source-sessions.json'), JSON.stringify(preview.sourceSet.sessions || [], null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-discovery.json'), JSON.stringify(preview.projectDiscovery, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-discovery.md'), projectDiscoveryMarkdown(preview.projectDiscovery), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-portfolio.json'), JSON.stringify(preview.projectPortfolio || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-portfolio.md'), projectPortfolioMarkdown(preview.projectPortfolio), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-evidence.json'), JSON.stringify(preview.projectEvidence || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-evidence.md'), projectEvidenceMarkdown(preview.projectEvidence), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-understanding.json'), JSON.stringify(preview.projectUnderstanding || null, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'project-understanding.md'), projectUnderstandingMarkdown(preview.projectUnderstanding), 'utf8'),
  ]);
  await writeProjectKnowledgeV4Artifacts(outputDir, preview.projectKnowledgeV4);
  return artifacts;
}

function publicAnalysisPayload(analysis, artifacts) {
  const projectDiscovery = analysis.projectDiscovery || analysis.projectEvidence?.discovery || null;
  const sessionsOnly = projectDiscovery?.mode === 'sessions-only';
  return {
    sessionId: analysis.source.sessionId,
    source: analysis.source,
    presentation: analysis.presentation,
    coverage: analysis.coverage,
    summary: analysis.summary,
    toolCatalog: analysis.toolCatalog,
    nestedToolCatalog: analysis.nestedToolCatalog,
    codeArtifacts: {
      fileChanges: analysis.codeArtifacts.fileChanges,
      commands: analysis.codeArtifacts.commands.slice(0, 160),
      fileExtensions: analysis.codeArtifacts.fileExtensions,
    },
    episodes: analysis.episodes,
    triggerLogic: analysis.triggerLogic,
    reusableCapabilities: analysis.reusableCapabilities,
    skillBlueprint: analysis.skillBlueprint,
    warnings: analysis.warnings,
    sourceSet: analysis.sourceSet || analysis.multiSource || null,
    projectDiscovery,
    sessionsOnlyProjectContext: sessionsOnly,
    scopePolicy: analysis.scopePolicy || null,
    projectPortfolio: compactProjectPortfolio(analysis.projectPortfolio),
    projectEvidenceSummary: analysis.projectEvidenceSummary || analysis.projectEvidence?.summary || null,
    projectEvidence: compactProjectEvidence(analysis.projectEvidence),
    projectUnderstanding: compactProjectUnderstanding(analysis.projectUnderstanding),
    projectKnowledgeV4: compactProjectKnowledgeV4(analysis.projectKnowledgeV4),
    artifacts,
  };
}

function publicAnalysis(result) {
  const { analysis, artifacts } = result;
  const outputKey = path.basename(artifacts.outputDir);
  return publicAnalysisPayload(analysis, {
    outputDir: artifacts.outputDir,
    report: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=report.html`,
    markdown: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=report.md`,
    analysis: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=analysis.json`,
    sources: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=source-sessions.json`,
    projectDiscovery: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-discovery.json`,
    projectDiscoveryMarkdown: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-discovery.md`,
    projectPortfolio: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-portfolio.json`,
    projectPortfolioMarkdown: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-portfolio.md`,
    projectEvidence: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-evidence.json`,
    projectEvidenceMarkdown: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-evidence.md`,
    projectUnderstanding: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-understanding.json`,
    projectUnderstandingMarkdown: `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=project-understanding.md`,
    ...knowledgeV4Links((artifact) => `/api/artifact?outputKey=${encodeURIComponent(outputKey)}&artifact=${encodeURIComponent(artifact)}`),
  });
}

function packageArtifactLink(packageKey, artifact) {
  return `/api/package-artifact?packageKey=${encodeURIComponent(packageKey)}&artifact=${encodeURIComponent(artifact)}`;
}

function packageArchiveLink(packageKey) {
  return packageArtifactLink(packageKey, '__archive__.zip');
}

function packageArtifactSet(manifest) {
  return new Set(Object.keys(manifest?.integrity?.artifacts || {}));
}

function firstPackageArtifact(artifacts, predicate) {
  return [...artifacts].find((artifact) => predicate(artifact)) || null;
}

function fallbackPackageDescription(manifest) {
  const packageInfo = manifest?.package || {};
  const naming = packageInfo.naming || {};
  const topics = naming.contentTopics || naming.subjects || [];
  const tools = naming.observedTools || [];
  const targets = packageInfo.targets || [];
  return {
    title: packageInfo.name || '已生成能力包',
    summary: topics.length
      ? `这是围绕“${topics.join('、')}”生成的能力包。可从本页直接查看说明、清单、ZIP 和独立 Agent 启动入口。`
      : '这是一个已生成的会话能力包。可从本页直接查看说明、清单、ZIP 和独立 Agent 启动入口。',
    namingExplanation: '该包由完整会话的主题、实际工具记录和文件证据自动命名。',
    phases: [],
    actualTools: tools,
    deliverables: targets.map((target) => ({
      skill: '可安装 Skill（复用会话工作流）',
      mcp: 'MCP 服务（提供会话证据与执行工具）',
      agent: '独立 Agent（提供中文操作界面）',
    })[target] || target),
    firstStep: '打开 README.md 阅读完整说明；需要实际操作时，解压 ZIP 并运行包根目录的启动器。',
  };
}

async function resolveStoredPackageRoot(packageKey) {
  if (!OUTPUT_KEY_RE.test(packageKey)) throw new Error('能力包目录标识不符合格式。');
  const root = path.resolve(CONVERSATION_PACKAGES_ROOT);
  const rootReal = await fsp.realpath(root);
  const candidate = path.resolve(rootReal, packageKey);
  const relative = path.relative(rootReal, candidate);
  if (!relative || relative.includes(path.sep) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('能力包目录超出允许的输出根目录。');
  }
  const packageRoot = await fsp.realpath(candidate);
  if (path.dirname(packageRoot) !== rootReal) throw new Error('能力包目录解析后超出允许的输出根目录。');
  return { rootReal, packageRoot };
}

function storedPackageDelivery(packageKey, packageRoot, artifacts) {
  const exists = (artifact) => artifacts.has(artifact);
  const file = (artifact) => exists(artifact) ? path.join(packageRoot, ...artifact.split('/')) : null;
  const link = (artifact) => exists(artifact) ? packageArtifactLink(packageKey, artifact) : null;
  const skillFile = firstPackageArtifact(artifacts, (artifact) => /^skill\/[^/]+\/SKILL\.md$/.test(artifact));
  const mcpServer = firstPackageArtifact(artifacts, (artifact) => /^mcp\/[^/]+-server\.mjs$/.test(artifact));
  const agentServer = exists('agent/agent-server.mjs') ? 'agent/agent-server.mjs' : null;
  const skill = skillFile && {
    root: path.dirname(file(skillFile)),
    installDirectory: null,
    skillFile: file(skillFile),
    interfaceFile: file(path.dirname(skillFile) + '/agents/openai.yaml'),
    runner: file(path.dirname(skillFile) + '/scripts/prepare-task.mjs'),
    links: {
      skill: link(skillFile),
      interface: link(path.dirname(skillFile) + '/agents/openai.yaml'),
      runner: link(path.dirname(skillFile) + '/scripts/prepare-task.mjs'),
    },
  };
  const mcp = mcpServer && {
    root: path.join(packageRoot, 'mcp'),
    server: file(mcpServer),
    config: file('mcp/mcp.config.example.json'),
    links: { server: link(mcpServer), config: link('mcp/mcp.config.example.json') },
  };
  const agent = agentServer && {
    root: path.join(packageRoot, 'agent'),
    server: file(agentServer),
    startCommand: 'node agent/launcher.mjs',
    aiProfile: file('agent/ai-profile.json'),
    readme: file('agent/README.md'),
    envExample: file('agent/.env.example'),
    launcher: file('agent/launcher.mjs'),
    projectUnderstanding: file('agent/project-understanding.json'),
    projectUnderstandingMarkdown: file('agent/project-understanding.md'),
    capability: file('agent/CAPABILITY.md'),
    priorityPlan: file('agent/PRIORITY-PLAN.md'),
    taskCatalog: file('agent/TASK-CATALOG.md'),
    recommendation: file('agent/recommendation.json'),
    evidenceManifest: file('agent/evidence-manifest.json'),
    install: {
      windows: { oneClick: file('install-and-start.cmd'), direct: file('launch.cmd') },
      posix: { oneClick: file('install-and-start.sh'), direct: file('launch.sh') },
    },
    ui: {
      root: path.join(packageRoot, 'agent', 'ui'),
      index: file('agent/ui/index.html'),
      app: file('agent/ui/app.js'),
      styles: file('agent/ui/styles.css'),
    },
    links: {
      server: link(agentServer),
      aiProfile: link('agent/ai-profile.json'),
      readme: link('agent/README.md'),
      envExample: link('agent/.env.example'),
      launcher: link('agent/launcher.mjs'),
      install: {
        windows: { oneClick: link('install-and-start.cmd'), direct: link('launch.cmd') },
        posix: { oneClick: link('install-and-start.sh'), direct: link('launch.sh') },
      },
      interface: link('agent/ui/index.html'),
      ui: { index: link('agent/ui/index.html'), app: link('agent/ui/app.js'), styles: link('agent/ui/styles.css') },
      distillation: link('agent/conversation-distillation.md'),
      distillationJson: link('agent/conversation-distillation.json'),
      projectUnderstanding: link('agent/project-understanding.json'),
      projectUnderstandingMarkdown: link('agent/project-understanding.md'),
      capability: link('agent/CAPABILITY.md'),
      priorityPlan: link('agent/PRIORITY-PLAN.md'),
      taskCatalog: link('agent/TASK-CATALOG.md'),
      recommendation: link('agent/recommendation.json'),
      evidenceManifest: link('agent/evidence-manifest.json'),
    },
  };
  return {
    skill,
    mcp,
    agent,
    distillation: {
      markdown: file('conversation-distillation.md'),
      json: file('conversation-distillation.json'),
      links: {
        markdown: link('conversation-distillation.md'),
        json: link('conversation-distillation.json'),
      },
    },
    projectUnderstanding: {
      json: file('project-understanding.json'),
      markdown: file('project-understanding.md'),
      links: {
        json: link('project-understanding.json'),
        markdown: link('project-understanding.md'),
      },
    },
    projectKnowledgeV4: {
      json: file('project-knowledge-v4.json'),
      markdown: file('project-knowledge-v4.md'),
      links: {
        json: link('project-knowledge-v4.json'),
        markdown: link('project-knowledge-v4.md'),
        ...knowledgeV4Links(link),
      },
    },
  };
}

async function storedPackageResult(packageKey, includeAnalysis = false) {
  const { rootReal, packageRoot } = await resolveStoredPackageRoot(packageKey);
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const artifacts = packageArtifactSet(manifest);
  let description = fallbackPackageDescription(manifest);
  if (artifacts.has('package-description.json')) {
    try {
      description = { ...description, ...JSON.parse(await fsp.readFile(path.join(packageRoot, 'package-description.json'), 'utf8')) };
    } catch {
      // 保持从清单恢复的最小可用说明，避免单个说明文件损坏隐藏整个能力包。
    }
  }
  let sourceSessions = manifest.selection?.sessions || [];
  let projectDiscovery = null;
  let projectPortfolio = null;
  let projectEvidence = null;
  let projectUnderstanding = null;
  let projectKnowledgeV4 = null;
  let releaseDecision = manifest.releaseDecision || null;
  const releaseValidation = {};
  if (artifacts.has('source-sessions.json')) {
    try { sourceSessions = JSON.parse(await fsp.readFile(path.join(packageRoot, 'source-sessions.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('project-discovery.json')) {
    try { projectDiscovery = JSON.parse(await fsp.readFile(path.join(packageRoot, 'project-discovery.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('project-portfolio.json')) {
    try { projectPortfolio = JSON.parse(await fsp.readFile(path.join(packageRoot, 'project-portfolio.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('project-evidence.json')) {
    try { projectEvidence = JSON.parse(await fsp.readFile(path.join(packageRoot, 'project-evidence.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('project-understanding.json')) {
    try { projectUnderstanding = JSON.parse(await fsp.readFile(path.join(packageRoot, 'project-understanding.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('project-knowledge-v4.json')) {
    try { projectKnowledgeV4 = JSON.parse(await fsp.readFile(path.join(packageRoot, 'project-knowledge-v4.json'), 'utf8')); } catch {}
  }
  if (artifacts.has('release-decision.json')) {
    try { releaseDecision = (JSON.parse(await fsp.readFile(path.join(packageRoot, 'release-decision.json'), 'utf8'))).releaseDecision || releaseDecision; } catch {}
  }
  for (const [key, artifact] of Object.entries({ deterministicReplay: 'deterministic-replay.json', originalTaskReplay: 'original-task-replay.json', heldOutEvaluation: 'held-out-evaluation.json', isolatedAgentValidation: 'isolated-agent-validation.json' })) {
    if (!artifacts.has(artifact)) continue;
    try { releaseValidation[key] = JSON.parse(await fsp.readFile(path.join(packageRoot, artifact), 'utf8')); } catch {}
  }
  const archivePath = path.join(rootReal, `${packageKey}.zip`);
  const archive = fs.existsSync(archivePath) ? archivePath : null;
  const payload = {
    packageKey,
    generatedAt: manifest.generatedAt || null,
    package: {
      id: manifest.package?.id || packageKey,
      name: manifest.package?.name || description.title || packageKey,
      root: packageRoot,
      manifest: manifestPath,
      archive,
      description,
      selection: manifest.selection || {},
      sourceSet: {
        mode: manifest.selection?.mode || 'whole-session',
        sessionCount: Number(manifest.selection?.sessionCount || sourceSessions.length || 1),
        sessions: sourceSessions,
      },
      projectDiscovery,
      projectPortfolio: compactProjectPortfolio(projectPortfolio),
      projectEvidenceSummary: projectEvidence?.summary || null,
      projectUnderstanding: compactProjectUnderstanding(projectUnderstanding),
      projectKnowledgeV4: compactProjectKnowledgeV4(projectKnowledgeV4),
      naming: manifest.package?.naming || {},
      releaseDecision,
      releaseValidation,
      targets: manifest.package?.targets || [],
      links: {
        manifest: packageArtifactLink(packageKey, 'package-manifest.json'),
        guide: linkIfPresent(packageKey, artifacts, 'README.md'),
        description: linkIfPresent(packageKey, artifacts, 'package-description.json'),
        capability: linkIfPresent(packageKey, artifacts, 'CAPABILITY.md'),
        priorityPlan: linkIfPresent(packageKey, artifacts, 'PRIORITY-PLAN.md'),
        taskCatalog: linkIfPresent(packageKey, artifacts, 'TASK-CATALOG.md'),
        recommendation: linkIfPresent(packageKey, artifacts, 'recommendation.json'),
        recommendationHtml: linkIfPresent(packageKey, artifacts, 'distillation-recommendation.html'),
        evidenceManifest: linkIfPresent(packageKey, artifacts, 'evidence-manifest.json'),
        workCapability: linkIfPresent(packageKey, artifacts, 'work-capability-ir.v2.json'),
        coverageMatrix: linkIfPresent(packageKey, artifacts, 'coverage-matrix.json'),
        coverageGaps: linkIfPresent(packageKey, artifacts, 'coverage-gaps.json'),
        releaseDecision: linkIfPresent(packageKey, artifacts, 'release-decision.json'),
        deterministicReplay: linkIfPresent(packageKey, artifacts, 'deterministic-replay.json'),
        originalTaskReplay: linkIfPresent(packageKey, artifacts, 'original-task-replay.json'),
        heldOutEvaluation: linkIfPresent(packageKey, artifacts, 'held-out-evaluation.json'),
        isolatedAgentValidation: linkIfPresent(packageKey, artifacts, 'isolated-agent-validation.json'),
        archive: archive ? packageArchiveLink(packageKey) : null,
        workflow: linkIfPresent(packageKey, artifacts, 'workflow-blueprint.json'),
        distillation: linkIfPresent(packageKey, artifacts, 'conversation-distillation.md'),
        distillationJson: linkIfPresent(packageKey, artifacts, 'conversation-distillation.json'),
        verify: linkIfPresent(packageKey, artifacts, 'verify.mjs'),
        evidenceReport: linkIfPresent(packageKey, artifacts, 'evidence/report.html'),
        sources: linkIfPresent(packageKey, artifacts, 'source-sessions.json'),
        projectDiscovery: linkIfPresent(packageKey, artifacts, 'project-discovery.json'),
        projectDiscoveryMarkdown: linkIfPresent(packageKey, artifacts, 'project-discovery.md'),
        projectPortfolio: linkIfPresent(packageKey, artifacts, 'project-portfolio.json'),
        projectPortfolioMarkdown: linkIfPresent(packageKey, artifacts, 'project-portfolio.md'),
        projectEvidence: linkIfPresent(packageKey, artifacts, 'project-evidence.json'),
        projectEvidenceMarkdown: linkIfPresent(packageKey, artifacts, 'project-evidence.md'),
        projectUnderstanding: linkIfPresent(packageKey, artifacts, 'project-understanding.json'),
        projectUnderstandingMarkdown: linkIfPresent(packageKey, artifacts, 'project-understanding.md'),
        ...knowledgeV4Links((artifact) => linkIfPresent(packageKey, artifacts, artifact)),
      },
      delivery: storedPackageDelivery(packageKey, packageRoot, artifacts),
    },
    verification: {
      status: 'manifested',
      artifactCount: artifacts.size,
      checks: ['已从能力包完整性清单恢复可展示文件。'],
    },
  };
  if (includeAnalysis && artifacts.has('evidence/analysis.json')) {
    try {
      const analysis = JSON.parse(await fsp.readFile(path.join(packageRoot, 'evidence', 'analysis.json'), 'utf8'));
      analysis.sourceSet ||= { mode: manifest.selection?.mode || 'whole-session', sessionCount: Number(manifest.selection?.sessionCount || sourceSessions.length || 1), sessions: sourceSessions };
      analysis.projectDiscovery ||= projectDiscovery;
      analysis.projectPortfolio ||= projectPortfolio;
      analysis.projectEvidence ||= projectEvidence;
      analysis.projectEvidenceSummary ||= projectEvidence?.summary || null;
      analysis.projectUnderstanding ||= projectUnderstanding;
      analysis.projectKnowledgeV4 ||= projectKnowledgeV4;
      payload.analysis = publicAnalysisPayload(analysis, {
        outputDir: path.join(packageRoot, 'evidence'),
        report: packageArtifactLink(packageKey, 'evidence/report.html'),
        markdown: packageArtifactLink(packageKey, 'evidence/report.md'),
        analysis: packageArtifactLink(packageKey, 'evidence/analysis.json'),
        sources: packageArtifactLink(packageKey, 'source-sessions.json'),
        projectDiscovery: packageArtifactLink(packageKey, 'project-discovery.json'),
        projectDiscoveryMarkdown: packageArtifactLink(packageKey, 'project-discovery.md'),
        projectPortfolio: packageArtifactLink(packageKey, 'project-portfolio.json'),
        projectPortfolioMarkdown: packageArtifactLink(packageKey, 'project-portfolio.md'),
        projectEvidence: packageArtifactLink(packageKey, 'project-evidence.json'),
        projectEvidenceMarkdown: packageArtifactLink(packageKey, 'project-evidence.md'),
        projectUnderstanding: packageArtifactLink(packageKey, 'project-understanding.json'),
        projectUnderstandingMarkdown: packageArtifactLink(packageKey, 'project-understanding.md'),
        ...knowledgeV4Links((artifact) => packageArtifactLink(packageKey, artifact)),
      });
    } catch {
      // 能力包的说明和下载入口仍可用；损坏的证据索引不阻断查看包。
    }
  }
  return payload;
}

function linkIfPresent(packageKey, artifacts, artifact) {
  return artifacts.has(artifact) ? packageArtifactLink(packageKey, artifact) : null;
}

async function storedPackageListItem(item) {
  const { rootReal, packageRoot } = await resolveStoredPackageRoot(item.packageKey);
  const manifest = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package-manifest.json'), 'utf8'));
  const artifacts = packageArtifactSet(manifest);
  let description = fallbackPackageDescription(manifest);
  if (artifacts.has('package-description.json')) {
    try {
      description = { ...description, ...JSON.parse(await fsp.readFile(path.join(packageRoot, 'package-description.json'), 'utf8')) };
    } catch {
      // 列表仍使用清单内的标题和命名依据，不让单个简介文件阻断历史入口。
    }
  }
  const archivePath = path.join(rootReal, `${item.packageKey}.zip`);
  const selection = manifest.selection || {};
  return {
    packageKey: item.packageKey,
    generatedAt: manifest.generatedAt || null,
    modifiedAt: new Date(item.modifiedAt).toISOString(),
    package: {
      id: manifest.package?.id || item.packageKey,
      name: manifest.package?.name || description.title || item.packageKey,
      root: packageRoot,
      description: {
        title: description.title || manifest.package?.name || item.packageKey,
        summary: description.summary || '',
        namingExplanation: description.namingExplanation || '',
        phases: Array.isArray(description.phases) ? description.phases.slice(0, 16) : [],
      },
      selection: {
        mode: selection.mode || 'whole-session',
        recordCount: Number(selection.recordCount || 0),
        normalisedEventCount: Number(selection.normalisedEventCount || 0),
        sessionCount: Number(selection.sessionCount || 1),
      },
      naming: manifest.package?.naming || {},
      targets: manifest.package?.targets || [],
      links: {
        manifest: packageArtifactLink(item.packageKey, 'package-manifest.json'),
        guide: linkIfPresent(item.packageKey, artifacts, 'README.md'),
        description: linkIfPresent(item.packageKey, artifacts, 'package-description.json'),
        capability: linkIfPresent(item.packageKey, artifacts, 'CAPABILITY.md'),
        priorityPlan: linkIfPresent(item.packageKey, artifacts, 'PRIORITY-PLAN.md'),
        taskCatalog: linkIfPresent(item.packageKey, artifacts, 'TASK-CATALOG.md'),
        archive: fs.existsSync(archivePath) ? packageArchiveLink(item.packageKey) : null,
      },
    },
    verification: {
      status: 'manifested',
      artifactCount: artifacts.size,
    },
  };
}

async function listStoredPackagesPage(limit, offset = 0) {
  const root = path.resolve(CONVERSATION_PACKAGES_ROOT);
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { packages: [], total: 0, nextOffset: null };
    throw error;
  }
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && OUTPUT_KEY_RE.test(entry.name))
    .map(async (entry) => {
      const candidate = path.join(root, entry.name);
      try {
        const stat = await fsp.stat(candidate);
        return { packageKey: entry.name, modifiedAt: stat.mtimeMs };
      } catch {
        return null;
      }
    }));
  const ordered = candidates.filter(Boolean).sort((left, right) => right.modifiedAt - left.modifiedAt);
  const page = ordered.slice(offset, offset + limit);
  const results = await Promise.all(page.map(async (item) => {
    try {
      return await storedPackageListItem(item);
    } catch {
      return null;
    }
  }));
  return {
    packages: results.filter(Boolean),
    total: ordered.length,
    nextOffset: offset + limit < ordered.length ? offset + limit : null,
  };
}

async function listStoredPackages(limit) {
  return (await listStoredPackagesPage(limit, 0)).packages;
}

function publicPackageResult(result) {
  const packageKey = path.basename(result.package.root);
  const delivery = result.package.delivery;
  const packageArtifact = (artifact) => packageArtifactLink(packageKey, artifact);
  const existingPackageFile = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const filePath = path.isAbsolute(candidate) ? candidate : path.join(result.package.root, candidate);
      const relative = path.relative(result.package.root, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) continue;
      return { path: filePath, link: packageArtifact(relative.split(path.sep).join('/')) };
    }
    return null;
  };
  const skill = delivery.skill && {
    root: delivery.skill.root,
    installDirectory: delivery.skill.installDirectory,
    skillFile: delivery.skill.skillFile,
    interfaceFile: delivery.skill.interfaceFile,
    runner: delivery.skill.runner,
    links: {
      skill: packageArtifact(path.relative(result.package.root, delivery.skill.skillFile).split(path.sep).join('/')),
      interface: packageArtifact(path.relative(result.package.root, delivery.skill.interfaceFile).split(path.sep).join('/')),
      runner: packageArtifact(path.relative(result.package.root, delivery.skill.runner).split(path.sep).join('/')),
    },
  };
  const mcp = delivery.mcp && {
    root: delivery.mcp.root,
    server: delivery.mcp.server,
    config: delivery.mcp.config,
    links: {
      server: packageArtifact(path.relative(result.package.root, delivery.mcp.server).split(path.sep).join('/')),
      config: packageArtifact(path.relative(result.package.root, delivery.mcp.config).split(path.sep).join('/')),
    },
  };
  const agent = delivery.agent && (() => {
    const agentRoot = delivery.agent.root;
    const ui = delivery.agent.ui || delivery.agent.uiFiles || {};
    const install = delivery.agent.install || {};
    const readme = existingPackageFile(delivery.agent.readme, delivery.agent.readmeFile, path.join(agentRoot, 'README.md'));
    const envExample = existingPackageFile(
      delivery.agent.envExample,
      delivery.agent.envExampleFile,
      delivery.agent.envFile,
      path.join(agentRoot, '.env.example'),
    );
    const aiProfile = existingPackageFile(
      delivery.agent.aiProfile,
      delivery.agent.aiProfileFile,
      path.join(agentRoot, 'ai-profile.json'),
      path.join(agentRoot, 'agent-profile.json'),
    );
    const uiIndex = existingPackageFile(ui.index, ui.indexFile, delivery.agent.uiIndex, path.join(agentRoot, 'ui', 'index.html'));
    const uiApp = existingPackageFile(ui.app, ui.appFile, delivery.agent.uiApp, path.join(agentRoot, 'ui', 'app.js'));
    const uiStyles = existingPackageFile(ui.styles, ui.stylesFile, delivery.agent.uiStyles, path.join(agentRoot, 'ui', 'styles.css'));
    const launcher = existingPackageFile(delivery.agent.launcher, delivery.agent.launcherFile, path.join(agentRoot, 'launcher.mjs'));
    const projectUnderstanding = existingPackageFile(
      delivery.agent.projectUnderstanding,
      delivery.agent.projectUnderstandingFile,
      path.join(agentRoot, 'project-understanding.json'),
    );
    const projectUnderstandingMarkdown = existingPackageFile(
      delivery.agent.projectUnderstandingMarkdown,
      delivery.agent.projectUnderstandingMarkdownFile,
      path.join(agentRoot, 'project-understanding.md'),
    );
    const projectKnowledgeV4 = existingPackageFile(
      delivery.agent.projectKnowledgeV4?.json,
      delivery.agent.projectKnowledgeV4File,
      path.join(agentRoot, 'project-knowledge-v4.json'),
    );
    const projectKnowledgeV4Markdown = existingPackageFile(
      delivery.agent.projectKnowledgeV4?.markdown,
      delivery.agent.projectKnowledgeV4MarkdownFile,
      path.join(agentRoot, 'project-knowledge-v4.md'),
    );
    const capability = existingPackageFile(delivery.agent.capability, path.join(agentRoot, 'CAPABILITY.md'));
    const priorityPlan = existingPackageFile(delivery.agent.priorityPlan, path.join(agentRoot, 'PRIORITY-PLAN.md'));
    const taskCatalog = existingPackageFile(delivery.agent.taskCatalog, path.join(agentRoot, 'TASK-CATALOG.md'));
    const recommendation = existingPackageFile(delivery.agent.recommendation?.json, delivery.agent.recommendation, path.join(agentRoot, 'recommendation.json'));
    const evidenceManifest = existingPackageFile(delivery.agent.evidenceManifest, path.join(agentRoot, 'evidence-manifest.json'));
    const windowsOneClick = existingPackageFile(install.windows?.oneClick, install.windows?.installer, path.join(result.package.root, 'install-and-start.cmd'));
    const windowsDirect = existingPackageFile(install.windows?.direct, path.join(result.package.root, 'launch.cmd'));
    const posixOneClick = existingPackageFile(install.posix?.oneClick, path.join(result.package.root, 'install-and-start.sh'));
    const posixDirect = existingPackageFile(install.posix?.direct, path.join(result.package.root, 'launch.sh'));
    const server = existingPackageFile(delivery.agent.server, delivery.agent.serverFile);
    return {
      root: agentRoot,
      server: server?.path || delivery.agent.server || delivery.agent.serverFile || null,
      startCommand: delivery.agent.startCommand,
      aiProfile: aiProfile?.path || null,
      readme: readme?.path || null,
      envExample: envExample?.path || null,
      launcher: launcher?.path || null,
      projectUnderstanding: projectUnderstanding?.path || null,
      projectUnderstandingMarkdown: projectUnderstandingMarkdown?.path || null,
      projectKnowledgeV4: projectKnowledgeV4?.path || null,
      projectKnowledgeV4Markdown: projectKnowledgeV4Markdown?.path || null,
      capability: capability?.path || null,
      priorityPlan: priorityPlan?.path || null,
      taskCatalog: taskCatalog?.path || null,
      recommendation: recommendation?.path || null,
      evidenceManifest: evidenceManifest?.path || null,
      install: {
        windows: { oneClick: windowsOneClick?.path || null, direct: windowsDirect?.path || null },
        posix: { oneClick: posixOneClick?.path || null, direct: posixDirect?.path || null },
      },
      ui: {
        root: path.join(agentRoot, 'ui'),
        index: uiIndex?.path || null,
        app: uiApp?.path || null,
        styles: uiStyles?.path || null,
      },
      links: {
        server: server?.link || null,
        aiProfile: aiProfile?.link || null,
        readme: readme?.link || null,
        envExample: envExample?.link || null,
        launcher: launcher?.link || null,
        projectUnderstanding: projectUnderstanding?.link || null,
        projectUnderstandingMarkdown: projectUnderstandingMarkdown?.link || null,
        projectKnowledgeV4: projectKnowledgeV4?.link || null,
        projectKnowledgeV4Markdown: projectKnowledgeV4Markdown?.link || null,
        capability: capability?.link || null,
        priorityPlan: priorityPlan?.link || null,
        taskCatalog: taskCatalog?.link || null,
        recommendation: recommendation?.link || null,
        evidenceManifest: evidenceManifest?.link || null,
        install: {
          windows: { oneClick: windowsOneClick?.link || null, direct: windowsDirect?.link || null },
          posix: { oneClick: posixOneClick?.link || null, direct: posixDirect?.link || null },
        },
        interface: uiIndex?.link || null,
        ui: {
          index: uiIndex?.link || null,
          app: uiApp?.link || null,
          styles: uiStyles?.link || null,
        },
      },
    };
  })();
  return {
    packageKey,
    package: {
      packageKey,
      id: result.package.id,
      name: result.package.name,
      root: result.package.root,
      manifest: result.package.manifest,
      archive: result.package.archive,
      description: result.package.description || result.package.naming?.description || null,
      selection: result.package.selection,
      sourceSet: result.package.sourceSet || {
        mode: result.package.selection?.mode || 'whole-session',
        sessionCount: Number(result.package.selection?.sessionCount || result.package.selection?.sessions?.length || 1),
        sessions: result.package.selection?.sessions || [],
      },
      projectDiscovery: result.package.projectDiscovery || result.analysis?.projectDiscovery || null,
      projectPortfolio: compactProjectPortfolio(result.package.projectPortfolio || result.analysis?.projectPortfolio),
      projectEvidenceSummary: result.package.projectEvidenceSummary || result.analysis?.projectEvidence?.summary || null,
      projectUnderstanding: compactProjectUnderstanding(result.package.projectUnderstanding || result.analysis?.projectUnderstanding),
      projectKnowledgeV4: compactProjectKnowledgeV4(result.package.projectKnowledgeV4 || result.analysis?.projectKnowledgeV4),
      naming: result.package.naming,
      links: {
        manifest: packageArtifact('package-manifest.json'),
        guide: packageArtifact('README.md'),
        description: packageArtifact('package-description.json'),
        capability: packageArtifact('CAPABILITY.md'),
        priorityPlan: packageArtifact('PRIORITY-PLAN.md'),
        taskCatalog: packageArtifact('TASK-CATALOG.md'),
        recommendation: packageArtifact('recommendation.json'),
        recommendationHtml: packageArtifact('distillation-recommendation.html'),
        evidenceManifest: packageArtifact('evidence-manifest.json'),
        workCapability: packageArtifact('work-capability-ir.v2.json'),
        coverageMatrix: packageArtifact('coverage-matrix.json'),
        coverageGaps: packageArtifact('coverage-gaps.json'),
        releaseDecision: packageArtifact('release-decision.json'),
        deterministicReplay: packageArtifact('deterministic-replay.json'),
        originalTaskReplay: packageArtifact('original-task-replay.json'),
        heldOutEvaluation: packageArtifact('held-out-evaluation.json'),
        isolatedAgentValidation: packageArtifact('isolated-agent-validation.json'),
        archive: packageArchiveLink(packageKey),
        workflow: packageArtifact('workflow-blueprint.json'),
        verify: packageArtifact('verify.mjs'),
        evidenceReport: packageArtifact('evidence/report.html'),
        sources: packageArtifact('source-sessions.json'),
        projectDiscovery: packageArtifact('project-discovery.json'),
        projectDiscoveryMarkdown: packageArtifact('project-discovery.md'),
        projectPortfolio: packageArtifact('project-portfolio.json'),
        projectPortfolioMarkdown: packageArtifact('project-portfolio.md'),
        projectEvidence: packageArtifact('project-evidence.json'),
        projectEvidenceMarkdown: packageArtifact('project-evidence.md'),
        projectUnderstanding: packageArtifact('project-understanding.json'),
        projectUnderstandingMarkdown: packageArtifact('project-understanding.md'),
        ...knowledgeV4Links(packageArtifact),
      },
      delivery: { skill, mcp, agent },
    },
    analysis: publicAnalysisPayload(result.analysis, {
      outputDir: path.join(result.package.root, 'evidence'),
      report: packageArtifact('evidence/report.html'),
      markdown: packageArtifact('evidence/report.md'),
      analysis: packageArtifact('evidence/analysis.json'),
      sources: packageArtifact('source-sessions.json'),
      projectDiscovery: packageArtifact('project-discovery.json'),
      projectDiscoveryMarkdown: packageArtifact('project-discovery.md'),
      projectPortfolio: packageArtifact('project-portfolio.json'),
      projectPortfolioMarkdown: packageArtifact('project-portfolio.md'),
      projectEvidence: packageArtifact('project-evidence.json'),
      projectEvidenceMarkdown: packageArtifact('project-evidence.md'),
      projectUnderstanding: packageArtifact('project-understanding.json'),
      projectUnderstandingMarkdown: packageArtifact('project-understanding.md'),
      ...knowledgeV4Links(packageArtifact),
    }),
    verification: result.verification,
  };
}

async function readBody(request, maxSize = JSON_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new Error('请求内容过大，请缩短输入后重试。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function readRawBody(request, maxSize = CHATGPT_EXPORT_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new Error('导入文件过大，请选择单个不超过 768MB 的官方导出 ZIP。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normaliseStringList(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\r\n,;]+/) : [];
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function optionalText(value) {
  const result = String(value || '').trim();
  return result || undefined;
}

function runLinks(runId) {
  const base = `/api/v2/runs/${encodeURIComponent(runId)}`;
  return {
    self: base,
    recommendation: `${base}/recommendation`,
    recommendationHtml: `${base}/recommendation.html`,
    recommendationMarkdown: `${base}/recommendation.md`,
    priorities: `${base}/priorities`,
    reprioritize: `${base}/reprioritize`,
    package: `${base}/package`,
    evidenceManifest: `${base}/evidence-manifest.json`,
  };
}

function publicDistillationRun(record) {
  const sessions = (record.sourceSet?.sessions || []).map((session) => ({
    sessionId: session.sessionId,
    title: session.title || '未命名会话',
    modifiedAt: session.modifiedAt || null,
    recordCount: session.recordCount || null,
    sha256: session.sha256 || null,
  }));
  return {
    runId: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    identity: record.identity,
    sourceSet: { mode: record.sourceSet?.mode || 'whole-session', sessionCount: sessions.length, sessions },
    selection: record.selection ? {
      selectionMode: record.selection.selectionMode || record.selection.workspaceSelection?.selectionMode || 'sessions',
      projectScope: record.selection.projectScope || 'sessions-only',
      contextMode: record.selection.contextMode || 'conversation-only',
      projectConfirmed: record.selection.projectConfirmed === true,
      projectContext: record.selection.projectContext || { enabled: false, mode: 'none' },
      snapshotId: record.selection.workspaceSelection?.snapshotId || null,
      catalogRevision: record.selection.workspaceSelection?.catalogRevision || null,
      workspaceIds: record.selection.workspaceSelection?.workspaceIds || [],
      workspaces: record.selection.workspaceSelection?.workspaces || [],
      sessionCount: sessions.length,
    } : null,
    project: {
      name: record.projectSummary?.name || record.projectEvidence?.project?.name || record.recommendation?.summary?.project || null,
      discoveryMode: record.projectDiscovery?.mode || null,
      discoveryReason: record.projectDiscovery?.reason || null,
      summary: record.projectSummary || null,
    },
    recommendation: record.recommendation,
    overrides: record.overrides || [],
    package: record.package || null,
    links: runLinks(record.id),
  };
}

function runEvidenceLinks(runId) {
  const base = `/api/v2/runs/${encodeURIComponent(runId)}/evidence-artifact`;
  const link = (artifact) => `${base}/${encodeURIComponent(artifact)}`;
  return {
    report: link('report.html'),
    markdown: link('report.md'),
    analysis: link('analysis.json'),
    sources: link('source-sessions.json'),
    projectDiscovery: link('project-discovery.json'),
    projectDiscoveryMarkdown: link('project-discovery.md'),
    projectPortfolio: link('project-portfolio.json'),
    projectPortfolioMarkdown: link('project-portfolio.md'),
    projectEvidence: link('project-evidence.json'),
    projectEvidenceMarkdown: link('project-evidence.md'),
    projectUnderstanding: link('project-understanding.json'),
    projectUnderstandingMarkdown: link('project-understanding.md'),
    ...knowledgeV4Links(link),
  };
}

async function readRunEvidenceArtifact(runId, artifact) {
  const allowed = new Set([
    'analysis.json', 'report.md', 'report.html', 'source-sessions.json',
    'project-discovery.json', 'project-discovery.md', 'project-portfolio.json', 'project-portfolio.md', 'project-evidence.json', 'project-evidence.md',
    'project-understanding.json', 'project-understanding.md', ...KNOWLEDGE_V4_ARTIFACTS,
  ]);
  if (!allowed.has(artifact)) throw new Error('该证据文件不在蒸馏任务可读取清单中。');
  const run = await readDistillationRun(runId);
  return fsp.readFile(path.join(run.root, 'evidence', artifact));
}

async function findStoredPackageKey(value) {
  const requested = String(value || '').trim();
  if (!requested) throw new Error('缺少能力包编号。');
  if (OUTPUT_KEY_RE.test(requested)) {
    try {
      await resolveStoredPackageRoot(requested);
      return requested;
    } catch {}
  }
  const packages = await listStoredPackages(5000);
  const found = packages.find((item) => item.package?.id === requested);
  if (!found) throw new Error('没有找到对应能力包。');
  return found.packageKey;
}

async function reserveLoopbackPort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('没有找到可用于独立 Agent 的本机端口。');
  return port;
}

async function waitForAgent(url, child, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`独立 Agent 启动进程已退出，代码 ${child.exitCode}。`);
    try {
      const response = await fetch(`${url}api/runtime/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
      lastError = new Error(`健康检查返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (!child.killed) child.kill();
  throw new Error(`独立 Agent 未能在 12 秒内启动：${lastError?.message || '没有响应'}`);
}

function appendAgentLog(record, stream, chunk) {
  const lines = String(chunk || '').replace(/\r/g, '').split('\n').filter(Boolean);
  const timestamp = new Date().toISOString();
  for (const line of lines) record.logs.push({ timestamp, stream, message: line });
  if (record.logs.length > AGENT_LOG_LIMIT) record.logs.splice(0, record.logs.length - AGENT_LOG_LIMIT);
}

function publicAgentState(record, extra = {}) {
  if (!record) return { status: 'stopped', running: false, logs: [], ...extra };
  return {
    packageKey: record.packageKey,
    packageId: record.packageId,
    status: record.status,
    running: record.status === 'running' || record.status === 'starting',
    url: record.url || null,
    port: record.port || null,
    pid: record.pid || null,
    startedAt: record.startedAt || null,
    stoppedAt: record.stoppedAt || null,
    exitCode: record.exitCode ?? null,
    error: record.error || null,
    logs: (record.logs || []).slice(-AGENT_LOG_LIMIT),
    ...extra,
  };
}

async function preflightStoredPackageAgent(packageReference) {
  const packageKey = await findStoredPackageKey(packageReference);
  const { packageRoot } = await resolveStoredPackageRoot(packageKey);
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  const agentRoot = path.join(packageRoot, 'agent');
  const serverFile = path.join(agentRoot, 'agent-server.mjs');
  const interfaceFile = path.join(agentRoot, 'ui', 'index.html');
  const checks = await Promise.all([
    ['能力包清单', manifestPath],
    ['Agent 服务程序', serverFile],
    ['Agent 操作界面', interfaceFile],
  ].map(async ([label, filePath]) => {
    try {
      await fsp.access(filePath, fs.constants.R_OK);
      return { label, ok: true, path: filePath };
    } catch {
      return { label, ok: false, path: filePath };
    }
  }));
  return {
    packageKey,
    packageRoot,
    agentRoot,
    serverFile,
    interfaceFile,
    ok: checks.every((item) => item.ok),
    checks,
  };
}

async function getStoredPackageAgentStatus(packageReference) {
  const preflight = await preflightStoredPackageAgent(packageReference);
  const record = launchedPackageAgents.get(preflight.packageKey);
  if (record && record.status === 'running' && record.url) {
    try {
      const response = await fetch(`${record.url}api/runtime/health`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error(`健康检查返回 ${response.status}`);
    } catch (error) {
      record.status = 'failed';
      record.error = `Agent 健康检查失败：${error.message}`;
      appendAgentLog(record, 'system', record.error);
    }
  }
  return publicAgentState(record, { preflight });
}

async function launchStoredPackageAgent(packageReference) {
  const preflight = await preflightStoredPackageAgent(packageReference);
  const { packageKey } = preflight;
  if (!preflight.ok) {
    const missing = preflight.checks.filter((item) => !item.ok).map((item) => item.label).join('、');
    throw new Error(`当前能力包缺少启动所需文件：${missing}。`);
  }
  const current = launchedPackageAgents.get(packageKey);
  if (current?.child?.exitCode === null && ['starting', 'running'].includes(current.status)) {
    return publicAgentState(current, { alreadyRunning: true, preflight });
  }
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, ['agent-server.mjs'], {
    cwd: preflight.agentRoot,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      CONVERSATION_AGENT_HOST: '127.0.0.1',
      CONVERSATION_AGENT_PORT: String(port),
    },
  });
  const launched = {
    packageId: packageReference,
    packageKey,
    url,
    port,
    pid: child.pid,
    child,
    status: 'starting',
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    error: null,
    logs: [],
  };
  launchedPackageAgents.set(packageKey, launched);
  appendAgentLog(launched, 'system', `正在启动当前能力包，端口 ${port}。`);
  child.stdout.on('data', (chunk) => appendAgentLog(launched, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendAgentLog(launched, 'stderr', chunk));
  child.once('error', (error) => {
    launched.status = 'failed';
    launched.error = `进程启动失败：${error.message}`;
    appendAgentLog(launched, 'system', launched.error);
  });
  child.once('exit', (code) => {
    launched.status = launched.status === 'stopping' || code === 0 ? 'stopped' : 'failed';
    launched.exitCode = code;
    launched.stoppedAt = new Date().toISOString();
    if (launched.status === 'failed' && !launched.error) launched.error = `独立 Agent 已退出，代码 ${code}。`;
    appendAgentLog(launched, 'system', launched.error || '独立 Agent 已停止。');
  });
  try {
    await waitForAgent(url, child);
    launched.status = 'running';
    appendAgentLog(launched, 'system', '健康检查通过，操作界面已可用。');
  } catch (error) {
    launched.status = 'failed';
    launched.error = error.message;
    appendAgentLog(launched, 'system', error.message);
    throw error;
  }
  return publicAgentState(launched, { alreadyRunning: false, preflight });
}

async function stopStoredPackageAgent(packageReference) {
  const packageKey = await findStoredPackageKey(packageReference);
  const record = launchedPackageAgents.get(packageKey);
  if (!record || record.child?.exitCode !== null) return publicAgentState(record, { alreadyStopped: true });
  record.status = 'stopping';
  appendAgentLog(record, 'system', '正在停止独立 Agent。');
  record.child.kill();
  return publicAgentState(record);
}

function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: 'aftercode API', version: '2.0.0', description: '会话选择、项目理解、P0-P3 建议、证据查看、优先级调整和专属能力包生成接口。' },
    servers: [{ url: `http://${HOST}:${PORT}`, description: '本机蒸馏器' }],
    paths: {
      '/api/v2/workspaces': { get: { summary: '完整扫描并按工作区归组本机 Codex 会话' } },
      '/api/v2/codex/sync': { post: { summary: '增量建立本机 Codex 会话索引' } },
      '/api/v2/codex/coverage': { get: { summary: '读取本机 Codex 会话索引覆盖率与变更数' } },
      '/api/v2/codex/sessions': { get: { summary: '读取全部已发现的本机 Codex 会话' } },
      '/api/v2/codex/sessions/{sessionId}': { get: { summary: '读取单条本机 Codex 会话的完整事件与工具内容' } },
      '/api/v2/session-search': { post: { summary: '搜索本机或网页端会话的标题、用户消息、助手回复、工具调用和附件内容' } },
      '/api/v2/workspace-selection/preview': { post: { summary: '预览工作区全选与会话例外后的实际范围' } },
      '/api/v2/project-context/preview': { post: { summary: '预览项目模式将读取和排除的相关文件' } },
      '/api/v2/runs': { post: { summary: '创建智能蒸馏任务' } },
      '/api/v2/runs/{runId}': { get: { summary: '读取蒸馏任务' } },
      '/api/v2/runs/{runId}/recommendation': { get: { summary: '读取结构化建议' } },
      '/api/v2/runs/{runId}/recommendation.html': { get: { summary: '打开中文建议网页' } },
      '/api/v2/runs/{runId}/recommendation.md': { get: { summary: '读取建议文档' } },
      '/api/v2/runs/{runId}/priorities': { get: { summary: '读取三套独立优先级判断' } },
      '/api/v2/runs/{runId}/evidence/{evidenceId}': { get: { summary: '读取单条判断证据' } },
      '/api/v2/runs/{runId}/reprioritize': { post: { summary: '强调、暂缓或恢复能力项' } },
      '/api/v2/runs/{runId}/package': { post: { summary: '按当前建议生成能力包' } },
      '/api/v2/packages/{packageId}': { get: { summary: '读取能力包' } },
      '/api/v2/packages/{packageId}/download': { get: { summary: '下载能力包 ZIP' } },
      '/api/v2/packages/{packageId}/launch': { post: { summary: '在本机工作台启动独立 Agent' } },
      '/api/v2/packages/{packageId}/agent/preflight': { get: { summary: '检查独立 Agent 启动条件' } },
      '/api/v2/packages/{packageId}/agent/status': { get: { summary: '读取独立 Agent 状态与日志' } },
      '/api/v2/packages/{packageId}/agent/start': { post: { summary: '启动当前能力包的独立 Agent' } },
      '/api/v2/packages/{packageId}/agent/stop': { post: { summary: '停止当前能力包的独立 Agent' } },
      '/api/v2/chatgpt/import/export': { post: { summary: '导入 ChatGPT 官方导出 ZIP，并建立完整会话索引' } },
      '/api/v2/chatgpt/coverage': { get: { summary: '查看 ChatGPT 官方导出与 Edge 网页捕获的覆盖率和对账结果' } },
      '/api/v2/chatgpt/conversations': { get: { summary: '按标题、来源或会话编号读取真实 ChatGPT 会话列表' } },
      '/api/v2/chatgpt/conversations/{conversationId}': { get: { summary: '查看单条 ChatGPT 会话的完整内容与来源证据' } },
      '/api/v2/chatgpt/conversations/{conversationId}/events': { get: { summary: '查看会话中的工具调用、代码执行、网页搜索和图片生成事件' } },
      '/api/v2/chatgpt/conversations/{conversationId}/assets': { get: { summary: '查看会话中的图片、文件、附件和远程资源引用' } },
      '/api/v2/chatgpt/conversations/{conversationId}/branches': { get: { summary: '查看会话消息节点、父子关系和当前分支路径' } },
      '/api/v2/chatgpt/conversations/{conversationId}/raw': { get: { summary: '查看会话原始网页接口载荷和载荷哈希' } },
      '/api/v2/chatgpt/reconciliation/refresh': { post: { summary: '重新扫描本地导入记录并刷新会话对账' } },
      '/api/v2/chatgpt/edge/discover': { post: { summary: '从已登录 Edge 页面发现真实 ChatGPT 会话目录' } },
      '/api/v2/chatgpt/edge/capture-all': { post: { summary: '按真实会话链接逐条读取 ChatGPT 全部聊天内容' } },
      '/api/v2/chatgpt/edge/resume': { post: { summary: '从持久化目录恢复未完成的网页会话读取' } },
      '/api/v2/chatgpt/edge/jobs/{jobId}': { get: { summary: '查看网页端批量读取的进度、成功数和失败数' } },
      '/api/v2/chatgpt/sync/{runId}': { get: { summary: '读取同步任务的实时状态或最近检查点' } },
      '/api/v2/chatgpt/sync/{runId}/events': { get: { summary: '读取同步任务的阶段事件和逐条处理记录' } },
      '/api/v2/chatgpt/sync/{runId}/pause': { post: { summary: '在当前批次检查点暂停同步任务' } },
      '/api/v2/chatgpt/sync/{runId}/resume': { post: { summary: '从最近检查点继续同步任务' } },
      '/api/v2/chatgpt/sync/{runId}/cancel': { post: { summary: '取消同步任务并保留已保存检查点' } },
      '/api/v2/chatgpt/sync/{runId}/retry-failed': { post: { summary: '只重新排队该任务中读取失败的会话' } },
      '/api/portable-workbench/build': { post: { summary: '生成 Windows 换机安装包' } },
      '/api/portable-workbench/download/{packageKey}': { get: { summary: '下载 Windows 换机安装包' } },
      '/api/web-chat/history/import': { post: { summary: '把真实网页历史目录保存为持久化会话列表' } },
    },
  };
}

function safeArtifactPath(outputKey, artifact) {
  if (!OUTPUT_KEY_RE.test(outputKey)) throw new Error('报告目录标识不符合格式。');
  if (!['analysis.json', 'report.md', 'report.html', 'source-sessions.json', 'project-discovery.json', 'project-discovery.md', 'project-portfolio.json', 'project-portfolio.md', 'project-evidence.json', 'project-evidence.md', 'project-understanding.json', 'project-understanding.md', ...KNOWLEDGE_V4_ARTIFACTS].includes(artifact)) throw new Error('当前仅允许读取报告、来源清单、项目组合、项目证据、项目理解和 V4 项目知识产物。');
  const outputDir = path.resolve(OUTPUT_ROOT, outputKey);
  const filePath = path.resolve(outputDir, artifact);
  if (path.dirname(filePath) !== outputDir) throw new Error('报告路径超出允许的输出目录。');
  return filePath;
}

function portableWorkbenchArchivePath(packageKey) {
  if (!/^(?:aftercode|work-capability-distiller)-windows-x64-\d{14}$/.test(packageKey)) {
    throw new Error('换机安装包标识不符合格式。');
  }
  const root = path.resolve(PORTABLE_WORKBENCH_OUTPUT_ROOT);
  const archivePath = path.resolve(root, `${packageKey}.zip`);
  if (path.dirname(archivePath) !== root) throw new Error('换机安装包路径超出允许的目录。');
  return archivePath;
}

async function safePackageArtifactPath(packageKey, artifact) {
  const { rootReal, packageRoot: packageReal } = await resolveStoredPackageRoot(packageKey);
  if (artifact === '__archive__.zip') {
    const archivePath = path.join(rootReal, `${packageKey}.zip`);
    const archiveReal = await fsp.realpath(archivePath);
    if (path.dirname(archiveReal) !== rootReal) throw new Error('能力包压缩包解析后超出允许的输出根目录。');
    return archiveReal;
  }
  const manifest = JSON.parse(await fsp.readFile(path.join(packageReal, 'package-manifest.json'), 'utf8'));
  const allowed = new Set(['package-manifest.json', ...Object.keys(manifest.integrity?.artifacts || {})]);
  if (!allowed.has(artifact)) throw new Error('读取范围仅限能力包生成清单中的文件。');
  const candidate = path.resolve(packageReal, ...artifact.split('/'));
  const relative = path.relative(packageReal, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('能力包文件路径超出根目录。');
  const fileReal = await fsp.realpath(candidate);
  const realRelative = path.relative(packageReal, fileReal);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('能力包文件解析后超出根目录。');
  return fileReal;
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (applyWebChatCompanionCors(request, response, url)) return;
  const webChatPath = webChatRoutePath(url.pathname);
  if (webChatPath !== null) {
    if (!isLoopbackRequest(request)) throw new Error('网页对话读取只能从本机工作台或本机浏览器伴侣发起。');
    if (request.method === 'GET' && webChatPath === '/') {
      sendJson(response, 200, { webChat: chatGptWeb.status() });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/open') {
      sendJson(response, 200, { webChat: chatGptWeb.openWebChat(await readBody(request)) });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/companion/open-folder') {
      sendJson(response, 200, { companion: chatGptWeb.openCompanionFolder() });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/companion/open-extensions') {
      const payload = await readBody(request);
      sendJson(response, 200, { extensionPage: chatGptWeb.openBrowserExtensions(payload?.browser || 'auto') });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/companion/setup') {
      const payload = await readBody(request);
      sendJson(response, 200, { setup: chatGptWeb.setupCompanion(payload) });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/disconnect') {
      sendJson(response, 200, { webChat: chatGptWeb.disconnect() });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/pair') {
      sendJson(response, 200, { pairing: chatGptWeb.pair(await readBody(request)) });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/heartbeat') {
      sendJson(response, 200, { heartbeat: chatGptWeb.heartbeat(request, await readBody(request)) });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/jobs') {
      sendJson(response, 201, { job: clientWebChatJob(chatGptWeb.enqueue(await readBody(request))) });
      return;
    }
    if (request.method === 'GET' && webChatPath === '/jobs/next') {
      sendJson(response, 200, chatGptWeb.nextJob(request));
      return;
    }
    const webChatJobCompleteMatch = webChatPath.match(/^\/jobs\/([^/]+)\/complete$/);
    if (request.method === 'POST' && webChatJobCompleteMatch) {
      const job = chatGptWeb.complete(request, decodeURIComponent(webChatJobCompleteMatch[1]), await readBody(request, WEB_CHAT_JSON_LIMIT));
      sendJson(response, 200, { job: clientWebChatJob(job) });
      return;
    }
    const webChatJobProgressMatch = webChatPath.match(/^\/jobs\/([^/]+)\/progress$/);
    if (request.method === 'POST' && webChatJobProgressMatch) {
      const jobId = decodeURIComponent(webChatJobProgressMatch[1]);
      const payload = await readBody(request, WEB_CHAT_JSON_LIMIT);
      const job = chatGptWeb.progress(request, jobId, payload);
      if (job.platform === 'chatgpt' && (payload?.snapshot || payload?.failure)) {
        const captures = payload.snapshot ? [payload.snapshot] : [];
        const failures = payload.failure ? [payload.failure] : [];
        if (payload.snapshot) {
          if (!webChatPersistedSourcesCache) webChatPersistedSourcesCache = await listPersistedWebChatImports(50_000);
          const source = await persistWebChatSnapshot(payload.snapshot, { existingSources: webChatPersistedSourcesCache });
          webChatPersistedSourcesCache = [source, ...webChatPersistedSourcesCache.filter((item) => item.sourcePath !== source.sourcePath)];
        }
        await checkpointChatGPTSyncJob({ root: CHATGPT_STORE_ROOT, jobId, captures, failures });
        await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId, patch: {
          status: job.control === 'pause' ? 'paused' : job.control === 'cancel' ? 'cancelled' : 'running',
          phase: job.control === 'pause' ? 'paused' : job.control === 'cancel' ? 'cancelled' : 'persisting',
          completedCount: job.completedCount,
          failedCount: job.failedCount,
          remainingCount: job.remainingCount,
          lastTitle: job.lastTitle,
          lastCheckpointAt: job.lastCheckpointAt,
          ratePerMinute: job.ratePerMinute,
          etaSeconds: job.etaSeconds,
        } });
      }
      sendJson(response, 200, { job: clientWebChatJob(job) });
      return;
    }
    const webChatJobControlMatch = webChatPath.match(/^\/jobs\/([^/]+)\/(pause|resume|cancel)$/);
    if (request.method === 'POST' && webChatJobControlMatch) {
      const jobId = decodeURIComponent(webChatJobControlMatch[1]);
      const action = webChatJobControlMatch[2];
      const job = action === 'pause' ? chatGptWeb.pauseJob(jobId) : action === 'resume' ? chatGptWeb.resumeJob(jobId) : chatGptWeb.cancelJob(jobId);
      if (job.platform === 'chatgpt') await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId, patch: {
        status: action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled',
        phase: action === 'pause' ? 'paused' : action === 'resume' ? 'capturing' : 'cancelled',
        completedCount: job.completedCount,
        failedCount: job.failedCount,
        remainingCount: job.remainingCount,
      } });
      sendJson(response, 200, { job: clientWebChatJob(job) });
      return;
    }
    const webChatJobMatch = webChatPath.match(/^\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && webChatJobMatch) {
      sendJson(response, 200, { job: clientWebChatJob(chatGptWeb.getJob(decodeURIComponent(webChatJobMatch[1]))) });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/imports') {
      const payload = await readBody(request);
      const source = await importWebChatJob(payload.jobId);
      sendJson(response, 201, { source, message: `已将 ${source.webChat.platformName} 对话加入本次会话选择。` });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/history/import') {
      const payload = await readBody(request);
      const result = await importWebChatHistoryJob(payload.jobId);
      sendJson(response, 201, { ...result, message: `已把 ${result.savedCount} 条网页历史保存到持久化列表；读取具体聊天后会更新同一条记录。` });
      return;
    }
    if (request.method === 'POST' && webChatPath === '/imports-batch') {
      const payload = await readBody(request);
      const result = await importWebChatBatchJob(payload.jobId);
      sendJson(response, 201, { ...result, message: `已将 ${result.capturedCount} 条真实网页会话保存到工作台。` });
      return;
    }
    sendText(response, 404, '未找到网页对话读取接口。');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/session-search') {
    if (!isLoopbackRequest(request)) throw new Error('会话全文搜索只能从本机工作台发起。');
    const payload = await readBody(request, WEB_CHAT_JSON_LIMIT);
    const scope = ['local', 'web', 'all'].includes(String(payload.scope || '').trim()) ? String(payload.scope).trim() : 'local';
    const query = String(payload.query || '').trim();
    if (!query) {
      sendJson(response, 200, { scope, query: '', matches: [], scannedCount: 0, matchedCount: 0, contentMatchCount: 0, metadataMatchCount: 0, truncated: false });
      return;
    }
    const limit = Math.max(1, Math.min(Number(payload.limit) || 250, 1000));
    const roots = normaliseStringList(payload.roots);
    const suppliedSources = Array.isArray(payload.sources) ? payload.sources.slice(0, SESSION_LIST_LIMIT).flatMap((source) => {
      const sourcePath = String(source?.sourcePath || '').trim();
      if (!sourcePath || !path.isAbsolute(sourcePath) || !['.json', '.jsonl', '.txt'].includes(path.extname(sourcePath).toLowerCase())) return [];
      return [{
        sourceKey: String(source.sourceKey || source.sessionId || sourcePath),
        sessionId: String(source.sessionId || '') || null,
        title: String(source.title || '未命名会话'),
        sourcePath: path.resolve(sourcePath),
        bytes: Number(source.bytes || 0),
        modifiedAt: source.modifiedAt || null,
        importKind: source.importKind === 'web-chat' ? 'web-chat' : 'codex',
        workspacePaths: normaliseStringList(source.workspacePaths).slice(0, 50),
        discoveredBy: normaliseStringList(source.discoveredBy).slice(0, 20),
        webChat: source.webChat && typeof source.webChat === 'object' ? {
          platform: String(source.webChat.platform || ''),
          platformName: String(source.webChat.platformName || ''),
          projectTitle: String(source.webChat.projectTitle || ''),
          userPreview: String(source.webChat.userPreview || ''),
          assistantPreview: String(source.webChat.assistantPreview || ''),
        } : null,
      }];
    }) : [];
    const sources = suppliedSources.filter((source) => scope === 'all' || (scope === 'web' ? source.importKind === 'web-chat' : source.importKind !== 'web-chat'));
    if (!sources.length && (scope === 'local' || scope === 'all')) {
      // Search uses the lightweight session catalog. Workspace grouping is intentionally
      // kept out of the query path because it is unrelated to matching message content.
      const catalogSources = await listSessionsCached({ roots, limit: SESSION_LIST_LIMIT, force: payload.refresh === true });
      sources.push(...catalogSources.filter((source) => source.importKind !== 'web-chat'));
    }
    if (!suppliedSources.length && (scope === 'web' || scope === 'all')) {
      if (!webChatPersistedSourcesCache || payload.refresh === true) webChatPersistedSourcesCache = await listPersistedWebChatImports(50_000);
      sources.push(...webChatPersistedSourcesCache);
    }
    if (payload.stream === true) {
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-search-scope': scope,
      });
      let clientGone = false;
      request.once('aborted', () => { clientGone = true; });
      response.once('close', () => {
        if (!response.writableEnded) clientGone = true;
      });
      const cacheKey = sessionSearchCacheKey({ scope, sources, query, limit });
      const memoryCached = sessionContentSearchCache.get(cacheKey);
      const cachedValue = memoryCached && Date.now() - memoryCached.createdAt < SESSION_SEARCH_CACHE_TTL_MS
        ? memoryCached.value
        : await readSessionSearchDiskCache(cacheKey);
      if (cachedValue) {
        if (!response.destroyed) {
          response.write(`${JSON.stringify({ type: 'progress', phase: 'cached', scope, query, scannedCount: cachedValue.scannedCount || sources.length, totalCount: sources.length, matches: cachedValue.matches || [], matchedCount: cachedValue.matchedCount || 0, contentMatchCount: cachedValue.contentMatchCount || 0, metadataMatchCount: cachedValue.metadataMatchCount || 0 })}\n`);
          response.write(`${JSON.stringify({ type: 'complete', scope, ...cachedValue, cached: true, persistentCache: !memoryCached })}\n`);
          response.end();
        }
        return;
      }
      const result = await searchSessionSourcesContent({
        sources,
        query,
        limit,
        shouldStop: () => clientGone || response.destroyed,
        onProgress: (progress) => {
          if (!clientGone && !response.destroyed) response.write(`${JSON.stringify({ type: 'progress', scope, query, ...progress })}\n`);
        },
      });
      sessionContentSearchCache.set(cacheKey, { createdAt: Date.now(), value: result });
      void writeSessionSearchDiskCache(cacheKey, result);
      if (!clientGone && !response.destroyed) {
        response.write(`${JSON.stringify({ type: 'complete', scope, ...result })}\n`);
        response.end();
      }
      return;
    }
    const result = await searchSessionSourcesCached({ scope, sources, query, limit });
    sendJson(response, 200, { scope, ...result });
    return;
  }
  if (url.pathname.startsWith('/api/v2/codex/')) {
    if (!isLoopbackRequest(request)) throw new Error('Codex 会话同步接口只允许本机工作台访问。');
    const roots = url.searchParams.getAll('root');
    if (request.method === 'POST' && url.pathname === '/api/v2/codex/sync') {
      const payload = await readBody(request);
      const catalog = await workspaceCatalogCached({ roots: normaliseStringList(payload.roots), force: true });
      const index = await syncCodexSessionIndex({ root: CODEX_STORE_ROOT, sources: catalog.sources, roots: catalog.roots, force: payload.force !== false });
      sendJson(response, 200, { coverage: codexCoverage(index), changes: index.changes, index });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/codex/coverage') {
      const catalog = await workspaceCatalogCached({ roots, force: url.searchParams.get('refresh') === '1' });
      const index = await syncCodexSessionIndex({ root: CODEX_STORE_ROOT, sources: catalog.sources, roots: catalog.roots, force: url.searchParams.get('refresh') === '1' });
      sendJson(response, 200, { coverage: codexCoverage(index), changes: index.changes, statistics: index.statistics });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/codex/sessions') {
      const index = await readCodexSessionIndex(CODEX_STORE_ROOT);
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-CN');
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 5000) || 5000, 5000));
      const entries = (index.entries || []).filter((entry) => entry.state !== 'removed' && (!query || [entry.title, entry.sessionId, entry.sourcePath].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query)))).slice(0, limit);
      sendJson(response, 200, { coverage: codexCoverage(index), records: entries, returnedCount: entries.length, complete: entries.length < limit });
      return;
    }
    const codexSessionMatch = url.pathname.match(/^\/api\/v2\/codex\/sessions\/([^/]+)$/);
    if (request.method === 'GET' && codexSessionMatch) {
      const sessionId = decodeURIComponent(codexSessionMatch[1]);
      const result = await readCodexSessionFromIndex({ root: CODEX_STORE_ROOT, sessionId, redact: url.searchParams.get('redact') !== '0' });
      if (!result) throw new Error('没有找到对应的本机 Codex 会话。');
      sendJson(response, 200, { schemaVersion: 'codex-session-v1', entry: result.entry, session: result.parsed });
      return;
    }
    sendText(response, 404, '没有找到 Codex 会话同步接口。');
    return;
  }
  if (url.pathname.startsWith('/api/v2/chatgpt/')) {
    if (!isLoopbackRequest(request)) throw new Error('ChatGPT 会话同步接口只允许本机工作台访问。');
    if (request.method === 'POST' && url.pathname === '/api/v2/chatgpt/import/export') {
      const raw = await readRawBody(request);
      if (!raw.length) throw new Error('请选择 ChatGPT 官方导出 ZIP 文件。');
      const originalName = decodeURIComponent(String(request.headers['x-file-name'] || '').trim())
        || String(request.headers['content-disposition'] || '').match(/filename="?([^";]+)"?/i)?.[1]
        || 'chatgpt-export.zip';
      const imported = await importChatGPTExport({ buffer: raw, root: CHATGPT_STORE_ROOT, originalName });
      const exportDirectory = path.join(WEB_CHAT_IMPORT_ROOT, 'chatgpt-export');
      const registeredSources = [];
      const registrationErrors = [];
      for (const record of imported.records) {
        try {
          const conversationId = String(record.conversationId || '').trim();
          const source = await persistWebChatSnapshot({
            platform: 'chatgpt',
            importKind: 'chatgpt-export',
            conversationId,
            title: record.title,
            url: record.url || (conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : ''),
            capturedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
            messages: record.messages,
          }, {
            sessionId: stableLocalSessionId(`chatgpt-export:${conversationId || record.title}`),
            targetDirectory: exportDirectory,
            allowEmpty: true,
          });
          registeredSources.push(source);
        } catch (error) {
          registrationErrors.push({ conversationId: record.conversationId || null, message: error.message });
        }
      }
      sessionListCache.clear();
      webChatPersistedSourcesCache = null;
      const coverage = await chatGPTCoveragePayload();
      sendJson(response, 201, {
        import: {
          runId: imported.manifest.runId,
          originalName: imported.manifest.originalName,
          recordCount: imported.manifest.recordCount,
          duplicateCount: imported.manifest.duplicateCount,
          sourcePath: imported.manifest.sourcePath,
        },
        registeredCount: registeredSources.length,
        registrationErrors,
        coverage,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/chatgpt/coverage') {
      sendJson(response, 200, await chatGPTCoveragePayload());
      return;
    }
    const syncRunMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/sync\/([^/]+)$/);
    if (request.method === 'GET' && syncRunMatch) {
      const jobId = decodeURIComponent(syncRunMatch[1]);
      try {
        sendJson(response, 200, { run: clientWebChatJob(chatGptWeb.getJob(jobId)), source: 'live' });
      } catch {
        const state = await readChatGPTSyncState(CHATGPT_STORE_ROOT);
        const run = state.runs?.[jobId];
        if (!run) throw new Error('没有找到对应的 ChatGPT 同步任务。');
        sendJson(response, 200, { run, source: 'checkpoint' });
      }
      return;
    }
    const syncRunEventsMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/sync\/([^/]+)\/events$/);
    if (request.method === 'GET' && syncRunEventsMatch) {
      const jobId = decodeURIComponent(syncRunEventsMatch[1]);
      try {
        const job = clientWebChatJob(chatGptWeb.getJob(jobId));
        sendJson(response, 200, { runId: jobId, events: job.events || [], count: job.events?.length || 0 });
      } catch {
        const state = await readChatGPTSyncState(CHATGPT_STORE_ROOT);
        const run = state.runs?.[jobId];
        if (!run) throw new Error('没有找到对应的 ChatGPT 同步任务。');
        sendJson(response, 200, { runId: jobId, events: [], count: 0, checkpoint: run });
      }
      return;
    }
    const syncRunRetryMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/sync\/([^/]+)\/retry-failed$/);
    if (request.method === 'POST' && syncRunRetryMatch) {
      const previousJobId = decodeURIComponent(syncRunRetryMatch[1]);
      const payload = await readBody(request, WEB_CHAT_JSON_LIMIT);
      const state = await readChatGPTSyncState(CHATGPT_STORE_ROOT);
      const previousRun = state.runs?.[previousJobId];
      if (!previousRun) throw new Error('没有找到对应的 ChatGPT 同步任务。');
      const failedIds = new Set((previousRun.failedIds?.length ? previousRun.failedIds : Object.entries(state.conversations || {}).filter(([, item]) => item.status === 'failed').map(([id]) => id)).filter(Boolean));
      const reconciliation = await readChatGPTReconciliation();
      const reconciledById = new Map((reconciliation.records || []).map((item) => [item.conversationId || chatGptConversationIdFromUrl(item.url), item]));
      const conversations = [...failedIds].map((id) => {
        const stateItem = state.conversations?.[id] || {};
        const reconciled = reconciledById.get(id) || {};
        const url = stateItem.url || reconciled.url || (String(id).includes('://') ? id : '');
        return {
          conversationId: stateItem.conversationId || reconciled.conversationId || chatGptConversationIdFromUrl(url) || id,
          title: stateItem.title || reconciled.title || '待读取 ChatGPT 会话',
          url,
          updatedAt: stateItem.updatedAt || reconciled.updatedAt || null,
          projectId: stateItem.projectId || reconciled.projectId || null,
          projectTitle: stateItem.projectTitle || reconciled.projectTitle || null,
        };
      }).filter((item) => item.url && item.url.includes('/c/'));
      if (!conversations.length) {
        sendJson(response, 200, { job: null, retriedCount: 0, message: '该任务没有带真实会话地址的失败记录；刷新真实会话列表后即可重新读取。' });
        return;
      }
      const plan = await planChatGPTIncrementalSync({ root: CHATGPT_STORE_ROOT, conversations, force: true });
      const job = chatGptWeb.enqueue({ type: 'capture-all', platform: payload.platform || 'chatgpt', conversations: plan.toFetch, skippedCount: 0 });
      await registerChatGPTSyncJob({ root: CHATGPT_STORE_ROOT, jobId: job.id, plan });
      await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId: job.id, patch: { retryOf: previousJobId, phase: 'queued' } });
      sendJson(response, 201, { job: clientWebChatJob(job), sync: plan.summary, retryOf: previousJobId, retriedCount: conversations.length });
      return;
    }
    const syncRunControlMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/sync\/([^/]+)\/(pause|resume|cancel)$/);
    if (request.method === 'POST' && syncRunControlMatch) {
      const jobId = decodeURIComponent(syncRunControlMatch[1]);
      const action = syncRunControlMatch[2];
      let job;
      try {
        job = action === 'pause' ? chatGptWeb.pauseJob(jobId) : action === 'resume' ? chatGptWeb.resumeJob(jobId) : chatGptWeb.cancelJob(jobId);
      } catch (error) {
        if (action !== 'resume') throw error;
        const state = await readChatGPTSyncState(CHATGPT_STORE_ROOT);
        const previousRun = state.runs?.[jobId];
        if (!previousRun) throw error;
        const reconciliation = await readChatGPTReconciliation();
        const recordsById = new Map((reconciliation.records || []).map((item) => [item.conversationId || chatGptConversationIdFromUrl(item.url), item]));
        const ids = previousRun.targetIds || Object.entries(state.conversations || {}).filter(([, item]) => item.status !== 'success').map(([id]) => id);
        const conversations = ids.map((id) => {
          const stateItem = state.conversations?.[id] || {};
          const record = recordsById.get(id) || {};
          const urlValue = stateItem.url || record.url || '';
          return { conversationId: stateItem.conversationId || record.conversationId || id, title: stateItem.title || record.title || '待读取 ChatGPT 会话', url: urlValue, updatedAt: stateItem.updatedAt || record.updatedAt || null, projectId: stateItem.projectId || record.projectId || null, projectTitle: stateItem.projectTitle || record.projectTitle || null };
        }).filter((item) => item.url && item.url.includes('/c/'));
        const plan = await planChatGPTIncrementalSync({ root: CHATGPT_STORE_ROOT, conversations, force: false });
        if (!plan.toFetch.length) {
          const run = await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId, patch: { status: 'completed', phase: 'reconciled', remainingCount: 0 } });
          sendJson(response, 200, { run, checkpoint: run, resumed: false, message: '检查点中的会话已经全部保存，无需继续读取。' });
          return;
        }
        job = chatGptWeb.enqueue({ type: 'capture-all', platform: 'chatgpt', conversations: plan.toFetch, skippedCount: plan.summary.skipped });
        await registerChatGPTSyncJob({ root: CHATGPT_STORE_ROOT, jobId: job.id, plan });
        await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId: job.id, patch: { resumedFrom: jobId, phase: 'queued' } });
      }
      const run = await updateChatGPTSyncRun({ root: CHATGPT_STORE_ROOT, jobId, patch: {
        status: action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled',
        phase: action === 'pause' ? 'paused' : action === 'resume' ? 'capturing' : 'cancelled',
        completedCount: job.completedCount,
        failedCount: job.failedCount,
        remainingCount: job.remainingCount,
      } });
      sendJson(response, 200, { run: clientWebChatJob(job), checkpoint: run });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/chatgpt/conversations') {
      const coverage = await chatGPTCoveragePayload();
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-CN');
      const sourceFilter = String(url.searchParams.get('source') || 'all').trim().toLowerCase();
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 5000) || 5000, 5000));
      const records = coverage.records.filter((item) => {
        const sourceMatch = sourceFilter === 'all' || item.sourceTypes?.some((source) => source.includes(sourceFilter));
        const queryMatch = !query || [item.title, item.url, item.conversationId].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
        return sourceMatch && queryMatch;
      }).slice(0, limit);
      sendJson(response, 200, { ...coverage, records, returnedCount: records.length, query, source: sourceFilter });
      return;
    }
    const conversationEventsMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/conversations\/([^/]+)\/(events|assets|branches|raw)$/);
    if (request.method === 'GET' && conversationEventsMatch) {
      const conversationId = decodeURIComponent(conversationEventsMatch[1]);
      const detail = await readPersistedWebChatRows(conversationId);
      if (!detail) throw new Error('没有找到对应的 ChatGPT 会话持久化内容。');
      const kind = conversationEventsMatch[2];
      if (kind === 'raw') {
        const raw = detail.rows.find((row) => row?.type === 'web_raw_detail')?.payload || null;
        sendJson(response, 200, { schemaVersion: 'chatgpt-conversation-raw-v1', conversationId, meta: detail.meta, raw });
        return;
      }
      const rowType = kind === 'events' ? 'web_event' : kind === 'assets' ? 'web_asset' : 'web_node';
      const values = detail.rows.filter((row) => row?.type === rowType).map((row) => row.payload).filter(Boolean);
      sendJson(response, 200, { schemaVersion: `chatgpt-conversation-${kind}-v1`, conversationId, meta: detail.meta, [kind]: values, count: values.length });
      return;
    }
    const conversationMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/conversations\/([^/]+)$/);
    if (request.method === 'GET' && conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1]);
      const coverage = await readChatGPTReconciliation();
      const record = coverage.records.find((item) => item.conversationId === conversationId || item.url.endsWith(`/c/${conversationId}`));
      if (!record) throw new Error('没有找到对应的 ChatGPT 会话。');
      sendJson(response, 200, { schemaVersion: 'chatgpt-conversation-v1', record });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v2/chatgpt/reconciliation/refresh') {
      sendJson(response, 200, await chatGPTCoveragePayload());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v2/chatgpt/edge/discover') {
      const payload = await readBody(request);
      const job = chatGptWeb.enqueue({ type: 'history-index', platform: payload.platform || 'chatgpt' });
      sendJson(response, 201, { job: clientWebChatJob(job) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v2/chatgpt/edge/capture-all') {
      const payload = await readBody(request, WEB_CHAT_JSON_LIMIT);
      const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
      const force = payload.force === true;
      const plan = String(payload.platform || 'chatgpt') === 'chatgpt'
        ? await planChatGPTIncrementalSync({ root: CHATGPT_STORE_ROOT, conversations, force })
        : { toFetch: conversations, skipped: [], summary: { total: conversations.length, toFetch: conversations.length, skipped: 0, forced: force } };
      if (!plan.toFetch.length) {
        sendJson(response, 200, { job: null, sync: plan.summary, message: '已检查全部会话，没有发现需要更新的内容。' });
        return;
      }
      const job = chatGptWeb.enqueue({ type: 'capture-all', platform: payload.platform || 'chatgpt', conversations: plan.toFetch, skippedCount: plan.summary.skipped });
      if (String(payload.platform || 'chatgpt') === 'chatgpt') await registerChatGPTSyncJob({ root: CHATGPT_STORE_ROOT, jobId: job.id, plan });
      sendJson(response, 201, { job: clientWebChatJob(job), sync: plan.summary });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v2/chatgpt/edge/resume') {
      const payload = await readBody(request, WEB_CHAT_JSON_LIMIT);
      const requested = Array.isArray(payload.conversations) ? payload.conversations : [];
      let conversations = requested;
      if (!conversations.length && String(payload.platform || 'chatgpt') === 'chatgpt') {
        const reconciliation = await readChatGPTReconciliation();
        conversations = reconciliation.records
          .filter((item) => item?.url && item.url.includes('/c/'))
          .map((item) => ({
            conversationId: item.conversationId || chatGptConversationIdFromUrl(item.url),
            title: item.title || '',
            url: item.url,
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null,
            projectId: item.projectId || null,
            projectTitle: item.projectTitle || null,
          }));
      }
      const force = payload.force === true;
      const plan = String(payload.platform || 'chatgpt') === 'chatgpt'
        ? await planChatGPTIncrementalSync({ root: CHATGPT_STORE_ROOT, conversations, force })
        : { toFetch: conversations, skipped: [], summary: { total: conversations.length, toFetch: conversations.length, skipped: 0, forced: force } };
      if (!plan.toFetch.length) {
        sendJson(response, 200, { job: null, sync: plan.summary, message: '已检查持久化目录，没有需要继续读取的网页会话。' });
        return;
      }
      const job = chatGptWeb.enqueue({ type: 'capture-all', platform: payload.platform || 'chatgpt', conversations: plan.toFetch, skippedCount: plan.summary.skipped });
      if (String(payload.platform || 'chatgpt') === 'chatgpt') await registerChatGPTSyncJob({ root: CHATGPT_STORE_ROOT, jobId: job.id, plan });
      sendJson(response, 201, { job: clientWebChatJob(job), sync: plan.summary, resumed: true });
      return;
    }
    const edgeJobMatch = url.pathname.match(/^\/api\/v2\/chatgpt\/edge\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && edgeJobMatch) {
      sendJson(response, 200, { job: clientWebChatJob(chatGptWeb.getJob(decodeURIComponent(edgeJobMatch[1]))) });
      return;
    }
    sendText(response, 404, '没有找到 ChatGPT 会话同步接口。');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, service: 'codex-session-forensics', port: PORT, localPathPicker: availablePathPickerKinds(), webChatSupported: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/portable-workbench/build') {
    if (!isLoopbackRequest(request)) throw new Error('换机安装包只能从本机主工作台生成。');
    const build = await buildPortableWorkbench();
    sendJson(response, 201, {
      build: {
        ...build,
        downloadUrl: `/api/portable-workbench/download/${encodeURIComponent(build.packageKey)}`,
      },
    });
    return;
  }
  const portableWorkbenchDownloadMatch = url.pathname.match(/^\/api\/portable-workbench\/download\/([^/]+)$/);
  if (request.method === 'GET' && portableWorkbenchDownloadMatch) {
    if (!isLoopbackRequest(request)) throw new Error('换机安装包只能从本机工作台下载。');
    const packageKey = decodeURIComponent(portableWorkbenchDownloadMatch[1]);
    const filePath = portableWorkbenchArchivePath(packageKey);
    const content = await fsp.readFile(filePath);
    response.writeHead(200, {
      'content-type': 'application/zip',
      'cache-control': 'no-store',
      'content-length': content.length,
      'content-disposition': `attachment; filename="${packageKey}.zip"`,
    });
    response.end(content);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/path-picker') {
    if (!isLoopbackRequest(request)) throw new Error('本机文件选择窗口只能从本机页面打开。');
    const payload = await readBody(request);
    const paths = await selectLocalPaths(String(payload.kind || ''));
    sendJson(response, 200, { ok: true, paths });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    const roots = url.searchParams.getAll('root');
    const requestedLimit = Number(url.searchParams.get('limit')) || SESSION_LIST_LIMIT;
    const sessions = await listSessionsCached({
      roots,
      limit: requestedLimit,
      force: url.searchParams.get('refresh') === '1',
    });
    sendJson(response, 200, {
      sessions: sessions.map((source) => ({ ...source, path: source.sourcePath })),
      complete: sessions.length < Math.min(requestedLimit, SESSION_LIST_LIMIT),
      limit: Math.min(requestedLimit, SESSION_LIST_LIMIT),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/session-sources') {
    const roots = url.searchParams.getAll('root');
    const requestedLimit = Number(url.searchParams.get('limit')) || SESSION_LIST_LIMIT;
    const sources = await listSessionsCached({
      roots,
      limit: requestedLimit,
      force: url.searchParams.get('refresh') === '1',
    });
    const query = String(url.searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN');
    const filtered = query
      ? sources.filter((source) => [source.title, source.sessionId, source.sourcePath, ...(source.discoveredBy || [])]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query)))
      : sources;
    const webChatSources = filtered.filter((source) => source.importKind === 'web-chat');
    const codexSources = filtered.filter((source) => source.importKind !== 'web-chat');
    sendJson(response, 200, {
      sources: filtered,
      codexSources,
      webChatSources,
      total: sources.length,
      complete: sources.length < Math.min(requestedLimit, SESSION_LIST_LIMIT),
      limit: Math.min(requestedLimit, SESSION_LIST_LIMIT),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/session-sources/scan') {
    if (!isLoopbackRequest(request)) throw new Error('本机会话扫描只能从本机工作台发起。');
    const payload = await readBody(request);
    const roots = normaliseStringList(payload.roots);
    const requestedLimit = Number(payload.limit) || SESSION_LIST_LIMIT;
    const sources = await listSessionsCached({ roots, limit: requestedLimit, force: payload.force !== false });
    const webChatSources = sources.filter((source) => source.importKind === 'web-chat');
    const codexSources = sources.filter((source) => source.importKind !== 'web-chat');
    sendJson(response, 200, {
      sources,
      codexSources,
      webChatSources,
      total: sources.length,
      roots,
      complete: sources.length < Math.min(requestedLimit, SESSION_LIST_LIMIT),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/session-sources/resolve') {
    if (!isLoopbackRequest(request)) throw new Error('本机会话解析只能从本机工作台发起。');
    const payload = await readBody(request);
    const result = await resolveSessionSources({
      threadIds: normaliseStringList(payload.threadIds || payload.threadId),
      sourcePaths: normaliseStringList(payload.sourcePaths || payload.sourcePath),
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      limit: SESSION_LIST_LIMIT,
    });
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/session-sources/preflight') {
    if (!isLoopbackRequest(request)) throw new Error('会话预检只能从本机工作台发起。');
    const payload = await readBody(request);
    const result = await preflightSessionSources({
      threadIds: normaliseStringList(payload.threadIds || payload.threadId),
      sourcePaths: normaliseStringList(payload.sourcePaths || payload.sourcePath),
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      limit: SESSION_LIST_LIMIT,
    });
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v2/workspaces') {
    const roots = url.searchParams.getAll('root');
    const catalog = await workspaceCatalogCached({ roots, force: url.searchParams.get('refresh') === '1' });
    const codexIndex = await syncCodexSessionIndex({ root: CODEX_STORE_ROOT, sources: catalog.sources, roots: catalog.roots, force: url.searchParams.get('refresh') === '1' });
    sendJson(response, 200, { catalog, codexSync: { coverage: codexCoverage(codexIndex), changes: codexIndex.changes } });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/workspace-selection/preview') {
    if (!isLoopbackRequest(request)) throw new Error('工作区选择预览只能从本机工作台发起。');
    const payload = await readBody(request);
    const roots = normaliseStringList(payload.roots);
    const catalog = await workspaceCatalogCached({ roots, force: payload.refresh === true });
    const selection = createWorkspaceSelection(catalog, payload);
    const { sources, sourcePaths, ...selectionSummary } = selection;
    sendJson(response, 200, {
      selection: {
        ...selectionSummary,
        sources: sources.slice(0, 200),
        sourcePathPreview: sourcePaths.slice(0, 200),
        sourcePreviewTruncated: sources.length > 200,
      },
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/project-context/preview') {
    if (!isLoopbackRequest(request)) throw new Error('Project context preview must be requested from the local workbench.');
    const payload = await readBody(request);
    const scopePolicy = normalizeScopePolicy(payload);
    if (!scopePolicy.projectConfirmed) {
      sendJson(response, 200, {
        scopePolicy,
        enabled: false,
        message: '当前只分析已选会话，不读取项目文件。',
      });
      return;
    }
    const workspaceInput = payload.workspaceSelection && typeof payload.workspaceSelection === 'object'
      ? payload.workspaceSelection
      : null;
    const workspaceIds = normaliseStringList(workspaceInput?.workspaceIds);
    const explicitSourcePaths = normaliseStringList(payload.sourcePaths || payload.sourcePath);
    let sourcePaths = explicitSourcePaths;
    if (workspaceIds.length || workspaceInput?.selectionMode === 'workspace') {
      const catalog = await workspaceCatalogCached({ roots: normaliseStringList(workspaceInput?.roots || payload.roots) });
      const workspaceSelection = createWorkspaceSelection(catalog, workspaceInput || {});
      sourcePaths = [...new Set([...workspaceSelection.sourcePaths, ...explicitSourcePaths])];
    }
    if (!sourcePaths.length) throw new Error('没有可用于项目预览的会话来源。');
    const preview = await previewConversationCapabilityV2({
      threadIds: normaliseStringList(payload.threadIds || payload.threadId),
      sourcePaths,
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      projectPath: optionalText(payload.projectPath),
      projectScope: scopePolicy.projectScope,
      contextMode: scopePolicy.contextMode,
      projectConfirmed: scopePolicy.projectConfirmed,
      projectContext: scopePolicy.projectContext,
      includeEvidence: true,
      redact: payload.redact !== false,
    });
    const evidence = compactProjectEvidence(preview.projectEvidence);
    const scan = evidence?.scan || {};
    sendJson(response, 200, {
      scopePolicy,
      enabled: true,
      projectDiscovery: preview.projectDiscovery || null,
      summary: evidence?.summary || null,
      scan: {
        filesScanned: Number(scan.filesScanned || 0),
        discoveredFiles: Number(scan.discoveredFiles || 0),
        relevanceOnly: scan.relevanceOnly !== false,
        relevanceMaxFiles: scan.relevanceMaxFiles || null,
        relevantFilesSelected: (scan.relevantFilesSelected || []).slice(0, 40),
        relevantFilesExcluded: (scan.relevantFilesExcluded || []).slice(0, 40),
      },
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v2/openapi.json') {
    sendJson(response, 200, openApiDocument());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/runs') {
    if (!isLoopbackRequest(request)) throw new Error('智能蒸馏只能从本机工作台发起。');
    const payload = await readBody(request);
    const workspaceInput = payload.workspaceSelection && typeof payload.workspaceSelection === 'object'
      ? payload.workspaceSelection
      : payload.selection && typeof payload.selection === 'object'
        ? payload.selection
        : null;
    let frozenWorkspaceSelection = null;
    const explicitSourcePaths = normaliseStringList(payload.sourcePaths || payload.sourcePath);
    let sourcePaths = explicitSourcePaths;
    const workspaceIds = normaliseStringList(workspaceInput?.workspaceIds);
    const workspaceSelectionMode = String(workspaceInput?.selectionMode || payload.selectionMode || '').trim();
    if (workspaceInput && (workspaceSelectionMode === 'workspace' || workspaceIds.length)) {
      const roots = normaliseStringList(workspaceInput.roots || payload.roots);
      const catalog = await workspaceCatalogCached({ roots, force: workspaceInput.refresh === true });
      frozenWorkspaceSelection = createWorkspaceSelection(catalog, workspaceInput);
      sourcePaths = [...new Set([...frozenWorkspaceSelection.sourcePaths, ...explicitSourcePaths])];
    }
    if (!sourcePaths.length) throw new Error('当前工作区选择没有包含可蒸馏的会话。');
    const scopePolicy = normalizeScopePolicy({
      ...payload,
      workspaceSelection: frozenWorkspaceSelection || workspaceInput,
      projectContext: payload.projectContext,
    });
    const preview = await previewConversationCapabilityV2({
      threadIds: normaliseStringList(payload.threadIds || payload.threadId),
      sourcePaths,
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      projectPath: scopePolicy.projectConfirmed ? optionalText(payload.projectPath) : '',
      projectScope: scopePolicy.projectScope,
      contextMode: scopePolicy.contextMode,
      projectConfirmed: scopePolicy.projectConfirmed,
      projectContext: scopePolicy.projectContext,
      includeEvidence: payload.includeEvidence !== false,
      redact: payload.redact !== false,
    });
    const resolvedSourcePaths = (preview.sourceSet?.sessions || []).map((session) => session.sourcePath).filter(Boolean);
    const run = await createDistillationRun({
      preview,
      selection: {
        sourcePaths: resolvedSourcePaths,
        projectPath: scopePolicy.projectConfirmed
          ? (payload.projectPath || preview.projectDiscovery?.selectedPath || preview.projectEvidence?.project?.root || '')
          : '',
        selectionMode: workspaceSelectionMode === 'workspace' ? 'workspace' : 'sessions',
        projectScope: scopePolicy.projectScope,
        contextMode: scopePolicy.contextMode,
        projectConfirmed: scopePolicy.projectConfirmed,
        projectContext: scopePolicy.projectContext,
        includeEvidence: payload.includeEvidence !== false,
        redact: payload.redact !== false,
        workspaceSelection: frozenWorkspaceSelection,
      },
    });
    const evidenceDir = path.join(run.root, 'evidence');
    await writePreviewEvidence(preview, evidenceDir);
    sendJson(response, 201, {
      run: publicDistillationRun(run),
      analysis: publicAnalysisPayload(preview.analysis, { outputDir: evidenceDir, ...runEvidenceLinks(run.id) }),
    });
    return;
  }
  const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    sendJson(response, 200, { run: publicDistillationRun(await readDistillationRun(decodeURIComponent(runMatch[1]))) });
    return;
  }
  const recommendationMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/recommendation$/);
  if (request.method === 'GET' && recommendationMatch) {
    const run = await readDistillationRun(decodeURIComponent(recommendationMatch[1]));
    sendJson(response, 200, run.recommendation);
    return;
  }
  const runDocumentMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(recommendation\.(?:html|md)|evidence-manifest\.json)$/);
  if (request.method === 'GET' && runDocumentMatch) {
    const runId = decodeURIComponent(runDocumentMatch[1]);
    const artifact = runDocumentMatch[2];
    const content = await readRunArtifact(runId, artifact);
    response.writeHead(200, { 'content-type': MIME[path.extname(artifact)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': content.length });
    response.end(content);
    return;
  }
  const prioritiesMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/priorities$/);
  if (request.method === 'GET' && prioritiesMatch) {
    const run = await readDistillationRun(decodeURIComponent(prioritiesMatch[1]));
    sendJson(response, 200, {
      runId: run.id,
      judgements: run.recommendation?.judgements || {},
      summary: run.recommendation?.summary || {},
      priorities: run.recommendation?.priorities || [],
    });
    return;
  }
  const evidenceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/evidence\/([^/]+)$/);
  if (request.method === 'GET' && evidenceMatch) {
    const run = await readDistillationRun(decodeURIComponent(evidenceMatch[1]));
    const evidenceId = decodeURIComponent(evidenceMatch[2]);
    const evidence = (run.recommendation?.evidence || []).find((item) => item.id === evidenceId);
    if (!evidence) throw new Error('没有找到对应证据。');
    const priorities = (run.recommendation?.priorities || []).filter((item) => (item.evidenceIds || []).includes(evidenceId)).map((item) => ({ id: item.id, title: item.title, level: item.distillationPriority?.level || item.level }));
    sendJson(response, 200, { runId: run.id, evidence, priorities });
    return;
  }
  const runEvidenceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/evidence-artifact\/([^/]+)$/);
  if (request.method === 'GET' && runEvidenceMatch) {
    const artifact = decodeURIComponent(runEvidenceMatch[2]);
    const content = await readRunEvidenceArtifact(decodeURIComponent(runEvidenceMatch[1]), artifact);
    response.writeHead(200, { 'content-type': MIME[path.extname(artifact)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': content.length });
    response.end(content);
    return;
  }
  const reprioritizeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/reprioritize$/);
  if (request.method === 'POST' && reprioritizeMatch) {
    if (!isLoopbackRequest(request)) throw new Error('调整蒸馏建议只能从本机工作台发起。');
    const payload = await readBody(request);
    const run = await reprioritizeDistillationRun(decodeURIComponent(reprioritizeMatch[1]), { priorityId: payload.priorityId, action: payload.action });
    sendJson(response, 200, { run: publicDistillationRun(run) });
    return;
  }
  const runPackageMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/package$/);
  if (request.method === 'POST' && runPackageMatch) {
    if (!isLoopbackRequest(request)) throw new Error('生成能力包只能从本机工作台发起。');
    const payload = await readBody(request);
    const runId = decodeURIComponent(runPackageMatch[1]);
    const run = await readDistillationRun(runId);
    const result = await packageConversationV2({
      sourcePaths: run.selection.sourcePaths,
      projectPath: optionalText(run.selection.projectPath),
      projectScope: run.selection.projectScope || 'sessions-only',
      contextMode: run.selection.contextMode || 'conversation-only',
      projectConfirmed: run.selection.projectConfirmed === true,
      projectContext: run.selection.projectContext || null,
      packageId: optionalText(payload.packageId),
      packageName: optionalText(payload.packageName),
      targets: Array.isArray(payload.targets) ? payload.targets : undefined,
      scope: 'whole-session',
      includeEvidence: run.selection.includeEvidence !== false,
      redact: run.selection.redact !== false,
      recommendationOverride: run.recommendation,
      heldOutCandidate: payload.heldOutCandidate && typeof payload.heldOutCandidate === 'object' ? payload.heldOutCandidate : null,
    });
    const attached = await attachPackageToRun(runId, result);
    sendJson(response, 201, { ...publicPackageResult(result), run: publicDistillationRun(attached) });
    return;
  }
  const packageDownloadMatch = url.pathname.match(/^\/api\/v2\/packages\/([^/]+)\/download$/);
  if (request.method === 'GET' && packageDownloadMatch) {
    const packageKey = await findStoredPackageKey(decodeURIComponent(packageDownloadMatch[1]));
    const filePath = await safePackageArtifactPath(packageKey, '__archive__.zip');
    const content = await fsp.readFile(filePath);
    response.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-length': content.length, 'content-disposition': `attachment; filename="${packageKey}.zip"` });
    response.end(content);
    return;
  }
  const packageLaunchMatch = url.pathname.match(/^\/api\/v2\/packages\/([^/]+)\/launch$/);
  if (request.method === 'POST' && packageLaunchMatch) {
    if (!isLoopbackRequest(request)) throw new Error('独立 Agent 只能从本机工作台启动。');
    const packageReference = decodeURIComponent(packageLaunchMatch[1]);
    const launch = await launchStoredPackageAgent(packageReference);
    sendJson(response, 200, { launch });
    return;
  }
  const packageAgentMatch = url.pathname.match(/^\/api\/v2\/packages\/([^/]+)\/agent\/(preflight|status|start|stop)$/);
  if (packageAgentMatch) {
    if (!isLoopbackRequest(request)) throw new Error('独立 Agent 只能从本机工作台管理。');
    const packageReference = decodeURIComponent(packageAgentMatch[1]);
    const action = packageAgentMatch[2];
    if (request.method === 'GET' && action === 'preflight') {
      sendJson(response, 200, { preflight: await preflightStoredPackageAgent(packageReference) });
      return;
    }
    if (request.method === 'GET' && action === 'status') {
      sendJson(response, 200, { agent: await getStoredPackageAgentStatus(packageReference) });
      return;
    }
    if (request.method === 'POST' && action === 'start') {
      sendJson(response, 200, { agent: await launchStoredPackageAgent(packageReference) });
      return;
    }
    if (request.method === 'POST' && action === 'stop') {
      sendJson(response, 200, { agent: await stopStoredPackageAgent(packageReference) });
      return;
    }
  }
  const packageV2Match = url.pathname.match(/^\/api\/v2\/packages\/([^/]+)$/);
  if (request.method === 'GET' && packageV2Match) {
    const packageKey = await findStoredPackageKey(decodeURIComponent(packageV2Match[1]));
    sendJson(response, 200, await storedPackageResult(packageKey, url.searchParams.get('includeAnalysis') === '1'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/packages') {
    const requested = Number(url.searchParams.get('limit'));
    const requestedOffset = Number(url.searchParams.get('offset'));
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 100)) : 24;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    sendJson(response, 200, await listStoredPackagesPage(limit, offset));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/package') {
    const packageKey = url.searchParams.get('packageKey') || '';
    sendJson(response, 200, await storedPackageResult(packageKey, url.searchParams.get('includeAnalysis') === '1'));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/analyze') {
    const payload = await readBody(request);
    const threadIds = normaliseStringList(payload.threadIds || payload.threadId);
    const sourcePaths = normaliseStringList(payload.sourcePaths || payload.sourcePath);
    const scopePolicy = normalizeScopePolicy(payload);
    const result = await previewConversationCapabilityV2({
      threadIds,
      sourcePaths,
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      projectPath: scopePolicy.projectConfirmed ? optionalText(payload.projectPath) : '',
      projectScope: scopePolicy.projectScope,
      contextMode: scopePolicy.contextMode,
      projectConfirmed: scopePolicy.projectConfirmed,
      projectContext: scopePolicy.projectContext,
      includeEvidence: Boolean(payload.includeEvidence),
      redact: payload.redact !== false,
    });
    const outputKey = `preview-${result.sourceSet.mode}-${result.sourceSet.sessionCount}-${Date.now()}`;
    const outputDir = path.join(OUTPUT_ROOT, outputKey);
    const artifacts = await writePreviewEvidence(result, outputDir);
    sendJson(response, 200, publicAnalysis({ analysis: result.analysis, artifacts }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/package') {
    const payload = await readBody(request);
    const scopePolicy = normalizeScopePolicy(payload);
    const result = await packageConversation({
      threadIds: normaliseStringList(payload.threadIds || payload.threadId),
      sourcePaths: normaliseStringList(payload.sourcePaths || payload.sourcePath),
      roots: Array.isArray(payload.roots) ? payload.roots : [],
      projectPath: scopePolicy.projectConfirmed ? optionalText(payload.projectPath) : '',
      projectScope: scopePolicy.projectScope,
      contextMode: scopePolicy.contextMode,
      projectConfirmed: scopePolicy.projectConfirmed,
      projectContext: scopePolicy.projectContext,
      packageId: optionalText(payload.packageId),
      packageName: optionalText(payload.packageName),
      targets: Array.isArray(payload.targets) ? payload.targets : undefined,
      scope: payload.scope || 'whole-session',
      includeEvidence: payload.includeEvidence !== false,
      redact: payload.redact !== false,
    });
    sendJson(response, 200, publicPackageResult(result));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/artifact') {
    const filePath = safeArtifactPath(url.searchParams.get('outputKey') || '', url.searchParams.get('artifact') || '');
    const content = await fsp.readFile(filePath);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': content.length });
    response.end(content);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/package-artifact') {
    const packageKey = url.searchParams.get('packageKey') || '';
    const artifact = url.searchParams.get('artifact') || '';
    const filePath = await safePackageArtifactPath(packageKey, artifact);
    const content = await fsp.readFile(filePath);
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'content-length': content.length };
    if (artifact === '__archive__.zip') headers['content-disposition'] = `attachment; filename="${packageKey}.zip"`;
    response.writeHead(200, headers);
    response.end(content);
    return;
  }
  if (request.method === 'GET') {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.resolve(UI_DIR, relative);
    const relativeCheck = path.relative(UI_DIR, filePath);
    if (!relativeCheck.startsWith('..') && !path.isAbsolute(relativeCheck) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const body = await fsp.readFile(filePath);
      response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
      response.end(body);
      return;
    }
  }
  sendText(response, 404, '未找到请求的页面或接口。');
}

server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    if (process.env.CODEX_SESSION_FORENSICS_DEBUG === '1') console.error('[session-forensics]', request.method, request.url, error?.stack || error);
    const message = error instanceof Error ? error.message : String(error);
    const userMessage = /^[\u4e00-\u9fff]/.test(message) ? message : '解析请求未完成，请检查会话编号或 JSON / JSONL 文件路径。';
    sendJson(response, 400, { error: userMessage });
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`会话全量取证工作台已启动：http://${HOST}:${PORT}/\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
