import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContentResultStore } from './content-result-store.mjs';
import { JobPayloadStore } from './job-payload-store.mjs';

const MAX_EVENTS = 180;
const INTERRUPTED_STATUSES = new Set(['queued', 'running']);

function persistenceError(error) {
  return {
    message: error?.message || 'Unable to persist collection jobs.',
    at: new Date().toISOString(),
  };
}

export class JobStore {
  constructor(dataDir, { sanitizeJob = null } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'jobs.json');
    this.sanitizeJob = sanitizeJob;
    this.jobs = new Map();
    this.campaigns = new Map();
    this.writeQueue = Promise.resolve();
    this.persistencePending = null;
    this.persistenceDirty = false;
    this.lastPersistenceError = null;
    this.recoveryNotice = null;
    this.contentResults = new ContentResultStore(dataDir);
    this.jobPayloads = new JobPayloadStore(dataDir);
    this.storageWaterline = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.refreshStorageWaterline();
        return;
      }
      if (error instanceof SyntaxError) {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}.json`;
        await fs.rename(this.filePath, backupPath);
        this.recoveryNotice = `Recovered from corrupt jobs file: ${path.basename(backupPath)}`;
        return;
      }
      throw error;
    }

    if (!payload || !Array.isArray(payload.jobs)) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}.json`;
      await fs.rename(this.filePath, backupPath);
      this.recoveryNotice = `Recovered from invalid jobs file: ${path.basename(backupPath)}`;
      return;
    }

    let recoveredJobs = 0;
    let sanitizedJobs = 0;
    let compactedContentJobs = 0;
    let compactedJobPayloads = 0;
    let needsPersistence = Number(payload.schemaVersion) !== 2;
    const now = new Date().toISOString();
    for (const savedJob of payload.jobs) {
      if (!savedJob?.id) continue;
      let job = { ...savedJob, events: Array.isArray(savedJob.events) ? savedJob.events : [] };
      if (job.type !== 'content') {
        const hasInlinePayload = Array.isArray(savedJob.targets)
          || Array.isArray(savedJob.results)
          || Array.isArray(savedJob.selectedCreatorIds)
          || Boolean(savedJob.channelResults && typeof savedJob.channelResults === 'object');
        job = await this.jobPayloads.initializeJob(job);
        if (hasInlinePayload) {
          compactedJobPayloads += 1;
          needsPersistence = true;
        }
      }
      const sanitized = this.sanitizeJob?.(job);
      if (sanitized?.job) job = sanitized.job;
      if (sanitized?.changed) sanitizedJobs += 1;
      if (INTERRUPTED_STATUSES.has(job.status)) {
        job.status = 'interrupted';
        // A restart does not mean the connector work was complete. Keep the last
        // checkpoint visible so the resume flow can accurately show its state.
        job.progress = Math.max(0, Math.min(99, Number(job.progress) || 0));
        job.finishedAt = null;
        job.updatedAt = now;
        job.error = {
          code: 'SERVER_RESTARTED',
          message: 'The local service restarted before this collection completed.',
          action: 'Resume this collection from its saved checkpoint.',
        };
        job.events.push({ at: now, level: 'warn', message: 'Collection marked interrupted after local service restart.' });
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
        recoveredJobs += 1;
      }
      if (job.type === 'content') {
        const hasInlineContent = Array.isArray(savedJob.targets)
          || Array.isArray(savedJob.results)
          || (savedJob.channelResults && typeof savedJob.channelResults === 'object');
        job = await this.contentResults.initializeJob(job);
        if (hasInlineContent) {
          compactedContentJobs += 1;
          needsPersistence = true;
        }
      }
      this.jobs.set(job.id, job);
    }

    for (const savedCampaign of Array.isArray(payload.campaigns) ? payload.campaigns : []) {
      if (!savedCampaign?.id) continue;
      this.campaigns.set(savedCampaign.id, { ...savedCampaign });
    }
    const notices = [];
    if (recoveredJobs) notices.push(`Marked ${recoveredJobs} incomplete collection job(s) as interrupted.`);
    if (sanitizedJobs) notices.push(`Sanitized ${sanitizedJobs} historical collection job(s) with invalid creator identities.`);
    if (compactedContentJobs) notices.push(`Compacted ${compactedContentJobs} content job(s) into external result storage.`);
    if (compactedJobPayloads) notices.push(`Compacted ${compactedJobPayloads} job payload(s) into external NDJSON storage.`);
    if (notices.length) {
      this.recoveryNotice = notices.join(' ');
    }
    if (needsPersistence) await this.persistSoon();
    await this.refreshStorageWaterline();
  }

  health() {
    return {
      status: this.lastPersistenceError ? 'degraded' : 'ready',
      error: this.lastPersistenceError,
      recoveryNotice: this.recoveryNotice,
      waterline: this.storageWaterline,
    };
  }

  create(input) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      events: [],
      channelResults: {},
      results: [],
      metrics: {},
      error: null,
      ...input,
    };
    this.jobs.set(job.id, job);
    void this.persistSoon().catch(() => {});
    return structuredClone(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  // Summary routes only read scalar metadata and must not clone a multi-target
  // content payload on every UI poll.
  inspect(id) {
    return this.jobs.get(id) || null;
  }

  list({ limit = 12, type = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    return this.listAll({ type }).slice(0, safeLimit);
  }

  // Internal product flows occasionally need the latest record for every
  // discovered creator, while the public archive deliberately remains capped.
  listAll({ type = '' } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !type || job.type === type)
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .map((job) => structuredClone(job));
  }

  createCampaign(input = {}) {
    const now = new Date().toISOString();
    const campaign = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      brief: {},
      channels: [],
      discoveryJobId: null,
      verificationJobIds: [],
      enrichmentJobIds: [],
      contentJobIds: [],
      contentAnalysisJobIds: [],
      contentAnalysisJobId: null,
      selectedCreatorIds: [],
      generated: false,
      sentCreatorIds: [],
      outreachDrafts: [],
      outreachMessages: [],
      currentStep: 1,
      ...input,
    };
    this.campaigns.set(campaign.id, campaign);
    void this.persistSoon().catch(() => {});
    return structuredClone(campaign);
  }

  getCampaign(id) {
    const campaign = this.campaigns.get(id);
    return campaign ? structuredClone(campaign) : null;
  }

  listCampaigns({ limit = 12 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    return [...this.campaigns.values()]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .slice(0, safeLimit)
      .map((campaign) => structuredClone(campaign));
  }

  patchCampaign(id, values) {
    const campaign = this.campaigns.get(id);
    if (!campaign) return null;
    Object.assign(campaign, values, { updatedAt: new Date().toISOString() });
    void this.persistSoon().catch(() => {});
    return structuredClone(campaign);
  }

  patch(id, values) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, values, { updatedAt: new Date().toISOString() });
    void this.persistSoon().catch(() => {});
    return structuredClone(job);
  }

  // High-frequency pipeline progress remains visible through the local API,
  // while durable checkpoints are written at creator and task boundaries.
  patchTransient(id, values) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, values, { updatedAt: new Date().toISOString() });
    return { id: job.id, status: job.status, progress: job.progress, updatedAt: job.updatedAt };
  }

  addEvent(id, event) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.events.push({ at: new Date().toISOString(), level: 'info', ...event });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    job.updatedAt = new Date().toISOString();
    void this.persistSoon().catch(() => {});
    return structuredClone(job);
  }

  addEventTransient(id, event) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.events.push({ at: new Date().toISOString(), level: 'info', ...event });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    job.updatedAt = new Date().toISOString();
    return { id: job.id, status: job.status, progress: job.progress, updatedAt: job.updatedAt };
  }

  jobsDirectory(jobId) {
    return path.join(this.dataDir, 'jobs', jobId);
  }

  async initializeContentJob(jobId, targets) {
    const job = this.jobs.get(jobId);
    if (!job || job.type !== 'content') return null;
    await this.contentResults.writeTargets(jobId, targets);
    Object.assign(job, await this.contentResults.initializeJob({ ...job, targets }, { migrateLegacy: false }));
    return structuredClone(job);
  }

  async commitContentResult(jobId, { capture = null, targetId = '', channelResult = null } = {}) {
    const job = this.jobs.get(jobId);
    if (!job || job.type !== 'content') return null;
    const checkpoint = await this.contentResults.commit(jobId, { capture, targetId, channelResult });
    job.results = this.contentResults.summariesForJob(jobId);
    job.channelResults = this.contentResults.channelResultsForJob(jobId);
    return structuredClone(checkpoint);
  }

  listContent(jobId, options = {}) {
    return this.contentResults.list(jobId, options);
  }

  listAllContent(jobId) {
    return this.contentResults.listAll(jobId);
  }

  listContentSamples(jobId, targetId, options = {}) {
    return this.contentResults.listSamples(jobId, targetId, options);
  }

  loadContentCaptures(jobId, targetIds = null) {
    return this.contentResults.loadCaptures(jobId, targetIds);
  }

  async refreshStorageWaterline() {
    try {
      const stats = await fs.statfs(this.dataDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      this.storageWaterline = {
        dataDir: this.dataDir,
        freeBytes,
        totalBytes,
        freeGb: Number((freeBytes / (1024 ** 3)).toFixed(2)),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.storageWaterline = {
        dataDir: this.dataDir,
        error: error?.message || 'Storage capacity is unavailable.',
        checkedAt: new Date().toISOString(),
      };
    }
    return this.storageWaterline;
  }

  persistableJob(job) {
    if (job?.type !== 'content') {
      return {
        ...job,
        targets: undefined,
        selectedCreatorIds: undefined,
        results: undefined,
        channelResults: undefined,
        payloadStorage: {
          schemaVersion: 1,
          format: 'ndjson_by_job',
          targetCount: Array.isArray(job.targets) ? job.targets.length : 0,
          selectedCreatorCount: Array.isArray(job.selectedCreatorIds) ? job.selectedCreatorIds.length : 0,
          resultCount: Array.isArray(job.results) ? job.results.length : 0,
          channelResultCount: Object.keys(job.channelResults || {}).length,
        },
      };
    }
    const resultCount = Array.isArray(job.results) ? job.results.length : Number(job.resultStorage?.resultCount) || 0;
    return {
      ...job,
      targets: undefined,
      selectedCreatorIds: undefined,
      results: undefined,
      channelResults: undefined,
      resultStorage: {
        schemaVersion: 1,
        format: 'per_target_json_and_ndjson_index',
        targetCount: Number(job.metrics?.targetCreators) || 0,
        resultCount,
      },
    };
  }

  persistSoon() {
    this.persistenceDirty = true;
    if (this.persistencePending) return this.persistencePending;

    const write = this.writeQueue.catch(() => undefined).then(async () => {
      while (this.persistenceDirty) {
        this.persistenceDirty = false;
        await Promise.all([...this.jobs.values()].map((job) => this.jobPayloads.persist(job)));
        const snapshot = {
          schemaVersion: 2,
          jobs: [...this.jobs.values()].map((job) => this.persistableJob(job)),
          campaigns: [...this.campaigns.values()],
        };
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
        await fs.rename(temporaryPath, this.filePath);
        this.lastPersistenceError = null;
      }
    }).catch((error) => {
      this.lastPersistenceError = persistenceError(error);
      console.error('Could not persist KOL collection jobs:', error);
      throw error;
    });

    this.persistencePending = write;
    this.writeQueue = write;
    void write.then(
      () => this.completePersistence(write),
      () => this.completePersistence(write),
    );
    return write;
  }

  completePersistence(write) {
    if (this.persistencePending !== write) return;
    this.persistencePending = null;
    if (this.persistenceDirty) this.persistSoon();
  }

  async flush() {
    while (true) {
      const pending = this.writeQueue;
      await pending;
      if (pending === this.writeQueue && !this.persistencePending && !this.persistenceDirty) return;
    }
  }
}
