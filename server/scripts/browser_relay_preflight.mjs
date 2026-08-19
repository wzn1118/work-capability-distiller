/**
 * Verify an already attached Browser Relay without reading browser credentials.
 * The status file intentionally stores only non-secret connection metadata.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REQUIRE = createRequire(import.meta.url);

const PLATFORM_DOMAINS = Object.freeze({
  xiaohongshu: 'xiaohongshu.com',
  douyin: 'douyin.com',
  bilibili: 'bilibili.com',
});
const PLATFORM_ROOTS = Object.freeze({
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  bilibili: 'https://www.bilibili.com/',
});
const LOGIN_MARKERS = [
  '\u8bf7\u767b\u5f55',
  '\u7acb\u5373\u767b\u5f55',
  '\u626b\u7801\u767b\u5f55',
  '\u624b\u673a\u53f7\u767b\u5f55',
  '\u767b\u5f55\u540e\u67e5\u770b',
  '\u767b\u5f55\u540e\u53ef\u89c1',
];
const VERIFICATION_MARKERS = [
  '\u5b89\u5168\u9a8c\u8bc1',
  '\u6ed1\u52a8\u9a8c\u8bc1',
  '\u4eba\u673a\u9a8c\u8bc1',
  '\u5b8c\u6210\u9a8c\u8bc1',
  '\u5f02\u5e38\u8bbf\u95ee',
  '\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validRelayPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parsedPort(value) {
  return /^\d{1,5}$/.test(String(value || '')) ? Number(value) : null;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

export function isPlatformPage(platform, value) {
  const domain = PLATFORM_DOMAINS[platform];
  if (!domain || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function pageAccessState(pageUrl, visibleText) {
  const url = text(pageUrl).toLowerCase();
  const body = text(visibleText).toLowerCase();
  if (['/captcha', '/security/verify', '/website-login/captcha'].some((marker) => url.includes(marker))) {
    return 'verification_required';
  }
  if (VERIFICATION_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) return 'verification_required';
  if (LOGIN_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) return 'login_required';
  return 'ready';
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function tokenFromConfig(payload) {
  const value = payload?.gateway?.auth?.token;
  return typeof value === 'string' ? value.trim() : '';
}

async function getGatewayToken() {
  const environmentToken = text(process.env.OPENCLAW_GATEWAY_TOKEN);
  if (environmentToken) return environmentToken;

  const openclawDirectory = path.join(os.homedir(), '.openclaw');
  try {
    const payload = JSON.parse(await fs.readFile(path.join(openclawDirectory, 'openclaw.json'), 'utf8'));
    const configToken = tokenFromConfig(payload);
    if (configToken) return configToken;
  } catch {
    // Fall through to the generated command file without exposing its token.
  }

  try {
    const command = await fs.readFile(path.join(openclawDirectory, 'gateway.cmd'), 'utf8');
    const match = command.match(/OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)/);
    const commandToken = text(match?.[1]);
    if (commandToken) return commandToken;
  } catch {
    // The token remains browser-local and is intentionally absent from output.
  }
  throw new Error('Browser Relay gateway token is unavailable.');
}

function relayHeaders(port, token) {
  const relayToken = createHmac('sha256', token)
    .update(`openclaw-extension-relay-v1:${port}`)
    .digest('hex');
  return { 'x-openclaw-relay-token': relayToken };
}

async function modulePaths(configuredPath) {
  const paths = [];
  const addResolved = (base) => {
    if (!base) return;
    try {
      const resolver = createRequire(path.join(base, 'relay-loader.cjs'));
      paths.push(resolver.resolve('playwright'));
    } catch {
      // Try the next supported local module location.
    }
  };
  const addPnpmVirtualStorePaths = async (base) => {
    if (!base) return;
    let entries = [];
    try {
      entries = await fs.readdir(path.join(base, '.pnpm'), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.filter((item) => item.isDirectory() && /^playwright@/i.test(item.name)).slice(0, 4)) {
      addResolved(path.join(base, '.pnpm', entry.name, 'node_modules'));
    }
  };

  try {
    paths.push(REQUIRE.resolve('playwright'));
  } catch {
    // This project deliberately keeps Playwright optional.
  }
  const supplied = text(configuredPath);
  if (!supplied) return [...new Set(paths)];
  const target = path.resolve(supplied);
  addResolved(target);
  addResolved(path.dirname(target));
  await addPnpmVirtualStorePaths(target);
  await addPnpmVirtualStorePaths(path.dirname(target));
  if (/\.(?:cjs|mjs|js)$/i.test(target)) paths.push(target);
  return [...new Set(paths)];
}

async function loadPlaywright(configuredPath) {
  for (const modulePath of await modulePaths(configuredPath)) {
    try {
      const imported = await import(pathToFileURL(modulePath).href);
      const playwright = imported?.chromium ? imported : imported?.default;
      if (playwright?.chromium?.connectOverCDP) return playwright;
    } catch {
      // Optional module roots can contain an incompatible package version.
    }
  }
  throw new Error('Playwright module is unavailable.');
}

async function readPageAccessState(page) {
  let visibleText = '';
  try {
    visibleText = (await page.locator('body').innerText({ timeout: 1_500 })).slice(0, 3_000);
  } catch {
    return 'unknown';
  }
  return pageAccessState(page.url(), visibleText);
}

async function relaySnapshot(browser, platform, relayPort) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const platformPages = pages.filter((page) => isPlatformPage(platform, page.url()));
  const states = await Promise.all(platformPages.map((page) => readPageAccessState(page)));
  const platformState = states.includes('verification_required')
    ? 'verification_required'
    : states.includes('login_required')
      ? 'login_required'
      : states.includes('ready')
        ? 'ready'
        : platformPages.length
          ? 'unknown'
          : 'not_checked';
  return {
    reachable: true,
    page_count: pages.length,
    platform_tab_count: platformPages.length,
    platform_session_state: platformState,
    session_persistence: 'attached_browser_profile',
    credential_handling: 'browser_managed_not_exported',
    relay_port: relayPort,
  };
}

export function relayTargetSnapshot(targets, platform, relayPort) {
  const pages = Array.isArray(targets)
    ? targets.filter((target) => target?.type === 'page' && typeof target?.url === 'string')
    : [];
  const platformPages = pages.filter((target) => isPlatformPage(platform, target.url));
  const platformState = platformPages.some((target) => pageAccessState(target.url, '') === 'verification_required')
    ? 'verification_required'
    : platformPages.length
      ? 'unknown'
      : 'not_checked';
  return {
    reachable: true,
    page_count: pages.length,
    platform_tab_count: platformPages.length,
    platform_session_state: platformState,
    session_persistence: 'attached_browser_profile',
    credential_handling: 'browser_managed_not_exported',
    relay_port: relayPort,
  };
}

async function relayTargets(relayPort, gatewayToken) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/json/list`, {
    headers: relayHeaders(relayPort, gatewayToken),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Browser Relay target list returned HTTP ${response.status}.`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('Browser Relay target list was malformed.');
  return targets;
}

async function writeSessionState(stateFile, platform, snapshot) {
  if (!stateFile) return false;
  const target = path.resolve(stateFile);
  let prior = {};
  try {
    const payload = JSON.parse(await fs.readFile(target, 'utf8'));
    prior = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    // Missing or malformed prior metadata is replaceable.
  }
  const platforms = prior.platforms && typeof prior.platforms === 'object' && !Array.isArray(prior.platforms)
    ? { ...prior.platforms }
    : {};
  platforms[platform] = {
    observedAt: utcNow(),
    tabCount: Math.max(0, Number(snapshot.platform_tab_count) || 0),
    state: snapshot.platform_session_state || 'not_checked',
  };
  const safeState = {
    schemaVersion: 2,
    updatedAt: utcNow(),
    relayPort: Math.max(0, Number(snapshot.relay_port) || 0),
    persistence: 'attached_browser_profile',
    credentialHandling: 'browser_managed_not_exported',
    pageCount: Math.max(0, Number(snapshot.page_count) || 0),
    platforms,
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(safeState, null, 2), 'utf8');
  await fs.rename(temporary, target);
  return true;
}

async function openPlatformPage(browser, platform) {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser Relay has no reusable context.');
  if (context.pages().some((page) => isPlatformPage(platform, page.url()))) return;
  const page = await context.newPage();
  await page.goto(PLATFORM_ROOTS[platform], { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1_000);
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const known = new Set(['--relay-port', '--platform', '--state-file', '--playwright-module-path', '--open-platform-page']);
  for (const argument of argv) {
    if (argument.startsWith('--') && !known.has(argument)) throw new Error('Invalid argument.');
  }
  const platform = text(optionValue(argv, '--platform'));
  const relayPort = argv.includes('--relay-port') ? parsedPort(optionValue(argv, '--relay-port')) : 18_800;
  if (!Object.hasOwn(PLATFORM_DOMAINS, platform) || !validRelayPort(relayPort)) throw new Error('Invalid required input.');
  return {
    help: false,
    platform,
    relayPort,
    stateFile: text(optionValue(argv, '--state-file')),
    configuredModulePath: text(optionValue(argv, '--playwright-module-path')) || text(process.env.KOLFORGE_RELAY_PLAYWRIGHT_MODULE_PATH),
    openPlatformPage: argv.includes('--open-platform-page'),
  };
}

function usage() {
  return [
    'Usage: node browser_relay_preflight.mjs --platform douyin|xiaohongshu|bilibili',
    '       [--relay-port 18800] [--state-file C:\\path\\to\\state.json]',
    '       [--playwright-module-path C:\\path\\to\\node_modules] [--open-platform-page]',
  ].join('\n');
}

function safeFailure(stage) {
  const errorCode = {
    playwright_load: 'PLAYWRIGHT_UNAVAILABLE',
    gateway_token: 'GATEWAY_TOKEN_UNAVAILABLE',
    relay_http: 'RELAY_CONNECTION_FAILED',
    relay_connect: 'RELAY_CONNECTION_FAILED',
    platform_page_open: 'PLATFORM_PAGE_OPEN_FAILED',
    snapshot: 'RELAY_SNAPSHOT_FAILED',
  }[stage] || 'BROWSER_RELAY_ERROR';
  return {
    reachable: false,
    error: `Browser Relay preflight failed: ${errorCode}.`,
    error_code: errorCode,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    process.stdout.write(`${JSON.stringify({ reachable: false, error: 'Invalid Relay preflight input.' })}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let browser = null;
  let stage = 'gateway_token';
  try {
    const gatewayToken = await getGatewayToken();
    if (!args.openPlatformPage) {
      stage = 'relay_http';
      const targets = await relayTargets(args.relayPort, gatewayToken);
      const snapshot = relayTargetSnapshot(targets, args.platform, args.relayPort);
      try {
        snapshot.session_state_persisted = await writeSessionState(args.stateFile, args.platform, snapshot);
      } catch {
        snapshot.session_state_persisted = false;
      }
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      return 0;
    }

    stage = 'playwright_load';
    const playwright = await loadPlaywright(args.configuredModulePath);
    stage = 'relay_connect';
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${args.relayPort}`, {
      headers: relayHeaders(args.relayPort, gatewayToken),
      timeout: 8_000,
    });
    stage = 'platform_page_open';
    if (args.openPlatformPage) await openPlatformPage(browser, args.platform);
    stage = 'snapshot';
    const snapshot = await relaySnapshot(browser, args.platform, args.relayPort);
    try {
      snapshot.session_state_persisted = await writeSessionState(args.stateFile, args.platform, snapshot);
    } catch {
      snapshot.session_state_persisted = false;
    }
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch {
    process.stdout.write(`${JSON.stringify(safeFailure(stage))}\n`);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const launchedAsScript = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (launchedAsScript) {
  process.exitCode = await main();
}
