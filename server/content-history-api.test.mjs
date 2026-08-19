import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalCreatorIdentity } from './normalizer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, processHandle, startupErrors = []) {
  let lastStatus = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error('Content history test server exited before becoming ready.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = response.ok ? await response.json() : null;
      lastStatus = health
        ? `${response.status} ${health.storage?.initialization || 'unknown'}`
        : `${response.status} unavailable`;
      if (health?.status === 'ok' && health.storage?.initialization === 'ready') return;
    } catch {
      // The local server may still be binding its port.
    }
    await delay(100);
  }
  throw new Error(`Content history test server did not become ready: ${lastStatus} ${startupErrors.join('')}`);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([once(processHandle, 'exit'), delay(3000)]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

test('content history lists, filters, expands, and exports persisted records across jobs', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-history-'));
  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const firstJobId = 'c7c0a0e0-2000-4000-8000-000000000001';
  const secondJobId = 'c7c0a0e0-2000-4000-8000-000000000002';
  const searchJobId = 'c7c0a0e0-2000-4000-8000-000000000003';
  const commentsJobId = 'c7c0a0e0-2000-4000-8000-000000000004';
  const mediaJobId = 'c7c0a0e0-2000-4000-8000-000000000005';
  const firstTargetId = 'history-creator-001';
  const secondTargetId = 'history-creator-002';
  const firstSourceUrl = 'https://www.douyin.com/user/history-creator-one';
  const secondSourceUrl = 'https://www.douyin.com/user/history-creator-two';
  const capture = ({ targetId, name, sourceUrl, capturedAt, title }) => ({
    id: `capture-${targetId}`,
    targetId,
    channel: 'douyin',
    platform: 'douyin',
    identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
    name,
    sourceUrl,
    capturedAt,
    status: 'succeeded',
    profile: {
      displayName: name,
      handle: `@${targetId}`,
      bio: '公开主页简介',
      followerCount: 1234,
      followerLabel: '1.2k',
    },
    content: {
      visibleSampleCount: 1,
      requestedSampleLimit: 1,
      visibleSamples: [{
        sourceUrl: `https://www.douyin.com/video/${targetId}`,
        title,
        summary: '已保存的公开内容摘要',
        contentType: 'video',
        coverUrl: 'https://example.com/cover.jpg',
        videoUrl: 'https://example.com/video.mp4',
        interactions: { diggCount: 99, commentCount: 8 },
      }],
    },
  });
  let api = null;

  t.after(async () => {
    await stopProcess(api);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [
      {
        id: firstJobId,
        type: 'content',
        status: 'succeeded',
        progress: 100,
        query: '短发女',
        channels: ['douyin'],
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:02:00.000Z',
        results: [capture({ targetId: firstTargetId, name: '短发女博主', sourceUrl: firstSourceUrl, capturedAt: '2026-07-30T00:02:00.000Z', title: '短发造型分享' })],
        channelResults: {},
        metrics: { contentCaptures: 1, visibleContentSamples: 1 },
      },
      {
        id: secondJobId,
        type: 'content',
        status: 'succeeded',
        progress: 100,
        query: '通勤穿搭',
        channels: ['douyin'],
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:02:00.000Z',
        results: [capture({ targetId: secondTargetId, name: '通勤穿搭博主', sourceUrl: secondSourceUrl, capturedAt: '2026-07-31T00:02:00.000Z', title: '通勤穿搭记录' })],
        channelResults: {},
        metrics: { contentCaptures: 1, visibleContentSamples: 1 },
      },
      {
        id: searchJobId,
        type: 'post_search',
        status: 'succeeded',
        progress: 100,
        query: '短发视频',
        channels: ['douyin'],
        createdAt: '2026-07-31T00:03:00.000Z',
        updatedAt: '2026-07-31T00:04:00.000Z',
        target: {},
        result: {
          query: '短发视频',
          posts: [
            { postId: 'post-001', title: '短发视频示例', authorName: '示例博主', contentUrl: 'https://www.douyin.com/video/post-001', coverUrl: 'https://example.com/post-cover-001.jpg' },
            { postId: 'post-002', title: '短发视频示例二', authorName: '示例博主二', contentUrl: 'https://www.douyin.com/video/post-002', coverUrl: 'https://example.com/post-cover-002.jpg' },
            { postId: 'post-003', title: '短发视频示例三', authorName: '示例博主三', contentUrl: 'https://www.douyin.com/video/post-003', coverUrl: 'https://example.com/post-cover-003.jpg' },
          ],
          total: 3,
          source: 'browser_relay',
          sourceUrl: 'https://www.douyin.com/search/短发视频',
        },
        metrics: { requested: 24, posts: 3, resultCount: 3 },
      },
      {
        id: commentsJobId,
        type: 'post_search_comments',
        status: 'succeeded',
        progress: 100,
        query: '短发视频',
        channels: ['douyin'],
        createdAt: '2026-07-31T00:05:00.000Z',
        updatedAt: '2026-07-31T00:06:00.000Z',
        target: { postId: 'post-001', postUrl: 'https://www.douyin.com/video/post-001', authorName: '示例博主' },
        result: {
          postId: 'post-001',
          postUrl: 'https://www.douyin.com/video/post-001',
          post: { postId: 'post-001', title: '短发视频示例', authorName: '示例博主', contentUrl: 'https://www.douyin.com/video/post-001' },
          comments: [{ commentId: 'comment-001', authorName: '热评用户', text: '这个造型很适合', likeCount: 18 }],
          summary: { summary: '用户集中讨论造型适配度' },
          total: 1,
          sourceUrl: 'https://www.douyin.com/video/post-001',
        },
        metrics: { requested: 10, comments: 1, resultCount: 1 },
      },
      {
        id: mediaJobId,
        type: 'post_search_media',
        status: 'succeeded',
        progress: 100,
        query: '短发视频',
        channels: ['douyin'],
        createdAt: '2026-07-31T00:07:00.000Z',
        updatedAt: '2026-07-31T00:08:00.000Z',
        target: { postId: 'post-001', postUrl: 'https://www.douyin.com/video/post-001', authorName: '示例博主', post: { postId: 'post-001', title: '短发视频示例', authorName: '示例博主', contentUrl: 'https://www.douyin.com/video/post-001', videoUrl: 'https://example.com/post.mp4' } },
        result: {
          postId: 'post-001',
          post: { postId: 'post-001', title: '短发视频示例', authorName: '示例博主', contentUrl: 'https://www.douyin.com/video/post-001', videoUrl: 'https://example.com/post.mp4' },
          video: { frames: [{ frameUrl: 'https://example.com/frame-001.jpg', timestamp: 1.5 }], playbackUrl: 'https://example.com/post.mp4' },
          sourceUrl: 'https://www.douyin.com/video/post-001',
        },
        metrics: { requested: 6, frames: 1, resultCount: 1 },
      },
    ],
    campaigns: [],
  }, null, 2), 'utf8');

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, KOLFORGE_DATA_DIR: dataDir, KOLFORGE_PORT: String(apiPort) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const startupErrors = [];
  api.stderr.on('data', (chunk) => startupErrors.push(chunk.toString()));
  await waitForHealth(baseUrl, api, startupErrors);

  const pageResponse = await fetch(`${baseUrl}/api/content-history?type=content&limit=1`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.total, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].name, '通勤穿搭博主');
  assert.equal(page.nextCursor, '1');

  const filteredResponse = await fetch(`${baseUrl}/api/content-history?type=content&q=${encodeURIComponent('短发女')}`);
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.records[0].targetId, firstTargetId);

  const directResponse = await fetch(`${baseUrl}/api/content-history?type=job&q=${encodeURIComponent('短发视频')}`);
  assert.equal(directResponse.status, 200);
  const direct = await directResponse.json();
  assert.equal(direct.total, 3);
  assert.ok(direct.records.some((record) => record.jobType === 'post_search' && record.sampleCount === 3));
  assert.ok(direct.records.some((record) => record.jobType === 'post_search_comments' && record.sampleCount === 1));
  assert.ok(direct.records.some((record) => record.jobType === 'post_search_media' && record.sampleCount === 1));

  const directSearchRecord = direct.records.find((record) => record.jobType === 'post_search');
  const directDetailResponse = await fetch(`${baseUrl}/api/content-history/detail?id=${encodeURIComponent(directSearchRecord.id)}`);
  assert.equal(directDetailResponse.status, 200);
  const directDetail = await directDetailResponse.json();
  assert.equal(directDetail.job.type, 'post_search');
  assert.equal(directDetail.job.result.posts.length, 3);
  assert.equal(directDetail.postSearchSnapshot.posts.length, 3);
  assert.deepEqual(directDetail.postSearchSnapshot.posts.map((post) => post.postId), ['post-001', 'post-002', 'post-003']);

  const detailResponse = await fetch(`${baseUrl}/api/content-history/detail?id=${encodeURIComponent(filtered.records[0].id)}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.record.sourceContentJobId, firstJobId);
  assert.equal(detail.content.content.visibleSamples[0].title, '短发造型分享');
  assert.equal(detail.content.profile.displayName, '短发女博主');

  const exportResponse = await fetch(`${baseUrl}/api/content-history/export`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition') || '', /attachment/);
  const exported = await exportResponse.json();
  assert.equal(exported.total, 5);
  assert.equal(exported.records.length, 5);
  const exportedContentRecord = exported.records.find((entry) => entry.record?.recordType === 'content');
  assert.equal(exportedContentRecord.content.content.visibleSamples[0].videoUrl, 'https://example.com/video.mp4');
});
