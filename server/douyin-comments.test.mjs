import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DouyinCommentError, normalizeCreateRequest } from './douyin-comments/contracts.mjs';
import { isManagedLaneTarget, managedLaneUrl, selectProfileCandidate } from './douyin-comments/browser-pool.mjs';
import { DouyinCommentCheckpointStore } from './douyin-comments/checkpoint-store.mjs';
import { DouyinCommentJobController } from './douyin-comments/controller.mjs';
import { normalizeVideoCheckpoint } from './douyin-comments/normalizer.mjs';
import { chromeCandidates, douyinRelayArguments, ensureDouyinRelay } from './douyin-comments/relay-bootstrap.mjs';
import { buildDouyinCommentArchive } from './scripts/build-douyin-comment-archive.mjs';

test('normalizes a public profile request and refuses media download', () => {
  const request = normalizeCreateRequest({
    profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample?foo=bar',
    concurrency: { mode: 'fixed', maxLanes: 8 },
    downloadMedia: false,
  });
  assert.equal(request.profileUrl, 'https://www.douyin.com/user/MS4wLjABAAAAexample');
  assert.deepEqual(request.concurrency, { mode: 'fixed', maxLanes: 8 });
  assert.deepEqual(
    normalizeCreateRequest({ profileInput: '三国杀', concurrency: { mode: 'adaptive', maxLanes: 10 } }).concurrency,
    { mode: 'adaptive', maxLanes: 10 },
  );
  const byName = normalizeCreateRequest({ profileInput: '三国杀wuhu联盟' });
  assert.equal(byName.profileUrl, '');
  assert.equal(byName.profileName, '三国杀wuhu联盟');
  assert.equal(byName.expectedCreatorName, '三国杀wuhu联盟');
  assert.deepEqual(byName.concurrency, { mode: 'adaptive', maxLanes: 8 });
  const byShareLink = normalizeCreateRequest({ profileInput: 'https://v.douyin.com/ExampleShare/' });
  assert.equal(byShareLink.profileUrl, '');
  assert.equal(byShareLink.profileSourceUrl, 'https://v.douyin.com/ExampleShare/');
  assert.throws(() => normalizeCreateRequest({
    profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample',
    downloadMedia: true,
  }), /never downloads media/);
});

test('selects only a name-matching public profile from search candidates', () => {
  const candidate = selectProfileCandidate('三国杀wuhu联盟', [
    { href: 'https://www.douyin.com/user/MS4wLjABAAAAwrong', name: '三国杀官方' },
    { href: 'https://www.douyin.com/user/MS4wLjABAAAAright', name: '三国杀wuhu联盟' },
  ]);
  assert.equal(candidate.profileUrl, 'https://www.douyin.com/user/MS4wLjABAAAAright');
  assert.equal(selectProfileCandidate('不存在的账号', [{ href: 'https://www.douyin.com/user/MS4wLjABAAAAwrong', name: '三国杀官方' }]), null);
});

test('marks only collector-owned browser lanes for restart cleanup', () => {
  const url = managedLaneUrl('https://www.douyin.com/video/1234567890123456789', 'run-1');
  assert.equal(new URL(url).searchParams.get('__kolforge_comment_lane'), 'run-1');
  assert.equal(isManagedLaneTarget({ type: 'page', id: 'managed', url }), true);
  assert.equal(isManagedLaneTarget({
    type: 'page',
    id: 'user-tab',
    url: 'https://www.douyin.com/video/1234567890123456789',
  }), false);
  assert.equal(isManagedLaneTarget({ type: 'iframe', id: 'frame', url }), false);
});

