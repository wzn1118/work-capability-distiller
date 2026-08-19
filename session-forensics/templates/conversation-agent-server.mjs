import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(AGENT_ROOT, '..');
const UI_DIR = path.join(AGENT_ROOT, 'ui');
const BLUEPRINT_PATH = path.join(AGENT_ROOT, 'workflow-blueprint.json');
const CONVERSATION_PATH = path.join(AGENT_ROOT, 'conversation-extraction.json');
const HOST = process.env.CONVERSATION_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.CONVERSATION_AGENT_PORT || 8890);
const JSON_LIMIT = 512 * 1024;
const TOOL_TEXT_LIMIT = 256 * 1024;
const COMMAND_OUTPUT_LIMIT = 96 * 1024;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ALLOW_INSECURE_HTTP = process.env.CONVERSATION_AGENT_ALLOW_INSECURE_HTTP === '1';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

const environmentRuntimeConfig = Object.freeze({
  baseUrl: process.env.CONVERSATION_AGENT_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
  apiKey: process.env.CONVERSATION_AGENT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
  model: process.env.CONVERSATION_AGENT_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  organization: process.env.CONVERSATION_AGENT_OPENAI_ORGANIZATION || process.env.OPENAI_ORGANIZATION || '',
  project: process.env.CONVERSATION_AGENT_OPENAI_PROJECT || process.env.OPENAI_PROJECT || '',
  timeoutMs: boundedNumber(process.env.CONVERSATION_AGENT_OPENAI_TIMEOUT_MS, 60000, 1000, 300000),
});

let runtimeConfig = { ...environmentRuntimeConfig };
let apiKeySource = runtimeConfig.apiKey ? 'environment' : 'none';
let runtimeRevision = 1;

const environmentWorkspaceConfig = Object.freeze({
  root: path.resolve(process.env.CONVERSATION_AGENT_WORKSPACE_ROOT || PACKAGE_ROOT),
  writeEnabled: process.env.CONVERSATION_AGENT_WORKSPACE_WRITE === '1',
  commandEnabled: process.env.CONVERSATION_AGENT_COMMAND_EXECUTION === '1',
  commandTimeoutMs: boundedNumber(process.env.CONVERSATION_AGENT_COMMAND_TIMEOUT_MS, 30000, 1000, 120000),
  maxAgentSteps: boundedNumber(process.env.CONVERSATION_AGENT_MAX_STEPS, 12, 1, 30),
});

let workspaceConfig = { ...environmentWorkspaceConfig };
let workspaceRevision = 1;

class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function cleanText(value, maximum = 4000) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maximum);
}

function boundedText(value, maximum = TOOL_TEXT_LIMIT) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maximum) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maximum) low = middle;
    else high = middle - 1;
  }
  return { text: `${text.slice(0, low)}\n[内容已截断]`, truncated: true };
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.localhost');
}

function isLoopbackRequest(request) {
  const value = String(request.socket.remoteAddress || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function requireLoopbackRequest(request) {
  if (!isLoopbackRequest(request)) {
    throw new HttpError(403, 'local_configuration_only', '模型配置只能从本机回环地址修改。');
  }
}

function normaliseBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(cleanText(value, 2000));
  } catch {
    throw new HttpError(400, 'invalid_base_url', '模型服务地址不是有效的网址。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'invalid_base_url', '模型服务地址只支持 HTTP 或 HTTPS。');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'invalid_base_url', '模型服务地址中不得包含用户名或密码。');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname) && !ALLOW_INSECURE_HTTP) {
    throw new HttpError(
      400,
      'insecure_base_url',
      '非本机模型服务必须使用 HTTPS；如确需内网 HTTP，请设置 CONVERSATION_AGENT_ALLOW_INSECURE_HTTP=1。',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function runtimeEndpoint(resource) {
  const baseUrl = normaliseBaseUrl(runtimeConfig.baseUrl);
  return new URL(cleanText(resource, 100).replace(/^\/+/, ''), `${baseUrl}/`).toString();
}

function publicRuntimeConfig() {
  let baseUrl = cleanText(runtimeConfig.baseUrl, 2000);
  let configurationError = null;
  try {
    baseUrl = normaliseBaseUrl(baseUrl);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }
  return {
    provider: 'openai-compatible',
    baseUrl,
    model: cleanText(runtimeConfig.model, 200),
    organization: cleanText(runtimeConfig.organization, 200),
    project: cleanText(runtimeConfig.project, 200),
    timeoutMs: runtimeConfig.timeoutMs,
    hasApiKey: Boolean(runtimeConfig.apiKey),
    apiKeySource,
    persistence: 'memory-only',
    revision: runtimeRevision,
    ready: !configurationError && Boolean(cleanText(runtimeConfig.model, 200)),
    configurationError,
  };
}

function updateRuntimeConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'invalid_configuration', '模型配置必须是 JSON 对象。');
  }
  const next = { ...runtimeConfig };
  if (Object.prototype.hasOwnProperty.call(payload, 'baseUrl')) next.baseUrl = normaliseBaseUrl(payload.baseUrl);
  if (Object.prototype.hasOwnProperty.call(payload, 'model')) {
    next.model = cleanText(payload.model, 200);
    if (!next.model) throw new HttpError(400, 'invalid_model', '模型名称为必填项。');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'organization')) next.organization = cleanText(payload.organization, 200);
  if (Object.prototype.hasOwnProperty.call(payload, 'project')) next.project = cleanText(payload.project, 200);
  if (Object.prototype.hasOwnProperty.call(payload, 'timeoutMs')) {
    next.timeoutMs = boundedNumber(payload.timeoutMs, next.timeoutMs, 1000, 300000);
  }
  if (payload.clearApiKey === true) {
    next.apiKey = '';
    apiKeySource = 'none';
  } else if (Object.prototype.hasOwnProperty.call(payload, 'apiKey')) {
    next.apiKey = cleanText(payload.apiKey, 8192);
    apiKeySource = next.apiKey ? 'runtime-memory' : 'none';
  }
  runtimeConfig = next;
  runtimeRevision += 1;
  return publicRuntimeConfig();
}

