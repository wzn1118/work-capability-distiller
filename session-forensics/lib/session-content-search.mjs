import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_LIMIT = 250;
const DEFAULT_CONCURRENCY = 12;
const MAX_QUERY_LENGTH = 240;

function text(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase('zh-CN');
}

function redact(value) {
  return text(value)
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, '$1[已隐藏]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/ig, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏的密钥样式文本]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/ig, (match, secret) => match.replace(secret, '[已隐藏]'));
}

function excerpt(value, query, maximum = 280) {
  const source = redact(value);
  const index = normalized(source).indexOf(query);
  if (index < 0 || source.length <= maximum) return source.slice(0, maximum);
  const before = Math.max(0, index - Math.floor(maximum * 0.38));
  const after = Math.min(source.length, before + maximum);
  return `${before ? '...' : ''}${source.slice(before, after)}${after < source.length ? '...' : ''}`;
}

function sourceKey(source) {
  return String(source?.sourceKey || source?.sessionId || source?.sourcePath || '').trim();
}

function metadataFields(source) {
  return [
    ['标题', source?.title],
    ['会话编号', source?.sessionId],
    ['文件路径', source?.sourcePath],
    ['工作区', ...(source?.workspacePaths || [])],
    ['来源', ...(source?.discoveredBy || [])],
    ['平台', source?.webChat?.platformName, source?.webChat?.platform],
    ['项目', source?.webChat?.projectTitle],
    ['用户消息', source?.webChat?.userPreview],
    ['助手回复', source?.webChat?.assistantPreview],
  ];
}

function metadataMatch(source, query) {
  for (const [field, ...values] of metadataFields(source)) {
    for (const value of values) {
      if (normalized(value).includes(query)) return { field, snippet: excerpt(value, query), origin: 'metadata' };
    }
  }
  return null;
}

function stringMatch(value, query, seen = new Set()) {
  if (typeof value === 'string') return normalized(value).includes(query) ? value : null;
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = stringMatch(item, query, seen);
      if (match) return match;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const match = stringMatch(item, query, seen);
    if (match) return match;
  }
  return null;
}

function recordField(record) {
  const role = String(record?.payload?.role || record?.role || '').toLowerCase();
  if (role === 'user') return '用户消息';
  if (role === 'assistant') return '助手回复';
  if (role === 'tool') return '工具调用或结果';
  if (record?.type === 'web_asset') return '图片或附件';
  if (record?.type === 'web_event') return '网页工具调用';
  const payloadType = String(record?.payload?.type || '').toLowerCase();
  if (/tool|function|command|computer|image/.test(payloadType)) return '工具调用或结果';
  return '会话内容';
}

async function fileContentMatch(sourcePath, query, shouldStop = null) {
  if (!sourcePath) return null;
  let stream;
  try {
    stream = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        lines.close();
        stream.destroy();
        return null;
      }
      lineNumber += 1;
      if (!normalized(line).includes(query)) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { record = line; }
      const matchedValue = stringMatch(record, query) || line;
      lines.close();
      stream.destroy();
      return {
        field: recordField(record),
        snippet: excerpt(matchedValue, query),
        origin: 'content',
        lineNumber,
      };
    }
    return null;
  } catch {
    stream?.destroy();
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, worker));
  return results;
}

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ripgrepBatches(sources, maximumCharacters = 12_000, maximumFiles = 12) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const source of sources) {
    const sourcePath = source.sourcePath;
    const nextSize = String(sourcePath).length + 3;
    if (current.length && (current.length >= maximumFiles || size + nextSize > maximumCharacters)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(source);
    size += nextSize;
  }
  if (current.length) batches.push(current);
  return batches;
}

function ripgrepBatch(batch, query, shouldStop = null) {
  return new Promise((resolve) => {
    const child = spawn('rg', ['--files-with-matches', '--ignore-case', '--fixed-strings', '--text', '--no-messages', '--max-count', '1', '--', query, ...batch], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const abortTimer = typeof shouldStop === 'function'
      ? setInterval(() => {
        if (shouldStop() && !settled) {
          child.kill();
          finish({ paths: [], aborted: true });
        }
      }, 100)
      : null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearInterval(abortTimer);
      resolve(value);
    };
    if (typeof shouldStop === 'function' && shouldStop()) {
      child.kill();
      finish({ paths: [], aborted: true });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => finish({ paths: null, aborted: false }));
    child.once('close', (code) => {
      if (settled) return;
      if (![0, 1].includes(code)) return finish({ paths: null, aborted: false });
      finish({ paths: output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), aborted: false });
    });
  });
}

