import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 'chatgpt-incremental-sync-v3';

function clean(value, limit = 500) { return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit); }
function statePath(root) { return path.join(root, 'incremental-sync-state.json'); }

async function readState(root) {
  try { return JSON.parse(await fsp.readFile(statePath(root), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, generatedAt: null, conversations: {}, pendingJobs: {}, runs: {} }; throw error; }
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const conversations = state.conversations || {};
  const pendingJobs = state.pendingJobs || {};
  const runs = { ...(state.runs || {}) };
  for (const [jobId, pending] of Object.entries(pendingJobs)) {
    if (runs[jobId]) continue;
    const targetIds = [...new Set((pending?.ids || []).map((id) => clean(id, 1_000)).filter(Boolean))];
    if (!targetIds.length) continue;
    // v2 只保存剩余队列；将它提升为暂停的可恢复任务，避免升级后丢失断点。
    runs[jobId] = {
      runId: jobId,
      jobId,
      status: 'paused',
      phase: 'recovered',
      totalCount: targetIds.length,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      remainingCount: targetIds.length,
      targetIds,
      successIds: [],
      failedIds: [],
      recoveredLegacyCheckpoint: true,
      createdAt: pending?.createdAt || null,
      lastCheckpointAt: pending?.lastCheckpointAt || pending?.createdAt || null,
      lastTitle: conversations[targetIds[0]]?.title || '',
      updatedAt: state.generatedAt || pending?.lastCheckpointAt || pending?.createdAt || null,
    };
  }
  return { ...state, schemaVersion: SCHEMA_VERSION, conversations, pendingJobs, runs };
}

async function writeState(root, state) {
  await fsp.mkdir(root, { recursive: true });
  const filePath = statePath(root);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString() }, null, 2), 'utf8');
  await fsp.rename(temporary, filePath);
}

function idOf(item) { return clean(item?.conversationId || item?.id || item?.url, 1000); }

function captureEnvelope(capture = {}) {
  return {
    messages: Array.isArray(capture.messages) ? capture.messages : [],
    events: Array.isArray(capture.events) ? capture.events : [],
    assets: Array.isArray(capture.assets) ? capture.assets : [],
    nodes: Array.isArray(capture.nodes) ? capture.nodes : [],
    branches: capture.branches || null,
  };
}

function captureHash(capture = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(captureEnvelope(capture))).digest('hex');
}

function captureStats(capture = {}) {
  const envelope = captureEnvelope(capture);
  return {
    captureSchema: 'lossless-web-v1',
    contentHash: captureHash(capture),
    messageCount: envelope.messages.length,
    eventCount: envelope.events.length,
    assetCount: envelope.assets.length,
    nodeCount: envelope.nodes.length,
    completeness: capture.completeness || null,
  };
}

export async function planChatGPTIncrementalSync({ root, conversations = [], force = false } = {}) {
  const state = normalizeState(await readState(root));
  const toFetch = [];
  const skipped = [];
  for (const item of conversations) {
    const id = idOf(item);
    if (!id) continue;
    const previous = state.conversations[id];
    const updatedAt = clean(item?.updatedAt || item?.update_time, 100) || null;
    const sameVersion = previous && previous.updatedAt === updatedAt && previous.status === 'success' && previous.captureSchema === 'lossless-web-v1';
    if (!force && sameVersion) skipped.push(item);
    else toFetch.push(item);
  }
  return { state, conversations: [...conversations], toFetch, skipped, summary: { total: conversations.length, toFetch: toFetch.length, skipped: skipped.length, forced: Boolean(force) } };
}

export async function registerChatGPTSyncJob({ root, jobId, plan } = {}) {
  // 规划和登记之间可能已经有上一轮读取落盘；登记必须以最新状态为准，避免把已成功会话重新标成 pending。
  const state = normalizeState(await readState(root));
  const pendingJobs = { ...(state.pendingJobs || {}) };
  const forced = Boolean(plan?.summary?.forced);
  const eligible = (plan?.toFetch || []).filter((item) => {
    const id = idOf(item);
    if (!id || forced) return Boolean(id);
    const current = state.conversations?.[id];
    const updatedAt = clean(item?.updatedAt || item?.update_time, 100) || null;
    return !(current?.status === 'success' && current.updatedAt === updatedAt);
  });
  const nextIds = eligible.map(idOf).filter(Boolean);
  const nextIdSet = new Set(nextIds);
  for (const [pendingJobId, pending] of Object.entries(pendingJobs)) {
    const remainingIds = (pending?.ids || []).filter((id) => !nextIdSet.has(id));
    if (remainingIds.length) pendingJobs[pendingJobId] = { ...pending, ids: remainingIds };
    else delete pendingJobs[pendingJobId];
  }
  pendingJobs[jobId] = { createdAt: new Date().toISOString(), ids: nextIds };
  const conversations = { ...(state.conversations || {}) };
  for (const item of eligible) {
    const id = idOf(item);
    if (!id) continue;
    const previous = conversations[id] || {};
    conversations[id] = {
      ...previous,
      conversationId: clean(item.conversationId || item.id, 1000) || previous.conversationId || null,
      title: clean(item.title),
      url: clean(item.url, 2_000) || previous.url || null,
      projectId: clean(item.projectId, 500) || previous.projectId || null,
      projectTitle: clean(item.projectTitle, 500) || previous.projectTitle || null,
      updatedAt: clean(item.updatedAt || item.update_time, 100) || null,
      status: 'pending',
      attempts: Number(previous.attempts || 0) + 1,
      lastQueuedAt: new Date().toISOString(),
    };
  }
  const runs = { ...(state.runs || {}), [jobId]: {
    ...(state.runs?.[jobId] || {}),
    runId: state.runs?.[jobId]?.runId || jobId,
    jobId,
    status: 'queued',
    phase: 'queued',
    totalCount: nextIds.length,
    completedCount: 0,
    failedCount: 0,
    skippedCount: Number(plan?.summary?.skipped || 0),
    remainingCount: nextIds.length,
    targetIds: nextIds,
    successIds: [],
    failedIds: [],
    createdAt: state.runs?.[jobId]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } };
  await writeState(root, { ...state, conversations, pendingJobs, runs });
  return { jobId, pendingCount: pendingJobs[jobId].ids.length };
}

