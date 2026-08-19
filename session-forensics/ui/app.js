const $ = (selector) => document.querySelector(selector);
const CHATGPT_BATCH_JOB_STORAGE_KEY = 'conversation-distiller.chatgpt-batch-job';
const state = {
  activeWorkbenchView: 'local',
  workbenchSearchTerms: { local: '', web: '' },
  sessionSearch: {
    local: { query: '', status: 'idle', matches: new Map(), stats: null, error: '', kindFilter: 'all' },
    web: { query: '', status: 'idle', matches: new Map(), stats: null, error: '', kindFilter: 'all' },
  },
  packageLibrary: [],
  packageLibraryTotal: 0,
  packageLibraryLoaded: false,
  packageLibraryError: false,
  result: null,
  package: null,
  packageKey: '',
  packageView: 'overview',
  packageDocuments: new Map(),
  packageDocumentLinks: {},
  agentStatusTimer: null,
  run: null,
  runSelectionKey: '',
  contextPreviewKey: '',
  contextPreview: null,
  activeTab: 'timeline',
  catalogSources: [],
  workspaceCatalog: null,
  sourceByKey: new Map(),
  selectedSourceKeys: new Set(),
  selectedWorkspaceIds: new Set(),
  excludedWorkspaceSourceKeys: new Set(),
  selectionMode: 'sessions',
  pickedSourcePaths: [],
  idResolutionResults: [],
  fileResolutionResults: [],
  webChat: {
    platform: 'chatgpt',
    connection: null,
    history: null,
    importedSources: [],
    coverage: null,
    coverageTimer: null,
    captureAllJob: null,
    captureAllMonitorPromise: null,
    busy: false,
    historyAutoAttempted: false,
    historyAutoLoading: false,
    setupPrepared: false,
    setupPanelOpen: false,
    setupTimer: null,
    setupStartedAt: 0,
  },
};

const WEB_CHAT_LABELS = {
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  doubao: '豆包',
};
const sessionSearchControllers = { local: null, web: null };
let sessionSearchTimer = null;

const LABELS = {
  'session-analysis': '会话分析',
  'skill-packaging': '技能封装',
  'mcp-integration': '服务接口集成',
  'ui-integration': '界面集成',
  'analysis-report': '分析报告',
  verification: '验证验收',
  debugging: '问题修复',
  'general-request': '通用请求',
  orchestration: '协同编排',
  'source-discovery': '来源发现',
  inspection: '检查与取证',
  implementation: '实现与修改',
  execution: '命令执行',
  'artifact-generation': '产物生成',
  'tool-use': '工具调用',
  direct: '直接证据',
  inferred: '时序推断',
  add: '新增',
  update: '更新',
  modify: '修改',
  delete: '删除',
  tool_argument: '工具参数',
  runtime_event: '运行时事件',
  discovery: '来源发现',
  verification: '验证验收',
  'repository-inspection': '仓库检查',
  'external-research': '外部资料检索',
  'script-execution': '脚本执行',
  command: '命令执行',
  strong: '强证据',
  moderate: '中等证据',
  weak: '弱证据',
};

function setStatus(message, error = false) {
  const node = $('#status');
  node.textContent = message;
  node.classList.toggle('error', error);
}

const WORKBENCH_VIEWS = {
  local: {
    kicker: '本机对话',
    title: '选择并蒸馏本机会话',
    description: '从真实标题中选择一条或多条 Codex 会话，确认范围后开始蒸馏。',
    searchLabel: '搜索本机工作',
    searchPlaceholder: '搜索标题、用户需求、助手回复或工具内容',
    refreshTitle: '重新扫描本机会话',
  },
  web: {
    kicker: '网页端对话',
    title: '读取并蒸馏网页会话',
    description: '连接已登录的网页聊天，读取真实历史或当前对话，再勾选需要蒸馏的记录。',
    searchLabel: '搜索已读取的网页会话',
    searchPlaceholder: '搜索平台、标题、ChatGPT 消息或工具内容',
    refreshTitle: '刷新网页会话与连接状态',
  },
  results: {
    kicker: '结果',
    title: '查看蒸馏结果',
    description: '集中查看系统建议、P0-P3、已生成能力包和完整证据。',
  },
};

function activeSearchQuery(scope) {
  const value = state.activeWorkbenchView === scope
    ? $('#session-search')?.value
    : state.workbenchSearchTerms[scope];
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function clientSearchMatch(source, query) {
  const fields = [
    ['标题', source.title],
    ['会话编号', source.sessionId],
    ['文件路径', source.sourcePath],
    ['工作区', ...(source.workspacePaths || [])],
    ['来源', ...(source.discoveredBy || [])],
    ['平台', source.webChat?.platformName, source.webChat?.platform],
    ['项目', source.webChat?.projectTitle],
    ['用户消息', source.webChat?.userPreview],
    ['助手回复', source.webChat?.assistantPreview],
  ];
  for (const [field, ...values] of fields) {
    for (const value of values) {
      if (String(value || '').toLocaleLowerCase('zh-CN').includes(query)) return { field, snippet: String(value || ''), origin: 'metadata' };
    }
  }
  return null;
}

function sessionSearchMatch(source, scope) {
  const query = activeSearchQuery(scope);
  if (!query) return null;
  const search = state.sessionSearch[scope];
  if (search.query === query && ['loading', 'complete'].includes(search.status)) return search.matches.get(sourceKey(source)) || null;
  return clientSearchMatch(source, query);
}

function sourceMatchesSessionSearch(source, scope) {
  return !activeSearchQuery(scope) || Boolean(sessionSearchMatch(source, scope));
}

function highlightedSearchText(value, query) {
  const source = String(value || '').replace(/\s+/g, ' ').trim();
  const index = source.toLocaleLowerCase('zh-CN').indexOf(query);
  if (index < 0) return escape(source);
  return escape(source.slice(0, index)) + '<mark>' + escape(source.slice(index, index + query.length)) + '</mark>' + escape(source.slice(index + query.length));
}

function sessionSearchHitMarkup(source, scope) {
  const query = activeSearchQuery(scope);
  const match = query ? sessionSearchMatch(source, scope) : null;
  if (!match) return '';
  return '<small class="session-search-hit"><b>命中' + escape(match.field || '会话内容') + '</b><span>' + highlightedSearchText(match.snippet || source.title, query) + '</span></small>';
}

function sessionSearchSource(scope, match) {
  const key = String(match?.sourceKey || '');
  const collection = scope === 'web' ? (state.webChat.importedSources || []) : state.catalogSources;
  return state.sourceByKey.get(key) || collection.find((source) => sourceKey(source) === key) || {
    sourceKey: key,
    sessionId: match?.sessionId || null,
    title: match?.title || '未命名会话',
    sourcePath: match?.sourcePath || '',
    importKind: match?.importKind || (scope === 'web' ? 'web-chat' : 'codex'),
    webChat: match?.platform ? { platform: match.platform, platformName: match.platform } : null,
  };
}

function renderSessionSearchPanel(scope = state.activeWorkbenchView) {
  const panel = $('#session-search-results');
  const list = $('#session-search-hit-list');
  const summary = $('#session-search-results-summary');
  const filter = $('#session-search-kind');
  if (!panel || !list || !summary || !['local', 'web'].includes(scope)) return;
  const query = activeSearchQuery(scope);
  const search = state.sessionSearch[scope];
  const kindFilter = search.kindFilter || 'all';
  if (filter && filter.value !== kindFilter) filter.value = kindFilter;
  panel.hidden = !query;
  if (!query) {
    list.innerHTML = '';
    return;
  }
  const allMatches = [...(search.matches?.values() || [])];
  const filtered = allMatches
    .filter((match) => kindFilter === 'all' || match.field === kindFilter)
    .slice(0, 60);
  const status = search.status === 'loading' ? '正在逐条检查完整内容' : search.status === 'complete' ? '完整搜索已完成' : search.status === 'error' ? '搜索出现问题' : '准备搜索完整内容';
  summary.textContent = `${status}；当前显示 ${number(filtered.length)} 条命中，可按类型筛选并定位会话。`;
  if (!filtered.length) {
    list.innerHTML = '<p class="session-search-empty">暂时还没有符合当前类型的正文命中；搜索会继续显示进度。</p>';
    return;
  }
  list.innerHTML = filtered.map((match) => {
    const source = sessionSearchSource(scope, match);
    const platform = scope === 'web' ? (source.webChat?.platformName || match.platform || '网页端') : '本机 Codex';
    const title = displayBusinessTitle(source.title || match.title);
    const location = match.lineNumber ? `第 ${number(match.lineNumber)} 行` : '来源信息';
    return '<article class="session-search-result-row">'
      + '<div class="session-search-result-copy"><strong>' + escape(title) + '</strong>'
      + '<span>' + escape(platform) + ' · ' + escape(match.field || '会话内容') + ' · ' + escape(location) + '</span>'
      + '<p>' + highlightedSearchText(match.snippet || title, query) + '</p></div>'
      + '<button type="button" class="secondary compact-button session-search-locate" data-session-search-source="' + escape(match.sourceKey) + '">定位会话</button>'
      + '</article>';
  }).join('');
}

function renderSessionSearchStatus(scope = state.activeWorkbenchView) {
  const output = $('#session-search-status');
  if (!output || !['local', 'web'].includes(scope)) return;
  const query = activeSearchQuery(scope);
  const search = state.sessionSearch[scope];
  output.dataset.state = search.status;
  if (!query) {
    output.textContent = scope === 'web'
      ? '可搜索网页标题、ChatGPT 用户消息、助手回复、工具调用和图片附件。'
      : '可搜索本机标题、用户需求、助手回复、命令和工具内容。';
    return;
  }
  if (search.status === 'loading' && search.query === query) {
    const stats = search.stats || {};
    output.textContent = stats.totalCount
      ? `正在搜索完整内容：已检查 ${number(stats.scannedCount || 0)} / ${number(stats.totalCount)} 条，已找到 ${number(stats.matchedCount || search.matches.size)} 条……`
      : '正在搜索完整会话内容，请稍候……';
    return;
  }
  if (search.status === 'complete' && search.query === query) {
    const stats = search.stats || {};
    output.textContent = `已搜索 ${number(stats.scannedCount || 0)} 条会话，找到 ${number(stats.matchedCount || 0)} 条；其中 ${number(stats.contentMatchCount || 0)} 条命中正文。`;
    return;
  }
  if (search.status === 'error' && search.query === query) {
    output.textContent = search.error || '完整内容搜索失败，当前仅显示标题等基础字段匹配。';
    return;
  }
  output.textContent = '输入暂停后会自动搜索完整会话内容。';
}

function renderSessionSearchResults(scope) {
  if (scope === 'local') {
    renderWorkspaceCatalog();
    renderSourceCatalog();
  } else {
    renderWebChatImportedSources();
  }
  if (scope === state.activeWorkbenchView) renderSessionSearchPanel(scope);
  if (scope === state.activeWorkbenchView) renderSessionSearchStatus(scope);
}

async function runSessionContentSearch(scope, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('zh-CN');
  const search = state.sessionSearch[scope];
  sessionSearchControllers[scope]?.abort();
  if (!normalizedQuery) {
    state.sessionSearch[scope] = { query: '', status: 'idle', matches: new Map(), stats: null, error: '', kindFilter: search.kindFilter || 'all' };
    renderSessionSearchResults(scope);
    return;
  }
  const controller = new AbortController();
  sessionSearchControllers[scope] = controller;
  search.query = normalizedQuery;
  search.status = 'loading';
  search.matches = new Map();
  search.stats = null;
  search.error = '';
  renderSessionSearchResults(scope);
  try {
    const searchableSources = (scope === 'web' ? state.webChat.importedSources : state.catalogSources.filter((source) => source.importKind !== 'web-chat')).map((source) => ({
      sourceKey: sourceKey(source),
      sessionId: source.sessionId || null,
      title: source.title || '',
      sourcePath: source.sourcePath || '',
      bytes: Number(source.bytes || 0),
      modifiedAt: source.modifiedAt || null,
      importKind: source.importKind || 'codex',
      workspacePaths: source.workspacePaths || [],
      discoveredBy: source.discoveredBy || [],
      webChat: source.webChat ? {
        platform: source.webChat.platform || '',
        platformName: source.webChat.platformName || '',
        projectTitle: source.webChat.projectTitle || '',
        userPreview: source.webChat.userPreview || '',
        assistantPreview: source.webChat.assistantPreview || '',
      } : null,
    }));
    const response = await fetch('/api/v2/session-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, query: normalizedQuery, limit: 1000, stream: true, sources: searchableSources }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error((await response.text()) || `请求失败（HTTP ${response.status}）`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('搜索服务没有返回可读取的进度流。');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (activeSearchQuery(scope) !== normalizedQuery) return;
        for (const match of event.matches || []) search.matches.set(match.sourceKey, match);
        search.stats = event;
        if (event.type === 'progress') renderSessionSearchResults(scope);
        if (event.type === 'complete') {
          search.status = 'complete';
          search.stats = event;
          renderSessionSearchResults(scope);
        }
      }
      if (chunk.done) break;
    }
    if (search.status !== 'complete') {
      search.status = 'complete';
      renderSessionSearchResults(scope);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || activeSearchQuery(scope) !== normalizedQuery) return;
    search.status = 'error';
    search.error = friendlyError(error, '完整内容搜索失败，当前仅显示标题等基础字段匹配。');
    renderSessionSearchResults(scope);
  }
}

function scheduleSessionContentSearch(scope, query) {
  clearTimeout(sessionSearchTimer);
  sessionSearchTimer = setTimeout(() => void runSessionContentSearch(scope, query), query.trim() ? 420 : 0);
}

function renderWorkbenchNavigation() {
  const selected = selectedSources();
  const localSelected = selected.filter((source) => source.importKind !== 'web-chat').length;
  const webSelected = selected.filter((source) => source.importKind === 'web-chat').length;
  const localTotal = state.catalogSources.filter((source) => source.importKind !== 'web-chat').length;
  const webTotal = (state.webChat.importedSources || []).length;
  const localCount = $('#nav-local-count');
  const webCount = $('#nav-web-count');
  const resultStatus = $('#nav-result-status');
  if (localCount) localCount.textContent = localSelected ? number(localSelected) + ' 已选' : number(localTotal) + ' 条';
  if (webCount) webCount.textContent = webSelected ? number(webSelected) + ' 已选' : number(webTotal) + ' 条';
  if (resultStatus) resultStatus.textContent = state.package
    ? '已生成'
    : state.run
      ? '有建议'
      : state.result
        ? '已解析'
        : !state.packageLibraryLoaded
          ? '读取中'
          : state.packageLibraryError
            ? '列表异常'
            : state.packageLibrary.length
              ? number(state.packageLibrary.length) + ' 个包'
              : '待生成';
}

function setViewAccessibility(view) {
  const controlPanel = $('.control-panel');
  const workspace = $('.workspace');
  const resultsActive = view === 'results';
  if (controlPanel) {
    controlPanel.hidden = resultsActive;
    controlPanel.toggleAttribute('inert', resultsActive);
    controlPanel.setAttribute('aria-hidden', String(resultsActive));
  }
  if (workspace) {
    workspace.hidden = !resultsActive;
    workspace.toggleAttribute('inert', !resultsActive);
    workspace.setAttribute('aria-hidden', String(!resultsActive));
  }
  document.querySelectorAll('.local-intake-only').forEach((node) => {
    const hidden = view !== 'local';
    node.hidden = hidden;
    node.toggleAttribute('inert', hidden);
    node.setAttribute('aria-hidden', String(hidden));
  });
  document.querySelectorAll('.web-intake-only').forEach((node) => {
    const hidden = view !== 'web';
    node.hidden = hidden;
    node.toggleAttribute('inert', hidden);
    node.setAttribute('aria-hidden', String(hidden));
  });
}

