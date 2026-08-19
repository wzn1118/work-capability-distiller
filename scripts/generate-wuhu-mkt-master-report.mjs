import fs from 'node:fs';
import path from 'node:path';
import { buildExpandedSections } from './wuhu-master-expanded-sections.mjs';
import { buildRepeatCommenterSection } from './wuhu-repeat-commenter-section.mjs';

const ROOT = process.cwd();
const MULTI_DIR = path.join(ROOT, 'output', 'wuhu-mkt-multidimensional-audience-20260814');
const DEEP_DIR = path.join(ROOT, 'output', 'wuhu-mkt-deep-analysis-20260814');
const GROUNDED_DIR = path.join(ROOT, 'output', 'wuhu-grounded-player-context-20260813');
const OUT_DIR = path.join(ROOT, 'output', 'wuhu-mkt-master-strategy-20260814');
const REPORT_PATH = path.join(OUT_DIR, '三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告.html');
const METHOD_PATH = path.join(OUT_DIR, '主报告证据口径与复算说明.md');
const REPEAT_DATA_PATH = path.join(OUT_DIR, 'wuhu-repeat-commenter-background-analysis.json');
const IDENTIFIED_TIMING_PATH = path.join(OUT_DIR, 'wuhu-repeat-commenter-identified-temporal-analysis.json');

const data = JSON.parse(fs.readFileSync(path.join(MULTI_DIR, 'wuhu-mkt-multidimensional-analysis.json'), 'utf8'));
const deep = JSON.parse(fs.readFileSync(path.join(DEEP_DIR, 'wuhu-mkt-deep-analysis.json'), 'utf8'));
const grounded = JSON.parse(fs.readFileSync(path.join(GROUNDED_DIR, 'wuhu-grounded-player-context-analysis.json'), 'utf8'));
const repeatData = JSON.parse(fs.readFileSync(REPEAT_DATA_PATH, 'utf8'));
const identifiedTiming = JSON.parse(fs.readFileSync(IDENTIFIED_TIMING_PATH, 'utf8'));
const nf = new Intl.NumberFormat('zh-CN');
const n1 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value) => nf.format(Number(value ?? 0));
const dec = (value, digits = 1) => (digits === 2 ? n2 : n1).format(Number(value ?? 0));
const pct = (value, digits = 1) => `${dec(Number(value ?? 0) * 100, digits)}%`;
const pp = (value, digits = 1) => `${dec(Number(value ?? 0) * 100, digits)}pp`;
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const clip = (value, max = 42) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const safeQuote = (value, max = 180) => clip(String(value ?? '')
  .replace(/https?:\/\/\S+/gi, '[链接已移除]')
  .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已移除]')
  .replace(/@[^\s，。！？、；：,.!?;:]+/g, '@用户')
  .replace(/\d{7,}/g, '[长数字已移除]'), max);
const metricMap = new Map(data.metrics.map((row) => [row['指标ID'], row]));
const mv = (id) => Number(metricMap.get(id)?.['数值'] ?? 0);
const metricFormat = (row) => {
  const value = Number(row['数值'] ?? 0);
  const unit = row['单位'];
  if (unit === '比例') return pct(value, value < .01 ? 2 : 1);
  if (unit === '百分点') return pp(value, 1);
  if (unit === '系数' || unit === 'rho' || unit === 'V' || unit === '指数') return dec(value, 3);
  if (unit === '倍' || unit === 'OR') return `${dec(value, 2)}×`;
  if (Number.isInteger(value)) return `${fmt(value)}${unit ? ` ${unit}` : ''}`;
  return `${dec(value, 2)}${unit ? ` ${unit}` : ''}`;
};

const semanticLabels = {
  character_recognition: '角色识别',
  mascot_persona_reference: '卡宝人格点名',
  courtesy_nickname: '表字 / 稳定昵称',
  cute_infantilization: '萌化与幼态表达',
  tosign_ritual: 'to签仪式',
  game_system_jargon: '游戏系统 / 版本黑话',
  merchandise_intent: '周边意向',
  moral_personality_judgment: '道德 / 人格判断',
  role_address_play: '角色扮演式称呼',
  protective_care: '保护性关怀',
  relationship_shipping: '关系配对 / CP',
  narrative_interaction_question: '剧情互动追问',
  strict_purchase_intent: '严格购买表达',
  submission_ritual: '礼貌投稿',
  continuation_request: '追更请求',
  mechanic_remap_validation: '机制重映射验证',
  community_address: '社群称呼',
  interpretive_explanation: '解释性说明',
  game_economy_memory: '游戏经济记忆',
  historical_intertext: '历史互文',
  publisher_pun_grievance: '厂商梗 / 怨言',
  knowledge_threshold_question: '知识门槛问询',
  canon_audit: '设定 / 正史核验',
  voice_line_callback: '台词回调',
  price_sensitivity: '价格敏感',
  tragic_repair: '悲剧修复',
  official_identity_confusion: '官方身份混淆',
  ai_quality_rights: 'AI质量 / 权益',
  outsider_self_identification: '圈外人自我声明',
  accessibility_request: '可及性请求',
  mascot_identity_question: '卡宝身份问询',
  canon_irony: '正史 / 设定反讽',
  counter_shipping: '反配对',
  content_boundary_rejection: '内容边界排斥',
};

function metricCard(label, value, note = '', tone = 'blue') {
  return `<article class="metric ${tone}"><div class="metric-value">${value}</div><h3>${esc(label)}</h3>${note ? `<p>${note}</p>` : ''}</article>`;
}

function finding(title, body, tag, tone = 'blue') {
  return `<article class="finding ${tone}"><span>${esc(tag)}</span><h3>${title}</h3><p>${body}</p></article>`;
}

function barList(rows, { label, value, display, note, tone = 'blue', max } = {}) {
  const peak = max ?? Math.max(1, ...rows.map((row) => Number(value(row) || 0)));
  return `<div class="bar-list">${rows.map((row) => {
    const v = Number(value(row) || 0);
    const width = Math.max(v > 0 ? 1.4 : 0, Math.min(100, v / peak * 100));
    return `<div class="bar-row"><div class="bar-head"><span>${esc(label(row))}</span><strong>${display(row)}</strong></div><div class="bar-track"><i class="${tone}" style="width:${width.toFixed(2)}%"></i></div>${note ? `<p>${note(row)}</p>` : ''}</div>`;
  }).join('')}</div>`;
}

