import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspaceConfig, filteredCommandEnvironment, publicWorkspaceConfig } from './config.mjs';
import { HttpError, cleanText, createId } from './shared.mjs';

const ignoredDirectories = new Set(['.git', 'node_modules', '.capability-state', 'dist', 'build', '.next', '.cache']);
const textExtensions = new Set(['.txt', '.md', '.json', '.jsonl', '.ndjson', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.scss', '.py', '.ps1', '.sh', '.yaml', '.yml', '.toml', '.xml', '.csv', '.sql', '.vue', '.svelte', '.java', '.cs', '.go', '.rs']);
const projectMarkerFiles = ['package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'vite.config.js', 'next.config.js'];
const instructionFiles = new Set(['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'CONTRIBUTING', 'DEVELOPMENT.md', 'ARCHITECTURE.md']);
const managedProcesses = new Map();

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(resolve, 1500);
      killer.once('close', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); resolve(); });
    });
    return;
  }

  let signalledGroup = false;
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      signalledGroup = true;
    } catch {}
  }
  if (!signalledGroup) {
    try { child.kill('SIGTERM'); } catch { return; }
  }

  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function rootRealPath() {
  const state = await publicWorkspaceConfig();
  if (!state.ready) throw new HttpError(400, 'workspace_not_ready', '请先选择有效的本地工作区。');
  return fsp.realpath(workspaceConfig.root);
}

async function resolveWorkspacePath(input, { allowMissing = false } = {}) {
  const root = await rootRealPath();
  const requested = String(input || '.').trim() || '.';
  if (path.isAbsolute(requested)) throw new HttpError(400, 'absolute_path_denied', '文件工具只接受相对工作区路径。');
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(403, 'path_outside_workspace', '路径超出当前工作区。');
  if (allowMissing) {
    let existingAncestor = candidate;
    while (existingAncestor !== root && !fs.existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
    const ancestorReal = await fsp.realpath(existingAncestor).catch(() => null);
    if (!ancestorReal) throw new HttpError(404, 'parent_not_found', '找不到目标路径所在的工作区。');
    const ancestorRelative = path.relative(root, ancestorReal);
    if (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative)) throw new HttpError(403, 'symlink_outside_workspace', '路径通过链接跳出了工作区。');
    return { root, absolute: candidate, relative: relative.split(path.sep).join('/') || '.' };
  }
  const real = await fsp.realpath(candidate).catch(() => null);
  if (!real) throw new HttpError(404, 'path_not_found', `找不到路径：${requested}`);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new HttpError(403, 'symlink_outside_workspace', '路径通过链接跳出了工作区。');
  return { root, absolute: real, relative: realRelative.split(path.sep).join('/') || '.' };
}

function requireWrite() {
  if (!workspaceConfig.allowWrite) throw new HttpError(403, 'write_permission_required', '文件写入权限尚未开启。');
}

function requireDelete() {
  requireWrite();
  if (!workspaceConfig.allowDelete) throw new HttpError(403, 'delete_permission_required', '删除权限尚未开启。');
}

function requireCommand() {
  if (!workspaceConfig.allowCommand) throw new HttpError(403, 'command_permission_required', '本地命令执行权限尚未开启。');
}

function requireGitWrite() {
  requireCommand();
  if (!workspaceConfig.allowGitWrite) throw new HttpError(403, 'git_write_permission_required', 'Git 写入权限尚未开启。');
}

function requireNetwork() {
  if (!workspaceConfig.allowNetwork) throw new HttpError(403, 'network_permission_required', '网络读取权限尚未开启。');
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function directoryDigest(directory) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  async function visit(current, prefix = '') {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new HttpError(400, 'checkpoint_symlink_denied', `检查点不支持符号链接：${relative}`);
      hash.update(`${entry.isDirectory() ? 'D' : 'F'}:${relative}\n`);
      if (entry.isDirectory()) await visit(absolute, `${relative}/`);
      else if (entry.isFile()) {
        const data = await fsp.readFile(absolute);
        bytes += data.length;
        hash.update(data);
      }
    }
  }
  await visit(directory);
  return { bytes, sha256: hash.digest('hex') };
}

async function pathSnapshot(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const digest = await directoryDigest(filePath);
      return { exists: true, type: 'directory', bytes: digest.bytes, sha256: digest.sha256, data: null, mode: stat.mode };
    }
    if (!stat.isFile()) throw new HttpError(400, 'unsupported_path_type', '检查点只支持文件和目录。');
    const data = await fsp.readFile(filePath);
    return { exists: true, type: 'file', bytes: data.length, sha256: hashBuffer(data), data, mode: stat.mode };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, type: 'missing', bytes: 0, sha256: null, data: null, mode: null };
    throw error;
  }
}

