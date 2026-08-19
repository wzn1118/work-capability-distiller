import crypto from 'node:crypto';
import {
  analyseParsedSession,
  parseCodexSessionFile,
} from './session-forensics.mjs';
import { preflightSessionSources } from './session-source-index.mjs';

function text(value, maximum = 24000) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  return result.length <= maximum ? result : `${result.slice(0, maximum)}\n……内容已截断。`;
}

function unique(values, maximum = 160) {
  return [...new Set((values || []).map((value) => text(value, 4000)).filter(Boolean))].slice(0, maximum);
}

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function inputValues(...values) {
  return unique(values.flatMap((value) => array(value).flatMap((item) => String(item ?? '').split(/[\r\n,;]+/))), 80);
}

function titleFor(parsed, fallbackIndex) {
  const sessionMeta = parsed.sessionMeta && typeof parsed.sessionMeta === 'object' ? parsed.sessionMeta : {};
  const fromMeta = text(sessionMeta.title || sessionMeta.name || sessionMeta.summary || '', 160);
  if (fromMeta) return fromMeta;
  const userMessage = (parsed.messages || []).find((message) => {
    const value = text(message.text, 400);
    return message.actor === 'user'
      && message.contextKind === 'user-request'
      && value
      && !/^#\s*AGENTS\.md instructions\b/i.test(value)
      && !/^<(?:environment_context|app-context|in-app-browser-context)\b/i.test(value);
  });
  if (userMessage) {
    let value = text(userMessage.text, 4000);
    const marker = value.match(/(?:^|\s)#{1,6}\s*(?:My request|我的请求|用户请求)\s*[:：]\s*([\s\S]+)$/i);
    if (marker?.[1]) value = marker[1].trim();
    else value = value.replace(/^#\s*Files mentioned by the user\s*:\s*/i, '').trim();
    return value.replace(/\s+/g, ' ').slice(0, 96);
  }
  return `未命名会话 ${fallbackIndex}`;
}

function requestTiming(parsed, selectionOrder) {
  const requests = (parsed.messages || []).filter((message) => {
    const value = text(message.text, 400);
    return message.actor === 'user'
      && message.contextKind === 'user-request'
      && value
      && !/^#\s*AGENTS\.md instructions\b/i.test(value)
      && !/^<(?:environment_context|app-context|in-app-browser-context)\b/i.test(value);
  });
  const latest = requests.at(-1) || null;
  const timestamp = text(latest?.timestamp || '', 80) || null;
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  return {
    selectionOrder,
    lastUserRequestAt: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : timestamp,
    latestUserRequest: latest ? text(latest.text, 360) : null,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

function assignSourceAuthority(sources) {
  const ranked = [...sources].sort((left, right) => {
    const rightTime = Number(right.timing?.timestampMs);
    const leftTime = Number(left.timing?.timestampMs);
    const hasRightTime = Number.isFinite(rightTime);
    const hasLeftTime = Number.isFinite(leftTime);
    if (hasRightTime && hasLeftTime && rightTime !== leftTime) return rightTime - leftTime;
    if (hasRightTime !== hasLeftTime) return hasRightTime ? -1 : 1;
    return Number(right.timing?.selectionOrder || 0) - Number(left.timing?.selectionOrder || 0);
  });
  ranked.forEach((source, index) => {
    const hasTimestamp = Number.isFinite(Number(source.timing?.timestampMs));
    source.authority = {
      rank: index + 1,
      reason: hasTimestamp ? '按最后一条用户要求的时间排序' : '缺少可解析时间，按用户选择顺序排序',
    };
  });
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function rebaseEventIndexes(value, offset) {
  if (Array.isArray(value)) return value.map((item) => rebaseEventIndexes(item, offset));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, current] of Object.entries(value)) {
    if ((key === 'eventIndex' || key === 'triggerEventIndex') && Number.isFinite(Number(current))) {
      copy[key] = Number(current) + offset;
    } else {
      copy[key] = rebaseEventIndexes(current, offset);
    }
  }
  return copy;
}

function eventExtent(parsed) {
  const values = [
    ...(parsed.timeline || []).map((item) => item.eventIndex),
    ...(parsed.messages || []).map((item) => item.eventIndex),
    ...(parsed.toolCalls || []).map((item) => item.eventIndex),
    ...(parsed.fileChanges || []).map((item) => item.eventIndex),
    ...(parsed.runtimeEvents || []).map((item) => item.eventIndex),
  ].map(Number).filter(Number.isFinite);
  return Math.max(0, ...values);
}

function sumCounts(sources, field) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.parsed[field] || {})) {
      result[key] = (result[key] || 0) + (Number(value) || 0);
    }
  }
  return result;
}

