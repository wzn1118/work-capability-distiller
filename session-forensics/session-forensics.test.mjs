import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyseParsedSession,
  analyseSessionSource,
  discoverSessions,
  parseCodexSessionFile,
} from './lib/session-forensics.mjs';
import { packageConversationLegacy as packageConversation, verifyConversationPackageLegacy as verifyConversationPackage } from './lib/conversation-packager.mjs';

const SESSION_ID = '11111111-2222-7333-8444-555555555555';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-forensics-'));
  const sourceDir = path.join(root, 'sessions', '2026', '08', '15');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, `rollout-2026-08-15T10-00-00-${SESSION_ID}.jsonl`);
  const rows = [
    { timestamp: '2026-08-15T10:00:00.000Z', type: 'session_meta', payload: { session_id: SESSION_ID, cwd: 'C:/workspace' } },
    { timestamp: '2026-08-15T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: 'C:/workspace' } },
    { timestamp: '2026-08-15T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Analyze this session and turn it into a Skill with an MCP and UI.' }] } },
    { timestamp: '2026-08-15T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'rg --files && node --test session-forensics/*.test.mjs' }) } },
    { timestamp: '2026-08-15T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'exit code: 0\nall tests passed' } },
    { timestamp: '2026-08-15T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'functions.apply_patch', call_id: 'call-2', arguments: '*** Begin Patch\n*** Add File: mcp/session-server.mjs\n+export const ok = true;\n*** End Patch' } },
    { timestamp: '2026-08-15T10:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-2', output: 'Done.' } },
    { timestamp: '2026-08-15T10:00:07.000Z', type: 'fileChange', payload: { changes: [{ path: 'mcp/session-server.mjs', action: 'added' }] } },
    { timestamp: '2026-08-15T10:00:08.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The report and MCP are ready.' }] } },
    { timestamp: '2026-08-15T10:00:09.000Z', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: 'C:/workspace' } },
    { timestamp: '2026-08-15T10:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '现在能力还是太弱了，必须提取原对话中的用户纠正、工具证据和文件变更，再按改进工作流执行。' }] } },
    { timestamp: '2026-08-15T10:00:11.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已补充原对话提取、证据检索和改进流程。' }] } },
  ];
  await fs.writeFile(source, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { root, source };
}

test('normalises calls, outputs, patches, and trigger evidence', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parsed = await parseCodexSessionFile(source);
  const analysis = analyseParsedSession(parsed, { includeEvidence: true });
  assert.equal(parsed.sessionId, SESSION_ID);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].output.success, true);
  assert.equal(analysis.summary.toolCalls, 2);
  assert.ok(analysis.toolCatalog.some((tool) => tool.name === 'functions.apply_patch'));
  assert.ok(analysis.codeArtifacts.fileChanges.some((change) => change.path === 'mcp/session-server.mjs'));
  assert.ok(analysis.triggerLogic.some((rule) => rule.confidence === 'direct'));
  assert.ok(analysis.reusableCapabilities.some((candidate) => candidate.name === '可复用工作流封装'));
  assert.equal(analysis.presentation.language, 'zh-CN');
  assert.match(analysis.episodes[0].title, /^P1｜/);
  assert.match(analysis.episodes[0].requestContent, /Analyze this session/);
  assert.match(analysis.episodes[0].assistantContent, /The report and MCP are ready/);
});

test('discovers an arbitrary local session and writes verifiable artifacts', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = await discoverSessions({ roots: [path.join(root, 'sessions')] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, SESSION_ID);
  assert.equal(sessions[0].title, 'Analyze this session and turn it into a Skill with an MCP and UI.');
  assert.equal(sessions[0].titleSource, 'first-user-request');
  const out = path.join(root, 'out');
  const result = await analyseSessionSource({ threadId: SESSION_ID, roots: [path.join(root, 'sessions')], outputDir: out });
  assert.equal(result.analysis.source.sessionId, SESSION_ID);
  const report = await fs.readFile(result.artifacts.paths.markdown, 'utf8');
  assert.match(report, /# 会话全量取证报告/);
  assert.match(report, /## 外层编排工具目录/);
  assert.match(report, /## 请求标题、内容与执行过程/);
  assert.match(report, /\*\*用户请求内容\*\*/);
  assert.match(report, /\*\*助手回应内容\*\*/);
  assert.ok((await fs.stat(result.artifacts.paths.timeline)).size > 0);
  assert.ok((await fs.stat(result.artifacts.paths.traceIR)).size > 0);
  assert.ok((await fs.stat(result.artifacts.paths.capabilityIR)).size > 0);
  assert.ok((await fs.stat(result.artifacts.paths.compilerResult)).size > 0);
  const traceIR = JSON.parse(await fs.readFile(result.artifacts.paths.traceIR, 'utf8'));
  const capabilityIR = JSON.parse(await fs.readFile(result.artifacts.paths.capabilityIR, 'utf8'));
  assert.equal(traceIR.schemaVersion, 'trace-ir/v1');
  assert.equal(capabilityIR.schemaVersion, 'conversation-ir-bundle/v1');
  assert.equal(traceIR.fingerprint.length, 64);
  assert.ok(capabilityIR.summary.capabilityCount >= 1);
  const manifest = JSON.parse(await fs.readFile(result.artifacts.paths.manifest, 'utf8'));
  assert.equal(path.basename(manifest.artifacts.traceIR.path), 'trace-ir.json');
  assert.equal(path.basename(manifest.artifacts.capabilityIR.path), 'capability-ir.json');
  assert.equal(path.basename(manifest.artifacts.compilerResult.path), 'compiler-result.json');
});

