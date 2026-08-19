import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DOUYIN_COMMENT_HEARTBEAT_MS,
  DOUYIN_COMMENT_LANE_PRESETS,
  DOUYIN_COMMENT_LEASE_MS,
  DouyinCommentError,
  asId,
  asInteger,
  asText,
  ensureJobId,
  isTerminalJobStatus,
  normalizeCatalogVideo,
  normalizeConcurrencyUpdate,
  normalizeCreateRequest,
  normalizeProfileUrl,
  publicError,
  sortCatalogVideos,
  summarizeJob,
  taskIdFor,
} from './contracts.mjs';
import { DouyinCommentCheckpointStore } from './checkpoint-store.mjs';
import { DouyinBrowserPool } from './browser-pool.mjs';
import { writeNormalizedVideo } from './normalizer.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_TASK_ATTEMPTS = 6;
const AUTO_SESSION_RECOVERY_LIMIT = 3;
const AUTO_RESUME_BASE_DELAY_MS = 15_000;
const AUTO_RESUME_MAX_DELAY_MS = 120_000;
const AUTO_RESUME_WATCHDOG_MS = 30_000;
const AUTO_RESUMABLE_JOB_STATUSES = new Set([
  'queued',
  'cataloging',
  'collecting',
  'waiting_for_connection',
  'exporting',
]);
const DOCUMENT_READ_CONCURRENCY = 16;

