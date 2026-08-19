import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { discoverSessions } from './session-forensics.mjs';

export const SESSION_SEMANTIC_INDEX_VERSION = '1.3.0';

const STOP_WORDS = new Set([
  '需要', '希望', '可以', '这个', '那个', '我们', '你们', '用户', '功能', '方案', '内容', '当前', '全部', '进行', '完成', '继续', '实现', '一个', '以及', '相关', '必须', '现在', '对话', '会话', 'codex', 'chatgpt', 'please', 'with', 'that', 'this', 'from', 'into', 'the', 'and', 'for', 'are', 'was', 'will',
]);
const GENERIC_TITLES = /^(?:未命名(?:本机)?会话|会话(?:目标|分析|任务|专属能力)?|通用(?:请求|任务|能力|工作流)|继续(?:做|推进|升级|实施)?(?:本方案)?|优化(?:此)?方案|实施(?:本)?方案|开始(?:执行|处理)?|任务)$/iu;

function text(value, maximum = 320) {
  const result = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return result.length <= maximum ? result : `${result.slice(0, maximum)}…`;
}

function digest(value, length = 14) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function distinct(values, maximum = 80) {
  return [...new Set((values || []).map((value) => text(value, 120)).filter(Boolean))].slice(0, maximum);
}

export function sanitizeSemanticTitle(value, sessionId) {
  let title = text(value, 1200)
    .replace(/\[[^\]\n]{1,240}\]\([^\n)]{0,800}\)/gu, ' ')
    .replace(/\[[^\]\n]{1,240}\]/gu, ' ')
    .replace(/^\s*(?:用户(?:请求|需求)?|任务|goal)\s*[:：#-]*/iu, '')
    .replace(/^\s*#+\s*/u, '')
    .replace(/^(?:请|帮我|我想|我需要|我要|希望你)\s*/u, '')
    .replace(/\b(?:rollout|session|thread)\s*[-_:].*$/iu, '')
    .trim();
  const priorityIssue = title.match(/(?:主要|首要|关键)?问题\s*(?:P\s*\d+)?\s*[:：]\s*([^。；;\n]{4,180})/iu);
  if (priorityIssue?.[1]) title = priorityIssue[1].trim();
  title = title
    .replace(/^(?:检查(?:已经|已)?完成[。；;，,\s]*|当前(?:代码|实现)[^。；;]{0,90}(?:问题|如下)[：:]?\s*)/u, '')
    .replace(/^(?:请(?:你)?|帮(?:我)?)(?:在|将|把)?/u, '')
    .replace(/[。；;，,\s]*(?:详情|说明|如下|见附件|见上文)[：:]?\s*$/u, '')
    .trim();
  if (/^这是什么情况[，,\s]*请(?:你)?在不重启的情况下(?:去)?修复/iu.test(title)) title = '在不重启条件下修复当前异常';
  const keywordRun = title.match(/^(?:跑|运行)(?:一个)?\s*(.{2,80}?)\s*为关键词的\s*(.{2,60}?)(?:[，,。；;]|$)/u);
  if (keywordRun) title = `验证“${keywordRun[1].trim()}”的${keywordRun[2].replace(/[】\]）)]/gu, '').trim()}流程并修复体验问题`;
  title = title
    .replace(/\bci\s+failure\b/giu, 'CI 失败')
    .replace(/\bui(?:\s*的)?\s*failure\b/giu, '界面失败')
    .replace(/\bgithub\b/giu, 'GitHub')
    .replace(/^(?:所有)?更新(?:全部)?合并提交至\s*GitHub\s*(?:并|，)?/u, '合并更新并')
    .replace(/，\s*(?:纪录|记录)其中遇到的错误.*$/u, '')
    .trim();
  if (!title || GENERIC_TITLES.test(title)) return `待蒸馏任务 ${String(sessionId || '').slice(0, 8) || '记录'}`;
  if (/^\/goal\b/iu.test(title)) title = title.replace(/^\/goal\b\s*/iu, '');
  return text(title || `待蒸馏任务 ${String(sessionId || '').slice(0, 8) || '记录'}`, 96);
}

function titleDomain(title) {
  if (/评论|视频|玩家|受众|营销|洞察|调研|报告|内容|抖音|小红书|douyin|research|report|marketing/iu.test(title)) return '内容与洞察';
  if (/项目|代码|文件|命令|测试|补丁|git|构建|接口|服务|前端|后端|工程|修复|排查|故障|异常|package|api|bug|fix|test/iu.test(title)) return '工程实现';
  if (/技能|能力包|mcp|agent|会话|蒸馏|工作流|skill/iu.test(title)) return '能力蒸馏';
  if (/表格|数据|指标|数据库|csv|excel|统计/iu.test(title)) return '数据处理';
  return '待归类任务';
}

function tokenize(value) {
  const normalized = text(value, 1200).toLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/gu) || [];
  const tokens = [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    tokens.push(word);
    if (/^[\u4e00-\u9fff]{4,}$/u.test(word)) {
      for (let index = 0; index <= word.length - 2; index += 1) tokens.push(word.slice(index, index + 2));
    }
  }
  return distinct(tokens, 40);
}

function similarity(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

function lifecycleFor(title) {
  if (/完成|已生成|验收|验证|通过|交付|成功|发布|done|verified|complete/iu.test(title)) return '已完成';
  if (/继续|修复|升级|优化|重构|实施|改进|测试|排查|推进|fix|upgrade|refactor/iu.test(title)) return '进行中';
  return '待判断';
}

function recommendationFor(entry) {
  let score = 20;
  const reasons = [];
  if (entry.lifecycle === '已完成') { score += 36; reasons.push('标题表明存在交付或验证结果'); }
  if (entry.lifecycle === '进行中') { score += 24; reasons.push('标题表明包含迭代、修正或实施过程'); }
  if (entry.domain === '工程实现') { score += 13; reasons.push('适合关联项目文件、命令和验证证据'); }
  if (entry.domain === '能力蒸馏') { score += 10; reasons.push('适合直接转为可安装工作流'); }
  if (!/^待蒸馏任务/u.test(entry.semanticTitle)) { score += 9; reasons.push('已提取可读的任务标题'); }
  return { score: Math.min(score, 99), reasons: reasons.length ? reasons : ['已发现本机会话，可先读取完整记录补全证据。'] };
}

function semanticRecord(entry) {
  const semanticTitle = sanitizeSemanticTitle(entry.title, entry.sessionId);
  const domain = titleDomain(semanticTitle);
  const lifecycle = lifecycleFor(semanticTitle);
  const tokens = tokenize(`${semanticTitle} ${entry.title || ''}`);
  const result = {
    sessionId: String(entry.sessionId || '').toLowerCase(),
    sourcePath: entry.path,
    rawTitle: text(entry.title, 240),
    semanticTitle,
    titleSource: entry.titleSource || '会话归档',
    domain,
    lifecycle,
    tokens,
    modifiedAt: entry.modifiedAt,
    bytes: Number(entry.bytes || 0),
  };
  const recommendation = recommendationFor(result);
  return { ...result, recommendationScore: recommendation.score, recommendationReasons: recommendation.reasons };
}

function buildChains(records) {
  const chains = [];
  const sorted = [...records].sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
  for (const record of sorted) {
    const target = chains.find((chain) => chain.domain === record.domain && similarity(chain.tokens, record.tokens) >= 0.62);
    if (target) {
      target.records.push(record);
      target.tokens = distinct([...target.tokens, ...record.tokens], 50);
    } else {
      chains.push({ domain: record.domain, tokens: [...record.tokens], records: [record] });
    }
  }
  return chains.map((chain) => {
    const recordsByRecency = [...chain.records].sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    const best = [...chain.records].sort((left, right) => right.recommendationScore - left.recommendationScore || Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))[0];
    const recordIds = recordsByRecency.map((item) => item.sessionId);
    // 会话数量是任务链的独立元数据。把它拼进标题会让选择器和导出的说明重复展示数量，
    // 也会削弱用户扫描业务语义标题的速度。
    const title = best.semanticTitle;
    const score = Math.min(99, best.recommendationScore + Math.min(15, (recordsByRecency.length - 1) * 4));
    return {
      taskChainId: `chain-${digest(recordIds.sort().join('|'))}`,
      title,
      domain: chain.domain,
      lifecycle: recordsByRecency.some((item) => item.lifecycle === '已完成') ? '含已完成结果' : best.lifecycle,
      sessionCount: recordsByRecency.length,
      sessionIds: recordIds,
      latestAt: recordsByRecency[0].modifiedAt,
      recommendationScore: score,
      recommendationReasons: distinct([
        ...best.recommendationReasons,
        recordsByRecency.length > 1 ? `已归并 ${recordsByRecency.length} 条相似会话，可联合读取需求演进和纠正。` : '',
      ], 4),
    };
  }).sort((left, right) => right.recommendationScore - left.recommendationScore || Date.parse(right.latestAt) - Date.parse(left.latestAt));
}

function attachChains(records, chains) {
  const membership = new Map();
  for (const chain of chains) for (const sessionId of chain.sessionIds) membership.set(sessionId, chain);
  return records.map((record) => {
    const chain = membership.get(record.sessionId);
    return {
      ...record,
      taskChainId: chain?.taskChainId || null,
      taskChainTitle: chain?.title || record.semanticTitle,
      relatedSessionCount: chain?.sessionCount || 1,
    };
  });
}

function rootFingerprint(roots = []) {
  return [...new Set((roots || [])
    .map((root) => String(root || '').trim())
    .filter(Boolean)
    .map((root) => path.resolve(root).toLowerCase()))]
    .sort()
    .join('|');
}

async function readCache(cachePath, roots) {
  if (!cachePath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (parsed?.schemaVersion !== SESSION_SEMANTIC_INDEX_VERSION || !Array.isArray(parsed?.sessions)) return null;
    if (String(parsed.rootFingerprint || '') !== rootFingerprint(roots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cachePath, index) {
  if (!cachePath) return;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, cachePath);
}

export async function buildSemanticSessionIndex({ roots = [], limit = 5000, cachePath = null, force = false } = {}) {
  const normalizedRoots = (roots || []).map((root) => String(root || '').trim()).filter(Boolean);
  const cached = !force ? await readCache(cachePath, normalizedRoots) : null;
  if (cached) return { ...cached, cache: '命中' };
  const found = await discoverSessions({ roots: normalizedRoots, limit: Math.max(1, Math.min(Number(limit) || 5000, 20000)) });
  const records = found.map(semanticRecord);
  const chains = buildChains(records);
  const sessions = attachChains(records, chains).sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
  const index = {
    schemaVersion: SESSION_SEMANTIC_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    rootFingerprint: rootFingerprint(normalizedRoots),
    total: sessions.length,
    sessions,
    taskChains: chains,
  };
  await writeCache(cachePath, index);
  return { ...index, cache: '重建' };
}

export function pageSemanticSessions(index, { query = '', offset = 0, limit = 40 } = {}) {
  const needle = text(query, 160).toLowerCase();
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
  const matched = (index?.sessions || []).filter((item) => !needle || [item.semanticTitle, item.rawTitle, item.domain, item.lifecycle, item.sessionId, item.taskChainTitle].join(' ').toLowerCase().includes(needle));
  const items = matched.slice(safeOffset, safeOffset + safeLimit);
  return {
    items,
    total: matched.length,
    totalAvailable: Number(index?.total || 0),
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: safeOffset + items.length < matched.length ? safeOffset + items.length : null,
    taskChains: !needle && safeOffset === 0 ? (index?.taskChains || []).slice(0, 5) : [],
  };
}

export function pageSemanticTaskChains(index, { query = '', offset = 0, limit = 24 } = {}) {
  const needle = text(query, 160).toLowerCase();
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 24, 100));
  const matched = (index?.taskChains || []).filter((chain) => {
    if (!needle) return true;
    return [
      chain.title,
      chain.domain,
      chain.lifecycle,
      ...(chain.recommendationReasons || []),
      ...(chain.sessionIds || []),
    ].join(' ').toLowerCase().includes(needle);
  });
  const items = matched.slice(safeOffset, safeOffset + safeLimit);
  return {
    items,
    total: matched.length,
    totalAvailable: (index?.taskChains || []).length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: safeOffset + items.length < matched.length ? safeOffset + items.length : null,
  };
}

export function findSemanticSessions(index, sessionIds = []) {
  const wanted = new Set((sessionIds || []).map((value) => String(value || '').toLowerCase()).filter(Boolean));
  return (index?.sessions || []).filter((item) => wanted.has(item.sessionId));
}
