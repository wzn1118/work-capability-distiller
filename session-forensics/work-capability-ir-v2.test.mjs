import assert from 'node:assert/strict';
import test from 'node:test';
import { compileWorkCapabilityTargets } from './lib/compilers/work-capability-compiler.mjs';
import { contentAddressedEvidenceId, createEvidenceRecord } from './lib/evidence/content-addressed-evidence.mjs';
import { evaluateWorkCapabilityGates } from './lib/evaluation/work-gates.mjs';
import { createWorkCapabilityIR, validateWorkCapabilityIR } from './lib/ir/work-capability-ir.mjs';
import { buildCoverageMatrix } from './lib/quality/metric-eligibility-engine.mjs';
import { resolveSourceIdentity } from './lib/source-adapters/source-identity-resolver.mjs';

function fixture({ requested = '目标账号', observed = '目标账号', numerator = 100, denominator = 100 } = {}) {
  const evidence = createEvidenceRecord({
    sourceHash: 'a'.repeat(64),
    recordKey: 'conversation:stage:1',
    claimType: 'verified-workflow',
    sourceType: 'conversation',
    sourceRef: 'session-001',
    excerpt: '读取输入，生成报告，验证结果。',
  });
  return createWorkCapabilityIR({
    runId: 'work-run-001',
    userGoal: '把真实工作运行编译成可执行能力包。',
    requestedSubject: { name: requested },
    observedSubject: { name: observed, evidenceRefs: [evidence.evidenceId] },
    sourceContracts: [{
      id: 'conversation-001', type: 'conversation', role: '来源会话', ref: 'session-001',
      sha256: 'a'.repeat(64), required: true, status: 'satisfied',
    }],
    evidence: [evidence],
    coverageMetrics: [{ metricId: 'field-coverage', name: '字段覆盖率', numerator, denominator, scope: '目标数据集' }],
    capabilities: [{ id: 'report-workflow', priority: 'P1', title: '可审计报告生成', summary: '读取数据并生成可验证报告。', evidenceRefs: [evidence.evidenceId] }],
    executionGraph: {
      steps: [{ id: 'step-001', title: '生成报告', instruction: '读取数据、生成报告并验证。', evidenceRefs: [evidence.evidenceId] }],
      acceptance: ['报告存在且指标可复算。'],
    },
    portability: { packageRelativePathsOnly: true },
    domainProfile: { slug: 'auditable-report', title: '可审计报告能力包' },
  });
}

test('内容寻址证据编号不受对象字段顺序影响', () => {
  const first = contentAddressedEvidenceId({ sourceHash: 'abc', recordKey: 'row-1', transformVersion: 'v2', claimType: 'metric' });
  const second = contentAddressedEvidenceId({ claimType: 'metric', transformVersion: 'v2', recordKey: 'row-1', sourceHash: 'abc' });
  assert.equal(first, second);
  assert.match(first, /^ev-[a-f0-9]{64}$/);
});

test('身份错配在 G1 硬阻断，低覆盖指标同时阻断发布', () => {
  const identity = resolveSourceIdentity({ requested: { name: '非目标账号' }, observed: { name: '实际账号' } });
  assert.equal(identity.match, false);
  assert.equal(identity.decision, 'BLOCKED_IDENTITY_MISMATCH');
  const workCapability = fixture({ requested: '非目标账号', observed: '实际账号', numerator: 7, denominator: 107 });
  const evaluation = evaluateWorkCapabilityGates(workCapability);
  assert.equal(evaluation.gates.G1.status, 'fail');
  assert.equal(workCapability.coverageMatrix.entries[0].eligibility, 'blocked');
  assert.equal(evaluation.releaseDecision.status, 'blocked');
});

test('完整 Work Capability IR v2 可统一编译为 Skill、MCP 和独立 Agent UI', () => {
  const workCapability = fixture();
  assert.deepEqual(validateWorkCapabilityIR(workCapability), { valid: true, errors: [] });
  const passing = Object.fromEntries(['G4', 'G6', 'G7', 'G9'].map((gate) => [gate, { status: 'pass', reason: '回归验收通过。' }]));
  const compiled = compileWorkCapabilityTargets({ workCapability, evaluationContext: { results: passing } });
  assert.equal(compiled.summary.targetCount, 3);
  assert.equal(compiled.summary.releaseStatus, 'publishable');
  assert.deepEqual(compiled.targets.map((item) => item.target), ['skill', 'mcp', 'agent-ui']);
  assert.ok(compiled.targets.every((item) => item.runtime.schemaVersion === 'work-capability-runtime/v2'));
  assert.ok(compiled.targets.find((item) => item.target === 'agent-ui').viewModel.pages.some((page) => page.id === 'evidence'));
});

test('覆盖矩阵把可发布、受限和阻断分开计算', () => {
  const matrix = buildCoverageMatrix([
    { metricId: 'all-comments', numerator: 987, denominator: 1000 },
    { metricId: 'publish-time', numerator: 60, denominator: 100 },
    { metricId: 'video-metrics', numerator: 7, denominator: 107 },
  ]);
  assert.deepEqual(matrix.entries.map((item) => item.eligibility), ['eligible', 'restricted', 'blocked']);
  assert.equal(matrix.summary.releaseImpact, 'blocked');
});
