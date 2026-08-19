import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoverageGaps, transitionCoverageGap } from './lib/quality/coverage-gap-state-machine.mjs';
import { buildSemanticEvaluationPlan, evaluateSemanticReadiness } from './lib/quality/semantic-evaluation-plan.mjs';
import { evaluateHeldOutCandidate, evaluateHeldOutSuite } from './lib/evaluation/held-out-evaluator.mjs';
import { validateAgentRuntimeInIsolation } from './lib/evaluation/isolated-agent-validator.mjs';
import { replayOriginalTask } from './lib/evaluation/original-task-replay.mjs';
import path from 'node:path';

test('覆盖缺口可以补充、对账、重算并解决，且拒绝跳过中间状态', () => {
  const register = buildCoverageGaps({
    entries: [{
      metricId: 'publish-time', name: '发布时间覆盖', numerator: 17, denominator: 107,
      coveragePercent: 15.8879, eligibility: 'blocked', reason: '覆盖率低于最低可用阈值。',
      affectedCapabilities: ['time-analysis'], evidenceRefs: ['ev-1'],
    }],
  }, [{ id: 'time-analysis' }]);
  assert.equal(register.summary.blocking, 1);
  const detected = register.gaps[0];
  assert.match(detected.gapId, /^gap-[a-f0-9]{24}$/);
  assert.throws(() => transitionCoverageGap(detected, 'resolve'), /不能执行/);
  const queued = transitionCoverageGap(detected, 'queue');
  const collecting = transitionCoverageGap(queued, 'collect');
  const reconciling = transitionCoverageGap(collecting, 'reconcile');
  const recomputing = transitionCoverageGap(reconciling, 'recompute');
  const resolved = transitionCoverageGap(recomputing, 'resolve', { note: '补充后覆盖满足要求。' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.history.length, 5);
  assert.deepEqual(resolved.availableActions, []);
});

test('覆盖缺口支持按当前数据锁定口径或暂不纳入能力包', () => {
  const [detected] = buildCoverageGaps({ entries: [{ metricId: 'image-only', name: '图片语义', numerator: 0, denominator: 546, eligibility: 'blocked' }] }).gaps;
  const locked = transitionCoverageGap(detected, 'lock');
  assert.equal(locked.status, 'locked');
  assert.ok(locked.availableActions.some((item) => item.action === 'queue'));
  const excluded = transitionCoverageGap(locked, 'exclude');
  assert.equal(excluded.status, 'excluded');
});

test('语义评估计划在证据不全时保持待评估，达标后才通过', () => {
  const plan = buildSemanticEvaluationPlan({
    fingerprint: 'f'.repeat(64),
    domainProfile: { semanticEvaluationRequired: true },
    semanticEvaluation: { ruleVersion: 'rules-v2', modelVersion: 'model-v1' },
  });
  assert.equal(plan.required, true);
  assert.equal(plan.strata.length, 9);
  assert.match(plan.reproducibility.cacheKey, /^[a-f0-9]{64}$/);
  assert.equal(evaluateSemanticReadiness(plan, { precision: 0.9 }).status, 'pending');
  const passing = evaluateSemanticReadiness(plan, {
    precision: 0.9, recall: 0.86, f1: 0.88, confusionMatrix: {}, correctionLog: [], sampleManifest: {}, evidenceRefs: ['ev-2'],
  });
  assert.equal(passing.status, 'pass');
});

test('原任务事件回放要求成功工具、文件变化、验证和可解析步骤证据同时存在', () => {
  const evidenceId = `ev-${'a'.repeat(64)}`;
  const replay = replayOriginalTask({
    extraction: {
      sources: [{ sessionId: 'session-1' }],
      stages: [{
        index: 1, title: 'P1｜生成并验证报告', request: '生成报告', assistantMessages: ['完成'], fileChanges: [{ path: 'report.html' }],
        toolCalls: [{ name: 'exec', nestedTools: ['exec_command'], result: { success: true } }],
      }],
    },
    workCapability: {
      fingerprint: 'f'.repeat(64),
      evidenceGraph: { entries: [{ evidenceId }] },
      executionGraph: { steps: [{ id: 'step-1', evidenceRefs: [evidenceId] }] },
    },
  });
  assert.equal(replay.status, 'pass');
  assert.equal(replay.totals.fileChanges, 1);
  assert.equal(replay.totals.verifications, 1);
});

test('留出任务拒绝复用蒸馏来源哈希，只接受独立来源、真实产物和验证结果', () => {
  const workCapability = {
    provenance: { sourceSessions: [{ sha256: 'a'.repeat(64) }] },
    sourceContracts: [],
    capabilities: [{ id: 'report-workflow' }],
  };
  const overlap = evaluateHeldOutCandidate(workCapability, {
    sourceHash: 'a'.repeat(64), matchedCapabilities: ['report-workflow'], outputs: ['report.html'], verification: { passed: true },
  });
  assert.equal(overlap.status, 'fail');
  assert.equal(overlap.sourceIndependent, false);
  const independent = evaluateHeldOutCandidate(workCapability, {
    sourceHash: 'b'.repeat(64), matchedCapabilities: ['report-workflow'], outputs: ['report.html'], verification: { passed: true },
  });
  assert.equal(independent.status, 'pass');
  assert.equal(independent.sourceIndependent, true);
});

test('留出任务套件必须覆盖全部核心能力后才允许 G7 通过', () => {
  const workCapability = {
    provenance: { sourceSessions: [{ sha256: 'a'.repeat(64) }] },
    sourceContracts: [],
    capabilities: [{ id: 'cap-a', priority: 'P0', title: '能力 A' }, { id: 'cap-b', priority: 'P1', title: '能力 B' }],
  };
  const first = evaluateHeldOutSuite(workCapability, [{ sourceHash: 'b'.repeat(64), matchedCapabilities: ['cap-a'], outputs: ['a.txt'], verification: { passed: true } }]);
  assert.equal(first.status, 'pending');
  assert.deepEqual(first.missingCapabilityIds, ['cap-b']);
  const complete = evaluateHeldOutSuite(workCapability, [
    { sourceHash: 'b'.repeat(64), matchedCapabilities: ['cap-a'], outputs: ['a.txt'], verification: { passed: true } },
    { sourceHash: 'c'.repeat(64), matchedCapabilities: ['cap-b'], outputs: ['b.txt'], verification: { passed: true } },
  ]);
  assert.equal(complete.status, 'pass');
  assert.deepEqual(complete.validatedCapabilityIds.sort(), ['cap-a', 'cap-b']);
  assert.equal(complete.coverage.validated, 2);
});

test('独立 Agent 在临时隔离工作区完成读写、命令、验证和恢复', async () => {
  const result = await validateAgentRuntimeInIsolation(path.resolve('session-forensics/templates/root-capability/agent/runtime'), { force: true });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.failedChecks, []);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.trace.checkpointCount, 1);
});