function setWorkbenchView(view, { updateUrl = true, focus = false } = {}) {
  if (!WORKBENCH_VIEWS[view] || document.body.dataset.pageMode) return;
  const previousView = state.activeWorkbenchView;
  if (previousView !== view && sessionSearchControllers[previousView]) {
    sessionSearchControllers[previousView].abort();
    sessionSearchControllers[previousView] = null;
    state.sessionSearch[previousView] = { query: '', status: 'idle', matches: new Map(), stats: null, error: '', kindFilter: 'all' };
  }
  const search = $('#session-search');
  if (search && state.activeWorkbenchView !== 'results') state.workbenchSearchTerms[state.activeWorkbenchView] = search.value;
  state.activeWorkbenchView = view;
  document.body.dataset.workbenchView = view;
  setViewAccessibility(view);
  document.querySelectorAll('[data-workbench-nav]').forEach((button) => {
    const active = button.dataset.workbenchNav === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (view !== 'results') {
    const copy = WORKBENCH_VIEWS[view];
    $('#intake-view-kicker').textContent = copy.kicker;
    $('#intake-view-title').textContent = copy.title;
    $('#intake-view-description').textContent = copy.description;
    $('#session-search-label').textContent = copy.searchLabel;
    $('#session-search').placeholder = copy.searchPlaceholder;
    $('#session-search').value = state.workbenchSearchTerms[view] || '';
    $('#refresh').title = copy.refreshTitle;
    $('#refresh').setAttribute('aria-label', copy.refreshTitle);
    if (state.catalogSources.length || state.webChat.importedSources.length) {
      if (view === 'local') {
        renderWorkspaceCatalog();
        renderSourceCatalog();
      } else {
        renderWebChatImportedSources();
      }
    }
    renderSessionSearchStatus(view);
    renderSessionSearchPanel(view);
    const restoredQuery = activeSearchQuery(view);
    if (restoredQuery && state.sessionSearch[view].query !== restoredQuery) scheduleSessionContentSearch(view, restoredQuery);
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('section', view);
    if (url.href !== window.location.href || previousView !== view) window.history.pushState({ workbenchView: view }, '', url);
  }
  renderWorkbenchNavigation();
  if (focus) {
    const target = view === 'results'
      ? $('#results-view-title')
      : $('#intake-view-title');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus?.({ preventScroll: true });
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(payload.error || payload.message || ('请求失败（HTTP ' + response.status + '）'));
  }
  return payload;
}

function setWebChatStatus(message, error = false) {
  const node = $('#web-chat-status');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', error);
}

function setChatGPTSyncStatus(message, error = false) {
  const node = $('#chatgpt-sync-status');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', error);
}

const CHATGPT_SYNC_PHASE_LABELS = {
  queued: '等待开始',
  discovering: '扫描会话目录',
  capturing: '读取完整内容',
  persisting: '保存检查点',
  paused: '已暂停，可继续',
  cancelled: '已取消',
  reconciled: '已完成对账',
  failed: '读取出现失败',
  discovered: '会话目录已完成',
};

function formatSyncEta(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return '等待计算';
  if (value < 60) return `约 ${Math.max(1, Math.round(value))} 秒`;
  const minutes = Math.ceil(value / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  return `约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function formatSyncCheckpoint(value) {
  if (!value) return '尚未保存';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '已保存';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return '刚刚保存';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function renderChatGPTSyncProgress(job = state.webChat.captureAllJob, fallbackRun = null) {
  const panel = $('#chatgpt-sync-progress');
  if (!panel) return;
  const source = job || fallbackRun;
  if (!source) {
    panel.hidden = true;
    return;
  }
  if (!job && fallbackRun && !state.webChat.captureAllJob) state.webChat.captureAllJob = fallbackRun;
  const total = Math.max(0, Number(source.totalCount || fallbackRun?.totalCount || 0));
  const completed = Math.max(0, Number(source.completedCount || fallbackRun?.completedCount || 0));
  const failed = Math.max(0, Number(source.failedCount || fallbackRun?.failedCount || 0));
  const remaining = Math.max(0, Number(source.remainingCount ?? fallbackRun?.remainingCount ?? Math.max(0, total - completed - failed)));
  const processed = Math.min(total, completed + failed);
  const percent = total ? Math.min(100, Math.round((processed / total) * 1000) / 10) : 0;
  const rawPhase = String(source.phase || fallbackRun?.phase || '').trim();
  const status = String(source.status || fallbackRun?.status || '').trim();
  const phase = rawPhase || (status === '已暂停' ? 'paused' : status === '已取消' ? 'cancelled' : status === '完成' || status === 'completed' ? 'reconciled' : status === '失败' ? 'failed' : 'capturing');
  const title = $('#chatgpt-sync-progress-title');
  const phaseNode = $('#chatgpt-sync-phase');
  const track = document.querySelector('.chatgpt-sync-track');
  const trackValue = $('#chatgpt-sync-track-value');
  const setText = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  panel.hidden = false;
  panel.dataset.state = phase;
  if (title) title.textContent = source.runId || source.jobId ? `ChatGPT 全量读取 · ${number(total)} 条目标` : '准备读取 ChatGPT 会话';
  if (phaseNode) {
    phaseNode.dataset.state = phase;
    phaseNode.textContent = CHATGPT_SYNC_PHASE_LABELS[phase] || status || '处理中';
  }
  if (trackValue) trackValue.style.width = `${percent}%`;
  if (track) track.setAttribute('aria-valuenow', String(percent));
  setText('#chatgpt-sync-completed', number(completed));
  setText('#chatgpt-sync-failed', number(failed));
  setText('#chatgpt-sync-remaining', number(remaining));
  setText('#chatgpt-sync-rate', Number(source.ratePerMinute || 0) > 0 ? `每分钟 ${number(Math.round(source.ratePerMinute))} 条` : '等待计算');
  setText('#chatgpt-sync-eta', formatSyncEta(source.etaSeconds));
  setText('#chatgpt-sync-checkpoint', formatSyncCheckpoint(source.lastCheckpointAt || fallbackRun?.lastCheckpointAt));
  setText('#chatgpt-sync-current', source.lastTitle ? `当前会话：${source.lastTitle}` : processed ? `已处理 ${number(processed)} 条，正在等待下一条。` : '正在建立读取计划……');
  const terminal = ['reconciled', 'discovered', 'cancelled', 'failed'].includes(phase) || ['完成', '已取消', '失败', 'completed', 'partial'].includes(status);
  const paused = phase === 'paused' || status === '已暂停';
  const pauseButton = $('#chatgpt-sync-pause');
  const resumeButton = $('#chatgpt-sync-resume');
  const cancelButton = $('#chatgpt-sync-cancel');
  if (pauseButton) pauseButton.hidden = terminal || paused;
  if (resumeButton) resumeButton.hidden = terminal || !paused;
  if (cancelButton) cancelButton.hidden = terminal;
  const retryButton = $('#chatgpt-sync-retry-failed');
  if (retryButton) retryButton.hidden = failed <= 0;
}

function renderChatGPTCoverage(payload = state.webChat.coverage) {
  const status = $('#chatgpt-coverage-status');
  const grid = $('#chatgpt-coverage-grid');
  const captureButton = $('#chatgpt-capture-all');
  const forceCaptureButton = $('#chatgpt-force-capture-all');
  if (!status || !grid) return;
  const counts = payload?.counts || {};
  const cards = [
    ['exportCount', payload?.exportCount || 0, '官方导出会话'],
    ['edgeCount', payload?.edgeCount || 0, 'Edge 已发现会话'],
    ['matched', counts.matched || 0, '两边已匹配'],
    ['incomplete', counts.incomplete || 0, '已有但内容待补齐'],
    ['exportOnly', counts.exportOnly || 0, '仅在官方导出中'],
    ['syncSuccess', payload?.incremental?.success || 0, '增量读取成功'],
    ['syncPending', payload?.incremental?.pending || 0, '等待读取或重试'],
    ['eventCount', payload?.details?.eventCount || 0, '工具与运行事件'],
    ['assetCount', payload?.details?.assetCount || 0, '图片与文件引用'],
    ['nodeCount', payload?.details?.nodeCount || 0, '消息节点与分支'],
    ['lossless', payload?.details?.lossless || 0, '无损完整会话'],
  ];
  // 页面本地缓存可能被清理，但服务端检查点仍然存在；优先拿有剩余会话的活动任务。
  const recoverableRuns = (payload?.incremental?.active || []).filter((run) => (
    ['queued', 'running', 'paused', 'partial'].includes(String(run?.status || ''))
    && Number(run?.remainingCount || 0) > 0
  ));
  const recoverableRun = recoverableRuns.sort((left, right) => {
    const leftCheckpoint = Date.parse(left?.lastCheckpointAt || left?.updatedAt || left?.createdAt || 0) || 0;
    const rightCheckpoint = Date.parse(right?.lastCheckpointAt || right?.updatedAt || right?.createdAt || 0) || 0;
    return rightCheckpoint - leftCheckpoint || Number(right?.remainingCount || 0) - Number(left?.remainingCount || 0);
  })[0] || null;
  const latestRun = recoverableRun || payload?.incremental?.runs?.[0] || payload?.incremental?.active?.[0] || null;
  if (latestRun && !state.webChat.captureAllJob) {
    renderChatGPTSyncProgress(null, latestRun);
    const recoverableId = latestRun.runId || latestRun.jobId;
    if (recoverableId && recoverableRun && !window.localStorage.getItem(CHATGPT_BATCH_JOB_STORAGE_KEY)) {
      window.localStorage.setItem(CHATGPT_BATCH_JOB_STORAGE_KEY, recoverableId);
      setChatGPTSyncStatus('发现上次未完成的 ChatGPT 读取，已保留断点，正在准备继续读取……');
    }
  }
  status.textContent = payload ? `已对账 ${number(payload.records?.length || 0)} 条；增量成功 ${number(payload.incremental?.success || 0)} 条，待读取或重试 ${number(payload.incremental?.pending || 0)} 条；工具/资产事件 ${number(payload.details?.eventCount || 0)}/${number(payload.details?.assetCount || 0)}` : '尚未建立对账';
  grid.innerHTML = cards.map(([, value, label]) => `<div class="chatgpt-coverage-card"><strong>${escape(number(value))}</strong><span>${escape(label)}</span></div>`).join('');
  const discovered = Number(state.webChat.history?.conversations?.length || 0);
  if (captureButton) captureButton.disabled = !state.webChat.connection?.connected || !discovered || state.webChat.busy;
  if (forceCaptureButton) forceCaptureButton.disabled = !state.webChat.connection?.connected || !discovered || state.webChat.busy;
}

async function loadChatGPTCoverage({ quiet = true } = {}) {
  try {
    const payload = await api('/api/v2/chatgpt/coverage');
    state.webChat.coverage = payload;
    renderChatGPTCoverage(payload);
    return payload;
  } catch (error) {
    renderChatGPTCoverage(null);
    if (!quiet) setChatGPTSyncStatus(friendlyError(error, '覆盖率暂时读取失败。'), true);
    return null;
  }
}

function startChatGPTCoveragePolling() {
  if (state.webChat.coverageTimer) window.clearInterval(state.webChat.coverageTimer);
  state.webChat.coverageTimer = window.setInterval(() => {
    void loadChatGPTCoverage({ quiet: true });
  }, 15_000);
}

async function importChatGPTExportFile(file) {
  if (!file) return;
  setChatGPTSyncStatus(`正在导入官方导出：${file.name}……`);
  try {
    const response = await api('/api/v2/chatgpt/import/export', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    state.webChat.coverage = response.coverage;
    renderChatGPTCoverage(response.coverage);
    setChatGPTSyncStatus(`已导入 ${number(response.import?.recordCount || 0)} 条官方会话；重复 ${number(response.import?.duplicateCount || 0)} 条。网页端内容可继续用下方按钮补齐。`);
    await loadSessions({ force: true, quiet: true });
  } catch (error) {
    setChatGPTSyncStatus(friendlyError(error, '官方导出导入失败，请选择有效的 ZIP 文件。'), true);
  }
}

async function waitForChatGPTBatchJob(jobId) {
  for (let attempt = 0; attempt < 9_600; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const data = await api('/api/web-chat/jobs/' + encodeURIComponent(jobId));
    const job = data.job;
    state.webChat.captureAllJob = job;
    renderChatGPTSyncProgress(job);
    const total = Number(job?.totalCount || 0);
    const completed = Number(job?.completedCount || 0);
    const failed = Number(job?.failedCount || 0);
    setChatGPTSyncStatus(`正在逐条读取真实网页会话：已完成 ${completed}/${total}，失败 ${failed}。${job?.lastTitle ? `当前：${job.lastTitle}` : ''}`);
    if (job?.status === '完成') return job;
    if (job?.status === '已取消') return job;
    if (job?.status === '失败') throw new Error(job.error || '网页批量读取失败。');
  }
  throw new Error('网页批量读取已持续 8 小时，任务编号已经保留；重新打开工作台会继续显示进度。');
}

async function finishChatGPTBatchJob(job) {
  state.webChat.captureAllJob = job;
  renderChatGPTSyncProgress(job);
  if (job?.status === '已取消') {
    setChatGPTSyncStatus('读取任务已取消；已经保存的检查点会保留，下次可以继续或重新读取。');
    return { sources: [], failedCount: Number(job.failedCount || 0), cancelled: true };
  }
  const imported = await api('/api/web-chat/imports-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: job.id }),
  });
  const sources = imported.sources || [];
  if (sources.length) {
    setSelectionMode('sessions');
    registerSources(sources);
    sources.forEach((source) => state.selectedSourceKeys.add(sourceKey(source)));
    state.webChat.importedSources = [...sources, ...(state.webChat.importedSources || [])]
      .filter((source, index, all) => all.findIndex((candidate) => sourceKey(candidate) === sourceKey(source)) === index)
      .sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));
    invalidateDistillation();
    renderWebChatImportedSources();
    renderSourceCatalog();
    renderSourceSelection();
  }
  await loadSessions({ force: true, quiet: true });
  await loadChatGPTCoverage({ quiet: false });
  window.localStorage.removeItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
  setChatGPTSyncStatus(`批量读取完成：成功保存 ${number(sources.length)} 条，失败 ${number(imported.failedCount || 0)} 条。每条会话已作为独立来源加入网页端列表。`);
  renderChatGPTSyncProgress({ ...job, status: imported.failedCount ? 'partial' : '完成', phase: imported.failedCount ? 'failed' : 'reconciled', completedCount: sources.length, failedCount: imported.failedCount || 0, remainingCount: 0 });
  return imported;
}

async function resumeChatGPTBatchJob() {
  let jobId = window.localStorage.getItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
  if (!jobId || state.webChat.captureAllMonitorPromise) return;
  state.webChat.captureAllMonitorPromise = (async () => {
    setWebChatBusy(true);
    setChatGPTSyncStatus('检测到上次未结束的 ChatGPT 全量读取，正在恢复真实进度……');
    try {
      let current;
      try {
        current = (await api('/api/web-chat/jobs/' + encodeURIComponent(jobId))).job;
      } catch (error) {
        if (!/找不到|失败|失效|404/.test(String(error?.message || error))) throw error;
        const resumed = await api('/api/v2/chatgpt/edge/resume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'chatgpt' }),
        });
        if (!resumed.job) {
          window.localStorage.removeItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
          setChatGPTSyncStatus(resumed.message || '持久化目录中没有等待继续读取的网页会话。');
          return;
        }
        jobId = resumed.job.id;
        window.localStorage.setItem(CHATGPT_BATCH_JOB_STORAGE_KEY, jobId);
        current = resumed.job;
        state.webChat.captureAllJob = current;
        renderChatGPTSyncProgress(current);
        setChatGPTSyncStatus(`已从持久化目录恢复读取任务，待处理 ${number(resumed.sync?.toFetch || current.totalCount || 0)} 条。`);
      }
      state.webChat.captureAllJob = current;
      renderChatGPTSyncProgress(current);
      if (current?.status === '完成' || current?.status === '已取消') await finishChatGPTBatchJob(current);
      else if (current?.status === '失败') throw new Error(current.error || '上次网页批量读取失败。');
      else await finishChatGPTBatchJob(await waitForChatGPTBatchJob(jobId));
    } catch (error) {
      if (/找不到|失败|失效|404/.test(String(error?.message || error))) window.localStorage.removeItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
      setChatGPTSyncStatus(friendlyError(error, '上次网页批量读取任务已失效，可以重新点击读取。'), true);
    } finally {
      state.webChat.captureAllMonitorPromise = null;
      setWebChatBusy(false);
      renderChatGPTCoverage();
    }
  })();
  await state.webChat.captureAllMonitorPromise;
}

async function captureAllChatGPTConversations(force = false) {
  if (!state.webChat.connection?.connected) {
    setChatGPTSyncStatus('请先完成浏览器伴侣连接。', true);
    return;
  }
  const conversations = state.webChat.history?.conversations || [];
  if (!conversations.length) {
    setChatGPTSyncStatus('还没有发现真实网页会话，请先点击“读取全部真实会话列表”。', true);
    return;
  }
  setWebChatBusy(true);
  setChatGPTSyncStatus(`准备逐条打开 ${number(conversations.length)} 个真实会话……`);
  try {
    const queued = await api('/api/v2/chatgpt/edge/capture-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: state.webChat.platform, conversations, force }),
    });
    if (!queued.job) {
      await loadChatGPTCoverage({ quiet: false });
      setChatGPTSyncStatus(queued.message || `增量检查完成：跳过 ${number(queued.sync?.skipped || 0)} 条未变化会话。`);
      await loadSessions({ force: true, quiet: true });
      return;
    }
    window.localStorage.setItem(CHATGPT_BATCH_JOB_STORAGE_KEY, queued.job.id);
    state.webChat.captureAllJob = queued.job;
    renderChatGPTSyncProgress(queued.job);
    const job = await waitForChatGPTBatchJob(queued.job?.id);
    await finishChatGPTBatchJob(job);
  } catch (error) {
    setChatGPTSyncStatus(friendlyError(error, '网页批量读取失败，请确认 Edge 中的会话仍可打开。'), true);
  } finally {
    setWebChatBusy(false);
    renderChatGPTCoverage();
    await loadWebChatStatus({ quiet: true });
  }
}

async function controlChatGPTSync(action) {
  const jobId = state.webChat.captureAllJob?.id || state.webChat.captureAllJob?.jobId || window.localStorage.getItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
  if (!jobId) {
    setChatGPTSyncStatus('当前没有可控制的读取任务。', true);
    return;
  }
  try {
    const response = await api(`/api/v2/chatgpt/sync/${encodeURIComponent(jobId)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const job = response.job || response.run || response.checkpoint;
    if (job) {
      state.webChat.captureAllJob = { ...(state.webChat.captureAllJob || {}), ...job, id: job.id || job.jobId || jobId };
      renderChatGPTSyncProgress(state.webChat.captureAllJob);
    }
    if (action === 'pause') setChatGPTSyncStatus('读取已暂停。当前进度已保存，点击“继续读取”可从下一条继续。');
    if (action === 'cancel') {
      window.localStorage.removeItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
      setChatGPTSyncStatus('读取已取消。已完成的会话和检查点仍保留，可在失败重试或下次全量读取时继续使用。');
    }
    if (action === 'resume') {
      const activeJobId = state.webChat.captureAllJob?.id || state.webChat.captureAllJob?.jobId || jobId;
      window.localStorage.setItem(CHATGPT_BATCH_JOB_STORAGE_KEY, activeJobId);
      setChatGPTSyncStatus('正在从检查点继续读取……');
      void resumeChatGPTBatchJob();
    }
  } catch (error) {
    setChatGPTSyncStatus(friendlyError(error, '读取任务状态更新失败，请稍后重试。'), true);
  }
}

async function retryFailedChatGPTSync() {
  const jobId = state.webChat.captureAllJob?.id || state.webChat.captureAllJob?.jobId || window.localStorage.getItem(CHATGPT_BATCH_JOB_STORAGE_KEY);
  if (!jobId) {
    setChatGPTSyncStatus('尚未找到可重试的读取任务。请先刷新覆盖率。', true);
    return;
  }
  setWebChatBusy(true);
  setChatGPTSyncStatus('正在从持久化检查点筛选失败会话，只重新读取失败项……');
  try {
    const response = await api(`/api/v2/chatgpt/sync/${encodeURIComponent(jobId)}/retry-failed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'chatgpt' }),
    });
    if (!response.job) {
      await loadChatGPTCoverage({ quiet: false });
      setChatGPTSyncStatus(response.message || '当前没有需要重试的失败会话。');
      return;
    }
    state.webChat.captureAllJob = response.job;
    window.localStorage.setItem(CHATGPT_BATCH_JOB_STORAGE_KEY, response.job.id);
    renderChatGPTSyncProgress(response.job);
    const job = await waitForChatGPTBatchJob(response.job.id);
    await finishChatGPTBatchJob(job);
  } catch (error) {
    setChatGPTSyncStatus(friendlyError(error, '失败会话重试未完成，请确认浏览器仍保持连接。'), true);
  } finally {
    setWebChatBusy(false);
    renderChatGPTCoverage();
  }
}

function setWebChatSetupDetail(message) {
  const node = $('#web-chat-setup-detail');
  if (node) node.textContent = message;
}

function setWebChatSetupStep(step, mode) {
  const node = document.querySelector('[data-setup-step="' + step + '"]');
  if (node) node.dataset.state = mode;
}

function renderWebChatSetup(webChat = state.webChat.connection) {
  const panel = $('#web-chat-setup-panel');
  const stateNode = $('#web-chat-setup-state');
  const fallback = $('#web-chat-setup-fallback');
  if (!panel || !stateNode) return;
  const address = webChat?.agentUrl || window.location.origin;
  const code = webChat?.pairingCode || '------';
  $('#web-chat-setup-address').textContent = address;
  $('#web-chat-setup-code').textContent = code;
  panel.hidden = Boolean(webChat?.connected) || !state.webChat.setupPanelOpen;
  if (webChat?.connected) {
    stateNode.dataset.state = 'complete';
    stateNode.textContent = '已自动连接';
    ['folder', 'extensions', 'confirm', 'connected'].forEach((step) => setWebChatSetupStep(step, 'complete'));
    fallback.hidden = true;
    stopWebChatSetupPolling();
    return;
  }
  if (state.webChat.setupPrepared) {
    stateNode.dataset.state = 'waiting';
    stateNode.textContent = '等待扩展确认';
    setWebChatSetupStep('folder', 'complete');
    setWebChatSetupStep('extensions', 'complete');
    setWebChatSetupStep('confirm', 'active');
    setWebChatSetupStep('connected', 'waiting');
    fallback.hidden = false;
    return;
  }
  stateNode.dataset.state = 'idle';
  stateNode.textContent = '尚未准备';
  ['folder', 'extensions', 'confirm', 'connected'].forEach((step) => setWebChatSetupStep(step, 'idle'));
  fallback.hidden = true;
}

function stopWebChatSetupPolling() {
  if (state.webChat.setupTimer) window.clearInterval(state.webChat.setupTimer);
  state.webChat.setupTimer = null;
}

function startWebChatSetupPolling() {
  stopWebChatSetupPolling();
  state.webChat.setupStartedAt = Date.now();
  state.webChat.setupTimer = window.setInterval(async () => {
    const webChat = await loadWebChatStatus({ quiet: true });
    if (webChat?.connected) {
      setWebChatSetupDetail('浏览器伴侣已自动连接。现在只需点击平台按钮，再读取需要的聊天。');
      setWebChatStatus('浏览器伴侣已自动连接。选择平台并读取当前聊天即可。');
      stopWebChatSetupPolling();
      return;
    }
    if (Date.now() - state.webChat.setupStartedAt > 180_000) {
      setWebChatSetupDetail('仍在等待扩展确认。完成“加载已解压的扩展程序”后，点击工具栏里的伴侣图标，它会自动连接当前工作台。');
      stopWebChatSetupPolling();
    }
  }, 1_500);
}

function preferredSetupBrowser() {
  return /\bEdg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
}

function renderWebChatConnection(webChat) {
  state.webChat.connection = webChat || null;
  const node = $('#web-chat-connection');
  if (!node) return;
  if (webChat?.connected && webChat?.pageReaderReady) {
    node.dataset.state = 'ok';
    node.textContent = '浏览器和页面读取器已连接';
    node.title = webChat.pageReaderVersion ? `页面读取器版本 ${webChat.pageReaderVersion}` : '';
  } else if (webChat?.connected) {
    node.dataset.state = 'waiting';
    node.textContent = '浏览器已连接，正在准备页面读取器';
    node.title = webChat.pageReaderError || '页面读取器将在读取前自动加载。';
  } else if (webChat?.state === '连接已中断') {
    node.dataset.state = 'error';
    node.textContent = '连接已中断';
  } else {
    node.dataset.state = 'waiting';
    node.textContent = '需要首次连接';
  }
  renderWebChatSetup(webChat);
}

function renderWebChatHistory(history = state.webChat.history) {
  const root = $('#web-chat-history-list');
  if (!root) return;
  const conversations = history?.conversations || [];
  if (!conversations.length) {
    root.hidden = true;
    root.innerHTML = '';
    renderChatGPTCoverage();
    return;
  }
  root.hidden = false;
  const platformName = history.platformName || WEB_CHAT_LABELS[state.webChat.platform] || '网页端';
  const scan = history.scan || {};
  const scanNote = `连续扫描 ${number(scan.scrollRounds || 0)} 轮，展开 ${number(scan.expandedSections || 0)} 个“查看全部/加载更多”入口，${scan.exhausted === false ? '已达到扫描上限，请继续滚动后重试' : '已扫到当前目录末尾'}。`;
  root.innerHTML = '<strong>' + escape(platformName) + ' 网页端实际会话（共 ' + number(conversations.length) + ' 条）</strong><span>下面每一行都来自浏览器当前加载的会话目录，不是工作台生成的占位记录。' + escape(scanNote) + '点击“打开这条对话”后，再点“读取当前聊天”即可把该条完整内容加入蒸馏。</span><ul>'
    + conversations.map((item) => {
      const href = validLink(item.url);
      const title = displayBusinessTitle(item.title || '未命名网页对话');
      const stateLabel = item.current ? '当前页面' : '已发现';
      const persisted = (state.webChat.importedSources || []).find((source) => source.webChat?.url && source.webChat.url === item.url);
      const persistedLabel = persisted ? (Number(persisted.webChat?.messageCount || 0) ? ' · 已保存完整内容' : ' · 已保存标题，待读取内容') : '';
      const openLink = href ? '<a class="web-chat-history-open" href="' + escape(href) + '" target="_blank" rel="noreferrer">打开这条对话</a>' : '<small>未返回网页入口</small>';
      return '<li' + (item.current ? ' class="current"' : '') + '><div class="web-chat-history-copy"><strong>' + escape(title) + '</strong><span>' + escape(platformName) + ' · ' + stateLabel + persistedLabel + '</span></div>' + openLink + '</li>';
    }).join('')
    + '</ul>';
  renderChatGPTCoverage();
}

async function loadWebChatHistoryAutomatically() {
  if (state.webChat.history || state.webChat.historyAutoAttempted || state.webChat.historyAutoLoading) return;
  if (!state.webChat.connection?.connected || state.webChat.busy) return;
  state.webChat.historyAutoAttempted = true;
  state.webChat.historyAutoLoading = true;
  try {
    await runWebChatJob('history-index');
  } catch {
    // 首次自动读取失败时保留按钮，让用户稍后手动重试。
  } finally {
    state.webChat.historyAutoLoading = false;
  }
}

function renderWebChatImportedSources() {
  const panel = $('#web-chat-imported-sources');
  const root = $('#web-chat-imported-list');
  if (!panel || !root) return;
  const query = activeSearchQuery('web');
  const all = [...(state.webChat.importedSources || [])].sort((left, right) => (
    Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0)
  ));
  const visible = all.filter((source) => sourceMatchesSessionSearch(source, 'web'));
  const rendered = visible;
  panel.hidden = all.length === 0;
  root.dataset.visibleKeys = JSON.stringify(rendered.map(sourceKey));
  if (!rendered.length) {
    root.innerHTML = '<p class="section-note">' + (query ? '当前搜索没有匹配的网页端会话。' : '还没有读取网页端会话。') + '</p>';
  } else {
    root.innerHTML = rendered.map((source) => {
      const key = sourceKey(source);
      const checked = sourceIsSelected(source) ? ' checked' : '';
      const platformName = source.webChat?.platformName || WEB_CHAT_LABELS[source.webChat?.platform] || '网页端';
      const originLabel = source.webChat?.origin === 'chatgpt-export'
        ? '官方导出完整历史'
        : source.webChat?.origin === 'web-chat-history'
          ? '网页历史目录（待读取内容）'
          : 'Edge 网页实时读取';
      const messageCount = Number(source.webChat?.messageCount || Math.max(0, Number(source.recordCount || 1) - 1));
      const preview = source.webChat?.userPreview || source.webChat?.assistantPreview || '';
      const href = validLink(source.webChat?.url);
      const openLink = href ? '<a class="web-chat-imported-open" href="' + escape(href) + '" target="_blank" rel="noreferrer">打开原始对话</a>' : '';
      const contentNote = preview
        ? '首条内容：' + escape(preview)
        : messageCount
          ? '已读取完整聊天内容；勾选后可参与本次蒸馏。'
          : '已保存会话标题；打开这条聊天并读取当前聊天后，会更新为完整内容。';
      return '<label class="web-chat-imported-row"><input type="checkbox" data-web-source-key="' + escape(key) + '"' + checked + ' /><span class="session-catalog-copy"><strong>' + escape(displayBusinessTitle(source.title)) + '</strong><span><b class="web-chat-source-badge">' + escape(platformName) + '</b> · ' + escape(originLabel) + ' · ' + escape(number(messageCount)) + ' 条消息 · 最近读取：' + escape(formatSessionTime(source.modifiedAt)) + ' · ' + escape(source.webChat?.titleSource || '网页端实际内容') + '</span>' + sessionSearchHitMarkup(source, 'web') + '<small class="web-chat-content-preview">' + contentNote + '</small>' + openLink + '</span></label>';
    }).join('');
  }
  const summary = $('#web-chat-imported-summary');
  if (summary) summary.textContent = (query ? '全文匹配 ' + number(visible.length) + ' 条；' : '') + '网页端独立列表共 ' + number(all.length) + ' 条，已选择 ' + number(all.filter(sourceIsSelected).length) + ' 条；不会混入本机 Codex 列表。';
}

function setWebChatBusy(busy) {
  state.webChat.busy = busy;
  ['#web-chat-capture', '#web-chat-history', '#web-chat-setup', '#web-chat-setup-start', '#select-visible-web-sessions', '#clear-web-session-selection', '#chatgpt-capture-all', '#chatgpt-force-capture-all', '#chatgpt-sync-retry-failed'].forEach((selector) => {
    const node = $(selector);
    if (node) node.disabled = busy;
  });
  document.querySelectorAll('[data-web-chat-platform]').forEach((node) => { node.disabled = busy; });
}

async function loadWebChatStatus({ quiet = false } = {}) {
  try {
    const data = await api('/api/web-chat');
    renderWebChatConnection(data.webChat);
    renderChatGPTCoverage();
    if (data.webChat?.connected) window.setTimeout(() => loadWebChatHistoryAutomatically(), 0);
    if (!quiet && data.webChat?.connected) setWebChatStatus('浏览器已连接，正在自动读取当前平台的全部真实会话；打开某条聊天后再点击“读取当前聊天”即可导入完整内容。');
    return data.webChat;
  } catch (error) {
    renderWebChatConnection(null);
    if (!quiet) setWebChatStatus(friendlyError(error, '网页对话读取服务暂不可用。'), true);
    return null;
  }
}

function setWebChatPlatform(platform) {
  const selected = Object.hasOwn(WEB_CHAT_LABELS, platform) ? platform : 'chatgpt';
  state.webChat.platform = selected;
  state.webChat.history = null;
  state.webChat.historyAutoAttempted = false;
  renderWebChatHistory();
  document.querySelectorAll('[data-web-chat-platform]').forEach((button) => {
    button.classList.toggle('active', button.dataset.webChatPlatform === selected);
  });
}

async function waitForWebChatJob(jobId, maxAttempts = 180) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const data = await api('/api/web-chat/jobs/' + encodeURIComponent(jobId));
    const job = data.job;
    if (job?.status === '完成') return job;
    if (job?.status === '失败') throw new Error(job.error || '网页对话读取失败。');
  }
  throw new Error('网页仍在读取，请确认浏览器伴侣已连接并停留在所选平台的具体聊天页面后重试。');
}

async function runWebChatJob(type) {
  const platform = state.webChat.platform;
  const platformName = WEB_CHAT_LABELS[platform];
  if (!state.webChat.connection?.connected) {
    setWebChatStatus('请先点击“自动准备浏览器伴侣”，完成一次浏览器扩展确认。之后可直接读取。', true);
    return;
  }
  if (!state.webChat.connection?.pageReaderReady) {
    setWebChatStatus(`正在为 ${platformName} 自动加载页面读取器，无需手动刷新网页……`);
  }
  setWebChatBusy(true);
  setWebChatStatus(type === 'capture' ? `正在读取 ${platformName} 当前聊天，完成后会自动加入会话列表……` : `正在读取 ${platformName} 已加载的对话标题……`);
  try {
    const queued = await api('/api/web-chat/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, platform }),
    });
    const jobId = queued.job?.id;
    if (!jobId) throw new Error('工作台没有收到浏览器读取任务编号，请重试。');
    const job = await waitForWebChatJob(jobId, type === 'history-index' ? 180 : 60);
    if (type === 'history-index') {
      state.webChat.history = job?.result?.history || null;
      const imported = await api('/api/web-chat/history/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const sources = imported.sources || [];
      if (sources.length) {
        registerSources(sources);
        state.webChat.importedSources = [...sources, ...(state.webChat.importedSources || [])]
          .filter((source, index, all) => all.findIndex((candidate) => sourceKey(candidate) === sourceKey(source)) === index)
          .sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));
        renderWebChatImportedSources();
        renderSourceCatalog();
        renderSourceSelection();
        await loadSessions({ force: true, quiet: true });
      }
      renderWebChatHistory();
      setWebChatStatus(state.webChat.history?.conversations?.length
        ? `已读到 ${number(state.webChat.history.conversations.length)} 条真实会话，并已保存到持久化列表。打开具体对话后读取当前聊天，会更新同一条记录。`
        : '浏览器没有返回可用标题。请确认已打开所选平台，并刷新网页后重试。');
      setChatGPTSyncStatus(imported.savedCount
        ? `已保存 ${number(imported.savedCount)} 条网页历史；其中 ${number(imported.updatedCount || 0)} 条已有内容，后续读取当前聊天会覆盖更新同一条记录。`
        : '浏览器没有返回可保存的网页历史。');
      return;
    }
    const imported = await api('/api/web-chat/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    const source = imported.source;
    if (!source?.sourcePath) throw new Error('网页对话已读取，但没有返回可选择的会话来源。');
    registerSources([source]);
    const key = sourceKey(source);
    setSelectionMode('sessions');
    state.webChat.importedSources = [state.sourceByKey.get(key) || source, ...state.webChat.importedSources.filter((item) => sourceKey(item) !== key)]
      .sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));
    state.selectedSourceKeys.add(key);
    invalidateDistillation();
    fillPackageDefaults(source.sessionId);
    renderWebChatImportedSources();
    renderSourceCatalog();
    renderSourceSelection();
    const updateLabel = source.webChat?.updateMode === 'updated' ? '已更新已有记录' : '已新增持久化记录';
    setWebChatStatus(`已读取“${displayBusinessTitle(source.title)}”，${updateLabel}，并自动勾选到本次蒸馏。`);
    setStatus(`网页端 ${platformName} 对话${updateLabel}并自动勾选。本机 Codex 列表保持不变。`);
  } catch (error) {
    setWebChatStatus(friendlyError(error, '网页对话读取失败，请确认浏览器已打开对应平台的具体聊天。'), true);
  } finally {
    setWebChatBusy(false);
    await loadWebChatStatus({ quiet: true });
  }
}

async function openWebChatPlatform(platform) {
  setWebChatPlatform(platform);
  const platformName = WEB_CHAT_LABELS[state.webChat.platform];
  setWebChatBusy(true);
  setWebChatStatus(`正在打开 ${platformName}。在浏览器中选择具体聊天后，回到这里点击“读取当前聊天”。`);
  try {
    await api('/api/web-chat/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: state.webChat.platform }),
    });
  } catch (error) {
    setWebChatStatus(friendlyError(error, `无法打开 ${platformName}。`), true);
  } finally {
    setWebChatBusy(false);
  }
}

async function setupWebChatCompanion() {
  state.webChat.setupPanelOpen = true;
  setWebChatBusy(true);
  try {
    const response = await api('/api/web-chat/companion/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ browser: preferredSetupBrowser() }),
    });
    const setup = response.setup || response;
    state.webChat.setupPrepared = true;
    const webChat = await loadWebChatStatus({ quiet: true });
    renderWebChatSetup(webChat);
    const address = setup.agentUrl || webChat?.agentUrl || window.location.origin;
    const code = setup.pairingCode || webChat?.pairingCode || '';
    try {
      await copyToClipboard(`工作台地址：${address}\n配对码：${code}`);
    } catch {}
    setWebChatSetupDetail('已自动打开伴侣文件夹和扩展管理页，并复制备用连接信息。请在扩展管理页点击一次“加载已解压的扩展程序”，选择刚打开的文件夹；随后点击工具栏中的伴侣图标，它会自动连接。');
    setWebChatStatus('首次准备已完成，正在等待浏览器伴侣自动连接。');
    startWebChatSetupPolling();
  } catch (error) {
    setWebChatStatus(friendlyError(error, '浏览器伴侣准备没有完成，请稍后重新点击。'), true);
  } finally {
    setWebChatBusy(false);
  }
}

async function copyWebChatSetup() {
  state.webChat.setupPanelOpen = true;
  const webChat = state.webChat.connection || await loadWebChatStatus({ quiet: true });
  const address = webChat?.agentUrl || window.location.origin;
  const code = webChat?.pairingCode || '';
  try {
    await copyToClipboard(`工作台地址：${address}\n配对码：${code}`);
    state.webChat.setupPrepared = true;
    renderWebChatSetup(webChat);
    setWebChatSetupDetail('备用连接信息已复制。正常情况下扩展会自动发现当前工作台；仅在自动识别失败时再使用这份信息。');
  } catch (error) {
    setWebChatSetupDetail(friendlyError(error, '备用连接信息暂未复制。'));
  }
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function number(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function label(value, fallback = '未标注') {
  const text = String(value ?? '');
  return LABELS[text] || fallback;
}

function badge(value) {
  const raw = String(value ?? '');
  const className = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return '<span class="badge ' + escape(className) + '">' + escape(label(raw, raw || '未标注')) + '</span>';
}

function table(headers, rows, empty = '暂无可展示的记录。') {
  if (!rows.length) return '<p class="section-note">' + escape(empty) + '</p>';
  return '<div class="table-wrap"><table><thead><tr>' + headers.map((header) => '<th>' + escape(header) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}

function row(cells) {
  return '<tr>' + cells.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>';
}

function code(value) {
  return '<code>' + escape(value) + '</code>';
}

function list(values, empty = '暂无') {
  return values.length ? values.map((value) => escape(value)).join('、') : empty;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return number(bytes) + ' 字节';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' 千字节';
  return (bytes / (1024 * 1024)).toFixed(1) + ' 兆字节';
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || '';
}

function displayBusinessTitle(value) {
  const original = String(value || '').trim();
  const cleaned = original
    .replace(/^\/(?:goal|plan)\s+/i, '')
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\s*[-:：|｜]\s*|\s*)/i, '')
    .trim();
  return cleaned || original || '未命名会话';
}

function localPath(...segments) {
  return segments.filter(Boolean).map((value) => String(value)).join('\\').replace(/[\\/]+/g, '\\');
}

function validLink(value) {
  const href = String(value || '');
  if (href.startsWith('/')) return href;
  try {
    const url = new URL(href);
    return ['http:', 'https:'].includes(url.protocol) ? href : '';
  } catch {
    return '';
  }
}

const PACKAGE_VIEW_COPY = {
  overview: ['能力包总览', '先看它解决什么问题、能交付什么，以及下一步从哪里开始。'],
  capability: ['专属能力', '用直白语言查看这个能力包会做什么、什么时候使用、怎样完成。'],
  priorities: ['优先级计划', '按 P0-P3 查看先处理什么、为什么先做，以及判断依据。'],
  tasks: ['可直接交办的任务', '选择一个已经整理好的任务，交给独立 Agent 直接执行。'],
  project: ['项目理解', '查看会话、项目、文件修改和生成产物之间的关系。'],
  evidence: ['文件与验证', '查看系统依据了哪些文件、改动、命令、产物和验证结果。'],
  agent: ['运行专属 Agent', '在独立操作区启动 Agent、查看状态并完成当前能力包对应的工作。'],
  install: ['安装与接口', '下载、安装或连接 Skill、MCP 和独立 Agent；普通使用只需按页面步骤操作。'],
  document: ['文件阅读', '页面已经把能力包文件整理成可阅读内容；原始技术数据放在页面末尾。'],
};

function packagePageUrl(packageKey, view = 'overview', extra = {}) {
  const params = new URLSearchParams({ package: String(packageKey || ''), view });
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, String(value));
  return '/?' + params.toString();
}

function packagePageAnchor(packageKey, view, text, className = '') {
  if (!packageKey) return '';
  return '<a class="' + escape(className) + '" href="' + escape(packagePageUrl(packageKey, view)) + '" target="_blank" rel="noreferrer">' + escape(text) + '</a>';
}

function packageDocumentPageUrl(link, title) {
  const info = packageArtifactInfo(link);
  return info.packageKey && info.artifact
    ? packagePageUrl(info.packageKey, 'document', { artifact: info.artifact, title })
    : '';
}

function readerPageUrl(link, title) {
  const params = new URLSearchParams({ reader: String(link || ''), title: String(title || '内容阅读') });
  return '/?' + params.toString();
}

function anchor(value, text) {
  const href = validLink(value);
  if (!href) return '';
  if (href.startsWith('/api/package-artifact') && !href.includes('artifact=__archive__.zip')) {
    if (document.body.dataset.pageMode === 'package') {
      return '<button type="button" class="document-link" data-package-document="' + escape(href) + '" data-document-title="' + escape(text) + '">' + escape(text) + '</button>';
    }
    const readerUrl = packageDocumentPageUrl(href, text);
    if (readerUrl) return '<a class="document-link" href="' + escape(readerUrl) + '" target="_blank" rel="noreferrer">' + escape(text) + '</a>';
  }
  const directDownload = href.includes('artifact=__archive__.zip') || /(?:\/download|\.zip)(?:\?|$)/i.test(href);
  if (href.startsWith('/api/') && !directDownload) {
    return '<a class="document-link" href="' + escape(readerPageUrl(href, text)) + '" target="_blank" rel="noreferrer">' + escape(text) + '</a>';
  }
  return '<a href="' + escape(href) + '"' + (href.includes('artifact=__archive__.zip') ? ' download' : ' target="_blank" rel="noreferrer"') + '>' + escape(text) + '</a>';
}

function copyButton(value, text = '复制路径') {
  return value ? '<button type="button" class="copy-button" data-copy-value="' + escape(value) + '">' + escape(text) + '</button>' : '';
}

async function copyToClipboard(value) {
  const text = String(value || '');
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  setStatus('已复制：' + text);
}

function bindCopyButtons(root = document) {
  root.querySelectorAll('[data-copy-value]').forEach((button) => {
    button.onclick = async () => {
      try {
        await copyToClipboard(button.dataset.copyValue);
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = '复制路径'; }, 1600);
      } catch {
        setStatus('复制失败，请直接选中页面中的路径。', true);
      }
    };
  });
}

async function launchPackageAgent(packageKey, button) {
  if (!packageKey) throw new Error('当前能力包缺少启动标识。');
  button?.setAttribute('disabled', '');
  try {
    activatePackageView('agent');
    renderAgentStatus({ status: 'starting', running: true, logs: [{ stream: 'system', message: '正在检查当前能力包并启动 Agent……' }] });
    setStatus('正在检查并启动当前能力包的专属 Agent……');
    const data = await api('/api/v2/packages/' + encodeURIComponent(packageKey) + '/agent/start', { method: 'POST' });
    const agent = data?.agent || data?.launch;
    const url = agent?.url;
    if (!url) throw new Error('独立 Agent 已启动，但没有返回操作界面地址。');
    renderAgentStatus(agent);
    mountAgentInterface(url);
    startAgentStatusPolling();
    setStatus(agent.alreadyRunning ? '当前能力包的 Agent 已在运行，界面已显示在工作台内。' : '当前能力包的 Agent 已启动，界面已显示在工作台内。');
  } finally {
    button?.removeAttribute('disabled');
  }
}

function bindPackageLaunchButtons(root = document) {
  root.querySelectorAll('[data-launch-package]').forEach((button) => {
    button.onclick = async () => {
      try {
        const packageKey = button.dataset.launchPackage;
        if (packageKey !== state.packageKey) await openStoredPackage(packageKey, { view: 'agent', scroll: true });
        await launchPackageAgent(packageKey, button);
      } catch (error) {
        renderAgentStatus({ status: 'failed', error: friendlyError(error, '独立 Agent 启动失败，请查看日志。'), logs: [] });
        setStatus(friendlyError(error, '独立 Agent 启动失败，请稍后重试。'), true);
      }
    };
  });
}

function packageArtifactInfo(link) {
  try {
    const url = new URL(link, window.location.origin);
    return {
      packageKey: url.searchParams.get('packageKey') || '',
      artifact: url.searchParams.get('artifact') || '',
    };
  } catch {
    return { packageKey: '', artifact: '' };
  }
}

function inlineMarkdown(value) {
  return escape(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(value) {
  const lines = String(value || '').replace(/\r/g, '').split('\n');
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) codeLines.push(lines[index++]);
      index += 1;
      output.push('<pre class="document-code"><code data-language="' + escape(language) + '">' + escape(codeLines.join('\n')) + '</code></pre>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      output.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
      index += 1;
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const cells = (rowText) => rowText.replace(/^\s*\||\|\s*$/g, '').split('|').map((cell) => cell.trim());
      const headers = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      output.push('<div class="document-table"><table><thead><tr>' + headers.map((cell) => '<th>' + inlineMarkdown(cell) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((rowCells) => '<tr>' + rowCells.map((cell) => '<td>' + inlineMarkdown(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''));
      output.push('<ul>' + items.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/, ''));
      output.push('<ol>' + items.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ol>');
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quotes = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quotes.push(lines[index++].replace(/^>\s?/, ''));
      output.push('<blockquote>' + inlineMarkdown(quotes.join(' ')) + '</blockquote>');
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+|^```|^\s*[-*]\s+|^\s*\d+[.)]\s+|^>\s?/.test(lines[index])) paragraph.push(lines[index++].trim());
    output.push('<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>');
  }
  return output.join('');
}

function jsonValueLabel(value) {
  if (Array.isArray(value)) return value.length + ' 项';
  if (value && typeof value === 'object') return Object.keys(value).length + ' 个字段';
  if (value === null) return '空值';
  return typeof value === 'string' ? value.slice(0, 80) : String(value);
}

const JSON_FIELD_LABELS = {
  schemaVersion: '数据版本', package: '能力包信息', packageId: '能力包编号', packageKey: '能力包标识', name: '名称', title: '标题',
  description: '说明', summary: '摘要', purpose: '目标', capabilities: '专属能力', priorities: '优先级', tasks: '任务目录',
  evidence: '判断依据', evidenceIds: '证据编号', files: '相关文件', tools: '使用工具', commands: '执行命令', outputs: '生成结果',
  verification: '验证结果', sessions: '来源会话', sourceSessions: '来源会话', projects: '关联项目', project: '关联项目',
  recommendations: '系统建议', recommendation: '系统建议', artifacts: '生成文件', delivery: '交付内容', links: '可打开入口',
  generatedAt: '生成时间', status: '当前状态', confidence: '可信程度', reason: '判断原因', workflow: '执行步骤',
};

function readableJsonKey(key) {
  return JSON_FIELD_LABELS[key] || String(key || '').replace(/[_-]+/g, ' ');
}

function readableJsonValue(value) {
  if (Array.isArray(value)) return value.length + ' 项内容';
  if (value && typeof value === 'object') return Object.keys(value).length + ' 组信息';
  if (value === null || value === undefined || value === '') return '暂未记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value).slice(0, 140);
}

function renderJsonDocument(value) {
  if (!value || typeof value !== 'object') return '<pre class="json-source">' + escape(JSON.stringify(value, null, 2)) + '</pre>';
  const entries = Object.entries(value);
  const overview = entries.slice(0, 8).map(([key, item]) => '<div><span>' + escape(readableJsonKey(key)) + '</span><strong>' + escape(readableJsonValue(item)) + '</strong></div>').join('');
  const sections = entries.map(([key, item], index) => '<details' + (index < 2 ? ' open' : '') + '><summary><span><strong>' + escape(readableJsonKey(key)) + '</strong><small>原字段：' + escape(key) + '</small></span><em>' + escape(jsonValueLabel(item)) + '</em></summary><div class="json-readable-value">' + escape(readableJsonValue(item)) + '</div><details class="json-technical"><summary>查看这组完整技术数据</summary><pre class="json-source">' + escape(JSON.stringify(item, null, 2)) + '</pre></details></details>').join('');
  return '<div class="json-document-summary"><strong>这是一份结构化能力包数据</strong><span>先看下方中文概览；只有核对接口或程序问题时，才需要展开原始技术数据。</span></div><div class="json-overview">' + overview + '</div><div class="json-sections">' + sections + '</div>';
}

function documentReadingGuide(artifact, title) {
  const name = String(artifact || '').toLowerCase();
  const guides = [
    [/capability|skill/, ['这份文件说明“它会做什么”', '先看适用任务、输入、执行方法和交付物；不需要理解程序代码。']],
    [/priority|recommendation/, ['这份文件说明“为什么这样排序”', '先看 P0 和 P1，它们决定当前能力包最先处理的工作。']],
    [/task-catalog|workflow/, ['这份文件是“可直接交办的任务清单”', '选择最接近当前目标的一项，再到“运行专属 Agent”开始执行。']],
    [/evidence|ledger|lineage|version|change|diff/, ['这份文件说明“结论依据是什么”', '用于核对来源会话、相关文件、修改、产物和验证记录。']],
    [/project|knowledge|discovery|dependency/, ['这份文件说明“系统怎样理解项目”', '先看项目目标、关键文件和当前状态；技术明细可按需展开。']],
    [/readme|guide/, ['这是能力包的完整使用说明', '按页面顺序阅读即可：了解能力、准备输入、启动 Agent、查看结果。']],
    [/manifest|package-description/, ['这份文件说明“包里有什么”', '用于确认交付内容和文件是否齐全，日常使用不需要逐项研究。']],
    [/config|profile|env/, ['这是连接与设置说明', '普通用户保持默认即可；只有需要更换模型或接入其他系统时再调整。']],
  ];
  const selected = guides.find(([pattern]) => pattern.test(name))?.[1] || ['能力包文件', '页面已将文件整理为可阅读内容；从标题和中文摘要开始即可。'];
  return '<section class="document-reading-guide"><span>如何阅读</span><div><strong>' + escape(selected[0]) + '</strong><p>' + escape(selected[1]) + '</p></div><small>' + escape(title || artifact || '能力包文件') + '</small></section>';
}

async function fetchPackageDocument(link) {
  if (state.packageDocuments.has(link)) return state.packageDocuments.get(link);
  const response = await fetch(link);
  if (!response.ok) throw new Error('能力包文件读取失败，状态码 ' + response.status + '。');
  const info = packageArtifactInfo(link);
  let inferredArtifact = info.artifact;
  if (!inferredArtifact) {
    try { inferredArtifact = decodeURIComponent(new URL(link, window.location.origin).pathname.split('/').pop() || ''); } catch {}
  }
  const document = {
    text: await response.text(),
    type: response.headers.get('content-type') || '',
    ...info,
    artifact: inferredArtifact,
  };
  state.packageDocuments.set(link, document);
  return document;
}

function renderDocumentContent(document, link, title = '') {
  const artifact = document.artifact || packageArtifactInfo(link).artifact;
  const extension = artifact.split('.').pop().toLowerCase();
  const guide = documentReadingGuide(artifact, title || $('#package-document-title')?.textContent);
  if (extension === 'md' || document.type.includes('markdown')) {
    return guide + '<article class="markdown-document">' + renderMarkdown(document.text) + '</article>';
  }
  if (extension === 'json' || document.type.includes('json')) {
    try {
      return guide + '<article class="json-document">' + renderJsonDocument(JSON.parse(document.text)) + '</article>';
    } catch {
      return guide + '<details class="json-technical" open><summary>查看文件内容</summary><pre class="json-source">' + escape(document.text) + '</pre></details>';
    }
  }
  if (extension === 'html') {
    return guide + '<iframe class="document-frame" title="能力包网页说明" src="' + escape(link) + '"></iframe>';
  }
  return guide + '<pre class="text-document">' + escape(document.text) + '</pre>';
}

async function renderDocumentInto(slot, link, title) {
  if (!slot) return;
  if (!link) {
    slot.innerHTML = '<div class="document-empty"><strong>本能力包没有生成这份文件</strong><p>可在“安装与接口”中查看实际交付清单。</p></div>';
    return;
  }
  slot.innerHTML = '<div class="document-loading">正在读取并整理“' + escape(title) + '”……</div>';
  try {
    const document = await fetchPackageDocument(link);
    slot.innerHTML = renderDocumentContent(document, link, title);
    bindPackageDocumentButtons(slot);
  } catch (error) {
    slot.innerHTML = '<div class="document-error"><strong>文件未能读取</strong><p>' + escape(friendlyError(error, '请确认能力包文件仍然存在。')) + '</p></div>';
  }
}

async function openPackageDocument(link, title = '能力包文件', { updateUrl = true } = {}) {
  const info = packageArtifactInfo(link);
  if (info.packageKey && info.packageKey !== state.packageKey) await openStoredPackage(info.packageKey, { view: 'document', scroll: true });
  activatePackageView('document', { updateUrl: false });
  $('#package-document-title').textContent = title;
  $('#package-document-meta').textContent = info.artifact ? '能力包内文件：' + info.artifact : '能力包文件';
  $('#package-document-actions').innerHTML = '<a href="' + escape(link) + '" download>下载源文件</a>';
  updateChildPageContext('document', title);
  if (updateUrl && state.packageKey) {
    const url = new URL(window.location.href);
    url.searchParams.set('package', state.packageKey);
    url.searchParams.set('view', 'document');
    if (info.artifact) url.searchParams.set('artifact', info.artifact);
    url.searchParams.set('title', title);
    history.replaceState({ packageKey: state.packageKey, view: 'document', artifact: info.artifact }, '', url);
  }
  await renderDocumentInto($('#package-document-reader'), link, title);
}

function bindPackageDocumentButtons(root = document) {
  root.querySelectorAll('[data-package-document]').forEach((button) => {
    button.onclick = () => openPackageDocument(button.dataset.packageDocument, button.dataset.documentTitle || button.textContent.trim());
  });
}

function configureChildPageShell(packageKey) {
  if (!packageKey) return;
  document.body.dataset.pageMode = 'package';
  const bar = $('#child-page-bar');
  if (bar) bar.hidden = false;
  const status = $('#child-page-status');
  if (status) status.textContent = '正在读取能力包';
}

async function openStandaloneReader(link, title = '内容阅读') {
  if (!String(link || '').startsWith('/api/')) {
    window.location.href = '/';
    return;
  }
  document.body.dataset.pageMode = 'reader';
  document.body.dataset.packagePage = 'document';
  const primary = $('#child-page-primary');
  if (primary) primary.hidden = true;
  const bar = $('#child-page-bar');
  if (bar) bar.hidden = false;
  $('#child-page-breadcrumb').textContent = '主工作台 / 内容阅读';
  $('#child-page-title').textContent = title;
  $('#child-page-description').textContent = '这份内容已经在独立阅读页打开；先看中文说明，技术明细按需展开。';
  $('#child-page-status').textContent = '正在整理内容';
  $('#standalone-reader-title').textContent = title;
  $('#standalone-reader').hidden = false;
  $('#standalone-reader-actions').innerHTML = '<a href="' + escape(link) + '" target="_blank" rel="noreferrer">打开原始内容</a>';
  try {
    const document = await fetchPackageDocument(link);
    $('#standalone-reader-content').innerHTML = renderDocumentContent(document, link, title);
    $('#child-page-status').textContent = '页面已就绪';
  } catch (error) {
    $('#standalone-reader-content').innerHTML = '<div class="document-error"><strong>内容未能读取</strong><p>' + escape(friendlyError(error, '请返回主工作台后重试。')) + '</p></div>';
    $('#child-page-status').textContent = '读取失败';
  }
}

function updateChildPageContext(view, title = '') {
  if (document.body.dataset.pageMode !== 'package') return;
  const copy = PACKAGE_VIEW_COPY[view] || PACKAGE_VIEW_COPY.overview;
  const packageName = state.package?.name || '当前能力包';
  $('#child-page-breadcrumb').textContent = '主工作台 / ' + packageName + ' / ' + copy[0];
  $('#child-page-title').textContent = title || copy[0];
  $('#child-page-description').textContent = copy[1];
  $('#child-page-status').textContent = '页面已就绪';
  document.body.dataset.packagePage = view;
  const primary = $('#child-page-primary');
  if (primary) {
    primary.hidden = false;
    primary.onclick = () => activatePackageView(view === 'agent' ? 'overview' : 'agent');
    primary.textContent = view === 'agent' ? '返回能力总览' : (view === 'overview' ? '开始使用 Agent' : '进入 Agent');
    primary.setAttribute('aria-label', primary.textContent + '：' + packageName);
  }
}

function rawPackageArtifactLink(packageKey, artifact) {
  return '/api/package-artifact?packageKey=' + encodeURIComponent(packageKey) + '&artifact=' + encodeURIComponent(artifact);
}

function updatePackageUrl(view = state.packageView) {
  if (!state.packageKey) return;
  const url = new URL(window.location.href);
  url.searchParams.set('package', state.packageKey);
  url.searchParams.set('view', view);
  if (view !== 'document') {
    url.searchParams.delete('artifact');
    url.searchParams.delete('title');
  }
  history.replaceState({ packageKey: state.packageKey, view }, '', url);
}

function packageViewDocument(view) {
  const config = {
    capability: ['#package-capability-reader', state.packageDocumentLinks.capability, '专属能力说明'],
    priorities: ['#package-priority-reader', state.packageDocumentLinks.priorityPlan, 'P0-P3 优先级计划'],
    tasks: ['#package-task-reader', state.packageDocumentLinks.taskCatalog, '任务目录'],
  }[view];
  if (!config) return;
  const slot = $(config[0]);
  if (!config[1] && view === 'capability' && $('#package-capability-expertise')?.children.length) {
    slot.hidden = true;
    return;
  }
  if (slot) slot.hidden = false;
  if (slot?.dataset.loadedLink === config[1]) return;
  if (slot) slot.dataset.loadedLink = config[1] || '';
  renderDocumentInto(slot, config[1], config[2]);
}

function packageUsesProjectContext(payload = state.package || {}) {
  const selection = payload.analysis?.scopePolicy || payload.selection || payload.package?.selection || {};
  return selection.projectConfirmed === true
    && selection.contextMode !== 'conversation-only'
    && selection.projectScope !== 'sessions-only';
}

function activatePackageView(view, { updateUrl = true } = {}) {
  const available = [...document.querySelectorAll('[data-package-panel]')].some((panel) => panel.dataset.packagePanel === view);
  const target = available && (view !== 'project' || packageUsesProjectContext()) ? view : 'overview';
  state.packageView = target;
  document.querySelectorAll('[data-package-panel]').forEach((panel) => { panel.hidden = panel.dataset.packagePanel !== target; });
  document.querySelectorAll('[data-package-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.packageView === target);
    button.setAttribute('aria-current', button.dataset.packageView === target ? 'page' : 'false');
  });
  const documentButton = document.querySelector('[data-package-view="document"]');
  if (documentButton) documentButton.hidden = target !== 'document';
  packageViewDocument(target);
  if (target === 'agent') loadAgentStatus();
  updateChildPageContext(target);
  if (updateUrl) updatePackageUrl(target);
}

function renderProjectSummary(knowledge, links) {
  if (!knowledge) return '<div class="document-empty"><strong>项目级蒸馏尚未生成</strong><p>仍可从会话证据与项目发现说明中查看已识别内容。</p></div>';
  const metrics = knowledge.metrics || knowledge.summary || {};
  const metricItems = [
    ['语义阶段', metrics.semanticStages || knowledge.semanticStages?.length],
    ['证据记录', metrics.evidenceLedger || knowledge.evidenceLedger?.length],
    ['项目文件', metrics.projectFiles || metrics.files || knowledge.fileVersions?.length],
    ['文件版本链', metrics.fileVersions || knowledge.fileVersions?.length],
    ['生成产物', metrics.artifacts || knowledge.artifactLineage?.length],
    ['待补证问题', metrics.openQuestions || knowledge.openEvidenceQuestions?.length],
  ];
  const actions = [
    anchor(links.projectKnowledgeV4Markdown, '阅读项目级蒸馏说明'),
    anchor(links.projectKnowledgeV4, '查看完整项目数据'),
    anchor(links.semanticStages, '查看语义阶段'),
    anchor(links.fileVersions, '查看文件版本链'),
    anchor(links.artifactLineage, '查看产物血缘'),
  ].filter(Boolean).join('');
  return '<section class="project-summary"><div><span class="eyebrow">项目知识总览</span><h4>系统从会话、文件和产物中确认的项目事实</h4></div><div class="project-summary-metrics">' + metricItems.map(([labelText, value]) => '<div><span>' + escape(labelText) + '</span><strong>' + number(value) + '</strong></div>').join('') + '</div><div class="project-summary-actions">' + actions + '</div></section>';
}

function configurePackageWorkbench(payload, documentLinks, projectKnowledgeLinks) {
  state.packageDocumentLinks = documentLinks;
  const hasProjectContext = packageUsesProjectContext(payload);
  const projectNavigation = document.querySelector('[data-package-view="project"]');
  const projectPanel = document.querySelector('[data-package-panel="project"]');
  if (projectNavigation) projectNavigation.hidden = !hasProjectContext;
  if (projectPanel) projectPanel.hidden = !hasProjectContext;
  document.querySelectorAll('[data-package-view]').forEach((button) => {
    if (!button.title) button.title = '打开“' + button.textContent.replace(/^\s*\d+\s*/, '').trim() + '”页面';
    button.onclick = () => activatePackageView(button.dataset.packageView);
  });
  document.querySelectorAll('[data-package-view-shortcut]').forEach((button) => {
    button.onclick = () => activatePackageView(button.dataset.packageViewShortcut);
  });
  const description = $('#package-description');
  const projectContent = $('#package-project-content');
  const evidenceContent = $('#package-evidence-content');
  const expertiseContent = $('#package-capability-expertise');
  projectContent.innerHTML = hasProjectContext
    ? renderProjectSummary(payload.analysis?.projectKnowledgeV4 || payload.package?.projectKnowledgeV4, projectKnowledgeLinks)
    : '<section class="project-scope-empty"><strong>本次只蒸馏已选会话</strong><p>你没有明确选择项目，因此系统没有读取项目文件、Git、项目规则或同目录下的其他内容。需要项目理解时，请返回主页面选择项目文件夹后重新蒸馏。</p></section>';
  if (hasProjectContext) ['.project-portfolio', '.source-project-evidence', '.project-understanding'].forEach((selector) => {
    const node = description.querySelector(selector);
    if (node) projectContent.append(node);
  });
  description.querySelector('.project-knowledge-v4')?.remove();
  description.querySelector('.project-knowledge-v4-empty')?.remove();
  expertiseContent.replaceChildren();
  const expertise = description.querySelector('.package-expertise');
  if (expertise) expertiseContent.append(expertise);
  const evidenceActions = [
    ['来源会话清单', documentLinks.sources],
    ['项目发现说明', documentLinks.projectDiscoveryMarkdown],
    ['项目证据说明', documentLinks.projectEvidenceMarkdown],
    ['项目知识完整数据', projectKnowledgeLinks.projectKnowledgeV4],
    ['文件版本链', projectKnowledgeLinks.fileVersions],
    ['文件变更矩阵', projectKnowledgeLinks.fileChangeMatrix],
    ['产物血缘', projectKnowledgeLinks.artifactLineage],
    ['产物复现表', projectKnowledgeLinks.artifactReproducibility],
    ['依赖影响', projectKnowledgeLinks.dependencyImpact],
    ['验证与待补证问题', projectKnowledgeLinks.openEvidenceQuestions],
    ['G0-G9 发布门', links.releaseDecision],
    ['原任务回放证据', links.originalTaskReplay],
    ['新任务留出验收', links.heldOutEvaluation],
    ['隔离 Agent 执行验收', links.isolatedAgentValidation],
  ].filter(([, link]) => link);
  const visibleEvidenceActions = hasProjectContext ? evidenceActions : evidenceActions.slice(0, 1);
  evidenceContent.innerHTML = '<div class="evidence-index"><div><strong>选择要查看的证据</strong><p>' + (hasProjectContext ? '所有内容都在当前网页中打开；只有下载源文件时才离开阅读视图。' : '本次只提供会话来源证据；项目文件和 Git 未被读取。') + '</p></div><div class="evidence-actions">' + visibleEvidenceActions.map(([title, link]) => anchor(link, title)).join('') + '</div></div>';
  bindPackageDocumentButtons($('#package-result'));
  bindPackageAgentControls();
  const requestedView = new URL(window.location.href).searchParams.get('view') || 'overview';
  activatePackageView(requestedView, { updateUrl: false });
}

function agentStatusText(status) {
  return ({ starting: '正在启动', running: '运行中', stopping: '正在停止', stopped: '未运行', failed: '启动失败' })[status] || '未运行';
}

function renderAgentStatus(agent = {}) {
  const preflight = agent.preflight || {};
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  const logs = Array.isArray(agent.logs) ? agent.logs : [];
  const status = agent.status || 'stopped';
  $('#package-agent-status').innerHTML = '<div class="agent-status-main" data-status="' + escape(status) + '"><span class="agent-status-dot"></span><div><strong>' + escape(agentStatusText(status)) + '</strong><p>' + escape(agent.error || (status === 'running' ? '健康检查已通过，可以直接在下方操作。' : '启动前会自动检查能力包清单、服务程序和界面文件。')) + '</p></div></div>' + (checks.length ? '<div class="agent-preflight">' + checks.map((item) => '<span data-ok="' + String(Boolean(item.ok)) + '">' + (item.ok ? '已就绪' : '缺失') + ' · ' + escape(item.label) + '</span>').join('') + '</div>' : '');
  $('#package-agent-logs').textContent = logs.length ? logs.map((item) => '[' + (item.timestamp ? new Date(item.timestamp).toLocaleTimeString('zh-CN') : '--:--:--') + '] ' + (item.stream || 'system') + '  ' + item.message).join('\n') : (agent.error || '暂无日志。');
  $('#package-agent-start').disabled = status === 'starting';
  $('#package-agent-stop').disabled = !['running', 'starting'].includes(status);
}

function mountAgentInterface(url) {
  const stage = $('#package-agent-stage');
  const current = stage.querySelector('iframe');
  if (current?.src === url) return;
  stage.innerHTML = '<iframe class="package-agent-frame" title="专属 Agent 操作界面" src="' + escape(url) + '"></iframe>';
}

async function loadAgentStatus() {
  if (!state.packageKey) return;
  try {
    const data = await api('/api/v2/packages/' + encodeURIComponent(state.packageKey) + '/agent/status');
    const agent = data.agent || {};
    renderAgentStatus(agent);
    if (agent.running && agent.url) mountAgentInterface(agent.url);
  } catch (error) {
    renderAgentStatus({ status: 'failed', error: friendlyError(error, 'Agent 状态读取失败。'), logs: [] });
  }
}

function startAgentStatusPolling() {
  clearInterval(state.agentStatusTimer);
  state.agentStatusTimer = setInterval(() => {
    if (state.packageView === 'agent') loadAgentStatus();
  }, 3500);
}

function bindPackageAgentControls() {
  $('#package-agent-start').onclick = async (event) => {
    try {
      await launchPackageAgent(state.packageKey, event.currentTarget);
    } catch (error) {
      renderAgentStatus({ status: 'failed', error: friendlyError(error, '独立 Agent 启动失败，请查看日志。'), logs: [] });
    }
  };
  $('#package-agent-refresh').onclick = () => loadAgentStatus();
  $('#package-agent-stop').onclick = async () => {
    if (!state.packageKey) return;
    try {
      const data = await api('/api/v2/packages/' + encodeURIComponent(state.packageKey) + '/agent/stop', { method: 'POST' });
      renderAgentStatus(data.agent || {});
      setStatus('已发送停止命令。');
    } catch (error) {
      setStatus(friendlyError(error, '停止 Agent 失败。'), true);
    }
  };
}

function getEvidenceLinks(packagePayload, analysis) {
  const links = packagePayload?.links || {};
  const evidence = links.evidence || {};
  return analysis?.artifacts || {
    report: firstValue(evidence.report, evidence.html, links.report, links.reportHtml),
    markdown: firstValue(evidence.markdown, links.markdown, links.reportMarkdown),
    analysis: firstValue(evidence.analysis, links.analysis),
    projectUnderstanding: firstValue(evidence.projectUnderstanding, links.projectUnderstanding),
    projectUnderstandingMarkdown: firstValue(evidence.projectUnderstandingMarkdown, links.projectUnderstandingMarkdown),
  };
}

function selectionKey(selection) {
  return JSON.stringify({
    sourcePaths: [...(selection?.sourcePaths || [])].sort(),
    selectionMode: selection?.selectionMode || 'sessions',
    projectScope: selection?.projectScope || 'sessions-only',
    workspaceIds: [...(selection?.workspaceSelection?.workspaceIds || [])].sort(),
    includedSourceKeys: [...(selection?.workspaceSelection?.includedSourceKeys || [])].sort(),
    excludedSourceKeys: [...(selection?.workspaceSelection?.excludedSourceKeys || [])].sort(),
    catalogRevision: selection?.workspaceSelection?.catalogRevision || '',
    projectPath: selection?.projectPath || '',
    includeEvidence: $('#include-evidence').checked,
    redact: $('#redact').checked,
  });
}

function invalidateDistillation() {
  state.run = null;
  state.runSelectionKey = '';
  state.contextPreviewKey = '';
  state.contextPreview = null;
  renderProjectContextPreview(null);
  const center = $('#recommendation-center');
  if (center) center.hidden = true;
}

function evidenceLink(run, evidenceId) {
  if (!run?.runId || !evidenceId) return '';
  return '/api/v2/runs/' + encodeURIComponent(run.runId) + '/evidence/' + encodeURIComponent(evidenceId);
}

function judgementMarkup(title, description, value) {
  return '<section><span>' + escape(title) + '</span><strong>' + escape(value) + '</strong><p>' + escape(description) + '</p></section>';
}

function priorityMarkup(run, item) {
  const distillation = item.distillationPriority || { level: item.level, score: item.score };
  const execution = item.agentExecutionPriority || { level: item.level, score: item.score };
  const confidence = item.evidenceConfidence || item.confidence || {};
  const reasons = (item.why || []).slice(0, 6).map((reason) => '<li>' + escape(reason) + '</li>').join('');
  const evidence = (item.evidenceIds || []).slice(0, 8).map((id) => anchor(evidenceLink(run, id), id)).filter(Boolean).join('');
  const files = (item.affectedFiles || []).slice(0, 8).map((file) => '<code>' + escape(file) + '</code>').join('');
  const tools = (item.observedTools || []).slice(0, 10).map((tool) => '<code>' + escape(tool) + '</code>').join('');
  const overridden = item.userOverride ? '<span class="user-override">已按你的选择调整</span>' : '';
  return '<article class="priority-item priority-' + escape(distillation.level || 'P3').toLowerCase() + '">' +
    '<header><div><span class="priority-rank">第 ' + number(item.rank) + ' 项</span><h3>' + escape((distillation.level || item.level || 'P3') + '｜' + (item.title || '未命名能力')) + '</h3></div>' + overridden + '</header>' +
    '<div class="priority-judgements"><div><span>蒸馏优先级</span><strong>' + escape(distillation.level || 'P3') + ' · ' + number(distillation.score) + '/100</strong><p>' + escape(distillation.reason || item.nextAction || '按建议写入能力包。') + '</p></div><div><span>Agent 执行优先级</span><strong>' + escape(execution.level || 'P3') + ' · ' + number(execution.score) + '/100</strong><p>' + escape(execution.reason || '按提炼流程执行。') + '</p></div><div><span>证据置信度</span><strong>' + escape(confidence.level || '待确认') + ' · ' + number(confidence.score) + '/100</strong><p>' + escape((confidence.basis || []).join('、') || '会话证据') + '</p></div></div>' +
    '<div class="priority-body"><section><h4>具体要完成什么</h4><p>' + escape(item.purpose || '按原会话阶段完成对应工作。') + '</p><h4>为什么排在这里</h4><ul>' + (reasons || '<li>来自所选会话中的明确任务阶段。</li>') + '</ul></section><section><h4>预期产物</h4><p>' + escape(item.expectedOutput || '可复核的任务结果与验证记录。') + '</p><h4>关联文件与工具</h4><div class="priority-chips">' + ((files || '') + (tools || '') || '<span>尚未发现可验证的文件或工具</span>') + '</div><h4>证据入口</h4><div class="priority-evidence">' + (evidence || '<span>证据已写入完整清单</span>') + '</div></section></div>' +
    '<footer><button type="button" class="secondary compact-button" data-priority-action="emphasize" data-priority-id="' + escape(item.id) + '">更重视这个目标</button><button type="button" class="text-button" data-priority-action="defer" data-priority-id="' + escape(item.id) + '">本次暂不纳入</button>' + (item.userOverride ? '<button type="button" class="text-button" data-priority-action="reset" data-priority-id="' + escape(item.id) + '">恢复系统建议</button>' : '') + '</footer></article>';
}

function renderRecommendation(run) {
  if (!run?.recommendation) return;
  state.run = run;
  renderWorkbenchNavigation();
  const recommendation = run.recommendation;
  const summary = recommendation.summary || {};
  const counts = summary.counts || {};
  $('#empty').hidden = true;
  $('#recommendation-center').hidden = false;
  $('#recommendation-title').textContent = recommendation.identity?.title || '专属蒸馏建议';
  $('#recommendation-headline').textContent = summary.headline || '系统已完成会话、项目、文件和产物理解。';
  $('#recommendation-links').innerHTML = [
    anchor(run.links?.recommendationHtml, '打开中文建议'),
    anchor(run.links?.recommendationMarkdown, '查看建议文档'),
    anchor(run.links?.evidenceManifest, '查看证据清单'),
    anchor('/api/v2/openapi.json', '查看接口说明'),
  ].filter(Boolean).join('');
  const priorities = recommendation.priorities || [];
  const highestExecution = priorities.slice().sort((left, right) => Number(right.agentExecutionPriority?.score || 0) - Number(left.agentExecutionPriority?.score || 0))[0];
  const avgConfidence = priorities.length ? Math.round(priorities.reduce((total, item) => total + Number(item.evidenceConfidence?.score || item.confidence?.score || 0), 0) / priorities.length) : 0;
  $('#recommendation-judgements').innerHTML = [
    judgementMarkup('蒸馏优先级', '先写进能力包的内容', 'P0 ' + number(counts.P0) + ' 项 · P1 ' + number(counts.P1) + ' 项'),
    judgementMarkup('Agent 执行优先级', '接到任务后最先处理什么', highestExecution ? (highestExecution.agentExecutionPriority?.level || highestExecution.level) + '｜' + highestExecution.title : '待确认'),
    judgementMarkup('证据置信度', '对话、文件、Git、产物与验证的共同支持', avgConfidence + '/100'),
  ].join('');
  const recommended = recommendation.recommendedPackage || {};
  const project = run.project || {};
  $('#recommended-package').innerHTML = '<div><span class="eyebrow">第 3 步 · 按推荐生成</span><h3>' + escape(recommended.title || recommendation.identity?.title || '会话专属能力包') + '</h3><p>' + escape(recommended.description || '生成专属技能、服务接口、独立执行型 Agent、中文界面和完整说明。') + '</p></div><dl><div><dt>关联项目</dt><dd>' + escape(project.name || '系统未发现可验证项目，将按会话证据生成') + '</dd></div><div><dt>当前状态</dt><dd>' + escape(summary.readiness || '可生成') + '</dd></div><div><dt>蒸馏任务</dt><dd>' + escape(run.runId || '已保存') + '</dd></div></dl>';
  $('#priority-list').innerHTML = priorities.length ? priorities.map((item) => priorityMarkup(run, item)).join('') : '<p class="section-note">没有识别到可排序的工作阶段，请选择包含完整需求和执行过程的会话。</p>';
  renderResultOverview();
}

async function updatePriority(priorityId, action) {
  if (!state.run?.runId) return;
  setBusy(true);
  setStatus('正在按你的选择重新计算建议，并保留原始排序依据……');
  try {
    const response = await fetch('/api/v2/runs/' + encodeURIComponent(state.run.runId) + '/reprioritize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priorityId, action }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '优先级调整失败。');
    renderRecommendation(data.run);
    setStatus('建议已更新。生成能力包时会使用这份最新排序。');
  } catch (error) {
    setStatus(friendlyError(error, '优先级调整失败，请稍后重试。'), true);
  } finally {
    setBusy(false);
  }
}

function renderMetrics(summary) {
  const source = state.result?.source || {};
  const sources = state.result?.sourceSet || state.result?.multiSource || {};
  const project = state.result?.projectEvidence?.summary || state.result?.projectEvidenceSummary || {};
  const understanding = state.result?.projectUnderstanding?.scope || {};
  const values = [
    ['联合来源会话', sources.sessionCount],
    ['解析记录', summary.records ?? source.recordCount],
    ['可执行用户请求', summary.actionableUserMessages],
    ['外层编排调用', summary.toolCalls],
    ['嵌套实际调用', summary.nestedToolCalls],
    ['识别到的工具', summary.uniqueNestedTools],
    ['命令与脚本证据', summary.shellOrScriptCommands],
    ['文件变更证据', summary.runtimeFileChanges],
    ['用户需求阶段', summary.episodes],
    ['项目扫描文件', project.scannedFiles],
    ['项目修改或新增', project.modifiedFiles],
    ['项目生成产物', project.generatedFiles],
    ['项目关系图节点', state.result?.projectUnderstanding?.evidenceGraph?.nodes],
    ['项目待确认项', (state.result?.projectUnderstanding?.conflictRegister || []).length],
  ];
  $('#metrics').innerHTML = values.filter(([, value]) => value !== undefined && value !== null).map(([metric, value]) => '<div class="metric"><strong>' + escape(metric) + '</strong><span>' + number(value) + '</span></div>').join('');
}

function renderTimeline(result) {
  const episodes = result.episodes || [];
  const rows = episodes.map((episode) => {
    const intents = episode.intentLabels || (episode.intents || []).map((value) => label(value, value));
    const stages = episode.stageLabels || (episode.stages || []).map((value) => label(value, value));
    const assistant = episode.assistantContent || (episode.assistantMessages || []).join('\n\n') || '本阶段没有可提取的助手正文。';
    const outcome = episode.outcomeSummary || ('本阶段记录 ' + number(episode.outcomeCount) + ' 条工具结果。');
    const sourceLabel = episode.sourceTitle || episode.sourceSessionTitle || episode.sourceSessionId || '';
    return '<article class="episode"><div class="episode-top"><strong>' + escape(episode.title || ('P' + episode.index + '｜未命名需求')) + '</strong><span>' + number(episode.toolCount) + ' 次工具调用</span></div><div class="chip-row">' + (sourceLabel ? '<span class="badge direct">来源：' + escape(sourceLabel) + '</span>' : '') + intents.map(badge).join('') + stages.map(badge).join('') + '</div><section class="episode-body"><h4>用户请求内容</h4><p>' + escape(episode.requestContent || episode.request || '暂无用户请求内容。') + '</p></section><section class="episode-body episode-result"><h4>助手回应内容</h4><p>' + escape(assistant) + '</p></section><section class="episode-body"><h4>执行结果</h4><p>' + escape(outcome) + '</p></section><div class="episode-meta"><span>执行阶段：' + escape(stages.join(' → ') || '暂无阶段') + '</span><span>使用工具：' + list((episode.toolNames || []), '暂无工具') + '</span><span>取证事件：' + escape(episode.triggerEventIndex) + '</span></div></article>';
  });
  return '<h3>请求标题与执行内容</h3><p class="section-note">每个阶段同时展示中文标题、用户请求正文、助手回应、执行结果和可追溯的技术证据。</p><div class="timeline">' + (rows.join('') || '<p class="section-note">暂无可执行的用户消息。</p>') + '</div>';
}

function renderTools(result) {
  const wrapperRows = (result.toolCatalog || []).map((tool) => row([code(tool.name), number(tool.calls), number(tool.completed), number(tool.succeeded), number(tool.failed), number(tool.pending)]));
  const nestedRows = (result.nestedToolCatalog || []).map((tool) => row([code(tool.name), number(tool.calls), list(tool.wrapperTools || [], '暂无')]));
  return '<h3>外层编排工具</h3><p class="section-note">这里列出记录中直接出现的外层工具调用；工具名称保留为可复核的技术标识。</p>' + table(['工具名称', '调用次数', '已完成', '成功', '失败', '未关联结果'], wrapperRows, '暂无外层工具调用。') + '<h3 class="section-heading">嵌套实际调用</h3><p class="section-note">从外层负载中恢复的内层工具调用。</p>' + table(['嵌套工具', '观测次数', '外层载体'], nestedRows, '暂无嵌套工具调用。');
}

function renderCode(result) {
  const changes = result.codeArtifacts?.fileChanges || [];
  const commands = result.codeArtifacts?.commands || [];
  const fileRows = changes.map((change) => row([badge(change.action), code(change.path), badge(change.origin), escape(change.eventIndex)]));
  const commandRows = commands.slice(0, 120).map((command) => row([badge(command.category), code(command.tool), escape(command.eventIndex), '<code>' + escape(command.command) + '</code>']));
  return '<h3>文件与产物证据</h3><p class="section-note">文件动作和来源使用中文标签；路径、工具名和命令属于原始技术证据。</p>' + table(['操作', '路径', '来源', '事件序号'], fileRows, '暂无文件变更。') + '<h3 class="section-heading">命令与脚本证据</h3><p class="section-note">页面展示前 120 条，完整内容见报告原文和 analysis.json。</p>' + table(['命令类别', '工具', '事件序号', '命令摘录'], commandRows, '暂无命令证据。');
}

function renderTriggers(result) {
  const rows = (result.triggerLogic || []).map((rule) => row([badge(rule.confidence), escape(rule.trigger), escape(rule.condition), escape(rule.action), escape(rule.evidence)]));
  return '<h3>触发逻辑与分支</h3><p class="section-note">“直接证据”表示用户消息与动作可直接对应；“时序推断”只表示从事件顺序归纳出的关系。</p>' + table(['证据级别', '触发条件', '成立条件', '执行动作', '证据'], rows, '暂无触发规则。');
}

function renderSkill(result) {
  const blueprint = result.skillBlueprint || {};
  const candidates = (result.reusableCapabilities || []).map((candidate) => '<div class="skill-block"><h3>' + escape(candidate.name) + '</h3><div>' + badge(candidate.confidence) + ' <span class="muted">评分 ' + number(candidate.score) + '</span></div><p>' + escape(candidate.trigger) + '</p><p><strong>工作流：</strong>' + escape((candidate.workflow || []).join(' → ')) + '</p><p class="muted">证据：' + escape((candidate.evidence || []).join('；') || '暂无') + '</p></div>').join('');
  const inputs = (blueprint.requiredInputs || []).map((value) => '<li>' + escape(value) + '</li>').join('');
  const workflow = (blueprint.workflow || []).map((value) => '<li>' + escape(value) + '</li>').join('');
  const guardrails = (blueprint.guardrails || []).map((value) => '<li>' + escape(value) + '</li>').join('');
  return '<section class="skill-block"><span class="eyebrow">推导出的技能蓝图</span><h3>' + escape(blueprint.candidateName || '未命名技能') + '</h3><p>' + escape(blueprint.description || '暂无描述。') + '</p><p><strong>技术标识：</strong>' + code(blueprint.candidateId || '暂无') + '</p><div class="skill-columns"><div><strong>必需输入</strong><ul>' + (inputs || '<li>暂无</li>') + '</ul></div><div><strong>执行工作流</strong><ul>' + (workflow || '<li>暂无</li>') + '</ul></div><div><strong>约束与验收要求</strong><ul>' + (guardrails || '<li>暂无</li>') + '</ul></div></div></section><section class="skill-block"><span class="eyebrow">会话中观测到的工具</span><p>' + list(blueprint.observedTools || [], '暂无') + '</p><strong>实现文件</strong><p>' + list(blueprint.implementationFiles || [], '暂无') + '</p></section><h3 class="section-heading">可复用能力候选</h3><div class="skill-grid">' + (candidates || '<p class="section-note">暂无能力候选。</p>') + '</div>';
}

function projectUnderstandingMarkup(understanding, links = {}) {
  if (!understanding) return '<section class="project-understanding-empty"><h3>项目理解尚未生成</h3><p>为会话填写关联项目文件夹后，蒸馏器会关联会话阶段、当前文件、Git 原始版本、差异、命令、生成产物和项目规则，生成可追溯的项目理解。</p></section>';
  const scope = understanding.scope || {};
  const graph = understanding.evidenceGraph || {};
  const cognition = understanding.projectCognition || {};
  const files = understanding.fileEvolution || [];
  const conflicts = understanding.conflictRegister || [];
  const plan = understanding.activeReadPlan || [];
  const fileRows = files.map((file) => {
    const stages = (file.conversationEvidence || []).map((item) => item.stage ? 'P' + item.stage + '｜' + (item.stageTitle || '未命名阶段') : '').filter(Boolean);
    const lineage = (file.lineage || []).map((item) => item.relation || item.description).filter(Boolean);
    const dependencies = [...(file.dependencies?.imports || []), ...(file.dependencies?.importedBy || []).map((item) => '被 ' + item + ' 引用')];
    return row([
      code(file.path || '未命名文件'),
      escape(file.kind || file.projectRole || '项目文件'),
      escape(file.changeState || '当前未标注'),
      '<strong>' + escape(file.confidence?.level || '待确认') + '</strong><br><span class="muted">' + escape(file.confidence?.description || '') + '</span>',
      escape(stages.join('；') || '未发现直接会话阶段'),
      escape(lineage.join('；') || '非生成产物或尚未定位唯一来源'),
      escape(dependencies.join('；') || '未在已读取内容中识别相对依赖'),
      (file.original?.available ? '原始版本' : '无原始版本') + '；' + (file.diff?.available ? '有差异' : '无差异') + '<br><span class="muted">' + escape((file.evidenceIds || []).join('、') || '无证据编号') + '</span>',
    ]);
  });
  const conflictRows = conflicts.map((item) => row([
    '<strong>' + escape(item.severity || '未分级') + '</strong>',
    escape(item.type || '待确认项'),
    escape(item.conclusion || ''),
    escape(item.handling || ''),
    escape(item.status || ''),
  ]));
  const planRows = plan.map((item) => row([
    '<strong>' + escape(item.priority || '中') + '</strong>',
    escape(item.action || '读取或核对'),
    item.path ? code(item.path) : '—',
    escape(item.reason || ''),
    escape((item.evidenceIds || []).join('、') || '—'),
  ]));
  const artifactLinks = [
    anchor(links.projectUnderstanding, '打开完整项目理解数据'),
    anchor(links.projectUnderstandingMarkdown, '打开可阅读项目理解说明'),
    anchor(links.projectEvidence, '打开项目证据数据'),
    anchor(links.projectEvidenceMarkdown, '打开项目证据说明'),
  ].filter(Boolean).join('');
  return '<section class="project-understanding"><div class="project-understanding-heading"><div><span class="eyebrow">从会话到项目的可追溯理解</span><h3>' + escape(understanding.project?.name || '关联项目') + '</h3><p><strong>当前目标：</strong>' + escape(understanding.purpose || '未提取明确目标。') + '</p></div><div class="project-understanding-links">' + artifactLinks + '</div></div><div class="project-understanding-metrics"><div><strong>联合会话</strong><span>' + number(scope.sourceSessions) + '</span></div><div><strong>语义阶段</strong><span>' + number(scope.stages) + '</span></div><div><strong>文件节点</strong><span>' + number(scope.files) + '</span></div><div><strong>会话关联文件</strong><span>' + number(scope.linkedFiles) + '</span></div><div><strong>修改文件</strong><span>' + number(scope.modifiedFiles) + '</span></div><div><strong>生成产物</strong><span>' + number(scope.generatedFiles) + '</span></div><div><strong>关系图节点</strong><span>' + number(graph.nodes) + '</span></div><div><strong>关系图边</strong><span>' + number(graph.edges) + '</span></div></div><section class="project-cognition"><h4>项目判断</h4><p>' + escape(cognition.currentState || '未提取项目状态。') + '</p><p><strong>入口候选：</strong>' + list(cognition.entryPoints || [], '未识别') + '</p><p><strong>项目规则：</strong>' + list((cognition.rules || []).map((item) => item.path), '未识别') + '</p></section><h4 class="section-heading">文件演化与生成产物链路</h4><p class="section-note">显示本次项目扫描得到的完整文件节点列表。每一行都将会话阶段、Git 原始版本和差异、命令证据、生成产物关系或依赖关系放在一起，未确认的关系会明确标注。</p>' + table(['文件', '项目角色', '状态', '证据级别', '关联会话阶段', '产物链路', '依赖关系', '版本与证据'], fileRows, '未识别可关联的项目文件。') + '<h4 class="section-heading">冲突、后续纠正与待确认项</h4>' + table(['严重度', '类型', '结论', '处理方式', '状态'], conflictRows, '没有识别到结构化冲突或待确认项。') + '<h4 class="section-heading">主动读取与验证计划</h4><p class="section-note">这是一份下一次真实执行时应先完成的读取与核对清单，不会把尚未执行的操作显示为已经完成。</p>' + table(['优先级', '操作', '目标文件', '原因', '证据编号'], planRows, '当前没有额外的读取与验证步骤。') + '</section>';
}

function projectKnowledgeV4Markup(knowledge, links = {}) {
  if (!knowledge) return '<section class="project-knowledge-v4-empty"><h3>V4 多会话项目知识尚未生成</h3><p>选择一条或多条会话后，蒸馏器会主动关联项目文件、Git 基线、差异和生成产物，并在这里显示完整语义阶段、文件版本链、血缘和覆盖率。</p></section>';
  const summary = knowledge.summary || {};
  const stages = Array.isArray(knowledge.semanticStages) ? knowledge.semanticStages : knowledge.semanticStages?.items || [];
  const versions = Array.isArray(knowledge.fileVersions) ? knowledge.fileVersions : knowledge.fileVersions?.items || [];
  const lineage = Array.isArray(knowledge.artifactLineage) ? knowledge.artifactLineage : knowledge.artifactLineage?.items || [];
  const timeline = Array.isArray(knowledge.crossSessionTimeline) ? knowledge.crossSessionTimeline : knowledge.crossSessionTimeline?.items || [];
  const changes = Array.isArray(knowledge.fileChangeMatrix) ? knowledge.fileChangeMatrix : knowledge.fileChangeMatrix?.items || [];
  const dependencyImpact = knowledge.dependencyImpact || {};
  const reproductions = Array.isArray(knowledge.artifactReproducibility) ? knowledge.artifactReproducibility : knowledge.artifactReproducibility?.items || [];
  const openQuestions = Array.isArray(knowledge.openEvidenceQuestions) ? knowledge.openEvidenceQuestions : knowledge.openEvidenceQuestions?.items || [];
  const snapshot = knowledge.projectSnapshot || {};
  const decisions = Array.isArray(knowledge.decisionConflicts) ? knowledge.decisionConflicts : knowledge.decisionConflicts?.items || [];
  const readLog = Array.isArray(knowledge.activeReadLog) ? knowledge.activeReadLog : knowledge.activeReadLog?.items || [];
  const model = knowledge.projectModel || {};
  const coverage = knowledge.coverage || {};
  const projectCoverage = coverage.project || {};
  const stageRows = stages.map((item) => row([
    '<strong>' + escape(item.title || item.phase || '未命名阶段') + '</strong>',
    escape(item.purpose || '未提取到具体目标。'),
    (item.sessions || []).map((session) => escape(session.title || session.sessionId) + (session.authorityRank ? '（优先 ' + escape(session.authorityRank) + '）' : '')).join('<br>') || '未标识',
    (item.files || []).map(code).join('<br>') || '未记录文件',
    (item.tools || []).map(code).join(' ') || '未记录工具',
    number(item.evidenceIds?.length),
  ]));
  const moduleRows = (model.modules || []).map((item) => row([
    '<strong>' + escape(item.name) + '</strong>', number(item.fileCount), number(item.modifiedFiles), number(item.generatedFiles),
    escape((item.languages || []).join('、') || '未识别'), escape((item.roles || []).join('、') || '未识别'),
    (item.examples || []).map(code).join('<br>') || '无示例',
  ]));
  const versionRows = versions.map((item) => row([
    code(item.path), escape(item.kind), escape([item.revision, item.action, item.gitStatus, item.changeState].filter(Boolean).join('｜') || '未标注'),
    badge(item.contentAvailable ? '正文可用' : '仅记录事实'), code(item.parentVersionId || '起点'), number(item.evidenceIds?.length),
  ]));
  const lineageRows = lineage.map((item) => row([
    code(item.path), badge(item.confidence || '待确认'), (item.inputs || []).map(code).join('<br>') || '未唯一定位',
    (item.commands || []).map((command) => '<code>' + escape(command.command || command) + '</code>').join('<br>') || '未唯一定位',
    escape(item.conclusion || ''), number(item.evidenceIds?.length),
  ]));
  const timelineRows = timeline.map((item) => row([
    escape(item.timestamp || '未记录时间'), badge(item.type || '事件'), escape(item.sessionTitle || item.sessionId || '未标识会话'),
    escape(item.title || item.action || item.tool || item.command || ''), escape(item.semanticStageTitle || item.semanticStageId || ''),
  ]));
  const changeRows = changes.map((item) => row([
    code(item.path), badge(item.changeState || item.gitStatus || '已记录'), escape((item.sessions || []).map((entry) => entry.title || entry.sessionId || entry).join('、') || '未关联会话'),
    code(item.baseline?.sha256 || item.baseline?.gitObjectId || '无 Git 基线'), code(item.current?.sha256 || '无当前指纹'), escape(item.assessment || ''),
  ]));
  const impactRows = (dependencyImpact.changedFiles || []).map((item) => row([
    code(item.path), (item.directDependents || []).map(code).join('<br>') || '无直接依赖方', (item.transitiveDependents || []).map(code).join('<br>') || '无传递影响',
    number(item.evidenceIds?.length),
  ]));
  const reproductionRows = reproductions.map((item) => row([
    code(item.path), badge(item.reproducibility?.status || '复现证据不足'), item.reproducibility?.readyToReplay ? '是' : '否',
    (item.inputs || []).map(code).join('<br>') || '输入待确认', (item.commands || []).map((entry) => code(entry.command || entry)).join('<br>') || '命令待确认', code(item.currentSnapshot?.sha256 || '无当前指纹'),
  ]));
  const decisionRows = decisions.map((item) => row([
    badge(item.status || '待核对'), escape(item.type || '证据缺口'), escape(item.severity || '中'), escape(item.decision || ''), escape(item.handling || ''),
    (item.supersedes || []).map((entry) => escape(entry.title || entry.semanticStageId)).join('<br>') || '未覆盖早期阶段',
  ]));
  const readRows = readLog.map((item) => row([
    badge(item.status || '计划'), escape(item.action || ''), code(item.target || '未定位'), escape(item.reason || ''), number(item.evidenceIds?.length),
  ]));
  const artifactLinks = [
    anchor(links.projectKnowledgeV4Markdown, '打开可阅读知识说明'), anchor(links.projectKnowledgeV4, '打开完整知识 JSON'),
    anchor(links.semanticStages, '打开语义阶段'), anchor(links.evidenceLedger, '打开证据账本'), anchor(links.projectModel, '打开项目模型'),
    anchor(links.projectGraph, '打开项目知识图'), anchor(links.fileVersions, '打开文件版本链'), anchor(links.artifactLineage, '打开产物血缘'),
    anchor(links.crossSessionTimeline, '打开跨会话时间线'), anchor(links.fileChangeMatrix, '打开文件变更矩阵'), anchor(links.dependencyImpact, '打开依赖影响'),
    anchor(links.artifactReproducibility, '打开产物复现表'), anchor(links.projectSnapshot, '打开项目快照'), anchor(links.openEvidenceQuestions, '打开待补证问题'),
    anchor(links.decisionConflicts, '打开后续决策'), anchor(links.knowledgeCoverage, '打开覆盖率'), anchor(links.activeReadLog, '打开主动读取记录'),
  ].filter(Boolean).join('');
  return '<section class="project-knowledge-v4"><div class="project-knowledge-v4-heading"><div><span class="eyebrow">项目级蒸馏 V4.1</span><h3>' + escape(knowledge.name || '跨会话与项目的可追溯知识层') + '</h3><p>它主动读取所选会话关联的项目文件、Git 原始版本、当前内容、差异、依赖与生成产物，再把所有证据按语义归并；不是只做对话摘要。</p></div><div class="project-understanding-links">' + artifactLinks + '</div></div><div class="project-knowledge-v4-metrics"><div><strong>来源会话</strong><span>' + number(summary.sessions) + '</span></div><div><strong>语义阶段</strong><span>' + number(summary.semanticStages) + '</span></div><div><strong>时间线事件</strong><span>' + number(summary.timelineEvents) + '</span></div><div><strong>变更文件</strong><span>' + number(summary.changedFiles) + '</span></div><div><strong>依赖关系</strong><span>' + number(summary.dependencyEdges) + '</span></div><div><strong>可复现产物</strong><span>' + number(summary.reproducibleArtifacts) + '</span></div><div><strong>文件版本</strong><span>' + number(summary.fileVersions) + '</span></div><div><strong>待补证</strong><span>' + number(summary.openEvidenceQuestions) + '</span></div></div><section class="project-knowledge-v4-coverage"><h4>本次到底读了多少</h4><p>会话已解析 <strong>' + number(coverage.sessions?.parsed) + ' / ' + number(coverage.sessions?.selected) + '</strong> 条；项目扫描 <strong>' + number(projectCoverage.scannedFiles) + ' / ' + number(projectCoverage.discoveredFiles) + '</strong> 个文件；读取正文 <strong>' + number(projectCoverage.textFilesRead) + '</strong> 个；仅记录元数据 <strong>' + number(projectCoverage.metadataOnlyFiles) + '</strong> 个；快照指纹 <strong>' + code(snapshot.fingerprint || '未生成') + '</strong>。</p>' + ((coverage.limitations || []).length ? '<ul>' + coverage.limitations.map((item) => '<li>' + escape(item) + '</li>').join('') + '</ul>' : '<p>没有额外读取限制。</p>') + '</section><h4 class="section-heading">从多条会话归并出的 P 阶段</h4><p class="section-note">每一行保留具体目标、来源会话、实际文件、工具和证据数量。</p>' + table(['P 阶段', '具体目标', '来源会话', '涉及文件', '实际工具', '证据'], stageRows, '没有可展示的语义阶段。') + '<h4 class="section-heading">跨会话执行时间线</h4>' + table(['时间', '事件', '会话', '内容', '归属阶段'], timelineRows, '没有可展示的时间线事件。') + '<h4 class="section-heading">项目目的、模块和入口</h4><p class="section-note"><strong>项目目的：</strong>' + escape(model.purpose || '未定位关联项目。') + '<br><strong>入口候选：</strong>' + (model.entryPoints || []).map((item) => code(item.path || item)).join('、') + '<br><strong>规则文件：</strong>' + (model.rules || []).map((item) => code(item.path || item)).join('、') + '</p>' + table(['模块', '文件', '修改', '产物', '语言', '职责', '示例文件'], moduleRows, '没有项目模块数据。') + '<h4 class="section-heading">逐文件变更矩阵</h4>' + table(['文件', '状态', '涉及会话', 'Git 原始指纹', '当前指纹', '判断'], changeRows, '没有文件变更记录。') + '<h4 class="section-heading">依赖影响</h4>' + table(['变更文件', '直接依赖方', '传递影响', '证据'], impactRows, '没有检测到依赖影响。') + '<h4 class="section-heading">文件版本链</h4><p class="section-note">完整区分 Git 原始版本、会话中记录的操作和当前工作区版本；下表展示全量记录。</p>' + table(['文件', '版本类型', '版本或动作', '内容状态', '父版本', '证据'], versionRows, '没有文件版本记录。') + '<h4 class="section-heading">生成产物血缘</h4>' + table(['生成产物', '可信度', '输入或依赖', '匹配命令', '结论', '证据'], lineageRows, '没有生成产物血缘。') + '<h4 class="section-heading">产物复现状态</h4>' + table(['产物', '状态', '可重放', '输入', '生成命令', '当前指纹'], reproductionRows, '没有生成产物复现记录。') + '<h4 class="section-heading">后续纠正、覆盖关系和证据缺口</h4>' + table(['状态', '类型', '严重度', '最新决策', '处理方式', '覆盖的早期阶段'], decisionRows, '没有后续决策或证据缺口。') + (openQuestions.length ? '<h4 class="section-heading">仍需补证的问题</h4><ul>' + openQuestions.map((item) => '<li>' + escape(typeof item === 'string' ? item : item.question || item.message || JSON.stringify(item)) + '</li>').join('') + '</ul>' : '') + '<h4 class="section-heading">主动读取记录</h4><p class="section-note">这里明确区分“已完成”“已取完整指纹”“仅元数据”和“计划”，不会把计划包装成已完成。</p>' + table(['状态', '动作', '目标', '原因', '证据'], readRows, '没有主动读取记录。') + '</section>';
}

function projectPortfolioMarkup(portfolio, links = {}) {
  if (!portfolio) return '';
  const projects = Array.isArray(portfolio.projects) ? portfolio.projects : [];
  const assignments = Array.isArray(portfolio.sessionAssignments) ? portfolio.sessionAssignments : [];
  const unassigned = Array.isArray(portfolio.unassignedSessions) ? portfolio.unassignedSessions : [];
  const modeText = portfolio.crossProject ? '跨项目分组' : projects.length ? '同一项目联合蒸馏' : '暂未定位项目';
  const projectCards = projects.length
    ? projects.map((project, index) => {
      const evidence = project.evidenceSummary || project.evidence?.summary || {};
      const sessions = Array.isArray(project.sessions) ? project.sessions : [];
      return '<article class="project-portfolio-card"><header><div><span>项目 ' + number(index + 1) + '</span><h4>' + escape(project.name || project.projectId || '未命名项目') + '</h4></div><span class="project-confidence">置信度 ' + escape(project.confidence || '未知') + '</span></header><code class="project-root">' + escape(project.root || '未定位项目根目录') + '</code><div class="project-card-metrics"><span><strong>' + number(project.sessionCount || sessions.length) + '</strong>条会话</span><span><strong>' + number(evidence.scannedFiles) + '</strong>个扫描文件</span><span><strong>' + number(evidence.modifiedFiles) + '</strong>个修改或关联文件</span><span><strong>' + number(evidence.generatedFiles) + '</strong>个生成产物</span></div><p><strong>归属会话：</strong>' + escape(sessions.map((item) => item.title || item.sessionId).filter(Boolean).join('；') || '暂无可展示标题') + '</p><p><strong>项目依据：</strong>' + escape((project.markers || []).join('、') || (project.git ? 'Git 仓库与会话路径证据' : '会话工作目录、文件和命令路径')) + '</p>' + (project.evidenceError ? '<p class="project-evidence-error"><strong>证据读取提示：</strong>' + escape(project.evidenceError) + '</p>' : '') + '</article>';
    }).join('')
    : '<p class="section-note">所选会话中没有可验证的本地项目；会话内容仍会完整蒸馏，并在后续选择工作区时补充项目证据。</p>';
  const assignmentRows = assignments.map((item) => row([
    '<strong>' + escape(item.title || '未命名会话') + '</strong><br>' + code(item.sessionId || '未识别'),
    item.projectName ? '<strong>' + escape(item.projectName) + '</strong><br>' + code(item.projectRoot || '') : '<span class="unassigned-project">未归属</span>',
    badge(item.confidence || '未知') + (item.ambiguous ? '<br><span class="assignment-warning">存在相近候选</span>' : ''),
    escape(item.reason || '暂无判断依据'),
  ]));
  const linkMarkup = [
    anchor(links.projectPortfolio, '打开项目组合数据'),
    anchor(links.projectPortfolioMarkdown, '打开项目组合说明'),
    anchor(links.projectDiscovery, '打开项目发现数据'),
    anchor(links.projectDiscoveryMarkdown, '打开项目发现说明'),
  ].filter(Boolean).join('');
  return '<section class="project-portfolio"><div class="project-portfolio-heading"><div><span class="eyebrow">多会话项目识别</span><h3>系统已把每条会话归入对应项目</h3><p>按每条会话自己的工作目录、文件路径、命令参数、项目标记和 Git 线索独立判断；跨项目时分别读取文件与证据，不把不同项目混成一个流程。</p></div><div class="project-portfolio-mode"><strong>' + escape(modeText) + '</strong><span>' + number(projects.length) + ' 个项目 · ' + number(assignments.length) + ' 条会话</span></div></div><div class="project-portfolio-notice ' + (portfolio.crossProject ? 'cross-project' : '') + '"><strong>' + escape(portfolio.recommendedMode || modeText) + '</strong><span>' + (portfolio.crossProject ? '不同项目会保持独立文件、Git、产物和验证证据，同时输出一个可导航的组合能力包。' : projects.length ? '所选会话共同指向同一项目，将合并时间线并以最新修正为准。' : '没有项目也不阻断会话蒸馏，系统会明确标记待补证范围。') + '</span></div><div class="project-portfolio-grid">' + projectCards + '</div><h4 class="section-heading">逐条会话归属与判断依据</h4>' + table(['所选会话', '归属项目', '置信度', '为什么这样判断'], assignmentRows, '没有可展示的会话归属记录。') + (unassigned.length ? '<p class="project-unassigned-note">有 ' + number(unassigned.length) + ' 条会话暂未定位项目。它们仍保留在能力包中，不会被静默丢弃。</p>' : '') + (linkMarkup ? '<div class="source-project-links">' + linkMarkup + '</div>' : '') + '</section>';
}

function renderProject(result) {
  if (result?.analysis?.scopePolicy && !packageUsesProjectContext(result.analysis)) {
    return '<section class="project-scope-empty"><strong>本次只蒸馏已选会话</strong><p>没有明确选择项目，因此这里不展示项目背景、项目知识或同目录下其他文件。</p></section>';
  }
  return projectPortfolioMarkup(result.projectPortfolio, result.artifacts || {}) + projectKnowledgeV4Markup(result.projectKnowledgeV4, result.artifacts || {}) + projectUnderstandingMarkup(result.projectUnderstanding, result.artifacts || {});
}

function renderTab() {
  if (!state.result) return;
  const renderers = { timeline: renderTimeline, tools: renderTools, code: renderCode, project: renderProject, triggers: renderTriggers, skill: renderSkill };
  $('#tab-content').innerHTML = renderers[state.activeTab](state.result);
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.activeTab));
}

