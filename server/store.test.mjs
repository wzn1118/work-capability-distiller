import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobStore } from './store.mjs';

test('keeps high-frequency job progress visible without persisting every update', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-store-transient-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const store = new JobStore(dataDir);
  await store.init();
  const job = store.create({
    type: 'content_analysis',
    status: 'succeeded',
    progress: 100,
    query: 'transient-progress',
    channels: ['douyin'],
  });
  await store.flush();

  store.patchTransient(job.id, {
    videoProgress: { completed: 12, total: 500, status: 'local_processing' },
  });
  assert.deepEqual(store.get(job.id).videoProgress, {
    completed: 12,
    total: 500,
    status: 'local_processing',
  });
  assert.equal(store.inspect(job.id).videoProgress.completed, 12);

  const restored = new JobStore(dataDir);
  await restored.init();
  assert.equal(restored.get(job.id).videoProgress, undefined);
});

test('coalesces rapid durable updates before a creator checkpoint flush', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-store-coalesced-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const store = new JobStore(dataDir);
  await store.init();
  const job = store.create({
    type: 'content',
    status: 'succeeded',
    progress: 0,
    query: 'coalesced-progress',
    channels: ['douyin'],
  });
  const firstPendingWrite = store.writeQueue;
  for (let index = 1; index <= 24; index += 1) {
    store.addEvent(job.id, { message: 'Captured profile ' + index + '.' });
    store.patch(job.id, { progress: index });
  }

  assert.equal(store.writeQueue, firstPendingWrite);
  await store.flush();

  const restored = new JobStore(dataDir);
  await restored.init();
  const saved = restored.get(job.id);
  assert.equal(saved.progress, 24);
  assert.equal(saved.events.length, 24);
});

test('persists campaign state and recovers an active collection after restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const firstStore = new JobStore(dataDir);
  await firstStore.init();
  const job = firstStore.create({
    type: 'discover',
    status: 'running',
    progress: 50,
    query: '护肤',
    channels: ['xiaohongshu'],
    channelResults: {
      xiaohongshu: { platform: 'xiaohongshu', status: 'succeeded', records: 12, creators: 10 },
    },
    results: [{ id: 'creator-1', channel: 'xiaohongshu' }],
    metrics: { sourceRecords: 12, creators: 10 },
  });
  const queuedJob = firstStore.create({
    type: 'discover',
    status: 'queued',
    progress: 0,
    query: 'queued-query',
    channels: ['douyin'],
  });
  const verificationJob = firstStore.create({
    type: 'verify',
    status: 'succeeded',
    progress: 100,
    query: 'verification-query',
    channels: ['xiaohongshu'],
  });
  const enrichmentJob = firstStore.create({
    type: 'enrich',
    status: 'succeeded',
    progress: 100,
    query: 'persona-query',
    channels: ['douyin'],
    discoveryJobId: job.id,
    selectedCreatorIds: ['creator-1'],
  });
  const contentJob = firstStore.create({
    type: 'content',
    status: 'succeeded',
    progress: 100,
    query: 'content-query',
    channels: ['douyin'],
    discoveryJobId: job.id,
    selectedCreatorIds: ['creator-1'],
    contentLimit: 24,
  });
  const campaign = firstStore.createCampaign({
    brief: { brand: '测试品牌', product: '精华' },
    channels: ['xiaohongshu'],
    discoveryJobId: job.id,
    verificationJobIds: [verificationJob.id],
    enrichmentJobIds: [enrichmentJob.id],
    contentJobIds: [contentJob.id],
    selectedCreatorIds: ['creator-1'],
    currentStep: 3,
  });
  await firstStore.flush();

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
  const persistedDiscovery = persisted.jobs.find((entry) => entry.id === job.id);
  assert.equal(persistedDiscovery.results, undefined);
  assert.equal(persistedDiscovery.channelResults, undefined);
  assert.equal(persistedDiscovery.payloadStorage.resultCount, 1);
  await fs.access(path.join(dataDir, 'jobs', job.id, 'payload', 'results.ndjson'));
  await fs.access(path.join(dataDir, 'jobs', job.id, 'payload', 'channel-results.ndjson'));

  const restoredStore = new JobStore(dataDir);
  await restoredStore.init();
  const restoredJob = restoredStore.get(job.id);
  const restoredQueuedJob = restoredStore.get(queuedJob.id);
  const restoredCampaign = restoredStore.getCampaign(campaign.id);

  assert.equal(restoredJob.status, 'interrupted');
  assert.equal(restoredJob.progress, 50);
  assert.equal(restoredJob.error.code, 'SERVER_RESTARTED');
  assert.equal(restoredJob.channelResults.xiaohongshu.records, 12);
  assert.equal(restoredQueuedJob.status, 'interrupted');
  assert.equal(restoredQueuedJob.progress, 0);
  assert.equal(restoredCampaign.brief.brand, '测试品牌');
  assert.deepEqual(restoredCampaign.selectedCreatorIds, ['creator-1']);
  assert.equal(restoredCampaign.discoveryJobId, job.id);
  assert.deepEqual(restoredCampaign.verificationJobIds, [verificationJob.id]);
  assert.deepEqual(restoredCampaign.enrichmentJobIds, [enrichmentJob.id]);
  assert.deepEqual(restoredCampaign.contentJobIds, [contentJob.id]);
  await restoredStore.flush();
});
