import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SERVER_DIR, '..');
const ROOT = path.resolve(process.env.WUHU_MKT_ROOT || DEFAULT_ROOT);
const DEFAULT_OUT = path.join(ROOT, 'output', 'wuhu-mkt-master-strategy-20260814');

function jsonResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error) : null,
  };
}

function assertWorkspace(workspace) {
  const root = path.resolve(workspace || ROOT);
  const generator = path.join(root, 'scripts', 'generate-wuhu-mkt-master-report.mjs');
  const verifier = path.join(root, 'scripts', 'verify-wuhu-mkt-master-report.py');
  if (!fs.existsSync(generator) || !fs.existsSync(verifier)) {
    throw new Error(`Workspace does not contain the Wuhu generator/verifier: ${root}`);
  }
  return root;
}

function runPipeline(args = {}) {
  const root = assertWorkspace(args.workspace);
  const generator = path.join(root, 'scripts', 'generate-wuhu-mkt-master-report.mjs');
  const verifier = path.join(root, 'scripts', 'verify-wuhu-mkt-master-report.py');
  const generated = run(process.execPath, [generator], root);
  if (generated.status !== 0) {
    return textResult(JSON.stringify({ stage: 'generate', ...generated }, null, 2), true);
  }
  if (args.verify === false) {
    return textResult(JSON.stringify({ stage: 'generate', ...generated }, null, 2));
  }
  const checked = run('python', ['-X', 'utf8', '-u', verifier], root);
  const payload = {
    stage: 'verify',
    generated: { status: generated.status, stdout: generated.stdout, stderr: generated.stderr },
    verification: checked,
  };
  return textResult(JSON.stringify(payload, null, 2), checked.status !== 0);
}

function readArtifact(args = {}) {
  const root = assertWorkspace(args.workspace);
  const out = path.resolve(args.outputDir || path.join(root, 'output', 'wuhu-mkt-master-strategy-20260814'));
  const verificationPath = path.join(out, 'verification.json');
  const manifestPath = path.join(out, 'artifact-manifest.json');
  const report = fs.readdirSync(out, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.endsWith('.html'));
  if (!fs.existsSync(verificationPath)) throw new Error(`Missing verification.json: ${verificationPath}`);
  const verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const reportPath = report ? path.join(out, report.name) : null;
  return textResult(JSON.stringify({
    workspace: root,
    outputDir: out,
    report: reportPath,
    reportBytes: reportPath ? fs.statSync(reportPath).size : null,
    verification: {
      passed: verification.passed,
      total: verification.summary?.totalChecks ?? null,
      passedChecks: verification.summary?.passedChecks ?? null,
      failed: verification.summary?.failedChecks ?? [],
      staticChecks: Array.isArray(verification.staticChecks) ? verification.staticChecks.length : null,
      browserViewports: Array.isArray(verification.browserChecks) ? verification.browserChecks.length : null,
    },
    manifest: manifest ? {
      exists: true,
      entries: Array.isArray(manifest.files) ? manifest.files.length : null,
      generatedAt: manifest.generatedAt || null,
    } : { exists: false },
  }, null, 2));
}

const tools = [
  {
    name: 'run_wuhu_mkt_analysis',
    description: 'Run the current Wuhu audience/MKT report generator and independent verifier.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace containing scripts and output directories.' },
        verify: { type: 'boolean', description: 'Run the independent verifier after generation. Defaults to true.' },
      },
    },
  },
  {
    name: 'verify_wuhu_mkt_report',
    description: 'Run the independent integrity, privacy, and browser verification for a Wuhu report.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } },
    },
  },
  {
    name: 'inspect_wuhu_mkt_artifact',
    description: 'Return the verified HTML path, verification status, manifest summary, and report size.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        outputDir: { type: 'string' },
      },
    },
  },
];

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    return jsonResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'wuhu-mkt-insights', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return jsonResponse(id, {});
  if (method === 'tools/list') return jsonResponse(id, { tools });
  if (method === 'tools/call') {
    try {
      if (params.name === 'run_wuhu_mkt_analysis') return jsonResponse(id, runPipeline(params.arguments || {}));
      if (params.name === 'verify_wuhu_mkt_report') {
        const root = assertWorkspace((params.arguments || {}).workspace);
        const verifier = path.join(root, 'scripts', 'verify-wuhu-mkt-master-report.py');
        const checked = run('python', ['-X', 'utf8', '-u', verifier], root);
        return jsonResponse(id, textResult(JSON.stringify(checked, null, 2), checked.status !== 0));
      }
      if (params.name === 'inspect_wuhu_mkt_artifact') return jsonResponse(id, readArtifact(params.arguments || {}));
      return errorResponse(id, -32602, `Unknown tool: ${params.name}`);
    } catch (error) {
      return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
  if (id === undefined) return null;
  return errorResponse(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = await handle(JSON.parse(line));
      if (response) process.stdout.write(`${response}\n`);
    } catch (error) {
      process.stdout.write(`${errorResponse(null, -32700, error instanceof Error ? error.message : String(error))}\n`);
    }
  }
});

process.stdin.on('end', async () => {
  if (!buffer.trim()) return;
  try {
    const response = await handle(JSON.parse(buffer));
    if (response) process.stdout.write(`${response}\n`);
  } catch (error) {
    process.stdout.write(`${errorResponse(null, -32700, error instanceof Error ? error.message : String(error))}\n`);
  }
});
