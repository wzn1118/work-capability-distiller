import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  analyseParsedSession,
  defaultSessionRoots,
  discoverSessions,
  parseCodexSessionFile,
  resolveSessionSource,
  WORKSPACE_ROOT,
  writeAnalysisArtifacts,
} from '../session-forensics/lib/session-forensics.mjs';
import { packageConversation } from '../session-forensics/lib/conversation-packager.mjs';

const DEFAULT_OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'output', 'session-forensics');
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function jsonResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

const tools = [
  {
    name: 'list_codex_sessions',
    description: '列出本机 Codex JSON/JSONL 会话文件，只读取文件目录信息，不读取正文。',
    inputSchema: {
      type: 'object',
      properties: {
        roots: { type: 'array', items: { type: 'string' }, description: '可选的会话根目录；传入后只扫描这些目录。' },
        limit: { type: 'integer', minimum: 1, maximum: 5000, description: '最多返回的会话数量，默认 50。' },
      },
    },
  },
  {
    name: 'inspect_codex_session',
    description: '解析会话并返回有长度上限的中文摘要，不写入报告文件。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Codex 会话 UUID。' },
        sourcePath: { type: 'string', description: '本机 JSON 或 JSONL 会话文件路径。' },
        roots: { type: 'array', items: { type: 'string' } },
        includeEvidence: { type: 'boolean', description: '保留长度受限的参数和结果示例，默认关闭。' },
        redact: { type: 'boolean', description: '遮盖疑似凭据字符串，默认开启。' },
        compact: { type: 'boolean', description: '对大型会话的列表进行长度限制，默认开启。' },
        maxItems: { type: 'integer', minimum: 1, maximum: 500, description: '每个受限列表最多返回的行数，默认 80。' },
      },
    },
  },
  {
    name: 'analyze_codex_session',
    description: '定位、解析、关联并导出完整的 Codex 会话全量取证报告。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Codex 会话 UUID，从本机会话根目录定位。' },
        sourcePath: { type: 'string', description: '本机 JSON 或 JSONL 会话文件路径。' },
        roots: { type: 'array', items: { type: 'string' } },
        outputDir: { type: 'string', description: '报告输出目录，默认位于 output/session-forensics/<会话编号>。' },
        includeEvidence: { type: 'boolean', description: '在 analysis.json 中保留长度受限的工具摘录。' },
        redact: { type: 'boolean', description: '遮盖疑似凭据字符串，默认开启。' },
        compact: { type: 'boolean', description: '限制 MCP 返回摘要的列表长度；报告文件仍保留完整内容，默认开启。' },
        maxItems: { type: 'integer', minimum: 1, maximum: 500, description: '每个 MCP 返回列表最多显示的行数，默认 80。' },
      },
    },
  },
  {
    name: 'get_session_artifact',
    description: '在完成分析后按文件名读取已生成的报告产物，并支持按字符偏移分页。',
    inputSchema: {
      type: 'object',
      required: ['outputDir', 'artifact'],
      properties: {
        outputDir: { type: 'string' },
        artifact: { type: 'string', enum: ['analysis.json', 'report.md', 'report.html', 'normalized-events.ndjson', 'manifest.json'] },
        maxChars: { type: 'integer', minimum: 100, maximum: 200000, description: '本次最多返回的字符数，默认 30000。' },
        offset: { type: 'integer', minimum: 0, description: '大型报告的字符分页起点，默认 0。' },
      },
    },
  },
  {
    name: 'package_codex_conversation',
    description: '选择整个 Codex 会话，并生成可安装的 Skill、可注册的独立 MCP 服务和带独立中文界面的 Agent 项目。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Codex 会话 UUID。' },
        sourcePath: { type: 'string', description: '本机 JSON 或 JSONL 会话文件路径；提供时优先使用并校验会话编号。' },
        roots: { type: 'array', items: { type: 'string' }, description: '定位会话编号时使用的可选根目录。' },
        packageId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: '能力包技术标识。' },
        packageName: { type: 'string', description: '能力包中文显示名称。' },
        targets: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['skill', 'mcp', 'agent'] },
          description: '要生成的交付物；默认全部生成。',
        },
        scope: { type: 'string', enum: ['whole-session'], description: '选择范围固定为整个会话。' },
        includeEvidence: { type: 'boolean', description: '在证据分析中保留长度受限的工具参数和结果摘录，默认开启。' },
        redact: { type: 'boolean', description: '遮盖疑似凭据字符串，默认开启。' },
      },
    },
  },
];

