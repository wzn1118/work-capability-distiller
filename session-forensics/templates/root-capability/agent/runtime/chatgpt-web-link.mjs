import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { cleanText, createId, HttpError } from './shared.mjs';

const CONNECTION_TTL_MS = 15_000;
const JOB_TTL_MS = 30 * 60_000;
const WEB_CHAT_PLATFORMS = {
  chatgpt: { name: 'ChatGPT', homeUrl: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'chat.openai.com'] },
  deepseek: { name: 'DeepSeek', homeUrl: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'] },
  gemini: { name: 'Gemini', homeUrl: 'https://gemini.google.com/app', hosts: ['gemini.google.com'] },
  doubao: { name: '豆包', homeUrl: 'https://www.doubao.com/chat/', hosts: ['www.doubao.com', 'doubao.com'] },
};

function pairingCode() {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function platformId(value) {
  const normalized = cleanText(value, 40).trim().toLowerCase();
  return Object.hasOwn(WEB_CHAT_PLATFORMS, normalized) ? normalized : 'chatgpt';
}

function platformFromUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return Object.entries(WEB_CHAT_PLATFORMS).find(([, item]) => item.hosts.includes(host))?.[0] || '';
  } catch {
    return '';
  }
}

function safeWebChatUrl(value, expectedPlatform = '') {
  const fallbackId = platformId(expectedPlatform);
  try {
    const url = new URL(String(value || WEB_CHAT_PLATFORMS[fallbackId].homeUrl));
    const detected = platformFromUrl(url.href);
    return url.protocol === 'https:' && detected ? url.href : WEB_CHAT_PLATFORMS[fallbackId].homeUrl;
  } catch {
    return WEB_CHAT_PLATFORMS[fallbackId].homeUrl;
  }
}

