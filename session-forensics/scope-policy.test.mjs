import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeContextMode,
  normalizeProjectScope,
  normalizeScopePolicy,
  isConversationOnly,
} from './lib/scope-policy.mjs';

test('未明确选择项目时默认只分析会话', () => {
  const policy = normalizeScopePolicy({});
  assert.equal(policy.contextMode, 'conversation-only');
  assert.equal(policy.projectScope, 'sessions-only');
  assert.equal(policy.projectConfirmed, false);
  assert.equal(isConversationOnly(policy), true);
});

test('auto 不是项目授权，不能偷偷读取项目', () => {
  const policy = normalizeScopePolicy({ projectScope: 'auto', contextMode: 'auto' });
  assert.equal(policy.contextMode, 'conversation-only');
  assert.equal(policy.projectScope, 'sessions-only');
  assert.equal(policy.projectConfirmed, false);
});

test('用户选择项目文件夹后才启用相关项目文件筛选', () => {
  const policy = normalizeScopePolicy({
    projectPath: 'C:/work/demo',
    projectScope: 'project',
    contextMode: 'project-relevant',
  });
  assert.equal(policy.contextMode, 'project-relevant');
  assert.equal(policy.projectScope, 'project');
  assert.equal(policy.projectConfirmed, true);
  assert.equal(policy.projectContext.relevancePolicy, 'evidence-ranked');
});

test('工作区只有在存在明确工作区选择时才启用', () => {
  assert.equal(normalizeProjectScope({ projectScope: 'workspace', workspaceSelection: { workspaceIds: [] } }), 'sessions-only');
  assert.equal(normalizeContextMode('workspace-relevant', { projectConfirmed: true }), 'workspace-relevant');
  const policy = normalizeScopePolicy({
    projectScope: 'workspace',
    contextMode: 'workspace-relevant',
    workspaceSelection: { workspaceIds: ['workspace-a'] },
  });
  assert.equal(policy.projectConfirmed, true);
  assert.equal(policy.projectScope, 'workspace');
});
