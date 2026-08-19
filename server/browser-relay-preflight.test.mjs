import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPlatformPage,
  pageAccessState,
  parseArgs,
  relayTargetSnapshot,
} from './scripts/browser_relay_preflight.mjs';

test('relay preflight accepts only HTTPS pages from the requested platform domain', () => {
  assert.equal(isPlatformPage('douyin', 'https://www.douyin.com/jingxuan'), true);
  assert.equal(isPlatformPage('douyin', 'https://evil-douyin.com/'), false);
  assert.equal(isPlatformPage('douyin', 'http://www.douyin.com/'), false);
});

test('relay preflight classifies visible login and verification states without retaining text', () => {
  assert.equal(pageAccessState('https://www.douyin.com/', '\u8bf7\u767b\u5f55\u540e\u67e5\u770b'), 'login_required');
  assert.equal(pageAccessState('https://www.douyin.com/security/verify', ''), 'verification_required');
  assert.equal(pageAccessState('https://www.douyin.com/', '\u9996\u9875'), 'ready');
});

test('relay preflight parses an explicit local Playwright module path', () => {
  assert.deepEqual(parseArgs([
    '--platform', 'douyin',
    '--relay-port', '18800',
    '--state-file', 'C:\\status.json',
    '--playwright-module-path', 'C:\\tools\\node_modules',
  ]), {
    help: false,
    platform: 'douyin',
    relayPort: 18800,
    stateFile: 'C:\\status.json',
    configuredModulePath: 'C:\\tools\\node_modules',
    openPlatformPage: false,
  });
});

test('relay preflight derives a lightweight target snapshot without attaching Playwright', () => {
  const snapshot = relayTargetSnapshot([
    { type: 'page', url: 'chrome-extension://relay/options.html' },
    { type: 'service_worker', url: 'https://www.douyin.com/worker.js' },
    { type: 'page', url: 'https://www.douyin.com/user/example' },
  ], 'douyin', 18_800);
  assert.equal(snapshot.page_count, 2);
  assert.equal(snapshot.platform_tab_count, 1);
  assert.equal(snapshot.platform_session_state, 'unknown');

  const blocked = relayTargetSnapshot([
    { type: 'page', url: 'https://www.douyin.com/security/verify' },
  ], 'douyin', 18_800);
  assert.equal(blocked.platform_session_state, 'verification_required');
});
