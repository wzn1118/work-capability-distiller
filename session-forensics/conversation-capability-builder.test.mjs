import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildConversationCapabilityBuilder } from './lib/conversation-capability-builder.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID_TWO = 'bbbbbbbb-cccc-7ddd-8eee-ffffffffffff';

function fixtureContent(sessionId = SESSION_ID, request = '分析评论和视频内容，生成营销洞察报告。') {
  const rows = [
    { timestamp: '2026-08-16T10:00:00.000Z', type: 'session_meta', payload: { session_id: sessionId, cwd: 'C:/workspace' } },
    { timestamp: '2026-08-16T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } },
    { timestamp: '2026-08-16T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', arguments: JSON.stringify({ cmd: 'node --test' }) } },
    { timestamp: '2026-08-16T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'exit code: 0' } },
    { timestamp: '2026-08-16T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成初步报告。' }] } },
    { timestamp: '2026-08-16T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '必须根据原对话专属生成 UI，并保留后续修正。' }] } },
  ];
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

async function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(`http://127.0.0.1:${match[1]}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('外部安装器可导入、AI 蒸馏、预览并导出会话专属能力包', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'conversation-builder-test-'));
  const stateRoot = path.join(root, 'state');
  const projectRoot = path.join(root, '关联项目');
  const localCodexRoot = path.join(root, 'codex-home', 'sessions');
  await fsp.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsp.mkdir(path.join(projectRoot, 'output'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'comment-insight-project', type: 'module' }, null, 2), 'utf8');
  await fsp.writeFile(path.join(projectRoot, 'src', 'analyse.mjs'), 'export function analyse(rows) { return rows.length; }\n', 'utf8');
  await fsp.writeFile(path.join(projectRoot, 'output', 'report.md'), '# 评论洞察报告\n\n由项目流程生成。\n', 'utf8');
  await fsp.mkdir(localCodexRoot, { recursive: true });
  await fsp.writeFile(path.join(localCodexRoot, `rollout-${SESSION_ID}.jsonl`), fixtureContent(), 'utf8');
  const built = await buildConversationCapabilityBuilder({ outputRoot: path.join(root, 'builder') });
  const builderServerSource = await fsp.readFile(path.join(process.cwd(), 'session-forensics', 'conversation-capability-builder', 'server.mjs'), 'utf8');
  assert.match(builderServerSource, /BUNDLED_LIB_ROOT/);
  assert.match(builderServerSource, /path\.join\(APP_ROOT, '\.\.', 'lib'\)/);
  for (const file of ['README.md', 'server.mjs', 'launcher.mjs', 'launch.cmd', 'install-and-start.cmd', 'ui/index.html', 'ui/app.js', 'ui/styles.css', 'lib/root-capability-packager.mjs', 'lib/session-forensics.mjs', 'lib/session-source-index.mjs', 'lib/session-semantic-index.mjs', 'lib/semantic-distillation-v2.mjs', 'lib/conversation-evidence-sources.mjs', 'lib/project-discovery.mjs', 'lib/project-evidence.mjs', 'lib/project-understanding.mjs', 'lib/project-knowledge-v4.mjs', 'lib/distillation-recommendation.mjs', 'lib/local-path-picker.mjs', 'lib/scope-policy.mjs', 'lib/package-work-capability.mjs', 'lib/ir/work-capability-ir.mjs', 'lib/evidence/content-addressed-evidence.mjs', 'lib/quality/metric-eligibility-engine.mjs', 'lib/source-adapters/source-identity-resolver.mjs', 'templates/root-capability/agent/ui/capability-ui.json']) {
    if (file.endsWith('capability-ui.json')) continue;
    await assert.doesNotReject(fsp.stat(path.join(built.root, file)));
  }
  const builderHtml = await fsp.readFile(path.join(built.root, 'ui', 'index.html'), 'utf8');
  assert.match(builderHtml, /id="session-list"/);
  assert.match(builderHtml, /本机 Codex 对话/);
  assert.match(builderHtml, /id="model-api-key" type="password"/);
  assert.match(builderHtml, /id="project-path" readonly/);
  assert.match(builderHtml, /id="pick-project-path"/);
  assert.match(builderHtml, /id="project-candidate-list"/);
  assert.match(builderHtml, /id="package-catalog-list"/);
  const builderUiScript = await fsp.readFile(path.join(built.root, 'ui', 'app.js'), 'utf8');
  assert.match(builderUiScript, /\/api\/v2\/path-picker/);
  assert.match(builderUiScript, /\/api\/v3\/sessions/);
  assert.match(builderUiScript, /\/api\/v3\/task-chains/);
  assert.match(builderUiScript, /完整任务链目录/);
  assert.match(builderUiScript, /selectProjectCandidate/);
  assert.match(builderUiScript, /data-project-candidate-path/);
  assert.match(builderUiScript, /改用此项目并重新蒸馏/);
  assert.match(builderUiScript, /\/api\/v3\/packages/);
  assert.match(builderUiScript, /data-package-agent-start/);
  assert.match(builderUiScript, /data-result-agent-start/);
  assert.match(builderUiScript, /启动并进入产物工作台/);
  assert.match(builderUiScript, /startPackageAgent/);
  const builderStyles = await fsp.readFile(path.join(built.root, 'ui', 'styles.css'), 'utf8');
  assert.match(builderStyles, /\.knowledge-table-wrap \{[^}]*contain: inline-size/);
  assert.match(builderStyles, /\.result-actions \{[^}]*display: grid/);

  const fakeModel = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') return response.end();
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.match(body, /完整会话|目的|产出/);
    const content = JSON.stringify({ identity: { title: '评论洞察专属工作台', subtitle: '从素材到营销判断' }, purpose: '读取评论和视频素材，输出可验证的营销洞察。', primaryAction: { label: '开始洞察' } });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const modelPort = fakeModel.address().port;
  t.after(() => fakeModel.close());

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: built.root,
    env: { ...process.env, CONVERSATION_BUILDER_PORT: '0', CONVERSATION_BUILDER_NO_BROWSER: '1', CONVERSATION_BUILDER_STATE_ROOT: stateRoot, CODEX_SESSION_ROOT: localCodexRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let agentChild;
  t.after(async () => {
    await stop(agentChild);
    await stop(child);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const baseUrl = await waitForUrl(child);
  const health = await fetch(`${baseUrl}/api/v2/health`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.localCodexDiscovery, true);
  assert.ok(healthPayload.localPathPicker.includes('directory'));
  const invalidBuilderPicker = await fetch(`${baseUrl}/api/v2/path-picker`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'invalid' }) });
  assert.equal(invalidBuilderPicker.status, 400);
  assert.match((await invalidBuilderPicker.json()).error, /选择类型无效/);
  const localSessions = await fetch(`${baseUrl}/api/v3/sessions?limit=20`);
  assert.equal(localSessions.status, 200);
  const localSessionPayload = await localSessions.json();
  const fixtureSession = localSessionPayload.sessions.find((item) => item.sessionId === SESSION_ID);
  assert.ok(fixtureSession);
  assert.equal(fixtureSession.title, '分析评论和视频内容，生成营销洞察报告。');
  assert.equal(localSessionPayload.totalAvailable, 1);
  assert.ok(Array.isArray(localSessionPayload.taskChains));
  const taskChainsResponse = await fetch(`${baseUrl}/api/v3/task-chains?limit=20`);
  assert.equal(taskChainsResponse.status, 200);
  const taskChains = await taskChainsResponse.json();
  assert.equal(taskChains.totalAvailable, 1);
  assert.equal(taskChains.taskChains[0].sessionIds.includes(SESSION_ID), true);
  const previewResponse = await fetch(`${baseUrl}/api/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    sources: [
      { name: '评论分析.jsonl', content: fixtureContent() },
      { name: '项目复核.jsonl', content: fixtureContent(SESSION_ID_TWO, '复核 src/analyse.mjs 和 output/report.md，保留项目文件证据并改进交付。') },
    ],
    projectPath: projectRoot,
    projectScope: 'project',
    contextMode: 'project-relevant',
    projectConfirmed: true,
    ai: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'fixture-model' },
  }) });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.ok, true);
  assert.equal(preview.ui.identity.title, '评论洞察专属工作台');
  assert.equal(preview.ui.generation.method, 'model');
  assert.ok(preview.ui.inputs.length > 0);
  assert.ok(preview.ui.deliverables.length > 0);
  assert.ok(preview.ui.capabilities.length > 0);
  assert.equal(preview.sourceSet.sessionCount, 2);
  assert.equal(preview.projectDiscovery.mode, '人工指定');
  assert.equal(preview.projectEvidence.project.name, '关联项目');
  assert.equal(preview.projectKnowledgeV4.schemaVersion, '4.1.0');
  assert.equal(preview.projectKnowledgeV4.summary.sessions, 2);
  assert.ok(preview.projectKnowledgeV4.summary.projectFiles >= 3);
  assert.ok(preview.projectKnowledgeV4.semanticStages.length > 0);
  assert.ok(preview.projectKnowledgeV4.crossSessionTimeline.length > 0);
  assert.ok(preview.projectKnowledgeV4.fileChangeMatrix.length > 0);
  assert.ok(Array.isArray(preview.projectKnowledgeV4.dependencyImpact.nodes));
  assert.ok(Array.isArray(preview.projectKnowledgeV4.dependencyImpact.changedFiles));
  assert.ok(Array.isArray(preview.projectKnowledgeV4.artifactReproducibility));
  assert.ok(preview.projectKnowledgeV4.projectSnapshot.project);
  assert.ok(preview.recommendation);
  assert.ok(preview.recommendation.priorities.length > 0);
  assert.match(preview.links.recommendation, /^\/api\/v2\/runs\//);
  const recommendationResponse = await fetch(`${baseUrl}${preview.links.recommendation}`);
  assert.equal(recommendationResponse.status, 200);
  assert.ok((await recommendationResponse.json()).recommendation);
  const localPreviewResponse = await fetch(`${baseUrl}/api/v2/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: [SESSION_ID], projectPath: projectRoot, projectScope: 'project', contextMode: 'project-relevant', projectConfirmed: true, ai: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'fixture-model' } }) });
  assert.equal(localPreviewResponse.status, 200, await localPreviewResponse.clone().text());
  const localPreview = await localPreviewResponse.json();
  assert.equal(localPreview.sourceSet.sessionCount, 1);
  assert.equal(localPreview.sourceSet.sessions[0].title, '分析评论和视频内容，生成营销洞察报告。');
  assert.ok(localPreview.recommendation.priorities.length > 0);

  const generateResponse = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ importId: preview.importId, targets: ['skill', 'mcp', 'agent'], ai: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'fixture-model' }, uiOverrides: { purpose: '用户确认过的营销洞察目标。' } }) });
  assert.equal(generateResponse.status, 201);
  const generated = await generateResponse.json();
  assert.equal(generated.ok, true);
  assert.match(generated.name, /评论.*视频.*洞察.*报告/);
  assert.match(generated.archive, /^\/api\/v3\/packages\//);
  assert.ok(generated.documents?.distillation);
  assert.ok(generated.recommendation);
  assert.ok(generated.agent.ui.endsWith(`${path.sep}index.html`) || generated.agent.ui.endsWith('/index.html'));
  assert.match(await fsp.readFile(generated.guide, 'utf8'), /评论洞察专属工作台/);
  assert.match(await fsp.readFile(generated.guide, 'utf8'), /项目知识/);
  assert.equal(generated.projectKnowledgeV4Summary.sessions, 2);
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'project-knowledge-v4.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'cross-session-timeline.ndjson')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'file-change-matrix.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'dependency-impact.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'artifact-reproducibility.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'project-snapshot.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'open-evidence-questions.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'distillation-recommendation.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.root, 'PRIORITY-PLAN.md')));
  await assert.doesNotReject(fsp.stat(path.join(generated.agent.directory, 'distillation-recommendation.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.agent.directory, 'project-knowledge-v4.json')));
  await assert.doesNotReject(fsp.stat(path.join(generated.agent.directory, 'runtime', 'session-forensics.mjs')));
  await assert.doesNotReject(fsp.stat(path.join(generated.agent.directory, 'runtime', 'session-semantic-index.mjs')));
  await assert.doesNotReject(fsp.stat(path.join(generated.agent.directory, 'runtime', 'local-path-picker.mjs')));
  const generatedAgentUi = await fsp.readFile(generated.agent.ui, 'utf8');
  assert.match(generatedAgentUi, /自动加载本机 Codex 对话/);
  assert.match(generatedAgentUi, /id="local-session-list"/);
  assert.match(generatedAgentUi, /id="local-task-chain-list"/);
  assert.match(generatedAgentUi, /全部已选会话的最新阶段证据/);
  assert.match(generatedAgentUi, /id="workspace-root" name="root" type="text" readonly/);
  assert.match(generatedAgentUi, /id="pick-workspace-root"/);
  const generatedAgentScript = await fsp.readFile(path.join(generated.agent.directory, 'ui', 'app.js'), 'utf8');
  assert.match(generatedAgentScript, /\/api\/runtime\/local-sessions/);
  assert.match(generatedAgentScript, /\/api\/runtime\/task-chains/);
  assert.match(generatedAgentScript, /loadLocalTaskChains/);
  assert.match(generatedAgentScript, /loadSelectedLocalSessions/);
  assert.match(generatedAgentScript, /localConversationContext/);
  assert.match(generatedAgentScript, /\/api\/runtime\/path-picker/);
  const generatedAgentProfile = JSON.parse(await fsp.readFile(path.join(generated.agent.directory, 'ai-profile.json'), 'utf8'));
  assert.equal(generatedAgentProfile.features.localCodexConversationDiscovery, true);
  assert.equal(generatedAgentProfile.features.localCodexConversationLoading, true);
  assert.equal(generatedAgentProfile.features.localCodexTaskChainDiscovery, true);
  assert.equal(generatedAgentProfile.features.dynamicLocalConversationContext, true);
  assert.equal(generatedAgentProfile.features.loadedConversationContextTool, true);
  assert.equal(generatedAgentProfile.features.nativePathSelection, true);
  assert.equal(generatedAgentProfile.endpoints.localSessions, '/api/runtime/local-sessions');
  assert.equal(generatedAgentProfile.endpoints.localTaskChains, '/api/runtime/task-chains');
  assert.equal(generatedAgentProfile.endpoints.pathPicker, '/api/runtime/path-picker');

  agentChild = spawn(process.execPath, ['agent-server.mjs'], {
    cwd: generated.agent.directory,
    env: {
      ...process.env,
      PORT: '0',
      CODEX_SESSION_ROOT: localCodexRoot,
      CONVERSATION_AGENT_OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      CONVERSATION_AGENT_OPENAI_MODEL: 'fixture-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agentUrl = await waitForUrl(agentChild);
  const agentHealth = await fetch(`${agentUrl}/api/runtime/health`);
  assert.equal(agentHealth.status, 200);
  assert.ok((await agentHealth.json()).localPathPicker.includes('directory'));
  const invalidAgentPicker = await fetch(`${agentUrl}/api/runtime/path-picker`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'invalid' }) });
  assert.equal(invalidAgentPicker.status, 400);
  assert.match((await invalidAgentPicker.json()).error.message, /选择类型无效/);
  const agentSessionsResponse = await fetch(`${agentUrl}/api/runtime/local-sessions?limit=20`);
  assert.equal(agentSessionsResponse.status, 200);
  const agentSessions = await agentSessionsResponse.json();
  const agentFixtureSession = agentSessions.sessions.find((item) => item.sessionId === SESSION_ID);
  assert.ok(agentFixtureSession);
  assert.equal(agentFixtureSession.title, '分析评论和视频内容，生成营销洞察报告。');
  assert.equal(agentSessions.totalAvailable, 1);
  assert.ok(Array.isArray(agentSessions.taskChains));
  const agentTaskChainsResponse = await fetch(`${agentUrl}/api/runtime/task-chains?limit=20`);
  assert.equal(agentTaskChainsResponse.status, 200);
  const agentTaskChains = await agentTaskChainsResponse.json();
  assert.equal(agentTaskChains.totalAvailable, 1);
  assert.equal(agentTaskChains.taskChains[0].sessionIds.includes(SESSION_ID), true);
  const loadedResponse = await fetch(`${agentUrl}/api/runtime/local-sessions/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionIds: [SESSION_ID] }),
  });
  assert.equal(loadedResponse.status, 200);
  const loaded = await loadedResponse.json();
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].session.title, '分析评论和视频内容，生成营销洞察报告。');
  assert.match(loaded.taskPrefill, /分析评论和视频内容，生成营销洞察报告。/);
  assert.match(loaded.taskPrefill, /P1｜/);
  assert.equal(loaded.context.sessionCount, 1);
  assert.ok(loaded.context.stageCount >= 1);
  assert.match(loaded.context.executionBrief, /最新阶段证据/);
  const taskCreation = await fetch(`${agentUrl}/api/runtime/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '验证动态会话上下文注入。', localConversationContext: { ...loaded.context, sessions: loaded.sessions } }),
  });
  assert.equal(taskCreation.status, 201);
  const createdTask = await taskCreation.json();
  assert.equal(createdTask.localConversationContext.sessionCount, 1);
  assert.match(createdTask.localConversationContext.executionBrief, /完整会话索引/);
  assert.equal(createdTask.localConversationContext.loadedSessionCount, 1);
  const runtimeTools = await fetch(`${agentUrl}/api/runtime/tools`);
  assert.equal(runtimeTools.status, 200);
  assert.ok((await runtimeTools.json()).tools.some((tool) => tool.name === 'get_loaded_local_conversation_context'));
  const download = await fetch(`${baseUrl}${generated.archive}`);
  assert.equal(download.status, 200);
  const archive = Buffer.from(await download.arrayBuffer());
  assert.equal(archive.subarray(0, 4).toString('ascii'), 'PK\x03\x04');
  const catalogResponse = await fetch(`${baseUrl}/api/v3/packages`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const catalogEntry = catalog.packages.find((entry) => entry.id === generated.packageId);
  assert.ok(catalogEntry);
  assert.equal(catalogEntry.hasAgent, true);
  assert.equal(catalogEntry.agent.available, true);
  assert.equal(catalogEntry.agent.running, false);
  const startCatalogAgentResponse = await fetch(`${baseUrl}/api/v3/packages/${encodeURIComponent(generated.packageId)}/agent/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(startCatalogAgentResponse.status, 201, await startCatalogAgentResponse.clone().text());
  const startedCatalogAgent = await startCatalogAgentResponse.json();
  assert.match(startedCatalogAgent.agent.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(startedCatalogAgent.agent.running, true);
  const catalogAgentHealth = await fetch(`${startedCatalogAgent.agent.url}/api/runtime/health`);
  assert.equal(catalogAgentHealth.status, 200);
  const catalogAgentStatus = await fetch(`${baseUrl}/api/v3/packages/${encodeURIComponent(generated.packageId)}/agent`);
  assert.equal(catalogAgentStatus.status, 200);
  assert.equal((await catalogAgentStatus.json()).agent.running, true);
  const stopCatalogAgentResponse = await fetch(`${baseUrl}/api/v3/packages/${encodeURIComponent(generated.packageId)}/agent/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(stopCatalogAgentResponse.status, 200);
  assert.equal((await stopCatalogAgentResponse.json()).agent.running, false);
  const documentResponse = await fetch(`${baseUrl}${generated.documents.distillation}`);
  assert.equal(documentResponse.status, 200);
  assert.match(await documentResponse.text(), /语义质量检查/);
});
