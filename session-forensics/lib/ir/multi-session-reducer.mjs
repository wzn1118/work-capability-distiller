import { migrateIRBundle } from './migrations.mjs';
import { createCapabilityIR } from './capability-ir.mjs';
import { sha256, stableStringify } from './trace-ir.mjs';

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '', maximum = 1600) {
  const result = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return (result || fallback).slice(0, maximum);
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values, maximum = 240) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, maximum);
}

function timestampOf(event) {
  const value = Date.parse(event?.timestamp || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function eventSortKey(event) {
  return [timestampOf(event), text(event?.sessionId, '~'), Number(event?.provenance?.eventIndex || 0), text(event?.eventId, '~')];
}

function compareEvents(left, right) {
  const a = eventSortKey(left);
  const b = eventSortKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function sourceSessionId(trace, event) {
  return text(event?.sessionId || trace?.sessionId, 'unknown-session', 160);
}

function mergeEvents(traces) {
  const byRawHash = new Map();
  const collisions = [];
  for (const trace of traces) {
    for (const sourceEvent of trace.events || []) {
      const event = clone(sourceEvent);
      const sessionId = sourceSessionId(trace, event);
      event.sessionId = sessionId;
      event.provenance = {
        ...(event.provenance || {}),
        sourceSessionId: sessionId,
        sourceTraceFingerprint: trace.fingerprint || null,
      };
      const rawHash = event.provenance.rawHash || sha256(event);
      event.provenance.rawHash = rawHash;
      if (byRawHash.has(rawHash)) continue;
      const existingId = [...byRawHash.values()].find((item) => item.eventId === event.eventId);
      if (existingId && existingId.provenance.rawHash !== rawHash) {
        event.eventId = `${event.eventId}:${rawHash.slice(0, 12)}`;
        event.parentEventId = null;
        collisions.push({ originalEventId: sourceEvent.eventId, resolvedEventId: event.eventId, rawHash });
      }
      byRawHash.set(rawHash, event);
    }
  }
  return { events: [...byRawHash.values()].sort(compareEvents), collisions };
}

function capabilityKey(capability) {
  return text(capability?.id || capability?.title, `capability-${sha256(capability).slice(0, 12)}`, 180).toLowerCase();
}

function mergeSteps(capabilities) {
  const byInstruction = new Map();
  for (const capability of capabilities) {
    for (const step of capability.steps || []) {
      const key = text(step.instruction).toLowerCase();
      if (!key) continue;
      const previous = byInstruction.get(key);
      if (!previous) {
        byInstruction.set(key, clone(step));
        continue;
      }
      byInstruction.set(key, {
        ...previous,
        evidenceRefs: unique([...previous.evidenceRefs, ...(step.evidenceRefs || [])], 80),
        toolContract: {
          ...(previous.toolContract || {}),
          tools: unique([...(previous.toolContract?.tools || []), ...(step.toolContract?.tools || [])], 40),
        },
      });
    }
  }
  return [...byInstruction.values()];
}

function mergeCapabilityVariants(key, variants) {
  const first = variants[0];
  const fingerprints = unique(variants.map((item) => item.fingerprint), 40);
  const merged = createCapabilityIR({
    ...clone(first),
    id: first.id,
    version: first.version,
    title: first.title,
    summary: variants.map((item) => item.summary).find(Boolean) || first.summary,
    triggers: unique(variants.flatMap((item) => item.triggers || []), 80),
    preconditions: unique(variants.flatMap((item) => item.preconditions || []), 80),
    inputSchema: first.inputSchema || {},
    steps: mergeSteps(variants),
    outputSchema: first.outputSchema || {},
    acceptance: unique(variants.flatMap((item) => item.acceptance || []), 80),
    recovery: unique(variants.flatMap((item) => item.recovery || []), 80),
    security: {
      filesystem: unique(variants.flatMap((item) => item.security?.filesystem || []), 120),
      commands: unique(variants.flatMap((item) => item.security?.commands || []), 120),
      network: unique(variants.flatMap((item) => item.security?.network || []), 80),
      secrets: variants.map((item) => item.security?.secrets).find(Boolean) || '',
    },
    provenance: {
      sourceSessions: unique(variants.flatMap((item) => item.provenance?.sourceSessions || []), 120),
      projectFingerprints: unique(variants.flatMap((item) => item.provenance?.projectFingerprints || []), 80),
      evidenceGraphHash: sha256(stableStringify(variants.map((item) => item.provenance?.evidenceGraphHash || item.fingerprint))),
      evidenceRefs: unique(variants.flatMap((item) => item.provenance?.evidenceRefs || []), 160),
    },
    evaluation: {
      static: 'pending',
      contract: 'pending',
      replay: 'pending',
      heldout: 'pending',
      canary: 'pending',
    },
  });
  return {
    capability: merged,
    conflict: fingerprints.length > 1 ? {
      key,
      type: 'capability-variant-conflict',
      variants: variants.map((item) => ({ fingerprint: item.fingerprint, title: item.title, version: item.version, sourceSessions: item.provenance?.sourceSessions || [] })),
      resolution: '合并共同步骤与全部证据，采用首个版本的输入输出契约，并保留所有变体指纹。',
    } : null,
  };
}

function groupProjects(projectAssignments = [], traces = []) {
  const groups = new Map();
  for (const assignment of projectAssignments || []) {
    const sessionId = text(assignment?.sessionId || assignment?.sourceSessionId, '', 160);
    const projectId = text(assignment?.projectId || assignment?.projectRoot, 'workspace-unassigned', 240);
    if (!groups.has(projectId)) {
      groups.set(projectId, {
        projectId,
        projectName: text(assignment?.projectName || assignment?.name, projectId),
        projectRoot: assignment?.projectRoot || null,
        sessionIds: [],
        evidence: [],
      });
    }
    const group = groups.get(projectId);
    if (sessionId) group.sessionIds.push(sessionId);
    group.evidence.push({
      sessionId,
      projectRoot: assignment?.projectRoot || null,
      confidence: assignment?.confidence || null,
      reason: assignment?.reason || null,
      linkedFiles: assignment?.linkedFiles || [],
    });
  }
  for (const trace of traces) {
    const sessionId = text(trace.sessionId, '', 160);
    if (!sessionId) continue;
    if (![...groups.values()].some((group) => group.sessionIds.includes(sessionId))) {
      if (!groups.has('workspace-unassigned')) groups.set('workspace-unassigned', { projectId: 'workspace-unassigned', projectName: '未分配项目', projectRoot: null, sessionIds: [], evidence: [] });
      groups.get('workspace-unassigned').sessionIds.push(sessionId);
    }
  }
  return [...groups.values()].map((group) => ({ ...group, sessionIds: unique(group.sessionIds, 200) }));
}

export function mergeConversationIRBundles({ bundles = [], projectAssignments = [] } = {}) {
  const migrations = [];
  const migratedBundles = bundles.map((bundle) => {
    const result = migrateIRBundle(bundle);
    migrations.push(...result.changes);
    return result.value;
  });
  const traces = migratedBundles.map((bundle) => bundle.trace).filter(Boolean);
  const mergedEvents = mergeEvents(traces);
  const variants = new Map();
  for (const bundle of migratedBundles) {
    for (const capability of bundle.capabilities || []) {
      const key = capabilityKey(capability);
      if (!variants.has(key)) variants.set(key, []);
      variants.get(key).push(capability);
    }
  }
  const conflicts = [];
  const capabilities = [];
  for (const [key, items] of variants) {
    const result = mergeCapabilityVariants(key, items);
    capabilities.push(result.capability);
    if (result.conflict) conflicts.push(result.conflict);
  }
  const sessionIds = unique(traces.map((trace) => trace.sessionId), 240);
  const mergedTrace = {
    schemaVersion: 'trace-ir/v1',
    sessionId: null,
    harness: 'multi-session',
    provenance: {
      sourcePath: null,
      sourceSha256: null,
      sourceSessionIds: sessionIds,
      sourceTraceFingerprints: unique(traces.map((trace) => trace.fingerprint), 240),
      eventCount: mergedEvents.events.length,
    },
    metadata: {
      multiSession: true,
      sessionCount: sessionIds.length,
      deduplicatedEventCount: traces.reduce((sum, trace) => sum + Number(trace.eventCount || 0), 0) - mergedEvents.events.length,
    },
    eventCount: mergedEvents.events.length,
    unknownKinds: unique(traces.flatMap((trace) => trace.unknownKinds || []), 120),
    events: mergedEvents.events,
  };
  mergedTrace.fingerprint = sha256({ ...mergedTrace, fingerprint: undefined });
  return {
    schemaVersion: 'conversation-ir-bundle/v1',
    trace: mergedTrace,
    capabilities,
    projects: groupProjects(projectAssignments, traces),
    conflicts,
    migrations,
    summary: {
      trace: { schemaVersion: mergedTrace.schemaVersion, sessionId: null, eventCount: mergedTrace.eventCount, fingerprint: mergedTrace.fingerprint },
      sessionCount: sessionIds.length,
      capabilityCount: capabilities.length,
      projectCount: groupProjects(projectAssignments, traces).length,
      conflictCount: conflicts.length,
      deduplicatedEventCount: mergedTrace.metadata.deduplicatedEventCount,
      capabilityFingerprints: capabilities.map((capability) => capability.fingerprint),
    },
  };
}