function resetRuntimeConfig() {
  runtimeConfig = { ...environmentRuntimeConfig };
  apiKeySource = runtimeConfig.apiKey ? 'environment' : 'none';
  runtimeRevision += 1;
  return publicRuntimeConfig();
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function existingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new HttpError(400, 'workspace_path_invalid', '工作区路径没有可访问的上级目录。');
      current = parent;
    }
  }
}

async function canonicalWorkspaceRoot(value = workspaceConfig.root) {
  const resolved = path.resolve(cleanText(value, 4000) || PACKAGE_ROOT);
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch {
    throw new HttpError(400, 'workspace_not_found', '工作区目录不存在，请填写已经存在的本地文件夹。');
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new HttpError(400, 'workspace_not_directory', '工作区路径必须是文件夹。');
  return real;
}

async function resolveWorkspacePath(value = '.', { allowMissing = false } = {}) {
  const root = await canonicalWorkspaceRoot();
  const requested = path.resolve(root, cleanText(value, 4000) || '.');
  if (!isPathInside(root, requested)) {
    throw new HttpError(400, 'path_outside_workspace', '请求的文件路径超出了当前工作区。');
  }
  try {
    const real = await fs.realpath(requested);
    if (!isPathInside(root, real)) {
      throw new HttpError(400, 'path_outside_workspace', '请求的文件通过链接指向了工作区外部。');
    }
    return { root, absolute: real, relative: path.relative(root, real) || '.' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (!allowMissing || error?.code !== 'ENOENT') {
      throw new HttpError(404, 'workspace_file_not_found', '工作区中没有找到请求的文件或目录。');
    }
    const ancestor = await existingAncestor(requested);
    const realAncestor = await fs.realpath(ancestor);
    if (!isPathInside(root, realAncestor)) {
      throw new HttpError(400, 'path_outside_workspace', '新文件的上级目录通过链接指向了工作区外部。');
    }
    return { root, absolute: requested, relative: path.relative(root, requested) || '.' };
  }
}

async function publicWorkspaceConfig() {
  let root = path.resolve(workspaceConfig.root);
  let ready = false;
  let configurationError = null;
  try {
    root = await canonicalWorkspaceRoot(root);
    ready = true;
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }
  return {
    root,
    ready,
    writeEnabled: workspaceConfig.writeEnabled === true,
    commandEnabled: workspaceConfig.commandEnabled === true,
    commandTimeoutMs: workspaceConfig.commandTimeoutMs,
    maxAgentSteps: workspaceConfig.maxAgentSteps,
    fileScope: 'workspace-only',
    commandScope: 'current-process-account',
    revision: workspaceRevision,
    configurationError,
  };
}

async function updateWorkspaceConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'invalid_workspace_configuration', '工作区配置必须是 JSON 对象。');
  }
  const next = { ...workspaceConfig };
  if (Object.prototype.hasOwnProperty.call(payload, 'root')) next.root = await canonicalWorkspaceRoot(payload.root);
  if (Object.prototype.hasOwnProperty.call(payload, 'writeEnabled')) next.writeEnabled = payload.writeEnabled === true;
  if (Object.prototype.hasOwnProperty.call(payload, 'commandEnabled')) next.commandEnabled = payload.commandEnabled === true;
  if (Object.prototype.hasOwnProperty.call(payload, 'commandTimeoutMs')) {
    next.commandTimeoutMs = boundedNumber(payload.commandTimeoutMs, next.commandTimeoutMs, 1000, 120000);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'maxAgentSteps')) {
    next.maxAgentSteps = boundedNumber(payload.maxAgentSteps, next.maxAgentSteps, 1, 30);
  }
  workspaceConfig = next;
  workspaceRevision += 1;
  return publicWorkspaceConfig();
}

async function resetWorkspaceConfig() {
  workspaceConfig = { ...environmentWorkspaceConfig };
  workspaceRevision += 1;
  return publicWorkspaceConfig();
}

function providerHeaders(hasBody = false) {
  const headers = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  if (runtimeConfig.apiKey) headers.authorization = `Bearer ${runtimeConfig.apiKey}`;
  if (runtimeConfig.organization) headers['openai-organization'] = runtimeConfig.organization;
  if (runtimeConfig.project) headers['openai-project'] = runtimeConfig.project;
  return headers;
}

function redactSecret(value) {
  const message = String(value || '');
  return runtimeConfig.apiKey ? message.split(runtimeConfig.apiKey).join('[已隐藏]') : message;
}