function deliveryLink(links, group, ...keys) {
  const value = links?.[group];
  if (typeof value === 'string') return value;
  for (const key of keys) {
    if (value?.[key]) return value[key];
    if (links?.[key]) return links[key];
  }
  return '';
}

function detailList(items) {
  return '<dl class="delivery-details">' + items.filter(([, value]) => value).map(([name, value]) => '<div><dt>' + escape(name) + '</dt><dd><code>' + escape(value) + '</code>' + copyButton(value) + '</dd></div>').join('') + '</dl>';
}

function sourceProjectEvidenceMarkup(sourceSet, projectEvidence, links = {}, projectUnderstanding = null) {
  const sourceSessions = Array.isArray(sourceSet?.sessions) ? sourceSet.sessions : [];
  const authorityBySession = new Map((sourceSet?.authority || []).map((item) => [item.sessionId, item]));
  const sessions = sourceSessions.map((item) => {
    const authority = authorityBySession.get(item.sessionId);
    return authority?.rank ? { ...item, title: `【优先级 ${authority.rank}】${item.title || item.sessionId || '未命名会话'}` } : item;
  });
  const project = projectEvidence || {};
  const summary = project.summary || project;
  const discovery = project.discovery || {};
  const sourceRows = sessions.length
    ? sessions.map((item, index) => '<li><strong>会话 ' + number(index + 1) + '：</strong>' + escape(item.title || item.sessionId || '未命名会话') + '<span>编号 ' + escape(item.sessionId || '未识别') + '；' + number(item.recordCount) + ' 条记录；' + number(item.normalisedEventCount) + ' 个事件</span><code>' + escape(item.sourcePath || item.path || '未提供来源路径') + '</code></li>').join('')
    : '<li>本次未返回来源会话清单。</li>';
  const projectFiles = [
    ...(project.modifiedFiles || []).slice(0, 8).map((item) => ({ ...item, group: '修改或关联' })),
    ...(project.generatedFiles || []).slice(0, 8).map((item) => ({ ...item, group: '生成产物' })),
  ];
  const fileRows = projectFiles.length
    ? projectFiles.map((item) => '<li><strong>' + escape(item.group) + '：</strong><code>' + escape(item.path || '未命名文件') + '</code><span>' + escape(item.changeState || item.status || '已识别') + '；' + (item.originalAvailable || item.original ? '已保留原始版本' : '无可用 Git 原始版本') + '；' + (item.hasDiff || item.diffExcerpt ? '已读取差异' : '无文本差异') + '</span></li>').join('')
    : '<li>自动发现未找到可验证项目，或已选项目中没有识别到修改和生成文件。</li>';
  const projectSummary = summary?.root
    ? '<p><strong>' + escape(summary.name || '已选项目') + '</strong>：' + escape(summary.discoveryMode || discovery.mode || '已选择') + '，置信度 ' + escape(summary.discoveryConfidence || discovery.confidence || '未记录') + '。扫描 ' + number(summary.scannedFiles) + ' 个文件，文本文件 ' + number(summary.textFiles) + ' 个，' + (summary.isGit ? 'Git 分支 ' + escape(summary.branch || '未命名') : '未识别 Git 仓库') + '；修改或关联 ' + number(summary.modifiedFiles) + ' 个文件，生成产物 ' + number(summary.generatedFiles) + ' 个。</p><p><strong>选择依据：</strong>' + escape(summary.discoveryReason || discovery.reason || '未记录') + '</p>'
    : '<p><strong>项目发现：</strong>' + escape(discovery.reason || '本次没有从会话工作目录、文件路径或项目标记中发现可验证的本地项目。') + '</p>';
  const understandingSummary = projectUnderstanding
    ? '<p><strong>深度理解：</strong>已建立 ' + number(projectUnderstanding.evidenceGraph?.nodes) + ' 个关系节点和 ' + number(projectUnderstanding.evidenceGraph?.edges) + ' 条关系；文件演化 ' + number((projectUnderstanding.fileEvolution || []).length) + ' 条，待确认或冲突 ' + number((projectUnderstanding.conflictRegister || []).length) + ' 项。</p>'
    : '';
  return '<section class="source-project-evidence"><div><span class="eyebrow">联合来源与项目理解</span><h3>蒸馏依据不是单条摘要</h3><p>每条会话保留标题、编号、路径、哈希和事件量；系统会自动定位关联项目，并保留当前文件、Git 原始版本、差异、会话关联文件和生成产物。</p></div><div class="source-project-grid"><section><h4>已纳入的会话</h4><ol class="source-session-list">' + sourceRows + '</ol></section><section><h4>已理解的项目</h4>' + projectSummary + understandingSummary + '<h4>关键文件证据</h4><ul class="project-file-list">' + fileRows + '</ul></section></div><div class="source-project-links">' + [anchor(links.sources, '查看来源会话清单'), anchor(links.projectDiscovery, '查看项目发现数据'), anchor(links.projectDiscoveryMarkdown, '查看项目发现说明'), anchor(links.projectEvidence, '查看项目证据数据'), anchor(links.projectEvidenceMarkdown, '查看项目证据说明'), anchor(links.projectUnderstanding, '查看项目深度理解数据'), anchor(links.projectUnderstandingMarkdown, '查看项目深度理解说明')].filter(Boolean).join('') + '</div></section>';
}

