import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { publicRuntimeConfig, publicWorkspaceConfig, updateRuntimeConfig, updateWorkspaceConfig, runtimeConfig } from './runtime/config.mjs';
import { connectCurrentCodex, inspectCurrentCodex } from './runtime/codex-link.mjs';
import { loadEvidence, searchConversation, getStage, getLatestCorrections, getImprovedWorkflow, getProjectKnowledgeV4 } from './runtime/evidence.mjs';
import { listModels, chatCompletion, proxyStreamingChat } from './runtime/provider.mjs';
import { cancelRun, createRun, executeRun, listRuns, loadRun, localConversationContextToolDefinition, publicRun, saveRun } from './runtime/task-engine.mjs';
import { getManagedProcesses, restoreCheckpoint, stopManagedProcess } from './runtime/workspace.mjs';
import { HttpError, errorPayload, readBody, sendBuffer, sendJson, startSse } from './runtime/shared.mjs';
import { inspectInstallation } from './runtime/installation.mjs';
import { analyseParsedSession, parseCodexSessionFile } from './runtime/session-forensics.mjs';
import { buildSemanticSessionIndex, pageSemanticSessions, pageSemanticTaskChains } from './runtime/session-semantic-index.mjs';
import { availablePathPickerKinds, selectLocalPaths } from './runtime/local-path-picker.mjs';
import { createChatGptWebBridge } from './runtime/chatgpt-web-link.mjs';
import { summarizeCoverageGaps, transitionCoverageGap } from './runtime/quality/coverage-gap-state-machine.mjs';
import { evaluateHeldOutCandidate, evaluateHeldOutSuite } from './runtime/evaluation/held-out-evaluator.mjs';
import { evaluateWorkCapabilityGates } from './runtime/evaluation/work-gates.mjs';

const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(AGENT_ROOT, 'ui');
function stateRootForCurrentUser() {
  if (process.env.CONVERSATION_AGENT_STATE_ROOT) return path.resolve(process.env.CONVERSATION_AGENT_STATE_ROOT);
  const packageId = path.basename(path.dirname(AGENT_ROOT)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'conversation-capability-agent';
  const home = process.env.HOME || process.env.USERPROFILE || AGENT_ROOT;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ConversationCapabilityAgents', packageId);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ConversationCapabilityAgents', packageId);
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'conversation-capability-agents', packageId);
}