async function createCheckpoint(stateRoot, run, relativePath, reason = '修改前自动检查点') {
  const target = await resolveWorkspacePath(relativePath, { allowMissing: true });
  const before = await pathSnapshot(target.absolute);
  const checkpointId = createId('checkpoint');
  const checkpointRoot = path.join(stateRoot, 'checkpoints', run.id, checkpointId);
  await fsp.mkdir(checkpointRoot, { recursive: true });
  if (before.type === 'file') await fsp.writeFile(path.join(checkpointRoot, 'content.bin'), before.data);
  if (before.type === 'directory') await fsp.cp(target.absolute, path.join(checkpointRoot, 'directory'), { recursive: true, dereference: false, preserveTimestamps: true });
  const checkpoint = {
    id: checkpointId,
    runId: run.id,
    path: target.relative,
    reason,
    createdAt: new Date().toISOString(),
    existed: before.exists,
    type: before.type,
    bytes: before.bytes,
    sha256: before.sha256,
    storage: path.relative(stateRoot, checkpointRoot).split(path.sep).join('/'),
  };
  await fsp.writeFile(path.join(checkpointRoot, 'metadata.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  run.checkpoints ||= [];
  run.checkpoints.push(checkpoint);
  return checkpoint;
}

async function recordChange(run, target, before, after, action, checkpoint) {
  const item = {
    id: createId('change'),
    timestamp: new Date().toISOString(),
    action,
    path: target.relative,
    before: { exists: before.exists, bytes: before.bytes, sha256: before.sha256 },
    after: { exists: after.exists, bytes: after.bytes, sha256: after.sha256 },
    checkpointId: checkpoint?.id || null,
  };
  run.changeJournal ||= [];
  run.changeJournal.push(item);
  return item;
}

async function listFiles(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  const stat = await fsp.stat(target.absolute);
  if (!stat.isDirectory()) throw new HttpError(400, 'not_directory', 'list_files 的目标必须是目录。');
  const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 6);
  const maximum = Math.min(Math.max(Number(args.maxItems) || 300, 1), 2000);
  const items = [];
  async function visit(current, currentDepth) {
    if (items.length >= maximum) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (items.length >= maximum) break;
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(target.root, absolute).split(path.sep).join('/');
      const info = await fsp.lstat(absolute);
      items.push({ path: relative, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', bytes: entry.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() });
      if (entry.isDirectory() && currentDepth < depth) await visit(absolute, currentDepth + 1);
    }
  }
  await visit(target.absolute, 1);
  return { root: target.relative, count: items.length, truncated: items.length >= maximum, items };
}

async function statPath(args = {}) {
  const target = await resolveWorkspacePath(args.path);
  const stat = await fsp.stat(target.absolute);
  return { path: target.relative, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', bytes: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString() };
}

async function readFile(args = {}) {
  const target = await resolveWorkspacePath(args.path);
  const stat = await fsp.stat(target.absolute);
  if (!stat.isFile()) throw new HttpError(400, 'not_file', 'read_file 的目标必须是文件。');
  if (stat.size > 8 * 1024 * 1024) throw new HttpError(413, 'file_too_large', '单次读取只支持 8MB 以内的文本文件。');
  const content = await fsp.readFile(target.absolute, 'utf8');
  const lines = content.split(/\r?\n/);
  const startLine = Math.min(Math.max(Number(args.startLine) || 1, 1), Math.max(lines.length, 1));
  const maxLines = Math.min(Math.max(Number(args.maxLines) || 500, 1), 4000);
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  return { path: target.relative, startLine, endLine: startLine + selected.length - 1, totalLines: lines.length, truncated: startLine - 1 + selected.length < lines.length, content: cleanText(selected.join('\n'), 200000) };
}

async function searchFiles(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new HttpError(400, 'query_required', 'search_files 必须提供关键词。');
  const target = await resolveWorkspacePath(args.path || '.');
  const maximum = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
  const caseSensitive = args.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLocaleLowerCase('zh-CN');
  const results = [];
  async function visit(current) {
    if (results.length >= maximum) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maximum || ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fsp.stat(absolute);
        if (stat.size > 2 * 1024 * 1024) continue;
        const lines = (await fsp.readFile(absolute, 'utf8')).split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maximum; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase('zh-CN');
          if (haystack.includes(needle)) results.push({ path: path.relative(target.root, absolute).split(path.sep).join('/'), line: index + 1, text: cleanText(lines[index], 1200) });
        }
      }
    }
  }
  await visit(target.absolute);
  return { query, count: results.length, truncated: results.length >= maximum, results };
}

