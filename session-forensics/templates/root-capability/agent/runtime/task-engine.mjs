import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceConfig } from './config.mjs';
import { loadEvidence, executeEvidenceTool, evidenceToolDefinitions, getLatestCorrections, getImprovedWorkflow } from './evidence.mjs';
import { chatCompletion } from './provider.mjs';
import { executeWorkspaceTool, workspaceToolDefinitions } from './workspace.mjs';
import { HttpError, cleanText, createId, redactSecrets, readJson, writeJsonAtomic } from './shared.mjs';

const controllers = new Map();

function runsRoot(stateRoot) {
  return path.join(stateRoot, 'runs');
}

function runPath(stateRoot, runId) {
  return path.join(runsRoot(stateRoot), `${runId}.json`);
}

export async function saveRun(stateRoot, run) {
  run.updatedAt = new Date().toISOString();
  await writeJsonAtomic(runPath(stateRoot, run.id), run);
  return run;
}

export async function loadRun(stateRoot, runId) {
  const run = await readJson(runPath(stateRoot, runId));
  if (!run) throw new HttpError(404, 'task_not_found', '找不到这个任务。');
  run.processes ||= [];
  return run;
}

export async function listRuns(stateRoot, maximum = 100) {
  const entries = await fs.readdir(runsRoot(stateRoot), { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
    const run = await readJson(path.join(runsRoot(stateRoot), entry.name));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, maximum).map(publicRun);
}

export function publicRun(run) {
  const copy = structuredClone(run);
  delete copy.providerMessages;
  if (copy.localConversationContext?.sessions) {
    copy.localConversationContext.loadedSessionCount = copy.localConversationContext.sessions.length;
    delete copy.localConversationContext.sessions;
  }
  return copy;
}

function normalizeLocalConversationContext(value) {
  if (!value || typeof value !== 'object' || !value.executionBrief) return null;
  const sessions = (Array.isArray(value.sessions) ? value.sessions : []).slice(0, 300).map((item, index) => {
    const session = item?.session || item || {};
    return {
      index: Math.max(1, Number(item?.index || index + 1) || index + 1),
      sessionId: cleanText(session.sessionId || item?.sessionId || '', 96),
      title: cleanText(session.title || item?.title || '未命名本机 Codex 对话', 220),
      summary: cleanText(item?.summary || '', 900),
      stages: (Array.isArray(item?.stages) ? item.stages : []).slice(0, 24).map((stage, stageIndex) => ({
        index: Math.max(1, Number(stage?.index || stageIndex + 1) || stageIndex + 1),
        title: cleanText(stage?.title || '未命名需求阶段', 220),
        request: cleanText(stage?.request || '', 900),
      })),
    };
  }).filter((item) => item.sessionId || item.title !== '未命名本机 Codex 对话');
  return {
    schemaVersion: cleanText(value.schemaVersion || '1.0', 24),
    sessionCount: Math.max(sessions.length, Number(value.sessionCount) || 0),
    stageCount: Math.max(sessions.reduce((total, item) => total + item.stages.length, 0), Number(value.stageCount) || 0),
    executionBrief: cleanText(value.executionBrief, 54_000),
    sessions,
  };
}

export function localConversationContextToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'get_loaded_local_conversation_context',
      description: '读取用户刚在本机独立界面选择的动态会话上下文。可按会话编号、标题或关键词继续取回摘要和需求阶段；用于长任务链，后续阶段与用户纠正优先。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '会话标题、编号、需求或纠正关键词。留空时读取目录。' },
          sessionId: { type: 'string', description: '指定本机会话编号。' },
          sessionIndex: { type: 'integer', description: '指定加载顺序中的会话序号，从 1 开始。' },
          detail: { type: 'string', enum: ['目录', '摘要', '需求阶段'], description: '目录只返回会话和阶段标题；需求阶段返回阶段原始请求摘要。' },
          maxResults: { type: 'integer', description: '最多返回的会话数，默认 4，最大 12。' },
        },
      },
    },
  };
}