async function providerFetch(resource, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs);
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  try {
    const { signal: _ignored, ...fetchOptions } = options;
    return await fetch(runtimeEndpoint(resource), { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (externalSignal?.aborted) throw new HttpError(499, 'agent_cancelled', '本次本地任务已停止。');
      throw new HttpError(504, 'provider_timeout', '模型服务响应超时。');
    }
    throw new HttpError(502, 'provider_unreachable', '未能连接模型服务。', {
      reason: redactSecret(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
  }
}

async function readProviderError(upstream) {
  const raw = redactSecret((await upstream.text()).slice(0, 8000));
  let details = raw;
  try {
    details = JSON.parse(raw);
  } catch {
    // Keep bounded plain text when a compatible provider does not return JSON.
  }
  const status = upstream.status >= 500 ? 502 : upstream.status;
  throw new HttpError(status, 'provider_error', '模型服务返回了错误。', {
    upstreamStatus: upstream.status,
    response: details,
  });
}

function workflowContext(blueprint) {
  const distillation = blueprint.distillation || {};
  const compactEvolution = (distillation.requirementEvolution || []).slice(0, 20).map((item) => ({ ...item, request: cleanText(item.request, 2400) }));
  const compactCorrections = (distillation.corrections || []).slice(0, 16).map((item) => ({ ...item, request: cleanText(item.request, 2400), requiredChange: cleanText(item.requiredChange, 1000) }));
  const compactList = (values, limit = 20) => (values || []).slice(0, limit).map((item) => cleanText(item, 1800));
  return {
    package: blueprint.package,
    capabilityGuide: blueprint.capabilityGuide,
    selection: {
      mode: blueprint.selection.mode,
      sessionId: blueprint.selection.sessionId,
      sourceSha256: blueprint.selection.sourceSha256,
      recordCount: blueprint.selection.recordCount,
      normalisedEventCount: blueprint.selection.normalisedEventCount,
    },
    workflow: {
      id: blueprint.workflow.id,
      name: blueprint.workflow.name,
      description: blueprint.workflow.description,
      inputs: blueprint.workflow.inputs,
      steps: blueprint.workflow.steps,
      expectedOutputs: blueprint.workflow.expectedOutputs,
      verification: blueprint.workflow.verification,
      triggers: (blueprint.workflow.triggers || []).slice(0, 24),
    },
    originalConversationImprovement: {
      purpose: distillation.purpose,
      requirementEvolution: compactEvolution,
      corrections: compactCorrections,
      retainedStrengths: compactList(distillation.retainedStrengths, 16),
      weaknesses: compactList(distillation.weaknesses, 20),
      improvedWorkflow: (distillation.improvedWorkflow || []).slice(0, 12),
      acceptanceCriteria: compactList(distillation.acceptanceCriteria, 30),
      recoveryRules: compactList(distillation.recoveryRules, 20),
      evidence: distillation.evidence || {},
    },
    observedTools: (blueprint.evidence.observedTools || []).slice(0, 80),
    implementationFiles: (blueprint.evidence.implementationFiles || []).slice(0, 80),
  };
}

function workflowSystemMessage(blueprint) {
  return [
    '你是由完整 Codex 会话派生的独立智能代理。',
    '必须围绕以下工作流、原对话改进摘要、输入输出合同和验证要求回答。',
    '不要机械复述旧助手回答。后续用户纠正覆盖早期弱要求，同时保留已有工具结果证明有效的做法。',
    '需要确认原要求、工具证据或文件变更时，调用 search_original_conversation 或 get_original_conversation_stage；需要确定改进顺序时调用 get_improved_workflow。',
    '执行时遵循改进工作流：读取最新纠正、回查证据、修正缺口、真实操作、复核验收、交付证据。',
    '不要声称已执行未发生的工具或文件操作。',
    '',
    JSON.stringify(workflowContext(blueprint), null, 2),
  ].join('\n');
}

function localToolDefinitions() {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'search_original_conversation',
        description: '按关键词搜索能力包来源会话中的用户消息、助手回应、工具调用、命令和文件变更。需要改进旧方案时先用它查依据。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的关键词或短句，例如“能力太弱”“独立 UI”“修改文件”。' },
            maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少个需求阶段，默认 10。' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_original_conversation_stage',
        description: '读取指定需求阶段的完整提取证据，包括用户和助手消息、工具参数与结果、命令和文件变更。',
        parameters: {
          type: 'object',
          properties: { stageIndex: { type: 'integer', minimum: 1, description: '需求阶段编号，从 1 开始。' } },
          required: ['stageIndex'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_improved_workflow',
        description: '读取根据原对话纠正和证据整理出的改进后执行流程、验收标准和失败恢复规则。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出当前本地工作区内的文件和目录。用于先了解项目结构。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的目录，默认为当前工作区根目录。' },
            depth: { type: 'integer', minimum: 0, maximum: 5, description: '递归深度，默认 2。' },
            maxEntries: { type: 'integer', minimum: 1, maximum: 1000, description: '最多返回多少项，默认 300。' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取当前工作区内的 UTF-8 文本文件，可指定起止行。修改前应先读取相关文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的文件路径。' },
            startLine: { type: 'integer', minimum: 1, description: '可选，起始行号，从 1 开始。' },
            endLine: { type: 'integer', minimum: 1, description: '可选，结束行号，包含该行。' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
  ];
  if (workspaceConfig.writeEnabled) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '在当前工作区内创建或完整覆盖一个 UTF-8 文本文件。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作区的文件路径。' },
              content: { type: 'string', description: '要写入的完整文件内容。' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'replace_text',
          description: '在当前工作区内精确替换文件文本，适合小范围修改，避免覆盖整个文件。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作区的文件路径。' },
              oldText: { type: 'string', description: '必须在文件中存在的原文本。' },
              newText: { type: 'string', description: '替换后的文本。' },
              replaceAll: { type: 'boolean', description: '是否替换全部匹配项，默认只允许唯一匹配。' },
            },
            required: ['path', 'oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_directory',
          description: '在当前工作区内创建目录，包括缺失的上级目录。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '相对工作区的目录路径。' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    );
  }
  if (workspaceConfig.commandEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'execute_command',
        description: '在当前工作区内执行本地 PowerShell 或 shell 命令，用于检查、构建、测试和验证。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的完整命令。' },
            cwd: { type: 'string', description: '相对工作区的执行目录，默认为工作区根目录。' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '可选超时毫秒数。' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

function agentSystemMessage(blueprint, workspace) {
  const permissions = [
    '可以读取工作区文件',
    workspace.writeEnabled ? '可以创建和修改工作区文件' : '当前未开放文件写入',
    workspace.commandEnabled ? '可以自动执行本地命令并读取结果' : '当前未开放命令执行',
  ].join('；');
  return [
    workflowSystemMessage(blueprint),
    '',
    '你现在还拥有由本机服务真实执行的本地工具。',
    `本地工作区：${workspace.root}`,
    `当前权限：${permissions}。`,
    '处理代码或文件任务时，先检查相关文件，再进行最小范围修改，并执行合适的检查或测试。',
    '工具返回失败时，读取错误并调整方案；不要把未发生的操作描述为已完成。',
    '最终答复应直白列出实际修改、实际命令结果、仍存在的问题以及相关文件路径。',
  ].join('\n');
}

function requireWritePermission() {
  if (!workspaceConfig.writeEnabled) {
    throw new HttpError(403, 'workspace_write_disabled', '当前没有开启工作区文件修改权限。');
  }
}

function requireCommandPermission() {
  if (!workspaceConfig.commandEnabled) {
    throw new HttpError(403, 'command_execution_disabled', '当前没有开启本地命令执行权限。');
  }
}

async function listWorkspaceFiles(args) {
  const target = await resolveWorkspacePath(args.path || '.');
  const stat = await fs.stat(target.absolute);
  if (!stat.isDirectory()) throw new HttpError(400, 'workspace_not_directory', 'list_files 的路径必须是目录。');
  const depth = boundedNumber(args.depth, 2, 0, 5);
  const maxEntries = boundedNumber(args.maxEntries, 300, 1, 1000);
  const entries = [];
  async function visit(directory, relativeBase, remainingDepth) {
    if (entries.length >= maxEntries) return;
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      const absolute = path.join(directory, child.name);
      const relative = path.join(relativeBase, child.name).split(path.sep).join('/');
      if (child.isSymbolicLink()) {
        entries.push({ path: relative, type: 'symbolic-link' });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory' });
        if (remainingDepth > 0) await visit(absolute, relative, remainingDepth - 1);
      } else if (child.isFile()) {
        const info = await fs.stat(absolute);
        entries.push({ path: relative, type: 'file', bytes: info.size });
      }
    }
  }
  await visit(target.absolute, target.relative === '.' ? '' : target.relative, depth);
  return { ok: true, path: target.relative, entries, truncated: entries.length >= maxEntries };
}

async function readWorkspaceFile(args) {
  const target = await resolveWorkspacePath(args.path);
  const stat = await fs.stat(target.absolute);
  if (!stat.isFile()) throw new HttpError(400, 'workspace_not_file', 'read_file 的路径必须是文件。');
  if (stat.size > TOOL_TEXT_LIMIT * 4) throw new HttpError(413, 'workspace_file_too_large', '文件过大，请指定更小的文本文件。');
  const buffer = await fs.readFile(target.absolute);
  if (buffer.includes(0)) throw new HttpError(400, 'workspace_binary_file', '当前工具只读取文本文件。');
  const allLines = buffer.toString('utf8').split(/\r?\n/);
  const startLine = boundedNumber(args.startLine, 1, 1, Math.max(1, allLines.length));
  const endLine = boundedNumber(args.endLine, allLines.length, startLine, allLines.length);
  const bounded = boundedText(allLines.slice(startLine - 1, endLine).join('\n'));
  return {
    ok: true,
    path: target.relative,
    startLine,
    endLine,
    totalLines: allLines.length,
    content: bounded.text,
    truncated: bounded.truncated,
  };
}

async function writeWorkspaceFile(args) {
  requireWritePermission();
  const target = await resolveWorkspacePath(args.path, { allowMissing: true });
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > TOOL_TEXT_LIMIT * 4) {
    throw new HttpError(413, 'workspace_write_too_large', '单次写入内容超过 1 MB 限制。');
  }
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  await fs.writeFile(target.absolute, content, 'utf8');
  return { ok: true, path: target.relative, bytes: Buffer.byteLength(content), action: 'written' };
}

async function replaceWorkspaceText(args) {
  requireWritePermission();
  const target = await resolveWorkspacePath(args.path);
  const oldText = String(args.oldText ?? '');
  const newText = String(args.newText ?? '');
  if (!oldText) throw new HttpError(400, 'old_text_required', 'replace_text 必须提供非空 oldText。');
  const source = await fs.readFile(target.absolute, 'utf8');
  const occurrences = source.split(oldText).length - 1;
  if (!occurrences) throw new HttpError(409, 'old_text_not_found', '文件中没有找到要替换的原文本。');
  if (!args.replaceAll && occurrences !== 1) {
    throw new HttpError(409, 'old_text_not_unique', `原文本出现 ${occurrences} 次；请提供更精确的文本，或明确设置 replaceAll。`);
  }
  const updated = args.replaceAll ? source.split(oldText).join(newText) : source.replace(oldText, newText);
  await fs.writeFile(target.absolute, updated, 'utf8');
  return { ok: true, path: target.relative, replacements: args.replaceAll ? occurrences : 1, action: 'replaced' };
}

async function createWorkspaceDirectory(args) {
  requireWritePermission();
  const target = await resolveWorkspacePath(args.path, { allowMissing: true });
  await fs.mkdir(target.absolute, { recursive: true });
  return { ok: true, path: target.relative, action: 'directory-created' };
}

function commandEnvironment() {
  const result = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/key|token|secret|password|credential|authorization/i.test(name)) continue;
    result[name] = value;
  }
  return result;
}

