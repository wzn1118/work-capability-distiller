import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityIR } from './lib/ir/capability-ir.mjs';
import { createTraceIR } from './lib/ir/trace-ir.mjs';
import { mergeConversationIRBundles } from './lib/ir/multi-session-reducer.mjs';
import { compileConversationBundles } from './lib/compilers/compiler-facade.mjs';
import { evaluateCapabilityGates } from './lib/evaluation/gates.mjs';
import { AdapterRegistry } from './lib/registry/adapter-registry.mjs';

function bundle(sessionId, title, eventText, version = '1.0.0') {
  const trace = createTraceIR({
    sessionId,
    sourcePath: `C:/sessions/${sessionId}.jsonl`,
    sourceSha256: `${sessionId}-sha`,
    events: [
      { sequence: 1, kind: 'message', actor: 'user', timestamp: '2026-08-18T00:00:00.000Z', text: eventText },
      { sequence: 2, kind: 'tool_call', callId: `${sessionId}-call`, name: 'functions.exec_command', argumentsExcerpt: '{"cmd":"node verify.mjs"}' },
      { sequence: 3, kind: 'tool_output', callId: `${sessionId}-call`, success: true, excerpt: 'exit code: 0' },
    ],
  });
  const capability = createCapabilityIR({
    id: 'report-workflow',
    version,
    title,
    summary: `${title}的可复用执行流程`,
    triggers: ['用户要求生成报告'],
    preconditions: ['已选择工作区'],
    steps: [{ id: 'step-01', instruction: '读取输入并生成报告', toolContract: { tools: ['functions.exec_command'] }, evidenceRefs: [`${sessionId}:e00000001`] }],
    outputSchema: { type: 'object', properties: { report: { type: 'string' } } },
    acceptance: ['执行验证命令并保留结果'],
    recovery: ['从检查点继续执行'],
    provenance: { sourceSessions: [sessionId], evidenceRefs: [`${sessionId}:e00000001`] },
  });
  return { schemaVersion: 'conversation-ir-bundle/v1', trace, capabilities: [capability], summary: { trace: { fingerprint: trace.fingerprint }, capabilityCount: 1, capabilityFingerprints: [capability.fingerprint] } };
}

test('multi-session reducer deduplicates events, preserves conflicts, and groups projects', () => {
  const first = bundle('session-a', '报告流程 A', '读取数据并生成报告');
  const second = bundle('session-b', '报告流程 B', '读取数据并生成报告', '2.0.0');
  // Same raw event copied into a second archive should count once after merge.
  second.trace.events[0] = { ...first.trace.events[0], sessionId: 'session-b', provenance: { ...first.trace.events[0].provenance, sourceSessionId: 'session-b' } };
  const merged = mergeConversationIRBundles({
    bundles: [first, second],
    projectAssignments: [
      { sessionId: 'session-a', projectId: 'project-a', projectName: '项目 A', projectRoot: 'C:/workspace/a', confidence: 'high' },
      { sessionId: 'session-b', projectId: 'project-b', projectName: '项目 B', projectRoot: 'C:/workspace/b', confidence: 'medium' },
    ],
  });
  assert.equal(merged.summary.sessionCount, 2);
  assert.equal(merged.summary.deduplicatedEventCount, 1);
  assert.equal(merged.summary.conflictCount, 1);
  assert.equal(merged.projects.length, 2);
  assert.deepEqual(merged.projects.map((project) => project.projectName).sort(), ['项目 A', '项目 B']);
  assert.deepEqual(merged.conflicts[0].variants.map((item) => item.version), ['1.0.0', '2.0.0']);
  assert.equal(merged.capabilities[0].provenance.sourceSessions.length, 2);
});

test('compiler facade exposes candidate publication state for every target', () => {
  const compiled = compileConversationBundles({ bundles: [bundle('session-c', '报告流程', '生成报告')] });
  assert.equal(compiled.summary.sessionCount, 1);
  assert.equal(compiled.summary.targetCount, 3);
  assert.equal(compiled.summary.candidateCount, 1);
  assert.equal(compiled.ir.capabilities[0].evaluationDetail.publishability, 'candidate');
  assert.deepEqual(compiled.summary.targetKinds, ['skill', 'mcp', 'agent-ui']);
});

test('G0-G5 gates become publishable only after replay, held-out, and canary evidence', () => {
  const capability = bundle('session-d', '可验证报告流程', '生成并验证报告').capabilities[0];
  const candidate = evaluateCapabilityGates(capability);
  assert.equal(candidate.publishability, 'candidate');
  const publishable = evaluateCapabilityGates(capability, { results: {
    G3: { status: 'pass', evidence: ['replay-1'] },
    G4: { status: 'pass', evidence: ['heldout-1'] },
    G5: { status: 'pass', evidence: ['canary-1'] },
  } });
  assert.equal(publishable.publishability, 'publishable');
  assert.equal(publishable.defaultExecutionAllowed, true);
});

test('adapter registry resolves versioned harness adapters deterministically', () => {
  const registry = new AdapterRegistry();
  registry.register({ name: 'codex-jsonl', version: '1.0.0', harness: 'codex', capabilities: ['trace'], adapter: { parse() {} } });
  registry.register({ name: 'codex-jsonl', version: '1.1.0', harness: 'codex', capabilities: ['trace', 'project'], adapter: { parse() {} } });
  assert.equal(registry.resolve('codex-jsonl').version, '1.1.0');
  assert.equal(registry.list({ capability: 'project' }).length, 1);
  assert.equal(registry.resolve('codex-jsonl', '1.0.0').harness, 'codex');
});