function readLoadedLocalConversationContext(run, args = {}) {
  const context = run.localConversationContext;
  if (!context?.sessions?.length) return { available: false, message: '当前任务没有从本机独立界面加载额外会话。请按能力包已有的原对话证据继续执行。' };
  const detail = ['摘要', '需求阶段'].includes(args.detail) ? args.detail : '目录';
  const query = cleanText(args.query || '', 240).toLowerCase();
  const sessionId = cleanText(args.sessionId || '', 120).toLowerCase();
  const sessionIndex = Number(args.sessionIndex);
  const maximum = Math.max(1, Math.min(Number(args.maxResults) || 4, 12));
  const matched = context.sessions.filter((item) => {
    if (sessionId && item.sessionId.toLowerCase() !== sessionId) return false;
    if (Number.isFinite(sessionIndex) && sessionIndex > 0 && item.index !== sessionIndex) return false;
    if (!query) return true;
    return [item.sessionId, item.title, item.summary, ...(item.stages || []).flatMap((stage) => [stage.title, stage.request])].join('\n').toLowerCase().includes(query);
  }).slice(0, maximum);
  return {
    available: true,
    selectedSessionCount: context.sessionCount,
    selectedStageCount: context.stageCount,
    matchingSessionCount: matched.length,
    detail,
    sessions: matched.map((item) => ({
      index: item.index,
      sessionId: item.sessionId,
      title: item.title,
      ...(detail === '摘要' || detail === '需求阶段' ? { summary: item.summary } : {}),
      stages: (item.stages || []).map((stage) => ({
        index: stage.index,
        title: stage.title,
        ...(detail === '需求阶段' ? { request: stage.request } : {}),
      })),
    })),
  };
}

export async function createRun(stateRoot, payload = {}) {
  const task = String(payload.task || payload.prompt || '').trim();
  if (!task) throw new HttpError(400, 'task_required', '必须填写要执行的任务。');
  const localConversationContext = normalizeLocalConversationContext(payload.localConversationContext);
  const run = {
    id: createId('task'),
    title: cleanText(payload.title || task, 120),
    task: cleanText(task, 24000),
    mode: String(payload.mode || '提取并改进原对话'),
    status: '等待',
    phase: '等待',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step: 0,
    maxSteps: workspaceConfig.maxSteps,
    events: [],
    toolTrace: [],
    changeJournal: [],
    checkpoints: [],
    commands: [],
    processes: [],
    verification: [],
    result: '',
    error: null,
    providerMessages: [],
    localConversationContext,
  };
  await saveRun(stateRoot, run);
  return run;
}

function emit(run, send, event, data = {}) {
  const item = { id: createId('event'), event, timestamp: new Date().toISOString(), ...data };
  run.events.push(item);
  if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
  send?.(event, { taskId: run.id, ...data });
  return item;
}

function parseArguments(value) {
  try { return JSON.parse(value || '{}'); } catch { throw new HttpError(400, 'invalid_tool_arguments', '模型返回的工具参数不是有效 JSON。'); }
}

