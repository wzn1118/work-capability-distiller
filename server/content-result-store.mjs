import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { contentInputFingerprint } from './content-analysis.mjs';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;

function compactText(value, limit = 240) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function safeTargetKey(targetId) {
  return createHash('sha256').update(String(targetId || '')).digest('hex').slice(0, 32);
}

function contentStoreDirectory(dataDir, jobId) {
  return path.join(dataDir, 'jobs', jobId, 'content-store');
}

function targetIdOf(value) {
  return compactText(value?.targetId || value?.discoveryCreatorId || value?.id, 180);
}

function captureSamples(capture) {
  return Array.isArray(capture?.content?.visibleSamples) ? capture.content.visibleSamples : [];
}

export function contentCaptureSummary(capture) {
  const targetId = targetIdOf(capture);
  const samples = captureSamples(capture);
  const itemLedger = capture?.content?.itemLedger || {};
  return {
    schemaVersion: 1,
    targetId,
    discoveryCreatorId: targetId,
    channel: capture?.channel || null,
    platform: capture?.platform || capture?.channel || null,
    identityKey: capture?.identityKey || null,
    name: capture?.name || null,
    handle: capture?.handle || capture?.profile?.handle || null,
    sourceUrl: capture?.sourceUrl || null,
    capturedAt: capture?.capturedAt || null,
    inputFingerprint: contentInputFingerprint(capture),
    status: capture?.status || (samples.length ? 'collected' : 'completed_empty'),
    profileConfirmation: capture?.profileConfirmation || null,
    profile: capture?.profile || null,
    audience: capture?.audience || null,
    performance: capture?.performance || null,
    commercial: capture?.commercial || null,
    risk: capture?.risk || null,
    quality: capture?.quality || null,
    evidence: capture?.evidence || null,
    provenance: capture?.provenance || null,
    content: {
      visibleSampleCount: Number.isFinite(capture?.content?.visibleSampleCount)
        ? capture.content.visibleSampleCount
        : samples.length,
      requestedSampleLimit: Number.isFinite(capture?.content?.requestedSampleLimit)
        ? capture.content.requestedSampleLimit
        : null,
      collectionCoverage: capture?.content?.collectionCoverage || null,
      itemLedger: {
        schemaVersion: itemLedger.schemaVersion || null,
        scope: itemLedger.scope || null,
        requestedSampleLimit: Number.isFinite(itemLedger.requestedSampleLimit) ? itemLedger.requestedSampleLimit : null,
        observedVisibleSampleCount: Number.isFinite(itemLedger.observedVisibleSampleCount)
          ? itemLedger.observedVisibleSampleCount
          : samples.length,
        uniquePublicContentCount: Number.isFinite(itemLedger.uniquePublicContentCount)
          ? itemLedger.uniquePublicContentCount
          : samples.length,
        duplicateVisibleReferenceCount: Number(itemLedger.duplicateVisibleReferenceCount) || 0,
        unavailableContentCount: Number(itemLedger.unavailableContentCount) || 0,
        publicVideoCandidateCount: Number(itemLedger.publicVideoCandidateCount) || 0,
      },
    },
  };
}

