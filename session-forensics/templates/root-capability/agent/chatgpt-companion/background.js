const DEFAULT_AGENT_URL = 'http://127.0.0.1:8890';
const EXPECTED_PAGE_READER_VERSION = '2.5.0';
const DEFAULT_BRIDGE_PATH = '/api/runtime/chatgpt-web';
const BRIDGE_PATHS = ['/api/runtime/chatgpt-web', '/api/web-chat'];
const PLATFORMS = {
  chatgpt: { name: 'ChatGPT', homeUrl: 'https://chatgpt.com/', pattern: 'https://chatgpt.com/*', legacyPattern: 'https://chat.openai.com/*' },
  deepseek: { name: 'DeepSeek', homeUrl: 'https://chat.deepseek.com/', pattern: 'https://chat.deepseek.com/*' },
  gemini: { name: 'Gemini', homeUrl: 'https://gemini.google.com/app', pattern: 'https://gemini.google.com/*' },
  doubao: { name: '豆包', homeUrl: 'https://www.doubao.com/chat/', pattern: 'https://www.doubao.com/*' },
};
const WEB_CHAT_PATTERNS = [...new Set(Object.values(PLATFORMS).flatMap((item) => [item.pattern, item.legacyPattern].filter(Boolean)))];
let pollTimer = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let busy = false;
const pageReaderPreparations = new Map();

function platformId(value) {
  const normalized = String(value || '').toLowerCase();
  return Object.hasOwn(PLATFORMS, normalized) ? normalized : 'chatgpt';
}

function bridgePath(value) {
  return BRIDGE_PATHS.includes(String(value || '').trim()) ? String(value).trim() : DEFAULT_BRIDGE_PATH;
}

function agentUrl(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_AGENT_URL).trim());
    const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    return local && ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : DEFAULT_AGENT_URL;
  } catch {
    return DEFAULT_AGENT_URL;
  }
}

function platformFromUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return 'chatgpt';
    if (host === 'chat.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
    if (host === 'gemini.google.com') return 'gemini';
    if (host === 'doubao.com' || host.endsWith('.doubao.com')) return 'doubao';
  } catch {}
  return '';
}

async function storedConnection() {
  const value = await chrome.storage.local.get(['agentUrl', 'bridgePath', 'token', 'preferredPlatform']);
  return {
    agentUrl: agentUrl(value.agentUrl),
    bridgePath: bridgePath(value.bridgePath),
    token: String(value.token || ''),
    preferredPlatform: platformId(value.preferredPlatform),
  };
}

async function api(suffix = '', { method = 'GET', body, authenticated = true } = {}) {
  const { agentUrl: baseUrl, bridgePath: basePath, token } = await storedConnection();
  const headers = { 'content-type': 'application/json' };
  if (authenticated && token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${basePath}${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `本机 Agent 请求失败：${response.status}`);
  return payload;
}

async function honorJobControl(jobId, response) {
  let control = response?.job?.control || response?.control || 'continue';
  while (control === 'pause') {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const status = await api(`/jobs/${encodeURIComponent(jobId)}`);
    control = status?.job?.control || 'continue';
  }
  if (control === 'cancel') throw new Error('任务已取消');
}

function localOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

async function discoverLocalWorkbench() {
  const connection = await storedConnection();
  const tabs = await chrome.tabs.query({});
  const localTabs = tabs
    .map((tab) => ({ url: localOrigin(tab.url), active: Boolean(tab.active), lastAccessed: Number(tab.lastAccessed || 0) }))
    .filter((tab) => tab.url)
    .sort((left, right) => Number(right.active) - Number(left.active) || right.lastAccessed - left.lastAccessed);
  const origins = [...new Set([...localTabs.map((tab) => tab.url), connection.agentUrl, DEFAULT_AGENT_URL])];
  for (const baseUrl of origins) {
    for (const basePath of BRIDGE_PATHS) {
      try {
        const response = await fetch(`${baseUrl}${basePath}`, { headers: { accept: 'application/json' } });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => null);
        const status = payload?.webChat || payload;
        if (!status?.supported || !status?.pairingCode) continue;
        const page = await pageState();
        return {
          ok: true,
          agentUrl: String(status.agentUrl || baseUrl).replace(/\/$/, ''),
          bridgePath: basePath,
          pairingCode: String(status.pairingCode),
          platform: page.pagePlatform || connection.preferredPlatform,
        };
      } catch {}
    }
  }
  throw new Error('没有在当前浏览器标签中找到正在运行的本机工作台。请先保持工作台页面打开，再点击浏览器伴侣图标。');
}

