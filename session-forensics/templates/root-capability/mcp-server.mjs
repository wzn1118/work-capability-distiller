#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const stateRoot = path.join(packageRoot, 'mcp-state');
const extractionPath = path.join(packageRoot, 'conversation-extraction.json');
const contractPath = path.join(packageRoot, 'capability-contract.json');
const blueprintPath = path.join(packageRoot, 'workflow-blueprint.json');
const projectPortfolioPath = path.join(packageRoot, 'project-portfolio.json');
const projectUnderstandingPath = path.join(packageRoot, 'project-understanding.json');
const projectKnowledgeV4Path = path.join(packageRoot, 'project-knowledge-v4.json');
const workspaceRoot = process.env.CAPABILITY_MCP_WORKSPACE_ROOT ? path.resolve(process.env.CAPABILITY_MCP_WORKSPACE_ROOT) : '';
const allowWrite = process.env.CAPABILITY_MCP_ALLOW_WRITE === '1';
const allowDelete = process.env.CAPABILITY_MCP_ALLOW_DELETE === '1';
const allowCommand = process.env.CAPABILITY_MCP_ALLOW_COMMAND === '1';
const allowGitWrite = process.env.CAPABILITY_MCP_ALLOW_GIT_WRITE === '1';
const allowNetwork = process.env.CAPABILITY_MCP_ALLOW_NETWORK === '1';
const skillRoots = String(process.env.CAPABILITY_MCP_SKILL_ROOTS || path.join(process.env.USERPROFILE || '', '.agents', 'skills')).split(path.delimiter).map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
const maxBytes = 8 * 1024 * 1024;
const textExtensions = new Set(['.txt', '.md', '.json', '.jsonl', '.ndjson', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.scss', '.py', '.ps1', '.sh', '.yaml', '.yml', '.toml', '.xml', '.csv', '.sql', '.vue', '.svelte', '.java', '.cs', '.go', '.rs']);
const ignored = new Set(['.git', 'node_modules', '.capability-state', 'dist', 'build', '.next', '.cache']);
const sensitive = /(key|token|secret|password|credential|authorization|cookie)/i;
const managedProcesses = new Map();

async function terminateProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(resolve, 1500);
      killer.once('close', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); resolve(); });
    });
  } else child.kill('SIGTERM');
}

