import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEMPLATE_ROOT = path.resolve('session-forensics/templates/root-capability/agent');
const LIB_ROOT = path.resolve('session-forensics/lib');
const GENERATED_RUNTIME_MODULES = ['session-forensics.mjs', 'session-semantic-index.mjs', 'local-path-picker.mjs'];
const FIXTURE_KEY = 'codex-link-fixture-secret';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function requestJson(url, pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.ok(response.ok, `请求 ${pathname} 失败：${JSON.stringify(body)}`);
  return body;
}

function startAgent(agentRoot, env) {
  const child = spawn(process.execPath, ['agent-server.mjs'], {
    cwd: agentRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Agent 启动超时：${output}`)), 8000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      if (!output.match(/http:\/\/127\.0\.0\.1:(\d+)\//)) {
        clearTimeout(timeout);
        reject(new Error(`Agent 提前退出（${code}）：${output}`));
      }
    });
  });
}

async function prepareAgentFixture(agentRoot) {
  await fs.cp(TEMPLATE_ROOT, agentRoot, { recursive: true });
  const runtimeRoot = path.join(agentRoot, 'runtime');
  await fs.mkdir(runtimeRoot, { recursive: true });
  await Promise.all(GENERATED_RUNTIME_MODULES.map((name) => fs.copyFile(path.join(LIB_ROOT, name), path.join(runtimeRoot, name))));
  await fs.cp(path.join(LIB_ROOT, 'ir'), path.join(runtimeRoot, 'ir'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'compilers'), path.join(runtimeRoot, 'compilers'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'evaluation'), path.join(runtimeRoot, 'evaluation'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'registry'), path.join(runtimeRoot, 'registry'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'evidence'), path.join(runtimeRoot, 'evidence'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'quality'), path.join(runtimeRoot, 'quality'), { recursive: true });
  await fs.cp(path.join(LIB_ROOT, 'source-adapters'), path.join(runtimeRoot, 'source-adapters'), { recursive: true });
}

test('独立 Agent 自动读取当前 Codex 配置并使用 Responses 接口，密钥不泄露', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-current-link-'));
  const agentRoot = path.join(root, 'agent');
  const codexHome = path.join(root, 'current-codex');
  let lastResponsePayload;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'codex-current-model' }, { id: 'codex-current-fast' }] }));
      return;
    }
    if (request.url === '/v1/responses') {
      assert.equal(request.headers.authorization, `Bearer ${FIXTURE_KEY}`);
      lastResponsePayload = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp-current-codex',
        model: 'codex-current-model',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已连接当前 Codex' }] }],
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  const upstreamUrl = await listen(upstream);
  let started = null;
  t.after(async () => {
    if (started?.child.exitCode === null) {
      started.child.kill();
      await new Promise((resolve) => started.child.once('exit', resolve));
    }
    if (upstream.listening) await close(upstream);
    await fs.rm(root, { recursive: true, force: true });
  });
  await prepareAgentFixture(agentRoot);
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "CurrentCodex"',
    'model = "codex-current-model"',
    '',
    '[model_providers.CurrentCodex]',
    'name = "Current Codex"',
    `base_url = "${upstreamUrl}/v1"`,
    'wire_api = "responses"',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(codexHome, 'env.json'), JSON.stringify({ OPENAI_API_KEY: FIXTURE_KEY }), 'utf8');

  started = await startAgent(agentRoot, {
    ...process.env,
    OPENAI_API_KEY: '',
    CODEX_API_KEY: '',
    CONVERSATION_AGENT_CODEX_API_KEY: '',
    CODEX_HOME: codexHome,
    CODEX_CONFIG_HOME: '',
    CONVERSATION_AGENT_CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
    CONVERSATION_AGENT_HOST: '127.0.0.1',
    CONVERSATION_AGENT_PORT: '0',
  });
  const detected = await requestJson(started.url, '/api/runtime/codex-link');
  assert.equal(detected.detected, true);
  assert.equal(detected.canApply, true);
  assert.equal(detected.model, 'codex-current-model');
  assert.equal(detected.wireApi, 'responses');
  assert.equal(detected.hasApiKey, true);
  assert.equal(JSON.stringify(detected).includes(FIXTURE_KEY), false);

  const linked = await requestJson(started.url, '/api/runtime/codex-link', { method: 'POST' });
  assert.equal(linked.applied, true);
  assert.equal(linked.runtime.model, 'codex-current-model');
  assert.equal(linked.runtime.wireApi, 'responses');
  assert.equal(linked.runtime.hasApiKey, true);
  assert.equal(JSON.stringify(linked).includes(FIXTURE_KEY), false);

  const runtime = await requestJson(started.url, '/api/runtime/config');
  assert.equal(runtime.wireApi, 'responses');
  assert.equal(JSON.stringify(runtime).includes(FIXTURE_KEY), false);

  const models = await requestJson(started.url, '/api/runtime/models');
  assert.deepEqual(models.data.map((item) => item.id), ['codex-current-model', 'codex-current-fast']);

  const completion = await requestJson(started.url, '/api/runtime/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'system', content: '你是本地 Agent。' }, { role: 'user', content: '检查当前连接。' }],
      tools: [{ type: 'function', function: { name: 'inspect_project', description: '检查项目', parameters: { type: 'object', properties: {} } } }],
    }),
  });
  assert.equal(completion.choices[0].message.content, '已连接当前 Codex');
  assert.equal(completion._conversationAgent.wireApi, 'responses');
  assert.equal(lastResponsePayload.model, 'codex-current-model');
  assert.equal(lastResponsePayload.input[0].role, 'developer');
  assert.equal(lastResponsePayload.tools[0].name, 'inspect_project');
  assert.equal(JSON.stringify(completion).includes(FIXTURE_KEY), false);
});
