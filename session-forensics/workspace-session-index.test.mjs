import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSessions } from './lib/session-forensics.mjs';
import { createWorkspaceSelection, discoverWorkspaceCatalog, UNASSIGNED_WORKSPACE_ID } from './lib/workspace-session-index.mjs';

async function writeSession(root, sessionId, { cwd, title }) {
  const records = [
    { type: 'session_meta', payload: { id: sessionId, cwd, title } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
  ];
  const file = path.join(root, `rollout-2026-08-17T00-00-00-${sessionId}.jsonl`);
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return file;
}

test('完整扫描按真实项目根目录归组，并支持工作区全选后排除单条会话', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-session-index-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = path.join(temporaryRoot, 'sessions');
  const projectA = path.join(temporaryRoot, '客户洞察项目');
  const projectB = path.join(temporaryRoot, '演示文稿项目');
  const projectASubdirectory = path.join(projectA, 'src', 'reports');
  await Promise.all([
    fs.mkdir(sessionsRoot, { recursive: true }),
    fs.mkdir(projectASubdirectory, { recursive: true }),
    fs.mkdir(projectB, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(projectA, 'package.json'), '{"name":"insight-project"}\n', 'utf8'),
    fs.writeFile(path.join(projectB, 'pyproject.toml'), '[project]\nname = "slides-project"\n', 'utf8'),
  ]);

  await Promise.all([
    writeSession(sessionsRoot, '11111111-1111-4111-8111-111111111111', { cwd: projectA, title: '生成评论洞察报告' }),
    writeSession(sessionsRoot, '22222222-2222-4222-8222-222222222222', { cwd: projectASubdirectory, title: '修正报告营销建议' }),
    writeSession(sessionsRoot, '33333333-3333-4333-8333-333333333333', { cwd: projectB, title: '重构演示文稿' }),
    writeSession(sessionsRoot, '44444444-4444-4444-8444-444444444444', { cwd: '', title: '没有工作区的独立会话' }),
  ]);

  const limited = await discoverSessions({ roots: [sessionsRoot], limit: 1 });
  const complete = await discoverSessions({ roots: [sessionsRoot], limit: 1, complete: true });
  assert.equal(limited.length, 1);
  assert.equal(complete.length, 4);

  const catalog = await discoverWorkspaceCatalog({ roots: [sessionsRoot], limit: 1 });
  assert.equal(catalog.complete, true);
  assert.equal(catalog.statistics.sessionCount, 4);
  assert.equal(catalog.statistics.workspaceCount, 2);
  assert.equal(catalog.statistics.unassignedCount, 1);
  assert.equal(catalog.workspaces.length, 3);

  const workspaceA = catalog.workspaces.find((workspace) => workspace.rootPath === projectA);
  const workspaceB = catalog.workspaces.find((workspace) => workspace.rootPath === projectB);
  const unassigned = catalog.workspaces.find((workspace) => workspace.workspaceId === UNASSIGNED_WORKSPACE_ID);
  assert.equal(workspaceA?.sessionCount, 2);
  assert.equal(workspaceB?.sessionCount, 1);
  assert.equal(unassigned?.sessionCount, 1);

  const excludedKey = workspaceA.sourceKeys[0];
  const selection = createWorkspaceSelection(catalog, {
    workspaceIds: [workspaceA.workspaceId, workspaceB.workspaceId],
    excludedSourceKeys: [excludedKey],
  });
  assert.equal(selection.selectionMode, 'workspace-all-with-exceptions');
  assert.equal(selection.sessionCount, 2);
  assert.deepEqual(new Set(selection.workspaceIds), new Set([workspaceA.workspaceId, workspaceB.workspaceId]));
  assert.equal(selection.sourceKeys.includes(excludedKey), false);
  assert.equal(selection.sourcePaths.length, 2);

  const repeatedCatalog = await discoverWorkspaceCatalog({ roots: [sessionsRoot], limit: 1 });
  const repeatedSelection = createWorkspaceSelection(repeatedCatalog, {
    workspaceIds: [workspaceA.workspaceId, workspaceB.workspaceId],
    excludedSourceKeys: [excludedKey],
  });
  assert.equal(repeatedCatalog.revision, catalog.revision);
  assert.equal(repeatedSelection.snapshotId, selection.snapshotId);
});
