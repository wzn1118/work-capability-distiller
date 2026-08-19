import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityIR, validateCapabilityIR } from './lib/ir/capability-ir.mjs';
import { buildIRBundle } from './lib/ir/legacy-bridge.mjs';
import { createTraceIR, summarizeTraceIR, validateTraceIR } from './lib/ir/trace-ir.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-7333-8444-cccccccccccc';

test('Trace IR keeps provenance, pairing links, unknown ledger, and deterministic fingerprint', () => {
  const input = [
    { sequence: 1, kind: 'message', actor: 'user', timestamp: '2026-08-18T00:00:00Z', text: '读取项目并验证。' },
    { sequence: 2, kind: 'tool_call', callId: 'call-1', name: 'functions.exec_command', argumentsExcerpt: '{"cmd":"node --test"}' },
    { sequence: 3, kind: 'tool_output', callId: 'call-1', success: true, excerpt: 'exit code: 0' },
    { sequence: 4, kind: 'future_event', payload: { value: 'kept in unknown ledger' } },
  ];
  const first = createTraceIR({ events: input, sessionId: SESSION_ID, sourcePath: 'C:/sessions/example.jsonl', sourceSha256: 'source-hash' });
  const second = createTraceIR({ events: input, sessionId: SESSION_ID, sourcePath: 'C:/sessions/example.jsonl', sourceSha256: 'source-hash' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.events[2].kind, 'tool_result');
  assert.equal(first.events[2].links.resultFor, 'call-1');
  assert.deepEqual(first.unknownKinds, ['future_event']);
  assert.match(first.events[0].provenance.rawHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateTraceIR(first), { valid: true, errors: [] });
  assert.equal(summarizeTraceIR(first).kindCounts.tool_result, 1);
});

test('Capability IR requires evidence-backed steps and remains deterministic', () => {
  const input = {
    id: 'comment-insight',
    title: '评论洞察报告生成',
    summary: '从评论数据生成可复核的洞察报告。',
    triggers: ['用户提供评论数据并要求洞察报告'],
    preconditions: ['已选择工作区'],
    steps: [{ instruction: '读取数据并生成报告', evidenceRefs: ['stage-1'] }],
    provenance: { sourceSessions: [SESSION_ID], evidenceRefs: ['stage-1'] },
  };
  const first = createCapabilityIR(input);
  const second = createCapabilityIR(input);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(validateCapabilityIR(first), { valid: true, errors: [] });
  assert.equal(validateCapabilityIR({ ...first, steps: [{ ...first.steps[0], evidenceRefs: [] }] }).valid, false);
});

test('legacy analysis is dual-written into a trace and capability bundle', () => {
  const bundle = buildIRBundle({
    parsed: { sessionId: SESSION_ID, sourcePath: 'C:/sessions/example.jsonl', sourceSha256: 'source-hash', sourceFormat: '.jsonl', recordCount: 2, invalidRecordCount: 0, eventTypeCounts: {}, timeline: [{ sequence: 1, kind: 'message', actor: 'user', text: '生成报告。' }] },
    analysis: {
      source: { sessionId: SESSION_ID },
      skillBlueprint: { candidateId: 'report', candidateName: '报告生成', description: '生成报告', workflow: ['读取输入', '生成报告'], requiredInputs: ['数据文件'], guardrails: ['保留证据'] },
      reusableCapabilities: [{ name: '报告生成', trigger: '用户要求报告', workflow: ['读取输入', '生成报告'], evidence: ['请求阶段 1'], score: 80, confidence: 'strong' }],
      codeArtifacts: { fileChanges: [{ path: 'report.md' }], commands: [{ command: 'node build.mjs' }] },
    },
  });
  assert.equal(bundle.schemaVersion, 'conversation-ir-bundle/v1');
  assert.equal(bundle.summary.capabilityCount, 1);
  assert.equal(validateTraceIR(bundle.trace).valid, true);
  assert.equal(validateCapabilityIR(bundle.capabilities[0]).valid, true);
  assert.equal(bundle.capabilities[0].provenance.evidenceGraphHash, bundle.trace.fingerprint);
});
