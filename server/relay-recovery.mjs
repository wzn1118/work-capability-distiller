import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { platformTargetConfig, planRelayRecovery, relayTargetSummary } from './relay-targets.mjs';

const DEFAULT_TIMEOUT_MS = 8_000;

export async function recoverRelay({
  platformId,
  port,
  profile = 'attached-browser',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  settleMs = 250,
  fetchImpl = fetch,
  webSocketImpl = globalThis.WebSocket,
  gatewayTokenResolver = resolveRelayToken,
  connectionChecker = async () => ({ ok: true }),
}) {
  const platform = platformTargetConfig(platformId);
  if (!platform) throw new Error(`Unsupported Relay platform: ${platformId}`);
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error('Relay port is invalid.');
  }
  if (typeof webSocketImpl !== 'function') throw new Error('Browser Relay CDP WebSocket is unavailable.');

  const relayToken = await gatewayTokenResolver({ port });
  const beforeTargets = await readRelayTargets({ port, relayToken, timeoutMs, fetchImpl });
  const plan = planRelayRecovery(beforeTargets, platformId);
  const version = await readRelayJson({ port, pathname: '/json/version', relayToken, timeoutMs, fetchImpl });
  const rawWebSocketUrl = String(version.value?.webSocketDebuggerUrl || '').trim();
  if (!rawWebSocketUrl) throw new Error('Relay version response has no WebSocket endpoint.');

  const client = await createCdpClient({
    webSocketUrl: appendRelayToken(rawWebSocketUrl, version.authenticated ? relayToken : ''),
    timeoutMs,
    webSocketImpl,
  });
  const warnings = [];
  let keeperId = String(plan.keeper?.id || '');
  let createdFreshTarget = false;
  let closedTargets = 0;

  try {
    if (plan.replaceWithFreshPage) {
      const created = await client.command('Target.createTarget', { url: platform.rootUrl });
      keeperId = String(created?.targetId || '');
      if (!keeperId) throw new Error(`Relay did not return a replacement ${platformId} target id.`);
      createdFreshTarget = true;
    }
    for (const target of plan.closeTargets) {
      try {
        const result = await client.command('Target.closeTarget', { targetId: String(target.id) });
        if (result?.success !== false) closedTargets += 1;
      } catch (error) {
        warnings.push(`Could not close target ${target.id}: ${publicError(error)}`);
      }
    }
    if (keeperId) {
      try {
        await client.command('Target.activateTarget', { targetId: keeperId });
      } catch (error) {
        warnings.push(`Could not activate the clean target: ${publicError(error)}`);
      }
    }
    await client.command('Browser.getVersion');
  } finally {
    client.close();
  }

  if (settleMs > 0) await delay(settleMs);
  const afterTargets = await readRelayTargets({ port, relayToken, timeoutMs, fetchImpl });
  const after = relayTargetSummary(afterTargets, platformId);
  const check = await connectionChecker({ platformId, port, after });
  const ok = Boolean(check?.ok && after.platformTabs > 0);

  return {
    ok,
    ready: ok,
    running: true,
    cdpReady: true,
    authenticated: version.authenticated,
    repaired: createdFreshTarget || closedTargets > 0,
    platform: platformId,
    port: Number(port),
    profile,
    tabs: after.targetCount,
    tabCount: after.targetCount,
    platformTabs: after.platformTabs,
    pageCount: after.pageCount,
    targetPressure: after.pressure,
    recoveryRecommended: after.recoveryRecommended,
    before: plan.summary,
    after,
    closedTargets,
    createdFreshTarget,
    sessionPreserved: true,
    checkedAt: new Date().toISOString(),
    warnings,
    message: ok
      ? `Relay recovered for ${platformId}: closed ${closedTargets} stale page(s) and verified the platform target.`
      : `Relay cleanup finished for ${platformId}, but connection verification did not pass.`,
    check,
  };
}

async function readRelayTargets(options) {
  const response = await readRelayJson({ ...options, pathname: '/json/list' });
  if (!Array.isArray(response.value)) throw new Error('Relay returned an invalid target list.');
  return response.value;
}

async function readRelayJson({ port, pathname, relayToken, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = (headers) => fetchImpl(`http://127.0.0.1:${port}${pathname}`, {
      ...(Object.keys(headers).length ? { headers } : {}),
      signal: controller.signal,
    });
    let response = await request(relayToken ? { 'x-openclaw-relay-token': relayToken } : {});
    const authenticated = Boolean(relayToken && response.ok);
    if (!response.ok && relayToken) response = await request({});
    if (!response.ok) throw new Error(`Relay responded with HTTP ${response.status}.`);
    return { value: await response.json(), authenticated };
  } finally {
    clearTimeout(timer);
  }
}

function createCdpClient({ webSocketUrl, timeoutMs, webSocketImpl }) {
  return new Promise((resolve, reject) => {
    let socket;
    let nextId = 0;
    let opened = false;
    const pending = new Map();
    const openTimer = setTimeout(() => finishOpen(new Error('Relay CDP WebSocket open timed out.')), timeoutMs);

    const listen = (event, handler) => {
      if (typeof socket?.addEventListener === 'function') socket.addEventListener(event, handler);
      else socket?.on?.(event, handler);
    };
    const finishOpen = (error) => {
      if (opened) return;
      opened = true;
      clearTimeout(openTimer);
      if (error) reject(error);
      else resolve({
        command(method, params = {}) {
          const id = ++nextId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`Relay CDP command ${method} timed out.`));
            }, timeoutMs);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { socket.close(); } catch {}
        },
      });
    };

    try {
      socket = new webSocketImpl(webSocketUrl);
      listen('open', () => finishOpen());
      listen('message', (event) => {
        const raw = typeof event === 'string' ? event : event?.data ?? event;
        const text = typeof raw === 'string' ? raw : raw ? Buffer.from(raw).toString('utf8') : '';
        let payload;
        try { payload = JSON.parse(text); } catch { return; }
        const request = pending.get(payload?.id);
        if (!request) return;
        pending.delete(payload.id);
        clearTimeout(request.timer);
        if (payload.error) request.reject(new Error(payload.error.message || 'Relay CDP command failed.'));
        else request.resolve(payload.result || {});
      });
      listen('error', (event) => finishOpen(new Error(event?.message || 'Relay CDP WebSocket failed.')));
      listen('close', () => finishOpen(new Error('Relay CDP WebSocket closed before opening.')));
    } catch (error) {
      finishOpen(error);
    }
  });
}

export async function resolveRelayToken({ port }) {
  const environmentToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  const gatewayToken = environmentToken || await readGatewayTokenFile();
  if (!gatewayToken) return '';
  return createHmac('sha256', gatewayToken)
    .update(`openclaw-extension-relay-v1:${port}`)
    .digest('hex');
}

async function readGatewayTokenFile() {
  const openclawDirectory = path.join(os.homedir(), '.openclaw');
  try {
    const payload = JSON.parse(await fs.readFile(path.join(openclawDirectory, 'openclaw.json'), 'utf8'));
    const token = String(payload?.gateway?.auth?.token || '').trim();
    if (token) return token;
  } catch {}
  try {
    const command = await fs.readFile(path.join(openclawDirectory, 'gateway.cmd'), 'utf8');
    const match = command.match(/OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)/);
    return String(match?.[1] || '').trim();
  } catch {
    return '';
  }
}

function appendRelayToken(webSocketUrl, relayToken) {
  if (!relayToken) return webSocketUrl;
  const parsed = new URL(webSocketUrl);
  parsed.searchParams.set('token', relayToken);
  return parsed.toString();
}

function publicError(error) {
  return String(error?.message || error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 240);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