function systemPrompt(evidence, workspace) {
  const correctionText = (evidence.extraction.corrections || []).slice(0, 10).map((item) => `- 阶段 ${item.stage}：${cleanText(item.request, 800)}`).join('\n') || '- 没有识别到明确纠正，以当前用户任务为准。';
  const sourceText = (evidence.sourceSessions || []).slice(0, 20).map((item, index) => `- 会话 ${index + 1}：${cleanText(item.title || item.sessionId, 180)}；记录 ${item.recordCount || 0} 条；来源 ${cleanText(item.sourcePath || '未提供', 260)}`).join('\n') || '- 没有独立来源清单。';
  const project = evidence.projectEvidence;
  const projectText = project?.summary
    ? `项目：${cleanText(project.summary.name || project.project?.name || '未命名项目', 160)}；根目录 ${cleanText(project.summary.root || project.project?.root || '未提供', 320)}；扫描 ${project.summary.scannedFiles || 0} 个文件；修改或关联 ${project.summary.modifiedFiles || 0} 个；生成产物 ${project.summary.generatedFiles || 0} 个；Git 分支 ${cleanText(project.summary.branch || '未识别', 120)}。`
    : '未指定项目文件夹。';
  const portfolio = evidence.projectPortfolio;
  const portfolioText = portfolio
    ? `项目组合：${portfolio.crossProject ? '跨项目' : '单项目'}；共 ${(portfolio.projects || []).length} 个项目。\n${(portfolio.projects || []).slice(0, 12).map((item) => `- ${cleanText(item.name || item.projectId || '未命名项目', 160)}：${cleanText(item.root || '未定位目录', 320)}；${item.sessionCount || (item.sessions || []).length || 0} 条会话；置信度 ${item.confidence || '未知'}`).join('\n') || '- 没有已归属项目'}\n会话归属：${(portfolio.sessionAssignments || []).slice(0, 24).map((item) => `${cleanText(item.title || item.sessionId || '未命名会话', 160)} -> ${cleanText(item.projectName || '未归属', 160)}`).join('；') || '无'}`
    : '没有可用的项目组合记录。';
  const understanding = evidence.projectUnderstanding;
  const understandingText = understanding
    ? `项目目的：${cleanText(understanding.purpose || '未提炼', 800)}\n文件演化：${(understanding.fileEvolution || []).slice(0, 16).map((item) => `${item.path}（${item.changeState || '状态未知'}，${item.projectRole || '角色未识别'}）`).join('；') || '未识别'}\n冲突登记：${(understanding.conflictRegister || []).slice(0, 8).map((item) => item.title || item.type || '未命名冲突').join('；') || '无'}\n主动读取计划：${(understanding.activeReadPlan || []).slice(0, 10).map((item) => item.action || item.title || item.path).join('；') || '无'}`
    : '没有可用的项目深度理解。';
  const permissionText = `工作区：${workspace.root || '未选择'}；读取=${workspace.ready ? '开' : '关'}；写入=${workspace.allowWrite ? '开' : '关'}；删除=${workspace.allowDelete ? '开' : '关'}；命令/长期进程=${workspace.allowCommand ? '开' : '关'}；Git 写入=${workspace.allowGitWrite ? '开' : '关'}；网络读取=${workspace.allowNetwork ? '开' : '关'}。`;
  return `你是“${evidence.blueprint.package.name}”的独立本地 Codex 工程 Agent。\n\n执行规则：\n1. 当前用户任务优先；后续用户纠正覆盖冲突的早期做法。\n2. 先取证：需要旧要求时调用原对话工具；本次联合来源先调用 get_source_sessions；有项目时先调用 get_project_portfolio，再调用 get_project_understanding（至少查看摘要、文件演化、冲突登记和主动读取计划）以及 get_project_evidence（至少查看摘要、修改文件和生成产物），再进入当前工作区调用 inspect_project、read_project_instructions，并在 Git 仓库中读取 git_status。\n3. 如果项目组合标记为跨项目，必须先确认当前工作区对应哪一个项目，只在该工作区内执行；需要处理另一个项目时建立独立任务和检查点，不把不同项目的文件、命令或验证结论混在一起。\n4. 修改前必须读取当前文件；多文件代码改动优先使用 apply_patch，完成后使用 get_file_diff 或 git_diff 审查。\n5. 默认执行真实修改并验证，不把计划写成已完成。需要服务或监视器时使用 start_process，结束时说明进程编号和状态。\n6. 写入前系统自动创建检查点；工具失败时保留错误并调整方案。\n7. 没有开启的权限不得尝试绕过；Git 提交只在任务明确需要且 Git 写入权限已开启时执行，绝不自行推送远程仓库。\n8. 最终用中文直白列出完成内容、修改文件、命令和 Git 结果、进程、失败项和恢复点。\n9. 不要声称没有实际工具轨迹的操作已经完成。\n\n联合会话来源：\n${sourceText}\n\n项目组合与会话归属：\n${portfolioText}\n\n项目证据摘要：\n${projectText}\n\n项目深度理解：\n${understandingText}\n\n最新纠正：\n${correctionText}\n\n当前权限：${permissionText}`;
}

