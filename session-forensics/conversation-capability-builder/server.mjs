import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_LIB_ROOT = path.join(APP_ROOT, 'lib');
const LIB_ROOT = fs.existsSync(path.join(BUNDLED_LIB_ROOT, 'root-capability-packager.mjs'))
  ? BUNDLED_LIB_ROOT
  : path.join(APP_ROOT, '..', 'lib');
const { packageConversationV2, previewConversationCapabilityV2 } = await import(pathToFileURL(path.join(LIB_ROOT, 'root-capability-packager.mjs')).href);
const { buildSemanticSessionIndex, pageSemanticSessions, pageSemanticTaskChains } = await import(pathToFileURL(path.join(LIB_ROOT, 'session-semantic-index.mjs')).href);
const { distillationRecommendationHtml, distillationRecommendationMarkdown } = await import(pathToFileURL(path.join(LIB_ROOT, 'distillation-recommendation.mjs')).href);
const { availablePathPickerKinds, selectLocalPaths } = await import(pathToFileURL(path.join(LIB_ROOT, 'local-path-picker.mjs')).href);

const HOST = process.env.CONVERSATION_BUILDER_HOST || '127.0.0.1';
const PORT = Number(process.env.CONVERSATION_BUILDER_PORT || process.env.PORT || 0);
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_ROOT = path.resolve(process.env.CONVERSATION_BUILDER_STATE_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'ConversationCapabilityBuilder')
  : path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'conversation-capability-builder')));
const IMPORT_ROOT = path.join(STATE_ROOT, 'imports');
const GENERATED_ROOT = path.join(STATE_ROOT, 'generated');
const SEMANTIC_INDEX_PATH = path.join(STATE_ROOT, 'session-semantic-index.json');
const PACKAGE_CATALOG_PATH = path.join(STATE_ROOT, 'package-catalog.json');
const UI_ROOT = path.join(APP_ROOT, 'ui');
const LOCAL_SESSION_ROOTS = String(process.env.CODEX_SESSION_ROOT || process.env.CODEX_SESSION_ROOTS || '')
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = 45 * 1024 * 1024;
const imports = new Map();
const packages = new Map();
const agentProcesses = new Map();
const localSessions = new Map();
let localSessionsListedAt = 0;
let localSessionIndex = null;
let packageCatalog = [];
const LOCAL_SESSION_CACHE_MS = 30_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.zip': 'application/zip' };

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(body);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(body);
}

function isLoopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function safeId(value) {
  return /^[a-z0-9-]{12,80}$/.test(String(value || '')) ? String(value) : null;
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('请求内容超过 45 MB，请先压缩或拆分对话文件。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求不是有效的 JSON。');
  }
}

function aiOptions(payload = {}) {
  const ai = payload.ai && typeof payload.ai === 'object' ? payload.ai : {};
  return {
    enabled: ai.enabled !== false,
    baseUrl: String(ai.baseUrl || '').trim(),
    model: String(ai.model || '').trim(),
    apiKey: String(ai.apiKey || '').trim(),
    timeoutMs: Number(ai.timeoutMs) || 45000,
  };
}

function publicExtraction(extraction = {}) {
  return {
    statistics: extraction.statistics || {},
    stages: (extraction.stages || []).map((stage) => ({
      index: stage.index,
      title: stage.title,
      request: stage.request,
      assistantMessages: (stage.assistantMessages || []).slice(-3),
      tools: stage.tools || [],
    })),
    corrections: extraction.corrections || [],
    strengths: extraction.strengths || [],
    weaknesses: extraction.weaknesses || [],
    improvedWorkflow: extraction.improvedWorkflow || [],
    acceptanceMatrix: extraction.acceptanceMatrix || [],
  };
}

function publicPreview(importId, result) {
  return {
    ok: true,
    importId,
    runId: importId,
    identity: result.identity,
    ui: result.ui,
    extraction: publicExtraction(result.extraction),
    sourceSet: result.sourceSet || null,
    projectDiscovery: result.projectDiscovery || null,
    projectEvidence: result.projectEvidence ? {
      project: result.projectEvidence.project,
      git: result.projectEvidence.git,
      summary: result.projectEvidence.summary,
      modifiedFiles: result.projectEvidence.modifiedFiles,
      generatedFiles: result.projectEvidence.generatedFiles,
    } : null,
    projectKnowledgeV4: result.projectKnowledgeV4 || null,
    recommendation: result.recommendation || null,
    source: { sourcePath: result.source.sourcePath, sessionId: result.parsed.sessionId, recordCount: result.parsed.records?.length || 0 },
    links: runLinks(importId),
    next: '检查会话专属标题、目标、输入、交付物、语义阶段、项目知识和后续修正；确认后点击生成能力包。',
  };
}

