const $ = (selector) => document.querySelector(selector);

const MODE_CONFIG = {
  '执行本地任务': { placeholder: '例如：查看项目，修复测试失败，并运行测试确认' },
  '分析问题': { placeholder: '例如：查看目录和关键文件，说明项目结构与风险' },
  '生成结果': { placeholder: '例如：根据当前工作流生成一份完整结果' },
  '检查内容': { placeholder: '例如：检查现有文件是否满足验收要求并修正' },
  '提取并改进原对话': { placeholder: '例如：检索原对话的最新纠正，说明旧方案不足，然后改进并验证' },
};

const TOOL_LABELS = {
  search_original_conversation: '搜索原对话',
  get_original_conversation_stage: '读取原对话阶段',
  get_improved_workflow: '读取改进工作流',
  list_files: '浏览目录',
  read_file: '读取文件',
  write_file: '写入文件',
  replace_text: '修改文件',
  create_directory: '创建目录',
  execute_command: '执行命令',
};

const state = {
  blueprint: null,
  runtime: null,
  workspace: null,
  messages: [],
  mode: '执行本地任务',
  controller: null,
  connectionState: 'unchecked',
  connectionKind: 'cloud',
  models: [],
  configBusy: false,
  workspaceBusy: false,
  lastFailedPrompt: '',
};

class ApiError extends Error {
  constructor(message, code = 'request_failed', status = 0, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

async function readJson(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 下面统一给出中文错误。
  }
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message || `请求失败，状态码 ${response.status}。`,
      payload?.error?.code || 'request_failed',
      response.status,
      payload?.error?.details,
    );
  }
  return payload;
}

async function fetchJson(url, options) {
  return readJson(await fetch(url, options));
}

function friendlyError(error) {
  const messages = {
    invalid_base_url: '模型地址格式不正确。请填写完整地址，例如 https://服务地址/v1。',
    insecure_base_url: '远程模型地址需要使用 HTTPS；本机模型可以使用 127.0.0.1 或 localhost。',
    model_required: '请填写或选择模型名称。',
    provider_unreachable: '没有连接到模型服务。请检查地址、本地模型是否已启动，以及网络是否可用。',
    provider_timeout: '模型服务等待超时。可检查服务状态，或提高最长等待时间。',
    provider_error: '模型服务返回错误。请检查模型名、密钥和服务端日志。',
    workspace_not_found: '找不到这个工作区。请填写一个已经存在的本地文件夹。',
    workspace_not_directory: '工作区必须是文件夹，不能是单个文件。',
    workspace_not_ready: '本地工作区尚未准备好，请先保存一个有效文件夹。',
    agent_step_limit: '已经达到自动步骤上限。请缩小任务，或提高“最多自动步骤”。',
    agent_cancelled: '本次任务已停止。',
  };
  return messages[error?.code] || error?.message || '操作没有完成，请检查配置后重试。';
}

function showStatus(selector, message, kind = 'info', focus = false) {
  const element = $(selector);
  element.textContent = message;
  element.dataset.state = kind;
  if (focus) element.focus();
}

function inferConnectionKind(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.localhost') ? 'local' : 'cloud';
  } catch {
    return state.connectionKind;
  }
}