export function mergeParsedSessions(sources) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('至少需要一条可解析的会话。');
  let offset = 0;
  const messages = [];
  const toolCalls = [];
  const toolOutputs = [];
  const fileChanges = [];
  const runtimeEvents = [];
  const turnContexts = [];
  const timeline = [];
  const warnings = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const parsed = source.parsed;
    const annotate = (item) => ({
      ...rebaseEventIndexes(clone(item), offset),
      sourceSessionId: source.sessionId,
      sourceTitle: source.title,
      sourcePath: source.sourcePath,
      sourceIndex: sourceIndex + 1,
      sourceAuthorityRank: source.authority?.rank || null,
    });
    messages.push(...(parsed.messages || []).map(annotate));
    toolCalls.push(...(parsed.toolCalls || []).map(annotate));
    toolOutputs.push(...(parsed.toolOutputs || []).map(annotate));
    fileChanges.push(...(parsed.fileChanges || []).map(annotate));
    runtimeEvents.push(...(parsed.runtimeEvents || []).map(annotate));
    turnContexts.push(...(parsed.turnContexts || []).map(annotate));
    timeline.push(...(parsed.timeline || []).map(annotate));
    warnings.push(...(parsed.warnings || []).map((warning) => `${source.title}：${warning}`));
    offset += Math.max(eventExtent(parsed), Number(parsed.recordCount) || 0) + 1;
  }
  timeline.sort((left, right) => Number(left.eventIndex || 0) - Number(right.eventIndex || 0));
  timeline.forEach((item, index) => { item.sequence = index + 1; });
  const sourceHash = crypto.createHash('sha256').update(sources.map((source) => source.parsed.sourceSha256).join('\n')).digest('hex');
  const sessionId = sources.length === 1 ? sources[0].sessionId : `multi-${sources.length}-${sourceHash.slice(0, 12)}`;
  return {
    sourcePath: sources.length === 1 ? sources[0].sourcePath : `多会话集合（${sources.length} 条）`,
    sourceBytes: sources.reduce((total, source) => total + (Number(source.parsed.sourceBytes) || 0), 0),
    sourceSha256: sourceHash,
    sourceFormat: sources.length === 1 ? sources[0].parsed.sourceFormat : 'multi-session-jsonl',
    sessionId,
    sessionMeta: {
      title: sources.length === 1 ? sources[0].title : `${sources.length} 条会话的联合蒸馏`,
      sourceSessions: sources.map((source) => ({
        sessionId: source.sessionId,
        title: source.title,
        path: source.sourcePath,
        authorityRank: source.authority?.rank || null,
        lastUserRequestAt: source.timing?.lastUserRequestAt || null,
      })),
    },
    recordCount: sources.reduce((total, source) => total + (Number(source.parsed.recordCount) || 0), 0),
    invalidRecordCount: sources.reduce((total, source) => total + (Number(source.parsed.invalidRecordCount) || 0), 0),
    eventTypeCounts: sumCounts(sources, 'eventTypeCounts'),
    responseItemTypeCounts: sumCounts(sources, 'responseItemTypeCounts'),
    turnContexts,
    messages,
    toolCalls,
    toolOutputs,
    fileChanges,
    runtimeEvents,
    timeline,
    warnings: unique(warnings, 240),
  };
}