const tools = [
  tool('get_capability_contract', '读取能力说明', '返回能力包的直白功能、权限、限制和验收标准。', {}),
  tool('get_conversation_summary', '读取会话摘要', '返回完整原对话的统计、需求演变和观测到的工具。', {}),
  tool('search_original_conversation', '搜索原对话', '按关键词、角色、阶段或工具搜索完整原始证据。', { query: { type: 'string' }, actor: { type: 'string' }, toolName: { type: 'string' }, stage: { type: 'integer' }, maxResults: { type: 'integer' } }, ['query']),
  tool('get_original_conversation_stage', '读取需求阶段', '读取一个阶段中的用户消息、助手内容、工具调用、命令和文件变更。', { stage: { type: 'integer' } }, ['stage']),
  tool('get_requirement_changes', '读取需求演变', '按时间读取用户目标、扩展、细化和纠正。', {}),
  tool('get_latest_corrections', '读取最新纠正', '返回必须覆盖早期方案的后续纠正。', { limit: { type: 'integer' } }),
  tool('get_improved_workflow', '读取升级流程', '返回从取证、规划、修改到验收和恢复的完整流程。', {}),
  tool('get_acceptance_matrix', '读取验收标准', '返回每一项完成标准以及所需证据。', {}),
  tool('get_project_portfolio', '读取项目组合', '返回所选多条会话分别属于哪个项目、识别依据、置信度和每个项目的证据摘要；跨项目任务应先读取此结果。', {}),
  tool('get_project_understanding', '读取项目深度理解', '返回跨会话证据图、逐文件演化、生成产物链路、冲突登记和主动读取验证计划；每项结论都保留证据编号。', { group: { type: 'string', enum: ['摘要', '文件演化', '产物链路', '冲突登记', '主动读取计划', '全部'] }, maxItems: { type: 'integer' } }),
  tool('get_project_knowledge_v4', '读取项目级蒸馏知识', '分页读取跨会话时间线、语义阶段、逐条证据、项目模型、文件变更、依赖影响、产物复现、项目快照与待补证问题。', { group: { type: 'string', enum: ['摘要', '语义阶段', '证据账本', '项目模型', '项目图', '文件版本', '产物血缘', '跨会话时间线', '文件变更矩阵', '依赖影响', '产物复现', '项目快照', '待补证问题', '后续决策', '覆盖率', '主动读取记录', '全部'] }, offset: { type: 'integer' }, maxItems: { type: 'integer' } }),
  tool('create_execution_plan', '生成执行计划', '把当前任务和原对话中的最新纠正编译成可执行清单。', { task: { type: 'string' }, workspace: { type: 'string' } }, ['task']),
  tool('get_package_artifact', '读取能力包文件', '读取能力包内允许公开的完整说明或结构化证据文件。', { artifact: { type: 'string', enum: ['README.md', 'conversation-extraction.json', 'capability-contract.json', 'workflow-blueprint.json', 'package-manifest.json', 'project-portfolio.json', 'project-portfolio.md', 'project-evidence.json', 'project-evidence.md', 'project-understanding.json', 'project-understanding.md', 'project-knowledge-v4.json', 'project-knowledge-v4.md', 'semantic-stages.json', 'evidence-ledger.ndjson', 'project-model.json', 'project-graph.json', 'file-versions.ndjson', 'artifact-lineage.json', 'cross-session-timeline.ndjson', 'file-change-matrix.json', 'dependency-impact.json', 'artifact-reproducibility.json', 'project-snapshot.json', 'open-evidence-questions.json', 'decision-conflicts.json', 'coverage.json', 'active-read-log.ndjson', 'conversation-distillation.md'] }, maxChars: { type: 'integer' } }, ['artifact']),
  tool('list_workspace_files', '浏览工作区', '列出工作区目录和文件，自动隐藏依赖与内部状态目录。', { path: { type: 'string' }, depth: { type: 'integer' }, maxItems: { type: 'integer' } }),
  tool('read_workspace_file', '读取工作区文件', '按行读取工作区内的 UTF-8 文本文件。', { path: { type: 'string' }, startLine: { type: 'integer' }, maxLines: { type: 'integer' } }, ['path']),
  tool('search_workspace_files', '搜索工作区文件', '在工作区文本文件中搜索关键词并返回路径和行号。', { query: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer' }, caseSensitive: { type: 'boolean' } }, ['query']),
  tool('create_directory', '创建目录', '在工作区内创建目录。需要开启写入权限。', { path: { type: 'string' }, recursive: { type: 'boolean' } }, ['path']),
  tool('write_workspace_file', '写入文件', '创建或覆盖 UTF-8 文件。写入前保存检查点。需要开启写入权限。', { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, ['path', 'content']),
  tool('replace_workspace_text', '精确替换', '唯一匹配旧文本后写入，避免误改。需要开启写入权限。', { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, reason: { type: 'string' } }, ['path', 'oldText', 'newText']),
  tool('apply_workspace_edits', '批量编辑', '一次执行多个唯一文本替换，任一项失败则不写入。需要开启写入权限。', { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } }, reason: { type: 'string' } }, ['path', 'edits']),
  tool('move_workspace_path', '移动或重命名', '在工作区内移动文件或目录。需要开启写入权限。', { source: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } }, ['source', 'target']),
  tool('delete_workspace_path', '删除路径', '删除前保存检查点，只能删除工作区内路径。需要开启删除权限。', { path: { type: 'string' }, recursive: { type: 'boolean' }, reason: { type: 'string' } }, ['path']),
  tool('create_workspace_checkpoint', '创建检查点', '为工作区内的文件或目录创建可恢复副本。需要开启写入权限。', { path: { type: 'string' }, reason: { type: 'string' } }, ['path']),
  tool('restore_workspace_checkpoint', '恢复检查点', '把文件或目录恢复到指定检查点，并记录恢复动作。需要开启写入权限。', { checkpointId: { type: 'string' } }, ['checkpointId']),
  tool('get_change_journal', '读取变更记录', '读取 MCP 会话中由本服务执行的修改、检查点和命令。', {}),
  tool('execute_workspace_command', '执行本地命令', '在工作区执行本地命令并返回退出码和输出。需要开启命令权限。', { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, ['command']),
  tool('run_verification', '运行验收命令', '依次运行多个命令并返回每项退出码。需要开启命令权限。', { commands: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } }, ['commands']),
  tool('inspect_project', '理解项目结构', '识别项目标记、语言、包脚本和 Git 状态。用于开始工程任务前建立项目上下文。', { path: { type: 'string' } }),
  tool('read_project_instructions', '读取项目约定', '读取工作区中的 AGENTS.md、README、CONTRIBUTING 等项目说明，避免违背本地约定。', { path: { type: 'string' }, maxFiles: { type: 'integer' } }),
  tool('apply_workspace_patch', '应用标准补丁', '应用 Begin Patch / Update File / Add File / Delete File 格式补丁。先完整校验，再创建检查点并写入。需要写入或删除权限。', { patch: { type: 'string' }, reason: { type: 'string' } }, ['patch']),
  tool('get_workspace_file_diff', '查看文件检查点差异', '将当前文件与最近检查点进行逐行差异比较，展示修改前后内容。', { path: { type: 'string' }, checkpointId: { type: 'string' } }, ['path']),
  tool('git_status', '查看 Git 状态', '返回当前分支、已修改和未跟踪文件。需要命令执行权限。', {}),
  tool('git_diff', '查看 Git 差异', '查看工作区或指定路径的 Git diff。需要命令执行权限。', { path: { type: 'string' }, staged: { type: 'boolean' } }),
  tool('git_log', '查看 Git 提交记录', '返回最近提交记录，用于理解变更历史。需要命令执行权限。', { limit: { type: 'integer' } }),
  tool('git_branch', '查看或创建 Git 分支', '查看分支，或在开启 Git 写入权限后创建分支。不会推送远端。', { create: { type: 'string' } }),
  tool('git_commit', '创建 Git 提交', '按给定中文说明提交已暂存内容。需要命令执行和 Git 写入权限；不会推送远端。', { message: { type: 'string' } }, ['message']),
  tool('start_workspace_process', '启动受管理长进程', '在工作区启动开发服务器、监听器或其他长任务，并保留输出、标准输入和停止控制。需要命令执行权限。', { command: { type: 'string' } }, ['command']),
  tool('read_workspace_process_output', '读取长进程输出', '读取受管理长进程的最新标准输出和错误输出。需要命令执行权限。', { processId: { type: 'string' } }, ['processId']),
  tool('write_workspace_process_input', '向长进程发送输入', '向受管理长进程的标准输入发送一行文本。需要命令执行权限。', { processId: { type: 'string' }, input: { type: 'string' } }, ['processId', 'input']),
  tool('stop_workspace_process', '停止长进程', '停止指定受管理长进程。需要命令执行权限。', { processId: { type: 'string' } }, ['processId']),
  tool('list_workspace_processes', '查看受管理长进程', '列出本次 MCP 会话启动的长进程及其状态。需要命令执行权限。', {}),
  tool('list_skills', '列出可复用 Skill', '列出配置目录中的 SKILL.md，以便读取本地工作流和复用说明。', { query: { type: 'string' }, maxResults: { type: 'integer' } }),
  tool('read_skill', '读取 Skill 说明', '读取一个已列出 Skill 的 SKILL.md 内容，不会执行其中命令。', { skillId: { type: 'string' }, maxChars: { type: 'integer' } }, ['skillId']),
  tool('fetch_url', '联网获取公开资料', '受控读取公开 HTTP/HTTPS 地址，只发起 GET 请求、不携带凭据，并限制正文大小。需要开启网络访问权限。', { url: { type: 'string' }, timeoutMs: { type: 'integer' } }, ['url']),
];

function tool(name, title, description, properties, required = []) {
  return { name, title, description, inputSchema: { type: 'object', properties, required } };
}

function error(code, message, status = 400) {
  const value = new Error(message);
  value.code = code;
  value.status = status;
  return value;
}

