import { deliverDouyinMessageViaRelay, OutreachRelayError } from './outreach-relay.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class OutreachDeliveryError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'OutreachDeliveryError';
    this.code = code;
    this.status = status;
  }
}

export function deliveryConfigSummary(config) {
  const configured = config.mode === 'partner_http'
    ? Boolean(config.url)
    : config.mode === 'browser_relay'
      ? Boolean(config.relayPort && config.node && config.script)
      : false;
  return {
    mode: config.mode,
    configured,
    endpointConfigured: Boolean(config.url),
    tokenConfigured: Boolean(config.token),
    timeoutMs: config.timeoutMs,
    deliveryLabel: configured ? config.mode : 'local_outbox',
  };
}

async function readResponsePayload(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new OutreachDeliveryError('MESSAGE_PROVIDER_PAYLOAD_TOO_LARGE', 'Message provider response exceeds the local size limit.');
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 2000) };
  }
}

export async function deliverOutreachMessage(message, config) {
  const summary = deliveryConfigSummary(config);
  if (!summary.configured) {
    return { status: 'queued', delivery: 'local_outbox', provider: null };
  }

  if (config.mode === 'browser_relay') {
    try {
      return await deliverDouyinMessageViaRelay(message, config);
    } catch (error) {
      if (error instanceof OutreachRelayError) {
        throw new OutreachDeliveryError(error.code, error.message, error.status);
      }
      throw new OutreachDeliveryError('DOUYIN_RELAY_UNREACHABLE', 'The Douyin browser Relay could not complete the message action.', 502);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({
        messageId: message.id,
        platform: message.platform,
        postId: message.postId,
        postUrl: message.postUrl,
        authorName: message.authorName,
        authorProfile: message.authorProfile,
        messageBody: message.messageBody,
        query: message.query,
        sourceUrl: message.sourceUrl,
        campaignId: message.campaignId,
      }),
      signal: controller.signal,
    });
    const providerPayload = await readResponsePayload(response);
    if (response.status === 401 || response.status === 403) {
      throw new OutreachDeliveryError('MESSAGE_PROVIDER_AUTH_FAILED', 'Message provider rejected the configured token.', 502);
    }
    if (response.status === 429) {
      throw new OutreachDeliveryError('MESSAGE_PROVIDER_RATE_LIMITED', 'Message provider rate-limited this request.', 429);
    }
    if (!response.ok) {
      throw new OutreachDeliveryError('MESSAGE_PROVIDER_HTTP_ERROR', `Message provider returned HTTP ${response.status}.`, 502);
    }
    return {
      status: 'sent',
      delivery: 'partner_http',
      provider: {
        status: response.status,
        requestId: response.headers.get('x-request-id') || response.headers.get('request-id') || null,
        response: providerPayload,
      },
    };
  } catch (error) {
    if (error instanceof OutreachDeliveryError) throw error;
    if (error?.name === 'AbortError') {
      throw new OutreachDeliveryError('MESSAGE_PROVIDER_TIMEOUT', 'Message provider request timed out.', 504);
    }
    throw new OutreachDeliveryError('MESSAGE_PROVIDER_UNREACHABLE', 'Message provider could not be reached.', 502);
  } finally {
    clearTimeout(timeout);
  }
}
