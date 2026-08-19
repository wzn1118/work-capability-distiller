import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function relayOnline(port, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return response.ok && Boolean(payload.webSocketDebuggerUrl);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function chromeCandidates(environment = process.env) {
  return [
    environment.KOLFORGE_CHROME_PATH,
    environment.PROGRAMFILES && path.win32.join(environment.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment['PROGRAMFILES(X86)'] && path.win32.join(environment['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment.PROGRAMFILES && path.win32.join(environment.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

export function douyinRelayArguments({ port, profileDir }) {
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-popup-blocking',
    '--remote-allow-origins=http://127.0.0.1:*',
    'https://www.douyin.com/',
  ];
}

export async function ensureDouyinRelay({
  port = 18801,
  dataDir,
  timeoutMs = 15_000,
  fetchImpl = fetch,
  spawnImpl = spawn,
  environment = process.env,
} = {}) {
  if (await relayOnline(port, fetchImpl)) return { status: 'online', launched: false, port };
  const candidates = chromeCandidates(environment);
  let executable = '';
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      executable = candidate;
      break;
    } catch {}
  }
  if (!executable) {
    const error = new Error('Chrome or Edge was not found for the dedicated Douyin browser session.');
    error.code = 'DOUYIN_BROWSER_NOT_FOUND';
    throw error;
  }
  const profileDir = path.join(dataDir, 'browser', 'douyin-comments');
  await fs.mkdir(profileDir, { recursive: true });
  const child = spawnImpl(executable, douyinRelayArguments({ port, profileDir }), {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await relayOnline(port, fetchImpl)) {
      return { status: 'online', launched: true, port, profileDir, executable };
    }
    await wait(350);
  }
  const error = new Error(`The dedicated Douyin browser did not open CDP port ${port} within ${timeoutMs} ms.`);
  error.code = 'DOUYIN_BROWSER_START_TIMEOUT';
  throw error;
}
