import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildIRBundle } from './ir/legacy-bridge.mjs';
import { compileConversationTargets } from './compilers/compiler-facade.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(MODULE_DIR, '..', '..');
export const DEFAULT_OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'output', 'session-forensics');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET_PATTERNS = [
  /\b(sk|rk|pk|api)[-_][a-z0-9_-]{16,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;"'}]{6,}/gi,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function redactText(value, { redact = true, maxLength = 520 } = {}) {
  let text = safeString(value).replace(/\s+/g, ' ').trim();
  if (redact) {
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  }
  if (text.length > maxLength) return `${text.slice(0, Math.max(0, maxLength - 14))} ...[truncated]`;
  return text;
}

function redactMultiline(value, { redact = true, maxLength = 2400 } = {}) {
  let text = safeString(value);
  if (redact) {
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  }
  if (text.length > maxLength) return `${text.slice(0, Math.max(0, maxLength - 14))}\n...[truncated]`;
  return text;
}

function contentText(content, options) {
  if (typeof content === 'string') return redactText(content, options);
  if (!Array.isArray(content)) {
    if (isObject(content)) {
      return redactText(content.text ?? content.content ?? content.value ?? '', options);
    }
    return redactText(content, options);
  }

  const values = [];
  for (const item of content) {
    if (typeof item === 'string') values.push(item);
    else if (isObject(item)) values.push(item.text ?? item.content ?? item.value ?? item.input_text ?? item.output_text ?? '');
  }
  return redactText(values.filter(Boolean).join('\n'), options);
}

function multilineContentText(content, options) {
  if (typeof content === 'string') return redactMultiline(content, options);
  if (!Array.isArray(content)) {
    if (isObject(content)) return redactMultiline(content.text ?? content.content ?? content.value ?? '', options);
    return redactMultiline(content, options);
  }
  const values = [];
  for (const item of content) {
    if (typeof item === 'string') values.push(item);
    else if (isObject(item)) values.push(item.text ?? item.content ?? item.value ?? item.input_text ?? item.output_text ?? '');
  }
  return redactMultiline(values.filter(Boolean).join('\n'), options);
}

function normaliseArgument(value, options) {
  const fullRaw = safeString(value);
  if (typeof value === 'string') {
    try {
      return { raw: redactMultiline(value, { ...options, maxLength: 2400 }), fullRaw, parsed: JSON.parse(value) };
    } catch {
      return { raw: redactMultiline(value, { ...options, maxLength: 2400 }), fullRaw, parsed: null };
    }
  }
  return { raw: redactMultiline(value, { ...options, maxLength: 2400 }), fullRaw, parsed: isObject(value) || Array.isArray(value) ? value : null };
}

function responseType(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return String(payload.type ?? record.item_type ?? record.type ?? '').toLowerCase();
}

function recordType(record) {
  return String(record.type ?? record.event_type ?? record.kind ?? 'unknown');
}

function timestampOf(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return record.timestamp ?? payload.timestamp ?? payload.created_at ?? payload.createdAt ?? null;
}

function eventName(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return payload.name ?? payload.tool_name ?? payload.function?.name ?? record.name ?? record.tool_name ?? null;
}

function eventCallId(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return payload.call_id ?? payload.callId ?? payload.tool_call_id ?? payload.id ?? record.call_id ?? record.callId ?? null;
}

function eventArguments(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return payload.arguments ?? payload.input ?? payload.parameters ?? payload.params ?? payload.payload ?? record.arguments ?? record.input ?? null;
}

function eventOutput(record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return payload.output ?? payload.content ?? payload.result ?? payload.response ?? record.output ?? record.result ?? null;
}

function isToolOutput(type, record) {
  if (/(function|tool|custom).*(_call_)?output|tool_result|function_result/.test(type)) return true;
  const payload = isObject(record.payload) ? record.payload : {};
  return Boolean((payload.call_id || payload.callId) && (payload.output !== undefined || payload.result !== undefined));
}

function isToolCall(type, record) {
  if (isToolOutput(type, record)) return false;
  if (/(function|tool|custom).*call/.test(type)) return Boolean(eventName(record));
  const payload = isObject(record.payload) ? record.payload : {};
  return Boolean((payload.name || payload.tool_name) && (payload.arguments !== undefined || payload.input !== undefined));
}

function isMessage(type, record) {
  const payload = isObject(record.payload) ? record.payload : {};
  return type === 'message' || Boolean(payload.role && (payload.content !== undefined || payload.text !== undefined));
}

function isSuccessOutput(value) {
  const text = safeString(value);
  if (/\b(exit code|status)\s*[:=]?\s*[1-9]\d*/i.test(text)) return false;
  if (/\b(script failed|script error|traceback|uncaught exception)\b/i.test(text)) return false;
  if (/"(?:isError|is_error)"\s*:\s*true/i.test(text)) return false;
  if (/"(?:status|state)"\s*:\s*"(?:failed|error)"/i.test(text)) return false;
  if (/"error"\s*:\s*(?!null\b|""\s*[,}])(?:"[^"\r\n]+"|\{)/i.test(text)) return false;
  return true;
}

function parseTimestamp(value) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function commandCategory(command) {
  const text = command.toLowerCase();
  if (/\b(rg|grep|findstr|ls|dir|get-childitem|cat|type|sed|head|tail|select-string)\b/.test(text)) return 'discovery';
  if (/\b(npm\s+(run\s+)?(test|build)|node\s+--test|pytest|vitest|jest|playwright|verify|lint|tsc)\b/.test(text)) return 'verification';
  if (/\b(git\s+(status|diff|show|log))\b/.test(text)) return 'repository-inspection';
  if (/\b(curl|invoke-webrequest|wget|web__run)\b/.test(text)) return 'external-research';
  if (/\b(node|python|pwsh|powershell|bash|sh)\b/.test(text)) return 'script-execution';
  return 'command';
}

function extractCommands(toolName, argument) {
  const commands = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      if (['cmd', 'command', 'script', 'shell', 'input'].includes(key.toLowerCase())) {
        const excerpt = redactText(value, { maxLength: 800 });
        if (excerpt) commands.push(excerpt);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (isObject(value)) Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
  };

  if (argument.parsed) visit(argument.parsed);
  const inlinePattern = /["'](?:cmd|command|script|shell)["']\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of argument.fullRaw.matchAll(inlinePattern)) {
    const literal = match[1];
    try {
      commands.push(literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n'));
    } catch {
      commands.push(literal.slice(1, -1));
    }
  }
  if (!commands.length && /exec|command|shell/i.test(toolName) && argument.raw) commands.push(argument.raw);
  return [...new Set(commands)];
}

function patchLineCounts(text) {
  let added = 0;
  let removed = 0;
  for (const line of safeString(text).split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function extractPatchArtifacts(text) {
  const raw = safeString(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
  if (!/\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)|diff --git/.test(raw)) return [];
  const paths = [];
  const patchPattern = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/gim;
  for (const match of raw.matchAll(patchPattern)) {
    paths.push({ action: match[1].toLowerCase(), path: match[2].trim().replace(/\\\\/g, '\\') });
  }
  const diffPattern = /^diff --git a\/(.+?) b\/(.+)$/gim;
  for (const match of raw.matchAll(diffPattern)) {
    paths.push({ action: 'update', path: match[2].trim() });
  }
  const counts = patchLineCounts(raw);
  return paths.map((entry) => ({ ...entry, ...counts }));
}

function extractFileChangeArtifacts(value, seen = new Set(), output = []) {
  if (value === null || value === undefined || typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => extractFileChangeArtifacts(item, seen, output));
    return output;
  }
  const pathValue = value.path ?? value.filePath ?? value.file_path ?? value.filename;
  if (typeof pathValue === 'string' && pathValue) {
    output.push({
      path: pathValue,
      action: String(value.action ?? value.kind ?? value.status ?? value.change ?? 'changed').toLowerCase(),
    });
  }
  Object.values(value).forEach((item) => extractFileChangeArtifacts(item, seen, output));
  return output;
}

function nestedToolNames(text) {
  const names = [];
  for (const match of safeString(text).matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) names.push(match[1]);
  return names;
}

function messageContextKind(actor, text) {
  if (actor !== 'user') return 'assistant-output';
  const value = safeString(text).trim();
  if (/^<environment_context[>\s]/i.test(value)) return 'environment-context';
  if (/^<codex_internal_context[>\s]/i.test(value)) return 'goal-context';
  if (/^<in-app-browser-context[>\s]/i.test(value)) return 'ambient-browser-context';
  if (/^#\s*AGENTS\.md instructions/i.test(value) || /<INSTRUCTIONS>/i.test(value)) return 'instruction-context';
  if (/^<app-context[>\s]/i.test(value)) return 'application-context';
  return 'user-request';
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function sessionIdFromPath(filePath) {
  return path.basename(filePath).match(UUID_RE)?.[0] ?? null;
}

function cleanSessionId(value) {
  const found = safeString(value).match(UUID_RE)?.[0];
  return found ? found.toLowerCase() : null;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((entry) => path.resolve(entry)))];
}

export function defaultSessionRoots(extraRoots = []) {
  const codexHome = process.env.CODEX_HOME || 'E:\\CodexHome';
  return uniquePaths([
    process.env.CODEX_SESSION_ROOT,
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
    path.join(os.homedir(), '.codex', 'sessions'),
    path.join(os.homedir(), '.codex', 'archived_sessions'),
    ...asArray(extraRoots),
  ]);
}

async function listFilesRecursively(root, found, limit) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= limit) return;
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) await listFilesRecursively(filePath, found, limit);
    else if (entry.isFile() && /\.(jsonl|json)$/i.test(entry.name) && UUID_RE.test(entry.name)) found.push(filePath);
  }
}

