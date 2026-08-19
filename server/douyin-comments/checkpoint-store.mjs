import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DOUYIN_COMMENT_JOB_VERSION,
  DouyinCommentError,
  asId,
  asText,
  isoNow,
  summarizeJob,
  taskIdFor,
} from './contracts.mjs';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const base = path.basename(filePath);
  const temporaryPath = path.join(path.dirname(filePath), `.${base}.${process.pid}.${randomUUID()}.tmp`);
  const backupPath = path.join(path.dirname(filePath), `.${base}.${process.pid}.${randomUUID()}.bak`);
  await fs.writeFile(temporaryPath, text, 'utf8');
  try {
    if (await exists(filePath)) await fs.rename(filePath, backupPath);
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (await exists(backupPath)) await fs.rename(backupPath, filePath).catch(() => {});
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs.rm(backupPath, { force: true }).catch(() => {});
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listDirectories(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function listJsonNames(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Task pages can be large on high-volume profiles. Keep checkpoint restoration
// responsive without allocating dozens of JSON buffers at the same time.
const TASK_READ_CONCURRENCY = 16;

async function listRelativeFiles(directory, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const output = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...await listRelativeFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(relative.replaceAll(path.sep, '/'));
  }
  return output;
}

function mergeProgress(previous, patch) {
  return { ...(previous || {}), ...(patch || {}) };
}

export class DouyinCommentCheckpointStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.jobsDir = path.join(this.dataDir, 'douyin-comment-jobs');
    this.mutation = Promise.resolve();
    this.taskCaches = new Map();
    this.taskCacheLoads = new Map();
  }

  async init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
  }

  async readProfileResolution(profileName) {
    const key = asText(profileName).toLocaleLowerCase();
    if (!key) return null;
    const registry = await readJson(path.join(this.jobsDir, 'profile-resolutions.json'), { entries: [] });
    return (Array.isArray(registry?.entries) ? registry.entries : [])
      .find((entry) => asText(entry?.profileName).toLocaleLowerCase() === key) || null;
  }

  async rememberProfileResolution(profileName, resolution, source = 'douyin_user_search') {
    const normalizedName = asText(profileName);
    const profileUrl = asText(resolution?.profileUrl);
    if (!normalizedName || !profileUrl) return null;
    return this.mutate(async () => {
      const filePath = path.join(this.jobsDir, 'profile-resolutions.json');
      const registry = await readJson(filePath, { version: 1, entries: [] });
      const key = normalizedName.toLocaleLowerCase();
      const entries = (Array.isArray(registry?.entries) ? registry.entries : [])
        .filter((entry) => asText(entry?.profileName).toLocaleLowerCase() !== key);
      const record = {
        profileName: normalizedName,
        profileUrl,
        matchedText: asText(resolution?.matchedText || normalizedName),
        source,
        observedAt: isoNow(),
      };
      entries.push(record);
      await atomicWriteJson(filePath, { version: 1, updatedAt: isoNow(), entries });
      return record;
    });
  }

  jobDir(jobId) {
    return path.join(this.jobsDir, jobId);
  }

  file(jobId, ...parts) {
    return path.join(this.jobDir(jobId), ...parts);
  }

  async mutate(task) {
    const run = this.mutation.then(task, task);
    this.mutation = run.catch(() => undefined);
    return run;
  }

  async readJob(jobId) {
    return readJson(this.file(jobId, 'job.json'));
  }

  async writeJob(job) {
    await atomicWriteJson(this.file(job.id, 'job.json'), job);
    return job;
  }

  async createJob({ id, config, now = new Date() }) {
    return this.mutate(async () => {
      const job = {
        id,
        version: DOUYIN_COMMENT_JOB_VERSION,
        type: 'douyin_profile_comments',
        status: 'queued',
        phase: 'catalog',
        profileInput: config.profileInput,
        profileUrl: config.profileUrl,
        profileName: config.profileName,
        profileSourceUrl: config.profileSourceUrl,
        expectedCreatorName: config.expectedCreatorName,
        label: config.label,
        config,
        concurrency: config.concurrency,
        effectiveLanes: config.concurrency.maxLanes,
        progress: {
          catalogStatus: 'pending',
          videosTotal: 0,
          videosComplete: 0,
          videosWithGap: 0,
          videosIncomplete: 0,
          rootTasksTotal: 0,
          rootTasksComplete: 0,
          replyTasksTotal: 0,
          replyTasksComplete: 0,
          commentsCaptured: 0,
          lastEventSeq: 0,
        },
        createdAt: isoNow(now),
        updatedAt: isoNow(now),
        startedAt: '',
        completedAt: '',
        pausedAt: '',
        autoResume: config.autoResume,
        lastError: null,
        artifacts: [],
      };
      await fs.mkdir(this.jobDir(id), { recursive: false });
      await fs.mkdir(this.file(id, 'catalog'), { recursive: true });
      await fs.mkdir(this.file(id, 'tasks'), { recursive: true });
      await fs.mkdir(this.file(id, 'pages', 'root'), { recursive: true });
      await fs.mkdir(this.file(id, 'pages', 'reply'), { recursive: true });
      await fs.mkdir(this.file(id, 'normalized', 'comments'), { recursive: true });
      await fs.mkdir(this.file(id, 'normalized', 'videos'), { recursive: true });
      await fs.mkdir(this.file(id, 'comments'), { recursive: true });
      await fs.mkdir(this.file(id, 'metadata'), { recursive: true });
      await fs.mkdir(this.file(id, 'exports'), { recursive: true });
      await fs.mkdir(this.file(id, 'ledger'), { recursive: true });
      await atomicWriteJson(this.file(id, 'job.json'), job);
      await atomicWriteJson(this.file(id, 'manifest.json'), {
        schema_version: 1,
        job_id: id,
        created_at: job.createdAt,
        profile_input: config.profileInput,
        profile_source_url: config.profileSourceUrl || config.profileUrl,
        profile_url: config.profileUrl,
        media_policy: 'forbidden',
        checkpoint_root: 'pages/',
        export_policy: 'xlsx_csv_ndjson_json',
      });
      this.taskCaches.set(id, new Map());
      return job;
    });
  }

  async loadTaskCache(jobId) {
    if (this.taskCaches.has(jobId)) return this.taskCaches.get(jobId);
    if (this.taskCacheLoads.has(jobId)) return this.taskCacheLoads.get(jobId);
    const loading = (async () => {
      const names = await listJsonNames(this.file(jobId, 'tasks'));
      const cache = new Map();
      for (let offset = 0; offset < names.length; offset += TASK_READ_CONCURRENCY) {
        const ids = names.slice(offset, offset + TASK_READ_CONCURRENCY);
        const tasks = await Promise.all(ids.map((id) => (
          readJson(this.file(jobId, 'tasks', `${id}.json`)).catch(() => null)
        )));
        for (const task of tasks) {
          if (task?.id) cache.set(task.id, task);
        }
      }
      this.taskCaches.set(jobId, cache);
      return cache;
    })();
    this.taskCacheLoads.set(jobId, loading);
    try {
      return await loading;
    } finally {
      this.taskCacheLoads.delete(jobId);
    }
  }

  peekTaskCache(jobId) {
    const cache = this.taskCaches.get(jobId);
    return cache ? [...cache.values()] : null;
  }

  async listJobs() {
    const ids = await listDirectories(this.jobsDir);
    const jobs = await Promise.all(ids.map((id) => this.readJob(id).catch(() => null)));
    return jobs.filter(Boolean).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async listJobSummaries() {
    return (await this.listJobs()).map(summarizeJob);
  }

  async patchJob(jobId, patch, now = new Date()) {
    return this.mutate(async () => {
      const current = await this.readJob(jobId);
      if (!current) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
      const next = {
        ...current,
        ...patch,
        progress: patch.progress ? mergeProgress(current.progress, patch.progress) : current.progress,
        updatedAt: isoNow(now),
      };
      await atomicWriteJson(this.file(jobId, 'job.json'), next);
      return next;
    });
  }

  async writeCatalog(jobId, payload = {}) {
    const { profile, videos = [], capturedAt = isoNow() } = payload;
    const profileRecord = profile || payload;
    const catalog = {
      schema_version: 1,
      platform: 'douyin',
      account_name: profileRecord?.account_name || '',
      douyin_id: profileRecord?.douyin_id || '',
      profile_url: profileRecord?.profile_url || '',
      public_video_count: Number.isFinite(Number(profileRecord?.public_video_count))
        ? Number(profileRecord.public_video_count)
        : videos.length,
      catalog_completed_at: capturedAt,
      videos,
    };
    await atomicWriteJson(this.file(jobId, 'catalog.json'), catalog);
    await atomicWriteJson(this.file(jobId, 'catalog', 'profile-snapshot.json'), {
      ...profileRecord,
      captured_at: capturedAt,
      video_count: videos.length,
    });
    const ndjson = videos.map((video) => JSON.stringify(video)).join('\n');
    await atomicWrite(this.file(jobId, 'catalog', 'videos.ndjson'), ndjson ? `${ndjson}\n` : '');
    return catalog;
  }

  async recordPageProgress(jobId, {
    kind,
    received = 0,
    completed = false,
    discoveredReplyTasks = 0,
  } = {}) {
    return this.mutate(async () => {
      const job = await this.readJob(jobId);
      if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
      const previous = job.progress || {};
      const progress = {
        ...previous,
        commentsCaptured: Number(previous.commentsCaptured || 0) + Math.max(0, Number(received) || 0),
        replyTasksTotal: Number(previous.replyTasksTotal || 0) + Math.max(0, Number(discoveredReplyTasks) || 0),
        rootTasksComplete: Number(previous.rootTasksComplete || 0)
          + (kind === 'root' && completed ? 1 : 0),
        replyTasksComplete: Number(previous.replyTasksComplete || 0)
          + (kind === 'reply' && completed ? 1 : 0),
      };
      const next = { ...job, progress, updatedAt: isoNow() };
      await atomicWriteJson(this.file(jobId, 'job.json'), next);
      return progress;
    });
  }

  async readCatalog(jobId) {
    return readJson(this.file(jobId, 'catalog.json'));
  }

  async readManifest(jobId) {
    return readJson(this.file(jobId, 'manifest.json'));
  }

  async patchManifest(jobId, patch) {
    return this.mutate(async () => {
      const current = await this.readManifest(jobId);
      if (!current) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
      const next = { ...current, ...patch, updated_at: isoNow() };
      await atomicWriteJson(this.file(jobId, 'manifest.json'), next);
      return next;
    });
  }

  async createTask(jobId, task) {
    const normalized = {
      ...task,
      id: task.id || taskIdFor(task.kind, task.videoId, task.rootCommentId),
      status: task.status || 'ready',
      attempts: Number(task.attempts || 0),
      pageRefs: Array.isArray(task.pageRefs) ? task.pageRefs : [],
      nextCursor: Number(task.nextCursor || 0),
      hasMore: task.hasMore !== false,
      lease: null,
      lastError: task.lastError || null,
      updatedAt: isoNow(),
    };
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const filePath = this.file(jobId, 'tasks', `${normalized.id}.json`);
      if (cache.has(normalized.id)) return cache.get(normalized.id);
      await atomicWriteJson(filePath, normalized);
      cache.set(normalized.id, normalized);
      return normalized;
    });
  }

  async createTasks(jobId, tasks = []) {
    const normalizedTasks = tasks.map((task) => ({
      ...task,
      id: task.id || taskIdFor(task.kind, task.videoId, task.rootCommentId),
      status: task.status || 'ready',
      attempts: Number(task.attempts || 0),
      pageRefs: Array.isArray(task.pageRefs) ? task.pageRefs : [],
      nextCursor: Number(task.nextCursor || 0),
      hasMore: task.hasMore !== false,
      lease: null,
      lastError: task.lastError || null,
      updatedAt: isoNow(),
    }));
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const output = [];
      for (let offset = 0; offset < normalizedTasks.length; offset += 16) {
        const chunk = normalizedTasks.slice(offset, offset + 16);
        output.push(...await Promise.all(chunk.map(async (task) => {
          const filePath = this.file(jobId, 'tasks', `${task.id}.json`);
          if (cache.has(task.id)) return cache.get(task.id);
          await atomicWriteJson(filePath, task);
          cache.set(task.id, task);
          return task;
        })));
      }
      return output;
    });
  }

  async pruneUnstartedTasksOutsideCatalog(jobId, videoIds = []) {
    const allowed = new Set(videoIds.map(asId).filter(Boolean));
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const taskIds = [...cache.keys()];
      let removed = 0;
      for (const taskId of taskIds) {
        const task = await this.getTask(jobId, taskId);
        if (!task || allowed.has(asId(task.videoId))) continue;
        if (Number(task.capturedCount || 0) > 0 || (task.pageRefs || []).length > 0) {
          throw new DouyinCommentError(
            'CATALOG_TASK_CONFLICT',
            'A task outside the imported catalog already contains durable comment pages.',
            409,
          );
        }
        await fs.rm(this.file(jobId, 'tasks', `${taskId}.json`), { force: true });
        cache.delete(taskId);
        removed += 1;
      }
      return removed;
    });
  }

  async getTask(jobId, taskId) {
    return (await this.loadTaskCache(jobId)).get(taskId) || null;
  }

  async listTasks(jobId) {
    return [...(await this.loadTaskCache(jobId)).values()];
  }

  async patchTask(jobId, taskId, patch) {
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const current = cache.get(taskId);
      if (!current) throw new DouyinCommentError('TASK_NOT_FOUND', 'Collection task was not found.', 404);
      const next = { ...current, ...patch, updatedAt: isoNow() };
      await atomicWriteJson(this.file(jobId, 'tasks', `${taskId}.json`), next);
      cache.set(taskId, next);
      return next;
    });
  }

  async claimNextTask(jobId, { workerId, leaseMs, preferRoot = false, now = Date.now() }) {
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const compare = (left, right) => Number(left.nextAttemptAt || 0) - Number(right.nextAttemptAt || 0)
        || String(left.id).localeCompare(String(right.id));
      const preferredKind = preferRoot ? 'root' : 'reply';
      let preferred = null;
      let fallback = null;
      for (const task of cache.values()) {
        const leaseExpired = task.status === 'running' && Number(task.lease?.expiresAt || 0) <= now;
        const runnable = task.status === 'ready' || leaseExpired;
        if (!runnable || Number(task.nextAttemptAt || 0) > now) continue;
        if (!fallback || compare(task, fallback) < 0) fallback = task;
        if (task.kind === preferredKind && (!preferred || compare(task, preferred) < 0)) preferred = task;
      }
      const task = preferred || fallback;
      if (!task) return null;
      const claimed = {
        ...task,
        status: 'running',
        lease: { workerId, claimedAt: now, expiresAt: now + leaseMs },
        updatedAt: isoNow(),
      };
      await atomicWriteJson(this.file(jobId, 'tasks', `${claimed.id}.json`), claimed);
      cache.set(claimed.id, claimed);
      return claimed;
    });
  }

  async releaseExpiredLeases(jobId, now = Date.now()) {
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const taskIds = [...cache.keys()];
      let released = 0;
      for (const taskId of taskIds) {
        const task = await this.getTask(jobId, taskId);
        if (task?.status !== 'running') continue;
        if (Number(task.lease?.expiresAt || 0) > now) continue;
        const next = {
          ...task,
          status: 'ready',
          lease: null,
          updatedAt: isoNow(),
        };
        await atomicWriteJson(this.file(jobId, 'tasks', `${taskId}.json`), next);
        cache.set(taskId, next);
        released += 1;
      }
      return released;
    });
  }

  async releaseAllRunningTasks(jobId) {
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const taskIds = [...cache.keys()];
      let released = 0;
      for (const taskId of taskIds) {
        const task = await this.getTask(jobId, taskId);
        if (task?.status !== 'running') continue;
        const next = {
          ...task,
          status: 'ready',
          lease: null,
          updatedAt: isoNow(),
        };
        await atomicWriteJson(this.file(jobId, 'tasks', `${taskId}.json`), next);
        cache.set(taskId, next);
        released += 1;
      }
      return released;
    });
  }

  async requeueFailedTasks(jobId) {
    return this.mutate(async () => {
      const cache = await this.loadTaskCache(jobId);
      const taskIds = [...cache.keys()];
      let requeued = 0;
      for (const taskId of taskIds) {
        const task = await this.getTask(jobId, taskId);
        if (task?.status !== 'failed') continue;
        const next = {
          ...task,
          status: 'ready',
          lease: null,
          attempts: 0,
          nextAttemptAt: 0,
          updatedAt: isoNow(),
        };
        await atomicWriteJson(this.file(jobId, 'tasks', `${taskId}.json`), next);
        cache.set(taskId, next);
        requeued += 1;
      }
      return requeued;
    });
  }

  pagePath(jobId, task, pageNumber) {
    const group = task.kind === 'reply'
      ? path.join('pages', 'reply', asId(task.videoId), asId(task.rootCommentId))
      : path.join('pages', 'root', asId(task.videoId));
    return this.file(jobId, group, `${String(pageNumber).padStart(6, '0')}.json`);
  }

  async writePage(jobId, task, pageNumber, payload) {
    const filePath = this.pagePath(jobId, task, pageNumber);
    await atomicWriteJson(filePath, payload);
    return path.relative(this.jobDir(jobId), filePath).replaceAll(path.sep, '/');
  }

  async readPage(jobId, relativePath) {
    return readJson(path.join(this.jobDir(jobId), relativePath));
  }

  async writeSourceDocument(jobId, videoId, { comments, metadata }) {
    const commentDocument = {
      schema_version: 3,
      video_id: asId(videoId),
      video_title: asText(metadata?.video_title),
      video_url: asText(metadata?.video_url) || `https://www.douyin.com/video/${videoId}`,
      collected_at: isoNow(),
      comments,
      completeness: metadata?.completeness || {},
    };
    await atomicWriteJson(this.file(jobId, 'comments', `${videoId}.json`), commentDocument);
    await atomicWriteJson(this.file(jobId, 'metadata', `${videoId}.json`), {
      schema_version: 3,
      video_id: asId(videoId),
      metadata,
      completeness: metadata?.completeness || {},
    });
  }

  async readComments(jobId, videoId) {
    return readJson(this.file(jobId, 'comments', `${videoId}.json`));
  }

  async appendEvent(jobId, event) {
    return this.mutate(async () => {
      const job = await this.readJob(jobId);
      if (!job) throw new DouyinCommentError('JOB_NOT_FOUND', 'Collection job was not found.', 404);
      const sequence = Number(job.progress?.lastEventSeq || 0) + 1;
      const record = { sequence, jobId, at: isoNow(), ...event };
      const ledgerPath = this.file(jobId, 'ledger', 'events.ndjson');
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
      const next = {
        ...job,
        progress: { ...(job.progress || {}), lastEventSeq: sequence },
        updatedAt: record.at,
      };
      await atomicWriteJson(this.file(jobId, 'job.json'), next);
      return record;
    });
  }

  async listEvents(jobId, afterSequence = 0, limit = 200) {
    try {
      const text = await fs.readFile(this.file(jobId, 'ledger', 'events.ndjson'), 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .filter((event) => Number(event.sequence) > Number(afterSequence))
        .slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async listArtifacts(jobId) {
    const directory = this.file(jobId, 'exports');
    try {
      return (await fs.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(xlsx|csv|ndjson|json|md)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async auditNoMedia(jobId) {
    const files = await listRelativeFiles(this.jobDir(jobId));
    const forbidden = /(?:^|\/)(?:media|media-cache)(?:\/|$)|\.(?:mp4|webm|m3u8|mp3|aac|wav|flac|m4a)$/i;
    const violations = files.filter((relative) => forbidden.test(relative));
    return { passed: violations.length === 0, violations, checkedAt: isoNow() };
  }

  async artifactPath(jobId, artifactName) {
    if (!/^[a-zA-Z0-9._-]+\.(xlsx|csv|ndjson|json|md)$/i.test(artifactName)) {
      throw new DouyinCommentError('ARTIFACT_INVALID', 'The requested artifact is not available.', 400);
    }
    const candidate = path.resolve(this.file(jobId, 'exports', artifactName));
    const root = path.resolve(this.file(jobId, 'exports'));
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw new DouyinCommentError('ARTIFACT_INVALID', 'The requested artifact is not available.', 400);
    }
    if (!(await exists(candidate))) throw new DouyinCommentError('ARTIFACT_NOT_FOUND', 'Artifact was not found.', 404);
    return candidate;
  }
}

export { atomicWrite, atomicWriteJson, readJson };