export async function loadConversationSources({
  threadId,
  sourcePath,
  threadIds = [],
  sourcePaths = [],
  roots = [],
  redact = true,
} = {}) {
  const ids = inputValues(threadId, threadIds);
  const paths = inputValues(sourcePath, sourcePaths);
  if (!ids.length && !paths.length) throw new Error('请选择至少一条本机会话，或指定至少一个会话文件。');
  const resolution = await preflightSessionSources({ threadIds: ids, sourcePaths: paths, roots });
  if (!resolution.ready) {
    const details = resolution.results.map((item) => `${item.input || '未命名来源'}：${item.state?.label || '未找到'}`).join('；');
    throw new Error(`没有可用的会话来源。${details || '请重新扫描本机会话或选择有效的 JSON/JSONL 文件。'}`);
  }
  const sources = [];
  for (const item of resolution.selectedSources) {
    const parsed = await parseCodexSessionFile(item.sourcePath, { redact });
    if (!parsed.sessionId && item.sessionId) parsed.sessionId = item.sessionId;
    sources.push({
      sourceKey: item.sourceKey,
      sessionId: text(item.sessionId || parsed.sessionId || `source-${sources.length + 1}`, 160),
      sourcePath: item.sourcePath,
      title: item.title || titleFor(parsed, sources.length + 1),
      titleSource: item.titleSource || null,
      discoveredBy: item.discoveredBy || [],
      duplicatePaths: item.duplicatePaths || [],
      live: Boolean(item.live),
      timing: requestTiming(parsed, sources.length + 1),
      parsed,
    });
  }
  assignSourceAuthority(sources);
  const mergedParsed = mergeParsedSessions(sources);
  const analysis = analyseParsedSession(mergedParsed, { includeEvidence: true });
  const sourceSummary = sources.map((source, index) => ({
    index: index + 1,
    selectionOrder: source.timing?.selectionOrder || index + 1,
    authorityRank: source.authority?.rank || null,
    authorityReason: source.authority?.reason || null,
    sourceKey: source.sourceKey || null,
    sessionId: source.sessionId,
    title: source.title,
    sourcePath: source.sourcePath,
    titleSource: source.titleSource || null,
    discoveredBy: source.discoveredBy || [],
    duplicatePaths: source.duplicatePaths || [],
    live: Boolean(source.live),
    lastUserRequestAt: source.timing?.lastUserRequestAt || null,
    latestUserRequest: source.timing?.latestUserRequest || null,
    sha256: source.parsed.sourceSha256,
    bytes: source.parsed.sourceBytes,
    recordCount: source.parsed.recordCount,
    normalisedEventCount: source.parsed.timeline?.length || 0,
    messages: source.parsed.messages?.length || 0,
    toolCalls: source.parsed.toolCalls?.length || 0,
    fileChanges: source.parsed.fileChanges?.length || 0,
  }));
  const sourceSet = {
    mode: sources.length > 1 ? 'multi-session' : 'whole-session',
    label: sources.length > 1
      ? `多会话联合蒸馏：${sources.length} 条完整会话，按选择顺序保留全部记录、消息、工具、命令和文件变更。`
      : '完整会话：所有原始记录、可见消息、工具调用、工具结果、命令和文件变更。',
    sessionCount: sources.length,
    recordCount: mergedParsed.recordCount,
    normalisedEventCount: analysis.coverage.normalisedEventCount,
    sourceSha256: mergedParsed.sourceSha256,
    sessions: sourceSummary,
    authority: sourceSummary
      .slice()
      .sort((left, right) => Number(left.authorityRank || 9999) - Number(right.authorityRank || 9999))
      .map((source) => ({
        rank: source.authorityRank,
        sessionId: source.sessionId,
        title: source.title,
        lastUserRequestAt: source.lastUserRequestAt,
        latestUserRequest: source.latestUserRequest,
        reason: source.authorityReason,
      })),
  };
  analysis.multiSource = sourceSet;
  analysis.source = {
    ...analysis.source,
    sessionId: mergedParsed.sessionId,
    path: mergedParsed.sourcePath,
    sha256: mergedParsed.sourceSha256,
    bytes: mergedParsed.sourceBytes,
    format: mergedParsed.sourceFormat,
    recordCount: mergedParsed.recordCount,
  };
  return { sources, mergedParsed, analysis, sourceSet };
}
