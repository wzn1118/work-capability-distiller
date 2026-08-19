import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  describeSessionFile,
  discoverSessionSources,
  preflightSessionSources,
  resolveSessionSources,
  splitSessionSourceInputs,
} from './lib/session-source-index.mjs';

const SESSION_A = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const SESSION_B = '11111111-2222-7333-8444-555555555555';

async function writeSession(filePath, sessionId, title, extraRows = []) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rows = [
    { timestamp: '2026-08-17T01:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: 'C:/workspace' } },
    { timestamp: '2026-08-17T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
    ...extraRows,
  ];
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test('拆分多条编号时支持换行、逗号和分号并自动去重', () => {
  assert.deepEqual(splitSessionSourceInputs(` ${SESSION_A}\n${SESSION_B},${SESSION_A}; `), [SESSION_A, SESSION_B]);
});

test('自动发现会话标题并把同一编号的重复副本合并为更完整来源', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const small = path.join(root, 'small', `rollout-${SESSION_A}.jsonl`);
  const complete = path.join(root, 'complete', `rollout-${SESSION_A}.jsonl`);
  await writeSession(small, SESSION_A, '把多条完整会话蒸馏成可安装能力包');
  await writeSession(complete, SESSION_A, '把多条完整会话蒸馏成可安装能力包', [
    { timestamp: '2026-08-17T01:00:02.000Z', type: 'event_msg', payload: { text: '补充执行证据' } },
  ]);

  const sources = await discoverSessionSources({ roots: [root] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sessionId, SESSION_A);
  assert.equal(sources[0].title, '把多条完整会话蒸馏成可安装能力包');
  assert.equal(sources[0].sourcePath, await fs.realpath(complete));
  assert.equal(sources[0].state.kind, 'duplicate');
  assert.deepEqual(sources[0].duplicatePaths, [await fs.realpath(small)]);
});

test('粘贴多个编号后一次解析可返回已定位项、坏编号和未找到项', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-id-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, `rollout-${SESSION_A}.jsonl`);
  await writeSession(file, SESSION_A, '编号自动定位对应的本机会话文件');

  const result = await resolveSessionSources({
    threadIds: [SESSION_A, '不是完整编号', SESSION_B],
    roots: [root],
  });
  assert.equal(result.selectedSources.length, 1);
  assert.equal(result.selectedSources[0].sessionId, SESSION_A);
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.results.find((item) => item.input === '不是完整编号').state.label, '格式错误');
  assert.equal(result.results.find((item) => item.input === SESSION_B).state.label, '未找到');
});

test('手选任意文件名也会读取内部编号、业务标题并通过预检', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '用户自己改过名字的会话.jsonl');
  await writeSession(file, SESSION_B, '自动读取文件内容而不是依赖文件名猜测');

  const described = await describeSessionFile(file);
  assert.equal(described.source.sessionId, SESSION_B);
  assert.equal(described.source.title, '自动读取文件内容而不是依赖文件名猜测');
  assert.equal(described.source.titleSource, '首条用户需求');

  const ready = await preflightSessionSources({ sourcePaths: [file] });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.sourcePaths, [await fs.realpath(file)]);
  assert.equal(ready.summary.errors, 0);

  const missing = await preflightSessionSources({ sourcePaths: [path.join(root, '不存在.jsonl')] });
  assert.equal(missing.ready, false);
  assert.equal(missing.summary.unreadable, 1);
});