async function executeWorkspaceCommand(args, signal) {
  requireCommandPermission();
  const command = cleanText(args.command, 10000);
  if (!command) throw new HttpError(400, 'command_required', 'execute_command 必须提供命令。');
  const directory = await resolveWorkspacePath(args.cwd || '.');
  const stat = await fs.stat(directory.absolute);
  if (!stat.isDirectory()) throw new HttpError(400, 'command_cwd_not_directory', '命令执行目录必须是工作区内的文件夹。');
  const timeoutMs = boundedNumber(args.timeoutMs, workspaceConfig.commandTimeoutMs, 1000, 120000);
  const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command];
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, shellArgs, {
      cwd: directory.absolute,
      env: commandEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const append = (current, chunk) => {
      if (Buffer.byteLength(current, 'utf8') >= COMMAND_OUTPUT_LIMIT) return current;
      return boundedText(current + chunk.toString('utf8'), COMMAND_OUTPUT_LIMIT).text;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const stop = () => {
      aborted = true;
      child.kill();
    };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      reject(new HttpError(500, 'command_start_failed', '本地命令没有成功启动。', { reason: error.message }));
    });
    child.once('close', (exitCode, closeSignal) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted,
        command,
        cwd: directory.relative,
        exitCode,
        signal: closeSignal,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

function conversationEvidenceItems(stage) {
  return [
    ...(stage.userMessages || []).map((item) => ({ kind: '用户消息', eventIndex: item.eventIndex, text: item.text })),
    ...(stage.assistantMessages || []).map((item) => ({ kind: '助手回应', eventIndex: item.eventIndex, text: item.text })),
    ...(stage.toolCalls || []).map((item) => ({
      kind: '工具调用',
      eventIndex: item.eventIndex,
      text: `${item.name || ''}\n参数：${item.arguments || ''}\n结果：${item.result?.excerpt || ''}`,
    })),
    ...(stage.commands || []).map((item) => ({ kind: '本地命令', eventIndex: item.eventIndex, text: item.command })),
    ...(stage.fileChanges || []).map((item) => ({ kind: '文件变更', eventIndex: item.eventIndex, text: `${item.path || ''} ${item.action || ''} ${item.role || ''}` })),
  ];
}

function evidenceExcerpt(value, query, maximum = 1800) {
  const source = String(value || '').trim();
  const lower = source.toLowerCase();
  const position = lower.indexOf(query.toLowerCase());
  const start = position >= 0 ? Math.max(0, position - 350) : 0;
  const excerpt = source.slice(start, start + maximum);
  return `${start > 0 ? '……' : ''}${excerpt}${start + maximum < source.length ? '……' : ''}`;
}

async function searchOriginalConversation(args) {
  const query = cleanText(args.query, 500);
  if (!query) throw new HttpError(400, 'conversation_query_required', '请提供要搜索的原对话关键词。');
  const maximum = boundedNumber(args.maxResults, 10, 1, 20);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const extraction = await loadConversationExtraction();
  const ranked = [];
  for (const stage of extraction.stages || []) {
    const items = conversationEvidenceItems(stage);
    const searchable = `${stage.title || ''}\n${stage.request || ''}\n${items.map((item) => item.text).join('\n')}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (searchable.includes(term) ? 1 : 0), 0);
    if (!score) continue;
    const matches = items
      .filter((item) => terms.some((term) => String(item.text || '').toLowerCase().includes(term)))
      .slice(0, 8)
      .map((item) => ({ ...item, text: evidenceExcerpt(item.text, terms.find((term) => String(item.text || '').toLowerCase().includes(term)) || query) }));
    ranked.push({
      score,
      stage: stage.index,
      title: stage.title,
      changeType: stage.changeType,
      changeLabel: stage.changeLabel,
      request: evidenceExcerpt(stage.request, terms.find((term) => String(stage.request || '').toLowerCase().includes(term)) || query, 2400),
      toolNames: stage.toolNames || [],
      matches,
    });
  }
  ranked.sort((left, right) => right.score - left.score || Number(right.stage) - Number(left.stage));
  return { ok: true, query, count: Math.min(ranked.length, maximum), results: ranked.slice(0, maximum) };
}

async function getOriginalConversationStage(args) {
  const stageIndex = boundedNumber(args.stageIndex, 0, 1, Number.MAX_SAFE_INTEGER);
  const extraction = await loadConversationExtraction();
  const stage = (extraction.stages || []).find((item) => Number(item.index) === stageIndex);
  if (!stage) throw new HttpError(404, 'conversation_stage_not_found', '未找到指定的原对话需求阶段。');
  return {
    ok: true,
    stage: {
      ...stage,
      userMessages: (stage.userMessages || []).slice(0, 30),
      assistantMessages: (stage.assistantMessages || []).slice(0, 30),
      toolCalls: (stage.toolCalls || []).slice(0, 60),
      commands: (stage.commands || []).slice(0, 60),
      fileChanges: (stage.fileChanges || []).slice(0, 60),
    },
  };
}

async function getImprovedWorkflow() {
  const extraction = await loadConversationExtraction();
  return {
    ok: true,
    purpose: extraction.distillation?.purpose || extraction.purpose,
    corrections: extraction.corrections || [],
    retainedStrengths: extraction.strengths || [],
    weaknesses: extraction.weaknesses || [],
    improvedWorkflow: extraction.improvedWorkflow || [],
    acceptanceCriteria: extraction.acceptanceCriteria || [],
    recoveryRules: extraction.recoveryRules || [],
  };
}

async function executeLocalTool(name, args, signal) {
  try {
    if (name === 'search_original_conversation') return await searchOriginalConversation(args);
    if (name === 'get_original_conversation_stage') return await getOriginalConversationStage(args);
    if (name === 'get_improved_workflow') return await getImprovedWorkflow();
    if (name === 'list_files') return await listWorkspaceFiles(args);
    if (name === 'read_file') return await readWorkspaceFile(args);
    if (name === 'write_file') return await writeWorkspaceFile(args);
    if (name === 'replace_text') return await replaceWorkspaceText(args);
    if (name === 'create_directory') return await createWorkspaceDirectory(args);
    if (name === 'execute_command') return await executeWorkspaceCommand(args, signal);
    throw new HttpError(400, 'unknown_local_tool', `未识别本地工具：${name}`);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof HttpError ? error.code : 'local_tool_error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}),
      },
    };
  }
}

function parseToolArguments(toolCall) {
  const raw = toolCall?.function?.arguments;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { __invalidArguments: raw };
  }
}

function normaliseMessages(payload) {
  let messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length && cleanText(payload.objective, 20000)) {
    const inputs = payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
      ? payload.inputs
      : {};
    messages = [{
      role: 'user',
      content: `${cleanText(payload.objective, 20000)}\n\n已有输入：${JSON.stringify(inputs)}`,
    }];
  }
  if (!messages.length) {
    throw new HttpError(400, 'messages_required', '请提供 messages，或提供 objective 作为本次对话目标。');
  }
  if (messages.length > 100) throw new HttpError(400, 'too_many_messages', '单次请求最多包含 100 条消息。');
  const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);
  const output = messages.map((message) => {
    if (!message || typeof message !== 'object' || !allowedRoles.has(message.role)) {
      throw new HttpError(400, 'invalid_message', '消息角色只支持 system、user、assistant 或 tool。');
    }
    const hasToolCalls = message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (typeof message.content !== 'string' && !Array.isArray(message.content) && !(message.content === null && hasToolCalls)) {
      throw new HttpError(400, 'invalid_message', '消息内容必须是文本或 OpenAI 兼容的内容数组。');
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: cleanText(message.name, 200) } : {}),
      ...(message.tool_call_id ? { tool_call_id: cleanText(message.tool_call_id, 300) } : {}),
      ...(hasToolCalls ? { tool_calls: message.tool_calls } : {}),
      ...(message.function_call && typeof message.function_call === 'object'
        ? { function_call: message.function_call }
        : {}),
    };
  });
  if (JSON.stringify(output).length > 240000) {
    throw new HttpError(413, 'messages_too_large', '对话消息总长度超过限制。');
  }
  return output;
}

function completionPayload(blueprint, payload) {
  const model = cleanText(payload.model || runtimeConfig.model, 200);
  if (!model) throw new HttpError(400, 'model_required', '请先配置模型名称。');
  const body = {
    model,
    stream: payload.stream === true,
    messages: [{ role: 'system', content: workflowSystemMessage(blueprint) }, ...normaliseMessages(payload)],
  };
  const optionalKeys = [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'stop',
    'response_format',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'seed',
    'user',
  ];
  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
  }
  return body;
}

function agentCompletionPayload(blueprint, payload, workspace, messages) {
  const model = cleanText(payload.model || runtimeConfig.model, 200);
  if (!model) throw new HttpError(400, 'model_required', '请先配置模型名称。');
  const body = {
    model,
    stream: false,
    messages: [{ role: 'system', content: agentSystemMessage(blueprint, workspace) }, ...messages],
    tools: localToolDefinitions(),
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
  const optionalKeys = [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'stop',
    'response_format',
    'seed',
    'user',
  ];
  for (const key of optionalKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
  }
  return body;
}

async function providerChatJson(body, signal) {
  const upstream = await providerFetch('chat/completions', {
    method: 'POST',
    headers: providerHeaders(true),
    body: JSON.stringify(body),
    signal,
  });
  if (!upstream.ok) await readProviderError(upstream);
  try {
    return await upstream.json();
  } catch {
    throw new HttpError(502, 'invalid_provider_response', '模型服务返回的对话结果不是有效 JSON。');
  }
}

function assistantText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => cleanText(part?.text || part?.content || '', 200000)).join('');
  }
  return '';
}

function serialisableToolArguments(args) {
  if (args?.__invalidArguments !== undefined) {
    return { raw: cleanText(args.__invalidArguments, 12000), invalid: true };
  }
  return args;
}

async function runAgentLoop(blueprint, payload, { signal, onEvent = () => {} } = {}) {
  const workspace = await publicWorkspaceConfig();
  if (!workspace.ready) {
    throw new HttpError(400, 'workspace_not_ready', workspace.configurationError || '请先选择有效的本地工作区。');
  }
  const messages = normaliseMessages(payload);
  const trace = [];
  let lastProviderResponse = null;

  for (let step = 1; step <= workspace.maxAgentSteps; step += 1) {
    if (signal?.aborted) throw new HttpError(499, 'agent_cancelled', '本次本地任务已停止。');
    onEvent({ type: 'status', step, message: `第 ${step} 轮：人工智能正在判断下一步。` });
    const body = agentCompletionPayload(blueprint, payload, workspace, messages);
    lastProviderResponse = await providerChatJson(body, signal);
    const assistant = lastProviderResponse?.choices?.[0]?.message;
    if (!assistant || typeof assistant !== 'object') {
      throw new HttpError(502, 'missing_assistant_message', '模型服务没有返回有效的人工智能消息。');
    }
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    messages.push({
      role: 'assistant',
      content: assistant.content ?? (toolCalls.length ? null : ''),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls.length) {
      const content = assistantText(assistant);
      return {
        id: lastProviderResponse.id || `conversation-agent-${randomUUID()}`,
        object: 'chat.completion',
        created: lastProviderResponse.created || Math.floor(Date.now() / 1000),
        model: lastProviderResponse.model || body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: lastProviderResponse?.choices?.[0]?.finish_reason || 'stop',
        }],
        usage: lastProviderResponse.usage,
        _conversationAgent: {
          packageId: blueprint.package.id,
          workflowId: blueprint.workflow.id,
          model: body.model,
          workspace,
          steps: step,
          toolTrace: trace,
        },
      };
    }

    for (const toolCall of toolCalls) {
      if (signal?.aborted) throw new HttpError(499, 'agent_cancelled', '本次本地任务已停止。');
      const id = cleanText(toolCall?.id || randomUUID(), 300);
      const name = cleanText(toolCall?.function?.name, 200);
      const args = parseToolArguments(toolCall);
      const visibleArgs = serialisableToolArguments(args);
      onEvent({ type: 'tool_start', step, id, name, arguments: visibleArgs });
      const startedAt = Date.now();
      const result = args.__invalidArguments !== undefined
        ? { ok: false, error: { code: 'invalid_tool_arguments', message: '模型给出的工具参数不是有效 JSON。' } }
        : await executeLocalTool(name, args, signal);
      const traceEntry = {
        step,
        id,
        name,
        arguments: visibleArgs,
        result,
        durationMs: Date.now() - startedAt,
      };
      trace.push(traceEntry);
      onEvent({ type: 'tool_result', ...traceEntry });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        name,
        content: JSON.stringify(result),
      });
    }
  }
  throw new HttpError(
    508,
    'agent_step_limit',
    `人工智能已达到 ${workspace.maxAgentSteps} 轮工具调用上限，请缩小任务或提高“最多自动步骤”。`,
    { toolTrace: trace },
  );
}

function writeAgentEvent(response, event) {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function runLocalAgent(response, blueprint, payload, request) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.once('aborted', cancel);
  response.once('close', () => {
    if (!response.writableEnded) cancel();
  });
  try {
    if (payload.stream === true) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const data = await runAgentLoop(blueprint, payload, {
        signal: controller.signal,
        onEvent: (event) => writeAgentEvent(response, event),
      });
      writeAgentEvent(response, {
        type: 'assistant',
        content: data.choices[0].message.content,
        message: data.choices[0].message,
        meta: data._conversationAgent,
      });
      writeAgentEvent(response, { type: 'done', meta: data._conversationAgent });
      if (!response.writableEnded) response.end('data: [DONE]\n\n');
      return;
    }
    sendJson(response, 200, await runAgentLoop(blueprint, payload, { signal: controller.signal }));
  } catch (error) {
    if (!response.headersSent) throw error;
    writeAgentEvent(response, {
      type: 'error',
      error: {
        code: error instanceof HttpError ? error.code : 'agent_error',
        message: error instanceof Error ? error.message : '人工智能执行本地任务时发生错误。',
        ...(error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}),
      },
    });
    if (!response.writableEnded) response.end('data: [DONE]\n\n');
  } finally {
    request.removeListener('aborted', cancel);
  }
}

async function listProviderModels() {
  const upstream = await providerFetch('models', { headers: providerHeaders(false) });
  if (!upstream.ok) await readProviderError(upstream);
  try {
    return await upstream.json();
  } catch {
    throw new HttpError(502, 'invalid_provider_response', '模型服务返回的模型列表不是有效 JSON。');
  }
}

async function runChatCompletion(response, blueprint, payload) {
  const body = completionPayload(blueprint, payload);
  const upstream = await providerFetch('chat/completions', {
    method: 'POST',
    headers: providerHeaders(true),
    body: JSON.stringify(body),
  });
  if (!upstream.ok) await readProviderError(upstream);
  if (body.stream) {
    if (!upstream.body) throw new HttpError(502, 'empty_provider_stream', '模型服务没有返回可读取的流。');
    response.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
    return;
  }
  let data;
  try {
    data = await upstream.json();
  } catch {
    throw new HttpError(502, 'invalid_provider_response', '模型服务返回的对话结果不是有效 JSON。');
  }
  data._conversationAgent = {
    packageId: blueprint.package.id,
    workflowId: blueprint.workflow.id,
    model: body.model,
  };
  sendJson(response, 200, data);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error) {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : '智能代理处理请求时发生内部错误。';
  sendJson(response, status, {
    error: {
      code,
      message,
      requestId: randomUUID(),
      ...(error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

async function loadBlueprint() {
  return JSON.parse(await fs.readFile(BLUEPRINT_PATH, 'utf8'));
}

let conversationExtractionPromise;
async function loadConversationExtraction() {
  if (!conversationExtractionPromise) {
    conversationExtractionPromise = fs.readFile(CONVERSATION_PATH, 'utf8').then((value) => JSON.parse(value));
  }
  try {
    return await conversationExtractionPromise;
  } catch (error) {
    conversationExtractionPromise = undefined;
    throw error;
  }
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new HttpError(413, 'request_too_large', '请求内容过大，请缩短对话或输入后重试。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是有效 JSON。');
  }
}

function preparePlan(blueprint, payload) {
  const objective = String(payload.objective || '').trim();
  if (!objective) throw new HttpError(400, 'objective_required', '请填写本次要处理的目标。');
  const inputs = payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
    ? payload.inputs
    : {};
  return {
    package: blueprint.package,
    objective,
    selection: blueprint.selection,
    providedInputs: inputs,
    steps: (blueprint.distillation?.improvedWorkflow?.length ? blueprint.distillation.improvedWorkflow : blueprint.workflow.steps.map((name) => ({ name, description: name }))).map((step, index) => ({
      order: index + 1,
      name: step.name || step,
      instruction: `围绕“${objective}”执行：${step.description || step.name || step}`,
      status: '待执行',
    })),
    expectedOutputs: blueprint.workflow.expectedOutputs,
    verification: blueprint.workflow.verification,
    triggers: blueprint.workflow.triggers,
  };
}

async function readNamedArtifact(blueprint, name) {
  const files = {
    manifest: 'package-manifest.json',
    packageGuide: blueprint.delivery.guideFile || 'README.md',
    skill: blueprint.delivery.skill && blueprint.delivery.skill.skillFile,
    mcpConfig: blueprint.delivery.mcp && blueprint.delivery.mcp.configFile,
    readme: blueprint.delivery.agent && blueprint.delivery.agent.readmeFile,
    aiProfile: blueprint.delivery.agent && blueprint.delivery.agent.aiProfileFile,
    envExample: blueprint.delivery.agent && blueprint.delivery.agent.envExampleFile,
    conversationExtraction: 'conversation-extraction.json',
  };
  const relative = files[name];
  if (!relative) throw new HttpError(404, 'artifact_not_found', '未找到请求的能力包文件。');
  const candidate = path.resolve(PACKAGE_ROOT, relative);
  const check = path.relative(PACKAGE_ROOT, candidate);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new HttpError(400, 'artifact_path_outside_package', '能力包文件路径超出允许范围。');
  }
  return { relative, content: await fs.readFile(candidate) };
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}/`);
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const blueprint = await loadBlueprint();
    const address = server.address();
    sendJson(response, 200, {
      ok: true,
      service: 'conversation-derived-agent',
      package: blueprint.package,
      port: address && typeof address === 'object' ? address.port : PORT,
      runtime: publicRuntimeConfig(),
      workspace: await publicWorkspaceConfig(),
    });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/health', '/api/ai/status'].includes(url.pathname)) {
    const blueprint = await loadBlueprint();
    sendJson(response, 200, {
      ok: true,
      service: 'openai-compatible-runtime',
      packageId: blueprint.package.id,
      workflowId: blueprint.workflow.id,
      runtime: publicRuntimeConfig(),
      workspace: await publicWorkspaceConfig(),
    });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/config', '/api/ai/config'].includes(url.pathname)) {
    sendJson(response, 200, { runtime: publicRuntimeConfig() });
    return;
  }
  if (request.method === 'PUT' && ['/api/runtime/config', '/api/ai/config'].includes(url.pathname)) {
    requireLoopbackRequest(request);
    sendJson(response, 200, { runtime: updateRuntimeConfig(await readBody(request)) });
    return;
  }
  if (request.method === 'DELETE' && ['/api/runtime/config', '/api/ai/config'].includes(url.pathname)) {
    requireLoopbackRequest(request);
    sendJson(response, 200, { runtime: resetRuntimeConfig() });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/workspace', '/api/ai/workspace'].includes(url.pathname)) {
    sendJson(response, 200, { workspace: await publicWorkspaceConfig() });
    return;
  }
  if (request.method === 'PUT' && ['/api/runtime/workspace', '/api/ai/workspace'].includes(url.pathname)) {
    requireLoopbackRequest(request);
    sendJson(response, 200, { workspace: await updateWorkspaceConfig(await readBody(request)) });
    return;
  }
  if (request.method === 'DELETE' && ['/api/runtime/workspace', '/api/ai/workspace'].includes(url.pathname)) {
    requireLoopbackRequest(request);
    sendJson(response, 200, { workspace: await resetWorkspaceConfig() });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/tools', '/api/ai/tools'].includes(url.pathname)) {
    sendJson(response, 200, {
      workspace: await publicWorkspaceConfig(),
      tools: localToolDefinitions(),
    });
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/context', '/api/ai/context'].includes(url.pathname)) {
    sendJson(response, 200, workflowContext(await loadBlueprint()));
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/distillation', '/api/ai/distillation'].includes(url.pathname)) {
    const blueprint = await loadBlueprint();
    sendJson(response, 200, { distillation: blueprint.distillation || {} });
    return;
  }
  if (request.method === 'POST' && ['/api/runtime/conversation/search', '/api/ai/conversation/search'].includes(url.pathname)) {
    sendJson(response, 200, await searchOriginalConversation(await readBody(request)));
    return;
  }
  if (request.method === 'GET' && ['/api/runtime/models', '/api/ai/models', '/v1/models'].includes(url.pathname)) {
    const models = await listProviderModels();
    if (url.pathname === '/v1/models') sendJson(response, 200, models);
    else sendJson(response, 200, { ...models, _conversationAgent: { runtime: publicRuntimeConfig() } });
    return;
  }
  if (request.method === 'POST' && ['/api/runtime/chat', '/api/ai/chat', '/v1/chat/completions'].includes(url.pathname)) {
    await runChatCompletion(response, await loadBlueprint(), await readBody(request));
    return;
  }
  if (request.method === 'POST' && ['/api/runtime/agent', '/api/ai/agent'].includes(url.pathname)) {
    await runLocalAgent(response, await loadBlueprint(), await readBody(request), request);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/workflow') {
    sendJson(response, 200, await loadBlueprint());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/prepare') {
    const blueprint = await loadBlueprint();
    sendJson(response, 200, preparePlan(blueprint, await readBody(request)));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/artifact') {
    const blueprint = await loadBlueprint();
    const artifact = await readNamedArtifact(blueprint, url.searchParams.get('name') || '');
    response.writeHead(200, {
      'content-type': MIME[path.extname(artifact.relative)] || 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': artifact.content.length,
    });
    response.end(artifact.content);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'GET') {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.resolve(UI_DIR, relative);
    const check = path.relative(UI_DIR, filePath);
    if (!check.startsWith('..') && !path.isAbsolute(check)) {
      try {
        const body = await fs.readFile(filePath);
        response.writeHead(200, {
          'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
          'cache-control': 'no-store',
          'content-length': body.length,
        });
        response.end(body);
        return;
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
    }
  }
  sendText(response, 404, '未找到请求的页面或接口。');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => sendError(response, error));
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = address && typeof address === 'object' ? address.port : PORT;
  process.stdout.write(`会话派生智能代理已启动：http://${HOST}:${activePort}/\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
