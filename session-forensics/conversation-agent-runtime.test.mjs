import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageConversationLegacy as packageConversation } from './lib/conversation-packager.mjs';

const SESSION_ID = '22222222-3333-7444-8555-666666666666';

async function createSessionFixture(root) {
  const source = path.join(root, `rollout-2026-08-15T12-00-00-${SESSION_ID}.jsonl`);
  const rows = [
    {
      timestamp: '2026-08-15T12:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: SESSION_ID, cwd: 'C:/workspace' },
    },
    {
      timestamp: '2026-08-15T12:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: 'C:/workspace' },
    },
    {
      timestamp: '2026-08-15T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '把完整会话封装成可运行的独立智能体。' }],
      },
    },
    {
      timestamp: '2026-08-15T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'functions.exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'node --test' }),
      },
    },
    {
      timestamp: '2026-08-15T12:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'exit code: 0' },
    },
    {
      timestamp: '2026-08-15T12:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '独立智能体已生成并完成验证。' }],
      },
    },
    {
      timestamp: '2026-08-15T12:00:06.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-2', cwd: 'C:/workspace' },
    },
    {
      timestamp: '2026-08-15T12:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '现在能力还是太弱了，必须提取原对话中的用户纠正、工具证据和文件变更，再按改进工作流执行。' }],
      },
    },
    {
      timestamp: '2026-08-15T12:00:08.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '已记录新的改进要求。' }],
      },
    },
  ];
  await fs.writeFile(source, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return source;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const rawBody = await readRequestBody(request);
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization || '',
      body,
    });

    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const hasProviderErrorRequest = body.messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('trigger-provider-error'),
      );
      if (hasProviderErrorRequest) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `upstream echoed ${request.headers.authorization}` } }));
        return;
      }
      const hasLocalAgentRequest = body.messages.some(
        (message) => typeof message.content === 'string' && message.content.includes('run-local-agent'),
      );
      if (hasLocalAgentRequest) {
        const toolMessages = body.messages.filter((message) => message.role === 'tool');
        const lastTool = toolMessages.at(-1);
        let message;
        if (!lastTool) {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'conversation-search',
              type: 'function',
              function: { name: 'search_original_conversation', arguments: JSON.stringify({ query: '太弱', maxResults: 5 }) },
            }],
          };
        } else if (lastTool.name === 'search_original_conversation') {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'local-write',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'execution-result.txt', content: '修改前' }) },
            }],
          };
        } else if (lastTool.name === 'write_file') {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'local-replace',
              type: 'function',
              function: { name: 'replace_text', arguments: JSON.stringify({ path: 'execution-result.txt', oldText: '修改前', newText: '修改后' }) },
            }],
          };
        } else if (lastTool.name === 'replace_text') {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'local-command',
              type: 'function',
              function: {
                name: 'execute_command',
                arguments: JSON.stringify({
                  command: 'node -e "const fs=require(\'fs\');process.stdout.write(fs.readFileSync(\'execution-result.txt\',\'utf8\')+\'|\'+(process.env.CONVERSATION_AGENT_OPENAI_API_KEY?\'密钥泄漏\':\'密钥已隔离\'))"',
                }),
              },
            }],
          };
        } else {
          message = { role: 'assistant', content: '本地任务已完成' };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'local-agent-loop',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.end('data: {"id":"chat-stream","choices":[{"delta":{"content":"流式结果"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chat-non-stream',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '模型执行结果' }, finish_reason: 'stop' }],
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    calls,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

function waitForAgentUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`等待智能体启动超时。stdout=${output} stderr=${errors}`)), 10000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      cleanup();
      resolve(`http://127.0.0.1:${match[1]}`);
    };
    const onStderr = (chunk) => {
      errors += chunk.toString('utf8');
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`智能体在启动前退出，退出码 ${code}。stderr=${errors}`));
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