function setConnectionKind(kind, applyPreset = false) {
  state.connectionKind = kind === 'local' ? 'local' : 'cloud';
  document.querySelectorAll('[data-connection-kind]').forEach((button) => {
    const active = button.dataset.connectionKind === state.connectionKind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const local = state.connectionKind === 'local';
  $('#connection-kind-note').textContent = local
    ? '本地模型需要先启动 OpenAI 兼容服务，密钥通常可以留空。'
    : '在线模型通常需要 HTTPS 服务地址、模型名称和 API 密钥。';
  if (applyPreset) {
    $('#base-url').value = local ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1';
    $('#model').value = local ? '' : 'gpt-4.1-mini';
    $('#model-list').hidden = true;
    state.models = [];
    $('#model-filter').value = '';
    renderModelCatalog();
    markConnectionDirty('连接方式已修改，需要保存并检查。');
  }
}

function setConnectionState(kind, message) {
  state.connectionState = kind;
  const ready = kind === 'ready';
  $('#runtime-dot').dataset.state = ready ? 'ready' : kind === 'checking' ? 'checking' : kind === 'error' ? 'error' : 'idle';
  $('#runtime-label').textContent = ready ? '模型已连接' : kind === 'checking' ? '正在检查模型' : kind === 'error' ? '模型连接失败' : '等待检查模型';
  $('#runtime-model').textContent = ready
    ? `${state.runtime?.model || '已配置模型'} · ${state.connectionKind === 'local' ? '本地服务' : '在线服务'}`
    : message || state.runtime?.model || '尚未检查';
  $('#send-chat').disabled = !ready || Boolean(state.controller);
  updateSetupProgress();
}

function markConnectionDirty(message = '模型配置有修改，需要重新检查。') {
  if (state.connectionState === 'ready') setConnectionState('unchecked', message);
  showStatus('#config-status', message, 'warning');
}

function updateSetupProgress() {
  const hasConnectionValues = Boolean($('#base-url').value.trim() && $('#model').value.trim());
  const workspaceReady = Boolean(state.workspace?.ready);
  const toolsEnabled = Boolean(state.workspace?.writeEnabled || state.workspace?.commandEnabled);
  const steps = [
    ['#setup-step-config', '#setup-config-state', state.connectionState === 'ready' ? 'complete' : hasConnectionValues ? 'current' : 'current', state.connectionState === 'ready' ? '已连接' : hasConnectionValues ? '等待检查' : '等待填写'],
    ['#setup-step-workspace', '#setup-workspace-state', workspaceReady ? 'complete' : state.connectionState === 'ready' ? 'current' : 'pending', workspaceReady ? '已选择' : '等待选择'],
    ['#setup-step-tools', '#setup-tools-state', workspaceReady ? 'complete' : 'pending', workspaceReady ? (toolsEnabled ? '已开启所选权限' : '只读模式') : '等待工作区'],
    ['#setup-step-chat', '#setup-chat-state', state.connectionState === 'ready' && workspaceReady ? (state.messages.length ? 'complete' : 'current') : 'pending', state.messages.length ? '任务已开始' : state.connectionState === 'ready' && workspaceReady ? '可以开始' : '配置后可用'],
  ];
  for (const [stepSelector, labelSelector, stepState, label] of steps) {
    $(stepSelector).dataset.state = stepState;
    $(labelSelector).textContent = label;
  }
  $('#local-tool-summary').textContent = !workspaceReady
    ? '等待选择工作区'
    : `读取已开；写入${state.workspace.writeEnabled ? '已开' : '未开'}；命令${state.workspace.commandEnabled ? '已开' : '未开'}`;
}

function renderRuntime(runtime) {
  state.runtime = runtime;
  $('#base-url').value = runtime?.baseUrl || '';
  $('#model').value = runtime?.model || '';
  $('#timeout-seconds').value = Math.round(Number(runtime?.timeoutMs || 60000) / 1000);
  setConnectionKind(inferConnectionKind(runtime?.baseUrl || ''));
  setConnectionState('unchecked', runtime?.configurationError || '配置已载入，等待检查');
  showStatus('#config-status', runtime?.configurationError || '配置已载入。点击“保存并检查连接”后才会开放任务区。', runtime?.configurationError ? 'error' : 'info');
}

function renderWorkspace(workspace) {
  state.workspace = workspace;
  $('#workspace-root').value = workspace?.root || '';
  $('#workspace-write-enabled').checked = workspace?.writeEnabled === true;
  $('#command-enabled').checked = workspace?.commandEnabled === true;
  $('#command-timeout-seconds').value = Math.round(Number(workspace?.commandTimeoutMs || 30000) / 1000);
  $('#max-agent-steps').value = Number(workspace?.maxAgentSteps || 12);
  const description = workspace?.ready
    ? `工作区已就绪。读取：已允许；写入：${workspace.writeEnabled ? '已允许' : '未允许'}；命令：${workspace.commandEnabled ? '已允许' : '未允许'}。`
    : workspace?.configurationError || '请填写一个已经存在的本地文件夹。';
  showStatus('#workspace-status', description, workspace?.ready ? 'success' : 'warning');
  updateSetupProgress();
}

function renderList(selector, values, empty) {
  $(selector).innerHTML = values?.length
    ? values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')
    : `<li>${escapeHtml(empty)}</li>`;
}

function renderBlueprint(blueprint) {
  state.blueprint = blueprint;
  const naming = blueprint.package.naming || {};
  const namingParts = [(naming.subjects || []).join('、'), (naming.contentTopics || []).join('、'), (naming.toolTerms || []).join('、')].filter(Boolean);
  const namingSummary = namingParts.join('；') || '根据完整会话内容和实际工具生成';
  const guide = blueprint.capabilityGuide || {};
  const specialities = guide.specialities || [];
  const suitableTasks = guide.suitableTasks || [];
  const deliveryForms = guide.deliveryForms || [];
  const distillation = blueprint.distillation || {};
  const extractionEvidence = distillation.evidence || {};
  $('#package-name').textContent = blueprint.package.name;
  document.title = `${blueprint.package.name} - 本地执行型人工智能`;
  $('#package-naming-summary').textContent = namingSummary;
  $('#package-naming-detail').textContent = `名称“${blueprint.package.name}”根据完整会话中的主题、内容方向、实际工具和实现文件自动生成。命名依据：${namingSummary}。`;
  $('#session-id').textContent = blueprint.selection.sessionId || '源文件未内嵌编号';
  $('#record-count').textContent = `${Number(blueprint.selection.recordCount || 0).toLocaleString('zh-CN')} 条`;
  $('#source-hash').textContent = blueprint.selection.sourceSha256 || '-';
  $('#capability-title').textContent = guide.title || `这个能力包专门用于：${blueprint.workflow.name}`;
  $('#capability-summary').textContent = guide.plainSummary || blueprint.workflow.description;
  $('#capability-panel-summary').textContent = guide.plainSummary || blueprint.workflow.description;
  $('#capability-speciality-summary').textContent = specialities.length ? specialities.slice(0, 3).map((item) => item.name).join('、') : blueprint.workflow.name;
  $('#capability-task-summary').textContent = `${suitableTasks.length || 1} 类来源任务，可直接执行`;
  $('#capability-delivery-summary').textContent = deliveryForms.length ? deliveryForms.map((item) => item.name).join('、') : '技能、MCP、独立智能体';
  $('#ui-capability-list').innerHTML = (guide.independentUiCapabilities || []).length
    ? guide.independentUiCapabilities.map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description)}</span></li>`).join('')
    : '<li><strong>会话派生执行</strong><span>按来源会话中的工作流分析、生成并检查内容。</span></li>';
  $('#speciality-list').innerHTML = specialities.length
    ? specialities.map((item) => `<article><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description)}</p><small>执行方法：${escapeHtml((item.steps || []).join(' → ') || '按当前工作流执行')}</small></article>`).join('')
    : `<article><strong>${escapeHtml(blueprint.workflow.name)}</strong><p>${escapeHtml(blueprint.workflow.description)}</p></article>`;
  $('#suitable-tasks').innerHTML = suitableTasks.length
    ? suitableTasks.map((item) => `<li><div><strong>${escapeHtml(item.title)}</strong><span>来源：原会话第 ${escapeHtml(item.sourceStage)} 个需求阶段</span></div><button type="button" data-use-task="${escapeHtml(item.prompt)}">填入任务</button></li>`).join('')
    : '<li><div><strong>按当前工作流处理相近任务</strong><span>在执行区说明目标并提供资料。</span></div></li>';
  renderList('#required-inputs', guide.requiredInputs || blueprint.workflow.inputs, '当前任务目标和可用资料。');
  renderList('#capability-outputs', guide.outputs || blueprint.workflow.expectedOutputs, '按当前工作流生成的结果。');
  renderList('#capability-limits', guide.limits, '重要结果仍需人工复核；本地权限由当前页面控制。');
  $('#workflow-name').textContent = (guide.title || blueprint.workflow.name).replace(/^这个能力包专门用于[：:]\s*/, '');
  $('#workflow-description').textContent = guide.plainSummary || blueprint.workflow.description;
  const workflowSteps = specialities.length ? specialities.slice(0, 6).map((item) => item.name) : blueprint.workflow.steps || [];
  $('#workflow-steps').innerHTML = workflowSteps.map((step, index) => `<li><span>${index + 1}</span><strong>${escapeHtml(step)}</strong></li>`).join('') || '<li><span>1</span><strong>暂无可提取步骤</strong></li>';
  renderList('#expected-outputs', guide.outputs || blueprint.workflow.expectedOutputs, '暂无预期产物。');
  renderList('#verification-list', guide.verification || blueprint.workflow.verification, '请按来源会话完成复核。');
  $('#distillation-purpose').textContent = distillation.purpose || '从原对话提取需求、纠正和工具证据，并用于改进后续执行。';
  $('#distillation-summary').innerHTML = [
    ['需求阶段', extractionEvidence.stageCount || (distillation.requirementEvolution || []).length],
    ['用户纠正', extractionEvidence.correctionCount || (distillation.corrections || []).length],
    ['提取消息', extractionEvidence.messageCount || 0],
    ['工具调用', extractionEvidence.toolCallCount || 0],
    ['关联文件', extractionEvidence.artifactCount || 0],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${Number(value || 0).toLocaleString('zh-CN')}</dd></div>`).join('');
  $('#requirement-evolution').innerHTML = (distillation.requirementEvolution || []).length
    ? distillation.requirementEvolution.map((item) => `<li><div><strong>第 ${escapeHtml(item.stage)} 阶段 · ${escapeHtml(item.label || item.type || '需求变化')}</strong><span>${escapeHtml(truncate(item.request || item.summary || '', 1200))}</span></div></li>`).join('')
    : '<li><div><strong>暂无可提取阶段</strong><span>原会话中没有识别到用户需求阶段。</span></div></li>';
  $('#conversation-corrections').innerHTML = (distillation.corrections || []).length
    ? distillation.corrections.map((item) => `<article><strong>第 ${escapeHtml(item.stage)} 阶段必须覆盖旧做法</strong><p>${escapeHtml(truncate(item.request || '', 1600))}</p><small>${escapeHtml(item.requiredChange || '按最新要求重新执行并验收。')}</small></article>`).join('')
    : '<p class="muted">没有识别到明确纠正；执行时仍以当前用户最新要求为准。</p>';
  renderList('#retained-strengths', distillation.retainedStrengths, '保留有实际工具结果支撑的做法。');
  renderList('#conversation-weaknesses', distillation.weaknesses, '暂无可从记录直接确认的旧方案不足。');
  $('#improved-workflow').innerHTML = (distillation.improvedWorkflow || []).length
    ? distillation.improvedWorkflow.map((item, index) => `<li><span>${escapeHtml(item.order || index + 1)}</span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description)}</p>${item.requiredTools?.length ? `<small>会调用：${escapeHtml(item.requiredTools.map((tool) => TOOL_LABELS[tool] || tool).join('、'))}</small>` : ''}</div></li>`).join('')
    : '<li><span>1</span><div><strong>读取原对话并执行当前目标</strong><p>按实际证据完成并验证。</p></div></li>';
  renderList('#distillation-acceptance', distillation.acceptanceCriteria, '必须能回查原对话证据，并完成实际验证。');
  renderList('#recovery-rules', distillation.recoveryRules, '工具失败时保留错误证据，调整后继续。');
}

