import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatGptWebBridge } from './templates/root-capability/agent/runtime/chatgpt-web-link.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.join(root, 'templates', 'root-capability', 'agent', 'chatgpt-companion');

function request(token = '') {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('网页伴侣保留真实目录、项目归属和完整会话元数据', () => {
  const bridge = createChatGptWebBridge({ companionRoot, getAgentUrl: () => 'http://127.0.0.1:8794' });
  const status = bridge.status();
  const pairing = bridge.pair({ pairingCode: status.pairingCode, browserName: '测试 Edge' });
  const auth = request(pairing.token);
  bridge.heartbeat(auth, { pageUrl: 'https://chatgpt.com/', pagePlatform: 'chatgpt' });

  const historyJob = bridge.enqueue({ type: 'history-index', platform: 'chatgpt' });
  bridge.nextJob(auth);
  const completedHistory = bridge.complete(auth, historyJob.id, {
    history: {
      platform: 'chatgpt',
      currentUrl: 'https://chatgpt.com/',
      conversations: [{
        conversationId: 'conv-1',
        title: '真实会话一',
        url: 'https://chatgpt.com/c/conv-1',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
        projectId: 'project-1',
        projectTitle: '项目一',
      }],
      scan: { mode: 'same-origin-api', discoveredCount: 1, exhausted: true },
    },
  });
  assert.equal(completedHistory.result.history.conversations[0].conversationId, 'conv-1');
  assert.equal(completedHistory.result.history.conversations[0].projectTitle, '项目一');
  assert.equal(completedHistory.result.history.scan.discoveredCount, 1);

  const batchJob = bridge.enqueue({
    type: 'capture-all',
    platform: 'chatgpt',
    conversations: completedHistory.result.history.conversations,
  });
  const queuedBatch = bridge.nextJob(auth).job;
  assert.equal(queuedBatch.totalCount, 1);
  assert.equal(queuedBatch.conversations.length, 1);
  assert.equal(queuedBatch.conversations[0].conversationId, 'conv-1');
  bridge.progress(auth, batchJob.id, {
    completedCount: 1,
    failedCount: 0,
    snapshot: {
      platform: 'chatgpt',
      conversationId: 'conv-1',
      title: '真实会话一',
      url: 'https://chatgpt.com/c/conv-1',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
      projectId: 'project-1',
      projectTitle: '项目一',
      messages: [
        { role: 'user', content: '第一条用户消息', messageId: 'u-1' },
        { role: 'assistant', content: '第一条助手消息', messageId: 'a-1' },
      ],
    },
  });
  const completedBatch = bridge.complete(auth, batchJob.id, { capturedCount: 1, failedCount: 0, capturesFromProgress: true });
  const snapshot = completedBatch.result.captures[0];
  assert.equal(snapshot.conversationId, 'conv-1');
  assert.equal(snapshot.projectId, 'project-1');
  assert.equal(snapshot.messages.length, 2);
});

test('ChatGPT 网页读取优先使用分页同源接口并分批返回完整会话', async () => {
  const content = await fs.readFile(path.join(companionRoot, 'content.js'), 'utf8');
  const background = await fs.readFile(path.join(companionRoot, 'background.js'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(companionRoot, 'manifest.json'), 'utf8'));
  const popup = await fs.readFile(path.join(companionRoot, 'popup.js'), 'utf8');
  assert.match(content, /backend-api\/conversations\?offset=/);
  assert.match(content, /backend-api\/gizmos\/snorlax\/sidebar/);
  assert.match(content, /chatgptApiJsonFirst/);
  assert.match(content, /projectEndpoint/);
  assert.match(content, /retry-after/);
  assert.match(content, /\[408, 425, 429\]/);
  assert.match(content, /2 \*\* attempt/);
  assert.match(content, /15_000 \* \(attempt \+ 1\)/);
  assert.match(content, /chatgptApiRequestGapMs/);
  assert.match(content, /fetchChatgptApi/);
  assert.match(content, /new AbortController\(\)/);
  assert.match(content, /controller\.abort\(\), 30_000/);
  assert.match(content, /signal: controller\.signal/);
  assert.match(content, /网页接口请求超时或网络失败/);
  assert.match(content, /backend-api\/conversation\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(content, /current_node/);
  assert.match(content, /rawPayload/);
  assert.match(content, /branches:/);
  assert.match(content, /eventType/);
  assert.match(content, /image_generation/);
  assert.match(content, /chatgptAssetRefs/);
  assert.match(content, /page < 10_000/);
  assert.match(content, /PAGE_READER_VERSION = '2\.5\.0'/);
  assert.match(content, /capture-all-api/);
  assert.match(background, /offset \+= 4/);
  assert.match(background, /executeChatGptApiBatchJob/);
  assert.match(background, /capturesFromProgress/);
  assert.match(content, /Promise\.all\(Array\.from\(\{ length: Math\.min\(2, items\.length\) \}/);
  assert.match(content, /const captureOne = async \(item\)/);
  assert.match(content, /setTimeout\(resolve, 250\)/);
  assert.match(content, /return \{ captures, failures, capturedCount/);
  assert.match(background, /读取失败：/);
  assert.match(background, /failure: \{ conversationId/);
  assert.ok(manifest.permissions.includes('scripting'));
  assert.match(content, /chatgpt-companion:ping/);
  assert.match(content, /__capabilityWebChatPageReaderInstalled/);
  assert.match(background, /preparePageReader/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /chrome\.tabs\.reload/);
  assert.match(background, /EXPECTED_PAGE_READER_VERSION/);
  assert.match(background, /response\.version !== EXPECTED_PAGE_READER_VERSION/);
  assert.match(background, /await ensurePageReader\(tab, selected\)/);
  assert.match(popup, /deploymentReloadRequested/);
  assert.match(popup, /chrome\.runtime\.reload/);
  assert.match(background, /for \(const item of conversations\) \{\s*let tab = null;\s*try \{\s*await honorJobControl\(job\.id, await api\(`\/jobs\/\$\{encodeURIComponent\(job\.id\)\}`\)\)/);
  assert.match(background, /const representedFailed = Math\.max\(chunkFailures\.length, chunk\.length - chunkCaptures\.length\);/);
  assert.match(background, /for \(const failure of chunkFailures\) \{/);
});

test('连接状态区分扩展后台和页面读取器就绪状态', () => {
  const bridge = createChatGptWebBridge({ companionRoot, getAgentUrl: () => 'http://127.0.0.1:8794' });
  const pairing = bridge.pair({ pairingCode: bridge.status().pairingCode, browserName: '测试 Edge' });
  const auth = request(pairing.token);
  bridge.heartbeat(auth, {
    pageUrl: 'https://chatgpt.com/c/conv-ready',
    pagePlatform: 'chatgpt',
    pageReaderReady: true,
    pageReaderVersion: '2.3.0',
    pageReaderError: '',
  });
  const status = bridge.status();
  assert.equal(status.connected, true);
  assert.equal(status.pageReaderReady, true);
  assert.equal(status.pageReaderVersion, '2.3.0');
  assert.equal(status.pageReaderError, '');
});

test('网页批量读取支持暂停、继续和取消，并暴露进度控制状态', () => {
  const bridge = createChatGptWebBridge({ companionRoot, getAgentUrl: () => 'http://127.0.0.1:8794' });
  const pairing = bridge.pair({ pairingCode: bridge.status().pairingCode, browserName: '测试 Edge' });
  const auth = request(pairing.token);
  const job = bridge.enqueue({ type: 'capture-all', platform: 'chatgpt', conversations: Array.from({ length: 3 }, (_, index) => ({
    conversationId: `pause-${index + 1}`,
    title: `暂停测试 ${index + 1}`,
    url: `https://chatgpt.com/c/pause-${index + 1}`,
  })) });
  bridge.nextJob(auth);
  const paused = bridge.pauseJob(job.id);
  assert.equal(paused.status, '已暂停');
  assert.equal(paused.control, 'pause');
  assert.equal(paused.phase, 'paused');
  const resumed = bridge.resumeJob(job.id);
  assert.equal(resumed.control, 'continue');
  assert.equal(resumed.phase, 'capturing');
  const cancelled = bridge.cancelJob(job.id);
  assert.equal(cancelled.status, '已取消');
  assert.equal(cancelled.control, 'cancel');
});