test('builds an isolated Douyin relay profile and reuses an online relay', async () => {
  const environment = { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
  assert.equal(chromeCandidates(environment)[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  const args = douyinRelayArguments({ port: 18801, profileDir: 'E:\\data\\browser\\douyin-comments' });
  assert.ok(args.includes('--remote-debugging-port=18801'));
  assert.ok(args.includes('--user-data-dir=E:\\data\\browser\\douyin-comments'));
  assert.ok(args.includes('https://www.douyin.com/'));
  let spawned = false;
  const result = await ensureDouyinRelay({
    port: 18801,
    dataDir: 'E:\\data',
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:18801/test' }) }),
    spawnImpl: () => { spawned = true; return { unref() {} }; },
  });
  assert.equal(result.launched, false);
  assert.equal(spawned, false);
});

test('persists a claimed page before the task cursor is advanced', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-comment-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  await store.rememberProfileResolution('三国杀', {
    profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAresolved',
    matchedText: '三国杀',
  });
  assert.equal((await store.readProfileResolution('三国杀')).profileUrl, 'https://www.douyin.com/user/MS4wLjABAAAAresolved');
  assert.equal((await store.readProfileResolution('不存在的账号')), null);
  const job = await store.createJob({
    id: 'dcj-12345678',
    config: normalizeCreateRequest({ profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample' }),
  });
  await store.writeCatalog(job.id, {
    profile_url: job.profileUrl,
    public_video_count: 1,
    videos: [{ video_id: '1234567890123456789', content_type: 'video', video_url: 'https://www.douyin.com/video/1234567890123456789' }],
  });
  const task = await store.createTask(job.id, { kind: 'root', videoId: '1234567890123456789', nextCursor: 0, hasMore: true });
  const claimed = await store.claimNextTask(job.id, { workerId: 'lane-test', leaseMs: 45_000 });
  assert.equal(claimed.id, task.id);
  const reference = await store.writePage(job.id, claimed, 0, { requested_cursor: 0, cursor: 50, has_more: 1, comments: [] });
  await store.patchTask(job.id, task.id, { status: 'ready', lease: null, nextCursor: 50, pageRefs: [reference] });
  const restored = await store.getTask(job.id, task.id);
  assert.equal(restored.nextCursor, 50);
  assert.deepEqual(await store.readPage(job.id, restored.pageRefs[0]), { requested_cursor: 0, cursor: 50, has_more: 1, comments: [] });
});

test('loads the task index once and claims fairly without reopening every task file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-task-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  const job = await store.createJob({
    id: 'dcj-cache123',
    config: normalizeCreateRequest({ profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample' }),
  });
  await store.createTasks(job.id, [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `root-cache-${String(index).padStart(3, '0')}`,
      kind: 'root',
      videoId: String(7_000_000_000_000_000_000n + BigInt(index)),
    })),
    { id: 'reply-cache-000', kind: 'reply', videoId: '7000000000000000000', rootCommentId: 'root-1' },
  ]);

  const restarted = new DouyinCommentCheckpointStore(root);
  await restarted.init();
  assert.equal((await restarted.listTasks(job.id)).length, 13);
  restarted.getTask = async () => { throw new Error('claim must use the loaded index'); };

  const reply = await restarted.claimNextTask(job.id, { workerId: 'lane-reply', leaseMs: 45_000 });
  assert.equal(reply.kind, 'reply');
  await restarted.patchTask(job.id, reply.id, { status: 'complete', lease: null });
  const rootTask = await restarted.claimNextTask(job.id, { workerId: 'lane-root', leaseMs: 45_000, preferRoot: true });
  assert.equal(rootTask.kind, 'root');
});

test('persists a flat resolved profile and updates page progress atomically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-live-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  const job = await store.createJob({
    id: 'dcj-live1234',
    config: normalizeCreateRequest({ profileInput: '三国杀' }),
  });
  const catalog = await store.writeCatalog(job.id, {
    account_name: '三国杀',
    profile_url: 'https://www.douyin.com/user/MS4wLjABAAAAresolved',
    public_video_count: 1,
    videos: [{ video_id: '1234567890123456789' }],
  });
  assert.equal(catalog.account_name, '三国杀');
  assert.equal(catalog.profile_url, 'https://www.douyin.com/user/MS4wLjABAAAAresolved');
  const snapshot = JSON.parse(await fs.readFile(store.file(job.id, 'catalog', 'profile-snapshot.json'), 'utf8'));
  assert.equal(snapshot.account_name, '三国杀');
  const first = await store.recordPageProgress(job.id, {
    kind: 'root', received: 50, completed: false, discoveredReplyTasks: 3,
  });
  assert.equal(first.commentsCaptured, 50);
  assert.equal(first.replyTasksTotal, 3);
  const second = await store.recordPageProgress(job.id, {
    kind: 'root', received: 12, completed: true, discoveredReplyTasks: 1,
  });
  assert.equal(second.commentsCaptured, 62);
  assert.equal(second.rootTasksComplete, 1);
  assert.equal(second.replyTasksTotal, 4);
  const third = await store.recordPageProgress(job.id, {
    kind: 'reply', received: 2, completed: true,
  });
  assert.equal(third.commentsCaptured, 64);
  assert.equal(third.replyTasksComplete, 1);
  assert.deepEqual((await store.readJob(job.id)).progress, third);
});

