import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverSessions, parseCodexSessionFile } from './session-forensics.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_EXTENSIONS = new Set(['.json', '.jsonl', '.txt']);

function text(value, maximum = 240) {
  const valueText = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return valueText.length <= maximum ? valueText : `${valueText.slice(0, maximum)}…`;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function canonicalPathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function canonicalSessionId(value) {
  const sessionId = String(value || '').trim().toLowerCase();
  return UUID_RE.test(sessionId) ? sessionId : null;
}

function sourceKey(sessionId, sourcePath) {
  if (sessionId) return `session:${sessionId}`;
  return `file:${crypto.createHash('sha256').update(canonicalPathKey(sourcePath)).digest('hex').slice(0, 20)}`;
}

function titleFromParsed(parsed, fallback) {
  const metadata = parsed?.sessionMeta && typeof parsed.sessionMeta === 'object' ? parsed.sessionMeta : {};
  const metadataTitle = text(metadata.title || metadata.name || metadata.summary || '', 160);
  if (metadataTitle) return { title: metadataTitle, titleSource: '元数据' };
  const request = (parsed?.messages || []).find((message) => {
    const messageText = text(message?.text, 400);
    return message?.actor === 'user'
      && message?.contextKind === 'user-request'
      && messageText
      && !/^#\s*AGENTS\.md instructions\b/i.test(messageText)
      && !/^<(?:environment_context|app-context|in-app-browser-context)\b/i.test(messageText);
  });
  if (request) return { title: text(request.text, 160), titleSource: '首条用户需求' };
  return { title: fallback, titleSource: '文件名' };
}

function status(kind, message = '') {
  return { kind, label: ({ ready: '已定位', duplicate: '已合并重复项', missing: '未找到', invalid: '格式错误', unreadable: '无法读取', changing: '文件正在写入' })[kind] || '待确认', message };
}

function sourceFromDescriptor(descriptor, extras = {}) {
  const sessionId = canonicalSessionId(descriptor.sessionId);
  const sourcePath = path.resolve(descriptor.path);
  const duplicatePaths = unique(descriptor.duplicatePaths || []);
  const duplicate = duplicatePaths.length > 0;
  return {
    sourceKey: sourceKey(sessionId, sourcePath),
    sessionId,
    title: text(descriptor.title || `未命名会话 ${String(sessionId || path.basename(sourcePath)).slice(0, 16)}`, 160),
    titleSource: descriptor.titleSource || '文件名',
    sourcePath,
    format: descriptor.format || path.extname(sourcePath).slice(1).toUpperCase() || '未知',
    bytes: Number(descriptor.bytes) || 0,
    modifiedAt: descriptor.modifiedAt || null,
    recordCount: Number(descriptor.recordCount) || null,
    live: Boolean(descriptor.live),
    state: descriptor.live
      ? status('changing', '读取期间文件发生变化，执行时将再次校验。')
      : duplicate
        ? status('duplicate', `已合并 ${duplicatePaths.length} 个重复副本，并优先使用更完整的记录。`)
        : status('ready'),
    discoveredBy: unique([...(descriptor.discoveredBy || []), ...(extras.discoveredBy || [])]),
    duplicatePaths,
    workspacePaths: unique(descriptor.workspacePaths || []).map((item) => path.resolve(item)),
  };
}

function preferCandidate(left, right) {
  if (!left) return right;
  if (right.bytes !== left.bytes) return right.bytes > left.bytes ? right : left;
  return Date.parse(right.modifiedAt || 0) > Date.parse(left.modifiedAt || 0) ? right : left;
}

function mergeSources(candidates, { sortByModifiedAt = false } = {}) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = candidate.sourceKey;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, candidate);
      continue;
    }
    const preferred = preferCandidate(existing, candidate);
    const other = preferred === existing ? candidate : existing;
    preferred.duplicatePaths = unique([...preferred.duplicatePaths, preferred.sourcePath, other.sourcePath, ...other.duplicatePaths]).filter((item) => item !== preferred.sourcePath);
    preferred.discoveredBy = unique([...preferred.discoveredBy, ...other.discoveredBy]);
    if (preferred.duplicatePaths.length) preferred.state = status('duplicate', `已合并 ${preferred.duplicatePaths.length} 个重复副本，并优先使用更完整的记录。`);
    grouped.set(key, preferred);
  }
  const merged = [...grouped.values()];
  return sortByModifiedAt
    ? merged.sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0))
    : merged;
}

function inputValues(...values) {
  return unique(values.flatMap((value) => (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? '').split(/[\r\n,;]+/))));
}

export function splitSessionSourceInputs(value) {
  return inputValues(value);
}

