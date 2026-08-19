import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, clamp } from './shared.mjs';

const env = process.env;
const sensitiveEnvironmentPattern = /(key|token|secret|password|credential|authorization|cookie)/i;

export function normaliseWireApi(value) {
  const wireApi = String(value || '').trim().toLowerCase().replace(/[-\s]/g, '_');
  return ['responses', 'response'].includes(wireApi) ? 'responses' : 'chat_completions';
}

export const runtimeConfig = {
  baseUrl: env.CONVERSATION_AGENT_OPENAI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: env.CONVERSATION_AGENT_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
  model: env.CONVERSATION_AGENT_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini',
  wireApi: normaliseWireApi(env.CONVERSATION_AGENT_OPENAI_WIRE_API || env.OPENAI_WIRE_API || 'chat_completions'),
  organization: env.CONVERSATION_AGENT_OPENAI_ORGANIZATION || env.OPENAI_ORGANIZATION || '',
  project: env.CONVERSATION_AGENT_OPENAI_PROJECT || env.OPENAI_PROJECT || '',
  timeoutMs: clamp(env.CONVERSATION_AGENT_OPENAI_TIMEOUT_MS, 3000, 300000, 60000),
};

export const workspaceConfig = {
  root: env.CONVERSATION_AGENT_WORKSPACE_ROOT ? path.resolve(env.CONVERSATION_AGENT_WORKSPACE_ROOT) : '',
  allowWrite: env.CONVERSATION_AGENT_ALLOW_WRITE === '1',
  allowDelete: env.CONVERSATION_AGENT_ALLOW_DELETE === '1',
  allowCommand: env.CONVERSATION_AGENT_ALLOW_COMMAND === '1',
  allowGitWrite: env.CONVERSATION_AGENT_ALLOW_GIT_WRITE === '1',
  allowNetwork: env.CONVERSATION_AGENT_ALLOW_NETWORK === '1',
  skillRoots: String(env.CONVERSATION_AGENT_SKILL_ROOTS || [
    env.CODEX_HOME ? path.join(env.CODEX_HOME, 'skills') : '',
    env.HOME ? path.join(env.HOME, '.codex', 'skills') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, '.codex', 'skills') : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, '.agents', 'skills') : '',
  ].filter(Boolean).join(path.delimiter)).split(path.delimiter).map((item) => item.trim()).filter(Boolean),
  commandTimeoutMs: clamp(env.CONVERSATION_AGENT_COMMAND_TIMEOUT_MS, 1000, 300000, 60000),
  maxSteps: clamp(env.CONVERSATION_AGENT_MAX_STEPS, 1, 60, 24),
};

export function publicRuntimeConfig() {
  return {
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
    wireApi: runtimeConfig.wireApi,
    organization: runtimeConfig.organization,
    project: runtimeConfig.project,
    timeoutMs: runtimeConfig.timeoutMs,
    hasApiKey: Boolean(runtimeConfig.apiKey),
    apiKeySource: runtimeConfig.apiKey ? 'environment-or-memory' : 'none',
    persistence: 'memory-only',
  };
}

export async function publicWorkspaceConfig() {
  let ready = false;
  let error = '';
  if (workspaceConfig.root) {
    try {
      ready = (await fs.stat(workspaceConfig.root)).isDirectory();
      if (!ready) error = '工作区路径不是文件夹。';
    } catch {
      error = '找不到工作区目录。';
    }
  }
  return {
    ...workspaceConfig,
    ready,
    configurationError: error,
    permissions: {
      read: ready,
      write: ready && workspaceConfig.allowWrite,
      delete: ready && workspaceConfig.allowDelete,
      command: ready && workspaceConfig.allowCommand,
      gitWrite: ready && workspaceConfig.allowCommand && workspaceConfig.allowGitWrite,
      network: ready && workspaceConfig.allowNetwork,
    },
  };
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new HttpError(400, 'invalid_base_url', '模型接口地址格式不正确。');
  }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase()) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(local || process.env.CONVERSATION_AGENT_ALLOW_INSECURE_HTTP === '1')) {
    throw new HttpError(400, 'insecure_base_url', '远程模型地址必须使用 HTTPS。');
  }
  return url.toString().replace(/\/$/, '');
}

export function updateRuntimeConfig(payload = {}) {
  if ('baseUrl' in payload) runtimeConfig.baseUrl = validateBaseUrl(payload.baseUrl);
  if ('model' in payload) runtimeConfig.model = String(payload.model || '').trim();
  if (!runtimeConfig.model) throw new HttpError(400, 'model_required', '必须填写模型名称。');
  if ('wireApi' in payload) runtimeConfig.wireApi = normaliseWireApi(payload.wireApi);
  if ('apiKey' in payload && String(payload.apiKey || '').trim()) runtimeConfig.apiKey = String(payload.apiKey).trim();
  if (payload.clearApiKey === true) runtimeConfig.apiKey = '';
  if ('organization' in payload) runtimeConfig.organization = String(payload.organization || '').trim();
  if ('project' in payload) runtimeConfig.project = String(payload.project || '').trim();
  if ('timeoutMs' in payload) runtimeConfig.timeoutMs = clamp(payload.timeoutMs, 3000, 300000, runtimeConfig.timeoutMs);
  return publicRuntimeConfig();
}

export async function updateWorkspaceConfig(payload = {}) {
  if ('root' in payload) workspaceConfig.root = String(payload.root || '').trim() ? path.resolve(String(payload.root).trim()) : '';
  if (workspaceConfig.root) {
    let stat;
    try {
      stat = await fs.stat(workspaceConfig.root);
    } catch {
      throw new HttpError(400, 'workspace_not_found', '找不到这个工作区目录。');
    }
    if (!stat.isDirectory()) throw new HttpError(400, 'workspace_not_directory', '工作区必须是文件夹。');
  }
  if ('allowWrite' in payload) workspaceConfig.allowWrite = payload.allowWrite === true;
  if ('allowDelete' in payload) workspaceConfig.allowDelete = payload.allowDelete === true;
  if ('allowCommand' in payload) workspaceConfig.allowCommand = payload.allowCommand === true;
  if ('allowGitWrite' in payload) workspaceConfig.allowGitWrite = payload.allowGitWrite === true;
  if ('allowNetwork' in payload) workspaceConfig.allowNetwork = payload.allowNetwork === true;
  if ('skillRoots' in payload && Array.isArray(payload.skillRoots)) {
    workspaceConfig.skillRoots = payload.skillRoots.map((item) => String(item || '').trim()).filter(Boolean).map((item) => path.resolve(item));
  }
  if ('commandTimeoutMs' in payload) workspaceConfig.commandTimeoutMs = clamp(payload.commandTimeoutMs, 1000, 300000, workspaceConfig.commandTimeoutMs);
  if ('maxSteps' in payload) workspaceConfig.maxSteps = clamp(payload.maxSteps, 1, 60, workspaceConfig.maxSteps);
  return publicWorkspaceConfig();
}

export function filteredCommandEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentPattern.test(name)));
}
