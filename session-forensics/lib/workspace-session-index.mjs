import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultSessionRoots } from './session-forensics.mjs';
import { discoverSessionSources } from './session-source-index.mjs';

const PROJECT_MARKERS = ['.git', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'requirements.txt'];
const UNASSIGNED_WORKSPACE_ID = 'workspace-unassigned';

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function workspaceId(rootPath) {
  return `workspace-${crypto.createHash('sha256').update(canonicalPath(rootPath)).digest('hex').slice(0, 16)}`;
}

async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function markerCount(directory) {
  const checks = await Promise.all(PROJECT_MARKERS.map(async (marker) => {
    try {
      await fs.access(path.join(directory, marker));
      return 1;
    } catch {
      return 0;
    }
  }));
  return checks.reduce((sum, value) => sum + value, 0);
}

async function resolveWorkspaceRoot(candidate) {
  let current = path.resolve(candidate);
  if (!await isDirectory(current)) return { rootPath: current, confidence: 72, evidence: '会话元数据记录了工作目录，但该目录当前不可访问。' };
  let nearest = null;
  for (let depth = 0; depth < 12; depth += 1) {
    const markers = await markerCount(current);
    if (markers > 0) {
      nearest = { rootPath: current, confidence: depth === 0 ? 100 : 94, evidence: depth === 0 ? '会话工作目录包含项目标记。' : '从会话工作目录向上定位到最近的项目根目录。' };
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return nearest || { rootPath: path.resolve(candidate), confidence: 88, evidence: '使用会话元数据中的工作目录作为工作区。' };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, worker));
  return output;
}

function publicSource(source, workspace = null) {
  return {
    ...source,
    workspaceId: workspace?.workspaceId || UNASSIGNED_WORKSPACE_ID,
    workspaceName: workspace?.name || '未识别工作区',
    workspaceRoot: workspace?.rootPath || null,
    workspaceConfidence: workspace?.confidence || 0,
    workspaceEvidence: workspace?.evidence || '会话头部没有可用的工作目录元数据。',
  };
}

export async function discoverWorkspaceCatalog({ roots = [], limit = Number.MAX_SAFE_INTEGER } = {}) {
  const scanRoots = unique(roots).length ? unique(roots).map((item) => path.resolve(item)) : defaultSessionRoots();
  const discovered = await discoverSessionSources({ roots: scanRoots, limit, complete: true });
  const workspaceCache = new Map();
  const sources = await mapWithConcurrency(discovered, 12, async (source) => {
    const candidate = unique(source.workspacePaths)[0];
    if (!candidate) return publicSource(source);
    const candidateKey = canonicalPath(candidate);
    if (!workspaceCache.has(candidateKey)) workspaceCache.set(candidateKey, resolveWorkspaceRoot(candidate));
    const resolved = await workspaceCache.get(candidateKey);
    const workspace = {
      workspaceId: workspaceId(resolved.rootPath),
      name: path.basename(resolved.rootPath) || resolved.rootPath,
      rootPath: resolved.rootPath,
      confidence: resolved.confidence,
      evidence: resolved.evidence,
    };
    return publicSource(source, workspace);
  });

  const grouped = new Map();
  for (const source of sources) {
    const id = source.workspaceId;
    if (!grouped.has(id)) {
      grouped.set(id, {
        workspaceId: id,
        name: source.workspaceName,
        rootPath: source.workspaceRoot,
        confidence: source.workspaceConfidence,
        evidence: source.workspaceEvidence,
        sourceKeys: [],
        sessionCount: 0,
        latestSessionAt: null,
        latestGoal: null,
      });
    }
    const group = grouped.get(id);
    group.sourceKeys.push(source.sourceKey);
    group.sessionCount += 1;
    if (!group.latestSessionAt || Date.parse(source.modifiedAt || 0) > Date.parse(group.latestSessionAt || 0)) {
      group.latestSessionAt = source.modifiedAt || null;
      group.latestGoal = source.title || null;
    }
  }

  const workspaces = [...grouped.values()].sort((left, right) => {
    if (left.workspaceId === UNASSIGNED_WORKSPACE_ID) return 1;
    if (right.workspaceId === UNASSIGNED_WORKSPACE_ID) return -1;
    return Date.parse(right.latestSessionAt || 0) - Date.parse(left.latestSessionAt || 0);
  });
  const revisionInput = sources.map((source) => `${source.sourceKey}:${source.bytes}:${source.modifiedAt}:${source.workspaceId}`).sort().join('\n');
  const revision = crypto.createHash('sha256').update(revisionInput).digest('hex');
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    revision,
    complete: true,
    roots: scanRoots,
    statistics: {
      sessionCount: sources.length,
      workspaceCount: workspaces.filter((item) => item.workspaceId !== UNASSIGNED_WORKSPACE_ID).length,
      unassignedCount: sources.filter((item) => item.workspaceId === UNASSIGNED_WORKSPACE_ID).length,
    },
    workspaces,
    sources,
  };
}

export function createWorkspaceSelection(catalog, input = {}) {
  const requestedWorkspaceIds = unique(input.workspaceIds);
  const includedSourceKeys = unique(input.includedSourceKeys || input.includeSourceKeys);
  const excludedSourceKeys = new Set(unique(input.excludedSourceKeys || input.excludeSourceKeys));
  const workspaceMap = new Map((catalog?.workspaces || []).map((item) => [item.workspaceId, item]));
  const sourceMap = new Map((catalog?.sources || []).map((item) => [item.sourceKey, item]));
  const selectedKeys = new Set(includedSourceKeys.filter((key) => sourceMap.has(key)));
  const selectedWorkspaces = [];
  const missingWorkspaceIds = [];
  for (const id of requestedWorkspaceIds) {
    const workspace = workspaceMap.get(id);
    if (!workspace) {
      missingWorkspaceIds.push(id);
      continue;
    }
    selectedWorkspaces.push(workspace);
    for (const key of workspace.sourceKeys) selectedKeys.add(key);
  }
  for (const key of excludedSourceKeys) selectedKeys.delete(key);
  const sources = (catalog?.sources || []).filter((source) => selectedKeys.has(source.sourceKey));
  const snapshotInput = JSON.stringify({ revision: catalog?.revision, requestedWorkspaceIds, includedSourceKeys, excludedSourceKeys: [...excludedSourceKeys].sort() });
  return {
    schemaVersion: '1.0.0',
    snapshotId: `selection-${crypto.createHash('sha256').update(snapshotInput).digest('hex').slice(0, 20)}`,
    createdAt: new Date().toISOString(),
    catalogRevision: catalog?.revision || null,
    selectionMode: requestedWorkspaceIds.length ? 'workspace-all-with-exceptions' : 'explicit-sessions',
    workspaceIds: selectedWorkspaces.map((item) => item.workspaceId),
    workspaces: selectedWorkspaces.map((item) => ({
      workspaceId: item.workspaceId,
      name: item.name,
      rootPath: item.rootPath,
      sessionCount: item.sessionCount,
    })),
    includedSourceKeys,
    excludedSourceKeys: [...excludedSourceKeys],
    missingWorkspaceIds,
    sourceKeys: sources.map((source) => source.sourceKey),
    sourcePaths: sources.map((source) => source.sourcePath),
    sessionCount: sources.length,
    sources,
  };
}

export { UNASSIGNED_WORKSPACE_ID };