function bearerToken(request) {
  const header = String(request.headers.authorization || '');
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function openExternal(target, { directory = false } = {}) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = directory ? 'explorer.exe' : 'cmd.exe';
    args = directory ? [target] : ['/d', '/s', '/c', 'start', '', target];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function extensionManagementPage(browser = 'auto') {
  const selected = cleanText(browser, 30).trim().toLowerCase();
  if (selected === 'edge') return { id: 'edge', name: 'Microsoft Edge', url: 'edge://extensions/' };
  if (selected === 'chrome') return { id: 'chrome', name: 'Google Chrome', url: 'chrome://extensions/' };
  return process.platform === 'win32'
    ? { id: 'edge', name: 'Microsoft Edge', url: 'edge://extensions/' }
    : { id: 'chrome', name: 'Google Chrome', url: 'chrome://extensions/' };
}

function normalizeSnapshot(value, fallbackPlatform = 'chatgpt') {
  const platform = platformId(value?.platform || platformFromUrl(value?.url) || fallbackPlatform);
  const messages = Array.isArray(value?.messages) ? value.messages.map((item, index) => ({
    index: Number(item?.index ?? index),
    role: ['user', 'assistant', 'system', 'tool'].includes(item?.role) ? item.role : 'unknown',
    content: cleanText(item?.content, 200_000).trim(),
    messageId: cleanText(item?.messageId, 300).trim() || null,
  })).filter((item) => item.content) : [];
  return {
    platform,
    platformName: WEB_CHAT_PLATFORMS[platform].name,
    title: cleanText(value?.title, 500).trim() || `未命名 ${WEB_CHAT_PLATFORMS[platform].name} 网页对话`,
    url: safeWebChatUrl(value?.url, platform),
    conversationId: cleanText(value?.conversationId || value?.conversation_id, 300).trim() || null,
    createdAt: cleanText(value?.createdAt || value?.create_time, 80).trim() || null,
    updatedAt: cleanText(value?.updatedAt || value?.update_time, 80).trim() || null,
    projectId: cleanText(value?.projectId || value?.project_id, 300).trim() || null,
    projectTitle: cleanText(value?.projectTitle || value?.project_title, 500).trim() || null,
    capturedAt: new Date().toISOString(),
    messages,
  };
}

function normalizeHistory(value, fallbackPlatform = 'chatgpt') {
  const platform = platformId(value?.platform || platformFromUrl(value?.currentUrl) || fallbackPlatform);
  const homeUrl = WEB_CHAT_PLATFORMS[platform].homeUrl;
  const conversations = Array.isArray(value?.conversations) ? value.conversations.map((item) => ({
    conversationId: cleanText(item?.conversationId || item?.id, 300).trim() || null,
    title: cleanText(item?.title, 500).trim() || `未命名 ${WEB_CHAT_PLATFORMS[platform].name} 对话`,
    url: safeWebChatUrl(item?.url, platform),
    current: Boolean(item?.current),
    createdAt: cleanText(item?.createdAt || item?.create_time, 80).trim() || null,
    updatedAt: cleanText(item?.updatedAt || item?.update_time, 80).trim() || null,
    archived: Boolean(item?.archived || item?.is_archived),
    projectId: cleanText(item?.projectId || item?.project_id, 300).trim() || null,
    projectTitle: cleanText(item?.projectTitle || item?.project_title, 500).trim() || null,
  })).filter((item, index, items) => item.url !== homeUrl && items.findIndex((candidate) => candidate.url === item.url) === index) : [];
  return {
    platform,
    platformName: WEB_CHAT_PLATFORMS[platform].name,
    capturedAt: cleanText(value?.capturedAt, 80).trim() || new Date().toISOString(),
    currentUrl: safeWebChatUrl(value?.currentUrl, platform),
    conversations,
    scan: value?.scan && typeof value.scan === 'object' ? {
      mode: cleanText(value.scan.mode, 80).trim() || 'dom-fallback',
      activePages: Number(value.scan.activePages || 0),
      archivedPages: Number(value.scan.archivedPages || 0),
      projectPages: Number(value.scan.projectPages || 0),
      projectCount: Number(value.scan.projectCount || 0),
      projectEndpoint: cleanText(value.scan.projectEndpoint, 300).trim(),
      containerCount: Number(value.scan.containerCount || 0),
      scrollRounds: Number(value.scan.scrollRounds || 0),
      expandedSections: Number(value.scan.expandedSections || 0),
      discoveredCount: Number(value.scan.discoveredCount || conversations.length),
      exhausted: value.scan.exhausted !== false,
      failures: Array.isArray(value.scan.failures) ? value.scan.failures.slice(0, 50) : [],
      scannedAt: cleanText(value.scan.scannedAt, 80).trim() || null,
    } : null,
  };
}

export function createChatGptWebBridge({ companionRoot, getAgentUrl }) {
  let code = pairingCode();
  let connection = null;
  const jobs = new Map();
  const queue = [];

  function pruneJobs() {
    const threshold = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (new Date(job.updatedAt).getTime() < threshold) jobs.delete(id);
  }

  function connected() {
    return Boolean(connection && Date.now() - connection.lastSeenAt < CONNECTION_TTL_MS);
  }

  function publicConnection() {
    pruneJobs();
    return {
      supported: true,
      connected: connected(),
      state: connected() ? '已连接' : connection ? '连接已中断' : '等待配对',
      pairingCode: code,
      agentUrl: getAgentUrl(),
      companionRoot,
      lastSeenAt: connection?.lastSeenAt ? new Date(connection.lastSeenAt).toISOString() : null,
      pageTitle: connection?.pageTitle || '',
      pageUrl: connection?.pageUrl || '',
      pagePlatform: connection?.pagePlatform || '',
      pagePlatformName: connection?.pagePlatformName || '',
      pageReaderReady: Boolean(connection?.pageReaderReady),
      pageReaderVersion: connection?.pageReaderVersion || '',
      pageReaderError: connection?.pageReaderError || '',
      browserName: connection?.browserName || '',
      queueLength: queue.length,
      supportedPlatforms: Object.entries(WEB_CHAT_PLATFORMS).map(([id, item]) => ({ id, name: item.name, homeUrl: item.homeUrl })),
      capabilities: ['连续扫描并展开四个平台网页端的历史对话目录', '返回真实标题、链接、扫描轮次和目录是否扫完', '按真实网页地址批量读取完整聊天记录', '读取当前完整聊天记录', '导入当前工作台解析', '复用浏览器已有登录状态'],
      privacy: '只在用户点击对应平台读取按钮时读取当前页面内容或历史目录；不读取、导出或保存 Cookie、账号密码和网页令牌。',
    };
  }

  function authenticate(request) {
    const token = bearerToken(request);
    if (!connection || !token || token.length !== connection.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(connection.token))) {
      throw new HttpError(401, 'web_chat_companion_unauthorized', '网页聊天记录伴侣尚未完成配对，或配对已经失效。');
    }
    connection.lastSeenAt = Date.now();
    return connection;
  }

  function pair(payload) {
    if (String(payload?.pairingCode || '').trim() !== code) throw new HttpError(401, 'invalid_pairing_code', '配对码不正确，请回到当前工作台查看最新六位配对码。');
    connection = {
      token: crypto.randomBytes(32).toString('base64url'),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      browserName: cleanText(payload?.browserName, 120).trim() || 'Chrome 浏览器',
      pageTitle: '',
      pageUrl: '',
      pagePlatform: '',
      pagePlatformName: '',
      pageReaderReady: false,
      pageReaderVersion: '',
      pageReaderError: '',
    };
    code = pairingCode();
    return { ok: true, token: connection.token, agentUrl: getAgentUrl(), pollIntervalMs: 1_000, heartbeatIntervalMs: 4_000 };
  }

  function heartbeat(request, payload) {
    const current = authenticate(request);
    current.pageTitle = cleanText(payload?.pageTitle, 500).trim();
    current.pagePlatform = platformId(payload?.pagePlatform || platformFromUrl(payload?.pageUrl));
    current.pagePlatformName = WEB_CHAT_PLATFORMS[current.pagePlatform].name;
    current.pageUrl = payload?.pageUrl ? safeWebChatUrl(payload.pageUrl, current.pagePlatform) : '';
    current.pageReaderReady = Boolean(payload?.pageReaderReady);
    current.pageReaderVersion = cleanText(payload?.pageReaderVersion, 80).trim();
    current.pageReaderError = cleanText(payload?.pageReaderError, 1_000).trim();
    current.browserName = cleanText(payload?.browserName, 120).trim() || current.browserName;
    return { ok: true, connected: true, serverTime: new Date().toISOString() };
  }

  function publicJob(job, { includePayload = false } = {}) {
    const processedCount = Number(job.completedCount || 0) + Number(job.failedCount || 0);
    const startedAt = Date.parse(job.startedAt || job.createdAt || 0);
    const elapsedSeconds = startedAt ? Math.max(1, (Date.now() - startedAt) / 1000) : 0;
    const ratePerMinute = elapsedSeconds ? Math.round((processedCount / elapsedSeconds) * 60 * 10) / 10 : 0;
    const remainingCount = Math.max(0, Number(job.totalCount || 0) - processedCount);
    const value = {
      id: job.id,
      type: job.type,
      platform: job.platform,
      platformName: job.platformName,
      status: job.status,
      prompt: job.prompt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      totalCount: job.totalCount || 0,
      completedCount: job.completedCount || 0,
      failedCount: job.failedCount || 0,
      skippedCount: job.skippedCount || 0,
      remainingCount,
      phase: job.phase || (job.status === '完成' ? 'reconciled' : 'queued'),
      control: job.cancelRequested ? 'cancel' : job.pauseRequested ? 'pause' : 'continue',
      startedAt: job.startedAt || null,
      lastCheckpointAt: job.lastCheckpointAt || null,
      ratePerMinute,
      etaSeconds: ratePerMinute > 0 ? Math.ceil((remainingCount / ratePerMinute) * 60) : null,
      lastTitle: job.lastTitle || '',
      events: Array.isArray(job.events) ? job.events.slice(-80) : [],
      result: job.result,
      error: job.error,
    };
    if (includePayload && job.type === 'capture-all') value.conversations = job.conversations;
    return value;
  }

  function enqueue(payload) {
    if (!connected()) throw new HttpError(409, 'web_chat_companion_offline', '网页聊天记录伴侣尚未连接。请先安装浏览器伴侣并完成配对。');
    const type = ['capture', 'history-index', 'capture-all'].includes(payload?.type) ? payload.type : 'prompt';
    const platform = platformId(payload?.platform);
    const prompt = type === 'prompt' ? cleanText(payload?.prompt, 32_000).trim() : '';
    if (type === 'prompt' && !prompt) throw new HttpError(400, 'empty_web_chat_prompt', `发送给 ${WEB_CHAT_PLATFORMS[platform].name} 的任务不能为空。`);
    const conversations = type === 'capture-all' && Array.isArray(payload?.conversations)
      ? payload.conversations.map((item) => ({
        conversationId: cleanText(item?.conversationId || item?.id, 300).trim() || null,
        title: cleanText(item?.title, 500).trim(),
        url: safeWebChatUrl(item?.url, platform),
        createdAt: cleanText(item?.createdAt || item?.create_time, 80).trim() || null,
        updatedAt: cleanText(item?.updatedAt || item?.update_time, 80).trim() || null,
        projectId: cleanText(item?.projectId || item?.project_id, 300).trim() || null,
        projectTitle: cleanText(item?.projectTitle || item?.project_title, 500).trim() || null,
      })).filter((item) => item.url !== WEB_CHAT_PLATFORMS[platform].homeUrl).slice(0, 5000)
      : [];
    if (type === 'capture-all' && !conversations.length) throw new HttpError(400, 'empty_web_chat_batch', '没有可读取的网页会话，请先读取真实会话目录。');
    const timestamp = new Date().toISOString();
    const job = { id: createId('web-chat'), type, platform, platformName: WEB_CHAT_PLATFORMS[platform].name, status: '等待网页执行', phase: type === 'history-index' ? 'discovering' : 'queued', prompt, conversations, totalCount: conversations.length, completedCount: 0, failedCount: 0, skippedCount: Number(payload?.skippedCount || 0), lastTitle: '', createdAt: timestamp, startedAt: null, lastCheckpointAt: null, updatedAt: timestamp, pauseRequested: false, cancelRequested: false, events: [{ id: 1, type: 'run_created', at: timestamp, message: '同步任务已创建。' }], result: null, error: null };
    jobs.set(job.id, job);
    queue.push(job.id);
    return publicJob(job);
  }

  function nextJob(request) {
    authenticate(request);
    while (queue.length) {
      const job = jobs.get(queue.shift());
      if (!job || job.status !== '等待网页执行') continue;
      job.status = '网页执行中';
      job.phase = job.type === 'history-index' ? 'discovering' : 'capturing';
      job.startedAt ||= new Date().toISOString();
      job.events.push({ id: job.events.length + 1, type: 'run_started', at: new Date().toISOString(), message: '浏览器伴侣已开始执行。' });
      job.updatedAt = new Date().toISOString();
      return { job: publicJob(job, { includePayload: true }) };
    }
    return { job: null };
  }

  function complete(request, id, payload) {
    authenticate(request);
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    if (job.cancelRequested || job.status === '已取消') {
      job.status = '已取消';
      job.phase = 'cancelled';
      job.error = null;
      job.result = null;
    } else if (payload?.error) {
      job.status = '失败';
      job.phase = 'failed';
      job.error = cleanText(payload.error, 4_000).trim();
      job.result = null;
    } else if (job.type === 'capture') {
      job.status = '完成';
      job.phase = 'reconciled';
      job.result = { snapshot: normalizeSnapshot(payload?.snapshot || payload?.result, job.platform) };
      job.error = null;
    } else if (job.type === 'capture-all') {
      job.status = '完成';
      job.phase = 'reconciled';
      const captures = Array.isArray(payload?.captures) ? payload.captures.map((item) => normalizeSnapshot(item, job.platform)) : (Array.isArray(job.captures) ? job.captures : []);
      job.result = { captures, capturedCount: captures.length, failedCount: job.failedCount || 0, totalCount: job.totalCount || captures.length };
      job.completedCount = captures.length;
      job.error = null;
    } else if (job.type === 'history-index') {
      job.status = '完成';
      job.phase = 'discovered';
      job.result = { history: normalizeHistory(payload?.history || payload?.result, job.platform) };
      job.error = null;
    } else {
      job.status = '完成';
      job.phase = 'reconciled';
      job.result = { answer: cleanText(payload?.answer, 64_000).trim(), snapshot: payload?.snapshot ? normalizeSnapshot(payload.snapshot, job.platform) : null };
      job.error = null;
    }
    job.updatedAt = new Date().toISOString();
    job.lastCheckpointAt = job.updatedAt;
    job.events.push({ id: job.events.length + 1, type: job.status === '完成' ? 'run_completed' : job.status === '已取消' ? 'run_cancelled' : 'run_failed', at: job.updatedAt, message: job.error || `任务状态：${job.status}` });
    return publicJob(job);
  }

  function progress(request, id, payload) {
    authenticate(request);
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    if (job.type !== 'capture-all') throw new HttpError(400, 'web_chat_progress_not_supported', '当前任务不支持批量读取进度。');
    if (!job.pauseRequested && !job.cancelRequested) job.status = '网页批量读取中';
    job.phase = job.pauseRequested ? 'paused' : job.cancelRequested ? 'cancelled' : 'persisting';
    job.completedCount = Math.max(job.completedCount || 0, Number(payload?.completedCount || 0));
    job.failedCount = Math.max(job.failedCount || 0, Number(payload?.failedCount || 0));
    job.lastTitle = cleanText(payload?.lastTitle, 500).trim();
    if (payload?.snapshot) {
      if (!Array.isArray(job.captures)) job.captures = [];
      if (job.captures.length < job.totalCount) job.captures.push(normalizeSnapshot(payload.snapshot, job.platform));
    }
    job.updatedAt = new Date().toISOString();
    job.lastCheckpointAt = job.updatedAt;
    job.events.push({ id: job.events.length + 1, type: payload?.failure ? 'conversation_failed' : payload?.snapshot ? 'conversation_completed' : 'progress_updated', at: job.updatedAt, message: job.lastTitle || `已处理 ${job.completedCount + job.failedCount}/${job.totalCount}` });
    if (job.events.length > 240) job.events.splice(0, job.events.length - 240);
    return publicJob(job);
  }

  function pauseJob(id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    if (['完成', '失败', '已取消'].includes(job.status)) return publicJob(job);
    job.pauseRequested = true;
    job.status = '已暂停';
    job.phase = 'paused';
    job.updatedAt = new Date().toISOString();
    job.events.push({ id: job.events.length + 1, type: 'run_paused', at: job.updatedAt, message: '用户暂停了同步任务。' });
    return publicJob(job);
  }

  function resumeJob(id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    if (['完成', '失败', '已取消'].includes(job.status)) return publicJob(job);
    job.pauseRequested = false;
    job.status = job.startedAt ? '网页批量读取中' : '等待网页执行';
    job.phase = job.startedAt ? 'capturing' : 'queued';
    if (!job.startedAt && !queue.includes(job.id)) queue.push(job.id);
    job.updatedAt = new Date().toISOString();
    job.events.push({ id: job.events.length + 1, type: 'run_resumed', at: job.updatedAt, message: '同步任务已继续。' });
    return publicJob(job);
  }

  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    job.cancelRequested = true;
    job.pauseRequested = false;
    job.status = '已取消';
    job.phase = 'cancelled';
    job.updatedAt = new Date().toISOString();
    job.events.push({ id: job.events.length + 1, type: 'run_cancelled', at: job.updatedAt, message: '用户取消了同步任务，已保存的检查点仍然保留。' });
    return publicJob(job);
  }

  function getJob(id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'web_chat_job_not_found', '找不到这条网页聊天记录任务。');
    return publicJob(job);
  }

  function disconnect() {
    connection = null;
    code = pairingCode();
    for (const job of jobs.values()) {
      if (['等待网页执行', '网页执行中'].includes(job.status)) {
        job.status = '失败';
        job.error = '网页聊天记录连接已断开。';
        job.updatedAt = new Date().toISOString();
      }
    }
    queue.length = 0;
    return publicConnection();
  }

  return {
    status: publicConnection,
    authenticate,
    pair,
    heartbeat,
    enqueue,
    nextJob,
    complete,
    progress,
    pauseJob,
    resumeJob,
    cancelJob,
    getJob,
    disconnect,
    openWebChat(value = {}) {
      const platform = platformId(typeof value === 'string' ? value : value?.platform);
      openExternal(WEB_CHAT_PLATFORMS[platform].homeUrl);
      return { ok: true, platform, platformName: WEB_CHAT_PLATFORMS[platform].name, message: `已请求系统浏览器打开 ${WEB_CHAT_PLATFORMS[platform].name}。` };
    },
    openChatGpt() { return this.openWebChat({ platform: 'chatgpt' }); },
    openCompanionFolder() { openExternal(path.resolve(companionRoot), { directory: true }); return { ok: true, path: path.resolve(companionRoot) }; },
    openBrowserExtensions(browser = 'auto') {
      const page = extensionManagementPage(browser);
      openExternal(page.url);
      return { ok: true, ...page };
    },
    setupCompanion({ browser = 'auto' } = {}) {
      const companion = this.openCompanionFolder();
      const extensionPage = this.openBrowserExtensions(browser);
      return {
        ok: true,
        companion,
        extensionPage,
        agentUrl: getAgentUrl(),
        pairingCode: code,
        nextAction: '在扩展管理页点击一次“加载已解压的扩展程序”，选择刚打开的伴侣文件夹；扩展弹窗会自动发现并连接当前工作台。',
      };
    },
  };
}
