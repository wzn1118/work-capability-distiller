import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveConversationUiBlueprint } from './lib/conversation-ai-distiller.mjs';
import { packageConversationV2, verifyConversationPackageV2 } from './lib/root-capability-packager.mjs';

const SESSION_ID = '33333333-4444-7555-8666-777777777777';

async function removeTreeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

function characteristicBlueprint({ name, topic, request }) {
  return deriveConversationUiBlueprint({
    analysis: { reusableCapabilities: [] },
    extraction: {
      stages: [{ index: 1, title: `P1｜${topic}`, request, assistantMessages: [], toolCalls: [], fileChanges: [] }],
      corrections: [],
      statistics: { messages: 1, toolCalls: 0 },
    },
    identity: { name, naming: { contentTopics: [topic] } },
  });
}

test('独立界面按能力特性生成不同结构，而不是复用同一模板', () => {
  const engineering = characteristicBlueprint({
    name: 'Codex 启动卡顿诊断与持久化修复能力包',
    topic: '启动性能修复',
    request: '分析启动卡顿根因，读取项目源码和 Git 差异，修改文件，执行终端命令、构建与测试并保留恢复点。',
  });
  const document = characteristicBlueprint({
    name: 'PPT 多版本融合与演示文稿重构能力包',
    topic: '演示文稿重构',
    request: '融合两个 PPTX 的内容，重组章节和页面版式，逐页预览并导出高质量演示文稿。',
  });
  const content = characteristicBlueprint({
    name: '评论与视频洞察报告自动化能力包',
    topic: '评论与视频洞察',
    request: '汇总 CSV 评论明细和视频数据表，清洗字段并分层统计，识别受众、粉丝、营销机会与传播风险，生成内容运营行动报告。',
  });

  assert.equal(engineering.visual.family, 'engineering-console');
  assert.equal(engineering.experience.layout, 'diagnostic-split');
  assert.deepEqual(engineering.experience.modules.map((item) => item.id), ['workspace', 'diagnosis', 'change-plan', 'terminal', 'verification']);
  assert.match(engineering.visual.rationale, /性能与卡顿|诊断与修复/);
  assert.ok(engineering.visual.scores['engineering-console'] > engineering.visual.scores['research-studio']);

  assert.equal(document.visual.family, 'document-studio');
  assert.equal(document.experience.layout, 'document-workshop');
  assert.ok(document.experience.modules.some((item) => item.id === 'layout'));
  assert.ok(document.experience.modules.some((item) => item.id === 'export'));

  assert.equal(content.visual.family, 'content-operations');
  assert.equal(content.experience.layout, 'campaign-board');
  assert.ok(content.experience.modules.some((item) => item.id === 'audience'));
  assert.ok(content.experience.modules.some((item) => item.id === 'opportunity'));

  assert.equal(new Set([engineering.experience.layout, document.experience.layout, content.experience.layout]).size, 3);
  assert.notDeepEqual(engineering.experience.navigationOrder, document.experience.navigationOrder);
  assert.notEqual(engineering.experience.task.title, content.experience.task.title);
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'root-capability-v3-'));
  const source = path.join(root, `rollout-2026-08-16T10-00-00-${SESSION_ID}.jsonl`);
  const rows = [
    { timestamp: '2026-08-16T10:00:00.000Z', type: 'session_meta', payload: { session_id: SESSION_ID, cwd: 'C:/workspace' } },
    { timestamp: '2026-08-16T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: 'C:/workspace' } },
    { timestamp: '2026-08-16T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '生成 WUHU 抖音评论与视频的玩家洞察报告，并执行本地命令修改文件。' }] } },
    { timestamp: '2026-08-16T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'node --test' }) } },
    { timestamp: '2026-08-16T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'exit code: 0' } },
    { timestamp: '2026-08-16T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'functions.apply_patch', call_id: 'call-2', arguments: '*** Begin Patch\n*** Add File: report.md\n+# 报告\n*** End Patch' } },
    { timestamp: '2026-08-16T10:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-2', output: 'Done.' } },
    { timestamp: '2026-08-16T10:00:07.000Z', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: 'C:/workspace' } },
    { timestamp: '2026-08-16T10:00:08.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '能力太弱，必须从根子重建，提取并改进原对话，提供全中文独立 UI、Skill、MCP、命令、文件修改、验证和恢复。' }] } },
    { timestamp: '2026-08-16T10:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '开始根级重建。' }] } },
  ];
  await fs.writeFile(source, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { root, source };
}

function startPortableLauncher(packageRoot, env) {
  const child = spawn(process.execPath, ['agent/launcher.mjs'], {
    cwd: packageRoot,
    env: { ...process.env, ...env, CONVERSATION_AGENT_NO_BROWSER: '1', CONVERSATION_AGENT_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`便携启动器启动超时：${output}`)), 8000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      if (!output.match(/http:\/\/127\.0\.0\.1:(\d+)\//)) {
        clearTimeout(timeout);
        reject(new Error(`便携启动器提前退出（${code}）：${output}`));
      }
    });
  });
}

async function readHttpBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startAutonomousToolProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const rawBody = await readHttpBody(request);
    const body = rawBody ? JSON.parse(rawBody) : {};
    calls.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization || '' });
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'autonomy-model', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const toolMessages = (body.messages || []).filter((message) => message.role === 'tool');
    const lastTool = toolMessages.at(-1)?.name;
    const toolCall = (id, name, argumentsValue) => ({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(argumentsValue) } }],
    });
    let message;
    if (!lastTool) message = toolCall('inspect-project', 'inspect_project', {});
    else if (lastTool === 'inspect_project') message = toolCall('read-instructions', 'read_project_instructions', {});
    else if (lastTool === 'read_project_instructions') message = toolCall('write-result', 'write_file', { path: 'autonomous-result.txt', content: '修改前' });
    else if (lastTool === 'write_file') message = toolCall('replace-result', 'replace_text', { path: 'autonomous-result.txt', oldText: '修改前', newText: '修改后' });
    else if (lastTool === 'replace_text') message = toolCall('run-command', 'execute_command', {
      command: 'node -e "const fs=require(\'fs\');process.stdout.write(fs.readFileSync(\'autonomous-result.txt\',\'utf8\')+\'|\'+(process.env.CONVERSATION_AGENT_OPENAI_API_KEY?\'密钥泄漏\':\'密钥已隔离\'))"',
    });
    else if (lastTool === 'execute_command') message = toolCall('verify-result', 'run_verification', { commands: ['node -e "process.exit(0)"'] });
    else message = { role: 'assistant', content: '自动工具闭环已完成：项目已检查，文件已修改，命令与验证均已执行。' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'autonomy-tool-loop',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { calls, server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

test('v3 根能力包生成统一契约、中文 UI 和可恢复本地执行运行时', async (t) => {
  const { root, source } = await createFixture();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await removeTreeWithRetry(root);
  });

  const result = await packageConversationV2({
    sourcePath: source,
    packageId: 'conversation-33333333',
    packageName: '会话 33333333 能力包',
    outputRoot: path.join(root, 'packages'),
  });
  const generated = result.package;
  assert.equal(generated.selection.mode, 'whole-session');
  assert.equal(generated.selection.recordCount, 10);
  const workCapability = JSON.parse(await fs.readFile(path.join(generated.root, 'work-capability-ir.v2.json'), 'utf8'));
  const releaseEvaluation = JSON.parse(await fs.readFile(path.join(generated.root, 'release-decision.json'), 'utf8'));
  const coverageMatrix = JSON.parse(await fs.readFile(path.join(generated.root, 'coverage-matrix.json'), 'utf8'));
  const compiledTargets = JSON.parse(await fs.readFile(path.join(generated.root, 'compiled-targets.v2.json'), 'utf8'));
  const coverageGaps = JSON.parse(await fs.readFile(path.join(generated.root, 'coverage-gaps.json'), 'utf8'));
  const semanticEvaluationPlan = JSON.parse(await fs.readFile(path.join(generated.root, 'semantic-evaluation-plan.json'), 'utf8'));
  const deterministicReplay = JSON.parse(await fs.readFile(path.join(generated.root, 'deterministic-replay.json'), 'utf8'));
  const originalTaskReplay = JSON.parse(await fs.readFile(path.join(generated.root, 'original-task-replay.json'), 'utf8'));
  const heldOutEvaluation = JSON.parse(await fs.readFile(path.join(generated.root, 'held-out-evaluation.json'), 'utf8'));
  const isolatedAgentValidation = JSON.parse(await fs.readFile(path.join(generated.root, 'isolated-agent-validation.json'), 'utf8'));
  assert.equal(workCapability.schemaVersion, 'work-capability-ir/v2');
  assert.equal(workCapability.runId, path.basename(generated.root));
  assert.ok(workCapability.evidenceGraph.entries.every((entry) => /^ev-[a-f0-9]{64}$/.test(entry.evidenceId)));
  assert.equal(coverageMatrix.schemaVersion, 'coverage-matrix/v2');
  assert.equal(releaseEvaluation.schemaVersion, 'work-capability-evaluation/v2');
  assert.equal(releaseEvaluation.gates.G4.status, 'pass');
  assert.equal(releaseEvaluation.gates.G6.status, 'fail');
  assert.equal(releaseEvaluation.gates.G7.status, 'pending');
  assert.equal(releaseEvaluation.gates.G9.status, 'pass');
  assert.equal(coverageGaps.schemaVersion, 'coverage-gap-register/v2');
  assert.equal(semanticEvaluationPlan.schemaVersion, 'semantic-evaluation-plan/v2');
  assert.equal(deterministicReplay.status, 'pass');
  assert.equal(deterministicReplay.firstFingerprint, deterministicReplay.secondFingerprint);
  assert.equal(originalTaskReplay.status, 'fail');
  assert.equal(heldOutEvaluation.status, 'pending');
  assert.equal(isolatedAgentValidation.status, 'pass');
  assert.equal(compiledTargets.length, 3);
  assert.ok(compiledTargets.every((target) => target.runtime.schemaVersion === 'work-capability-runtime/v2'));
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'work-capability-ir.v2.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'coverage-gaps.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'semantic-evaluation-plan.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'deterministic-replay.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'original-task-replay.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'held-out-evaluation.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'isolated-agent-validation.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'ui', 'work-capability.json'))).isFile());
  assert.notEqual(generated.id, 'conversation-33333333');
  assert.ok(generated.description);
  assert.ok(generated.description.phases.length > 0);
  assert.ok(generated.description.phases.every((phase) => /^P\d+｜/.test(phase.title)));
  assert.ok(generated.description.summary.includes('语义阶段'));
  assert.ok((await fs.stat(path.join(generated.root, 'package-description.json'))).isFile());
  assert.equal(generated.name, '三国杀 WUHU 评论与视频洞察报告自动化能力包');
  assert.equal(generated.naming.semanticProfile.id, 'sanguosha-wuhu-comment-video-insight-report');
  assert.ok(generated.naming.observedTools.includes('functions.exec_command'));
  assert.ok(generated.naming.observedTools.includes('functions.apply_patch'));

  const contract = JSON.parse(await fs.readFile(path.join(generated.root, 'capability-contract.json'), 'utf8'));
  assert.equal(contract.schemaVersion, '3.0.0');
  assert.equal(contract.tools.length, 38);
  assert.ok(contract.tools.some((item) => item.name === 'read_file' && item.permission === '选择有效工作区'));
  assert.ok(contract.tools.some((item) => item.name === 'restore_checkpoint'));
  assert.ok(contract.tools.some((item) => item.name === 'apply_patch'));
  assert.ok(contract.tools.some((item) => item.name === 'git_commit'));
  assert.ok(contract.tools.some((item) => item.name === 'start_process'));
  assert.ok(contract.tools.some((item) => item.name === 'fetch_url'));
  assert.equal(contract.codexAlignment.domains.length, 9);
  assert.equal(contract.workflow.length, 8);

  const distillation = JSON.parse(await fs.readFile(path.join(generated.root, 'conversation-distillation.json'), 'utf8'));
  assert.equal(distillation.type, 'universal-core-multi-conversation-project-specialization');
  assert.equal(distillation.universalCore.toolCount, 38);
  assert.equal(distillation.universalCore.tools.length, 38);
  assert.ok(distillation.universalCore.tools.some((item) => item.name === 'execute_command' && item.label === '执行本地命令' && item.permission === '开启命令执行'));
  assert.ok(distillation.universalCore.tools.some((item) => item.name === 'fetch_url' && item.label === '联网读取页面'));
  assert.ok(Array.isArray(distillation.specializedCapabilities));
  assert.ok(distillation.specializedCapabilities.length > 0);
  assert.ok(distillation.specializedCapabilities.every((item) => /^P\d+$/.test(item.phase) && item.goal && item.approach && item.deliverable && item.evidence));
  assert.ok(Array.isArray(distillation.distilledExpertise));
  assert.ok(distillation.distilledExpertise.length > 0);
  assert.ok(distillation.distilledExpertise.every((item) => /^P\d+$/.test(item.phase) && item.capability && item.whenToUse && item.executionMethod && item.deliverable && item.evidence));
  const distillationMarkdown = await fs.readFile(path.join(generated.root, 'conversation-distillation.md'), 'utf8');
  assert.match(distillationMarkdown, /从原会话提炼出的专长/);
  assert.match(distillationMarkdown, /\| 专长 \| 什么时候使用 \| 执行方法 \|/);
  assert.match(distillationMarkdown, /完整通用能力说明与功能清单/);
  assert.match(distillationMarkdown, /`execute_command`/);
  assert.match(distillationMarkdown, /P1/);
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'conversation-distillation.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.root, 'project-understanding.json'))).isFile());
  assert.ok((await fs.stat(path.join(generated.root, 'project-understanding.md'))).isFile());
  assert.ok((await fs.stat(path.join(generated.delivery.agent.root, 'project-understanding.json'))).isFile());
  assert.ok((await fs.stat(generated.delivery.skill.packageEntryFile)).isFile());
  assert.equal(generated.delivery.skill.packageEntryFile, path.join(generated.root, 'skill', 'SKILL.md'));
  const skillEntry = await fs.readFile(generated.delivery.skill.packageEntryFile, 'utf8');
  assert.match(skillEntry, /可安装技能目录/);
  assert.match(skillEntry, new RegExp(`${path.basename(generated.delivery.skill.root)}/SKILL\\.md`));

  const guide = await fs.readFile(generated.delivery.guide, 'utf8');
  assert.match(guide, /完整能力说明与功能清单/);
  assert.match(guide, /新手第一次使用/);
  assert.match(guide, /在“工作区”中选择项目目录后可以读取/);
  assert.match(guide, /接口模型全量列表/);
  assert.match(guide, /不会截断返回结果/);
  assert.match(guide, /自动连接当前 Codex/);
  assert.match(guide, /CODEX_HOME\/config\.toml/);
  assert.match(guide, /按建议填入任务/);
  assert.match(guide, /PRIORITY-PLAN\.md/);
  const ui = await fs.readFile(generated.delivery.agent.ui.index, 'utf8');
  assert.match(ui, /<html lang="zh-CN">/);
  assert.match(ui, /id="model-form"/);
  assert.match(ui, /id="workspace-form"/);
  assert.match(ui, /id="task-form"/);
  assert.match(ui, /id="execution-setup"/);
  assert.match(ui, /id="open-execution-setup"/);
  assert.match(ui, /开始一项可验证的本地任务/);
  assert.match(ui, /data-view="distillation"/);
  assert.match(ui, /id="universal-tool-list"/);
  assert.match(ui, /id="distilled-expertise"/);
  assert.match(ui, /id="project-understanding"/);
  assert.match(ui, /从原会话提炼出的专长/);
  assert.match(ui, /接口模型全量列表/);
  assert.match(ui, /id="model-catalog"/);
  assert.match(ui, /id="model-filter"/);
  assert.match(ui, /id="connect-codex"/);
  assert.doesNotMatch(ui, /class="web-chat-main-quickstart"/);
  assert.doesNotMatch(ui, /读取网页端 AI 聊天记录/);
  assert.doesNotMatch(ui, /data-web-chat-platform-button/);
  assert.match(ui, /id="installation-state"/);
  assert.match(ui, /id="work-release-panel"/);
  assert.match(ui, /id="coverage-gap-panel"/);
  assert.match(ui, /缺口处理与语义评估/);
  assert.match(ui, /查看原任务回放、留出任务和隔离执行明细/);
  assert.match(ui, /真实工作编译状态/);
  assert.match(ui, /G0-G9 发布门/);
  assert.match(ui, /安装与启动状态/);
  assert.match(ui, /自动连接当前 Codex/);
  assert.match(ui, /功能总览/);
  assert.match(ui, /模型自动执行状态/);
  assert.match(ui, /工具调用/);
  assert.match(ui, /写入操作/);
  assert.match(ui, /命令与验证/);
  assert.match(ui, /恢复点/);
  assert.match(ui, /原对话升级/);
  assert.match(ui, /任务记录/);
  assert.match(ui, /完整说明/);
  const styles = await fs.readFile(generated.delivery.agent.ui.styles, 'utf8');
  assert.match(styles, /\.brand-block h1 \{[^}]*white-space: normal/);
  assert.match(styles, /\.model-catalog-list/);
  assert.match(styles, /\.setup-disclosure/);
  assert.match(styles, /\.task-brief/);
  assert.match(styles, /\.conversation-brief-disclosure/);
  const uiScript = await fs.readFile(generated.delivery.agent.ui.app, 'utf8');
  assert.match(uiScript, /conversation-brief-body/);
  assert.match(uiScript, /\/api\/runtime\/work-capability/);
  assert.match(uiScript, /\/api\/runtime\/coverage-gaps/);
  assert.match(uiScript, /\/api\/runtime\/semantic-evaluation-plan/);
  assert.match(uiScript, /function renderCoverageGaps/);
  assert.match(uiScript, /\/api\/runtime\/release-validation/);
  assert.match(uiScript, /function renderHeldOutSubmit/);
  assert.match(uiScript, /\/api\/runtime\/release-validation\/from-task/);
  assert.match(uiScript, /function renderReleaseValidation/);
  assert.match(uiScript, /renderWorkCapability/);
  const uiBlueprint = JSON.parse(await fs.readFile(path.join(generated.root, 'conversation-ui-blueprint.json'), 'utf8'));
  const agentUiBlueprint = JSON.parse(await fs.readFile(generated.delivery.agent.ui.blueprint, 'utf8'));
  assert.ok(uiBlueprint.identity.title);
  assert.ok(uiBlueprint.purpose);
  assert.ok(uiBlueprint.inputs.length > 0);
  assert.ok(uiBlueprint.capabilities.length > 0);
  assert.ok(uiBlueprint.specializations.length > 0);
  assert.ok(uiBlueprint.expertise.length > 0);
  assert.ok(uiBlueprint.expertise.every((item) => /^P\d+$/.test(item.phase) && item.capability && item.whenToUse && item.executionMethod));
  assert.ok(uiBlueprint.deliverables.length > 0);
  assert.equal(agentUiBlueprint.identity.title, uiBlueprint.identity.title);
  assert.match(uiScript, /function renderModelCatalog/);
  assert.doesNotMatch(uiScript, /quick-index-web-chat-history/);
  assert.doesNotMatch(uiScript, /data-web-chat-platform-button/);
  assert.doesNotMatch(uiScript, /chatGptWebAction/);
  assert.match(uiScript, /function openExecutionSetup/);
  assert.match(uiScript, /function phaseLabel/);
  assert.match(uiScript, /function renderUniversalTools/);
  assert.match(uiScript, /function sourcePhaseLabels/);
  assert.match(uiScript, /conversation-source/);
  assert.match(uiScript, /请遵循原会话的语义阶段/);
  assert.match(uiScript, /function loadConversationUi/);
  assert.match(uiScript, /function renderAdaptiveWorkspace/);
  assert.match(uiScript, /function reorderNavigation/);
  assert.match(uiScript, /data-held-out-capability/);
  assert.match(uiScript, /data-experience-quick/);
  assert.match(uiScript, /function renderSpecializations/);
  assert.match(uiScript, /function renderProjectUnderstanding/);
  assert.match(uiScript, /\/api\/runtime\/project-understanding/);
  assert.match(uiScript, /distilledExpertise/);
  assert.match(uiScript, /function prefillSpecializedTask/);
  assert.match(uiScript, /function priorityRecommendationMarkup/);
  assert.match(uiScript, /data-recommendation-action/);
  assert.match(uiScript, /\/api\/runtime\/recommendation/);
  assert.ok(uiScript.includes('capability-ui.json'));
  assert.ok(uiBlueprint.visual.family);
  assert.ok(uiBlueprint.visual.signals.length > 0);
  assert.ok(Object.keys(uiBlueprint.visual.scores).length >= 6);
  assert.ok(uiBlueprint.experience.layout);
  assert.equal(uiBlueprint.experience.modules.length, 5);
  assert.ok(uiBlueprint.experience.navigationOrder.length > 0);
  assert.match(styles, /\.adaptive-workspace/);
  assert.match(styles, /body\[data-ui-family="engineering-console"\]/);
  assert.match(styles, /body\[data-ui-family="document-studio"\]/);
  assert.match(styles, /body\[data-ui-family="content-operations"\]/);
  assert.match(uiScript, /接口返回的全部/);
  assert.match(uiScript, /data-model-id/);
  assert.match(uiScript, /\/api\/runtime\/codex-link/);
  assert.doesNotMatch(uiScript, /\/api\/runtime\/chatgpt-web\/jobs/);
  assert.doesNotMatch(uiScript, /WEB_CHAT_PLATFORM_NAMES/);
  assert.doesNotMatch(uiScript, /function selectWebChatPlatform/);
  assert.doesNotMatch(uiScript, /function renderChatGptWeb/);
  assert.doesNotMatch(uiScript, /function formatChatGptSnapshot/);
  assert.doesNotMatch(uiScript, /function renderChatGptHistory/);
  assert.doesNotMatch(uiScript, /companion\/setup/);
  assert.doesNotMatch(uiScript, /自动打开伴侣文件夹和扩展管理页/);
  assert.match(uiScript, /function renderInstallation/);
  assert.match(uiScript, /function renderAutonomyStatus/);
  assert.match(uiScript, /async function loadProjectInsightData/);
  assert.match(uiScript, /void loadProjectInsightData\(\)/);
  assert.match(uiScript, /\/api\/runtime\/capabilities\?compact=1/);
  assert.match(uiScript, /\/api\/runtime\/distillation\?compact=1/);
  assert.match(uiScript, /\/api\/runtime\/sources/);
  assert.match(uiScript, /autonomy-tool-count/);
  assert.match(uiScript, /autonomy-write-count/);
  assert.match(uiScript, /autonomy-command-count/);
  assert.match(uiScript, /autonomy-checkpoint-count/);
  assert.match(uiScript, /if \(!state\.models\.length && state\.health\?\.runtime\?\.baseUrl[\s\S]*?loadModels\(false\)/);
  const agentServer = await fs.readFile(generated.delivery.agent.server, 'utf8');
  assert.match(agentServer, /\/api\/runtime\/codex-link/);
  assert.match(agentServer, /\/api\/runtime\/chatgpt-web/);
  assert.match(agentServer, /createChatGptWebBridge/);
  assert.match(agentServer, /companion\/open-extensions/);
  assert.match(agentServer, /companion\/setup/);
  assert.match(agentServer, /\/api\/runtime\/installation/);
  assert.match(agentServer, /\/api\/runtime\/distillation/);
  assert.match(agentServer, /\/api\/runtime\/project-understanding/);
  assert.match(agentServer, /url\.searchParams\.get\('compact'\) === '1'/);
  assert.match(agentServer, /isLoopbackRequest/);
  const launcher = await fs.readFile(generated.delivery.agent.launcher, 'utf8');
  assert.match(launcher, /CONVERSATION_AGENT_NO_BROWSER/);
  assert.match(launcher, /xdg-open/);
  const installCommand = await fs.readFile(generated.delivery.agent.install.windows.oneClick, 'utf8');
  const directCommand = await fs.readFile(generated.delivery.agent.install.windows.direct, 'utf8');
  assert.match(installCommand, /install-and-start\.ps1/);
  assert.match(directCommand, /launch\.ps1/);
  assert.equal((await fs.stat(generated.archive)).size > 0, true);
  const archive = await fs.readFile(generated.archive);
  assert.equal(archive.subarray(0, 4).toString('ascii'), 'PK\x03\x04');
  assert.notEqual(archive.indexOf(Buffer.from('install-and-start.cmd')), -1);
  assert.notEqual(archive.indexOf(Buffer.from('chatgpt-companion/manifest.json')), -1);
  const companionRoot = path.join(generated.delivery.agent.root, 'chatgpt-companion');
  assert.equal(generated.delivery.agent.chatGptWeb.companion, companionRoot);
  assert.equal(generated.delivery.agent.chatGptWeb.readme, path.join(companionRoot, 'README.md'));
  assert.equal(generated.delivery.agent.chatGptWeb.manifest, path.join(companionRoot, 'manifest.json'));
  const companionManifest = JSON.parse(await fs.readFile(path.join(companionRoot, 'manifest.json'), 'utf8'));
  assert.equal(companionManifest.manifest_version, 3);
  assert.ok(companionManifest.host_permissions.includes('https://chatgpt.com/*'));
  assert.ok(companionManifest.host_permissions.includes('https://chat.openai.com/*'));
  assert.ok(companionManifest.host_permissions.includes('https://chat.deepseek.com/*'));
  assert.ok(companionManifest.host_permissions.includes('https://gemini.google.com/*'));
  assert.ok(companionManifest.host_permissions.includes('https://www.doubao.com/*'));
  assert.match(await fs.readFile(path.join(companionRoot, 'README.md'), 'utf8'), /主工作台/);
  assert.match(await fs.readFile(path.join(companionRoot, 'README.md'), 'utf8'), /自动发现/);
  assert.match(await fs.readFile(path.join(companionRoot, 'README.md'), 'utf8'), /不读取、导出或保存 Cookie/);
  const companionContent = await fs.readFile(path.join(companionRoot, 'content.js'), 'utf8');
  assert.match(companionContent, /function historyIndex/);
  assert.match(companionContent, /history-index/);
  assert.match(companionContent, /function expandHistorySections/);
  assert.match(companionContent, /expandedSections/);
  assert.match(companionContent, /scrollRounds/);
  const companionBackground = await fs.readFile(path.join(companionRoot, 'background.js'), 'utf8');
  assert.match(companionBackground, /discoverLocalWorkbench/);
  assert.match(companionBackground, /BRIDGE_PATHS/);
  assert.match(companionBackground, /startConnectionMaintenance/);
  assert.match(companionBackground, /autoReconnect/);
  const companionPopup = await fs.readFile(path.join(companionRoot, 'popup.html'), 'utf8');
  assert.match(companionPopup, /自动发现并连接/);
  const companionPopupScript = await fs.readFile(path.join(companionRoot, 'popup.js'), 'utf8');
  assert.match(companionPopupScript, /正在自动重新查找当前工作台/);
  const taskEngine = await fs.readFile(path.join(generated.delivery.agent.root, 'runtime', 'task-engine.mjs'), 'utf8');
  assert.match(taskEngine, /workspace\.ready && workspace\.allowWrite/);
  assert.match(taskEngine, /workspace\.ready && workspace\.allowCommand/);

  const profile = JSON.parse(await fs.readFile(generated.delivery.agent.aiProfile, 'utf8'));
  assert.equal(profile.schemaVersion, '6.3.0');
  assert.equal(profile.secretsPersisted, false);
  assert.equal(profile.features.autonomousToolLoop, true);
  assert.equal(profile.features.taskResume, true);
  assert.equal(profile.features.rollback, true);
  assert.equal(profile.features.independentChineseUi, true);
  assert.equal(profile.features.fullModelCatalog, true);
  assert.equal(profile.features.autoModelCatalogRefresh, true);
  assert.equal(profile.features.currentCodexAutoLink, true);
  assert.equal(profile.features.chatGptWebCompanion, true);
  assert.equal(profile.features.chatGptWebPrompt, true);
  assert.equal(profile.features.chatGptConversationImport, true);
  assert.equal(profile.features.chatGptWebHistoryIndex, true);
  assert.equal(profile.features.chatGptWebCurrentConversationRead, true);
  assert.equal(profile.features.chatGptCredentialIsolation, true);
  assert.equal(profile.features.webChatMainWorkbenchControls, true);
  assert.equal(profile.features.webChatPlatformSelection, true);
  assert.deepEqual(profile.features.webChatPlatforms, ['chatgpt', 'deepseek', 'gemini', 'doubao']);
  assert.equal(profile.features.responsesApiAdapter, true);
  assert.equal(profile.features.portableDistribution, true);
  assert.equal(profile.features.oneClickInstall, true);
  assert.equal(profile.features.perUserStateStorage, true);
  assert.equal(profile.endpoints.installation, '/api/runtime/installation');
  assert.equal(profile.endpoints.codexLink, '/api/runtime/codex-link');
  assert.equal(profile.endpoints.chatGptWeb, '/api/runtime/chatgpt-web');
  assert.equal(profile.endpoints.chatGptWebJobs, '/api/runtime/chatgpt-web/jobs');
  assert.equal(profile.endpoints.webChat, '/api/runtime/chatgpt-web');
  assert.equal(profile.endpoints.webChatJobs, '/api/runtime/chatgpt-web/jobs');
  assert.equal(profile.features.projectInspection, true);
  assert.equal(profile.features.standardPatch, true);
  assert.equal(profile.features.gitWorkflow, true);
  assert.equal(profile.features.managedLongRunningProcesses, true);
  assert.equal(profile.features.skillDiscovery, true);
  assert.equal(profile.features.universalAndSpecializedDistillation, true);
  assert.equal(profile.features.projectEvidenceGraph, true);
  assert.equal(profile.features.fileEvolutionEvidence, true);
  assert.equal(profile.features.generatedArtifactLineage, true);
  assert.equal(profile.features.conflictRegister, true);
  assert.equal(profile.endpoints.distillation, '/api/runtime/distillation');
  assert.equal(profile.endpoints.recommendation, '/api/runtime/recommendation');
  assert.equal(profile.endpoints.projectUnderstanding, '/api/runtime/project-understanding');

  const portableState = path.join(root, 'portable-state');
  const portable = await startPortableLauncher(generated.root, { CONVERSATION_AGENT_STATE_ROOT: portableState, CONVERSATION_AGENT_CODEX_HOME: path.join(root, 'no-codex-here') });
  try {
    const portableHealthResponse = await fetch(`${portable.url}/api/runtime/health`);
    assert.equal(portableHealthResponse.ok, true);
    const portableHealth = await portableHealthResponse.json();
    assert.equal(portableHealth.installation.ready, true);
    assert.equal(portableHealth.installation.dependencies.thirdPartyPackages, 0);
    assert.equal(portableHealth.installation.state.packageDirectoryReadOnlySupported, true);
    assert.equal(portableHealth.installation.launch.directLaunch, 'launch.cmd');
    assert.equal(portableHealth.chatGptWeb.connected, false);
    assert.deepEqual(portableHealth.chatGptWeb.supportedPlatforms.map((platform) => platform.id), ['chatgpt', 'deepseek', 'gemini', 'doubao']);
    assert.match(portableHealth.chatGptWeb.pairingCode, /^\d{6}$/);
    assert.equal(portableHealth.chatGptWeb.privacy.includes('Cookie'), true);
    const initialPairingCode = portableHealth.chatGptWeb.pairingCode;
    const corsResponse = await fetch(`${portable.url}/api/runtime/chatgpt-web`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
    assert.equal(corsResponse.status, 204);
    assert.equal(corsResponse.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    const pairResponse = await fetch(`${portable.url}/api/runtime/chatgpt-web/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingCode: initialPairingCode, browserName: '自动化测试浏览器' }),
    });
    assert.equal(pairResponse.ok, true);
    const pair = await pairResponse.json();
    assert.ok(pair.token);
    const companionHeaders = { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` };
    const heartbeatResponse = await fetch(`${portable.url}/api/runtime/chatgpt-web/heartbeat`, {
      method: 'POST', headers: companionHeaders, body: JSON.stringify({ pageTitle: '测试 ChatGPT 对话', pageUrl: 'https://chatgpt.com/c/test-conversation' }),
    });
    assert.equal(heartbeatResponse.ok, true);
    const linkedStatus = await (await fetch(`${portable.url}/api/runtime/chatgpt-web`)).json();
    assert.equal(linkedStatus.connected, true);
    assert.equal(linkedStatus.pageTitle, '测试 ChatGPT 对话');
    const queuedResponse = await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', platform: 'deepseek', prompt: '总结当前目标' }),
    });
    assert.equal(queuedResponse.status, 201);
    const queued = await queuedResponse.json();
    const nextJob = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/next`, { headers: { authorization: `Bearer ${pair.token}` } })).json();
    assert.equal(nextJob.job.id, queued.id);
    assert.equal(nextJob.job.prompt, '总结当前目标');
    assert.equal(nextJob.job.platform, 'deepseek');
    const completeResponse = await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${queued.id}/complete`, {
      method: 'POST', headers: companionHeaders, body: JSON.stringify({ answer: '网页回答已返回', snapshot: { platform: 'deepseek', title: '测试 DeepSeek 对话', url: 'https://chat.deepseek.com/a/test-conversation', messages: [{ role: 'user', content: '总结当前目标' }, { role: 'assistant', content: '网页回答已返回' }] } }),
    });
    assert.equal(completeResponse.ok, true);
    const completed = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${queued.id}`)).json();
    assert.equal(completed.status, '完成');
    assert.equal(completed.result.answer, '网页回答已返回');
    assert.equal(completed.result.snapshot.platform, 'deepseek');
    assert.equal(completed.result.snapshot.messages.length, 2);
    const historyQueued = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'history-index', platform: 'gemini' }),
    })).json();
    const historyNext = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/next`, { headers: { authorization: `Bearer ${pair.token}` } })).json();
    assert.equal(historyNext.job.id, historyQueued.id);
    assert.equal(historyNext.job.type, 'history-index');
    assert.equal(historyNext.job.platform, 'gemini');
    await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${historyQueued.id}/complete`, {
      method: 'POST',
      headers: companionHeaders,
      body: JSON.stringify({ history: { platform: 'gemini', currentUrl: 'https://gemini.google.com/app/test-conversation', conversations: [{ title: '完整项目改造讨论', url: 'https://gemini.google.com/app/test-conversation', current: true }, { title: '报告修正记录', url: 'https://gemini.google.com/app/report-revision' }] } }),
    });
    const historyCompleted = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${historyQueued.id}`)).json();
    assert.equal(historyCompleted.status, '完成');
    assert.equal(historyCompleted.result.history.conversations.length, 2);
    assert.equal(historyCompleted.result.history.conversations[0].title, '完整项目改造讨论');
    assert.equal(historyCompleted.result.history.platform, 'gemini');
    const captureQueued = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'capture', platform: 'doubao' }),
    })).json();
    const captureNext = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/next`, { headers: { authorization: `Bearer ${pair.token}` } })).json();
    assert.equal(captureNext.job.id, captureQueued.id);
    assert.equal(captureNext.job.platform, 'doubao');
    await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${captureQueued.id}/complete`, {
      method: 'POST', headers: companionHeaders, body: JSON.stringify({ snapshot: { platform: 'doubao', title: '待导入对话', url: 'https://www.doubao.com/chat/import', messages: [{ role: 'user', content: '第一条需求' }, { role: 'assistant', content: '第一条回答' }] } }),
    });
    const captured = await (await fetch(`${portable.url}/api/runtime/chatgpt-web/jobs/${captureQueued.id}`)).json();
    assert.equal(captured.result.snapshot.title, '待导入对话');
    assert.equal(captured.result.snapshot.platform, 'doubao');
    assert.equal(captured.result.snapshot.messages[0].content, '第一条需求');
    await fetch(`${portable.url}/api/runtime/chatgpt-web/disconnect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const disconnectedStatus = await (await fetch(`${portable.url}/api/runtime/chatgpt-web`)).json();
    assert.equal(disconnectedStatus.connected, false);
    assert.notEqual(disconnectedStatus.pairingCode, initialPairingCode);
    const distillationResponse = await fetch(`${portable.url}/api/runtime/distillation`);
    assert.equal(distillationResponse.ok, true);
    const portableDistillation = await distillationResponse.json();
    assert.equal(portableDistillation.conversationDistillation.universalCore.toolCount, 38);
    assert.ok(portableDistillation.conversationDistillation.specializedCapabilities.length > 0);
    const recommendationResponse = await fetch(`${portable.url}/api/runtime/recommendation`);
    assert.equal(recommendationResponse.ok, true);
    const portableRecommendation = await recommendationResponse.json();
    assert.ok(portableRecommendation.recommendation);
    assert.ok(portableRecommendation.recommendation.priorities.length > 0);
    assert.match(portableRecommendation.recommendation.priorities[0].level, /^P[0-3]$/);
    assert.ok(portableRecommendation.recommendation.priorities[0].nextAction);
    const workCapabilityResponse = await fetch(`${portable.url}/api/runtime/work-capability`);
    assert.equal(workCapabilityResponse.ok, true);
    const portableWorkCapability = await workCapabilityResponse.json();
    assert.equal(portableWorkCapability.available, true);
    assert.equal(portableWorkCapability.workCapability.schemaVersion, 'work-capability-ir/v2');
    assert.equal(portableWorkCapability.evaluation.schemaVersion, 'work-capability-evaluation/v2');
    assert.equal(portableWorkCapability.evaluation.gates.G4.status, 'pass');
    assert.equal(portableWorkCapability.evaluation.gates.G6.status, 'fail');
    assert.equal(portableWorkCapability.evaluation.gates.G7.status, 'pending');
    assert.equal(portableWorkCapability.evaluation.gates.G9.status, 'pass');
    assert.equal(portableWorkCapability.deterministicReplay.status, 'pass');
    const coverageGapResponse = await fetch(`${portable.url}/api/runtime/coverage-gaps`);
    assert.equal(coverageGapResponse.ok, true);
    const portableCoverageGaps = await coverageGapResponse.json();
    assert.equal(portableCoverageGaps.schemaVersion, 'coverage-gap-register/v2');
    const semanticPlanResponse = await fetch(`${portable.url}/api/runtime/semantic-evaluation-plan`);
    assert.equal(semanticPlanResponse.ok, true);
    const portableSemanticPlan = await semanticPlanResponse.json();
    assert.equal(portableSemanticPlan.schemaVersion, 'semantic-evaluation-plan/v2');
    const releaseValidationResponse = await fetch(`${portable.url}/api/runtime/release-validation`);
    assert.equal(releaseValidationResponse.ok, true);
    const portableReleaseValidation = await releaseValidationResponse.json();
    assert.equal(portableReleaseValidation.originalTaskReplay.status, 'fail');
    assert.equal(portableReleaseValidation.heldOutEvaluation.status, 'pending');
    assert.equal(portableReleaseValidation.isolatedAgentValidation.status, 'pass');
    const projectUnderstandingResponse = await fetch(`${portable.url}/api/runtime/project-understanding`);
    assert.equal(projectUnderstandingResponse.ok, true);
    const portableProjectUnderstanding = await projectUnderstandingResponse.json();
    assert.equal(portableProjectUnderstanding.projectUnderstanding, null);
  } finally {
    if (portable.child.exitCode === null) {
      const exited = new Promise((resolve) => portable.child.once('exit', resolve));
      portable.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
  }

  const config = await import(pathToFileURL(path.join(generated.delivery.agent.root, 'runtime', 'config.mjs')).href);
  const workspace = await import(pathToFileURL(path.join(generated.delivery.agent.root, 'runtime', 'workspace.mjs')).href);
  const workspaceRoot = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'agent-state');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const skillRoot = path.join(root, 'skills');
  await fs.mkdir(path.join(skillRoot, 'fixture-skill'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'fixture-skill', 'SKILL.md'), '# Fixture Skill\nTest skill content.\n', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), '# Project Instructions\nRead instructions before edits.\n', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
  await config.updateWorkspaceConfig({ root: workspaceRoot, allowWrite: true, allowDelete: true, allowCommand: true, allowGitWrite: true, allowNetwork: true, skillRoots: [skillRoot], commandTimeoutMs: 10000 });
  const run = { id: 'run-v3', changeJournal: [], checkpoints: [], commands: [], processes: [], verification: [] };

  const project = await workspace.executeWorkspaceTool(stateRoot, run, 'inspect_project', {});
  assert.ok(project.projectMarkers.includes('package.json'));
  assert.equal(project.packageScripts.test, 'node --test');
  const instructions = await workspace.executeWorkspaceTool(stateRoot, run, 'read_project_instructions', {});
  assert.equal(instructions.count, 1);
  const skills = await workspace.executeWorkspaceTool(stateRoot, run, 'list_skills', {});
  assert.ok(skills.skills.some((item) => item.name === 'fixture-skill'));
  const skill = await workspace.executeWorkspaceTool(stateRoot, run, 'read_skill', { name: 'fixture-skill' });
  assert.match(skill.content, /Fixture Skill/);

  const written = await workspace.executeWorkspaceTool(stateRoot, run, 'write_file', { path: 'nested/deep/value.txt', content: '旧内容' });
  assert.equal(written.path, 'nested/deep/value.txt');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'nested', 'deep', 'value.txt'), 'utf8'), '旧内容');
  await workspace.executeWorkspaceTool(stateRoot, run, 'replace_text', { path: 'nested/deep/value.txt', oldText: '旧内容', newText: '新内容' });
  const command = await workspace.executeWorkspaceTool(stateRoot, run, 'execute_command', { command: 'node -e "process.stdout.write(\'命令通过\')"' });
  const patchResult = await workspace.executeWorkspaceTool(stateRoot, run, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: patched.txt\n+patched by standard patch\n*** End Patch' });
  assert.deepEqual(patchResult.files, ['patched.txt']);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'patched.txt'), 'utf8'), 'patched by standard patch');
  const diff = await workspace.executeWorkspaceTool(stateRoot, run, 'get_file_diff', { path: 'nested/deep/value.txt' });
  assert.match(diff.diff, /---/);
  assert.equal(command.exitCode, 0);
  assert.match(command.stdout, /命令通过/);
  const verification = await workspace.executeWorkspaceTool(stateRoot, run, 'run_verification', { commands: ['node -e "process.exit(0)"'] });
  assert.equal(verification.passed, true);
  await workspace.executeWorkspaceTool(stateRoot, run, 'execute_command', { command: 'git init' });
  const gitStatus = await workspace.executeWorkspaceTool(stateRoot, run, 'git_status', {});
  assert.equal(gitStatus.exitCode, 0);
  const managedProcess = await workspace.executeWorkspaceTool(stateRoot, run, 'start_process', { command: 'node -e "console.log(\'managed-ready\'); setInterval(() => {}, 1000)"' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const processOutput = await workspace.executeWorkspaceTool(stateRoot, run, 'read_process_output', { processId: managedProcess.id });
  assert.match(processOutput.stdout, /managed-ready/);
  await workspace.executeWorkspaceTool(stateRoot, run, 'stop_process', { processId: managedProcess.id });
  const moved = await workspace.executeWorkspaceTool(stateRoot, run, 'move_path', { source: 'nested/deep/value.txt', target: 'moved/final/value.txt' });
  assert.equal(moved.checkpoints.length, 2);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'moved', 'final', 'value.txt'), 'utf8'), '新内容');
  await workspace.restoreCheckpoint(stateRoot, moved.checkpoints[1].id, run);
  await workspace.restoreCheckpoint(stateRoot, moved.checkpoints[0].id, run);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'nested', 'deep', 'value.txt'), 'utf8'), '新内容');
  await assert.rejects(fs.stat(path.join(workspaceRoot, 'moved', 'final', 'value.txt')));
  assert.ok(run.changeJournal.some((item) => item.action === 'restore'));
  assert.ok(run.checkpoints.length >= 4);
  assert.equal((await verifyConversationPackageV2(generated.root)).ok, true);
});

test('v3 MCP 完成标准握手、文件写入、检查点和恢复', async (t) => {
  const { root, source } = await createFixture();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  const result = await packageConversationV2({ sourcePath: source, targets: ['mcp'], outputRoot: path.join(root, 'packages') });
  const workspaceRoot = path.join(root, 'mcp-workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
  const mcpSkillRoot = path.join(root, 'skills');
  await fs.mkdir(path.join(mcpSkillRoot, 'mcp-fixture'), { recursive: true });
  await fs.writeFile(path.join(mcpSkillRoot, 'mcp-fixture', 'SKILL.md'), '# MCP Fixture\n', 'utf8');
  const child = spawn(process.execPath, [result.package.delivery.mcp.server], {
    cwd: result.package.delivery.mcp.root,
    env: { ...process.env, CAPABILITY_MCP_WORKSPACE_ROOT: workspaceRoot, CAPABILITY_MCP_ALLOW_WRITE: '1', CAPABILITY_MCP_ALLOW_DELETE: '1', CAPABILITY_MCP_ALLOW_COMMAND: '1', CAPABILITY_MCP_ALLOW_GIT_WRITE: '1', CAPABILITY_MCP_ALLOW_NETWORK: '1', CAPABILITY_MCP_SKILL_ROOTS: mcpSkillRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const handler = pending.get(message.id);
    if (handler) { pending.delete(message.id); handler.resolve(message); }
  });
  function call(method, params = {}) {
    sequence += 1;
    const id = sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 调用超时：${method}`)); }, 5000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    lines.close();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await removeTreeWithRetry(root);
  });

  const initialized = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  const listed = await call('tools/list');
  assert.ok(listed.result.tools.some((item) => item.name === 'restore_workspace_checkpoint'));
  assert.ok(listed.result.tools.some((item) => item.name === 'inspect_project'));
  assert.ok(listed.result.tools.some((item) => item.name === 'apply_workspace_patch'));
  assert.ok(listed.result.tools.some((item) => item.name === 'git_status'));
  assert.ok(listed.result.tools.some((item) => item.name === 'start_workspace_process'));
  assert.ok(listed.result.tools.some((item) => item.name === 'list_skills'));
  assert.ok(listed.result.tools.some((item) => item.name === 'fetch_url'));
  assert.ok(listed.result.tools.some((item) => item.name === 'get_project_understanding'));
  const deepUnderstanding = await call('tools/call', { name: 'get_project_understanding', arguments: { group: '摘要' } });
  assert.equal(deepUnderstanding.result.structuredContent.available, false);
  const project = await call('tools/call', { name: 'inspect_project', arguments: {} });
  assert.ok(project.result.structuredContent.markers.includes('package.json'));
  const patched = await call('tools/call', { name: 'apply_workspace_patch', arguments: { patch: '*** Begin Patch\n*** Add File: from-mcp.txt\n+written by mcp patch\n*** End Patch' } });
  assert.equal(patched.result.structuredContent.count, 1);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'from-mcp.txt'), 'utf8'), 'written by mcp patch');
  const skillList = await call('tools/call', { name: 'list_skills', arguments: {} });
  assert.ok(skillList.result.structuredContent.skills.some((item) => item.name === 'mcp-fixture'));
  const write = await call('tools/call', { name: 'write_workspace_file', arguments: { path: 'deep/new.txt', content: 'MCP 新内容' } });
  assert.equal(write.result.structuredContent.path, 'deep/new.txt');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'deep', 'new.txt'), 'utf8'), 'MCP 新内容');
  const checkpointId = write.result.structuredContent.checkpoint.id;
  const restored = await call('tools/call', { name: 'restore_workspace_checkpoint', arguments: { checkpointId } });
  assert.equal(restored.result.structuredContent.change.action, 'restore');
  await assert.rejects(fs.stat(path.join(workspaceRoot, 'deep', 'new.txt')));
  const missingStage = await call('tools/call', { name: 'get_original_conversation_stage', arguments: { stage: 999 } });
  assert.equal(missingStage.result.isError, true);
  assert.match(missingStage.result.content[0].text, /找不到需求阶段/);
});