test('imports a verified public catalog, prunes stale empty tasks, and queues collection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-catalog-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new DouyinCommentJobController({ dataDir: root, cdpUrl: 'http://127.0.0.1:18801' });
  await controller.store.init();
  controller.schedule = () => {};
  const profileUrl = 'https://www.douyin.com/user/MS4wLjABAAAAexample';
  const job = await controller.store.createJob({
    id: 'dcj-bootstrap1',
    config: normalizeCreateRequest({ profileUrl, expectedCreatorName: 'sample creator' }),
  });
  await controller.store.createTask(job.id, { kind: 'root', videoId: '9999999999999999999' });
  const result = await controller.bootstrapCatalog(job.id, {
    accountName: 'sample creator',
    profileUrl,
    declaredTotal: 3,
    videos: [
      { video_id: '1234567890123456789', content_type: 'video', video_title: 'first' },
      { video_id: '1234567890123456789', content_type: 'video', video_title: 'duplicate' },
      { video_id: '2234567890123456789', content_type: 'note', video_title: 'second' },
    ],
  });
  assert.equal(result.catalog.publicRenderedTotal, 2);
  assert.equal(result.catalog.declaredGap, 1);
  assert.equal(result.catalog.prunedTasks, 1);
  assert.equal((await controller.store.listTasks(job.id)).length, 2);
  const updated = await controller.store.readJob(job.id);
  assert.equal(updated.status, 'collecting');
  assert.equal(updated.progress.catalogStatus, 'complete_with_declared_gap');
  assert.equal(updated.progress.rootTasksTotal, 2);
});

test('automatically rebuilds a transiently empty browser session without losing the task checkpoint', async () => {
  const patchedTasks = [];
  const patchedJobs = [];
  const events = [];
  const controller = Object.create(DouyinCommentJobController.prototype);
  controller.store = {
    readJob: async () => ({ autoResume: true, connectionRecoveryAttempts: 0 }),
    patchTask: async (_jobId, _taskId, patch) => { patchedTasks.push(patch); },
    patchJob: async (_jobId, patch) => { patchedJobs.push(patch); },
  };
  controller.emit = async (_jobId, event) => { events.push(event); };
  const runtime = { stopRequested: false, restartRequested: false, connectionRecoveryAttempts: 0 };
  const task = { id: 'reply:test', kind: 'reply', videoId: '1234567890123456789', attempts: 0 };
  const error = new DouyinCommentError('COMMENT_EMPTY_RESPONSE', 'empty response', 503);

  await controller.handleTaskFailure('dcj-recovery1', runtime, task, error);

  assert.equal(runtime.stopRequested, true);
  assert.equal(runtime.restartRequested, true);
  assert.equal(runtime.connectionRecoveryAttempts, 1);
  assert.equal(patchedTasks[0].status, 'ready');
  assert.equal(patchedJobs[0].status, 'collecting');
  assert.equal(patchedJobs[0].connectionRecoveryAttempts, 1);
  assert.equal(events[0].type, 'connection_recovering');
});

test('keeps scheduling durable recovery after immediate session rebuilds are exhausted', async () => {
  const patchedJobs = [];
  const events = [];
  const scheduled = [];
  const controller = Object.create(DouyinCommentJobController.prototype);
  controller.store = {
    readJob: async () => ({ autoResume: true, connectionRecoveryAttempts: 3 }),
    patchTask: async () => {},
    patchJob: async (_jobId, patch) => { patchedJobs.push(patch); },
  };
  controller.emit = async (_jobId, event) => { events.push(event); };
  controller.scheduleAutoResume = (jobId, delay) => { scheduled.push({ jobId, delay }); };
  const runtime = { stopRequested: false, restartRequested: false, connectionRecoveryAttempts: 3 };
  const task = { id: 'reply:retry', kind: 'reply', videoId: '1234567890123456789', attempts: 0 };

  await controller.handleTaskFailure(
    'dcj-recovery2', runtime, task,
    new DouyinCommentError('COMMENT_EMPTY_RESPONSE', 'empty response', 503),
  );

  assert.equal(runtime.stopRequested, true);
  assert.equal(runtime.restartRequested, false);
  assert.equal(patchedJobs[0].status, 'waiting_for_connection');
  assert.equal(patchedJobs[0].connectionRecoveryAttempts, 4);
  assert.ok(Date.parse(patchedJobs[0].nextAutoResumeAt) > Date.now());
  assert.deepEqual(scheduled, [{ jobId: 'dcj-recovery2', delay: 15_000 }]);
  assert.deepEqual(events.map((event) => event.type), ['connection_required', 'connection_recovering']);
});