test('generated Agent provides a secret-safe OpenAI-compatible runtime', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-agent-runtime-'));
  const workspaceDir = path.join(root, 'workspace');
  await fs.mkdir(workspaceDir);
  const provider = await startProvider();
  let child;
  t.after(async () => {
    if (child) await stopChild(child);
    await new Promise((resolve) => provider.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const sourcePath = await createSessionFixture(root);
  const result = await packageConversation({
    sourcePath,
    packageId: 'runtime-fixture',
    packageName: '独立智能体运行时测试',
    targets: ['agent'],
    outputRoot: path.join(root, 'packages'),
  });
  const generated = result.package.delivery.agent;

  assert.ok((await fs.stat(generated.server)).isFile());
  assert.ok((await fs.stat(generated.aiProfile)).isFile());
  assert.ok((await fs.stat(generated.readme)).isFile());
  assert.ok((await fs.stat(generated.envExample)).isFile());
  assert.ok((await fs.stat(generated.workflow)).isFile());
  assert.ok((await fs.stat(generated.conversationExtraction)).isFile());
  assert.ok((await fs.stat(generated.ui.index)).isFile());

  const profile = JSON.parse(await fs.readFile(generated.aiProfile, 'utf8'));
  assert.equal(profile.provider, 'openai-compatible');
  assert.equal(profile.schemaVersion, '4.0.0');
  assert.equal(profile.secretsPersisted, false);
  assert.equal(profile.features.streaming, true);
  assert.equal(profile.endpoints.chat, '/api/runtime/chat');
  assert.equal(profile.endpoints.workspace, '/api/runtime/workspace');
  assert.equal(profile.endpoints.tools, '/api/runtime/tools');
  assert.equal(profile.endpoints.agent, '/api/runtime/agent');
  assert.equal(profile.endpoints.distillation, '/api/runtime/distillation');
  assert.equal(profile.endpoints.conversationSearch, '/api/runtime/conversation/search');
  assert.equal(profile.compatibilityAliases.status, '/api/ai/status');
  assert.equal(profile.compatibilityAliases.config, '/api/ai/config');
  assert.equal(profile.compatibilityAliases.chat, '/api/ai/chat');
  assert.equal(profile.compatibilityAliases.agent, '/api/ai/agent');
  assert.equal(profile.features.autonomousToolLoop, true);
  assert.equal(profile.features.fileWriteWithExplicitPermission, true);
  assert.equal(profile.features.commandExecutionWithExplicitPermission, true);
  assert.equal(profile.features.visibleToolTrace, true);
  assert.equal(profile.features.originalConversationExtraction, true);
  assert.equal(profile.features.originalConversationSearch, true);
  assert.equal(profile.features.improvedWorkflow, true);
  assert.equal(profile.features.beginnerGuidedSetup, true);
  assert.equal(profile.features.verifiedConnectionGate, true);
  assert.equal(profile.features.errorRecovery, true);
  assert.equal(profile.defaults.apiKey, undefined);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /密钥只保存在当前进程内存/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /node agent-server\.mjs/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /\/api\/ai\/status/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /\/api\/ai\/config/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /\/api\/ai\/chat/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /\/api\/runtime\/agent/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /允许自动执行本地命令/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /三个原对话工具/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /六个工作区工具/);
  assert.match(await fs.readFile(generated.readme, 'utf8'), /提取并改进原对话/);
  assert.match(await fs.readFile(generated.envExample, 'utf8'), /CONVERSATION_AGENT_OPENAI_API_KEY=\n/);
  assert.match(await fs.readFile(generated.envExample, 'utf8'), /CONVERSATION_AGENT_WORKSPACE_WRITE=0/);
  assert.match(await fs.readFile(generated.envExample, 'utf8'), /CONVERSATION_AGENT_COMMAND_EXECUTION=0/);

  child = spawn(process.execPath, [generated.server], {
    cwd: generated.root,
    env: {
      ...process.env,
      PORT: '0',
      CONVERSATION_AGENT_OPENAI_BASE_URL: provider.baseUrl,
      CONVERSATION_AGENT_OPENAI_API_KEY: 'fixture-secret',
      CONVERSATION_AGENT_OPENAI_MODEL: 'mock-model',
      CONVERSATION_AGENT_OPENAI_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agentUrl = await waitForAgentUrl(child);

  const uiResponse = await fetch(`${agentUrl}/`);
  assert.equal(uiResponse.status, 200);
  const uiHtml = await uiResponse.text();
  assert.match(uiHtml, /<html lang="zh-CN">/);
  assert.match(uiHtml, /<form id="config-form"/);
  assert.match(uiHtml, /<form id="workspace-form"/);
  assert.match(uiHtml, /<form id="chat-form"/);
  assert.match(uiHtml, /class="setup-progress"/);
  assert.match(uiHtml, /保存并检查连接/);
  assert.match(uiHtml, /id="prompt-examples"/);
  assert.match(uiHtml, /id="retry-chat"/);
  assert.match(uiHtml, /id="send-chat"/);
  assert.match(uiHtml, /id="stop-chat"/);
  assert.match(uiHtml, /真实模型 \+ 本地工具自动循环/);
  assert.match(uiHtml, /允许创建和修改文件/);
  assert.match(uiHtml, /允许自动执行本地命令/);
  assert.match(uiHtml, /本地执行能力/);
  assert.match(uiHtml, /工具执行记录/);
  assert.match(uiHtml, /提取并改进原对话/);
  assert.match(uiHtml, /原对话提炼/);
  assert.match(uiHtml, /id="distillation-panel"/);

  const uiScriptResponse = await fetch(`${agentUrl}/app.js`);
  assert.equal(uiScriptResponse.status, 200);
  const uiScript = await uiScriptResponse.text();
  assert.match(uiScript, /config-form.*addEventListener\('submit'/s);
  assert.match(uiScript, /chat-form.*addEventListener\('submit'/s);
  assert.match(uiScript, /\/api\/runtime\/config/);
  assert.match(uiScript, /\/api\/runtime\/models/);
  assert.match(uiScript, /\/api\/runtime\/workspace/);
  assert.match(uiScript, /\/api\/runtime\/agent/);
  assert.match(uiScript, /getReader\(\)/);
  assert.match(uiScript, /tool_start/);
  assert.match(uiScript, /tool_result/);
  assert.match(uiScript, /blueprint\.distillation/);
  assert.match(uiScript, /search_original_conversation/);
  assert.match(uiScript, /get_original_conversation_stage/);
  assert.match(uiScript, /get_improved_workflow/);
  assert.match(uiScript, /function friendlyError/);
  assert.match(uiScript, /function saveAndCheckConnection/);
  assert.match(uiScript, /function saveWorkspace/);
  assert.match(uiScript, /navigator\.clipboard\.writeText/);
  assert.match(uiScript, /new Blob\(/);

  const statusResponse = await fetch(`${agentUrl}/api/ai/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.ok, true);
  assert.equal(status.runtime.hasApiKey, true);
  assert.equal(status.runtime.apiKeySource, 'environment');
  assert.equal(status.runtime.persistence, 'memory-only');
  assert.doesNotMatch(JSON.stringify(status), /fixture-secret/);

  const configResponse = await fetch(`${agentUrl}/api/ai/config`);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.runtime.model, 'mock-model');
  assert.equal(config.runtime.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(config), /fixture-secret/);

  const distillationResponse = await fetch(`${agentUrl}/api/runtime/distillation`);
  assert.equal(distillationResponse.status, 200);
  const distillation = await distillationResponse.json();
  assert.equal(distillation.distillation.evidence.correctionCount, 1);
  assert.ok(distillation.distillation.corrections.some((item) => item.request.includes('能力还是太弱')));

  const conversationSearchResponse = await fetch(`${agentUrl}/api/runtime/conversation/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '太弱', maxResults: 5 }),
  });
  assert.equal(conversationSearchResponse.status, 200);
  const conversationSearch = await conversationSearchResponse.json();
  assert.equal(conversationSearch.ok, true);
  assert.ok(conversationSearch.results.some((item) => item.stage === 2));

  const initialWorkspaceResponse = await fetch(`${agentUrl}/api/runtime/workspace`);
  assert.equal(initialWorkspaceResponse.status, 200);
  const initialWorkspace = await initialWorkspaceResponse.json();
  assert.equal(initialWorkspace.workspace.writeEnabled, false);
  assert.equal(initialWorkspace.workspace.commandEnabled, false);

  const workspaceResponse = await fetch(`${agentUrl}/api/ai/workspace`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root: workspaceDir,
      writeEnabled: true,
      commandEnabled: true,
      commandTimeoutMs: 5000,
      maxAgentSteps: 8,
    }),
  });
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json();
  assert.equal(workspace.workspace.root, await fs.realpath(workspaceDir));
  assert.equal(workspace.workspace.writeEnabled, true);
  assert.equal(workspace.workspace.commandEnabled, true);

  const toolsResponse = await fetch(`${agentUrl}/api/runtime/tools`);
  assert.equal(toolsResponse.status, 200);
  const tools = await toolsResponse.json();
  assert.deepEqual(
    tools.tools.map((item) => item.function.name),
    ['search_original_conversation', 'get_original_conversation_stage', 'get_improved_workflow', 'list_files', 'read_file', 'write_file', 'replace_text', 'create_directory', 'execute_command'],
  );

  const modelsResponse = await fetch(`${agentUrl}/api/ai/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.data[0].id, 'mock-model');
  assert.equal(provider.calls.at(-1).authorization, 'Bearer fixture-secret');

  const chatResponse = await fetch(`${agentUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: '执行工作流并使用工具。' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      ],
      tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }),
  });
  assert.equal(chatResponse.status, 200);
  const chat = await chatResponse.json();
  assert.equal(chat.choices[0].message.content, '模型执行结果');
  assert.equal(chat._conversationAgent.packageId, 'runtime-fixture');
  const nonStreamCall = provider.calls.at(-1);
  assert.equal(nonStreamCall.body.messages[0].role, 'system');
  assert.match(nonStreamCall.body.messages[0].content, /runtime-fixture/);
  assert.match(nonStreamCall.body.messages[0].content, /originalConversationImprovement/);
  assert.match(nonStreamCall.body.messages[0].content, /后续用户纠正/);
  assert.deepEqual(nonStreamCall.body.messages[2].tool_calls[0].function, { name: 'inspect', arguments: '{}' });
  assert.equal(nonStreamCall.body.tools[0].function.name, 'inspect');

  const localAgentResponse = await fetch(`${agentUrl}/api/runtime/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'run-local-agent' }] }),
  });
  assert.equal(localAgentResponse.status, 200);
  const localAgent = await localAgentResponse.json();
  assert.equal(localAgent.choices[0].message.content, '本地任务已完成');
  assert.equal(await fs.readFile(path.join(workspaceDir, 'execution-result.txt'), 'utf8'), '修改后');
  assert.deepEqual(
    localAgent._conversationAgent.toolTrace.map((item) => item.name),
    ['search_original_conversation', 'write_file', 'replace_text', 'execute_command'],
  );
  assert.equal(localAgent._conversationAgent.toolTrace[0].result.ok, true);
  assert.ok(localAgent._conversationAgent.toolTrace[0].result.results.some((item) => item.stage === 2));
  const commandResult = localAgent._conversationAgent.toolTrace.at(-1).result;
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.exitCode, 0);
  assert.match(commandResult.stdout, /修改后\|密钥已隔离/);
  assert.doesNotMatch(JSON.stringify(localAgent), /fixture-secret/);

  const localAgentStreamResponse = await fetch(`${agentUrl}/api/ai/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'run-local-agent' }], stream: true }),
  });
  assert.equal(localAgentStreamResponse.status, 200);
  assert.match(localAgentStreamResponse.headers.get('content-type'), /text\/event-stream/);
  const localAgentStream = await localAgentStreamResponse.text();
  assert.match(localAgentStream, /"type":"tool_start"/);
  assert.match(localAgentStream, /"type":"tool_result"/);
  assert.match(localAgentStream, /"type":"assistant"/);
  assert.match(localAgentStream, /data: \[DONE\]/);

  const updateResponse = await fetch(`${agentUrl}/api/ai/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'runtime-secret', model: 'mock-model-2' }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.runtime.apiKeySource, 'runtime-memory');
  assert.equal(updated.runtime.model, 'mock-model-2');
  assert.doesNotMatch(JSON.stringify(updated), /runtime-secret/);

  const streamResponse = await fetch(`${agentUrl}/api/runtime/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '流式执行' }], stream: true }),
  });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
  assert.match(await streamResponse.text(), /data: \[DONE\]/);
  assert.equal(provider.calls.at(-1).authorization, 'Bearer runtime-secret');

  const providerErrorResponse = await fetch(`${agentUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'trigger-provider-error' }] }),
  });
  assert.equal(providerErrorResponse.status, 401);
  const providerErrorText = await providerErrorResponse.text();
  assert.match(providerErrorText, /provider_error/);
  assert.doesNotMatch(providerErrorText, /runtime-secret/);

  const resetResponse = await fetch(`${agentUrl}/api/runtime/config`, { method: 'DELETE' });
  const reset = await resetResponse.json();
  assert.equal(reset.runtime.apiKeySource, 'environment');
  assert.equal(reset.runtime.model, 'mock-model');
  assert.doesNotMatch(JSON.stringify(reset), /fixture-secret/);

  const generatedFiles = [generated.server, generated.aiProfile, generated.readme, generated.envExample, generated.workflow, generated.conversationExtraction];
  for (const filePath of generatedFiles) {
    const contents = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(contents, /fixture-secret|runtime-secret/);
  }
});