function truncate(value, maximum = 5000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n……内容过长，界面已截断`;
}

function renderActivities(activities) {
  if (!activities?.length) return '';
  return `<section class="tool-activity" aria-label="工具执行记录"><h3>工具执行记录</h3>${activities.map((activity) => {
    const status = activity.status === 'running' ? '执行中' : activity.status === 'success' ? '已完成' : '有错误';
    const result = activity.result === undefined ? '等待本地服务返回结果…' : truncate(activity.result);
    return `<details class="tool-call" data-state="${escapeHtml(activity.status)}" ${activity.status === 'running' ? 'open' : ''}><summary><span>${escapeHtml(TOOL_LABELS[activity.name] || activity.name || '本地工具')}</span><strong>${status}</strong>${activity.durationMs !== undefined ? `<small>${Number(activity.durationMs)} 毫秒</small>` : ''}</summary><dl><dt>参数</dt><dd><pre>${escapeHtml(truncate(activity.arguments, 3000))}</pre></dd><dt>结果</dt><dd><pre>${escapeHtml(result)}</pre></dd></dl></details>`;
  }).join('')}</section>`;
}

function renderMessages() {
  const container = $('#messages');
  if (!state.messages.length) {
    const name = (state.blueprint?.capabilityGuide?.title || state.blueprint?.workflow?.name || '当前会话派生工作流').replace(/^这个能力包专门用于[：:]\s*/, '');
    container.innerHTML = `<div class="welcome-message"><strong>这个人工智能专门用于：${escapeHtml(name)}</strong><p>它会先回查原对话中的最新纠正和工具证据；还会在你选择的工作区中真实浏览文件，开启权限后修改文件和执行命令。所有工具操作都会显示在这里。</p></div>`;
    updateSetupProgress();
    return;
  }
  container.innerHTML = state.messages.map((message, index) => {
    const role = message.role === 'user' ? '你' : '人工智能';
    const content = message.displayContent ?? message.content;
    const waiting = message.role === 'assistant' && !content && !message.complete;
    const actions = message.role === 'assistant' && message.complete && content
      ? `<footer class="message-actions"><button type="button" data-copy-message="${index}">复制结果</button><button type="button" data-download-message="${index}">下载 Markdown</button></footer>`
      : '';
    return `<article class="message ${message.role}" data-message-index="${index}"><header><strong>${role}</strong><span>${escapeHtml(message.mode || '')}</span></header>${renderActivities(message.activities)}<div class="message-content${waiting ? ' waiting' : ''}">${waiting ? '人工智能正在检查工作区并决定下一步…' : escapeHtml(content || '任务已结束，但模型没有返回文字说明。')}</div>${actions}</article>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
  updateSetupProgress();
}