const STATE_ROOT = stateRootForCurrentUser();
const HOST = process.env.CONVERSATION_AGENT_HOST || process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.CONVERSATION_AGENT_PORT || process.env.PORT || 8890);
let server = null;
const chatGptWeb = createChatGptWebBridge({
  companionRoot: path.join(AGENT_ROOT, 'chatgpt-companion'),
  getAgentUrl: () => {
    const address = server?.address();
    const port = address && typeof address === 'object' ? address.port : PORT;
    return `http://127.0.0.1:${port}`;
  },
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.ndjson': 'application/x-ndjson; charset=utf-8', '.svg': 'image/svg+xml' };
const LOCAL_CONVERSATION_CACHE_MS = 30_000;
const LOCAL_SESSION_ROOTS = String(process.env.CODEX_SESSION_ROOT || process.env.CODEX_SESSION_ROOTS || '')
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);
let localConversationsListedAt = 0;
let localConversationIndex = null;
const localConversations = new Map();
const LOCAL_SESSION_INDEX_CACHE_PATH = path.join(STATE_ROOT, 'local-session-semantic-index.json');
const ARTIFACTS = new Map([
  ['packageGuide', path.join(AGENT_ROOT, '..', 'README.md')],
  ['readme', path.join(AGENT_ROOT, 'README.md')],
  ['profile', path.join(AGENT_ROOT, 'ai-profile.json')],
  ['blueprint', path.join(AGENT_ROOT, 'workflow-blueprint.json')],
  ['contract', path.join(AGENT_ROOT, 'capability-contract.json')],
  ['extraction', path.join(AGENT_ROOT, 'conversation-extraction.json')],
  ['distillation', path.join(AGENT_ROOT, 'conversation-distillation.md')],
  ['distillationJson', path.join(AGENT_ROOT, 'conversation-distillation.json')],
  ['recommendation', path.join(AGENT_ROOT, 'distillation-recommendation.json')],
  ['priorityPlan', path.join(AGENT_ROOT, 'PRIORITY-PLAN.md')],
  ['recommendationHtml', path.join(AGENT_ROOT, 'distillation-recommendation.html')],
  ['sourceSessions', path.join(AGENT_ROOT, 'source-sessions.json')],
  ['projectPortfolio', path.join(AGENT_ROOT, 'project-portfolio.json')],
  ['projectPortfolioMarkdown', path.join(AGENT_ROOT, 'project-portfolio.md')],
  ['projectEvidence', path.join(AGENT_ROOT, 'project-evidence.json')],
  ['projectEvidenceMarkdown', path.join(AGENT_ROOT, 'project-evidence.md')],
  ['projectUnderstanding', path.join(AGENT_ROOT, 'project-understanding.json')],
  ['projectUnderstandingMarkdown', path.join(AGENT_ROOT, 'project-understanding.md')],
  ['projectKnowledgeV4', path.join(AGENT_ROOT, 'project-knowledge-v4.json')],
  ['projectKnowledgeV4Markdown', path.join(AGENT_ROOT, 'project-knowledge-v4.md')],
  ['semanticStages', path.join(AGENT_ROOT, 'semantic-stages.json')],
  ['evidenceLedger', path.join(AGENT_ROOT, 'evidence-ledger.ndjson')],
  ['projectModel', path.join(AGENT_ROOT, 'project-model.json')],
  ['projectGraph', path.join(AGENT_ROOT, 'project-graph.json')],
  ['fileVersions', path.join(AGENT_ROOT, 'file-versions.ndjson')],
  ['artifactLineage', path.join(AGENT_ROOT, 'artifact-lineage.json')],
  ['crossSessionTimeline', path.join(AGENT_ROOT, 'cross-session-timeline.ndjson')],
  ['fileChangeMatrix', path.join(AGENT_ROOT, 'file-change-matrix.json')],
  ['dependencyImpact', path.join(AGENT_ROOT, 'dependency-impact.json')],
  ['artifactReproducibility', path.join(AGENT_ROOT, 'artifact-reproducibility.json')],
  ['projectSnapshot', path.join(AGENT_ROOT, 'project-snapshot.json')],
  ['openEvidenceQuestions', path.join(AGENT_ROOT, 'open-evidence-questions.json')],
  ['decisionConflicts', path.join(AGENT_ROOT, 'decision-conflicts.json')],
  ['knowledgeCoverage', path.join(AGENT_ROOT, 'coverage.json')],
  ['activeReadLog', path.join(AGENT_ROOT, 'active-read-log.ndjson')],
  ['workCapability', path.join(AGENT_ROOT, 'work-capability-ir.v2.json')],
  ['coverageMatrix', path.join(AGENT_ROOT, 'coverage-matrix.json')],
  ['workEvidenceLedger', path.join(AGENT_ROOT, 'work-evidence-ledger.ndjson')],
  ['executionGraph', path.join(AGENT_ROOT, 'execution-graph.json')],
  ['releaseDecision', path.join(AGENT_ROOT, 'release-decision.json')],
  ['coverageGaps', path.join(AGENT_ROOT, 'coverage-gaps.json')],
  ['semanticEvaluationPlan', path.join(AGENT_ROOT, 'semantic-evaluation-plan.json')],
  ['deterministicReplay', path.join(AGENT_ROOT, 'deterministic-replay.json')],
  ['originalTaskReplay', path.join(AGENT_ROOT, 'original-task-replay.json')],
  ['heldOutEvaluation', path.join(AGENT_ROOT, 'held-out-evaluation.json')],
  ['isolatedAgentValidation', path.join(AGENT_ROOT, 'isolated-agent-validation.json')],
  ['manifest', path.join(AGENT_ROOT, '..', 'package-manifest.json')],
]);

const COVERAGE_GAP_STATE_PATH = path.join(STATE_ROOT, 'coverage-gaps-state.json');
const RELEASE_VALIDATION_STATE_PATH = path.join(STATE_ROOT, 'release-validation-state.json');

async function readArtifactJson(name, fallback = null) {
  const filePath = ARTIFACTS.get(name);
  if (!filePath) return fallback;
  try { return JSON.parse(await fsp.readFile(filePath, 'utf8')); } catch { return fallback; }
}

async function readCoverageGapRegister() {
  const packaged = await readArtifactJson('coverageGaps', { schemaVersion: 'coverage-gap-register/v2', gaps: [] });
  const persisted = await fsp.readFile(COVERAGE_GAP_STATE_PATH, 'utf8').then(JSON.parse).catch(() => ({ gaps: [] }));
  const overlays = new Map((persisted.gaps || []).map((gap) => [gap.gapId, gap]));
  const gaps = (packaged.gaps || []).map((gap) => overlays.get(gap.gapId) || gap);
  return { ...packaged, gaps, summary: summarizeCoverageGaps(gaps) };
}

async function persistCoverageGap(gap) {
  const current = await fsp.readFile(COVERAGE_GAP_STATE_PATH, 'utf8').then(JSON.parse).catch(() => ({ schemaVersion: 'coverage-gap-state/v2', gaps: [] }));
  const gaps = [...(current.gaps || []).filter((item) => item.gapId !== gap.gapId), gap];
  const payload = { schemaVersion: 'coverage-gap-state/v2', updatedAt: new Date().toISOString(), gaps };
  await fsp.mkdir(STATE_ROOT, { recursive: true });
  const temporary = `${COVERAGE_GAP_STATE_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, COVERAGE_GAP_STATE_PATH);
}

async function readReleaseValidationState() {
  return fsp.readFile(RELEASE_VALIDATION_STATE_PATH, 'utf8').then(JSON.parse).catch(() => null);
}

async function persistReleaseValidationState(payload) {
  await fsp.mkdir(STATE_ROOT, { recursive: true });
  const temporary = `${RELEASE_VALIDATION_STATE_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, RELEASE_VALIDATION_STATE_PATH);
}

function heldOutRunSourceHash(run) {
  const source = JSON.stringify({
    schemaVersion: 'runtime-task-source/v1',
    taskId: run.id,
    task: run.task,
    title: run.title,
    createdAt: run.createdAt,
    workspace: run.workspaceRoot || null,
  });
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function heldOutCapabilityMatches(workCapability, run, requested = []) {
  const capabilities = Array.isArray(workCapability?.capabilities) ? workCapability.capabilities : [];
  const valid = new Set(capabilities.map((item) => String(item?.id || '')).filter(Boolean));
  const explicit = [...new Set((Array.isArray(requested) ? requested : []).map(String))].filter((id) => valid.has(id));
  if (explicit.length) return explicit;
  const task = String(run.task || '').toLowerCase();
  const scored = capabilities.map((item) => {
    const text = [item.title, item.summary, item.goal, ...(item.inputs || []), ...(item.outputs || [])].filter(Boolean).join(' ').toLowerCase();
    const terms = [...new Set(text.split(/[^a-z0-9\u3400-\u9fff]+/i).filter((term) => term.length >= 2))];
    return { id: String(item.id || ''), score: terms.reduce((total, term) => total + (task.includes(term) ? Math.min(term.length, 8) : 0), 0) };
  }).filter((item) => item.id && item.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((item) => item.id);
}

function heldOutOutputsFromRun(run) {
  const outputs = [];
  for (const change of Array.isArray(run.changeJournal) ? run.changeJournal : []) {
    outputs.push({ type: 'file-change', path: change.path || change.file || null, action: change.action || change.kind || 'modified', checkpointId: change.checkpointId || null });
  }
  for (const command of Array.isArray(run.commands) ? run.commands : []) {
    outputs.push({ type: 'command', command: command.command || command.cmd || null, passed: command.exitCode === 0 || command.status === 'success' });
  }
  if (run.result) outputs.push({ type: 'task-result', summary: String(run.result).slice(0, 4000) });
  return outputs.filter((item) => item.path || item.command || item.summary);
}

function heldOutCandidateFromRun(run, matchedCapabilities = []) {
  const verification = Array.isArray(run.verification) ? run.verification : [];
  return {
    id: `held-out-task-${run.id}`,
    sourceHash: heldOutRunSourceHash(run),
    sourceType: '独立本地任务执行记录',
    sourceTaskId: run.id,
    matchedCapabilities,
    outputs: heldOutOutputsFromRun(run),
    verification: {
      passed: verification.length > 0 && verification.every((item) => item.passed === true),
      checks: verification.map((item) => ({ id: item.id, passed: item.passed, commands: item.checks?.map?.((check) => check.command) || [] })),
    },
  };
}

async function persistHeldOutEvaluation(workCapability, current, candidate) {
  const existingCandidates = Array.isArray(current.heldOutCandidates) ? current.heldOutCandidates : [];
  const candidates = [...existingCandidates.filter((item) => item?.id !== candidate?.id && item?.sourceHash !== candidate?.sourceHash), candidate];
  const heldOutEvaluation = evaluateHeldOutSuite(workCapability, candidates);
  const resultFor = (value) => ({ status: value?.status || 'pending', reason: value?.reason || '缺少验证结果。', evidence: value?.status && value.status !== 'pending' ? [value.schemaVersion] : [] });
  const evaluation = evaluateWorkCapabilityGates(workCapability, { results: {
    G4: resultFor(current.deterministicReplay),
    G6: resultFor(current.originalTaskReplay),
    G7: resultFor(heldOutEvaluation),
    G9: resultFor(current.isolatedAgentValidation),
  } });
  const persisted = { schemaVersion: 'runtime-release-validation/v3', updatedAt: new Date().toISOString(), heldOutCandidates: candidates, heldOutEvaluation, evaluation };
  await persistReleaseValidationState(persisted);
  return { ...current, ...persisted };
}

async function releaseValidationPayload() {
  const persisted = await readReleaseValidationState();
  return {
    deterministicReplay: await readArtifactJson('deterministicReplay', null),
    originalTaskReplay: await readArtifactJson('originalTaskReplay', null),
    heldOutEvaluation: persisted?.heldOutEvaluation || await readArtifactJson('heldOutEvaluation', null),
    heldOutCandidates: persisted?.heldOutCandidates || [],
    isolatedAgentValidation: await readArtifactJson('isolatedAgentValidation', null),
    evaluation: persisted?.evaluation || await readArtifactJson('releaseDecision', null),
    updatedAt: persisted?.updatedAt || null,
  };
}

function toolAvailable(permission, workspace) {
  if (permission === '始终开放') return true;
  if (permission === '加载本机对话后自动开放') return true;
  if (permission === '选择有效工作区') return workspace.ready;
  if (permission === '开启文件写入') return workspace.ready && workspace.allowWrite;
  if (permission === '开启删除权限') return workspace.ready && workspace.allowWrite && workspace.allowDelete;
  if (permission === '开启命令执行') return workspace.ready && workspace.allowCommand;
  if (permission === '开启 Git 写入') return workspace.ready && workspace.allowCommand && workspace.allowGitWrite;
  if (permission === '开启网络访问') return workspace.allowNetwork;
  return false;
}

async function serveStatic(response, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(UI_ROOT, relative);
  const check = path.relative(UI_ROOT, filePath);
  if (check.startsWith('..') || path.isAbsolute(check) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const body = await fsp.readFile(filePath);
  sendBuffer(response, 200, body, MIME[path.extname(filePath)] || 'application/octet-stream');
  return true;
}

function taskIdFrom(pathname, suffix = '') {
  const pattern = suffix ? new RegExp(`^/api/runtime/tasks/([^/]+)/${suffix}$`) : /^\/api\/runtime\/tasks\/([^/]+)$/;
  return pathname.match(pattern)?.[1] || null;
}

function isLoopbackRequest(request) {
  const address = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function applyChatGptCompanionCors(request, response, url) {
  if (!url.pathname.startsWith('/api/runtime/chatgpt-web')) return false;
  const origin = String(request.headers.origin || '');
  if (/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'origin');
    response.setHeader('access-control-allow-headers', 'content-type, authorization');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }
  return false;
}

function publicLocalConversation(entry) {
  return {
    sessionId: entry.sessionId,
    title: entry.semanticTitle || entry.title || '未命名本机 Codex 对话',
    rawTitle: entry.rawTitle || entry.title || '',
    titleSource: entry.titleSource || '会话归档',
    modifiedAt: entry.modifiedAt,
    bytes: entry.bytes,
    domain: entry.domain || '工程任务',
    lifecycle: entry.lifecycle || '待理解',
    keywords: entry.keywords || [],
    recommendationScore: Number(entry.recommendationScore || 0),
    recommendationReasons: entry.recommendationReasons || [],
    taskChainId: entry.taskChainId || null,
    taskChainTitle: entry.taskChainTitle || null,
    taskChainSize: Number(entry.relatedSessionCount || entry.taskChainSize || 1),
  };
}

function shortLocalText(value, maximum = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function buildLoadedConversationContext(sessions) {
  const sourceSessions = sessions.map((item, sessionIndex) => ({
    index: sessionIndex + 1,
    sessionId: item.session.sessionId,
    title: item.session.title,
    summary: item.summary,
    stageCount: item.stages.length,
    stages: item.stages.map((stage) => ({ index: stage.index, title: stage.title, request: stage.request })),
  }));
  const sessionIndexText = sourceSessions.map((item) => [
    `【会话 ${item.index}】${item.title}`,
    item.summary,
    ...(item.stages || []).map((stage) => `P${stage.index}｜${stage.title}`),
  ].filter(Boolean).join('\n')).join('\n\n');
  const latestEvidenceText = sourceSessions.map((item) => {
    const latestStages = item.stages.slice(-2);
    return [
      `【会话 ${item.index} 的最新阶段】${item.title}`,
      ...latestStages.map((stage) => `P${stage.index}｜${stage.title}${stage.request ? `：${stage.request}` : ''}`),
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const taskPrefill = [
    `已自动加载 ${sourceSessions.length} 条本机 Codex 对话。下方是全部会话索引；开始执行时，Agent 还会自动读取每条会话的最新阶段摘要。`,
    sessionIndexText,
    '当前要完成的任务：',
  ].join('\n\n');
  const executionContext = [
    `本次任务已选择 ${sourceSessions.length} 条本机 Codex 对话。以下会话索引覆盖全部已选对话；每条对话的最新两个 P 阶段用于识别后续纠正和最终目标。`,
    '完整会话索引：',
    sessionIndexText,
    '最新阶段证据：',
    latestEvidenceText,
  ].join('\n\n');
  return {
    schemaVersion: '1.0',
    sessionCount: sourceSessions.length,
    stageCount: sourceSessions.reduce((total, item) => total + item.stageCount, 0),
    sessions: sourceSessions,
    taskPrefill: shortLocalText(taskPrefill, 18_000),
    executionBrief: shortLocalText(executionContext, 54_000),
  };
}

async function listLocalConversations({ limit = 50, offset = 0, query = '', force = false } = {}) {
  const requestedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const requestedOffset = Math.max(0, Number(offset) || 0);
  const needsRefresh = force || !localConversationIndex || Date.now() - localConversationsListedAt >= LOCAL_CONVERSATION_CACHE_MS;
  if (needsRefresh) {
    localConversationIndex = await buildSemanticSessionIndex({
      roots: LOCAL_SESSION_ROOTS,
      limit: 5000,
      cachePath: LOCAL_SESSION_INDEX_CACHE_PATH,
      force: force || Boolean(localConversationIndex),
    });
    localConversations.clear();
    for (const entry of localConversationIndex.sessions || []) {
      if (entry.sessionId && (entry.sourcePath || entry.path)) localConversations.set(String(entry.sessionId).toLowerCase(), entry);
    }
    localConversationsListedAt = Date.now();
  }
  const page = pageSemanticSessions(localConversationIndex, { limit: requestedLimit, offset: requestedOffset, query });
  return {
    ...page,
    items: (page.items || []).map(publicLocalConversation),
    taskChains: (localConversationIndex?.taskChains || []).slice(0, 12),
  };
}

async function listLocalTaskChains({ limit = 24, offset = 0, query = '', force = false } = {}) {
  await listLocalConversations({ limit: 1, offset: 0, force });
  return pageSemanticTaskChains(localConversationIndex, { limit, offset, query });
}

async function loadLocalConversationContext(payload = {}) {
  const sessionIds = [...new Set((Array.isArray(payload.sessionIds) ? payload.sessionIds : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f-]{16,}$/i.test(value)))];
  if (!sessionIds.length) throw new HttpError(400, 'session_required', '请先从本机 Codex 对话列表中选择至少一条对话。');
  if (!localConversations.size || sessionIds.some((id) => !localConversations.has(id))) await listLocalConversations({ limit: 50, force: true });
  const missing = sessionIds.filter((id) => !localConversations.has(id));
  if (missing.length) throw new HttpError(404, 'session_missing', `找不到已选本机对话：${missing.join('、')}。请重新搜索后再加载。`);

  const sessions = [];
  for (const sessionId of sessionIds) {
    const entry = localConversations.get(sessionId);
    const parsed = await parseCodexSessionFile(entry.sourcePath || entry.path, { redact: true });
    const analysis = analyseParsedSession(parsed, { includeEvidence: false });
    const stages = (analysis.episodes || []).slice(0, 12).map((episode) => ({
      index: episode.index,
      title: shortLocalText(episode.title || `P${episode.index}｜原会话需求`, 180),
      request: shortLocalText(episode.request || episode.requestContent || '', 700),
      tools: Array.isArray(episode.tools) ? episode.tools.slice(0, 12) : [],
    }));
    sessions.push({
      session: publicLocalConversation(entry),
      summary: analysis.presentation?.summary || '',
      statistics: analysis.summary,
      stages,
    });
  }

  const context = buildLoadedConversationContext(sessions);
  return {
    ok: true,
    loadedAt: new Date().toISOString(),
    sessions,
    context: {
      schemaVersion: context.schemaVersion,
      sessionCount: context.sessionCount,
      stageCount: context.stageCount,
      executionBrief: context.executionBrief,
    },
    taskPrefill: context.taskPrefill,
  };
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (applyChatGptCompanionCors(request, response, url)) return;
  if (request.method === 'GET' && ['/api/runtime/health', '/api/ai/status'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    sendJson(response, 200, { ok: true, service: 'root-conversation-capability-agent', package: evidence.blueprint.package, runtime: publicRuntimeConfig(), codexLink: await inspectCurrentCodex(), chatGptWeb: chatGptWeb.status(), localConversationDiscovery: true, localPathPicker: availablePathPickerKinds(), installation: inspectInstallation(AGENT_ROOT, STATE_ROOT), workspace: await publicWorkspaceConfig() });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/config', '/api/ai/config'].includes(url.pathname)) return sendJson(response, 200, publicRuntimeConfig());
  if (request.method === 'GET' && ['/api/runtime/installation', '/api/ai/installation'].includes(url.pathname)) return sendJson(response, 200, inspectInstallation(AGENT_ROOT, STATE_ROOT));
  if (request.method === 'PUT' && ['/api/runtime/config', '/api/ai/config'].includes(url.pathname)) return sendJson(response, 200, updateRuntimeConfig(await readBody(request)));
  if (request.method === 'GET' && ['/api/runtime/codex-link', '/api/ai/codex-link'].includes(url.pathname)) return sendJson(response, 200, await inspectCurrentCodex());
  if (request.method === 'POST' && ['/api/runtime/codex-link', '/api/ai/codex-link'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '自动连接当前 Codex 只能从本机访问。');
    return sendJson(response, 200, await connectCurrentCodex());
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/chatgpt-web') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '网页聊天记录连接状态只能从本机读取。');
    return sendJson(response, 200, chatGptWeb.status());
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/open') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机打开网页聊天平台。');
    return sendJson(response, 200, chatGptWeb.openWebChat(await readBody(request)));
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/companion/open-folder') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机打开浏览器伴侣文件夹。');
    return sendJson(response, 200, chatGptWeb.openCompanionFolder());
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/companion/open-extensions') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机打开浏览器扩展管理页。');
    const payload = await readBody(request);
    return sendJson(response, 200, chatGptWeb.openBrowserExtensions(payload?.browser || 'auto'));
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/companion/setup') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机启动浏览器伴侣首次准备。');
    return sendJson(response, 200, chatGptWeb.setupCompanion(await readBody(request)));
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/disconnect') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机断开网页聊天记录连接。');
    return sendJson(response, 200, chatGptWeb.disconnect());
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/pair') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '浏览器伴侣只能与本机 Agent 配对。');
    return sendJson(response, 200, chatGptWeb.pair(await readBody(request)));
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/heartbeat') {
    return sendJson(response, 200, chatGptWeb.heartbeat(request, await readBody(request)));
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/chatgpt-web/jobs/next') {
    return sendJson(response, 200, chatGptWeb.nextJob(request));
  }
  const chatGptCompleteJobId = url.pathname.match(/^\/api\/runtime\/chatgpt-web\/jobs\/([^/]+)\/complete$/)?.[1];
  if (request.method === 'POST' && chatGptCompleteJobId) {
    return sendJson(response, 200, chatGptWeb.complete(request, decodeURIComponent(chatGptCompleteJobId), await readBody(request)));
  }
  if (request.method === 'POST' && url.pathname === '/api/runtime/chatgpt-web/jobs') {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机向网页聊天平台发送任务。');
    return sendJson(response, 201, chatGptWeb.enqueue(await readBody(request)));
  }
  const chatGptJobId = url.pathname.match(/^\/api\/runtime\/chatgpt-web\/jobs\/([^/]+)$/)?.[1];
  if (request.method === 'GET' && chatGptJobId) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '只能从本机读取网页聊天任务结果。');
    return sendJson(response, 200, chatGptWeb.getJob(decodeURIComponent(chatGptJobId)));
  }
  if (request.method === 'GET' && ['/api/runtime/local-sessions', '/api/ai/local-sessions'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '本机 Codex 对话只能从本机独立界面加载。');
    const page = await listLocalConversations({
      limit: Number(url.searchParams.get('limit')) || 50,
      offset: Number(url.searchParams.get('offset')) || 0,
      query: url.searchParams.get('q') || '',
      force: url.searchParams.get('refresh') === '1',
    });
    return sendJson(response, 200, {
      ok: true,
      sessions: page.items,
      total: page.total,
      totalAvailable: page.totalAvailable || page.total,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.nextOffset,
      taskChains: page.taskChains,
      source: '本机 Codex 对话归档（全量语义索引）',
      refreshedAt: new Date(localConversationsListedAt).toISOString(),
    });
  }
  if (request.method === 'GET' && ['/api/runtime/task-chains', '/api/ai/task-chains'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '本机 Codex 任务链只能从本机独立界面读取。');
    const page = await listLocalTaskChains({
      limit: Number(url.searchParams.get('limit')) || 24,
      offset: Number(url.searchParams.get('offset')) || 0,
      query: url.searchParams.get('q') || '',
      force: url.searchParams.get('refresh') === '1',
    });
    return sendJson(response, 200, {
      ok: true,
      taskChains: page.items,
      total: page.total,
      totalAvailable: page.totalAvailable || page.total,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.nextOffset,
      source: '本机 Codex 对话全量语义任务链',
      refreshedAt: new Date(localConversationsListedAt).toISOString(),
    });
  }
  if (request.method === 'POST' && ['/api/runtime/local-sessions/load', '/api/ai/local-sessions/load'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '本机 Codex 对话只能从本机独立界面加载。');
    return sendJson(response, 200, await loadLocalConversationContext(await readBody(request)));
  }
  if (request.method === 'POST' && ['/api/runtime/path-picker', '/api/ai/path-picker'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '本机文件选择窗口只能从本机独立界面打开。');
    const payload = await readBody(request);
    const kind = String(payload.kind || '');
    if (!availablePathPickerKinds().includes(kind)) throw new HttpError(400, 'invalid_path_picker_kind', '选择类型无效。');
    return sendJson(response, 200, { ok: true, paths: await selectLocalPaths(kind) });
  }
  if (request.method === 'GET' && ['/api/runtime/models', '/api/ai/models', '/v1/models'].includes(url.pathname)) return sendJson(response, 200, await listModels(request.signal));
  if (request.method === 'GET' && ['/api/runtime/workspace', '/api/ai/workspace'].includes(url.pathname)) return sendJson(response, 200, await publicWorkspaceConfig());
  if (request.method === 'PUT' && ['/api/runtime/workspace', '/api/ai/workspace'].includes(url.pathname)) return sendJson(response, 200, await updateWorkspaceConfig(await readBody(request)));
  if (request.method === 'GET' && ['/api/runtime/capabilities', '/api/runtime/context', '/api/ai/context'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    const compact = url.searchParams.get('compact') === '1';
    const payload = {
      package: evidence.blueprint.package,
      selection: evidence.blueprint.selection,
      contract: evidence.contract,
      statistics: evidence.extraction.statistics,
      recommendation: await readArtifactJson('recommendation', evidence.blueprint.distillationRecommendation || null),
    };
    if (!compact) {
      payload.sourceSessions = await readArtifactJson('sourceSessions', evidence.blueprint.selection?.sessions || []);
      payload.projectPortfolio = await readArtifactJson('projectPortfolio', evidence.blueprint.projectPortfolio || null);
      payload.projectEvidence = await readArtifactJson('projectEvidence', null);
      payload.projectUnderstanding = await readArtifactJson('projectUnderstanding', null);
      payload.projectKnowledgeV4 = await getProjectKnowledgeV4(AGENT_ROOT, { group: '摘要' });
    }
    return sendJson(response, 200, payload);
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/codex-alignment') {
    const evidence = await loadEvidence(AGENT_ROOT);
    return sendJson(response, 200, evidence.contract.codexAlignment || { title: 'Codex 工程能力对齐图', domains: [] });
  }
  if (request.method === 'GET' && ['/api/runtime/distillation', '/api/ai/distillation'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    const compact = url.searchParams.get('compact') === '1';
    let conversationDistillation = evidence.blueprint.conversationDistillation || null;
    if (!conversationDistillation) {
      try { conversationDistillation = JSON.parse(await fsp.readFile(path.join(AGENT_ROOT, 'conversation-distillation.json'), 'utf8')); } catch {}
    }
    const payload = {
      conversationDistillation,
      recommendation: await readArtifactJson('recommendation', evidence.blueprint.distillationRecommendation || null),
      requirementEvolution: evidence.extraction.requirementEvolution,
      corrections: evidence.extraction.corrections,
      strengths: evidence.extraction.strengths,
      weaknesses: evidence.extraction.weaknesses,
      improvedWorkflow: evidence.extraction.improvedWorkflow,
      acceptanceMatrix: evidence.extraction.acceptanceMatrix,
      recoveryRules: evidence.extraction.recoveryRules,
      statistics: evidence.extraction.statistics,
    };
    if (!compact) {
      payload.sourceSessions = await readArtifactJson('sourceSessions', evidence.blueprint.selection?.sessions || []);
      payload.projectPortfolio = await readArtifactJson('projectPortfolio', evidence.blueprint.projectPortfolio || null);
      payload.projectEvidence = await readArtifactJson('projectEvidence', null);
      payload.projectUnderstanding = await readArtifactJson('projectUnderstanding', null);
      payload.projectKnowledgeV4 = await getProjectKnowledgeV4(AGENT_ROOT, { group: '摘要' });
    }
    return sendJson(response, 200, payload);
  }
  if (request.method === 'GET' && ['/api/runtime/recommendation', '/api/ai/recommendation'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    return sendJson(response, 200, { recommendation: await readArtifactJson('recommendation', evidence.blueprint.distillationRecommendation || null) });
  }
  if (request.method === 'GET' && ['/api/runtime/work-capability', '/api/ai/work-capability'].includes(url.pathname)) {
    const workCapability = await readArtifactJson('workCapability', null);
    const validation = await releaseValidationPayload();
    const evaluation = validation.evaluation;
    return sendJson(response, 200, {
      available: Boolean(workCapability),
      workCapability,
      coverageMatrix: workCapability?.coverageMatrix || await readArtifactJson('coverageMatrix', null),
      evaluation,
      deterministicReplay: await readArtifactJson('deterministicReplay', null),
    });
  }
  if (request.method === 'GET' && ['/api/runtime/coverage-gaps', '/api/ai/coverage-gaps'].includes(url.pathname)) {
    return sendJson(response, 200, await readCoverageGapRegister());
  }
  const coverageGapActionId = url.pathname.match(/^\/api\/(?:runtime|ai)\/coverage-gaps\/([^/]+)\/actions$/)?.[1];
  if (request.method === 'POST' && coverageGapActionId) {
    const payload = await readBody(request);
    const register = await readCoverageGapRegister();
    const gapId = decodeURIComponent(coverageGapActionId);
    const gap = register.gaps.find((item) => item.gapId === gapId);
    if (!gap) throw new HttpError(404, '没有找到对应的数据缺口。');
    const updated = transitionCoverageGap(gap, String(payload.action || ''), {
      note: payload.note,
      evidenceRefs: payload.evidenceRefs,
    });
    await persistCoverageGap(updated);
    return sendJson(response, 200, { gap: updated, summary: summarizeCoverageGaps(register.gaps.map((item) => item.gapId === gapId ? updated : item)) });
  }
  if (request.method === 'GET' && ['/api/runtime/semantic-evaluation-plan', '/api/ai/semantic-evaluation-plan'].includes(url.pathname)) {
    return sendJson(response, 200, await readArtifactJson('semanticEvaluationPlan', null));
  }
  if (request.method === 'GET' && ['/api/runtime/release-validation', '/api/ai/release-validation'].includes(url.pathname)) {
    return sendJson(response, 200, await releaseValidationPayload());
  }
  if (request.method === 'POST' && ['/api/runtime/release-validation/held-out', '/api/ai/release-validation/held-out'].includes(url.pathname)) {
    const workCapability = await readArtifactJson('workCapability', null);
    if (!workCapability) throw new HttpError(409, '当前能力包没有 Work Capability IR v2。');
    const candidate = await readBody(request);
    const current = await releaseValidationPayload();
    return sendJson(response, 200, await persistHeldOutEvaluation(workCapability, current, candidate));
  }
  if (request.method === 'POST' && ['/api/runtime/release-validation/from-task', '/api/ai/release-validation/from-task'].includes(url.pathname)) {
    if (!isLoopbackRequest(request)) throw new HttpError(403, 'local_only', '留出任务验收只能从本机提交。');
    const workCapability = await readArtifactJson('workCapability', null);
    if (!workCapability) throw new HttpError(409, 'work_capability_missing', '当前能力包没有 Work Capability IR v2。');
    const payload = await readBody(request);
    const taskId = String(payload?.taskId || '').trim();
    if (!taskId) throw new HttpError(400, 'task_required', '请先选择一项已经完成的本地任务。');
    const run = await loadRun(STATE_ROOT, taskId);
    const candidate = heldOutCandidateFromRun(run, heldOutCapabilityMatches(workCapability, run, payload?.matchedCapabilities));
    const current = await releaseValidationPayload();
    const result = await persistHeldOutEvaluation(workCapability, current, candidate);
    return sendJson(response, 200, { ...result, candidate });
  }
  if (request.method === 'GET' && ['/api/runtime/sources', '/api/ai/sources'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    return sendJson(response, 200, { sessions: await readArtifactJson('sourceSessions', evidence.blueprint.selection?.sessions || []) });
  }
  if (request.method === 'GET' && ['/api/runtime/project-portfolio', '/api/ai/project-portfolio'].includes(url.pathname)) {
    return sendJson(response, 200, { projectPortfolio: await readArtifactJson('projectPortfolio', null) });
  }
  if (request.method === 'GET' && ['/api/runtime/project-evidence', '/api/ai/project-evidence'].includes(url.pathname)) {
    return sendJson(response, 200, { projectEvidence: await readArtifactJson('projectEvidence', null) });
  }
  if (request.method === 'GET' && ['/api/runtime/project-understanding', '/api/ai/project-understanding'].includes(url.pathname)) {
    return sendJson(response, 200, { projectUnderstanding: await readArtifactJson('projectUnderstanding', null) });
  }
  if (request.method === 'GET' && ['/api/runtime/project-knowledge-v4', '/api/ai/project-knowledge-v4'].includes(url.pathname)) {
    return sendJson(response, 200, await getProjectKnowledgeV4(AGENT_ROOT, Object.fromEntries(url.searchParams)));
  }
  if (request.method === 'GET' && ['/api/runtime/conversation/search', '/api/ai/conversation/search'].includes(url.pathname)) return sendJson(response, 200, await searchConversation(AGENT_ROOT, Object.fromEntries(url.searchParams)));
  if (request.method === 'GET' && url.pathname.startsWith('/api/runtime/conversation/stages/')) return sendJson(response, 200, await getStage(AGENT_ROOT, { stage: Number(url.pathname.split('/').at(-1)) }));
  if (request.method === 'GET' && url.pathname === '/api/runtime/conversation/corrections') return sendJson(response, 200, await getLatestCorrections(AGENT_ROOT));
  if (request.method === 'GET' && url.pathname === '/api/runtime/workflow') return sendJson(response, 200, await getImprovedWorkflow(AGENT_ROOT));
  if (request.method === 'GET' && ['/api/runtime/tools', '/api/ai/tools'].includes(url.pathname)) {
    const evidence = await loadEvidence(AGENT_ROOT);
    const workspace = await publicWorkspaceConfig();
    const dynamicContextTool = localConversationContextToolDefinition().function;
    const runtimeTools = [
      ...evidence.contract.tools,
      {
        name: dynamicContextTool.name,
        label: '读取已选会话上下文',
        category: '本机对话理解',
        description: '执行时按会话、关键词或阶段继续读取用户刚选择的本机多会话证据；长任务链不会只依赖输入框中可见的文本。',
        permission: '加载本机对话后自动开放',
      },
    ];
    return sendJson(response, 200, { tools: runtimeTools.map((tool) => ({ ...tool, available: toolAvailable(tool.permission, workspace) })), workspace });
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/processes') return sendJson(response, 200, { processes: getManagedProcesses() });
  const processStopId = url.pathname.match(/^\/api\/runtime\/processes\/([^/]+)\/stop$/)?.[1];
  if (request.method === 'POST' && processStopId) return sendJson(response, 200, await stopManagedProcess(processStopId));
  if (request.method === 'GET' && url.pathname === '/api/runtime/tasks') return sendJson(response, 200, { tasks: await listRuns(STATE_ROOT, Number(url.searchParams.get('limit')) || 100) });
  if (request.method === 'POST' && url.pathname === '/api/runtime/tasks') return sendJson(response, 201, publicRun(await createRun(STATE_ROOT, await readBody(request))));
  const taskId = taskIdFrom(url.pathname);
  if (request.method === 'GET' && taskId) return sendJson(response, 200, publicRun(await loadRun(STATE_ROOT, taskId)));
  const continueId = taskIdFrom(url.pathname, 'continue');
  if (request.method === 'POST' && continueId) {
    const run = await loadRun(STATE_ROOT, continueId);
    const payload = await readBody(request);
    const write = startSse(response);
    await executeRun({ agentRoot: AGENT_ROOT, stateRoot: STATE_ROOT, run, workspace: await publicWorkspaceConfig(), send: write, continuation: String(payload.message || '') }).catch(() => {});
    response.end();
    return;
  }
  const cancelId = taskIdFrom(url.pathname, 'cancel');
  if (request.method === 'POST' && cancelId) {
    const cancelled = cancelRun(cancelId);
    const run = await loadRun(STATE_ROOT, cancelId);
    if (!cancelled && !['完成', '失败', '已停止'].includes(run.status)) { run.status = '已停止'; run.phase = '已停止'; await saveRun(STATE_ROOT, run); }
    return sendJson(response, 200, { cancelled: true, task: publicRun(run) });
  }
  if (request.method === 'POST' && ['/api/runtime/agent', '/api/ai/agent'].includes(url.pathname)) {
    const payload = await readBody(request);
    const run = payload.taskId ? await loadRun(STATE_ROOT, payload.taskId) : await createRun(STATE_ROOT, payload);
    const write = startSse(response);
    write('task_created', { taskId: run.id, task: publicRun(run) });
    await executeRun({ agentRoot: AGENT_ROOT, stateRoot: STATE_ROOT, run, workspace: await publicWorkspaceConfig(), send: write, continuation: String(payload.continuation || '') }).catch(() => {});
    response.end();
    return;
  }
  const checkpointId = url.pathname.match(/^\/api\/runtime\/checkpoints\/([^/]+)\/restore$/)?.[1];
  if (request.method === 'POST' && checkpointId) return sendJson(response, 200, await restoreCheckpoint(STATE_ROOT, checkpointId));
  if (request.method === 'POST' && ['/api/runtime/chat', '/api/ai/chat', '/v1/chat/completions'].includes(url.pathname)) {
    const payload = await readBody(request);
    if (payload.stream) return proxyStreamingChat({ ...payload, model: payload.model || runtimeConfig.model }, response, request.signal);
    return sendJson(response, 200, await chatCompletion({ ...payload, model: payload.model || runtimeConfig.model }, request.signal));
  }
  if (request.method === 'GET' && url.pathname === '/api/artifact') {
    const filePath = ARTIFACTS.get(url.searchParams.get('name'));
    if (!filePath || !fs.existsSync(filePath)) throw new HttpError(404, 'artifact_not_found', '找不到这个能力包文件。');
    const body = await fsp.readFile(filePath);
    return sendBuffer(response, 200, body, MIME[path.extname(filePath)] || 'application/octet-stream');
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (request.method === 'GET' && await serveStatic(response, url.pathname)) return;
  throw new HttpError(404, 'not_found', '找不到请求的页面或接口。');
}

await fsp.mkdir(path.join(STATE_ROOT, 'runs'), { recursive: true });
server = http.createServer((request, response) => route(request, response).catch((error) => {
  const payload = errorPayload(error);
  if (!response.headersSent) sendJson(response, payload.status, payload.body);
  else response.end();
}));
server.listen(PORT, HOST, () => process.stdout.write(`根能力包独立 Agent 已启动：http://${HOST}:${server.address().port}/\n`));
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forcedExit = setTimeout(() => process.exit(0), 1500);
  forcedExit.unref();
  server.close(() => {
    clearTimeout(forcedExit);
    process.exit(0);
  });
  server.closeIdleConnections?.();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