function summaryPayload(analysis, artifacts = null, { compact = true, maxItems = 80 } = {}) {
  const bound = (items) => compact ? items.slice(0, maxItems) : items;
  return {
    sessionId: analysis.source.sessionId,
    source: analysis.source,
    presentation: analysis.presentation,
    summary: analysis.summary,
    eventTypeCounts: analysis.coverage.eventTypeCounts,
    responseItemTypeCounts: analysis.coverage.responseItemTypeCounts,
    wrapperTools: bound(analysis.toolCatalog).map(({ examples, ...tool }) => tool),
    nestedTools: bound(analysis.nestedToolCatalog),
    codeArtifacts: {
      fileChanges: bound(analysis.codeArtifacts.fileChanges),
      commandCount: analysis.codeArtifacts.commands.length,
      fileChangeCount: analysis.codeArtifacts.fileChanges.length,
      fileExtensions: analysis.codeArtifacts.fileExtensions,
    },
    triggerLogic: bound(analysis.triggerLogic),
    episodes: bound(analysis.episodes),
    reusableCapabilities: bound(analysis.reusableCapabilities),
    skillBlueprint: analysis.skillBlueprint,
    artifacts: artifacts?.paths ?? null,
    responseBounds: {
      compact,
      maxItems: compact ? maxItems : null,
      wrapperToolsOmitted: Math.max(0, analysis.toolCatalog.length - (compact ? maxItems : analysis.toolCatalog.length)),
      nestedToolsOmitted: Math.max(0, analysis.nestedToolCatalog.length - (compact ? maxItems : analysis.nestedToolCatalog.length)),
      fileChangesOmitted: Math.max(0, analysis.codeArtifacts.fileChanges.length - (compact ? maxItems : analysis.codeArtifacts.fileChanges.length)),
      triggerRulesOmitted: Math.max(0, analysis.triggerLogic.length - (compact ? maxItems : analysis.triggerLogic.length)),
      episodesOmitted: Math.max(0, analysis.episodes.length - (compact ? maxItems : analysis.episodes.length)),
    },
  };
}

function normaliseSessionId(value) {
  const text = String(value || '').trim().toLowerCase();
  return SESSION_ID_RE.test(text) ? text : null;
}

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum);
}

function outputKeyFromDirectory(outputDir) {
  const root = path.resolve(DEFAULT_OUTPUT_ROOT);
  const candidate = path.resolve(outputDir);
  const relative = path.relative(root, candidate);
  if (!relative || relative.includes(path.sep) || !OUTPUT_KEY_RE.test(relative)) {
    throw new Error('outputDir 必须是 output/session-forensics 下的直接子目录。');
  }
  return relative;
}

async function safeOutputDirectory(requestedOutputDir, sessionId) {
  const outputKey = requestedOutputDir
    ? outputKeyFromDirectory(requestedOutputDir)
    : (normaliseSessionId(sessionId) || `session-${Date.now()}`);
  if (!OUTPUT_KEY_RE.test(outputKey)) throw new Error('报告输出目录标识不符合格式。');

  const root = path.resolve(DEFAULT_OUTPUT_ROOT);
  await fsp.mkdir(root, { recursive: true });
  const rootReal = await fsp.realpath(root);
  const outputDir = path.join(root, outputKey);
  await fsp.mkdir(outputDir, { recursive: true });
  const outputReal = await fsp.realpath(outputDir);
  if (path.dirname(outputReal) !== rootReal) {
    throw new Error('报告输出目录解析后超出允许的取证输出根目录。');
  }
  return outputDir;
}

async function allowedArtifactPath(outputDir, artifact) {
  const allowed = new Set(['analysis.json', 'report.md', 'report.html', 'normalized-events.ndjson', 'manifest.json']);
  if (!allowed.has(artifact)) throw new Error(`报告文件名必须是：${[...allowed].join('、')}`);
  const outputKey = outputKeyFromDirectory(outputDir);
  const root = path.resolve(DEFAULT_OUTPUT_ROOT);
  const rootReal = await fsp.realpath(root);
  const outputDirReal = await fsp.realpath(path.join(root, outputKey));
  if (path.dirname(outputDirReal) !== rootReal) throw new Error('报告输出目录解析后超出允许的根目录。');
  const filePath = path.resolve(outputDirReal, artifact);
  if (path.dirname(filePath) !== outputDirReal) throw new Error('报告文件路径超出输出目录。');
  const fileReal = await fsp.realpath(filePath);
  if (path.dirname(fileReal) !== outputDirReal) throw new Error('报告文件解析后超出允许的目录。');
  return fileReal;
}

