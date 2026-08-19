import { spawn } from 'node:child_process';

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export class OutreachRelayError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'OutreachRelayError';
    this.code = code;
    this.status = status;
  }
}

function lastJsonLine(output) {
  const lines = String(output || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      // The relay script keeps its result on one JSON line. Ignore diagnostics.
    }
  }
  return null;
}

function relayFailure(result) {
  const failures = {
    login_required: ['DOUYIN_RELAY_LOGIN_REQUIRED', 'Douyin browser session requires login.', 409],
    verification_required: ['DOUYIN_RELAY_VERIFICATION_REQUIRED', 'Douyin browser session requires verification.', 409],
    message_button_not_found: ['DOUYIN_RELAY_MESSAGE_BUTTON_NOT_FOUND', 'The Douyin profile did not expose a private-message control.', 502],
    message_input_not_found: ['DOUYIN_RELAY_MESSAGE_INPUT_NOT_FOUND', 'The Douyin private-message editor did not appear.', 502],
    send_button_not_found: ['DOUYIN_RELAY_SEND_BUTTON_NOT_FOUND', 'The Douyin private-message send control did not appear.', 502],
    send_verification_failed: ['DOUYIN_RELAY_SEND_VERIFICATION_FAILED', 'The Douyin page did not confirm that the private message was sent.', 502],
    follow_button_not_found: ['DOUYIN_RELAY_FOLLOW_BUTTON_NOT_FOUND', 'The Douyin profile did not expose a follow control.', 502],
    follow_verification_failed: ['DOUYIN_RELAY_FOLLOW_VERIFICATION_FAILED', 'The Douyin page did not confirm that the profile was followed.', 502],
    invalid_input: ['DOUYIN_RELAY_INVALID_INPUT', 'The selected Douyin profile or action input is invalid.', 400],
    relay_error: ['DOUYIN_RELAY_UNREACHABLE', 'The Douyin browser Relay could not complete the requested action.', 502],
  };
  const [code, message, status] = failures[result?.status] || failures.relay_error;
  return new OutreachRelayError(code, message, status);
}

async function runDouyinRelayAction(action, inputPayload, config, acceptedStatuses, actionLabel) {
  const timeoutMs = Math.max(5_000, Math.min(Number(config.timeoutMs) || 30_000, 120_000));
  const command = config.node || process.execPath;
  const script = config.script;
  if (!script || !config.relayPort) throw new OutreachRelayError('DOUYIN_RELAY_NOT_CONFIGURED', 'Douyin message Relay is not configured.', 503);

  const args = [
    script,
    '--relay-port', String(config.relayPort),
    '--playwright-module-path', config.playwrightModulePath || '',
    '--action', action,
  ];
  const child = spawn(command, args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  try {
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stdout.on('data', (chunk) => {
        if (Buffer.byteLength(stdout, 'utf8') < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (Buffer.byteLength(stderr, 'utf8') < 16_000) stderr += chunk.toString('utf8');
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.stdin.end(JSON.stringify(inputPayload));
    });
    if (timedOut) throw new OutreachRelayError('DOUYIN_RELAY_TIMEOUT', `Douyin browser Relay ${actionLabel} action timed out.`, 504);
    const resultPayload = lastJsonLine(stdout);
    if (!resultPayload || !acceptedStatuses.has(resultPayload.status) || result.code !== 0) {
      if (resultPayload) throw relayFailure(resultPayload);
      throw new OutreachRelayError('DOUYIN_RELAY_UNREACHABLE', 'The Douyin browser Relay returned no usable result.', 502);
    }
    return resultPayload;
  } catch (error) {
    if (error instanceof OutreachRelayError) throw error;
    if (timedOut) throw new OutreachRelayError('DOUYIN_RELAY_TIMEOUT', `Douyin browser Relay ${actionLabel} action timed out.`, 504);
    if (error?.code === 'ENOENT') throw new OutreachRelayError('DOUYIN_RELAY_UNREACHABLE', 'The Douyin browser Relay runner could not be started.', 502);
    throw new OutreachRelayError('DOUYIN_RELAY_UNREACHABLE', 'The Douyin browser Relay could not be reached.', 502);
  } finally {
    clearTimeout(timer);
    void stderr;
  }
}

export async function deliverDouyinMessageViaRelay(message, config) {
  const result = await runDouyinRelayAction('message', {
    messageId: message.id,
    authorProfile: message.authorProfile,
    postUrl: message.postUrl,
    authorName: message.authorName,
    messageBody: message.messageBody,
  }, config, new Set(['sent']), 'message');
  return {
    status: 'sent',
    delivery: 'browser_relay',
    provider: {
      relayPort: Number(config.relayPort),
      verified: true,
      profileUrl: result.profileUrl || null,
    },
  };
}

export async function deliverDouyinFollowViaRelay(profile, config) {
  const profileUrl = profile.authorProfile || profile.sourceUrl || profile.profileUrl;
  const result = await runDouyinRelayAction('follow', {
    profileUrl,
    authorProfile: profileUrl,
    authorName: profile.authorName || profile.name || '',
  }, config, new Set(['followed', 'already_following']), 'follow');
  return {
    status: result.status,
    delivery: 'browser_relay',
    provider: {
      relayPort: Number(config.relayPort),
      verified: true,
      profileUrl: result.profileUrl || profileUrl || null,
    },
  };
}
