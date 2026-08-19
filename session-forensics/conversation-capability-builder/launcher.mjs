import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write('需要 Node.js 18 或更高版本。请先安装 Node.js LTS，再重新启动此应用。\n');
  process.exit(1);
}

const env = { ...process.env, CONVERSATION_BUILDER_HOST: process.env.CONVERSATION_BUILDER_HOST || '127.0.0.1', CONVERSATION_BUILDER_PORT: process.env.CONVERSATION_BUILDER_PORT || '0' };
const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: false });
let output = '';
let opened = false;
function openBrowser(url) {
  if (opened || process.env.CONVERSATION_BUILDER_NO_BROWSER === '1') return;
  opened = true;
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
  const match = output.match(/(http:\/\/127\.0\.0\.1:\d+\/)/);
  if (match) openBrowser(match[1]);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