test('uses the first business request as the selectable session title', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-title-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = '22222222-3333-7444-8555-666666666666';
  const source = path.join(root, `rollout-${sessionId}.jsonl`);
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n# Conversation Guardrails\nIgnore this as a title.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# My request:\nBuild a beginner-friendly conversation package generator.' }] } },
  ];
  await fs.writeFile(source, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const [session] = await discoverSessions({ roots: [root], limit: 10 });
  assert.equal(session.title, 'Build a beginner-friendly conversation package generator.');
  assert.equal(session.titleSource, 'first-user-request');
});

test('deduplicates archive copies by session id and keeps the more complete record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-duplicate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = '33333333-4444-7555-8666-777777777777';
  const primary = path.join(root, 'primary', `rollout-${sessionId}.jsonl`);
  const mirror = path.join(root, 'mirror', `rollout-${sessionId}.jsonl`);
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '生成带标题的完整会话列表。' }] } });
  await fs.mkdir(path.dirname(primary), { recursive: true });
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  await fs.writeFile(primary, `${row}\n`, 'utf8');
  await fs.writeFile(mirror, `${row}\n${JSON.stringify({ type: 'event_msg', payload: { text: 'more complete copy' } })}\n`, 'utf8');
  const sessions = await discoverSessions({ roots: [path.dirname(primary), path.dirname(mirror)], limit: 10 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId);
  assert.equal(sessions[0].path, mirror);
  assert.equal(sessions[0].title, '生成带标题的完整会话列表。');
});