export function normalizeSessionSearchQuery(value) {
  return normalized(value).slice(0, MAX_QUERY_LENGTH);
}

function publicMatch(source, match) {
  return {
    sourceKey: sourceKey(source),
    sessionId: source.sessionId || null,
    title: source.title || '未命名会话',
    sourcePath: source.sourcePath || null,
    modifiedAt: source.modifiedAt || null,
    importKind: source.importKind || 'codex',
    platform: source.webChat?.platform || null,
    ...match,
  };
}

export async function searchSessionSourcesContent({ sources = [], query, limit = DEFAULT_LIMIT, concurrency = DEFAULT_CONCURRENCY, onProgress = null, shouldStop = null } = {}) {
  const normalizedQuery = normalizeSessionSearchQuery(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 1000));
  const candidates = [...new Map((sources || []).filter(Boolean).map((source) => [sourceKey(source), source])).values()];
  if (!normalizedQuery) return { query: '', matches: [], scannedCount: 0, matchedCount: 0, contentMatchCount: 0, metadataMatchCount: 0, truncated: false };

  const metadataMatches = [];
  const contentCandidates = [];
  for (const source of candidates) {
    const match = metadataMatch(source, normalizedQuery);
    if (match) metadataMatches.push({ source, match });
    else contentCandidates.push(source);
  }
  const matches = metadataMatches.map(({ source, match }) => publicMatch(source, match));
  let scannedContentCount = 0;
  let usedNodeFallback = false;
  if (typeof onProgress === 'function') await onProgress({
    phase: 'metadata',
    scannedCount: metadataMatches.length,
    totalCount: candidates.length,
    matches: matches.slice(0, safeLimit),
    matchedCount: matches.length,
  });
  const batches = ripgrepBatches(contentCandidates.filter((source) => source.sourcePath));
  await mapWithConcurrency(batches, 4, async (batch) => {
    if (typeof shouldStop === 'function' && shouldStop()) return [];
    const locatedResult = await ripgrepBatch(batch.map((source) => source.sourcePath), normalizedQuery, shouldStop);
    if (locatedResult?.aborted || (typeof shouldStop === 'function' && shouldStop())) return [];
    const locatedPaths = locatedResult?.paths ?? null;
    const fallback = locatedPaths === null;
    if (fallback) usedNodeFallback = true;
    const located = fallback ? null : new Set(locatedPaths.map(pathKey));
    const filesToRead = fallback ? batch : batch.filter((source) => located.has(pathKey(source.sourcePath)));
    const batchMatches = (await mapWithConcurrency(filesToRead, concurrency, async (source) => {
      const match = await fileContentMatch(source.sourcePath, normalizedQuery, shouldStop);
      return match ? publicMatch(source, match) : null;
    })).filter(Boolean);
    if (typeof shouldStop === 'function' && shouldStop()) return [];
    matches.push(...batchMatches);
    scannedContentCount += batch.length;
    if (typeof onProgress === 'function') await onProgress({
      phase: 'content',
      scannedCount: metadataMatches.length + scannedContentCount,
      totalCount: candidates.length,
      matches: batchMatches,
      matchedCount: matches.length,
      contentMatchCount: matches.filter((item) => item.origin === 'content').length,
      metadataMatchCount: metadataMatches.length,
    });
    return batchMatches;
  });
  matches.sort((left, right) => Date.parse(right.modifiedAt || 0) - Date.parse(left.modifiedAt || 0));

  return {
    query: text(query).slice(0, MAX_QUERY_LENGTH),
    matches: matches.slice(0, safeLimit),
    scannedCount: candidates.length,
    matchedCount: matches.length,
    contentMatchCount: matches.filter((item) => item.origin === 'content').length,
    metadataMatchCount: matches.filter((item) => item.origin === 'metadata').length,
    engine: usedNodeFallback ? 'node-stream-fallback' : 'ripgrep-prefilter',
    truncated: matches.length > safeLimit,
  };
}
