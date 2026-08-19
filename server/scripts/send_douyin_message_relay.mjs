import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REQUIRE = createRequire(import.meta.url);
const MAX_INPUT_BYTES = 32 * 1024;
const LOGIN_MARKERS = [
  '\u8bf7\u767b\u5f55', '\u767b\u5f55\u540e\u67e5\u770b', '\u624b\u673a\u53f7\u767b\u5f55', '\u767b\u5f55\u5373\u53ef',
];
const VERIFICATION_MARKERS = [
  '\u4eba\u673a\u9a8c\u8bc1', '\u5b89\u5168\u9a8c\u8bc1', '\u8bf7\u5b8c\u6210\u9a8c\u8bc1', '\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41', '\u5f02\u5e38\u8bbf\u95ee',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || '' : '';
  };
  const relayPort = Number(value('--relay-port'));
  return {
    relayPort: Number.isInteger(relayPort) && relayPort > 0 && relayPort <= 65_535 ? relayPort : 0,
    configuredModulePath: value('--playwright-module-path'),
    action: value('--action') === 'follow' ? 'follow' : 'message',
  };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('input_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_input');
  }
}

function validDouyinUrl(value) {
  try {
    const parsed = new URL(text(value));
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'douyin.com' || host.endsWith('.douyin.com'));
  } catch {
    return false;
  }
}

function tokenFromConfig(payload) {
  const value = payload?.gateway?.auth?.token;
  return typeof value === 'string' ? value.trim() : '';
}

async function gatewayToken() {
  const environmentToken = text(process.env.OPENCLAW_GATEWAY_TOKEN);
  if (environmentToken) return environmentToken;
  const openclawDirectory = path.join(os.homedir(), '.openclaw');
  try {
    const payload = JSON.parse(await fs.readFile(path.join(openclawDirectory, 'openclaw.json'), 'utf8'));
    const token = tokenFromConfig(payload);
    if (token) return token;
  } catch {
    // Continue to the generated gateway command file.
  }
  try {
    const command = await fs.readFile(path.join(openclawDirectory, 'gateway.cmd'), 'utf8');
    const match = command.match(/OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)/);
    const token = text(match?.[1]);
    if (token) return token;
  } catch {
    // Keep credentials out of the result payload.
  }
  throw new Error('relay_token_unavailable');
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
      // Try another local module root.
    }
  };
  try {
    paths.push(REQUIRE.resolve('playwright'));
  } catch {
    // Playwright is intentionally optional at project level.
  }
  const supplied = text(configuredPath);
  if (supplied) {
    const target = path.resolve(supplied);
    addResolved(target);
    addResolved(path.dirname(target));
    try {
      for (const entry of await fs.readdir(path.join(target, '.pnpm'), { withFileTypes: true })) {
        if (entry.isDirectory() && /^playwright@/i.test(entry.name)) addResolved(path.join(target, '.pnpm', entry.name, 'node_modules'));
      }
    } catch {
      // The supplied root may not be a pnpm store.
    }
  }
  return [...new Set(paths)];
}

async function loadPlaywright(configuredPath) {
  for (const modulePath of await modulePaths(configuredPath)) {
    try {
      const imported = await import(pathToFileURL(modulePath).href);
      const playwright = imported?.chromium ? imported : imported?.default;
      if (playwright?.chromium?.connectOverCDP) return playwright;
    } catch {
      // Try the next local package.
    }
  }
  throw new Error('playwright_unavailable');
}

async function visibleText(page) {
  return text(await page.locator('body').innerText().catch(() => ''));
}

async function accessState(page) {
  const frameUrls = page.frames().map((frame) => frame.url().toLowerCase());
  if (frameUrls.some((url) => url.includes('captcha') || url.includes('security/verify') || url.includes('rc-verifycenter'))) {
    return 'verification_required';
  }
  const body = (await visibleText(page)).toLowerCase();
  if (VERIFICATION_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) return 'verification_required';
  if (LOGIN_MARKERS.some((marker) => body.includes(marker.toLowerCase()))) return 'login_required';
  return 'ready';
}

