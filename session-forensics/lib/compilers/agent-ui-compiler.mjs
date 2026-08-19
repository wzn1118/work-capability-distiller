import { targetManifest } from './shared-runtime.mjs';

export function compileAgentUiTarget(capability) {
  const manifest = targetManifest(capability, 'agent-ui', ['agent/agent-server.mjs', 'agent/ui/index.html', 'agent/ui/app.js', 'agent/ui/styles.css']);
  return {
    ...manifest,
    viewModel: {
      title: capability.title,
      summary: capability.summary,
      inputSchema: capability.inputSchema,
      steps: capability.steps.map((step) => ({ id: step.id, instruction: step.instruction, evidenceRefs: step.evidenceRefs })),
      acceptance: capability.acceptance,
      recovery: capability.recovery,
      pages: [
        { id: 'overview', title: '能力总览' },
        { id: 'inputs', title: '输入与身份' },
        { id: 'execute', title: '执行任务' },
        { id: 'evidence', title: '证据与差异' },
        { id: 'deliverables', title: '产物与恢复' },
      ],
    },
  };
}
