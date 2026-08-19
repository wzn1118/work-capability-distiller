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
    if (processHandle.exitCode !== null) throw lastError || new Error('Audience API test server exited before becoming ready.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health.storage?.initialization === 'ready') return;
      lastError = new Error(`Audience API test server is ${health?.storage?.initialization || 'unavailable'}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error('Audience API test server did not become ready.');
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([
    once(processHandle, 'exit'),
    delay(3000),
  ]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

test('audience insight API stores only normalized aggregate data and exposes its artifact', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-audience-api-'));
  const discoveryJobId = 'd7c0a0e0-1000-4000-8000-000000000001';
  const enrichmentJobId = 'd7c0a0e0-1000-4000-8000-000000000002';
  const creatorId = 'douyin-creator-001';
  const sourceUrl = 'https://www.douyin.com/user/MS4wLjABAAAA1abc';
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let api = null;

  t.after(async () => {
    await stopProcess(api);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      id: discoveryJobId,
      type: 'discover',
      status: 'succeeded',
      progress: 100,
      query: 'test topic',
      channels: ['douyin'],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      startedAt: '2026-07-21T00:00:00.000Z',
      finishedAt: '2026-07-21T00:00:00.000Z',
      events: [],
      channelResults: {},
      metrics: { creators: 1 },
      results: [{
        id: creatorId,
        channel: 'douyin',
        platform: 'Douyin',
        name: 'Test Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
      }],
      error: null,
    }, {
      id: enrichmentJobId,
      type: 'enrich',
      status: 'succeeded',
      progress: 100,
      query: 'test topic',
      channels: ['douyin'],
      discoveryJobId,
      selectedCreatorIds: [creatorId],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      startedAt: '2026-07-21T00:00:00.000Z',
      finishedAt: '2026-07-21T00:00:00.000Z',
      events: [],
      channelResults: {},
      metrics: { enrichedCreators: 1 },
      results: [{
        schemaVersion: 2,
        id: `${creatorId}-persona`,
        targetId: creatorId,
        discoveryCreatorId: creatorId,
        channel: 'douyin',
        platform: 'Douyin',
        name: 'Test Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
        capturedAt: '2026-07-21T00:00:00.000Z',
        status: 'enriched',
        profile: { publicAudienceSignals: ['Fan club visible'] },
        audience: {
          dataScope: 'public_profile_signals',
          publicSignals: ['Fan club visible'],
          aggregate: null,
        },
      }],
      error: null,
    }],
    campaigns: [],
  }, null, 2), 'utf8');

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(port),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const emptyResponse = await fetch(`${baseUrl}/api/audience-insights?discoveryJobId=${discoveryJobId}`);
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual((await emptyResponse.json()).audienceInsights, []);

  const importResponse = await fetch(`${baseUrl}/api/audience-insights/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      discoveryJobId,
      creatorId,
      payload: {
        source: { type: 'official_export', reportId: 'aggregate-report-1' },
        profile: { totalAudience: 5000 },
        audience: {
          gender: [{ label: 'female', count: 3000 }, { label: 'male', count: 2000 }],
          age: [{ label: '18-23', count: 2200 }, { label: '24-30', count: 2800 }],
          cities: [{ label: 'Beijing', count: 2500 }, { label: 'Chengdu', count: 2500 }],
          devices: [{ label: 'iOS', count: 2800 }, { label: 'Android', count: 2200 }],
          consumptionPower: [{ label: 'high', count: 2100 }, { label: 'medium', count: 2900 }],
          interests: [{ label: 'skin care', count: 3000 }, { label: 'fitness', count: 2000 }],
          activeHours: [{ hour: 20, count: 3200 }, { hour: 21, count: 1800 }],
        },
      },
    }),
  });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json();
  assert.equal(imported.audienceInsight.creatorId, creatorId);
  assert.equal(imported.audienceInsight.source.dataScope, 'aggregate');
  assert.equal(imported.audienceInsight.gender[0].percent, 60);
  assert.deepEqual(imported.audienceInsight.dimensions.device.rows, [
    { label: 'iOS', value: 2800, percent: 56 },
    { label: 'Android', value: 2200, percent: 44 },
  ]);
  assert.equal(imported.audienceInsight.dimensions.consumptionpower.rows.length, 2);

  const personasResponse = await fetch(`${baseUrl}/api/jobs/${enrichmentJobId}/personas`);
  assert.equal(personasResponse.status, 200);
  const personasPayload = await personasResponse.json();
  assert.equal(personasPayload.personas.length, 1);
  assert.equal(personasPayload.personas[0].schemaVersion, 2);
  assert.deepEqual(personasPayload.personas[0].audience.publicSignals, ['Fan club visible']);
  assert.equal(personasPayload.personas[0].audience.aggregate.creatorId, creatorId);
  assert.equal(personasPayload.personas[0].audience.aggregate.profile.totalAudience, 5000);
  assert.equal(personasPayload.personas[0].audience.aggregate.dimensions.device.rows[0].label, 'iOS');

  const enrichmentResponse = await fetch(`${baseUrl}/api/jobs/${enrichmentJobId}`);
  assert.equal(enrichmentResponse.status, 200);
  assert.equal((await enrichmentResponse.json()).job.results[0].audience.aggregate.creatorId, creatorId);

  const listResponse = await fetch(`${baseUrl}/api/audience-insights?discoveryJobId=${discoveryJobId}`);
  const listed = await listResponse.json();
  assert.equal(listed.audienceInsights.length, 1);
  assert.equal(listed.audienceInsights[0].profile.totalAudience, 5000);

  const artifactsResponse = await fetch(`${baseUrl}${imported.artifactsUrl}`);
  assert.equal(artifactsResponse.status, 200);
  const artifacts = await artifactsResponse.json();
  assert.equal(artifacts.artifacts[0].id, 'audience_insight_latest.json');

  const detailedResponse = await fetch(`${baseUrl}/api/audience-insights/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      discoveryJobId,
      creatorId,
      payload: { source: 'official_export', fans: [{ uid: 'individual-fan' }] },
    }),
  });
  assert.equal(detailedResponse.status, 400);
  assert.equal((await detailedResponse.json()).error.code, 'AUDIENCE_DETAIL_NOT_ALLOWED');
});
