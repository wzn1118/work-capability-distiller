import { sha256, stableStringify } from '../ir/trace-ir.mjs';

export const ORIGINAL_TASK_REPLAY_SCHEMA_VERSION = 'original-task-replay/v2';

function array(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function toolSucceeded(tool) {
  return tool?.result?.success === true;
}

export function replayOriginalTask({ extraction = {}, workCapability = {} } = {}) {
  const stages = array(extraction.stages);
  const replayedStages = stages.map((stage) => {
    const tools = array(stage.toolCalls);
    const successfulTools = tools.filter(toolSucceeded);
    const verificationTools = successfulTools.filter((tool) => {
      const names = [tool.name, ...array(tool.nestedTools)].filter(Boolean).join(' ');
      return /verify|test|check|view_image|playwright|exec_command|shell_command|run_verification/i.test(names);
    });
    return {
      stageId: `P${stage.index}`,
      title: stage.title,
      requestPresent: Boolean(String(stage.request || '').trim()),
      toolCallCount: tools.length,
      successfulToolCallCount: successfulTools.length,
      failedToolCallCount: tools.filter((tool) => tool?.result && !toolSucceeded(tool)).length,
      fileChangeCount: array(stage.fileChanges).length,
      verificationCount: verificationTools.length,
      assistantMessageCount: array(stage.assistantMessages).length,
      passed: Boolean(String(stage.request || '').trim()) && successfulTools.length > 0,
    };
  });
  const totals = replayedStages.reduce((result, stage) => {
    result.toolCalls += stage.toolCallCount;
    result.successfulTools += stage.successfulToolCallCount;
    result.failedTools += stage.failedToolCallCount;
    result.fileChanges += stage.fileChangeCount;
    result.verifications += stage.verificationCount;
    return result;
  }, { stages: replayedStages.length, toolCalls: 0, successfulTools: 0, failedTools: 0, fileChanges: 0, verifications: 0 });
  const evidenceIds = new Set(array(workCapability?.evidenceGraph?.entries).map((entry) => entry.evidenceId));
  const stepEvidence = array(workCapability?.executionGraph?.steps).map((step) => ({
    stepId: step.id,
    evidenceRefs: array(step.evidenceRefs),
    resolvedEvidenceRefs: array(step.evidenceRefs).filter((id) => evidenceIds.has(id)),
  }));
  const checks = {
    stagesAvailable: totals.stages > 0,
    successfulExecutionAvailable: totals.successfulTools > 0,
    fileChangeEvidenceAvailable: totals.fileChanges > 0,
    verificationEvidenceAvailable: totals.verifications > 0,
    everyExecutionStepHasResolvedEvidence: stepEvidence.length > 0 && stepEvidence.every((step) => step.evidenceRefs.length > 0 && step.evidenceRefs.length === step.resolvedEvidenceRefs.length),
    finalStageCompleted: replayedStages.at(-1)?.passed === true,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const replay = {
    schemaVersion: ORIGINAL_TASK_REPLAY_SCHEMA_VERSION,
    mode: 'recorded-event-replay',
    sourceSessionIds: array(extraction.sources).map((source) => source.sessionId).filter(Boolean),
    workCapabilityFingerprint: workCapability.fingerprint || null,
    status: failedChecks.length ? 'fail' : 'pass',
    reason: failedChecks.length
      ? `原任务事件回放未满足：${failedChecks.join('、')}。`
      : '原会话阶段、成功工具结果、文件变更、验证记录和执行步骤证据已完成一致性回放。',
    checks,
    failedChecks,
    totals,
    stages: replayedStages,
    executionStepEvidence: stepEvidence,
  };
  return { ...replay, fingerprint: sha256(stableStringify(replay)) };
}
