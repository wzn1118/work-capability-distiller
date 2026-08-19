import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_ROOT } from './session-forensics.mjs';
import { distillationRecommendationHtml, distillationRecommendationMarkdown } from './distillation-recommendation.mjs';
import { normalizeScopePolicy } from './scope-policy.mjs';

export const DISTILLATION_RUNS_ROOT = path.join(WORKSPACE_ROOT, 'output', 'session-forensics', 'runs');
const RUN_ID_RE = /^run-[A-Za-z0-9_-]{24}$/;
const LEVEL_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function runId() {
  return `run-${crypto.randomBytes(18).toString('base64url')}`;
}

function assertRunId(value) {
  const id = String(value || '');
  if (!RUN_ID_RE.test(id)) throw new Error('蒸馏任务编号格式不正确。');
  return id;
}

function runRoot(value) {
  return path.join(DISTILLATION_RUNS_ROOT, assertRunId(value));
}

function safeSelection(selection = {}) {
  const sourcePaths = (selection.sourcePaths || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const workspace = selection.workspaceSelection && typeof selection.workspaceSelection === 'object'
    ? selection.workspaceSelection
    : null;
  const scopePolicy = normalizeScopePolicy({ ...selection, workspaceSelection: workspace });
  const selectionMode = selection.selectionMode === 'workspace' || workspace?.selectionMode === 'workspace'
    ? 'workspace'
    : 'sessions';
  return {
    sourcePaths: [...new Set(sourcePaths)],
    projectPath: scopePolicy.projectConfirmed && selection.projectPath ? path.resolve(String(selection.projectPath)) : '',
    includeEvidence: selection.includeEvidence !== false,
    redact: selection.redact !== false,
    scope: 'whole-session',
    selectionMode,
    projectScope: scopePolicy.projectScope,
    contextMode: scopePolicy.contextMode,
    projectConfirmed: scopePolicy.projectConfirmed,
    projectContext: scopePolicy.projectContext,
    workspaceSelection: workspace ? {
      schemaVersion: workspace.schemaVersion || '1.0.0',
      snapshotId: String(workspace.snapshotId || ''),
      createdAt: workspace.createdAt || new Date().toISOString(),
      catalogRevision: workspace.catalogRevision || null,
      selectionMode: workspace.selectionMode || 'workspace-all-with-exceptions',
      workspaceIds: [...new Set((workspace.workspaceIds || []).map(String))],
      workspaces: (workspace.workspaces || []).map((item) => ({
        workspaceId: String(item.workspaceId || ''),
        name: String(item.name || '未命名工作区'),
        rootPath: item.rootPath ? path.resolve(String(item.rootPath)) : null,
        sessionCount: Number(item.sessionCount) || 0,
      })),
      includedSourceKeys: [...new Set((workspace.includedSourceKeys || []).map(String))],
      excludedSourceKeys: [...new Set((workspace.excludedSourceKeys || []).map(String))],
      sourceKeys: [...new Set((workspace.sourceKeys || []).map(String))],
      sessionCount: Number(workspace.sessionCount) || sourcePaths.length,
    } : null,
  };
}

function evidenceManifest(recommendation, sourceSet, projectDiscovery, projectEvidence, projectKnowledgeV4, selection) {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    workspaceSelection: selection?.workspaceSelection || null,
    sourceSessions: (sourceSet?.sessions || []).map((session) => ({
      sessionId: session.sessionId,
      title: session.title || null,
      sourcePath: session.sourcePath || null,
      sha256: session.sha256 || null,
      recordCount: session.recordCount || null,
      modifiedAt: session.modifiedAt || null,
    })),
    project: {
      mode: projectDiscovery?.mode || '未发现',
      selectedPath: projectDiscovery?.selectedPath || projectEvidence?.project?.root || null,
      name: projectEvidence?.project?.name || recommendation?.summary?.project || null,
      git: projectEvidence?.git || null,
    },
    statistics: recommendation?.evidenceGraph?.statistics || {},
    evidence: recommendation?.evidence || [],
    graph: recommendation?.evidenceGraph || { nodes: [], edges: [], statistics: {} },
    files: (projectKnowledgeV4?.fileChangeMatrix || []).map((item) => ({
      path: item.path,
      changeState: item.changeState || item.assessment || null,
      gitStatus: item.gitStatus || null,
      evidenceIds: item.evidenceIds || [],
    })),
    artifacts: projectKnowledgeV4?.artifactLineage || [],
    verifications: (recommendation?.evidence || []).filter((item) => item.type === 'verification'),
  };
}

