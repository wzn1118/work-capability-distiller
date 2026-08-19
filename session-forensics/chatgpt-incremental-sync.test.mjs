import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkpointChatGPTSyncJob, commitChatGPTSyncJob, planChatGPTIncrementalSync, readChatGPTSyncState, registerChatGPTSyncJob, updateChatGPTSyncRun } from './lib/chatgpt-incremental-sync.mjs';

test('网页端增量同步按会话更新时间跳过未变化项，并在成功后保留状态', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-sync-'));
  const conversations = [
    { conversationId: 'one', title: '第一条', updatedAt: '2026-08-18T00:00:00.000Z' },
    { conversationId: 'two', title: '第二条', updatedAt: '2026-08-18T01:00:00.000Z' },
  ];
  let plan = await planChatGPTIncrementalSync({ root, conversations });
  assert.equal(plan.summary.toFetch, 2);
  await registerChatGPTSyncJob({ root, jobId: 'job-1', plan });
  await commitChatGPTSyncJob({ root, jobId: 'job-1', captures: conversations.map((item) => ({ ...item, messages: [{ role: 'user', content: item.title }], events: [{ eventType: 'tool_call' }], assets: [{ assetId: item.conversationId }], nodes: [{ nodeId: item.conversationId }] })) });
  plan = await planChatGPTIncrementalSync({ root, conversations });
  assert.equal(plan.summary.toFetch, 0);
  assert.equal(plan.summary.skipped, 2);
  const changed = [{ ...conversations[0], updatedAt: '2026-08-19T00:00:00.000Z' }, conversations[1]];
  plan = await planChatGPTIncrementalSync({ root, conversations: changed });
  assert.equal(plan.summary.toFetch, 1);
  assert.equal(plan.toFetch[0].conversationId, 'one');
  const state = await readChatGPTSyncState(root);
  assert.equal(state.conversations.one.status, 'success');
  assert.equal(state.conversations.two.status, 'success');
  assert.equal(state.conversations.one.eventCount, 1);
  assert.equal(state.conversations.one.assetCount, 1);
  assert.equal(state.conversations.one.nodeCount, 1);
  assert.equal(state.schemaVersion, 'chatgpt-incremental-sync-v3');
  assert.equal(state.runs['job-1'].status, 'completed');
  assert.deepEqual(state.runs['job-1'].successIds.sort(), ['one', 'two']);
});

test('重新排队时新任务接管旧任务中的重复会话', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-sync-retry-'));
  const conversations = [
    { conversationId: 'one', title: '第一条', updatedAt: '2026-08-18T00:00:00.000Z' },
    { conversationId: 'two', title: '第二条', updatedAt: '2026-08-18T01:00:00.000Z' },
  ];
  const firstPlan = await planChatGPTIncrementalSync({ root, conversations });
  await registerChatGPTSyncJob({ root, jobId: 'job-old', plan: firstPlan });
  const retryPlan = await planChatGPTIncrementalSync({ root, conversations });
  await registerChatGPTSyncJob({ root, jobId: 'job-new', plan: retryPlan });
  const state = await readChatGPTSyncState(root);
  assert.equal(state.pendingJobs['job-old'], undefined);
  assert.deepEqual(state.pendingJobs['job-new'].ids, ['one', 'two']);
});

test('长任务逐条写入成功与失败检查点，并保护规划后刚写入的成功状态', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-sync-checkpoint-'));
  const conversations = [
    { conversationId: 'one', title: '第一条', updatedAt: '2026-08-18T00:00:00.000Z' },
    { conversationId: 'two', title: '第二条', updatedAt: '2026-08-18T01:00:00.000Z' },
  ];
  const stalePlan = await planChatGPTIncrementalSync({ root, conversations });
  await registerChatGPTSyncJob({ root, jobId: 'job-checkpoint', plan: stalePlan });
  await checkpointChatGPTSyncJob({
    root,
    jobId: 'job-checkpoint',
    captures: [{ ...conversations[0], messages: [{ role: 'user', content: '已保存内容' }], events: [{ eventType: 'image_generation' }], assets: [{ assetId: 'asset-1' }] }],
    failures: [{ ...conversations[1], error: '网页限流' }],
  });
  let state = await readChatGPTSyncState(root);
  assert.equal(state.conversations.one.status, 'success');
  assert.equal(state.conversations.one.eventCount, 1);
  assert.equal(state.conversations.one.assetCount, 1);
  assert.equal(state.conversations.two.status, 'failed');
  assert.deepEqual(state.pendingJobs['job-checkpoint'].ids, []);
  assert.equal(state.runs['job-checkpoint'].status, 'partial');
  assert.deepEqual(state.runs['job-checkpoint'].failedIds, ['two']);

  await registerChatGPTSyncJob({ root, jobId: 'job-stale-plan', plan: stalePlan });
  state = await readChatGPTSyncState(root);
  assert.equal(state.conversations.one.status, 'success');
  assert.deepEqual(state.pendingJobs['job-stale-plan'].ids, ['two']);
});

test('同步运行状态可独立更新并在读取状态时恢复', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-sync-run-'));
  await updateChatGPTSyncRun({ root, jobId: 'job-paused', patch: { status: 'paused', phase: 'paused', totalCount: 3001, completedCount: 1200, remainingCount: 1801 } });
  const state = await readChatGPTSyncState(root);
  assert.equal(state.runs['job-paused'].phase, 'paused');
  assert.equal(state.runs['job-paused'].remainingCount, 1801);
});

test('旧版检查点会迁移成可恢复的暂停任务', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-incremental-legacy-'));
  await fsp.writeFile(path.join(root, 'incremental-sync-state.json'), JSON.stringify({
    schemaVersion: 'chatgpt-incremental-sync-v2',
    generatedAt: '2026-08-18T00:00:00.000Z',
    conversations: {
      legacy_one: { conversationId: 'legacy_one', title: '旧版断点中的会话', status: 'pending' },
    },
    pendingJobs: {
      'legacy-job': { createdAt: '2026-08-18T00:00:00.000Z', ids: ['legacy_one', 'legacy_two'] },
    },
  }), 'utf8');
  const state = await readChatGPTSyncState(root);
  assert.equal(state.schemaVersion, 'chatgpt-incremental-sync-v3');
  assert.equal(state.runs['legacy-job'].status, 'paused');
  assert.equal(state.runs['legacy-job'].phase, 'recovered');
  assert.equal(state.runs['legacy-job'].remainingCount, 2);
  assert.equal(state.runs['legacy-job'].recoveredLegacyCheckpoint, true);
  assert.equal(state.runs['legacy-job'].lastTitle, '旧版断点中的会话');
});

test('3000+ 网页会话可以一次性排队并保持增量读取', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatgpt-sync-capacity-'));
  const conversations = Array.from({ length: 3001 }, (_, index) => ({
    conversationId: `conversation-${index + 1}`,
    title: `会话 ${index + 1}`,
    updatedAt: '2026-08-18T00:00:00.000Z',
    url: `https://chatgpt.com/c/conversation-${index + 1}`,
  }));
  const plan = await planChatGPTIncrementalSync({ root, conversations });
  assert.equal(plan.summary.total, 3001);
  assert.equal(plan.summary.toFetch, 3001);
  assert.equal(plan.toFetch.length, 3001);
  await registerChatGPTSyncJob({ root, jobId: 'job-3001', plan });
  const state = await readChatGPTSyncState(root);
  assert.equal(state.pendingJobs['job-3001'].ids.length, 3001);
  assert.equal(Object.keys(state.conversations).length, 3001);
});
