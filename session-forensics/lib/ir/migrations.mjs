import { createCapabilityIR } from './capability-ir.mjs';
import { createTraceIR } from './trace-ir.mjs';
import { createWorkCapabilityIR } from './work-capability-ir.mjs';
import { createEvidenceRecord } from '../evidence/content-addressed-evidence.mjs';

export const CURRENT_IR_VERSIONS = Object.freeze({ trace: 'trace-ir/v1', capability: 'capability-ir/v1', workCapability: 'work-capability-ir/v2', bundle: 'conversation-ir-bundle/v1' });

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function migrateTraceIR(input, { sourcePath = null, sourceSha256 = null, sessionId = null } = {}) {
  if (input?.schemaVersion === CURRENT_IR_VERSIONS.trace) return { value: clone(input), changes: [] };
  if (input && Array.isArray(input.events)) {
    const value = createTraceIR({
      events: input.events,
      sessionId: input.sessionId ?? sessionId,
      sourcePath: input.provenance?.sourcePath ?? sourcePath,
      sourceSha256: input.provenance?.sourceSha256 ?? sourceSha256,
      harness: input.harness ?? 'codex',
      metadata: input.metadata ?? { migratedFrom: input.schemaVersion ?? 'legacy-trace' },
    });
    return { value, changes: ['legacy-trace -> trace-ir/v1'] };
  }
  throw new Error('无法迁移缺少 events 的 Trace IR。');
}

export function migrateCapabilityIR(input, { sourceSession = null, evidenceGraphHash = null } = {}) {
  if (input?.schemaVersion === CURRENT_IR_VERSIONS.capability) return { value: clone(input), changes: [] };
  if (input && typeof input === 'object') {
    const value = createCapabilityIR({
      ...input,
      provenance: {
        ...input.provenance,
        sourceSessions: input.provenance?.sourceSessions?.length ? input.provenance.sourceSessions : [sourceSession].filter(Boolean),
        evidenceGraphHash: input.provenance?.evidenceGraphHash ?? evidenceGraphHash,
      },
    });
    return { value, changes: ['legacy-capability -> capability-ir/v1'] };
  }
  throw new Error('无法迁移空的 Capability IR。');
}

export function migrateWorkCapabilityIR(input, { runId = null, scope = 'single-conversation' } = {}) {
  if (input?.schemaVersion === CURRENT_IR_VERSIONS.workCapability) return { value: clone(input), changes: [] };
  const capabilityMigration = migrateCapabilityIR(input);
  const capability = capabilityMigration.value;
  const sourceHash = capability.provenance?.evidenceGraphHash || capability.fingerprint;
  const evidenceByLegacyRef = new Map();
  for (const legacyRef of [...new Set((capability.steps || []).flatMap((step) => step.evidenceRefs || []))]) {
    evidenceByLegacyRef.set(legacyRef, createEvidenceRecord({
      sourceHash,
      recordKey: legacyRef,
      claimType: 'legacy-capability-step',
      sourceType: 'capability-ir/v1',
      sourceRef: legacyRef,
      metadata: { migratedFrom: legacyRef },
    }));
  }
  const evidence = [...evidenceByLegacyRef.values()];
  const sourceContracts = (capability.provenance?.sourceSessions || []).map((sessionId, index) => ({
    id: `session-${String(index + 1).padStart(3, '0')}`,
    type: 'conversation',
    role: '来源会话',
    ref: sessionId,
    sha256: sourceHash,
    required: true,
    status: 'satisfied',
  }));
  const value = createWorkCapabilityIR({
    runId: runId || `migrated-${capability.id}`,
    scope,
    userGoal: capability.summary || capability.title,
    observedSubject: { name: capability.title },
    sourceContracts,
    evidence,
    capabilities: [{
      id: capability.id,
      priority: 'P1',
      title: capability.title,
      summary: capability.summary,
      status: 'candidate',
      evidenceRefs: evidence.map((item) => item.evidenceId),
      inputs: capability.inputSchema,
      outputs: capability.outputSchema,
      limitations: capability.recovery,
    }],
    executionGraph: {
      steps: capability.steps.map((step) => ({
        id: step.id,
        title: step.instruction,
        instruction: step.instruction,
        evidenceRefs: (step.evidenceRefs || []).map((legacyRef) => evidenceByLegacyRef.get(legacyRef)?.evidenceId).filter(Boolean),
        rollback: step.onFailure,
      })),
      acceptance: capability.acceptance,
    },
    portability: { packageRelativePathsOnly: true },
    domainProfile: { title: capability.title, summary: capability.summary, slug: capability.id },
    provenance: { migratedFrom: capability.schemaVersion, capabilityFingerprint: capability.fingerprint },
  });
  return { value, changes: [...capabilityMigration.changes, `${capability.schemaVersion} -> work-capability-ir/v2`] };
}

export function migrateIRBundle(input, options = {}) {
  if (input?.schemaVersion === CURRENT_IR_VERSIONS.bundle) return { value: clone(input), changes: [] };
  const traceMigration = migrateTraceIR(input?.trace ?? input, options);
  const capabilities = Array.isArray(input?.capabilities) ? input.capabilities : [];
  const capabilityMigrations = capabilities.map((capability) => migrateCapabilityIR(capability, {
    sourceSession: traceMigration.value.sessionId,
    evidenceGraphHash: traceMigration.value.fingerprint,
  }));
  return {
    value: {
      schemaVersion: CURRENT_IR_VERSIONS.bundle,
      trace: traceMigration.value,
      capabilities: capabilityMigrations.map((item) => item.value),
      summary: {
        trace: {
          schemaVersion: traceMigration.value.schemaVersion,
          sessionId: traceMigration.value.sessionId,
          eventCount: traceMigration.value.eventCount,
          fingerprint: traceMigration.value.fingerprint,
        },
        capabilityCount: capabilityMigrations.length,
        capabilityFingerprints: capabilityMigrations.map((item) => item.value.fingerprint),
      },
    },
    changes: [...traceMigration.changes, ...capabilityMigrations.flatMap((item) => item.changes)],
  };
}