async function inspectProject(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  const stat = await fsp.stat(target.absolute);
  if (!stat.isDirectory()) throw new HttpError(400, 'not_directory', 'inspect_project 的目标必须是目录。');
  const entries = await fsp.readdir(target.absolute, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const markers = projectMarkerFiles.filter((name) => names.has(name));
  const languages = [];
  const languageRules = [
    [/package\.json|\.ts$|\.tsx$|\.js$|\.jsx$/i, 'JavaScript / TypeScript'],
    [/pyproject\.toml|requirements\.txt|\.py$/i, 'Python'],
    [/Cargo\.toml|\.rs$/i, 'Rust'],
    [/go\.mod|\.go$/i, 'Go'],
    [/\.csproj$|\.sln$|\.cs$/i, '.NET / C#'],
    [/pom\.xml|build\.gradle|\.java$/i, 'Java'],
  ];
  const sampleNames = entries.map((entry) => entry.name).join('\n');
  for (const [pattern, language] of languageRules) if (pattern.test(`${markers.join('\n')}\n${sampleNames}`)) languages.push(language);
  let packageScripts = {};
  if (names.has('package.json')) {
    try { packageScripts = JSON.parse(await fsp.readFile(path.join(target.absolute, 'package.json'), 'utf8')).scripts || {}; } catch { packageScripts = {}; }
  }
  const hasGit = fs.existsSync(path.join(target.absolute, '.git'));
  return {
    path: target.relative,
    projectMarkers: markers,
    languages,
    hasGit,
    packageScripts: Object.fromEntries(Object.entries(packageScripts).slice(0, 80)),
    topLevel: entries.filter((entry) => !ignoredDirectories.has(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
    suggestedNextSteps: [
      '先读取 read_project_instructions 的结果。',
      hasGit ? '随后调用 git_status 和 git_diff 了解当前变更。' : '当前目录未发现 .git；如需版本控制，请确认工作区选择是否正确。',
      Object.keys(packageScripts).length ? '可根据 packageScripts 选择测试或构建命令。' : '未发现 package.json scripts；请根据项目标记选择验证命令。',
    ],
  };
}

async function readProjectInstructions(args = {}) {
  const target = await resolveWorkspacePath(args.path || '.');
  const stat = await fsp.stat(target.absolute);
  if (!stat.isDirectory()) throw new HttpError(400, 'not_directory', 'read_project_instructions 的目标必须是目录。');
  const maximum = Math.min(Math.max(Number(args.maxFiles) || 24, 1), 60);
  const found = [];
  async function visit(current, depth) {
    if (found.length >= maximum || depth > 4) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (found.length >= maximum || ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile() && instructionFiles.has(entry.name)) {
        const info = await fsp.stat(absolute);
        if (info.size > 512 * 1024) continue;
        found.push({ path: path.relative(target.root, absolute).split(path.sep).join('/'), name: entry.name, content: cleanText(await fsp.readFile(absolute, 'utf8'), 48000) });
      }
    }
  }
  await visit(target.absolute, 0);
  return { path: target.relative, count: found.length, instructions: found };
}

function lineDiff(beforeText, afterText, maximum = 18000) {
  if (beforeText === afterText) return '文件内容没有变化。';
  const before = String(beforeText || '').split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const lines = ['--- 检查点', '+++ 当前文件', `@@ -${prefix + 1},${before.length - prefix - suffix} +${prefix + 1},${after.length - prefix - suffix} @@`];
  for (const line of before.slice(prefix, before.length - suffix)) lines.push(`-${line}`);
  for (const line of after.slice(prefix, after.length - suffix)) lines.push(`+${line}`);
  return cleanText(lines.join('\n'), maximum);
}

async function findCheckpointMetadata(stateRoot, checkpointId) {
  const checkpointsRoot = path.join(stateRoot, 'checkpoints');
  let metadataPath = null;
  async function visit(current) {
    if (metadataPath) return;
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === checkpointId && fs.existsSync(path.join(candidate, 'metadata.json'))) { metadataPath = path.join(candidate, 'metadata.json'); return; }
      await visit(candidate);
    }
  }
  await visit(checkpointsRoot);
  if (!metadataPath) throw new HttpError(404, 'checkpoint_not_found', '找不到这个检查点。');
  return { metadata: JSON.parse(await fsp.readFile(metadataPath, 'utf8')), root: path.dirname(metadataPath) };
}

async function getFileDiff(stateRoot, run, args = {}) {
  const checkpointId = String(args.checkpointId || '').trim() || (run.checkpoints || []).filter((item) => item.type === 'file' && (!args.path || item.path === args.path)).at(-1)?.id;
  if (!checkpointId) throw new HttpError(400, 'checkpoint_required', 'get_file_diff 需要 checkpointId，或需要当前任务中对应文件的检查点。');
  const found = await findCheckpointMetadata(stateRoot, checkpointId);
  if (!found.metadata.existed || found.metadata.type !== 'file') throw new HttpError(400, 'file_checkpoint_required', '指定检查点不是已有文本文件，无法生成行级差异。');
  const target = await resolveWorkspacePath(args.path || found.metadata.path, { allowMissing: true });
  const before = await fsp.readFile(path.join(found.root, 'content.bin'), 'utf8');
  const after = fs.existsSync(target.absolute) ? await fsp.readFile(target.absolute, 'utf8') : '';
  return { path: target.relative, checkpointId, beforeExists: true, afterExists: fs.existsSync(target.absolute), diff: lineDiff(before, after), truncated: before.length + after.length > 18000 };
}

function parseStandardPatch(patchText) {
  const text = String(patchText || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('*** Begin Patch\n') || !text.trimEnd().endsWith('*** End Patch')) throw new HttpError(400, 'invalid_patch', 'apply_patch 只接受以 *** Begin Patch 和 *** End Patch 包围的标准补丁。');
  const lines = text.trimEnd().split('\n').slice(1, -1);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      if (current) blocks.push(current);
      current = { action: header[1].toLowerCase(), path: header[2].trim(), lines: [] };
    } else if (current) current.lines.push(line);
    else if (line.trim()) throw new HttpError(400, 'invalid_patch', '补丁头部之后必须是文件操作块。');
  }
  if (current) blocks.push(current);
  if (!blocks.length) throw new HttpError(400, 'empty_patch', '补丁中没有文件操作。');
  return blocks;
}

