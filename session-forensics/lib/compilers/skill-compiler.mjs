import { targetManifest } from './shared-runtime.mjs';

export function compileSkillTarget(capability) {
  const manifest = targetManifest(capability, 'skill', ['skill/SKILL.md']);
  return {
    ...manifest,
    entry: {
      name: capability.id,
      description: capability.summary,
      triggers: capability.triggers,
      instructions: capability.steps.map((step) => step.instruction),
      acceptance: capability.acceptance,
    },
  };
}

export function renderSkillMarkdown(capability) {
  const compiled = compileSkillTarget(capability);
  return [
    `---`,
    `name: ${compiled.entry.name}`,
    `description: ${compiled.entry.description}`,
    `---`,
    '',
    `# ${capability.title}`,
    '',
    capability.summary,
    '',
    '## 触发条件',
    ...capability.triggers.map((item) => `- ${item}`),
    '',
    '## 执行步骤',
    ...capability.steps.map((step, index) => `${index + 1}. ${step.instruction}（证据：${step.evidenceRefs.join('、')}）`),
    '',
    '## 验收条件',
    ...capability.acceptance.map((item) => `- ${item}`),
    '',
  ].join('\n');
}