function setConfigBusy(busy, action = 'save') {
  state.configBusy = busy;
  $('#config-form').setAttribute('aria-busy', String(busy));
  $('#config-form').querySelectorAll('button, input, select').forEach((control) => { control.disabled = busy; });
  const labels = { save: ['正在保存并检查…', '保存并检查连接'], models: ['正在获取模型…', '获取模型'], test: ['正在重新检查…', '重新检查'] };
  const target = action === 'models' ? $('#load-models') : action === 'test' ? $('#test-connection') : $('#save-config');
  target.textContent = labels[action][busy ? 0 : 1];
}

function setWorkspaceBusy(busy) {
  state.workspaceBusy = busy;
  $('#workspace-form').setAttribute('aria-busy', String(busy));
  $('#workspace-form').querySelectorAll('button, input').forEach((control) => { control.disabled = busy; });
  $('#save-workspace').textContent = busy ? '正在保存…' : '保存工作区与权限';
}

function setChatBusy(busy, message) {
  $('#chat-form').setAttribute('aria-busy', String(busy));
  $('#send-chat').disabled = busy || state.connectionState !== 'ready' || !state.workspace?.ready;
  $('#stop-chat').hidden = !busy;
  $('#chat-status').textContent = message;
}

function modelFormPayload({ requireModel = false } = {}) {
  const baseUrl = $('#base-url').value.trim();
  const model = $('#model').value.trim();
  if (!baseUrl) throw new ApiError('请先填写模型接口地址。', 'invalid_base_url');
  try { new URL(baseUrl); } catch { throw new ApiError('服务地址格式不正确。', 'invalid_base_url'); }
  if (requireModel && !model) throw new ApiError('请先填写或选择模型。', 'model_required');
  const timeoutSeconds = Number($('#timeout-seconds').value);
  const payload = { baseUrl, timeoutMs: Math.min(300, Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 60)) * 1000 };
  if (model) payload.model = model;
  if ($('#api-key').value) payload.apiKey = $('#api-key').value;
  return payload;
}