function clean(value, limit = 120000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loaded() {
  const [extraction, contract, blueprint, projectPortfolio, projectUnderstanding, projectKnowledgeV4] = await Promise.all([readJson(extractionPath), readJson(contractPath), readJson(blueprintPath), readJson(projectPortfolioPath).catch(() => null), readJson(projectUnderstandingPath).catch(() => null), readJson(projectKnowledgeV4Path).catch(() => null)]);
  return { extraction, contract, blueprint, projectPortfolio, projectUnderstanding, projectKnowledgeV4 };
}

async function ensureWorkspace() {
  if (!workspaceRoot) throw error('workspace_not_ready', '请在 MCP 配置中设置 CAPABILITY_MCP_WORKSPACE_ROOT。', 400);
  const stat = await fs.stat(workspaceRoot).catch(() => null);
  if (!stat?.isDirectory()) throw error('workspace_not_found', '找不到 MCP 工作区目录。', 400);
  return fs.realpath(workspaceRoot);
}

async function resolveWorkspacePath(input, allowMissing = false) {
  const root = await ensureWorkspace();
  const requested = String(input || '.').trim() || '.';
  if (path.isAbsolute(requested)) throw error('absolute_path_denied', '只接受相对工作区路径。', 400);
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('path_outside_workspace', '路径超出工作区。', 403);
  if (allowMissing) {
    let ancestor = candidate;
    while (ancestor !== root && !fsSync.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = await fs.realpath(ancestor).catch(() => null);
    const check = real ? path.relative(root, real) : '..';
    if (!real || check.startsWith('..') || path.isAbsolute(check)) throw error('symlink_outside_workspace', '目标路径通过链接跳出了工作区。', 403);
    return { root, absolute: candidate, relative: relative.split(path.sep).join('/') || '.' };
  }
  const real = await fs.realpath(candidate).catch(() => null);
  if (!real) throw error('path_not_found', `找不到路径：${requested}`, 404);
  const check = path.relative(root, real);
  if (check.startsWith('..') || path.isAbsolute(check)) throw error('symlink_outside_workspace', '路径通过链接跳出了工作区。', 403);
  return { root, absolute: real, relative: check.split(path.sep).join('/') || '.' };
}

async function listFiles(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  if (!(await fs.stat(target.absolute)).isDirectory()) throw error('not_directory', '目标必须是目录。');
  const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 6);
  const maximum = Math.min(Math.max(Number(args.maxItems) || 300, 1), 2000);
  const items = [];
  async function visit(current, level) {
    if (items.length >= maximum) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (items.length >= maximum || ignored.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const stat = await fs.lstat(absolute);
      const relative = path.relative(target.root, absolute).split(path.sep).join('/');
      items.push({ path: relative, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', bytes: entry.isFile() ? stat.size : null, modifiedAt: stat.mtime.toISOString() });
      if (entry.isDirectory() && level < depth) await visit(absolute, level + 1);
    }
  }
  await visit(target.absolute, 1);
  return { root: target.relative, count: items.length, truncated: items.length >= maximum, items };
}

async function readWorkspaceFile(args = {}) {
  const target = await resolveWorkspacePath(args.path);
  const stat = await fs.stat(target.absolute);
  if (!stat.isFile()) throw error('not_file', '目标必须是文件。');
  if (stat.size > maxBytes) throw error('file_too_large', '单次读取上限为 8MB。', 413);
  const lines = (await fs.readFile(target.absolute, 'utf8')).split(/\r?\n/);
  const startLine = Math.min(Math.max(Number(args.startLine) || 1, 1), Math.max(lines.length, 1));
  const maxLines = Math.min(Math.max(Number(args.maxLines) || 500, 1), 4000);
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  return { path: target.relative, startLine, endLine: startLine + selected.length - 1, totalLines: lines.length, truncated: startLine - 1 + selected.length < lines.length, content: clean(selected.join('\n'), 200000) };
}

async function searchWorkspaceFiles(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw error('query_required', '必须提供搜索关键词。');
  const target = await resolveWorkspacePath(args.path || '.');
  const maximum = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
  const sensitiveCase = args.caseSensitive === true;
  const needle = sensitiveCase ? query : query.toLocaleLowerCase('zh-CN');
  const results = [];
  async function visit(current) {
    if (results.length >= maximum) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (results.length >= maximum || ignored.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(absolute);
        if (stat.size > 2 * 1024 * 1024) continue;
        const lines = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maximum; index += 1) {
          const haystack = sensitiveCase ? lines[index] : lines[index].toLocaleLowerCase('zh-CN');
          if (haystack.includes(needle)) results.push({ path: path.relative(target.root, absolute).split(path.sep).join('/'), line: index + 1, text: clean(lines[index], 1200) });
        }
      }
    }
  }
  await visit(target.absolute);
  return { query, count: results.length, truncated: results.length >= maximum, results };
}

function requireWrite() { if (!allowWrite) throw error('write_permission_required', 'MCP 写入权限未开启。', 403); }
function requireDelete() { requireWrite(); if (!allowDelete) throw error('delete_permission_required', 'MCP 删除权限未开启。', 403); }
function requireCommand() { if (!allowCommand) throw error('command_permission_required', 'MCP 命令执行权限未开启。', 403); }
function requireGitWrite() { requireCommand(); if (!allowGitWrite) throw error('git_write_permission_required', 'MCP Git 写入权限未开启。', 403); }
function requireNetwork() { if (!allowNetwork) throw error('network_permission_required', 'MCP 网络访问权限未开启。', 403); }

async function snapshot(target) {
  const exists = await fs.stat(target.absolute).then(() => true).catch(() => false);
  if (!exists) return { exists: false, sha256: null, bytes: 0 };
  const stat = await fs.stat(target.absolute);
  if (!stat.isFile()) return { exists: true, sha256: null, bytes: null, type: 'directory' };
  const data = await fs.readFile(target.absolute);
  return { exists: true, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length, type: 'file' };
}

async function journal() { return readJson(path.join(stateRoot, 'journal.json')).catch(() => ({ changes: [], checkpoints: [], commands: [] })); }
async function saveJournal(value) { await fs.mkdir(stateRoot, { recursive: true }); await fs.writeFile(path.join(stateRoot, 'journal.json'), `${json(value)}\n`, 'utf8'); return value; }
async function rememberChange(item) { const value = await journal(); value.changes ||= []; value.changes.push(item); return saveJournal(value); }
async function rememberCheckpoint(item) { const value = await journal(); value.checkpoints ||= []; value.checkpoints.push(item); await saveJournal(value); return item; }

async function createWorkspaceCheckpoint(target, reason = '自动检查点') {
  requireWrite();
  const before = await snapshot(target);
  const id = crypto.randomUUID();
  const backupRoot = path.join(stateRoot, 'checkpoints', id);
  const backupPath = path.join(backupRoot, 'content');
  await fs.mkdir(backupRoot, { recursive: true });
  if (before.exists) {
    if (before.type === 'directory') await fs.cp(target.absolute, backupPath, { recursive: true, force: true });
    else await fs.copyFile(target.absolute, backupPath);
  }
  const checkpoint = { id, path: target.relative, before, backupPath: before.exists ? path.relative(stateRoot, backupPath).split(path.sep).join('/') : null, reason: clean(reason, 500), createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(backupRoot, 'metadata.json'), `${json(checkpoint)}\n`, 'utf8');
  return rememberCheckpoint(checkpoint);
}

async function restoreWorkspaceCheckpoint(args = {}) {
  requireWrite();
  const value = await journal();
  const checkpoint = (value.checkpoints || []).find((item) => item.id === String(args.checkpointId || ''));
  if (!checkpoint) throw error('checkpoint_not_found', '找不到这个检查点。', 404);
  const target = await resolveWorkspacePath(checkpoint.path, true);
  const beforeRestore = await snapshot(target);
  if (!checkpoint.before?.exists) {
    await fs.rm(target.absolute, { recursive: true, force: true });
  } else {
    const backupPath = path.resolve(stateRoot, checkpoint.backupPath || '');
    const relativeBackup = path.relative(path.join(stateRoot, 'checkpoints'), backupPath);
    if (relativeBackup.startsWith('..') || path.isAbsolute(relativeBackup)) throw error('checkpoint_invalid', '检查点路径无效。', 500);
    await fs.rm(target.absolute, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    if (checkpoint.before.type === 'directory') await fs.cp(backupPath, target.absolute, { recursive: true, force: true });
    else await fs.copyFile(backupPath, target.absolute);
  }
  const afterRestore = await snapshot(target);
  const change = { id: crypto.randomUUID(), action: 'restore', path: target.relative, checkpointId: checkpoint.id, before: beforeRestore, after: afterRestore, timestamp: new Date().toISOString() };
  await rememberChange(change);
  return { checkpoint, change };
}

async function writeWorkspaceFile(args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path, true);
  const before = await snapshot(target);
  const checkpoint = await createWorkspaceCheckpoint(target, args.reason || '写入前自动检查点');
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.writeFile(target.absolute, String(args.content ?? ''), 'utf8');
  const after = await snapshot(target);
  const change = { id: crypto.randomUUID(), action: before.exists ? 'overwrite' : 'create', path: target.relative, before, after, reason: clean(args.reason, 500), timestamp: new Date().toISOString() };
  await rememberChange(change);
  return { path: target.relative, bytes: after.bytes, sha256: after.sha256, checkpoint, change };
}

async function replaceWorkspaceText(args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path);
  const original = await fs.readFile(target.absolute, 'utf8');
  const oldText = String(args.oldText ?? '');
  if (!oldText) throw error('old_text_required', '必须提供 oldText。');
  const occurrences = original.split(oldText).length - 1;
  if (occurrences !== 1) throw error('replace_not_unique', `旧文本匹配 ${occurrences} 次，要求唯一匹配。`, 409);
  return writeWorkspaceFile({ ...args, content: original.replace(oldText, String(args.newText ?? '')) });
}

