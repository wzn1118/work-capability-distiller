import fs from 'node:fs/promises';
import path from 'node:path';

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

function objectEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).map(([key, result]) => ({ key, result }))
    : [];
}

export class JobPayloadStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.snapshots = new Map();
  }

  paths(jobId) {
    const root = path.join(this.dataDir, 'jobs', jobId, 'payload');
    return {
      root,
      results: path.join(root, 'results.ndjson'),
      targets: path.join(root, 'targets.ndjson'),
      selectedCreatorIds: path.join(root, 'selected-creator-ids.ndjson'),
      channelResults: path.join(root, 'channel-results.ndjson'),
    };
  }

  async initializeJob(job) {
    if (!job?.id || job.type === 'content') return job;
    const paths = this.paths(job.id);
    const inline = {
      results: Array.isArray(job.results),
      targets: Array.isArray(job.targets),
      selectedCreatorIds: Array.isArray(job.selectedCreatorIds),
      channelResults: Boolean(job.channelResults && typeof job.channelResults === 'object' && !Array.isArray(job.channelResults)),
    };
    const results = inline.results ? job.results : await readNdjson(paths.results);
    const targets = inline.targets ? job.targets : await readNdjson(paths.targets);
    const selectedRows = inline.selectedCreatorIds
      ? job.selectedCreatorIds.map((id) => ({ id }))
      : await readNdjson(paths.selectedCreatorIds);
    const channelRows = inline.channelResults ? objectEntries(job.channelResults) : await readNdjson(paths.channelResults);
    const hydrated = {
      ...job,
      results,
      targets,
      selectedCreatorIds: selectedRows.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id),
      channelResults: Object.fromEntries(channelRows.filter((entry) => entry?.key).map((entry) => [entry.key, entry.result])),
    };
    if (Object.values(inline).some(Boolean)) await this.persist(hydrated, { force: true });
    return hydrated;
  }

  async persist(job, { force = false } = {}) {
    if (!job?.id || job.type === 'content') return null;
    const paths = this.paths(job.id);
    const values = {
      results: Array.isArray(job.results) ? job.results : [],
      targets: Array.isArray(job.targets) ? job.targets : [],
      selectedCreatorIds: (Array.isArray(job.selectedCreatorIds) ? job.selectedCreatorIds : []).map((id) => ({ id })),
      channelResults: objectEntries(job.channelResults),
    };
    const prior = this.snapshots.get(job.id) || {};
    const next = {};
    for (const [field, rows] of Object.entries(values)) {
      const serialized = JSON.stringify(rows);
      next[field] = serialized;
      if (force || prior[field] !== serialized) await writeNdjsonAtomic(paths[field], rows);
    }
    this.snapshots.set(job.id, next);
    return {
      schemaVersion: 1,
      format: 'ndjson_by_job',
      resultCount: values.results.length,
      targetCount: values.targets.length,
      selectedCreatorCount: values.selectedCreatorIds.length,
      channelResultCount: values.channelResults.length,
    };
  }
}