export async function checkpointChatGPTSyncJob({ root, jobId, captures = [], failures = [] } = {}) {
  const state = normalizeState(await readState(root));
  const pending = state.pendingJobs?.[jobId] || { ids: [] };
  const conversations = { ...(state.conversations || {}) };
  const resolvedIds = new Set();
  for (const capture of captures || []) {
    const id = idOf(capture);
    if (!id) continue;
    resolvedIds.add(id);
    const stats = captureStats(capture);
    conversations[id] = {
      ...(conversations[id] || {}),
      title: clean(capture.title),
      updatedAt: clean(capture.updatedAt || capture.update_time, 100) || conversations[id]?.updatedAt || null,
      ...stats,
      status: 'success',
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    };
  }
  for (const failure of failures || []) {
    const id = idOf(failure);
    if (!id) continue;
    resolvedIds.add(id);
    conversations[id] = {
      ...(conversations[id] || {}),
      title: clean(failure.title || conversations[id]?.title),
      status: 'failed',
      lastError: clean(failure.error || '本次读取失败', 2_000),
      lastFailedAt: new Date().toISOString(),
    };
  }
  const pendingJobs = { ...(state.pendingJobs || {}) };
  pendingJobs[jobId] = {
    ...(pendingJobs[jobId] || {}),
    ids: (pending.ids || []).filter((id) => !resolvedIds.has(id)),
    lastCheckpointAt: new Date().toISOString(),
  };
  const previousRun = state.runs?.[jobId] || {};
  const successIds = [...new Set([...(previousRun.successIds || []), ...(captures || []).map(idOf).filter(Boolean)])];
  const failedIds = [...new Set([...(previousRun.failedIds || []), ...(failures || []).map(idOf).filter(Boolean)])].filter((id) => !successIds.includes(id));
  const runs = { ...(state.runs || {}), [jobId]: {
    ...previousRun,
    status: failures.length ? 'partial' : 'running',
    phase: 'persisting',
    completedCount: Number(previousRun.completedCount || 0) + captures.length,
    failedCount: Number(previousRun.failedCount || 0) + failures.length,
    remainingCount: pendingJobs[jobId].ids.length,
    successIds,
    failedIds,
    lastCheckpointAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } };
  await writeState(root, { ...state, conversations, pendingJobs, runs });
  return { capturedCount: captures.length, failedCount: failures.length, remainingCount: pendingJobs[jobId].ids.length };
}

export async function commitChatGPTSyncJob({ root, jobId, captures = [], error = '' } = {}) {
  const state = normalizeState(await readState(root));
  const pending = state.pendingJobs?.[jobId] || { ids: [] };
  const conversations = { ...(state.conversations || {}) };
  const capturedIds = new Set();
  for (const capture of captures || []) {
    const id = idOf(capture);
    if (!id) continue;
    capturedIds.add(id);
    const stats = captureStats(capture);
    conversations[id] = { ...(conversations[id] || {}), title: clean(capture.title), updatedAt: clean(capture.updatedAt || capture.update_time, 100) || conversations[id]?.updatedAt || null, ...stats, status: 'success', lastSuccessAt: new Date().toISOString(), lastError: null };
  }
  for (const id of pending.ids || []) {
    if (capturedIds.has(id)) continue;
    conversations[id] = { ...(conversations[id] || {}), status: 'failed', lastError: clean(error || '本次读取没有返回完整内容', 2000), lastFailedAt: new Date().toISOString() };
  }
  const pendingJobs = { ...(state.pendingJobs || {}) };
  delete pendingJobs[jobId];
  const previousRun = state.runs?.[jobId] || {};
  const successIds = [...new Set([...(previousRun.successIds || []), ...capturedIds])];
  const failedIds = [...new Set([...(previousRun.failedIds || []), ...(pending.ids || []).filter((id) => !capturedIds.has(id))])].filter((id) => !successIds.includes(id));
  const failedCount = failedIds.length;
  const runs = { ...(state.runs || {}), [jobId]: {
    ...previousRun,
    status: failedCount ? 'partial' : 'completed',
    phase: 'reconciled',
    completedCount: successIds.length,
    failedCount,
    remainingCount: 0,
    successIds,
    failedIds,
    lastCheckpointAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } };
  await writeState(root, { ...state, conversations, pendingJobs, runs });
  return { capturedCount: capturedIds.size, failedCount };
}

export async function updateChatGPTSyncRun({ root, jobId, patch = {} } = {}) {
  const state = normalizeState(await readState(root));
  const current = state.runs?.[jobId] || { runId: jobId, jobId, createdAt: new Date().toISOString() };
  const runs = { ...(state.runs || {}), [jobId]: { ...current, ...patch, updatedAt: new Date().toISOString() } };
  await writeState(root, { ...state, runs });
  return runs[jobId];
}

export async function readChatGPTSyncState(root) { return normalizeState(await readState(root)); }