function runLinks(importId) {
  const encoded = encodeURIComponent(importId);
  return {
    self: `/api/v2/runs/${encoded}`,
    recommendation: `/api/v2/runs/${encoded}/recommendation`,
    recommendationMarkdown: `/api/v2/runs/${encoded}/recommendation.md`,
    recommendationHtml: `/api/v2/runs/${encoded}/recommendation.html`,
    package: `/api/v2/runs/${encoded}/package`,
  };
}

function publicPackage(id, result) {
  const delivery = result.package.delivery || {};
  const description = result.package.description || {};
  return {
    ok: true,
    packageId: id,
    name: result.package.name,
    skill: delivery.skill ? { directory: delivery.skill.root, file: delivery.skill.file } : null,
    mcp: delivery.mcp ? { directory: delivery.mcp.root, server: delivery.mcp.server, config: delivery.mcp.config } : null,
    agent: delivery.agent ? { directory: delivery.agent.root, server: delivery.agent.server, ui: delivery.agent.ui?.index, readme: delivery.agent.readme, start: delivery.agent.startCommand, projectKnowledgeV4: delivery.agent.projectKnowledge?.overview || null, projectKnowledgeV4Markdown: delivery.agent.projectKnowledge?.markdown || null } : null,
    projectKnowledgeV4: delivery.projectKnowledgeV4 || result.package.projectKnowledgeV4 || null,
    projectKnowledgeV4Summary: result.package.projectKnowledgeV4Summary || null,
    recommendation: result.package.recommendation || null,
    description: {
      summary: description.summary || '',
      namingExplanation: description.namingExplanation || '',
      phases: description.phases || [],
      specializedCapabilities: description.specializedCapabilities || [],
      expertise: description.expertise || [],
    },
    priorityPlan: delivery.recommendation || null,
    guide: delivery.guide,
    root: result.package.root,
    archive: `/api/v3/packages/${id}/download`,
    legacyArchive: `/api/download/${id}`,
    directArchivePath: result.package.archive,
    documents: packageDocumentLinks(id),
    install: '下载 ZIP，解压后先阅读 README.md；Agent 可运行 install-and-start.cmd 或 launch.cmd。',
  };
}

function packageDocumentLinks(packageId) {
  const encoded = encodeURIComponent(packageId);
  return {
    readme: `/api/v3/packages/${encoded}/documents/README.md`,
    distillation: `/api/v3/packages/${encoded}/documents/conversation-distillation.md`,
    priorityPlan: `/api/v3/packages/${encoded}/documents/PRIORITY-PLAN.md`,
    manifest: `/api/v3/packages/${encoded}/documents/package-manifest.json`,
  };
}

function catalogEntry(packageId, result, createdAt = new Date().toISOString()) {
  const packageInfo = result.package || result;
  const description = packageInfo.description || {};
  const sourceSet = packageInfo.sourceSet || {};
  const delivery = packageInfo.delivery || {};
  const declaredTargets = Array.isArray(packageInfo.targets) ? packageInfo.targets : [];
  const targets = declaredTargets.length
    ? ['skill', 'mcp', 'agent'].filter((target) => declaredTargets.includes(target))
    : ['skill', 'mcp', 'agent'].filter((target) => Boolean(delivery[target]));
  return {
    id: packageId,
    name: packageInfo.name || '未命名能力包',
    createdAt,
    root: packageInfo.root,
    archivePath: packageInfo.archive || delivery.archive || null,
    sourceCount: Number(sourceSet.sessionCount || 1),
    sourceMode: sourceSet.mode || 'whole-session',
    summary: String(description.summary || '').slice(0, 1200),
    namingExplanation: String(description.namingExplanation || '').slice(0, 1200),
    phases: (description.phases || []).slice(0, 16).map((item) => ({ index: item.index, title: item.title })),
    expertise: (description.expertise || []).slice(0, 12).map((item) => ({ phase: item.phase, capability: item.capability, deliverable: item.deliverable })),
    targets,
    hasAgent: Boolean(delivery.agent) || targets.includes('agent'),
  };
}