test('watchdog restores only resumable auto-resume jobs and honors persisted retry deadlines', async () => {
  const scheduled = [];
  const now = Date.now();
  const controller = Object.create(DouyinCommentJobController.prototype);
  controller.stopping = false;
  controller.runtimes = new Map([['dcj-active', { active: true }]]);
  controller.retryTimers = new Map();
  controller.store = {
    listJobs: async () => [
      { id: 'dcj-due', autoResume: true, status: 'waiting_for_connection', nextAutoResumeAt: new Date(now - 1_000).toISOString() },
      { id: 'dcj-later', autoResume: true, status: 'collecting', nextAutoResumeAt: new Date(now + 60_000).toISOString() },
      { id: 'dcj-active', autoResume: true, status: 'collecting' },
      { id: 'dcj-export-failed', autoResume: true, status: 'export_failed' },
      { id: 'dcj-paused', autoResume: true, status: 'paused' },
      { id: 'dcj-disabled', autoResume: false, status: 'collecting' },
    ],
  };
  controller.scheduleAutoResume = (jobId, delay) => scheduled.push({ jobId, delay });

  await controller.sweepAutoResumeJobs();

  assert.equal(scheduled.length, 2);
  assert.deepEqual(scheduled[0], { jobId: 'dcj-due', delay: 250 });
  assert.equal(scheduled[1].jobId, 'dcj-later');
  assert.ok(scheduled[1].delay > 55_000 && scheduled[1].delay <= 60_000);
});

test('serves persisted progress immediately while the cold checkpoint index restores', async () => {
  let listTasksCalls = 0;
  const controller = Object.create(DouyinCommentJobController.prototype);
  controller.runtimes = new Map([['dcj-coldcache1', {
    active: true,
    effectiveLanes: 1,
    startedAt: new Date().toISOString(),
    checkpointRestoring: true,
  }]]);
  controller.cdpUrl = 'http://127.0.0.1:18801';
  controller.store = {
    readJob: async () => ({
      id: 'dcj-coldcache1',
      status: 'collecting',
      phase: 'collecting',
      autoResume: true,
      progress: {
        rootTasksTotal: 100,
        rootTasksComplete: 40,
        replyTasksTotal: 300,
        replyTasksComplete: 210,
        commentsCaptured: 12_345,
      },
    }),
    peekTaskCache: () => null,
    listTasks: async () => { listTasksCalls += 1; return []; },
    readManifest: async () => ({}),
    readCatalog: async () => ({ videos: [], public_video_count: 0 }),
  };

  const result = await controller.getJob('dcj-coldcache1');

  assert.equal(listTasksCalls, 0);
  assert.equal(result.runtime.checkpointRestoring, true);
  assert.equal(result.taskSummary.restoring, true);
  assert.equal(result.taskSummary.total, 400);
  assert.equal(result.taskSummary.complete, 250);
  assert.equal(result.taskSummary.comments, 12_345);
});

test('requeues an exhausted task and audits job data for prohibited media files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-comment-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  const job = await store.createJob({
    id: 'dcj-87654321',
    config: normalizeCreateRequest({ profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample' }),
  });
  const task = await store.createTask(job.id, { kind: 'root', videoId: '1234567890123456789', status: 'failed', attempts: 6 });
  assert.equal(await store.requeueFailedTasks(job.id), 1);
  assert.equal((await store.getTask(job.id, task.id)).status, 'ready');
  assert.equal((await store.auditNoMedia(job.id)).passed, true);
  await fs.writeFile(store.file(job.id, 'unexpected.mp4'), 'not media data');
  const audit = await store.auditNoMedia(job.id);
  assert.equal(audit.passed, false);
  assert.deepEqual(audit.violations, ['unexpected.mp4']);
});

