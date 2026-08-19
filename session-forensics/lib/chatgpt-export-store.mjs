import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

function text(value, limit = 2_000_000) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, limit);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeName(value) {
  return text(value, 400).replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function decodeZipName(buffer, flags) {
  if (flags & 0x800) return buffer.toString('utf8');
  return buffer.toString('utf8');
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (readUInt32(buffer, offset) === ZIP_END) return offset;
  }
  return -1;
}

function readZipEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error('导入文件不是有效的 ZIP 数据。');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = readUInt32(buffer, end + 12);
  const directoryOffset = readUInt32(buffer, end + 16);
  if (count > 20_000 || directorySize > buffer.length || directoryOffset > buffer.length) throw new Error('ZIP 目录超出允许范围。');
  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
    if (readUInt32(buffer, offset) !== ZIP_CENTRAL) throw new Error('ZIP 目录结构不完整。');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = readUInt32(buffer, offset + 42);
    const nameStart = offset + 46;
    const name = decodeZipName(buffer.subarray(nameStart, nameStart + nameLength), flags);
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(buffer, entry) {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > buffer.length) throw new Error(`ZIP 条目过大：${entry.name}`);
  const offset = entry.localOffset;
  if (offset < 0 || offset + 30 > buffer.length || readUInt32(buffer, offset) !== ZIP_LOCAL) throw new Error(`ZIP 条目位置无效：${entry.name}`);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new Error(`ZIP 条目内容不完整：${entry.name}`);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`暂不支持 ZIP 压缩方式 ${entry.method}：${entry.name}`);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content.parts)) return content.parts.map(messageText).filter(Boolean).join('\n');
  if (typeof content.text === 'string') return content.text;
  if (typeof content.result === 'string') return content.result;
  return '';
}

function roleOf(message) {
  const role = text(message?.author?.role || message?.role, 30).toLowerCase();
  return ['user', 'assistant', 'system', 'tool'].includes(role) ? role : 'unknown';
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function conversationIdOf(value) {
  return text(value?.conversation_id || value?.conversationId || value?.id, 300).trim();
}

function flattenMapping(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  const nodes = Object.entries(mapping).map(([id, node], index) => ({
    id,
    index,
    node,
    message: node?.message,
    createdAt: timestampOf(node?.message?.create_time || node?.create_time),
  })).filter((item) => item.message);
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const ordered = [];
  const seen = new Set();
  let current = text(conversation?.current_node, 300);
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    ordered.unshift(byId.get(current));
    current = text(byId.get(current)?.node?.parent, 300);
  }
  for (const item of nodes.sort((left, right) => (Date.parse(left.createdAt || 0) || left.index) - (Date.parse(right.createdAt || 0) || right.index))) {
    if (!seen.has(item.id)) ordered.push(item);
  }
  return ordered.map((item, index) => ({
    index,
    role: roleOf(item.message),
    content: text(messageText(item.message?.content), 200_000).trim(),
    messageId: item.id,
    createdAt: item.createdAt,
    parentId: text(item.node?.parent, 300) || null,
  })).filter((item) => item.content || item.role !== 'unknown');
}

function normalizeConversation(value, sourceFile) {
  const conversationId = conversationIdOf(value);
  const messages = flattenMapping(value);
  const firstUser = messages.find((item) => item.role === 'user' && item.content)?.content || '';
  const title = text(value?.title, 500).replace(/[\r\n]+/g, ' ').trim() || firstUser.slice(0, 120) || `未命名 ChatGPT 会话 ${conversationId || '未知编号'}`;
  const createdAt = timestampOf(value?.create_time || value?.created_at);
  const updatedAt = timestampOf(value?.update_time || value?.updated_at || value?.create_time || value?.created_at) || createdAt;
  const stableId = conversationId || sha256(JSON.stringify({ title, createdAt, messages })).slice(0, 32);
  const url = value?.url || `https://chatgpt.com/c/${stableId}`;
  const record = {
    conversationId: stableId,
    title,
    createdAt,
    updatedAt,
    url: text(url, 1_000),
    messages,
    messageCount: messages.length,
    sourceType: 'chatgpt-export',
    sourceFile: text(sourceFile, 500),
    completeness: 'complete-export',
  };
  record.contentHash = sha256(JSON.stringify(record.messages));
  return record;
}

function extractConversationObjects(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.conversations)) return value.conversations;
  if (value && typeof value === 'object' && (value.mapping || value.conversation_id || value.conversationId)) return [value];
  return [];
}

async function ensureStore(root) {
  await fsp.mkdir(root, { recursive: true });
}