function sessionTitleFromText(value) {
  let text = redactMultiline(value, { redact: true, maxLength: 1600 })
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/giu, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const rawLines = text
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s*/, '').trim())
    .filter(Boolean);
  const requestMarkerIndex = rawLines.findIndex((line) => /^(?:my\s+request(?:\s+for\s+codex)?|我的请求(?:\s*for\s*codex)?|用户请求)\s*[:：]?\s*$/i.test(line));
  const lines = (requestMarkerIndex >= 0 ? rawLines.slice(requestMarkerIndex + 1) : rawLines)
    .filter((line) => !/^(files? mentioned|文件(?:提及|列表)|附件|attachments?)\b/i.test(line));
  text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > 96 ? `${chars.slice(0, 96).join('')}…` : text;
}

function metadataSessionTitle(record) {
  if (!isObject(record)) return '';
  const payload = isObject(record.payload) ? record.payload : {};
  const type = recordType(record).toLowerCase();
  if (!/session|thread/.test(type)) return '';
  const nested = isObject(payload.thread) ? payload.thread : isObject(payload.session) ? payload.session : {};
  return sessionTitleFromText(payload.title ?? payload.session_title ?? payload.thread_title ?? payload.name ?? nested.title ?? nested.name ?? '');
}

function userTextFromSessionRecord(record) {
  if (!isObject(record)) return '';
  const payload = isObject(record.payload) ? record.payload : {};
  const role = String(payload.role ?? record.role ?? '').toLowerCase();
  if (role === 'user') return multilineContentText(payload.content ?? payload.message ?? payload.text ?? '', { redact: true, maxLength: 1600 });
  if (recordType(record) === 'event_msg' && String(payload.type ?? '').toLowerCase() === 'user_message') {
    return multilineContentText(payload.message ?? payload.content ?? payload.text ?? '', { redact: true, maxLength: 1600 });
  }
  return '';
}

function isSessionBootstrapText(value) {
  const text = safeString(value).trim();
  return /^(?:#\s*)?AGENTS\.md\s+instructions\b/i.test(text)
    || /<(?:app-context|environment_context|skills_instructions|permissions instructions)>/i.test(text.slice(0, 512));
}

async function readSessionDescriptor(filePath, sessionId) {
  const fallbackTitle = `未命名会话 ${String(sessionId || '').slice(0, 8) || '记录'}`;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return { title: fallbackTitle, titleSource: 'fallback', workspacePaths: [] };
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', start: 0, end: 512 * 1024 - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const workspacePaths = [];
  const result = (title, titleSource) => ({ title, titleSource, workspacePaths: uniquePaths(workspacePaths) });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = isObject(record.payload) ? record.payload : {};
      const context = isObject(payload.context) ? payload.context : {};
      const candidates = [
        payload.cwd,
        payload.working_directory,
        payload.workingDirectory,
        payload.workspace,
        payload.workspaceRoot,
        context.cwd,
        context.working_directory,
        context.workingDirectory,
        context.workspace,
        context.workspaceRoot,
      ];
      for (const candidate of candidates) {
        const candidatePath = safeString(candidate).trim();
        if (candidatePath && path.isAbsolute(candidatePath)) workspacePaths.push(candidatePath);
      }
      const metadataTitle = metadataSessionTitle(record);
      if (metadataTitle) return result(metadataTitle, 'metadata');
      const userText = userTextFromSessionRecord(record);
      if (isSessionBootstrapText(userText)) continue;
      const userTitle = sessionTitleFromText(userText);
      if (userTitle) return result(userTitle, 'first-user-request');
    }
  } catch {
    return result(fallbackTitle, 'fallback');
  } finally {
    lines.close();
    stream.destroy();
  }
  return result(fallbackTitle, 'fallback');
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

export async function discoverSessions({ roots = [], limit = 200, complete = false } = {}) {
  const files = [];
  const safeLimit = Math.max(1, Number(limit) || 200);
  const collectionLimit = complete ? Number.MAX_SAFE_INTEGER : Math.max(safeLimit * 8, safeLimit);
  const scanRoots = asArray(roots).filter(Boolean).length > 0 ? uniquePaths(roots) : defaultSessionRoots();
  for (const root of scanRoots) {
    await listFilesRecursively(root, files, collectionLimit);
  }
  const rows = await mapWithConcurrency(files, 16, async (filePath) => {
    const stat = await fsp.stat(filePath);
    const sessionId = sessionIdFromPath(filePath);
    const descriptor = await readSessionDescriptor(filePath, sessionId);
    return {
      sessionId,
      path: filePath,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      title: descriptor.title,
      titleSource: descriptor.titleSource,
      workspacePaths: descriptor.workspacePaths,
    };
  });
  const uniqueSessions = new Map();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const key = row.sessionId.toLowerCase();
    const existing = uniqueSessions.get(key);
    const isMoreComplete = !existing
      || row.bytes > existing.bytes
      || (row.bytes === existing.bytes && Date.parse(row.modifiedAt) > Date.parse(existing.modifiedAt));
    if (isMoreComplete) {
      row.duplicatePaths = uniquePaths([
        ...(existing?.duplicatePaths || []),
        existing?.path,
      ]).filter((candidate) => candidate !== row.path);
      uniqueSessions.set(key, row);
    } else {
      existing.duplicatePaths = uniquePaths([
        ...(existing.duplicatePaths || []),
        row.path,
      ]).filter((candidate) => candidate !== existing.path);
    }
  }
  const sessions = [...uniqueSessions.values()]
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
  return complete ? sessions : sessions.slice(0, safeLimit);
}

export async function resolveSessionSource({ threadId, sourcePath, roots = [] } = {}) {
  if (sourcePath) {
    const resolved = path.resolve(sourcePath);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error(`会话源路径不是文件：${resolved}`);
    return { sourcePath: resolved, sessionId: cleanSessionId(threadId) ?? sessionIdFromPath(resolved) };
  }

  const sessionId = cleanSessionId(threadId);
  if (!sessionId) throw new Error('请提供 UUID 会话编号，或提供 JSON/JSONL 会话文件的 sourcePath。');
  const matches = (await discoverSessions({ roots, limit: 5000 }))
    .filter((entry) => entry.sessionId?.toLowerCase() === sessionId);
  if (matches.length === 0) {
    throw new Error(`未找到会话 ${sessionId} 的本机 Codex 记录；请提供 --source 或增加 --root。`);
  }
  return { sourcePath: matches[0].path, sessionId };
}

function appendTimeline(parsed, event) {
  parsed.timeline.push({ sequence: parsed.timeline.length + 1, ...event });
}

function associateToolOutputs(parsed) {
  const byCallId = new Map();
  for (const output of parsed.toolOutputs) {
    if (output.callId) byCallId.set(output.callId, output);
  }
  for (const tool of parsed.toolCalls) {
    const output = tool.callId ? byCallId.get(tool.callId) : null;
    tool.output = output ? {
      eventIndex: output.eventIndex,
      timestamp: output.timestamp,
      success: output.success,
      excerpt: output.excerpt,
    } : null;
    const start = parseTimestamp(tool.timestamp);
    const end = parseTimestamp(output?.timestamp);
    tool.durationMs = start !== null && end !== null && end >= start ? end - start : null;
  }
  // Timeline tool-call records are copies used by per-request episodes. Keep their
  // linked result state in sync with the catalog records before rendering summaries.
  for (const event of parsed.timeline) {
    if (event.kind !== 'tool_call') continue;
    const output = event.callId ? byCallId.get(event.callId) : null;
    event.output = output ? {
      eventIndex: output.eventIndex,
      timestamp: output.timestamp,
      success: output.success,
      excerpt: output.excerpt,
    } : null;
    const start = parseTimestamp(event.timestamp);
    const end = parseTimestamp(output?.timestamp);
    event.durationMs = start !== null && end !== null && end >= start ? end - start : null;
  }
}