function renderPackage(payload) {
  const packageData = payload.package || {};
  const delivery = packageData.delivery || payload.delivery || {};
  const links = packageData.links || payload.links || {};
  const selection = packageData.selection || payload.selection || {};
  const range = Array.isArray(selection.selectedRecordRange) ? selection.selectedRecordRange : [1, selection.recordCount];
  const recordStart = Number(range[0] || 1);
  const recordEnd = Number(range[1] || selection.recordCount || 0);
  const root = packageData.root || payload.root || '';
  const manifest = packageData.manifest || payload.manifest || localPath(root, 'package-manifest.json');
  const verification = payload.verification || {};
  const description = packageData.description || {};
  const packageKey = payload.packageKey || packageData.packageKey || packageArtifactInfo(links.manifest).packageKey || packageData.id || '';
  const verificationPassed = verification.status === 'verified' || verification.ok === true;

  state.package = packageData;
  state.packageKey = packageKey;
  renderWorkbenchNavigation();
  document.body.classList.add('package-focus');
  $('#empty').hidden = true;
  $('#package-result').hidden = false;
  $('#package-title').textContent = packageData.name || '完整会话能力包';
  $('#package-state').dataset.state = verificationPassed ? 'verified' : 'ready';
  $('#package-state').textContent = verificationPassed ? '已完成蒸馏与校验' : '能力包已生成';
  const naming = packageData.naming || {};
  const namingBasis = [
    (naming.subjects || []).join('、'),
    (naming.contentTopics || []).join('、'),
    (naming.toolTerms || []).join('、'),
  ].filter(Boolean).join('；');
  $('#package-summary').textContent = description.summary || ('包标识：' + (packageData.id || '未提供') + '；已封装 ' + number(selection.recordCount || recordEnd) + ' 条原始记录和 ' + number(selection.normalisedEventCount) + ' 个标准化事件。命名依据：' + (namingBasis || '完整会话内容与实际工具'));
  $('#package-scope').textContent = '记录 ' + number(recordStart) + ' 至 ' + (recordEnd ? number(recordEnd) : '最后一条');
  $('#package-root').textContent = root || '未提供';
  $('#package-manifest').textContent = manifest || '未提供';
  const packageScopeNode = $('#package-scope');
  if (packageScopeNode) packageScopeNode.textContent = packageUsesProjectContext(payload)
    ? '已选会话 + 已确认项目的相关文件（按证据筛选）'
    : '仅已选会话（未读取项目文件、Git 或项目知识）';
  const rootValue = $('#package-root');
  const manifestValue = $('#package-manifest');
  rootValue.parentElement.querySelectorAll('.copy-button').forEach((button) => button.remove());
  manifestValue.parentElement.querySelectorAll('.copy-button').forEach((button) => button.remove());
  rootValue.insertAdjacentHTML('afterend', copyButton(root, '复制目录'));
  manifestValue.insertAdjacentHTML('afterend', copyButton(manifest, '复制路径'));

  const manifestLink = firstValue(links.manifest, links.packageManifest, payload.manifestLink);
  const blueprintLink = firstValue(links.blueprint, links.workflow, links.workflowBlueprint);
  const verifyLink = firstValue(links.verify, links.verifier);
  const guideLink = firstValue(links.guide, links.readme, links.packageGuide);
  const descriptionLink = firstValue(links.description, links.packageDescription);
  const capabilityLink = firstValue(links.capability, delivery.agent?.links?.capability);
  const priorityPlanLink = firstValue(links.priorityPlan, delivery.agent?.links?.priorityPlan);
  const taskCatalogLink = firstValue(links.taskCatalog, delivery.agent?.links?.taskCatalog);
  const recommendationLink = firstValue(links.recommendation, delivery.agent?.links?.recommendation);
  const recommendationHtmlLink = firstValue(links.recommendationHtml);
  const evidenceManifestLink = firstValue(links.evidenceManifest, delivery.agent?.links?.evidenceManifest);
  const distillationLink = firstValue(links.distillation, links.conversationDistillation, delivery.distillation?.links?.markdown);
  const distillationJsonLink = firstValue(links.distillationJson, links.conversationDistillationJson, delivery.distillation?.links?.json);
  const archiveLink = firstValue(links.archive, links.download, links.zip);
  const sourcesLink = firstValue(links.sources, delivery.sources?.link);
  const projectDiscoveryLink = firstValue(links.projectDiscovery, delivery.projectDiscovery?.links?.json);
  const projectDiscoveryMarkdownLink = firstValue(links.projectDiscoveryMarkdown, delivery.projectDiscovery?.links?.markdown);
  const projectEvidenceLink = firstValue(links.projectEvidence, delivery.projectEvidence?.links?.json);
  const projectEvidenceMarkdownLink = firstValue(links.projectEvidenceMarkdown, delivery.projectEvidence?.links?.markdown);
  const projectPortfolioLink = firstValue(links.projectPortfolio, delivery.projectPortfolio?.links?.json, delivery.agent?.links?.projectPortfolio);
  const projectPortfolioMarkdownLink = firstValue(links.projectPortfolioMarkdown, delivery.projectPortfolio?.links?.markdown, delivery.agent?.links?.projectPortfolioMarkdown);
  const projectUnderstandingLink = firstValue(links.projectUnderstanding, delivery.projectUnderstanding?.links?.json, delivery.agent?.links?.projectUnderstanding);
  const projectUnderstandingMarkdownLink = firstValue(links.projectUnderstandingMarkdown, delivery.projectUnderstanding?.links?.markdown, delivery.agent?.links?.projectUnderstandingMarkdown);
  const projectKnowledgeV4Link = firstValue(links.projectKnowledgeV4, delivery.agent?.links?.projectKnowledgeV4);
  const projectKnowledgeV4MarkdownLink = firstValue(links.projectKnowledgeV4Markdown, delivery.agent?.links?.projectKnowledgeV4Markdown);
  const releaseValidation = packageData.releaseValidation || {};
  const releaseDecision = packageData.releaseDecision || {};
  $('#package-links').innerHTML = [
    packageKey ? '<button type="button" class="primary package-header-launch" data-launch-package="' + escape(packageKey) + '">启动 Agent</button>' : '',
    capabilityLink ? '<button type="button" data-package-view-shortcut="capability">查看能力</button>' : '',
    guideLink ? '<button type="button" data-package-document="' + escape(guideLink) + '" data-document-title="完整使用说明">阅读说明</button>' : '',
    anchor(archiveLink, '下载 ZIP'),
  ].filter(Boolean).join('');

  const phases = Array.isArray(description.phases) ? description.phases : [];
  const actualTools = Array.isArray(description.actualTools) ? description.actualTools : [];
  const deliverables = Array.isArray(description.deliverables) ? description.deliverables : [];
  const expertise = Array.isArray(description.expertise) ? description.expertise : [];
  const expertiseRows = expertise.length
    ? expertise.map((item) => '<tr><td><strong>' + escape((item.phase ? item.phase + '｜' : '') + (item.capability || '会话专属能力')) + '</strong></td><td>' + escape(item.whenToUse || '在原会话确认的输入和目标再次出现时使用。') + '</td><td>' + escape(item.executionMethod || '回查会话证据 → 执行阶段做法 → 核对交付结果。') + '</td></tr>').join('')
    : '<tr><td colspan="3">本次尚未返回可展示的会话专长。</td></tr>';
  const sourceSet = packageData.sourceSet || payload.sourceSet || { mode: selection.mode, sessionCount: selection.sessionCount, sessions: selection.sessions || [] };
  const sourceSessionCount = sourceSet.sessionCount || sourceSet.sessions?.length || selection.sessionCount || 0;
  const glanceItems = [
    ['来源会话', sourceSessionCount, '完整纳入'],
    ['原始记录', selection.recordCount || recordEnd, '全量读取'],
    ['专属能力', expertise.length || phases.length, '从会话提炼'],
    ['实际工具', actualTools.length, '真实调用'],
    ['校验文件', verification.artifactCount || verification.checkedArtifacts || 0, verificationPassed ? '校验通过' : '已纳入清单'],
  ];
  $('#package-glance').innerHTML = glanceItems.map(([label, value, note]) => '<div><span>' + escape(label) + '</span><strong>' + number(value) + '</strong><small>' + escape(note) + '</small></div>').join('');
  const projectPortfolio = payload.analysis?.projectPortfolio || packageData.projectPortfolio || null;
  const projectEvidence = payload.analysis?.projectEvidence || (packageData.projectEvidenceSummary || packageData.projectDiscovery ? { summary: packageData.projectEvidenceSummary || {}, discovery: packageData.projectDiscovery || null } : null);
  const projectUnderstanding = payload.analysis?.projectUnderstanding || packageData.projectUnderstanding || null;
  const projectKnowledgeV4 = payload.analysis?.projectKnowledgeV4 || packageData.projectKnowledgeV4 || null;
  const projectKnowledgeLinks = { projectKnowledgeV4: projectKnowledgeV4Link, projectKnowledgeV4Markdown: projectKnowledgeV4MarkdownLink, semanticStages: links.semanticStages, evidenceLedger: links.evidenceLedger, projectModel: links.projectModel, projectGraph: links.projectGraph, fileVersions: links.fileVersions, artifactLineage: links.artifactLineage, crossSessionTimeline: links.crossSessionTimeline, fileChangeMatrix: links.fileChangeMatrix, dependencyImpact: links.dependencyImpact, artifactReproducibility: links.artifactReproducibility, projectSnapshot: links.projectSnapshot, openEvidenceQuestions: links.openEvidenceQuestions, decisionConflicts: links.decisionConflicts, knowledgeCoverage: links.knowledgeCoverage, activeReadLog: links.activeReadLog };
  $('#package-description').innerHTML = '<div class="description-heading"><div><span class="eyebrow">包的直白说明</span><h3>这个能力包具体做什么</h3></div>' + (descriptionLink ? anchor(descriptionLink, '查看完整结构化说明') : '') + '</div><p class="package-description-summary">' + escape(description.summary || '本包会把完整会话转成可安装技能、可连接服务和可实际执行任务的独立 Agent。') + '</p><p class="package-name-basis"><strong>命名依据：</strong>' + escape(description.namingExplanation || namingBasis || '完整会话主题、实际工具与文件变更') + '</p>' + projectPortfolioMarkup(projectPortfolio, { projectPortfolio: projectPortfolioLink, projectPortfolioMarkdown: projectPortfolioMarkdownLink, projectDiscovery: projectDiscoveryLink, projectDiscoveryMarkdown: projectDiscoveryMarkdownLink }) + sourceProjectEvidenceMarkup(sourceSet, projectEvidence, { sources: sourcesLink, projectDiscovery: projectDiscoveryLink, projectDiscoveryMarkdown: projectDiscoveryMarkdownLink, projectEvidence: projectEvidenceLink, projectEvidenceMarkdown: projectEvidenceMarkdownLink, projectUnderstanding: projectUnderstandingLink, projectUnderstandingMarkdown: projectUnderstandingMarkdownLink }, projectUnderstanding) + projectKnowledgeV4Markup(projectKnowledgeV4, projectKnowledgeLinks) + (projectUnderstanding ? projectUnderstandingMarkup(projectUnderstanding, { projectUnderstanding: projectUnderstandingLink, projectUnderstandingMarkdown: projectUnderstandingMarkdownLink, projectEvidence: projectEvidenceLink, projectEvidenceMarkdown: projectEvidenceMarkdownLink }) : '') + '<div class="package-description-grid"><section><h4>需求阶段地图</h4><ol class="phase-map">' + (phases.length ? phases.map((item) => '<li><strong>' + escape(item.id || '') + '</strong><span>' + escape(item.title || '') + '</span><em>' + escape(item.role || '') + '</em></li>').join('') : '<li><span>本次未返回阶段地图。</span></li>') + '</ol></section><section><h4>实际观测工具</h4><p class="tool-list">' + (actualTools.length ? actualTools.map((item) => code(item)).join(' ') : '本次没有可展示的工具记录。') + '</p><h4>会生成的交付物</h4><ul class="plain-list">' + (deliverables.length ? deliverables.map((item) => '<li>' + escape(item) + '</li>').join('') : '<li>完整说明、清单和证据文件。</li>') + '</ul></section></div><section class="package-expertise"><div class="description-heading"><div><span class="eyebrow">本会话专属结果</span><h4>从原会话提炼出的专长</h4></div></div><p>下面的每一行都绑定一个 P 阶段，写明什么时候使用以及如何执行，不是通用任务模板。</p><div class="package-expertise-table-wrap"><table class="package-expertise-table"><thead><tr><th>专长</th><th>什么时候使用</th><th>执行方法</th></tr></thead><tbody>' + expertiseRows + '</tbody></table></div></section>';

  $('#package-description').insertAdjacentHTML('beforeend', '<section class="distillation-result-callout"><strong>会话蒸馏结果</strong><span>通用 Codex 工具底座与从原会话逐阶段提炼出的 P 阶段专属能力已分开交付；每一阶段都包含目标、做法、交付物和原会话证据。</span><div>' + anchor(distillationLink, '打开可阅读的蒸馏说明') + anchor(distillationJsonLink, '打开完整蒸馏数据') + '</div></section>');
  const validationItems = [
    ['G4', '确定性复跑', releaseValidation.deterministicReplay],
    ['G6', '原任务回放', releaseValidation.originalTaskReplay],
    ['G7', '新任务留出验收', releaseValidation.heldOutEvaluation],
    ['G9', '隔离 Agent 执行', releaseValidation.isolatedAgentValidation],
  ];
  const validationLabels = { pass: '通过', fail: '未通过', pending: '待验证', restricted: '受限' };
  $('#package-description').insertAdjacentHTML('beforeend', '<section class="package-release-validation"><div class="description-heading"><div><span class="eyebrow">发布验证</span><h4>这份能力包经过了哪些真实检查</h4></div><span class="package-release-state" data-state="' + escape(releaseDecision.status || 'candidate') + '">' + escape(({ publishable: '可发布', restricted: '受限可用', candidate: '候选能力', blocked: '已阻断' })[releaseDecision.status] || '候选能力') + '</span></div><div class="package-release-validation-grid">' + validationItems.map(([gate, title, result]) => '<article><span>' + gate + '</span><strong>' + escape(title) + '</strong><em data-state="' + escape(result?.status || 'pending') + '">' + escape(validationLabels[result?.status] || '待验证') + '</em><p>' + escape(result?.reason || '尚未生成这项验证记录。') + '</p></article>').join('') + '</div><div class="package-release-validation-actions">' + [anchor(links.releaseDecision, '查看全部 G0-G9'), anchor(links.originalTaskReplay, '查看原任务回放'), anchor(links.heldOutEvaluation, '查看留出任务'), anchor(links.isolatedAgentValidation, '查看隔离执行')].filter(Boolean).join('') + '</div></section>');

  const sections = [];
  let agentLaunch = null;
  if (delivery.skill) {
    const item = delivery.skill;
    const skillRoot = firstValue(item.root, item.directory && localPath(root, item.directory));
    const skillFile = firstValue(item.skillFile, item.file, skillRoot && localPath(skillRoot, 'SKILL.md'));
    const interfaceFile = firstValue(item.interfaceFile, item.interface, skillRoot && localPath(skillRoot, 'agents', 'openai.yaml'));
    const installDirectory = firstValue(item.installDirectory, item.installPath);
    const action = anchor(firstValue(item.links?.skill, item.links?.skillFile, deliveryLink(links, 'skill', 'skillFile', 'skillDefinition')), '查看技能定义');
    sections.push('<section class="delivery-item"><div class="delivery-heading"><span>01</span><div><h3>可安装技能</h3><p>包含触发说明、执行流程、接口元数据和确定性工作流脚本。</p></div></div>' + detailList([['生成目录', skillRoot], ['技能定义', skillFile], ['接口定义', interfaceFile], ['建议安装目录', installDirectory]]) + (action ? '<div class="delivery-actions">' + action + '</div>' : '') + '</section>');
  }
  if (delivery.mcp) {
    const item = delivery.mcp;
    const mcpRoot = firstValue(item.root, item.directory && localPath(root, item.directory));
    const server = firstValue(item.server, item.serverFile, item.file);
    const config = firstValue(item.config, item.configFile);
    const serverPath = server && !/^[A-Za-z]:[\\/]/.test(server) ? localPath(root, server) : server;
    const configPath = config && !/^[A-Za-z]:[\\/]/.test(config) ? localPath(root, config) : config;
    const actions = [anchor(firstValue(item.links?.server, deliveryLink(links, 'mcp', 'server', 'serverFile', 'mcpServer')), '查看服务程序'), anchor(firstValue(item.links?.config, deliveryLink(links, 'mcp', 'config', 'configFile', 'mcpConfig')), '查看连接配置')].filter(Boolean).join('');
    sections.push('<section class="delivery-item"><div class="delivery-heading"><span>02</span><div><h3>模型上下文协议服务</h3><p>可作为独立标准输入输出服务注册，提供工作流、证据摘要、执行计划和能力包文件读取工具。</p></div></div>' + detailList([['服务目录', mcpRoot], ['服务程序', serverPath], ['连接配置', configPath]]) + (actions ? '<div class="delivery-actions">' + actions + '</div>' : '') + '</section>');
  }
  if (delivery.agent) {
    const item = delivery.agent;
    const agentRoot = firstValue(item.root, item.directory && localPath(root, item.directory));
    const server = firstValue(item.server, item.serverFile, agentRoot && localPath(agentRoot, 'agent-server.mjs'));
    const serverPath = server && !/^[A-Za-z]:[\\/]/.test(server) ? localPath(root, server) : server;
    const startCommand = firstValue(item.startCommand, item.command, serverPath && ('node "' + serverPath + '"'));
    const interfaceUrl = firstValue(item.url, item.interfaceUrl, links.agentUrl);
    const ui = item.ui || {};
    const aiProfile = firstValue(item.aiProfile, item.aiProfileFile);
    const readme = firstValue(item.readme, item.readmeFile);
    const envExample = firstValue(item.envExample, item.envExampleFile, item.envFile);
    const uiIndex = firstValue(ui.index, ui.indexFile, item.uiIndex);
    const uiApp = firstValue(ui.app, ui.appFile, item.uiApp);
    const uiStyles = firstValue(ui.styles, ui.stylesFile, item.uiStyles);
    const liveInterface = anchor(firstValue(item.url, item.interfaceUrl, links.agentUrl), '打开已启动的独立界面');
    const oneClickInstall = firstValue(item.install?.windows?.oneClick, item.install?.windows?.installer);
    const directLaunch = firstValue(item.install?.windows?.direct, item.install?.windows?.launcher);
    const oneClickInstallLink = firstValue(item.links?.install?.windows?.oneClick, item.links?.install?.windows?.installer);
    const directLaunchLink = firstValue(item.links?.install?.windows?.direct, item.links?.install?.windows?.launcher);
    const launcher = firstValue(item.launcher, item.launcherFile);
    const launcherLink = firstValue(item.links?.launcher);
    const actions = [
      anchor(item.links?.capability, '查看专属能力说明'),
      anchor(item.links?.priorityPlan, '查看优先级计划'),
      anchor(item.links?.taskCatalog, '查看任务目录'),
      anchor(item.links?.recommendation, '查看蒸馏建议'),
      anchor(item.links?.evidenceManifest, '查看证据清单'),
      anchor(item.links?.distillation, '查看 Agent 会话蒸馏说明'),
      anchor(item.links?.distillationJson, '查看 Agent 蒸馏数据'),
      anchor(item.links?.readme, '查看使用说明'),
      anchor(item.links?.aiProfile, '查看人工智能配置'),
      anchor(item.links?.envExample, '查看环境配置示例'),
      anchor(oneClickInstallLink, '查看 Windows 一键安装启动器'),
      anchor(directLaunchLink, '查看 Windows 临时启动器'),
      anchor(launcherLink, '查看启动程序'),
      liveInterface || anchor(firstValue(item.links?.ui?.index, item.links?.interface, deliveryLink(links, 'agent', 'interface', 'agentInterface')), '查看独立界面文件'),
      anchor(item.links?.ui?.app, '查看界面交互脚本'),
      anchor(item.links?.ui?.styles, '查看界面样式'),
      anchor(firstValue(item.links?.server, deliveryLink(links, 'agent', 'server', 'agentServer')), '查看代理服务程序'),
    ].filter(Boolean).join('');
    const installPath = oneClickInstall || localPath(root, 'install-and-start.cmd');
    agentLaunch = { installPath, oneClickInstallLink, directLaunchLink, agentRoot };
    sections.push('<section class="delivery-item"><div class="delivery-heading"><span>03</span><div><h3>可实际执行本地工作的独立 Agent</h3><p>它会按本包的 P0-P3 建议理解任务，读取工作区，修改文件，运行命令，查看 Git 差异，执行验证并保留恢复点。</p></div></div><div class="agent-ai-capability"><strong>独立 AI 与本地工具</strong><span>可自动连接当前 Codex 环境或配置兼容模型服务；模型负责理解和决策，本地工具负责真实读写、命令、Git、验证和过程记录。</span></div>' + detailList([['项目目录', agentRoot], ['使用说明', readme], ['专属能力说明', item.capability], ['优先级计划', item.priorityPlan], ['任务目录', item.taskCatalog], ['证据清单', item.evidenceManifest], ['人工智能配置', aiProfile], ['环境配置示例', envExample], ['服务程序', serverPath], ['启动程序', launcher], ['Windows 一键安装启动器', installPath], ['Windows 临时启动器', directLaunch], ['独立界面入口', uiIndex], ['界面交互脚本', uiApp], ['界面样式', uiStyles], ['启动命令', startCommand], ['网页地址', interfaceUrl || '启动后自动打开，不需要预先猜端口']]) + '<p class="delivery-hint">在本机工作台可直接启动；交给其他用户时，下载 ZIP、解压并双击 Windows 一键安装启动器即可。</p>' + (actions ? '<div class="delivery-actions">' + actions + '</div>' : '') + '</section>');
  }
  $('#package-delivery').innerHTML = sections.join('') || '<p class="section-note">本次响应中没有可展示的交付物，请检查所选生成类型。</p>';

  const guideAction = anchor(guideLink, '打开完整说明');
  const capabilityAction = anchor(capabilityLink, '先看直白能力说明');
  const archiveAction = anchor(archiveLink, '下载完整 ZIP');
  const agentAction = agentLaunch?.oneClickInstallLink ? anchor(agentLaunch.oneClickInstallLink, '查看 Windows 一键启动器') : '';
  const workbenchLaunch = packageKey
    ? '<button type="button" class="action primary" data-launch-package="' + escape(packageKey) + '">在工作台启动独立 Agent</button>'
    : '';
  $('#package-next-steps').innerHTML = '<div><span class="eyebrow">生成后看这里</span><h3>查看、启动或交给其他用户</h3></div><ol><li><strong>先看它具体能做什么：</strong>' + (capabilityAction || guideAction || '打开包内 CAPABILITY.md') + '，再查看 P0-P3 和任务目录。</li><li><strong>直接开始使用：</strong>' + (workbenchLaunch || (agentLaunch ? '双击 <code>' + escape(agentLaunch.installPath) + '</code>' + copyButton(agentLaunch.installPath, '复制启动器路径') : '本次没有生成 Agent。')) + (workbenchLaunch ? '<span class="inline-hint">系统会自动启动专属中文 UI，不需要查找目录、端口或命令。</span>' : '') + '</li><li><strong>交给其他用户：</strong>' + (archiveAction || '使用包根目录旁的 ZIP 文件') + '，解压后双击一键启动器，不需要本工作台。</li><li><strong>本机保存位置：</strong><code>' + escape(root || '未提供') + '</code>' + copyButton(root, '复制能力包目录') + '</li></ol>';
  bindCopyButtons($('#package-result'));
  bindPackageLaunchButtons($('#package-result'));

  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const verificationTitle = verification.status === 'verified' || verification.ok === true ? '完整性校验已通过' : '完整性清单已生成';
  $('#package-verification').innerHTML = '<strong>' + verificationTitle + '</strong><span>' + number(verification.artifactCount || verification.checkedArtifacts) + ' 个文件已纳入校验</span>' + (checks.length ? '<ul>' + checks.map((item) => '<li>' + escape(item) + '</li>').join('') + '</ul>' : '');
  const documentLinks = {
    capability: capabilityLink,
    priorityPlan: priorityPlanLink,
    taskCatalog: taskCatalogLink,
    guide: guideLink,
    sources: sourcesLink,
    projectDiscovery: projectDiscoveryLink,
    projectDiscoveryMarkdown: projectDiscoveryMarkdownLink,
    projectEvidence: projectEvidenceLink,
    projectEvidenceMarkdown: projectEvidenceMarkdownLink,
  };
  configurePackageWorkbench(payload, documentLinks, projectKnowledgeLinks);
  renderResultOverview();
}

