import { validateCapabilityIR } from '../ir/capability-ir.mjs';

export const COMPILER_TARGETS = Object.freeze(['skill', 'mcp', 'agent-ui']);

export function assertCapabilityForCompilation(capability) {
  const result = validateCapabilityIR(capability);
  if (!result.valid) throw new Error(`Capability IR 未通过静态编译门禁：${result.errors.join('；')}`);
  return capability;
}

export function targetManifest(capability, target, files = []) {
  assertCapabilityForCompilation(capability);
  if (!COMPILER_TARGETS.includes(target)) throw new Error(`未知编译目标：${target}`);
  return {
    target,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    capabilityFingerprint: capability.fingerprint,
    files,
    source: { schemaVersion: capability.schemaVersion, provenance: capability.provenance },
    runtime: {
      schemaVersion: 'work-capability-runtime/v2',
      accepts: ['capability-ir/v1', 'work-capability-ir/v2'],
      sharedArtifacts: {
        workCapability: 'work-capability-ir.v2.json',
        coverageMatrix: 'coverage-matrix.json',
        evidenceLedger: 'work-evidence-ledger.ndjson',
        executionGraph: 'execution-graph.json',
        releaseDecision: 'release-decision.json',
        coverageGaps: 'coverage-gaps.json',
        semanticEvaluationPlan: 'semantic-evaluation-plan.json',
        deterministicReplay: 'deterministic-replay.json',
        originalTaskReplay: 'original-task-replay.json',
        heldOutEvaluation: 'held-out-evaluation.json',
        isolatedAgentValidation: 'isolated-agent-validation.json',
      },
    },
  };
}