async function webChatTab({ create = false, platform } = {}) {
  const wanted = platformId(platform || (await storedConnection()).preferredPlatform);
  const tabs = await chrome.tabs.query({ url: WEB_CHAT_PATTERNS });
  const matching = tabs.filter((tab) => platformFromUrl(tab.url) === wanted);
  const any = tabs.filter((tab) => platformFromUrl(tab.url));
  const candidate = [...matching.filter((tab) => tab.active), ...matching, ...any.filter((tab) => tab.active), ...any][0];
  if (candidate) return candidate;
  if (!create) return null;
  return chrome.tabs.create({ url: PLATFORMS[wanted].homeUrl });
}

async function pingPageReader(tab, selected) {
  if (!tab?.id) throw new Error('没有找到可探测的网页标签。');
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'chatgpt-companion:ping' });
  if (!response?.ok || !response?.ready) throw new Error('页面读取器没有返回就绪状态。');
  if (response.platform !== selected) throw new Error(`页面读取器当前属于 ${response.platform || '未知平台'}，不是 ${selected}。`);
  if (response.version !== EXPECTED_PAGE_READER_VERSION) throw new Error(`页面读取器版本过旧：${response.version || '未知'}，期望 ${EXPECTED_PAGE_READER_VERSION}。`);
  return response;
}

async function preparePageReader(tab, selected) {
  if (!tab?.id) throw new Error(`没有找到可读取的 ${PLATFORMS[selected].name} 网页标签。`);
  if (platformFromUrl(tab.url) !== selected) throw new Error(`当前标签页不是 ${PLATFORMS[selected].name} 页面。`);
  if (tab.status !== 'complete') await waitForTabReady(tab.id);
  try {
    return await pingPageReader(tab, selected);
  } catch (firstError) {
    let injectionError = null;
    try {
      if (!chrome.scripting?.executeScript) throw new Error('当前扩展进程尚未启用动态脚本权限。');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await sleep(180);
      return await pingPageReader(tab, selected);
    } catch (error) {
      injectionError = error;
    }
    try {
      await chrome.tabs.reload(tab.id);
      await waitForTabReady(tab.id);
      await sleep(300);
      return await pingPageReader(tab, selected);
    } catch (reloadError) {
      const details = [firstError, injectionError, reloadError].map((error) => error?.message).filter(Boolean).join('；');
      throw new Error(`${PLATFORMS[selected].name} 页面读取器没有就绪，自动注入和页面重载均未成功：${details || '未知错误'}`);
    }
  }
}

async function ensurePageReader(tab, selected) {
  const existing = pageReaderPreparations.get(tab.id);
  if (existing) return existing;
  const preparation = preparePageReader(tab, selected).finally(() => pageReaderPreparations.delete(tab.id));
  pageReaderPreparations.set(tab.id, preparation);
  return preparation;
}

async function pageState() {
  const tab = await webChatTab();
  const detected = platformFromUrl(tab?.url);
  let pageReaderReady = false;
  let pageReaderVersion = '';
  let pageReaderError = '';
  if (tab?.id && detected) {
    try {
      const reader = await ensurePageReader(tab, detected);
      pageReaderReady = true;
      pageReaderVersion = String(reader?.version || '');
    } catch (error) {
      pageReaderError = error?.message || '页面读取器尚未就绪。';
    }
  }
  return {
    pageTitle: tab?.title || '',
    pageUrl: tab?.url || '',
    pagePlatform: detected || '',
    pagePlatformName: detected ? PLATFORMS[detected].name : '',
    pageReaderReady,
    pageReaderVersion,
    pageReaderError,
    browserName: 'Chrome / Edge 浏览器扩展',
  };
}

async function heartbeat() {
  const { token } = await storedConnection();
  if (!token) return;
  try {
    await api('/heartbeat', { method: 'POST', body: await pageState() });
  } catch (error) {
    await chrome.storage.local.set({ lastError: error.message, token: '' });
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTabReady(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') return tab;
    } catch {}
    await sleep(250);
  }
  throw new Error('网页在规定时间内没有加载完成。');
}

async function captureTab(tab, platform) {
  await waitForTabReady(tab.id);
  await ensurePageReader(tab, platform);
  await sleep(1_200);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'chatgpt-companion:execute', job: { type: 'capture', platform } });
      if (result?.ok) return result;
      throw new Error(result?.error || '网页没有返回完整会话内容。');
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1_200);
    }
  }
  throw new Error('网页读取失败。');
}