function descriptionFromDistillation(distillation = {}) {
  const specializations = Array.isArray(distillation.specializedCapabilities) ? distillation.specializedCapabilities : [];
  const expertise = Array.isArray(distillation.distilledExpertise) ? distillation.distilledExpertise : [];
  return {
    summary: String(distillation.summary || '').slice(0, 1200),
    namingExplanation: '该能力包的名称和说明从归档的会话蒸馏结果恢复，包含原会话主题、P 阶段、实际工具与项目证据。',
    phases: specializations.slice(0, 16).map((item, index) => ({ index: index + 1, title: item.title || `${item.phase || `P${index + 1}`}｜会话专属能力` })),
    expertise: expertise.slice(0, 12).map((item) => ({ phase: item.phase, capability: item.capability, deliverable: item.deliverable })),
  };
}

function descriptionFromLegacyManifest(packageMetadata = {}, selection = {}, extraction = {}) {
  const naming = packageMetadata.naming || {};
  const topics = Array.isArray(naming.contentTopics) ? naming.contentTopics.filter(Boolean) : [];
  const toolTerms = Array.isArray(naming.toolTerms) ? naming.toolTerms.filter(Boolean) : [];
  const stages = Array.isArray(extraction.stages) ? extraction.stages : [];
  const phases = stages.slice(0, 16).map((stage, index) => {
    const request = String(stage.request || '').replace(/\s+/g, ' ').trim();
    const readableRequest = request && !/^\?+[,，?]*$/u.test(request) ? request.slice(0, 140) : '';
    return { index: index + 1, title: `P${index + 1}｜${readableRequest || stage.title || '复原的会话执行阶段'}` };
  });
  const capability = topics.join('、') || packageMetadata.name || '已恢复的会话执行能力';
  return {
    summary: `这是从历史归档恢复的能力包，来源为 ${Number(selection.sessionCount || 1)} 条完整会话、${Number(selection.recordCount || 0)} 条记录。它保留了原始任务证据、工具轨迹和可复核的交付入口。`,
    namingExplanation: `历史包名称来自${topics.length ? `会话主题“${topics.join('、')}”` : '原会话归档'}，实际观测到的执行方式为${toolTerms.length ? toolTerms.join('、') : '会话证据复核'}。重新蒸馏后可获得更细的 P 阶段和项目文件说明。`,
    phases: phases.length ? phases : [{ index: 1, title: 'P1｜复原原会话目标与执行证据' }],
    expertise: [{ phase: 'P1', capability, deliverable: '可继续使用、重新蒸馏或下载的历史能力包。' }],
  };
}