async function firstVisible(locator) {
  const count = Math.min(await locator.count().catch(() => 0), 160);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function clickMessageControl(page) {
  const locator = page.locator('button, [role="button"], a').filter({
    hasText: /\u79c1\u4fe1|\u53d1\u79c1\u4fe1|\u53d1\u6d88\u606f|message/i,
  });
  return firstVisible(locator);
}

async function findMessageInput(page) {
  for (const selector of [
    'textarea',
    '[contenteditable="true"]',
    'input[placeholder*="\u6d88\u606f"]',
    'input[placeholder*="\u79c1\u4fe1"]',
    '[data-e2e*="message"]',
  ]) {
    const input = await firstVisible(page.locator(selector));
    if (input) return input;
  }
  return null;
}

async function sendMessage(page, messageBody) {
  const control = await clickMessageControl(page);
  if (!control) return 'message_button_not_found';
  await control.click().catch(() => {});
  await page.waitForTimeout(700);
  const afterOpenState = await accessState(page);
  if (afterOpenState !== 'ready') return afterOpenState;
  const input = await findMessageInput(page);
  if (!input) return 'message_input_not_found';
  await input.fill(messageBody);
  const sendControl = await firstVisible(page.locator('button, [role="button"]').filter({ hasText: /\u53d1\u9001|send/i }));
  if (sendControl) {
    await sendControl.click();
  } else {
    await input.press('Enter');
  }
  await page.waitForTimeout(900);
  const body = await visibleText(page);
  if (body.includes(messageBody)) return 'sent';
  const remaining = await input.inputValue().catch(async () => input.textContent().catch(() => messageBody));
  return text(remaining) ? 'send_verification_failed' : 'sent';
}

const ALREADY_FOLLOWING_MARKERS = /\u5df2\u5173\u6ce8|\u53d6\u6d88\u5173\u6ce8|following|unfollow/i;
const FOLLOW_MARKERS = /\u5173\u6ce8|follow/i;

async function findFollowControl(page) {
  const locator = page.locator('button, [role="button"]');
  const count = Math.min(await locator.count().catch(() => 0), 200);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const label = [
      await item.innerText().catch(() => ''),
      await item.getAttribute('aria-label').catch(() => ''),
      await item.getAttribute('title').catch(() => ''),
    ].join(' ').replace(/\s+/g, ' ').trim();
    if (FOLLOW_MARKERS.test(label)) return { control: item, label };
  }
  return null;
}

async function followProfile(page) {
  const initial = await findFollowControl(page);
  if (!initial) return 'follow_button_not_found';
  if (ALREADY_FOLLOWING_MARKERS.test(initial.label)) return 'already_following';
  await initial.control.click().catch(() => {});
  await page.waitForTimeout(900);
  const confirmed = await findFollowControl(page);
  const body = await visibleText(page);
  if (confirmed && ALREADY_FOLLOWING_MARKERS.test(confirmed.label)) return 'followed';
  if (ALREADY_FOLLOWING_MARKERS.test(body)) return 'followed';
  return 'follow_verification_failed';
}

async function run(payload, args) {
  const action = args.action === 'follow' ? 'follow' : 'message';
  const profileUrl = text(payload?.authorProfile) || text(payload?.postUrl);
  const messageBody = text(payload?.messageBody);
  if (!args.relayPort || !validDouyinUrl(profileUrl)
    || (action === 'message' && (!messageBody || messageBody.length > 2_000))) return { status: 'invalid_input' };
  const playwright = await loadPlaywright(args.configuredModulePath);
  const token = await gatewayToken();
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${args.relayPort}`, {
    headers: relayHeaders(args.relayPort, token),
    timeout: 20_000,
  });
  let page;
  try {
    const context = browser.contexts()[0];
    if (!context) return { status: 'relay_error' };
    page = await context.newPage();
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1_200);
    const state = await accessState(page);
    if (state !== 'ready') return { status: state };
    const status = action === 'follow' ? await followProfile(page) : await sendMessage(page, messageBody);
    return ['sent', 'followed', 'already_following'].includes(status)
      ? { status, profileUrl: profileUrl.replace(/[?#].*$/, '') }
      : { status };
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const payload = await readStdin();
    const result = await run(payload, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = ['sent', 'followed', 'already_following'].includes(result.status) ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'relay_error' })}\n`);
    process.exitCode = 6;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) void main();
