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

async function waitForHealth(baseUrl, processHandle) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) throw lastError || new Error('Content API test server exited before becoming ready.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health.storage?.initialization === 'ready') return;
      lastError = new Error(`Content API test server is ${health?.storage?.initialization || 'unavailable'}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error('Content API test server did not become ready.');
}

async function waitForTerminalJob(baseUrl, jobId) {
  let latest = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    assert.equal(response.status, 200);
    latest = (await response.json()).job;
    if (!['queued', 'running'].includes(latest.status)) return latest;
    await delay(50);
  }
  throw new Error(`Content job ${jobId} did not become terminal: ${latest?.status || 'unknown'}`);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([once(processHandle, 'exit'), delay(3000)]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('content collection stores bounded public profile samples, artifacts, and campaign linkage', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-api-'));
  const discoveryJobId = 'd7c0a0e0-2000-4000-8000-000000000001';
  const campaignId = 'd7c0a0e0-2000-4000-8000-000000000002';
  const creatorId = 'douyin-content-creator-001';
  const secondCreatorId = 'douyin-content-creator-002';
  const sourceUrl = 'https://www.douyin.com/user/content-creator';
  const secondSourceUrl = 'https://www.douyin.com/user/content-creator-two';
  const apiPort = await availablePort();
  const partnerPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  let api = null;
  const receivedRequests = [];
  const requestCountBySourceUrl = new Map();
  let activePartnerRequests = 0;
  let peakPartnerRequests = 0;
  const apiEnvironment = {
    ...process.env,
    KOLFORGE_DATA_DIR: dataDir,
    KOLFORGE_PORT: String(apiPort),
    KOLFORGE_CONTENT_COLLECTION_CONCURRENCY: '2',
    DOUYIN_CONNECTOR: 'partner_http',
    DOUYIN_PARTNER_URL: `http://127.0.0.1:${partnerPort}/collect`,
  };
  const startApi = () => spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: apiEnvironment,
    stdio: 'ignore',
    windowsHide: true,
  });

  const partner = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const receivedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    activePartnerRequests += 1;
    peakPartnerRequests = Math.max(peakPartnerRequests, activePartnerRequests);
    try {
      receivedRequests.push(receivedRequest);
      const isSecondCreator = receivedRequest.target?.sourceUrl === secondSourceUrl;
      const requestAttempt = (requestCountBySourceUrl.get(receivedRequest.target?.sourceUrl) || 0) + 1;
      requestCountBySourceUrl.set(receivedRequest.target?.sourceUrl, requestAttempt);
      const continuationRecommended = isSecondCreator && requestAttempt === 1;
      // Give both bounded workers an observable overlap window. This connector
      // is partner_http, so it does not share the Browser Relay session.
      await delay(80);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        collectionMeta: continuationRecommended
          ? {
            stop_reason: 'public_profile_settled',
            stop_evidence: {
              classification: 'retryable_collection_gap',
              continuation_recommended: true,
            },
          }
          : { stop_reason: 'page_exhausted' },
        items: [{
          name: isSecondCreator ? 'Content Creator Two' : 'Content Creator',
          profile_url: isSecondCreator ? secondSourceUrl : sourceUrl,
          follower_count: '12.3w',
          profile: {
            latest_samples: Array.from({ length: 24 }, (_, index) => ({
              note_url: `https://www.douyin.com/video/${1000 + index}`,
              title: `Public sample ${index + 1}`,
              body: `Visible public sample ${index + 1}.`,
              content_type: 'video',
              hashtags: ['skincare'],
              published_at: `2026-07-${String((index % 20) + 1).padStart(2, '0')}`,
              statistics: { digg_count: 100 + index, comment_count: 2 + index },
            })),
            content_summary: {
              visible_sample_count: 24,
              sampled_from_public_profile: true,
            },
          },
        }],
      }));
    } finally {
      activePartnerRequests -= 1;
    }
  });
  partner.listen(partnerPort, '127.0.0.1');
  await once(partner, 'listening');

  t.after(async () => {
    await stopProcess(api);
    await stopServer(partner);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      id: discoveryJobId,
      type: 'discover',
      status: 'succeeded',
      progress: 100,
      query: 'skin care',
      channels: ['douyin'],
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      startedAt: '2026-07-22T00:00:00.000Z',
      finishedAt: '2026-07-22T00:00:00.000Z',
      events: [],
      channelResults: {},
      metrics: { creators: 2 },
      results: [{
        id: creatorId,
        channel: 'douyin',
        platform: 'Douyin',
        name: 'Content Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
        niche: 'skin care',
      }, {
        id: secondCreatorId,
        channel: 'douyin',
        platform: 'Douyin',
        name: 'Content Creator Two',
        sourceUrl: secondSourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', secondSourceUrl),
        niche: 'skin care',
      }],
      error: null,
    }],
    campaigns: [{
      id: campaignId,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      brief: {},
      channels: ['douyin'],
      discoveryJobId,
      verificationJobIds: [],
      enrichmentJobIds: [],
      contentJobIds: [],
      selectedCreatorIds: [creatorId, secondCreatorId],
      generated: false,
      sentCreatorIds: [],
      currentStep: 3,
    }],
  }, null, 2), 'utf8');

  api = startApi();
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/content-collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaignId,
      discoveryJobId,
      allDiscoveredCandidates: true,
      contentLimit: 24,
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.deepEqual(Object.keys(created), ['job']);
  assert.equal(created.job.type, 'content');
  assert.equal(created.job.targetScope, 'all_discovered_candidates');
  assert.equal(created.job.selectedCreatorIds.length, 2);
  assert.equal(created.job.contentLimit, 24);

  const completed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(completed.status, 'partial_success');
  assert.equal(completed.metrics.contentCaptures, 2);
  assert.equal(completed.metrics.visibleContentSamples, 48);
  assert.equal(completed.metrics.retryableContentCaptures, 1);
  assert.equal(completed.metrics.pendingWorkItems, 1);
  assert.equal(peakPartnerRequests, 2);
  assert.equal(receivedRequests.length, 2);
  assert.ok(receivedRequests.every((request) => request.mode === 'content'));
  assert.ok(receivedRequests.every((request) => request.contentLimit === 24));
  assert.deepEqual(
    receivedRequests.map((request) => request.target.sourceUrl).sort(),
    [sourceUrl, secondSourceUrl].sort(),
  );
  const retryableChannel = Object.values(completed.channelResults).find((result) => result.targetId === secondCreatorId);
  assert.equal(retryableChannel.status, 'retryable');
  assert.equal(retryableChannel.resumeState, 'continuation_recommended');
  assert.equal(retryableChannel.contentCollectionCoverage.completion, 'retryable');

  const contentResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/content`);
  assert.equal(contentResponse.status, 200);
  const contentPayload = await contentResponse.json();
  assert.equal(contentPayload.job.contentLimit, 24);
  assert.equal(contentPayload.content.length, 2);
  for (const capture of contentPayload.content) {
    assert.equal(capture.content.visibleSampleCount, 24);
    assert.equal(capture.content.visibleSamples.length, 24);
    assert.equal(capture.profileConfirmation.status, 'confirmed');
    assert.equal(capture.evidence.publicDataScope, 'profile_and_visible_content');
  }
  const firstPageResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/content?cursor=0&limit=1`);
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.content.length, 1);
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.nextCursor, '1');
  assert.equal(firstPage.content[0].content.visibleSamples, undefined);
  assert.equal(firstPage.content[0].performance, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(firstPage.content[0])) < 5_000);
  const samplesResponse = await fetch(
    `${baseUrl}/api/jobs/${created.job.id}/content/${encodeURIComponent(firstPage.content[0].targetId)}/samples?cursor=0&limit=10`,
  );
  assert.equal(samplesResponse.status, 200);
  const samplesPage = await samplesResponse.json();
  assert.equal(samplesPage.samples.length, 10);
  assert.equal(samplesPage.total, 24);
  assert.equal(samplesPage.nextCursor, '10');

  await stopProcess(api);
  api = null;
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
  const persistedContentJob = persisted.jobs.find((job) => job.id === created.job.id);
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persistedContentJob.results, undefined);
  assert.equal(persistedContentJob.targets, undefined);
  assert.equal(persistedContentJob.channelResults, undefined);
  assert.equal(persistedContentJob.resultStorage.resultCount, 2);
  api = startApi();
  await waitForHealth(baseUrl, api);

  const resumeResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/resume`, { method: 'POST' });
  assert.equal(resumeResponse.status, 202);
  const resumed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.metrics.contentCaptures, 2);
  assert.equal(resumed.metrics.visibleContentSamples, 48);
  assert.equal(resumed.metrics.retryableContentCaptures, 0);
  assert.equal(resumed.metrics.pendingWorkItems, 0);
  assert.equal(receivedRequests.length, 3);
  assert.equal(requestCountBySourceUrl.get(sourceUrl), 1);
  assert.equal(requestCountBySourceUrl.get(secondSourceUrl), 2);

  const artifactsResponse = await fetch(`${baseUrl}${contentPayload.artifactsUrl}`);
  assert.equal(artifactsResponse.status, 200);
  const artifacts = (await artifactsResponse.json()).artifacts;
  const artifactIds = artifacts.map((artifact) => artifact.id);
  assert.ok(artifactIds.includes('content/douyin/1/creator_content_latest.json'));
  assert.ok(artifactIds.includes('content/douyin/1/partner_response_latest.json'));
  const captureArtifact = artifacts.find((artifact) => artifact.id === 'content/douyin/1/creator_content_latest.json');
  assert.equal(captureArtifact.downloadable, true);
  assert.match(captureArtifact.sha256, /^[a-f0-9]{64}$/);

  const campaignResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}`);
  assert.equal(campaignResponse.status, 200);
  const campaign = (await campaignResponse.json()).campaign;
  assert.deepEqual(campaign.contentJobIds, [created.job.id]);
});