export async function parseCodexSessionFile(sourcePath, options = {}) {
  const resolvedPath = path.resolve(sourcePath);
  const stat = await fsp.stat(resolvedPath);
  const parsed = {
    sourcePath: resolvedPath,
    sourceBytes: stat.size,
    sourceSha256: await hashFile(resolvedPath),
    sourceFormat: path.extname(resolvedPath).toLowerCase(),
    sessionId: sessionIdFromPath(resolvedPath),
    sessionMeta: null,
    recordCount: 0,
    invalidRecordCount: 0,
    eventTypeCounts: {},
    responseItemTypeCounts: {},
    turnContexts: [],
    messages: [],
    toolCalls: [],
    toolOutputs: [],
    fileChanges: [],
    runtimeEvents: [],
    timeline: [],
    warnings: [],
  };
  const redactionOptions = { redact: options.redact !== false };

  if (parsed.sourceFormat === '.json') {
    const data = JSON.parse(await fsp.readFile(resolvedPath, 'utf8'));
    const records = Array.isArray(data) ? data : data.events ?? data.records ?? [data];
    for (const record of records) await consumeRecord(record, parsed, redactionOptions);
  } else {
    const stream = fs.createReadStream(resolvedPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        await consumeRecord(JSON.parse(line), parsed, redactionOptions);
      } catch (error) {
        parsed.invalidRecordCount += 1;
        if (parsed.warnings.length < 20) parsed.warnings.push(`第 ${parsed.recordCount + 1} 条记录无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  associateToolOutputs(parsed);
  parsed.sessionId = cleanSessionId(parsed.sessionMeta?.session_id ?? parsed.sessionMeta?.id ?? parsed.sessionId) ?? parsed.sessionId;
  if (parsed.invalidRecordCount > 0) parsed.warnings.push(`已跳过 ${parsed.invalidRecordCount} 条无法解析的 JSONL 记录。`);
  return parsed;
}

async function consumeRecord(record, parsed, options) {
  parsed.recordCount += 1;
  if (!isObject(record)) {
    parsed.invalidRecordCount += 1;
    return;
  }
  const rawType = recordType(record);
  const payload = isObject(record.payload) ? record.payload : {};
  const type = responseType(record);
  const timestamp = timestampOf(record);
  parsed.eventTypeCounts[rawType] = (parsed.eventTypeCounts[rawType] ?? 0) + 1;

  if (rawType === 'session_meta') {
    parsed.sessionMeta = payload;
    appendTimeline(parsed, { kind: 'session_meta', recordIndex: parsed.recordCount, timestamp, label: redactText(payload.id ?? payload.session_id ?? 'session metadata', options) });
    return;
  }

  if (rawType === 'turn_context') {
    const turn = {
      recordIndex: parsed.recordCount,
      timestamp,
      turnId: payload.turn_id ?? payload.turnId ?? payload.id ?? null,
      cwd: redactText(payload.cwd ?? '', options),
      active: payload.active ?? null,
    };
    parsed.turnContexts.push(turn);
    appendTimeline(parsed, { kind: 'turn_context', ...turn });
    return;
  }

  if (rawType === 'response_item') {
    parsed.responseItemTypeCounts[type || 'unknown'] = (parsed.responseItemTypeCounts[type || 'unknown'] ?? 0) + 1;
  }

  if (isMessage(type, record)) {
    const actor = String(payload.role ?? record.role ?? 'unknown').toLowerCase();
    const text = contentText(payload.content ?? payload.text ?? payload, options);
    const message = {
      eventIndex: parsed.timeline.length + 1,
      recordIndex: parsed.recordCount,
      timestamp,
      actor,
      text,
      channel: payload.channel ?? payload.phase ?? null,
      contextKind: messageContextKind(actor, text),
    };
    parsed.messages.push(message);
    appendTimeline(parsed, { kind: 'message', ...message });
    return;
  }

  if (isToolOutput(type, record)) {
    const output = eventOutput(record);
    const toolOutput = {
      eventIndex: parsed.timeline.length + 1,
      recordIndex: parsed.recordCount,
      timestamp,
      callId: eventCallId(record),
      success: isSuccessOutput(output),
      excerpt: contentText(output, { ...options, maxLength: 1200 }),
    };
    parsed.toolOutputs.push(toolOutput);
    appendTimeline(parsed, { kind: 'tool_output', ...toolOutput });
    return;
  }

  if (isToolCall(type, record)) {
    const name = String(eventName(record) ?? 'unnamed_tool');
    const argumentsValue = normaliseArgument(eventArguments(record), options);
    const toolCall = {
      eventIndex: parsed.timeline.length + 1,
      recordIndex: parsed.recordCount,
      timestamp,
      callId: eventCallId(record),
      name,
      argumentsExcerpt: argumentsValue.raw,
      argumentSchema: argumentsValue.parsed && isObject(argumentsValue.parsed) ? Object.keys(argumentsValue.parsed).sort() : [],
      nestedTools: nestedToolNames(argumentsValue.fullRaw),
      output: null,
      durationMs: null,
    };
    parsed.toolCalls.push(toolCall);
    appendTimeline(parsed, { kind: 'tool_call', ...toolCall, output: undefined });
    for (const command of extractCommands(name, argumentsValue)) {
      parsed.runtimeEvents.push({ kind: 'command', eventIndex: toolCall.eventIndex, tool: name, command, category: commandCategory(command) });
    }
    for (const patch of extractPatchArtifacts(argumentsValue.fullRaw)) {
      parsed.fileChanges.push({ ...patch, origin: 'tool_argument', eventIndex: toolCall.eventIndex, tool: name });
    }
    return;
  }

  if (/file.?change/i.test(rawType)) {
    const changes = extractFileChangeArtifacts(payload);
    for (const change of changes) parsed.fileChanges.push({ ...change, origin: 'runtime_event', eventIndex: parsed.timeline.length + 1, tool: null });
    appendTimeline(parsed, {
      kind: 'file_change',
      recordIndex: parsed.recordCount,
      timestamp,
      changes: changes.slice(0, 20),
      changeCount: changes.length,
    });
    return;
  }

  const runtimeEvent = {
    kind: 'runtime_event',
    recordIndex: parsed.recordCount,
    timestamp,
    eventType: rawType,
    responseType: type || null,
    label: redactText(payload.type ?? payload.message ?? payload.status ?? rawType, options),
  };
  parsed.runtimeEvents.push(runtimeEvent);
  appendTimeline(parsed, runtimeEvent);
}

function classifyIntent(text) {
  const value = safeString(text).toLowerCase();
  const labels = [];
  if (/(session|thread|conversation|会话|对话|调用链|工具调用)/.test(value)) labels.push('session-analysis');
  if (/(skill|技能|prompt)/.test(value)) labels.push('skill-packaging');
  if (/(mcp|模型上下文协议)/.test(value)) labels.push('mcp-integration');
  if (/(ui|界面|前端|workspace|工作台)/.test(value)) labels.push('ui-integration');
  if (/(report|报告|洞察|分析|analyse|analyze)/.test(value)) labels.push('analysis-report');
  if (/(test|verify|验证|测试|build|构建)/.test(value)) labels.push('verification');
  if (/(fix|bug|修复|报错)/.test(value)) labels.push('debugging');
  return labels.length > 0 ? labels : ['general-request'];
}

function toolStage(tool) {
  const name = safeString(tool.name).toLowerCase();
  const args = safeString(tool.argumentsExcerpt).toLowerCase();
  if (/spawn_agent|wait_agent|send_message|subagent/.test(name)) return 'orchestration';
  if (/read_thread|list_thread|read_mcp|web__run/.test(name)) return 'source-discovery';
  if (/rg|grep|read|list|find|show|status/.test(name) || /\b(rg|grep|get-content|readfile|readdir)\b/.test(args)) return 'inspection';
  if (/apply_patch|write|edit/.test(name) || /\*\*\* begin patch/.test(args)) return 'implementation';
  if (/exec|command|shell/.test(name)) {
    if (/\b(test|verify|build|lint|playwright|pytest|vitest|jest)\b/.test(args)) return 'verification';
    return 'execution';
  }
  if (/image|artifact|export|report/.test(name)) return 'artifact-generation';
  return 'tool-use';
}

function buildEpisodes(parsed) {
  const episodes = [];
  let current = null;
  for (const event of parsed.timeline) {
    if (event.kind === 'message' && event.actor === 'user' && event.contextKind === 'user-request') {
      current = {
        index: episodes.length + 1,
        triggerEventIndex: event.sequence,
        timestamp: event.timestamp,
        request: event.text,
        intents: classifyIntent(event.text),
        assistantMessages: [],
        tools: [],
        stages: [],
        outcomes: [],
      };
      episodes.push(current);
      continue;
    }
    if (!current) continue;
    if (event.kind === 'message' && event.actor === 'assistant' && event.text) current.assistantMessages.push(event.text);
    if (event.kind === 'tool_call') {
      const stage = toolStage(event);
      current.tools.push(event);
      if (!current.stages.includes(stage)) current.stages.push(stage);
    }
    if (event.kind === 'tool_output') current.outcomes.push(event);
  }
  return episodes.map((episode) => ({
    ...episode,
    request: redactText(episode.request, { maxLength: 520 }),
    assistantMessages: episode.assistantMessages.slice(0, 3).map((message) => redactText(message, { maxLength: 420 })),
    toolNames: [...new Set(episode.tools.map((tool) => tool.name))],
    toolCount: episode.tools.length,
    completedToolCount: episode.tools.filter((tool) => tool.output).length,
    succeededToolCount: episode.tools.filter((tool) => tool.output?.success).length,
    failedToolCount: episode.tools.filter((tool) => tool.output && !tool.output.success).length,
    title: requestTitle(episode.request, episode.index, episode.intents),
    requestContent: localizeRequestEvidence(redactText(episode.request, { maxLength: 2400 })),
    assistantContent: episode.assistantMessages.length
      ? episode.assistantMessages.slice(0, 3).map((message) => localizeRequestEvidence(redactText(message, { maxLength: 900 }))).join('\n\n')
      : '本阶段没有可提取的助手正文。',
    outcomeSummary: episode.tools.length
      ? `本阶段记录 ${episode.tools.length} 次工具调用，其中 ${episode.tools.filter((tool) => tool.output).length} 次已关联结果、${episode.tools.filter((tool) => tool.output?.success).length} 次成功、${episode.tools.filter((tool) => tool.output && !tool.output.success).length} 次非成功、${episode.tools.filter((tool) => !tool.output).length} 次未关联结果。`
      : '本阶段未记录工具调用；可见执行内容仅来自助手回应。',
    intentLabels: displayIntentList(episode.intents),
    stageLabels: displayStageList(episode.stages),
  }));
}

function buildToolCatalog(parsed) {
  const catalog = new Map();
  for (const call of parsed.toolCalls) {
    const current = catalog.get(call.name) ?? {
      name: call.name,
      calls: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      pending: 0,
      durations: [],
      observedArgumentKeys: new Set(),
      nestedTools: new Set(),
      examples: [],
    };
    current.calls += 1;
    if (call.output) {
      current.completed += 1;
      if (call.output.success) current.succeeded += 1;
      else current.failed += 1;
    } else current.pending += 1;
    if (Number.isFinite(call.durationMs)) current.durations.push(call.durationMs);
    call.argumentSchema.forEach((key) => current.observedArgumentKeys.add(key));
    call.nestedTools.forEach((name) => current.nestedTools.add(name));
    if (current.examples.length < 3) current.examples.push({ eventIndex: call.eventIndex, argumentsExcerpt: call.argumentsExcerpt, outputExcerpt: call.output?.excerpt ?? null });
    catalog.set(call.name, current);
  }
  return [...catalog.values()]
    .map((item) => ({
      name: item.name,
      calls: item.calls,
      completed: item.completed,
      succeeded: item.succeeded,
      failed: item.failed,
      pending: item.pending,
      averageDurationMs: item.durations.length ? Math.round(item.durations.reduce((sum, value) => sum + value, 0) / item.durations.length) : null,
      observedArgumentKeys: [...item.observedArgumentKeys].sort(),
      nestedTools: [...item.nestedTools].sort(),
      examples: item.examples,
    }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

function buildNestedToolCatalog(parsed) {
  const catalog = new Map();
  for (const wrapper of parsed.toolCalls) {
    for (const name of wrapper.nestedTools) {
      const item = catalog.get(name) ?? { name, calls: 0, wrapperTools: new Set(), examples: [] };
      item.calls += 1;
      item.wrapperTools.add(wrapper.name);
      if (item.examples.length < 3) item.examples.push({ eventIndex: wrapper.eventIndex, wrapper: wrapper.name, argumentsExcerpt: wrapper.argumentsExcerpt });
      catalog.set(name, item);
    }
  }
  return [...catalog.values()]
    .map((item) => ({ name: item.name, calls: item.calls, wrapperTools: [...item.wrapperTools].sort(), examples: item.examples }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

const DISPLAY_LABELS = {
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
  verification_stage: '验证验收',
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
  'external-research': '外部资料检索',
  'script-execution': '脚本执行',
  'file-operation': '文件操作',
  'process-launch': '进程启动',
  'report-generation': '报告生成',
  command: '命令执行',
  'repository-inspection': '仓库检查',
  strong: '强证据',
  moderate: '中等证据',
  weak: '弱证据',
};

const SUMMARY_LABELS = {
  userMessages: '用户消息',
  actionableUserMessages: '可执行用户请求',
  assistantMessages: '助手消息',
  turnContexts: '会话上下文',
  toolCalls: '外层工具调用',
  toolOutputs: '工具结果',
  uniqueWrapperTools: '外层工具种类',
  nestedToolCalls: '嵌套工具调用',
  uniqueNestedTools: '嵌套工具种类',
  linkedToolResults: '已关联工具结果',
  runtimeFileChanges: '文件变更证据',
  shellOrScriptCommands: '命令与脚本证据',
  episodes: '用户请求阶段',
};

function displayLabel(value, fallback = '未标注') {
  const text = safeString(value);
  return DISPLAY_LABELS[text] ?? fallback;
}

function displaySummaryLabel(value) {
  const text = safeString(value);
  return SUMMARY_LABELS[text] ?? text;
}

function displayIntentList(values = []) {
  return values.map((value) => displayLabel(value, value));
}

function displayStageList(values = []) {
  return values.map((value) => displayLabel(value, value));
}

function displayStageSequence(values = []) {
  return displayStageList(values).join(' → ');
}

function localizeRequestEvidence(value) {
  return safeString(value)
    .replace(/# Files mentioned by the user:/gi, '用户提到的文件：')
    .replace(/## My request:/gi, '用户请求：')
    .replace(/Files mentioned by the user/gi, '用户提到的文件')
    .replace(/My request/gi, '用户请求');
}

function requestTitle(request, index, intents = []) {
  const text = safeString(request);
  const titleRules = [
    [/模仿这个.*全量洞察|全量洞察现在的数据|全量数据.*洞察/i, '全量数据洞察与证据盘点'],
    [/详尽的内容分析|扎根分析|玩家的相关语境|质性编码/i, '玩家语境与扎根编码分析'],
    [/更MKT角度|营销角度|MKT角度|营销洞察/i, '营销机会与传播策略强化'],
    [/量化分析|粉丝和受众|粉丝与受众|受众量化/i, '粉丝受众量化与分层建模'],
    [/内容太少|篇幅不足|扩写|补充内容|证据不足|too little content/i, '报告扩展与证据密度提升'],
    [/内容还是完全不行.*大力升级|报告.*升级|重写报告/i, '洞察报告重写与交付升级'],
    [/skill.*mcp|mcp.*skill|封装.*skill|封装.*mcp|能力包|智能代理/i, '技能、MCP 与独立 Agent 封装'],
    [/界面|UI|前端|操作台|独立界面/i, '专属操作界面与交互闭环'],
    [/安装|发布|打包|ZIP|外部用户|可安装/i, '外部安装包与一键启动交付'],
    [/续跑|继续|验证|验收|测试|修复/i, '端到端验证、修复与交付验收'],
    [/PPT|PowerPoint|路演|演示稿|幻灯/i, '路演演示稿融合与结构重构'],
  ];
  const matched = titleRules.find(([pattern]) => pattern.test(text));
  const intent = displayIntentList(intents)[0] || '通用任务执行';
  const title = matched ? matched[1] : intent;
  return `P${index}｜${title}`;
}

function displayAction(value) {
  const text = safeString(value);
  if (text.startsWith('Retry ')) return `重试工具 ${text.slice(6)}`;
  if (text.includes('->')) return `按阶段执行：${displayStageSequence(text.split('->').map((item) => item.trim()))}`;
  return displayLabel(text, text);
}

function displayOrigin(value) {
  const text = safeString(value);
  return displayLabel(text, text.replace(/_/g, ' '));
}

function displayCommandCategory(value) {
  return displayLabel(value, value || '未分类命令');
}

function displayEvidenceList(values = []) {
  return values.map((value) => safeString(value).replace(/^episode (\d+):/i, '请求阶段 $1：').replace(/^file change:/i, '文件变更：'));
}

function inferTriggerRules(episodes) {
  const rules = [];
  for (const episode of episodes) {
    rules.push({
      confidence: 'direct',
      trigger: `第 ${episode.index} 个请求的用户明确指令`,
      condition: localizeRequestEvidence(episode.request) || '没有可提取的用户消息内容',
      action: episode.stages.length ? `按阶段执行：${displayStageSequence(episode.stages)}` : '未记录工具调用，仅生成助手回应',
      evidence: `时间线事件 ${episode.triggerEventIndex}；相关工具：${episode.toolNames.join('、') || '无'}`,
    });
    const stageIndexes = new Map(episode.stages.map((stage, index) => [stage, index]));
    if (stageIndexes.has('inspection') && stageIndexes.has('implementation') && stageIndexes.get('inspection') < stageIndexes.get('implementation')) {
      rules.push({
        confidence: 'inferred',
        trigger: `第 ${episode.index} 个请求中，检查取证先于实现修改`,
        condition: '检查与取证阶段先于实现与修改阶段完成',
        action: '使用已发现的上下文驱动编辑或补丁',
        evidence: `阶段顺序：${displayStageSequence(episode.stages)}`,
      });
    }
    if (stageIndexes.has('implementation') && stageIndexes.has('verification') && stageIndexes.get('implementation') < stageIndexes.get('verification')) {
      rules.push({
        confidence: 'inferred',
        trigger: `第 ${episode.index} 个请求中，实现修改后执行验证`,
        condition: '实现与修改阶段后存在验证命令',
        action: '在报告完成前验证已修改的产物',
        evidence: `阶段顺序：${displayStageSequence(episode.stages)}`,
      });
    }
    const failedTools = episode.tools.filter((tool) => tool.output && !tool.output.success);
    for (const failed of failedTools) {
      const retry = episode.tools.find((tool) => tool.eventIndex > failed.eventIndex && tool.name === failed.name);
      if (retry) {
        rules.push({
          confidence: 'inferred',
          trigger: `观察到工具 ${failed.name} 的非成功结果`,
          condition: `事件 ${failed.output.eventIndex} 的工具结果被归类为非成功`,
          action: `重试工具 ${failed.name}`,
          evidence: `工具事件 ${failed.eventIndex} -> ${retry.eventIndex}`,
        });
      }
    }
  }
  return rules;
}

function buildCodeArtifacts(parsed) {
  const commands = parsed.runtimeEvents
    .filter((event) => event.kind === 'command')
    .map((event) => ({ ...event, command: redactText(event.command, { maxLength: 800 }) }));
  const fileChanges = [];
  const seen = new Set();
  for (const change of parsed.fileChanges) {
    const key = `${change.path}|${change.action}|${change.eventIndex}|${change.origin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fileChanges.push(change);
  }
  const extensions = {};
  for (const change of fileChanges) {
    const extension = path.extname(change.path).toLowerCase() || '[no extension]';
    extensions[extension] = (extensions[extension] ?? 0) + 1;
  }
  return { commands, fileChanges, fileExtensions: extensions };
}

function buildCapabilityCandidates(episodes, toolCatalog, codeArtifacts) {
  const text = episodes.map((episode) => `${episode.request} ${episode.assistantMessages.join(' ')}`).join(' ').toLowerCase();
  const toolNames = toolCatalog.map((tool) => tool.name).join(' ').toLowerCase();
  const changes = codeArtifacts.fileChanges.map((change) => change.path).join(' ').toLowerCase();
  const candidates = [];
  const add = (name, trigger, workflow, match) => {
    const evidence = [
      ...episodes.filter((episode) => match(`${episode.request} ${episode.assistantMessages.join(' ')}`)).slice(0, 3).map((episode) => `请求阶段 ${episode.index}：${localizeRequestEvidence(episode.request)}`),
      ...codeArtifacts.fileChanges.filter((change) => match(change.path)).slice(0, 3).map((change) => `文件变更：${change.path}`),
    ];
    if (evidence.length === 0 && !match(`${text} ${toolNames} ${changes}`)) return;
    candidates.push({
      name,
      confidence: evidence.length >= 2 ? 'strong' : 'moderate',
      trigger,
      workflow,
      evidence,
      score: evidence.length * 20 + Math.min(20, toolCatalog.length * 2) + Math.min(20, codeArtifacts.fileChanges.length * 2),
    });
  };
  add('会话证据分析', '用户提供会话标识或转储文件，并要求还原工具、代码或决策链。', ['定位来源', '规范化记录', '关联调用与结果', '输出证据报告'], (value) => /(session|thread|conversation|会话|对话|tool call|工具调用)/i.test(value));
  add('可复用工作流封装', '已有流程需要封装成可调用技能、服务接口或操作界面。', ['识别重复流程', '提取触发条件', '定义输入输出契约', '封装并验证'], (value) => /(skill|mcp|workflow|reusable|技能|复用|工作流)/i.test(value));
  add('基于证据的实现', '请求要求检查仓库、修改源文件并通过测试或构建验证。', ['检查现状', '实现修改', '验证结果', '发布产物'], (value) => /(apply_patch|test|verify|build|\.m?js|\.tsx?|\.py)/i.test(value));
  add('报告与产物生成', '用户要求生成结构化报告、导出文件或可审计结果。', ['收集源数据', '转换分析', '渲染报告', '验证输出'], (value) => /(report|analysis|export|artifact|报告|分析|导出|洞察)/i.test(value));
  return candidates.sort((left, right) => right.score - left.score);
}

function slugify(value) {
  const basic = safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return basic || 'derived-codex-workflow';
}

function buildSkillBlueprint(episodes, capabilities, codeArtifacts, toolCatalog, nestedToolCatalog = []) {
  const primary = capabilities[0];
  const triggers = episodes
    .filter((episode) => episode.request)
    .slice(0, 5)
    .map((episode) => ({ episode: episode.index, intent: episode.intents, requestExcerpt: localizeRequestEvidence(episode.request) }));
  const stages = [...new Set(episodes.flatMap((episode) => episode.stages))];
  const identifier = slugify(primary?.name ?? 'codex-workflow');
  return {
    candidateId: identifier.length > 55 ? identifier.slice(0, 55) : identifier,
    candidateName: primary?.name ?? '会话工作流',
    description: primary ? `根据当前会话的可见证据，提炼出的“${primary.name}”可复用工作流。` : '根据当前会话的可见证据提炼出的 Codex 可复用工作流。',
    activationSignals: triggers,
    requiredInputs: ['会话 ID 或转储源文件', '期望的报告与输出目录'],
    observedTools: [...new Set([...toolCatalog.map((tool) => tool.name), ...nestedToolCatalog.map((tool) => tool.name)])],
    implementationFiles: [...new Set(codeArtifacts.fileChanges.map((change) => change.path))],
    workflow: stages.length ? displayStageList(stages) : ['收集证据', '执行请求动作', '验证产物'],
    guardrails: [
      '将原始会话事件视为证据，并将时序推断与直接证据分开标注。',
      '默认脱敏凭据样式文本，不输出完整原始工具结果。',
      '让会话导入、解析、服务接口与界面边界保持可独立测试。',
    ],
  };
}

export function analyseParsedSession(parsed, { includeEvidence = false } = {}) {
  const episodes = buildEpisodes(parsed);
  const toolCatalog = buildToolCatalog(parsed);
  const nestedToolCatalog = buildNestedToolCatalog(parsed);
  const codeArtifacts = buildCodeArtifacts(parsed);
  const triggerLogic = inferTriggerRules(episodes);
  const capabilities = buildCapabilityCandidates(episodes, toolCatalog, codeArtifacts);
  const skillBlueprint = buildSkillBlueprint(episodes, capabilities, codeArtifacts, toolCatalog, nestedToolCatalog);
  const knownEventTotal = Object.values(parsed.eventTypeCounts).reduce((sum, value) => sum + value, 0);
  const analysis = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      sessionId: parsed.sessionId,
      path: parsed.sourcePath,
      format: parsed.sourceFormat,
      bytes: parsed.sourceBytes,
      sha256: parsed.sourceSha256,
      recordCount: parsed.recordCount,
      invalidRecordCount: parsed.invalidRecordCount,
    },
    coverage: {
      eventTypeCounts: parsed.eventTypeCounts,
      responseItemTypeCounts: parsed.responseItemTypeCounts,
      knownEventTotal,
      normalisedEventCount: parsed.timeline.length,
      fullTimelineArtifact: 'normalized-events.ndjson',
    },
    summary: {
      userMessages: parsed.messages.filter((message) => message.actor === 'user').length,
      actionableUserMessages: parsed.messages.filter((message) => message.actor === 'user' && message.contextKind === 'user-request').length,
      assistantMessages: parsed.messages.filter((message) => message.actor === 'assistant').length,
      turnContexts: parsed.turnContexts.length,
      toolCalls: parsed.toolCalls.length,
      toolOutputs: parsed.toolOutputs.length,
      uniqueWrapperTools: toolCatalog.length,
      nestedToolCalls: nestedToolCatalog.reduce((sum, tool) => sum + tool.calls, 0),
      uniqueNestedTools: nestedToolCatalog.length,
      linkedToolResults: parsed.toolCalls.filter((tool) => tool.output).length,
      runtimeFileChanges: codeArtifacts.fileChanges.length,
      shellOrScriptCommands: codeArtifacts.commands.length,
      episodes: episodes.length,
    },
    toolCatalog: includeEvidence ? toolCatalog : toolCatalog.map(({ examples, ...tool }) => tool),
    nestedToolCatalog: includeEvidence ? nestedToolCatalog : nestedToolCatalog.map(({ examples, ...tool }) => tool),
    codeArtifacts: includeEvidence ? codeArtifacts : {
      commands: codeArtifacts.commands.map(({ command, ...commandMeta }) => ({ ...commandMeta, command: redactText(command, { maxLength: 240 }) })),
      fileChanges: codeArtifacts.fileChanges,
      fileExtensions: codeArtifacts.fileExtensions,
    },
    episodes: episodes.map(({ tools, outcomes, ...episode }) => ({
      ...episode,
      tools: includeEvidence ? tools.map((tool) => ({ name: tool.name, eventIndex: tool.eventIndex, output: tool.output })) : episode.toolNames,
      outcomeCount: outcomes.length,
    })),
    triggerLogic,
    reusableCapabilities: capabilities,
    skillBlueprint,
    warnings: parsed.warnings,
    limitations: [
      '本报告不解释内部推理；只依据可见消息、结构化事件、工具调用、工具结果和文件变更事件。',
      '缺少工具结果时仅标记为“未关联”，不会直接判定为失败。',
      '时序推断只描述观察到的事件顺序，并会明确标注为“时序推断”。',
    ],
    timelinePreview: parsed.timeline.slice(0, 120),
  };
  analysis.ir = buildIRBundle({ parsed, analysis }).summary;
  analysis.presentation = {
    language: 'zh-CN',
    title: '会话全量取证报告',
    summary: '本会话识别出 ' + analysis.summary.episodes + ' 个用户需求阶段，记录 ' + analysis.summary.toolCalls + ' 次外层工具调用、' + analysis.summary.nestedToolCalls + ' 次嵌套实际调用，以及 ' + analysis.summary.runtimeFileChanges + ' 项文件变更证据。',
    sourceSummary: '会话编号：' + (analysis.source.sessionId ?? '源文件未内嵌会话编号') + '；已解析 ' + analysis.source.recordCount + ' 条记录；标准化事件 ' + analysis.coverage.normalisedEventCount + ' 条。',
    evidenceNote: '所有标题、标签、状态和说明均以中文呈现。工具名、路径、命令及原始消息属于取证证据，保留原始文本。',
  };
  return analysis;
}

function escapeMarkdown(value) {
  return safeString(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function table(rows, headers) {
  if (!rows.length) return '_暂无记录。_';
  const head = `| ${headers.join(' | ')} |`;
  const divide = `| ${headers.map(() => '---').join(' | ')} |`;
  return `${head}\n${divide}\n${rows.map((row) => `| ${row.map((cell) => escapeMarkdown(cell)).join(' | ')} |`).join('\n')}`;
}

function buildLegacyMarkdownReport(analysis) {
  const tools = analysis.toolCatalog.map((tool) => [tool.name, tool.calls, tool.completed, tool.succeeded, tool.failed, tool.pending, tool.averageDurationMs ?? '-']);
  const nestedTools = analysis.nestedToolCatalog.map((tool) => [tool.name, tool.calls, tool.wrapperTools.join(', ')]);
  const files = analysis.codeArtifacts.fileChanges.map((change) => [change.action, change.path, change.origin, change.eventIndex]);
  const commands = analysis.codeArtifacts.commands.slice(0, 80).map((command) => [command.category, command.tool, command.eventIndex, command.command]);
  const episodes = analysis.episodes.map((episode) => [episode.index, episode.intents.join(', '), episode.toolCount, episode.stages.join(' -> '), episode.request]);
  const triggers = analysis.triggerLogic.map((rule) => [rule.confidence, rule.trigger, rule.condition, rule.action, rule.evidence]);
  const capabilities = analysis.reusableCapabilities.map((candidate) => [candidate.name, candidate.confidence, candidate.score, candidate.trigger, candidate.workflow.join(' -> '), candidate.evidence.join('; ')]);
  return `# Codex Session Forensics Report\n\n## Evidence Scope\n\n- Session ID: \`${analysis.source.sessionId ?? 'not embedded in source'}\`\n- Source: \`${analysis.source.path}\`\n- Source SHA-256: \`${analysis.source.sha256}\`\n- Parsed records: ${analysis.source.recordCount}; malformed records skipped: ${analysis.source.invalidRecordCount}\n- Normalised event stream: \`${analysis.coverage.fullTimelineArtifact}\` (${analysis.coverage.normalisedEventCount} events)\n\nThe source transcript is retained separately. This report contains redacted, bounded excerpts rather than a raw transcript dump.\n\n## Coverage\n\n${table(Object.entries(analysis.coverage.eventTypeCounts).map(([type, count]) => [type, count]), ['Raw event type', 'Count'])}\n\n## Execution Summary\n\n- User-role messages: ${analysis.summary.userMessages}; actionable user requests: ${analysis.summary.actionableUserMessages}\n- Assistant messages: ${analysis.summary.assistantMessages}\n- Turn contexts: ${analysis.summary.turnContexts}\n- Wrapper tool calls: ${analysis.summary.toolCalls}; linked results: ${analysis.summary.linkedToolResults}\n- Unique wrapper tools: ${analysis.summary.uniqueWrapperTools}\n- Nested tool invocations observed inside wrappers: ${analysis.summary.nestedToolCalls}; unique nested tools: ${analysis.summary.uniqueNestedTools}\n- Commands extracted: ${analysis.summary.shellOrScriptCommands}\n- File changes/patch artifacts: ${analysis.summary.runtimeFileChanges}\n\n## Wrapper Tool Catalog\n\n${table(tools, ['Tool', 'Calls', 'Completed', 'Success', 'Failure', 'Unlinked', 'Avg ms'])}\n\n## Nested Tool Catalog\n\nThe Codex runtime can wrap actual tool calls inside an orchestration call such as \`exec\`. This table recovers those inner calls from the recorded code payload.\n\n${table(nestedTools, ['Nested tool', 'Observed calls', 'Wrapper tool'])}\n\n## Code And Artifact Evidence\n\n### File Changes\n\n${table(files, ['Action', 'Path', 'Origin', 'Event'])}\n\n### Commands\n\n${table(commands, ['Category', 'Tool', 'Event', 'Command excerpt'])}\n\n## Request To Execution Episodes\n\n${table(episodes, ['#', 'Intent labels', 'Tools', 'Observed stages', 'User request excerpt'])}\n\n## Trigger Logic\n\nDirect rules are explicit user-to-action traces. Inferred rules are limited to observed ordering; they do not claim hidden intent.\n\n${table(triggers, ['Confidence', 'Trigger', 'Condition', 'Action', 'Evidence'])}\n\n## Reusable Capability Candidates\n\n${table(capabilities, ['Capability', 'Confidence', 'Score', 'Activation', 'Workflow', 'Evidence'])}\n\n## Derived Skill Blueprint\n\n- Candidate name: \`${analysis.skillBlueprint.candidateName}\`\n- Description: ${analysis.skillBlueprint.description}\n- Required inputs: ${analysis.skillBlueprint.requiredInputs.join(', ')}\n- Observed tools: ${analysis.skillBlueprint.observedTools.join(', ') || 'none'}\n- Implementation files: ${analysis.skillBlueprint.implementationFiles.join(', ') || 'none'}\n- Workflow: ${analysis.skillBlueprint.workflow.join(' -> ')}\n\n### Activation Signals\n\n${table(analysis.skillBlueprint.activationSignals.map((signal) => [signal.episode, signal.intent.join(', '), signal.requestExcerpt]), ['Episode', 'Intent', 'Request excerpt'])}\n\n## Limits\n\n${analysis.limitations.map((item) => `- ${item}`).join('\n')}\n\n${analysis.warnings.length ? `## Parser Warnings\n\n${analysis.warnings.map((warning) => `- ${warning}`).join('\n')}\n` : ''}`;
}

function escapeHtml(value) {
  return safeString(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildLegacyHtmlReport(analysis) {
  const summary = Object.entries(analysis.summary).map(([name, value]) => `<article><strong>${escapeHtml(name)}</strong><span>${escapeHtml(value)}</span></article>`).join('');
  const toolRows = analysis.toolCatalog.map((tool) => `<tr><td>${escapeHtml(tool.name)}</td><td>${tool.calls}</td><td>${tool.succeeded}</td><td>${tool.failed}</td><td>${tool.pending}</td></tr>`).join('');
  const nestedToolRows = analysis.nestedToolCatalog.map((tool) => `<tr><td>${escapeHtml(tool.name)}</td><td>${tool.calls}</td><td>${escapeHtml(tool.wrapperTools.join(', '))}</td></tr>`).join('');
  const fileRows = analysis.codeArtifacts.fileChanges.map((change) => `<tr><td>${escapeHtml(change.action)}</td><td><code>${escapeHtml(change.path)}</code></td><td>${escapeHtml(change.origin)}</td><td>${escapeHtml(change.eventIndex)}</td></tr>`).join('');
  const episodeRows = analysis.episodes.map((episode) => `<tr><td>${episode.index}</td><td>${escapeHtml(episode.intents.join(', '))}</td><td>${episode.toolCount}</td><td>${escapeHtml(episode.stages.join(' -> '))}</td><td>${escapeHtml(episode.request)}</td></tr>`).join('');
  const triggerRows = analysis.triggerLogic.map((rule) => `<tr><td>${escapeHtml(rule.confidence)}</td><td>${escapeHtml(rule.trigger)}</td><td>${escapeHtml(rule.action)}</td><td>${escapeHtml(rule.evidence)}</td></tr>`).join('');
  const capabilityRows = analysis.reusableCapabilities.map((candidate) => `<tr><td>${escapeHtml(candidate.name)}</td><td>${escapeHtml(candidate.confidence)}</td><td>${candidate.score}</td><td>${escapeHtml(candidate.workflow.join(' -> '))}</td></tr>`).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Session Forensics</title><style>body{margin:0;background:#f7faf8;color:#17211e;font:14px/1.5 Inter,Segoe UI,Arial,sans-serif}main{max-width:1200px;margin:auto;padding:32px}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:34px 0 12px;border-bottom:1px solid #cbd5d0;padding-bottom:8px}h3{font-size:15px;margin:20px 0 8px}.muted{color:#53625b}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.summary article{border:1px solid #cbd5d0;background:#fff;padding:12px;border-radius:6px}.summary strong,.summary span{display:block}.summary strong{text-transform:uppercase;font-size:11px;letter-spacing:0}.summary span{font-size:21px;margin-top:4px}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:9px;border:1px solid #d7e0db;vertical-align:top;text-align:left;word-break:break-word}th{background:#e7f0eb}code{background:#e7f0eb;padding:2px 4px}ul{padding-left:20px}@media(max-width:700px){main{padding:18px}table{font-size:12px}}</style></head><body><main><h1>Codex Session Forensics</h1><p class="muted">Session <code>${escapeHtml(analysis.source.sessionId ?? 'unknown')}</code> | source SHA-256 <code>${escapeHtml(analysis.source.sha256)}</code></p><section class="summary">${summary}</section><h2>Wrapper Tool Catalog</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Failure</th><th>Unlinked</th></tr></thead><tbody>${toolRows || '<tr><td colspan="5">No tools recorded.</td></tr>'}</tbody></table><h2>Nested Tool Catalog</h2><p class="muted">Nested calls are recovered from recorded wrapper payloads such as exec.</p><table><thead><tr><th>Nested tool</th><th>Observed calls</th><th>Wrapper</th></tr></thead><tbody>${nestedToolRows || '<tr><td colspan="3">No nested tools recorded.</td></tr>'}</tbody></table><h2>Code And Artifact Evidence</h2><table><thead><tr><th>Action</th><th>Path</th><th>Origin</th><th>Event</th></tr></thead><tbody>${fileRows || '<tr><td colspan="4">No file changes recorded.</td></tr>'}</tbody></table><h2>Request To Execution Episodes</h2><table><thead><tr><th>#</th><th>Intent</th><th>Tools</th><th>Stages</th><th>Request excerpt</th></tr></thead><tbody>${episodeRows || '<tr><td colspan="5">No actionable requests recorded.</td></tr>'}</tbody></table><h2>Trigger Logic</h2><table><thead><tr><th>Confidence</th><th>Trigger</th><th>Action</th><th>Evidence</th></tr></thead><tbody>${triggerRows || '<tr><td colspan="4">No trigger rules recorded.</td></tr>'}</tbody></table><h2>Reusable Capability Candidates</h2><table><thead><tr><th>Capability</th><th>Confidence</th><th>Score</th><th>Workflow</th></tr></thead><tbody>${capabilityRows || '<tr><td colspan="4">No candidates recorded.</td></tr>'}</tbody></table><h2>Derived Skill Blueprint</h2><p><strong>${escapeHtml(analysis.skillBlueprint.candidateName)}</strong>: ${escapeHtml(analysis.skillBlueprint.description)}</p><p class="muted">The complete normalised event stream is in <code>${escapeHtml(analysis.coverage.fullTimelineArtifact)}</code>. This rendered report deliberately excludes raw tool outputs and internal reasoning.</p></main></body></html>`;
}

function markdownQuote(value, empty = '暂无内容。') {
  const text = safeString(value).trim();
  if (!text) return '> ' + empty;
  return text.split(/\r?\n/).map((line) => '> ' + escapeMarkdown(line)).join('\n');
}

function markdownList(values, empty = '暂无记录。') {
  return values.length ? values.map((value) => '- ' + escapeMarkdown(value)).join('\n') : '- ' + empty;
}

function displayTools(values = []) {
  return values.length ? values.map((value) => safeString(value)).join('、') : '暂无工具';
}

function displayStages(values = []) {
  return values.length ? displayStageList(values).join(' → ') : '暂无阶段';
}

function htmlMultiline(value, empty = '暂无内容。') {
  const text = safeString(value).trim();
  return text ? escapeHtml(text).replace(/\r?\n/g, '<br>') : escapeHtml(empty);
}

function htmlList(values, empty = '暂无记录。') {
  if (!values.length) return '<p class="muted">' + escapeHtml(empty) + '</p>';
  return '<ul>' + values.map((value) => '<li>' + escapeHtml(value) + '</li>').join('') + '</ul>';
}

function htmlCodeList(values, empty = '暂无工具') {
  return values.length
    ? values.map((value) => '<code>' + escapeHtml(value) + '</code>').join(' ')
    : escapeHtml(empty);
}

function htmlTable(headers, rows, empty = '暂无记录。', codeColumns = []) {
  const head = '<thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') + '</tr></thead>';
  const body = rows.length
    ? '<tbody>' + rows.map((cells) => '<tr>' + cells.map((cell, index) => '<td>' + (codeColumns.includes(index) ? '<code>' + escapeHtml(cell) + '</code>' : htmlMultiline(cell)) + '</td>').join('') + '</tr>').join('') + '</tbody>'
    : '<tbody><tr><td colspan="' + headers.length + '">' + escapeHtml(empty) + '</td></tr></tbody>';
  return '<div class="table-wrap"><table>' + head + body + '</table></div>';
}

function buildChineseMarkdownReport(analysis) {
  const summaryRows = Object.entries(analysis.summary).map(([name, value]) => [displaySummaryLabel(name), value]);
  const coverageRows = Object.entries(analysis.coverage.eventTypeCounts).map(([type, count]) => [type, count]);
  const tools = analysis.toolCatalog.map((tool) => [tool.name, tool.calls, tool.completed, tool.succeeded, tool.failed, tool.pending, tool.averageDurationMs ?? '暂无']);
  const nestedTools = analysis.nestedToolCatalog.map((tool) => [tool.name, tool.calls, tool.wrapperTools.join('、')]);
  const files = analysis.codeArtifacts.fileChanges.map((change) => [displayAction(change.action), change.path, displayOrigin(change.origin), change.eventIndex]);
  const commands = analysis.codeArtifacts.commands.slice(0, 80).map((command) => [displayCommandCategory(command.category), command.tool, command.eventIndex, command.command]);
  const triggers = analysis.triggerLogic.map((rule) => [displayLabel(rule.confidence, rule.confidence), rule.trigger, rule.condition, rule.action, rule.evidence]);
  const capabilities = analysis.reusableCapabilities.map((candidate) => [candidate.name, displayLabel(candidate.confidence, candidate.confidence), candidate.score, candidate.trigger, candidate.workflow.join(' → '), displayEvidenceList(candidate.evidence).join('；')]);
  const episodeSections = analysis.episodes.length
    ? analysis.episodes.map((episode) => [
      '### ' + episode.title,
      '',
      '**用户请求内容**',
      '',
      markdownQuote(episode.requestContent),
      '',
      '**助手回应内容**',
      '',
      markdownQuote(episode.assistantContent),
      '',
      '**执行结果**',
      '',
      episode.outcomeSummary,
      '',
      '**执行阶段与工具**',
      '',
      '阶段：' + displayStages(episode.stages),
      '',
      '工具：' + displayTools(episode.toolNames),
      '',
      '工具调用数：' + episode.toolCount + '；已完成：' + episode.completedToolCount + '；成功：' + episode.succeededToolCount + '；非成功：' + episode.failedToolCount + '；结果未关联：' + (episode.toolCount - episode.completedToolCount),
      '',
      '取证事件序号：' + episode.triggerEventIndex,
    ].join('\n')).join('\n\n')
    : '暂无可执行的用户请求阶段。';
  const blueprint = analysis.skillBlueprint;
  const activationRows = blueprint.activationSignals.map((signal) => [signal.episode, displayIntentList(signal.intent).join('、'), signal.requestExcerpt]);
  const warningSection = analysis.warnings.length
    ? '\n## 解析警告\n\n以下警告保留解析器原文，便于复核：\n\n' + markdownList(analysis.warnings)
    : '';
  return [
    '# ' + (analysis.presentation?.title || '会话全量取证报告'),
    '',
    '> ' + (analysis.presentation?.evidenceNote || '本报告的标题、表头、状态和说明使用中文；技术标识及原始证据保留原貌。'),
    '',
    '## 报告标题与内容摘要',
    '',
    analysis.presentation?.summary || '暂无摘要。',
    '',
    analysis.presentation?.sourceSummary || '暂无来源摘要。',
    '',
    '## 证据范围',
    '',
    '- 会话编号：' + (analysis.source.sessionId || '源文件未内嵌会话编号'),
    '- 源文件：' + analysis.source.path,
    '- 源文件 SHA-256：' + analysis.source.sha256,
    '- 解析记录：' + analysis.source.recordCount + ' 条；格式错误记录：' + analysis.source.invalidRecordCount + ' 条',
    '- 标准化事件流：' + analysis.coverage.fullTimelineArtifact + '，共 ' + analysis.coverage.normalisedEventCount + ' 条',
    '',
    '## 解析覆盖范围',
    '',
    table(coverageRows, ['原始事件类型', '数量']),
    '',
    '## 执行摘要',
    '',
    table(summaryRows, ['指标', '数值']),
    '',
    '## 外层编排工具目录',
    '',
    table(tools, ['工具名称', '调用次数', '已完成', '成功', '失败', '未关联结果', '平均耗时（毫秒）']),
    '',
    '## 嵌套实际调用工具目录',
    '',
    '运行时可能把实际工具调用包在外层编排调用中；以下内容从已记录的代码负载中恢复。',
    '',
    table(nestedTools, ['嵌套工具', '观察到的调用次数', '外层工具']),
    '',
    '## 代码与产物证据',
    '',
    '### 文件变更',
    '',
    table(files, ['操作', '路径', '来源', '事件序号']),
    '',
    '### 命令与脚本',
    '',
    '以下展示前 80 条命令证据；完整标准化事件流见 normalized-events.ndjson。',
    '',
    table(commands, ['命令类别', '工具', '事件序号', '命令摘录']),
    '',
    '## 请求标题、内容与执行过程',
    '',
    episodeSections,
    '',
    '## 触发逻辑',
    '',
    '直接证据来自可见用户指令与对应动作；时序推断只描述观察到的事件顺序，不代替不可见推理。',
    '',
    table(triggers, ['证据级别', '触发条件', '成立条件', '执行动作', '证据']),
    '',
    '## 可复用能力候选',
    '',
    table(capabilities, ['能力名称', '证据强度', '评分', '激活条件', '工作流', '证据']),
    '',
    '## 推导出的技能蓝图',
    '',
    '- 技术标识：' + blueprint.candidateId,
    '- 名称：' + blueprint.candidateName,
    '- 描述：' + blueprint.description,
    '- 必需输入：' + blueprint.requiredInputs.join('、'),
    '- 观测到的工具：' + (blueprint.observedTools.join('、') || '暂无'),
    '- 实现文件：' + (blueprint.implementationFiles.join('、') || '暂无'),
    '- 工作流：' + blueprint.workflow.join(' → '),
    '',
    '### 激活信号',
    '',
    table(activationRows, ['阶段', '意图', '请求摘录']),
    '',
    '### 约束与验收要求',
    '',
    markdownList(blueprint.guardrails),
    '',
    '## 边界说明',
    '',
    markdownList(analysis.limitations),
    warningSection,
  ].join('\n');
}

function buildChineseHtmlReport(analysis) {
  const summaryRows = Object.entries(analysis.summary).map(([name, value]) => [displaySummaryLabel(name), value]);
  const coverageRows = Object.entries(analysis.coverage.eventTypeCounts).map(([type, count]) => [type, count]);
  const toolRows = analysis.toolCatalog.map((tool) => [tool.name, tool.calls, tool.completed, tool.succeeded, tool.failed, tool.pending, tool.averageDurationMs ?? '暂无']);
  const nestedRows = analysis.nestedToolCatalog.map((tool) => [tool.name, tool.calls, tool.wrapperTools.join('、')]);
  const fileRows = analysis.codeArtifacts.fileChanges.map((change) => [displayAction(change.action), change.path, displayOrigin(change.origin), change.eventIndex]);
  const commandRows = analysis.codeArtifacts.commands.slice(0, 80).map((command) => [displayCommandCategory(command.category), command.tool, command.eventIndex, command.command]);
  const triggerRows = analysis.triggerLogic.map((rule) => [displayLabel(rule.confidence, rule.confidence), rule.trigger, rule.condition, rule.action, rule.evidence]);
  const capabilityRows = analysis.reusableCapabilities.map((candidate) => [candidate.name, displayLabel(candidate.confidence, candidate.confidence), candidate.score, candidate.trigger, candidate.workflow.join(' → '), displayEvidenceList(candidate.evidence).join('；')]);
  const episodeCards = analysis.episodes.length
    ? analysis.episodes.map((episode) => '<article class="episode-card"><div class="episode-top"><span class="eyebrow">P' + episode.index + '</span><span>' + episode.toolCount + ' 次工具调用</span></div><h3>' + escapeHtml(episode.title) + '</h3><div class="chip-row">' + [...(episode.intentLabels || []), ...(episode.stageLabels || [])].map((label) => '<span class="badge">' + escapeHtml(label) + '</span>').join('') + '</div><section><h4>用户请求内容</h4><p class="evidence">' + htmlMultiline(episode.requestContent) + '</p></section><section><h4>助手回应内容</h4><p class="evidence">' + htmlMultiline(episode.assistantContent) + '</p></section><section><h4>执行结果</h4><p>' + escapeHtml(episode.outcomeSummary) + '</p></section><section class="episode-meta"><strong>执行阶段：</strong>' + escapeHtml(displayStages(episode.stages)) + '<br><strong>使用工具：</strong>' + htmlCodeList(episode.toolNames) + '<br><strong>取证事件序号：</strong>' + escapeHtml(episode.triggerEventIndex) + '</section></article>').join('')
    : '<p class="muted">暂无可执行的用户请求阶段。</p>';
  const blueprint = analysis.skillBlueprint;
  const activationRows = blueprint.activationSignals.map((signal) => [signal.episode, displayIntentList(signal.intent).join('、'), signal.requestExcerpt]);
  const warningHtml = analysis.warnings.length ? '<h2>解析警告</h2><p class="muted">以下警告保留解析器原文，便于复核。</p>' + htmlList(analysis.warnings) : '';
  const style = '<style>body{margin:0;background:#f5f8f6;color:#17211e;font:14px/1.6 Inter,"Segoe UI","Microsoft YaHei",Arial,sans-serif}main{max-width:1280px;margin:auto;padding:32px}h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:34px 0 12px;border-bottom:1px solid #cbd5d0;padding-bottom:8px}h3{font-size:17px;margin:12px 0 8px}h4{font-size:14px;margin:14px 0 5px}.muted{color:#53625b}.lead{font-size:16px;max-width:900px}.meta{padding:14px;background:#edf4f1;border-left:3px solid #096b60}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.summary article{border:1px solid #cbd5d0;background:#fff;padding:12px;border-radius:6px}.summary strong,.summary span{display:block}.summary strong{font-size:12px;color:#53625b}.summary span{font-size:21px;margin-top:4px;color:#096b60}.table-wrap{overflow-x:auto;border:1px solid #d7e0db;border-radius:5px}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:9px;border:1px solid #d7e0db;vertical-align:top;text-align:left;word-break:break-word}th{background:#e7f0eb;color:#40534b}code{background:#e7f0eb;padding:2px 4px;overflow-wrap:anywhere}.episode-list{display:grid;gap:14px}.episode-card{padding:16px;border:1px solid #cbd5d0;border-left:4px solid #096b60;background:#fff;border-radius:5px}.episode-card section{border-top:1px solid #e4ebe7;margin-top:12px;padding-top:4px}.episode-top{display:flex;justify-content:space-between;gap:12px;color:#53625b;font-size:12px}.evidence{white-space:pre-wrap;background:#f7faf8;padding:10px;border-radius:4px;margin:0}.chip-row{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.badge{display:inline-block;padding:2px 7px;border:1px solid #bad8ce;border-radius:3px;background:#e3f1ed;color:#096b60;font-size:12px}.episode-meta{color:#53625b;overflow-wrap:anywhere}ul{padding-left:22px}@media(max-width:700px){main{padding:18px}h1{font-size:24px}.episode-top{display:block}.episode-top span{display:block;margin-top:4px}table{font-size:12px}}</style>';
  const summaryHtml = summaryRows.map((item) => '<article><strong>' + escapeHtml(item[0]) + '</strong><span>' + escapeHtml(item[1]) + '</span></article>').join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(analysis.presentation?.title || '会话全量取证报告') + '</title>' + style + '</head><body><main><h1>' + escapeHtml(analysis.presentation?.title || '会话全量取证报告') + '</h1><p class="lead">' + escapeHtml(analysis.presentation?.summary || '暂无摘要。') + '</p><p class="meta">' + escapeHtml(analysis.presentation?.evidenceNote || '') + '<br>会话编号：<code>' + escapeHtml(analysis.source.sessionId || '源文件未内嵌会话编号') + '</code><br>源文件：<code>' + escapeHtml(analysis.source.path) + '</code><br>源文件 SHA-256：<code>' + escapeHtml(analysis.source.sha256) + '</code></p><section class="summary">' + summaryHtml + '</section><h2>证据范围</h2><p>已解析 ' + escapeHtml(analysis.source.recordCount) + ' 条记录，格式错误记录 ' + escapeHtml(analysis.source.invalidRecordCount) + ' 条；标准化事件流共 ' + escapeHtml(analysis.coverage.normalisedEventCount) + ' 条。</p><h2>解析覆盖范围</h2>' + htmlTable(['原始事件类型','数量'], coverageRows) + '<h2>外层编排工具目录</h2>' + htmlTable(['工具名称','调用次数','已完成','成功','失败','未关联结果','平均耗时（毫秒）'], toolRows, '暂无工具调用记录。', [0]) + '<h2>嵌套实际调用工具目录</h2><p class="muted">以下内容从外层编排负载中的已记录代码恢复，工具标识保留原貌。</p>' + htmlTable(['嵌套工具','观察到的调用次数','外层工具'], nestedRows, '暂无嵌套工具记录。', [0,2]) + '<h2>代码与产物证据</h2><h3>文件变更</h3>' + htmlTable(['操作','路径','来源','事件序号'], fileRows, '暂无文件变更记录。', [1]) + '<h3>命令与脚本</h3><p class="muted">以下展示前 80 条命令证据；完整内容见 normalized-events.ndjson。</p>' + htmlTable(['命令类别','工具','事件序号','命令摘录'], commandRows, '暂无命令证据。', [1,3]) + '<h2>请求标题、内容与执行过程</h2><div class="episode-list">' + episodeCards + '</div><h2>触发逻辑</h2><p class="muted">直接证据来自可见用户指令；时序推断只描述观察到的顺序，不代替不可见推理。</p>' + htmlTable(['证据级别','触发条件','成立条件','执行动作','证据'], triggerRows, '暂无触发规则。') + '<h2>可复用能力候选</h2>' + htmlTable(['能力名称','证据强度','评分','激活条件','工作流','证据'], capabilityRows, '暂无能力候选。') + '<h2>推导出的技能蓝图</h2><h3>' + escapeHtml(blueprint.candidateName) + '</h3><p>' + escapeHtml(blueprint.description) + '</p><p><strong>技术标识：</strong><code>' + escapeHtml(blueprint.candidateId) + '</code></p><h4>必需输入</h4>' + htmlList(blueprint.requiredInputs) + '<h4>工作流</h4>' + htmlList(blueprint.workflow) + '<h4>观测到的工具</h4><p>' + htmlCodeList(blueprint.observedTools) + '</p><h4>实现文件</h4>' + htmlList(blueprint.implementationFiles) + '<h4>激活信号</h4>' + htmlTable(['阶段','意图','请求摘录'], activationRows, '暂无激活信号。') + '<h4>约束与验收要求</h4>' + htmlList(blueprint.guardrails) + '<h2>边界说明</h2>' + htmlList(analysis.limitations) + warningHtml + '</main></body></html>';
}

export function buildMarkdownReport(analysis) {
  return buildChineseMarkdownReport(analysis);
}

export function buildHtmlReport(analysis) {
  return buildChineseHtmlReport(analysis);
}

export async function writeAnalysisArtifacts(parsed, analysis, outputDirectory = path.join(DEFAULT_OUTPUT_ROOT, parsed.sessionId ?? ('session-' + Date.now()))) {
  const outputDir = path.resolve(outputDirectory);
  await fsp.mkdir(outputDir, { recursive: true });
  const irBundle = buildIRBundle({ parsed, analysis });
  const compilerResult = compileConversationTargets({ parsed, analysis, bundle: irBundle });
  const paths = {
    analysis: path.join(outputDir, 'analysis.json'),
    markdown: path.join(outputDir, 'report.md'),
    html: path.join(outputDir, 'report.html'),
    timeline: path.join(outputDir, 'normalized-events.ndjson'),
    traceIR: path.join(outputDir, 'trace-ir.json'),
    capabilityIR: path.join(outputDir, 'capability-ir.json'),
    compilerResult: path.join(outputDir, 'compiler-result.json'),
    manifest: path.join(outputDir, 'manifest.json'),
  };
  await fsp.writeFile(paths.analysis, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  await fsp.writeFile(paths.markdown, buildMarkdownReport(analysis), 'utf8');
  await fsp.writeFile(paths.html, buildHtmlReport(analysis), 'utf8');
  await fsp.writeFile(paths.traceIR, `${JSON.stringify(irBundle.trace, null, 2)}\n`, 'utf8');
  await fsp.writeFile(paths.capabilityIR, `${JSON.stringify(irBundle, null, 2)}\n`, 'utf8');
  await fsp.writeFile(paths.compilerResult, `${JSON.stringify(compilerResult, null, 2)}\n`, 'utf8');
  const timelineStream = fs.createWriteStream(paths.timeline, { encoding: 'utf8' });
  for (const event of parsed.timeline) timelineStream.write(`${JSON.stringify(event)}\n`);
  await new Promise((resolve, reject) => timelineStream.end((error) => error ? reject(error) : resolve()));
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: analysis.source,
    ir: irBundle.summary,
    artifacts: {},
  };
  for (const [name, artifactPath] of Object.entries(paths)) {
    if (name === 'manifest') continue;
    const artifactStat = await fsp.stat(artifactPath);
    manifest.artifacts[name] = { path: artifactPath, bytes: artifactStat.size, sha256: await hashFile(artifactPath) };
  }
  await fsp.writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outputDir, paths: { ...paths, manifest: paths.manifest }, manifest };
}

export async function analyseSessionSource({ threadId, sourcePath, roots = [], outputDir, includeEvidence = false, redact = true } = {}) {
  const source = await resolveSessionSource({ threadId, sourcePath, roots });
  const parsed = await parseCodexSessionFile(source.sourcePath, { redact });
  if (!parsed.sessionId && source.sessionId) parsed.sessionId = source.sessionId;
  const analysis = analyseParsedSession(parsed, { includeEvidence });
  const artifacts = await writeAnalysisArtifacts(parsed, analysis, outputDir ?? path.join(DEFAULT_OUTPUT_ROOT, parsed.sessionId ?? `session-${Date.now()}`));
  return { parsed, analysis, artifacts };
}
