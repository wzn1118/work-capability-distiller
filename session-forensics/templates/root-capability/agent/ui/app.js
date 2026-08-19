const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  health: null,
  capabilities: null,
  distillation: null,
  alignment: null,
  tools: [],
  models: [],
  codexLink: null,
  localSessions: [],
  localSessionTotal: 0,
  localSessionNextOffset: null,
  localTaskChains: [],
  localTaskChainTotal: 0,
  localTaskChainAvailable: 0,
  localTaskChainNextOffset: null,
  selectedLocalSessionIds: new Set(),
  loadedLocalSessions: [],
  loadedLocalContext: null,
  installation: null,
  uiBlueprint: null,
  sourceSessions: [],
  projectPortfolio: null,
  projectEvidence: null,
  projectUnderstanding: null,
  projectKnowledgeV4: null,
  recommendation: null,
  workCapability: null,
  workEvaluation: null,
  coverageGaps: null,
  semanticEvaluationPlan: null,
  releaseValidation: null,
  processes: [],
  tasks: [],
  mode: '提取并改进原对话',
  currentTask: null,
  running: false,
  events: [],
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function compact(value, maximum = 1200) {
  const text = String(value ?? '').trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function showToast(message, type = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error?.message || body?.message || body || `请求失败：${response.status}`);
  return body;
}

function switchView(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  $$('.view').forEach((item) => item.classList.toggle('active', item.dataset.viewPanel === name));
  if (name === 'history') loadTasks();
}

function statusClass(status) {
  if (status === '完成') return 'success';
  if (['失败', '已停止'].includes(status)) return 'failed';
  return 'running';
}

function updateReadiness() {
  const runtime = state.health?.runtime || {};
  const workspace = state.health?.workspace || {};
  const modelReady = Boolean(runtime.baseUrl && runtime.model);
  const workspaceReady = Boolean(workspace.ready);
  $('#service-dot').className = `status-dot ${state.health?.ok ? 'ready' : 'error'}`;
  $('#service-status').textContent = state.health?.ok ? '本地服务正常' : '本地服务异常';
  $('#model-status').textContent = modelReady ? `模型已配置：${runtime.model}${runtime.hasApiKey ? '，密钥已提供' : '，当前接口未提供密钥'}` : '模型接口或模型名称未配置';
  $('#task-ready-dot').className = `status-dot ${modelReady && workspaceReady ? 'ready' : 'busy'}`;
  if (!modelReady) $('#task-readiness').textContent = '请先保存模型接口和模型名称；密钥可按接口要求选填';
  else if (!workspaceReady) $('#task-readiness').textContent = '请先选择有效的本地工作区';
  else if (!workspace.allowWrite && !workspace.allowCommand) $('#task-readiness').textContent = '当前仅能读取和规划，不会修改文件或执行命令';
  else $('#task-readiness').textContent = '模型和工作区已就绪，可以开始真实执行';
  $('#setup-state').textContent = modelReady && workspaceReady ? '已完成设置' : '仍需设置';
  $('#setup-state').className = `pill ${modelReady && workspaceReady ? 'success' : 'neutral'}`;
  $('#start-task').disabled = !modelReady || !workspaceReady || state.running;
}

function renderWorkCapability() {
  const work = state.workCapability;
  const evaluation = state.workEvaluation;
  const release = evaluation?.releaseDecision || work?.releaseDecision || {};
  const statusNames = { publishable: '可发布', restricted: '受限可用', candidate: '候选能力', blocked: '已阻断' };
  const stateLabel = $('#work-release-state');
  if (!work) {
    $('#work-release-title').textContent = '当前包尚未生成 Work Capability IR v2';
    stateLabel.textContent = '等待升级';
    stateLabel.className = 'pill neutral';
    $('#work-identity').textContent = '缺少统一工作运行对象，仍可使用现有会话能力。';
    $('#work-coverage').textContent = '尚未生成字段与指标覆盖矩阵。';
    $('#work-gates').textContent = '尚未生成 G0-G9 发布门结果。';
    return;
  }
  const identity = work.subjectIdentity || {};
  const requested = identity.requestedSubject?.name || identity.requestedSubject?.businessObject || identity.requestedSubject?.accountName || '未填写目标对象';
  const observed = identity.observedSubject?.name || identity.observedSubject?.businessObject || identity.observedSubject?.accountName || '未识别实际对象';
  const counts = work.coverageMatrix?.summary?.counts || {};
  const gates = evaluation?.gates || {};
  const passed = Object.values(gates).filter((gate) => gate.status === 'pass').length;
  const failed = Object.values(gates).filter((gate) => gate.status === 'fail').length;
  const pending = Object.values(gates).filter((gate) => gate.status === 'pending').length;
  $('#work-release-title').textContent = work.domainProfile?.title || work.userGoal || '专属工作能力';
  stateLabel.textContent = statusNames[release.status] || '待评估';
  stateLabel.className = `pill ${release.status === 'publishable' ? 'success' : release.status === 'blocked' ? 'warning' : 'neutral'}`;
  $('#work-identity').textContent = identity.match === true
    ? `目标“${requested}”与实际对象“${observed}”一致。`
    : identity.match === false
      ? `目标“${requested}”与实际对象“${observed}”不一致，已阻止误标发布。`
      : `目标“${requested}”，实际对象“${observed}”，发布前仍需确认。`;
  $('#work-coverage').textContent = `可发布 ${counts.eligible || 0} 项，受限 ${counts.restricted || 0} 项，阻断 ${counts.blocked || 0} 项，待确认 ${counts.unknown || 0} 项。`;
  $('#work-gates').textContent = `通过 ${passed} 项，失败 ${failed} 项，待验证 ${pending} 项。${release.reason || ''}`;
}

function renderCoverageGaps() {
  const register = state.coverageGaps || { gaps: [], summary: {} };
  const gaps = register.gaps || [];
  const summary = register.summary || {};
  const count = $('#coverage-gap-count');
  const active = Number(summary.active || 0);
  count.textContent = active ? `${active} 项待处理` : '当前无待处理项';
  count.className = `pill ${Number(summary.blocking || 0) ? 'warning' : active ? 'neutral' : 'success'}`;
  $('#coverage-gap-summary-text').textContent = gaps.length
    ? `共识别 ${gaps.length} 项缺口，其中 ${active} 项仍需处理`
    : '当前覆盖矩阵没有需要人工处理的数据缺口';
  const root = $('#coverage-gap-list');
  root.innerHTML = gaps.length ? gaps.map((gap) => {
    const actions = gap.availableActions || [];
    const coverage = gap.coveragePercent === null || gap.coveragePercent === undefined ? '尚未建立分母' : `${Number(gap.coveragePercent).toFixed(2)}%`;
    const statusNames = { detected: '待决定', queued: '等待补充', collecting: '正在补充', reconciling: '正在对账', recomputing: '正在重算', resolved: '已解决', locked: '已锁定口径', excluded: '已排除', failed: '处理失败' };
    return `<article class="coverage-gap-row"><div class="coverage-gap-copy"><div class="coverage-gap-title-row"><strong>${escapeHtml(gap.title || gap.metricId)}</strong><span class="pill ${gap.severity === 'blocking' ? 'warning' : 'neutral'}">${escapeHtml(statusNames[gap.status] || gap.status)}</span></div><p>${escapeHtml(gap.reason || '')}</p><dl><div><dt>当前覆盖</dt><dd>${escapeHtml(`${gap.numerator || 0}/${gap.denominator || 0}，${coverage}`)}</dd></div><div><dt>影响</dt><dd>${escapeHtml(gap.impact || '影响该指标的发布范围。')}</dd></div></dl></div><div class="coverage-gap-actions">${actions.length ? actions.map((action) => `<button type="button" class="secondary-button" data-gap-id="${escapeHtml(gap.gapId)}" data-gap-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`).join('') : '<span class="muted">当前状态没有下一步操作。</span>'}</div></article>`;
  }).join('') : '<p class="coverage-gap-empty">当前没有阻断或受限覆盖项，可以继续执行任务。</p>';
  const plan = state.semanticEvaluationPlan;
  if (!plan) {
    $('#semantic-evaluation-detail').textContent = '当前包没有语义评估计划，通用执行能力仍可正常使用。';
  } else if (!plan.required) {
    $('#semantic-evaluation-detail').textContent = '当前能力不依赖模型语义结论，无需额外语义评估。';
  } else {
    $('#semantic-evaluation-detail').textContent = `语义能力仍为候选：需要完成 ${plan.strata?.length || 0} 类分层抽样，并输出精确率、召回率、F1、混淆矩阵和人工修正记录。`;
  }
}

function renderReleaseValidation() {
  const root = $('#release-validation-list');
  if (!root) return;
  const validation = state.releaseValidation || {};
  const items = [
    ['G4', '确定性复跑', validation.deterministicReplay],
    ['G6', '原任务事件回放', validation.originalTaskReplay],
    ['G7', '未参与蒸馏的新任务', validation.heldOutEvaluation],
    ['G9', '隔离工作区执行', validation.isolatedAgentValidation],
  ];
  root.innerHTML = items.map(([gate, title, result]) => {
    const status = result?.status || 'pending';
    const labels = { pass: '通过', fail: '未通过', pending: '待验证', restricted: '受限' };
    const coverage = gate === 'G7' && result?.coverage
      ? `<p class="release-coverage"><strong>${escapeHtml(`${result.coverage.validated || 0}/${result.coverage.required || 0}`)}</strong> 项核心能力已验证，累计 ${escapeHtml(String(result.coverage.passedCandidateCount || 0))} 个合格独立任务</p>`
      : '';
    return `<article><div><span>${gate}</span><strong>${escapeHtml(title)}</strong></div><span class="pill ${status === 'pass' ? 'success' : status === 'fail' ? 'warning' : 'neutral'}">${escapeHtml(labels[status] || status)}</span><p>${escapeHtml(result?.reason || '当前能力包没有这项验证记录。')}</p>${coverage}</article>`;
  }).join('');
}

function renderHeldOutSubmit(task = state.currentTask) {
  const panel = $('#held-out-submit');
  if (!panel) return;
  const finished = Boolean(task?.result || task?.error);
  panel.classList.toggle('hidden', !finished);
  if (!finished) return;
  const checks = Array.isArray(task.verification) ? task.verification : [];
  const passed = checks.length > 0 && checks.every((item) => item.passed === true);
  const stateLabel = $('#held-out-submit-state');
  const help = $('#held-out-submit-help');
  const submit = $('#submit-held-out');
  stateLabel.textContent = passed ? '可以提交' : '需要先通过验收';
  stateLabel.className = `pill ${passed ? 'success' : 'warning'}`;
  const suite = state.releaseValidation?.heldOutEvaluation || {};
  const validated = new Set(Array.isArray(suite.validatedCapabilityIds) ? suite.validatedCapabilityIds : []);
  const missing = new Set(Array.isArray(suite.missingCapabilityIds) ? suite.missingCapabilityIds : []);
  const coverage = suite.coverage || {};
  help.textContent = passed
    ? `系统会使用这次任务的真实执行记录生成独立来源指纹。当前已验证 ${coverage.validated || 0}/${coverage.required || 0} 项核心能力，请只勾选本次实际完成的能力。`
    : '这次任务还没有全部通过的验证命令。请先继续任务并运行验证，再提交 G7。';
  const root = $('#held-out-capabilities');
  const capabilities = Array.isArray(state.workCapability?.capabilities) ? state.workCapability.capabilities.slice(0, 12) : [];
  const firstMissingId = capabilities.find((item) => missing.has(item.id))?.id || capabilities[0]?.id;
  root.innerHTML = capabilities.length
    ? `<p class="held-out-capabilities-label">请选择这次任务实际完成的专属能力（可多选，已验证能力无需重复提交）：</p>${capabilities.map((item) => {
        const isValidated = validated.has(item.id);
        return `<label class="held-out-capability-option ${isValidated ? 'is-validated' : ''}"><input type="checkbox" data-held-out-capability="${escapeHtml(item.id)}" ${item.id === firstMissingId && !isValidated ? 'checked' : ''}><span><strong>${escapeHtml(item.priority || '')} ${escapeHtml(item.title || item.id)}</strong><small>${escapeHtml(compact(item.summary || item.goal || '', 180))}</small></span><em>${isValidated ? '已验证' : '待验证'}</em></label>`;
      }).join('')}`
    : '<p class="muted">当前能力包没有可供匹配的专属能力。</p>';
  submit.disabled = !passed || !capabilities.length;
}

async function submitHeldOut() {
  const task = state.currentTask;
  if (!task?.id || $('#submit-held-out')?.disabled) return;
  const matchedCapabilities = $$('[data-held-out-capability]:checked').map((item) => item.dataset.heldOutCapability);
  const button = $('#submit-held-out');
  const stateLabel = $('#held-out-submit-state');
  button.disabled = true;
  button.textContent = '正在生成独立验收结果…';
  stateLabel.textContent = '正在计算';
  try {
    const response = await api('/api/runtime/release-validation/from-task', {
      method: 'POST',
      body: JSON.stringify({ taskId: task.id, matchedCapabilities }),
    });
    state.releaseValidation = response;
    state.workEvaluation = response.evaluation || state.workEvaluation;
    renderReleaseValidation();
    renderWorkCapability();
    renderHeldOutSubmit(task);
    const suite = response.heldOutEvaluation || {};
    const passed = suite.status === 'pass';
    const coverage = suite.coverage || {};
    stateLabel.textContent = passed ? 'G7 已通过' : `${coverage.validated || 0}/${coverage.required || 0} 已验证`;
    stateLabel.className = `pill ${passed ? 'success' : 'neutral'}`;
    button.textContent = passed ? '已完成 G7 验收' : '提交本次任务作为 G7 验收';
    button.disabled = passed;
    showToast(passed ? '全部核心能力均已通过独立任务验收，发布状态已更新。' : `本次任务已登记，核心能力覆盖 ${coverage.validated || 0}/${coverage.required || 0}。`, 'success');
  } catch (error) {
    button.disabled = false;
    button.textContent = '提交本次任务作为 G7 验收';
    stateLabel.textContent = '提交失败';
    stateLabel.className = 'pill warning';
    showToast(error.message, 'error');
  }
}