async function writePackageCatalog() {
  const temporary = `${PACKAGE_CATALOG_PATH}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify({ schemaVersion: '1.0.0', packages: packageCatalog }, null, 2) + '\n', 'utf8');
  await fsp.rename(temporary, PACKAGE_CATALOG_PATH);
}

async function restorePackageCatalog() {
  try {
    const cached = JSON.parse(await fsp.readFile(PACKAGE_CATALOG_PATH, 'utf8'));
    packageCatalog = Array.isArray(cached?.packages) ? cached.packages.filter((entry) => entry?.id && entry?.root) : [];
  } catch {
    packageCatalog = [];
  }
  let entries = [];
  try {
    entries = await fsp.readdir(GENERATED_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  const knownRoots = new Map(packageCatalog.map((entry, index) => [path.resolve(entry.root), index]));
  let changed = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(GENERATED_ROOT, entry.name);
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package-manifest.json'), 'utf8'));
      let distillation = {};
      let extraction = {};
      try { distillation = JSON.parse(await fsp.readFile(path.join(root, 'conversation-distillation.json'), 'utf8')); } catch { /* older packages can omit this optional file */ }
      try { extraction = JSON.parse(await fsp.readFile(path.join(root, 'conversation-extraction.json'), 'utf8')); } catch { /* older packages can omit this optional file */ }
      const existingIndex = knownRoots.get(path.resolve(root));
      const existing = existingIndex === undefined ? null : packageCatalog[existingIndex];
      const packageId = existing?.id || `restored-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
      const packageMetadata = manifest.package || {};
      const distilledDescription = descriptionFromDistillation(distillation);
      const description = packageMetadata.description || manifest.description
        || (distilledDescription.summary || distilledDescription.phases.length ? distilledDescription : descriptionFromLegacyManifest(packageMetadata, manifest.selection || {}, extraction));
      const delivery = manifest.delivery || packageMetadata.delivery || {};
      const result = {
        package: {
          name: packageMetadata.name || manifest.identity?.name || entry.name,
          root,
          archive: path.join(GENERATED_ROOT, `${entry.name}.zip`),
          sourceSet: manifest.sourceSet || manifest.sources || { sessionCount: manifest.selection?.sessionCount || 1, mode: manifest.selection?.mode || 'whole-session' },
          description,
          delivery,
          targets: packageMetadata.targets || manifest.targets || [],
        },
      };
      const restored = catalogEntry(packageId, result, existing?.createdAt || manifest.generatedAt || (await fsp.stat(root)).mtime.toISOString());
      if (existingIndex === undefined) {
        packageCatalog.push(restored);
        changed = true;
      } else if (!existing.summary || !existing.namingExplanation || !Array.isArray(existing.targets) || !existing.targets.length || !existing.hasAgent) {
        packageCatalog[existingIndex] = restored;
        changed = true;
      }
    } catch {
      // Ignore unrelated directories and incomplete package writes.
    }
  }
  packageCatalog.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  if (changed) await writePackageCatalog();
}

function catalogPackage(packageId, result) {
  const entry = catalogEntry(packageId, result);
  packageCatalog = [entry, ...packageCatalog.filter((item) => item.id !== packageId)].slice(0, 300);
  return entry;
}

function findCatalogPackage(packageId) {
  return packageCatalog.find((entry) => entry.id === packageId) || null;
}

function isChildPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isRunningAgent(record) {
  return Boolean(record?.child && record.child.exitCode === null && !record.child.killed);
}

function catalogAgentStatus(catalog) {
  const record = catalog ? agentProcesses.get(catalog.id) : null;
  const running = isRunningAgent(record);
  return {
    available: Boolean(catalog?.hasAgent),
    running,
    starting: Boolean(running && !record?.url),
    url: record?.url || null,
    startedAt: record?.startedAt || null,
    error: record?.error || null,
  };
}

function agentStartupUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error, url = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url);
    };
    const capture = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-6000);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    };
    const timer = setTimeout(() => finish(new Error(`独立 Agent 启动超时。${output ? `启动输出：${output}` : ''}`)), 12_000);
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(`独立 Agent 在启动前退出（${signal || `退出码 ${code}`}）。${output ? `启动输出：${output}` : ''}`));
    });
  });
}