async function executeBatchJob(job) {
  const selected = platformId(job?.platform || (await storedConnection()).preferredPlatform);
  const conversations = Array.isArray(job?.conversations) ? job.conversations : [];
  let completedCount = 0;
  let failedCount = 0;
  for (const item of conversations) {
    let tab = null;
    try {
      await honorJobControl(job.id, await api(`/jobs/${encodeURIComponent(job.id)}`));
      tab = await chrome.tabs.create({ url: item.url, active: false });
      const result = await captureTab(tab, selected);
      const snapshot = { ...(result.snapshot || result.result || {}), title: item.title || result.snapshot?.title, url: item.url || result.snapshot?.url };
      completedCount += 1;
      await honorJobControl(job.id, await api(`/jobs/${encodeURIComponent(job.id)}/progress`, { method: 'POST', body: { snapshot, completedCount, failedCount, lastTitle: snapshot.title || item.title || '' } }));
    } catch (error) {
      if (String(error?.message || '').includes('任务已取消')) throw error;
      failedCount += 1;
      const progress = await api(`/jobs/${encodeURIComponent(job.id)}/progress`, { method: 'POST', body: { completedCount, failedCount, lastTitle: item.title || '' } });
      await honorJobControl(job.id, progress);
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  return { ok: true, capturesFromProgress: true, capturedCount: completedCount, failedCount, totalCount: conversations.length };
}

async function executeChatGptApiBatchJob(job, tab, selected) {
  const conversations = Array.isArray(job?.conversations) ? job.conversations : [];
  let completedCount = 0;
  let failedCount = 0;
  await waitForTabReady(tab.id);
  await ensurePageReader(tab, selected);
  for (let offset = 0; offset < conversations.length; offset += 4) {
    await honorJobControl(job.id, await api(`/jobs/${encodeURIComponent(job.id)}`));
    const chunk = conversations.slice(offset, offset + 4);
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'chatgpt-companion:execute',
      job: { type: 'capture-all-api', platform: selected, conversations: chunk },
    });
    if (!result?.ok) throw new Error(result?.error || '网页接口没有返回批量会话内容。');
    const chunkCaptures = Array.isArray(result.captures) ? result.captures : [];
    const chunkFailures = Array.isArray(result.failures) ? result.failures : [];
    const reportedFailed = Number(result.failedCount || 0);
    const representedFailed = Math.max(chunkFailures.length, chunk.length - chunkCaptures.length);
    const chunkFailed = Math.max(reportedFailed, representedFailed);
    failedCount += chunkFailed;
    for (const snapshot of chunkCaptures) {
      completedCount += 1;
      const progress = await api(`/jobs/${encodeURIComponent(job.id)}/progress`, {
        method: 'POST',
        body: { snapshot, completedCount, failedCount, lastTitle: snapshot.title || '' },
      });
      await honorJobControl(job.id, progress);
    }
    for (const failure of chunkFailures) {
      const progress = await api(`/jobs/${encodeURIComponent(job.id)}/progress`, {
        method: 'POST',
        body: {
          completedCount,
          failedCount,
          failure: { conversationId: failure.conversationId || '', title: failure.title || '', error: failure.error || '未知原因' },
          lastTitle: `读取失败：${failure.title || failure.conversationId || '未命名会话'}｜${failure.error || '未知原因'}`,
        },
      });
      await honorJobControl(job.id, progress);
    }
  }
  return { ok: true, capturesFromProgress: true, capturedCount: completedCount, failedCount, totalCount: conversations.length };
}

async function executeJob(job) {
  const selected = platformId(job?.platform || (await storedConnection()).preferredPlatform);
  if (job?.type === 'capture-all' && selected === 'chatgpt') {
    const tab = await webChatTab({ create: true, platform: selected });
    if (!tab?.id) throw new Error('没有找到可读取的 ChatGPT 网页标签。');
    return executeChatGptApiBatchJob({ ...job, platform: selected }, tab, selected);
  }
  if (job?.type === 'capture-all') return executeBatchJob({ ...job, platform: selected });
  const tab = await webChatTab({ create: true, platform: selected });
  if (!tab?.id) throw new Error(`没有找到可操作的 ${PLATFORMS[selected].name} 网页标签。`);
  await ensurePageReader(tab, selected);
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'chatgpt-companion:execute', job: { ...job, platform: selected } });
  } catch (error) {
    throw new Error(`${PLATFORMS[selected].name} 页面读取失败。${error?.message ? ` ${error.message}` : ''}`);
  }
}