function applyUpdateHunks(original, lines) {
  const groups = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('@@')) { if (current.length) groups.push(current); current = []; }
    else if (line === '\\ No newline at end of file') continue;
    else current.push(line);
  }
  if (current.length) groups.push(current);
  if (!groups.length) throw new HttpError(400, 'empty_update_patch', '更新补丁缺少内容块。');
  let next = original;
  for (const group of groups) {
    let oldText = ''; let newText = '';
    for (const line of group) {
      if (line.startsWith(' ')) { oldText += `${line.slice(1)}\n`; newText += `${line.slice(1)}\n`; }
      else if (line.startsWith('-')) oldText += `${line.slice(1)}\n`;
      else if (line.startsWith('+')) newText += `${line.slice(1)}\n`;
      else throw new HttpError(400, 'invalid_patch_line', '更新补丁的每一行必须以空格、+、- 或 @@ 开头。');
    }
    const trimLast = (value) => value.endsWith('\n') ? value.slice(0, -1) : value;
    oldText = trimLast(oldText); newText = trimLast(newText);
    const occurrences = oldText ? next.split(oldText).length - 1 : 0;
    if (occurrences !== 1) throw new HttpError(409, 'patch_context_not_unique', `补丁上下文匹配了 ${occurrences} 次，未写入文件。`);
    next = next.replace(oldText, newText);
  }
  return next;
}

async function applyPatch(stateRoot, run, args = {}) {
  requireWrite();
  const blocks = parseStandardPatch(args.patch);
  const plans = [];
  for (const block of blocks) {
    const target = await resolveWorkspacePath(block.path, { allowMissing: true });
    const exists = fs.existsSync(target.absolute);
    if (block.action === 'add') {
      if (exists) throw new HttpError(409, 'patch_add_exists', `新增补丁的目标已存在：${target.relative}`);
      const content = block.lines.map((line) => line.startsWith('+') ? line.slice(1) : line).join('\n');
      plans.push({ block, target, before: await pathSnapshot(target.absolute), content, action: 'patch-add' });
    } else if (block.action === 'delete') {
      requireDelete();
      if (!exists) throw new HttpError(404, 'patch_delete_missing', `删除补丁的目标不存在：${target.relative}`);
      plans.push({ block, target, before: await pathSnapshot(target.absolute), content: null, action: 'patch-delete' });
    } else {
      if (!exists) throw new HttpError(404, 'patch_update_missing', `更新补丁的目标不存在：${target.relative}`);
      const original = await fsp.readFile(target.absolute, 'utf8');
      plans.push({ block, target, before: await pathSnapshot(target.absolute), content: applyUpdateHunks(original, block.lines), action: 'patch-update' });
    }
  }
  const changes = [];
  for (const plan of plans) {
    const checkpoint = await createCheckpoint(stateRoot, run, plan.target.relative, args.reason || '标准补丁前自动检查点');
    if (plan.action === 'patch-delete') await fsp.rm(plan.target.absolute, { recursive: true, force: false });
    else { await fsp.mkdir(path.dirname(plan.target.absolute), { recursive: true }); await fsp.writeFile(plan.target.absolute, plan.content, 'utf8'); }
    changes.push(await recordChange(run, plan.target, plan.before, await pathSnapshot(plan.target.absolute), plan.action, checkpoint));
  }
  return { applied: true, files: changes.map((change) => change.path), changes };
}

async function writeFile(stateRoot, run, args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path, { allowMissing: true });
  const content = String(args.content ?? '');
  const before = await pathSnapshot(target.absolute);
  const checkpoint = await createCheckpoint(stateRoot, run, target.relative, args.reason || '写入文件前自动检查点');
  await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
  await fsp.writeFile(target.absolute, content, 'utf8');
  const after = await pathSnapshot(target.absolute);
  const change = await recordChange(run, target, before, after, before.exists ? 'overwrite' : 'create', checkpoint);
  return { path: target.relative, bytes: after.bytes, sha256: after.sha256, change };
}

async function replaceText(stateRoot, run, args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path);
  const oldText = String(args.oldText ?? '');
  const newText = String(args.newText ?? '');
  if (!oldText) throw new HttpError(400, 'old_text_required', 'replace_text 必须提供 oldText。');
  const original = await fsp.readFile(target.absolute, 'utf8');
  const occurrences = original.split(oldText).length - 1;
  if (occurrences !== 1) throw new HttpError(409, 'replace_not_unique', `oldText 匹配了 ${occurrences} 次，必须唯一匹配。`);
  const before = await pathSnapshot(target.absolute);
  const checkpoint = await createCheckpoint(stateRoot, run, target.relative, args.reason || '精确替换前自动检查点');
  await fsp.writeFile(target.absolute, original.replace(oldText, newText), 'utf8');
  const after = await pathSnapshot(target.absolute);
  const change = await recordChange(run, target, before, after, 'replace', checkpoint);
  return { path: target.relative, replacements: 1, change };
}