function workspaceFormPayload() {
  const root = $('#workspace-root').value.trim();
  if (!root) throw new ApiError('请先填写本地工作区文件夹。', 'workspace_not_found');
  const timeoutSeconds = Number($('#command-timeout-seconds').value);
  const steps = Number($('#max-agent-steps').value);
  return {
    root,
    writeEnabled: $('#workspace-write-enabled').checked,
    commandEnabled: $('#command-enabled').checked,
    commandTimeoutMs: Math.min(120, Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 30)) * 1000,
    maxAgentSteps: Math.min(30, Math.max(1, Number.isFinite(steps) ? steps : 12)),
  };
}

async function persistModelForm(options = {}) {
  const result = await fetchJson('/api/runtime/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(modelFormPayload(options)) });
  state.runtime = result.runtime;
  $('#api-key').value = '';
  setConnectionKind(inferConnectionKind(result.runtime.baseUrl));
  return result.runtime;
}

function populateModels(models) {
  const select = $('#model-list');
  state.models = (models || []).map((item) => ({
    id: String(typeof item === 'string' ? item : item?.id || item?.name || '').trim(),
    owner: typeof item === 'object' ? String(item?.owned_by || item?.owner || '').trim() : '',
  })).filter((item) => item.id);
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择模型';
  select.append(placeholder);
  for (const item of state.models) {
    const id = item.id;
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    select.append(option);
  }
  select.hidden = false;
  if (select.options.length === 2 && !$('#model').value.trim()) {
    select.selectedIndex = 1;
    $('#model').value = select.value;
  } else select.value = $('#model').value.trim();
  renderModelCatalog();
}

function renderModelCatalog() {
  const filter = $('#model-filter');
  const root = $('#model-catalog');
  const stateLabel = $('#model-catalog-state');
  const count = $('#model-catalog-count');
  const query = filter.value.trim().toLocaleLowerCase();
  const models = state.models;
  const visibleModels = query ? models.filter((item) => item.id.toLocaleLowerCase().includes(query)) : models;
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
    ? visibleModels.map((item) => `<button type="button" class="model-catalog-item" data-model-id="${escapeHtml(item.id)}" title="选择 ${escapeHtml(item.id)}"><strong>${escapeHtml(item.id)}</strong>${item.owner ? `<small>提供方：${escapeHtml(item.owner)}</small>` : ''}</button>`).join('')
    : '<p class="muted">没有与搜索条件匹配的模型。</p>';
}

function selectCatalogModel(id) {
  $('#model').value = id;
  $('#model-list').value = id;
  markConnectionDirty(`已选择模型“${id}”，请保存并检查连接。`);
}

async function saveAndCheckConnection(action = 'save') {
  if (state.configBusy) return;
  setConnectionState('checking', '正在检查模型连接');
  setConfigBusy(true, action);
  showStatus('#config-status', '正在保存配置并从模型服务读取模型列表…', 'info');
  try {
    await persistModelForm({ requireModel: true });
    const result = await fetchJson('/api/runtime/models');
    populateModels(result.data || []);
    setConnectionState('ready');
    showStatus('#config-status', `连接成功，当前模型：${state.runtime.model}。`, 'success', true);
  } catch (error) {
    setConnectionState('error', friendlyError(error));
    showStatus('#config-status', friendlyError(error), 'error', true);
  } finally {
    setConfigBusy(false, action);
  }
}

async function saveWorkspace() {
  if (state.workspaceBusy) return;
  setWorkspaceBusy(true);
  showStatus('#workspace-status', '正在检查文件夹并保存权限…', 'info');
  try {
    const result = await fetchJson('/api/runtime/workspace', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workspaceFormPayload()) });
    renderWorkspace(result.workspace);
    showStatus('#workspace-status', `已保存。读取：已允许；写入：${result.workspace.writeEnabled ? '已允许' : '未允许'}；命令：${result.workspace.commandEnabled ? '已允许' : '未允许'}。`, 'success', true);
  } catch (error) {
    showStatus('#workspace-status', friendlyError(error), 'error', true);
  } finally {
    setWorkspaceBusy(false);
  }
}

