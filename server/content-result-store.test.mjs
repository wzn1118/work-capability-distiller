import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentResultStore } from './content-result-store.mjs';
import { JobStore } from './store.mjs';

function capture(targetId, sampleCount = 2) {
  return {
    targetId,
    discoveryCreatorId: targetId,
    channel: 'douyin',
    name: `Creator ${targetId}`,
    sourceUrl: `https://www.douyin.com/user/${targetId}`,
    capturedAt: '2026-07-26T00:00:00.000Z',
    content: {
      visibleSampleCount: sampleCount,
      visibleSamples: Array.from({ length: sampleCount }, (_, index) => ({
        contentItemId: `${targetId}-${index + 1}`,
        sourceUrl: `https://www.douyin.com/video/${targetId}${index + 1}`,
      })),
      itemLedger: { uniquePublicContentCount: sampleCount },
    },
  };
}

test('content result commits are idempotent and cursor pagination remains stable', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-results-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const results = new ContentResultStore(dataDir);
  const job = { id: 'job-1', type: 'content', targets: [{ id: 'a' }, { id: 'b' }] };
  await results.initializeJob(job);

  await results.commit(job.id, { capture: capture('a'), channelResult: { platform: 'douyin', targetId: 'a', status: 'succeeded' } });
  await results.commit(job.id, { capture: capture('a', 3), channelResult: { platform: 'douyin', targetId: 'a', status: 'succeeded' } });
  await results.commit(job.id, { capture: capture('b'), channelResult: { platform: 'douyin', targetId: 'b', status: 'succeeded' } });

  const first = results.list(job.id, { cursor: 0, limit: 1 });
  const second = results.list(job.id, { cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(first.content.map((entry) => entry.targetId), ['a']);
  assert.deepEqual(second.content.map((entry) => entry.targetId), ['b']);
  assert.equal(second.nextCursor, null);
  assert.equal(first.total, 2);
  assert.equal(first.content[0].audience, undefined);
  assert.equal(first.content[0].profile.followerCount, null);
  assert.equal((await results.listSamples(job.id, 'a', { cursor: 1, limit: 2 })).samples.length, 2);

  const indexText = await fs.readFile(path.join(dataDir, 'jobs', job.id, 'content-store', 'result-index.ndjson'), 'utf8');
  assert.equal(indexText.trim().split(/\r?\n/).length, 2);
});

test('content pagination skips checkpoint-only failures without inflating result totals', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-checkpoints-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const results = new ContentResultStore(dataDir);
  const job = { id: 'job-checkpoints', type: 'content', targets: [{ id: 'failed' }, { id: 'ok' }] };
  await results.initializeJob(job);

  await results.commit(job.id, {
    targetId: 'failed',
    channelResult: { platform: 'douyin', targetId: 'failed', status: 'failed' },
  });
  await results.commit(job.id, {
    capture: capture('ok'),
    channelResult: { platform: 'douyin', targetId: 'ok', status: 'succeeded' },
  });

  const page = results.list(job.id, { cursor: 0, limit: 1 });
  assert.equal(page.total, 1);
  assert.deepEqual(page.content.map((entry) => entry.targetId), ['ok']);
  assert.equal(page.nextCursor, null);
});

test('legacy content jobs migrate once and jobs.json retains metadata only', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      id: 'legacy-content',
      type: 'content',
      status: 'succeeded',
      progress: 100,
      targets: [{ id: 'a', targetId: 'a', channel: 'douyin' }],
      selectedCreatorIds: ['a'],
      results: [capture('a')],
      channelResults: { 'douyin:a': { platform: 'douyin', targetId: 'a', status: 'succeeded' } },
      metrics: { targetCreators: 1, contentCaptures: 1 },
      events: [],
    }],
    campaigns: [],
  }), 'utf8');

  const first = new JobStore(dataDir);
  await first.init();
  await first.flush();
  assert.equal(first.get('legacy-content').results.length, 1);
  const compactedAfterInit = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')).jobs[0];
  assert.equal(compactedAfterInit.results, undefined);
  assert.equal(compactedAfterInit.targets, undefined);
  assert.equal(compactedAfterInit.channelResults, undefined);

  const second = new JobStore(dataDir);
  await second.init();
  await second.persistSoon();
  await second.flush();
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')).jobs[0];
  assert.equal(saved.results, undefined);
  assert.equal(saved.targets, undefined);
  assert.equal(saved.channelResults, undefined);
  assert.equal(saved.resultStorage.resultCount, 1);
  const indexText = await fs.readFile(path.join(dataDir, 'jobs', 'legacy-content', 'content-store', 'result-index.ndjson'), 'utf8');
  assert.equal(indexText.trim().split(/\r?\n/).length, 1);
});
