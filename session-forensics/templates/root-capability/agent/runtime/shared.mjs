import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createId(prefix = 'item') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

export function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

export function cleanText(value, maximum = 32000) {
  const text = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n');
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n……内容过长，已截断。`;
}

export function redactSecrets(value, secrets = []) {
  let text = cleanText(value, 64000);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[已隐藏密钥]');
  return text.replace(/(bearer\s+)[a-z0-9._~+\/-]{12,}/ig, '$1[已隐藏密钥]');
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

export async function readBody(request, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large', '请求内容过大。');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是有效 JSON。');
  }
}

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function sendBuffer(response, status, body, contentType) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  response.end(body);
}

export function startSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(': ready\n\n');
  return (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function errorPayload(error) {
  const status = error instanceof HttpError ? error.status : 500;
  return {
    status,
    body: {
      error: {
        code: error instanceof HttpError ? error.code : 'internal_error',
        message: error instanceof HttpError ? error.message : '服务执行失败，请查看终端日志。',
        details: error instanceof HttpError ? error.details : undefined,
      },
    },
  };
}
