const state = {
  preview: null,
  importedSources: [],
  sessions: [],
  selectedIds: new Set(),
  sessionMap: new Map(),
  taskChains: [],
  allTaskChains: [],
  taskChainTotal: 0,
  taskChainAvailable: 0,
  taskChainNextOffset: null,
  totalSessions: 0,
  totalAvailable: 0,
  nextOffset: null,
  packages: [],
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function setStatus(message, error = false) {
  const node = $('#status');
  node.textContent = message || '';
  node.classList.toggle('error', error);
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function aiConfig() {
  return {
    enabled: true,
    baseUrl: $('#model-base-url').value.trim(),
    model: $('#model-name').value.trim(),
    apiKey: $('#model-api-key').value.trim(),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function shortText(value, maximum = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function comparablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function updateSelectedSummary() {
  const count = state.selectedIds.size;
  $('#selected-session-summary').textContent = count ? `已选择 ${count.toLocaleString('zh-CN')} 条本机会话` : '尚未选择会话';
  $('#preview-button').textContent = count ? `蒸馏 ${count.toLocaleString('zh-CN')} 条所选会话` : '蒸馏所选会话';
}

function selectTaskChain(sessionIds) {
  for (const id of sessionIds || []) state.selectedIds.add(String(id).toLowerCase());
  renderSessionList();
  updateSelectedSummary();
  setStatus('已加入这条任务链的所有会话。蒸馏时会按照时间线读取需求、执行、产出与后续修正。');
}

function taskChainMarkup(chain) {
  return `<article class="task-chain-item">
    <div><b>${escapeHtml(chain.title || '未命名任务链')}</b><small>${escapeHtml(chain.domain || '通用任务')} · ${Number(chain.sessionCount || 1).toLocaleString('zh-CN')} 条会话 · ${escapeHtml(chain.lifecycle || '待判断')} · 推荐 ${Math.round(Number(chain.recommendationScore || 0))} 分</small><em>${escapeHtml((chain.recommendationReasons || []).join('；') || '已根据实际会话内容归并。')}</em></div>
    <button type="button" class="secondary chain-select" data-chain-ids="${escapeHtml((chain.sessionIds || []).join(','))}">选择整条链</button>
  </article>`;
}

function bindTaskChainSelection(root = document) {
  $$('.chain-select', root).forEach((button) => button.addEventListener('click', () => {
    selectTaskChain(String(button.dataset.chainIds || '').split(',').filter(Boolean));
  }));
}

function renderTaskChains() {
  const panel = $('#task-chain-panel');
  const chains = state.taskChains || [];
  panel.hidden = !chains.length;
  $('#task-chain-list').innerHTML = chains.map(taskChainMarkup).join('');
  $('#task-chain-count').textContent = state.taskChainAvailable
    ? `本机共归并 ${state.taskChainAvailable.toLocaleString('zh-CN')} 条任务链；这里显示优先级最高的 ${chains.length.toLocaleString('zh-CN')} 条。`
    : '正在汇总完整任务链目录。';
  bindTaskChainSelection($('#task-chain-list'));
}

function renderAllTaskChains() {
  const list = $('#all-task-chain-list');
  const count = $('#task-chain-browser-count');
  const chains = state.allTaskChains || [];
  count.textContent = state.taskChainAvailable
    ? `当前显示 ${chains.length.toLocaleString('zh-CN')} / ${state.taskChainTotal.toLocaleString('zh-CN')} 条匹配任务链（本机共 ${state.taskChainAvailable.toLocaleString('zh-CN')} 条）。`
    : '尚未发现可归并的任务链。';
  list.innerHTML = chains.length ? chains.map(taskChainMarkup).join('') : '<p class="empty">没有匹配的任务链。可清空搜索词后重试。</p>';
  const more = $('#load-more-task-chains');
  more.hidden = state.taskChainNextOffset === null;
  more.textContent = state.taskChainNextOffset === null ? '已显示全部匹配任务链' : `继续加载（还有 ${(state.taskChainTotal - chains.length).toLocaleString('zh-CN')} 条）`;
  bindTaskChainSelection(list);
}

async function loadTaskChains({ force = false, append = false } = {}) {
  const more = $('#load-more-task-chains');
  if (append) more.disabled = true;
  try {
    const query = $('#task-chain-search').value.trim();
    const offset = append ? Number(state.taskChainNextOffset || 0) : 0;
    const params = new URLSearchParams({ limit: '20', offset: String(offset) });
    if (query) params.set('q', query);
    if (force) params.set('refresh', '1');
    const payload = await request(`/api/v3/task-chains?${params}`);
    const incoming = Array.isArray(payload.taskChains) ? payload.taskChains : [];
    state.allTaskChains = append ? [...state.allTaskChains, ...incoming] : incoming;
    state.taskChainTotal = Number(payload.total || state.allTaskChains.length);
    state.taskChainAvailable = Number(payload.totalAvailable || state.taskChainTotal);
    state.taskChainNextOffset = payload.nextOffset === null || payload.nextOffset === undefined ? null : Number(payload.nextOffset);
    if (!query && !append) state.taskChains = incoming.slice(0, 5);
    renderTaskChains();
    renderAllTaskChains();
  } catch (error) {
    $('#task-chain-browser-count').textContent = '任务链目录暂时不可用。可点击刷新列表后重试。';
    $('#all-task-chain-list').innerHTML = '<p class="empty">无法读取完整任务链目录。</p>';
    setStatus(error.message, true);
  } finally {
    more.disabled = false;
  }
}

function renderSessionList() {
  $('#session-count').textContent = state.totalAvailable
    ? `当前显示 ${state.sessions.length.toLocaleString('zh-CN')} / ${state.totalSessions.toLocaleString('zh-CN')} 条匹配会话（本机共发现 ${state.totalAvailable.toLocaleString('zh-CN')} 条）`
    : '尚未发现本机 Codex 会话';
  $('#session-list').innerHTML = state.sessions.length ? state.sessions.map((session) => {
    const selected = state.selectedIds.has(session.sessionId.toLowerCase());
    return `<label class="session-item${selected ? ' selected' : ''}">
      <input type="checkbox" data-session-id="${escapeHtml(session.sessionId)}" ${selected ? 'checked' : ''}>
      <span class="session-copy"><b>${escapeHtml(session.title || '未命名本机会话')}</b><small>${escapeHtml(session.domain || '通用任务')} · ${escapeHtml(session.lifecycle || '待判断')} · 推荐 ${Math.round(Number(session.recommendationScore || 0))} 分</small><em>${escapeHtml(formatTime(session.modifiedAt))} · ${escapeHtml(session.taskChainTitle || session.titleSource || '独立会话')}</em><i>${escapeHtml(session.rawTitle && session.rawTitle !== session.title ? `原始标题：${session.rawTitle}` : `${session.sessionId} · ${formatBytes(session.bytes)}`)}</i></span>
    </label>`;
  }).join('') : '<p class="empty">没有匹配的会话。可清空搜索词或点击“刷新列表”。</p>';
  const more = $('#load-more-sessions');
  more.hidden = state.nextOffset === null;
  more.textContent = state.nextOffset === null ? '已显示全部匹配会话' : `继续加载（还有 ${(state.totalSessions - state.sessions.length).toLocaleString('zh-CN')} 条）`;
  $$('#session-list input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => {
    const id = String(input.dataset.sessionId || '').toLowerCase();
    if (input.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    renderSessionList();
    updateSelectedSummary();
  }));
  updateSelectedSummary();
}

async function loadLocalSessions({ force = false, append = false } = {}) {
  const button = $('#refresh-sessions');
  button.disabled = true;
  if (append) $('#load-more-sessions').disabled = true;
  $('#session-count').textContent = '正在建立本机 Codex 会话的语义索引……';
  try {
    const query = $('#session-search').value.trim();
    const offset = append ? Number(state.nextOffset || 0) : 0;
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    if (query) params.set('q', query);
    if (force) params.set('refresh', '1');
    const payload = await request(`/api/v3/sessions?${params}`);
    const incoming = Array.isArray(payload.sessions) ? payload.sessions : [];
    state.sessions = append ? [...state.sessions, ...incoming] : incoming;
    for (const session of incoming) state.sessionMap.set(String(session.sessionId || '').toLowerCase(), session);
    state.taskChains = append || query ? state.taskChains : (Array.isArray(payload.taskChains) ? payload.taskChains : []);
    state.totalSessions = Number(payload.total || state.sessions.length);
    state.totalAvailable = Number(payload.totalAvailable || state.totalSessions);
    state.nextOffset = payload.nextOffset === null || payload.nextOffset === undefined ? null : Number(payload.nextOffset);
    renderTaskChains();
    renderSessionList();
    setStatus(state.totalAvailable ? '本机 Codex 会话已自动加载并按语义标题整理。可选择一条会话，也可选择整条任务链后蒸馏。' : '没有发现本机 Codex 会话，可在高级选项中导入导出的 JSON/JSONL 文件。');
  } catch (error) {
    $('#session-list').innerHTML = '<p class="empty">本机会话列表暂时不可用。可点击刷新重试，或在高级选项中导入会话文件。</p>';
    $('#session-count').textContent = '本机会话搜索失败';
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
    $('#load-more-sessions').disabled = false;
  }
}

function renderPackageCatalog() {
  const node = $('#package-catalog-list');
  const packages = state.packages || [];
  if (!packages.length) {
    node.innerHTML = '<p class="empty">还没有已登记的能力包。完成一次蒸馏并生成后，会在这里长期显示下载、说明和启动入口。</p>';
    return;
  }
  node.innerHTML = packages.map((item) => {
    const packageId = String(item.id || '');
    const phases = (item.phases || []).map((phase) => `P${phase.index || '?'}｜${phase.title || '未命名阶段'}`).filter(Boolean);
    const expertise = (item.expertise || []).map((entry) => entry.capability || entry.deliverable || '').filter(Boolean);
    const targets = (item.targets || []).map((target) => ({ skill: 'Skill', mcp: 'MCP', agent: '独立 Agent' }[target] || target));
    const tags = [...phases.slice(0, 4), ...targets].map((tag) => `<span class="catalog-tag">${escapeHtml(tag)}</span>`).join('');
    const summary = item.summary || expertise.slice(0, 3).join('；') || '已提取会话目标、工具轨迹、文件证据和可复用执行流程。';
    const agent = item.agent || {};
    const agentUrl = String(agent.url || '').trim();
    const agentState = agent.running
      ? (agentUrl ? `已启动：${agentUrl}` : '正在启动独立 Agent……')
      : '未启动。点击后会在本机启动并打开独立中文界面。';
    const agentActions = item.hasAgent ? `<div class="catalog-agent-launch"><button type="button" class="catalog-agent-primary" data-package-agent-start="${escapeHtml(packageId)}">${agent.running ? '进入产物工作台' : '启动并进入产物工作台'}</button>${agent.running ? `<button type="button" data-package-agent-stop="${escapeHtml(packageId)}">停止 Agent</button>` : ''}<small>${escapeHtml(agentState)}</small></div>` : '<small class="catalog-agent-unavailable">此包未包含独立 Agent。</small>';
    return `<article class="package-catalog-entry">
      <div><h3>${escapeHtml(item.name || '未命名能力包')}</h3><p>${escapeHtml(summary)}</p><p class="catalog-meta">${escapeHtml(formatTime(item.createdAt))} · 来自 ${Number(item.sourceCount || 1).toLocaleString('zh-CN')} 条会话 · ${escapeHtml(item.sourceMode === 'multi-session' ? '联合会话蒸馏' : '完整会话蒸馏')}</p><p class="catalog-meta">${escapeHtml(item.namingExplanation || '命名依据已写入完整蒸馏说明。')}</p><div class="catalog-tags">${tags || '<span class="catalog-tag">完整说明已生成</span>'}</div></div>
      <div class="catalog-actions">${agentActions}<a href="${escapeHtml(item.archive || '')}" download>下载 ZIP</a><button type="button" data-package-id="${escapeHtml(packageId)}" data-package-document="conversation-distillation.md">查看蒸馏说明</button><button type="button" data-package-id="${escapeHtml(packageId)}" data-package-document="PRIORITY-PLAN.md">查看优先级</button><button type="button" data-package-id="${escapeHtml(packageId)}" data-package-document="README.md">查看安装与功能</button></div>
    </article>`;
  }).join('');
}

async function loadPackageCatalog({ quiet = false } = {}) {
  const button = $('#refresh-package-catalog');
  button.disabled = true;
  try {
    const payload = await request('/api/v3/packages?limit=100');
    state.packages = Array.isArray(payload.packages) ? payload.packages : [];
    renderPackageCatalog();
    if (!quiet) setStatus(state.packages.length ? `已读取 ${state.packages.length.toLocaleString('zh-CN')} 个已生成能力包。` : '还没有已登记的能力包。');
  } catch (error) {
    $('#package-catalog-list').innerHTML = '<p class="empty">能力包目录暂时不可用。可点击“刷新能力包目录”重试。</p>';
    if (!quiet) setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function openPackageDocument(packageId, documentName) {
  const labels = {
    'README.md': '安装、功能与启动说明',
    'conversation-distillation.md': '完整蒸馏说明',
    'PRIORITY-PLAN.md': '优先级与执行计划',
    'package-manifest.json': '能力包清单',
  };
  const viewer = $('#package-document-viewer');
  $('#package-document-title').textContent = labels[documentName] || '能力包说明';
  $('#package-document-content').textContent = '正在读取说明……';
  viewer.hidden = false;
  try {
    const response = await fetch(`/api/v3/packages/${encodeURIComponent(packageId)}/documents/${encodeURIComponent(documentName)}`);
    const body = await response.text();
    if (!response.ok) throw new Error(body || `读取说明失败（${response.status}）`);
    $('#package-document-content').textContent = body;
    viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('#package-document-content').textContent = `读取失败：${error.message || error}`;
  }
}

function updatePackageAgent(packageId, agent) {
  state.packages = state.packages.map((item) => (item.id === packageId ? { ...item, agent } : item));
}

async function startPackageAgent(packageId, button) {
  const openingTab = window.open('', '_blank');
  if (openingTab) {
    openingTab.opener = null;
    openingTab.document.title = '正在打开产物工作台';
    openingTab.document.body.textContent = '正在启动本次能力包的产物工作台，请稍候……';
  }
  button.disabled = true;
  setStatus('正在启动此能力包的产物工作台……');
  try {
    const payload = await request(`/api/v3/packages/${encodeURIComponent(packageId)}/agent/start`, { method: 'POST', body: '{}' });
    const agent = payload.agent || {};
    updatePackageAgent(packageId, agent);
    renderPackageCatalog();
    if (!agent.url) throw new Error('独立 Agent 已启动，但没有返回可打开的本机地址。');
    if (openingTab && !openingTab.closed) openingTab.location.replace(agent.url);
    else window.open(agent.url, '_blank', 'noopener');
    setStatus(agent.reused ? '产物工作台已在运行，已为你打开其操作界面。' : '产物工作台已启动并打开。可在新页面直接对话、读取会话、选择工作区和执行任务。');
  } catch (error) {
    if (openingTab && !openingTab.closed) openingTab.close();
    setStatus(error.message || '独立 Agent 启动失败。', true);
  } finally {
    button.disabled = false;
  }
}

async function stopPackageAgent(packageId, button) {
  button.disabled = true;
  setStatus('正在停止独立 Agent……');
  try {
    const payload = await request(`/api/v3/packages/${encodeURIComponent(packageId)}/agent/stop`, { method: 'POST', body: '{}' });
    updatePackageAgent(packageId, payload.agent || {});
    renderPackageCatalog();
    setStatus('独立 Agent 已停止。需要时可再次点击“启动独立 Agent”。');
  } catch (error) {
    setStatus(error.message || '停止独立 Agent 失败。', true);
  } finally {
    button.disabled = false;
  }
}

async function chooseProjectPath() {
  const button = $('#pick-project-path');
  button.disabled = true;
  setStatus('正在打开本机项目文件夹选择窗口……');
  try {
    const payload = await request('/api/v2/path-picker', { method: 'POST', body: JSON.stringify({ kind: 'directory' }) });
    const selectedPath = Array.isArray(payload.paths) ? String(payload.paths[0] || '').trim() : '';
    if (!selectedPath) return setStatus('没有指定项目文件夹；蒸馏时会自动发现关联项目。');
    $('#project-path').value = selectedPath;
    setStatus(`已选择项目文件夹：${selectedPath}`);
  } catch (error) {
    setStatus(error.message || '无法打开本机项目文件夹选择窗口。', true);
  } finally {
    button.disabled = false;
  }
}

function listMarkup(items, titleKey, descriptionKey) {
  if (!Array.isArray(items) || !items.length) return '<li class="empty">暂无内容</li>';
  return items.map((item) => `<li><strong>${escapeHtml(item?.[titleKey] || item?.title || item?.label || '未命名')}</strong><span>${escapeHtml(item?.[descriptionKey] || item?.description || item?.help || item?.instruction || '')}</span></li>`).join('');
}

function tableMarkup(headers, rows, empty = '暂无内容') {
  if (!rows.length) return `<p class="knowledge-empty">${escapeHtml(empty)}</p>`;
  return `<table><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderRecommendation(recommendation, links = {}) {
  const priorities = recommendation?.priorities || [];
  const summary = recommendation?.summary || {};
  $('#recommendation-summary').textContent = priorities.length
    ? `${priorities.length.toLocaleString('zh-CN')} 项建议 · 证据置信度 ${Number(summary.confidence || 0).toLocaleString('zh-CN')}`
    : '暂未生成优先级';
  $('#recommendation-note').textContent = recommendation?.purpose || '优先级由会话中的最终纠正、语义阶段、实际工具调用、项目文件与生成产物证据共同确定。';
  $('#recommendation-list').innerHTML = priorities.length ? priorities.map((item) => `<article class="recommendation-item">
    <span class="priority-badge">${escapeHtml(item.priority || 'P?')}</span>
    <div><h4>${escapeHtml(item.title || '未命名建议')}</h4><p>${escapeHtml(item.reason || item.description || '')}</p><dl><div><dt>建议输出</dt><dd>${escapeHtml(item.expectedOutput || item.output || '待定义')}</dd></div><div><dt>建议封装</dt><dd>${escapeHtml(item.recommendedPackage || item.package || '能力包')}</dd></div><div><dt>依据</dt><dd>${escapeHtml((item.evidence || item.evidenceIds || []).map((value) => typeof value === 'string' ? value : value.title || value.id || '').filter(Boolean).join('、') || '会话与项目证据')}</dd></div></dl></div>
  </article>`).join('') : '<p class="knowledge-empty">当前会话尚无足够证据生成优先级建议。</p>';
  const visibleLinks = [
    ['优先级 JSON', links.recommendation],
    ['优先级说明', links.recommendationMarkdown],
    ['可读报告', links.recommendationHtml],
  ].filter(([, href]) => href);
  $('#recommendation-links').innerHTML = visibleLinks.map(([label, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`).join('');
}

function renderProjectDiscovery(discovery = {}, evidence = {}, knowledge = {}) {
  const summary = evidence?.summary || {};
  const project = evidence?.project || knowledge?.projectSnapshot?.project || {};
  const selectedPath = discovery?.selectedPath || project?.root || '';
  const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
  const filesRead = Number(summary.filesScanned || summary.scannedFiles || summary.filesRead || knowledge?.summary?.projectFiles || 0);
  const modifiedFiles = Number(summary.modifiedFiles || (evidence?.modifiedFiles || []).length || knowledge?.summary?.modifiedFiles || 0);
  const generatedFiles = Number(summary.generatedFiles || (evidence?.generatedFiles || []).length || knowledge?.summary?.generatedFiles || 0);
  const originalFiles = Number(summary.originalFiles || (evidence?.originalFiles || []).length || 0);
  const mode = discovery?.mode || summary.discoveryMode || '未定位';
  const reason = discovery?.reason || summary.discoveryReason || '';

  $('#project-discovery-summary').textContent = selectedPath
    ? `已自动关联项目：${selectedPath}。定位方式为“${mode}”，会话、文件变更和 Git 证据会一起参与蒸馏。`
    : '尚未自动确认关联项目。本次仍会完整读取所选会话；可使用上方“选择项目文件夹”按钮从本机目录选择项目，无需手工输入路径。';
  const metrics = [
    ['定位方式', mode],
    ['项目目录', selectedPath ? shortText(selectedPath, 72) : '未定位'],
    ['实际读取', `${filesRead.toLocaleString('zh-CN')} 个项目文件`],
    ['修改 / 生成 / 原始', `${modifiedFiles.toLocaleString('zh-CN')} / ${generatedFiles.toLocaleString('zh-CN')} / ${originalFiles.toLocaleString('zh-CN')}`],
  ];
  $('#project-discovery-metrics').innerHTML = metrics.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b title="${escapeHtml(value)}">${escapeHtml(value)}</b></div>`).join('');
  const explanations = [
    reason,
    selectedPath ? '已把关联文件、当前工作区文件、Git 原始版本与差异纳入同一次理解，不只根据对话文本命名。' : '在未选项目时，系统不会猜测或写入任何目录；选择动作始终通过本机文件夹选择器完成。',
    candidates.length > 1 ? `系统还比较了 ${candidates.length.toLocaleString('zh-CN')} 个候选项目，已选取证据最强的一项。` : '',
  ].filter(Boolean);
  $('#project-discovery-reasons').innerHTML = explanations.map((item) => `<p>${escapeHtml(item)}</p>`).join('');
  const selectedComparablePath = comparablePath(selectedPath);
  $('#project-candidate-list').innerHTML = candidates.length ? `<div class="project-candidate-heading"><strong>可选择的关联项目</strong><span>候选来自会话工作目录、文件变更、工具路径和项目标记；点击即可切换并自动重新蒸馏。</span></div>${candidates.map((candidate, index) => {
    const candidatePath = String(candidate?.root || '').trim();
    const selected = comparablePath(candidatePath) === selectedComparablePath;
    const markers = Array.isArray(candidate?.markers) && candidate.markers.length ? candidate.markers.join('、') : '未识别项目标记';
    const signals = Array.isArray(candidate?.signals) ? candidate.signals.slice(0, 2) : [];
    const signalText = signals.map((signal) => `${signal.type || '证据'}：${signal.detail || signal.path || '已命中'}`).join('；') || '已由会话和项目结构交叉确认。';
    return `<article class="project-candidate${selected ? ' selected' : ''}">
      <div><span class="project-candidate-rank">候选 ${index + 1} · ${escapeHtml(candidate?.confidence || '待判断')}置信度 · ${Number(candidate?.score || 0).toLocaleString('zh-CN')} 分</span><strong title="${escapeHtml(candidatePath)}">${escapeHtml(candidatePath || '未记录目录')}</strong><p>${candidate?.git ? 'Git 仓库' : '非 Git 目录'} · 项目标记：${escapeHtml(markers)} · 会话关联文件 ${Number(candidate?.linkedFiles || 0).toLocaleString('zh-CN')} 个</p><small>命中证据：${escapeHtml(signalText)}</small></div>
      <button type="button" class="secondary" data-project-candidate-path="${escapeHtml(candidatePath)}" ${selected ? 'disabled' : ''}>${selected ? '当前已采用' : '改用此项目并重新蒸馏'}</button>
    </article>`;
  }).join('')}` : '<p class="project-candidate-empty">未发现可验证的关联项目候选。可使用上方“选择项目文件夹”打开本机选择器，不需要手工输入路径。</p>';
}

function renderProjectKnowledge(knowledge) {
  const summary = knowledge?.summary || {};
  const projectCoverage = knowledge?.coverage?.project || {};
  const stages = knowledge?.semanticStages || [];
  const model = knowledge?.projectModel || null;
  const changes = knowledge?.fileChangeMatrix || [];
  const versions = knowledge?.fileVersions || [];
  const timeline = knowledge?.crossSessionTimeline || [];
  const lineage = knowledge?.artifactLineage || [];
  const reproductions = knowledge?.artifactReproducibility || [];
  const decisions = knowledge?.decisionConflicts?.decisions || knowledge?.decisionConflicts || [];
  const reads = knowledge?.activeReadLog || [];
  $('#knowledge-metrics').innerHTML = [
    ['来源会话', summary.sessions], ['P 阶段', summary.semanticStages], ['项目文件', summary.projectFiles], ['变更文件', summary.changedFiles],
    ['版本证据', summary.fileVersions], ['时间线事件', summary.timelineEvents], ['生成产物', summary.reproducibleArtifacts], ['待补证', summary.openEvidenceQuestions],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${Number(value || 0).toLocaleString('zh-CN')}</strong></div>`).join('');
  $('#knowledge-coverage').textContent = projectCoverage.available ? `已读正文 ${Number(projectCoverage.textFilesRead || 0).toLocaleString('zh-CN')} 个文件` : '未定位关联项目';
  $('#knowledge-stages').innerHTML = stages.length ? stages.map((stage) => `<article><div><strong>${escapeHtml(stage.title || `P${stage.index || '?'}`)}</strong><span>${escapeHtml(stage.purpose || '未提取具体目标')}</span></div><p><b>来源会话：</b>${escapeHtml((stage.sessions || []).map((item) => item.title || item.sessionId || item).join('、') || '—')}<br><b>关联文件：</b>${escapeHtml((stage.files || []).join('、') || '—')}<br><b>实际工具：</b>${escapeHtml((stage.tools || []).join('、') || '—')}</p></article>`).join('') : '<p class="knowledge-empty">没有识别到语义阶段。</p>';
  $('#knowledge-timeline').innerHTML = tableMarkup(['时间', '事件', '来源会话', '内容', 'P 阶段'], timeline.slice(0, 100).map((item) => [escapeHtml(item.timestamp || '未记录'), escapeHtml(item.type || '事件'), escapeHtml(item.sessionTitle || item.sessionId || '未标识'), escapeHtml(shortText(item.title || item.action || item.tool || item.command || '', 180)), escapeHtml(item.semanticStageTitle || item.semanticStageId || '')]));
  $('#knowledge-model').innerHTML = model ? `<article><div><strong>${escapeHtml(model.project?.name || '未命名项目')}</strong><span>${escapeHtml(model.purpose || '未确认项目目的')}</span></div><p><b>根目录：</b>${escapeHtml(model.project?.root || '—')}<br><b>入口：</b>${escapeHtml((model.entryPoints || []).map((item) => item.path || item).join('、') || '—')}<br><b>模块：</b>${escapeHtml((model.modules || []).map((item) => item.name || item).join('、') || '—')}</p></article>` : '<p class="knowledge-empty">本次未定位到可读取项目；会话证据仍已保留。</p>';
  $('#knowledge-changes').innerHTML = tableMarkup(['文件', '状态', '涉及会话', '判断'], changes.slice(0, 200).map((item) => [escapeHtml(item.path), escapeHtml(item.changeState || item.gitStatus || item.kind || '已记录'), escapeHtml((item.sessions || []).map((entry) => entry.title || entry.sessionId || entry).join('、') || '未关联'), escapeHtml(item.assessment || '')]));
  $('#knowledge-impact').innerHTML = tableMarkup(['变更文件', '直接依赖方', '传递影响'], (knowledge?.dependencyImpact?.changedFiles || []).slice(0, 150).map((item) => [escapeHtml(item.path), escapeHtml((item.directDependents || []).join('、') || '无'), escapeHtml((item.transitiveDependents || []).join('、') || '无')]));
  $('#knowledge-versions').innerHTML = tableMarkup(['文件', '版本类型', '版本或动作', '正文'], versions.slice(0, 200).map((item) => [escapeHtml(item.path), escapeHtml(item.kind), escapeHtml(item.action || item.revision || '—'), item.contentAvailable ? '可用' : '不可用']));
  $('#knowledge-lineage').innerHTML = tableMarkup(['生成产物', '可信度', '输入或依赖', '结论'], lineage.slice(0, 150).map((item) => [escapeHtml(item.path), escapeHtml(item.confidence), escapeHtml((item.inputs || []).join('、') || '—'), escapeHtml(item.conclusion || '—')]));
  $('#knowledge-reproduction').innerHTML = tableMarkup(['产物', '状态', '可重放', '当前指纹'], reproductions.slice(0, 150).map((item) => [escapeHtml(item.path), escapeHtml(item.reproducibility?.status || '复现证据不足'), item.reproducibility?.readyToReplay ? '是' : '否', escapeHtml(item.currentSnapshot?.sha256 || '无')]));
  $('#knowledge-decisions').innerHTML = tableMarkup(['主题', '最终采用', '依据'], decisions.slice(0, 100).map((item) => [escapeHtml(item.topic || item.title || '未命名决策'), escapeHtml(item.finalDecision || item.adopted || item.decision || '—'), escapeHtml((item.evidenceIds || []).join('、') || item.reason || '—')]));
  const limitations = knowledge?.coverage?.limitations || [];
  $('#knowledge-limitations').innerHTML = limitations.length ? limitations.map((item) => `<article><div><strong>${escapeHtml(item.title || item.kind || '覆盖限制')}</strong><span>${escapeHtml(item.description || item.reason || item)}</span></div></article>`).join('') : '<p class="knowledge-empty">当前未记录额外限制。</p>';
  const questions = knowledge?.openEvidenceQuestions || [];
  const questionMarkup = questions.map((item) => `<article><div><strong>待补证</strong><span>${escapeHtml(typeof item === 'string' ? item : item.question || item.message || '待确认')}</span></div></article>`).join('');
  $('#knowledge-snapshot').innerHTML = `<article><div><strong>项目快照指纹</strong><span>${escapeHtml(knowledge?.projectSnapshot?.fingerprint || '未生成')}</span></div></article>${questionMarkup || '<p class="knowledge-empty">暂无待补证问题。</p>'}`;
  $('#knowledge-reads').innerHTML = tableMarkup(['状态', '动作', '目标', '原因'], reads.slice(0, 150).map((item) => [escapeHtml(item.status), escapeHtml(item.action), escapeHtml(item.target || '—'), escapeHtml(item.reason || '—')]));
}

function showPreview(payload) {
  state.preview = payload;
  const ui = payload.ui || {};
  const identity = ui.identity || payload.identity || {};
  $('#capability-title').value = identity.title || identity.packageName || payload.identity?.name || '';
  $('#capability-action').value = ui.primaryAction?.label || '开始执行专属工作流';
  $('#capability-purpose').value = ui.purpose || payload.recommendation?.purpose || '';
  $('#generation-note').textContent = `${ui.generation?.label || '全量证据蒸馏'}：${ui.generation?.reason || '已读取用户目标、后续纠正、实际工具、文件修改和关联项目。'}`;
  $('#session-meta').textContent = `${Number(payload.sourceSet?.sessionCount || 1).toLocaleString('zh-CN')} 条会话 · ${Number(payload.sourceSet?.recordCount || payload.source?.recordCount || 0).toLocaleString('zh-CN')} 条记录`;
  $('#input-list').innerHTML = listMarkup(ui.inputs, 'label', 'help');
  $('#capability-list').innerHTML = listMarkup(ui.capabilities, 'action', 'description');
  $('#deliverable-list').innerHTML = listMarkup(ui.deliverables, 'title', 'description');
  $('#correction-list').innerHTML = listMarkup(ui.corrections, 'title', 'instruction');
  const stages = payload.projectKnowledgeV4?.semanticStages || payload.extraction?.stages || [];
  $('#stage-summary').textContent = stages.length ? stages.map((stage) => stage.title?.startsWith('P') ? stage.title : `P${stage.index || '?'}｜${stage.title || '未命名'}`).join('；') : '未识别阶段，将按完整输入处理。';
  const semanticQuality = ui.semanticQuality || payload.conversationDistillation?.semanticQuality || {};
  $('#semantic-quality-summary').textContent = `状态：${semanticQuality.status || '未执行'}；已从 ${Number(semanticQuality.sourceStageCount || stages.length || 0).toLocaleString('zh-CN')} 个原始需求阶段生成 ${Number(semanticQuality.specializationCount || ui.specializations?.length || 0).toLocaleString('zh-CN')} 个专属能力。`;
  $('#semantic-quality-guarantees').innerHTML = (semanticQuality.guarantees || ['每项 P 阶段均保留任务目标、执行方法、交付物和证据。']).map((item) => `<li><strong>已保证</strong><span>${escapeHtml(item)}</span></li>`).join('');
  $('#semantic-quality-issues').innerHTML = (semanticQuality.issues || []).length
    ? semanticQuality.issues.map((item) => `<li class="quality-issue"><strong>待补证</strong><span>${escapeHtml(item)}</span></li>`).join('')
    : '<li><strong>检查结果</strong><span>未发现会使阶段退化为泛泛标题的缺项。</span></li>';
  renderRecommendation(payload.recommendation, payload.links || {});
  renderProjectDiscovery(payload.projectDiscovery, payload.projectEvidence, payload.projectKnowledgeV4 || {});
  renderProjectKnowledge(payload.projectKnowledgeV4 || {});
  $('#preview-panel').hidden = false;
  $('#export-panel').hidden = false;
  $$('.steps li').forEach((node, index) => node.classList.toggle('active', index > 0));
  $('#preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function previewConversation() {
  const localIds = [...state.selectedIds];
  const content = $('#conversation-content').value;
  if (!localIds.length && !content.trim() && !state.importedSources.length) return setStatus('请先勾选至少一条本机 Codex 会话；没有本机记录时可在高级选项中导入文件。', true);
  const button = $('#preview-button');
  button.disabled = true;
  setStatus(localIds.length ? '正在读取所选本机 Codex 会话、自动定位关联项目并建立文件版本证据……' : '正在读取导入会话、自动定位关联项目并建立文件版本证据……');
  try {
    const common = { projectPath: $('#project-path').value.trim(), ai: aiConfig() };
    const payload = localIds.length
      ? await request('/api/v2/intakes', { method: 'POST', body: JSON.stringify({ ...common, sessionIds: localIds }) })
      : await request('/api/preview', { method: 'POST', body: JSON.stringify({ ...common, content, sources: state.importedSources }) });
    showPreview(payload);
    setStatus('蒸馏完成。优先级、P 阶段、项目证据和能力说明已生成；确认名称后即可导出。');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function selectProjectCandidate(button) {
  const selectedPath = String(button?.dataset?.projectCandidatePath || '').trim();
  if (!selectedPath) return setStatus('该项目候选没有可用路径，无法切换。', true);
  if (comparablePath(selectedPath) === comparablePath($('#project-path').value)) return setStatus('当前已经采用这个关联项目。');
  $('#project-path').value = selectedPath;
  setStatus(`已切换到候选项目：${selectedPath}。正在重新读取会话、文件版本和项目证据……`);
  await previewConversation();
}

function selectedTargets() {
  return $$('.target-option input:checked').map((input) => input.value);
}

async function generatePackage() {
  if (!state.preview?.importId) return setStatus('请先完成会话蒸馏。', true);
  const targets = selectedTargets();
  if (!targets.length) return setStatus('至少选择一种交付形式。', true);
  const button = $('#generate-button');
  button.disabled = true;
  setStatus('正在写入会话证据、P0-P3 优先级、完整说明、独立界面和可安装文件……');
  try {
    const body = {
      targets,
      ai: aiConfig(),
      uiOverrides: { identity: { title: $('#capability-title').value.trim() }, purpose: $('#capability-purpose').value.trim(), primaryAction: { label: $('#capability-action').value.trim() } },
    };
    const path = state.preview.links?.package || '/api/generate';
    if (!state.preview.links?.package) body.importId = state.preview.importId;
    const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
    const parts = [];
    if (result.skill) parts.push(`<li><b>Skill：</b>${escapeHtml(result.skill.file || result.skill.directory)}</li>`);
    if (result.mcp) parts.push(`<li><b>MCP：</b>${escapeHtml(result.mcp.server || result.mcp.directory)}</li>`);
    if (result.agent) parts.push('<li><b>产物工作台：</b>已生成可操作的中文界面。可直接点击下方主按钮启动并进入，无需输入命令或文件路径。</li>');
    const recommendation = result.recommendation || state.preview.recommendation;
    const priorityText = (recommendation?.priorities || []).map((item) => `${item.priority} ${item.title}`).join('；');
    const node = $('#result');
    node.innerHTML = `<h3>已生成：${escapeHtml(result.name)}</h3><p>该能力包针对本次所选会话和关联项目生成，包含完整能力说明、项目证据、文件版本、产物血缘以及 P0-P3 优先级计划。</p>${priorityText ? `<p><b>蒸馏优先级：</b>${escapeHtml(priorityText)}</p>` : ''}<a class="download-link" href="${escapeHtml(result.archive)}" download>下载可安装 ZIP</a><ul>${parts.join('')}</ul><p><b>下一步：</b>可下载可安装 ZIP，或在下方能力包目录查看完整说明和启动记录。</p>`;
    if (result.agent && result.packageId) {
      const title = node.querySelector('h3');
      title?.insertAdjacentHTML('afterend', `<div class="result-actions"><button type="button" class="primary" data-result-agent-start="${escapeHtml(result.packageId)}">启动并进入产物工作台</button><p>会在新标签页打开本次蒸馏专属的中文操作界面，可直接对话、读取证据、选择工作区和执行任务。</p></div>`);
      const nextStep = [...node.children].reverse().find((child) => child.tagName === 'P');
      if (nextStep) nextStep.innerHTML = '<b>下一步：</b>直接点击上方“启动并进入产物工作台”，即可开始使用本次能力包。目录仍保留下载、说明和停止服务入口。';
    }
    node.hidden = false;
    await loadPackageCatalog({ quiet: true });
    $$('.steps li').forEach((item, index) => item.classList.toggle('active', index > 1));
    setStatus('能力包已生成并登记。现在可直接点击结果区的“启动并进入产物工作台”，目录保留下载、说明和服务管理入口。');
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('#conversation-file').addEventListener('change', async (event) => {
  const files = [...(event.target.files || [])];
  if (!files.length) return;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 45 * 1024 * 1024) return setStatus('所选文件合计超过 45 MB，请拆分后再导入。', true);
  state.importedSources = await Promise.all(files.map(async (file) => ({ name: file.name, content: await file.text(), bytes: file.size })));
  $('#file-status').textContent = `已载入 ${files.length.toLocaleString('zh-CN')} 份备用会话文件`;
  $('#character-count').textContent = `${(state.importedSources.reduce((sum, item) => sum + item.content.length, 0) + $('#conversation-content').value.length).toLocaleString('zh-CN')} 字符`;
  $('#selected-source-list').innerHTML = state.importedSources.map((item, index) => `<div><b>${index + 1}</b><span>${escapeHtml(item.name)}</span><small>${Number(item.bytes || 0).toLocaleString('zh-CN')} 字节</small></div>`).join('');
});
$('#conversation-content').addEventListener('input', () => { $('#character-count').textContent = `${(state.importedSources.reduce((sum, item) => sum + item.content.length, 0) + $('#conversation-content').value.length).toLocaleString('zh-CN')} 字符`; });
let sessionSearchTimer = null;
$('#session-search').addEventListener('input', () => {
  window.clearTimeout(sessionSearchTimer);
  sessionSearchTimer = window.setTimeout(() => loadLocalSessions(), 260);
});
let taskChainSearchTimer = null;
$('#open-task-chain-browser').addEventListener('click', () => {
  const browser = $('#task-chain-browser');
  browser.open = true;
  $('#task-chain-search').focus();
  browser.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#task-chain-search').addEventListener('input', () => {
  window.clearTimeout(taskChainSearchTimer);
  taskChainSearchTimer = window.setTimeout(() => loadTaskChains(), 260);
});
$('#load-more-task-chains').addEventListener('click', () => loadTaskChains({ append: true }));
$('#refresh-sessions').addEventListener('click', async () => {
  await loadLocalSessions({ force: true });
  await loadTaskChains();
});
$('#load-more-sessions').addEventListener('click', () => loadLocalSessions({ append: true }));
$('#pick-project-path').addEventListener('click', chooseProjectPath);
$('#preview-button').addEventListener('click', previewConversation);
$('#generate-button').addEventListener('click', generatePackage);
$('#project-candidate-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-project-candidate-path]');
  if (button && !button.disabled) void selectProjectCandidate(button);
});
$('#result').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-result-agent-start]');
  if (button) void startPackageAgent(button.dataset.resultAgentStart || '', button);
});
$('#refresh-package-catalog').addEventListener('click', () => loadPackageCatalog());
$('#package-catalog-list').addEventListener('click', (event) => {
  const startButton = event.target.closest('button[data-package-agent-start]');
  if (startButton) {
    void startPackageAgent(startButton.dataset.packageAgentStart || '', startButton);
    return;
  }
  const stopButton = event.target.closest('button[data-package-agent-stop]');
  if (stopButton) {
    void stopPackageAgent(stopButton.dataset.packageAgentStop || '', stopButton);
    return;
  }
  const button = event.target.closest('button[data-package-document]');
  if (!button) return;
  openPackageDocument(button.dataset.packageId || '', button.dataset.packageDocument || 'README.md');
});
$('#close-package-document').addEventListener('click', () => { $('#package-document-viewer').hidden = true; });

async function initializeWorkspace() {
  await loadLocalSessions();
  await loadTaskChains();
  await loadPackageCatalog({ quiet: true });
}

void initializeWorkspace();
