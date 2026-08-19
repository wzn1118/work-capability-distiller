import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelayRecovery, relayTargetSummary } from './relay-targets.mjs';
import { recoverRelay } from './relay-recovery.mjs';

const xhsPage = (id, url) => ({ id, type: 'page', title: 'page', url });
const douyinPage = (id, url) => ({ id, type: 'page', title: 'page', url });

test('recovery plan only closes targets belonging to the requested platform', () => {
  const targets = [
    xhsPage('xhs-1', 'https://www.xiaohongshu.com/explore'),
    douyinPage('dy-1', 'https://www.douyin.com/search/demo'),
    { id: 'worker-1', type: 'service_worker', url: 'https://www.douyin.com/' },
  ];
  const plan = planRelayRecovery(targets, 'douyin');
  assert.equal(plan.closeTargets.length, 0);
  assert.equal(plan.replaceWithFreshPage, false);
  assert.equal(plan.keeper.id, 'dy-1');
  assert.equal(relayTargetSummary(targets, 'douyin').unrelatedPages, 1);
});

test('recovery creates a platform target when the requested platform is absent', () => {
  const plan = planRelayRecovery([xhsPage('xhs-1', 'https://www.xiaohongshu.com/explore')], 'douyin');
  assert.equal(plan.replaceWithFreshPage, true);
  assert.deepEqual(plan.closeTargets, []);
});

test('recovery uses CDP commands and keeps the other platform untouched', async () => {
  const commands = [];
  const responses = {
    before: [xhsPage('xhs-1', 'https://www.xiaohongshu.com/explore'), douyinPage('dy-1', 'https://www.douyin.com/search/demo'), douyinPage('dy-2', 'https://www.douyin.com/video/2'), douyinPage('dy-3', 'https://www.douyin.com/video/3')],
    after: [xhsPage('xhs-1', 'https://www.xiaohongshu.com/explore'), douyinPage('dy-new', 'https://www.douyin.com/')],
  };
  let listReads = 0;
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: 'ws://127.0.0.1:18801/devtools/browser/test' };
      listReads += 1;
      return listReads === 1 ? responses.before : responses.after;
    },
  });
  class FakeWebSocket {
    constructor() { setTimeout(() => this.onopen?.(), 0); }
    addEventListener(event, handler) { this[`on${event}`] = handler; }
    send(raw) {
      const message = JSON.parse(raw);
      commands.push(message);
      const result = message.method === 'Target.createTarget' ? { targetId: 'dy-new' } : { success: true };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  }
  const result = await recoverRelay({
    platformId: 'douyin',
    port: 18801,
    settleMs: 0,
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    gatewayTokenResolver: async () => '',
    connectionChecker: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.createdFreshTarget, true);
  assert.deepEqual(commands.map((command) => command.method), ['Target.createTarget', 'Target.closeTarget', 'Target.closeTarget', 'Target.closeTarget', 'Target.activateTarget', 'Browser.getVersion']);
  assert.equal(commands.filter((command) => command.method === 'Target.closeTarget').every((command) => ['dy-1', 'dy-2', 'dy-3'].includes(command.params.targetId)), true);
});
