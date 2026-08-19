import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { searchSessionSourcesContent } from './lib/session-content-search.mjs';

test('会话搜索同时覆盖标题、用户消息、助手回复和网页工具事件', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-content-search-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const localPath = path.join(root, 'local.jsonl');
  const webPath = path.join(root, 'web.jsonl');
  await fsp.writeFile(localPath, [
    { type: 'session_meta', payload: { id: 'local-1', title: '本机测试标题' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '正文里的稀有检索词：玄铁报告' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '助手给出了完整处理步骤' }] } },
  ].map(JSON.stringify).join('\n'), 'utf8');
  await fsp.writeFile(webPath, [
    { type: 'session_meta', payload: { id: 'web-1', title: 'ChatGPT 历史会话' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ChatGPT 后续回复包含蓝鲸证据链' }] } },
    { type: 'web_event', payload: { type: 'image2', prompt: '生成赤色城门图片' } },
  ].map(JSON.stringify).join('\n'), 'utf8');
  const sources = [
    { sourceKey: 'local-1', sessionId: 'local-1', title: '本机测试标题', sourcePath: localPath, modifiedAt: '2026-08-18T01:00:00Z' },
    { sourceKey: 'web-1', sessionId: 'web-1', title: 'ChatGPT 历史会话', sourcePath: webPath, modifiedAt: '2026-08-18T02:00:00Z', importKind: 'web-chat', webChat: { platform: 'chatgpt', platformName: 'ChatGPT' } },
  ];

  const title = await searchSessionSourcesContent({ sources, query: '本机测试标题' });
  assert.equal(title.matches[0].field, '标题');
  const progress = [];
  const localContent = await searchSessionSourcesContent({ sources, query: '玄铁报告', onProgress: (event) => progress.push(event) });
  assert.equal(localContent.matches[0].field, '用户消息');
  assert.match(localContent.matches[0].snippet, /玄铁报告/);
  assert.ok(progress.some((event) => event.phase === 'content'));
  const chatGptContent = await searchSessionSourcesContent({ sources, query: '蓝鲸证据链' });
  assert.equal(chatGptContent.matches[0].sourceKey, 'web-1');
  assert.equal(chatGptContent.matches[0].field, '助手回复');
  const imageCall = await searchSessionSourcesContent({ sources, query: '赤色城门' });
  assert.equal(imageCall.matches[0].field, '网页工具调用');
  assert.equal(imageCall.contentMatchCount, 1);
});

test('全文搜索收到取消信号时不会继续读取文件', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-content-search-cancel-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'cancel.jsonl');
  await fsp.writeFile(sourcePath, `${JSON.stringify({ type: 'message', role: 'user', content: 'cancel-me' })}\n`, 'utf8');
  const result = await searchSessionSourcesContent({
    sources: [{ sourceKey: 'cancel-1', title: '取消测试', sourcePath }],
    query: 'cancel-me',
    shouldStop: () => true,
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.scannedCount, 1);
});
