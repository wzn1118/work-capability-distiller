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
  let lastStatus = 'unavailable';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Content analysis test server exited before becoming ready: ${lastStatus}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.status === 'ok' && health.storage?.initialization === 'ready') return;
      lastStatus = health?.storage?.initialization || `HTTP ${response.status}`;
    } catch {
      // The process may still be binding its local port.
    }
    await delay(100);
  }
  throw new Error(`Content analysis test server did not become ready: ${lastStatus}`);
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
  throw new Error(`Content analysis job ${jobId} did not become terminal: ${latest?.status || 'unknown'}`);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([once(processHandle, 'exit'), delay(3000)]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

test('content analysis persists a deterministic evidence matrix and campaign linkage', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-analysis-api-'));
  const discoveryJobId = 'd7c0a0e0-2000-4000-8000-000000000011';
  const contentJobId = 'd7c0a0e0-2000-4000-8000-000000000012';
  const campaignId = 'd7c0a0e0-2000-4000-8000-000000000013';
  const newerContentJobId = 'd7c0a0e0-2000-4000-8000-000000000014';
  const priorAnalysisJobId = 'd7c0a0e0-2000-4000-8000-000000000015';
  const legacyAnalysisJobId = 'd7c0a0e0-2000-4000-8000-000000000016';
  const creatorId = 'douyin-analysis-creator-001';
  const sourceUrl = 'https://www.douyin.com/user/analysis-creator';
  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  let api = null;

  t.after(async () => {
    await stopProcess(api);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      id: contentJobId,
      type: 'content',
      status: 'succeeded',
      progress: 100,
      query: 'skin care',
      channels: ['douyin'],
      campaignId,
      discoveryJobId,
      selectedCreatorIds: [creatorId],
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      startedAt: '2026-07-22T00:00:00.000Z',
      finishedAt: '2026-07-22T00:01:00.000Z',
      events: [],
      channelResults: {},
      metrics: { contentCaptures: 1, visibleContentSamples: 2 },
      results: [{
        id: 'content-capture-1',
        targetId: creatorId,
        discoveryCreatorId: creatorId,
        channel: 'douyin',
        platform: 'douyin',
        name: 'Analysis Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
        capturedAt: '2026-07-22T00:01:00.000Z',
        evidence: { publicDataScope: 'profile_and_visible_content' },
        content: {
          visibleSamples: [
            {
              sourceUrl: 'https://www.douyin.com/video/analysis-one',
              title: '',
              summary: 'A detailed tutorial and review for a skincare routine.',
              contentType: 'video',
              hashtags: ['skincare', 'tutorial'],
              interactions: { digg_count: 260, comment_count: 12 },
            },
            {
              sourceUrl: 'https://www.douyin.com/video/analysis-two',
              title: '',
              summary: 'A daily product recommendation with practical steps.',
              contentType: 'video',
              hashtags: ['skincare', 'recommendation'],
              interactions: { digg_count: 118 },
            },
          ],
        },
      }],
      error: null,
    }, {
      id: newerContentJobId,
      type: 'content',
      status: 'succeeded',
      progress: 100,
      query: 'skin care',
      channels: ['douyin'],
      campaignId,
      discoveryJobId,
      selectedCreatorIds: [creatorId],
      createdAt: '2026-07-22T00:02:00.000Z',
      updatedAt: '2026-07-22T00:02:00.000Z',
      startedAt: '2026-07-22T00:02:00.000Z',
      finishedAt: '2026-07-22T00:03:00.000Z',
      events: [],
      channelResults: {},
      metrics: { contentCaptures: 0, visibleContentSamples: 0 },
      results: [],
      error: null,
    }, {
      id: priorAnalysisJobId,
      type: 'content_analysis',
      status: 'succeeded',
      progress: 100,
      query: 'skin care',
      channels: ['douyin'],
      campaignId,
      discoveryJobId,
      contentJobId: newerContentJobId,
      selectedCreatorIds: [creatorId],
      createdAt: '2020-07-22T00:04:00.000Z',
      updatedAt: '2020-07-22T00:04:00.000Z',
      startedAt: '2020-07-22T00:04:00.000Z',
      finishedAt: '2020-07-22T00:05:00.000Z',
      events: [],
      channelResults: {},
      metrics: { analyzedCreators: 0 },
      results: [],
      error: null,
    }, {
      id: legacyAnalysisJobId,
      type: 'content_analysis',
      status: 'succeeded',
      progress: 100,
      query: 'skin care',
      channels: ['douyin'],
      campaignId,
      discoveryJobId,
      contentJobId,
      selectedCreatorIds: [creatorId],
      createdAt: '2026-07-22T00:04:00.000Z',
      updatedAt: '2026-07-22T00:05:00.000Z',
      startedAt: '2026-07-22T00:04:00.000Z',
      finishedAt: '2026-07-22T00:05:00.000Z',
      events: [],
      channelResults: {},
      metrics: { analyzedCreators: 1 },
      sourceCaptures: [{
        id: 'content-capture-1',
        targetId: creatorId,
        discoveryCreatorId: creatorId,
        channel: 'douyin',
        platform: 'douyin',
        name: 'Analysis Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
        capturedAt: '2026-07-22T00:01:00.000Z',
        evidence: { publicDataScope: 'profile_and_visible_content' },
        content: {
          visibleSamples: [
            {
              sourceUrl: 'https://www.douyin.com/video/analysis-one',
              summary: 'A detailed tutorial and review for a skincare routine.',
              contentType: 'video',
              hashtags: ['skincare', 'tutorial'],
              interactions: { digg_count: 260, comment_count: 12 },
            },
            {
              sourceUrl: 'https://www.douyin.com/video/analysis-two',
              summary: 'A daily product recommendation with practical steps.',
              contentType: 'video',
              hashtags: ['skincare', 'recommendation'],
              interactions: { digg_count: 118 },
            },
          ],
        },
      }],
      results: [{
        schemaVersion: 1,
        id: `content-analysis-${creatorId}`,
        targetId: creatorId,
        discoveryCreatorId: creatorId,
        channel: 'douyin',
        platform: 'douyin',
        name: 'Analysis Creator',
        sourceUrl,
        identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
        sourceContentJobId: contentJobId,
        sourceContentCapturedAt: '2026-07-22T00:01:00.000Z',
        analyzedAt: '2026-07-22T00:05:00.000Z',
        status: 'completed',
        analysis: {
          schemaVersion: 'content-analysis-matrix/v2',
          status: 'completed',
          capturedAt: '2026-07-22T00:05:00.000Z',
          source: { inputFingerprint: 'legacy-v2-input' },
          evidence: [],
          roles: [],
          video: {
            schemaVersion: 'video-evidence/v2',
            status: 'completed',
            coverage: {
              eligibleVideoSampleCount: 2,
              selectedVideoSampleCount: 1,
              selectedSampleIndexes: [1],
            },
            videos: [{
              sampleIndex: 1,
              sourceUrl: 'https://www.douyin.com/video/analysis-one',
              contentType: 'video',
              status: 'completed',
              selectionRank: 1,
              selectionReason: 'visible_source_order_fallback',
              rendered: {
                durationSeconds: 42,
                dimensions: { width: 1080, height: 1920 },
                evidence: 'legacy_rendered_public_video',
              },
              frames: [{
                index: 1,
                timeSeconds: 12,
                artifactPath: 'analysis/douyin/1/legacy-frame-01.jpg',
                ocrText: 'Legacy skincare routine step',
              }],
              ocr: { status: 'completed' },
              transcript: { status: 'not_available' },
              vision: { status: 'not_available' },
              limitations: [],
            }],
            limitations: ['Legacy selected subset.'],
          },
        },
      }],
      error: null,
    }],
    campaigns: [{
      id: campaignId,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      brief: { product: 'skincare' },
      channels: ['douyin'],
      discoveryJobId,
      verificationJobIds: [],
      enrichmentJobIds: [],
      contentJobIds: [contentJobId, newerContentJobId],
      contentAnalysisJobIds: [priorAnalysisJobId],
      selectedCreatorIds: [creatorId],
      generated: false,
      sentCreatorIds: [],
      currentStep: 4,
    }],
  }, null, 2), 'utf8');

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(apiPort),
      KOLFORGE_CONTENT_ANALYSIS_PROVIDER: 'openai_responses',
      KOLFORGE_CONTENT_ANALYSIS_MODEL: '',
      KOLFORGE_CONTENT_ANALYSIS_API_KEY: '',
      KOLFORGE_CONTENT_ANALYSIS_OLLAMA_MODEL: '',
      KOLFORGE_VIDEO_ANALYSIS_ENABLED: 'false',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/content-analysis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ campaignId, contentJobId, creatorIds: [creatorId] }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.job.type, 'content_analysis');
  assert.equal(created.job.contentJobId, contentJobId);

  const completed = await waitForTerminalJob(baseUrl, created.job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.metrics.analyzedCreators, 1);
  assert.equal(completed.metrics.deterministicCreators, 1);

  const analysisResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/content-analysis`);
  assert.equal(analysisResponse.status, 200);
  const analysisPayload = await analysisResponse.json();
  assert.equal(analysisPayload.analyses.length, 1);
  const record = analysisPayload.analyses[0];
  const contentResponse = await fetch(`${baseUrl}/api/jobs/${contentJobId}/content`);
  assert.equal(contentResponse.status, 200);
  const contentPayload = await contentResponse.json();
  const sourceCapture = contentPayload.content.find((capture) => capture.targetId === creatorId);
  assert.ok(sourceCapture);
  assert.equal(record.analysis.mode, 'deterministic_evidence_matrix');
  assert.equal(record.analysis.model.status, 'not_configured');
  assert.equal(record.analysis.coverage.summaryObservedSampleCount, 2);
  assert.equal(record.analysis.source.freshness, 'current_snapshot');
  assert.equal(record.analysis.roles.length, 7);
  assert.equal(record.analysis.video.status, 'disabled');
  assert.equal(record.sourceContentJobId, contentJobId);
  assert.equal(record.sourceContentCapturedAt, sourceCapture.capturedAt);
  assert.equal(record.analysis.source.contentCaptureId, sourceCapture.id);
  assert.ok(record.analysis.source.inputFingerprint);
  assert.equal(record.analysis.contentItems.length, sourceCapture.content.visibleSamples.length);
  assert.equal(completed.metrics.sampledVideoFrames, 0);
  assert.equal(
    completed.metrics.findings,
    record.analysis.roles.reduce((total, role) => total + role.findings.length, 0),
  );
  const evidenceIds = new Set(record.analysis.evidence.map((entry) => entry.id));
  record.analysis.contentItems.forEach((item, index) => {
    const sourceSample = sourceCapture.content.visibleSamples[index];
    const itemEvidenceIds = record.analysis.evidence
      .filter((entry) => entry.sampleIndex === index + 1)
      .map((entry) => entry.id)
      .sort();
    assert.equal(item.id, `sample:${index + 1}`);
    assert.equal(item.sampleIndex, index + 1);
    assert.equal(item.sourceUrl, sourceSample.sourceUrl);
    assert.deepEqual([...item.evidenceIds].sort(), itemEvidenceIds);
    for (const signal of item.signals) {
      for (const evidenceId of signal.evidenceIds) assert.ok(item.evidenceIds.includes(evidenceId));
    }
    for (const finding of item.findings) {
      for (const evidenceId of finding.evidenceIds) assert.ok(item.evidenceIds.includes(evidenceId));
    }
  });
  for (const role of record.analysis.roles) {
    for (const finding of role.findings) {
      for (const evidenceId of finding.evidenceIds) assert.ok(evidenceIds.has(evidenceId));
    }
  }

  const legacyResponse = await fetch(`${baseUrl}/api/jobs/${legacyAnalysisJobId}/content-analysis`);
  assert.equal(legacyResponse.status, 200);
  const legacyPayload = await legacyResponse.json();
  const legacyAnalysis = legacyPayload.analyses[0].analysis;
  assert.equal(legacyAnalysis.schemaVersion, 'content-analysis-matrix/v2');
  assert.equal(legacyAnalysis.videoAnalysis.schemaVersion, 'creator-video-analysis/v1');
  assert.equal(legacyAnalysis.videoAnalysis.items.length, 2);
  assert.deepEqual(legacyAnalysis.videoAnalysis.items.map((item) => item.status), ['completed', 'not_selected']);
  assert.equal(legacyAnalysis.videoAnalysis.rollup.coverage.eligibleVideoCount, 2);
  assert.equal(legacyAnalysis.videoAnalysis.rollup.coverage.completedVideoCount, 1);
  assert.equal(legacyAnalysis.videoAnalysis.rollup.coverage.notSelectedVideoCount, 1);
  const legacyEvidenceIds = new Set(legacyAnalysis.evidence.map((entry) => entry.id));
  for (const item of legacyAnalysis.videoAnalysis.items) {
    assert.ok(item.evidenceIds.every((id) => legacyEvidenceIds.has(id)));
  }

  const artifactsResponse = await fetch(`${baseUrl}${analysisPayload.artifactsUrl}`);
  assert.equal(artifactsResponse.status, 200);
  const artifactIds = (await artifactsResponse.json()).artifacts.map((artifact) => artifact.id);
  assert.ok(artifactIds.includes('analysis/douyin/1/creator_content_analysis_latest.json'));

  const campaignResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}`);
  assert.equal(campaignResponse.status, 200);
  const campaignPayload = await campaignResponse.json();
  assert.deepEqual(campaignPayload.campaign.contentAnalysisJobIds, [priorAnalysisJobId, created.job.id]);
  assert.equal(campaignPayload.campaign.contentAnalysisJobId, created.job.id);
  assert.equal(campaignPayload.currentContentJob.id, newerContentJobId);
  assert.equal(campaignPayload.currentContentAnalysisJob.id, created.job.id);

  const draftResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}/outreach-drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentAnalysisJobId: created.job.id }),
  });
  assert.equal(draftResponse.status, 201);
  const draftPayload = await draftResponse.json();
  assert.equal(draftPayload.contentAnalysisJob.id, created.job.id);
  assert.deepEqual(draftPayload.summary, {
    total: 1,
    ready: 1,
    blocked: 0,
    stale: 0,
    multimodal: 1,
    review: { draft: 1, approved: 0, sent: 0 },
  });
  assert.equal(draftPayload.drafts.length, 1);
  assert.equal(draftPayload.drafts[0].targetId, creatorId);
  assert.equal(draftPayload.drafts[0].status, 'ready');
  assert.equal(draftPayload.drafts[0].source.freshness, 'current_snapshot');
  assert.equal(draftPayload.drafts[0].evidence.primary.sourceUrl, sourceCapture.content.visibleSamples[0].sourceUrl);
  assert.ok(draftPayload.drafts[0].message.body.includes('skincare'));

  const updatedMessage = 'Hello Analysis Creator, your practical skincare tutorial is a strong fit for a co-created product walkthrough.';
  const draftPatchResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}/outreach-drafts/${creatorId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageBody: updatedMessage, reviewStatus: 'sent' }),
  });
  assert.equal(draftPatchResponse.status, 200);
  const draftPatchPayload = await draftPatchResponse.json();
  assert.equal(draftPatchPayload.draft.message.body, updatedMessage);
  assert.equal(draftPatchPayload.draft.review.status, 'sent');
  assert.equal(draftPatchPayload.campaign.generated, true);
  assert.deepEqual(draftPatchPayload.campaign.sentCreatorIds, [creatorId]);

  const draftGetResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}/outreach-drafts`);
  assert.equal(draftGetResponse.status, 200);
  const draftGetPayload = await draftGetResponse.json();
  assert.equal(draftGetPayload.drafts[0].message.body, updatedMessage);
  assert.equal(draftGetPayload.drafts[0].review.status, 'sent');

  const corsResponse = await fetch(`${baseUrl}/api/campaigns/${campaignId}/outreach-drafts/${creatorId}`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(corsResponse.status, 204);
  assert.match(corsResponse.headers.get('access-control-allow-methods') || '', /PATCH/);
});

test('content analysis completes every selected creator with bounded parallel pipelines', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-content-analysis-parallel-'));
  const contentJobId = 'd7c0a0e0-2000-4000-8000-000000000021';
  const creatorIds = [
    'douyin-analysis-parallel-001',
    'douyin-analysis-parallel-002',
    'douyin-analysis-parallel-003',
  ];
  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  let api = null;

  t.after(async () => {
    await stopProcess(api);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const captures = creatorIds.map((creatorId, index) => {
    const sourceUrl = `https://www.douyin.com/user/parallel-${index + 1}`;
    return {
      id: `content-capture-parallel-${index + 1}`,
      targetId: creatorId,
      discoveryCreatorId: creatorId,
      channel: 'douyin',
      platform: 'douyin',
      name: `Parallel Creator ${index + 1}`,
      sourceUrl,
      identityKey: canonicalCreatorIdentity('douyin', sourceUrl),
      capturedAt: '2026-07-23T00:01:00.000Z',
      evidence: { publicDataScope: 'profile_and_visible_content' },
      content: {
        visibleSamples: [{
          sourceUrl: `https://www.douyin.com/video/parallel-${index + 1}`,
          summary: `Visible public tutorial ${index + 1}.`,
          contentType: 'video',
          interactions: { digg_count: 100 - index },
        }],
      },
    };
  });
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      id: contentJobId,
      type: 'content',
      status: 'succeeded',
      progress: 100,
      query: 'parallel content',
      channels: ['douyin'],
      selectedCreatorIds: creatorIds,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
      startedAt: '2026-07-23T00:00:00.000Z',
      finishedAt: '2026-07-23T00:01:00.000Z',
      events: [],
      channelResults: {},
      metrics: { contentCaptures: captures.length, visibleContentSamples: captures.length },
      results: captures,
      error: null,
    }],
    campaigns: [],
  }, null, 2), 'utf8');

  api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KOLFORGE_DATA_DIR: dataDir,
      KOLFORGE_PORT: String(apiPort),
      KOLFORGE_CONTENT_ANALYSIS_PROVIDER: 'openai_responses',
      KOLFORGE_CONTENT_ANALYSIS_MODEL: '',
      KOLFORGE_CONTENT_ANALYSIS_API_KEY: '',
      KOLFORGE_CONTENT_ANALYSIS_OLLAMA_MODEL: '',
      KOLFORGE_VIDEO_ANALYSIS_ENABLED: 'false',
      KOLFORGE_VIDEO_CREATOR_CONCURRENCY: '2',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForHealth(baseUrl, api);

  const createResponse = await fetch(`${baseUrl}/api/content-analysis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentJobId, allCapturedCreators: true }),
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.job.targetScope, 'all_captured_creators');
  assert.equal(created.job.selectedCreatorIds.length, creatorIds.length);
  const completed = await waitForTerminalJob(baseUrl, created.job.id);

  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.results.length, 3);
  assert.equal(new Set(completed.results.map((entry) => entry.targetId)).size, 3);
  assert.equal(completed.metrics.analyzedCreators, 3);
  assert.equal(completed.metrics.analysisTargets, 3);
  assert.equal(completed.metrics.pendingWorkItems, 0);
  assert.equal(Object.keys(completed.channelResults).length, 3);
  assert.equal(Object.values(completed.channelResults).every((result) => result.status === 'succeeded'), true);
  assert.equal(completed.videoProgress, null);
  assert.deepEqual(completed.videoProgressByTarget, {});
  for (let index = 0; index < captures.length; index += 1) {
    await fs.access(path.join(
      dataDir,
      'jobs',
      created.job.id,
      'analysis',
      'douyin',
      String(index + 1),
      'creator_content_analysis_latest.json',
    ));
  }
});