async function applyEdits(stateRoot, run, args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!edits.length) throw new HttpError(400, 'edits_required', 'apply_edits 必须提供 edits 数组。');
  const original = await fsp.readFile(target.absolute, 'utf8');
  let next = original;
  for (const [index, edit] of edits.entries()) {
    const oldText = String(edit.oldText ?? '');
    const newText = String(edit.newText ?? '');
    const occurrences = oldText ? next.split(oldText).length - 1 : 0;
    if (occurrences !== 1) throw new HttpError(409, 'edit_not_unique', `第 ${index + 1} 个编辑匹配了 ${occurrences} 次，文件尚未写入。`);
    next = next.replace(oldText, newText);
  }
  const before = await pathSnapshot(target.absolute);
  const checkpoint = await createCheckpoint(stateRoot, run, target.relative, args.reason || '批量编辑前自动检查点');
  await fsp.writeFile(target.absolute, next, 'utf8');
  const after = await pathSnapshot(target.absolute);
  const change = await recordChange(run, target, before, after, 'batch-edit', checkpoint);
  return { path: target.relative, edits: edits.length, change };
}

async function createDirectory(run, args = {}) {
  requireWrite();
  const target = await resolveWorkspacePath(args.path, { allowMissing: true });
  await fsp.mkdir(target.absolute, { recursive: Boolean(args.recursive ?? true) });
  run.changeJournal ||= [];
  run.changeJournal.push({ id: createId('change'), timestamp: new Date().toISOString(), action: 'mkdir', path: target.relative });
  return { path: target.relative, created: true };
}

async function movePath(stateRoot, run, args = {}) {
  requireWrite();
  const source = await resolveWorkspacePath(args.source);
  const target = await resolveWorkspacePath(args.target, { allowMissing: true });
  const sourceCheckpoint = await createCheckpoint(stateRoot, run, source.relative, args.reason || '移动前源路径检查点');
  const targetCheckpoint = await createCheckpoint(stateRoot, run, target.relative, args.reason || '移动前目标路径检查点');
  await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
  await fsp.rename(source.absolute, target.absolute);
  run.changeJournal ||= [];
  const change = { id: createId('change'), timestamp: new Date().toISOString(), action: 'move', path: source.relative, target: target.relative, checkpointId: sourceCheckpoint.id, targetCheckpointId: targetCheckpoint.id };
  run.changeJournal.push(change);
  return { change, checkpoints: [sourceCheckpoint, targetCheckpoint] };
}

async function deletePath(stateRoot, run, args = {}) {
  requireDelete();
  const target = await resolveWorkspacePath(args.path);
  if (target.relative === '.') throw new HttpError(403, 'delete_root_denied', '不能删除工作区根目录。');
  const checkpoint = await createCheckpoint(stateRoot, run, target.relative, args.reason || '删除前自动检查点');
  const stat = await fsp.stat(target.absolute);
  if (stat.isDirectory() && args.recursive !== true) throw new HttpError(400, 'recursive_required', '删除目录必须明确设置 recursive=true。');
  await fsp.rm(target.absolute, { recursive: stat.isDirectory(), force: false });
  run.changeJournal ||= [];
  const change = { id: createId('change'), timestamp: new Date().toISOString(), action: 'delete', path: target.relative, checkpointId: checkpoint.id };
  run.changeJournal.push(change);
  return change;
}

async function runCommand(command, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd: workspaceConfig.root,
      env: filteredCommandEnvironment(),
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => cleanText(current + chunk.toString('utf8'), 120000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void terminateProcessTree(child); }, timeoutMs);
    const onAbort = () => { void terminateProcessTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ command, exitCode, signal: exitSignal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr });
    });
  });
}

async function runProgram(program, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(program, args, { cwd: workspaceConfig.root, env: filteredCommandEnvironment(), shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const append = (current, chunk) => cleanText(current + chunk.toString('utf8'), 120000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; void terminateProcessTree(child); }, timeoutMs);
    const onAbort = () => { void terminateProcessTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', (exitCode, exitSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ command: [program, ...args].join(' '), exitCode, signal: exitSignal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr }); });
  });
}

function recordCommand(run, result, type = 'command') {
  run.commands ||= [];
  run.commands.push({ ...result, id: createId(type), timestamp: new Date().toISOString() });
  return result;
}

async function runGit(run, args, signal) {
  requireCommand();
  const result = await runProgram('git', args, signal, Math.min(Math.max(Number(workspaceConfig.commandTimeoutMs), 1000), 300000));
  return recordCommand(run, result, 'git');
}

async function gitStatus(run, _args, signal) { return runGit(run, ['status', '--short', '--branch'], signal); }
async function gitDiff(run, args = {}, signal) {
  const parameters = ['diff'];
  if (args.staged === true) parameters.push('--staged');
  parameters.push('--');
  if (args.path) {
    const target = await resolveWorkspacePath(args.path);
    parameters.push(target.relative);
  }
  return runGit(run, parameters, signal);
}
async function gitLog(run, args = {}, signal) { return runGit(run, ['log', `-${Math.min(Math.max(Number(args.limit) || 12, 1), 100)}`, '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=iso'], signal); }
async function gitBranch(run, _args, signal) { return runGit(run, ['branch', '--no-color'], signal); }
async function gitCommit(run, args = {}, signal) {
  requireGitWrite();
  const message = String(args.message || '').trim();
  if (!message) throw new HttpError(400, 'git_message_required', 'git_commit 必须提供提交说明 message。');
  if (message.length > 240) throw new HttpError(400, 'git_message_too_long', '提交说明不能超过 240 个字符。');
  return runGit(run, ['commit', '-m', message], signal);
}