function renderResult(result, artifactLinks = null) {
  state.result = result;
  renderWorkbenchNavigation();
  $('#empty').hidden = true;
  $('#result').hidden = false;
  $('#result-title').textContent = result.presentation?.title || '会话取证报告';
  $('#result-summary').textContent = result.presentation?.summary || '本次解析已完成。';
  const sourceSet = result.sourceSet || result.multiSource || {};
  const sourceTitles = (sourceSet.sessions || []).slice(0, 4).map((item) => item.title || item.sessionId).filter(Boolean);
  const projectPortfolio = result.projectPortfolio || null;
  const projectCount = Number(projectPortfolio?.projects?.length || 0);
  const projectSummary = result.projectEvidence?.summary || result.projectEvidenceSummary;
  const portfolioSummary = projectCount
    ? '；识别 ' + number(projectCount) + ' 个项目，' + (projectPortfolio.crossProject ? '已按项目隔离会话、文件、Git 和产物证据' : '所选会话共同指向同一项目')
    : (projectSummary?.root ? '；项目：' + (projectSummary.name || projectSummary.root) + '（' + (projectSummary.discoveryMode || result.projectDiscovery?.mode || '已选择') + '），修改或关联 ' + number(projectSummary.modifiedFiles) + ' 个文件，生成 ' + number(projectSummary.generatedFiles) + ' 个产物' : '；自动发现未找到可验证项目');
  $('#result-source').textContent = '联合会话：' + number(sourceSet.sessionCount || 1) + ' 条' + (sourceTitles.length ? '（' + sourceTitles.join('；') + (sourceSet.sessions?.length > sourceTitles.length ? '；……' : '') + '）' : '') + '；总编号：' + (result.sessionId || '未识别') + '；来源哈希：' + (result.source?.sha256 || '未提供') + portfolioSummary;
  renderMetrics(result.summary || {});
  renderResultOverview();
  const links = artifactLinks || result.artifacts || {};
  $('#artifact-links').innerHTML = [['report', '报告网页'], ['markdown', '报告原文'], ['analysis', '结构化分析数据'], ['sources', '来源会话清单'], ['projectPortfolio', '多项目组合数据'], ['projectPortfolioMarkdown', '多项目组合说明'], ['projectDiscovery', '项目发现数据'], ['projectDiscoveryMarkdown', '项目发现说明'], ['projectEvidence', '项目证据数据'], ['projectEvidenceMarkdown', '项目证据说明'], ['projectUnderstanding', '项目深度理解数据'], ['projectUnderstandingMarkdown', '项目深度理解说明'], ['projectKnowledgeV4', '项目级蒸馏数据'], ['projectKnowledgeV4Markdown', '项目级蒸馏说明'], ['semanticStages', '跨会话语义阶段'], ['evidenceLedger', '逐条证据账本'], ['projectModel', '项目模型'], ['projectGraph', '项目知识图'], ['fileVersions', '文件版本链'], ['artifactLineage', '产物血缘'], ['crossSessionTimeline', '跨会话时间线'], ['fileChangeMatrix', '文件变更矩阵'], ['dependencyImpact', '依赖影响'], ['artifactReproducibility', '产物复现表'], ['projectSnapshot', '项目快照'], ['openEvidenceQuestions', '待补证问题'], ['decisionConflicts', '后续决策与冲突'], ['knowledgeCoverage', '读取覆盖率'], ['activeReadLog', '主动读取记录']].map(([key, text]) => anchor(links[key], text)).filter(Boolean).join('');
  bindPackageDocumentButtons($('#artifact-links'));
  renderTab();
}