function canAutoResumeJob(job) {
  return Boolean(job?.autoResume)
    && !isTerminalJobStatus(job.status)
    && AUTO_RESUMABLE_JOB_STATUSES.has(job.status);
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function terminalForMaterialization(task) {
  return ['complete', 'public_api_complete_with_gap'].includes(task?.status);
}

function taskSummary(tasks) {
  return tasks.reduce((summary, task) => {
    summary.total += 1;
    summary[task.kind === 'reply' ? 'reply' : 'root'] += 1;
    if (terminalForMaterialization(task)) summary.complete += 1;
    if (task.status === 'failed') summary.failed += 1;
    if (task.status === 'running') summary.running += 1;
    if (task.status === 'ready') summary.ready += 1;
    summary.comments += Number(task.capturedCount || 0);
    return summary;
  }, { total: 0, root: 0, reply: 0, complete: 0, failed: 0, running: 0, ready: 0, comments: 0 });
}

function persistedTaskSummary(job) {
  const progress = job?.progress || {};
  const root = Number(progress.rootTasksTotal || 0);
  const reply = Number(progress.replyTasksTotal || 0);
  const complete = Number(progress.rootTasksComplete || 0) + Number(progress.replyTasksComplete || 0);
  const total = root + reply;
  return {
    total,
    root,
    reply,
    complete,
    failed: 0,
    running: 0,
    ready: Math.max(0, total - complete),
    comments: Number(progress.commentsCaptured || 0),
    restoring: true,
  };
}

function artifactContentType(name) {
  if (name.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (name.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (name.endsWith('.ndjson')) return 'application/x-ndjson; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/markdown; charset=utf-8';
}

function publicJob(job, runtime = null) {
  return {
    ...summarizeJob(job),
    runtime: runtime ? {
      active: runtime.active,
      effectiveLanes: runtime.effectiveLanes,
      startedAt: runtime.startedAt,
      checkpointRestoring: Boolean(runtime.checkpointRestoring),
    } : { active: false, effectiveLanes: job.effectiveLanes || 0 },
  };
}

export class DouyinCommentJobController {
  constructor({ dataDir, cdpUrl, forceBackupCdn = false, ensureBrowser = null } = {}) {
    this.store = new DouyinCommentCheckpointStore(dataDir);
    this.cdpUrl = cdpUrl;
    this.forceBackupCdn = forceBackupCdn;
    this.ensureBrowser = ensureBrowser;
    this.runtimes = new Map();
    this.subscribers = new Map();
    this.retryTimers = new Map();
    this.materializationQueues = new Map();
    this.resumeWatchdog = null;
    this.stopping = false;
  }

  async init() {
    await this.store.init();
    const jobs = await this.store.listJobs();
    for (const job of jobs) {
      if (!canAutoResumeJob(job)) continue;
      this.schedule(job.id, 1_500);
    }
    this.resumeWatchdog = setInterval(() => {
      void this.sweepAutoResumeJobs().catch(() => {});
    }, AUTO_RESUME_WATCHDOG_MS);
    this.resumeWatchdog.unref?.();
  }

  async shutdown() {
    this.stopping = true;
    if (this.resumeWatchdog) clearInterval(this.resumeWatchdog);
    this.resumeWatchdog = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.stopRequested = true;
      await runtime.pool?.close().catch(() => {});
    }
    await Promise.all([...this.runtimes.keys()].map((jobId) => this.store.releaseAllRunningTasks(jobId).catch(() => {})));
  }

  schedule(jobId, delay = 0) {
    if (this.stopping || this.runtimes.get(jobId)?.active) return;
    const retryTimer = this.retryTimers.get(jobId);
    if (retryTimer) clearTimeout(retryTimer);
    this.retryTimers.delete(jobId);
    const runtime = {
      active: true,
      stopRequested: false,
      restartRequested: false,
      effectiveLanes: 1,
      startedAt: new Date().toISOString(),
      pool: null,
      operations: 0,
      successStreak: 0,
      replyClaimsSinceRoot: 0,
      checkpointRestoring: false,
      catalogVideosById: new Map(),
      taskIdsByVideo: new Map(),
      materializationQueues: this.materializationQueues,
    };
    this.runtimes.set(jobId, runtime);
    setTimeout(() => {
      void this.runJob(jobId, runtime).catch(async (error) => {
        await this.handleRunFailure(jobId, runtime, error);
      });
    }, delay);
  }

  scheduleAutoResume(jobId, delay) {
    if (this.stopping || this.retryTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      void this.store.readJob(jobId).then((job) => {
        if (!canAutoResumeJob(job)) return;
        this.schedule(jobId);
      }).catch(() => {});
    }, delay);
    this.retryTimers.set(jobId, timer);
  }

  async sweepAutoResumeJobs() {
    if (this.stopping) return;
    const jobs = await this.store.listJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (!canAutoResumeJob(job)
        || this.runtimes.get(job.id)?.active || this.retryTimers.has(job.id)) continue;
      const retryAt = Date.parse(job.nextAutoResumeAt || '');
      const delay = Number.isFinite(retryAt) && retryAt > now
        ? Math.min(AUTO_RESUME_MAX_DELAY_MS, retryAt - now)
        : 250;
      this.scheduleAutoResume(job.id, delay);
    }
  }

  async emit(jobId, event) {
    const record = await this.store.appendEvent(jobId, event);
    const sockets = this.subscribers.get(jobId);
    if (sockets) {
      const payload = `id: ${record.sequence}\nevent: ${record.type || 'progress'}\ndata: ${JSON.stringify(record)}\n\n`;
      for (const response of [...sockets]) {
        try { response.write(payload); } catch { sockets.delete(response); }
      }
    }
    return record;
  }

  async createJob(input, idempotencyKey = '') {
    const config = normalizeCreateRequest(input);
    const key = String(idempotencyKey || '').trim().slice(0, 160);
    if (key) {
      const existing = (await this.store.listJobs()).find((job) => job.config?.idempotencyKey === key);
      if (existing) return { job: existing, created: false };
      config.idempotencyKey = key;
    }
    const id = `dcj-${randomUUID()}`;
    const job = await this.store.createJob({ id, config });
    await this.emit(id, { type: 'job_created', message: 'Collection job was created.', severity: 'info' });
    this.schedule(id);
    return { job, created: true };
  }

  async bootstrapCatalog(jobId, input = {}) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    if (isTerminalJobStatus(job.status) || ['paused', 'cancelled'].includes(job.status)) {
      throw new DouyinCommentError('JOB_NOT_BOOTSTRAPPABLE', 'This job cannot accept a public catalog in its current state.', 409);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DouyinCommentError('CATALOG_INPUT_INVALID', 'The public catalog payload must be a JSON object.');
    }

    const profileUrl = normalizeProfileUrl(input.profileUrl || job.profileUrl);
    if (job.profileUrl && normalizeProfileUrl(job.profileUrl) !== profileUrl) {
      throw new DouyinCommentError('CATALOG_PROFILE_MISMATCH', 'The imported catalog does not belong to this job profile.', 409);
    }
    const accountName = asText(input.accountName || input.account_name || job.expectedCreatorName).slice(0, 120);
    const expectedName = asText(job.expectedCreatorName).toLocaleLowerCase();
    const observedName = accountName.toLocaleLowerCase();
    if (expectedName && observedName && !observedName.includes(expectedName) && !expectedName.includes(observedName)) {
      throw new DouyinCommentError('PROFILE_NAME_MISMATCH', `The imported profile name "${accountName}" does not match the expected name.`, 409);
    }

    const normalized = (Array.isArray(input.videos) ? input.videos : [])
      .map(normalizeCatalogVideo)
      .filter(Boolean);
    const byId = new Map(normalized.map((video) => [video.video_id, video]));
    const videos = sortCatalogVideos([...byId.values()]);
    if (!videos.length) throw new DouyinCommentError('CATALOG_EMPTY', 'The imported public catalog contains no usable items.');
    if (Number(job.progress?.commentsCaptured || 0) > 0) {
      throw new DouyinCommentError('CATALOG_ALREADY_STARTED', 'The catalog cannot be replaced after comment pages have been committed.', 409);
    }
    const declaredTotal = Math.max(videos.length, asInteger(input.declaredTotal ?? input.public_video_count, videos.length));
    const gap = Math.max(0, declaredTotal - videos.length);
    const capturedAt = new Date().toISOString();
    const catalog = await this.store.writeCatalog(id, {
      account_name: accountName,
      douyin_id: asText(input.douyinId || input.douyin_id).slice(0, 120),
      profile_url: profileUrl,
      public_video_count: declaredTotal,
      catalog_source: 'in_app_public_profile',
      captured_at: capturedAt,
      videos,
    });
    const prunedTasks = await this.store.pruneUnstartedTasksOutsideCatalog(id, videos.map((video) => video.video_id));
    await this.store.createTasks(id, videos.map((video) => ({
      id: taskIdFor('root', video.video_id),
      kind: 'root',
      videoId: video.video_id,
      rootCommentId: '',
      nextCursor: 0,
      hasMore: true,
      capturedCount: 0,
    })));
    await this.store.patchManifest(id, {
      profile_url: profileUrl,
      catalog_source: 'in_app_public_profile',
      catalog_snapshot: {
        captured_at: capturedAt,
        declared_item_count: declaredTotal,
        public_rendered_item_count: videos.length,
        declared_public_gap: gap,
        pruned_unstarted_tasks: prunedTasks,
        media_downloaded: false,
      },
    });
    const next = await this.store.patchJob(id, {
      profileUrl,
      status: 'collecting',
      phase: 'collecting',
      startedAt: job.startedAt || capturedAt,
      lastError: null,
      progress: {
        catalogStatus: gap ? 'complete_with_declared_gap' : 'complete',
        videosTotal: videos.length,
        videosIncomplete: videos.length,
        rootTasksTotal: videos.length,
      },
    });
    await this.emit(id, {
      type: 'catalog_imported',
      message: gap
        ? `Imported ${videos.length} publicly rendered profile items; ${gap} declared items were not publicly rendered.`
        : `Imported ${videos.length} publicly rendered profile items.`,
      severity: gap ? 'warning' : 'success',
      catalog: { declaredTotal, publicRenderedTotal: videos.length, declaredGap: gap, prunedTasks },
      progress: next.progress,
    });
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.restartRequested = true;
      runtime.stopRequested = true;
    } else {
      this.schedule(id);
    }
    return { job: publicJob(next, this.runtimes.get(id)), catalog: { declaredTotal, publicRenderedTotal: videos.length, declaredGap: gap, prunedTasks } };
  }

  async getJob(jobId) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    const runtime = this.runtimes.get(id);
    const cachedTasks = this.store.peekTaskCache(id);
    const taskRead = cachedTasks !== null
      ? Promise.resolve(cachedTasks)
      : runtime?.active
        ? Promise.resolve(null)
        : this.store.listTasks(id);
    const [tasks, manifest, catalog] = await Promise.all([
      taskRead,
      this.store.readManifest(id),
      this.store.readCatalog(id),
    ]);
    const catalogTotal = Number(catalog?.videos?.length || 0);
    const declaredTotal = Number(catalog?.public_video_count || catalogTotal);
    return {
      ...publicJob(job, this.runtimes.get(id)),
      taskSummary: tasks ? taskSummary(tasks) : persistedTaskSummary(job),
      catalog: catalog ? {
        status: job.progress?.catalogStatus || 'complete',
        publicRenderedTotal: catalogTotal,
        declaredTotal,
        declaredGap: Math.max(0, declaredTotal - catalogTotal),
        capturedAt: catalog.catalog_completed_at || '',
      } : null,
      mediaPolicy: 'forbidden',
      browserRelay: this.cdpUrl,
      audit: {
        media: manifest?.media_audit || null,
        catalogRevalidation: manifest?.catalog_revalidation || null,
      },
    };
  }

  async getBrowserHealth() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`${this.cdpUrl}/json/version`, { signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      return {
        status: response.ok && Boolean(payload.webSocketDebuggerUrl) ? 'online' : 'offline',
        cdpUrl: this.cdpUrl,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return { status: 'offline', cdpUrl: this.cdpUrl, checkedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  async revalidateCatalog(jobId, { allowExporting = false } = {}) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    const catalog = await this.store.readCatalog(id);
    if (!job || !catalog) throw new DouyinCommentError('CATALOG_PENDING', 'The profile catalog has not completed yet.', 409);
    if (!allowExporting && ['cataloging', 'collecting', 'exporting'].includes(job.status)) {
      throw new DouyinCommentError('REVALIDATE_BUSY', 'Pause or finish the collection before revalidating its catalog snapshot.', 409);
    }
    const pool = new DouyinBrowserPool({ cdpUrl: this.cdpUrl, forceBackupCdn: this.forceBackupCdn });
    try {
      const observed = await pool.catalogProfile(job.profileUrl);
      const snapshotIds = new Set((catalog.videos || []).map((video) => video.video_id));
      const observedIds = new Set((observed.videos || []).map((video) => video.video_id));
      const audit = {
        status: 'reconciled',
        checked_at: new Date().toISOString(),
        snapshot_completed_at: catalog.catalog_completed_at || '',
        snapshot_video_count: snapshotIds.size,
        observed_video_count: observedIds.size,
        unavailable_after_snapshot: [...snapshotIds].filter((videoId) => !observedIds.has(videoId)).sort(),
        catalog_drift: [...observedIds].filter((videoId) => !snapshotIds.has(videoId)).sort(),
      };
      if (audit.unavailable_after_snapshot.length || audit.catalog_drift.length) audit.status = 'drift_detected';
      await this.store.patchManifest(id, { catalog_revalidation: audit });
      await this.emit(id, {
        type: 'catalog_revalidated',
        message: audit.status === 'reconciled' ? 'Catalog snapshot revalidated without drift.' : 'Catalog revalidation recorded snapshot drift.',
        severity: audit.status === 'reconciled' ? 'success' : 'warning',
      });
      return audit;
    } finally {
      await pool.close();
    }
  }

  async refreshProgress(jobId) {
    const tasks = await this.store.listTasks(jobId);
    const summary = taskSummary(tasks);
    const catalog = await this.store.readCatalog(jobId);
    const videos = catalog?.videos || [];
    const videoTaskGroups = new Map(videos.map((video) => [video.video_id, []]));
    for (const task of tasks) {
      if (!videoTaskGroups.has(task.videoId)) videoTaskGroups.set(task.videoId, []);
      videoTaskGroups.get(task.videoId).push(task);
    }
    let complete = 0;
    let gap = 0;
    for (const video of videos) {
      const related = videoTaskGroups.get(video.video_id) || [];
      const root = related.find((task) => task.kind === 'root');
      const replies = related.filter((task) => task.kind === 'reply');
      if (!root || !terminalForMaterialization(root) || !replies.every(terminalForMaterialization)) continue;
      if ([root, ...replies].some((task) => task.status === 'public_api_complete_with_gap')) gap += 1;
      else complete += 1;
    }
    const job = await this.store.patchJob(jobId, {
      progress: {
        videosTotal: videos.length,
        videosComplete: complete,
        videosWithGap: gap,
        videosIncomplete: Math.max(0, videos.length - complete - gap),
        rootTasksTotal: summary.root,
        rootTasksComplete: tasks.filter((task) => task.kind === 'root' && terminalForMaterialization(task)).length,
        replyTasksTotal: summary.reply,
        replyTasksComplete: tasks.filter((task) => task.kind === 'reply' && terminalForMaterialization(task)).length,
        commentsCaptured: summary.comments,
      },
    });
    return job;
  }

  async setPaused(jobId, paused) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    if (isTerminalJobStatus(job.status)) throw new DouyinCommentError('JOB_TERMINAL', 'This completed job cannot be changed.', 409);
    if (paused) {
      const runtime = this.runtimes.get(id);
      if (runtime) runtime.stopRequested = true;
      const next = await this.store.patchJob(id, { status: 'paused', phase: job.phase, pausedAt: new Date().toISOString() });
      await this.emit(id, { type: 'paused', message: 'Collection paused. Durable page checkpoints are retained.', severity: 'info' });
      return next;
    }
    await this.store.releaseAllRunningTasks(id);
    const requeued = await this.store.requeueFailedTasks(id);
    const next = await this.store.patchJob(id, { status: 'queued', phase: job.phase, pausedAt: '', lastError: null });
    await this.emit(id, {
      type: 'resumed',
      message: requeued ? `Collection queued; ${requeued} exhausted task(s) were requeued.` : 'Collection queued for automatic continuation.',
      severity: 'info',
    });
    this.schedule(id);
    return next;
  }

  async cancel(jobId) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.stopRequested = true;
    const next = await this.store.patchJob(id, { status: 'cancelled', phase: 'cancelled', completedAt: new Date().toISOString() });
    await this.emit(id, { type: 'cancelled', message: 'Collection cancelled. Existing checkpoints and exports are retained.', severity: 'warning' });
    return next;
  }

  async updateConcurrency(jobId, input) {
    const id = ensureJobId(jobId);
    const concurrency = normalizeConcurrencyUpdate(input);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    const runtime = this.runtimes.get(id);
    const nextConfig = { ...job.config, concurrency };
    const next = await this.store.patchJob(id, {
      config: nextConfig,
      concurrency,
      effectiveLanes: concurrency.mode === 'fixed' ? concurrency.maxLanes : Math.min(4, concurrency.maxLanes),
    });
    if (runtime) {
      runtime.restartRequested = true;
      runtime.stopRequested = true;
    } else if (!isTerminalJobStatus(next.status) && next.status !== 'paused') {
      this.schedule(id);
    }
    await this.emit(id, { type: 'concurrency_updated', message: `Concurrency set to ${concurrency.mode}/${concurrency.maxLanes}.`, severity: 'info' });
    return next;
  }

  async listVideos(jobId, { offset = 0, limit = 100 } = {}) {
    const id = ensureJobId(jobId);
    const catalog = await this.store.readCatalog(id);
    if (!catalog) throw new DouyinCommentError('CATALOG_PENDING', 'The profile catalog has not completed yet.', 409);
    const tasks = await this.store.listTasks(id);
    const taskByVideo = new Map();
    for (const task of tasks) {
      if (!taskByVideo.has(task.videoId)) taskByVideo.set(task.videoId, []);
      taskByVideo.get(task.videoId).push(task);
    }
    const start = Math.max(0, asInteger(offset, 0));
    const pageLimit = Math.min(500, Math.max(1, asInteger(limit, 100)));
    const pageVideos = catalog.videos.slice(start, start + pageLimit);
    const rows = await mapWithConcurrency(pageVideos, DOCUMENT_READ_CONCURRENCY, async (video) => {
      const related = taskByVideo.get(video.video_id) || [];
      const root = related.find((task) => task.kind === 'root');
      const reply = related.filter((task) => task.kind === 'reply');
      const comments = await this.store.readComments(id, video.video_id);
      const completeReplies = reply.filter(terminalForMaterialization).length;
      return {
        videoId: video.video_id,
        videoTitle: video.video_title || video.card_text || '',
        videoUrl: video.video_url || video.url,
        contentType: video.content_type,
        status: comments?.completeness?.status || (root?.status || 'queued'),
        rootCursor: root?.nextCursor || 0,
        rootPages: root?.pageRefs?.length || 0,
        replyThreadsTotal: reply.length,
        replyThreadsComplete: completeReplies,
        commentsCaptured: comments?.comments?.length || 0,
        declaredComments: comments?.completeness?.declared_comment_count || root?.declaredTotal || null,
      };
    });
    return { total: catalog.videos.length, offset: start, limit: pageLimit, rows };
  }

  async listComments(jobId, videoId, { offset = 0, limit = 100 } = {}) {
    const id = ensureJobId(jobId);
    const document = await this.store.readComments(id, asId(videoId));
    if (!document) return { total: 0, rows: [], pending: true };
    const rows = Array.isArray(document.comments) ? document.comments : [];
    const start = Math.max(0, asInteger(offset, 0));
    const pageLimit = Math.min(500, Math.max(1, asInteger(limit, 100)));
    return { total: rows.length, offset: start, limit: pageLimit, rows: rows.slice(start, start + pageLimit), completeness: document.completeness || {} };
  }

  async materializeVideo(jobId, video, tasks) {
    const rootTask = tasks.find((task) => task.kind === 'root' && task.videoId === video.video_id);
    if (!rootTask || !terminalForMaterialization(rootTask)) return null;
    const replyTasks = tasks.filter((task) => task.kind === 'reply' && task.videoId === video.video_id);
    if (!replyTasks.every(terminalForMaterialization)) return null;
    const rootPages = [];
    for (const reference of rootTask.pageRefs || []) {
      const page = await this.store.readPage(jobId, reference);
      if (page) rootPages.push(page);
    }
    const replyPagesByRoot = new Map();
    for (const task of replyTasks) {
      const pages = [];
      for (const reference of task.pageRefs || []) {
        const page = await this.store.readPage(jobId, reference);
        if (page) pages.push(page);
      }
      replyPagesByRoot.set(task.rootCommentId, pages);
    }
    return writeNormalizedVideo({ store: this.store, jobId, video, rootPages, replyPagesByRoot, rootTask, replyTasks });
  }

  async materializeReadyVideo(jobId, videoId, runtime) {
    const id = asId(videoId);
    const previous = runtime.materializationQueues.get(id) || Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
      const video = runtime.catalogVideosById.get(id);
      const taskIds = runtime.taskIdsByVideo.get(id);
      if (!video || !taskIds?.size) return null;
      const existing = await this.store.readComments(jobId, id);
      if (existing) return existing;
      const related = (await Promise.all([...taskIds].map((taskId) => this.store.getTask(jobId, taskId)))).filter(Boolean);
      const root = related.find((task) => task.kind === 'root');
      if (!root || !terminalForMaterialization(root) || related.some((task) => !terminalForMaterialization(task))) return null;
      const document = await this.materializeVideo(jobId, video, related);
      if (document) {
        await this.emit(jobId, {
          type: 'video_materialized',
          message: `视频评论已可查看：${id}，共 ${document.comments?.length || 0} 条。`,
          severity: document.completeness?.status === 'complete' ? 'success' : 'warning',
          videoId: id,
          comments: document.comments?.length || 0,
          completeness: document.completeness?.status || '',
        });
      }
      return document;
    });
    runtime.materializationQueues.set(id, queued);
    try {
      return await queued;
    } finally {
      if (runtime.materializationQueues.get(id) === queued) runtime.materializationQueues.delete(id);
    }
  }

  async finalizeJob(jobId) {
    const catalog = await this.store.readCatalog(jobId);
    const tasks = await this.store.listTasks(jobId);
    if (!catalog || tasks.some((task) => !terminalForMaterialization(task))) return null;
    try {
      await this.revalidateCatalog(jobId, { allowExporting: true });
    } catch (error) {
      await this.store.patchManifest(jobId, {
        catalog_revalidation: {
          status: 'not_available',
          checked_at: new Date().toISOString(),
          error: publicError(error).code,
        },
      });
    }
    await this.store.patchJob(jobId, { status: 'exporting', phase: 'export' });
    await this.emit(jobId, { type: 'export_started', message: 'Building the comment archive and XLSX workbook.', severity: 'info' });
    for (const video of catalog.videos) await this.materializeVideo(jobId, video, tasks);
    const mediaAudit = await this.store.auditNoMedia(jobId);
    await this.store.patchManifest(jobId, { media_audit: mediaAudit });
    if (!mediaAudit.passed) {
      throw new DouyinCommentError(
        'MEDIA_POLICY_VIOLATION',
        `Media-policy audit found ${mediaAudit.violations.length} prohibited path(s).`,
        500,
      );
    }
    const { buildDouyinCommentArchive } = await import('../scripts/build-douyin-comment-archive.mjs');
    const result = await buildDouyinCommentArchive({ inputDir: this.store.jobDir(jobId), outputDir: this.store.file(jobId, 'exports') });
    const artifacts = await this.store.listArtifacts(jobId);
    const status = result.manifest.validation.archive_status;
    const next = await this.store.patchJob(jobId, {
      status,
      phase: 'complete',
      completedAt: new Date().toISOString(),
      lastError: null,
      artifacts,
    });
    await this.refreshProgress(jobId);
    await this.emit(jobId, {
      type: 'job_complete',
      message: status === 'complete' ? 'Collection and XLSX export completed.' : 'Public API traversal completed with count gaps recorded in the audit.',
      severity: status === 'complete' ? 'success' : 'warning',
    });
    return next;
  }

  async claimAndProcess(jobId, runtime, lane) {
    const task = await this.store.claimNextTask(jobId, {
      workerId: lane.id,
      leaseMs: DOUYIN_COMMENT_LEASE_MS,
      preferRoot: runtime.replyClaimsSinceRoot >= 8,
    });
    if (!task) return false;
    try {
      const requestedCursor = Number(task.nextCursor || 0);
      if ((task.cursorHistory || []).includes(requestedCursor)) {
        throw new DouyinCommentError('COMMENT_CURSOR_REPEATED', 'A comment cursor would be collected twice before a terminal page.', 503);
      }
      const startedAt = Date.now();
      const page = await runtime.pool.fetchPage(lane, {
        kind: task.kind,
        videoId: task.videoId,
        rootCommentId: task.rootCommentId,
        cursor: requestedCursor,
      });
      const latencyMs = Date.now() - startedAt;
      if (page.kind !== task.kind || page.video_id !== task.videoId || (task.kind === 'reply' && page.root_comment_id !== task.rootCommentId)) {
        throw new DouyinCommentError('COMMENT_TASK_MISMATCH', 'The comment response does not belong to its claimed task.', 503);
      }
      if (page.has_more && page.cursor <= Number(task.nextCursor || 0)) {
        throw new DouyinCommentError('COMMENT_CURSOR_STALLED', 'Comment pagination did not advance the cursor.', 503);
      }
      const pageNumber = (task.pageRefs || []).length;
      const pageRef = await this.store.writePage(jobId, task, pageNumber, {
        ...page,
        fetched_at: new Date().toISOString(),
        task_id: task.id,
        video_id: task.videoId,
        root_comment_id: task.rootCommentId || null,
      });
      let discoveredReplyTasks = 0;
      if (task.kind === 'root') {
        for (const comment of page.comments) {
          const rootCommentId = asId(comment?.cid);
          if (!rootCommentId || Number(comment?.reply_comment_total || 0) <= 0) continue;
          const replyTaskId = taskIdFor('reply', task.videoId, rootCommentId);
          const existingReplyTask = await this.store.getTask(jobId, replyTaskId);
          await this.store.createTask(jobId, {
            id: replyTaskId,
            kind: 'reply',
            videoId: task.videoId,
            rootCommentId,
            declaredReplyCount: Number(comment.reply_comment_total || 0),
            nextCursor: 0,
            hasMore: true,
            capturedCount: 0,
          });
          if (!runtime.taskIdsByVideo.has(task.videoId)) runtime.taskIdsByVideo.set(task.videoId, new Set());
          runtime.taskIdsByVideo.get(task.videoId).add(replyTaskId);
          if (!existingReplyTask) discoveredReplyTasks += 1;
        }
      }
      const complete = !Boolean(page.has_more);
      await this.store.patchTask(jobId, task.id, {
        status: complete ? 'complete' : 'ready',
        lease: null,
        hasMore: !complete,
        nextCursor: complete ? Number(page.cursor || task.nextCursor || 0) : Number(page.cursor),
        cursorHistory: [...(task.cursorHistory || []), requestedCursor],
        declaredTotal: Number(page.total || task.declaredTotal || 0),
        pageRefs: [...(task.pageRefs || []), pageRef],
        capturedCount: Number(task.capturedCount || 0) + page.received,
        lastLatencyMs: latencyMs,
        lastError: null,
        nextAttemptAt: 0,
      });
      const progress = await this.store.recordPageProgress(jobId, {
        kind: task.kind,
        received: page.received,
        completed: complete,
        discoveredReplyTasks,
      });
      if (runtime.connectionRecoveryAttempts) {
        runtime.connectionRecoveryAttempts = 0;
        await this.store.patchJob(jobId, {
          connectionRecoveryAttempts: 0,
          nextAutoResumeAt: '',
          lastError: null,
        });
        await this.emit(jobId, {
          type: 'connection_recovered',
          message: 'The browser session recovered and durable collection resumed.',
          severity: 'success',
        });
      }
      if (task.kind === 'reply') runtime.replyClaimsSinceRoot += 1;
      else runtime.replyClaimsSinceRoot = 0;
      runtime.successStreak += 1;
      runtime.operations += 1;
      if (runtime.operations % 12 === 0) await this.refreshProgress(jobId);
      if (runtime.successStreak % 24 === 0) await this.raiseAdaptiveLanes(jobId, runtime);
      await this.emit(jobId, {
        type: 'page_committed',
        message: `${task.kind === 'root' ? '根评论' : '回复'}分页已写入：${task.videoId}，本页 ${page.received} 条。`,
        severity: 'info',
        videoId: task.videoId,
        taskId: task.id,
        kind: task.kind,
        received: page.received,
        cursor: requestedCursor,
        nextCursor: Number(page.cursor || requestedCursor),
        hasMore: Boolean(page.has_more),
        latencyMs,
        discoveredReplyTasks,
        progress,
      });
      if (complete) {
        try {
          await this.materializeReadyVideo(jobId, task.videoId, runtime);
        } catch (materializationError) {
          await this.emit(jobId, {
            type: 'video_materialization_failed',
            message: `视频评论展示文件生成失败，采集断点已保留：${task.videoId}。`,
            severity: 'warning',
            videoId: task.videoId,
            error: materializationError?.message || String(materializationError),
          });
        }
      }
      return true;
    } catch (error) {
      await this.handleTaskFailure(jobId, runtime, task, error);
      return true;
    }
  }

  async raiseAdaptiveLanes(jobId, runtime) {
    const job = await this.store.readJob(jobId);
    if (!job || job.concurrency?.mode !== 'adaptive') return;
    const current = runtime.effectiveLanes;
    const next = DOUYIN_COMMENT_LANE_PRESETS.find((value) => value > current && value <= job.concurrency.maxLanes);
    if (!next) return;
    runtime.effectiveLanes = next;
    await this.store.patchJob(jobId, { effectiveLanes: next });
    await this.emit(jobId, { type: 'adaptive_lanes', message: `Adaptive concurrency increased to ${next} lanes.`, severity: 'info' });
  }

  async handleTaskFailure(jobId, runtime, task, error) {
    const problem = publicError(error);
    const attempts = Number(task.attempts || 0) + 1;
    const sessionFailure = ['COMMENT_EMPTY_RESPONSE', 'COMMENT_RESPONSE_INVALID', 'COMMENT_ENDPOINT_NOT_OBSERVED'].includes(problem.code);
    if (sessionFailure) {
      const job = await this.store.readJob(jobId);
      const recoveryAttempts = Number(job?.connectionRecoveryAttempts || runtime.connectionRecoveryAttempts || 0) + 1;
      runtime.stopRequested = true;
      await this.store.patchTask(jobId, task.id, {
        status: 'ready', lease: null, attempts, nextAttemptAt: Date.now() + 15_000,
        lastError: { code: problem.code, message: problem.message, at: new Date().toISOString() },
      });
      if (job?.autoResume && recoveryAttempts <= AUTO_SESSION_RECOVERY_LIMIT) {
        runtime.connectionRecoveryAttempts = recoveryAttempts;
        runtime.restartRequested = true;
        await this.store.patchJob(jobId, {
          status: 'collecting', phase: 'collecting',
          connectionRecoveryAttempts: recoveryAttempts,
          lastError: null,
        });
        await this.emit(jobId, {
          type: 'connection_recovering',
          message: `The browser lane returned an invalid response; automatically rebuilding the session (${recoveryAttempts}/${AUTO_SESSION_RECOVERY_LIMIT}).`,
          severity: 'warning', videoId: task.videoId, taskId: task.id,
        });
        return;
      }
      const cooldownAttempt = Math.max(0, recoveryAttempts - AUTO_SESSION_RECOVERY_LIMIT - 1);
      const retryDelay = Math.min(AUTO_RESUME_MAX_DELAY_MS, AUTO_RESUME_BASE_DELAY_MS * (2 ** Math.min(3, cooldownAttempt)));
      const nextAutoResumeAt = job?.autoResume ? new Date(Date.now() + retryDelay).toISOString() : '';
      await this.store.patchJob(jobId, {
        status: 'waiting_for_connection', phase: 'collecting',
        connectionRecoveryAttempts: recoveryAttempts,
        nextAutoResumeAt,
        lastError: { code: problem.code, message: problem.message, action: 'Open the logged-in Douyin browser tab, dismiss overlays, then resume.' },
      });
      await this.emit(jobId, {
        type: 'connection_required', message: problem.message, severity: 'warning',
        videoId: task.videoId, taskId: task.id, retryAt: nextAutoResumeAt,
      });
      if (job?.autoResume) {
        await this.emit(jobId, {
          type: 'connection_recovering',
          message: `The browser session will be retried automatically in ${Math.ceil(retryDelay / 1_000)} seconds.`,
          severity: 'warning', retryAt: nextAutoResumeAt, attempt: recoveryAttempts,
        });
        this.scheduleAutoResume(jobId, retryDelay);
      }
      return;
    }
    if (attempts >= MAX_TASK_ATTEMPTS) {
      runtime.stopRequested = true;
      await this.store.patchTask(jobId, task.id, {
        status: 'failed', lease: null, attempts,
        lastError: { code: problem.code, message: problem.message, at: new Date().toISOString() },
      });
      await this.store.patchJob(jobId, {
        status: 'waiting_for_connection', phase: 'collecting',
        lastError: { code: problem.code, message: problem.message, action: 'Resume to retry this durable checkpoint task.' },
      });
      await this.emit(jobId, { type: 'task_retry_exhausted', message: problem.message, severity: 'warning', videoId: task.videoId, taskId: task.id });
      return;
    }
    const retryAfter = Math.min(30_000, 500 * (2 ** attempts) + Math.floor(Math.random() * 250));
    await this.store.patchTask(jobId, task.id, {
      status: 'ready', lease: null, attempts, nextAttemptAt: Date.now() + retryAfter,
      lastError: { code: problem.code, message: problem.message, at: new Date().toISOString() },
    });
    runtime.successStreak = 0;
    if (runtime.effectiveLanes > 1) {
      const currentJob = await this.store.readJob(jobId);
      const candidates = DOUYIN_COMMENT_LANE_PRESETS.filter((value) => value < runtime.effectiveLanes && value <= currentJob.concurrency.maxLanes);
      runtime.effectiveLanes = candidates.at(-1) || 1;
      await this.store.patchJob(jobId, { effectiveLanes: runtime.effectiveLanes });
    }
    await this.emit(jobId, { type: 'task_retry', message: `${problem.message} Retrying durable task ${attempts}/${MAX_TASK_ATTEMPTS}.`, severity: 'warning', videoId: task.videoId, taskId: task.id });
  }

  async workerLoop(jobId, runtime, lane, index) {
    for (;;) {
      if (runtime.stopRequested || this.stopping) return;
      const job = await this.store.readJob(jobId);
      if (!job || ['paused', 'cancelled', 'waiting_for_connection'].includes(job.status)) return;
      if (index >= runtime.effectiveLanes) {
        await wait(250);
        continue;
      }
      const claimed = await this.claimAndProcess(jobId, runtime, lane);
      if (claimed) continue;
      const tasks = await this.store.listTasks(jobId);
      const earliest = tasks.filter((task) => task.status === 'ready')
        .map((task) => Number(task.nextAttemptAt || 0)).filter(Boolean).sort((left, right) => left - right)[0];
      if (earliest && earliest > Date.now()) {
        await wait(Math.min(2_000, earliest - Date.now()));
        continue;
      }
      return;
    }
  }

  async runJob(jobId, runtime) {
    let job = await this.store.readJob(jobId);
    if (!job || this.stopping || isTerminalJobStatus(job.status) || ['paused', 'cancelled'].includes(job.status)) return;
    const coldCheckpoint = this.store.peekTaskCache(jobId) === null;
    runtime.checkpointRestoring = coldCheckpoint;
    if (coldCheckpoint) {
      await this.emit(jobId, {
        type: 'checkpoint_restoring',
        message: '正在后台恢复持久化评论断点，任务进度仍可实时查看。',
        severity: 'info',
      });
    }
    await this.store.releaseAllRunningTasks(jobId);
    runtime.checkpointRestoring = false;
    if (coldCheckpoint) {
      await this.emit(jobId, {
        type: 'checkpoint_restored',
        message: '评论断点索引恢复完成，自动采集继续。',
        severity: 'success',
      });
    }
    runtime.connectionRecoveryAttempts = Number(job.connectionRecoveryAttempts || 0);
    if (this.ensureBrowser) {
      await this.emit(jobId, { type: 'browser_starting', message: 'Checking the dedicated Douyin browser session.', severity: 'info' });
      const browser = await this.ensureBrowser();
      await this.emit(jobId, {
        type: 'browser_ready',
        message: browser?.launched ? 'The dedicated Douyin browser was started.' : 'The dedicated Douyin browser is connected.',
        severity: 'success',
      });
    }
    const pool = new DouyinBrowserPool({
      cdpUrl: this.cdpUrl,
      forceBackupCdn: this.forceBackupCdn,
      onDiagnostic: (diagnostic) => this.emit(jobId, {
        type: 'browser_diagnostic',
        message: `Browser diagnostic: ${diagnostic.type || 'update'}`,
        severity: 'info',
        diagnostic,
      }).catch(() => {}),
    });
    runtime.pool = pool;
    try {
      let catalog = await this.store.readCatalog(jobId);
      if (!catalog) {
        await this.store.patchJob(jobId, { status: 'cataloging', phase: 'catalog', startedAt: job.startedAt || new Date().toISOString(), lastError: null });
        if (!job.profileUrl) {
          await this.emit(jobId, { type: 'profile_resolving', message: 'Resolving the creator input in the active browser session.', severity: 'info' });
          let resolution = job.profileName ? await this.store.readProfileResolution(job.profileName) : null;
          if (resolution) {
            await this.emit(jobId, {
              type: 'profile_resolution_cache_hit',
              message: 'A previously verified public profile match was found and will be revalidated against the profile page.',
              severity: 'success',
            });
          } else {
            resolution = job.profileName
              ? await pool.resolveProfileName(job.profileName)
              : await pool.resolveProfileLink(job.profileSourceUrl || job.profileInput);
            if (job.profileName) await this.store.rememberProfileResolution(job.profileName, resolution);
          }
          job = await this.store.patchJob(jobId, { profileUrl: resolution.profileUrl });
          await this.store.patchManifest(jobId, {
            profile_url: resolution.profileUrl,
            profile_resolution: {
              status: 'resolved',
              source: job.profileName ? 'creator_name' : 'creator_link',
              resolved_at: new Date().toISOString(),
              matched_text: resolution.matchedText || '',
            },
          });
          await this.emit(jobId, { type: 'profile_resolved', message: 'Creator name resolved to its public profile.', severity: 'success' });
        }
        await this.emit(jobId, { type: 'catalog_started', message: 'Enumerating the public creator profile without downloading media.', severity: 'info' });
        const profile = await pool.catalogProfile(job.profileUrl);
        const expectedName = String(job.expectedCreatorName || '').trim().toLocaleLowerCase();
        const observedName = String(profile.account_name || '').trim().toLocaleLowerCase();
        if (expectedName && observedName && !observedName.includes(expectedName) && !expectedName.includes(observedName)) {
          throw new DouyinCommentError(
            'PROFILE_NAME_MISMATCH',
            `The opened profile name "${profile.account_name}" does not match the expected name.`,
            409,
            'Check the profile URL or clear the optional expected account name before resuming.',
          );
        }
        catalog = await this.store.writeCatalog(jobId, profile);
        for (const video of catalog.videos) {
          await this.store.createTask(jobId, {
            id: taskIdFor('root', video.video_id), kind: 'root', videoId: video.video_id,
            rootCommentId: '', nextCursor: 0, hasMore: true, capturedCount: 0,
          });
        }
        await this.store.patchJob(jobId, {
          status: 'collecting', phase: 'collecting',
          progress: { catalogStatus: 'complete', videosTotal: catalog.videos.length, rootTasksTotal: catalog.videos.length },
        });
        await this.emit(jobId, { type: 'catalog_complete', message: `Catalog checkpoint contains ${catalog.videos.length} public items.`, severity: 'success' });
      }
      if (runtime.stopRequested) return;
      const tasksBefore = await this.store.listTasks(jobId);
      runtime.catalogVideosById = new Map(catalog.videos.map((video) => [video.video_id, video]));
      runtime.taskIdsByVideo = new Map();
      for (const task of tasksBefore) {
        if (!runtime.taskIdsByVideo.has(task.videoId)) runtime.taskIdsByVideo.set(task.videoId, new Set());
        runtime.taskIdsByVideo.get(task.videoId).add(task.id);
      }
      const terminalVideoIds = [...new Set(
        tasksBefore.filter(terminalForMaterialization).map((task) => task.videoId),
      )];
      void (async () => {
        for (let index = 0; index < terminalVideoIds.length; index += 4) {
          await Promise.all(terminalVideoIds.slice(index, index + 4).map(async (videoId) => {
            try {
              await this.materializeReadyVideo(jobId, videoId, runtime);
            } catch (materializationError) {
              await this.emit(jobId, {
                type: 'video_materialization_failed',
                message: `启动恢复时未能生成视频评论展示文件：${videoId}。`,
                severity: 'warning',
                videoId,
                error: materializationError?.message || String(materializationError),
              });
            }
          }));
        }
      })().catch(() => {});
      if (tasksBefore.length && tasksBefore.every(terminalForMaterialization)) {
        await this.finalizeJob(jobId);
        return;
      }
      const configuredSeed = job.config?.seedVideoId && catalog.videos.some((video) => video.video_id === job.config.seedVideoId)
        ? job.config.seedVideoId : '';
      const pendingVideoIds = new Set(tasksBefore.filter((task) => !terminalForMaterialization(task)).map((task) => task.videoId));
      const provenSeeds = tasksBefore
        .filter((task) => task.kind === 'root' && (task.pageRefs || []).length > 0)
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .map((task) => task.videoId);
      const newestVideos = [...catalog.videos].reverse();
      const seedCandidates = [...new Set([
        configuredSeed,
        ...provenSeeds.slice(0, 2),
        ...newestVideos.filter((video) => pendingVideoIds.has(video.video_id)).slice(0, 4).map((video) => video.video_id),
        ...newestVideos.slice(0, 4).map((video) => video.video_id),
      ].filter(Boolean))].slice(0, 6);
      if (!seedCandidates.length) throw new DouyinCommentError('CATALOG_EMPTY', 'The catalog does not contain a usable public item.', 503);
      await this.store.patchJob(jobId, { status: 'collecting', phase: 'collecting', startedAt: job.startedAt || new Date().toISOString(), lastError: null });
      await this.emit(jobId, { type: 'collector_started', message: 'Capturing in-memory comment endpoint templates from the active browser session.', severity: 'info' });
      const openTabEndpoints = await pool.captureEndpointsFromOpenTabs();
      let seed = openTabEndpoints?.seedVideoId || '';
      let endpointError = null;
      if (openTabEndpoints) {
        pool.endpoints = openTabEndpoints;
        await this.emit(jobId, {
          type: 'endpoint_session_reused',
          message: '已从现有可用抖音标签页恢复评论端点，无需重新加载作品页。',
          severity: 'success',
          videoId: seed,
        });
      }
      for (const candidate of seed ? [] : seedCandidates) {
        try {
          pool.endpoints = await pool.captureEndpoints(candidate);
          seed = candidate;
          break;
        } catch (error) {
          endpointError = error;
          if (publicError(error).code !== 'COMMENT_ENDPOINT_NOT_OBSERVED') throw error;
          await this.emit(jobId, {
            type: 'endpoint_seed_rotated',
            message: `作品 ${candidate} 未触发评论端点，正在自动尝试下一条近期作品。`,
            severity: 'warning',
            videoId: candidate,
          });
        }
      }
      if (!seed) throw endpointError;
      job = await this.store.readJob(jobId);
      const recoveredFromWaiting = job.status === 'waiting_for_connection' || Number(job.bootstrapRecoveryAttempts || 0) > 0;
      if (recoveredFromWaiting) {
        await this.store.patchJob(jobId, { bootstrapRecoveryAttempts: 0, nextAutoResumeAt: '', lastError: null });
        await this.emit(jobId, {
          type: 'connection_recovered',
          message: '评论端点已重新建立，自动续跑已恢复。',
          severity: 'success',
        });
      }
      runtime.effectiveLanes = job.concurrency?.mode === 'fixed'
        ? job.concurrency.maxLanes : Math.min(4, job.concurrency?.maxLanes || 4);
      await this.store.patchJob(jobId, { effectiveLanes: runtime.effectiveLanes });
      const lanes = await pool.openLanes(job.concurrency?.maxLanes || 1, seed);
      await Promise.all(lanes.map((lane, index) => this.workerLoop(jobId, runtime, lane, index)));
      await this.refreshProgress(jobId);
      if (runtime.stopRequested || this.stopping) return;
      const tasks = await this.store.listTasks(jobId);
      if (tasks.length && tasks.every(terminalForMaterialization)) await this.finalizeJob(jobId);
    } finally {
      await pool.close();
      runtime.pool = null;
      runtime.active = false;
      this.runtimes.delete(jobId);
      await this.store.releaseAllRunningTasks(jobId);
      if (runtime.restartRequested && !this.stopping) this.schedule(jobId, 250);
    }
  }

  async handleRunFailure(jobId, runtime, error) {
    const problem = publicError(error);
    runtime.active = false;
    this.runtimes.delete(jobId);
    await runtime.pool?.close().catch(() => {});
    await this.store.releaseAllRunningTasks(jobId).catch(() => {});
    const job = await this.store.readJob(jobId).catch(() => null);
    if (!job || ['paused', 'cancelled'].includes(job.status) || isTerminalJobStatus(job.status)) return;
    if (problem.code === 'MEDIA_POLICY_VIOLATION') {
      await this.store.patchJob(jobId, {
        status: 'failed', phase: 'failed',
        lastError: { code: problem.code, message: problem.message, action: 'Remove the prohibited file from this job directory before creating a new archive.' },
      }).catch(() => {});
      await this.emit(jobId, { type: 'policy_failed', message: problem.message, severity: 'warning' }).catch(() => {});
      return;
    }
    if (job.phase === 'export') {
      await this.store.patchJob(jobId, {
        status: 'export_failed', phase: 'export',
        lastError: { code: problem.code, message: problem.message, action: 'Retry the export after reviewing the task audit.' },
      }).catch(() => {});
      await this.emit(jobId, { type: 'export_failed', message: problem.message, severity: 'warning' }).catch(() => {});
      return;
    }
    const recoveryAttempts = Number(job.bootstrapRecoveryAttempts || 0) + 1;
    const retryDelay = Math.min(AUTO_RESUME_MAX_DELAY_MS, AUTO_RESUME_BASE_DELAY_MS * (2 ** Math.min(3, recoveryAttempts - 1)));
    const nextAutoResumeAt = job.autoResume ? new Date(Date.now() + retryDelay).toISOString() : '';
    await this.store.patchJob(jobId, {
      status: 'waiting_for_connection', phase: job.phase || 'collecting',
      bootstrapRecoveryAttempts: recoveryAttempts,
      nextAutoResumeAt,
      lastError: { code: problem.code, message: problem.message, action: problem.action || 'Check the attached Douyin browser session, then resume.' },
    }).catch(() => {});
    await this.emit(jobId, { type: 'collector_waiting', message: problem.message, severity: 'warning' }).catch(() => {});
    if (job.autoResume) {
      await this.emit(jobId, {
        type: 'connection_recovering',
        message: `浏览器端点暂不可用，将在 ${Math.ceil(retryDelay / 1_000)} 秒后自动续跑。`,
        severity: 'warning',
        retryAt: nextAutoResumeAt,
        attempt: recoveryAttempts,
      }).catch(() => {});
      this.scheduleAutoResume(jobId, retryDelay);
    }
  }

  async rebuildExport(jobId) {
    const id = ensureJobId(jobId);
    const tasks = await this.store.listTasks(id);
    if (!tasks.length || !tasks.every(terminalForMaterialization)) {
      throw new DouyinCommentError('EXPORT_PENDING', 'XLSX export becomes available after all root and reply tasks finish.', 409);
    }
    const job = await this.finalizeJob(id);
    return publicJob(job, this.runtimes.get(id));
  }

  async subscribeEvents(request, response, jobId, afterSequence) {
    const id = ensureJobId(jobId);
    const job = await this.store.readJob(id);
    if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    const events = await this.store.listEvents(id, afterSequence, 300);
    for (const event of events) response.write(`id: ${event.sequence}\nevent: ${event.type || 'progress'}\ndata: ${JSON.stringify(event)}\n\n`);
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    const set = this.subscribers.get(id);
    set.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), DOUYIN_COMMENT_HEARTBEAT_MS);
    request.on('close', () => {
      clearInterval(heartbeat);
      set.delete(response);
      if (!set.size) this.subscribers.delete(id);
    });
  }

  async handleHttpRequest({ request, response, url, pathname, readRequestJson, sendJson, sendError }) {
    const base = '/api/douyin-comment-jobs';
    if (pathname !== base && !pathname.startsWith(`${base}/`)) return false;
    try {
      const suffix = pathname.slice(base.length).replace(/^\/+/, '');
      const segments = suffix ? suffix.split('/').map(decodeURIComponent) : [];
      if (segments.length === 1 && segments[0] === 'health' && request.method === 'GET') {
        sendJson(response, 200, await this.getBrowserHealth());
        return true;
      }
      if (!segments.length && request.method === 'GET') {
        sendJson(response, 200, { jobs: await this.store.listJobSummaries() });
        return true;
      }
      if (!segments.length && request.method === 'POST') {
        const result = await this.createJob(await readRequestJson(request), request.headers['idempotency-key']);
        sendJson(response, result.created ? 201 : 200, { job: publicJob(result.job, this.runtimes.get(result.job.id)), reused: !result.created });
        return true;
      }
      const [jobId, action] = segments;
      ensureJobId(jobId);
      if (!action && request.method === 'GET') {
        sendJson(response, 200, { job: await this.getJob(jobId) });
        return true;
      }
      if (action === 'events' && request.method === 'GET') {
        const after = asInteger(url.searchParams.get('after') || request.headers['last-event-id'], 0);
        await this.subscribeEvents(request, response, jobId, after);
        return true;
      }
      if (action === 'videos' && request.method === 'GET') {
        sendJson(response, 200, await this.listVideos(jobId, { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }));
        return true;
      }
      if (action === 'comments' && request.method === 'GET') {
        sendJson(response, 200, await this.listComments(jobId, url.searchParams.get('videoId'), { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }));
        return true;
      }
      if (action === 'pause' && request.method === 'POST') {
        sendJson(response, 200, { job: publicJob(await this.setPaused(jobId, true), this.runtimes.get(jobId)) });
        return true;
      }
      if (action === 'resume' && request.method === 'POST') {
        sendJson(response, 200, { job: publicJob(await this.setPaused(jobId, false), this.runtimes.get(jobId)) });
        return true;
      }
      if (action === 'cancel' && request.method === 'POST') {
        sendJson(response, 200, { job: publicJob(await this.cancel(jobId), this.runtimes.get(jobId)) });
        return true;
      }
      if (action === 'concurrency' && request.method === 'POST') {
        sendJson(response, 200, { job: publicJob(await this.updateConcurrency(jobId, await readRequestJson(request)), this.runtimes.get(jobId)) });
        return true;
      }
      if (action === 'catalog-bootstrap' && request.method === 'POST') {
        sendJson(response, 200, await this.bootstrapCatalog(jobId, await readRequestJson(request)));
        return true;
      }
      if (action === 'revalidate' && request.method === 'POST') {
        const audit = await this.revalidateCatalog(jobId);
        sendJson(response, 200, { job: await this.getJob(jobId), audit });
        return true;
      }
      if (action === 'export' && request.method === 'POST') {
        sendJson(response, 200, { job: await this.rebuildExport(jobId) });
        return true;
      }
      if (action === 'artifacts' && segments.length === 2 && request.method === 'GET') {
        sendJson(response, 200, { artifacts: await this.store.listArtifacts(jobId) });
        return true;
      }
      if (action === 'artifacts' && segments.length === 3 && request.method === 'GET') {
        const artifactName = segments[2];
        const artifactPath = await this.store.artifactPath(jobId, artifactName);
        response.writeHead(200, {
          'content-type': artifactContentType(artifactName),
          'content-disposition': `attachment; filename="${artifactName}"`,
          'cache-control': 'no-store',
        });
        fs.createReadStream(artifactPath).pipe(response);
        return true;
      }
      throw new DouyinCommentError('ROUTE_NOT_FOUND', 'Comment collection route was not found.', 404);
    } catch (error) {
      const problem = publicError(error);
      sendError(response, problem.statusCode || 500, problem.code, problem.message, problem.action || '');
      return true;
    }
  }
}
