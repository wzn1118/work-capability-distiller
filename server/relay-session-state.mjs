import fs from 'node:fs/promises';
import path from 'node:path';

const SESSION_STATES = new Set([
  'ready',
  'login_required',
  'verification_required',
  'not_checked',
  'unknown',
]);
const PLATFORM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function safeTabCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.max(0, Math.min(count, 10_000)) : 0;
}

export function relaySessionStateFile(sessionStateDir, platformId) {
  if (!PLATFORM_ID_PATTERN.test(platformId)) throw new Error('Invalid relay session platform id.');
  return path.join(sessionStateDir, `${platformId}.json`);
}

export function normalizeRelaySessionRecord(payload, platformId) {
  const entry = payload?.platforms?.[platformId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { persisted: false, observedAt: null, state: 'not_checked', tabCount: 0 };
  }
  const state = SESSION_STATES.has(entry.state) ? entry.state : 'not_checked';
  return {
    persisted: true,
    observedAt: safeTimestamp(entry.observedAt) || safeTimestamp(payload.updatedAt),
    state,
    tabCount: safeTabCount(entry.tabCount),
  };
}

export async function readRelaySessionRecord({ sessionStateDir, platformId }) {
  const filePath = relaySessionStateFile(sessionStateDir, platformId);
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return normalizeRelaySessionRecord(payload, platformId);
  } catch {
    return { persisted: false, observedAt: null, state: 'not_checked', tabCount: 0 };
  }
}

export async function readRelaySessionRetention({ sessionStateDir, platformIds, profileAlias }) {
  const entries = await Promise.all(platformIds.map(async (platformId) => [
    platformId,
    await readRelaySessionRecord({ sessionStateDir, platformId }),
  ]));
  const platforms = Object.fromEntries(entries);
  const observedTimes = Object.values(platforms)
    .map((entry) => entry.observedAt)
    .filter(Boolean)
    .sort();
  return {
    mechanism: 'attached_browser_profile',
    profileAlias,
    credentialStorage: 'browser_profile_encrypted',
    appCredentialStorage: 'not_used',
    statusPersistence: 'local_non_secret_metadata',
    recheck: 'connector_preflight',
    lastSavedAt: observedTimes.at(-1) || null,
    platforms,
  };
}