function table(rows, columns, className = '') {
  return `<div class="table-wrap ${className}"><table><thead><tr>${columns.map((column) => `<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td class="${esc(column.className || '')}">${column.render ? column.render(row) : esc(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function effectCard(title, effect, interpretation, tone = 'green') {
  return `<article class="effect-card ${tone}"><div class="effect-title"><h3>${title}</h3><span>观察关联</span></div><div class="effect-grid"><div><small>命中组</small><strong>${pct(effect.exposed_rate)}</strong><em>${fmt(effect.a_exposed_outcome)}/${fmt(effect.a_exposed_outcome + effect.b_exposed_no_outcome)}</em></div><div><small>未命中组</small><strong>${pct(effect.unexposed_rate)}</strong><em>${fmt(effect.c_unexposed_outcome)}/${fmt(effect.c_unexposed_outcome + effect.d_unexposed_no_outcome)}</em></div><div><small>风险差</small><strong>${pp(effect.risk_difference)}</strong><em>绝对差</em></div><div><small>风险比 / OR</small><strong>${dec(effect.risk_ratio, 2)}× / ${dec(effect.odds_ratio, 2)}×</strong><em>相对效应</em></div></div><p>${interpretation}</p><footer>Wilson 95%区间：命中组 ${pct(effect.exposed_wilson_95[0], 1)}–${pct(effect.exposed_wilson_95[1], 1)}；未命中组 ${pct(effect.unexposed_wilson_95[0], 1)}–${pct(effect.unexposed_wilson_95[1], 1)}</footer></article>`;
}

function quoteBlock(text, likes, label = '匿名评论证据') {
  return `<blockquote class="quote"><p>“${esc(safeQuote(text))}”</p><footer>${esc(label)} · ${fmt(likes)}赞（采集快照）</footer></blockquote>`;
}

function partHead(index, title, subtitle) {
  const id = String(index).padStart(2, '0');
  return `<div class="part-head" id="part-${id}"><span class="no">${id}</span><h2>${title}</h2><p>${subtitle}</p></div>`;
}

const modules = [...new Set(data.metrics.map((row) => row['模块']))];
const lifecycle = data.lifecycleSegments;
const contextOrder = new Map(['L0 未编码互动', 'L1 其他已编码表达', 'L2 角色/萌化身份', 'L3 严格玩家解码', 'L4 有机共创'].map((x, i) => [x, i]));
const contexts = [...data.contextLevels].sort((a, b) => contextOrder.get(a['语境层']) - contextOrder.get(b['语境层']));
const tribes = [...data.strictCuteSegments].sort((a, b) => b['跨视频率'] - a['跨视频率']);
const semantics = [...data.semanticCodes].sort((a, b) => b['评论数'] - a['评论数']);
const topVideos = [...data.videoStatistics].sort((a, b) => b['观众评论数'] - a['观众评论数']).slice(0, 12);
const effects = data.effects;
const methods = data.scope.statisticalMethods;
const moduleCounts = modules.map((module) => ({ module, count: data.metrics.filter((row) => row['模块'] === module).length }));
const allMetricRows = data.metrics.map((row) => `<tr data-module="${esc(row['模块'])}" data-search="${esc(`${row['指标ID']} ${row['模块']} ${row['指标']} ${row['统计方法']} ${row['经营解释']} ${row['边界']}`.toLowerCase())}"><td><code>${esc(row['指标ID'])}</code></td><td>${esc(row['模块'])}</td><td><strong>${esc(row['指标'])}</strong></td><td class="num">${esc(metricFormat(row))}</td><td>${esc(row['统计方法'])}</td><td>${esc(row['分母/样本'])}</td><td>${esc(row['经营解释'])}</td><td>${esc(row['边界'] || '—')}</td></tr>`).join('');

const semanticTopBars = barList(semantics.slice(0, 12), {
  label: (row) => semanticLabels[row['编码']] || row['编码'],
  value: (row) => row['评论数'],
  display: (row) => `${fmt(row['评论数'])}评 · ${pct(row['评论占比'])}`,
  note: () => '',
  tone: 'violet',
});

const lifecycleBars = barList(lifecycle, {
  label: (row) => row['分层'],
  value: (row) => row['占比'],
  display: (row) => `${fmt(row['用户数'])}人 · ${pct(row['占比'])}`,
  note: () => '',
  tone: 'green',
  max: Math.max(...lifecycle.map((row) => row['占比'])),
});

const contextBars = barList(contexts, {
  label: (row) => row['语境层'],
  value: (row) => row['用户占比'],
  display: (row) => `${fmt(row['用户数'])}人 · ${pct(row['用户占比'])}`,
  note: (row) => `人均 ${dec(row['评论人均'], 2)}评；跨视频 ${pct(row['跨视频率'])}；30日机会校正 ${pct(row['30日后仍评论率'])}（n=${fmt(row['30日观察分母'])}）`,
  tone: 'blue',
});

const chapters = [
  '管理结论', '证据母体', '受众集中度', '生命周期', '玩家语境', '受众部落', '社群机制',
  '商业信号', '视频组合', '统计证据', 'MKT系统', '90天实验', '状态迁移', '部落桥梁',
  '角色资产', '角色机会', '关系资产', '内容原型', '内容案例', '线程与回复', '仪式机制',
  '商业路径', '商品策略', '经营节奏', '看板治理', '证据限制', '具名时序', '指标附录',
];
const roleAssets = [...deep.roles.sensitivity];
const roleOpportunities = roleAssets
  .filter((row) => row.quadrant === '低标题供给 × 高非标题点名代理')
  .sort((a, b) => b.relativeOpportunityIndex - a.relativeOpportunityIndex);
const roleCore = roleAssets
  .filter((row) => row.quadrant === '高标题供给 × 高非标题点名代理')
  .sort((a, b) => b.nonTitleMentionIndex - a.nonTitleMentionIndex);
const roleSupplyDependent = roleAssets
  .filter((row) => row.quadrant === '高标题供给 × 低非标题点名代理')
  .sort((a, b) => a.relativeOpportunityIndex - b.relativeOpportunityIndex);
const pairAssets = [...deep.roles.pairs];
const contentQuadrants = deep.content.quadrants;
const archetypeCohorts = deep.content.archetypeEntryCohorts;
const deepVideos = deep.content.videos;
const acquisitionLeaders = [...deepVideos].sort((a, b) => b.firstTouchUsers - a.firstTouchUsers).slice(0, 10);
const retentionLeaders = [...deepVideos].filter((row) => row.returningUsers >= 20).sort((a, b) => b.returningShare - a.returningShare).slice(0, 10);
const denseVideos = grounded.contextDenseVideos.slice(0, 10);
const meaningSystem = deep.grounded.meaningSystem;
const threadCases = grounded.threadCases;
const commerce = deep.commerce;
const replyAssociation = deep.community.authorReplyAssociation[0];
const repeatedFormulas = grounded.repeatedFormulas.slice(0, 10);
const roleOpportunityNames = roleOpportunities.slice(0, 4).map((row) => row.label).join('、');
const firstPurchaseQuote = threadCases.find((row) => row.label === '情感对象向实物迁移')?.root;
const boundaryQuote = threadCases.find((row) => row.label === '内容方向存在真实分歧')?.root;
const navHtml = chapters.map((label, index) => `<a href="#part-${String(index + 1).padStart(2, '0')}">${String(index + 1).padStart(2, '0')} ${label}</a>`).join('');
const expandedSections = buildExpandedSections({
  deep, grounded, coverage: data.coverage, roleAssets, roleOpportunities, roleCore, roleSupplyDependent,
  pairAssets, contentQuadrants, archetypeCohorts, acquisitionLeaders,
  retentionLeaders, denseVideos, meaningSystem, threadCases, commerce,
  replyAssociation, repeatedFormulas, firstPurchaseQuote, boundaryQuote,
  fmt, dec, pct, esc, partHead, metricCard, finding, quoteBlock, table,
});
const repeatCommenterSection = buildRepeatCommenterSection({
  repeatData, identifiedTiming, fmt, dec, pct, esc, partHead, metricCard, finding, table,
});

let report = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告</title>
<style>
:root{--paper:#f4f3ee;--surface:#fff;--ink:#28302e;--muted:#65706c;--line:#d8ddd8;--deep:#425653;--blue:#527f8e;--blue-soft:#e7f0f2;--green:#69866f;--green-soft:#e9f0ea;--amber:#a6753e;--amber-soft:#f5ede2;--red:#a45952;--red-soft:#f5e7e5;--violet:#756a86;--violet-soft:#eeebf2;--radius:7px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif;line-height:1.72;letter-spacing:0}a{color:#3f7180;text-underline-offset:3px}strong{color:#273330}.page{max-width:1180px;margin:0 auto;padding:24px 22px 80px}.cover{min-height:min(720px,calc(100vh - 48px));background:var(--deep);color:#f6f7f3;border-radius:var(--radius);padding:58px 62px 42px;display:flex;flex-direction:column;justify-content:space-between}.eyebrow{font-size:12px;font-weight:800;color:#bed0cd;text-transform:uppercase}.cover h1{font-size:46px;line-height:1.18;max-width:900px;margin:18px 0 18px;letter-spacing:0}.cover .deck{font-size:19px;max-width:850px;color:#dce7e4;margin:0}.cover-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:42px 0 26px}.cover-grid div{border-top:1px solid rgba(255,255,255,.28);padding-top:13px}.cover-grid strong{display:block;color:#fff;font-size:26px}.cover-grid span{font-size:12px;color:#d2dedb}.cover-meta{display:flex;gap:8px;flex-wrap:wrap}.cover-meta span{border:1px solid rgba(255,255,255,.24);padding:5px 9px;font-size:11px}.cover-hint{margin-top:24px;color:#c6d5d1;font-size:12px}.nav{position:sticky;top:0;z-index:30;display:flex;gap:3px;overflow-x:auto;padding:10px 0;margin:14px 0 0;background:rgba(244,243,238,.97);border-bottom:1px solid var(--line);scrollbar-width:thin}.nav a{flex:0 0 auto;text-decoration:none;color:var(--muted);font-size:11px;padding:6px 8px;border-radius:4px}.nav a:hover,.nav a:focus-visible{background:var(--blue-soft);color:var(--ink)}.part-head{display:grid;grid-template-columns:45px minmax(0,auto) 1fr;align-items:end;gap:14px;margin:46px 0 16px;padding-bottom:11px;border-bottom:1px solid var(--line)}.part-head .no{color:var(--blue);font-size:13px;font-weight:800}.part-head h2{font-size:28px;line-height:1.25;margin:0}.part-head p{font-size:13px;color:var(--muted);margin:0 0 2px}.band{background:var(--surface);border-top:1px solid #e2e4df;border-bottom:1px solid #e2e4df;padding:34px 38px;margin-bottom:18px}.band h3{font-size:20px;line-height:1.38;margin:0 0 8px}.band h4{font-size:16px;margin:26px 0 10px}.lead{font-size:18px;max-width:980px;margin:0 0 24px;line-height:1.78}.note{font-size:12px;color:var(--muted);margin:12px 0 0}.muted{color:var(--muted)}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.metric{background:#f7f7f4;border-top:3px solid #bec6c2;border-radius:var(--radius);padding:17px 16px;min-height:126px}.metric.blue{border-color:var(--blue)}.metric.green{border-color:var(--green)}.metric.amber{border-color:var(--amber)}.metric.red{border-color:var(--red)}.metric.violet{border-color:var(--violet)}.metric-value{font-size:27px;font-weight:760;color:#315f6b;line-height:1.15}.metric h3{font-size:12px;margin:9px 0 3px}.metric p{font-size:11px;color:var(--muted);margin:0}.finding-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.finding{border-left:4px solid var(--blue);background:var(--blue-soft);border-radius:0 var(--radius) var(--radius) 0;padding:19px 20px;min-height:175px}.finding.green{border-color:var(--green);background:var(--green-soft)}.finding.amber{border-color:var(--amber);background:var(--amber-soft)}.finding.red{border-color:var(--red);background:var(--red-soft)}.finding.violet{border-color:var(--violet);background:var(--violet-soft)}.finding>span{font-size:10px;text-transform:uppercase;font-weight:800;color:var(--muted)}.finding h3{font-size:17px;margin:6px 0}.finding p{font-size:14px;margin:0}.two-col{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.three-col{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.two-col>*,.three-col>*{min-width:0}.bar-list{display:grid;gap:14px}.bar-head{display:flex;justify-content:space-between;gap:12px;font-size:12px}.bar-head strong{white-space:nowrap}.bar-track{height:9px;background:#eaede9;overflow:hidden;margin-top:5px}.bar-track i{display:block;height:100%;background:var(--blue)}.bar-track i.green{background:var(--green)}.bar-track i.violet{background:var(--violet)}.bar-track i.amber{background:var(--amber)}.bar-row p{font-size:11px;color:var(--muted);margin:4px 0 0}.table-wrap{max-width:100%;overflow-x:auto;border:1px solid #e0e3de;background:#fff}.table-wrap table{border-collapse:collapse;width:100%;min-width:760px;font-size:12px}.table-wrap th{position:sticky;top:0;background:#eef1ed;color:#4d5854;text-align:left;padding:10px 11px;border-bottom:1px solid var(--line);white-space:nowrap}.table-wrap td{padding:10px 11px;border-bottom:1px solid #eceeea;vertical-align:top}.table-wrap tr:last-child td{border-bottom:0}.table-wrap tr:hover td{background:#fafbf8}.table-wrap .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.table-wrap code{font-size:11px;color:#4d6770}.effect-list{display:grid;gap:12px}.effect-card{border:1px solid #d9dfda;border-top:4px solid var(--green);border-radius:var(--radius);padding:20px}.effect-card.blue{border-top-color:var(--blue)}.effect-card.amber{border-top-color:var(--amber)}.effect-card.violet{border-top-color:var(--violet)}.effect-title{display:flex;justify-content:space-between;gap:12px;align-items:center}.effect-title h3{font-size:17px;margin:0}.effect-title span{font-size:10px;font-weight:800;padding:3px 7px;background:#edf1ed;color:var(--muted)}.effect-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:15px 0}.effect-grid div{background:#f7f8f5;padding:10px}.effect-grid small,.effect-grid em{display:block;font-size:10px;color:var(--muted);font-style:normal}.effect-grid strong{display:block;font-size:18px;margin:2px 0}.effect-card>p{font-size:13px;margin:0}.effect-card footer{font-size:10px;color:var(--muted);margin-top:10px}.signal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.signal{border:1px solid var(--line);border-radius:var(--radius);padding:18px}.signal h3{font-size:16px;margin:0 0 7px}.signal strong{font-size:25px;color:#315f6b}.signal p{font-size:12px;color:var(--muted);margin:7px 0 0}.method-cloud{display:flex;gap:7px;flex-wrap:wrap;margin:16px 0}.method-cloud span{font-size:10px;border:1px solid #cfd5d0;background:#f8f9f6;padding:5px 7px;border-radius:4px}.matrix{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.matrix article{border-top:3px solid var(--blue);background:#f7f8f5;border-radius:var(--radius);padding:16px}.matrix article:nth-child(2){border-color:var(--green)}.matrix article:nth-child(3){border-color:var(--amber)}.matrix article:nth-child(4){border-color:var(--violet)}.matrix h3{font-size:15px;margin:0 0 8px}.matrix ul,.experiment ul{padding-left:18px;margin:0;font-size:12px}.matrix li,.experiment li{margin:5px 0}.experiment-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.experiment{border:1px solid var(--line);border-radius:var(--radius);padding:20px}.experiment .id{font-size:10px;font-weight:800;color:var(--blue)}.experiment h3{font-size:17px;margin:6px 0}.experiment p{font-size:12px;color:var(--muted)}.experiment dl{display:grid;grid-template-columns:70px 1fr;gap:6px 10px;font-size:12px;margin:14px 0 0}.experiment dt{font-weight:800}.experiment dd{margin:0}.tools{display:grid;grid-template-columns:minmax(190px,1fr) minmax(190px,280px) auto;gap:8px;margin:14px 0}.tools input,.tools select{width:100%;border:1px solid #bbc5bf;background:#fff;padding:9px 10px;border-radius:4px;font:inherit;font-size:12px;color:var(--ink)}.tools output{font-size:11px;color:var(--muted);align-self:center;white-space:nowrap}.metric-dictionary{max-height:760px;overflow:auto}.metric-dictionary table{min-width:1180px}.metric-dictionary th{top:0;z-index:1}.definition-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.definition-grid article{background:#f7f8f5;border-left:3px solid var(--blue);padding:14px}.definition-grid strong{display:block;font-size:12px}.definition-grid span{font-size:11px;color:var(--muted)}.footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);margin-top:42px;padding-top:18px;font-size:11px;color:var(--muted)}
.thesis{border-left:5px solid var(--green);background:#f0f4ef;padding:24px 26px;margin:18px 0}.thesis h3{font-size:21px;margin:0 0 8px}.thesis p{font-size:15px;margin:0;line-height:1.85}.evidence-chain{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:18px 0}.evidence-chain article{border-top:3px solid var(--blue);background:#f7f8f5;padding:14px;min-height:150px}.evidence-chain strong{display:block;font-size:12px}.evidence-chain p{font-size:11px;color:var(--muted);margin:6px 0 0}.quote-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.quote{margin:0;border-left:4px solid var(--amber);background:var(--amber-soft);padding:18px}.quote p{margin:0;font-size:15px}.quote footer{margin-top:10px;font-size:10px;color:var(--muted)}.verdict{border-top:4px solid var(--deep);background:#edf1ed;padding:22px;margin:18px 0}.verdict h3{font-size:19px;margin:0 0 8px}.verdict p{font-size:14px;margin:0;line-height:1.85}.priority-list{counter-reset:priority;display:grid;gap:10px}.priority-list article{counter-increment:priority;display:grid;grid-template-columns:42px 1fr;gap:12px;border-bottom:1px solid var(--line);padding:12px 0}.priority-list article>span{display:none}.priority-list article:before{content:counter(priority,decimal-leading-zero);color:var(--blue);font-weight:800;font-size:13px}.priority-list h3{font-size:16px;margin:0 0 4px}.priority-list p{font-size:13px;margin:0;color:var(--muted)}.timeline{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.timeline article{border-left:4px solid var(--blue);background:#f7f8f5;padding:18px}.timeline h3{font-size:16px;margin:0 0 7px}.timeline p{font-size:12px;margin:0;color:var(--muted)}.callout{background:var(--deep);color:#f5f7f4;padding:24px;margin:18px 0}.callout strong{color:#fff}.callout p{margin:0}.longform{max-width:980px}.longform p{font-size:15px;line-height:1.9}.kicker{font-size:11px;font-weight:800;color:var(--blue);text-transform:uppercase;margin-bottom:6px}.section-rule{height:1px;background:var(--line);margin:26px 0}
@media(max-width:900px){.page{padding:14px 14px 60px}.cover{padding:42px 34px;min-height:620px}.cover h1{font-size:38px}.cover-grid,.metric-grid,.matrix{grid-template-columns:repeat(2,1fr)}.part-head{grid-template-columns:38px 1fr}.part-head p{grid-column:2}.two-col,.three-col{grid-template-columns:minmax(0,1fr)}.band{padding:28px 26px}.signal-grid{grid-template-columns:1fr 1fr}.definition-grid{grid-template-columns:1fr 1fr}.evidence-chain{grid-template-columns:repeat(2,1fr)}.timeline{grid-template-columns:1fr}.quote-grid{grid-template-columns:1fr}}
@media(max-width:580px){.page{padding:8px 8px 48px}.cover{padding:34px 24px;min-height:calc(100vh - 16px)}.cover h1{font-size:30px}.cover .deck{font-size:16px}.cover-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.cover-grid strong{font-size:21px}.part-head{margin-top:34px}.part-head h2{font-size:23px}.band{padding:22px 16px}.metric-grid,.finding-grid,.effect-grid,.signal-grid,.matrix,.experiment-grid,.definition-grid,.evidence-chain{grid-template-columns:1fr}.metric{min-height:0}.effect-title{align-items:flex-start}.tools{grid-template-columns:1fr}.tools output{white-space:normal}.footer{display:block}.footer span{display:block;margin-bottom:5px}.bar-head{align-items:flex-start}.bar-head strong{white-space:normal;text-align:right}.lead{font-size:16px}.priority-list article{grid-template-columns:34px 1fr}.quote{padding:15px}}
@media print{body{background:#fff}.page{max-width:none;padding:0}.nav,.tools{display:none}.cover{min-height:0;break-after:page}.band{break-inside:auto}.metric,.finding,.effect-card,.experiment{break-inside:avoid}.metric-dictionary{max-height:none;overflow:visible}.table-wrap{overflow:visible}.metric-dictionary table{min-width:0;font-size:8px}}
</style>
</head>
<body>
<main class="page">
  <header class="cover">
    <div>
      <div class="eyebrow">Audience asset · Content growth · Quantitative grounded strategy · 2026-08-14</div>
      <h1>三国杀WUHU联盟卡宝<br>受众资产与内容增长战略全量报告</h1>
      <p class="deck">不再停留在“评论多不多”。本报告把全量行为统计、三国杀玩家语境扎根编码与MKT经营框架合并为28章证据链；新增一章内部具名时序，保留多次评论者的昵称、主页、原始评论与精确时间，用于核查谁在持续参与、何时回流、哪些轨迹值得经营。</p>
      <div class="cover-grid">
        <div><strong>${fmt(chapters.length)}</strong><span>完整战略章节</span></div>
        <div><strong>${fmt(data.coverage.videos)}</strong><span>全量视频样本</span></div>
        <div><strong>${fmt(data.coverage.audienceUsers)}</strong><span>观测评论者 U1</span></div>
        <div><strong>${fmt(data.scope.metricDimensions)} / ${fmt(data.scope.statisticalMethodCount)}</strong><span>指标 / 统计程序</span></div>
      </div>
    </div>
    <div>
      <div class="cover-meta"><span>${fmt(data.coverage.videos)}条视频</span><span>${fmt(data.coverage.capturedComments)}条实采评论</span><span>${fmt(data.coverage.audienceComments)}条观众评论</span><span>采集覆盖 ${pct(data.coverage.capturedComments / data.coverage.declaredComments, 2)}</span><span>${esc(data.coverage.observationStart.slice(0,10))}—${esc(data.coverage.observationEnd.slice(0,10))}</span><span>内部具名时序版</span></div>
      <div class="cover-hint">报告以“事实 → 解释 → 反证 → 动作 → 验证指标”为统一写法；不把观测评论者外推为全部观看者或粉丝，不把跨视频评论写成平台留存，不把购买语言写成订单转化。</div>
    </div>
  </header>

  <nav class="nav" aria-label="报告章节">
    ${navHtml}
  </nav>

  <div class="part-head" id="part-01"><span class="no">01</span><h2>管理层结论</h2><p>不是更多图表，而是更强的受众经营判断</p></div>
  <section class="band">
    <p class="lead"><strong>核心判断：</strong>卡宝的受众价值不来自单一“萌”或单一“玩家知识”，而来自两类互补的样本信号：严格玩家解码与更高的跨视频评论代理相关，萌化语言与更高的购买表达共现。二者交叉人群在样本中呈现最高的跨视频评论代理；但严格玩家解码命中组并不是购买表达最高的人群，商品测试应优先面对“能认角色、愿意萌化、希望拥有”的观测评论者。这些均是观察性关联，不是因果效果。</p>
    <div class="finding-grid">
      ${finding('评论量不能直接代表受众规模', `观测评论者评论数中位数仅 <strong>${fmt(mv('U02'))}</strong>，但 Top 10% 用户贡献 <strong>${pct(mv('U12'))}</strong> 评论，用户评论贡献 Gini 为 <strong>${dec(mv('U13'),3)}</strong>。任何主题都必须同时报评论数与独立评论者数。`, '结构性事实', 'red')}
      ${finding('语境越深，重复参与关联越强', `语境层与评论数、视频广度的 Spearman ρ 分别为 <strong>${dec(mv('S29'),3)}</strong> 与 <strong>${dec(mv('S30'),3)}</strong>；严格玩家解码者跨视频率 ${pct(effects.strict_vs_cross_video.exposed_rate)}，非严格组 ${pct(effects.strict_vs_cross_video.unexposed_rate)}，RR=${dec(effects.strict_vs_cross_video.risk_ratio,2)}。`, '用户级关联', 'green')}
      ${finding('萌化更接近商品语言入口', `萌化用户严格购买表达率 <strong>${pct(effects.cute_vs_purchase.exposed_rate)}</strong>，非萌化组 <strong>${pct(effects.cute_vs_purchase.unexposed_rate)}</strong>，风险差 ${pp(effects.cute_vs_purchase.risk_difference)}。仅萌化部落的购买表达率 ${pct(data.strictCuteSegments.find(x=>x['部落']==='仅萌化')['购买表达率'])}，高于仅玩家部落 ${pct(data.strictCuteSegments.find(x=>x['部落']==='仅玩家')['购买表达率'])}。`, '商业假设', 'amber')}
      ${finding('混合核是社群种子，不是市场规模', `“玩家×萌化”共 <strong>${fmt(data.strictCuteSegments.find(x=>x['部落']==='玩家×萌化')['用户数'])}人</strong>，占 U2 的 ${pct(data.strictCuteSegments.find(x=>x['部落']==='玩家×萌化')['用户占比'])}；跨视频率 ${pct(data.strictCuteSegments.find(x=>x['部落']==='玩家×萌化')['跨视频率'])}，30日机会校正率 ${pct(data.strictCuteSegments.find(x=>x['部落']==='玩家×萌化')['30日后仍评论率'])}。它是运营优先队列，不是全市场TAM。`, '高价值小群体', 'violet')}
      ${finding('仪式参与必须从自然关系资产中拆开', `投稿/to签类仪式命中 <strong>${pct(mv('S08'))}</strong> 有文本观测评论者。仪式可以放大已有参与，但批量召集武将、复制固定文案会虚增角色与关系声量，因此不纳入“有机共创”层。`, '口径校正', 'blue')}
      ${finding('商品信号存在，但仍不是成交', `严格购买表达来自 <strong>${fmt(data.commerce.purchaseUserCount)}人 / ${fmt(data.commerce.purchaseCommentCount)}评</strong>；去除点赞最高3条后仍保留 ${fmt(data.commerce.top3RemovedUserCount)} 人，即 ${pct(data.commerce.top3RemovedUserCount/data.commerce.purchaseUserCount)}。这说明信号不只靠三条热评，但没有点击、预约、订金或支付分母。`, '需求表达下限', 'amber')}
    </div>
  </section>

  <div class="part-head" id="part-02"><span class="no">02</span><h2>证据母体与统计架构</h2><p>先固定分母，再讨论任何人群与比例</p></div>
  <section class="band">
    <div class="metric-grid">
      ${metricCard('C0 声明评论', fmt(data.coverage.declaredComments), '仅作为采集覆盖分母', 'blue')}
      ${metricCard('C1 实际采集评论', fmt(data.coverage.capturedComments), `覆盖 ${pct(data.coverage.capturedComments/data.coverage.declaredComments,2)}`, 'green')}
      ${metricCard('C2 非作者评论', fmt(data.coverage.audienceComments), '观众行为与互动主母体', 'amber')}
      ${metricCard('C3 有文本观众评论', fmt(data.coverage.audienceTextComments), `文本可用率 ${pct(mv('D09'))}`, 'violet')}
      ${metricCard('U1 观测评论者', fmt(data.coverage.audienceUsers), '用户行为主母体', 'blue')}
      ${metricCard('U2 有文本评论者', fmt(data.coverage.audienceTextUsers), '语义与商业主母体', 'green')}
      ${metricCard('V 视频样本', fmt(data.coverage.videos), `${fmt(data.coverage.commentBearingVideos)}条有观众评论`, 'amber')}
      ${metricCard('固定指标 / 方法', `${fmt(data.scope.metricDimensions)} / ${fmt(data.scope.statisticalMethodCount)}`, '指标维度不等于方法种类', 'violet')}
    </div>
    <h3>98个指标如何覆盖受众</h3>
    ${barList(moduleCounts,{label:r=>r.module,value:r=>r.count,display:r=>`${r.count}项`,tone:'blue'})}
    <h4>34类实际统计程序</h4>
    <div class="method-cloud">${methods.map((method)=>`<span>${esc(method)}</span>`).join('')}</div>
    <div class="definition-grid">
      <article><strong>规模与分布</strong><span>COUNT、DISTINCT、均值、中位数、分位数、Top-share、Gini、HHI与有效数量。</span></article>
      <article><strong>不确定性</strong><span>Wilson 95%区间与固定种子的1200次非参数Bootstrap。</span></article>
      <article><strong>组间效应</strong><span>风险差、风险比、赔率比同时报告，避免只看相对倍数。</span></article>
      <article><strong>关联结构</strong><span>Spearman秩相关、Cramer's V与四格交叉分类，不解释为因果。</span></article>
      <article><strong>多标签语义</strong><span>评论率、用户率、集合交集与条件率；多标签比例不可相加。</span></article>
      <article><strong>稳健性</strong><span>剔除头部热评后复算，检验信号是否由极少样本驱动。</span></article>
    </div>
    <p class="note">主分析仍使用稳定用户键做聚合，匿名用户表继续保留为可外发版本；根据本次内部复盘要求，第27章及其具名附件额外保留昵称、主页、原始评论与精确评论时间，用于逐人核查。具名材料仅限本项目内部使用，不得公开转载或二次分发。</p>
  </section>

  <div class="part-head" id="part-03"><span class="no">03</span><h2>受众集中度</h2><p>均值背后是高度不均匀的评论与点赞分配</p></div>
  <section class="band">
    <p class="lead">观测评论者的典型行为是“一次性发言”，但内容生态中的可见讨论由少数高频用户与少数高赞评论放大。经营看板若只看评论总数和平均点赞，会把“核心参与者贡献”误写成“大多数受众行为”。</p>
    <div class="metric-grid">
      ${metricCard('人均 / 中位评论', `${dec(mv('U01'),2)} / ${fmt(mv('U02'))}`, `Bootstrap均值95%区间 ${dec(mv('R01'),2)}–${dec(mv('R02'),2)}`, 'blue')}
      ${metricCard('至少4次互动', pct(mv('U10')), `${fmt(Math.round(mv('U10')*data.coverage.audienceUsers))}人`, 'green')}
      ${metricCard('Top 10%评论贡献', pct(mv('U12')), `Top 1%贡献 ${pct(mv('U11'))}`, 'amber')}
      ${metricCard('用户评论Gini', dec(mv('U13'),3), '0为完全均匀，1为高度集中', 'red')}
      ${metricCard('单评平均 / 中位赞', `${dec(mv('L02'),2)} / ${fmt(mv('L03'))}`, '均值被高赞尾部显著拉高', 'blue')}
      ${metricCard('零赞评论', pct(mv('L07')), `${fmt(Math.round(mv('L07')*data.coverage.audienceComments))}条`, 'green')}
      ${metricCard('Top 1%点赞贡献', pct(mv('L08')), `Top 5%贡献 ${pct(mv('L09'))}`, 'amber')}
      ${metricCard('评论点赞Gini', dec(mv('L10'),3), '热评集中度远高于用户评论集中度', 'red')}
    </div>
    <div class="two-col">
      ${finding('经营含义：把“人数”和“次数”拆开', '每个主题至少同时看：独立评论者数、评论数、人均评论、涉及视频数、跨视频评论代理率。高评论量可能只是少数核心用户重复参与。', '看板原则', 'blue')}
      ${finding('经营含义：热评不是总体民意', `单评点赞中位数为0，Top 1%评论却吸收 ${pct(mv('L08'))} 点赞。高赞原话可作创意证据，但不能单独决定受众规模、品类优先级或价格。`, '证据等级', 'red')}
    </div>
  </section>

  <div class="part-head" id="part-04"><span class="no">04</span><h2>生命周期与可见回评</h2><p>用互斥分层与机会校正替代“留存率”想象</p></div>
  <section class="band">
    <div class="two-col">
      <div><h3>5,410位评论者的互斥行为层</h3>${lifecycleBars}</div>
      <div>
        <h3>重复互动发生得有多快</h3>
        <div class="metric-grid" style="grid-template-columns:repeat(2,1fr)">
          ${metricCard('第二次互动中位时延', `${dec(mv('T04'),1)}小时`, '仅2,059位重复互动者', 'blue')}
          ${metricCard('1小时内', pct(mv('T07')), '占重复互动者', 'green')}
          ${metricCard('24小时内', pct(mv('T08')), '占重复互动者', 'amber')}
          ${metricCard('7天内', pct(mv('T09')), `30天内 ${pct(mv('T10'))}`, 'violet')}
        </div>
        ${finding('30日机会校正结果', `仅在首次可见评论距观察截止日不少于30天的 <strong>2,367人</strong>中计算，356人后续仍有评论，点估计 <strong>${pct(mv('T17'))}</strong>，Wilson 95%区间 ${pct(mv('T18'))}–${pct(mv('T19'))}。`, '正确分母', 'green')}
      </div>
    </div>
    <h4>这不是平台留存</h4>
    <p class="note">时间起点是样本内首次可见评论，不是首次观看、首次关注或真实注册；只观测到后续评论，没有后续观看但未评论的记录。60%以上的“单次互动”只能解释为样本内只出现一次，不等于流失。90/107条视频缺少可靠发布时间，因此月度评论量不用于内容增长因果判断。</p>
  </section>

  <div class="part-head" id="part-05"><span class="no">05</span><h2>三国杀玩家语境</h2><p>三层编码：角色识别、关系叙事、规则与历史解码</p></div>
  <section class="band">
    <p class="lead">评论并非普通情绪文本。表层是卡宝拟人、萌化与可爱占有；中层是武将名、表字昵称、君臣/CP/悲剧修复等关系叙事；深层是技能机制、版本经济、历史互文、正史核验与台词回调。真正的玩家价值在于把游戏机制翻译成日常动作和二创笑点，而不是简单出现“三国杀”三个字。</p>
    <div class="three-col">
      ${finding('表层：人格化与可拥有', `卡宝人格点名覆盖 ${pct(mv('S02'))} U2，萌化情感覆盖 ${pct(mv('S03'))}。这是泛娱乐进入与商品想象最直接的语言层。`, '情感入口', 'amber')}
      ${finding('中层：角色与关系', `角色识别覆盖 ${pct(mv('S01'))} U2，有机关系共创覆盖 ${pct(mv('S07'))}。角色识别是进入CP、护短、追更与悲剧修复的桥梁。`, '叙事参与', 'violet')}
      ${finding('深层：规则与考据', `严格玩家解码覆盖 ${pct(mv('S04'))} U2；其中严格机制映射仅 ${pct(mv('S05'))}，史事与设定 ${pct(mv('S06'))}。小比例不等于低价值，它们承担圈内可信度。`, '玩家信誉', 'green')}
    </div>
    <h3 style="margin-top:26px">34个开放编码的评论发生量</h3>
    <div class="two-col"><div>${semanticTopBars}</div><div>${table(semantics,[{label:'编码',render:r=>esc(semanticLabels[r['编码']]||r['编码'])},{label:'规则ID',render:r=>`<code>${esc(r['编码'])}</code>`},{label:'评论数',render:r=>fmt(r['评论数']),className:'num'},{label:'评论率',render:r=>pct(r['评论占比']),className:'num'}])}</div></div>
    <p class="note">34个编码是规则辅助的扎根式下限，允许一条评论命中多个编码，比例不能相加为100%。负面词在卖血、锁技能、历史悲剧、角色台词、自嘲和反讽中常有完全不同含义，因此本报告不自动计算“负面率”。</p>
  </section>

  <div class="part-head" id="part-06"><span class="no">06</span><h2>受众部落与价值分工</h2><p>语境深度不是价值等级，部落也不是人口标签</p></div>
  <section class="band">
    <h3>五层可观测语境深度</h3>
    ${contextBars}
    <p class="note">L1“其他已编码表达”吸收了未进入角色/玩家/共创主轴的商业、仪式、提问和边界表达，因此它的周边与购买比率较高是分类定义结果，不可解释为“L1比L4更有商业价值”。L0只代表现有词典未命中，不是已验证的泛人群。</p>
    <h3 style="margin-top:28px">严格玩家 × 萌化的四类交叉部落</h3>
    ${table(tribes,[
      {label:'部落',key:'部落'},
      {label:'用户',render:r=>fmt(r['用户数']),className:'num'},
      {label:'U2占比',render:r=>pct(r['用户占比']),className:'num'},
      {label:'跨视频评论',render:r=>pct(r['跨视频率']),className:'num'},
      {label:'30日机会分母',render:r=>fmt(r['30日观察分母']),className:'num'},
      {label:'30日后仍评论',render:r=>pct(r['30日后仍评论率']),className:'num'},
      {label:'周边兴趣',render:r=>pct(r['周边兴趣率']),className:'num'},
      {label:'购买表达',render:r=>pct(r['购买表达率']),className:'num'},
    ])}
    <div class="finding-grid" style="margin-top:18px">
      ${finding('玩家×萌化：社群种子', `478人，占U2的9.58%；跨视频 ${pct(tribes.find(x=>x['部落']==='玩家×萌化')['跨视频率'])}，周边兴趣 ${pct(tribes.find(x=>x['部落']==='玩家×萌化')['周边兴趣率'])}。适合共创、测试和内容解释，不外推为市场规模。`, '高参与 + 高商品想象', 'green')}
      ${finding('仅玩家：信誉与解释层', `784人；跨视频 ${pct(tribes.find(x=>x['部落']==='仅玩家')['跨视频率'])}，购买表达仅 ${pct(tribes.find(x=>x['部落']==='仅玩家')['购买表达率'])}。适合机制钩子、考据与纠错，不应被当成首要卖货池。`, '高内容价值 + 低购买表达', 'blue')}
      ${finding('仅萌化：商品概念入口', `564人；周边兴趣 ${pct(tribes.find(x=>x['部落']==='仅萌化')['周边兴趣率'])}，购买表达 ${pct(tribes.find(x=>x['部落']==='仅萌化')['购买表达率'])}，是四格中最高。优先用于视觉、材质、尺寸与价格测试。`, '中参与 + 高购买表达', 'amber')}
      ${finding('二者皆无：最大外圈', `3,164人，占U2的63.41%；跨视频 ${pct(tribes.find(x=>x['部落']==='二者皆无')['跨视频率'])}。它包含大量低频与未编码表达，只能作为增长池，不能称为“泛受众画像”。`, '大规模 + 低可见深度', 'violet')}
    </div>
  </section>

  <div class="part-head" id="part-07"><span class="no">07</span><h2>社群入口与作者回复</h2><p>用效应量建立实验先验，而不是把相关性写成运营效果</p></div>
  <section class="band">
    <div class="metric-grid">
      ${metricCard('首触为根评论', pct(mv('C01')), '3,743 / 5,410人', 'blue')}
      ${metricCard('首触为回复', pct(mv('C02')), '1,667 / 5,410人', 'green')}
      ${metricCard('根评入口跨视频', pct(mv('C03')), '1,426 / 3,743人', 'amber')}
      ${metricCard('回复入口跨视频', pct(mv('C04')), '398 / 1,667人', 'violet')}
    </div>
    ${effectCard('首根评“作者回复”标记与跨视频评论代理', effects.author_reply_marker_vs_cross_video, `首根评带作者回复标记的观测评论者跨视频率高出 ${pp(effects.author_reply_marker_vs_cross_video.risk_difference)}，RR=${dec(effects.author_reply_marker_vs_cross_video.risk_ratio,2)}，OR=${dec(effects.author_reply_marker_vs_cross_video.odds_ratio,2)}。但字段没有真实回复时间；作者可能更愿意回复高质量或高活跃用户，视频批次与内容质量也未控制。该结果只能用于估算随机回复实验的样本和先验。`, 'blue')}
    <div class="two-col" style="margin-top:16px">
      ${finding('根评是更强的参与入口', `根评入口组跨视频率 ${pct(mv('C03'))}，回复入口组 ${pct(mv('C04'))}。两者相差并不证明“鼓励根评”会产生复访，因为用户主动性与评论内容同时影响入口类型。`, '入口关联', 'green')}
      ${finding('回复策略要从“挑热评”改成实验', `首根评被回复标记率为 ${pct(mv('C05'))}。下一步应按视频、时段和语境分层随机分配回复，记录回复时间，比较7日可见回评，而不是继续比较被选择与未被选择的人。`, '可行动作', 'amber')}
    </div>
  </section>

  <div class="part-head" id="part-08"><span class="no">08</span><h2>商品与购买语言</h2><p>并列信号，不画伪漏斗</p></div>
  <section class="band">
    <p class="lead">商业证据来自两组高度重叠、但定义不同的语言信号：367位周边兴趣评论者与153位严格购买表达评论者。两者交集146人，另有7位购买表达者没有命中宽泛周边词。因此它们是并列信号，不是“5,410→367→153”的转化漏斗。</p>
    <div class="signal-grid">
      <article class="signal"><h3>周边兴趣</h3><strong>${fmt(data.commerce.merchUserCount)}人</strong><p>占U2 ${pct(data.commerce.merchUserCount/data.coverage.audienceTextUsers)}；包括玩偶、周边、表情包、毛绒、实体、公仔、手办、盲盒等。</p></article>
      <article class="signal"><h3>严格购买表达</h3><strong>${fmt(data.commerce.purchaseUserCount)}人 / ${fmt(data.commerce.purchaseCommentCount)}评</strong><p>占U2 ${pct(data.commerce.purchaseUserCount/data.coverage.audienceTextUsers)}；表达“想买、必买、肯定买、在哪里买”或催促具体周边。</p></article>
      <article class="signal"><h3>信号交集</h3><strong>${fmt(data.commerce.overlapUserCount)}人</strong><p>占购买表达用户 ${pct(data.commerce.overlapUserCount/data.commerce.purchaseUserCount)}；还有 ${fmt(data.commerce.purchaseUserCount-data.commerce.overlapUserCount)} 人仅命中严格购买规则。</p></article>
    </div>
    <h3 style="margin-top:26px">购买表达评论中的品类语言</h3>
    ${barList(Object.entries(data.commerce.categories).map(([label,value])=>({label,value})),{label:r=>r.label,value:r=>r.value,display:r=>`${fmt(r.value)}评 · ${pct(r.value/data.commerce.purchaseCommentCount)}`,tone:'amber'})}
    <div class="finding-grid" style="margin-top:18px">
      ${finding('玩偶/娃娃是第一概念，而非销量预测', `${fmt(data.commerce.categories['玩偶/娃娃'])}/${fmt(data.commerce.purchaseCommentCount)}条购买表达提及玩偶或娃娃，即 ${pct(data.commerce.categories['玩偶/娃娃']/data.commerce.purchaseCommentCount)}。泛周边为 ${pct(data.commerce.categories['泛周边']/data.commerce.purchaseCommentCount)}。品类多标签可重叠，不能相加为100%。`, '产品假设', 'amber')}
      ${finding('信号对头部热评稳健', `去除点赞最高的3条购买表达评论，仍有 ${fmt(data.commerce.top3RemovedUserCount)}/${fmt(data.commerce.purchaseUserCount)} 位用户保留购买表达，保留率 ${pct(data.commerce.top3RemovedUserCount/data.commerce.purchaseUserCount)}。这支持继续做概念测试，但不支持直接备货。`, '稳健性', 'green')}
      ${finding('价格信息远远不足', `价格敏感只覆盖 ${pct(mv('S11'),2)} U2；按购买用户条件口径仅 ${pct(mv('M08'),2)}。少量高赞“不要太贵”适合提出三档价格实验，不足以定义价格带。`, '定价边界', 'red')}
      ${finding('商业分母必须升级', '下一阶段把评论语言作为招募与创意筛选，把到货提醒点击、订金、有效联系方式提交、支付与取消作为真实漏斗事件；角色偏好只按正文直接点名归因，不按视频标题归因SKU。', '数据建设', 'blue')}
    </div>
  </section>

  <div class="part-head" id="part-09"><span class="no">09</span><h2>视频组合与内容资产</h2><p>从单条爆款转向组合分布与可重复性</p></div>
  <section class="band">
    <div class="metric-grid">
      ${metricCard('有观众评论视频', fmt(mv('V01')), `总样本${fmt(data.coverage.videos)}条`, 'blue')}
      ${metricCard('单视频评论中位 / P90', `${dec(mv('V02'),1)} / ${dec(mv('V05'),1)}`, '非作者评论', 'green')}
      ${metricCard('视频评论Gini', dec(mv('V06'),3), `有效视频数 ${dec(mv('V08'),1)}`, 'amber')}
      ${metricCard('Top10评论贡献', pct(mv('V09')), '不是单条爆款垄断', 'violet')}
    </div>
    <p class="lead">视频评论量的Gini为 ${dec(mv('V06'),3)}，106条有观众评论的视频对应的有效视频数为 ${dec(mv('V08'),1)}；Top10只贡献 ${pct(mv('V09'))} 观众评论。当前生态更接近“广泛中高位供给”，而不是一两条爆款驱动。视频评论量与人均评论的Spearman ρ=${dec(mv('V12'),3)}，与每评平均赞的ρ=${dec(mv('V13'),3)}；后者更高，但点赞不是曝光，不能解释为内容效率。</p>
    <h3>观众评论量Top 12视频</h3>
    ${table(topVideos,[
      {label:'视频标题',render:r=>esc(clip(r['所属视频标题'],48))},
      {label:'观众评论',render:r=>fmt(r['观众评论数']),className:'num'},
      {label:'观众用户',render:r=>fmt(r['观众用户数']),className:'num'},
      {label:'文本用户',render:r=>fmt(r['文本用户数']),className:'num'},
      {label:'人均评论',render:r=>dec(r['人均评论'],2),className:'num'},
      {label:'评论点赞',render:r=>fmt(r['评论点赞数']),className:'num'},
      {label:'每评平均赞',render:r=>dec(r['每评平均赞'],2),className:'num'},
    ])}
    <p class="note">没有播放、完播、收藏、分享和关注数据，因此表格比较的是“已发生评论中的规模与结构”，不是曝光效率或内容ROI。标题也只是内容供给代理，不代表画面、对话和剧情的全部曝光。</p>
  </section>

  <div class="part-head" id="part-10"><span class="no">10</span><h2>统计关联与证据强度</h2><p>点估计、区间、绝对差与相对差同时报告</p></div>
  <section class="band">
    <div class="effect-list">
      ${effectCard('严格玩家解码 × 跨视频评论代理', effects.strict_vs_cross_video, `严格玩家解码者的跨视频评论率比非严格组高 ${pp(effects.strict_vs_cross_video.risk_difference)}，RR=${dec(effects.strict_vs_cross_video.risk_ratio,2)}。这支持“机制/考据是高参与人群特征”，不证明加入机制钩子必然提升复访。`, 'green')}
      ${effectCard('萌化情感 × 严格购买表达', effects.cute_vs_purchase, `萌化评论者的严格购买表达率比非萌化组高 ${pp(effects.cute_vs_purchase.risk_difference)}，RR=${dec(effects.cute_vs_purchase.risk_ratio,2)}。这支持商品概念测试优先面对萌化人群，但不能解释为购买转化率。`, 'amber')}
      ${effectCard('有机共创 × 跨视频评论代理', effects.organic_co_creation_vs_cross_video, `有机共创者跨视频率为 ${pct(effects.organic_co_creation_vs_cross_video.exposed_rate)}，非共创组为 ${pct(effects.organic_co_creation_vs_cross_video.unexposed_rate)}。共创是持续参与的强标记，但也可能只是高活跃用户更容易进入共创。`, 'violet')}
    </div>
    <h3 style="margin-top:26px">模型外的关联校验</h3>
    <div class="three-col">
      ${metricCard('语境层 × 评论数', `ρ=${dec(mv('S29'),3)}`, 'Spearman秩相关', 'blue')}
      ${metricCard('语境层 × 视频广度', `ρ=${dec(mv('S30'),3)}`, 'Spearman秩相关', 'green')}
      ${metricCard('四部落 × 跨视频', `V=${dec(mv('S31'),3)}`, "Cramer's V", 'violet')}
    </div>
    <p class="note">所有效应量来自观察数据：没有随机曝光，没有控制推荐分发、视频质量、发布时间与用户自选择，也没有多变量因果识别。报告使用“关联、共现、观测率差”，不使用“驱动、提升、转化”。</p>
  </section>

  <div class="part-head" id="part-11"><span class="no">11</span><h2>MKT受众经营系统</h2><p>把内容、社群与商业放进一棵可追踪KPI树</p></div>
  <section class="band">
    <div class="matrix">
      <article><h3>1. 入口规模</h3><ul><li>每视频独立观测评论者</li><li>根评入口评论者占比</li><li>文本可用率与理解门槛率</li><li>视频评论集中度与Top10份额</li></ul></article>
      <article><h3>2. 持续参与</h3><ul><li>至少2次 / 4次互动用户率</li><li>第二次互动中位时延</li><li>7日、30日机会校正可见回评</li><li>跨视频评论代理与视频广度</li></ul></article>
      <article><h3>3. 语境与社群</h3><ul><li>角色识别、严格玩家、共创用户率</li><li>玩家×萌化四格部落</li><li>线程入口与作者回复实验差</li><li>仪式参与和有机共创分开</li></ul></article>
      <article><h3>4. 商业验证</h3><ul><li>周边兴趣与购买表达并列报告</li><li>品类、价格、角色正文点名</li><li>到货提醒、订金、支付、取消</li><li>剔除Top热评后的稳健性</li></ul></article>
    </div>
    <h3 style="margin-top:26px">三类内容任务，不用一个“爆款分”混在一起</h3>
    <div class="finding-grid">
      ${finding('泛娱乐入口片', '用强视觉、角色萌化、日常冲突降低理解门槛。主指标是独立评论者和理解门槛；不以硬核术语密度作为成功标准。', 'Reach proxy', 'amber')}
      ${finding('玩家信誉承接片', '把技能机制、历史互文和表字昵称转成剧情因果，再补一句圈外人能理解的白话。主指标是严格玩家用户率、解释/纠错与后续跨视频评论。', 'Trust proxy', 'green')}
      ${finding('关系共创连续剧', '开放结尾、续作选择、角色护短与悲剧修复，明确区分玩家二创与官方设定。主指标是有机共创用户、行动型请求和跨视频评论代理。', 'Community proxy', 'violet')}
      ${finding('商品概念验证片', '展示可触摸的尺寸、材质、细节与价格，不把CP热度自动外推为双人套装购买。主指标从评论升级为点击、预约、订金和支付。', 'Commerce event', 'blue')}
    </div>
  </section>

  <div class="part-head" id="part-12"><span class="no">12</span><h2>90天实验路线</h2><p>把观察关联升级为可检验的经营因果</p></div>
  <section class="band">
    <div class="experiment-grid">
      <article class="experiment"><span class="id">EXP 01 · 2×2内容语境</span><h3>萌化钩子 × 机制钩子</h3><p>验证两类价值是互补、替代，还是仅由既有用户自选择造成。</p><dl><dt>设计</dt><dd>同角色、同长度、同发布块；四格各至少6条，共24条。</dd><dt>主指标</dt><dd>7日跨视频可见回评用户 / 千名合格首触评论者。</dd><dt>次指标</dt><dd>严格玩家、共创、周边与购买表达 / 千名文本评论者。</dd><dt>分析</dt><dd>Wilson区间、风险差、风险比；按角色与发布块分层。</dd></dl></article>
      <article class="experiment"><span class="id">EXP 02 · 作者回复RCT</span><h3>随机回复，而不是挑热评</h3><p>检验作者回复是否真正影响后续可见参与。</p><dl><dt>设计</dt><dd>按视频、小时、首评语境分层，首根评随机回复/不回复，各至少400。</dd><dt>主指标</dt><dd>7日跨视频可见回评。</dd><dt>次指标</dt><dd>后续严格玩家、共创和周边表达。</dd><dt>先验</dt><dd>观察关联 ${pct(effects.author_reply_marker_vs_cross_video.exposed_rate)} vs ${pct(effects.author_reply_marker_vs_cross_video.unexposed_rate)}，只用于样本规划。</dd></dl></article>
      <article class="experiment"><span class="id">EXP 03 · 仪式净化</span><h3>to签、开放共创与无提示对照</h3><p>拆分“活动参与”与“自然内容关系”，避免复制文案虚增角色声量。</p><dl><dt>设计</dt><dd>三种CTA使用相同角色与叙事长度，各至少6条。</dd><dt>主指标</dt><dd>后续非活动视频中的有机角色/关系表达。</dd><dt>次指标</dt><dd>跨视频评论、重复文案率、共创行动请求。</dd><dt>停止线</dt><dd>只增加当期固定话术、不增加后续有机表达则不扩量。</dd></dl></article>
      <article class="experiment"><span class="id">EXP 04 · 商品概念</span><h3>单武将玩偶、双人套装、卡宝挂件</h3><p>把169条购买语言推进到真实行为事件。</p><dl><dt>设计</dt><dd>同渲染质量、同信息量；价格另设三档随机展示。</dd><dt>主指标</dt><dd>到货提醒、有效预约、订金与支付率。</dd><dt>次指标</dt><dd>正文直接点名角色、取消、价格敏感反馈。</dd><dt>边界</dt><dd>不按视频标题归因SKU，不以评论“必买”替代支付。</dd></dl></article>
      <article class="experiment"><span class="id">EXP 05 · 7日承接序列</span><h3>入口片 → 解释片 → 共创片</h3><p>${pct(mv('T09'))}的重复互动者在7天内发生二次互动，为内容编排提供观察窗口。</p><dl><dt>设计</dt><dd>入口片后7天内固定发布角色续篇、机制解释与开放共创各1条。</dd><dt>主指标</dt><dd>同入口队列的7日跨视频可见回评。</dd><dt>次指标</dt><dd>角色→严格玩家、角色→有机共创的观测迁移。</dd><dt>控制</dt><dd>记录完整发布时间、内容曝光和推荐来源。</dd></dl></article>
      <article class="experiment"><span class="id">EXP 06 · 组合稳定性</span><h3>减少对头部视频与高频用户的依赖</h3><p>检验策略是否能在不同视频和普通评论者中复现。</p><dl><dt>设计</dt><dd>每轮同时报告全样本、剔除Top1%用户、剔除Top3热评、留一视频。</dd><dt>主指标</dt><dd>方向一致、效应量量级稳定、支持用户数达阈值。</dd><dt>阈值</dt><dd>≥100用户可进主文；30–99为探索；&lt;30仅列绝对数。</dd><dt>决策</dt><dd>仅多数稳健设定下方向一致的结论进入季度预算。</dd></dl></article>
    </div>
    <div class="three-col" style="margin-top:18px">
      ${finding('0–30天：补数据链', '补齐发布时间、播放、完播、分享、收藏、关注、点击、预约、支付与取消；冻结指标字典和实验日志。', 'Phase 1', 'blue')}
      ${finding('31–60天：跑内容实验', '执行2×2语境、回复RCT与仪式净化，按预注册主指标判断，不用总评论量替代。', 'Phase 2', 'green')}
      ${finding('61–90天：跑商品实验', '只对内容实验中稳定的人群与概念做点击、预约和订金验证；不以当前评论样本直接备货。', 'Phase 3', 'amber')}
    </div>
  </section>

  ${expandedSections}

  ${repeatCommenterSection}

  <div class="part-head" id="part-28"><span class="no">28</span><h2>98项指标字典与复算</h2><p>每一个数字都保留方法、分母、解释和边界</p></div>
  <section class="band">
    <p class="lead">下表是本报告的机器可读证据索引。98项指标均来自同一轮重跑；筛选只改变表格展示，不改变底层数值。指标数量是分析维度，不等于98种统计方法。</p>
    <div class="tools"><input id="metricSearch" type="search" placeholder="搜索指标ID、名称、方法或解释" aria-label="搜索指标"><select id="moduleFilter" aria-label="筛选指标模块"><option value="">全部模块</option>${modules.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select><output id="metricCount">显示 ${data.metrics.length} / ${data.metrics.length} 项</output></div>
    <div class="table-wrap metric-dictionary"><table id="metricTable"><thead><tr><th>ID</th><th>模块</th><th>指标</th><th>数值</th><th>统计方法</th><th>分母 / 样本</th><th>经营解释</th><th>证据边界</th></tr></thead><tbody>${allMetricRows}</tbody></table></div>
    <h3 style="margin-top:26px">证据边界</h3>
    <div class="definition-grid">${data.evidenceBoundaries.map((item,index)=>`<article><strong>LIMIT ${String(index+1).padStart(2,'0')}</strong><span>${esc(item)}</span></article>`).join('')}</div>
    <h3 style="margin-top:26px">交付文件</h3>
    <div class="definition-grid">
      <article><strong>结构化分析</strong><span><a href="wuhu-mkt-multidimensional-analysis.json">wuhu-mkt-multidimensional-analysis.json</a></span></article>
      <article><strong>98项指标字典</strong><span><a href="wuhu-mkt-multidimensional-metric-dictionary.csv">wuhu-mkt-multidimensional-metric-dictionary.csv</a></span></article>
       <article><strong>匿名用户画像</strong><span><a href="wuhu-mkt-multidimensional-anonymous-profiles.csv">wuhu-mkt-multidimensional-anonymous-profiles.csv</a></span></article>
       <article><strong>内部具名时序附录</strong><span><a href="多次评论用户具名时序附录.html">多次评论用户具名时序附录.html</a><br>含昵称、主页、原文与精确时间，仅内部使用</span></article>
       <article><strong>具名用户级画像</strong><span><a href="多次评论用户具名画像与时序.csv">多次评论用户具名画像与时序.csv</a></span></article>
       <article><strong>逐条具名评论时序</strong><span><a href="多次评论用户逐条评论时序明细.csv">多次评论用户逐条评论时序明细.csv</a></span></article>
       <article><strong>具名时序统计</strong><span><a href="wuhu-repeat-commenter-identified-temporal-analysis.json">wuhu-repeat-commenter-identified-temporal-analysis.json</a></span></article>
       <article><strong>视频统计明细</strong><span><a href="wuhu-mkt-multidimensional-video-statistics.csv">wuhu-mkt-multidimensional-video-statistics.csv</a></span></article>
      <article><strong>增长路径明细</strong><span><a href="wuhu-mkt-deep-pseudonymous-journeys.csv">wuhu-mkt-deep-pseudonymous-journeys.csv</a></span></article>
      <article><strong>视频任务评分</strong><span><a href="wuhu-mkt-deep-video-scorecard.csv">wuhu-mkt-deep-video-scorecard.csv</a></span></article>
      <article><strong>玩家语境编码</strong><span><a href="wuhu-grounded-coded-comments.csv">wuhu-grounded-coded-comments.csv</a></span></article>
      <article><strong>扎根编码手册</strong><span><a href="三国杀玩家语境扎根编码手册.md">三国杀玩家语境扎根编码手册.md</a></span></article>
      <article><strong>方法与口径</strong><span><a href="主报告证据口径与复算说明.md">主报告证据口径与复算说明.md</a></span></article>
       <article><strong>生成与验证脚本</strong><span>scripts/analyze-wuhu-repeat-user-background.py<br>scripts/build-wuhu-repeat-commenter-identified-appendix.py<br>scripts/generate-wuhu-mkt-master-report.mjs<br>scripts/wuhu-repeat-commenter-section.mjs<br>scripts/verify-wuhu-mkt-master-report.py</span></article>
    </div>
  </section>

  <footer class="footer"><span>三国杀WUHU联盟卡宝 · 受众资产与内容增长战略全量报告</span><span>28章内部具名时序版 · 生成于 ${esc(data.generatedAt)}</span></footer>
</main>
<script>
const search=document.getElementById('metricSearch');const select=document.getElementById('moduleFilter');const rows=[...document.querySelectorAll('#metricTable tbody tr')];const count=document.getElementById('metricCount');function apply(){const q=search.value.trim().toLowerCase();const module=select.value;let visible=0;for(const row of rows){const show=(!q||row.dataset.search.includes(q))&&(!module||row.dataset.module===module);row.hidden=!show;if(show)visible++;}count.textContent='显示 '+visible+' / '+rows.length+' 项';}search.addEventListener('input',apply);select.addEventListener('change',apply);
</script>
</body>
</html>`;

const methodMd = `# 三国杀WUHU联盟卡宝：98维受众统计方法与口径

## 1. 数据母体

| 代号 | 母体 | 数量 | 用途 |
|---|---|---:|---|
| C0 | 视频汇总声明评论 | ${fmt(data.coverage.declaredComments)}条 | 采集覆盖分母 |
| C1 | 实际采集评论 | ${fmt(data.coverage.capturedComments)}条 | 当前可见语料 |
| C2 | 排除作者后的观众评论 | ${fmt(data.coverage.audienceComments)}条 | 评论行为分析 |
| C3 | 有文本观众评论 | ${fmt(data.coverage.audienceTextComments)}条 | 语义编码评论分母 |
| U1 | 观测评论者 | ${fmt(data.coverage.audienceUsers)}人 | 用户行为主分母 |
| U2 | 有文本观测评论者 | ${fmt(data.coverage.audienceTextUsers)}人 | 用户语义与商业主分母 |
| V | 视频汇总样本 | ${fmt(data.coverage.videos)}条 | 视频组合分析 |

采集覆盖率为 ${pct(data.coverage.capturedComments/data.coverage.declaredComments,3)}。用户键使用评论用户URL优先。常规导出的用户级表为稳定匿名ID，不含昵称、URL、原文和精确评论时间；本版按内部复盘需求另行生成具名时序附录，包含多次评论者的昵称、主页、原始评论与精确时间，必须限制在本项目内部使用。

## 2. 分析规模

- 固定原子指标：**${fmt(data.scope.metricDimensions)}项**。
- 实际统计程序：**${fmt(data.scope.statisticalMethodCount)}类**。
- 分析层级：${data.scope.analysisLevels.join('、')}。
- 观察期：${data.coverage.observationStart} 至 ${data.coverage.observationEnd}。

## 3. 统计程序

${methods.map((method)=>`- \`${method}\``).join('\n')}

指标数不等于统计方法数。98项指标是固定的数据字典；34类方法包括规模、比例、分位数、集中度、区间估计、效应量、关联与稳健性程序。

## 4. 关键定义

### 4.1 跨视频评论代理

同一匿名观测评论者在至少两条视频留下评论。它是样本内可见评论行为，不是观看留存、关注留存或平台推荐曝光。

### 4.2 30日后仍评论率

仅在首次可见评论距离样本截止日至少30天的人中计算。首次可见评论不是首次观看或首次关注，因此只能称机会校正的可见回评率。

### 4.3 五层语境深度

- L0 未编码互动：现有词典未命中，不等于已验证泛受众。
- L1 其他已编码表达：未进入角色、严格玩家、有机共创主轴的商业、仪式、提问和边界表达。
- L2 角色/萌化身份：角色点名、卡宝人格与萌化表达。
- L3 严格玩家解码：表字昵称、机制、经济记忆、历史互文、设定核验、台词回调与解释。
- L4 有机共创：关系配对、保护/护短、悲剧修复、角色扮演与追更；排除纯to签仪式。

用户按 L4 > L3 > L2 > L1 > L0 互斥归层。语境深度是表达代理，不是人口身份或价值等级。

### 4.4 商业语言

- 周边兴趣：玩偶、周边、表情包、毛绒、实体、公仔、手办、盲盒等宽泛语言。
- 严格购买表达：想买、必买、肯定买、我要买、在哪里买，或催促推出具体周边的句式。
- 两类信号高度重叠但不构成漏斗：${fmt(data.commerce.overlapUserCount)}/${fmt(data.commerce.purchaseUserCount)}位购买表达者同时命中周边兴趣。
- 评论表达不是订单、GMV或真实购买率；品类规则允许多标签。

## 5. 证据解释规则

1. 所有语义主题同时保留评论发生率与独立评论者发生率；不以评论量替代受众规模。
2. 比例优先报告分子、分母和Wilson 95%区间；偏态分布优先报告中位数和分位数。
3. 组间比较同时报告风险差、风险比与赔率比；所有结果只解释为观察关联。
4. 语义多标签比例不可相加为100%；to签/投稿仪式与有机角色、关系需求分开。
5. 对高度集中信号执行剔除头部热评后的复算；本轮严格购买表达去Top3后保留 ${fmt(data.commerce.top3RemovedUserCount)}/${fmt(data.commerce.purchaseUserCount)} 位用户。

## 6. 主要限制

${data.evidenceBoundaries.map((item)=>`- ${item}`).join('\n')}

## 7. 复算命令

在工作区根目录运行：

\`\`\`powershell
python -X utf8 -u .\\scripts\\analyze-wuhu-mkt-multidimensional.py
node .\\scripts\\generate-wuhu-mkt-multidimensional-report.mjs
python -X utf8 -u .\\scripts\\verify-wuhu-mkt-multidimensional-report.py
python -X utf8 -u .\\scripts\\analyze-wuhu-repeat-user-background.py
python -X utf8 -u .\\scripts\\build-wuhu-repeat-commenter-identified-appendix.py
node .\\scripts\\generate-wuhu-mkt-master-report.mjs
python -X utf8 -u .\\scripts\\verify-wuhu-mkt-master-report.py
\`\`\`

## 8. 产物

- \`三国杀WUHU联盟卡宝98维受众统计深度洞察报告.html\`：离线HTML主报告。
- \`wuhu-mkt-multidimensional-analysis.json\`：全部聚合结果。
- \`wuhu-mkt-multidimensional-metric-dictionary.csv\`：98项指标、方法、分母和边界。
- \`wuhu-mkt-multidimensional-anonymous-profiles.csv\`：匿名用户级派生特征。
- \`wuhu-mkt-multidimensional-video-statistics.csv\`：视频粒度统计。
- \`verification.json\`：一致性、隐私和浏览器验证结果。
- \`多次评论用户具名时序附录.html\`、\`多次评论用户具名画像与时序.csv\`、\`多次评论用户逐条评论时序明细.csv\`：内部具名时序材料；含昵称、主页、原文与精确时间，只限本项目内部使用。
`;

const masterMethodAppendix = `

## 9. 本版战略报告的内容扩展

本版将 98 个可复算指标从“指标字典”重组为 28 个经营章节。正文不把指标总数当作洞察数量；每个重要判断至少明确：观察对象、分子/分母、玩家语境、经营含义、建议动作与证据边界。

- **受众资产**：用单次、同视频重复、跨视频、7 日以上、30 日以上可见评论行为描绘关系强度，而不是把评论总量称为留存。
- **玩家语境**：区分角色识别、严格玩家解码、萌化身份、有机关系共创和活动仪式；“玩家”不是静态人口标签，也不是消费能力标签。
- **内容资产**：把角色、角色关系、视频原型和内容任务拆开。标题下的评论者只是供给视频下的可见响应，不能充当播放曝光或全市场偏好。
- **商业证据**：周边兴趣与严格购买表达并列呈现，明确重叠用户数；评论中的“必买”是表达下限，不是成交、GMV 或转化率。
- **经营系统**：把观察关联转换成可预注册的 2×2 内容实验、作者回复随机对照、关系格式实验与商品概念测试。
- **具名时序核查**：对至少两次评论的用户，保留昵称、主页、原文和精确到秒的时间戳；同时分开计算相邻间隔、短时会话、跨日回流、首次可见月份、周内与日内时段。具名轨迹用于内部核查与定性复盘，不替代聚合指标，也不外推为真实粉丝留存。

## 10. 关键解释纪律

1. 语义标签多数由用户整个观察窗口的文本推导；不能把全周期标签倒灌为首触时的因果变量。
2. “曾出现过”的角色、周边或购买标签受活跃度和可观察机会影响；对比时需同时给样本数、机会窗口和排除头部后的稳健性结果。
3. 严格玩家解码中同时包含表字/昵称、机制、史事、版本和设定校验；角色认同与机制能力不能互相替代。
4. 作者回复关联没有回复时间、选择规则和随机化信息，只能作为随机实验的样本量先验，不能作为回复效果。
5. 视频无播放、完播、收藏、转发与完整发布时间字段；视频排名只用于当前评论语料的内容任务判断，不能声称算法分发、获客效率或显著优于。
6. 角色关系同提不等于 CP；玩家二创、官方设定和史事关系分别表述。低样本关系仅进入探索池，不进入预算承诺。

## 11. 本版复算与交付

在工作区根目录运行：

\`\`\`powershell
python -X utf8 -u .\\scripts\\analyze-wuhu-repeat-user-background.py
python -X utf8 -u .\\scripts\\build-wuhu-repeat-commenter-identified-appendix.py
node .\\scripts\\generate-wuhu-mkt-master-report.mjs
python -X utf8 -u .\\scripts\\verify-wuhu-mkt-master-report.py
\`\`\`

本目录同时保留多维受众、增长路径和扎根玩家语境的结构化导出。聚合与匿名逐评论导出继续使用去标识版本；根据本次内部复盘要求，另有具名时序附录保留多次评论用户的昵称、主页、原始文本和精确时间，不可作为对外传播材料。`;

const masterMethodMd = methodMd.replace(/^#.*$/m, '# 三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告：证据口径与复算说明') + masterMethodAppendix;

const deliverySources = [
  [MULTI_DIR, 'wuhu-mkt-multidimensional-analysis.json'],
  [MULTI_DIR, 'wuhu-mkt-multidimensional-metric-dictionary.csv'],
  [MULTI_DIR, 'wuhu-mkt-multidimensional-anonymous-profiles.csv'],
  [MULTI_DIR, 'wuhu-mkt-multidimensional-video-statistics.csv'],
  [DEEP_DIR, 'wuhu-mkt-deep-analysis.json'],
  [DEEP_DIR, 'wuhu-mkt-deep-pseudonymous-journeys.csv'],
  [DEEP_DIR, 'wuhu-mkt-deep-video-scorecard.csv'],
  [GROUNDED_DIR, 'wuhu-grounded-player-context-analysis.json'],
  [GROUNDED_DIR, 'wuhu-grounded-coded-comments.csv'],
  [GROUNDED_DIR, '三国杀玩家语境扎根编码手册.md'],
];

const deliveryIndex = `# 三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告：交付清单

## 主报告

- \`三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告.html\`：28 章离线主报告，含内部具名时序章节。
- \`主报告证据口径与复算说明.md\`：口径、解释纪律、复算与交付说明。

## 结构化证据

- \`wuhu-mkt-multidimensional-analysis.json\`：98 个原子指标及统计方法。
- \`wuhu-mkt-deep-analysis.json\`：用户旅程、视频任务与商业路径聚合结果。
- \`wuhu-grounded-player-context-analysis.json\`：三国杀玩家语境扎根编码聚合结果。
- \`wuhu-mkt-multidimensional-anonymous-profiles.csv\` 与 \`wuhu-mkt-deep-pseudonymous-journeys.csv\`：匿名用户级派生特征。
- \`wuhu-mkt-multidimensional-video-statistics.csv\` 与 \`wuhu-mkt-deep-video-scorecard.csv\`：视频级指标与内容任务评分。
- \`wuhu-grounded-coded-comments.csv\` 与 \`三国杀玩家语境扎根编码手册.md\`：去标识评论编码和编码规则。

## 内部具名时序材料

- \`多次评论用户具名时序附录.html\`：可搜索的具名用户轨迹与逐条评论时间线。
- \`多次评论用户具名画像与时序.csv\`：2,059 位至少评论两次用户的昵称、主页、原文摘要、精确时间与派生时序特征。
- \`多次评论用户逐条评论时序明细.csv\`：11,364 条评论事件，保留昵称、主页、原始评论、精确时间、视频、层级、点赞与语境标签。
- \`wuhu-repeat-commenter-identified-temporal-analysis.json\`：相邻间隔、会话、月度、周内与日内时序统计。

以上四份文件含源数据中的可识别内容，只限本项目内部分析、复盘和访问控制环境，不得公开转载、转存或二次分发。

## 可复现脚本

- \`scripts/generate-wuhu-mkt-master-report.mjs\`
- \`scripts/wuhu-master-expanded-sections.mjs\`
- \`scripts/analyze-wuhu-repeat-user-background.py\`
- \`scripts/build-wuhu-repeat-commenter-identified-appendix.py\`
- \`scripts/wuhu-repeat-commenter-section.mjs\`
- \`scripts/verify-wuhu-mkt-master-report.py\`
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, report, 'utf8');
fs.writeFileSync(METHOD_PATH, masterMethodMd, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, '交付清单.md'), deliveryIndex, 'utf8');
for (const [sourceDir, filename] of deliverySources) {
  fs.copyFileSync(path.join(sourceDir, filename), path.join(OUT_DIR, filename));
}
const scriptOutDir = path.join(OUT_DIR, 'scripts');
fs.mkdirSync(scriptOutDir, { recursive: true });
for (const filename of ['analyze-wuhu-repeat-user-background.py', 'build-wuhu-repeat-commenter-identified-appendix.py', 'generate-wuhu-mkt-master-report.mjs', 'wuhu-master-expanded-sections.mjs', 'wuhu-repeat-commenter-section.mjs', 'verify-wuhu-mkt-master-report.py']) {
  const source = path.join(ROOT, 'scripts', filename);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scriptOutDir, filename));
}

console.log(JSON.stringify({
  report: REPORT_PATH,
  reportBytes: Buffer.byteLength(report),
  method: METHOD_PATH,
  methodBytes: Buffer.byteLength(masterMethodMd),
  sections: 28,
  metricsRendered: data.metrics.length,
  semanticCodesRendered: data.semanticCodes.length,
  statisticalMethodsRendered: methods.length,
}, null, 2));