function allowedTools(workspace) {
  return [...evidenceToolDefinitions(), ...workspaceToolDefinitions(), localConversationContextToolDefinition()].filter((tool) => {
    const name = tool.function.name;
    if (['create_directory', 'write_file', 'replace_text', 'apply_edits', 'apply_patch', 'move_path', 'create_checkpoint', 'restore_checkpoint'].includes(name)) return workspace.ready && workspace.allowWrite;
    if (name === 'delete_path') return workspace.ready && workspace.allowWrite && workspace.allowDelete;
    if (['execute_command', 'run_verification', 'git_status', 'git_diff', 'git_log', 'git_branch', 'start_process', 'read_process_output', 'write_process_input', 'stop_process', 'list_processes'].includes(name)) return workspace.ready && workspace.allowCommand;
    if (name === 'git_commit') return workspace.ready && workspace.allowCommand && workspace.allowGitWrite;
    if (name === 'fetch_url') return workspace.allowNetwork;
    if (['list_files', 'stat_path', 'search_files', 'read_file', 'inspect_project', 'read_project_instructions', 'get_file_diff'].includes(name)) return workspace.ready;
    return true;
  });
}

async function executeTool(agentRoot, stateRoot, run, name, args, signal) {
  if (name === 'get_loaded_local_conversation_context') return readLoadedLocalConversationContext(run, args);
  const evidenceResult = await executeEvidenceTool(agentRoot, name, args);
  if (evidenceResult !== null) return evidenceResult;
  const workspaceResult = await executeWorkspaceTool(stateRoot, run, name, args, signal);
  if (workspaceResult !== null) return workspaceResult;
  throw new HttpError(400, 'unknown_tool', `不认识工具 ${name}。`);
}