async function startCatalogAgent(catalog) {
  if (!catalog?.hasAgent) throw new Error('这个能力包没有生成独立 Agent，请重新生成时勾选“独立 Agent”。');
  const existing = agentProcesses.get(catalog.id);
  if (isRunningAgent(existing)) {
    const ready = await existing.ready;
    return { ...catalogAgentStatus(catalog), reused: true, url: ready.url || existing.url };
  }
  const packageRoot = path.resolve(catalog.root);
  const agentRoot = path.resolve(packageRoot, 'agent');
  const agentServer = path.resolve(agentRoot, 'agent-server.mjs');
  if (!isChildPath(packageRoot, agentRoot) || !isChildPath(agentRoot, agentServer) || !fs.existsSync(agentServer)) {
    throw new Error('能力包的独立 Agent 文件不完整。请重新生成该能力包后再启动。');
  }
  const child = spawn(process.execPath, [agentServer], {
    cwd: agentRoot,
    env: { ...process.env, PORT: '0', CONVERSATION_AGENT_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const record = { child, startedAt: new Date().toISOString(), url: null, error: null, ready: null };
  agentProcesses.set(catalog.id, record);
  record.ready = agentStartupUrl(child)
    .then((url) => {
      record.url = url;
      return record;
    })
    .catch((error) => {
      record.error = String(error?.message || error);
      if (agentProcesses.get(catalog.id) === record) agentProcesses.delete(catalog.id);
      if (isRunningAgent(record)) record.child.kill('SIGTERM');
      throw error;
    });
  child.once('exit', () => {
    if (agentProcesses.get(catalog.id) === record) agentProcesses.delete(catalog.id);
  });
  const ready = await record.ready;
  return { ...catalogAgentStatus(catalog), reused: false, url: ready.url };
}

async function stopCatalogAgent(catalog) {
  const record = catalog ? agentProcesses.get(catalog.id) : null;
  if (!record || !isRunningAgent(record)) return { ...catalogAgentStatus(catalog), stopped: false };
  const exited = new Promise((resolve) => record.child.once('exit', resolve));
  record.child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (isRunningAgent(record)) record.child.kill('SIGKILL');
  if (agentProcesses.get(catalog.id) === record) agentProcesses.delete(catalog.id);
  return { ...catalogAgentStatus(catalog), stopped: true };
}

async function servePackageDocument(response, packageId, documentName) {
  const allowed = new Set(['README.md', 'conversation-distillation.md', 'PRIORITY-PLAN.md', 'package-manifest.json']);
  const catalog = findCatalogPackage(packageId);
  if (!catalog || !allowed.has(documentName)) return false;
  const root = path.resolve(catalog.root);
  const documentPath = path.resolve(root, documentName);
  const relative = path.relative(root, documentPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(documentPath)) return false;
  const contentType = documentName.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8';
  sendText(response, 200, await fsp.readFile(documentPath, 'utf8'), contentType);
  return true;
}

function publicLocalSession(entry) {
  return {
    sessionId: entry.sessionId,
    title: entry.semanticTitle || entry.title || '未命名本机会话',
    rawTitle: entry.rawTitle || entry.title || '',
    titleSource: entry.titleSource || '会话归档',
    modifiedAt: entry.modifiedAt,
    bytes: entry.bytes,
    domain: entry.domain || '通用任务',
    lifecycle: entry.lifecycle || '已归档',
    keywords: entry.keywords || [],
    recommendationScore: Number(entry.recommendationScore || 0),
    recommendationReasons: entry.recommendationReasons || [],
    taskChainId: entry.taskChainId || null,
    taskChainTitle: entry.taskChainTitle || null,
    taskChainSize: Number(entry.relatedSessionCount || entry.taskChainSize || 1),
  };
}

async function listLocalCodexSessions({ limit = 50, offset = 0, query = '', force = false } = {}) {
  const needsRefresh = force || !localSessionIndex || Date.now() - localSessionsListedAt >= LOCAL_SESSION_CACHE_MS;
  if (needsRefresh) {
    localSessionIndex = await buildSemanticSessionIndex({
      roots: LOCAL_SESSION_ROOTS,
      limit: 5000,
      cachePath: SEMANTIC_INDEX_PATH,
      force: force || Boolean(localSessionIndex),
    });
    localSessions.clear();
    for (const entry of localSessionIndex.sessions || []) {
      if (entry.sessionId && (entry.sourcePath || entry.path)) localSessions.set(entry.sessionId.toLowerCase(), entry);
    }
    localSessionsListedAt = Date.now();
  }
  const page = pageSemanticSessions(localSessionIndex, { limit, offset, query });
  return {
    ...page,
    items: page.items.map(publicLocalSession),
    taskChains: (localSessionIndex.taskChains || []).slice(0, 12),
  };
}

async function listLocalCodexTaskChains({ limit = 24, offset = 0, query = '', force = false } = {}) {
  // Reuse the same complete semantic index as the conversation list so a chain
  // always resolves to selectable local session IDs.
  await listLocalCodexSessions({ limit: 1, offset: 0, force });
  return pageSemanticTaskChains(localSessionIndex, { limit, offset, query });
}

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(UI_ROOT, relative);
  const check = path.relative(UI_ROOT, filePath);
  if (check.startsWith('..') || path.isAbsolute(check) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const body = await fsp.readFile(filePath);
  response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(body);
  return true;
}

async function preview(payload) {
  const importId = `import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const supplied = Array.isArray(payload.sources)
    ? payload.sources.map((item, index) => ({ name: String(item?.name || `会话-${index + 1}.jsonl`), content: String(item?.content || '') })).filter((item) => item.content.trim())
    : [];
  const pasted = String(payload.content || '');
  if (pasted.trim()) supplied.push({ name: '粘贴会话.jsonl', content: pasted });
  if (!supplied.length) throw new Error('请先粘贴对话，或选择一份及以上 JSON/JSONL 会话文件。');
  const importRoot = path.join(IMPORT_ROOT, importId);
  await fsp.mkdir(importRoot, { recursive: true });
  const sourcePaths = [];
  for (let index = 0; index < supplied.length; index += 1) {
    const extension = ['.json', '.jsonl', '.txt'].includes(path.extname(supplied[index].name).toLowerCase()) ? path.extname(supplied[index].name).toLowerCase() : '.jsonl';
    const sourcePath = path.join(importRoot, `source-${String(index + 1).padStart(3, '0')}${extension}`);
    await fsp.writeFile(sourcePath, supplied[index].content, 'utf8');
    sourcePaths.push(sourcePath);
  }
  const projectPath = String(payload.projectPath || '').trim() || null;
  const projectSelection = projectPath
    ? { projectScope: 'project', contextMode: 'project-relevant', projectConfirmed: true }
    : { projectScope: 'sessions-only', contextMode: 'conversation-only', projectConfirmed: false };
  const result = await previewConversationCapabilityV2({ sourcePaths, projectPath, ...projectSelection, redact: true, ai: aiOptions(payload) });
  imports.set(importId, { sourcePaths, projectPath, ...projectSelection, ai: aiOptions(payload), result });
  return publicPreview(importId, result);
}

async function previewLocalSessions(payload) {
  const requestedIds = [...new Set((Array.isArray(payload.sessionIds) ? payload.sessionIds : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => safeId(value)))];
  if (!requestedIds.length) throw new Error('请先从“本机 Codex 会话”列表至少选择一条会话。');
  if (!localSessions.size || requestedIds.some((id) => !localSessions.has(id))) {
    await listLocalCodexSessions({ limit: 50, force: true });
  }
  const missing = requestedIds.filter((id) => !localSessions.has(id));
  if (missing.length) throw new Error(`找不到已选本机会话：${missing.join('、')}。请刷新会话列表后重试。`);
  const sourcePaths = requestedIds.map((id) => localSessions.get(id).sourcePath || localSessions.get(id).path);
  const importId = `import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const projectPath = String(payload.projectPath || '').trim() || null;
  const ai = aiOptions(payload);
  const projectSelection = projectPath
    ? { projectScope: 'project', contextMode: 'project-relevant', projectConfirmed: true }
    : { projectScope: 'sessions-only', contextMode: 'conversation-only', projectConfirmed: false };
  const result = await previewConversationCapabilityV2({ sourcePaths, projectPath, ...projectSelection, redact: true, ai });
  imports.set(importId, { sourcePaths, projectPath, ...projectSelection, ai, result, sourceKind: 'local-codex', sessionIds: requestedIds });
  return publicPreview(importId, result);
}

async function generate(payload) {
  const importId = safeId(payload.importId);
  const cached = importId ? imports.get(importId) : null;
  if (!cached) throw new Error('预览已过期，请重新导入对话。');
  const targets = Array.isArray(payload.targets) && payload.targets.length ? payload.targets : ['skill', 'mcp', 'agent'];
  const uiOverrides = payload.uiOverrides && typeof payload.uiOverrides === 'object' ? payload.uiOverrides : null;
  const result = await packageConversationV2({
    sourcePaths: cached.sourcePaths,
    projectPath: cached.projectPath,
    projectScope: cached.projectScope,
    contextMode: cached.contextMode,
    projectConfirmed: cached.projectConfirmed,
    outputRoot: GENERATED_ROOT,
    targets,
    redact: true,
    ai: aiOptions(payload.ai ? payload : { ai: cached.ai }),
    uiBlueprintOverride: uiOverrides,
    heldOutCandidate: payload.heldOutCandidate && typeof payload.heldOutCandidate === 'object' ? payload.heldOutCandidate : null,
  });
  const packageId = `package-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  packages.set(packageId, result);
  const catalog = catalogPackage(packageId, result);
  await writePackageCatalog();
  return { ...publicPackage(packageId, result), catalog };
}

function requireRun(runId) {
  const cached = safeId(runId) ? imports.get(runId) : null;
  if (!cached) throw new Error('本次蒸馏已过期，请重新选择会话。');
  return cached;
}

function packageDownload(response, packageInfo) {
  const packageResult = packageInfo?.package ? packageInfo.package : packageInfo;
  if (!packageResult || !fs.existsSync(packageResult.archive)) return false;
  return fsp.readFile(packageResult.archive).then((body) => {
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length, 'content-disposition': `attachment; filename="${path.basename(packageResult.archive)}"`, 'cache-control': 'no-store' });
    response.end(body);
    return true;
  });
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT || 80}`);
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'conversation-capability-builder', stateRoot: STATE_ROOT, node: process.version, localPathPicker: availablePathPickerKinds() });
  if (request.method === 'GET' && (url.pathname === '/api/v2/health' || url.pathname === '/api/v3/health')) return sendJson(response, 200, { ok: true, service: '对话能力蒸馏器', version: '3', localCodexDiscovery: true, semanticSessionIndex: true, stateRoot: STATE_ROOT, node: process.version, localPathPicker: availablePathPickerKinds() });
  if (request.method === 'POST' && (url.pathname === '/api/path-picker' || url.pathname === '/api/v2/path-picker')) {
    if (!isLoopbackRequest(request)) throw new Error('本机文件选择窗口只能从本机页面打开。');
    const payload = await readJson(request);
    return sendJson(response, 200, { ok: true, paths: await selectLocalPaths(String(payload.kind || '')) });
  }
  if (request.method === 'GET' && (url.pathname === '/api/sessions' || url.pathname === '/api/v2/sessions' || url.pathname === '/api/v3/sessions')) {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const query = String(url.searchParams.get('q') || '').trim();
    const refresh = url.searchParams.get('refresh') === '1';
    const page = await listLocalCodexSessions({ limit, offset, query, force: refresh });
    return sendJson(response, 200, {
      ok: true,
      sessions: page.items,
      total: page.total,
      totalAvailable: page.totalAvailable,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.nextOffset,
      taskChains: page.taskChains,
      source: '本机 Codex 会话归档',
      refreshedAt: new Date(localSessionsListedAt).toISOString(),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/v3/task-chains') {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 24, 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const query = String(url.searchParams.get('q') || '').trim();
    const refresh = url.searchParams.get('refresh') === '1';
    const page = await listLocalCodexTaskChains({ limit, offset, query, force: refresh });
    return sendJson(response, 200, {
      ok: true,
      taskChains: page.items,
      total: page.total,
      totalAvailable: page.totalAvailable,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.nextOffset,
      source: '本机 Codex 会话全量语义任务链',
      refreshedAt: new Date(localSessionsListedAt).toISOString(),
    });
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v2/intakes') return sendJson(response, 200, await previewLocalSessions(await readJson(request)));
  if (request.method === 'POST' && url.pathname === '/api/preview') return sendJson(response, 200, await preview(await readJson(request)));
  if (request.method === 'POST' && url.pathname === '/api/generate') return sendJson(response, 201, await generate(await readJson(request)));
  if (request.method === 'GET' && url.pathname === '/api/v3/packages') {
    const items = packageCatalog
      .filter((entry) => entry.root && fs.existsSync(entry.root))
      .slice(0, Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 60, 300)))
      .map((entry) => ({ ...entry, agent: catalogAgentStatus(entry), documents: packageDocumentLinks(entry.id), archive: `/api/v3/packages/${encodeURIComponent(entry.id)}/download` }));
    return sendJson(response, 200, { ok: true, packages: items, total: items.length, source: '本机已生成能力包目录' });
  }
  const catalogAgentMatch = url.pathname.match(/^\/api\/v3\/packages\/([^/]+)\/agent(?:\/(start|stop))?$/);
  if (catalogAgentMatch) {
    if (!isLoopbackRequest(request)) throw new Error('独立 Agent 只能从本机蒸馏器页面启动。');
    const catalog = findCatalogPackage(decodeURIComponent(catalogAgentMatch[1]));
    const action = catalogAgentMatch[2] || '';
    if (!catalog) return sendJson(response, 404, { ok: false, error: '找不到已登记的能力包。' });
    if (!catalog.hasAgent) return sendJson(response, 400, { ok: false, error: '这个能力包没有独立 Agent。请重新生成时勾选“独立 Agent”。' });
    if (request.method === 'GET' && !action) return sendJson(response, 200, { ok: true, packageId: catalog.id, agent: catalogAgentStatus(catalog) });
    if (request.method === 'POST' && action === 'start') {
      const agent = await startCatalogAgent(catalog);
      return sendJson(response, agent.reused ? 200 : 201, { ok: true, packageId: catalog.id, agent });
    }
    if (request.method === 'POST' && action === 'stop') {
      const agent = await stopCatalogAgent(catalog);
      return sendJson(response, 200, { ok: true, packageId: catalog.id, agent });
    }
    return sendJson(response, 405, { ok: false, error: '该独立 Agent 接口不支持此请求方式。' });
  }
  const catalogDownloadMatch = url.pathname.match(/^\/api\/v3\/packages\/([^/]+)\/download$/);
  if (request.method === 'GET' && catalogDownloadMatch) {
    const catalog = findCatalogPackage(decodeURIComponent(catalogDownloadMatch[1]));
    if (catalog && await packageDownload(response, { package: { archive: catalog.archivePath } })) return;
    return sendText(response, 404, '找不到能力包 ZIP。');
  }
  const documentMatch = url.pathname.match(/^\/api\/v3\/packages\/([^/]+)\/documents\/(README\.md|conversation-distillation\.md|PRIORITY-PLAN\.md|package-manifest\.json)$/);
  if (request.method === 'GET' && documentMatch) {
    const packageId = decodeURIComponent(documentMatch[1]);
    const documentName = decodeURIComponent(documentMatch[2]);
    if (await servePackageDocument(response, packageId, documentName)) return;
    return sendText(response, 404, '找不到能力包说明文件。');
  }
  const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)(?:\/(recommendation(?:\.(?:md|html))?|package))?$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2] || '';
    const cached = requireRun(runId);
    if (request.method === 'GET' && !action) return sendJson(response, 200, publicPreview(runId, cached.result));
    if (request.method === 'GET' && action === 'recommendation') return sendJson(response, 200, { ok: true, runId, recommendation: cached.result.recommendation || null, links: runLinks(runId) });
    if (request.method === 'GET' && action === 'recommendation.md') return sendText(response, 200, distillationRecommendationMarkdown(cached.result.recommendation || {}), 'text/markdown; charset=utf-8');
    if (request.method === 'GET' && action === 'recommendation.html') return sendText(response, 200, distillationRecommendationHtml(cached.result.recommendation || {}), 'text/html; charset=utf-8');
    if (request.method === 'POST' && action === 'package') return sendJson(response, 201, await generate({ ...(await readJson(request)), importId: runId }));
  }
  const packageMatch = url.pathname.match(/^\/api\/v2\/packages\/([^/]+)(?:\/download)?$/);
  if (packageMatch) {
    const packageId = decodeURIComponent(packageMatch[1]);
    const packageInfo = packages.get(packageId);
    if (!packageInfo) return sendText(response, 404, '找不到能力包。');
    if (request.method === 'GET' && !url.pathname.endsWith('/download')) return sendJson(response, 200, publicPackage(packageId, packageInfo));
    if (request.method === 'GET' && url.pathname.endsWith('/download')) {
      if (await packageDownload(response, packageInfo)) return;
      return sendText(response, 404, '找不到能力包 ZIP。');
    }
  }
  const downloadId = url.pathname.match(/^\/api\/download\/([^/]+)$/)?.[1];
  if (request.method === 'GET' && downloadId) {
    const packageInfo = packages.get(downloadId);
    if (await packageDownload(response, packageInfo)) return;
    return sendText(response, 404, '找不到能力包 ZIP。');
  }
  if (request.method === 'GET' && await serveStatic(response, url.pathname)) return;
  sendText(response, 404, '找不到请求的页面或接口。');
}

await fsp.mkdir(IMPORT_ROOT, { recursive: true });
await fsp.mkdir(GENERATED_ROOT, { recursive: true });
await restorePackageCatalog();
const server = http.createServer((request, response) => route(request, response).catch((error) => sendJson(response, 400, { ok: false, error: String(error?.message || error) })));
server.listen(PORT, HOST, () => process.stdout.write(`对话转能力包已启动：http://${HOST}:${server.address().port}/\n`));
const shutdown = () => {
  for (const record of agentProcesses.values()) {
    if (isRunningAgent(record)) record.child.kill('SIGTERM');
  }
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