async function poll() {
  if (busy) return;
  const { token } = await storedConnection();
  if (!token) return;
  busy = true;
  try {
    const response = await api('/jobs/next');
    if (!response.job) return;
    try {
      const result = await executeJob(response.job);
      if (!result?.ok) throw new Error(result?.error || '网页聊天页面没有返回结果。');
      await api(`/jobs/${encodeURIComponent(response.job.id)}/complete`, { method: 'POST', body: result });
    } catch (error) {
      await api(`/jobs/${encodeURIComponent(response.job.id)}/complete`, { method: 'POST', body: { error: error.message } });
    }
  } catch (error) {
      await chrome.storage.local.set({ lastError: error.message, token: '' });
  } finally {
    busy = false;
  }
}

function startTimers() {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  pollTimer = setInterval(poll, 1000);
  heartbeatTimer = setInterval(heartbeat, 4000);
  void heartbeat();
  void poll();
}

async function autoReconnect() {
  const connection = await storedConnection();
  if (connection.token) return;
  try {
    await autoPair({ platform: connection.preferredPlatform });
  } catch {
    // 工作台或网页标签尚未打开时静默等待下一轮。
  }
}

function startConnectionMaintenance() {
  clearInterval(reconnectTimer);
  reconnectTimer = setInterval(autoReconnect, 5000);
  void autoReconnect();
}

async function pair({ agentUrl: requestedUrl, bridgePath: requestedPath, pairingCode, platform }) {
  const cleanUrl = agentUrl(requestedUrl);
  const cleanPath = bridgePath(requestedPath);
  const preferredPlatform = platformId(platform);
  await chrome.storage.local.set({ agentUrl: cleanUrl, bridgePath: cleanPath, token: '', preferredPlatform, lastError: '' });
  const raw = await api('/pair', { method: 'POST', authenticated: false, body: { pairingCode, browserName: 'Chrome / Edge 浏览器扩展' } });
  const result = raw?.pairing || raw;
  if (!result?.token) throw new Error('工作台没有返回可用的配对结果，请刷新工作台后重试。');
  await chrome.storage.local.set({ agentUrl: cleanUrl, bridgePath: cleanPath, token: result.token, preferredPlatform, lastError: '' });
  startTimers();
  return { ok: true, agentUrl: cleanUrl, bridgePath: cleanPath, platform: preferredPlatform };
}

async function autoPair({ platform } = {}) {
  const found = await discoverLocalWorkbench();
  const result = await pair({ ...found, platform: platform || found.platform });
  return { ...result, discovery: found };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'companion:pair') return pair(message);
    if (message?.type === 'companion:disconnect') {
      const current = await storedConnection();
      if (current.token) await api('/disconnect', { method: 'POST', body: {} }).catch(() => {});
      await chrome.storage.local.set({ token: '', lastError: '' });
      return { ok: true };
    }
    if (message?.type === 'companion:open-platform') {
      const selected = platformId(message.platform);
      await chrome.storage.local.set({ preferredPlatform: selected });
      const tab = await webChatTab({ create: true, platform: selected });
      if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
      return { ok: true, platform: selected };
    }
    if (message?.type === 'companion:state') {
      const connection = await storedConnection();
      const stored = await chrome.storage.local.get(['lastError']);
      const rawStatus = connection.token ? await api('').catch(() => null) : null;
      const status = rawStatus?.webChat || rawStatus;
      return {
        ok: true,
        ...connection,
        connected: Boolean(status?.connected),
        pagePlatform: status?.pagePlatform || '',
        pagePlatformName: status?.pagePlatformName || '',
        pageTitle: status?.pageTitle || '',
        lastError: stored.lastError || '',
      };
    }
    if (message?.type === 'companion:discover') return discoverLocalWorkbench();
    if (message?.type === 'companion:auto-pair') return autoPair(message);
    return { ok: false, error: '未知伴侣操作。' };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onStartup.addListener(startTimers);
chrome.runtime.onStartup.addListener(startConnectionMaintenance);
chrome.runtime.onInstalled.addListener(startTimers);
chrome.runtime.onInstalled.addListener(startConnectionMaintenance);
void storedConnection().then(({ token }) => {
  if (token) startTimers();
  startConnectionMaintenance();
});
