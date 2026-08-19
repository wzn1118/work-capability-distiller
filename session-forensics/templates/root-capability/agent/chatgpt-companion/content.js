(function installWebChatPageReader() {
if (globalThis.__capabilityWebChatPageReaderInstalled) return;
globalThis.__capabilityWebChatPageReaderInstalled = true;

const PAGE_READER_VERSION = '2.5.0';
const PLATFORMS = {
  chatgpt: {
    name: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    titleSuffix: /\s*[|\-]\s*ChatGPT\s*$/i,
    conversationPaths: [/^\/c\/[^/]+/],
    messageSelectors: ['[data-message-author-role]'],
    composerSelectors: ['#prompt-textarea'],
  },
  deepseek: {
    name: 'DeepSeek',
    homeUrl: 'https://chat.deepseek.com/',
    titleSuffix: /\s*[|\-]\s*DeepSeek\s*$/i,
    conversationPaths: [/^\/a\//, /^\/chat\//, /^\/conversation\//],
    messageSelectors: ['[data-testid*="message"]', '[class*="message-item"]', '[class*="chat-message"]', '[class*="ds-message"]'],
    composerSelectors: ['textarea', '[contenteditable="true"]'],
  },
  gemini: {
    name: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    titleSuffix: /\s*[|\-]\s*Gemini\s*$/i,
    conversationPaths: [/^\/app(?:\/[^/]+)?/],
    messageSelectors: ['user-query', 'model-response', '[data-test-id*="conversation-turn"]', '[data-test-id*="message"]'],
    composerSelectors: ['rich-textarea [contenteditable="true"]', '[contenteditable="true"]', 'textarea'],
  },
  doubao: {
    name: '豆包',
    homeUrl: 'https://www.doubao.com/chat/',
    titleSuffix: /\s*[|\-]\s*豆包\s*$/i,
    conversationPaths: [/^\/chat\//, /^\/conversation\//, /^\/s\//],
    messageSelectors: ['[data-testid*="message"]', '[class*="message-item"]', '[class*="chat-message"]', '[class*="message-content"]'],
    composerSelectors: ['textarea', '[contenteditable="true"]'],
  },
};

function platformIdFromUrl(value = location.href) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return 'chatgpt';
    if (host === 'chat.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
    if (host === 'gemini.google.com') return 'gemini';
    if (host === 'doubao.com' || host.endsWith('.doubao.com')) return 'doubao';
  } catch {}
  return 'chatgpt';
}

function platform() {
  return PLATFORMS[platformIdFromUrl()] || PLATFORMS.chatgpt;
}

function cleanTitle(value) {
  return String(value || '').replace(platform().titleSuffix, '').replace(/\s+/g, ' ').trim();
}

function usableConversationTitle(value) {
  const title = cleanTitle(value);
  if (!title || /\?{2,}/.test(title)) return '';
  if (/^(?:ChatGPT|DeepSeek|Gemini|豆包)$/i.test(title)) return '';
  return title;
}

function inferRole(node) {
  const direct = String(node.getAttribute?.('data-message-author-role') || '').toLowerCase();
  if (['user', 'assistant', 'system', 'tool'].includes(direct)) return direct;
  const text = `${node.tagName || ''} ${node.className || ''} ${node.getAttribute?.('data-testid') || ''} ${node.getAttribute?.('aria-label') || ''}`.toLowerCase();
  if (/user-query|user-message|human|user\b|question/.test(text)) return 'user';
  if (/model-response|assistant|bot|answer|ai-message|response/.test(text)) return 'assistant';
  return 'unknown';
}

function messageNodes() {
  const selectors = [...platform().messageSelectors, '[data-message-author-role]'];
  const found = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
  return found.filter((node) => !found.some((candidate) => candidate !== node && node.contains(candidate)));
}

function pageSnapshot() {
  const seen = new Set();
  const messages = messageNodes().map((node) => ({
    role: inferRole(node),
    content: (node.innerText || node.textContent || '').trim(),
    messageId: node.closest?.('[data-message-id]')?.getAttribute('data-message-id') || node.id || null,
  })).filter((item) => {
    const signature = `${item.role}:${item.content}`;
    if (!item.content || seen.has(signature)) return false;
    seen.add(signature);
    return true;
  // 保留当前页面实际加载的全部消息；历史补齐依赖原始对话完整内容，不再静默截断到最后 500 条。
  }).map((item, index) => ({ ...item, index }));
  const firstUserMessage = messages.find((item) => item.role === 'user')?.content || '';
  const title = usableConversationTitle(document.title) || firstUserMessage.slice(0, 160) || `未命名 ${platform().name} 网页对话`;
  return {
    platform: platformIdFromUrl(),
    platformName: platform().name,
    title,
    url: location.href,
    messages,
  };
}

function chatgptCookieValue(name) {
  const prefix = `${name}=`;
  const item = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

async function chatgptApiContext() {
  const response = await fetch('/api/auth/session?unstable_client=true', { credentials: 'include' });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session?.accessToken) throw new Error('当前网页没有返回可用的登录状态，请先在网页端打开一个会话后重试。');
  return {
    token: session.accessToken,
    deviceId: chatgptCookieValue('oai-device-id') || crypto.randomUUID(),
  };
}

let chatgptApiNotBefore = 0;
let chatgptApiRequestGapMs = 1_500;

async function waitForChatgptApiSlot() {
  const waitMs = Math.max(0, chatgptApiNotBefore - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function fetchChatgptApi(path, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(path, {
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function chatgptApiJson(path, context) {
  const headers = { accept: 'application/json', authorization: `Bearer ${context.token}`, 'oai-device-id': context.deviceId };
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitForChatgptApiSlot();
    let response;
    try {
      response = await fetchChatgptApi(path, headers);
    } catch (error) {
      lastStatus = 408;
      chatgptApiNotBefore = Date.now() + chatgptApiRequestGapMs;
      if (attempt === 5) {
        throw new Error(`网页接口请求超时或网络失败：${path}：${String(error?.message || error)}`);
      }
      const backoffMs = Math.min(120_000, 1_000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    chatgptApiNotBefore = Date.now() + chatgptApiRequestGapMs;
    lastStatus = response.status;
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      chatgptApiRequestGapMs = Math.max(1_500, Math.floor(chatgptApiRequestGapMs * 0.95));
      return payload;
    }
    const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
    if (response.status === 429) chatgptApiRequestGapMs = Math.min(15_000, Math.max(3_000, chatgptApiRequestGapMs * 2));
    if (!retryable || attempt === 5) throw new Error(`网页接口请求失败（${response.status}）：${path}`);
    const retryAfterHeader = response.headers.get('retry-after') || '';
    const retryAfterSeconds = Number(retryAfterHeader);
    const retryAfterDate = Date.parse(retryAfterHeader);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : Number.isFinite(retryAfterDate)
        ? Math.max(0, retryAfterDate - Date.now())
        : 0;
    const fallbackBackoffMs = response.status === 429 ? 15_000 * (attempt + 1) : 1_000 * (2 ** attempt);
    const backoffMs = Math.min(120_000, Math.max(retryAfterMs, fallbackBackoffMs) + Math.floor(Math.random() * 500));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`网页接口请求失败（${lastStatus || '未知状态'}）：${path}`);
}

async function chatgptApiJsonFirst(paths, context) {
  const failures = [];
  for (const path of paths) {
    try {
      return { payload: await chatgptApiJson(path, context), path };
    } catch (error) {
      failures.push(`${path} -> ${String(error?.message || error)}`);
    }
  }
  throw new Error(failures.join('；'));
}

function chatgptConversationUrl(id) {
  return `${location.origin}/c/${encodeURIComponent(id)}`;
}

function chatgptConversationEntry(item, extra = {}) {
  const id = String(item?.id || item?.conversation_id || '').trim();
  if (!id) return null;
  return {
    conversationId: id,
    title: String(item?.title || '').trim() || `未命名 ChatGPT 对话 ${id.slice(0, 8)}`,
    url: chatgptConversationUrl(id),
    current: location.pathname.endsWith(`/c/${id}`),
    createdAt: item?.create_time || item?.created_at || null,
    updatedAt: item?.update_time || item?.updated_at || null,
    archived: Boolean(extra.archived || item?.is_archived),
    projectId: String(extra.projectId || item?.gizmo_id || item?.project_id || '').trim() || null,
    projectTitle: String(extra.projectTitle || item?.gizmo_title || item?.project_title || '').trim() || null,
  };
}

function chatgptContentParts(content) {
  if (content === null || content === undefined) return [];
  if (Array.isArray(content)) return content.flatMap((part) => chatgptContentParts(part));
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (typeof content !== 'object') return [{ type: typeof content, value: content }];
  if (Array.isArray(content.parts)) return content.parts.flatMap((part) => chatgptContentParts(part));
  if (typeof content.text === 'string') return [{ type: 'text', text: content.text }];
  const type = String(content.content_type || content.type || '').trim();
  const image = content.asset_pointer || content.asset_id || content.image_url || content.url;
  if (image) return [{ type: type || 'asset', value: image, raw: content }];
  return [{ type: type || 'object', raw: content }];
}

function chatgptMessageText(content) {
  return chatgptContentParts(content).map((part) => {
    if (part.type === 'text') return String(part.text || '');
    if (part.type === 'asset') return `[${String(part.value || 'asset')}]`;
    return part.raw ? JSON.stringify(part.raw) : '';
  }).filter(Boolean).join('\n').trim();
}

function chatgptAssetRefs(value, refs = [], seen = new Set()) {
  if (value === null || value === undefined) return refs;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(https?:\/\/|data:image\/|file-|file_)/i.test(text)) refs.push({ ref: text });
    return refs;
  }
  if (typeof value !== 'object' || seen.has(value)) return refs;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => chatgptAssetRefs(item, refs, seen));
  else Object.entries(value).forEach(([key, item]) => {
    if (/asset|file|image|attachment|url|download/i.test(key) && (typeof item === 'string' || typeof item === 'number')) refs.push({ key, ref: String(item) });
    chatgptAssetRefs(item, refs, seen);
  });
  return refs;
}

function chatgptEventType(message = {}) {
  const metadata = message.metadata || {};
  const content = message.content || {};
  const contentType = String(content.content_type || metadata.content_type || '').toLowerCase();
  const recipient = String(message.recipient || metadata.recipient || '').toLowerCase();
  const serialized = JSON.stringify({ content, metadata, recipient }).toLowerCase();
  if (/image_gen|dall-e|image_generation|image_edit|imagegen/.test(serialized)) return 'image_generation';
  if (/code_interpreter|python|container|shell/.test(serialized)) return 'code_execution';
  if (/browser|web.run|web_search|browsing/.test(serialized)) return 'web_search';
  if (message.author?.role === 'tool' || recipient || /tool|function_call|tool_calls/.test(serialized)) return 'tool_call';
  if (/multimodal|image|file|attachment/.test(contentType) || chatgptAssetRefs(content).length) return 'asset_event';
  return 'message';
}

function chatgptSnapshotFromApi(payload, fallback = {}) {
  const mapping = payload?.mapping && typeof payload.mapping === 'object' ? payload.mapping : {};
  const currentPath = [];
  let nodeId = String(payload?.current_node || '').trim();
  const visited = new Set();
  while (nodeId && !visited.has(nodeId) && mapping[nodeId]) {
    visited.add(nodeId);
    currentPath.push(nodeId);
    nodeId = String(mapping[nodeId]?.parent || '').trim();
  }
  currentPath.reverse();
  const nodes = Object.entries(mapping)
    .map(([entryId, node]) => ({ entryId, node }))
    .sort((left, right) => Number(left.node?.message?.create_time || 0) - Number(right.node?.message?.create_time || 0));
  const assets = [];
  const events = [];
  const messages = nodes.map(({ entryId, node }, index) => {
    const message = node?.message || {};
    const role = String(message?.author?.role || 'unknown').toLowerCase();
    const content = chatgptMessageText(message?.content);
    const contentParts = chatgptContentParts(message?.content);
    const eventType = chatgptEventType(message);
    const refs = chatgptAssetRefs({ content: message?.content, metadata: message?.metadata, recipient: message?.recipient });
    refs.forEach((asset, assetIndex) => assets.push({
      assetId: `${entryId}-asset-${assetIndex + 1}`,
      source: 'chatgpt',
      messageId: message?.id || entryId,
      nodeId: entryId,
      ...asset,
    }));
    const result = {
      index,
      role: ['user', 'assistant', 'system', 'tool'].includes(role) ? role : 'unknown',
      content,
      messageId: String(message?.id || node?.id || '').trim() || null,
      createdAt: message?.create_time || null,
      nodeId: entryId,
      parentNodeId: String(node?.parent || '').trim() || null,
      childNodeIds: Array.isArray(node?.children) ? node.children.map((item) => String(item || '').trim()).filter(Boolean) : [],
      model: message?.metadata?.model_slug || message?.metadata?.model || null,
      recipient: message?.recipient || message?.metadata?.recipient || null,
      contentType: message?.content?.content_type || null,
      contentParts,
      eventType,
      metadata: message?.metadata || {},
    };
    if (eventType !== 'message' || result.recipient || refs.length) events.push({ eventId: `${entryId}-event`, eventType, nodeId: entryId, messageId: result.messageId, payload: result });
    if (!content && !result.recipient && !refs.length && !Object.keys(result.metadata || {}).length) return null;
    return result;
  }).filter(Boolean);
  const id = String(payload?.conversation_id || payload?.id || fallback.conversationId || '').trim();
  const firstUser = messages.find((item) => item.role === 'user')?.content || '';
  return {
    platform: 'chatgpt',
    platformName: 'ChatGPT',
    title: String(payload?.title || fallback.title || '').trim() || firstUser.slice(0, 160) || `未命名 ChatGPT 网页对话`,
    url: chatgptConversationUrl(id),
    conversationId: id || null,
    capturedAt: new Date().toISOString(),
    createdAt: payload?.create_time || fallback.createdAt || null,
    updatedAt: payload?.update_time || fallback.updatedAt || null,
    projectId: fallback.projectId || null,
    projectTitle: fallback.projectTitle || null,
    messages,
    nodes: nodes.map(({ entryId, node }) => ({ nodeId: entryId, parentNodeId: node?.parent || null, childNodeIds: Array.isArray(node?.children) ? node.children : [], hasMessage: Boolean(node?.message) })),
    branches: { currentNodeId: payload?.current_node || null, currentPath, nodeCount: nodes.length },
    events,
    assets,
    rawPayload: payload,
    completeness: {
      index: true,
      messages: messages.length > 0,
      branches: nodes.length > 0,
      tools: true,
      assets: true,
      raw: true,
    },
    source: 'ChatGPT 网页同源接口',
  };
}

async function chatgptApiHistoryIndex() {
  const context = await chatgptApiContext();
  const entries = new Map();
  const scan = { mode: 'same-origin-api', activePages: 0, archivedPages: 0, projectPages: 0, projectCount: 0, projectEndpoint: '', exhausted: true, failures: [], scannedAt: null };
  const add = (item, extra = {}) => {
    const entry = chatgptConversationEntry(item, extra);
    if (entry) entries.set(entry.conversationId, { ...(entries.get(entry.conversationId) || {}), ...entry });
  };
  for (const archived of [false, true]) {
    let offset = 0;
    for (let page = 0; page < 10_000; page += 1) {
      const suffix = archived ? '&is_archived=true' : '';
      let data;
      try {
        data = await chatgptApiJson(`/backend-api/conversations?offset=${offset}&limit=100&order=updated${suffix}`, context);
      } catch (error) {
        scan.failures.push({ scope: archived ? 'archived' : 'active', offset, message: String(error?.message || error) });
        scan.exhausted = false;
        break;
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      if (archived) scan.archivedPages += 1; else scan.activePages += 1;
      items.forEach((item) => add(item, { archived }));
      const hasMore = data?.has_more === true || data?.hasMore === true || Boolean(data?.next_cursor || data?.nextCursor) || items.length === 100;
      if (!hasMore || !items.length) break;
      offset += items.length;
    }
  }
  let cursor = null;
  for (let page = 0; page < 10_000; page += 1) {
    const cursorSuffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const projectPaths = [
      `/backend-api/gizmos/snorlax/sidebar?limit=50${cursorSuffix}`,
      `/backend-api/gizmos/snorlax/sidebar?limit=50&order=updated${cursorSuffix}`,
      `/backend-api/gizmos/snorlax/sidebar?limit=50&conversations_per_gizmo=50&owned_only=false${cursorSuffix}`,
    ];
    let data;
    try {
      const result = await chatgptApiJsonFirst(projectPaths, context);
      data = result.payload;
      scan.projectEndpoint = result.path.split('?')[0];
    } catch (error) {
      scan.failures.push({ scope: 'projects', cursor, message: String(error?.message || error) });
      scan.exhausted = false;
      break;
    }
    const projects = Array.isArray(data?.items) ? data.items : [];
    scan.projectPages += 1;
    for (const rawProject of projects) {
      const project = rawProject?.gizmo?.gizmo || rawProject?.gizmo || rawProject;
      const projectId = String(project?.id || rawProject?.id || '').trim();
      const projectTitle = String(project?.display?.name || project?.name || rawProject?.title || '').trim();
      if (!projectId) continue;
      scan.projectCount += 1;
      let projectCursor = null;
      for (let projectPage = 0; projectPage < 10_000; projectPage += 1) {
        const projectQuery = projectCursor ? `?cursor=${encodeURIComponent(projectCursor)}` : '?cursor=0';
        let projectData;
        try {
          projectData = await chatgptApiJson(`/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations${projectQuery}`, context);
        } catch (error) {
          scan.failures.push({ scope: 'project', projectId, cursor: projectCursor, message: String(error?.message || error) });
          scan.exhausted = false;
          break;
        }
        const items = Array.isArray(projectData?.items) ? projectData.items : [];
        scan.projectPages += 1;
        items.forEach((item) => add(item, { projectId, projectTitle }));
        projectCursor = projectData?.cursor || null;
        if (!projectCursor) break;
      }
    }
    cursor = data?.cursor || null;
    if (!cursor) break;
  }
  const conversations = [...entries.values()].sort((left, right) => (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0));
  scan.discoveredCount = conversations.length;
  scan.scannedAt = new Date().toISOString();
  return {
    platform: 'chatgpt',
    platformName: 'ChatGPT',
    capturedAt: new Date().toISOString(),
    currentUrl: location.href,
    conversations,
    scan,
  };
}

async function chatgptApiCaptureBatch(conversations) {
  const context = await chatgptApiContext();
  const items = Array.isArray(conversations) ? conversations : [];
  const results = [];
  let cursor = 0;
  const captureOne = async (item) => {
    const id = String(item?.conversationId || item?.id || '').trim() || String(item?.url || '').match(/\/c\/([^/?#]+)/)?.[1] || '';
    if (!id) {
      return { capture: null, error: '缺少会话编号。' };
    }
    try {
      const payload = await chatgptApiJson(`/backend-api/conversation/${encodeURIComponent(id)}`, context);
      return { capture: chatgptSnapshotFromApi(payload, { ...item, conversationId: id }), error: null };
    } catch (error) {
      console.warn('ChatGPT 会话读取失败：', id, error);
      return { capture: null, error: String(error?.message || error) };
    }
  };
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await captureOne(items[index]);
      // 保留很小的间隔，避免连续请求触发网页端限流；失败仍然只影响当前会话。
      if (cursor < items.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, () => worker()));
  const captures = results.map((item) => item.capture).filter(Boolean);
  const failures = results.map((result, index) => result.error ? {
    conversationId: String(items[index]?.conversationId || items[index]?.id || '').trim() || null,
    title: String(items[index]?.title || '').trim(),
    error: result.error,
  } : null).filter(Boolean);
  return { captures, failures, capturedCount: captures.length, failedCount: failures.length, totalCount: items.length };
}

function isConversationUrl(url, link) {
  if (url.hostname !== location.hostname || url.pathname === '/') return false;
  if (platform().conversationPaths.some((pattern) => pattern.test(url.pathname))) return true;
  const container = link.closest('nav, aside, [role="navigation"], [class*="history"], [class*="sidebar"]');
  const title = cleanTitle(link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText || link.textContent);
  return Boolean(container && title && !/^(设置|帮助|登录|Settings|Help|Sign in)$/i.test(title));
}

function historyLinkCandidates() {
  return document.querySelectorAll('nav a[href], aside a[href], [role="navigation"] a[href], [class*="history"] a[href], [class*="sidebar"] a[href], a[href*="/c/"], a[href*="/chat/"], a[href*="/app/"], [role="link"][href], [data-href]');
}

function captureHistoryLinks(target) {
  for (const link of historyLinkCandidates()) {
    let url;
    try { url = new URL(link.getAttribute('href') || link.getAttribute('data-href') || link.href, location.origin); } catch { continue; }
    if (!isConversationUrl(url, link) || target.has(url.href)) continue;
    const title = usableConversationTitle(link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText || link.textContent);
    if (title) target.set(url.href, { title, url: url.href, current: url.href === location.href });
  }
}

function historyExpansionCandidates() {
  const pattern = /^(?:view all|show all|see all|load more|查看全部|显示全部|查看更多|加载更多)$/i;
  return [...document.querySelectorAll('button, a, [role="button"]')].filter((node) => {
    if (!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)) return false;
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    return pattern.test(label);
  });
}

async function expandHistorySections(target) {
  let clicks = 0;
  const seen = new Set();
  for (let round = 0; round < 6; round += 1) {
    const candidate = historyExpansionCandidates().find((node) => !seen.has(node));
    if (!candidate) break;
    seen.add(candidate);
    candidate.click();
    clicks += 1;
    await new Promise((resolve) => setTimeout(resolve, 650));
    captureHistoryLinks(target);
  }
  return clicks;
}

const MAX_HISTORY_SCROLL_ROUNDS = 800;

async function loadAllHistoryLinks() {
  const containers = [...document.querySelectorAll('nav, aside, [role="navigation"], [class*="history"], [class*="sidebar"]')]
    .filter((node) => node.scrollHeight > node.clientHeight + 8 && node.clientHeight > 40);
  const captured = new Map();
  captureHistoryLinks(captured);
  const expandedSections = await expandHistorySections(captured);
  let rounds = 0;
  let exhausted = true;
  for (const container of containers) {
    const originalTop = container.scrollTop;
    let stagnantRounds = 0;
    let previousHeight = container.scrollHeight;
    try {
      container.scrollTop = 0;
      for (let round = 0; round < MAX_HISTORY_SCROLL_ROUNDS; round += 1) {
        rounds += 1;
        captureHistoryLinks(captured);
        const beforeTop = container.scrollTop;
        container.scrollTop = Math.min(container.scrollHeight, beforeTop + Math.max(240, Math.floor(container.clientHeight * 0.85)));
        await new Promise((resolve) => setTimeout(resolve, 45));
        const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
        const heightChanged = container.scrollHeight !== previousHeight;
        previousHeight = container.scrollHeight;
        if (container.scrollTop === beforeTop && !heightChanged) stagnantRounds += 1;
        else stagnantRounds = 0;
        if (atEnd && stagnantRounds >= 2) break;
        if (round === MAX_HISTORY_SCROLL_ROUNDS - 1) exhausted = false;
      }
      captureHistoryLinks(captured);
    } finally {
      container.scrollTop = originalTop;
    }
  }
  return {
    captured,
    scan: {
      containerCount: containers.length,
      scrollRounds: rounds,
      expandedSections,
      discoveredCount: captured.size,
      exhausted,
      scannedAt: new Date().toISOString(),
    },
  };
}

async function historyIndex() {
  if (platformIdFromUrl() === 'chatgpt') {
    try {
      return await chatgptApiHistoryIndex();
    } catch (error) {
      console.warn('ChatGPT 同源接口目录读取失败，回退到网页目录扫描：', error);
    }
  }
  const loaded = await loadAllHistoryLinks();
  const captured = loaded.captured;
  const currentUrl = location.href;
  const conversations = new Map();
  for (const [url, item] of captured) conversations.set(url, { ...item, current: url === currentUrl });
  if (location.pathname !== '/' && !conversations.has(currentUrl)) {
    conversations.set(currentUrl, { title: usableConversationTitle(document.title) || `当前打开的 ${platform().name} 对话`, url: currentUrl, current: true });
  }
  return {
    platform: platformIdFromUrl(),
    platformName: platform().name,
    capturedAt: new Date().toISOString(),
    currentUrl,
    conversations: [...conversations.values()],
    scan: loaded.scan,
  };
}

function assistantMessages() {
  return pageSnapshot().messages.filter((item) => item.role === 'assistant').map((item) => item.content);
}

function findComposer() {
  return platform().composerSelectors.map((selector) => document.querySelector(selector)).find(Boolean)
    || document.querySelector('textarea[placeholder], div[contenteditable="true"]');
}

function setComposerText(composer, text) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), 'value')?.set;
    if (setter) setter.call(composer, text); else composer.value = text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, text);
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

async function waitForSendButton() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const button = document.querySelector('button[data-testid="send-button"]') || [...document.querySelectorAll('button')].find((item) => /发送|Send|提交|Submit/i.test(item.getAttribute('aria-label') || item.title || item.innerText || ''));
    if (button && !button.disabled) return button;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`没有找到可用的发送按钮。请确认 ${platform().name} 页面已登录并可正常输入。`);
}

async function waitForAnswer(previousCount) {
  const deadline = Date.now() + 180_000;
  let stableText = '';
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const answers = assistantMessages();
    const answer = answers.at(-1) || '';
    const generating = Boolean([...document.querySelectorAll('button')].find((node) => /Stop|停止/.test(node.getAttribute('aria-label') || node.innerText || '')));
    if (answers.length > previousCount && answer) {
      stableRounds = answer === stableText && !generating ? stableRounds + 1 : 0;
      stableText = answer;
      if (stableRounds >= 3) return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`等待 ${platform().name} 回答超时。回答可能仍在网页生成，可回到网页检查。`);
}

async function sendPrompt(prompt) {
  const composer = findComposer();
  if (!composer) throw new Error(`没有找到 ${platform().name} 输入框。请刷新网页或打开一个可输入的新对话。`);
  const previousCount = assistantMessages().length;
  setComposerText(composer, prompt);
  (await waitForSendButton()).click();
  return { answer: await waitForAnswer(previousCount), snapshot: pageSnapshot() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'chatgpt-companion:ping') {
    sendResponse({
      ok: true,
      ready: true,
      version: PAGE_READER_VERSION,
      platform: platformIdFromUrl(),
      url: location.href,
    });
    return false;
  }
  if (message?.type !== 'chatgpt-companion:execute') return false;
  (async () => {
    if (message.job?.type === 'history-index') return { ok: true, history: await historyIndex() };
    if (message.job?.type === 'capture-all-api') return { ok: true, ...(await chatgptApiCaptureBatch(message.job?.conversations || [])) };
    if (message.job?.type === 'capture') return { ok: true, snapshot: pageSnapshot() };
    return { ok: true, ...(await sendPrompt(String(message.job?.prompt || ''))) };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
})();