function publicProcess(item, outputOffset = 0) {
  return {
    id: item.id, command: item.command, pid: item.child.pid || null, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt || null,
    exitCode: item.exitCode ?? null, signal: item.signal || null, stdout: cleanText(item.stdout.slice(Math.max(Number(outputOffset) || 0, 0)), 120000), stderr: cleanText(item.stderr.slice(Math.max(Number(outputOffset) || 0, 0)), 120000),
    stdoutLength: item.stdout.length, stderrLength: item.stderr.length, taskId: item.taskId || null,
  };
}

function appendProcessOutput(item, key, chunk) { item[key] = cleanText(item[key] + chunk.toString('utf8'), 240000); }

async function startProcess(run, args = {}) {
  requireCommand();
  const command = String(args.command || '').trim();
  if (!command) throw new HttpError(400, 'command_required', 'start_process 必须提供 command。');
  if ([...managedProcesses.values()].filter((item) => item.status === '运行中').length >= 12) throw new HttpError(429, 'process_limit', '同时运行的受管理进程已达到 12 个，请先停止不需要的进程。');
  const child = spawn(command, { cwd: workspaceConfig.root, env: filteredCommandEnvironment(), shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = { id: createId('process'), child, command, taskId: run?.id || null, status: '运行中', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, stdout: '', stderr: '' };
  managedProcesses.set(item.id, item);
  child.stdout.on('data', (chunk) => appendProcessOutput(item, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendProcessOutput(item, 'stderr', chunk));
  child.on('error', (error) => { item.status = '启动失败'; item.stderr = cleanText(`${item.stderr}\n${error.message}`, 240000); item.endedAt = new Date().toISOString(); });
  child.on('close', (exitCode, exitSignal) => { item.status = exitCode === 0 ? '已完成' : '已停止'; item.exitCode = exitCode; item.signal = exitSignal; item.endedAt = new Date().toISOString(); });
  run.processes ||= [];
  run.processes.push({ id: item.id, command, startedAt: item.startedAt, status: item.status });
  return publicProcess(item);
}

function findManagedProcess(processId) {
  const item = managedProcesses.get(String(processId || ''));
  if (!item) throw new HttpError(404, 'process_not_found', '找不到受管理进程；服务重启后旧进程不能继续控制。');
  return item;
}

async function readProcessOutput(_run, args = {}) { requireCommand(); return publicProcess(findManagedProcess(args.processId), args.offset); }
async function writeProcessInput(_run, args = {}) {
  requireCommand(); const item = findManagedProcess(args.processId);
  if (item.status !== '运行中' || !item.child.stdin.writable) throw new HttpError(409, 'process_not_writable', '这个进程已结束或不接受标准输入。');
  const input = String(args.input ?? ''); item.child.stdin.write(`${input}${args.appendNewline === false ? '' : '\n'}`);
  return { processId: item.id, written: input.length, status: item.status };
}
async function stopProcess(_run, args = {}) {
  requireCommand(); const item = findManagedProcess(args.processId);
  if (item.status === '运行中') { item.status = '停止中'; await terminateProcessTree(item.child); }
  return publicProcess(item);
}
async function listProcesses(_run, _args = {}) { requireCommand(); return { processes: [...managedProcesses.values()].map((item) => publicProcess(item)) }; }

async function listSkills(args = {}) {
  const roots = workspaceConfig.skillRoots.slice(0, 24);
  const skills = [];
  for (const root of roots) {
    const actual = await fsp.realpath(root).catch(() => null);
    if (!actual) continue;
    for (const entry of await fsp.readdir(actual, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || skills.length >= Math.min(Math.max(Number(args.maxItems) || 200, 1), 1000)) continue;
      const skillFile = path.join(actual, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const preview = cleanText(await fsp.readFile(skillFile, 'utf8'), 2400);
      const description = preview.match(/description:\s*["']?([^\n"']+)/i)?.[1] || preview.split(/\r?\n/).find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '') || '';
      skills.push({ name: entry.name, root: actual, path: skillFile, description: cleanText(description, 600) });
    }
  }
  return { count: skills.length, skillRoots: roots, skills };
}

async function readSkill(args = {}) {
  const name = String(args.name || '').trim();
  if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new HttpError(400, 'invalid_skill_name', '技能名称只能包含字母、数字、点、下划线、短横线和冒号。');
  for (const root of workspaceConfig.skillRoots) {
    const actual = await fsp.realpath(root).catch(() => null);
    if (!actual) continue;
    const candidate = path.join(actual, name, 'SKILL.md');
    if (fs.existsSync(candidate)) return { name, path: candidate, content: cleanText(await fsp.readFile(candidate, 'utf8'), Math.min(Math.max(Number(args.maxChars) || 60000, 1000), 180000)) };
  }
  throw new HttpError(404, 'skill_not_found', `找不到技能：${name}。请先调用 list_skills。`);
}

async function fetchUrl(_run, args = {}, signal) {
  requireNetwork();
  let target;
  try { target = new URL(String(args.url || '').trim()); } catch { throw new HttpError(400, 'invalid_url', 'fetch_url 必须提供有效网页地址。'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new HttpError(400, 'url_denied', '只支持不含账号信息的 HTTP 或 HTTPS 页面地址。');
  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 30000, 1000), 120000);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(target, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { accept: 'text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1', 'user-agent': 'Conversation-Codex-Ability-Package/3.0' } });
    const reader = response.body?.getReader(); const chunks = []; let bytes = 0; let truncated = false;
    while (reader) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1024 * 1024) { truncated = true; break; } chunks.push(value); }
    if (truncated) await reader?.cancel().catch(() => {});
    const body = new TextDecoder().decode(Buffer.concat(chunks.map((item) => Buffer.from(item))));
    return { requestedUrl: target.toString(), finalUrl: response.url, status: response.status, ok: response.ok, contentType: response.headers.get('content-type') || '', bytes, truncated, content: cleanText(body, 200000) };
  } catch (error) {
    if (error?.name === 'AbortError') throw new HttpError(408, 'fetch_timeout', `网页读取在 ${timeout} 毫秒后超时。`);
    throw new HttpError(502, 'fetch_failed', `网页读取失败：${error.message}`);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

async function executeCommand(run, args = {}, signal) {
  requireCommand();
  const command = String(args.command || '').trim();
  if (!command) throw new HttpError(400, 'command_required', 'execute_command 必须提供 command。');
  const result = await runCommand(command, signal, Math.min(Math.max(Number(args.timeoutMs) || workspaceConfig.commandTimeoutMs, 1000), 300000));
  return recordCommand(run, result);
}

async function runVerification(run, args = {}, signal) {
  if (!workspaceConfig.allowCommand) throw new HttpError(403, 'command_permission_required', '运行验收需要先开启本地命令权限。');
  const commands = Array.isArray(args.commands) ? args.commands.map(String).filter(Boolean) : [];
  if (!commands.length) throw new HttpError(400, 'verification_commands_required', 'run_verification 必须提供 commands。');
  const checks = [];
  for (const command of commands.slice(0, 12)) checks.push(await executeCommand(run, { command, timeoutMs: args.timeoutMs }, signal));
  const passed = checks.every((item) => item.exitCode === 0 && !item.timedOut);
  run.verification ||= [];
  const result = { id: createId('verification'), timestamp: new Date().toISOString(), passed, checks };
  run.verification.push(result);
  return result;
}

export async function restoreCheckpoint(stateRoot, checkpointId, run = null) {
  requireWrite();
  const checkpointsRoot = path.join(stateRoot, 'checkpoints');
  let metadataPath = null;
  async function find(current) {
    if (metadataPath) return;
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === checkpointId && fs.existsSync(path.join(candidate, 'metadata.json'))) {
          metadataPath = path.join(candidate, 'metadata.json');
          return;
        }
        await find(candidate);
      }
    }
  }
  await find(checkpointsRoot);
  if (!metadataPath) throw new HttpError(404, 'checkpoint_not_found', '找不到这个检查点。');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  const target = await resolveWorkspacePath(metadata.path, { allowMissing: true });
  await fsp.rm(target.absolute, { recursive: true, force: true });
  if (metadata.existed && metadata.type === 'directory') {
    await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
    await fsp.cp(path.join(path.dirname(metadataPath), 'directory'), target.absolute, { recursive: true, dereference: false, preserveTimestamps: true });
  } else if (metadata.existed) {
    await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
    await fsp.writeFile(target.absolute, await fsp.readFile(path.join(path.dirname(metadataPath), 'content.bin')));
  }
  if (run) {
    run.changeJournal ||= [];
    run.changeJournal.push({ id: createId('change'), timestamp: new Date().toISOString(), action: 'restore', path: metadata.path, checkpointId });
  }
  return { restored: true, checkpoint: metadata };
}

export function workspaceToolDefinitions() {
  return [
    { type: 'function', function: { name: 'list_files', description: '列出工作区文件和目录。', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer' }, maxItems: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'stat_path', description: '读取路径类型、大小和时间。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'search_files', description: '搜索工作区文本文件内容。', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer' }, caseSensitive: { type: 'boolean' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'read_file', description: '按行读取工作区文本文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, maxLines: { type: 'integer' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'inspect_project', description: '识别项目语言、构建入口、依赖清单、测试脚本和 Git 仓库。', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read_project_instructions', description: '读取 AGENTS.md、README、贡献说明等项目约定。', parameters: { type: 'object', properties: { path: { type: 'string' }, maxFiles: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'create_directory', description: '创建工作区目录。', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: '写入 UTF-8 文本文件，覆盖前自动创建检查点。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'replace_text', description: '唯一匹配后精确替换文件文本。', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } } },
    { type: 'function', function: { name: 'apply_edits', description: '原子执行多个唯一文本替换。', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } }, reason: { type: 'string' } }, required: ['path', 'edits'] } } },
    { type: 'function', function: { name: 'apply_patch', description: '应用 *** Begin Patch 格式标准补丁；写入前创建检查点。', parameters: { type: 'object', properties: { patch: { type: 'string' }, reason: { type: 'string' } }, required: ['patch'] } } },
    { type: 'function', function: { name: 'move_path', description: '移动或重命名工作区路径。', parameters: { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } }, required: ['source', 'target'] } } },
    { type: 'function', function: { name: 'delete_path', description: '删除路径，删除前自动创建检查点。', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' }, reason: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'create_checkpoint', description: '为指定路径手动创建恢复检查点。', parameters: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'restore_checkpoint', description: '恢复指定检查点。', parameters: { type: 'object', properties: { checkpointId: { type: 'string' } }, required: ['checkpointId'] } } },
    { type: 'function', function: { name: 'get_change_journal', description: '读取当前任务的文件变更、命令和检查点。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_file_diff', description: '使用检查点和当前文件生成行级差异。', parameters: { type: 'object', properties: { path: { type: 'string' }, checkpointId: { type: 'string' } } } } },
    { type: 'function', function: { name: 'execute_command', description: '在工作区执行本地命令并返回退出码和输出。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'run_verification', description: '依次执行多个验收命令并汇总是否通过。', parameters: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } }, required: ['commands'] } } },
    { type: 'function', function: { name: 'git_status', description: '读取 Git 分支和工作区状态。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_diff', description: '读取 Git 差异，可选文件或暂存区。', parameters: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } } } },
    { type: 'function', function: { name: 'git_log', description: '读取最近 Git 提交历史。', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'git_branch', description: '读取当前 Git 分支和本地分支。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_commit', description: '创建本地 Git 提交；需要 Git 写入权限且不会推送远程。', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
    { type: 'function', function: { name: 'start_process', description: '启动并管理长期本地进程。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'read_process_output', description: '读取受管理长期进程的输出和状态。', parameters: { type: 'object', properties: { processId: { type: 'string' }, offset: { type: 'integer' } }, required: ['processId'] } } },
    { type: 'function', function: { name: 'write_process_input', description: '向受管理交互式进程写入输入。', parameters: { type: 'object', properties: { processId: { type: 'string' }, input: { type: 'string' }, appendNewline: { type: 'boolean' } }, required: ['processId', 'input'] } } },
    { type: 'function', function: { name: 'stop_process', description: '停止受管理长期进程。', parameters: { type: 'object', properties: { processId: { type: 'string' } }, required: ['processId'] } } },
    { type: 'function', function: { name: 'list_processes', description: '列出当前受管理长期进程。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'list_skills', description: '列出配置的 Codex 技能目录中的可用技能。', parameters: { type: 'object', properties: { maxItems: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'read_skill', description: '读取指定本地技能的 SKILL.md。', parameters: { type: 'object', properties: { name: { type: 'string' }, maxChars: { type: 'integer' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'fetch_url', description: '读取公开网页内容；需要网络读取权限。', parameters: { type: 'object', properties: { url: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['url'] } } },
  ];
}

export async function executeWorkspaceTool(stateRoot, run, name, args, signal) {
  if (name === 'list_files') return listFiles(args);
  if (name === 'stat_path') return statPath(args);
  if (name === 'search_files') return searchFiles(args);
  if (name === 'read_file') return readFile(args);
  if (name === 'inspect_project') return inspectProject(args);
  if (name === 'read_project_instructions') return readProjectInstructions(args);
  if (name === 'create_directory') return createDirectory(run, args);
  if (name === 'write_file') return writeFile(stateRoot, run, args);
  if (name === 'replace_text') return replaceText(stateRoot, run, args);
  if (name === 'apply_edits') return applyEdits(stateRoot, run, args);
  if (name === 'apply_patch') return applyPatch(stateRoot, run, args);
  if (name === 'move_path') return movePath(stateRoot, run, args);
  if (name === 'delete_path') return deletePath(stateRoot, run, args);
  if (name === 'create_checkpoint') return createCheckpoint(stateRoot, run, args.path, args.reason);
  if (name === 'restore_checkpoint') return restoreCheckpoint(stateRoot, args.checkpointId, run);
  if (name === 'get_change_journal') return { changes: run.changeJournal || [], checkpoints: run.checkpoints || [], commands: run.commands || [], processes: run.processes || [], verification: run.verification || [] };
  if (name === 'get_file_diff') return getFileDiff(stateRoot, run, args);
  if (name === 'execute_command') return executeCommand(run, args, signal);
  if (name === 'run_verification') return runVerification(run, args, signal);
  if (name === 'git_status') return gitStatus(run, args, signal);
  if (name === 'git_diff') return gitDiff(run, args, signal);
  if (name === 'git_log') return gitLog(run, args, signal);
  if (name === 'git_branch') return gitBranch(run, args, signal);
  if (name === 'git_commit') return gitCommit(run, args, signal);
  if (name === 'start_process') return startProcess(run, args);
  if (name === 'read_process_output') return readProcessOutput(run, args);
  if (name === 'write_process_input') return writeProcessInput(run, args);
  if (name === 'stop_process') return stopProcess(run, args);
  if (name === 'list_processes') return listProcesses(run, args);
  if (name === 'list_skills') return listSkills(args);
  if (name === 'read_skill') return readSkill(args);
  if (name === 'fetch_url') return fetchUrl(run, args, signal);
  return null;
}

export function getManagedProcesses() {
  return [...managedProcesses.values()].map((item) => publicProcess(item));
}

export async function stopManagedProcess(processId) {
  return stopProcess(null, { processId });
}
