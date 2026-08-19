import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseCodexSessionFile } from './session-forensics.mjs';

const SCHEMA_VERSION = 'codex-session-sync-v1';

function asText(value, limit = 500) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function sourceKeyOf(source) {
  return asText(source?.sourceKey || source?.sessionId || source?.sourcePath, 1000);
}

function sourceEntry(source, previous = null) {
  const sourcePath = path.resolve(asText(source?.sourcePath || source?.path));
  const bytes = Number(source?.bytes || 0);
  const modifiedAt = asText(source?.modifiedAt, 80) || null;
  const fingerprint = crypto.createHash('sha256').update(`${sourcePath}\n${bytes}\n${modifiedAt}`).digest('hex');
  const unchanged = previous && previous.fingerprint === fingerprint;
  return {
    sourceKey: sourceKeyOf(source),
    sessionId: asText(source?.sessionId, 200) || null,
    title: asText(source?.title, 500) || '未命名 Codex 会话',
    titleSource: asText(source?.titleSource, 120) || null,
    sourcePath,
    bytes,
    modifiedAt,
    recordCount: Number(source?.recordCount || 0) || null,
    workspacePaths: Array.isArray(source?.workspacePaths) ? source.workspacePaths.map((item) => path.resolve(String(item))).slice(0, 50) : [],
    duplicatePaths: Array.isArray(source?.duplicatePaths) ? source.duplicatePaths.map((item) => path.resolve(String(item))).slice(0, 20) : [],
    fingerprint,
    state: unchanged ? (previous.state || 'unchanged') : previous ? 'changed' : 'new',
    firstSeenAt: previous?.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastReadAt: previous?.lastReadAt || null,
    lastReadSha256: previous?.lastReadSha256 || null,
    lastReadRecordCount: previous?.lastReadRecordCount || null,
    readError: null,
  };
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fsp.readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(temporary, filePath);
}

function indexPath(root) { return path.join(root, 'codex-session-index.json'); }

export async function readCodexSessionIndex(root) {
  const filePath = indexPath(root);
  const index = await readJson(filePath, { schemaVersion: SCHEMA_VERSION, entries: [], statistics: null });
  return { ...index, filePath };
}

export async function syncCodexSessionIndex({ root, sources = [], roots = [], force = false } = {}) {
  const previous = await readCodexSessionIndex(root);
  const oldEntries = new Map((previous.entries || []).map((entry) => [sourceKeyOf(entry), entry]));
  const currentEntries = sources.map((source) => sourceEntry(source, oldEntries.get(sourceKeyOf(source))));
  const currentKeys = new Set(currentEntries.map((entry) => entry.sourceKey));
  const removed = (previous.entries || []).filter((entry) => !currentKeys.has(sourceKeyOf(entry))).map((entry) => ({ ...entry, state: 'removed', lastSeenAt: new Date().toISOString() }));
  const entries = [...currentEntries, ...removed].sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));
  const counts = entries.reduce((acc, entry) => {
    acc.total += 1;
    acc[entry.state] = (acc[entry.state] || 0) + 1;
    if (entry.state !== 'removed') acc.current += 1;
    return acc;
  }, { total: 0, current: 0, new: 0, changed: 0, unchanged: 0, removed: 0 });
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    roots: roots.map((item) => path.resolve(String(item))),
    complete: true,
    forced: Boolean(force),
    entries,
    statistics: counts,
  };
  await writeJsonAtomic(indexPath(root), index);
  return { ...index, filePath: indexPath(root), changes: { new: counts.new, changed: counts.changed, removed: counts.removed, unchanged: counts.unchanged } };
}

export async function readCodexSessionFromIndex({ root, sessionId, sourceKey, redact = true } = {}) {
  const index = await readCodexSessionIndex(root);
  const entry = (index.entries || []).find((item) => (sessionId && String(item.sessionId).toLowerCase() === String(sessionId).toLowerCase()) || (sourceKey && item.sourceKey === sourceKey));
  if (!entry || entry.state === 'removed') return null;
  try {
    const parsed = await parseCodexSessionFile(entry.sourcePath, { redact });
    const updatedEntry = { ...entry, state: 'read', lastReadAt: new Date().toISOString(), lastReadSha256: parsed.sourceSha256, lastReadRecordCount: parsed.recordCount, readError: null };
    const nextEntries = (index.entries || []).map((item) => item.sourceKey === entry.sourceKey ? updatedEntry : item);
    await writeJsonAtomic(index.filePath, { ...index, generatedAt: new Date().toISOString(), entries: nextEntries });
    return { entry: updatedEntry, parsed };
  } catch (error) {
    const updatedEntry = { ...entry, state: 'read-error', readError: asText(error?.message || error, 2000), lastReadAt: new Date().toISOString() };
    const nextEntries = (index.entries || []).map((item) => item.sourceKey === entry.sourceKey ? updatedEntry : item);
    await writeJsonAtomic(index.filePath, { ...index, generatedAt: new Date().toISOString(), entries: nextEntries });
    throw error;
  }
}

export function codexCoverage(index) {
  const statistics = index?.statistics || {};
  const current = Number(statistics.current || 0);
  const read = (index?.entries || []).filter((entry) => entry.state === 'read' && entry.lastReadSha256).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: index?.generatedAt || null,
    complete: index?.complete === true,
    total: current,
    indexed: current,
    fullyRead: read,
    pendingRead: Math.max(0, current - read),
    coverage: current ? Number((read / current * 100).toFixed(1)) : 0,
    changes: { new: Number(statistics.new || 0), changed: Number(statistics.changed || 0), removed: Number(statistics.removed || 0), unchanged: Number(statistics.unchanged || 0) },
    indexPath: index?.filePath || null,
  };
}