test('large content job summaries omit target and successful-result bulk while retaining blockers', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-summary-'));
  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const jobId = 'd7c0a0e0-2000-4000-8000-000000000099';
  const selectedCreatorIds = Array.from({ length: 120 }, (_, index) => `douyin-summary-${index + 1}`);
  const channelResults = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const targetId = selectedCreatorIds[index];
    const waiting = index === 29;
    return [`douyin:${targetId}`, {
      key: `douyin:${targetId}`,
      platform: 'douyin',
      targetId,
      status: waiting ? 'waiting_for_connection' : 'succeeded',
      error: waiting ? { code: 'LOGIN_REQUIRED', message: 'Login required.' } : null,
    }];
  }));
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    schemaVersion: 2,
    jobs: [{
      id: jobId,
      type: 'content',
      status: 'waiting_for_connection',
      progress: 20,
      query: 'summary',
      channels: ['douyin'],
      targets: selectedCreatorIds.map((targetId) => ({
        targetId,
        id: targetId,
        platform: 'douyin',
        sourceUrl: `https://www.douyin.com/user/${targetId}`,
      })),
      selectedCreatorIds,
      channelResults,
      results: [],
      metrics: { targetCreators: selectedCreatorIds.length, profileCoverageCount: 29 },
      events: [],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:01:00.000Z',
    }],
    campaigns: [],
  }), 'utf8');

  const api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, KOLFORGE_DATA_DIR: dataDir, KOLFORGE_PORT: String(apiPort) },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    await stopProcess(api);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, api);

  const response = await fetch(`${baseUrl}/api/jobs/${jobId}?summary=1`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const summary = JSON.parse(text).job;
  assert.equal(summary.selectedCreatorCount, 120);
  assert.deepEqual(summary.selectedCreatorIds, []);
  assert.equal(summary.channelResultCount, 30);
  assert.equal(summary.channelResultsTruncated, true);
  assert.equal(Object.keys(summary.channelResults).length, 1);
  assert.equal(Object.values(summary.channelResults)[0].error.code, 'LOGIN_REQUIRED');
  assert.ok(Buffer.byteLength(text) < 10_000);
});