async function applyWorkspaceEdits(args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path);
  let content = await fs.readFile(target.absolute, 'utf8');
  for (const [index, edit] of (Array.isArray(args.edits) ? args.edits : []).entries()) {
    const oldText = String(edit.oldText ?? '');
    const count = oldText ? content.split(oldText).length - 1 : 0;
    if (count !== 1) throw error('edit_not_unique', `第 ${index + 1} 项匹配 ${count} 次，文件尚未写入。`, 409);
    content = content.replace(oldText, String(edit.newText ?? ''));
  }
  return writeWorkspaceFile({ path: args.path, content, reason: args.reason || '批量精确编辑' });
}

async function moveWorkspacePath(args = {}) {
  requireWrite();
  const source = await resolveWorkspacePath(args.source);
  const target = await resolveWorkspacePath(args.target, true);
  const sourceCheckpoint = await createWorkspaceCheckpoint(source, args.reason || '移动前源路径检查点');
  const targetCheckpoint = await createWorkspaceCheckpoint(target, args.reason || '移动前目标路径检查点');
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.rename(source.absolute, target.absolute);
  const change = { id: crypto.randomUUID(), action: 'move', path: source.relative, target: target.relative, timestamp: new Date().toISOString() };
  await rememberChange(change);
  return { change, checkpoints: [sourceCheckpoint, targetCheckpoint] };
}

async function deleteWorkspacePath(args = {}) {
  requireDelete();
  const target = await resolveWorkspacePath(args.path);
  if (target.relative === '.') throw error('delete_root_denied', '不能删除工作区根目录。', 403);
  const stat = await fs.stat(target.absolute);
  if (stat.isDirectory() && args.recursive !== true) throw error('recursive_required', '删除目录必须明确 recursive=true。');
  const checkpoint = await createWorkspaceCheckpoint(target, args.reason || '删除前自动检查点');
  await fs.rm(target.absolute, { recursive: stat.isDirectory() });
  const change = { id: crypto.randomUUID(), action: 'delete', path: target.relative, timestamp: new Date().toISOString() };
  await rememberChange(change);
  return { checkpoint, change };
}

async function runCommand(command, timeoutMs = 60000) {
  requireCommand();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, { cwd: workspaceRoot, shell: true, windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitive.test(name))), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const append = (value, chunk) => clean(value + chunk.toString('utf8'), 120000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; void terminateProcessTree(child); }, Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 300000));
    child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ command, exitCode, signal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr }); });
  });
}

async function runProgram(program, argumentsList = [], timeoutMs = 60000) {
  requireCommand();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(program, argumentsList.map((item) => String(item)), { cwd: workspaceRoot, shell: false, windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitive.test(name))), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const append = (value, chunk) => clean(value + chunk.toString('utf8'), 120000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; void terminateProcessTree(child); }, Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 300000));
    child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ command: [program, ...argumentsList].join(' '), exitCode, signal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr }); });
  });
}

async function inspectProject(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  const stat = await fs.stat(target.absolute);
  if (!stat.isDirectory()) throw error('not_directory', '项目路径必须是目录。');
  const listing = await listFiles({ path: target.relative, depth: 4, maxItems: 900 });
  const files = listing.items.filter((item) => item.type === 'file');
  const markers = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile', 'compose.yml', 'docker-compose.yml', 'vite.config.js', 'next.config.js', 'AGENTS.md'].filter((name) => files.some((item) => path.basename(item.path).toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN')));
  const languageCounts = new Map();
  for (const item of files) {
    const extension = path.extname(item.path).toLowerCase();
    if (extension) languageCounts.set(extension, (languageCounts.get(extension) || 0) + 1);
  }
  let packageScripts = {};
  const packageItem = files.find((item) => item.path === 'package.json' || item.path.endsWith('/package.json'));
  if (packageItem) {
    try { packageScripts = JSON.parse(await fs.readFile(path.join(target.root, packageItem.path), 'utf8')).scripts || {}; } catch { packageScripts = {}; }
  }
  const gitRoot = await fs.stat(path.join(target.absolute, '.git')).then((item) => item.isDirectory() || item.isFile()).catch(() => false);
  return { path: target.relative, markers, gitDetected: gitRoot, filesScanned: files.length, languages: [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([extension, count]) => ({ extension, count })), packageScripts };
}

