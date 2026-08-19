import { buildIRBundle } from '../ir/legacy-bridge.mjs';
import { migrateIRBundle } from '../ir/migrations.mjs';
import { mergeConversationIRBundles } from '../ir/multi-session-reducer.mjs';
import { applyCapabilityEvaluation } from '../evaluation/gates.mjs';
import { compileAgentUiTarget } from './agent-ui-compiler.mjs';
import { compileMcpTarget } from './mcp-compiler.mjs';
import { compileSkillTarget } from './skill-compiler.mjs';
export { compileWorkCapabilityTargets } from './work-capability-compiler.mjs';

const TARGET_COMPILERS = Object.freeze({
  skill: compileSkillTarget,
  mcp: compileMcpTarget,
  'agent-ui': compileAgentUiTarget,
});

export function compileConversationTargets({ parsed, analysis, bundle = null, targets = Object.keys(TARGET_COMPILERS) } = {}) {
  const sourceBundle = bundle ?? buildIRBundle({ parsed, analysis });
  const migrated = migrateIRBundle(sourceBundle);
  const capabilities = migrated.value.capabilities.map((capability) => applyCapabilityEvaluation(capability));
  const selectedTargets = [...new Set(targets)].filter((target) => TARGET_COMPILERS[target]);
  const compiled = capabilities.flatMap((capability) => selectedTargets.map((target) => TARGET_COMPILERS[target](capability)));
  return {
    schemaVersion: 'conversation-compiler-result/v1',
    ir: { ...migrated.value, capabilities },
    migrations: migrated.changes,
    targets: compiled,
    summary: {
      capabilityCount: capabilities.length,
      targetCount: compiled.length,
      targetKinds: selectedTargets,
      publishableCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'publishable').length,
      candidateCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'candidate').length,
      blockedCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'blocked').length,
      fingerprints: capabilities.map((capability) => capability.fingerprint),
    },
  };
}

export function compileConversationBundles({ bundles = [], projectAssignments = [], targets = Object.keys(TARGET_COMPILERS) } = {}) {
  const merged = mergeConversationIRBundles({ bundles, projectAssignments });
  const capabilities = merged.capabilities.map((capability) => applyCapabilityEvaluation(capability));
  const selectedTargets = [...new Set(targets)].filter((target) => TARGET_COMPILERS[target]);
  const compiled = capabilities.flatMap((capability) => selectedTargets.map((target) => TARGET_COMPILERS[target](capability)));
  return {
    schemaVersion: 'conversation-compiler-result/v1',
    ir: { ...merged, capabilities },
    migrations: merged.migrations,
    targets: compiled,
    summary: {
      ...merged.summary,
      targetCount: compiled.length,
      targetKinds: selectedTargets,
      publishableCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'publishable').length,
      candidateCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'candidate').length,
      blockedCount: capabilities.filter((capability) => capability.evaluationDetail?.publishability === 'blocked').length,
      fingerprints: capabilities.map((capability) => capability.fingerprint),
    },
  };
}