async function readJsonLines(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonLines(filePath, rows) {
  await fsp.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export async function importChatGPTExport({ buffer, root, originalName = 'chatgpt-export.zip' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('请选择有效的 ChatGPT ZIP 导出文件。');
  await ensureStore(root);
  const entries = readZipEntries(buffer).filter((entry) => !entry.name.endsWith('/'));
  const jsonEntries = entries.filter((entry) => /(?:^|[\\/])(?:conversations|\d+)[^\\/]*\.json$/i.test(entry.name));
  if (!jsonEntries.length) throw new Error('ZIP 中没有找到 conversations.json 或拆分会话 JSON 文件。');
  const runId = `chatgpt-import-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const runRoot = path.join(root, 'imports', runId);
  await fsp.mkdir(runRoot, { recursive: true });
  const records = [];
  const inputFiles = [];
  for (const entry of jsonEntries) {
    const raw = extractZipEntry(buffer, entry);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { continue; }
    inputFiles.push({ name: entry.name, bytes: raw.length, sha256: sha256(raw) });
    for (const object of extractConversationObjects(parsed)) {
      const normalized = normalizeConversation(object, entry.name);
      records.push(normalized);
    }
  }
  const deduped = new Map();
  for (const record of records) deduped.set(record.conversationId, record);
  const uniqueRecords = [...deduped.values()].sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  await writeJsonLines(path.join(runRoot, 'conversations.ndjson'), uniqueRecords);
  const indexPath = path.join(root, 'chatgpt-conversations.ndjson');
  const existing = await readJsonLines(indexPath);
  const merged = new Map(existing.map((item) => [item.conversationId, item]));
  for (const record of uniqueRecords) {
    const previous = merged.get(record.conversationId);
    const versions = Array.isArray(previous?.versions) ? previous.versions : previous ? [{ sourceType: previous.sourceType, contentHash: previous.contentHash, updatedAt: previous.updatedAt }] : [];
    if (previous && previous.contentHash !== record.contentHash) versions.push({ sourceType: record.sourceType, contentHash: record.contentHash, updatedAt: record.updatedAt, importedAt: new Date().toISOString() });
    merged.set(record.conversationId, { ...previous, ...record, versions: versions.slice(-20), importedAt: new Date().toISOString() });
  }
  await writeJsonLines(indexPath, [...merged.values()]);
  const manifest = {
    schemaVersion: 'chatgpt-export-v1',
    runId,
    originalName: safeName(originalName),
    importedAt: new Date().toISOString(),
    bytes: buffer.length,
    inputFiles,
    recordCount: uniqueRecords.length,
    duplicateCount: records.length - uniqueRecords.length,
    indexPath,
    sourcePath: path.join(runRoot, 'conversations.ndjson'),
  };
  await fsp.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ...manifest, runRoot, records: uniqueRecords };
}

export async function listChatGPTExportRecords(root) {
  return readJsonLines(path.join(root, 'chatgpt-conversations.ndjson'));
}

export function reconcileChatGPTRecords(exportRecords = [], edgeRecords = []) {
  const result = new Map();
  for (const item of exportRecords) {
    const key = text(item.conversationId || item.url, 500) || sha256(JSON.stringify(item));
    result.set(key, {
      ...item,
      sourceTypes: ['chatgpt-export'],
      status: 'export-only',
      completeness: item.completeness || 'complete-export',
      evidence: [{ type: 'official-export', sourceFile: item.sourceFile, contentHash: item.contentHash }],
    });
  }
  for (const item of edgeRecords) {
    const id = text(item.conversationId, 300) || (() => { try { return new URL(item.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } })();
    const key = id || text(item.url, 500) || sha256(JSON.stringify(item));
    const previous = result.get(key);
    if (!previous) {
      const edgeCompleteness = item.completeness || (item.messages?.length ? 'complete-edge' : 'index-only');
      result.set(key, { ...item, sourceTypes: ['chatgpt-edge'], status: item.messages?.length ? 'edge-only' : 'incomplete', completeness: edgeCompleteness, evidence: [{ type: 'edge-capture', url: item.url, capturedAt: item.capturedAt }] });
      continue;
    }
    const same = !item.contentHash || !previous.contentHash || item.contentHash === previous.contentHash;
    result.set(key, {
      ...previous,
      ...(Date.parse(item.updatedAt || item.capturedAt || 0) >= Date.parse(previous.updatedAt || 0) ? item : {}),
      sourceTypes: ['chatgpt-export', 'chatgpt-edge'],
      status: same ? 'matched' : 'conflict',
      completeness: item.messages?.length ? (String(item.completeness || '').includes('lossless') ? 'complete-both-lossless' : 'complete-both') : previous.completeness,
      evidence: [...(previous.evidence || []), { type: 'edge-capture', url: item.url, capturedAt: item.capturedAt, contentHash: item.contentHash || null }],
    });
  }
  const records = [...result.values()].sort((left, right) => Date.parse(right.updatedAt || right.capturedAt || 0) - Date.parse(left.updatedAt || left.capturedAt || 0));
  const counts = records.reduce((acc, item) => { acc.total += 1; acc[item.status] = (acc[item.status] || 0) + 1; if (String(item.completeness || '').startsWith('complete')) acc.complete += 1; return acc; }, { total: 0, complete: 0 });
  return { records, counts: { ...counts, coverage: counts.total ? Number((counts.complete / counts.total * 100).toFixed(1)) : 0 } };
}

export async function writeChatGPTReconciliation(root, reconciliation) {
  await ensureStore(root);
  await writeJsonLines(path.join(root, 'chatgpt-reconciliation.ndjson'), reconciliation.records || []);
  await fsp.writeFile(path.join(root, 'chatgpt-coverage.json'), JSON.stringify({ schemaVersion: 'chatgpt-coverage-v1', generatedAt: new Date().toISOString(), ...reconciliation.counts }, null, 2), 'utf8');
  return reconciliation;
}