function formatPackageDate(value) {
  if (!value) return '生成时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '生成时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function packagePhaseChips(description) {
  const phases = Array.isArray(description?.phases) ? description.phases : [];
  return phases.map((phase) => '<span>' + escape(phase.title || phase.id || '未命名阶段') + '</span>').join('');
}

function packageSearchText(item) {
  const packageData = item?.package || {};
  const description = packageData.description || {};
  return [
    item?.packageKey,
    packageData.id,
    packageData.name,
    packageData.root,
    description.summary,
    ...(packageData.targets || []),
    ...(description.phases || []).flatMap((phase) => [phase.id, phase.title, phase.description]),
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
}

function packageGeneratedAt(item) {
  const value = Date.parse(item?.generatedAt || item?.modifiedAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function packageReleaseInfo(item) {
  const packageData = item?.package || {};
  const status = packageData.releaseDecision?.status || item?.verification?.status || 'candidate';
  const labels = {
    publishable: '可发布',
    verified: '已通过校验',
    manifested: '已生成校验清单',
    restricted: '受限可用',
    candidate: '待进一步验证',
    blocked: '已阻断',
  };
  return { status, label: labels[status] || '已生成' };
}

function renderResultOverview() {
  const root = $('#result-overview-strip');
  if (!root) return;
  const packageData = state.package || {};
  const result = state.result || {};
  const run = state.run || {};
  const sourceSet = packageData.sourceSet || result.sourceSet || result.multiSource || {};
  const sourceCount = Number(packageData.selection?.sessionCount || sourceSet.sessionCount || sourceSet.sessions?.length || 0);
  const phases = Array.isArray(packageData.description?.phases) ? packageData.description.phases : [];
  const priorities = Array.isArray(run.recommendation?.priorities) ? run.recommendation.priorities : [];
  const capabilityCount = phases.length || priorities.length;
  const libraryCount = Number(state.packageLibrary.length || state.packageLibraryTotal || 0);
  const topics = packageData.naming?.contentTopics || packageData.naming?.semanticProfile?.topics || [];
  const hasData = Boolean(state.result || state.run || state.package || libraryCount);
  root.hidden = !hasData;
  if (!hasData) return;

  $('#result-overview-source').textContent = sourceCount ? number(sourceCount) + ' 条会话' : '历史能力包';
  $('#result-overview-source-detail').textContent = sourceCount
    ? (topics.slice(0, 3).join('、') || '按本次选中范围蒸馏')
    : '当前没有新的蒸馏任务，可从历史记录继续使用。';
  $('#result-overview-capabilities').textContent = capabilityCount ? number(capabilityCount) + ' 项能力' : '等待分析';
  $('#result-overview-capabilities-detail').textContent = phases.length
    ? phases.slice(0, 3).map((phase) => phase.id || phase.title).filter(Boolean).join('、') + (phases.length > 3 ? ' 等' : '')
    : priorities.length
      ? '已形成 P0-P3 建议与执行顺序。'
      : '分析后会显示来自真实会话和工具过程的能力。';
  $('#result-overview-packages').textContent = number(libraryCount) + ' 个';
  $('#result-overview-packages-detail').textContent = state.package
    ? (packageReleaseInfo({ package: packageData }).label + '，可直接启动或交付。')
    : libraryCount
      ? '可再次打开、下载或运行。'
      : '生成后会保存在这里。';

  const action = state.package
    ? { type: 'package', title: '进入刚生成的能力包', button: '查看能力包' }
    : state.run
      ? { type: 'recommendation', title: '查看系统建议并决定是否生成', button: '查看建议' }
      : libraryCount
        ? { type: 'library', title: '从历史能力包中继续使用', button: '浏览能力包' }
        : { type: 'source', title: '选择会话开始蒸馏', button: '选择会话' };
  $('#result-overview-next').textContent = action.title;
  const button = $('#result-overview-primary');
  button.dataset.resultOverviewAction = action.type;
  button.textContent = action.button;
}

function packageMatchesFilters(item, query, target, days) {
  const packageData = item?.package || {};
  if (query && !packageSearchText(item).includes(query)) return false;
  if (target !== 'all' && !(packageData.targets || []).includes(target)) return false;
  if (days !== 'all') {
    const timestamp = packageGeneratedAt(item);
    const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    if (!timestamp || timestamp < cutoff) return false;
  }
  return true;
}

function renderResultHubState() {
  renderResultOverview();
  const title = $('#results-empty-title');
  const description = $('#results-empty-description');
  if (!title || !description || state.run || state.result || state.package) return;
  if (state.packageLibrary.length) {
    title.textContent = '当前没有新的蒸馏结果';
    description.textContent = '已找到 ' + number(state.packageLibrary.length) + ' 个历史能力包。可直接从下方搜索并打开，或返回选择会话开始新一次蒸馏。';
  } else {
    title.textContent = '还没有新的蒸馏结果';
    description.textContent = '先从左侧选择本机对话或网页端对话，完成蒸馏后，系统建议、P0-P3、证据和能力包会统一显示在这里。';
  }
}

function renderPackageLibrary(packages) {
  const root = $('#recent-packages');
  if (!root) return;
  const allPackages = Array.isArray(packages) ? packages : [];
  const query = String($('#package-library-search')?.value || '').trim().toLocaleLowerCase('zh-CN');
  const target = $('#package-library-target')?.value || 'all';
  const days = $('#package-library-time')?.value || 'all';
  const sort = $('#package-library-sort')?.value || 'latest';
  const visiblePackages = allPackages
    .filter((item) => packageMatchesFilters(item, query, target, days))
    .sort((left, right) => sort === 'name'
      ? String(left.package?.name || left.packageKey || '').localeCompare(String(right.package?.name || right.packageKey || ''), 'zh-CN')
      : sort === 'oldest'
        ? packageGeneratedAt(left) - packageGeneratedAt(right)
        : packageGeneratedAt(right) - packageGeneratedAt(left));
  const count = $('#package-library-count');
  const filtered = Boolean(query || target !== 'all' || days !== 'all');
  if (count) count.textContent = filtered
    ? number(visiblePackages.length) + ' / ' + number(allPackages.length) + ' 个'
    : state.packageLibraryLoaded
      ? number(allPackages.length) + ' 个'
      : number(allPackages.length) + ' / ' + number(state.packageLibraryTotal || allPackages.length) + ' 个';
  if (!allPackages.length) {
    root.innerHTML = '<div class="recent-package-empty"><strong>还没有可回看的能力包</strong><p>生成第一个能力包后，它会在这里保留入口；刷新页面也不会丢失。</p></div>';
    return;
  }
  if (!visiblePackages.length) {
    root.innerHTML = '<div class="recent-package-empty"><strong>没有匹配的能力包</strong><p>请尝试名称、能力、项目或目录中的其他关键词。</p></div>';
    return;
  }
  root.innerHTML = visiblePackages.map((item, index) => {
    const packageData = item.package || {};
    const description = packageData.description || {};
    const links = packageData.links || {};
    const summary = String(description.summary || '已生成能力包，可从下方入口查看完整说明和文件。').replace(/\s+/g, ' ').trim();
    const selection = packageData.selection || {};
    const phaseMarkup = packagePhaseChips(description) || '<span>阶段地图见完整说明</span>';
    const actionLinks = [
      anchor(links.archive, '下载完整 ZIP'),
      packagePageAnchor(item.packageKey, 'capability', '查看能力说明', 'document-link'),
      packagePageAnchor(item.packageKey, 'priorities', '查看 P0-P3', 'document-link'),
      packagePageAnchor(item.packageKey, 'tasks', '查看任务目录', 'document-link'),
      links.guide ? packageDocumentPageUrl(links.guide, '完整使用说明') && '<a class="document-link" href="' + escape(packageDocumentPageUrl(links.guide, '完整使用说明')) + '" target="_blank" rel="noreferrer">打开完整说明</a>' : '',
    ].filter(Boolean).join('');
    const launchButton = packagePageAnchor(item.packageKey, 'agent', '打开专属 Agent', 'primary');
    const overviewButton = packagePageAnchor(item.packageKey, 'overview', '打开能力包子页面');
    const detailsId = 'package-details-' + escape(String(item.packageKey || packageData.id || 'package').replace(/[^a-z0-9_-]/gi, '-')) + '-' + index;
    return '<article class="recent-package"><div class="recent-package-header"><div><h3>' + escape(packageData.name || item.packageKey) + '</h3><div class="recent-package-quick-meta"><span>' + number(selection.recordCount) + ' 条记录</span><span>' + escape(list(packageData.targets || [], '交付物未记录')) + '</span></div></div><time datetime="' + escape(item.generatedAt || item.modifiedAt || '') + '">' + escape(formatPackageDate(item.generatedAt || item.modifiedAt)) + '</time></div><p class="recent-package-summary">' + escape(summary) + '</p><div class="recent-package-primary-actions">' + launchButton + overviewButton + '<button type="button" class="secondary package-details-toggle" data-package-details-toggle="' + detailsId + '" aria-expanded="false" aria-controls="' + detailsId + '">展开完整信息</button></div><section id="' + detailsId + '" class="recent-package-details" hidden><div class="recent-package-phases" aria-label="语义阶段">' + phaseMarkup + '</div><div class="recent-package-meta"><span>完整记录：' + number(selection.recordCount) + ' 条</span><span>交付类型：' + escape(list(packageData.targets || [], '清单未记录')) + '</span><span>保存目录：<code>' + escape(packageData.root || '未提供') + '</code></span></div><div class="recent-package-actions">' + actionLinks + copyButton(packageData.root, '复制包目录') + '</div></section></article>';
  }).join('');
  bindCopyButtons(root);
}

async function loadPackageLibrary() {
  const root = $('#recent-packages');
  if (!root) return;
  state.packageLibraryLoaded = false;
  state.packageLibraryError = false;
  state.packageLibrary = [];
  state.packageLibraryTotal = 0;
  renderWorkbenchNavigation();
  try {
    let offset = 0;
    do {
      const response = await fetch('/api/packages?limit=100&offset=' + offset);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '能力包列表读取失败。');
      const incoming = Array.isArray(data.packages) ? data.packages : [];
      const packages = new Map(state.packageLibrary.map((item) => [item.packageKey, item]));
      incoming.forEach((item) => packages.set(item.packageKey, item));
      state.packageLibrary = [...packages.values()];
      state.packageLibraryTotal = Number(data.total || state.packageLibrary.length);
      renderPackageLibrary(state.packageLibrary);
      renderResultOverview();
      offset = Number.isFinite(data.nextOffset) ? data.nextOffset : null;
    } while (offset !== null);
    state.packageLibraryLoaded = true;
    renderPackageLibrary(state.packageLibrary);
    renderResultHubState();
    renderWorkbenchNavigation();
  } catch (error) {
    state.packageLibraryLoaded = true;
    state.packageLibraryError = true;
    const count = $('#package-library-count');
    if (count) count.textContent = '读取失败';
    renderWorkbenchNavigation();
    root.innerHTML = '<p class="section-note">' + escape(friendlyError(error, '能力包列表读取失败，请检查本地服务。')) + '</p>';
  }
}

async function buildPortableWorkbenchUi() {
  const button = $('#build-portable-workbench');
  const status = $('#portable-workbench-status');
  if (!button || !status) return;
  button.disabled = true;
  status.textContent = '正在复制主工作台、内置运行环境和中文界面，并校验不携带本机私人数据……';
  try {
    const data = await api('/api/portable-workbench/build', { method: 'POST' });
    const build = data.build || {};
    const downloadUrl = build.downloadUrl || '';
    status.innerHTML = '<strong>换机安装包已生成。</strong> 大小 ' + escape(formatBytes(build.archiveBytes)) +
      '，已保存到 <code>' + escape(build.zipPath || '') + '</code>。' +
      (downloadUrl ? ' <a class="document-link" href="' + escape(downloadUrl) + '">下载 ZIP</a>' : '') +
      '<span>在新电脑解压后双击“安装并启动.cmd”；首次使用会自动扫描那台电脑上的会话，并使用那台电脑浏览器重新连接网页聊天。</span>';
    setStatus('Windows 换机安装包已生成。可直接下载或复制 ZIP 到新电脑。');
  } catch (error) {
    status.textContent = friendlyError(error, '换机安装包生成失败，请检查本机磁盘空间后重试。');
    setStatus('换机安装包生成失败，请检查本机磁盘空间后重试。', true);
  } finally {
    button.disabled = false;
  }
}

async function openStoredPackage(packageKey, { view = 'overview', scroll = true } = {}) {
  if (!packageKey) return;
  state.packageView = view;
  setBusy(true);
  setStatus('正在重新读取能力包说明、阶段地图和交付入口……');
  try {
    const response = await fetch('/api/package?packageKey=' + encodeURIComponent(packageKey) + '&includeAnalysis=1');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '能力包读取失败。');
    renderPackage(data);
    if (data.analysis) renderResult(data.analysis, getEvidenceLinks(data.package, data.analysis));
    activatePackageView(view);
    setStatus('已打开能力包：页面上方显示完整说明、P 阶段地图、功能入口和可操作交付物。');
    if (scroll) $('#package-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(friendlyError(error, '能力包读取失败，请刷新列表后重试。'), true);
  } finally {
    setBusy(false);
  }
}

function friendlyError(error, fallback) {
  const message = String(error?.message || '');
  return /^[\u4e00-\u9fff]/.test(message) ? message : fallback;
}

function splitValues(value) {
  return String(value || '').split(/[\r\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function sourceKey(source) {
  if (!source) return '';
  if (source.sourceKey) return String(source.sourceKey);
  if (source.sessionId) return 'session:' + String(source.sessionId).toLowerCase();
  return source.sourcePath ? 'file:' + String(source.sourcePath) : '';
}

function registerSources(sources) {
  for (const source of sources || []) {
    const key = sourceKey(source);
    if (!key) continue;
    const previous = state.sourceByKey.get(key) || {};
    state.sourceByKey.set(key, {
      ...previous,
      ...source,
      sourceKey: key,
      discoveredBy: uniqueValues([...(previous.discoveredBy || []), ...(source.discoveredBy || [])]),
      duplicatePaths: uniqueValues([...(previous.duplicatePaths || []), ...(source.duplicatePaths || [])]),
    });
  }
}

function setSelectionMode(mode) {
  const next = mode === 'workspace' ? 'workspace' : 'sessions';
  if (state.selectionMode === next) {
    const label = $('#session-selection-mode');
    if (label) label.textContent = next === 'workspace' ? '当前：工作区全量选择' : '当前：仅处理所选会话';
    return;
  }
  state.selectionMode = next;
  if (next === 'workspace') {
    // A workspace selection is an explicit all-sessions choice. Do not carry
    // an earlier single-session or web-chat selection into it.
    state.selectedSourceKeys.clear();
    state.excludedWorkspaceSourceKeys.clear();
  } else {
    // An explicit-session selection must never inherit a workspace expansion.
    state.selectedWorkspaceIds.clear();
    state.excludedWorkspaceSourceKeys.clear();
  }
  document.querySelector('.workspace-picker')?.setAttribute('data-selection-mode', next);
  document.querySelector('.session-detail-picker')?.setAttribute('data-selection-mode', next);
  const label = $('#session-selection-mode');
  if (label) label.textContent = next === 'workspace' ? '当前：工作区全量选择' : '当前：仅处理所选会话';
}

function selectedSources() {
  const selected = new Map();
  if (state.selectionMode === 'workspace') {
    for (const source of state.workspaceCatalog?.sources || []) {
      if (state.selectedWorkspaceIds.has(source.workspaceId) && !state.excludedWorkspaceSourceKeys.has(sourceKey(source))) {
        selected.set(sourceKey(source), state.sourceByKey.get(sourceKey(source)) || source);
      }
    }
  }
  for (const key of state.selectedSourceKeys) {
    if (!state.excludedWorkspaceSourceKeys.has(key)) selected.set(key, state.sourceByKey.get(key));
  }
  return [...selected.values()].filter(Boolean);
}

function sourceIsSelected(source) {
  const key = sourceKey(source);
  if (state.excludedWorkspaceSourceKeys.has(key)) return false;
  return state.selectedSourceKeys.has(key) || (state.selectionMode === 'workspace' && state.selectedWorkspaceIds.has(source.workspaceId));
}

function renderWorkspaceCatalog() {
  const root = $('#workspace-catalog');
  const query = activeSearchQuery('local');
  const matchedWorkspaceIds = new Set((state.workspaceCatalog?.sources || []).filter((source) => sourceMatchesSessionSearch(source, 'local')).map((source) => source.workspaceId));
  const workspaces = (state.workspaceCatalog?.workspaces || []).filter((workspace) => !query || matchedWorkspaceIds.has(workspace.workspaceId) || [workspace.name, workspace.rootPath, workspace.latestGoal]
    .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query)));
  root.dataset.visibleWorkspaceIds = JSON.stringify(workspaces.map((item) => item.workspaceId));
  root.innerHTML = workspaces.length ? workspaces.map((workspace) => {
    const checked = state.selectedWorkspaceIds.has(workspace.workspaceId) ? ' checked' : '';
    const unassigned = workspace.workspaceId === 'workspace-unassigned';
    return '<label class="workspace-row' + (unassigned ? ' workspace-unassigned' : '') + '"><input type="checkbox" data-workspace-id="' + escape(workspace.workspaceId) + '"' + checked + ' /><span class="workspace-row-copy"><span class="workspace-row-title"><strong>' + escape(workspace.name) + '</strong><b>' + escape(number(workspace.sessionCount)) + ' 条会话</b></span><span>' + escape(workspace.latestGoal || '尚未提取到最近目标') + '</span>' + (workspace.rootPath ? '<code>' + escape(workspace.rootPath) + '</code>' : '<small>会话未记录可用的工作目录，可作为独立分组处理。</small>') + '</span></label>';
  }).join('') : '<p class="section-note">当前搜索没有匹配的工作区。</p>';
  const selectedWorkspaceCount = state.selectedWorkspaceIds.size;
  const selectedCount = selectedSources().length;
  $('#workspace-selection-count').textContent = number(selectedWorkspaceCount) + ' 个';
  $('#workspace-selection-summary').textContent = selectedWorkspaceCount
    ? '已选择 ' + number(selectedWorkspaceCount) + ' 个工作区，共纳入 ' + number(selectedCount) + ' 条会话；已排除 ' + number(state.excludedWorkspaceSourceKeys.size) + ' 条。'
    : '共识别 ' + number(state.workspaceCatalog?.statistics?.workspaceCount || 0) + ' 个工作区、' + number(state.workspaceCatalog?.statistics?.sessionCount || 0) + ' 条会话；可直接勾选整个工作区。';
}

function formatSessionTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function sourceState(source) {
  return source?.state || { kind: 'ready', label: '已定位', message: '' };
}

function renderSourceCatalog() {
  const root = $('#session-catalog');
  const query = activeSearchQuery('local');
  const visible = state.catalogSources.filter((source) => source.importKind !== 'web-chat' && sourceMatchesSessionSearch(source, 'local'));
  const rendered = visible.slice(0, 250);
  root.dataset.visibleKeys = JSON.stringify(rendered.map(sourceKey));
  if (!rendered.length) {
    root.innerHTML = '<p class="section-note">' + (query ? '当前搜索没有匹配会话。' : '没有发现本机会话，可粘贴编号、选择文件或扫描其他文件夹。') + '</p>';
  } else {
    root.innerHTML = rendered.map((source) => {
      const key = sourceKey(source);
      const checked = sourceIsSelected(source) ? ' checked' : '';
      const sourceLabel = '本机 Codex 会话';
      return '<label class="session-catalog-row"><input type="checkbox" data-source-key="' + escape(key) + '"' + checked + ' /><span class="session-catalog-copy"><strong>' + escape(displayBusinessTitle(source.title)) + '</strong><span>' + escape(sourceLabel) + ' · 最近更新：' + escape(formatSessionTime(source.modifiedAt)) + ' · 完整记录 ' + escape(formatBytes(source.bytes)) + '</span>' + sessionSearchHitMarkup(source, 'local') + '</span></label>';
    }).join('') + (visible.length > rendered.length ? '<p class="catalog-limit-note">当前显示前 250 条；继续输入标题或工作区名称可缩小范围。工作区全选仍包含全部 ' + escape(number(visible.length)) + ' 条。</p>' : '');
  }
  $('#selected-session-summary').textContent = (query ? '全文匹配 ' : '当前显示 ') + number(visible.length) + ' 条本机 Codex 会话，共发现 ' + number(state.catalogSources.length) + ' 条；网页端会话在独立页面中管理。';
}

function issueMarkup(item) {
  const current = item?.state || {};
  return '<article class="source-issue" data-state="' + escape(current.kind || 'invalid') + '"><div><strong>' + escape(current.label || '待处理') + '</strong><span>' + escape(item.inputType || '补充来源') + '</span></div><p>' + escape(item.input || '未提供内容') + '</p>' + (current.message ? '<small>' + escape(current.message) + '</small>' : '') + '</article>';
}

function renderScopeSummary(selection = currentSelection()) {
  const title = $('#scope-summary-title');
  const detail = $('#scope-summary-detail');
  const contextPath = $('#project-context-path');
  const enableButton = $('#enable-project-context');
  const disableButton = $('#disable-project-context');
  const selectedPath = $('#project-path')?.value.trim() || '';
  if (selection.projectConfirmed) {
    const isWorkspace = selection.contextMode === 'workspace-relevant';
    if (contextPath) contextPath.textContent = isWorkspace
      ? '已按所选工作区读取相关项目文件；不会把无关文件夹混入本次会话。'
      : '已选择：' + selectedPath + '。系统只读取与会话、Git 变更、规则和任务关键词相关的文件。';
    if (enableButton) enableButton.textContent = isWorkspace ? '更换为单个项目' : '更换项目文件夹';
    if (disableButton) disableButton.hidden = isWorkspace;
  } else {
    if (contextPath) contextPath.textContent = '当前只使用所选会话。不会扫描电脑中的其他项目或文件夹。';
    if (enableButton) enableButton.textContent = '选择项目文件夹';
    if (disableButton) disableButton.hidden = true;
  }
  if (!title || !detail) return;
  if (selection.projectConfirmed) {
    const workspace = selection.contextMode === 'workspace-relevant';
    title.textContent = workspace ? '分析范围：已确认工作区，智能筛选相关项目文件' : '分析范围：已确认项目，智能筛选相关项目文件';
    detail.textContent = workspace
      ? '会话仍是主要依据；系统只读取与所选会话、Git 变更、项目规则和任务关键词相关的文件。'
      : '会话仍是主要依据；系统只读取与所选会话、Git 变更、项目规则和任务关键词相关的文件。';
    return;
  }
  title.textContent = '分析范围：仅分析已选会话';
  detail.textContent = '当前不会读取项目文件、Git、项目知识或同目录下的其他内容；如需项目理解，请在高级设置中选择项目文件夹。';
}

function projectPreviewItemMarkup(item, emptyText) {
  if (!item?.path) return '<li class="project-preview-empty">' + escape(emptyText) + '</li>';
  const reasons = Array.isArray(item.reasons) && item.reasons.length
    ? '<span>' + escape(item.reasons.join('、')) + '</span>'
    : '';
  return '<li><code>' + escape(item.path) + '</code>' + reasons + '</li>';
}

function renderProjectContextPreview(preview) {
  const panel = $('#project-context-preview');
  const status = $('#project-context-preview-status');
  const summary = $('#project-context-preview-summary');
  const selectedList = $('#project-context-preview-selected');
  const excludedList = $('#project-context-preview-excluded');
  if (!panel || !status || !summary || !selectedList || !excludedList) return;

  if (!preview?.enabled) {
    panel.hidden = true;
    status.textContent = '等待检查';
    summary.textContent = '选择项目后，系统会先列出相关文件和排除项。';
    selectedList.innerHTML = '';
    excludedList.innerHTML = '';
    return;
  }

  panel.hidden = false;
  if (preview.loading) {
    status.textContent = '正在检查';
    summary.textContent = '正在从会话、Git 变更、项目规则和任务关键词中筛选相关文件。';
    selectedList.innerHTML = '<li class="project-preview-empty">正在生成清单...</li>';
    excludedList.innerHTML = '<li class="project-preview-empty">正在计算排除项...</li>';
    return;
  }

  if (preview.error) {
    status.textContent = '检查失败';
    summary.textContent = preview.error;
    selectedList.innerHTML = '<li class="project-preview-empty">暂未取得纳入清单。</li>';
    excludedList.innerHTML = '<li class="project-preview-empty">请调整项目文件夹后重试。</li>';
    return;
  }

  const scan = preview.scan || {};
  const selected = scan.relevantFilesSelected || [];
  const excluded = scan.relevantFilesExcluded || [];
  const project = preview.projectDiscovery?.primaryProject || preview.projectDiscovery?.projects?.[0] || {};
  const projectName = project.name || project.root || '所选项目';
  const selectedCount = number(selected.length);
  const excludedCount = number(excluded.length);
  const total = number(scan.discoveredFiles || scan.filesScanned || 0);
  status.textContent = '已检查';
  summary.textContent = projectName + '：已在发现的 ' + total + ' 个项目文件中，优先纳入 ' + selectedCount + ' 个与会话直接相关、Git 变更、项目规则或任务关键词匹配的文件；以下同时展示 ' + excludedCount + ' 个不纳入本次蒸馏的文件样例。';
  selectedList.innerHTML = selected.length
    ? selected.map((item) => projectPreviewItemMarkup(item, '')).join('')
    : '<li class="project-preview-empty">未发现可直接纳入的项目文件；本次会继续以会话证据为主。</li>';
  excludedList.innerHTML = excluded.length
    ? excluded.map((item) => projectPreviewItemMarkup(item, '')).join('')
    : '<li class="project-preview-empty">没有需要额外排除的已发现文件。</li>';
}

async function previewProjectContext(selection) {
  if (!selection?.projectConfirmed) {
    renderProjectContextPreview(null);
    return selection;
  }
  const key = selectionKey(selection);
  if (state.contextPreviewKey === key && state.contextPreview) {
    renderProjectContextPreview(state.contextPreview);
    return selection;
  }
  renderProjectContextPreview({ enabled: true, loading: true });
  const response = await fetch('/api/v2/project-context/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(selection),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error || '项目相关文件预检失败。';
    state.contextPreviewKey = '';
    state.contextPreview = { enabled: true, error };
    renderProjectContextPreview(state.contextPreview);
    throw new Error(error);
  }
  state.contextPreviewKey = key;
  state.contextPreview = payload;
  renderProjectContextPreview(payload);
  return selection;
}

function renderSourceSelection() {
  renderScopeSummary();
  const sources = selectedSources();
  const issues = [...state.idResolutionResults, ...state.fileResolutionResults].filter((item) => !item.source);
  const duplicateCount = sources.filter((source) => source.duplicatePaths?.length).length;
  const liveCount = sources.filter((source) => source.live).length;
  $('#source-selection-count').textContent = number(sources.length) + ' 条';
  $('#source-selection-summary').textContent = sources.length
    ? '已定位 ' + number(sources.length) + ' 条唯一会话' + (duplicateCount ? '，合并 ' + number(duplicateCount) + ' 组重复来源' : '') + (liveCount ? '，' + number(liveCount) + ' 条读取时仍在变化' : '') + (issues.length ? '；另有 ' + number(issues.length) + ' 项需要处理' : '') + '。'
    : issues.length ? '当前没有可用会话，以下补充来源需要处理。' : '从上方勾选会话、粘贴编号或选择文件后，会在这里显示完整来源。';
  const displayedSources = sources.slice(0, 60);
  const sourceMarkup = displayedSources.map((source) => {
    const current = sourceState(source);
    const duplicate = source.duplicatePaths?.length ? '<p class="source-duplicates">系统已自动合并重复来源，不会重复蒸馏。</p>' : '';
    return '<article class="selected-source" data-state="' + escape(current.kind) + '"><div class="selected-source-heading"><div><strong>' + escape(displayBusinessTitle(source.title)) + '</strong><span class="source-status">' + escape(current.label) + '</span></div><button type="button" class="remove-source" data-remove-source="' + escape(sourceKey(source)) + '" aria-label="移除这条会话">移除</button></div><p class="source-reason">最近更新：' + escape(formatSessionTime(source.modifiedAt)) + ' · 系统将读取完整工作过程</p>' + duplicate + (current.message ? '<p class="source-warning">' + escape(current.message) + '</p>' : '') + '</article>';
  }).join('');
  const remainder = sources.length > displayedSources.length ? '<p class="catalog-limit-note">已完整选择 ' + escape(number(sources.length)) + ' 条会话，此处只预览前 60 条；蒸馏任务会处理完整范围。</p>' : '';
  $('#source-selection-list').innerHTML = sourceMarkup + remainder + issues.map(issueMarkup).join('') || '<p class="section-note">尚未选择会话。</p>';
  renderActionAvailability();
  renderWorkbenchNavigation();
}

function renderPickedSessionFiles() {
  const paths = state.pickedSourcePaths;
  $('#selected-session-files').textContent = paths.length
    ? '已选择并解析 ' + number(paths.length) + ' 个文件：' + paths.map((item) => String(item).split(/[\\/]/).pop()).join('；')
    : '未选择补充会话文件';
}

async function loadSessions({ force = false, roots = [], quiet = false } = {}) {
  $('#connection').dataset.state = 'checking';
  $('#connection').textContent = roots.length ? '正在扫描所选文件夹……' : '正在读取全部本机会话标题……';
  if (!quiet) setStatus(roots.length ? '正在扫描所选会话文件夹，并提取标题、编号与文件状态……' : '正在自动发现本机会话，并建立可搜索的来源索引……');
  try {
    const workspaceUrl = new URL('/api/v2/workspaces', window.location.origin);
    roots.forEach((root) => workspaceUrl.searchParams.append('root', root));
    if (force) workspaceUrl.searchParams.set('refresh', '1');
    const [workspaceResponse, importResponse] = await Promise.all([
      fetch(workspaceUrl),
      fetch('/api/session-sources?limit=5000' + (force ? '&refresh=1' : '')),
    ]);
    const workspaceData = await workspaceResponse.json();
    const importData = await importResponse.json();
    if (!workspaceResponse.ok) throw new Error(workspaceData.error || '工作区会话读取失败。');
    if (!importResponse.ok) throw new Error(importData.error || '网页端会话读取失败。');
    state.workspaceCatalog = workspaceData.catalog;
    const importedWebChats = (importData.webChatSources || importData.sources || []).filter((source) => source.importKind === 'web-chat');
    state.webChat.importedSources = importedWebChats;
    const incoming = [...(state.workspaceCatalog?.sources || [])];
    registerSources([...incoming, ...importedWebChats]);
    const catalog = roots.length ? [...state.catalogSources, ...incoming] : incoming;
    const catalogMap = new Map(catalog.map((source) => [sourceKey(source), state.sourceByKey.get(sourceKey(source)) || source]));
    state.catalogSources = [...catalogMap.values()].sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));
    for (const scope of ['local', 'web']) {
      state.sessionSearch[scope].status = 'idle';
      state.sessionSearch[scope].matches = new Map();
      state.sessionSearch[scope].stats = null;
    }
    const validWorkspaceIds = new Set((state.workspaceCatalog?.workspaces || []).map((item) => item.workspaceId));
    state.selectedWorkspaceIds = new Set([...state.selectedWorkspaceIds].filter((id) => validWorkspaceIds.has(id)));
    renderWorkspaceCatalog();
    renderWebChatImportedSources();
    renderSourceCatalog();
    renderSourceSelection();
    $('#connection').dataset.state = 'ok';
    $('#connection').textContent = '已发现 ' + number(state.catalogSources.length) + ' 条本机 Codex 会话';
    const currentQuery = activeSearchQuery(state.activeWorkbenchView);
    if (currentQuery && ['local', 'web'].includes(state.activeWorkbenchView)) scheduleSessionContentSearch(state.activeWorkbenchView, currentQuery);
    if (!quiet) setStatus('工作区索引完成：识别 ' + number(state.workspaceCatalog?.statistics?.workspaceCount || 0) + ' 个工作区、' + number(state.workspaceCatalog?.statistics?.sessionCount || 0) + ' 条本机 Codex 会话；网页端另列显示。');
  } catch (error) {
    $('#connection').dataset.state = 'error';
    $('#connection').textContent = '接口未连接';
    if (!quiet) setStatus(friendlyError(error, '本机会话读取失败，请检查本地服务。'), true);
  }
}

async function chooseLocalPaths(kind) {
  const response = await fetch('/api/path-picker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '无法打开本机文件选择窗口。');
  return uniqueValues(payload.paths || []);
}

async function chooseSessionFiles() {
  const button = $('#pick-session-files');
  button.disabled = true;
  setStatus('正在打开本机文件选择窗口……');
  try {
    const paths = await chooseLocalPaths('sessionFiles');
    if (!paths.length) return setStatus('没有选择补充会话文件；可继续使用本机 Codex 会话列表。');
    state.pickedSourcePaths = uniqueValues([...state.pickedSourcePaths, ...paths]);
    renderPickedSessionFiles();
    await resolveSourceInputs({ sourcePaths: paths }, 'file');
    setStatus('已选择并定位 ' + number(paths.length) + ' 个会话文件；结果已加入待处理清单。');
  } catch (error) {
    setStatus(friendlyError(error, '无法打开本机文件选择窗口。'), true);
  } finally {
    button.disabled = false;
  }
}

async function chooseSessionDirectory() {
  const button = $('#pick-session-directory');
  button.disabled = true;
  setStatus('正在打开会话文件夹选择窗口……');
  try {
    const roots = await chooseLocalPaths('sessionDirectory');
    if (!roots.length) return setStatus('没有选择会话文件夹，现有来源保持不变。');
    await loadSessions({ force: true, roots });
  } catch (error) {
    setStatus(friendlyError(error, '无法扫描所选会话文件夹。'), true);
  } finally {
    button.disabled = false;
  }
}

async function resolveSourceInputs(body, resultType) {
  const response = await fetch('/api/session-sources/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '会话来源定位失败。');
  setSelectionMode('sessions');
  registerSources(payload.selectedSources || []);
  for (const source of payload.selectedSources || []) state.selectedSourceKeys.add(sourceKey(source));
  invalidateDistillation();
  if (resultType === 'id') state.idResolutionResults = payload.results || [];
  if (resultType === 'file') state.fileResolutionResults = payload.results || [];
  renderSourceCatalog();
  renderSourceSelection();
  const summary = payload.summary || {};
  return { payload, summary };
}

async function resolveThreadIds({ automatic = false } = {}) {
  const button = $('#resolve-thread-ids');
  const threadIds = splitValues($('#thread-id').value);
  if (!threadIds.length) {
    state.idResolutionResults = [];
    renderSourceSelection();
    if (!automatic) setStatus('没有需要定位的补充会话编号。');
    return;
  }
  button.disabled = true;
  if (!automatic) setStatus('正在批量定位 ' + number(threadIds.length) + ' 个会话编号对应的本机文件……');
  try {
    const { summary } = await resolveSourceInputs({ threadIds }, 'id');
    setStatus('编号定位完成：找到 ' + number(summary.resolved) + ' 条唯一会话' + (summary.errors ? '，' + number(summary.errors) + ' 项需要处理' : '') + '。', Boolean(summary.errors && !summary.resolved));
  } catch (error) {
    setStatus(friendlyError(error, '会话编号定位失败，请重新扫描后重试。'), true);
  } finally {
    button.disabled = false;
  }
}

async function chooseProjectPath() {
  const button = $('#pick-project-path');
  button.disabled = true;
  setStatus('正在打开本机项目文件夹选择窗口……');
  try {
    const paths = await chooseLocalPaths('directory');
    if (!paths.length) return setStatus('没有指定项目文件夹，将在解析时自动发现关联项目。');
    $('#project-path').value = paths[0];
    invalidateDistillation();
    renderSourceSelection();
    setStatus('已选择项目文件夹：' + paths[0]);
  } catch (error) {
    setStatus(friendlyError(error, '无法打开本机项目文件夹选择窗口。'), true);
  } finally {
    button.disabled = false;
  }
}

function clearProjectContext() {
  $('#project-path').value = '';
  invalidateDistillation();
  renderSourceSelection();
  setStatus('已切换为仅分析会话。本次不会读取项目文件、Git 或项目知识。');
}

function currentSelection() {
  const sources = selectedSources();
  const explicitSources = [...state.selectedSourceKeys].map((key) => state.sourceByKey.get(key)).filter(Boolean);
  const sourcePaths = uniqueValues(explicitSources.map((source) => source.sourcePath));
  const projectPath = $('#project-path').value.trim();
  const selectionMode = state.selectionMode === 'workspace' ? 'workspace' : 'sessions';
  const projectConfirmed = Boolean(projectPath) || (selectionMode === 'workspace' && state.selectedWorkspaceIds.size > 0);
  const contextMode = projectConfirmed
    ? (selectionMode === 'workspace' ? 'workspace-relevant' : 'project-relevant')
    : 'conversation-only';
  return {
    sourceKeys: explicitSources.map(sourceKey),
    threadId: '',
    sourcePath: sourcePaths[0] || '',
    threadIds: [],
    sourcePaths,
    projectPath,
    selectionMode,
    projectScope: selectionMode === 'workspace' ? 'workspace' : (projectPath ? 'project' : 'sessions-only'),
    contextMode,
    projectConfirmed,
    projectContext: {
      enabled: projectConfirmed,
      confirmed: projectConfirmed,
      mode: contextMode,
      relevancePolicy: projectConfirmed ? 'evidence-ranked' : 'disabled',
    },
    selectedSessionCount: sources.length,
    workspaceSelection: {
      catalogRevision: state.workspaceCatalog?.revision || null,
      selectionMode,
      workspaceIds: selectionMode === 'workspace' ? [...state.selectedWorkspaceIds] : [],
      includedSourceKeys: selectionMode === 'sessions' ? [...state.selectedSourceKeys] : [],
      excludedSourceKeys: selectionMode === 'workspace' ? [...state.excludedWorkspaceSourceKeys] : [],
    },
  };
}

async function preflightSelection() {
  const selection = currentSelection();
  if (!selection.selectedSessionCount) throw new Error('请先选择至少一个工作区或一条会话。');
  if (selection.workspaceSelection.workspaceIds.length) {
    const response = await fetch('/api/v2/workspace-selection/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selection.workspaceSelection),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '工作区选择预检失败。');
    if (!payload.selection?.sessionCount) throw new Error('所选工作区当前没有可用会话。');
    const catalogKeys = new Set((state.workspaceCatalog?.sources || []).map(sourceKey));
    const externalSourceCount = selection.sourceKeys.filter((key) => !catalogKeys.has(key)).length;
    selection.selectedSessionCount = payload.selection.sessionCount + externalSourceCount;
  }
  if (!selection.sourcePaths.length) {
    await previewProjectContext(selection);
    return selection;
  }
  const response = await fetch('/api/session-sources/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourcePaths: selection.sourcePaths }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '会话来源预检失败。');
  if (!payload.ready || !payload.sourcePaths?.length) throw new Error('预检后没有可用会话，请处理来源清单中的错误。');
  registerSources(payload.selectedSources || []);
  const readyKeys = new Set((payload.selectedSources || []).map(sourceKey));
  for (const key of selection.sourceKeys) {
    if (!readyKeys.has(key)) state.selectedSourceKeys.delete(key);
  }
  for (const key of readyKeys) state.selectedSourceKeys.add(key);
  state.fileResolutionResults = (payload.results || []).filter((item) => !item.source);
  renderSourceCatalog();
  renderSourceSelection();
  const readySelection = {
    ...selection,
    threadId: '',
    threadIds: [],
    sourcePath: payload.sourcePaths[0],
    sourcePaths: payload.sourcePaths,
  };
  await previewProjectContext(readySelection);
  return readySelection;
}

function selectedTargets() {
  return [
    ['skill', '#target-skill'],
    ['mcp', '#target-mcp'],
    ['agent', '#target-agent'],
  ].filter(([, selector]) => $(selector).checked).map(([target]) => target);
}

function setBusy(busy) {
  state.busy = busy;
  $('#refresh').disabled = busy;
  setWebChatBusy(busy);
  ['#resolve-thread-ids', '#scan-default-sessions', '#pick-session-files', '#pick-session-directory', '#select-all-sessions', '#clear-selected-sessions', '#select-visible-workspaces', '#clear-selected-workspaces', '#enable-project-context', '#disable-project-context'].forEach((selector) => {
    const node = $(selector);
    if (node) node.disabled = busy;
  });
  renderActionAvailability();
}

function renderActionAvailability() {
  const hasSelection = selectedSources().length > 0;
  const disabled = Boolean(state.busy) || !hasSelection;
  ['#analyze', '#package'].forEach((selector) => {
    const button = $(selector);
    if (!button) return;
    button.disabled = disabled;
    button.title = hasSelection ? '' : '先选择至少一条会话';
  });
  const hint = $('#primary-action-hint');
  if (!hint) return;
  hint.textContent = state.busy
    ? '系统正在处理，请稍候；完成后会自动回到可操作状态。'
    : hasSelection
      ? '已准备好。先看智能蒸馏建议，确认后再生成能力包。'
      : '先选择至少一条会话，系统会自动启用下一步。';
  hint.dataset.ready = hasSelection ? 'true' : 'false';
}

function fillPackageDefaults(sessionId) {
  // 包名称和标识必须等完整会话分析完成后再决定，不能用会话编号占位。
  if (String(sessionId || '').trim()) {
    $('#package-id').dataset.auto = 'true';
    $('#package-name').dataset.auto = 'true';
  }
}

function openPackageLoadingWindow() {
  if (document.body.dataset.pageMode === 'package') return null;
  const child = window.open('', '_blank');
  if (!child) return null;
  child.document.title = '正在生成能力包';
  child.document.body.style.cssText = 'margin:0;background:#f4f7f6;color:#172520;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center';
  child.document.body.innerHTML = '<main style="width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #cbd8d3;background:white"><strong style="font-size:24px">正在生成能力包</strong><p style="line-height:1.8;color:#586b64">系统正在理解会话、项目、文件和产物。完成后，这里会自动打开独立能力包子页面。</p></main>';
  return child;
}

async function createPackage() {
  const initialSelection = currentSelection();
  const targets = selectedTargets();
  if (!initialSelection.selectedSessionCount) {
    setStatus('请先选择至少一个工作区或一条会话。', true);
    return;
  }
  if (!targets.length) {
    setStatus('请至少选择一种交付物。', true);
    return;
  }
  const childWindow = openPackageLoadingWindow();
  setBusy(true);
  setStatus('正在确认所选工作，并准备专属蒸馏建议……');
  try {
    const selection = await preflightSelection();
    const key = selectionKey(selection);
    if (!state.run?.runId || state.runSelectionKey !== key) {
      setStatus('正在读取完整会话，自动理解项目、文件、Git、产物和验证记录……');
      const runResponse = await fetch('/api/v2/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, includeEvidence: $('#include-evidence').checked, redact: $('#redact').checked }) });
      const runData = await runResponse.json();
      if (!runResponse.ok) throw new Error(runData.error || '智能蒸馏失败。');
      state.runSelectionKey = key;
      renderRecommendation(runData.run);
      if (runData.analysis) renderResult(runData.analysis);
    }
    setStatus('建议已确定，正在生成专属技能、服务接口、独立 Agent、中文 UI 和完整说明……');
    const response = await fetch('/api/v2/runs/' + encodeURIComponent(state.run.runId) + '/package', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packageId: $('#package-id').value.trim(),
        packageName: $('#package-name').value.trim(),
        targets,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '能力包生成失败。');
    if (!data.package) throw new Error('接口没有返回能力包信息。');
    if (data.analysis) renderResult(data.analysis, getEvidenceLinks(data.package, data.analysis));
    await loadPackageLibrary();
    const packageKey = data.packageKey || data.package?.packageKey || packageArtifactInfo(data.package?.links?.manifest || '').packageKey || data.package?.id;
    const childUrl = packagePageUrl(packageKey, 'overview');
    if (childWindow && !childWindow.closed) childWindow.location.href = childUrl;
    const sourceCount = data.package?.selection?.sessionCount || data.package?.selection?.sessions?.length || selection.threadIds.length || selection.sourcePaths.length;
    if (data.run) renderRecommendation(data.run);
    setWorkbenchView('results', { focus: false });
    setStatus('能力包已生成：联合理解 ' + number(sourceCount) + ' 条会话，生成 ' + number(targets.length) + ' 类交付物和 ' + number(data.verification?.artifactCount) + ' 个已校验文件。独立能力包子页面已打开；也可从“已生成的能力包”再次进入。' + (childWindow ? '' : ' 浏览器拦截了新页面，请点击能力包列表中的“打开能力包子页面”。'));
  } catch (error) {
    if (childWindow && !childWindow.closed) {
      childWindow.document.body.innerHTML = '<main style="width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #e2c7c3;background:white"><strong style="font-size:24px">能力包未生成</strong><p style="line-height:1.8;color:#7a3d35">请返回主工作台查看错误提示，修正后可以再次生成。</p><p><a href="/" style="color:#087f70">返回主工作台</a></p></main>';
    }
    setStatus(friendlyError(error, '能力包生成失败，请检查会话选择、包标识和本地服务。'), true);
  } finally {
    setBusy(false);
  }
}

async function analyze() {
  const initialSelection = currentSelection();
  if (!initialSelection.selectedSessionCount) {
    setStatus('请先选择至少一个工作区或一条会话。', true);
    return;
  }
  setBusy(true);
  setStatus('正在确认所选工作并合并重复来源……');
  try {
    const selection = await preflightSelection();
    setStatus('正在读取完整会话，并主动查找关联项目、原始文件、修改、Git 差异、产物与验证记录……');
    const response = await fetch('/api/v2/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selection, includeEvidence: $('#include-evidence').checked, redact: $('#redact').checked }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '智能蒸馏失败。');
    state.runSelectionKey = selectionKey(selection);
    renderRecommendation(data.run);
    if (data.analysis) renderResult(data.analysis);
    const summary = data.run?.recommendation?.summary || {};
    setStatus('智能蒸馏完成：' + (summary.headline || '已形成专属建议。') + ' 你可以调整重点，或按推荐一键生成能力包。');
    setWorkbenchView('results', { focus: false });
    $('#recommendation-center').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(friendlyError(error, '智能蒸馏失败，请重新选择会话后重试。'), true);
  } finally {
    setBusy(false);
  }
}

const workbenchNavigation = $('.workbench-navigation');
workbenchNavigation.addEventListener('click', (event) => {
  const button = event.target.closest('[data-workbench-nav]');
  if (!button) return;
  setWorkbenchView(button.dataset.workbenchNav, { focus: true });
  if (button.dataset.workbenchNav === 'web') {
    void loadWebChatStatus({ quiet: true });
    void loadChatGPTCoverage({ quiet: true });
  }
});
workbenchNavigation.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...workbenchNavigation.querySelectorAll('[data-workbench-nav]')];
  const current = Math.max(0, buttons.indexOf(document.activeElement));
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
  buttons[next].click();
});
$('#results-back-to-source').addEventListener('click', () => setWorkbenchView('local', { focus: true }));
$('#result-overview-primary').addEventListener('click', () => {
  const action = $('#result-overview-primary').dataset.resultOverviewAction;
  if (action === 'package') {
    $('#package-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'recommendation') {
    $('#recommendation-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'library') {
    $('#package-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => $('#package-library-search')?.focus(), 260);
    return;
  }
  setWorkbenchView('local', { focus: true });
});
const workbenchToolsDialog = $('#workbench-tools-dialog');
$('#open-workbench-tools').addEventListener('click', () => {
  if (typeof workbenchToolsDialog.showModal === 'function') workbenchToolsDialog.showModal();
  else workbenchToolsDialog.setAttribute('open', '');
});
$('#close-workbench-tools').addEventListener('click', () => workbenchToolsDialog.close());
workbenchToolsDialog.addEventListener('click', (event) => {
  if (event.target === workbenchToolsDialog) workbenchToolsDialog.close();
});

$('#session-catalog').addEventListener('change', (event) => {
  const input = event.target.closest('[data-source-key]');
  if (!input) return;
  setSelectionMode('sessions');
  if (input.checked) {
    state.selectedSourceKeys.add(input.dataset.sourceKey);
    state.excludedWorkspaceSourceKeys.delete(input.dataset.sourceKey);
  } else {
    state.selectedSourceKeys.delete(input.dataset.sourceKey);
    const source = state.sourceByKey.get(input.dataset.sourceKey);
    if (source && state.selectedWorkspaceIds.has(source.workspaceId)) state.excludedWorkspaceSourceKeys.add(input.dataset.sourceKey);
  }
  invalidateDistillation();
  const first = selectedSources()[0];
  if (first) fillPackageDefaults(first.sessionId);
  renderSourceSelection();
});
$('#source-selection-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-source]');
  if (!button) return;
  const source = state.sourceByKey.get(button.dataset.removeSource);
  state.selectedSourceKeys.delete(button.dataset.removeSource);
  if (source && state.selectedWorkspaceIds.has(source.workspaceId)) state.excludedWorkspaceSourceKeys.add(button.dataset.removeSource);
  invalidateDistillation();
  if (source?.sourcePath) {
    state.pickedSourcePaths = state.pickedSourcePaths.filter((item) => item !== source.sourcePath);
    renderPickedSessionFiles();
  }
  renderSourceCatalog();
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#web-chat-imported-list').addEventListener('change', (event) => {
  const input = event.target.closest('[data-web-source-key]');
  if (!input) return;
  setSelectionMode('sessions');
  if (input.checked) state.selectedSourceKeys.add(input.dataset.webSourceKey);
  else state.selectedSourceKeys.delete(input.dataset.webSourceKey);
  invalidateDistillation();
  const first = selectedSources()[0];
  if (first) fillPackageDefaults(first.sessionId);
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#web-chat-imported-list').addEventListener('click', (event) => {
  if (event.target.closest('a')) event.stopPropagation();
});
$('#workspace-catalog').addEventListener('change', (event) => {
  const input = event.target.closest('[data-workspace-id]');
  if (!input) return;
  setSelectionMode('workspace');
  if (input.checked) {
    state.selectedWorkspaceIds.add(input.dataset.workspaceId);
    for (const source of state.workspaceCatalog?.sources || []) {
      if (source.workspaceId === input.dataset.workspaceId) state.excludedWorkspaceSourceKeys.delete(sourceKey(source));
    }
  } else {
    state.selectedWorkspaceIds.delete(input.dataset.workspaceId);
  }
  invalidateDistillation();
  renderWorkspaceCatalog();
  renderSourceCatalog();
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#session-search').addEventListener('input', (event) => {
  const scope = state.activeWorkbenchView;
  if (!['local', 'web'].includes(scope)) return;
  const query = String(event.target.value || '').trim();
  state.workbenchSearchTerms[scope] = event.target.value;
  state.sessionSearch[scope].status = query ? 'pending' : 'idle';
  state.sessionSearch[scope].query = query.toLocaleLowerCase('zh-CN');
  state.sessionSearch[scope].matches = new Map();
  state.sessionSearch[scope].stats = null;
  renderSessionSearchResults(scope);
  scheduleSessionContentSearch(scope, query);
});
$('#session-search-kind').addEventListener('change', (event) => {
  const scope = state.activeWorkbenchView;
  if (!['local', 'web'].includes(scope)) return;
  state.sessionSearch[scope].kindFilter = event.target.value || 'all';
  renderSessionSearchPanel(scope);
});
$('#session-search-results').addEventListener('click', (event) => {
  const button = event.target.closest('[data-session-search-source]');
  if (!button) return;
  const key = button.dataset.sessionSearchSource || '';
  const target = [...document.querySelectorAll('[data-source-key], [data-web-source-key]')].find((node) => node.dataset.sourceKey === key || node.dataset.webSourceKey === key);
  if (!target) {
    setStatus('当前命中会话不在列表首屏，请继续缩小关键词范围。', true);
    return;
  }
  const row = target.closest('label') || target;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('session-search-target');
  window.setTimeout(() => row.classList.remove('session-search-target'), 1800);
});
$('#clear-session-search').addEventListener('click', () => {
  const search = $('#session-search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.focus();
});
$('#web-chat-platforms').addEventListener('click', (event) => {
  const button = event.target.closest('[data-web-chat-platform]');
  if (button) openWebChatPlatform(button.dataset.webChatPlatform);
});
$('#web-chat-capture').addEventListener('click', () => runWebChatJob('capture'));
$('#web-chat-history').addEventListener('click', () => runWebChatJob('history-index'));
$('#web-chat-setup').addEventListener('click', () => {
  state.webChat.setupPanelOpen = true;
  renderWebChatSetup(state.webChat.connection);
  void setupWebChatCompanion();
});
$('#web-chat-setup-start').addEventListener('click', setupWebChatCompanion);
$('#web-chat-copy-setup').addEventListener('click', copyWebChatSetup);
$('#chatgpt-import-trigger').addEventListener('click', () => $('#chatgpt-export-file').click());
$('#chatgpt-export-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  void importChatGPTExportFile(file);
  event.target.value = '';
});
$('#chatgpt-refresh-coverage').addEventListener('click', () => void loadChatGPTCoverage({ quiet: false }));
$('#chatgpt-capture-all').addEventListener('click', () => void captureAllChatGPTConversations());
$('#chatgpt-force-capture-all').addEventListener('click', () => void captureAllChatGPTConversations(true));
$('#chatgpt-sync-pause').addEventListener('click', () => void controlChatGPTSync('pause'));
$('#chatgpt-sync-resume').addEventListener('click', () => void controlChatGPTSync('resume'));
$('#chatgpt-sync-cancel').addEventListener('click', () => void controlChatGPTSync('cancel'));
$('#chatgpt-sync-retry-failed').addEventListener('click', () => void retryFailedChatGPTSync());
$('#select-all-sessions').addEventListener('click', () => {
  setSelectionMode('sessions');
  const keys = JSON.parse($('#session-catalog').dataset.visibleKeys || '[]');
  keys.forEach((key) => { state.selectedSourceKeys.add(key); state.excludedWorkspaceSourceKeys.delete(key); });
  invalidateDistillation();
  renderSourceCatalog();
  renderSourceSelection();
});
$('#select-visible-web-sessions').addEventListener('click', () => {
  setSelectionMode('sessions');
  const keys = JSON.parse($('#web-chat-imported-list').dataset.visibleKeys || '[]');
  keys.forEach((key) => state.selectedSourceKeys.add(key));
  invalidateDistillation();
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#clear-web-session-selection').addEventListener('click', () => {
  for (const source of state.webChat.importedSources || []) state.selectedSourceKeys.delete(sourceKey(source));
  invalidateDistillation();
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#clear-selected-sessions').addEventListener('click', () => {
  state.selectedSourceKeys.clear();
  if (state.selectionMode === 'sessions') state.excludedWorkspaceSourceKeys.clear();
  invalidateDistillation();
  renderSourceCatalog();
  renderWebChatImportedSources();
  renderSourceSelection();
});
$('#select-visible-workspaces').addEventListener('click', () => {
  setSelectionMode('workspace');
  const ids = JSON.parse($('#workspace-catalog').dataset.visibleWorkspaceIds || '[]');
  const visibleIds = new Set(ids);
  ids.forEach((id) => state.selectedWorkspaceIds.add(id));
  for (const source of state.workspaceCatalog?.sources || []) {
    if (visibleIds.has(source.workspaceId)) state.excludedWorkspaceSourceKeys.delete(sourceKey(source));
  }
  invalidateDistillation();
  renderWorkspaceCatalog();
  renderSourceCatalog();
  renderSourceSelection();
});
$('#clear-selected-workspaces').addEventListener('click', () => {
  state.selectedWorkspaceIds.clear();
  state.excludedWorkspaceSourceKeys.clear();
  invalidateDistillation();
  renderWorkspaceCatalog();
  renderSourceCatalog();
  renderSourceSelection();
});
let idResolveTimer;
$('#thread-id').addEventListener('input', () => {
  clearTimeout(idResolveTimer);
  const values = splitValues($('#thread-id').value);
  if (!values.length) {
    state.idResolutionResults = [];
    renderSourceSelection();
    return;
  }
  if (values.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
    idResolveTimer = setTimeout(() => resolveThreadIds({ automatic: true }), 650);
  }
});
$('#refresh').addEventListener('click', () => {
  if (state.activeWorkbenchView === 'web') {
    void loadWebChatStatus({ quiet: false });
    void loadChatGPTCoverage({ quiet: false });
    return;
  }
  void loadSessions({ force: true });
});
$('#scan-default-sessions').addEventListener('click', () => loadSessions({ force: true }));
$('#resolve-thread-ids').addEventListener('click', () => resolveThreadIds());
$('#clear-thread-ids').addEventListener('click', () => {
  $('#thread-id').value = '';
  state.idResolutionResults = [];
  renderSourceSelection();
  setStatus('补充会话编号已清空，已定位并勾选的会话仍保留。');
});
$('#pick-session-files').addEventListener('click', chooseSessionFiles);
$('#pick-session-directory').addEventListener('click', chooseSessionDirectory);
$('#pick-project-path').addEventListener('click', chooseProjectPath);
$('#enable-project-context').addEventListener('click', chooseProjectPath);
$('#disable-project-context').addEventListener('click', clearProjectContext);
$('#refresh-packages').addEventListener('click', loadPackageLibrary);
$('#package-library-search').addEventListener('input', () => renderPackageLibrary(state.packageLibrary));
['#package-library-target', '#package-library-time', '#package-library-sort'].forEach((selector) => {
  $(selector).addEventListener('change', () => renderPackageLibrary(state.packageLibrary));
});
$('#clear-package-filters').addEventListener('click', () => {
  $('#package-library-search').value = '';
  $('#package-library-target').value = 'all';
  $('#package-library-time').value = 'all';
  $('#package-library-sort').value = 'latest';
  renderPackageLibrary(state.packageLibrary);
  $('#package-library-search').focus();
});
$('#recent-packages').addEventListener('click', (event) => {
  const button = event.target.closest('[data-package-details-toggle]');
  if (!button) return;
  const details = document.getElementById(button.dataset.packageDetailsToggle);
  if (!details) return;
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  button.textContent = expanded ? '展开完整信息' : '收起完整信息';
  details.hidden = expanded;
});
$('#build-portable-workbench').addEventListener('click', buildPortableWorkbenchUi);
$('#package').addEventListener('click', createPackage);
$('#analyze').addEventListener('click', analyze);
$('#recommendation-package').addEventListener('click', createPackage);
$('#priority-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-priority-action]');
  if (button) updatePriority(button.dataset.priorityId, button.dataset.priorityAction);
});
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderTab(); }));
const initialUrl = new URL(window.location.href);
const initialPackageKey = initialUrl.searchParams.get('package');
const initialReaderLink = initialUrl.searchParams.get('reader');
const initialWorkbenchSection = initialUrl.searchParams.get('section');
window.addEventListener('popstate', () => {
  const section = new URL(window.location.href).searchParams.get('section');
  setWorkbenchView(WORKBENCH_VIEWS[section] ? section : 'local', { updateUrl: false, focus: true });
});
if (initialReaderLink) {
  openStandaloneReader(initialReaderLink, initialUrl.searchParams.get('title') || '内容阅读');
} else if (initialPackageKey) {
  configureChildPageShell(initialPackageKey);
  (async () => {
    const requestedView = initialUrl.searchParams.get('view') || 'overview';
    await openStoredPackage(initialPackageKey, { view: requestedView, scroll: false });
    if (requestedView === 'document') {
      const artifact = initialUrl.searchParams.get('artifact') || '';
      const title = initialUrl.searchParams.get('title') || '完整使用说明';
      const link = artifact
        ? rawPackageArtifactLink(initialPackageKey, artifact)
        : (state.packageDocumentLinks.guide || state.packageDocumentLinks.capability || '');
      if (link) await openPackageDocument(link, title, { updateUrl: true });
    }
  })();
} else {
  setWorkbenchView(WORKBENCH_VIEWS[initialWorkbenchSection] ? initialWorkbenchSection : 'local', { updateUrl: false });
  loadSessions();
  loadWebChatStatus({ quiet: true });
  loadChatGPTCoverage({ quiet: true });
  startChatGPTCoveragePolling();
  void resumeChatGPTBatchJob();
  loadPackageLibrary();
}
