import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normaliseWireApi, updateRuntimeConfig } from './config.mjs';

const env = process.env;

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function decodeTomlValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const closing = text.lastIndexOf('"');
    if (closing > 0) {
      try { return JSON.parse(text.slice(0, closing + 1)); } catch { return text.slice(1, closing); }
    }
  }
  if (text.startsWith("'")) {
    const closing = text.lastIndexOf("'");
    if (closing > 0) return text.slice(1, closing);
  }
  return text.replace(/\s+#.*$/, '').trim();
}

function parseCodexToml(content) {
  const root = {};
  const providers = new Map();
  let providerName = '';
  for (const line of String(content || '').split(/\r?\n/)) {
    const section = line.trim().match(/^\[model_providers\.([^\]]+)\]$/);
    if (section) {
      providerName = decodeTomlValue(section[1]);
      if (!providers.has(providerName)) providers.set(providerName, {});
      continue;
    }
    if (line.trim().startsWith('[')) {
      providerName = '';
      continue;
    }
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!pair || line.trim().startsWith('#')) continue;
    const value = decodeTomlValue(pair[2]);
    if (providerName) providers.get(providerName)[pair[1]] = value;
    else root[pair[1]] = value;
  }
  return { root, providers };
}

function codexHomes() {
  const home = env.HOME || env.USERPROFILE || '';
  return unique([
    env.CONVERSATION_AGENT_CODEX_HOME,
    env.CODEX_HOME,
    env.CODEX_CONFIG_HOME,
    home ? path.join(home, '.codex') : '',
  ]);
}

async function readFirstToml() {
  const candidates = unique([env.CONVERSATION_AGENT_CODEX_CONFIG, ...codexHomes().map((home) => path.join(home, 'config.toml'))]);
  for (const filePath of candidates) {
    try {
      return { filePath, ...parseCodexToml(await fs.readFile(filePath, 'utf8')) };
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
  }
  return { filePath: '', root: {}, providers: new Map() };
}

async function readCodexKeyFile(homes) {
  const candidates = unique([
    env.CONVERSATION_AGENT_CODEX_ENV_FILE,
    ...homes.map((home) => path.join(home, 'auth.json')),
    ...homes.map((home) => path.join(home, 'env.json')),
  ]);
  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      let parsed = {};
      try { parsed = JSON.parse(content); } catch {
        for (const line of content.split(/\r?\n/)) {
          const pair = line.match(/^\s*(OPENAI_API_KEY|CODEX_API_KEY)\s*=\s*([^#\s]+)\s*$/);
          if (pair) parsed[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
        }
      }
      const apiKey = String(parsed?.OPENAI_API_KEY || parsed?.CODEX_API_KEY || '').trim();
      if (apiKey) return { apiKey, source: path.basename(filePath) };
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
  }
  return { apiKey: '', source: '' };
}

function publicLink(candidate) {
  return {
    detected: Boolean(candidate.baseUrl && candidate.model),
    canApply: Boolean(candidate.baseUrl && candidate.model),
    applied: false,
    baseUrl: candidate.baseUrl || '',
    model: candidate.model || '',
    wireApi: candidate.wireApi,
    hasApiKey: Boolean(candidate.apiKey),
    provider: candidate.provider || '',
    configurationSource: candidate.configurationSource || '',
    credentialSource: candidate.credentialSource || '',
    message: candidate.baseUrl && candidate.model
      ? '已找到当前 Codex 的模型接口配置。'
      : '未找到可直接使用的当前 Codex 配置，可在下方手动填写模型接口。',
  };
}

async function resolveCurrentCodex() {
  const homes = codexHomes();
  const config = await readFirstToml();
  const requestedProvider = String(config.root.model_provider || '').trim();
  const provider = config.providers.get(requestedProvider) || config.providers.values().next().value || {};
  const explicitApiKey = String(env.CONVERSATION_AGENT_CODEX_API_KEY || env.CODEX_API_KEY || '').trim();
  const fileKey = explicitApiKey ? { apiKey: '', source: '' } : await readCodexKeyFile(homes);
  const inheritedApiKey = String(env.OPENAI_API_KEY || '').trim();
  const apiKey = explicitApiKey || fileKey.apiKey || inheritedApiKey;
  return {
    baseUrl: String(env.CONVERSATION_AGENT_CODEX_BASE_URL || env.CODEX_API_BASE_URL || provider.base_url || '').trim().replace(/\/$/, ''),
    model: String(env.CONVERSATION_AGENT_CODEX_MODEL || env.CODEX_MODEL || config.root.model || '').trim(),
    wireApi: normaliseWireApi(env.CONVERSATION_AGENT_CODEX_WIRE_API || env.CODEX_WIRE_API || provider.wire_api || 'responses'),
    apiKey,
    provider: String(provider.name || requestedProvider || '').trim(),
    configurationSource: config.filePath ? 'CODEX_HOME/config.toml' : '',
    credentialSource: explicitApiKey ? '本机环境变量' : fileKey.apiKey ? `当前 Codex ${fileKey.source}` : inheritedApiKey ? '当前进程环境变量' : '',
  };
}

export async function inspectCurrentCodex() {
  return publicLink(await resolveCurrentCodex());
}

export async function connectCurrentCodex() {
  const candidate = await resolveCurrentCodex();
  const result = publicLink(candidate);
  if (!result.canApply) return result;
  const payload = { baseUrl: candidate.baseUrl, model: candidate.model, wireApi: candidate.wireApi };
  if (candidate.apiKey) payload.apiKey = candidate.apiKey;
  return { ...result, applied: true, runtime: updateRuntimeConfig(payload), message: '已将当前 Codex 配置接入此独立 Agent；密钥仅保留在当前进程内存。' };
}