async function readProjectInstructions(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  const listing = await listFiles({ path: target.relative, depth: 5, maxItems: 1600 });
  const names = new Set(['agents.md', 'readme.md', 'contributing.md', 'development.md', 'architecture.md', 'code_of_conduct.md']);
  const maximum = Math.min(Math.max(Number(args.maxFiles) || 12, 1), 40);
  const items = listing.items.filter((item) => item.type === 'file' && names.has(path.basename(item.path).toLocaleLowerCase('zh-CN'))).slice(0, maximum);
  const files = [];
  for (const item of items) {
    try { files.push(await readWorkspaceFile({ path: item.path, startLine: 1, maxLines: 900 })); } catch (cause) { files.push({ path: item.path, error: clean(cause.message || cause, 500) }); }
  }
  return { path: target.relative, count: files.length, files };
}

function splitPatchSections(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') throw error('patch_format_invalid', '补丁必须使用 *** Begin Patch 和 *** End Patch 包围。');
  const sections = []; let current = null;
  for (const line of lines.slice(1, -1)) {
    const match = line.match(/^\*\*\* (Update File|Add File|Delete File): (.+)$/);
    if (match) { if (current) sections.push(current); current = { action: match[1], path: match[2].trim(), lines: [] }; continue; }
    if (!current) { if (line.trim()) throw error('patch_format_invalid', '补丁区段必须以 Update File、Add File 或 Delete File 开头。'); continue; }
    current.lines.push(line);
  }
  if (current) sections.push(current);
  if (!sections.length) throw error('patch_empty', '补丁没有任何文件操作。');
  return sections;
}

function applyPatchHunks(original, patchLines) {
  const hunks = []; let current = [];
  for (const line of patchLines) {
    if (line.startsWith('@@')) { if (current.length) hunks.push(current); current = []; continue; }
    if (line === '\\ No newline at end of file') continue;
    if (!/^[ +\-]/.test(line)) throw error('patch_hunk_invalid', 'Update File 中每一行必须以空格、+ 或 - 开头。');
    current.push(line);
  }
  if (current.length) hunks.push(current);
  if (!hunks.length) throw error('patch_hunk_empty', 'Update File 缺少可应用的差异块。');
  let result = original;
  for (const hunk of hunks) {
    const oldLines = hunk.filter((line) => !line.startsWith('+')).map((line) => line.slice(1));
    const newLines = hunk.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
    const oldText = oldLines.join('\n'); const newText = newLines.join('\n');
    let index = result.indexOf(oldText);
    if (index < 0 && oldText) index = result.indexOf(`${oldText}\n`);
    if (index < 0) throw error('patch_context_missing', '补丁上下文与当前文件不匹配，未写入任何文件。', 409);
    const matched = result.startsWith(`${oldText}\n`, index) ? `${oldText}\n` : oldText;
    const replacement = matched.endsWith('\n') && newText && !newText.endsWith('\n') ? `${newText}\n` : newText;
    result = `${result.slice(0, index)}${replacement}${result.slice(index + matched.length)}`;
  }
  return result;
}

async function applyWorkspacePatch(args = {}) {
  requireWrite();
  const sections = splitPatchSections(args.patch);
  const prepared = [];
  for (const section of sections) {
    if (section.action === 'Add File') {
      const target = await resolveWorkspacePath(section.path, true);
      if (await fs.stat(target.absolute).then(() => true).catch(() => false)) throw error('patch_add_exists', `新增文件已存在：${target.relative}`, 409);
      if (section.lines.some((line) => !line.startsWith('+') && line !== '')) throw error('patch_add_invalid', 'Add File 的内容行必须以 + 开头。');
      prepared.push({ ...section, target, content: section.lines.filter(Boolean).map((line) => line.slice(1)).join('\n') });
      continue;
    }
    if (section.action === 'Delete File') {
      requireDelete();
      const target = await resolveWorkspacePath(section.path);
      prepared.push({ ...section, target });
      continue;
    }
    const target = await resolveWorkspacePath(section.path);
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw error('patch_update_not_file', `只能更新文件：${target.relative}`);
    prepared.push({ ...section, target, content: applyPatchHunks(await fs.readFile(target.absolute, 'utf8'), section.lines) });
  }
  const changes = [];
  for (const item of prepared) {
    if (item.action === 'Delete File') changes.push(await deleteWorkspacePath({ path: item.target.relative, recursive: false, reason: args.reason || '标准补丁删除文件' }));
    else changes.push(await writeWorkspaceFile({ path: item.target.relative, content: item.content, reason: args.reason || '标准补丁写入' }));
  }
  return { count: changes.length, changes };
}

function lineDiff(before, after) {
  const left = String(before || '').split(/\r?\n/); const right = String(after || '').split(/\r?\n/);
  const output = []; const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) output.push({ kind: 'removed', line: index + 1, text: left[index] });
    if (right[index] !== undefined) output.push({ kind: 'added', line: index + 1, text: right[index] });
    if (output.length >= 800) break;
  }
  return output;
}

async function getWorkspaceFileDiff(args = {}) {
  const target = await resolveWorkspacePath(args.path);
  const value = await journal();
  const checkpoint = args.checkpointId ? (value.checkpoints || []).find((item) => item.id === String(args.checkpointId)) : [...(value.checkpoints || [])].reverse().find((item) => item.path === target.relative);
  if (!checkpoint) return { path: target.relative, available: false, message: '尚未找到该文件的检查点。' };
  let before = '';
  if (checkpoint.before?.exists && checkpoint.before.type === 'file') before = await fs.readFile(path.resolve(stateRoot, checkpoint.backupPath), 'utf8');
  const after = await fs.readFile(target.absolute, 'utf8');
  return { path: target.relative, checkpointId: checkpoint.id, available: true, changed: before !== after, lines: lineDiff(before, after), before: clean(before, 100000), after: clean(after, 100000) };
}

async function gitStatus() { return runProgram('git', ['status', '--short', '--branch']); }
async function gitDiff(args = {}) { return runProgram('git', args.staged === true ? ['diff', '--cached', '--', ...(args.path ? [String(args.path)] : [])] : ['diff', '--', ...(args.path ? [String(args.path)] : [])]); }
async function gitLog(args = {}) { return runProgram('git', ['log', `-${Math.min(Math.max(Number(args.limit) || 12, 1), 80)}`, '--pretty=format:%h%x09%ad%x09%s', '--date=short']); }
async function gitBranch(args = {}) { if (args.create) { requireGitWrite(); return runProgram('git', ['switch', '-c', String(args.create)]); } return runProgram('git', ['branch', '--show-current']); }
async function gitCommit(args = {}) { requireGitWrite(); const message = String(args.message || '').trim(); if (!message) throw error('commit_message_required', '必须提供提交说明。'); const committed = await runProgram('git', ['commit', '-m', message]); return { committed, status: await gitStatus() }; }