async function handleCoverageGapAction(button) {
  const gapId = button.dataset.gapId;
  const action = button.dataset.gapAction;
  if (!gapId || !action || button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在保存…';
  try {
    await api(`/api/runtime/coverage-gaps/${encodeURIComponent(gapId)}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
    state.coverageGaps = await api('/api/runtime/coverage-gaps');
    renderCoverageGaps();
    showToast('缺口处理状态已保存。', 'success');
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    showToast(error.message, 'error');
  }
}

function fillConfig() {
  const runtime = state.health?.runtime || {};
  const workspace = state.health?.workspace || {};
  $('#base-url').value = runtime.baseUrl || '';
  $('#model-name').value = runtime.model || '';
  $('#api-key').value = '';
  $('#workspace-root').value = workspace.root || '';
  $('#allow-write').checked = Boolean(workspace.allowWrite);
  $('#allow-delete').checked = Boolean(workspace.allowDelete);
  $('#allow-command').checked = Boolean(workspace.allowCommand);
  $('#allow-git-write').checked = Boolean(workspace.allowGitWrite);
  $('#allow-network').checked = Boolean(workspace.allowNetwork);
}

function renderInstallation() {
  const installation = state.installation || state.health?.installation;
  const stateLabel = $('#installation-state');
  const detail = $('#installation-detail');
  if (!installation) {
    stateLabel.textContent = '未读取';
    stateLabel.className = 'pill neutral';
    detail.textContent = '未能读取安装状态。刷新页面后会重新检查。';
    return;
  }
  const node = installation.node || {};
  const dependencies = installation.dependencies || {};
  const launch = installation.launch || {};
  stateLabel.textContent = installation.ready ? '可直接使用' : '需要 Node.js';
  stateLabel.className = `pill ${installation.ready ? 'success' : 'warning'}`;
  detail.textContent = `${dependencies.installCommand || '无需 npm install'}。当前 Node.js：${node.version || '未检测到'}（最低 ${node.minimum || '18.0.0'}）。${launch.manual || '请使用包内启动文件。'} 首次固定安装可运行 ${launch.oneClickInstall || 'install-and-start.cmd'}；能力包目录可只读，任务记录按当前用户独立保存。`;
}

function renderCodexLink() {
  const link = state.codexLink;
  const stateLabel = $('#codex-link-state');
  const detail = $('#codex-link-detail');
  const button = $('#connect-codex');
  if (!link) {
    stateLabel.textContent = '正在检查';
    stateLabel.className = 'pill neutral';
    detail.textContent = '正在检查当前 Codex 本机配置。';
    return;
  }
  if (link.applied) {
    stateLabel.textContent = '已自动接入';
    stateLabel.className = 'pill success';
    detail.textContent = `已接入当前 Codex：模型 ${link.runtime?.model || link.model}，接口类型 ${link.runtime?.wireApi === 'responses' ? 'Responses' : 'Chat Completions'}，${link.hasApiKey ? '密钥已在本机内存提供' : '未找到密钥'}。`;
    button.textContent = '重新连接当前 Codex';
    return;
  }
  if (link.detected) {
    stateLabel.textContent = '已找到配置';
    stateLabel.className = 'pill neutral';
    detail.textContent = `已找到当前 Codex：模型 ${link.model}，接口类型 ${link.wireApi === 'responses' ? 'Responses' : 'Chat Completions'}，${link.hasApiKey ? '已找到本机密钥' : '未找到密钥'}。`;
    button.textContent = '连接当前 Codex';
    return;
  }
  stateLabel.textContent = '需要手动设置';
  stateLabel.className = 'pill neutral';
  detail.textContent = link.message || '未找到当前 Codex 配置，可在下方手动填写模型接口。';
  button.textContent = '重新检查当前 Codex';
}

async function connectCurrentCodex({ automatic = false } = {}) {
  const button = $('#connect-codex');
  button.disabled = true;
  try {
    const link = await api('/api/runtime/codex-link', { method: 'POST', body: '{}' });
    state.codexLink = link;
    if (link.applied && state.health) {
      state.health.runtime = link.runtime;
      fillConfig();
      updateReadiness();
      state.models = [];
      renderModelCatalog();
      $('#model-catalog-state').textContent = '已连接当前 Codex，正在读取接口返回的全部模型...';
      loadModels(false).catch((error) => {
        $('#model-catalog-state').textContent = `已接入当前 Codex，但读取模型列表失败：${error.message}`;
      });
    }
    renderCodexLink();
    if (!automatic) showToast(link.applied ? '已接入当前 Codex 配置。' : link.message, link.applied ? 'success' : '');
  } catch (error) {
    state.codexLink = { detected: false, message: `自动连接失败：${error.message}` };
    renderCodexLink();
    if (!automatic) showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function localSessionOptionLabel(session) {
  const stamp = session.modifiedAt ? new Date(session.modifiedAt).toLocaleString('zh-CN') : '时间未知';
  const meaning = [session.domain, session.lifecycle, session.taskChainSize > 1 ? `任务链 ${session.taskChainSize} 条` : '独立会话'].filter(Boolean).join('｜');
  return `${session.title || '未命名本机 Codex 对话'} ｜ ${meaning} ｜ ${stamp} ｜ ${String(session.sessionId || '').slice(0, 8)}`;
}

function renderLocalSessions() {
  const list = $('#local-session-list');
  list.replaceChildren();
  if (!state.localSessions.length) {
    const option = new Option($('#local-session-filter').value.trim() ? '没有匹配的本机 Codex 对话' : '没有发现本机 Codex 对话', '');
    option.disabled = true;
    list.add(option);
  } else {
    for (const session of state.localSessions) {
      const option = new Option(localSessionOptionLabel(session), session.sessionId);
      option.selected = state.selectedLocalSessionIds.has(String(session.sessionId || '').toLowerCase());
      option.title = `${session.title || '未命名本机 Codex 对话'}\n${session.rawTitle || ''}\n${session.domain || ''}｜${session.lifecycle || ''}\n${(session.keywords || []).join('、')}\n${session.sessionId || ''}\n${session.modifiedAt || ''}`;
      list.add(option);
    }
  }
  $('#load-more-local-sessions').hidden = state.localSessionNextOffset === null || state.localSessionNextOffset === undefined;
  updateLocalSessionSelection();
}

function updateLocalSessionSelection() {
  const selectedCount = state.selectedLocalSessionIds.size;
  $('#load-local-sessions').disabled = selectedCount === 0;
  if (state.localSessionTotal) {
    $('#local-session-detail').textContent = selectedCount
      ? `已选择 ${selectedCount} 条本机 Codex 对话。加载后会提取需求阶段、用户纠正、工具和文件证据，并写入下方任务输入框。`
      : `已索引 ${state.localSessionTotal} 条本机 Codex 对话，当前显示 ${state.localSessions.length} 条。搜索会在全部归档中执行。`;
  }
}

async function loadLocalSessions({ force = false, append = false } = {}) {
  const stateLabel = $('#local-session-state');
  const refreshButton = $('#refresh-local-sessions');
  const moreButton = $('#load-more-local-sessions');
  stateLabel.textContent = force ? '正在重新搜索' : '正在搜索';
  stateLabel.className = 'pill neutral';
  refreshButton.disabled = true;
  if (append) moreButton.disabled = true;
  try {
    const params = new URLSearchParams({ limit: '50', offset: String(append ? state.localSessionNextOffset || 0 : 0) });
    const query = $('#local-session-filter').value.trim();
    if (query) params.set('q', query);
    if (force) params.set('refresh', '1');
    const response = await api(`/api/runtime/local-sessions?${params}`);
    const incoming = Array.isArray(response.sessions) ? response.sessions : [];
    state.localSessions = append ? [...state.localSessions, ...incoming] : incoming;
    state.localSessionTotal = Number(response.totalAvailable || response.total || state.localSessions.length);
    state.localSessionNextOffset = response.nextOffset === null || response.nextOffset === undefined ? null : Number(response.nextOffset);
    stateLabel.textContent = state.localSessionTotal ? `已索引 ${state.localSessionTotal} 条` : '未发现对话';
    stateLabel.className = `pill ${state.localSessionTotal ? 'success' : 'neutral'}`;
    renderLocalSessions();
  } catch (error) {
    state.localSessions = [];
    state.localSessionTotal = 0;
    state.localSessionNextOffset = null;
    stateLabel.textContent = '搜索失败';
    stateLabel.className = 'pill warning';
    $('#local-session-list').replaceChildren(new Option('读取本机 Codex 对话失败', ''));
    $('#local-session-detail').textContent = `读取失败：${error.message}`;
  } finally {
    refreshButton.disabled = false;
    moreButton.disabled = false;
  }
}

function localTaskChainMarkup(chain) {
  const sessionIds = Array.isArray(chain.sessionIds) ? chain.sessionIds.map((item) => String(item || '').toLowerCase()).filter(Boolean) : [];
  const meta = [chain.domain || '工程任务', `${Number(chain.sessionCount || sessionIds.length || 1).toLocaleString('zh-CN')} 条会话`, chain.lifecycle || '待理解'].filter(Boolean).join('｜');
  const reasons = (chain.recommendationReasons || []).join('；') || '已根据会话目标、工具和时间顺序归并。';
  return `<article class="local-task-chain-item"><div><strong>${escapeHtml(chain.title || '未命名任务链')}</strong><span>${escapeHtml(meta)}</span><small>${escapeHtml(reasons)}</small></div><button type="button" class="secondary-button" data-local-chain-ids="${escapeHtml(sessionIds.join(','))}">选择整条链</button></article>`;
}

function selectLocalTaskChain(sessionIds) {
  const ids = [...new Set((sessionIds || []).map((item) => String(item || '').toLowerCase()).filter(Boolean))];
  if (!ids.length) return;
  ids.forEach((id) => state.selectedLocalSessionIds.add(id));
  for (const option of $('#local-session-list').options) {
    if (option.value && state.selectedLocalSessionIds.has(String(option.value).toLowerCase())) option.selected = true;
  }
  updateLocalSessionSelection();
  $('#local-session-detail').textContent = `已选择完整任务链中的 ${ids.length.toLocaleString('zh-CN')} 条会话；其中未显示在当前页的会话也会一并加载。`;
  showToast(`已选择完整任务链：${ids.length.toLocaleString('zh-CN')} 条会话。`, 'success');
}

function renderLocalTaskChains() {
  const root = $('#local-task-chain-list');
  const chains = state.localTaskChains || [];
  $('#local-task-chain-count').textContent = state.localTaskChainAvailable
    ? `当前显示 ${chains.length.toLocaleString('zh-CN')} / ${state.localTaskChainTotal.toLocaleString('zh-CN')} 条匹配任务链（本机共 ${state.localTaskChainAvailable.toLocaleString('zh-CN')} 条）。`
    : '没有发现可归并的完整任务链。';
  root.innerHTML = chains.length ? chains.map(localTaskChainMarkup).join('') : '<p class="muted">没有与搜索条件匹配的任务链。</p>';
  $('#load-more-local-task-chains').hidden = state.localTaskChainNextOffset === null;
  $('#load-more-local-task-chains').textContent = state.localTaskChainNextOffset === null ? '已显示全部匹配任务链' : `加载更多任务链（还有 ${(state.localTaskChainTotal - chains.length).toLocaleString('zh-CN')} 条）`;
  $$('[data-local-chain-ids]', root).forEach((button) => button.addEventListener('click', () => selectLocalTaskChain(String(button.dataset.localChainIds || '').split(','))));
}

async function loadLocalTaskChains({ force = false, append = false } = {}) {
  const button = $('#load-more-local-task-chains');
  if (append) button.disabled = true;
  try {
    const query = $('#local-task-chain-filter').value.trim();
    const offset = append ? Number(state.localTaskChainNextOffset || 0) : 0;
    const params = new URLSearchParams({ limit: '20', offset: String(offset) });
    if (query) params.set('q', query);
    if (force) params.set('refresh', '1');
    const response = await api(`/api/runtime/task-chains?${params}`);
    const incoming = Array.isArray(response.taskChains) ? response.taskChains : [];
    state.localTaskChains = append ? [...state.localTaskChains, ...incoming] : incoming;
    state.localTaskChainTotal = Number(response.total || state.localTaskChains.length);
    state.localTaskChainAvailable = Number(response.totalAvailable || response.total || state.localTaskChains.length);
    state.localTaskChainNextOffset = response.nextOffset === null || response.nextOffset === undefined ? null : Number(response.nextOffset);
    renderLocalTaskChains();
  } catch (error) {
    $('#local-task-chain-count').textContent = `读取任务链目录失败：${error.message}`;
    $('#local-task-chain-list').innerHTML = '<p class="muted">任务链目录暂时不可用。</p>';
  } finally {
    button.disabled = false;
  }
}

async function loadSelectedLocalSessions() {
  const button = $('#load-local-sessions');
  const sessionIds = [...state.selectedLocalSessionIds];
  if (!sessionIds.length) return showToast('请先选择至少一条本机 Codex 对话。');
  button.disabled = true;
  $('#local-session-detail').textContent = '正在读取所选对话并生成任务上下文...';
  try {
    const response = await api('/api/runtime/local-sessions/load', { method: 'POST', body: JSON.stringify({ sessionIds }) });
    state.loadedLocalSessions = response.sessions || [];
    state.loadedLocalContext = { ...(response.context || {}), sessions: state.loadedLocalSessions };
    const taskInput = $('#task-input');
    taskInput.value = response.taskPrefill || taskInput.value;
    const stageCount = Number(state.loadedLocalContext?.stageCount || 0);
    $('#local-session-detail').textContent = `已加载 ${state.loadedLocalSessions.length} 条对话和 ${stageCount} 个需求阶段。输入框显示完整索引；开始执行时会把全部索引与最新阶段证据自动交给 Agent。`;
    showToast(`已加载 ${state.loadedLocalSessions.length} 条本机 Codex 对话。`, 'success');
    $('#task-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    taskInput.focus();
  } catch (error) {
    $('#local-session-detail').textContent = `加载失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    updateLocalSessionSelection();
  }
}

function conversationList(items, render, empty = '暂无可展示内容。') {
  return Array.isArray(items) && items.length ? items.map(render).join('') : `<p class="muted">${escapeHtml(empty)}</p>`;
}

function phaseLabel(stage, title = '') {
  const number = Number(stage);
  const prefix = Number.isFinite(number) && number > 0 ? `P${number}｜` : '';
  const value = String(title || '').trim();
  if (/^P\d+｜/.test(value)) return value;
  return `${prefix}${value || '原会话要求'}`;
}

function sourcePhaseLabels(stages) {
  const catalog = new Map((state.uiBlueprint?.sourceSummary?.sourceStages || []).map((item) => [Number(item.index), item.title]));
  return (Array.isArray(stages) ? stages : [])
    .map((stage) => phaseLabel(stage, catalog.get(Number(stage))))
    .filter(Boolean);
}

function conversationActionMarkup(item) {
  const sources = sourcePhaseLabels(item.sourceStages);
  return '<button type="button" class="conversation-action" data-conversation-action="' + escapeHtml(item.id) + '"><strong>' + escapeHtml(item.title) + '</strong><b>' + escapeHtml(item.action || '执行该阶段') + '</b><span>' + escapeHtml(item.description) + '</span>' + (sources.length ? '<em class="conversation-source">来自：' + escapeHtml(sources.join('；')) + '</em>' : '') + '</button>';
}

function conversationInputMarkup(item) {
  return '<li><strong>' + escapeHtml(item.label) + '</strong><span>' + escapeHtml(item.help) + '</span><em>' + (item.required === false ? '可选' : '必填') + '</em></li>';
}

function conversationDeliverableMarkup(item) {
  return '<li><strong>' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(item.description) + '</span></li>';
}

function conversationCorrectionMarkup(item) {
  return '<li><strong>' + escapeHtml(phaseLabel(item.stage, item.title)) + '</strong><span>' + escapeHtml(item.instruction) + '</span></li>';
}

function primaryRecommendation() {
  const priorities = Array.isArray(state.recommendation?.priorities) ? state.recommendation.priorities : [];
  return priorities.find((item) => item && item.title) || null;
}

function recommendationTaskText(item) {
  const files = Array.isArray(item.affectedFiles) && item.affectedFiles.length ? item.affectedFiles.join('、') : '当前没有已关联的项目文件；先检查工作区与原会话证据。';
  const tools = Array.isArray(item.observedTools) && item.observedTools.length ? item.observedTools.join('、') : '当前没有记录到固定工具；先按任务实际情况取证。';
  const reasons = Array.isArray(item.why) && item.why.length ? item.why.join('；') : '来自原会话的已排序需求阶段。';
  return [
    `${item.level || 'P1'} 优先任务｜${item.title || '会话蒸馏建议'}`,
    `阶段要求：${item.purpose || '完成当前优先级阶段。'}`,
    `为什么优先：${reasons}`,
    `现在建议：${item.nextAction || '先回查证据，再执行并验证。'}`,
    `预期交付：${item.expectedOutput || '可复核的阶段结果。'}`,
    `关联文件：${files}`,
    `原会话实际工具：${tools}`,
  ].join('\n\n');
}

function prefillRecommendedTask(item) {
  if (!item) return;
  const taskInput = $('#task-input');
  taskInput.value = recommendationTaskText(item);
  state.mode = `${item.level || 'P1'} 优先建议`;
  $$('#mode-switch button').forEach((node) => node.classList.remove('active'));
  switchView('execute');
  $('#task-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  taskInput.focus();
  showToast(`已写入 ${item.level || 'P1'} 优先任务。`, 'success');
}

function priorityRecommendationMarkup() {
  const item = primaryRecommendation();
  const summary = state.recommendation?.summary || {};
  if (!item) return '<section class="priority-guidance priority-guidance-empty"><div><p class="section-kicker">系统优先级建议</p><h4>当前没有可排序的阶段</h4><p>选择完整会话或关联项目后，系统会基于最新纠正、文件变更、实际工具和产物证据生成下一步建议。</p></div><button type="button" class="secondary-button" data-recommendation-view>查看蒸馏证据</button></section>';
  const sourceStages = Array.isArray(item.sourceStages) && item.sourceStages.length ? item.sourceStages.join('、') : '未记录来源阶段';
  const files = Array.isArray(item.affectedFiles) && item.affectedFiles.length ? `${item.affectedFiles.length} 个关联文件` : '暂未关联文件';
  const tools = Array.isArray(item.observedTools) && item.observedTools.length ? `${item.observedTools.length} 项实际工具` : '暂未记录工具';
  return [
    '<section class="priority-guidance" aria-label="系统优先级建议">',
    '<div class="priority-guidance-level"><span>', escapeHtml(item.level || 'P1'), '</span><strong>第 ', escapeHtml(item.rank || 1), ' 优先</strong><small>', escapeHtml(item.confidence?.level || '待确认'), ' · ', escapeHtml(item.score || 0), '/100</small></div>',
    '<div class="priority-guidance-main"><p class="section-kicker">系统建议先做这件事</p><h4>', escapeHtml(item.title || '会话蒸馏建议'), '</h4><p>', escapeHtml(compact(item.nextAction || item.purpose || summary.headline || '先回查会话证据，再执行并验证。', 260)), '</p><small>依据：', escapeHtml(sourceStages), '；', escapeHtml(files), '；', escapeHtml(tools), '。</small></div>',
    '<div class="priority-guidance-actions"><button type="button" class="primary-button priority-apply" data-recommendation-action>按建议填入任务</button><button type="button" class="secondary-button" data-recommendation-view>查看排序依据</button></div>',
    '</section>',
  ].join('');
}

function buildConversationBrief(ui) {
  const visual = ui.visual || {};
  return [
    '<div class="brief-header"><div><p class="section-kicker">从完整对话生成</p><h3>', escapeHtml(ui.identity.title || ui.identity.packageName || '会话专属能力'), '</h3><p>', escapeHtml(visual.description || ui.purpose || ''), '</p></div><span class="brief-method">', escapeHtml(ui.generation?.label || '会话结构提炼'), '</span></div>',
    priorityRecommendationMarkup(),
    '<div class="brief-grid">',
    '<section><h4>这次要完成什么</h4><p>', escapeHtml(ui.purpose || ''), '</p><small>面向：', escapeHtml(ui.audience || '当前会话的复用者'), '</small></section>',
    '<section><h4>开始前需要提供</h4><ul>', conversationList(ui.inputs, conversationInputMarkup), '</ul></section>',
    '<section><h4>会生成哪些结果</h4><ul>', conversationList(ui.deliverables, conversationDeliverableMarkup), '</ul></section>',
    '<section><h4>必须继承的修正</h4><ol>', conversationList(ui.corrections, conversationCorrectionMarkup, '未识别到后续修正；仍以当前输入为最高优先级。'), '</ol></section>',
    '</div>',
    '<section class="brief-actions"><div><h4>可以直接执行的会话能力</h4><p>每项都绑定原会话的 P 阶段。点击后会写入阶段目标、做法和预期交付物；完整列表在“会话蒸馏”。</p></div><div class="conversation-action-list">', conversationList(ui.capabilities, conversationActionMarkup), '</div></section>',
  ].join('');
}

function specializedTaskText(item) {
  return [
    item.title,
    `阶段目标：${item.goal || '完成原会话确认的阶段目标。'}`,
    `执行做法：${item.approach || '先回查会话证据，再执行并核对结果。'}`,
    `预期交付：${item.deliverable || '可复核的阶段结果。'}`,
    `原会话证据：${item.evidence || '对应原会话需求阶段。'}`,
  ].join('\n\n');
}

function prefillSpecializedTask(item) {
  const taskInput = $('#task-input');
  if (!taskInput || !item) return;
  taskInput.value = specializedTaskText(item);
  state.mode = item.action || '会话专属执行';
  $$('#mode-switch button').forEach((node) => node.classList.remove('active'));
  switchView('execute');
  $('#task-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  taskInput.focus();
}

function reorderNavigation(order = []) {
  const root = $('.nav-list');
  if (!root || !Array.isArray(order) || !order.length) return;
  const nodes = new Map($$('.nav-item', root).map((item) => [item.dataset.view, item]));
  [...order, ...nodes.keys()].filter((value, index, values) => values.indexOf(value) === index).forEach((view) => {
    const node = nodes.get(view);
    if (node) root.appendChild(node);
  });
  $$('.nav-item', root).forEach((item, index) => {
    const number = $('.nav-index', item);
    if (number) number.textContent = String(index + 1).padStart(2, '0');
  });
}

function updateResultLabels(labels = {}) {
  const targets = {
    result: '#run-result', changes: '#change-list', verification: '#verification-list', processes: '#process-list', checkpoints: '#checkpoint-list',
  };
  Object.entries(targets).forEach(([key, selector]) => {
    const heading = $(selector)?.closest('.result-block')?.querySelector('h4');
    if (heading && labels[key]) heading.textContent = labels[key];
  });
}

function renderAdaptiveWorkspace(ui) {
  const experience = ui.experience || {};
  const visual = ui.visual || {};
  const executeView = $('.view[data-view-panel="execute"]');
  if (!executeView || !experience.layout) return;
  executeView.dataset.experienceLayout = experience.layout;
  document.body.dataset.uiLayout = experience.layout;
  document.body.dataset.uiDensity = experience.density || 'comfortable';

  let root = $('#adaptive-workspace');
  if (!root) {
    root = document.createElement('section');
    root.id = 'adaptive-workspace';
    root.className = 'adaptive-workspace';
    executeView.querySelector('.page-heading')?.insertAdjacentElement('afterend', root);
  }
  const signals = (visual.signals || []).slice(0, 4);
  const modules = (experience.modules || []).slice(0, 7);
  const quickStarts = (experience.quickStarts || []).slice(0, 4);
  const deliverables = (experience.deliverablePreview || []).slice(0, 3);
  root.dataset.layout = experience.layout;
  root.innerHTML = `
    <header class="adaptive-hero">
      <div class="adaptive-hero-copy">
        <p class="section-kicker">${escapeHtml(experience.hero?.eyebrow || visual.label || '专属界面')}</p>
        <h3>${escapeHtml(ui.identity?.title || ui.identity?.packageName || '会话专属工作台')}</h3>
        <p>${escapeHtml(experience.hero?.summary || visual.description || ui.purpose || '')}</p>
      </div>
      <div class="adaptive-identity">
        <span class="adaptive-family-mark">${escapeHtml(visual.label || '专属工作台')}</span>
        <strong>${Math.round(Number(visual.confidence || 0.6) * 100)}%</strong>
        <small>界面特征匹配度</small>
      </div>
    </header>
    <div class="adaptive-signal-strip" aria-label="界面生成依据">
      <strong>生成依据</strong>
      ${signals.length ? signals.map((item) => `<span>${escapeHtml(item.label)} · ${Number(item.count || 0)} 处</span>`).join('') : '<span>会话目标与项目证据</span>'}
      <button class="adaptive-rationale" type="button" aria-expanded="false">为什么这样生成</button>
      <p class="adaptive-rationale-copy" hidden>${escapeHtml(experience.rationale || visual.rationale || '界面根据当前能力包的目标、工具和产物生成。')}</p>
    </div>
    <div class="adaptive-workspace-body">
      <section class="experience-flow" aria-labelledby="experience-flow-title">
        <div class="adaptive-section-heading"><span>专属工作流</span><strong id="experience-flow-title">${escapeHtml(modules.length)} 个关键工作模块</strong></div>
        <ol class="experience-modules">
          ${modules.map((item) => `<li data-module="${escapeHtml(item.id)}"><span class="module-order">${String(item.order || 0).padStart(2, '0')}</span><div><small>${escapeHtml(item.stage)}</small><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></div></li>`).join('')}
        </ol>
      </section>
      <aside class="experience-actions" aria-labelledby="experience-actions-title">
        <div class="adaptive-section-heading"><span>直接开始</span><strong id="experience-actions-title">推荐任务</strong></div>
        <div class="experience-quick-list">
          ${quickStarts.length ? quickStarts.map((item, index) => `<button type="button" data-experience-quick="${index}"><span>${escapeHtml(item.phase || `P${index + 1}`)}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(compact(item.prompt, 90))}</small></button>`).join('') : `<button type="button" data-experience-quick="0"><span>P1</span><strong>${escapeHtml(experience.task?.title || '开始专属任务')}</strong><small>${escapeHtml(compact(ui.purpose, 90))}</small></button>`}
        </div>
        ${deliverables.length ? `<div class="experience-deliverables"><span>预计交付</span>${deliverables.map((item) => `<strong>${escapeHtml(item.title)}</strong>`).join('')}</div>` : ''}
      </aside>
    </div>`;

  $('.adaptive-rationale', root)?.addEventListener('click', (event) => {
    const detail = $('.adaptive-rationale-copy', root);
    const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
    event.currentTarget.setAttribute('aria-expanded', String(!expanded));
    event.currentTarget.textContent = expanded ? '为什么这样生成' : '收起生成依据';
    if (detail) detail.hidden = expanded;
  });
  $$('[data-experience-quick]', root).forEach((button) => button.addEventListener('click', () => {
    const item = quickStarts[Number(button.dataset.experienceQuick)] || { label: experience.task?.title, prompt: ui.purpose };
    const specialization = (ui.specializations || []).find((candidate) => candidate.id === item.id);
    if (specialization) return prefillSpecializedTask(specialization);
    const taskInput = $('#task-input');
    taskInput.value = `${item.label || '专属任务'}\n\n${item.prompt || ui.purpose || ''}`.trim();
    taskInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    taskInput.focus();
  }));
}

function renderConversationUi() {
  const ui = state.uiBlueprint;
  if (!ui || !ui.identity) return;
  const visual = ui.visual || {};
  const experience = ui.experience || {};
  const navigation = ui.navigation || {};
  document.body.dataset.uiFamily = visual.family || 'workflow-desk';
  const familyMarks = { 'engineering-console': '工', 'research-studio': '研', 'data-lab': '数', 'document-studio': '稿', 'content-operations': '策', 'automation-control': '控', 'workflow-desk': '能' };
  const brandMark = $('.brand-mark');
  if (brandMark) brandMark.textContent = familyMarks[visual.family] || '能';
  for (const [name, value] of Object.entries({
    '--conversation-accent': visual.accent,
    '--conversation-accent-strong': visual.accentStrong,
    '--conversation-accent-soft': visual.accentSoft,
    '--conversation-contrast': visual.contrast,
    '--conversation-surface': visual.surface,
  })) if (value) document.documentElement.style.setProperty(name, value);
  renderAdaptiveWorkspace(ui);
  reorderNavigation(experience.navigationOrder);
  const generatedName = state.health?.package?.name || state.capabilities?.package?.name || ui.identity.packageName || ui.identity.title || '会话能力包';
  const distilledSummary = state.distillation?.conversationDistillation?.summary || state.capabilities?.contract?.plainSummary || '';
  const purpose = String(ui.purpose || '').trim();
  document.title = `${generatedName} - 独立操作界面`;
  $('#package-name').textContent = generatedName;
  $('#package-summary').textContent = purpose.length >= 30 ? purpose : (distilledSummary || '此页面由完整会话的目标、产出与后续纠正生成。');
  const executeHeading = $('.view[data-view-panel="execute"] .page-heading h2');
  if (executeHeading) executeHeading.textContent = ui.identity.subtitle || '会话专属工作台';
  const labels = { execute: navigation.execute, features: navigation.features, alignment: navigation.alignment, evidence: navigation.evidence, history: navigation.history, guide: navigation.guide };
  Object.entries(labels).forEach(([view, label]) => {
    const node = $(`.nav-item[data-view="${view}"] span:last-child`);
    if (node && label) node.textContent = label;
  });
  const taskTitle = $('#task-title');
  if (taskTitle) taskTitle.textContent = experience.task?.title || ui.primaryAction?.label || '开始会话专属任务';
  const taskInput = $('#task-input');
  if (taskInput && ui.taskPlaceholder) taskInput.placeholder = ui.taskPlaceholder;
  const start = $('#start-task');
  if (start) start.lastChild.textContent = experience.hero?.primaryLabel || ui.primaryAction?.label || '开始执行';
  const modes = experience.task?.modes || [];
  $$('#mode-switch button').forEach((button, index) => {
    if (!modes[index]) return;
    button.dataset.mode = modes[index];
    button.textContent = modes[index];
    if (index === 0) state.mode = modes[index];
  });
  updateResultLabels(experience.resultLabels);
  const taskBrief = $('.task-brief span');
  if (taskBrief && experience.modules?.length) taskBrief.textContent = experience.modules.map((item) => item.title).join(' → ');
  let root = $('#conversation-brief');
  if (!root) {
    root = document.createElement('details');
    root.id = 'conversation-brief';
    root.className = 'conversation-brief conversation-brief-disclosure';
    root.innerHTML = `
      <summary class="conversation-brief-summary">
        <span class="conversation-brief-summary-copy">
          <span class="section-kicker">任务依据</span>
          <strong>查看原会话蒸馏与项目证据</strong>
          <small>包含目标、优先级建议、可复用能力和来源阶段</small>
        </span>
        <span class="conversation-brief-summary-state">按需展开</span>
      </summary>
      <div class="conversation-brief-body"></div>`;
    $('.view[data-view-panel="execute"] .page-heading').insertAdjacentElement('afterend', root);
  }
  const conversationBriefBody = $('.conversation-brief-body', root) || root;
  conversationBriefBody.innerHTML = buildConversationBrief(ui);
  renderSpecializations();
  const recommendationAction = $('[data-recommendation-action]', root);
  if (recommendationAction) recommendationAction.addEventListener('click', () => prefillRecommendedTask(primaryRecommendation()));
  const recommendationView = $('[data-recommendation-view]', root);
  if (recommendationView) recommendationView.addEventListener('click', () => switchView('distillation'));
  $$('.conversation-action', root).forEach((button) => button.addEventListener('click', () => {
    const capability = (ui.capabilities || []).find((item) => item.id === button.dataset.conversationAction);
    if (!capability) return;
    const specialization = (ui.specializations || []).find((item) => item.id === capability.id);
    if (specialization) return prefillSpecializedTask(specialization);
    const sourceStages = sourcePhaseLabels(capability.sourceStages);
    const sourceHint = sourceStages.length ? `请遵循原会话的语义阶段：${sourceStages.join('；')}。` : '';
    taskInput.value = `${capability.title}：${capability.description}\n${sourceHint}`.trim();
    state.mode = capability.action || '会话专属执行';
    $$('#mode-switch button').forEach((item) => item.classList.remove('active'));
    $('#task-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    taskInput.focus();
  }));
}

async function loadConversationUi() {
  try {
    state.uiBlueprint = await api('/capability-ui.json');
    renderConversationUi();
  } catch {
    // Older packages do not contain an interface blueprint; keep their original UI usable.
  }
}

function renderOverview() {
  const capabilities = state.capabilities || {};
  const contract = capabilities.contract || {};
  const statistics = capabilities.statistics || state.distillation?.statistics || {};
  const packageInfo = capabilities.package || state.health?.package || {};
  document.title = `${packageInfo.name || '本地能力执行台'} - 独立操作界面`;
  $('#package-name').textContent = packageInfo.name || '本地能力执行台';
  $('#package-summary').textContent = contract.plainSummary || '从完整原对话重建的本地执行型人工智能。';
  $('#tool-count').textContent = `${(contract.tools || []).length} 项工具`;
  $('#source-count').textContent = `${Number(statistics.sourceRecords || 0).toLocaleString('zh-CN')} 条原始记录`;
  $('#guide-summary').textContent = contract.plainSummary || '';
  $('#principle-list').innerHTML = (contract.operatingPrinciples || []).map((item) => `<div class="bullet-item">${escapeHtml(item)}</div>`).join('');
  $('#limit-list').innerHTML = (contract.limits || []).map((item) => `<div class="bullet-item">${escapeHtml(item)}</div>`).join('');
  $('#acceptance-list').innerHTML = (contract.acceptanceMatrix || []).map((item) => `<article class="acceptance-item"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.passCondition)}</p></article>`).join('');
}

function metric(label, value) {
  return `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderFeatures() {
  const contract = state.capabilities?.contract || {};
  const tools = state.tools.length ? state.tools : (contract.tools || []);
  const statistics = state.capabilities?.statistics || {};
  const available = tools.filter((tool) => tool.available !== false).length;
  $('#capability-stats').innerHTML = [
    metric('能力工具', tools.length), metric('当前可用', available), metric('原始记录', Number(statistics.sourceRecords || 0).toLocaleString('zh-CN')),
    metric('需求阶段', statistics.stages || 0), metric('原工具调用', Number(statistics.toolCalls || 0).toLocaleString('zh-CN')), metric('用户纠正', statistics.corrections || 0),
  ].join('');
  const groups = Object.groupBy ? Object.groupBy(tools, (tool) => tool.category || '其他') : tools.reduce((result, tool) => { const key = tool.category || '其他'; (result[key] ||= []).push(tool); return result; }, {});
  $('#feature-groups').innerHTML = Object.entries(groups).map(([group, items]) => `
    <section class="feature-group">
      <div class="feature-group-header"><h3>${escapeHtml(group)}</h3><span>${items.length} 项功能</span></div>
      <table class="feature-table"><thead><tr><th>功能</th><th>直白说明</th><th>需要权限</th><th>当前状态</th></tr></thead><tbody>
        ${items.map((tool) => `<tr><td>${escapeHtml(tool.label || tool.name)}</td><td>${escapeHtml(tool.description)}</td><td>${escapeHtml(tool.permission || '始终开放')}</td><td><span class="availability ${tool.available === false ? 'off' : ''}">${tool.available === false ? '权限未开启' : '可以使用'}</span></td></tr>`).join('')}
      </tbody></table>
    </section>`).join('');
}

function renderAlignment() {
  const alignment = state.alignment || state.capabilities?.contract?.codexAlignment || {};
  $('#alignment-title').textContent = alignment.title || 'Codex 工程能力对齐图';
  $('#alignment-summary').textContent = alignment.description || '正在读取能力包对齐说明。';
  $('#alignment-groups').innerHTML = (alignment.domains || []).map((item) => `<article class="alignment-item"><div class="alignment-header"><h3>${escapeHtml(item.name)}</h3><span class="availability ${item.status === '已实现' ? '' : 'off'}">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.description)}</p></article>`).join('') || '<p class="muted">没有可展示的对齐信息。</p>';
}

function renderDistillation() {
  const data = state.distillation || {};
  const stats = data.statistics || {};
  $('#evidence-stats').innerHTML = [
    metric('原始记录', Number(stats.sourceRecords || 0).toLocaleString('zh-CN')), metric('需求阶段', stats.stages || 0), metric('消息', Number(stats.messages || 0).toLocaleString('zh-CN')),
    metric('工具调用', Number(stats.toolCalls || 0).toLocaleString('zh-CN')), metric('文件变更', Number(stats.fileChanges || 0).toLocaleString('zh-CN')), metric('后续纠正', stats.corrections || 0),
  ].join('');
  $('#correction-list').innerHTML = (data.corrections || []).length ? data.corrections.map((item, index) => `
    <article class="numbered-item"><span>${index + 1}</span><div><h4>${escapeHtml(phaseLabel(item.stage, item.title || '后续纠正'))}</h4><p>${escapeHtml(compact(item.request, 1600))}</p></div></article>`).join('') : '<p class="muted">没有识别到明确的后续纠正，执行时以当前任务为最高优先级。</p>';
  $('#workflow-list').innerHTML = (data.improvedWorkflow || []).map((item) => `
    <article class="workflow-step"><div class="order">${escapeHtml(item.order)}</div><div><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description)}</p></div></article>`).join('');
  renderSpecializations();
  renderSourceEvidence();
}

function renderSourceEvidence() {
  const sessions = Array.isArray(state.sourceSessions)
    ? state.sourceSessions
    : (Array.isArray(state.distillation?.sourceSessions) ? state.distillation.sourceSessions : (state.capabilities?.sourceSessions || []));
  const sourceRoot = $('#source-session-list');
  if (sourceRoot) {
    sourceRoot.innerHTML = sessions.length
      ? sessions.map((source, index) => `<article class="source-session-item"><div class="source-session-index">${index + 1}</div><div><h4>${escapeHtml(source.title || source.sessionId || '未命名会话')}</h4><p>会话编号：<code>${escapeHtml(source.sessionId || '未提供')}</code>；记录 ${Number(source.recordCount || 0).toLocaleString('zh-CN')} 条；事件 ${Number(source.eventCount || 0).toLocaleString('zh-CN')} 条。</p><small>${escapeHtml(source.sourcePath || '未提供来源路径')}<br>SHA-256：${escapeHtml(source.sha256 || '未提供')}</small></div></article>`).join('')
      : '<p class="muted">本能力包没有返回联合会话清单。</p>';
  }
  if (sourceRoot && sessions.some((source) => source.authorityRank)) {
    sourceRoot.querySelectorAll('.source-session-index').forEach((element, index) => {
      const rank = sessions[index]?.authorityRank;
      if (rank) element.textContent = `优先 ${rank}`;
    });
    sourceRoot.insertAdjacentHTML('afterbegin', '<p class="source-authority-note">来源优先级按各会话最后一条用户要求排序；排名 1 的会话是跨会话冲突时优先采用的最新要求。</p>');
  }
  renderProjectPortfolio();
  renderProjectUnderstanding();
  const project = state.projectEvidence || state.distillation?.projectEvidence || state.capabilities?.projectEvidence || null;
  const summaryRoot = $('#project-evidence-summary');
  const groupsRoot = $('#project-file-groups');
  if (!summaryRoot || !groupsRoot) return;
  if (!project?.project) {
    summaryRoot.innerHTML = '<p class="muted">生成时未指定项目文件夹；本能力包仍保留每个会话的完整证据。</p>';
    groupsRoot.innerHTML = '';
    return;
  }
  const summary = project.summary || {};
  const git = project.git || {};
  summaryRoot.innerHTML = `<div class="project-evidence-heading"><div><h4>${escapeHtml(project.project.name || '未命名项目')}</h4><p>${escapeHtml(project.project.root || '未提供项目路径')}</p></div><span class="pill ${git.available ? '' : 'neutral'}">${git.available ? `Git：${escapeHtml(git.branch || '已识别')}` : '未识别 Git'}</span></div><div class="project-evidence-metrics"><span><strong>${Number(summary.scannedFiles || 0).toLocaleString('zh-CN')}</strong>扫描文件</span><span><strong>${Number(summary.modifiedFiles || 0).toLocaleString('zh-CN')}</strong>修改/新增</span><span><strong>${Number(summary.generatedFiles || 0).toLocaleString('zh-CN')}</strong>生成产物</span><span><strong>${Number(summary.linkedFiles || 0).toLocaleString('zh-CN')}</strong>会话关联</span><span><strong>${Number(summary.originalFiles || 0).toLocaleString('zh-CN')}</strong>原始版本</span></div>`;
  if (summary.priorityFiles || summary.scanTruncated) {
    summaryRoot.insertAdjacentHTML('beforeend', `<p class="project-evidence-note">优先证据 ${Number(summary.priorityFiles || 0).toLocaleString('zh-CN')} 个：会话直接关联文件和 Git 变更始终优先纳入；${summary.scanTruncated ? '普通目录扫描达到上限，但优先文件仍已保留。' : '其余文件按项目结构补充。'}</p>`);
  }
  const groups = [
    ['modifiedFiles', '当前已修改或新增文件', '这些文件在会话工具轨迹、Git 差异或当前项目快照中被识别为变更对象。'],
    ['generatedFiles', '生成产物', '这些文件按项目命名、扩展名和会话动作判断为输出或构建产物。'],
    ['originalFiles', 'Git 原始版本', '这些内容来自 Git HEAD 基线，用来和当前文件比较。'],
  ];
  groupsRoot.innerHTML = groups.map(([key, title, help]) => {
    const items = Array.isArray(project[key]) ? project[key].slice(0, 80) : [];
    return `<section class="project-file-group"><div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(help)}</p></div>${items.length ? `<ul>${items.map((item) => `<li><code>${escapeHtml(item.path || item.file || item.relativePath || '未命名文件')}</code><span>${escapeHtml(item.status || item.action || item.kind || '已记录')}</span></li>`).join('')}</ul>` : '<p class="muted">没有该类文件证据。</p>'}</section>`;
  }).join('');
}

function renderProjectPortfolio() {
  const root = $('#project-portfolio');
  if (!root) return;
  const portfolio = state.projectPortfolio || state.distillation?.projectPortfolio || state.capabilities?.projectPortfolio || null;
  if (!portfolio) {
    root.innerHTML = '<p class="muted">没有可展示的项目归属。会话仍会完整保留，选择工作区后可补充项目证据。</p>';
    return;
  }
  const projects = Array.isArray(portfolio.projects) ? portfolio.projects : [];
  const assignments = Array.isArray(portfolio.sessionAssignments) ? portfolio.sessionAssignments : [];
  root.innerHTML = `<div class="agent-project-portfolio-heading"><div><p class="section-kicker">多会话项目识别</p><h4>${portfolio.crossProject ? '已识别多个不同项目并隔离证据' : projects.length ? '所选会话共同指向同一项目' : '暂未定位本地项目'}</h4><p>${escapeHtml(portfolio.recommendedMode || '按当前证据蒸馏')}</p></div><span class="pill ${portfolio.crossProject ? 'warning' : ''}">${projects.length.toLocaleString('zh-CN')} 个项目 · ${assignments.length.toLocaleString('zh-CN')} 条会话</span></div><div class="agent-project-grid">${projects.map((project, index) => { const summary = project.evidenceSummary || project.evidence?.summary || {}; return `<article><header><span>项目 ${index + 1}</span><strong>${escapeHtml(project.name || project.projectId || '未命名项目')}</strong></header><code>${escapeHtml(project.root || '未定位项目目录')}</code><p>${Number(project.sessionCount || project.sessions?.length || 0).toLocaleString('zh-CN')} 条会话；扫描 ${Number(summary.scannedFiles || 0).toLocaleString('zh-CN')} 个文件；修改或关联 ${Number(summary.modifiedFiles || 0).toLocaleString('zh-CN')} 个；产物 ${Number(summary.generatedFiles || 0).toLocaleString('zh-CN')} 个。</p></article>`; }).join('') || '<p class="muted">没有发现可验证的本地项目。</p>'}</div><div class="agent-project-assignments"><h5>每条会话属于哪个项目</h5>${assignments.map((item) => `<article><div><strong>${escapeHtml(item.title || item.sessionId || '未命名会话')}</strong><small>${escapeHtml(item.sessionId || '未提供编号')}</small></div><div><strong>${escapeHtml(item.projectName || '未归属')}</strong><small>置信度 ${escapeHtml(item.confidence || '未知')}${item.ambiguous ? '；存在相近候选' : ''}</small></div><p>${escapeHtml(item.reason || '暂无判断依据')}</p></article>`).join('') || '<p class="muted">没有会话归属记录。</p>'}</div>`;
}

function renderProjectUnderstanding() {
  const root = $('#project-understanding');
  if (!root) return;
  const understanding = state.projectUnderstanding || state.distillation?.projectUnderstanding || state.capabilities?.projectUnderstanding || null;
  if (!understanding) {
    root.innerHTML = '<p class="muted">没有可展示的项目深度理解。选择项目后生成能力包时，会自动关联会话、当前文件、Git 原始版本、差异、命令和产物。</p>';
    return;
  }
  const graph = understanding.evidenceGraph?.statistics || understanding.evidenceGraph || {};
  const scope = understanding.scope || {};
  const evolution = (understanding.fileEvolution || []).slice(0, 60);
  const lineage = evolution.filter((item) => item.lineage);
  const conflicts = (understanding.conflictRegister || []).slice(0, 24);
  const plan = (understanding.activeReadPlan || []).slice(0, 24);
  root.innerHTML = `
    <div class="project-understanding-header"><div><p class="section-kicker">项目深度理解</p><h4>这份能力包已理解什么、为什么、先验证什么</h4><p>${escapeHtml(understanding.purpose || '项目目的尚未从证据中收敛。')}</p></div><span class="pill">证据图 ${Number(graph.nodes || 0).toLocaleString('zh-CN')} 节点</span></div>
    <div class="project-understanding-metrics"><span><strong>${Number(scope.sourceSessions || 0).toLocaleString('zh-CN')}</strong>来源会话</span><span><strong>${Number(scope.stages || 0).toLocaleString('zh-CN')}</strong>需求阶段</span><span><strong>${Number(scope.files || evolution.length).toLocaleString('zh-CN')}</strong>关联文件</span><span><strong>${Number(graph.edges || 0).toLocaleString('zh-CN')}</strong>证据关系</span><span><strong>${conflicts.length.toLocaleString('zh-CN')}</strong>待处理冲突</span></div>
    <div class="project-understanding-grid">
      <section><h5>文件演化</h5>${evolution.length ? `<ul>${evolution.map((item) => `<li><code>${escapeHtml(item.path || '未命名文件')}</code><span>${escapeHtml([item.changeState, item.projectRole, item.confidence ? `可信度 ${item.confidence}` : ''].filter(Boolean).join('｜') || '已关联')}</span>${item.conversationEvidence?.length ? `<small>关联 ${item.conversationEvidence.length} 条会话证据</small>` : ''}</li>`).join('')}</ul>` : '<p class="muted">没有可展示的文件演化记录。</p>'}</section>
      <section><h5>生成产物链路</h5>${lineage.length ? `<ul>${lineage.map((item) => `<li><code>${escapeHtml(item.path || '未命名产物')}</code><span>${escapeHtml(item.lineage?.summary || item.lineage?.source || '已关联来源')}</span></li>`).join('')}</ul>` : '<p class="muted">没有识别到可追溯的生成产物。</p>'}</section>
      <section><h5>冲突与后续纠正</h5>${conflicts.length ? `<ul>${conflicts.map((item) => `<li><strong>${escapeHtml(item.title || item.type || '待决冲突')}</strong><span>${escapeHtml(item.resolution || item.description || item.message || '以较晚的用户要求和当前文件证据为准。')}</span></li>`).join('')}</ul>` : '<p class="muted">未识别到需要覆盖的冲突。</p>'}</section>
      <section><h5>主动读取与验证计划</h5>${plan.length ? `<ol>${plan.map((item) => `<li><strong>${escapeHtml(item.action || item.title || item.path || '读取证据')}</strong><span>${escapeHtml(item.reason || item.description || item.expected || '')}</span></li>`).join('')}</ol>` : '<p class="muted">项目已无待补读证据。</p>'}</section>
    </div>`;
}

function pagedItems(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

function knowledgeSearchText(...values) {
  return values.flat(Infinity).filter((value) => value !== null && value !== undefined).map((value) => typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' ').toLocaleLowerCase('zh-CN');
}

function renderProjectKnowledgeV4() {
  const knowledge = state.projectKnowledgeV4;
  const metricsRoot = $('#knowledge-v4-metrics');
  if (!metricsRoot) return;
  if (!knowledge) {
    metricsRoot.innerHTML = '<p class="muted">当前能力包没有 V4 多会话项目知识。重新生成能力包时选择会话与关联项目即可建立。</p>';
    ['stages', 'timeline', 'model', 'changes', 'impact', 'versions', 'lineage', 'reproduction', 'decisions', 'coverage', 'open-questions', 'read-log'].forEach((id) => { const node = $(`#knowledge-v4-${id}`); if (node) node.innerHTML = ''; });
    return;
  }
  const summary = knowledge.summary || {};
  const stages = pagedItems(knowledge.semanticStages);
  const versions = pagedItems(knowledge.fileVersions);
  const lineage = pagedItems(knowledge.artifactLineage);
  const timeline = pagedItems(knowledge.crossSessionTimeline);
  const changes = pagedItems(knowledge.fileChangeMatrix);
  const impact = knowledge.dependencyImpact || {};
  const reproductions = pagedItems(knowledge.artifactReproducibility);
  const openQuestions = pagedItems(knowledge.openEvidenceQuestions);
  const snapshot = knowledge.projectSnapshot || {};
  const decisions = pagedItems(knowledge.decisionConflicts);
  const readLog = pagedItems(knowledge.activeReadLog);
  const model = knowledge.projectModel || null;
  const coverage = knowledge.coverage || {};
  const filter = ($('#knowledge-filter')?.value || '').trim().toLocaleLowerCase('zh-CN');
  const visible = (items, getText) => filter ? items.filter((item) => getText(item).includes(filter)) : items;
  metricsRoot.innerHTML = [
    metric('来源会话', Number(summary.sessions || 0).toLocaleString('zh-CN')),
    metric('语义阶段', Number(summary.semanticStages || stages.length).toLocaleString('zh-CN')),
    metric('逐条证据', Number(summary.evidenceEntries || 0).toLocaleString('zh-CN')),
    metric('项目文件', Number(summary.projectFiles || 0).toLocaleString('zh-CN')),
    metric('文件版本', Number(summary.fileVersions || versions.length).toLocaleString('zh-CN')),
    metric('时间线事件', Number(summary.timelineEvents || timeline.length).toLocaleString('zh-CN')),
    metric('变更文件', Number(summary.changedFiles || changes.length).toLocaleString('zh-CN')),
    metric('依赖关系', Number(summary.dependencyEdges || impact.edges?.length || 0).toLocaleString('zh-CN')),
    metric('可复现产物', Number(summary.reproducibleArtifacts || 0).toLocaleString('zh-CN')),
  ].join('');

  const visibleStages = visible(stages, (item) => knowledgeSearchText(item.title, item.purpose, item.sessions, item.files, item.tools));
  $('#knowledge-v4-stages').innerHTML = visibleStages.length ? visibleStages.map((stage) => `<article class="knowledge-stage" data-search="${escapeHtml(knowledgeSearchText(stage.title, stage.purpose, stage.sessions, stage.files, stage.tools))}"><header><div><span class="phase-badge">${escapeHtml(stage.phase || 'P')}</span><h4>${escapeHtml(stage.title || '未命名语义阶段')}</h4></div><span class="pill neutral">${Number(stage.evidenceIds?.length || 0).toLocaleString('zh-CN')} 条证据</span></header><p>${escapeHtml(stage.purpose || '未提取到具体目标。')}</p><dl><div><dt>来源会话</dt><dd>${(stage.sessions || []).map((session) => `${escapeHtml(session.title || session.sessionId)}${session.authorityRank ? `（优先 ${escapeHtml(session.authorityRank)}）` : ''}`).join('<br>') || '未标识'}</dd></div><div><dt>涉及文件</dt><dd>${(stage.files || []).map((file) => `<code>${escapeHtml(file)}</code>`).join('<br>') || '未记录文件'}</dd></div><div><dt>实际工具</dt><dd>${(stage.tools || []).map((tool) => `<code>${escapeHtml(tool)}</code>`).join('、') || '未记录工具'}</dd></div><div><dt>执行结果</dt><dd>工具 ${Number(stage.outcome?.toolCalls || 0).toLocaleString('zh-CN')} 次；成功 ${Number(stage.outcome?.succeeded || 0).toLocaleString('zh-CN')}；失败 ${Number(stage.outcome?.failed || 0).toLocaleString('zh-CN')}；文件 ${Number(stage.outcome?.changedFiles || 0).toLocaleString('zh-CN')} 个</dd></div></dl><details><summary>查看 ${Number(stage.occurrences?.length || 0).toLocaleString('zh-CN')} 条原始阶段轨迹</summary><ol>${(stage.occurrences || []).map((item) => `<li><strong>${escapeHtml(item.title || `原阶段 ${item.stageIndex}`)}</strong><span>${escapeHtml(compact(item.request, 1200))}</span></li>`).join('')}</ol></details></article>`).join('') : '<p class="muted">没有与当前关键词匹配的语义阶段。</p>';

  const visibleTimeline = visible(timeline, (item) => knowledgeSearchText(item));
  $('#knowledge-v4-timeline').innerHTML = `<p class="knowledge-count">显示 ${visibleTimeline.length.toLocaleString('zh-CN')} / ${timeline.length.toLocaleString('zh-CN')} 条跨会话事件</p><table class="knowledge-table"><thead><tr><th>时间</th><th>事件</th><th>来源会话</th><th>具体内容</th><th>P 阶段</th></tr></thead><tbody>${visibleTimeline.map((item) => `<tr><td>${escapeHtml(item.timestamp || '未记录')}</td><td><span class="knowledge-status done">${escapeHtml(item.type || '事件')}</span></td><td>${escapeHtml(item.sessionTitle || item.sessionId || '未标识')}</td><td>${escapeHtml(item.title || item.action || item.tool || item.command || '')}</td><td>${escapeHtml(item.semanticStageTitle || item.semanticStageId || '')}</td></tr>`).join('')}</tbody></table>`;

  const modules = model?.modules || [];
  $('#knowledge-v4-model').innerHTML = model ? `<div class="knowledge-model-summary"><div><strong>项目</strong><span>${escapeHtml(model.project?.name || '未命名项目')}</span><small>${escapeHtml(model.project?.root || '')}</small></div><div><strong>项目目的</strong><span>${escapeHtml(model.purpose || '尚未从证据中收敛')}</span></div><div><strong>入口候选</strong><span>${(model.entryPoints || []).map((item) => `<code>${escapeHtml(item.path || item)}</code>`).join('、') || '未识别'}</span></div><div><strong>规则文件</strong><span>${(model.rules || []).map((item) => `<code>${escapeHtml(item.path || item)}</code>`).join('、') || '未识别'}</span></div></div><div class="knowledge-module-list">${visible(modules, (item) => knowledgeSearchText(item)).map((module) => `<article><h4>${escapeHtml(module.name)}</h4><p>${Number(module.fileCount || 0).toLocaleString('zh-CN')} 个文件；${Number(module.modifiedFiles || 0).toLocaleString('zh-CN')} 个修改；${Number(module.generatedFiles || 0).toLocaleString('zh-CN')} 个产物</p><small>${escapeHtml((module.languages || []).join('、') || '未识别语言')}｜${escapeHtml((module.roles || []).join('、') || '未识别职责')}</small><details><summary>查看示例文件</summary>${(module.examples || []).map((file) => `<code>${escapeHtml(file)}</code>`).join('<br>')}</details></article>`).join('')}</div>` : '<p class="muted">没有定位到可读取的项目模型。</p>';

  const visibleChanges = visible(changes, (item) => knowledgeSearchText(item));
  $('#knowledge-v4-changes').innerHTML = `<p class="knowledge-count">显示 ${visibleChanges.length.toLocaleString('zh-CN')} / ${changes.length.toLocaleString('zh-CN')} 个文件</p><table class="knowledge-table"><thead><tr><th>文件</th><th>状态</th><th>涉及会话</th><th>Git 原始指纹</th><th>当前指纹</th><th>判断</th></tr></thead><tbody>${visibleChanges.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code></td><td>${escapeHtml(item.changeState || item.gitStatus || item.kind || '已记录')}</td><td>${(item.sessions || []).map((entry) => escapeHtml(entry.title || entry.sessionId || entry)).join('<br>') || '未关联'}</td><td><code>${escapeHtml(item.baseline?.sha256 || item.baseline?.gitObjectId || '无 Git 基线')}</code></td><td><code>${escapeHtml(item.current?.sha256 || '无当前指纹')}</code></td><td>${escapeHtml(item.assessment || '')}</td></tr>`).join('')}</tbody></table>`;

  const visibleImpact = visible(impact.changedFiles || [], (item) => knowledgeSearchText(item));
  $('#knowledge-v4-impact').innerHTML = `<table class="knowledge-table"><thead><tr><th>变更文件</th><th>直接依赖方</th><th>传递影响</th><th>证据</th></tr></thead><tbody>${visibleImpact.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code></td><td>${(item.directDependents || []).map((entry) => `<code>${escapeHtml(entry)}</code>`).join('<br>') || '无'}</td><td>${(item.transitiveDependents || []).map((entry) => `<code>${escapeHtml(entry)}</code>`).join('<br>') || '无'}</td><td>${Number(item.evidenceIds?.length || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table>`;

  const visibleVersions = visible(versions, (item) => knowledgeSearchText(item.path, item.kind, item.revision, item.action, item.changeState, item.gitStatus));
  $('#knowledge-v4-versions').innerHTML = `<p class="knowledge-count">显示 ${visibleVersions.length.toLocaleString('zh-CN')} / ${versions.length.toLocaleString('zh-CN')} 条文件版本记录</p><table class="knowledge-table"><thead><tr><th>文件</th><th>版本类型</th><th>版本/动作</th><th>内容状态</th><th>父版本</th><th>证据</th></tr></thead><tbody>${visibleVersions.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code></td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml([item.revision, item.action, item.gitStatus, item.changeState].filter(Boolean).join('｜'))}</td><td><span class="knowledge-status ${item.contentAvailable ? 'done' : 'metadata'}">${item.contentAvailable ? '正文可用' : '仅记录事实'}</span></td><td><code>${escapeHtml(item.parentVersionId || '起点')}</code></td><td>${Number(item.evidenceIds?.length || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table>`;

  const visibleLineage = visible(lineage, (item) => knowledgeSearchText(item.path, item.kind, item.role, item.inputs, item.commands, item.conclusion));
  $('#knowledge-v4-lineage').innerHTML = `<p class="knowledge-count">显示 ${visibleLineage.length.toLocaleString('zh-CN')} / ${lineage.length.toLocaleString('zh-CN')} 条产物血缘</p><table class="knowledge-table"><thead><tr><th>生成产物</th><th>可信度</th><th>输入或依赖</th><th>匹配命令</th><th>证据结论</th></tr></thead><tbody>${visibleLineage.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code><small>${escapeHtml(item.role || item.kind || '')}</small></td><td><span class="knowledge-status ${item.confidence === '待确认' ? 'planned' : 'done'}">${escapeHtml(item.confidence)}</span></td><td>${(item.inputs || []).map((input) => `<code>${escapeHtml(input)}</code>`).join('<br>') || '未唯一定位'}</td><td>${(item.commands || []).map((command) => `<code>${escapeHtml(compact(command.command, 600))}</code>`).join('<br>') || '未唯一定位'}</td><td>${escapeHtml(item.conclusion)}</td></tr>`).join('')}</tbody></table>`;

  const visibleReproductions = visible(reproductions, (item) => knowledgeSearchText(item));
  $('#knowledge-v4-reproduction').innerHTML = `<table class="knowledge-table"><thead><tr><th>产物</th><th>状态</th><th>可重放</th><th>输入</th><th>生成命令</th><th>当前指纹</th></tr></thead><tbody>${visibleReproductions.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code></td><td>${escapeHtml(item.reproducibility?.status || '复现证据不足')}</td><td>${item.reproducibility?.readyToReplay ? '是' : '否'}</td><td>${(item.inputs || []).map((entry) => `<code>${escapeHtml(entry)}</code>`).join('<br>') || '待确认'}</td><td>${(item.commands || []).map((entry) => `<code>${escapeHtml(entry.command || entry)}</code>`).join('<br>') || '待确认'}</td><td><code>${escapeHtml(item.currentSnapshot?.sha256 || '无')}</code></td></tr>`).join('')}</tbody></table>`;

  const visibleDecisions = visible(decisions, (item) => knowledgeSearchText(item.type, item.status, item.decision, item.handling, item.supersedes));
  $('#knowledge-v4-decisions').innerHTML = visibleDecisions.length ? visibleDecisions.map((item) => `<article><header><span class="knowledge-status ${item.status === '已裁决' ? 'done' : 'planned'}">${escapeHtml(item.status)}</span><strong>${escapeHtml(item.type)}｜${escapeHtml(item.severity || '中')}</strong></header><p>${escapeHtml(item.decision)}</p><small>${escapeHtml(item.handling || '')}</small>${item.supersedes?.length ? `<details><summary>查看覆盖的早期阶段</summary>${item.supersedes.map((entry) => `<code>${escapeHtml(entry.title || entry.semanticStageId)}</code>`).join('<br>')}</details>` : ''}</article>`).join('') : '<p class="muted">没有与当前关键词匹配的后续决策或证据缺口。</p>';

  const projectCoverage = coverage.project || {};
  $('#knowledge-v4-coverage').innerHTML = `<div class="knowledge-coverage"><span><strong>${Number(coverage.sessions?.parsed || 0).toLocaleString('zh-CN')} / ${Number(coverage.sessions?.selected || 0).toLocaleString('zh-CN')}</strong>会话已解析</span><span><strong>${Number(projectCoverage.scannedFiles || 0).toLocaleString('zh-CN')} / ${Number(projectCoverage.discoveredFiles || 0).toLocaleString('zh-CN')}</strong>项目文件已扫描</span><span><strong>${Number(projectCoverage.textFilesRead || 0).toLocaleString('zh-CN')}</strong>文本文件已读取</span><span><strong>${Number(projectCoverage.metadataOnlyFiles || 0).toLocaleString('zh-CN')}</strong>仅记录元数据</span></div><p class="muted">项目快照：<code>${escapeHtml(snapshot.fingerprint || '未生成')}</code>；下次可用此指纹判断是否需要增量重读。</p>${(coverage.limitations || []).length ? `<ul class="knowledge-limitations">${coverage.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">没有额外读取限制。</p>'}`;
  $('#knowledge-v4-open-questions').innerHTML = openQuestions.length ? openQuestions.map((item) => `<article><header><strong>待补证</strong></header><p>${escapeHtml(typeof item === 'string' ? item : item.question || item.message || JSON.stringify(item))}</p></article>`).join('') : '<p class="muted">当前没有待补证问题。</p>';
  const visibleReadLog = visible(readLog, (item) => knowledgeSearchText(item.status, item.action, item.target, item.reason));
  $('#knowledge-v4-read-log').innerHTML = `<p class="knowledge-count">显示 ${visibleReadLog.length.toLocaleString('zh-CN')} / ${readLog.length.toLocaleString('zh-CN')} 条主动读取记录</p><table class="knowledge-table"><thead><tr><th>状态</th><th>动作</th><th>目标</th><th>为什么读取</th><th>证据</th></tr></thead><tbody>${visibleReadLog.map((item) => `<tr><td><span class="knowledge-status ${item.status === '已完成' ? 'done' : item.status === '仅元数据' ? 'metadata' : 'planned'}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.action)}</td><td><code>${escapeHtml(item.target || '未定位')}</code></td><td>${escapeHtml(item.reason)}</td><td>${Number(item.evidenceIds?.length || 0).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table>`;
}

function renderSpecializations() {
  const root = $('#specialization-list');
  if (!root) return;
  const distilled = state.distillation?.conversationDistillation || {};
  const ui = state.uiBlueprint || {};
  const specializations = distilled.specializedCapabilities || ui.specializations || [];
  const expertise = distilled.distilledExpertise || ui.expertise || [];
  $('#distillation-summary').textContent = distilled.summary || ui.distillationSummary || '正在根据完整会话生成专属能力说明。';
  $('#universal-core-summary').textContent = distilled.universalCore?.description || '完整工具目录负责真实执行；P 阶段蒸馏负责把这份会话的具体目标、做法、交付物和证据呈现出来。';
  const expertiseRoot = $('#distilled-expertise');
  if (expertiseRoot) {
    expertiseRoot.innerHTML = expertise.length
      ? expertise.map((item) => `<tr><td><span class="phase-badge">${escapeHtml(item.phase || 'P')}</span><strong>${escapeHtml(item.capability || item.title || '会话专属能力')}</strong></td><td>${escapeHtml(item.whenToUse || item.goal || '在原会话确认的输入和目标再次出现时使用。')}</td><td>${escapeHtml(item.executionMethod || item.approach || '回查会话证据 → 执行阶段做法 → 核对交付结果。')}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">当前能力包尚未识别到可展示的会话专长。</td></tr>';
  }
  renderUniversalTools(distilled.universalCore || {});
  if (!specializations.length) {
    root.innerHTML = '<p class="muted">当前能力包尚未提供按阶段拆分的会话蒸馏结果。</p>';
    return;
  }
  root.innerHTML = specializations.map((item) => `
    <article class="specialization-item">
      <header><div><span class="phase-badge">${escapeHtml(item.phase || 'P')}</span><h3>${escapeHtml(item.title || '会话专属能力')}</h3></div><button type="button" class="secondary-button specialization-action" data-specialization-id="${escapeHtml(item.id)}">${escapeHtml(item.action || '填入任务')}</button></header>
      <dl>
        <div><dt>阶段目标</dt><dd>${escapeHtml(item.goal || '完成原会话确认的阶段目标。')}</dd></div>
        <div><dt>执行做法</dt><dd>${escapeHtml(item.approach || '先回查会话证据，再执行并核对结果。')}</dd></div>
        <div><dt>预期交付</dt><dd>${escapeHtml(item.deliverable || '可复核的阶段结果。')}</dd></div>
        <div><dt>原会话证据</dt><dd>${escapeHtml(item.evidence || '对应原会话需求阶段。')}</dd></div>
      </dl>
    </article>`).join('');
  $$('.specialization-action', root).forEach((button) => button.addEventListener('click', () => {
    const item = specializations.find((candidate) => candidate.id === button.dataset.specializationId);
    if (item) prefillSpecializedTask(item);
  }));
}

function renderUniversalTools(universalCore) {
  const root = $('#universal-tool-list');
  if (!root) return;
  const currentTools = new Map((state.tools || []).map((item) => [item.name, item]));
  const tools = universalCore.tools || state.tools || [];
  if (!tools.length) {
    root.innerHTML = '<p class="muted">当前能力包尚未提供通用工具目录。</p>';
    return;
  }
  root.innerHTML = `<section class="feature-group"><div class="feature-group-header"><h3>${escapeHtml(universalCore.title || '通用 Codex 执行能力底座')}</h3><span>${tools.length} 项功能</span></div><table class="feature-table"><thead><tr><th>工具代码</th><th>中文名称</th><th>直白说明</th><th>开放条件</th><th>当前状态</th></tr></thead><tbody>${tools.map((tool) => {
    const runtimeTool = currentTools.get(tool.name);
    const available = runtimeTool?.available !== false;
    return `<tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.label || tool.name)}</td><td>${escapeHtml(tool.description || '按能力契约执行对应操作。')}</td><td>${escapeHtml(tool.permission || '始终开放')}</td><td><span class="availability ${available ? '' : 'off'}">${available ? '可以使用' : '等待开启'}</span></td></tr>`;
  }).join('')}</tbody></table></section>`;
}

function renderHistory() {
  const root = $('#history-list');
  if (!state.tasks.length) {
    root.innerHTML = '<div class="muted" style="padding:24px">还没有任务记录。完成一次执行后会在这里保留状态、工具、文件和验收信息。</div>';
    return;
  }
  root.innerHTML = state.tasks.map((task) => `<button class="history-item" type="button" data-task-id="${escapeHtml(task.id)}"><div class="history-title"><strong>${escapeHtml(task.title || task.task)}</strong><span>${escapeHtml(compact(task.task, 180))}</span></div><span class="pill ${statusClass(task.status)}">${escapeHtml(task.status)}</span><span>${task.changeJournal?.length || 0} 项文件变更</span><span>${new Date(task.updatedAt).toLocaleString('zh-CN')}</span></button>`).join('');
  $$('.history-item', root).forEach((button) => button.addEventListener('click', () => openTask(button.dataset.taskId)));
}

async function refreshAll({ keepForms = false } = {}) {
  try {
    const [health, capabilities, distillation, recommendationResponse, toolsResponse, alignment, processes, sourcesResponse, workResponse, coverageGaps, semanticEvaluationPlan, releaseValidation] = await Promise.all([
      api('/api/runtime/health'), api('/api/runtime/capabilities?compact=1'), api('/api/runtime/distillation?compact=1'), api('/api/runtime/recommendation'), api('/api/runtime/tools'), api('/api/runtime/codex-alignment'), api('/api/runtime/processes'), api('/api/runtime/sources'), api('/api/runtime/work-capability'), api('/api/runtime/coverage-gaps'), api('/api/runtime/semantic-evaluation-plan'), api('/api/runtime/release-validation'),
    ]);
    state.health = health;
    state.installation = health.installation || state.installation;
    state.codexLink = state.codexLink?.applied ? state.codexLink : (health.codexLink || state.codexLink);
    state.capabilities = capabilities;
    state.distillation = distillation;
    state.recommendation = recommendationResponse.recommendation || null;
    state.workCapability = workResponse.workCapability || null;
    state.workEvaluation = workResponse.evaluation || null;
    state.coverageGaps = coverageGaps || null;
    state.semanticEvaluationPlan = semanticEvaluationPlan || null;
    state.releaseValidation = releaseValidation || null;
    state.sourceSessions = sourcesResponse.sessions || distillation.sourceSessions || capabilities.sourceSessions || [];
    state.projectPortfolio = distillation.projectPortfolio || capabilities.projectPortfolio || null;
    state.projectEvidence = distillation.projectEvidence || capabilities.projectEvidence || null;
    state.projectUnderstanding = distillation.projectUnderstanding || capabilities.projectUnderstanding || null;
    state.projectKnowledgeV4 = null;
    state.tools = toolsResponse.tools || [];
    state.alignment = alignment;
    state.processes = processes.processes || [];
    renderOverview(); renderFeatures(); renderAlignment(); renderDistillation(); renderProjectKnowledgeV4(); renderWorkCapability(); renderCoverageGaps(); renderReleaseValidation(); updateReadiness(); renderInstallation();
    void loadProjectInsightData();
    await loadConversationUi();
    if (!keepForms) fillConfig();
    renderCodexLink();
    await loadTasks();
    await loadLocalSessions();
    await loadLocalTaskChains();
    if (!state.codexLink?.applied) await connectCurrentCodex({ automatic: true });
    if (!state.models.length && state.health?.runtime?.baseUrl && !state.codexLink?.applied) {
      $('#model-catalog-state').textContent = '正在自动读取接口返回的全部模型...';
      loadModels(false).catch((error) => {
        $('#model-catalog-state').textContent = `自动读取模型列表失败：${error.message}；可以点击“读取全部模型”重试。`;
      });
    }
  } catch (error) {
    $('#service-dot').className = 'status-dot error';
    $('#service-status').textContent = '本地服务连接失败';
    showToast(error.message, 'error');
  }
}

async function loadProjectInsightData() {
  try {
    const [projectPortfolioResponse, projectEvidenceResponse, projectUnderstandingResponse, projectKnowledgeV4Response] = await Promise.all([
      api('/api/runtime/project-portfolio'),
      api('/api/runtime/project-evidence'),
      api('/api/runtime/project-understanding'),
      api('/api/runtime/project-knowledge-v4?group=全部&maxItems=5000'),
    ]);
    state.projectPortfolio = projectPortfolioResponse.projectPortfolio || state.projectPortfolio || null;
    state.projectEvidence = projectEvidenceResponse.projectEvidence || state.projectEvidence || null;
    state.projectUnderstanding = projectUnderstandingResponse.projectUnderstanding || state.projectUnderstanding || null;
    state.projectKnowledgeV4 = projectKnowledgeV4Response.available ? projectKnowledgeV4Response.content : null;
    renderDistillation();
    renderProjectKnowledgeV4();
  } catch (error) {
    // Project evidence is optional for portable conversation-only packages.
    console.warn(`项目深度资料读取失败：${error.message}`);
  }
}

function modelId(model) {
  return String(typeof model === 'string' ? model : model?.id || model?.name || '').trim();
}

function renderModelCatalog() {
  const filter = $('#model-filter');
  const root = $('#model-catalog');
  const stateLabel = $('#model-catalog-state');
  const count = $('#model-catalog-count');
  const query = filter.value.trim().toLocaleLowerCase();
  const models = state.models;
  const visibleModels = query ? models.filter((model) => model.id.toLocaleLowerCase().includes(query)) : models;
  filter.disabled = models.length === 0;
  count.textContent = models.length ? (query ? `显示 ${visibleModels.length} / ${models.length} 个` : `共 ${models.length} 个`) : '尚未读取';
  if (!models.length) {
    root.innerHTML = '<p class="muted">尚未读取接口模型。</p>';
    return;
  }
  stateLabel.textContent = query
    ? `正在显示匹配“${filter.value.trim()}”的 ${visibleModels.length} 个模型；接口返回的全部 ${models.length} 个模型仍已保留。`
    : `以下完整显示接口返回的 ${models.length} 个模型；点击任意名称即可选用。`;
  root.innerHTML = visibleModels.length
    ? visibleModels.map((model) => `<button type="button" class="model-catalog-item" data-model-id="${escapeHtml(model.id)}" title="选择 ${escapeHtml(model.id)}"><strong>${escapeHtml(model.id)}</strong>${model.owner ? `<small>提供方：${escapeHtml(model.owner)}</small>` : ''}</button>`).join('')
    : '<p class="muted">没有与搜索条件匹配的模型。</p>';
}

function setSelectedModel(id) {
  $('#model-name').value = id;
  $('#model-form-state').textContent = `已选择模型：${id}。保存后会执行连接检查。`;
  showToast(`已填入模型名称：${id}`, 'success');
}

async function loadModels(showMessage = true) {
  const response = await api('/api/runtime/models');
  const models = Array.isArray(response) ? response : (response.data || response.models || []);
  state.models = models.map((model) => ({
    id: modelId(model),
    owner: typeof model === 'object' ? String(model.owned_by || model.owner || '').trim() : '',
  })).filter((model) => model.id);
  $('#model-list').innerHTML = state.models.map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join('');
  renderModelCatalog();
  if (showMessage) showToast(`模型服务连接正常，已完整读取 ${state.models.length} 个模型。`, 'success');
  return state.models;
}

async function saveModel(event) {
  event.preventDefault();
  const payload = { baseUrl: $('#base-url').value.trim(), model: $('#model-name').value.trim() };
  if ($('#api-key').value.trim()) payload.apiKey = $('#api-key').value.trim();
  $('#model-form-state').textContent = '正在保存并连接模型…';
  try {
    await api('/api/runtime/config', { method: 'PUT', body: JSON.stringify(payload) });
    await loadModels(false);
    $('#model-form-state').textContent = '模型连接正常';
    showToast('模型配置已保存到当前进程内存，并且连接测试通过。', 'success');
    await refreshAll({ keepForms: true });
    $('#api-key').value = '';
  } catch (error) {
    $('#model-form-state').textContent = `连接失败：${error.message}`;
    showToast(error.message, 'error');
  }
}

async function saveWorkspace(event) {
  event.preventDefault();
  const payload = { root: $('#workspace-root').value.trim(), allowWrite: $('#allow-write').checked, allowDelete: $('#allow-delete').checked, allowCommand: $('#allow-command').checked, allowGitWrite: $('#allow-git-write').checked, allowNetwork: $('#allow-network').checked };
  $('#workspace-form-state').textContent = '正在检查目录…';
  try {
    const workspace = await api('/api/runtime/workspace', { method: 'PUT', body: JSON.stringify(payload) });
    $('#workspace-form-state').textContent = workspace.ready ? '工作区有效，权限已保存' : workspace.configurationError;
    showToast('工作区和权限已经更新。', 'success');
    await refreshAll({ keepForms: true });
  } catch (error) {
    $('#workspace-form-state').textContent = `保存失败：${error.message}`;
    showToast(error.message, 'error');
  }
}

async function chooseWorkspaceRoot() {
  const button = $('#pick-workspace-root');
  button.disabled = true;
  $('#workspace-form-state').textContent = '正在打开本机项目文件夹选择窗口…';
  try {
    const payload = await api('/api/runtime/path-picker', { method: 'POST', body: JSON.stringify({ kind: 'directory' }) });
    const selectedPath = Array.isArray(payload.paths) ? String(payload.paths[0] || '').trim() : '';
    if (!selectedPath) {
      $('#workspace-form-state').textContent = '未选择项目文件夹。';
      return;
    }
    $('#workspace-root').value = selectedPath;
    $('#workspace-form-state').textContent = '已选择项目文件夹；请保存工作区权限。';
    showToast('项目文件夹已选择。', 'success');
  } catch (error) {
    $('#workspace-form-state').textContent = `选择失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function resetRunPanel(title) {
  state.events = [];
  $('#run-panel').classList.remove('hidden');
  $('#run-title').textContent = title || '任务执行中';
  $('#run-status').textContent = '等待';
  $('#run-status').className = 'pill running';
  $('#event-stream').innerHTML = '';
  $('#event-count').textContent = '0 条';
  $('#run-result').textContent = '正在等待执行结果。';
  $('#run-result').className = 'result-content muted';
  $('#change-list').textContent = '尚无变更。';
  $('#verification-list').textContent = '尚无命令记录。';
  $('#process-list').textContent = '尚无长期进程。';
  $('#process-count').textContent = '0 个';
  $('#checkpoint-list').textContent = '尚无恢复点。';
  $('#continue-form').classList.add('hidden');
  renderAutonomyStatus(null);
  updatePhase('取证');
  $('#run-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updatePhase(phase) {
  const phases = ['取证', '规划', '执行', '验证', '完成'];
  const activeIndex = Math.max(phases.indexOf(phase), 0);
  $$('.phase-track span').forEach((item, index) => item.classList.toggle('active', index <= activeIndex));
}

function eventLabel(event) {
  return ({ task_created: '任务建立', task_state: '阶段变化', evidence: '自动取证', step_start: '执行步骤', assistant_delta: '模型输出', tool_start: '调用工具', tool_result: '工具结果', task_complete: '任务完成', task_error: '任务异常' })[event] || event;
}

function eventText(event, data) {
  if (event === 'task_created') return `任务编号 ${data.taskId}`;
  if (event === 'task_state') return `当前阶段：${data.phase || data.status}`;
  if (event === 'evidence') return data.summary || '已读取原对话证据。';
  if (event === 'step_start') return `自动步骤 ${data.step} / ${data.maxSteps}`;
  if (event === 'assistant_delta') return data.content;
  if (event === 'tool_start') return `${data.trace?.name || '工具'}\n参数：${JSON.stringify(data.trace?.arguments || {}, null, 2)}`;
  if (event === 'tool_result') return `${data.trace?.name || '工具'}：${data.trace?.status === 'success' ? '成功' : '失败'}\n${JSON.stringify(data.trace?.result || data.trace?.error || {}, null, 2)}`;
  if (event === 'task_complete') return `执行结束：修改 ${data.changes || 0} 项，命令 ${data.commands || 0} 条，恢复点 ${data.checkpoints || 0} 个。`;
  if (event === 'task_error') return `${data.error?.message || '任务执行失败'}${data.resumable ? '；状态已保存，可以继续执行。' : ''}`;
  return compact(JSON.stringify(data), 5000);
}

function traceForAutonomy(task = state.currentTask) {
  const stored = Array.isArray(task?.toolTrace) ? task.toolTrace : [];
  if (stored.length) return stored;
  const fromEvents = state.events
    .filter((item) => item.event === 'tool_start' || item.event === 'tool_result')
    .map((item) => item.data?.trace)
    .filter(Boolean);
  return [...new Map(fromEvents.map((trace) => [trace.id || `${trace.name}-${JSON.stringify(trace.arguments || {})}`, trace])).values()];
}

function renderAutonomyStatus(task = state.currentTask) {
  const traces = traceForAutonomy(task);
  const writeTools = new Set(['create_directory', 'write_file', 'replace_text', 'apply_edits', 'apply_patch', 'move_path', 'delete_path', 'restore_checkpoint']);
  const commandTools = new Set(['execute_command', 'run_verification', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit', 'start_process', 'read_process_output', 'write_process_input', 'stop_process', 'list_processes']);
  const writeCount = task?.changeJournal?.length || traces.filter((trace) => writeTools.has(trace.name) && trace.status === 'success').length;
  const commandCount = task?.commands?.length || traces.filter((trace) => commandTools.has(trace.name) && trace.status === 'success').length;
  const checkpointCount = task?.checkpoints?.length ?? 0;
  const status = task?.status || (state.running ? '执行中' : '待开始');
  const phase = task?.phase || (state.running ? '自动执行中' : '尚未开始');
  $('#autonomy-state').textContent = status;
  $('#autonomy-state').className = `pill ${statusClass(status)}`;
  $('#autonomy-tool-count').textContent = String(traces.length);
  $('#autonomy-write-count').textContent = String(writeCount);
  $('#autonomy-command-count').textContent = String(commandCount);
  $('#autonomy-checkpoint-count').textContent = String(checkpointCount);
  if (!task && !state.running) {
    $('#autonomy-summary').textContent = '开始任务后，模型会在你已经开启的权限范围内自行取证、读取项目、修改文件并执行命令验证；每一步都会留在下方记录中。';
    return;
  }
  const latest = traces.at(-1);
  const latestText = latest ? `最近${latest.status === 'failed' ? '失败' : '完成'}：${latest.name || '未命名工具'}。` : '正在准备第一步取证。';
  $('#autonomy-summary').textContent = `当前处于${phase}阶段，模型已自动选择 ${traces.length} 项工具。${latestText} 文件、命令与恢复点统计会在任务结束后保留。`;
}

function appendEvent(event, data) {
  state.events.push({ event, data });
  const root = $('#event-stream');
  const text = eventText(event, data);
  const item = document.createElement('article');
  item.className = 'event-item';
  item.innerHTML = `<div class="event-kind">${escapeHtml(eventLabel(event))}</div><div class="event-body">${escapeHtml(compact(text, 10000)).replace(/\n/g, '<br>')}</div>`;
  root.append(item);
  root.scrollTop = root.scrollHeight;
  $('#event-count').textContent = `${state.events.length} 条`;
  if (event === 'task_created') state.currentTask = data.task || { id: data.taskId };
  if (event === 'task_state') {
    $('#run-status').textContent = data.status || data.phase;
    $('#run-status').className = `pill ${statusClass(data.status || data.phase)}`;
    updatePhase(data.phase || data.status);
  }
  if (event === 'task_complete') {
    $('#run-status').textContent = '完成'; $('#run-status').className = 'pill success'; updatePhase('完成');
  }
  if (event === 'task_error') {
    $('#run-status').textContent = data.status || '失败'; $('#run-status').className = 'pill failed'; $('#continue-form').classList.remove('hidden');
  }
  renderAutonomyStatus();
}

async function consumeSse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `执行请求失败：${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      let event = 'message'; let data = {};
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch { data = { content: line.slice(5).trim() }; } }
      }
      appendEvent(event, data);
    }
    if (done) break;
  }
}

async function startTask(event) {
  event.preventDefault();
  const task = $('#task-input').value.trim();
  if (!task || state.running) return;
  resetRunPanel(compact(task, 90));
  state.running = true;
  $('#start-task').disabled = true; $('#stop-task').disabled = false;
  try {
    const response = await fetch('/api/runtime/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task, title: compact(task, 90), mode: state.mode, localConversationContext: state.loadedLocalContext }) });
    await consumeSse(response);
  } catch (error) {
    appendEvent('task_error', { status: '失败', error: { message: error.message }, resumable: Boolean(state.currentTask?.id) });
    showToast(error.message, 'error');
  } finally {
    state.running = false; $('#stop-task').disabled = true; updateReadiness();
    if (state.currentTask?.id) await openTask(state.currentTask.id, false);
    await loadTasks();
    if (!state.models.length && state.health?.runtime?.baseUrl) {
      loadModels(false).catch((error) => {
        $('#model-catalog-state').textContent = `自动读取模型列表失败：${error.message}`;
      });
    }
  }
}

async function continueTask(event) {
  event.preventDefault();
  if (!state.currentTask?.id || state.running) return;
  const message = $('#continue-input').value.trim();
  state.running = true; $('#stop-task').disabled = false; $('#continue-form').classList.add('hidden');
  try {
    const response = await fetch(`/api/runtime/tasks/${encodeURIComponent(state.currentTask.id)}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    await consumeSse(response);
    $('#continue-input').value = '';
  } catch (error) {
    appendEvent('task_error', { status: '失败', error: { message: error.message }, resumable: true });
  } finally {
    state.running = false; $('#stop-task').disabled = true; updateReadiness(); await openTask(state.currentTask.id, false); await loadTasks();
  }
}

async function stopTask() {
  if (!state.currentTask?.id) return;
  try {
    await api(`/api/runtime/tasks/${encodeURIComponent(state.currentTask.id)}/cancel`, { method: 'POST', body: '{}' });
    showToast('已发送停止指令，当前任务状态会保留。');
  } catch (error) { showToast(error.message, 'error'); }
}

function renderTask(task) {
  state.currentTask = task;
  $('#run-panel').classList.remove('hidden');
  $('#run-title').textContent = task.title || compact(task.task, 90);
  $('#run-status').textContent = task.status;
  $('#run-status').className = `pill ${statusClass(task.status)}`;
  updatePhase(task.phase || task.status);
  $('#run-result').textContent = task.result || task.error?.message || '任务尚未产生最终结果。';
  $('#run-result').className = `result-content ${task.result ? '' : 'muted'}`;
  const changes = task.changeJournal || [];
  $('#change-count').textContent = `${changes.length} 项`;
  $('#change-list').className = 'compact-list';
  $('#change-list').innerHTML = changes.length ? changes.map((item) => `<div class="compact-item success"><strong>${escapeHtml(item.action || '修改')}：${escapeHtml(item.path)}</strong>${item.target ? `<span>目标：${escapeHtml(item.target)}</span>` : ''}${item.checkpointId ? `<span>恢复点：${escapeHtml(item.checkpointId)}</span>` : ''}</div>`).join('') : '<span class="muted">尚无变更。</span>';
  const commands = task.commands || [];
  const verifications = task.verification || [];
  $('#verification-state').textContent = verifications.length ? (verifications.every((item) => item.passed) ? '验收通过' : '验收未通过') : `${commands.length} 条命令`;
  $('#verification-list').className = 'compact-list';
  $('#verification-list').innerHTML = commands.length ? commands.map((item) => `<div class="compact-item ${item.exitCode === 0 && !item.timedOut ? 'success' : 'failed'}"><strong>${escapeHtml(item.command)}</strong><span>退出码 ${escapeHtml(item.exitCode)} · ${escapeHtml(item.durationMs)} 毫秒${item.timedOut ? ' · 已超时' : ''}</span></div>`).join('') : '<span class="muted">尚无命令记录。</span>';
  const processIds = new Set((task.processes || []).map((item) => item.id));
  const processes = state.processes.filter((item) => processIds.has(item.id));
  $('#process-count').textContent = `${processes.length} 个`;
  $('#process-list').className = 'compact-list';
  $('#process-list').innerHTML = processes.length ? processes.map((item) => `<div class="compact-item ${item.status === '运行中' ? 'success' : ''}"><strong>${escapeHtml(item.command)}</strong><span>编号 ${escapeHtml(item.id)} · ${escapeHtml(item.status)}${item.pid ? ` · PID ${escapeHtml(item.pid)}` : ''}</span>${item.status === '运行中' ? `<button type="button" data-stop-process="${escapeHtml(item.id)}">停止进程</button>` : ''}${item.stdout ? `<pre>${escapeHtml(compact(item.stdout, 2400))}</pre>` : ''}${item.stderr ? `<pre>${escapeHtml(compact(item.stderr, 1200))}</pre>` : ''}</div>`).join('') : '<span class="muted">尚无由本任务启动的长期进程。</span>';
  $$('[data-stop-process]', $('#process-list')).forEach((button) => button.addEventListener('click', () => stopManagedProcess(button.dataset.stopProcess)));
  const checkpoints = task.checkpoints || [];
  $('#checkpoint-count').textContent = `${checkpoints.length} 个`;
  $('#checkpoint-list').className = 'compact-list';
  $('#checkpoint-list').innerHTML = checkpoints.length ? checkpoints.map((item) => `<div class="compact-item"><strong>${escapeHtml(item.path)}</strong><span>${escapeHtml(item.reason || '修改前自动检查点')}</span><button type="button" data-restore="${escapeHtml(item.id)}">恢复这个版本</button></div>`).join('') : '<span class="muted">尚无恢复点。</span>';
  $$('[data-restore]', $('#checkpoint-list')).forEach((button) => button.addEventListener('click', () => restore(button.dataset.restore)));
  $('#continue-form').classList.toggle('hidden', !['失败', '已停止'].includes(task.status));
  $('#event-stream').innerHTML = '';
  state.events = [];
  for (const item of (task.events || [])) appendEvent(item.event, item);
  renderAutonomyStatus(task);
  renderHeldOutSubmit(task);
}

async function stopManagedProcess(processId) {
  try {
    await api(`/api/runtime/processes/${encodeURIComponent(processId)}/stop`, { method: 'POST', body: '{}' });
    showToast('已发送停止进程指令。', 'success');
    await refreshAll({ keepForms: true });
    if (state.currentTask?.id) await openTask(state.currentTask.id, false);
  } catch (error) { showToast(error.message, 'error'); }
}

async function openTask(taskId, changeView = true) {
  try {
    const task = await api(`/api/runtime/tasks/${encodeURIComponent(taskId)}`);
    renderTask(task);
    if (changeView) { switchView('execute'); $('#run-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (error) { showToast(error.message, 'error'); }
}

async function loadTasks() {
  try { state.tasks = (await api('/api/runtime/tasks?limit=100')).tasks || []; renderHistory(); }
  catch (error) { showToast(error.message, 'error'); }
}

async function restore(checkpointId) {
  try {
    await api(`/api/runtime/checkpoints/${encodeURIComponent(checkpointId)}/restore`, { method: 'POST', body: '{}' });
    showToast('检查点已经恢复。', 'success');
    if (state.currentTask?.id) await openTask(state.currentTask.id, false);
  } catch (error) { showToast(error.message, 'error'); }
}

async function searchConversation(event) {
  event.preventDefault();
  const query = $('#conversation-query').value.trim();
  const root = $('#conversation-results');
  root.textContent = '正在搜索完整原对话…';
  try {
    const response = await api(`/api/runtime/conversation/search?query=${encodeURIComponent(query)}&maxResults=60`);
    root.className = 'search-results';
    root.innerHTML = response.results?.length ? response.results.map((item) => `<article class="search-hit"><strong>阶段 ${escapeHtml(item.stage || '-')} · ${escapeHtml(item.kind === 'tool' ? item.name : item.actor || item.kind)}</strong>${escapeHtml(compact(item.text || item.command || item.path || item.arguments || item.result?.excerpt || '', 2400)).replace(/\n/g, '<br>')}</article>`).join('') : '<span class="muted">没有找到匹配内容。</span>';
  } catch (error) { root.textContent = error.message; root.className = 'search-results muted'; }
}

function openExecutionSetup() {
  const setup = $('#execution-setup');
  setup.open = true;
  setup.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('#connect-codex').focus({ preventScroll: true }), 260);
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('#mode-switch button').forEach((button) => button.addEventListener('click', () => {
    $$('#mode-switch button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.mode = button.dataset.mode;
  }));
  $('#model-form').addEventListener('submit', saveModel);
  $('#connect-codex').addEventListener('click', () => connectCurrentCodex());
  let localSessionSearchTimer = null;
  $('#local-session-filter').addEventListener('input', () => {
    window.clearTimeout(localSessionSearchTimer);
    localSessionSearchTimer = window.setTimeout(() => loadLocalSessions(), 260);
  });
  let localTaskChainSearchTimer = null;
  $('#local-task-chain-filter').addEventListener('input', () => {
    window.clearTimeout(localTaskChainSearchTimer);
    localTaskChainSearchTimer = window.setTimeout(() => loadLocalTaskChains(), 260);
  });
  $('#load-more-local-task-chains').addEventListener('click', () => loadLocalTaskChains({ append: true }));
  $('#refresh-local-sessions').addEventListener('click', async () => {
    await loadLocalSessions({ force: true });
    await loadLocalTaskChains();
  });
  $('#load-more-local-sessions').addEventListener('click', () => loadLocalSessions({ append: true }));
  $('#load-local-sessions').addEventListener('click', loadSelectedLocalSessions);
  $('#local-session-list').addEventListener('change', () => {
    for (const option of $('#local-session-list').options) {
      if (!option.value) continue;
      const id = String(option.value).toLowerCase();
      if (option.selected) state.selectedLocalSessionIds.add(id);
      else state.selectedLocalSessionIds.delete(id);
    }
    updateLocalSessionSelection();
  });
  $('#pick-workspace-root').addEventListener('click', chooseWorkspaceRoot);
  $('#workspace-form').addEventListener('submit', saveWorkspace);
  $('#load-models').addEventListener('click', () => loadModels().catch((error) => showToast(error.message, 'error')));
  $('#model-filter').addEventListener('input', renderModelCatalog);
  $('#knowledge-filter').addEventListener('input', renderProjectKnowledgeV4);
  $('#model-catalog').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model-id]');
    if (button) setSelectedModel(button.dataset.modelId);
  });
  $('#task-form').addEventListener('submit', startTask);
  $('#open-execution-setup').addEventListener('click', openExecutionSetup);
  $('#stop-task').addEventListener('click', stopTask);
  $('#continue-form').addEventListener('submit', continueTask);
  $('#submit-held-out').addEventListener('click', submitHeldOut);
  $('#conversation-search-form').addEventListener('submit', searchConversation);
  $('#refresh-all').addEventListener('click', () => refreshAll());
  $('#refresh-history').addEventListener('click', loadTasks);
  $('#coverage-gap-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-gap-action]');
    if (button) handleCoverageGapAction(button);
  });
}

bindEvents();
refreshAll();
