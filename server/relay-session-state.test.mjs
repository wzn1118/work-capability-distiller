import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRelaySessionRetention, relaySessionStateFile } from './relay-session-state.mjs';

test('relay session retention keeps only non-secret browser session metadata', async (t) => {
  const sessionStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kolforge-relay-session-'));
  t.after(() => fs.rm(sessionStateDir, { recursive: true, force: true }));
  const observedAt = '2026-07-23T06:00:00Z';
  await fs.writeFile(relaySessionStateFile(sessionStateDir, 'douyin'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: observedAt,
    sessionAnchor: 'opaque-diagnostic-anchor',
    cookies: ['must-not-be-returned'],
    token: 'must-not-be-returned',
    platforms: {
      douyin: {
        observedAt,
        tabCount: 5,
        state: 'ready',
        cookie: 'must-not-be-returned',
      },
    },
  }), 'utf8');

  const retention = await readRelaySessionRetention({
    sessionStateDir,
    platformIds: ['douyin', 'xiaohongshu'],
    profileAlias: 'attached-browser',
  });

  assert.deepEqual(retention.platforms.douyin, {
    persisted: true,
    observedAt,
    state: 'ready',
    tabCount: 5,
  });
  assert.deepEqual(retention.platforms.xiaohongshu, {
    persisted: false,
    observedAt: null,
    state: 'not_checked',
    tabCount: 0,
  });
  assert.equal(retention.lastSavedAt, observedAt);
  assert.equal(JSON.stringify(retention).includes('must-not-be-returned'), false);
  assert.equal(JSON.stringify(retention).includes('opaque-diagnostic-anchor'), false);
});

test('relay session state file rejects an invalid platform id', () => {
  assert.throws(() => relaySessionStateFile('C:/tmp/session', '../douyin'), /Invalid relay session platform id/);
});