function publicProcess(item) { return { id: item.id, command: item.command, pid: item.child.pid || null, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt || null, exitCode: item.exitCode ?? null, signal: item.signal || null, stdout: clean(item.stdout, 120000), stderr: clean(item.stderr, 120000) }; }

async function startWorkspaceProcess(args = {}) {
  requireCommand(); await ensureWorkspace(); const command = String(args.command || '').trim(); if (!command) throw error('process_command_required', '必须提供长进程命令。');
  const child = spawn(command, { cwd: workspaceRoot, shell: true, windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitive.test(name))), stdio: ['pipe', 'pipe', 'pipe'] });
  const item = { id: crypto.randomUUID(), command, child, status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '', exitCode: null, signal: null, endedAt: null };
  const append = (value, chunk) => clean(value + chunk.toString('utf8'), 120000);
  child.stdout.on('data', (chunk) => { item.stdout = append(item.stdout, chunk); }); child.stderr.on('data', (chunk) => { item.stderr = append(item.stderr, chunk); });
  child.on('error', (cause) => { item.status = 'failed'; item.stderr = clean(`${item.stderr}\n${cause.message}`, 120000); item.endedAt = new Date().toISOString(); });
  child.on('close', (exitCode, signal) => { item.status = exitCode === 0 ? 'completed' : 'stopped'; item.exitCode = exitCode; item.signal = signal; item.endedAt = new Date().toISOString(); });
  managedProcesses.set(item.id, item); return publicProcess(item);
}

function findProcess(processId) { const item = managedProcesses.get(String(processId || '')); if (!item) throw error('process_not_found', '找不到该受管理长进程。', 404); return item; }
async function readWorkspaceProcessOutput(args = {}) { requireCommand(); return publicProcess(findProcess(args.processId)); }
async function writeWorkspaceProcessInput(args = {}) { requireCommand(); const item = findProcess(args.processId); if (!item.child.stdin.writable) throw error('process_stdin_closed', '该进程的标准输入已经关闭。', 409); item.child.stdin.write(`${String(args.input || '')}\n`); return { process: publicProcess(item), sent: true }; }
async function stopWorkspaceProcess(args = {}) { requireCommand(); const item = findProcess(args.processId); if (item.status === 'running') { item.status = 'stopping'; await terminateProcessTree(item.child); } return publicProcess(item); }
async function listWorkspaceProcesses() { requireCommand(); return { count: managedProcesses.size, processes: [...managedProcesses.values()].map(publicProcess) }; }

async function listSkills(args = {}) {
  const query = String(args.query || '').toLocaleLowerCase('zh-CN'); const maximum = Math.min(Math.max(Number(args.maxResults) || 120, 1), 500); const items = [];
  for (const [rootIndex, root] of skillRoots.entries()) {
    if (!fsSync.existsSync(root)) continue;
    const visit = async (current, depth) => {
      if (items.length >= maximum || depth > 4) return;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (items.length >= maximum || ignored.has(entry.name)) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(absolute, depth + 1);
        else if (entry.isFile() && entry.name === 'SKILL.md') { const relative = path.relative(root, absolute).split(path.sep).join('/'); if (!query || relative.toLocaleLowerCase('zh-CN').includes(query)) items.push({ id: `${rootIndex}:${relative}`, name: path.basename(path.dirname(absolute)), path: relative }); }
      }
    };
    await visit(root, 1);
  }
  return { roots: skillRoots, count: items.length, skills: items };
}

async function readSkill(args = {}) {
  const match = String(args.skillId || '').match(/^(\d+):(.+)$/); if (!match) throw error('skill_id_invalid', 'skillId 必须来自 list_skills 返回的 id。');
  const root = skillRoots[Number(match[1])]; if (!root) throw error('skill_root_missing', 'Skill 根目录不存在。', 404);
  const candidate = path.resolve(root, match[2]); const relative = path.relative(root, candidate); if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(candidate) !== 'SKILL.md') throw error('skill_path_denied', 'Skill 路径不在允许范围。', 403);
  const content = await fs.readFile(candidate, 'utf8'); return { skillId: args.skillId, path: match[2], content: clean(content, Math.min(Math.max(Number(args.maxChars) || 100000, 1000), 400000)) };
}

async function fetchUrl(args = {}) {
  requireNetwork(); const url = new URL(String(args.url || '')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('url_denied', '只允许不含凭据的公开 HTTP/HTTPS 地址。', 403);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(args.timeoutMs) || 20000, 1000), 60000));
  try { const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'ConversationCapabilityMCP/3.0' } }); const bytes = new Uint8Array(await response.arrayBuffer()); return { url: response.url, status: response.status, ok: response.ok, contentType: response.headers.get('content-type') || '', truncated: bytes.length > 1024 * 1024, content: clean(Buffer.from(bytes.subarray(0, 1024 * 1024)).toString('utf8'), 1000000) }; }
  finally { clearTimeout(timer); }
}

function pageKnowledgeItems(items, args = {}) {
  const source = Array.isArray(items) ? items : [];
  const offset = Math.max(Number(args.offset) || 0, 0);
  const maximum = Math.min(Math.max(Number(args.maxItems) || 100, 1), 5000);
  return { total: source.length, offset, count: Math.max(0, Math.min(maximum, source.length - offset)), hasMore: offset + maximum < source.length, nextOffset: offset + maximum < source.length ? offset + maximum : null, items: source.slice(offset, offset + maximum) };
}

