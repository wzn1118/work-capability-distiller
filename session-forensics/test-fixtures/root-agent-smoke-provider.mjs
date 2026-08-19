import http from 'node:http';

const port = Number(process.env.ROOT_AGENT_SMOKE_PROVIDER_PORT || 8899);

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    return sendJson(response, {
      object: 'list',
      data: [
        { id: 'root-agent-smoke', object: 'model', owned_by: '本地验收服务' },
        { id: 'root-agent-long-context', object: 'model', owned_by: '本地验收服务' },
        { id: 'root-agent-reasoning', object: 'model', owned_by: '本地验收服务' },
        { id: 'root-agent-vision', object: 'model', owned_by: '本地验收服务' },
      ],
    });
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const payload = await readJson(request);
    const hasToolResult = payload.messages?.some((message) => message.role === 'tool');
    const message = hasToolResult ? {
      role: 'assistant',
      content: '自动执行验收完成：已检索原对话证据、写入验证文件、执行本地读取命令，并通过验收命令。',
    } : {
      role: 'assistant',
      content: '开始执行根能力包自主工具链。',
      tool_calls: [
        { id: 'evidence-1', type: 'function', function: { name: 'search_original_conversation', arguments: JSON.stringify({ query: '独立 UI', limit: 2 }) } },
        { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '自动执行验证.txt', content: '根能力包自动执行通过\n' }) } },
        { id: 'command-1', type: 'function', function: { name: 'execute_command', arguments: JSON.stringify({ command: 'node -e "const fs=require(\'fs\');process.stdout.write(fs.readFileSync(\'自动执行验证.txt\',\'utf8\'))"' }) } },
        { id: 'verify-1', type: 'function', function: { name: 'run_verification', arguments: JSON.stringify({ commands: ['node -e "process.exit(0)"'] }) } },
      ],
    };
    return sendJson(response, { id: 'chatcmpl-root-smoke', object: 'chat.completion', choices: [{ index: 0, finish_reason: hasToolResult ? 'stop' : 'tool_calls', message }] });
  }
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`根能力包假模型已启动：http://127.0.0.1:${port}/v1\n`));
