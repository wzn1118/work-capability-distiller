import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  importChatGPTExport,
  listChatGPTExportRecords,
  reconcileChatGPTRecords,
} from './lib/chatgpt-export-store.mjs';

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralParts.length, 8);
  end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function exportFixture() {
  return [{
    conversation_id: 'chatgpt-real-001',
    title: '真实的报告重构会话',
    create_time: 1787000000,
    update_time: 1787000012,
    current_node: 'assistant-1',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        message: { author: { role: 'user' }, create_time: 1787000001, content: { content_type: 'text', parts: ['请把报告改成可审计的中文版本'] } },
      },
      'assistant-1': {
        id: 'assistant-1',
        parent: 'user-1',
        message: { author: { role: 'assistant' }, create_time: 1787000002, content: { content_type: 'text', parts: ['我会读取原始文件、修改模板并运行验证。'] } },
      },
    },
  }];
}

test('导入官方 ZIP 会保留真实标题、完整消息和可追溯路径', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-export-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const buffer = storedZip({ 'conversations.json': JSON.stringify(exportFixture()) });
  const imported = await importChatGPTExport({ buffer, root, originalName: 'conversations.zip' });

  assert.equal(imported.recordCount, 1);
  assert.match(imported.sourcePath, /conversations\.ndjson$/);
  assert.equal(imported.records[0].conversationId, 'chatgpt-real-001');
  assert.equal(imported.records[0].title, '真实的报告重构会话');
  assert.deepEqual(imported.records[0].messages.map((message) => message.role), ['user', 'assistant']);
  assert.match(imported.records[0].messages[0].content, /可审计/);
  assert.equal((await listChatGPTExportRecords(root)).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'imports', imported.runId, 'manifest.json'), 'utf8')).sourcePath, imported.sourcePath);
});

test('官方导出与网页端快照按会话编号对账，并标记冲突与缺失', () => {
  const record = {
    ...exportFixture()[0],
    conversationId: 'chatgpt-real-001',
    messages: [{ role: 'user', content: '请把报告改成可审计的中文版本' }, { role: 'assistant', content: '我会读取原始文件、修改模板并运行验证。' }],
    contentHash: crypto.createHash('sha256').update(JSON.stringify([{ role: 'user', content: '请把报告改成可审计的中文版本' }, { role: 'assistant', content: '我会读取原始文件、修改模板并运行验证。' }])).digest('hex'),
    sourceType: 'chatgpt-export',
    completeness: 'complete-export',
  };
  const matched = reconcileChatGPTRecords([record], [{ ...record, sourceType: 'chatgpt-edge', capturedAt: '2026-08-18T10:00:00.000Z' }]);
  assert.equal(matched.records[0].status, 'matched');
  assert.deepEqual(matched.records[0].sourceTypes, ['chatgpt-export', 'chatgpt-edge']);
  assert.equal(matched.counts.coverage, 100);

  const conflict = reconcileChatGPTRecords([record], [{ ...record, sourceType: 'chatgpt-edge', contentHash: 'different', messages: [{ role: 'user', content: '被网页端改写的内容' }] }]);
  assert.equal(conflict.records[0].status, 'conflict');
  assert.equal(conflict.counts.conflict, 1);

  const missing = reconcileChatGPTRecords([record], []);
  assert.equal(missing.records[0].status, 'export-only');
  assert.equal(missing.counts.coverage, 100);
});