function hideChatError() { $('#chat-error').hidden = true; }
function showChatError(message) { $('#chat-error-message').textContent = message; $('#chat-error').hidden = false; }

function updateActivity(assistantMessage, event) {
  assistantMessage.activities ||= [];
  if (event.type === 'tool_start') {
    assistantMessage.activities.push({ id: event.id, name: event.name, arguments: event.arguments, status: 'running', step: event.step });
  } else if (event.type === 'tool_result') {
    let activity = assistantMessage.activities.find((item) => item.id === event.id);
    if (!activity) {
      activity = { id: event.id, name: event.name, arguments: event.arguments, step: event.step };
      assistantMessage.activities.push(activity);
    }
    activity.result = event.result;
    activity.durationMs = event.durationMs;
    activity.status = event.result?.ok === false ? 'error' : 'success';
  }
}

async function consumeAgentStream(response, assistantMessage) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('本地智能体没有返回可读取的数据流。', 'empty_agent_stream');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === 'tool_start' || event.type === 'tool_result') {
        updateActivity(assistantMessage, event);
        $('#chat-status').textContent = event.type === 'tool_start'
          ? `正在${TOOL_LABELS[event.name] || '调用本地工具'}…`
          : `${TOOL_LABELS[event.name] || '本地工具'}${event.result?.ok === false ? '返回错误，人工智能正在处理' : '已完成，人工智能正在继续'}`;
      } else if (event.type === 'status') {
        $('#chat-status').textContent = event.message || '人工智能正在继续执行…';
      } else if (event.type === 'assistant') {
        assistantMessage.content = event.content || '';
      } else if (event.type === 'error') {
        throw new ApiError(event.error?.message || '本地智能体执行失败。', event.error?.code || 'agent_error', 0, event.error?.details);
      }
      renderMessages();
    }
  }
}