async function resolveAndParse(args) {
  const source = args.sourcePath
    ? await resolveSessionSource({ sourcePath: args.sourcePath })
    : await resolveSessionSource({ threadId: args.threadId, roots: args.roots || [] });
  const parsed = await parseCodexSessionFile(source.sourcePath, { redact: args.redact !== false });
  if (!parsed.sessionId && source.sessionId) parsed.sessionId = source.sessionId;
  const requestedId = normaliseSessionId(args.threadId);
  const actualId = normaliseSessionId(parsed.sessionId);
  if (requestedId && actualId && requestedId !== actualId) {
    throw new Error(`threadId ${requestedId} 与源文件会话 ${actualId} 不一致。`);
  }
  return { source, parsed };
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    return jsonResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'codex-session-forensics', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return jsonResponse(id, {});
  if (method === 'tools/list') return jsonResponse(id, { tools });
  if (method === 'tools/call') {
    try {
      const args = params.arguments || {};
      if (params.name === 'list_codex_sessions') {
        const sessions = await discoverSessions({ roots: args.roots || [], limit: boundedInt(args.limit, 50, 1, 5000) });
        return jsonResponse(id, textResult({ roots: args.roots?.length ? args.roots : defaultSessionRoots(), sessions }));
      }
      if (params.name === 'inspect_codex_session') {
        const { parsed } = await resolveAndParse(args);
        const analysis = analyseParsedSession(parsed, { includeEvidence: Boolean(args.includeEvidence) });
        return jsonResponse(id, textResult(summaryPayload(analysis, null, {
          compact: args.compact !== false,
          maxItems: boundedInt(args.maxItems, 80, 1, 500),
        })));
      }
      if (params.name === 'analyze_codex_session') {
        const { parsed } = await resolveAndParse(args);
        const analysis = analyseParsedSession(parsed, { includeEvidence: Boolean(args.includeEvidence) });
        const outputDir = await safeOutputDirectory(args.outputDir, parsed.sessionId);
        const artifacts = await writeAnalysisArtifacts(parsed, analysis, outputDir);
        return jsonResponse(id, textResult(summaryPayload(analysis, artifacts, {
          compact: args.compact !== false,
          maxItems: boundedInt(args.maxItems, 80, 1, 500),
        })));
      }
      if (params.name === 'get_session_artifact') {
        const filePath = await allowedArtifactPath(args.outputDir, args.artifact);
        const maxChars = boundedInt(args.maxChars, 30000, 100, 200000);
        const offset = boundedInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const content = await fsp.readFile(filePath, 'utf8');
        const fragment = content.slice(offset, offset + maxChars);
        return jsonResponse(id, textResult({
          artifact: args.artifact,
          outputDir: path.dirname(filePath),
          offset,
          nextOffset: offset + fragment.length,
          totalChars: content.length,
          hasMore: offset + fragment.length < content.length,
          content: fragment,
        }));
      }
      if (params.name === 'package_codex_conversation') {
        const result = await packageConversation({
          threadId: args.threadId,
          sourcePath: args.sourcePath,
          roots: args.roots || [],
          packageId: args.packageId,
          packageName: args.packageName,
          targets: args.targets,
          scope: args.scope || 'whole-session',
          includeEvidence: args.includeEvidence !== false,
          redact: args.redact !== false,
        });
        return jsonResponse(id, textResult({
          package: result.package,
          verification: result.verification,
        }));
      }
      return errorResponse(id, -32602, `未识别的工具：${params.name}`);
    } catch (error) {
      return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
  if (id === undefined) return null;
  return errorResponse(id, -32601, `未找到请求的方法：${method}`);
}

let buffer = '';
let requestQueue = Promise.resolve();

function enqueueLine(line) {
  requestQueue = requestQueue.then(async () => {
    if (!line.trim()) return;
    try {
      const response = await handle(JSON.parse(line));
      if (response) process.stdout.write(`${response}\n`);
    } catch (error) {
      process.stdout.write(`${errorResponse(null, -32700, error instanceof Error ? error.message : String(error))}\n`);
    }
  });
  return requestQueue;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    enqueueLine(line);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) enqueueLine(buffer);
});