export async function describeSessionFile(candidatePath, { discoveredBy = '手动选择文件' } = {}) {
  const requestedPath = String(candidatePath || '').trim();
  if (!requestedPath) return { input: requestedPath, state: status('invalid', '未提供文件路径。'), source: null };
  try {
    const resolved = path.resolve(requestedPath);
    const realPath = await fs.realpath(resolved);
    const extension = path.extname(realPath).toLowerCase();
    if (!SESSION_EXTENSIONS.has(extension)) return { input: requestedPath, state: status('invalid', '仅支持 JSON、JSONL 或 TXT 会话文件。'), source: null };
    const before = await fs.stat(realPath);
    if (!before.isFile()) return { input: requestedPath, state: status('invalid', '选择的路径不是文件。'), source: null };
    const parsed = await parseCodexSessionFile(realPath, { redact: true });
    const after = await fs.stat(realPath);
    const live = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
    const sessionId = canonicalSessionId(parsed.sessionId);
    const title = titleFromParsed(parsed, `未命名会话 ${path.basename(realPath)}`);
    const source = sourceFromDescriptor({
      sessionId,
      path: realPath,
      title: title.title,
      titleSource: title.titleSource,
      format: parsed.sourceFormat || extension.slice(1).toUpperCase(),
      bytes: after.size,
      modifiedAt: after.mtime.toISOString(),
      recordCount: parsed.recordCount,
      live,
      discoveredBy: [discoveredBy],
    });
    return { input: requestedPath, state: source.state, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { input: requestedPath, state: status('unreadable', /^[\u4e00-\u9fff]/.test(message) ? message : '该文件不是可读取的 Codex 会话。'), source: null };
  }
}

export async function discoverSessionSources({ roots = [], limit = 5000, complete = false } = {}) {
  const discovered = await discoverSessions({ roots, limit, complete });
  return mergeSources(discovered.map((entry) => sourceFromDescriptor({
    ...entry,
    format: path.extname(entry.path).slice(1).toUpperCase(),
    discoveredBy: ['本机 Codex 会话目录'],
  })), { sortByModifiedAt: true });
}

export async function resolveSessionSources({ threadId, threadIds = [], sourcePath, sourcePaths = [], roots = [], limit = 5000 } = {}) {
  const ids = inputValues(threadId, threadIds);
  const paths = inputValues(sourcePath, sourcePaths);
  const catalog = ids.length ? await discoverSessionSources({ roots, limit }) : [];
  const catalogById = new Map(catalog.filter((item) => item.sessionId).map((item) => [item.sessionId, item]));
  const results = [];
  const candidates = [];

  for (const rawId of ids) {
    const sessionId = canonicalSessionId(rawId);
    if (!sessionId) {
      results.push({ inputType: '会话编号', input: rawId, state: status('invalid', '请填写完整 UUID 会话编号。'), source: null });
      continue;
    }
    const source = catalogById.get(sessionId) || null;
    if (!source) {
      results.push({ inputType: '会话编号', input: rawId, state: status('missing', '未在当前本机会话目录中找到对应文件。'), source: null });
      continue;
    }
    candidates.push({ ...source, discoveredBy: unique([...source.discoveredBy, '粘贴会话编号']) });
    results.push({ inputType: '会话编号', input: rawId, state: source.state, source });
  }

  for (const candidatePath of paths) {
    const described = await describeSessionFile(candidatePath);
    results.push({ inputType: '会话文件', ...described });
    if (described.source) candidates.push(described.source);
  }

  const selectedSources = mergeSources(candidates);
  const selectedKeys = new Set(selectedSources.map((item) => item.sourceKey));
  for (const result of results) {
    if (!result.source) continue;
    const canonical = selectedSources.find((item) => item.sourceKey === result.source.sourceKey) || result.source;
    result.source = canonical;
    if (canonical.state.kind === 'duplicate' && selectedKeys.has(canonical.sourceKey)) result.state = canonical.state;
  }
  const errors = results.filter((item) => !item.source).length;
  return {
    catalog,
    results,
    selectedSources,
    summary: {
      supplied: ids.length + paths.length,
      resolved: selectedSources.length,
      invalid: results.filter((item) => item.state?.kind === 'invalid').length,
      missing: results.filter((item) => item.state?.kind === 'missing').length,
      unreadable: results.filter((item) => item.state?.kind === 'unreadable').length,
      duplicates: selectedSources.filter((item) => item.duplicatePaths?.length).length,
      errors,
    },
  };
}

export async function preflightSessionSources(input = {}) {
  const resolved = await resolveSessionSources(input);
  return {
    ...resolved,
    ready: resolved.selectedSources.length > 0,
    sourcePaths: resolved.selectedSources.map((item) => item.sourcePath),
    threadIds: resolved.selectedSources.map((item) => item.sessionId).filter(Boolean),
  };
}