async function execute(name, args = {}) {
  const { extraction, contract, blueprint, projectPortfolio, projectUnderstanding, projectKnowledgeV4 } = await loaded();
  if (name === 'get_capability_contract') return contract;
  if (name === 'get_conversation_summary') return { summary: extraction.summary, coverage: extraction.coverage, statistics: extraction.statistics, observedTools: extraction.observedTools, observedFiles: extraction.observedFiles, requirementEvolution: extraction.requirementEvolution };
  if (name === 'search_original_conversation') {
    const query = String(args.query || '').toLocaleLowerCase('zh-CN'); const actor = String(args.actor || '').toLocaleLowerCase('zh-CN'); const toolName = String(args.toolName || '').toLocaleLowerCase('zh-CN'); const stage = Number(args.stage) || 0; const maximum = Math.min(Math.max(Number(args.maxResults) || 50, 1), 500);
    const results = (extraction.timeline || []).filter((item) => (!query || JSON.stringify(item).toLocaleLowerCase('zh-CN').includes(query)) && (!actor || String(item.actor || '').toLocaleLowerCase('zh-CN') === actor) && (!toolName || String(item.name || '').toLocaleLowerCase('zh-CN').includes(toolName)) && (!stage || Number(item.stage || 0) === stage)).slice(0, maximum);
    return { query: args.query || '', count: results.length, results };
  }
  if (name === 'get_original_conversation_stage') {
    const stage = extraction.stages.find((item) => Number(item.index) === Number(args.stage));
    if (!stage) throw error('stage_not_found', `找不到需求阶段 ${args.stage}。`, 404);
    return stage;
  }
  if (name === 'get_requirement_changes') return { requirementEvolution: extraction.requirementEvolution || [], corrections: extraction.corrections || [] };
  if (name === 'get_latest_corrections') return { corrections: (extraction.corrections || []).slice(0, Math.min(Math.max(Number(args.limit) || 12, 1), 100)) };
  if (name === 'get_improved_workflow') return { workflow: extraction.improvedWorkflow || blueprint.capabilityContract.workflow, recoveryRules: extraction.recoveryRules || [] };
  if (name === 'get_acceptance_matrix') return { acceptanceMatrix: extraction.acceptanceMatrix || blueprint.capabilityContract.acceptanceMatrix };
  if (name === 'get_project_portfolio') {
    if (!projectPortfolio) return { available: false, message: '能力包中没有项目组合记录。' };
    return {
      available: true,
      crossProject: Boolean(projectPortfolio.crossProject),
      mode: projectPortfolio.mode || '未识别',
      recommendedMode: projectPortfolio.recommendedMode || '按证据处理',
      projects: (projectPortfolio.projects || []).map((project) => ({ projectId: project.projectId, name: project.name, root: project.root, confidence: project.confidence, markers: project.markers || [], sessionCount: project.sessionCount || (project.sessions || []).length || 0, evidenceSummary: project.evidenceSummary || project.evidence?.summary || null, evidenceError: project.evidenceError || null })),
      sessionAssignments: projectPortfolio.sessionAssignments || [],
      unassignedSessions: projectPortfolio.unassignedSessions || [],
    };
  }
  if (name === 'get_project_understanding') {
    if (!projectUnderstanding) return { available: false, message: '能力包未包含项目文件夹，当前没有项目级证据图。' };
    const maximum = Math.min(Math.max(Number(args.maxItems) || 120, 1), 800);
    const group = String(args.group || '摘要');
    const all = group === '全部';
    const result = {
      available: true,
      project: projectUnderstanding.project || null,
      purpose: projectUnderstanding.purpose || null,
      scope: projectUnderstanding.scope || null,
      evidenceGraph: projectUnderstanding.evidenceGraph?.statistics || null,
    };
    if (all || group === '文件演化') result.fileEvolution = (projectUnderstanding.fileEvolution || []).slice(0, maximum);
    if (all || group === '产物链路') result.generatedArtifactLineage = (projectUnderstanding.fileEvolution || []).filter((item) => item.kind === '生成产物').slice(0, maximum).map((item) => ({ path: item.path, lineage: item.lineage || [], evidenceIds: item.evidenceIds || [] }));
    if (all || group === '冲突登记') result.conflictRegister = (projectUnderstanding.conflictRegister || []).slice(0, maximum);
    if (all || group === '主动读取计划') result.activeReadPlan = (projectUnderstanding.activeReadPlan || []).slice(0, maximum);
    return result;
  }
  if (name === 'get_project_knowledge_v4') {
    if (!projectKnowledgeV4) return { available: false, message: '能力包未包含 V4 多会话项目知识层。' };
    const group = String(args.group || '摘要');
    const groups = {
      摘要: { schemaVersion: projectKnowledgeV4.schemaVersion, generatedAt: projectKnowledgeV4.generatedAt, name: projectKnowledgeV4.name, summary: projectKnowledgeV4.summary, coverage: projectKnowledgeV4.coverage, graphStatistics: projectKnowledgeV4.projectGraph?.statistics || null },
      语义阶段: pageKnowledgeItems(projectKnowledgeV4.semanticStages, args),
      证据账本: pageKnowledgeItems(projectKnowledgeV4.evidenceLedger, args),
      项目模型: projectKnowledgeV4.projectModel,
      项目图: { statistics: projectKnowledgeV4.projectGraph?.statistics || null, nodes: pageKnowledgeItems(projectKnowledgeV4.projectGraph?.nodes, args), edges: pageKnowledgeItems(projectKnowledgeV4.projectGraph?.edges, args) },
      文件版本: pageKnowledgeItems(projectKnowledgeV4.fileVersions, args),
      产物血缘: pageKnowledgeItems(projectKnowledgeV4.artifactLineage, args),
      跨会话时间线: pageKnowledgeItems(projectKnowledgeV4.crossSessionTimeline, args),
      文件变更矩阵: pageKnowledgeItems(projectKnowledgeV4.fileChangeMatrix, args),
      依赖影响: projectKnowledgeV4.dependencyImpact,
      产物复现: pageKnowledgeItems(projectKnowledgeV4.artifactReproducibility, args),
      项目快照: projectKnowledgeV4.projectSnapshot,
      待补证问题: pageKnowledgeItems(projectKnowledgeV4.openEvidenceQuestions, args),
      后续决策: pageKnowledgeItems(projectKnowledgeV4.decisionConflicts, args),
      覆盖率: projectKnowledgeV4.coverage,
      主动读取记录: pageKnowledgeItems(projectKnowledgeV4.activeReadLog, args),
      全部: { schemaVersion: projectKnowledgeV4.schemaVersion, generatedAt: projectKnowledgeV4.generatedAt, name: projectKnowledgeV4.name, summary: projectKnowledgeV4.summary, semanticStages: pageKnowledgeItems(projectKnowledgeV4.semanticStages, args), evidenceLedger: pageKnowledgeItems(projectKnowledgeV4.evidenceLedger, args), projectModel: projectKnowledgeV4.projectModel, projectGraph: { statistics: projectKnowledgeV4.projectGraph?.statistics || null, nodes: pageKnowledgeItems(projectKnowledgeV4.projectGraph?.nodes, args), edges: pageKnowledgeItems(projectKnowledgeV4.projectGraph?.edges, args) }, fileVersions: pageKnowledgeItems(projectKnowledgeV4.fileVersions, args), artifactLineage: pageKnowledgeItems(projectKnowledgeV4.artifactLineage, args), crossSessionTimeline: pageKnowledgeItems(projectKnowledgeV4.crossSessionTimeline, args), fileChangeMatrix: pageKnowledgeItems(projectKnowledgeV4.fileChangeMatrix, args), dependencyImpact: projectKnowledgeV4.dependencyImpact, artifactReproducibility: pageKnowledgeItems(projectKnowledgeV4.artifactReproducibility, args), projectSnapshot: projectKnowledgeV4.projectSnapshot, openEvidenceQuestions: pageKnowledgeItems(projectKnowledgeV4.openEvidenceQuestions, args), decisionConflicts: pageKnowledgeItems(projectKnowledgeV4.decisionConflicts, args), coverage: projectKnowledgeV4.coverage, activeReadLog: pageKnowledgeItems(projectKnowledgeV4.activeReadLog, args) },
    };
    if (!(group in groups)) throw error('project_knowledge_v4_group_invalid', 'V4 项目知识分组名称无效。');
    return { available: true, group, content: groups[group] };
  }
  if (name === 'create_execution_plan') return { task: clean(args.task, 24000), workspace: clean(args.workspace || workspaceRoot || '未选择', 1000), principles: contract.operatingPrinciples, latestCorrections: contract.latestCorrections, steps: contract.workflow, acceptance: contract.acceptanceMatrix, status: '已生成清单，尚未修改文件或运行命令' };
  if (name === 'get_package_artifact') {
    const allowed = new Set(['README.md', 'conversation-extraction.json', 'capability-contract.json', 'workflow-blueprint.json', 'package-manifest.json', 'project-portfolio.json', 'project-portfolio.md', 'project-evidence.json', 'project-evidence.md', 'project-understanding.json', 'project-understanding.md', 'project-knowledge-v4.json', 'project-knowledge-v4.md', 'semantic-stages.json', 'evidence-ledger.ndjson', 'project-model.json', 'project-graph.json', 'file-versions.ndjson', 'artifact-lineage.json', 'cross-session-timeline.ndjson', 'file-change-matrix.json', 'dependency-impact.json', 'artifact-reproducibility.json', 'project-snapshot.json', 'open-evidence-questions.json', 'decision-conflicts.json', 'coverage.json', 'active-read-log.ndjson', 'conversation-distillation.md']);
    if (!allowed.has(args.artifact)) throw error('artifact_denied', '这个文件不在 MCP 公开清单中。', 403);
    const value = await fs.readFile(path.join(packageRoot, args.artifact), 'utf8');
    return { artifact: args.artifact, content: clean(value, Math.min(Math.max(Number(args.maxChars) || 200000, 1000), 600000)) };
  }
  if (name === 'list_workspace_files') return listFiles(args);
  if (name === 'read_workspace_file') return readWorkspaceFile(args);
  if (name === 'search_workspace_files') return searchWorkspaceFiles(args);
  if (name === 'create_directory') { requireWrite(); const target = await resolveWorkspacePath(args.path, true); await fs.mkdir(target.absolute, { recursive: args.recursive !== false }); return { path: target.relative, created: true }; }
  if (name === 'write_workspace_file') return writeWorkspaceFile(args);
  if (name === 'replace_workspace_text') return replaceWorkspaceText(args);
  if (name === 'apply_workspace_edits') return applyWorkspaceEdits(args);
  if (name === 'move_workspace_path') return moveWorkspacePath(args);
  if (name === 'delete_workspace_path') return deleteWorkspacePath(args);
  if (name === 'create_workspace_checkpoint') { requireWrite(); return createWorkspaceCheckpoint(await resolveWorkspacePath(args.path, true), args.reason); }
  if (name === 'restore_workspace_checkpoint') return restoreWorkspaceCheckpoint(args);
  if (name === 'get_change_journal') return journal();
  if (name === 'execute_workspace_command') { const result = await runCommand(args.command, args.timeoutMs); const value = await journal(); value.commands ||= []; value.commands.push({ ...result, timestamp: new Date().toISOString() }); await saveJournal(value); return result; }
  if (name === 'run_verification') { const checks = []; for (const command of (Array.isArray(args.commands) ? args.commands : []).slice(0, 12)) checks.push(await runCommand(command, args.timeoutMs)); const value = await journal(); value.commands ||= []; value.commands.push(...checks.map((item) => ({ ...item, verification: true, timestamp: new Date().toISOString() }))); await saveJournal(value); return { passed: checks.every((item) => item.exitCode === 0 && !item.timedOut), checks }; }
  if (name === 'inspect_project') return inspectProject(args);
  if (name === 'read_project_instructions') return readProjectInstructions(args);
  if (name === 'apply_workspace_patch') return applyWorkspacePatch(args);
  if (name === 'get_workspace_file_diff') return getWorkspaceFileDiff(args);
  if (name === 'git_status') return gitStatus();
  if (name === 'git_diff') return gitDiff(args);
  if (name === 'git_log') return gitLog(args);
  if (name === 'git_branch') return gitBranch(args);
  if (name === 'git_commit') return gitCommit(args);
  if (name === 'start_workspace_process') return startWorkspaceProcess(args);
  if (name === 'read_workspace_process_output') return readWorkspaceProcessOutput(args);
  if (name === 'write_workspace_process_input') return writeWorkspaceProcessInput(args);
  if (name === 'stop_workspace_process') return stopWorkspaceProcess(args);
  if (name === 'list_workspace_processes') return listWorkspaceProcesses();
  if (name === 'list_skills') return listSkills(args);
  if (name === 'read_skill') return readSkill(args);
  if (name === 'fetch_url') return fetchUrl(args);
  throw error('unknown_tool', `不认识工具：${name}。`, 404);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondTool(id, result, isError = false) {
  respond(id, isError ? { isError: true, content: [{ type: 'text', text: json(result) }] } : { content: [{ type: 'text', text: json(result) }], structuredContent: result });
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') return respond(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'root-conversation-capability-mcp', version: '3.0.0' }, instructions: '这是从完整原对话重建的中文 Codex 工程 MCP：证据、项目理解、精确补丁、Git、受管理进程、Skill、联网取证、验证和恢复。' });
  if (message.method === 'ping') return respond(message.id, {});
  if (message.method === 'tools/list') return respond(message.id, { tools });
  if (message.method === 'tools/call') {
    try { return respondTool(message.id, await execute(message.params?.name, message.params?.arguments || {})); }
    catch (cause) { return respondTool(message.id, { code: cause.code || 'mcp_error', message: clean(cause.message || cause) }, true); }
  }
  if (message.id !== undefined) return respondError(message.id, -32601, `不支持方法：${message.method}`);
}

let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines.filter(Boolean)) {
    queue = queue.then(async () => {
      let message = null;
      try { message = JSON.parse(line); await handle(message); }
      catch (cause) { if (message?.id !== undefined) respondError(message.id, -32600, clean(cause.message || cause)); }
    });
  }
});
