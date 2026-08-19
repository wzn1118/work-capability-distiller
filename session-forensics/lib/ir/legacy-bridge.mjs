import { createCapabilityIR } from './capability-ir.mjs';
import { traceIRFromParsed, summarizeTraceIR } from './trace-ir.mjs';

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function evidenceId(value, index) {
  if (value && typeof value === 'object' && value.id) return value.id;
  const text = String(value ?? '').trim();
  return text ? `legacy-evidence-${index + 1}` : '';
}

function capabilityFromCandidate(candidate, analysis, trace, index) {
  const blueprint = analysis?.skillBlueprint ?? {};
  const sourceSession = analysis?.source?.sessionId ?? trace.sessionId ?? `session-${index + 1}`;
  const evidence = list(candidate?.evidence);
  const evidenceRefs = evidence.map(evidenceId).filter(Boolean).slice(0, 8);
  if (!evidenceRefs.length) evidenceRefs.push(`trace-${trace.fingerprint.slice(0, 16)}`);
  const observedTools = list(candidate?.observedTools ?? blueprint.observedTools);
  const workflow = list(candidate?.workflow ?? blueprint.workflow);
  const steps = (workflow.length ? workflow : ['收集证据', '执行工作流', '验证交付结果']).map((instruction, stepIndex) => ({
    id: `step-${String(stepIndex + 1).padStart(2, '0')}`,
    instruction,
    toolContract: { tools: observedTools.slice(0, 12) },
    evidenceRefs,
    confidence: { level: candidate?.confidence ?? '待确认', score: candidate?.score ?? 0 },
    onFailure: '记录失败输出，保留修改前状态，并先处理验证失败原因。',
  }));
  const capability = createCapabilityIR({
    id: candidate?.name ?? blueprint.candidateId ?? `session-capability-${index + 1}`,
    title: candidate?.name ?? blueprint.candidateName ?? `会话专属能力 ${index + 1}`,
    summary: candidate?.trigger ?? blueprint.description ?? '根据现有会话证据提炼出的可复用工作流。',
    triggers: [candidate?.trigger, ...list(blueprint.activationSignals).map((signal) => signal.requestExcerpt)].filter(Boolean),
    preconditions: list(blueprint.requiredInputs),
    inputSchema: { type: 'object', properties: Object.fromEntries(list(blueprint.requiredInputs).map((input, inputIndex) => [`input${inputIndex + 1}`, { type: 'string', description: input }])) },
    steps,
    outputSchema: { type: 'object', description: analysis?.skillBlueprint?.description ?? '可复核的工作流结果、文件变更和验证记录。' },
    acceptance: list(blueprint.guardrails).concat(['输出必须保留来源会话、文件和验证证据。']),
    recovery: ['失败后从最近检查点继续。', '验证通过前不标记为已交付。'],
    security: {
      filesystem: list(analysis?.codeArtifacts?.fileChanges).map((change) => change.path).slice(0, 60),
      commands: list(analysis?.codeArtifacts?.commands).map((command) => command.command ?? command).slice(0, 30),
      network: observedTools.filter((tool) => /web|fetch|browser|network/i.test(tool)),
    },
    provenance: {
      sourceSessions: [sourceSession],
      evidenceGraphHash: trace.fingerprint,
      evidenceRefs,
    },
    evaluation: { static: 'pending', contract: 'pending', replay: 'pending', heldout: 'pending', canary: 'pending' },
  });
  return capability;
}

export function buildIRBundle({ parsed, analysis, capabilities = null } = {}) {
  const trace = traceIRFromParsed(parsed);
  const candidates = capabilities ?? analysis?.reusableCapabilities ?? [];
  const capabilityIR = candidates.map((candidate, index) => capabilityFromCandidate(candidate, analysis, trace, index));
  return {
    schemaVersion: 'conversation-ir-bundle/v1',
    trace,
    capabilities: capabilityIR,
    summary: {
      trace: summarizeTraceIR(trace),
      capabilityCount: capabilityIR.length,
      capabilityFingerprints: capabilityIR.map((capability) => capability.fingerprint),
    },
  };
}
