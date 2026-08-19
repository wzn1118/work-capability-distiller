import { runtimeConfig } from './config.mjs';
import { HttpError, redactSecrets } from './shared.mjs';

function endpoint(name) {
  return `${runtimeConfig.baseUrl.replace(/\/$/, '')}/${name.replace(/^\//, '')}`;
}

function headers() {
  const result = { 'content-type': 'application/json' };
  if (runtimeConfig.apiKey) result.authorization = `Bearer ${runtimeConfig.apiKey}`;
  if (runtimeConfig.organization) result['openai-organization'] = runtimeConfig.organization;
  if (runtimeConfig.project) result['openai-project'] = runtimeConfig.project;
  return result;
}

function responseInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (message?.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') });
      continue;
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) input.push({ role: 'assistant', content: String(message.content) });
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '{}' });
      }
      continue;
    }
    input.push({ role: message?.role === 'system' ? 'developer' : (message?.role || 'user'), content: String(message?.content || '') });
  }
  return input;
}

function responseTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description,
    parameters: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
  }));
}

function responsePayload(payload = {}) {
  const body = { model: payload.model || runtimeConfig.model, input: responseInput(payload.messages) };
  const tools = responseTools(payload.tools);
  if (tools?.length) body.tools = tools;
  if (payload.tool_choice) body.tool_choice = payload.tool_choice;
  for (const key of ['temperature', 'top_p', 'max_output_tokens', 'store', 'metadata']) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  if (payload.max_tokens !== undefined && body.max_output_tokens === undefined) body.max_output_tokens = payload.max_tokens;
  return body;
}

function textFromResponse(item) {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => part.text || part.content || '').join('');
  return item.text || '';
}

function responseAsChatCompletion(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const text = output.filter((item) => item.type === 'message').map(textFromResponse).join('');
  const toolCalls = output.filter((item) => item.type === 'function_call').map((item, index) => ({
    id: item.call_id || item.id || `call-${index + 1}`,
    type: 'function',
    function: { name: item.name, arguments: item.arguments || '{}' },
  }));
  return {
    id: data?.id || `response-${Date.now()}`,
    object: 'chat.completion',
    model: data?.model || runtimeConfig.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: data?.usage,
    _conversationAgent: { wireApi: 'responses', responseId: data?.id || '' },
  };
}

async function providerFetch(url, options = {}, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new HttpError(504, 'provider_timeout', '模型服务连接超时或任务已停止。');
    throw new HttpError(502, 'provider_unreachable', '没有连接到模型服务。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readProviderError(response) {
  const text = await response.text();
  let message = text;
  try { message = JSON.parse(text)?.error?.message || text; } catch { /* 保留文本 */ }
  return redactSecrets(message, [runtimeConfig.apiKey]);
}

export async function listModels(signal) {
  const response = await providerFetch(endpoint('models'), { headers: headers() }, signal);
  if (!response.ok) throw new HttpError(response.status, 'provider_error', `模型列表读取失败：${await readProviderError(response)}`);
  return response.json();
}

export async function chatCompletion(payload, signal) {
  if (runtimeConfig.wireApi === 'responses') {
    const response = await providerFetch(endpoint('responses'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(responsePayload(payload)),
    }, signal);
    if (!response.ok) throw new HttpError(response.status, 'provider_error', `模型服务返回错误：${await readProviderError(response)}`);
    return responseAsChatCompletion(await response.json());
  }
  const response = await providerFetch(endpoint('chat/completions'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...payload, model: payload.model || runtimeConfig.model }),
  }, signal);
  if (!response.ok) throw new HttpError(response.status, 'provider_error', `模型服务返回错误：${await readProviderError(response)}`);
  return response.json();
}

export async function proxyStreamingChat(payload, response, signal) {
  if (runtimeConfig.wireApi === 'responses') {
    const completion = await chatCompletion({ ...payload, stream: false }, signal);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: completion.choices[0].message, finish_reason: completion.choices[0].finish_reason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  const upstream = await providerFetch(endpoint('chat/completions'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...payload, model: payload.model || runtimeConfig.model, stream: true }),
  }, signal);
  if (!upstream.ok) throw new HttpError(upstream.status, 'provider_error', `模型服务返回错误：${await readProviderError(upstream)}`);
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
}
