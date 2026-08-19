import assert from 'node:assert/strict';
import test from 'node:test';

import { pageSemanticTaskChains, sanitizeSemanticTitle } from './lib/session-semantic-index.mjs';

test('语义标题去除检查套话、文件链接和不利于扫描的失败术语', () => {
  assert.equal(
    sanitizeSemanticTitle('检查完成。当前代码不建议合并，确认有以下问题。主要问题 P1：岗位解析会篡改原始语义 [application_intelligence_agents.py](C:/work/app.py)', 'session-a'),
    '岗位解析会篡改原始语义',
  );
  assert.equal(sanitizeSemanticTitle('这是什么情况，请你在不重启的情况下去修复', 'session-b'), '在不重启条件下修复当前异常');
  assert.equal(
    sanitizeSemanticTitle('所有更新合并提交至GitHub并修复ci failure和ui的failure', 'session-c'),
    '合并更新并修复CI 失败和界面失败',
  );
});

test('完整任务链目录支持按语义筛选与分批读取', () => {
  const index = {
    taskChains: [
      { title: '修复数据导入校验', domain: '工程实现', lifecycle: '进行中', sessionIds: ['a'], recommendationReasons: [] },
      { title: '生成视频评论洞察报告', domain: '内容与洞察', lifecycle: '已完成', sessionIds: ['b'], recommendationReasons: [] },
      { title: '修复构建与测试失败', domain: '工程实现', lifecycle: '进行中', sessionIds: ['c'], recommendationReasons: [] },
    ],
  };
  const firstPage = pageSemanticTaskChains(index, { limit: 2 });
  assert.equal(firstPage.totalAvailable, 3);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.nextOffset, 2);
  const filtered = pageSemanticTaskChains(index, { query: '视频', limit: 20 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].title, '生成视频评论洞察报告');
});
