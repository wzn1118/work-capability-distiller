import { createHash } from 'node:crypto';

export const TRACE_IR_SCHEMA_VERSION = 'trace-ir/v1';

const KIND_MAP = new Map([
  ['message', 'message'],
  ['tool_call', 'tool_call'],
  ['tool_output', 'tool_result'],
  ['tool_result', 'tool_result'],
  ['command', 'command'],
  ['file_change', 'patch'],
  ['patch', 'patch'],
  ['artifact', 'artifact'],
  ['verification', 'verification'],
  ['correction', 'correction'],
  ['checkpoint', 'checkpoint'],
  ['session_meta', 'checkpoint'],
  ['turn_context', 'checkpoint'],
  ['runtime_event', 'runtime_event'],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value, maximum = 4000) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.replace(/\u0000/g, '').slice(0, maximum);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, maximum));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, clean(item, maximum)]));
  return String(value).slice(0, maximum);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function sourceRef(event, index, source) {
  return {
    sourcePath: source.sourcePath ?? null,
    sourceSha256: source.sourceSha256 ?? null,
    recordIndex: Number(event.recordIndex ?? event.rawRecordIndex ?? 0) || null,
    eventIndex: Number(event.sequence ?? event.eventIndex ?? index + 1) || index + 1,
    rawHash: sha256({ source: source.sourceSha256 ?? null, event: clean(event, 1600) }),
  };
}

function eventLinks(event, kind) {
  const links = {};
  if (event.callId) links.callId = String(event.callId);
  if (kind === 'tool_result' && event.callId) links.resultFor = String(event.callId);
  if (event.replaces) links.replaces = clean(event.replaces, 240);
  if (event.verifies) links.verifies = clean(event.verifies, 240);
  if (event.produced) links.produced = clean(event.produced, 240);
  return links;
}

export function normalizeTraceEvent(event, index, source = {}) {
  const sourceKind = String(event?.kind ?? event?.type ?? 'unknown');
  const kind = KIND_MAP.get(sourceKind) ?? 'unknown';
  const sequence = Number(event?.sequence ?? event?.eventIndex ?? index + 1) || index + 1;
  const eventId = `${source.sessionId ?? 'session'}:e${String(sequence).padStart(8, '0')}`;
  const payload = clean(event, 6000) ?? {};
  const links = eventLinks(event, kind);
  const parentEventId = index > 0 ? `${source.sessionId ?? 'session'}:e${String(index).padStart(8, '0')}` : null;
  return {
    eventId,
    sessionId: source.sessionId ?? null,
    parentEventId,
    timestamp: event?.timestamp ?? null,
    actor: event?.actor ?? null,
    kind,
    sourceKind,
    harness: source.harness ?? 'codex',
    payload,
    links,
    provenance: sourceRef(event, index, source),
    confidence: {
      level: 'direct',
      score: 100,
      reason: '来自已解析的原始会话事件或其标准化映射。',
    },
  };
}

export function createTraceIR({ events = [], sessionId = null, sourcePath = null, sourceSha256 = null, harness = 'codex', metadata = {} } = {}) {
  const source = { sessionId, sourcePath, sourceSha256, harness };
  const normalizedEvents = (Array.isArray(events) ? events : []).map((event, index) => normalizeTraceEvent(event, index, source));
  const unknownKinds = [...new Set(normalizedEvents.filter((event) => event.kind === 'unknown').map((event) => event.sourceKind))].sort();
  const trace = {
    schemaVersion: TRACE_IR_SCHEMA_VERSION,
    sessionId,
    harness,
    provenance: {
      sourcePath,
      sourceSha256,
      eventCount: normalizedEvents.length,
    },
    metadata: clean(metadata, 2000) ?? {},
    eventCount: normalizedEvents.length,
    unknownKinds,
    events: normalizedEvents,
  };
  return {
    ...trace,
    fingerprint: sha256({ ...trace, fingerprint: undefined }),
  };
}

export function validateTraceIR(trace) {
  const errors = [];
  if (!isObject(trace)) errors.push('Trace IR 必须是对象。');
  if (trace?.schemaVersion !== TRACE_IR_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${TRACE_IR_SCHEMA_VERSION}。`);
  if (!Array.isArray(trace?.events)) errors.push('events 必须是数组。');
  const ids = new Set();
  for (const [index, event] of (trace?.events ?? []).entries()) {
    if (!event?.eventId) errors.push(`事件 ${index + 1} 缺少 eventId。`);
    if (ids.has(event?.eventId)) errors.push(`事件 ${index + 1} 的 eventId 重复。`);
    ids.add(event?.eventId);
    if (!event?.kind) errors.push(`事件 ${index + 1} 缺少 kind。`);
    if (!event?.provenance?.rawHash) errors.push(`事件 ${index + 1} 缺少 provenance.rawHash。`);
  }
  if (trace?.eventCount !== trace?.events?.length) errors.push('eventCount 与 events.length 不一致。');
  return { valid: errors.length === 0, errors };
}

export function traceIRFromParsed(parsed, options = {}) {
  return createTraceIR({
    events: parsed?.timeline ?? [],
    sessionId: parsed?.sessionId ?? options.sessionId ?? null,
    sourcePath: parsed?.sourcePath ?? options.sourcePath ?? null,
    sourceSha256: parsed?.sourceSha256 ?? options.sourceSha256 ?? null,
    harness: options.harness ?? 'codex',
    metadata: {
      sourceFormat: parsed?.sourceFormat ?? null,
      recordCount: parsed?.recordCount ?? null,
      invalidRecordCount: parsed?.invalidRecordCount ?? null,
      eventTypeCounts: parsed?.eventTypeCounts ?? {},
    },
  });
}

export function summarizeTraceIR(trace) {
  const counts = {};
  for (const event of trace?.events ?? []) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return {
    schemaVersion: trace?.schemaVersion ?? TRACE_IR_SCHEMA_VERSION,
    sessionId: trace?.sessionId ?? null,
    eventCount: trace?.eventCount ?? 0,
    kindCounts: counts,
    unknownKinds: trace?.unknownKinds ?? [],
    fingerprint: trace?.fingerprint ?? null,
  };
}