export function contentListSummary(summary) {
  const profile = summary?.profile || {};
  const confirmation = summary?.profileConfirmation || {};
  return {
    schemaVersion: summary?.schemaVersion || 1,
    targetId: summary?.targetId || null,
    discoveryCreatorId: summary?.discoveryCreatorId || summary?.targetId || null,
    channel: summary?.channel || null,
    platform: summary?.platform || summary?.channel || null,
    identityKey: summary?.identityKey || null,
    name: summary?.name || null,
    handle: summary?.handle || profile.handle || null,
    sourceUrl: summary?.sourceUrl || null,
    capturedAt: summary?.capturedAt || null,
    inputFingerprint: summary?.inputFingerprint || null,
    status: summary?.status || null,
    profileConfirmation: {
      status: confirmation.status || null,
      observedName: confirmation.observedName || null,
      matchMethod: confirmation.matchMethod || null,
    },
    profile: {
      displayName: profile.displayName || null,
      bio: profile.bio || null,
      location: profile.location || null,
      verified: typeof profile.verified === 'boolean' ? profile.verified : null,
      verifiedLabel: profile.verifiedLabel || null,
      accountType: profile.accountType || null,
      avatar: profile.avatar || null,
      followerCount: Number.isFinite(profile.followerCount) ? profile.followerCount : null,
      followerLabel: profile.followerLabel || null,
      followingCount: Number.isFinite(profile.followingCount) ? profile.followingCount : null,
      followingLabel: profile.followingLabel || null,
      totalLikes: Number.isFinite(profile.totalLikes) ? profile.totalLikes : null,
      totalLikesLabel: profile.totalLikesLabel || null,
      workCount: Number.isFinite(profile.workCount) ? profile.workCount : null,
      workCountLabel: profile.workCountLabel || null,
      metricSources: profile.metricSources && typeof profile.metricSources === 'object'
        ? profile.metricSources
        : null,
      metricsCapturedAt: profile.metricsCapturedAt || summary?.capturedAt || null,
      missingReasons: profile.missingReasons && typeof profile.missingReasons === 'object'
        ? profile.missingReasons
        : null,
    },
    content: summary?.content || {
      visibleSampleCount: 0,
      requestedSampleLimit: null,
      collectionCoverage: null,
      itemLedger: null,
    },
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function readNdjson(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeNdjsonAtomic(filePath, values) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = values.length ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
  await fs.writeFile(temporaryPath, payload, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function pageArguments({ cursor = 0, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const parsedCursor = Number.parseInt(cursor, 10);
  const parsedLimit = Number.parseInt(limit, 10);
  return {
    cursor: Number.isFinite(parsedCursor) ? Math.max(0, parsedCursor) : 0,
    limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, MAX_PAGE_LIMIT)) : DEFAULT_PAGE_LIMIT,
  };
}

export class ContentResultStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.indexes = new Map();
    this.summaries = new Map();
    this.checkpoints = new Map();
  }

  paths(jobId, targetId = '') {
    const root = contentStoreDirectory(this.dataDir, jobId);
    const key = targetId ? safeTargetKey(targetId) : '';
    return {
      root,
      targets: path.join(root, 'targets.ndjson'),
      index: path.join(root, 'result-index.ndjson'),
      capture: key ? path.join(root, 'captures', `${key}.json`) : '',
      checkpoint: key ? path.join(root, 'checkpoints', `${key}.json`) : '',
    };
  }

  async initializeJob(job, { migrateLegacy = true } = {}) {
    if (!job?.id || job.type !== 'content') return job;
    const paths = this.paths(job.id);
    await fs.mkdir(path.join(paths.root, 'captures'), { recursive: true });
    await fs.mkdir(path.join(paths.root, 'checkpoints'), { recursive: true });

    let targets = await readNdjson(paths.targets);
    if (!targets.length && Array.isArray(job.targets) && job.targets.length) {
      targets = job.targets;
      await writeNdjsonAtomic(paths.targets, targets);
    }

    const indexEntries = await readNdjson(paths.index);
    const orderedIds = [];
    const indexed = new Set();
    for (const entry of indexEntries) {
      const targetId = targetIdOf(entry);
      if (!targetId || indexed.has(targetId)) continue;
      indexed.add(targetId);
      orderedIds.push(targetId);
    }
    this.indexes.set(job.id, orderedIds);

    if (migrateLegacy) {
      const legacyResults = Array.isArray(job.results) ? job.results : [];
      const legacyChannelResults = job.channelResults && typeof job.channelResults === 'object' ? job.channelResults : {};
      for (const capture of legacyResults) {
        const targetId = targetIdOf(capture);
        if (!targetId) continue;
        const channelResult = Object.values(legacyChannelResults).find((entry) => entry?.targetId === targetId) || null;
        await this.commit(job.id, { capture, channelResult, migrated: true });
      }
      for (const channelResult of Object.values(legacyChannelResults)) {
        const targetId = targetIdOf(channelResult);
        if (!targetId || legacyResults.some((capture) => targetIdOf(capture) === targetId)) continue;
        await this.commit(job.id, { targetId, channelResult, migrated: true });
      }
    }

    const refreshedEntries = await readNdjson(paths.index);
    const refreshedIds = [];
    const refreshedSet = new Set();
    for (const entry of refreshedEntries) {
      const targetId = targetIdOf(entry);
      if (!targetId || refreshedSet.has(targetId)) continue;
      refreshedSet.add(targetId);
      refreshedIds.push(targetId);
    }
    this.indexes.set(job.id, refreshedIds);

    const summaries = new Map();
    const checkpoints = new Map();
    for (const targetId of refreshedIds) {
      const checkpoint = await readJson(this.paths(job.id, targetId).checkpoint);
      if (checkpoint) checkpoints.set(targetId, checkpoint);
      if (checkpoint?.summary) summaries.set(targetId, checkpoint.summary);
    }
    this.summaries.set(job.id, summaries);
    this.checkpoints.set(job.id, checkpoints);

    return {
      ...job,
      targets,
      selectedCreatorIds: targets.map((target) => targetIdOf(target)).filter(Boolean),
      results: refreshedIds.map((targetId) => summaries.get(targetId)).filter(Boolean),
      channelResults: Object.fromEntries(
        [...checkpoints.values()]
          .filter((checkpoint) => checkpoint?.channelResult?.targetId)
          .map((checkpoint) => [checkpoint.channelResult.key || `${checkpoint.channelResult.platform}:${checkpoint.channelResult.targetId}`, checkpoint.channelResult]),
      ),
      resultStorage: {
        schemaVersion: 1,
        format: 'per_target_json_and_ndjson_index',
        targetCount: targets.length,
        resultCount: summaries.size,
      },
    };
  }

  async writeTargets(jobId, targets) {
    const values = Array.isArray(targets) ? targets : [];
    await writeNdjsonAtomic(this.paths(jobId).targets, values);
    return values.length;
  }

  async commit(jobId, { capture = null, targetId: explicitTargetId = '', channelResult = null, migrated = false } = {}) {
    const targetId = targetIdOf(capture) || compactText(explicitTargetId || channelResult?.targetId, 180);
    if (!targetId) throw new Error('A content result requires targetId.');
    const paths = this.paths(jobId, targetId);
    const summary = capture ? contentCaptureSummary(capture) : null;

    if (capture) await atomicWriteJson(paths.capture, capture);
    const checkpoint = {
      schemaVersion: 1,
      targetId,
      committedAt: new Date().toISOString(),
      migrated,
      summary,
      channelResult: channelResult ? { ...channelResult, key: channelResult.key || `${channelResult.platform}:${targetId}` } : null,
    };
    await atomicWriteJson(paths.checkpoint, checkpoint);

    const indexed = this.indexes.get(jobId) || [];
    if (!indexed.includes(targetId)) {
      await fs.mkdir(path.dirname(paths.index), { recursive: true });
      await fs.appendFile(paths.index, `${JSON.stringify({ targetId, indexedAt: checkpoint.committedAt })}\n`, 'utf8');
      indexed.push(targetId);
      this.indexes.set(jobId, indexed);
    }

    const summaries = this.summaries.get(jobId) || new Map();
    if (summary) summaries.set(targetId, summary);
    this.summaries.set(jobId, summaries);
    const checkpoints = this.checkpoints.get(jobId) || new Map();
    checkpoints.set(targetId, checkpoint);
    this.checkpoints.set(jobId, checkpoints);
    return checkpoint;
  }

  summariesForJob(jobId) {
    const summaries = this.summaries.get(jobId) || new Map();
    return (this.indexes.get(jobId) || []).map((targetId) => summaries.get(targetId)).filter(Boolean);
  }

  channelResultsForJob(jobId) {
    const checkpoints = this.checkpoints.get(jobId) || new Map();
    return Object.fromEntries(
      [...checkpoints.values()]
        .filter((checkpoint) => checkpoint?.channelResult?.targetId)
        .map((checkpoint) => [checkpoint.channelResult.key || `${checkpoint.channelResult.platform}:${checkpoint.channelResult.targetId}`, checkpoint.channelResult]),
    );
  }

  list(jobId, options = {}) {
    const { cursor, limit } = pageArguments(options);
    const ids = this.indexes.get(jobId) || [];
    const summaries = this.summaries.get(jobId) || new Map();
    const content = [];
    let nextOffset = cursor;
    while (nextOffset < ids.length && content.length < limit) {
      const summary = summaries.get(ids[nextOffset]);
      nextOffset += 1;
      if (summary) content.push(contentListSummary(summary));
    }
    return {
      content,
      cursor: String(cursor),
      nextCursor: nextOffset < ids.length ? String(nextOffset) : null,
      total: summaries.size,
    };
  }

  listAll(jobId) {
    const ids = this.indexes.get(jobId) || [];
    const summaries = this.summaries.get(jobId) || new Map();
    return ids.map((targetId) => summaries.get(targetId)).filter(Boolean).map(contentListSummary);
  }

  async readCapture(jobId, targetId) {
    return readJson(this.paths(jobId, targetId).capture);
  }

  async loadCaptures(jobId, targetIds = null) {
    const ids = Array.isArray(targetIds) && targetIds.length ? targetIds : (this.indexes.get(jobId) || []);
    const captures = await Promise.all(ids.map((targetId) => this.readCapture(jobId, targetId)));
    return captures.filter(Boolean);
  }

  async listSamples(jobId, targetId, options = {}) {
    const { cursor, limit } = pageArguments(options);
    const capture = await this.readCapture(jobId, targetId);
    const samples = captureSamples(capture);
    const content = samples.slice(cursor, cursor + limit);
    const nextOffset = cursor + content.length;
    return {
      target: capture ? contentListSummary(contentCaptureSummary(capture)) : null,
      samples: content,
      cursor: String(cursor),
      nextCursor: nextOffset < samples.length ? String(nextOffset) : null,
      total: samples.length,
    };
  }
}