test('v3 根能力包 Agent 会自动完成项目取证、文件修改、命令验证并公开工具轨迹', async (t) => {
  const { root, source } = await createFixture();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  const provider = await startAutonomousToolProvider();
  let portable;
  t.after(async () => {
    if (portable?.child.exitCode === null) {
      const exited = new Promise((resolve) => portable.child.once('exit', resolve));
      portable.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await new Promise((resolve) => provider.server.close(resolve));
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await removeTreeWithRetry(root);
  });

  const result = await packageConversationV2({
    sourcePath: source,
    packageId: 'autonomy-v3-fixture',
    packageName: '自动工具闭环验证能力包',
    targets: ['agent'],
    outputRoot: path.join(root, 'packages'),
  });
  const generated = result.package;
  const workspaceRoot = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'agent-state');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), '# 本地项目规则\n先阅读说明，再修改文件。\n', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'autonomy-fixture', scripts: { test: 'node --test' } }), 'utf8');
  portable = await startPortableLauncher(generated.root, {
    CONVERSATION_AGENT_STATE_ROOT: stateRoot,
    CONVERSATION_AGENT_CODEX_HOME: path.join(root, 'no-codex-here'),
    CONVERSATION_AGENT_OPENAI_BASE_URL: provider.baseUrl,
    CONVERSATION_AGENT_OPENAI_API_KEY: 'autonomy-fixture-secret',
    CONVERSATION_AGENT_OPENAI_MODEL: 'autonomy-model',
    CONVERSATION_AGENT_OPENAI_TIMEOUT_MS: '5000',
  });

  const workspaceResponse = await fetch(`${portable.url}/api/runtime/workspace`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: workspaceRoot, allowWrite: true, allowCommand: true, maxSteps: 10 }),
  });
  assert.equal(workspaceResponse.ok, true);
  const workspace = await workspaceResponse.json();
  assert.equal(workspace.ready, true);
  assert.equal(workspace.permissions.write, true);
  assert.equal(workspace.permissions.command, true);

  const agentResponse = await fetch(`${portable.url}/api/runtime/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '执行自动工具闭环验收：读取项目规则，修改结果文件，并完成本地命令验证。', title: '自动工具闭环验收' }),
  });
  assert.equal(agentResponse.ok, true);
  assert.match(agentResponse.headers.get('content-type') || '', /text\/event-stream/);
  const sse = await agentResponse.text();
  assert.match(sse, /event: evidence/);
  assert.match(sse, /event: tool_start/);
  assert.match(sse, /event: tool_result/);
  assert.match(sse, /event: task_complete/);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'autonomous-result.txt'), 'utf8'), '修改后');

  const tasksResponse = await fetch(`${portable.url}/api/runtime/tasks`);
  assert.equal(tasksResponse.ok, true);
  const tasks = await tasksResponse.json();
  assert.equal(tasks.tasks.length, 1);
  const task = tasks.tasks[0];
  assert.equal(task.status, '完成');
  assert.deepEqual(task.toolTrace.map((item) => item.name), [
    'inspect_project',
    'read_project_instructions',
    'write_file',
    'replace_text',
    'execute_command',
    'run_verification',
  ]);
  assert.ok(task.toolTrace.every((item) => item.status === 'success'));
  assert.equal(task.changeJournal.length, 2);
  assert.equal(task.commands.length, 2);
  assert.equal(task.verification.length, 1);
  assert.equal(task.verification[0].passed, true);
  assert.equal(task.checkpoints.length, 2);
  assert.match(task.commands[0].stdout, /修改后\|密钥已隔离/);
  assert.match(task.result, /自动工具闭环已完成/);
  assert.equal(provider.calls.filter((item) => item.url === '/v1/chat/completions').length, 7);
  assert.ok(provider.calls.every((item) => item.authorization !== 'Bearer autonomy-fixture-secret' || item.url === '/v1/chat/completions'));
  assert.doesNotMatch(JSON.stringify({ sse, task }), /autonomy-fixture-secret/);
});