test('packages the complete selected session as a Skill, MCP, and independent Agent', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await packageConversation({
    sourcePath: source,
    packageId: 'fixture-workflow',
    packageName: '测试会话能力包',
    outputRoot: path.join(root, 'conversation-packages'),
  });
  const { package: generated } = result;
  assert.equal(generated.selection.mode, 'whole-session');
  assert.equal(generated.selection.selectedRecordRange[0], 1);
  assert.equal(generated.selection.selectedRecordRange[1], 12);
  assert.equal(generated.selection.sourceSha256.length, 64);
  assert.ok(generated.selection.normalisedEventCount > 0);
  assert.ok(generated.delivery.skill);
  assert.ok(generated.delivery.mcp);
  assert.ok(generated.delivery.agent);
  assert.ok((await fs.stat(generated.delivery.guide)).isFile());
  assert.equal(generated.delivery.guide, path.join(generated.root, 'README.md'));
  const packageGuide = await fs.readFile(generated.delivery.guide, 'utf8');
  assert.match(packageGuide, /完整能力说明/);
  assert.match(packageGuide, /一句话说明/);
  assert.match(packageGuide, /包名称为什么这样命名/);
  assert.match(packageGuide, /会话中实际出现的工具/);
  assert.match(packageGuide, /它实际能做什么/);
  assert.match(packageGuide, /独立界面能直接完成/);
  assert.match(packageGuide, /三种交付形态分别负责什么/);
  assert.match(packageGuide, /页面上每个主要功能的作用/);
  assert.match(packageGuide, /明确的能力边界/);
  assert.match(packageGuide, /get_conversation_workflow/);
  assert.match(packageGuide, /如何提取并改进原对话/);
  assert.match(packageGuide, /search_original_conversation/);
  assert.match(packageGuide, /用户纠正/);
  assert.match(packageGuide, /node verify\.mjs/);
  assert.match(packageGuide, new RegExp(SESSION_ID));
  assert.equal(generated.delivery.agent ? true : false, true);
  assert.match(await fs.readFile(generated.delivery.skill.skillFile, 'utf8'), /name: fixture-workflow-workflow/);
  assert.match(await fs.readFile(generated.delivery.skill.interfaceFile, 'utf8'), /\$fixture-workflow-workflow/);
  assert.ok((await fs.stat(path.join(generated.delivery.skill.root, 'references', 'conversation-extraction.json'))).isFile());
  assert.ok((await fs.stat(generated.delivery.mcp.server)).isFile());
  assert.ok((await fs.stat(path.join(generated.root, 'conversation-extraction.json'))).isFile());
  assert.ok((await fs.stat(generated.delivery.agent.server)).isFile());
  assert.ok((await fs.stat(generated.delivery.agent.conversationExtraction)).isFile());
  assert.ok((await fs.stat(generated.delivery.agent.aiProfile)).isFile());
  assert.ok((await fs.stat(generated.delivery.agent.readme)).isFile());
  assert.ok((await fs.stat(generated.delivery.agent.envExample)).isFile());
  const profile = JSON.parse(await fs.readFile(generated.delivery.agent.aiProfile, 'utf8'));
  assert.equal(profile.schemaVersion, '4.0.0');
  assert.equal(profile.provider, 'openai-compatible');
  assert.equal(profile.secretsPersisted, false);
  assert.equal(profile.compatibilityAliases.status, '/api/ai/status');
  assert.equal(profile.compatibilityAliases.config, '/api/ai/config');
  assert.equal(profile.compatibilityAliases.chat, '/api/ai/chat');
  assert.equal(profile.features.beginnerGuidedSetup, true);
  assert.equal(profile.features.verifiedConnectionGate, true);
  assert.equal(profile.features.promptExamples, true);
  assert.equal(profile.features.errorRecovery, true);
  assert.equal(profile.features.resultCopyAndDownload, true);
  assert.equal(profile.features.localWorkspace, true);
  assert.equal(profile.features.workspaceBoundFileTools, true);
  assert.equal(profile.features.fileRead, true);
  assert.equal(profile.features.fileWriteWithExplicitPermission, true);
  assert.equal(profile.features.commandExecutionWithExplicitPermission, true);
  assert.equal(profile.features.autonomousToolLoop, true);
  assert.equal(profile.features.visibleToolTrace, true);
  assert.equal(profile.features.originalConversationExtraction, true);
  assert.equal(profile.features.originalConversationSearch, true);
  assert.equal(profile.features.improvedWorkflow, true);
  assert.equal(profile.endpoints.workspace, '/api/runtime/workspace');
  assert.equal(profile.endpoints.tools, '/api/runtime/tools');
  assert.equal(profile.endpoints.agent, '/api/runtime/agent');
  assert.equal(profile.endpoints.distillation, '/api/runtime/distillation');
  assert.equal(profile.endpoints.conversationSearch, '/api/runtime/conversation/search');
  assert.deepEqual(profile.features.modes, ['执行本地任务', '分析问题', '生成结果', '检查内容', '提取并改进原对话']);
  const agentReadme = await fs.readFile(generated.delivery.agent.readme, 'utf8');
  assert.match(agentReadme, /开始前需要准备什么/);
  assert.match(agentReadme, /第一次启动（Windows）/);
  assert.match(agentReadme, /第一次连接模型/);
  assert.match(agentReadme, /获取全部模型/);
  assert.match(agentReadme, /保存并检查连接/);
  assert.match(agentReadme, /常见问题/);
  assert.match(agentReadme, /隐私和密钥/);
  assert.match(agentReadme, /本地执行能力/);
  assert.match(agentReadme, /`read_file`/);
  assert.match(agentReadme, /`replace_text`/);
  assert.match(agentReadme, /`execute_command`/);
  assert.match(agentReadme, /工具调用循环/);
  assert.match(agentReadme, /三个原对话工具/);
  assert.match(agentReadme, /六个工作区工具/);
  assert.match(agentReadme, /提取并改进原对话/);
  assert.match(agentReadme, /node agent-server\.mjs/);
  const agentEnv = await fs.readFile(generated.delivery.agent.envExample, 'utf8');
  assert.match(agentEnv, /新手无需修改/);
  assert.match(agentEnv, /程序不会自动读取/);
  assert.match(agentEnv, /CONVERSATION_AGENT_OPENAI_API_KEY=\n/);
  assert.match(agentEnv, /CONVERSATION_AGENT_WORKSPACE_ROOT=/);
  assert.match(agentEnv, /CONVERSATION_AGENT_WORKSPACE_WRITE=0/);
  assert.match(agentEnv, /CONVERSATION_AGENT_COMMAND_EXECUTION=0/);
  const agentUi = await fs.readFile(generated.delivery.agent.ui.index, 'utf8');
  assert.match(agentUi, /<form id="config-form"/);
  assert.match(agentUi, /<form id="chat-form"/);
  assert.match(agentUi, /<form id="workspace-form"/);
  assert.match(agentUi, /id="workspace-write-enabled"/);
  assert.match(agentUi, /id="command-enabled"/);
  assert.match(agentUi, /本地执行能力/);
  assert.match(agentUi, /工具执行记录/);
  assert.match(agentUi, /执行本地任务/);
  assert.match(agentUi, /提取并改进原对话/);
  assert.match(agentUi, /原对话提炼/);
  assert.match(agentUi, /id="distillation-panel"/);
  assert.match(agentUi, /完整原对话提取/);
  assert.match(agentUi, /id="capability-title"/);
  assert.match(agentUi, /id="package-naming-summary"/);
  assert.match(agentUi, /id="package-naming-detail"/);
  assert.match(agentUi, /id="capability-panel"/);
  assert.match(agentUi, /它能直接完成什么/);
  assert.match(agentUi, /适合交给它的任务/);
  assert.match(agentUi, /需要你提供/);
  assert.match(agentUi, /你会获得/);
  assert.match(agentUi, /明确的能力边界/);
  assert.match(agentUi, /页面功能直白说明/);
  assert.match(agentUi, /data-tab="capability"/);
  assert.match(agentUi, /class="setup-progress"/);
  assert.match(agentUi, /data-connection-kind="cloud"/);
  assert.match(agentUi, /data-connection-kind="local"/);
  assert.match(agentUi, /保存并检查连接/);
  assert.match(agentUi, /id="prompt-examples"/);
  assert.match(agentUi, /id="retry-chat"/);
  assert.match(agentUi, /id="send-chat"/);
  assert.match(agentUi, /id="stop-chat"/);
  assert.match(agentUi, /接口模型全量列表/);
  assert.match(agentUi, /id="model-catalog"/);
  assert.match(agentUi, /id="model-filter"/);
  assert.match(agentUi, /真实模型 \+ 本地工具自动循环/);
  const agentUiScript = await fs.readFile(generated.delivery.agent.ui.app, 'utf8');
  assert.match(agentUiScript, /\/api\/runtime\/config/);
  assert.match(agentUiScript, /\/api\/runtime\/models/);
  assert.match(agentUiScript, /\/api\/runtime\/workspace/);
  assert.match(agentUiScript, /\/api\/runtime\/agent/);
  assert.match(agentUiScript, /tool_start/);
  assert.match(agentUiScript, /tool_result/);
  assert.match(agentUiScript, /getReader\(\)/);
  assert.match(agentUiScript, /function friendlyError/);
  assert.match(agentUiScript, /function saveAndCheckConnection/);
  assert.match(agentUiScript, /function renderModelCatalog/);
  assert.match(agentUiScript, /接口返回的全部/);
  assert.match(agentUiScript, /data-model-id/);
  assert.match(agentUiScript, /blueprint\.capabilityGuide/);
  assert.match(agentUiScript, /blueprint\.distillation/);
  assert.match(agentUiScript, /search_original_conversation/);
  assert.match(agentUiScript, /get_original_conversation_stage/);
  assert.match(agentUiScript, /get_improved_workflow/);
  assert.match(agentUiScript, /document\.title/);
  assert.match(agentUiScript, /blueprint\.package\.naming/);
  assert.match(agentUiScript, /data-use-task/);
  assert.match(agentUiScript, /#capability-panel/);
  assert.match(agentUiScript, /请先保存并检查模型连接/);
  assert.match(agentUiScript, /任务未完成，可检查配置后重试/);
  assert.match(agentUiScript, /navigator\.clipboard\.writeText/);
  assert.match(agentUiScript, /new Blob\(/);
  const extraction = JSON.parse(await fs.readFile(path.join(generated.root, 'conversation-extraction.json'), 'utf8'));
  assert.equal(extraction.schemaVersion, '1.0.0');
  assert.equal(extraction.stages.length, 2);
  assert.ok(extraction.corrections.some((item) => item.request.includes('能力还是太弱')));
  assert.ok(extraction.requirementEvolution.some((item) => item.type === 'correction'));
  assert.ok(extraction.improvedWorkflow.some((item) => item.requiredTools?.includes('search_original_conversation')));
  assert.ok(extraction.stages[0].toolCalls.some((item) => item.name === 'functions.exec_command'));
  assert.ok(extraction.artifactIndex.some((item) => item.startsWith('mcp/session-server.mjs')));
  const blueprint = JSON.parse(await fs.readFile(generated.delivery.agent.workflow, 'utf8'));
  assert.equal(blueprint.distillation.evidence.correctionCount, 1);
  assert.ok(blueprint.distillation.weaknesses.length > 0);
  const mcpSource = await fs.readFile(generated.delivery.mcp.server, 'utf8');
  assert.match(mcpSource, /get_conversation_distillation/);
  assert.match(mcpSource, /search_original_conversation/);
  assert.match(mcpSource, /get_original_conversation_stage/);
  assert.match(mcpSource, /get_improved_workflow/);
  const verified = await verifyConversationPackage(generated.root);
  assert.equal(verified.ok, true, JSON.stringify(verified.failures));
  assert.ok(verified.checkedArtifacts >= 15);
});

test('names a package from conversation topics, actual tools, and implementation evidence', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await packageConversation({
    sourcePath: source,
    packageId: 'conversation-11111111',
    packageName: '会话 11111111 能力包',
    targets: ['skill'],
    outputRoot: path.join(root, 'auto-named-packages'),
  });
  const generated = result.package;
  assert.notEqual(generated.id, 'conversation-11111111');
  assert.match(generated.id, /report/);
  assert.match(generated.id, /exec/);
  assert.match(generated.name, /报告生成与升级/);
  assert.match(generated.name, /命令执行/);
  assert.match(generated.name, /代码修改/);
  assert.equal(generated.naming.mode, '会话内容与实际工具自动命名');
  assert.ok(generated.naming.observedTools.includes('functions.exec_command'));
  assert.ok(generated.naming.observedTools.includes('functions.apply_patch'));
  const blueprint = JSON.parse(await fs.readFile(path.join(generated.root, 'workflow-blueprint.json'), 'utf8'));
  assert.equal(blueprint.package.name, generated.name);
  assert.deepEqual(blueprint.package.naming.contentTopics, generated.naming.contentTopics);
  assert.match(await fs.readFile(generated.delivery.guide, 'utf8'), new RegExp(generated.name));
  assert.equal((await verifyConversationPackage(generated.root)).ok, true);
});
