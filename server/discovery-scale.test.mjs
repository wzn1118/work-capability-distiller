import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    if (processHandle.exitCode !== null) {
      throw lastError || new Error('Discovery scale test server exited before becoming ready.');
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health.storage?.initialization === 'ready') return;
      lastError = new Error(`Discovery scale test server is ${health?.storage?.initialization || 'unavailable'}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error('Discovery scale test server did not become ready.');
}

async function waitForTerminalJob(baseUrl, jobId) {
  let latest = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    assert.equal(response.status, 200);
    latest = (await response.json()).job;
    if (!['queued', 'running'].includes(latest.status)) return latest;
    await delay(50);
  }
  throw new Error(`Discovery job ${jobId} did not become terminal: ${latest?.status || 'unknown'}`);
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

function creator(id) {
  return {
    name: `Creator ${id}`,
    profile_url: `https://www.douyin.com/user/${id}`,
    follower_count: '12.3w',
    title: `Visible ${id} content`,
  };
}

test('discovery fans out bounded keyword routes, preserves a high per-channel target, and dedupes creator identities', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-discovery-scale-'));
  const apiPort = await availablePort();
  const partnerPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const partnerRequests = [];
  let api = null;

  const recordsByQuery = new Map([
    ['护肤', [creator('a'), creator('b'), creator('c')]],
    ['敏感肌', [creator('b'), creator('d')]],
    ['抗老', [creator('a'), creator('e')]],
  ]);
  const partner = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    partnerRequests.push(payload);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: recordsByQuery.get(payload.query) || [] }));
  });
  partner.listen(partnerPort, '127.0.0.1');
  await once(partner, 'listening');

  t.after(async () => {
    await stopProcess(api);
    await stopServer(partner);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(apiPort),
      KOLFORGE_MAX_DISCOVERY_PER_CHANNEL: '3000',
      KOLFORGE_DISCOVERY_QUERY_VARIANTS: '3',
      DOUYIN_CONNECTOR: 'partner_http',
      DOUYIN_PARTNER_URL: `http://127.0.0.1:${partnerPort}/collect`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'discover',
      channels: ['douyin'],
      query: '护肤',
      querySeeds: ['敏感肌', '抗老'],
      limit: 1500,
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.job.type, 'discover');
  assert.equal(created.job.limit, 1500);

  const completed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.limit, 1500);
  assert.deepEqual(completed.queryPlan, ['护肤', '敏感肌', '抗老']);
  assert.deepEqual(partnerRequests.map((entry) => entry.query), ['护肤', '敏感肌', '抗老']);
  assert.equal(partnerRequests.length, 3);
  assert.equal(partnerRequests.every((entry) => (
    entry.platform === 'douyin'
      && entry.mode === 'discover'
      && entry.target === null
      && Number.isInteger(entry.limit)
      && entry.limit > 0
      && entry.limit <= 1500
  )), true);

  assert.deepEqual(
    Object.keys(completed.channelResults).sort(),
    ['douyin:route:1', 'douyin:route:2', 'douyin:route:3'],
  );
  const routeRecordCounts = [3, 2, 2];
  for (const [index, query] of completed.queryPlan.entries()) {
    const route = completed.channelResults[`douyin:route:${index + 1}`];
    assert.ok(route);
    assert.equal(route.status, 'succeeded');
    assert.equal(route.requestedLimit, 675);
    assert.equal(route.queryCount, 1);
    assert.equal(route.records, routeRecordCounts[index]);
    assert.equal(route.creators, routeRecordCounts[index]);
    assert.deepEqual(route.route, {
      index,
      total: 3,
      limit: 675,
      query,
    });
  }
  assert.equal(completed.metrics.sourceRecords, 7);
  assert.equal(completed.metrics.creators, 5);
  assert.equal(completed.metrics.queryRoutes, 3);
  assert.equal(completed.metrics.requestedCandidates, 1500);
  assert.equal(completed.results.length, 5);
  assert.deepEqual(
    new Set(completed.results.map((entry) => entry.identityKey)),
    new Set(['douyin:a', 'douyin:b', 'douyin:c', 'douyin:d', 'douyin:e']),
  );

  const summaryResponse = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(created.job.id)}?summary=1`);
  assert.equal(summaryResponse.status, 200);
  const summary = (await summaryResponse.json()).job;
  assert.equal(summary.resultCount, 5);
  assert.equal(Object.hasOwn(summary, 'results'), false);

  const firstCandidatePage = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(created.job.id)}/candidates?limit=2`);
  assert.equal(firstCandidatePage.status, 200);
  const firstCandidatePayload = await firstCandidatePage.json();
  assert.equal(firstCandidatePayload.total, 5);
  assert.equal(firstCandidatePayload.candidates.length, 2);
  assert.equal(firstCandidatePayload.nextCursor, '2');

  const secondCandidatePage = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(created.job.id)}/candidates?cursor=2&limit=1000`);
  assert.equal(secondCandidatePage.status, 200);
  const secondCandidatePayload = await secondCandidatePage.json();
  assert.equal(secondCandidatePayload.candidates.length, 3);
  assert.equal(secondCandidatePayload.nextCursor, null);
});

test('discovery checkpoints ten 1000-candidate routes and resumes only the failed route', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-discovery-volume-'));
  const apiPort = await availablePort();
  const partnerPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const partnerRequests = [];
  let api = null;

  const routeQueries = Array.from({ length: 10 }, (_, index) => `route-${String(index + 1).padStart(2, '0')}`);
  const failedQuery = routeQueries[4];
  const recordsByQuery = new Map(routeQueries.map((query, index) => [
    query,
    [creator('shared'), creator(`unique-${index + 1}`)],
  ]));
  let shouldFailRouteOnce = true;
  const partner = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    partnerRequests.push(payload);
    if (payload.query === failedQuery && shouldFailRouteOnce) {
      shouldFailRouteOnce = false;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'temporary fixture failure' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: recordsByQuery.get(payload.query) || [] }));
  });
  partner.listen(partnerPort, '127.0.0.1');
  await once(partner, 'listening');

  t.after(async () => {
    await stopProcess(api);
    await stopServer(partner);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(apiPort),
      KOLFORGE_MAX_DISCOVERY_PER_CHANNEL: '10000',
      KOLFORGE_DISCOVERY_QUERY_VARIANTS: '10',
      DOUYIN_CONNECTOR: 'partner_http',
      DOUYIN_PARTNER_URL: `http://127.0.0.1:${partnerPort}/collect`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'discover',
      channels: ['douyin'],
      query: routeQueries[0],
      querySeeds: routeQueries.slice(1),
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.job.type, 'discover');
  assert.equal(created.job.limit, 10000);

  const initial = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(initial.status, 'partial_success');
  assert.equal(initial.limit, 10000);
  assert.deepEqual(initial.queryPlan, routeQueries);
  assert.deepEqual(partnerRequests.map((entry) => entry.query), routeQueries);
  assert.equal(partnerRequests.length, 10);
  assert.equal(partnerRequests.every((entry) => (
    entry.platform === 'douyin'
      && entry.mode === 'discover'
      && entry.target === null
      && entry.limit === 1350
  )), true);
  assert.deepEqual(
    Object.keys(initial.channelResults).sort(),
    routeQueries.map((_, index) => `douyin:route:${index + 1}`).sort(),
  );
  assert.equal(initial.channelResults['douyin:route:5'].status, 'failed');
  assert.equal(
    Object.values(initial.channelResults).filter((result) => result.status === 'succeeded').length,
    9,
  );
  assert.equal(initial.metrics.sourceRecords, 18);
  assert.equal(initial.metrics.creators, 10);
  assert.equal(initial.metrics.queryRoutes, 10);
  assert.equal(initial.metrics.pendingWorkItems, 1);

  const resumeResponse = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(created.job.id)}/resume`, {
    method: 'POST',
  });
  assert.equal(resumeResponse.status, 202);
  const completed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.limit, 10000);
  assert.equal(partnerRequests.length, 11);
  assert.deepEqual(partnerRequests.slice(10).map((entry) => entry.query), [failedQuery]);

  for (const [index, query] of routeQueries.entries()) {
    const route = completed.channelResults[`douyin:route:${index + 1}`];
    assert.ok(route);
    assert.equal(route.status, 'succeeded');
    assert.deepEqual(route.route, {
      index,
      total: 10,
        limit: 1350,
      query,
    });
  }
  assert.equal(completed.metrics.sourceRecords, 20);
  assert.equal(completed.metrics.creators, 11);
  assert.equal(completed.metrics.queryRoutes, 10);
  assert.equal(completed.metrics.requestedCandidates, 10000);
  assert.equal(completed.metrics.pendingWorkItems, 0);
  assert.equal(completed.results.length, 11);
  assert.deepEqual(
    new Set(completed.results.map((entry) => entry.identityKey)),
    new Set([
      'douyin:shared',
      ...routeQueries.map((_, index) => `douyin:unique-${index + 1}`),
    ]),
  );
});

test('retryable public-page stops remain resumable and preserve their route evidence', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-discovery-retryable-'));
  const apiPort = await availablePort();
  const partnerPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  let api = null;
  let firstAttempt = true;

  const partner = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body before replying so the local adapter follows the normal HTTP path.
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (firstAttempt) {
      firstAttempt = false;
      response.end(JSON.stringify({
        items: [],
        collectionMeta: {
          stop_reason: 'scroll_control_failed_retryable',
          stop_evidence: { source: 'fixture', observed: 'scroll_control_failed' },
        },
      }));
      return;
    }
    response.end(JSON.stringify({
      items: [creator('recovered')],
      collectionMeta: {
        stop_reason: 'page_exhausted',
        cumulative_public_page_cards: 1,
        cumulative_unique_accounts: 1,
        stop_evidence: { source: 'fixture', observed: 'page_exhausted' },
      },
    }));
  });
  partner.listen(partnerPort, '127.0.0.1');
  await once(partner, 'listening');

  t.after(async () => {
    await stopProcess(api);
    await stopServer(partner);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(apiPort),
      KOLFORGE_MAX_DISCOVERY_PER_CHANNEL: '100',
      KOLFORGE_DISCOVERY_QUERY_VARIANTS: '1',
      DOUYIN_CONNECTOR: 'partner_http',
      DOUYIN_PARTNER_URL: `http://127.0.0.1:${partnerPort}/collect`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'discover',
      channels: ['douyin'],
      query: 'retryable-route',
      limit: 100,
    }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();

  const initial = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(initial.status, 'interrupted');
  const initialRoute = initial.channelResults['douyin:route:1'];
  assert.equal(initialRoute.status, 'retryable');
  assert.equal(initialRoute.completionReason, 'scroll_control_failed_retryable');
  assert.equal(initialRoute.attempt, 1);
  assert.deepEqual(initialRoute.stopEvidence, { source: 'fixture', observed: 'scroll_control_failed' });
  assert.equal(initial.metrics.retryableRoutes, 1);
  assert.equal(initial.metrics.pendingWorkItems, 1);

  const resumeResponse = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(created.job.id)}/resume`, { method: 'POST' });
  assert.equal(resumeResponse.status, 202);
  const completed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(completed.status, 'succeeded');
  const completedRoute = completed.channelResults['douyin:route:1'];
  assert.equal(completedRoute.status, 'succeeded');
  assert.equal(completedRoute.completionReason, 'page_exhausted');
  assert.equal(completedRoute.attempt, 2);
  assert.equal(completed.metrics.retryableRoutes, 0);
  assert.equal(completed.metrics.pendingWorkItems, 0);
  assert.equal(completed.results.length, 1);
  assert.equal(completed.results[0].identityKey, 'douyin:recovered');
});