async function sendChat(prompt) {
  if (state.connectionState !== 'ready') {
    showStatus('#config-status', '请先保存并检查模型连接。', 'warning', true);
    $('#settings-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!state.workspace?.ready) {
    showStatus('#workspace-status', '请先保存一个有效的本地工作区。', 'warning', true);
    $('#workspace-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  hideChatError();
  state.lastFailedPrompt = '';
  const userMessage = { role: 'user', content: `[工作模式：${state.mode}]\n${prompt}`, displayContent: prompt, mode: state.mode, complete: true };
  state.messages.push(userMessage);
  const outbound = state.messages.filter((message) => message.complete && message.content).map(({ role, content }) => ({ role, content }));
  const assistantMessage = { role: 'assistant', content: '', mode: state.mode, complete: false, activities: [] };
  state.messages.push(assistantMessage);
  renderMessages();
  state.controller = new AbortController();
  setChatBusy(true, '人工智能正在检查原对话证据、工作区和可用工具…');
  try {
    const response = await fetch('/api/runtime/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: outbound, stream: true }),
      signal: state.controller.signal,
    });
    if (!response.ok) await readJson(response);
    await consumeAgentStream(response, assistantMessage);
    assistantMessage.complete = true;
    $('#chat-status').textContent = assistantMessage.activities.length
      ? `任务已完成，共执行 ${assistantMessage.activities.length} 次工具调用。`
      : '任务已完成，本次不需要调用本地工具。';
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.code === 'agent_cancelled';
    assistantMessage.complete = true;
    assistantMessage.content ||= aborted ? '本次任务已由你停止。' : `任务未完成：${friendlyError(error)}`;
    state.lastFailedPrompt = aborted ? '' : prompt;
    if (!aborted) showChatError(friendlyError(error));
    $('#chat-status').textContent = aborted ? '任务已停止。' : '任务未完成，可检查配置后重试。';
  } finally {
    state.controller = null;
    setChatBusy(false, $('#chat-status').textContent);
    renderMessages();
  }
}

function setMode(mode) {
  state.mode = MODE_CONFIG[mode] ? mode : '执行本地任务';
  document.querySelectorAll('[data-mode]').forEach((button) => {
    if (!button.closest('#mode-selector')) return;
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#prompt').placeholder = MODE_CONFIG[state.mode].placeholder;
}

function copyMessage(index) {
  const content = state.messages[index]?.content || '';
  navigator.clipboard.writeText(content).then(() => { $('#chat-status').textContent = '结果已复制。'; });
}

function downloadMessage(index) {
  const message = state.messages[index];
  if (!message?.content) return;
  const blob = new Blob([`# ${state.blueprint?.package?.name || '人工智能结果'}\n\n${message.content}\n`], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${state.blueprint?.package?.id || 'result'}-${index + 1}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function activateTab(button) {
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    $(`#${tab.dataset.tab}-panel`).hidden = !active;
  });
}

async function loadInitialState() {
  try {
    const [blueprint, health, workspaceResult] = await Promise.all([
      fetchJson('/api/workflow'),
      fetchJson('/api/runtime/health'),
      fetchJson('/api/runtime/workspace'),
    ]);
    renderBlueprint(blueprint);
    renderRuntime(health.runtime);
    renderWorkspace(workspaceResult.workspace);
    renderMessages();
    if (health.runtime?.baseUrl) {
      $('#model-catalog-state').textContent = '正在自动读取接口返回的全部模型…';
      fetchJson('/api/runtime/models').then((models) => {
        populateModels(models.data || models.models || []);
        showStatus('#config-status', `已自动读取接口返回的 ${state.models.length} 个模型。`, 'info');
      }).catch((error) => {
        $('#model-catalog-state').textContent = `自动读取模型列表失败：${friendlyError(error)}；保存接口配置后可重新读取。`;
      });
    }
  } catch (error) {
    $('#capability-title').textContent = '能力包读取失败';
    $('#capability-summary').textContent = friendlyError(error);
    setConnectionState('error', friendlyError(error));
  }
}

document.querySelectorAll('[data-connection-kind]').forEach((button) => button.addEventListener('click', () => setConnectionKind(button.dataset.connectionKind, true)));
['base-url', 'model', 'api-key', 'timeout-seconds'].forEach((id) => $(`#${id}`).addEventListener('input', () => markConnectionDirty()));
['workspace-root', 'workspace-write-enabled', 'command-enabled', 'command-timeout-seconds', 'max-agent-steps'].forEach((id) => $(`#${id}`).addEventListener('input', () => showStatus('#workspace-status', '工作区或权限有修改，请点击“保存工作区与权限”。', 'warning')));

$('#config-form').addEventListener('submit', async (event) => { event.preventDefault(); await saveAndCheckConnection('save'); });
$('#test-connection').addEventListener('click', () => saveAndCheckConnection('test'));
$('#load-models').addEventListener('click', async () => {
  if (state.configBusy) return;
  setConfigBusy(true, 'models');
  try {
    await persistModelForm();
    const result = await fetchJson('/api/runtime/models');
    populateModels(result.data || []);
    showStatus('#config-status', `已获取 ${result.data?.length || 0} 个模型，请选择后保存并检查。`, 'success');
  } catch (error) { showStatus('#config-status', friendlyError(error), 'error', true); }
  finally { setConfigBusy(false, 'models'); }
});
$('#model-list').addEventListener('change', () => { if ($('#model-list').value) $('#model').value = $('#model-list').value; markConnectionDirty('已选择模型，请保存并检查连接。'); });
$('#model-filter').addEventListener('input', renderModelCatalog);
$('#model-catalog').addEventListener('click', (event) => {
  const button = event.target.closest('[data-model-id]');
  if (button) selectCatalogModel(button.dataset.modelId);
});
$('#clear-key').addEventListener('click', async () => {
  try {
    const result = await fetchJson('/api/runtime/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearApiKey: true }) });
    state.runtime = result.runtime;
    $('#api-key').value = '';
    markConnectionDirty('本次密钥已清除，需要重新检查连接。');
  } catch (error) { showStatus('#config-status', friendlyError(error), 'error', true); }
});
$('#reset-config').addEventListener('click', async () => {
  try { renderRuntime((await fetchJson('/api/runtime/config', { method: 'DELETE' })).runtime); }
  catch (error) { showStatus('#config-status', friendlyError(error), 'error', true); }
});

$('#workspace-form').addEventListener('submit', async (event) => { event.preventDefault(); await saveWorkspace(); });
$('#reset-workspace').addEventListener('click', async () => {
  try { renderWorkspace((await fetchJson('/api/runtime/workspace', { method: 'DELETE' })).workspace); }
  catch (error) { showStatus('#workspace-status', friendlyError(error), 'error', true); }
});

$('#mode-selector').addEventListener('click', (event) => { const button = event.target.closest('[data-mode]'); if (button) setMode(button.dataset.mode); });
$('#prompt-examples').addEventListener('click', (event) => { const button = event.target.closest('[data-prompt]'); if (!button) return; setMode(button.dataset.mode); $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); });
$('#suitable-tasks').addEventListener('click', (event) => { const button = event.target.closest('[data-use-task]'); if (!button) return; setMode('执行本地任务'); $('#prompt').value = button.dataset.useTask; $('#prompt').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#prompt').focus(); });
$('#chat-form').addEventListener('submit', async (event) => { event.preventDefault(); const prompt = $('#prompt').value.trim(); if (!prompt || state.controller) return; $('#prompt').value = ''; await sendChat(prompt); });
$('#messages').addEventListener('click', (event) => { const copy = event.target.closest('[data-copy-message]'); const download = event.target.closest('[data-download-message]'); if (copy) copyMessage(Number(copy.dataset.copyMessage)); if (download) downloadMessage(Number(download.dataset.downloadMessage)); });
$('#stop-chat').addEventListener('click', () => state.controller?.abort());
$('#clear-chat').addEventListener('click', () => { if (state.controller) return; state.messages = []; state.lastFailedPrompt = ''; hideChatError(); renderMessages(); $('#chat-status').textContent = '对话已清空，可以开始新任务。'; });
$('#retry-chat').addEventListener('click', async () => { const prompt = state.lastFailedPrompt; if (prompt) await sendChat(prompt); });
$('#review-connection').addEventListener('click', () => { $('#settings-title').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#save-config').focus(); });

document.querySelectorAll('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => activateTab(button));
  button.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[data-tab]')];
    let index = tabs.indexOf(button);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    activateTab(tabs[index]);
    tabs[index].focus();
  });
});

setMode('执行本地任务');
loadInitialState();