export async function executeRun({ agentRoot, stateRoot, run, workspace, send, continuation = '', signal }) {
  if (controllers.has(run.id)) throw new HttpError(409, 'task_already_running', '这个任务正在执行。');
  const controller = new AbortController();
  controllers.set(run.id, controller);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  try {
    const evidence = await loadEvidence(agentRoot);
    run.status = '取证';
    run.phase = '取证';
    emit(run, send, 'task_state', { status: run.status, phase: run.phase });
    const [corrections, workflow] = await Promise.all([getLatestCorrections(agentRoot), getImprovedWorkflow(agentRoot)]);
    const automaticEvidence = { corrections: corrections.corrections.slice(0, 12), workflow: workflow.workflow, acceptanceMatrix: workflow.acceptanceMatrix, sourceSessions: (evidence.sourceSessions || []).map((item) => ({ title: item.title, sessionId: item.sessionId, sourcePath: item.sourcePath, recordCount: item.recordCount })), projectPortfolio: evidence.projectPortfolio ? { crossProject: evidence.projectPortfolio.crossProject, recommendedMode: evidence.projectPortfolio.recommendedMode, projects: (evidence.projectPortfolio.projects || []).map((item) => ({ projectId: item.projectId, name: item.name, root: item.root, sessionCount: item.sessionCount, confidence: item.confidence })), sessionAssignments: evidence.projectPortfolio.sessionAssignments || [] } : null, projectEvidence: evidence.projectEvidence?.summary || null, projectUnderstanding: evidence.projectUnderstanding ? { purpose: evidence.projectUnderstanding.purpose, conflicts: (evidence.projectUnderstanding.conflictRegister || []).slice(0, 12), activeReadPlan: (evidence.projectUnderstanding.activeReadPlan || []).slice(0, 12), fileEvolution: (evidence.projectUnderstanding.fileEvolution || []).slice(0, 24) } : null };
    emit(run, send, 'evidence', { summary: '已自动读取联合会话来源、项目快照、文件演化、Git 摘要、产物链路、冲突登记、最新用户纠正、改进流程和验收矩阵。', data: automaticEvidence });
    const messages = run.providerMessages.length ? run.providerMessages : [
      { role: 'system', content: systemPrompt(evidence, workspace) },
      { role: 'user', content: `执行模式：${run.mode}\n任务：${run.task}\n\n${run.localConversationContext?.executionBrief ? `用户刚从本机选择了 ${run.localConversationContext.sessionCount} 条会话、${run.localConversationContext.stageCount} 个需求阶段。请将下面的动态会话证据与能力包自身证据合并理解；后续阶段优先于冲突的早期要求。\n\n${run.localConversationContext.executionBrief}\n\n` : ''}系统已经自动读取联合会话来源、项目证据、文件演化、产物链路、冲突登记、主动读取计划、最新纠正和改进流程。请继续检索必要证据、检查工作区、执行修改并验证。` },
    ];
    if (continuation) messages.push({ role: 'user', content: `继续要求：${continuation}` });
    if (continuation && run.step >= run.maxSteps) run.maxSteps = Math.min(run.maxSteps + workspace.maxSteps, 120);
    run.error = null;
    run.providerMessages = messages;
    run.status = '规划';
    run.phase = '规划';
    emit(run, send, 'task_state', { status: run.status, phase: run.phase });
    await saveRun(stateRoot, run);
    const tools = allowedTools(workspace);
    for (let step = run.step; step < run.maxSteps; step += 1) {
      if (controller.signal.aborted) throw new HttpError(499, 'task_cancelled', '任务已停止。');
      run.step = step + 1;
      run.status = step === 0 ? '规划' : '执行';
      run.phase = run.status;
      emit(run, send, 'step_start', { step: run.step, maxSteps: run.maxSteps, status: run.status });
      const completion = await chatCompletion({ model: undefined, messages, tools, tool_choice: 'auto', temperature: 0.2 }, controller.signal);
      const message = completion?.choices?.[0]?.message;
      if (!message) throw new HttpError(502, 'empty_model_response', '模型没有返回可执行内容。');
      messages.push(message);
      run.providerMessages = messages;
      if (message.content) emit(run, send, 'assistant_delta', { content: cleanText(message.content, 120000) });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        run.result = cleanText(message.content || '任务已结束，但模型没有提供文字结果。', 160000);
        run.status = run.verification.length ? '完成' : '完成';
        run.phase = '完成';
        run.providerMessages = messages;
        emit(run, send, 'task_complete', { status: run.status, result: run.result, changes: run.changeJournal.length, commands: run.commands.length, checkpoints: run.checkpoints.length, verification: run.verification });
        await saveRun(stateRoot, run);
        return run;
      }
      for (const call of calls) {
        const name = call.function?.name;
        const args = parseArguments(call.function?.arguments);
        const trace = { id: call.id || createId('tool'), name, arguments: args, status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
        run.toolTrace.push(trace);
        emit(run, send, 'tool_start', { trace });
        try {
          const result = await executeTool(agentRoot, stateRoot, run, name, args, controller.signal);
          trace.status = 'success';
          trace.result = result;
          trace.finishedAt = new Date().toISOString();
          emit(run, send, 'tool_result', { trace });
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) });
        } catch (error) {
          trace.status = 'failed';
          trace.error = { code: error.code || 'tool_failed', message: redactSecrets(error.message) };
          trace.finishedAt = new Date().toISOString();
          emit(run, send, 'tool_result', { trace });
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify({ error: trace.error }) });
        }
        run.providerMessages = messages;
        await saveRun(stateRoot, run);
      }
    }
    throw new HttpError(409, 'agent_step_limit', `已达到 ${run.maxSteps} 个自动步骤。任务状态已保存，可以继续执行。`);
  } catch (error) {
    run.providerMessages ||= [];
    run.status = error.code === 'task_cancelled' ? '已停止' : '失败';
    run.phase = run.status;
    run.error = { code: error.code || 'task_failed', message: redactSecrets(error.message) };
    emit(run, send, 'task_error', { status: run.status, error: run.error, resumable: true });
    await saveRun(stateRoot, run);
    throw error;
  } finally {
    controllers.delete(run.id);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export function cancelRun(runId) {
  const controller = controllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}