test('normalizes roots and reply relationships with audit completeness', () => {
  const output = normalizeVideoCheckpoint({
    video: { video_id: '1234567890123456789', video_title: 'test video', video_url: 'https://www.douyin.com/video/1234567890123456789' },
    rootPages: [{ total: 1, comments: [{ cid: 'root-1', text: 'root', create_time: 1, user: { nickname: 'root user' }, reply_comment_total: 1 }] }],
    replyPagesByRoot: new Map([['root-1', [{ total: 1, comments: [{ cid: 'reply-1', reply_id: 'root-1', reply_to_reply_id: '0', text: 'reply', create_time: 2, user: { nickname: 'reply user' } }] }]]]),
    rootTask: { status: 'complete', declaredTotal: 1 },
    replyTasks: [{ status: 'complete', rootCommentId: 'root-1', declaredReplyCount: 1, declaredTotal: 1 }],
  });
  assert.equal(output.completeness.status, 'complete');
  assert.equal(output.comments.length, 2);
  assert.equal(output.comments.find((row) => row.comment_id === 'reply-1').parent_comment_id, 'root-1');
  assert.equal(output.comments.find((row) => row.comment_id === 'reply-1').relationship_quality, 'exact');
});

test('materializes a completed video immediately for paged frontend reads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-comment-materialize-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  const job = await store.createJob({
    id: 'dcj-materialize1',
    config: normalizeCreateRequest({ profileInput: '三国杀' }),
  });
  const video = {
    video_id: '1234567890123456789',
    video_title: 'incremental fixture',
    video_url: 'https://www.douyin.com/video/1234567890123456789',
    content_type: 'video',
  };
  await store.writeCatalog(job.id, { profile_url: job.profileUrl, public_video_count: 1, videos: [video] });
  const task = await store.createTask(job.id, {
    kind: 'root', videoId: video.video_id, status: 'complete', hasMore: false, declaredTotal: 1,
  });
  const pageRef = await store.writePage(job.id, task, 0, {
    total: 1,
    comments: [{ cid: 'root-1', text: 'root', create_time: 1, user: { nickname: 'root user' }, reply_comment_total: 0 }],
  });
  await store.patchTask(job.id, task.id, { pageRefs: [pageRef], capturedCount: 1 });
  const controller = new DouyinCommentJobController({ dataDir: root, cdpUrl: 'http://127.0.0.1:18801' });
  controller.store = store;
  const runtime = {
    materializationQueues: new Map(),
    catalogVideosById: new Map([[video.video_id, video]]),
    taskIdsByVideo: new Map([[video.video_id, new Set([task.id])]]),
  };

  const result = await controller.materializeReadyVideo(job.id, video.video_id, runtime);
  const persisted = await store.readComments(job.id, video.video_id);

  assert.equal(result.comments.length, 1);
  assert.equal(persisted.comments[0].comment_user, 'root user');
  assert.equal(persisted.comments[0].video_id, video.video_id);
  assert.equal(runtime.materializationQueues.size, 0);
});

test('exports a real XLSX archive from the new normalized checkpoint schema', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-douyin-comment-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DouyinCommentCheckpointStore(root);
  await store.init();
  const job = await store.createJob({
    id: 'dcj-11223344',
    config: normalizeCreateRequest({ profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAexample' }),
  });
  const video = { video_id: '1234567890123456789', video_title: 'fixture video', video_url: 'https://www.douyin.com/video/1234567890123456789', content_type: 'video' };
  await store.writeCatalog(job.id, { profile_url: job.profileUrl, public_video_count: 1, videos: [video] });
  const normalized = normalizeVideoCheckpoint({
    video,
    rootPages: [{ total: 1, comments: [{ cid: 'root-1', text: 'root', user: { nickname: 'root user' }, reply_comment_total: 1 }] }],
    replyPagesByRoot: new Map([['root-1', [{ total: 1, comments: [{ cid: 'reply-1', reply_id: 'root-1', text: 'reply', user: { nickname: 'reply user' } }] }]]]),
    rootTask: { status: 'complete', declaredTotal: 1 },
    replyTasks: [{ status: 'complete', rootCommentId: 'root-1', declaredReplyCount: 1, declaredTotal: 1 }],
  });
  await store.writeSourceDocument(job.id, video.video_id, normalized);
  const result = await buildDouyinCommentArchive({ inputDir: store.jobDir(job.id), outputDir: store.file(job.id, 'exports') });
  const xlsx = await fs.readFile(store.file(job.id, 'exports', 'all-comments.xlsx'));
  assert.equal(xlsx.subarray(0, 2).toString('utf8'), 'PK');
  assert.equal(result.manifest.validation.archive_status, 'complete');
  assert.equal(result.allComments.length, 2);
});