async function writeRecommendationFiles(root, recommendation, manifest) {
  await Promise.all([
    fsp.writeFile(path.join(root, 'recommendation.json'), `${JSON.stringify(recommendation, null, 2)}\n`, 'utf8'),
    fsp.writeFile(path.join(root, 'recommendation.md'), distillationRecommendationMarkdown(recommendation), 'utf8'),
    fsp.writeFile(path.join(root, 'recommendation.html'), distillationRecommendationHtml(recommendation), 'utf8'),
    fsp.writeFile(path.join(root, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  ]);
}

export async function createDistillationRun({ preview, selection } = {}) {
  if (!preview?.recommendation) throw new Error('没有可保存的蒸馏建议。');
  const id = runId();
  const root = runRoot(id);
  const createdAt = new Date().toISOString();
  const storedSelection = safeSelection(selection);
  const manifest = evidenceManifest(preview.recommendation, preview.sourceSet, preview.projectDiscovery, preview.projectEvidence, preview.projectKnowledgeV4, storedSelection);
  const record = {
    schemaVersion: '2.0.0',
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'recommended',
    selection: storedSelection,
    identity: preview.identity,
    sourceSet: preview.sourceSet,
    projectDiscovery: preview.projectDiscovery,
    projectEvidence: preview.projectEvidence || null,
    projectKnowledgeV4: preview.projectKnowledgeV4 || null,
    projectSummary: preview.projectEvidence?.summary || null,
    projectUnderstandingSummary: {
      purpose: preview.projectUnderstanding?.purpose || null,
      scope: preview.projectUnderstanding?.scope || null,
      graph: preview.projectUnderstanding?.evidenceGraph?.statistics || null,
    },
    recommendation: preview.recommendation,
    overrides: [],
    package: null,
  };
  await fsp.mkdir(root, { recursive: true });
  await writeRecommendationFiles(root, record.recommendation, manifest);
  await fsp.writeFile(path.join(root, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { ...record, root, evidenceManifest: manifest };
}

export async function readDistillationRun(id) {
  const root = runRoot(id);
  const record = JSON.parse(await fsp.readFile(path.join(root, 'run.json'), 'utf8'));
  return { ...record, root };
}

export async function readRunArtifact(id, artifact) {
  const allowed = new Set(['recommendation.json', 'recommendation.md', 'recommendation.html', 'evidence-manifest.json']);
  if (!allowed.has(artifact)) throw new Error('该蒸馏任务文件不在可读取清单中。');
  return fsp.readFile(path.join(runRoot(id), artifact));
}

function applyOverride(recommendation, priorityId, action) {
  const priorities = (recommendation.priorities || []).map((entry) => {
    if (entry.id !== priorityId) return entry;
    if (action === 'reset') {
      const original = entry.userOverride?.original;
      return original ? { ...entry, ...original, userOverride: undefined } : entry;
    }
    const original = entry.userOverride?.original || {
      level: entry.level,
      score: entry.score,
      distillationPriority: entry.distillationPriority,
      agentExecutionPriority: entry.agentExecutionPriority,
    };
    const emphasized = action === 'emphasize';
    const level = emphasized ? 'P0' : 'P3';
    const score = emphasized ? Math.max(92, Number(entry.score || 0)) : Math.min(35, Number(entry.score || 0));
    const reason = emphasized ? '用户明确要求优先写入能力包。' : '用户明确要求本次暂不纳入默认执行路径。';
    return {
      ...entry,
      level,
      score,
      distillationPriority: { ...entry.distillationPriority, level, score, reason },
      agentExecutionPriority: emphasized ? { ...entry.agentExecutionPriority, level: 'P0', score: Math.max(90, Number(entry.agentExecutionPriority?.score || 0)), reason: '用户已将该目标设为本次首要执行事项。' } : entry.agentExecutionPriority,
      userOverride: { action, reason, updatedAt: new Date().toISOString(), original },
    };
  });
  priorities.sort((left, right) => LEVEL_ORDER[left.distillationPriority.level] - LEVEL_ORDER[right.distillationPriority.level] || right.distillationPriority.score - left.distillationPriority.score || left.sourceOrder - right.sourceOrder);
  recommendation.priorities = priorities.map((entry, index) => ({ ...entry, rank: index + 1 }));
  recommendation.summary.counts = Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map((level) => [level, recommendation.priorities.filter((entry) => entry.distillationPriority.level === level).length]));
  recommendation.summary.headline = `建议生成“${recommendation.identity?.title || '会话专属能力包'}”，包含 ${recommendation.priorities.filter((entry) => entry.distillationPriority.level !== 'P3').length} 项重点能力，先处理 ${recommendation.summary.counts.P0} 项必须项。`;
  const priorityNodes = new Map(recommendation.priorities.map((entry) => [entry.id, entry]));
  recommendation.evidenceGraph.nodes = (recommendation.evidenceGraph.nodes || []).map((node) => priorityNodes.has(node.id) ? { ...node, priority: priorityNodes.get(node.id).distillationPriority.level } : node);
  recommendation.updatedAt = new Date().toISOString();
  return recommendation;
}

export async function reprioritizeDistillationRun(id, { priorityId, action } = {}) {
  if (!['emphasize', 'defer', 'reset'].includes(action)) throw new Error('优先级操作只支持 emphasize、defer 或 reset。');
  const record = await readDistillationRun(id);
  if (!(record.recommendation?.priorities || []).some((entry) => entry.id === priorityId)) throw new Error('没有找到要调整的能力项。');
  record.recommendation = applyOverride(record.recommendation, priorityId, action);
  record.updatedAt = new Date().toISOString();
  record.overrides = [...(record.overrides || []), { priorityId, action, updatedAt: record.updatedAt }].slice(-200);
  const manifest = evidenceManifest(record.recommendation, record.sourceSet, record.projectDiscovery, record.projectEvidence || { summary: record.projectSummary }, record.projectKnowledgeV4);
  await writeRecommendationFiles(record.root, record.recommendation, manifest);
  const persisted = { ...record };
  delete persisted.root;
  await fsp.writeFile(path.join(record.root, 'run.json'), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  return { ...persisted, root: record.root, evidenceManifest: manifest };
}

export async function attachPackageToRun(id, packageResult) {
  const record = await readDistillationRun(id);
  record.updatedAt = new Date().toISOString();
  record.status = 'packaged';
  record.package = {
    id: packageResult.package.id,
    name: packageResult.package.name,
    root: packageResult.package.root,
    manifest: packageResult.package.manifest,
    archive: packageResult.package.archive,
    createdAt: record.updatedAt,
  };
  const persisted = { ...record };
  delete persisted.root;
  await fsp.writeFile(path.join(record.root, 'run.json'), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  return { ...persisted, root: record.root };
}
