import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deliverOutreachMessage, deliveryConfigSummary } from './outreach-delivery.mjs';

const message = {
  id: 'message-1',
  platform: 'douyin',
  postId: 'post-1',
  postUrl: 'https://www.douyin.com/video/123',
  authorName: 'Creator',
  authorProfile: 'https://www.douyin.com/user/creator',
  messageBody: 'Hello',
  query: 'short hair',
  sourceUrl: 'https://www.douyin.com/search/short-hair',
  campaignId: null,
};

test('uses local outbox when no provider endpoint is configured', async () => {
  const config = { mode: 'local_outbox', url: '', token: '', timeoutMs: 1000 };
  assert.deepEqual(deliveryConfigSummary(config), {
    mode: 'local_outbox',
    configured: false,
    endpointConfigured: false,
    tokenConfigured: false,
    timeoutMs: 1000,
    deliveryLabel: 'local_outbox',
  });
  assert.deepEqual(await deliverOutreachMessage(message, config), {
    status: 'queued',
    delivery: 'local_outbox',
    provider: null,
  });
});

test('recognizes an independent browser Relay as a configured delivery channel', () => {
  const summary = deliveryConfigSummary({
    mode: 'browser_relay',
    url: '',
    token: '',
    timeoutMs: 30_000,
    node: process.execPath,
    script: 'send_douyin_message_relay.mjs',
    relayPort: 18_801,
  });
  assert.equal(summary.configured, true);
  assert.equal(summary.deliveryLabel, 'browser_relay');
  assert.equal(summary.endpointConfigured, false);
});

test('posts the normalized message to a configured provider', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(202, { 'content-type': 'application/json', 'x-request-id': 'provider-1' });
      response.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await deliverOutreachMessage(message, {
    mode: 'partner_http',
    url: `http://127.0.0.1:${port}/messages`,
    token: 'test-token',
    timeoutMs: 2000,
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.delivery, 'partner_http');
  assert.equal(result.provider.requestId, 'provider-1');
  assert.equal(requests[0].headers.authorization, 'Bearer test-token');
  assert.equal(requests[0].body.messageBody, 'Hello');
  assert.equal(requests[0].body.postUrl, message.postUrl);
});
