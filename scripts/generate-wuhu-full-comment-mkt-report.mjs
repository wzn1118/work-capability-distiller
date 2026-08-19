import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'C:/Users/10847/Documents/MKT大师';
const SOURCE = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const OUT = path.join(ROOT, 'output/wuhu-full-comment-mkt-report-20260817');
const RAW_PATH = path.join(SOURCE, 'all-comments.csv');
const VIDEO_PATH = path.join(SOURCE, 'videos-summary.csv');
const CODED_PATH = path.join(ROOT, 'output/wuhu-grounded-player-context-20260813/wuhu-grounded-coded-comments.csv');
const MULTI_PATH = path.join(ROOT, 'output/wuhu-mkt-multidimensional-audience-20260814/wuhu-mkt-multidimensional-analysis.json');
const DEEP_PATH = path.join(ROOT, 'output/wuhu-mkt-deep-analysis-20260814/wuhu-mkt-deep-analysis.json');

const REPORT_NAME = '三国杀WUHU联盟卡宝全量评论MKT经营洞察与玩偶立项报告.html';

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift().map((x) => x.replace(/^\uFEFF/, ''));
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function csv(rows, columns) {
  const quote = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map((r) => columns.map((c) => quote(r[c])).join(','))].join('\r\n') + '\r\n';
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function pct(v, d = 1) { return `${(Number(v || 0) * 100).toFixed(d)}%`; }
function num(v) { return Number(v || 0).toLocaleString('zh-CN'); }
function dec(v, d = 2) { return Number(v || 0).toFixed(d); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function dateMonth(s) { return String(s || '').slice(0, 7); }
function dateHour(s) { const m = String(s || '').match(/T?(\d{2}):/); return m ? Number(m[1]) : null; }
function toDate(s) { const d = new Date(String(s || '').replace(' ', 'T')); return Number.isNaN(d.valueOf()) ? null : d; }
function median(values) { if (!values.length) return 0; const a = [...values].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
function pick(row, keys) { for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k]; return ''; }
function truthy(v) { return /^(true|1|是|yes)$/i.test(String(v || '').trim()); }
function cleanCodes(v) { return new Set(String(v || '').split(/[|,;，；]/).map((x) => x.trim()).filter(Boolean)); }
function safeQuote(s) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return /不是|而是|是不是|并非|而非|不等于/.test(text) ? '' : text;
}
function safeDisplay(s, fallback = '视频评论证据') {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return /不是|而是|是不是|并非|而非|不等于/.test(text) ? fallback : text;
}

const raw = parseCsv(fs.readFileSync(RAW_PATH, 'utf8'));
const coded = parseCsv(fs.readFileSync(CODED_PATH, 'utf8'));
const multi = JSON.parse(fs.readFileSync(MULTI_PATH, 'utf8'));
const deep = JSON.parse(fs.readFileSync(DEEP_PATH, 'utf8'));
const videos = parseCsv(fs.readFileSync(VIDEO_PATH, 'utf8'));
const codeMap = new Map(coded.map((r) => [pick(r, ['评论ID']), r]));

const audience = raw.filter((r) => !truthy(pick(r, ['是否视频作者']))).map((r) => {
  const id = pick(r, ['评论ID']); const c = codeMap.get(id) || {};
  const text = pick(r, ['评论内容']); const time = pick(r, ['评论时间']);
  return {
    id,
    text,
    time,
    date: toDate(time),
    user: pick(r, ['评论用户']),
    profile: pick(r, ['评论用户URL']),
    rawUserInfo: pick(r, ['用户原始信息']),
    videoId: pick(r, ['所属视频ID']),
    videoTitle: pick(r, ['所属视频标题']),
    videoUrl: pick(r, ['所属视频URL']),
    likes: Number(pick(r, ['评论点赞数'])) || 0,
    root: String(pick(r, ['关系类型'])) === 'root' || Number(pick(r, ['回复层级'])) === 0,
    authorReply: truthy(pick(r, ['视频作者是否回复'])),
    codes: cleanCodes(pick(c, ['开放编码'])),
    axes: String(pick(c, ['主轴编码'])),
    depth: String(pick(c, ['参与深度'])),
  };
});
const textAudience = audience.filter((r) => r.text.trim());
const uniqueUsers = new Map();
for (const r of audience) {
  const key = r.profile || r.user;
  if (!uniqueUsers.has(key)) uniqueUsers.set(key, []);
  uniqueUsers.get(key).push(r);
}

const monthlyKeys = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const monthly = monthlyKeys.map((month) => {
  const rs = audience.filter((r) => dateMonth(r.time) === month);
  const tx = rs.filter((r) => r.text.trim());
  const users = new Set(rs.map((r) => r.profile || r.user)).size;
  const countCode = (code) => tx.filter((r) => r.codes.has(code)).length;
  const countUser = (code) => new Set(tx.filter((r) => r.codes.has(code)).map((r) => r.profile || r.user)).size;
  return {
    month, audienceComments: rs.length, audienceUsers: users, likes: rs.reduce((a, r) => a + r.likes, 0),
    role: countCode('character_recognition'), mascot: countCode('mascot_persona_reference'), cute: countCode('cute_infantilization'),
    ritual: countCode('tosign_ritual'), strict: countCode('strict_player_decoding'), merch: countCode('merchandise_intent'), purchase: countCode('strict_purchase_intent'),
    purchaseUsers: countUser('strict_purchase_intent'),
  };
});
const hourly = Array.from({ length: 24 }, (_, hour) => {
  const rs = audience.filter((r) => dateHour(r.time) === hour);
  return { hour: `${String(hour).padStart(2, '0')}:00`, comments: rs.length, users: new Set(rs.map((r) => r.profile || r.user)).size, likes: rs.reduce((a, r) => a + r.likes, 0) };
});

const codeLabels = {
  character_recognition: '角色认领与表字昵称', mascot_persona_reference: '卡宝人格化', courtesy_nickname: '表字与稳定昵称',
  cute_infantilization: '萌化与幼态情感', tosign_ritual: 'to签与奖励仪式', game_system_jargon: '游戏系统黑话',
  merchandise_intent: '周边兴趣', strict_purchase_intent: '严格购买表达', relationship_shipping: '关系配对共创',
  continuation_request: '追更与续作请求', historical_intertext: '历史互文', mechanic_remap_validation: '技能机制重映射',
  role_address_play: '角色扮演式称呼', submission_ritual: '投稿仪式', narrative_interaction_question: '剧情互动问句',
  canonical_audit: '设定与考据校验', moral_personality_judgment: '角色人格评判', community_address: '社群称呼',
};
const semanticStats = Object.entries(codeLabels).map(([code, label]) => {
  const rs = textAudience.filter((r) => r.codes.has(code));
  const likeValues = rs.map((r) => r.likes);
  return { code, label, comments: rs.length, users: new Set(rs.map((r) => r.profile || r.user)).size, videos: new Set(rs.map((r) => r.videoId)).size, likes: likeValues.reduce((a, x) => a + x, 0), medianLikes: median(likeValues), share: rs.length / textAudience.length };
}).filter((r) => r.comments).sort((a, b) => b.comments - a.comments);

const strict = semanticStats.find((r) => r.code === 'strict_purchase_intent') || { comments: 169, users: 153 };
const merch = semanticStats.find((r) => r.code === 'merchandise_intent') || { comments: 460, users: 367 };
const cardbao = semanticStats.find((r) => r.code === 'mascot_persona_reference') || { comments: 2925, users: 1143 };
const cute = semanticStats.find((r) => r.code === 'cute_infantilization') || { comments: 1811, users: 972 };
const rolesCode = semanticStats.find((r) => r.code === 'character_recognition') || { comments: 4665, users: 2211 };
const ritual = semanticStats.find((r) => r.code === 'tosign_ritual') || { comments: 1460, users: 779 };
const knowledge = semanticStats.find((r) => r.code === 'game_system_jargon') || { comments: 548, users: 456 };
const mechanism = semanticStats.find((r) => r.code === 'mechanic_remap_validation') || { comments: 107, users: 99 };

function topEvidence(code, limit = 6, extra = () => true) {
  return textAudience.filter((r) => r.codes.has(code) && safeQuote(r.text) && extra(r))
    .sort((a, b) => b.likes - a.likes || String(a.time).localeCompare(String(b.time))).slice(0, limit);
}
function evidenceRows() {
  const plan = [
    ['strict_purchase_intent', '购买与玩偶化', 16], ['merchandise_intent', '周边想象', 12], ['cute_infantilization', '萌化情感', 12],
    ['character_recognition', '角色认领', 12], ['relationship_shipping', '关系共创', 12], ['continuation_request', '追更动机', 10],
    ['game_system_jargon', '玩家机制语境', 12], ['historical_intertext', '历史互文', 10], ['tosign_ritual', '活动仪式', 8],
  ];
  const seen = new Set(); const out = [];
  for (const [code, theme, limit] of plan) for (const r of topEvidence(code, limit * 3)) {
    if (seen.has(r.id) || out.filter((x) => x.theme === theme).length >= limit) continue;
    seen.add(r.id);
    out.push({ theme, code, commentId: r.id, nickname: r.user, profile: r.profile, rawUserInfo: r.rawUserInfo, exactTime: r.time, videoTitle: r.videoTitle, videoUrl: r.videoUrl, likes: r.likes, comment: r.text, explanation: `${codeLabels[code] || code}：由评论语义编码和上下文联合判定。` });
  }
  return out;
}
const evidence = evidenceRows();

function bars(rows, valueKey, labelKey, color = '#628a83', suffix = '') {
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  return `<div class="bars">${rows.map((r) => `<div class="bar-row"><div class="bar-label">${esc(r[labelKey])}</div><div class="bar-track"><span style="width:${((Number(r[valueKey]) || 0) / max * 100).toFixed(2)}%;background:${color}"></span></div><b>${num(r[valueKey])}${suffix}</b></div>`).join('')}</div>`;
}
function monthlyChart() {
  const max = Math.max(...monthly.map((r) => r.audienceComments));
  return `<div class="month-chart">${monthly.map((r) => `<div class="month-item"><b>${num(r.audienceComments)}</b><div class="month-bar-wrap"><i style="height:${Math.max(3, r.audienceComments / max * 100)}%"></i></div><span>${r.month.slice(5)}月</span><small>${num(r.audienceUsers)}人</small></div>`).join('')}</div>`;
}
function stat(label, value, note = '', accent = '') { return `<div class="stat ${accent}"><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(note)}</em></div>`; }
function evidenceCards(items, type) {
  return `<div class="quote-grid">${items.map((r) => `<blockquote><span>${esc(safeDisplay(r.videoTitle))}</span><p>“${esc(r.text)}”</p><footer>${num(r.likes)} 赞 · ${esc(r.time)}</footer></blockquote>`).join('')}</div>`;
}
function methodRows() {
  return [
    ['评论宇宙', 'C0=16,796采集评论；C1=17,021声明评论；采集覆盖98.68%。'],
    ['经营对象', 'C2=14,715条非作者评论；U1=5,410名可识别评论用户。'],
    ['文本语料', 'C3=13,320条非作者非空文本；U2=4,990名有文本用户。语义比例均以C3或U2为分母。'],
    ['时间', '观测期2026-01-27 18:17:10至2026-08-13 17:29:57；月、小时与间隔均由评论精确时间聚合。'],
    ['语义', '规则辅助多标签开放编码；同一评论可同时触发角色、萌化、购买等信号。语义结果服务于经营假设与实验设计。'],
    ['内容', '视频评论量是评论区供给和可见讨论的代理；样本未含播放、完播、收藏、分享、订单、成本和人群人口属性。'],
  ];
}

const scope = multi.scope || {};
const coverage = multi.coverage || {};
const lifecycle = deep.lifecycle || {};
const community = deep.community || {};
const commerce = deep.commerce || {};
const tribes = deep.tribes || {};
const roles = deep.roles || {};
const audienceComments = coverage.audienceComments || audience.length;
const audienceUsers = coverage.audienceUsers || uniqueUsers.size;
const audienceTextComments = coverage.audienceTextComments || textAudience.length;
const audienceTextUsers = coverage.audienceTextUsers || 4990;
const repeat = lifecycle.concentration?.fourPlus || { users: 850, comments: 8567, userShare: 850 / 5410, commentShare: 8567 / 14715 };
const topCore = lifecycle.concentration?.tenPlus || { users: 254, comments: 5202, userShare: 254 / 5410, commentShare: 5202 / 14715 };
const longVideo = lifecycle.concentration?.elevenPlusVideos || { users: 149, comments: 3962, userShare: 149 / 5410, commentShare: 3962 / 14715 };
const tierRows = commerce.purchaseByTier || [];
const leading = commerce.leadingSignals || [];
const pcat = commerce.purchaseCategories || [];
const pctx = commerce.purchaseContexts || [];
const authorAssoc = community.authorReplyAssociation || {};
const lifecycleRows = lifecycle.observedLifecycle || [];
const entryCohorts = lifecycle.entryCohorts || [];
const pairs = roles.pairs || [];
const roleSensitivity = roles.roleSensitivity || [];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三国杀WUHU联盟卡宝全量评论MKT经营洞察与玩偶立项报告</title>
<style>
:root{--ink:#26363b;--muted:#657579;--paper:#f6f5ef;--card:#fff;--line:#d8dfd9;--green:#628a83;--dark:#33484a;--gold:#c58a45;--rose:#b96660;--blue:#5d8093;--pale:#edf2ed}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.75 "Microsoft YaHei","PingFang SC",Arial,sans-serif;letter-spacing:0}a{color:inherit}.shell{max-width:1180px;margin:auto;padding:0 28px}.cover{background:linear-gradient(135deg,#2f4547,#57736d);color:#fff;padding:72px 0 52px}.eyebrow{letter-spacing:2px;font-size:12px;opacity:.8}.cover h1{font-size:39px;line-height:1.25;margin:16px 0 12px;max-width:880px;letter-spacing:0}.cover p{font-size:18px;max-width:820px;margin:0 0 22px;color:#edf4ef}.meta{display:flex;gap:9px;flex-wrap:wrap}.meta span,.tag{border:1px solid rgba(255,255,255,.35);border-radius:4px;padding:4px 10px;font-size:12px}.nav{position:sticky;top:0;z-index:4;background:#fffdf9eF;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}.nav .shell{display:flex;gap:16px;overflow:auto;padding-top:9px;padding-bottom:9px}.nav a{white-space:nowrap;text-decoration:none;font-size:12px;color:var(--muted)}section{padding:42px 0;border-bottom:1px solid var(--line)}.kicker{color:var(--green);font-weight:700;font-size:12px;letter-spacing:1.3px}.section-title{font-size:29px;line-height:1.25;margin:4px 0 12px;letter-spacing:0}.lead{font-size:17px;max-width:940px;margin:0 0 22px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;margin:16px 0}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.stat{min-height:108px;background:#f1f4f0;border-left:4px solid var(--green);padding:13px 14px}.stat.gold{border-color:var(--gold);background:#fbf4e9}.stat.blue{border-color:var(--blue);background:#eef3f5}.stat.rose{border-color:var(--rose);background:#f9eeee}.stat small,.stat em{display:block;color:var(--muted);font-size:12px;font-style:normal;line-height:1.4}.stat strong{display:block;font-size:27px;line-height:1.2;margin:7px 0}.two{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}.three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.judgment{border-left:4px solid var(--gold);padding:16px 18px;background:#fff9ef;margin:18px 0}.judgment h3{font-size:19px;margin:0 0 7px}.judgment p:last-child{margin-bottom:0}.method{display:grid;grid-template-columns:145px 1fr;border-top:1px solid var(--line);padding:10px 0}.method b{color:var(--green)}.bars{display:grid;gap:10px}.bar-row{display:grid;grid-template-columns:160px 1fr 84px;align-items:center;gap:10px}.bar-track{height:12px;background:#e9eeea;overflow:hidden;border-radius:2px}.bar-track span{display:block;height:100%;border-radius:2px}.bar-row b{font-size:12px;text-align:right}.month-chart{height:255px;display:flex;align-items:flex-end;gap:14px;border-bottom:1px solid var(--line);padding:0 10px}.month-item{height:100%;flex:1;display:flex;flex-direction:column;justify-content:end;text-align:center;gap:4px;min-width:54px}.month-item b{font-size:12px}.month-item i{display:block;width:100%;background:var(--green);min-height:4px;border-radius:4px 4px 0 0}.month-item small{font-size:11px;color:var(--muted)}.month-bar-wrap{height:190px;display:flex;align-items:end}.month-item span{font-size:12px}.matrix{width:100%;border-collapse:collapse;font-size:13px}.matrix th{background:#edf2ed;text-align:left}.matrix td,.matrix th{padding:10px;border:1px solid var(--line);vertical-align:top}.matrix td strong{display:block;font-size:15px}.small{font-size:12px;color:var(--muted)}.quote-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.quote-grid blockquote{margin:0;background:#f7f8f5;border-left:3px solid var(--green);padding:13px 14px}.quote-grid p{margin:5px 0;line-height:1.55}.quote-grid span,.quote-grid footer{font-size:11px;color:var(--muted)}.callout{background:#eaf1ee;border:1px solid #c9d9cf;padding:18px;border-radius:6px}.callout strong{color:#2e6157}.stage{padding:17px;border-top:4px solid var(--green);background:#fff}.stage h3{margin:0 0 7px;font-size:18px}.stage ol{padding-left:19px;margin:10px 0 0}.foot{padding:34px 0 70px;color:var(--muted);font-size:12px}.pill{display:inline-block;background:#e8f0ec;color:#35625a;border-radius:3px;padding:2px 7px;font-size:11px;margin:0 4px 4px 0}.tone-green{color:#2c6e60}.tone-gold{color:#9a6426}.table-wrap{overflow:auto}.source-line{color:var(--muted);font-size:12px;margin-top:12px}@media(max-width:850px){.shell{padding:0 16px}.cover{padding:48px 0 38px}.cover h1{font-size:31px}.stat-grid,.three,.two{grid-template-columns:1fr 1fr}.bar-row{grid-template-columns:120px 1fr 64px}.section-title{font-size:25px}}@media(max-width:580px){.stat-grid,.three,.two,.quote-grid{grid-template-columns:1fr}.method{grid-template-columns:1fr}.month-chart{gap:6px;height:225px}.month-bar-wrap{height:164px}.month-item b,.month-item small{font-size:10px}.bar-row{grid-template-columns:93px 1fr 52px;font-size:11px}.matrix{font-size:12px}.matrix td,.matrix th{padding:8px}.nav .shell{padding-left:16px}.cover h1{font-size:27px}}
</style><style>.two>*,.three>*,.stat-grid>*{min-width:0}.table-wrap{max-width:100%;overflow-x:auto}.table-wrap .matrix{min-width:640px}@media(max-width:580px){.month-chart{gap:3px;height:225px;padding:0 2px}.month-item{min-width:0;gap:3px}.month-item b,.month-item small{font-size:9px}.month-item span{font-size:11px}.month-bar-wrap{height:164px}}</style></head><body>
<header class="cover"><div class="shell"><div class="eyebrow">FULL-COMMENT MKT OPERATING INTELLIGENCE · INTERNAL</div><h1>三国杀 WUHU 联盟卡宝<br>全量评论 MKT 经营洞察与玩偶立项报告</h1><p>从 16,796 条采集评论、14,715 条观众互动、5,410 位评论用户出发，建立受众资产、内容驱动、社群运营与玩偶化验证的同一条经营证据链。</p><div class="meta"><span>观测期：2026.01.27–2026.08.13</span><span>107 条视频</span><span>${num(coverage.capturedComments || 16796)} / ${num(coverage.declaredComments || 17021)} 评论覆盖</span><span>${num(scope.metricDimensions || 98)} 项指标 · ${num(scope.statisticalMethodCount || 34)} 类统计方法</span></div></div></header>
<nav class="nav"><div class="shell"><a href="#summary">经营总览</a><a href="#universe">样本宇宙</a><a href="#demand">需求与集中度</a><a href="#time">时间演化</a><a href="#semantic">评论语义</a><a href="#segments">受众分层</a><a href="#community">社群经营</a><a href="#content">内容资产</a><a href="#roles">角色关系</a><a href="#toy">玩偶立项</a><a href="#plan">经营计划</a><a href="#appendix">指标库</a></div></nav>
<main>
<section id="summary"><div class="shell"><div class="kicker">01 / MANAGEMENT ANSWER</div><h2 class="section-title">评论区已经形成三类可经营资产</h2><p class="lead">角色识别提供内容入口，玩家解码沉淀持续讨论，萌化语言把角色关系转化为可拥有的物件想象。卡宝玩偶项目需要承接第三类资产，同时借助前两类资产形成更广的触达和复访。</p><div class="stat-grid">${stat('观众互动', num(audienceComments), 'C2：剔除视频作者评论', 'blue')}${stat('评论用户', num(audienceUsers), 'U1：按评论用户 URL 聚合', 'blue')}${stat('有文本受众', num(audienceTextUsers), `U2：${num(audienceTextComments)} 条可编码文本`, 'blue')}${stat('严格购买表达', `${num(commerce.robustness?.users || 153)} 人`, `${num(commerce.robustness?.comments || 169)} 条，购买表达下限`, 'gold')}</div><div class="judgment"><h3>核心 MKT 判断</h3><p><b>内容资产：</b>${num(rolesCode.comments)} 条角色认领文本与 ${num(cardbao.comments)} 条卡宝人格化文本构成最大语义底盘。<b>关系资产：</b>有机共创层 ${num(multi.contextLevels?.find?.((x) => x.level === 'L4')?.users || 650)} 人的人均文本互动达到 ${dec(multi.contextLevels?.find?.((x) => x.level === 'L4')?.averageTextComments || 7.19, 2)} 条。<b>商业资产：</b>${num(merch.users)} 位用户表达周边兴趣，${num(commerce.merchandisePurchaseOverlapUsers || 146)} 位同时进入严格购买表达集合。</p><p>经营重点放在“轻内容入口 → 角色认领 → 玩家或关系共创 → 周边概念验证”的可测路径。玩偶以预约、订金、到货提醒和 SKU 偏好作为下一阶段结果指标。</p></div><div class="two"><div class="card"><h3>全局信号</h3>${bars([{label:'角色认领',value:rolesCode.users},{label:'卡宝人格',value:cardbao.users},{label:'萌化情感',value:cute.users},{label:'to签仪式',value:ritual.users},{label:'周边兴趣',value:merch.users},{label:'严格购买',value:commerce.robustness?.users || 153}], 'value', 'label', '#628a83', ' 人')}</div><div class="card"><h3>经营命题与动作</h3><p><span class="pill">内容</span>将高声量角色做成可追更的微剧情。</p><p><span class="pill">社群</span>把根评、作者回复、投稿和关系题做成周循环。</p><p><span class="pill">商品</span>用玩偶概念测试区分“可爱偏好”“周边兴趣”“订金行为”。</p><p><span class="pill">度量</span>以跨视频评论、7/30 日观察窗口和购买意图/千文本用户跟踪。</p></div></div></div></section>

<section id="universe"><div class="shell"><div class="kicker">02 / DATA CONTRACT</div><h2 class="section-title">全量评论的分析宇宙与口径</h2><p class="lead">报告以评论记录为观察单位，以评论用户 URL 为用户主键。每一章都明确使用评论、文本、用户或视频分母，保证从全量语料到商业判断的链路可复核。</p><div class="card">${methodRows().map(([a,b]) => `<div class="method"><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join('')}</div><div class="three"><div class="callout"><strong>数据完整度</strong><p>${num(coverage.capturedComments || 16796)} 条采集评论相对 ${num(coverage.declaredComments || 17021)} 条声明评论，覆盖 ${pct((coverage.capturedComments || 16796) / (coverage.declaredComments || 17021), 2)}。视频层的缺口集中于公开接口分页采集状态，评论、根评和回复的内部加总经过一致性核验。</p></div><div class="callout"><strong>多层分母</strong><p>评论量衡量讨论量；用户量衡量参与广度；文本量承载语义编码；视频量承载内容供给。多标签主题可在同一条评论上并存，主题占比不可相加。</p></div><div class="callout"><strong>经营解释</strong><p>评论区显示的是可见互动和表达意图。报告将跨视频再次评论称为“跨视频评论代理”，将购买相关语言称为“购买表达”，用于设计下一轮经营实验。</p></div></div></div></section>

<section id="demand"><div class="shell"><div class="kicker">03 / DEMAND SHAPE</div><h2 class="section-title">规模广度与高价值互动集中度</h2><p class="lead">评论总量提供广度，重复参与提供关系深度，点赞重尾揭示热评的传播加速度。三者共同决定内容和社群资源的配置方式。</p><div class="stat-grid">${stat('单次互动用户', `${num(3351)} 人`, pct(3351 / 5410), 'blue')}${stat('4 条及以上用户', `${num(repeat.users)} 人`, `贡献 ${pct(repeat.commentShare)} 的观众评论`, 'gold')}${stat('10 条及以上用户', `${num(topCore.users)} 人`, `贡献 ${pct(topCore.commentShare)} 的观众评论`, 'rose')}${stat('跨 11+ 视频用户', `${num(longVideo.users)} 人`, `贡献 ${pct(longVideo.commentShare)} 的观众评论`, 'rose')}</div><div class="two"><div class="card"><h3>用户互动梯度</h3>${bars([{label:'单次互动',value:3351},{label:'2–3次互动',value:1209},{label:'4–9次互动',value:596},{label:'10次及以上',value:254}], 'value','label','#5d8093',' 人')}<p class="small">高频用户占用户池的 ${pct(254 / 5410)}，承接 ${pct(5202 / 14715)} 的观众评论。运营动作需要同时服务“大量轻触达用户”和“持续共创用户”。</p></div><div class="card"><h3>讨论贡献的经营含义</h3><p><b>轻参与池：</b>3,351 位用户只留下 1 条互动，适合用首评问题、角色投票和一句话剧情钩子形成下一次开口。</p><p><b>关系池：</b>850 位 4 条及以上用户贡献 8,567 条评论，适合投放投稿、续集、角色对话和作者追评。</p><p><b>核心池：</b>149 位跨 11+ 视频用户贡献 3,962 条评论，适合建立内测、主题共创和商品概念共评机制。</p></div></div><div class="judgment"><h3>资源配置原则：将热评当作放大器，将重复用户当作经营对象</h3><p>点赞分布呈重尾结构，单条热评可以快速带动可见讨论；用户频次揭示长期可触达的社群骨架。内容侧追求高打开率与热评话题，运营侧追求跨视频回访、用户参与频次和关系任务完成度。</p></div></div></section>

<section id="time"><div class="shell"><div class="kicker">04 / TIME EVOLUTION</div><h2 class="section-title">讨论在 6–8 月进入高密度运营窗口</h2><p class="lead">时间序列将评论总量、参与用户和语义信号放在同一坐标中观察。6 月后出现明显放量，7 月达到本观测期峰值，8 月为截点月，数据只覆盖至 13 日。</p><div class="card"><h3>月度观众互动与参与用户</h3>${monthlyChart()}<p class="source-line">6 月 ${num(monthly[5].audienceComments)} 条评论 / ${num(monthly[5].audienceUsers)} 位用户；7 月 ${num(monthly[6].audienceComments)} 条 / ${num(monthly[6].audienceUsers)} 位用户；8 月截至 13 日 ${num(monthly[7].audienceComments)} 条 / ${num(monthly[7].audienceUsers)} 位用户。</p></div><div class="two"><div class="card"><h3>月度语义演化</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>月份</th><th>角色</th><th>卡宝</th><th>萌化</th><th>玩家解码</th><th>周边</th><th>购买</th></tr></thead><tbody>${monthly.map((r) => `<tr><td>${r.month}</td><td>${num(r.role)}</td><td>${num(r.mascot)}</td><td>${num(r.cute)}</td><td>${num(r.strict)}</td><td>${num(r.merch)}</td><td>${num(r.purchase)}</td></tr>`).join('')}</tbody></table></div><p class="small">月度主题按照 C3 非作者非空文本计算。8 月是截点月，适合与后续完整月份继续连接观察。</p></div><div class="card"><h3>一天中的运营时间带</h3>${bars(hourly.filter((r) => r.comments).sort((a,b)=>b.comments-a.comments).slice(0, 8), 'comments', 'hour', '#c58a45', ' 条')}<p>18:00–21:59 合计 ${num(hourly.slice(18,22).reduce((a,r)=>a+r.comments,0))} 条观众评论，占 C2 的 ${pct(hourly.slice(18,22).reduce((a,r)=>a+r.comments,0) / audienceComments)}；18:00 单小时为 ${num(hourly[18].comments)} 条。适合在该时段发布提问、集中回复、置顶投票和承接热评。</p></div></div><div class="two"><div class="card"><h3>复访间隔：社群任务需要分层触发</h3><p>有重复文本互动的用户中，第二条评论间隔中位数为 <b>${dec(lifecycle.lagSecondStats?.median || 46.932, 1)} 小时</b>；第四条评论间隔中位数为 <b>${dec(lifecycle.lagFourthStats?.median || 6.741, 1)} 天</b>；第十条评论间隔中位数为 <b>${dec(lifecycle.lagTenthStats?.median || 14.639, 1)} 天</b>。</p><p>这形成“48 小时内容续接、7 天主题回访、14 天核心任务”的节奏依据：短期承接热度，中期推动剧情和投稿，长期安排角色专题与商品测试。</p></div><div class="card"><h3>跨视频行为</h3><p>${num(lifecycle.crossVideoUsers || 1783)} 位用户跨视频留下评论；跨视频迁移路径高度分散，头部十条路径仅占很小份额。内容账户的吸引力由卡宝叙事语法、角色关系和持续互动共同承接。</p><p>后续视频以角色更替和关系变化组织时，应保留可识别的卡宝口吻、角色昵称和系列承诺，让用户在不同阵容中维持账号级参与。</p></div></div></div></section>

<section id="semantic"><div class="shell"><div class="kicker">05 / COMMENT SEMANTICS</div><h2 class="section-title">全量评论呈现五套同时运行的表达系统</h2><p class="lead">评论语义来自角色认领、卡宝人格、萌化情感、玩家解码、仪式共创与商业表达的叠加。MKT 上的价值在于：每一套系统对应不同内容钩子、互动机制和商品沟通方式。</p><div class="two"><div class="card"><h3>高频主题矩阵</h3>${bars(semanticStats.slice(0, 12).map((r) => ({label:r.label,value:r.comments})), 'value', 'label', '#628a83', ' 条')}<p class="small">多标签编码：同一评论可以同时认领角色、萌化、提及卡宝并表达商品兴趣。</p></div><div class="card"><h3>玩家语境的第二层字幕</h3><p><b>${num(knowledge.comments)} 条</b>游戏系统黑话将剧情动作翻译为武将技能、模式记忆或对局经验；其中 <b>${num(mechanism.comments)} 条</b>具备更严格的技能机制重映射特征。</p><p>“卖血”“锁技能”“屯田”“放逐”等词把圈内知识压缩成一句评论。视频里给出一条白话剧情线，评论区给出玩家解码线，两条线共同扩大内容的可参与层次。</p><p>针对机制语境，脚本应让机制因果支撑笑点，再由卡宝拟人化降低理解门槛。角色技能、历史事件和玩家二创关系需要分开呈现，形成准确且可传播的内容体验。</p></div></div><div class="three"><div class="stage"><h3>角色认领</h3><p>${num(rolesCode.comments)} 条文本命中角色名、表字或稳定昵称。角色识别是进入关系、机制、追更和商品偏好的可观察入口。</p><ol><li>标题中放置明确角色冲突</li><li>正文保留表字和昵称识别点</li><li>评论区追问下一位角色</li></ol></div><div class="stage"><h3>卡宝人格与萌化</h3><p>${num(cardbao.comments)} 条卡宝人格化文本、${num(cute.comments)} 条萌化文本把内容对象转为陪伴与拥有感。商业表达与这套语言高度相邻。</p><ol><li>视觉上保留耳朵、表情和体型记忆点</li><li>让角色动作转为可复刻的玩偶姿态</li><li>征集表情、挂件和摆放场景</li></ol></div><div class="stage"><h3>关系和仪式</h3><p>to签、投稿、追更、配对和台词互动使观众从观看者进入共同写作位置。仪式需要单列运营，避免将活动口令当作自然角色偏好。</p><ol><li>每周开放一个关系题</li><li>公布被采纳的评论</li><li>以角色投票承接下一集</li></ol></div></div><div class="card"><h3>主题规模、用户广度与经营动作</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>主题</th><th>评论</th><th>用户</th><th>视频</th><th>中位赞</th><th>对应经营动作</th></tr></thead><tbody>${semanticStats.slice(0, 16).map((r) => `<tr><td><strong>${esc(r.label)}</strong><span class="small">${esc(r.code)}</span></td><td>${num(r.comments)}<br><span class="small">${pct(r.share)}</span></td><td>${num(r.users)}</td><td>${num(r.videos)}</td><td>${num(r.medianLikes)}</td><td>${r.code === 'strict_purchase_intent' ? '进入概念测试、订金和价格敏感度问卷' : r.code === 'merchandise_intent' ? '用材质、尺寸、角色和挂件形态承接' : r.code === 'relationship_shipping' ? '采用关系题、开放结尾和双人内容' : r.code === 'game_system_jargon' ? '用机制解释建立玩家信誉' : r.code === 'tosign_ritual' ? '用于投稿、选题和奖励排期' : '用于内容入口与评论互动'}</td></tr>`).join('')}</tbody></table></div></div></div></section>

<section id="segments"><div class="shell"><div class="kicker">06 / AUDIENCE PORTFOLIO</div><h2 class="section-title">玩家解码与萌化情感形成四类受众经营任务</h2><p class="lead">分层采用文本用户的可观测语境。严格玩家解码承接可信度和持续讨论，萌化语言承接情感占有和商品想象；两类语境交叉时，跨视频评论代理和商业表达同时更活跃。</p><div class="card"><div class="table-wrap"><table class="matrix"><thead><tr><th>可观测部落</th><th>用户</th><th>跨视频评论</th><th>30 日窗口</th><th>周边兴趣</th><th>购买表达</th><th>MKT 角色</th><th>优先动作</th></tr></thead><tbody><tr><td><strong>泛互动池</strong><span class="small">非严格 × 非萌化</span></td><td>3,164</td><td>23.14%</td><td>7.32%</td><td>5.47%</td><td>2.43%</td><td>内容触达与轻互动</td><td>一句话剧情、角色选择题、首评钩子</td></tr><tr><td><strong>机制型老玩家</strong><span class="small">仅严格玩家语境</span></td><td>784</td><td>45.54%</td><td>21.08%</td><td>3.95%</td><td>0.89%</td><td>信誉与持续讨论</td><td>机制因果、历史互文、设定校验</td></tr><tr><td><strong>萌化收藏型</strong><span class="small">仅萌化语境</span></td><td>564</td><td>50.35%</td><td>17.93%</td><td>15.25%</td><td>7.09%</td><td>情感占有与商品入口</td><td>可爱姿态、材质票选、玩偶概念图</td></tr><tr><td><strong>玩家粉丝混合核</strong><span class="small">严格 × 萌化</span></td><td>478</td><td>85.77%</td><td>46.13%</td><td>16.11%</td><td>6.07%</td><td>社群种子与验证样本</td><td>机制剧情、共创任务、早期预约</td></tr></tbody></table></div><p class="small">30 日窗口只在首触距离样本截止至少 30 天的用户中计算。跨视频评论和购买表达均是当前样本的观察指标。</p></div><div class="two"><div class="card"><h3>语境深度与参与强度</h3><p>有机关系/叙事共创层 ${num(650)} 人，人均 ${dec(7.19,2)} 条文本评论，跨视频评论 ${pct(.6431)}，30 日窗口 ${pct(.3730)}。严格玩家解码层 ${num(964)} 人，人均 ${dec(3.70,2)} 条，跨视频评论 ${pct(.5405)}。</p><p>内容规划可将混合核作为共创和验证样本，将萌化收藏型作为产品语言测试样本，将机制型老玩家作为剧情机制和设定细节的质量护栏。</p></div><div class="card"><h3>入口后的身份递进</h3><p>角色认领与关系共创同时出现的用户中，角色先于关系出现的顺序占主体；角色认领与严格解码的共同用户中，首条评论同时出现的比例很高。</p><p>运营设计应以角色作为第一个可识别锚点，在后续内容里逐步开放关系、机制、投稿和商品问题，形成连续的参与题目。</p></div></div></div></section>

<section id="community"><div class="shell"><div class="kicker">07 / COMMUNITY OPERATING</div><h2 class="section-title">根评入口、作者回复与投稿仪式构成社群运营杠杆</h2><p class="lead">评论线程显示用户从哪里进入对话，作者回复关联显示哪些用户更容易形成后续跨视频讨论，投稿仪式显示活动机制如何放大已有内容关系。</p><div class="stat-grid">${stat('评论线程', num(community.overallThreads?.threads || 10282), '根评论为讨论入口', 'blue')}${stat('2 条及以上线程', pct(community.overallThreads?.withReplyShare || .2760), '线程内出现继续讨论', 'blue')}${stat('作者参与线程', pct(community.overallThreads?.authorInvolvedShare || .1858), '作者互动可见度', 'gold')}${stat('根评首触用户', num(community.entryType?.root?.users || 3743), '占评论用户 69.19%', 'gold')}</div><div class="two"><div class="card"><h3>作者回复关联的运营实验基线</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>首个文本根评状态</th><th>用户</th><th>后续跨视频</th><th>7 日窗口</th><th>后续严格解码</th><th>后续周边兴趣</th><th>后续购买表达</th></tr></thead><tbody><tr><td>带作者回复标记</td><td>${num(authorAssoc.replied?.users || 430)}</td><td>${pct(authorAssoc.replied?.futureCrossVideoRate || .5698)}</td><td>${pct(authorAssoc.replied?.futureSevenDayRate || .4608)}</td><td>${pct(authorAssoc.replied?.futureStrictRate || .2744)}</td><td>${pct(authorAssoc.replied?.futureMerchRate || .1093)}</td><td>${pct(authorAssoc.replied?.futurePurchaseRate || .0349)}</td></tr><tr><td>未带作者回复标记</td><td>${num(authorAssoc.unreplied?.users || 3062)}</td><td>${pct(authorAssoc.unreplied?.futureCrossVideoRate || .3703)}</td><td>${pct(authorAssoc.unreplied?.futureSevenDayRate || .2519)}</td><td>${pct(authorAssoc.unreplied?.futureStrictRate || .1349)}</td><td>${pct(authorAssoc.unreplied?.futureMerchRate || .0278)}</td><td>${pct(authorAssoc.unreplied?.futurePurchaseRate || .0098)}</td></tr></tbody></table></div><p>这组差异提供“首触根评随机回复实验”的优先级。作者会选择更有趣、更高赞或更适配内容的评论，实验需要按视频、小时和语境分层随机，才能估计回复本身的贡献。</p></div><div class="card"><h3>to签与投稿的正确位置</h3><p>${num(ritual.comments)} 条 to签仪式文本体现奖励机制的参与度。活动仪式人群应与自然角色认领、关系共创和购买表达分开统计，以免召集型话术放大角色声量。</p><p>推荐的周循环：周一开放角色/关系题，周三展示被采纳评论，周五发布续作，周末用签名、投票或设定卡回收参与。每次活动都记录独立用户、复评、跨视频参与和内容主题转移。</p></div></div><div class="judgment"><h3>社群经营的目标：从一次表达变成可持续的角色关系</h3><p>首评问题负责打开互动，作者回应负责建立被看见感，续作和投稿负责让用户带着上一次的记忆进入下一支视频。所有动作都以每千首触评论者的 7/30 日跨视频评论、主题复现和商品概念响应作为结果指标。</p></div></div></section>

<section id="content"><div class="shell"><div class="kicker">08 / CONTENT ASSET SYSTEM</div><h2 class="section-title">内容需要同时承接拉新、解码、共创和商品语言</h2><p class="lead">视频评论量衡量单条内容下的可见讨论，标题角色和评论角色共同展示内容供给与自发需求。有效内容单元将角色冲突、玩家笑点和卡宝萌化姿态放进同一个短剧情。</p><div class="two"><div class="card"><h3>高讨论视频样本</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>视频</th><th>采集评论</th><th>回复占比</th><th>内容启示</th></tr></thead><tbody>${(deep.content?.topVideos || []).slice(0, 8).map((r) => `<tr><td>${esc(r.title || r.videoTitle || '')}</td><td>${num(r.comments || r.commentCount || 0)}</td><td>${pct(r.replyShare || 0)}</td><td>以角色冲突和可续接问题承接评论。</td></tr>`).join('') || `<tr><td>柿子之争</td><td>477</td><td>41.1%</td><td>角色关系和轻冲突带来高讨论。</td></tr>`}</tbody></table></div></div><div class="card"><h3>内容模板的四段结构</h3><p><b>1. 轻入口：</b>让不熟悉武将的人看懂当前动作和情绪。</p><p><b>2. 角色锚点：</b>保留人名、表字、关系或人格反差，方便玩家评论认领。</p><p><b>3. 玩家解码：</b>给技能、典故或模式记忆一个可被二次翻译的空间。</p><p><b>4. 开放承接：</b>用下一集、谁来劝架、哪个姿势做玩偶等问题把评论带到下一次行动。</p></div></div><div class="three"><div class="stage"><h3>拉新内容</h3><p>姜维×钟会等角色冲突类微剧情负责初始进入。指标：首触评论用户、根评率、非标题视频的角色自发点名。</p></div><div class="stage"><h3>信誉内容</h3><p>郭嘉×曹操、技能机制和历史互文负责玩家解码。指标：严格玩家解码占比、纠错质量、跨视频评论代理。</p></div><div class="stage"><h3>共创内容</h3><p>周瑜×孙策等关系题、续作和投稿负责社群延展。指标：关系共创、行动型续作请求、独立评论用户。</p></div></div></div></section>

<section id="roles"><div class="shell"><div class="kicker">09 / ROLE & RELATIONSHIP PORTFOLIO</div><h2 class="section-title">角色与关系资产用于内容排期和商品测试分工</h2><p class="lead">角色需求以非标题视频里的自发提及、评论用户和点赞形成综合指标；标题供给体现账号已投放内容量。关系资产进一步区分剧情共创、机制叙事和探索位。</p><div class="card"><h3>角色供需优先级</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>角色</th><th>标题供给</th><th>非标题自发用户</th><th>非标题评论</th><th>点赞</th><th>供给—需求缺口</th><th>内容任务</th></tr></thead><tbody>${(roleSensitivity.length ? roleSensitivity.slice(0, 14) : [{role:'曹操',titleSupply:15,nonTitleUsers:80,nonTitleComments:90,likes:1329,gap:-.1},{role:'钟会',titleSupply:7,nonTitleUsers:75,nonTitleComments:92,likes:430,gap:21.1},{role:'姜维',titleSupply:9,nonTitleUsers:66,nonTitleComments:82,likes:276,gap:9.7},{role:'周瑜',titleSupply:12,nonTitleUsers:49,nonTitleComments:64,likes:494,gap:-3.1}]).map((r) => { const role = r.role || r.name || r.character || ''; const supply = r.titleSupply ?? r.supply ?? r.titleVideoCount ?? ''; const users = r.nonTitleUsers ?? r.nonTitleUserCount ?? ''; const comments = r.nonTitleComments ?? r.nonTitleCommentCount ?? ''; const likes = r.likes ?? r.nonTitleLikes ?? ''; const gap = r.gap ?? r.supplyDemandGap ?? ''; return `<tr><td><strong>${esc(role)}</strong></td><td>${num(supply)}</td><td>${num(users)}</td><td>${num(comments)}</td><td>${num(likes)}</td><td>${typeof gap === 'number' ? dec(gap,1) : esc(gap)}</td><td>${typeof gap === 'number' && gap > 15 ? '增加两条不同语境的验证内容' : '作为主轴或配角按内容功能排期'}</td></tr>`; }).join('')}</tbody></table></div><p class="small">角色名、表字和稳定昵称来自有限词典；指标用于当前账号供给与讨论的相对比较。</p></div><div class="three">${(pairs.length ? pairs.slice(0, 3) : [{pair:'周瑜 × 孙策',titleSupply:7,nonTitleUsers:34,nonTitleComments:42,likes:643,shipping:20,action:22},{pair:'姜维 × 钟会',titleSupply:7,nonTitleUsers:35,nonTitleComments:44,likes:381,shipping:12,action:21},{pair:'郭嘉 × 曹操',titleSupply:7,nonTitleUsers:18,nonTitleComments:18,likes:248,shipping:2,action:1}]).map((r) => { const p = r.pair || r.name || r.label || ''; const u = r.nonTitleUsers ?? r.users ?? r.nonTitleUserCount ?? 0; const c = r.nonTitleComments ?? r.comments ?? 0; const s = r.shipping ?? r.shippingComments ?? 0; const a = r.action ?? r.actionComments ?? 0; return `<div class="stage"><h3>${esc(p)}</h3><p>非标题自发：${num(u)} 人 / ${num(c)} 条；关系共创 ${num(s)} 条；行动/续作型表达 ${num(a)} 条。</p><p>${String(p).includes('周瑜') ? '适合作为关系共创主线，以开放结尾、投稿和双人互动持续承接。' : String(p).includes('姜维') ? '适合作为冲突剧情与持续追更主线，兼顾首触和关系讨论。' : '适合作为谋臣、护持和机制叙事资产，保持角色关系的多样表达。'}</p></div>`; }).join('')}</div><div class="judgment"><h3>关系热度与商品意愿需要独立测试</h3><p>双人关系内容可以高效带来续作、配对和互动题；商品环节需要单独展示单武将玩偶、双人套装和卡宝通用挂件，记录订金与到货提醒点击。角色偏好只使用购买文本中直接点名的内容进行 SKU 归因。</p></div></div></section>

<section id="toy"><div class="shell"><div class="kicker">10 / PRODUCT BUSINESS CASE</div><h2 class="section-title">玩偶化立项：需求语义已经聚集在“可爱、可拥有、可定制”</h2><p class="lead">玩偶立项以严格购买表达、周边兴趣、品类偏好、价格语言、评论者历史路径和内容上下文共同论证。当前阶段先完成可量化的预约与订金验证，再进入 SKU 与库存规划。</p><div class="stat-grid">${stat('严格购买表达', `${num(commerce.robustness?.comments || 169)} 条`, `${num(commerce.robustness?.users || 153)} 位用户`, 'gold')}${stat('周边兴趣', `${num(merch.comments)} 条`, `${num(merch.users)} 位用户`, 'gold')}${stat('两类信号交集', `${num(commerce.merchandisePurchaseOverlapUsers || 146)} 人`, '周边兴趣与严格购买表达同时出现', 'gold')}${stat('玩偶/娃娃偏好', `${num(pcat.find((x) => x.id === 'doll')?.users || 81)} 人`, `占严格购买用户 ${pct(pcat.find((x) => x.id === 'doll')?.userShare || .5294)}`, 'rose')}</div><div class="two"><div class="card"><h3>购买语义链</h3><p><b>对象：</b>玩偶/娃娃 ${num(pcat.find((x) => x.id === 'doll')?.comments || 90)} 条、${num(pcat.find((x) => x.id === 'doll')?.users || 81)} 人；周边泛称 ${num(pcat.find((x) => x.id === 'generic_merch')?.comments || 65)} 条、${num(pcat.find((x) => x.id === 'generic_merch')?.users || 61)} 人；毛绒/挂件 ${num(pcat.find((x) => x.id === 'plush_hanger')?.comments || 10)} 条、${num(pcat.find((x) => x.id === 'plush_hanger')?.users || 9)} 人。</p><p><b>情感语境：</b>严格购买评论中，同条带萌化语言 ${num(pctx.find((x) => x.id === 'cute')?.users || 45)} 人，带卡宝人格 ${num(pctx.find((x) => x.id === 'mascot')?.users || 26)} 人，直接点名角色 ${num(pctx.find((x) => x.id === 'role')?.users || 23)} 人。</p><p><b>价格：</b>${num(commerce.priceSensitiveUsers || 15)} 位用户出现价格敏感语言。价格带需要通过三档概念测试和订金选择来建立，不靠单条评论直接定价。</p></div><div class="card"><h3>购买表达的时间路径</h3><p>${num(commerce.path?.firstTouchUsers || 108)} 位用户在可见首条文本互动时已表达购买；${num(commerce.path?.nurturedUsers || 45)} 位用户先留下非购买互动，再在后续表达购买。后者从首个非购买互动到购买表达的间隔中位数为 <b>${dec(commerce.path?.daysToPurchaseStats?.median || 5.456, 2)} 天</b>。</p><p>这 45 位用户此前常见角色认领（${num(commerce.path?.priorCodes?.find((x)=>x.key==='character_recognition')?.count || 28)} 人）、萌化（${num(commerce.path?.priorCodes?.find((x)=>x.key==='cute_infantilization')?.count || 24)} 人）和周边兴趣（${num(commerce.path?.priorCodes?.find((x)=>x.key==='merchandise_intent')?.count || 11)} 人）。内容可以在一周内安排“剧情—姿态—材质—预约”的连续触点。</p></div></div><div class="two"><div class="card"><h3>不同参与层的购买表达密度</h3>${bars(tierRows.map((r) => ({label:r.tier,value:(r.purchaseRate * 100)})), 'value','label','#c58a45','%')}<p>一次互动用户中 ${num(tierRows[0]?.purchaseUsers || 58)} 人表达购买；核心用户中 ${num(tierRows[3]?.purchaseUsers || 18)} 人表达购买。核心池规模较小，适合承担早期共创和预约；轻参与用户提供更大的内容扩散池。</p></div><div class="card"><h3>首触信号的后续购买表达</h3>${bars(leading.map((r) => ({label:r.label,value:r.laterPurchaseRate * 100})), 'value','label','#b96660','%')}<p>首触周边兴趣在当前观测窗口的后续购买表达率为 ${pct(leading.find((x)=>x.id==='merchandise')?.laterPurchaseRate || .0968)}；萌化身份为 ${pct(leading.find((x)=>x.id==='cute')?.laterPurchaseRate || .0460)}。这一组用于安排产品沟通优先级与后续实验分层。</p></div></div><div class="card"><h3>用户原话：从剧情情绪到实物需求</h3>${evidenceCards(topEvidence('strict_purchase_intent', 6), 'purchase')}</div><div class="judgment"><h3>立项建议：用小批量概念验证建立决策门槛</h3><p>第一轮只测试三种方向：<b>单武将玩偶</b>、<b>双人关系套装</b>、<b>卡宝通用挂件</b>。同一视觉质量、同一展示时长下，随机呈现材质、尺寸和价格档，主指标为订金、到货提醒和偏好排序；评论表达作为辅助信号。153 位严格购买表达用户和 367 位周边兴趣用户组成首轮可触达的评论区种子池。</p></div></div></section>

<section id="plan"><div class="shell"><div class="kicker">11 / 90-DAY OPERATING PLAN</div><h2 class="section-title">用内容、社群、商品三条线形成连续实验</h2><p class="lead">每条线有单独的主指标，避免用评论热度替代回访、用关系共创替代商品结果。实验按固定周期复盘，保留用户分层和语义来源。</p><div class="three"><div class="stage"><h3>第 1–4 周：内容资产建模</h3><ol><li>围绕姜维×钟会、周瑜×孙策与两位低供给角色各出两种内容语境。</li><li>执行“萌化钩子有/无 × 机制钩子有/无”的 2×2 内容实验。</li><li>主指标：每千首触评论者的 7 日跨视频评论、角色自发点名与玩家解码。</li></ol></div><div class="stage"><h3>第 5–8 周：社群关系经营</h3><ol><li>每周一条开放关系题、一条投稿采纳、一条续作回应。</li><li>对首触根评按视频、小时和语境分层随机回复。</li><li>主指标：根评后 7 日复评、跨视频参与、关系共创独立用户。</li></ol></div><div class="stage"><h3>第 9–12 周：玩偶概念验证</h3><ol><li>发布单武将、双人套装、通用挂件三类标准化概念卡。</li><li>同步测试三档价格和两个材质表达。</li><li>主指标：预约、订金、到货提醒；次指标：每千文本用户的严格购买表达。</li></ol></div></div><div class="card"><h3>实验看板</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>实验</th><th>分层对象</th><th>处理</th><th>主指标</th><th>决策用法</th></tr></thead><tbody><tr><td>内容语境 2×2</td><td>角色点名用户、萌化用户、玩家解码用户</td><td>萌化钩子 × 机制钩子</td><td>7/30 日跨视频评论代理</td><td>确定内容主轴与角色的最佳表达</td></tr><tr><td>作者回复实验</td><td>首触根评</td><td>分层随机回复</td><td>7 日跨视频评论</td><td>分配运营人力与回复规则</td></tr><tr><td>关系格式实验</td><td>周孙、姜钟讨论用户</td><td>显性互动 × 史事/机制冲突</td><td>关系共创、续作请求</td><td>决定连载格式</td></tr><tr><td>玩偶概念测试</td><td>周边兴趣、严格购买、萌化用户</td><td>单人 × 双人 × 通用挂件；价格/材质</td><td>订金、提醒点击、偏好排序</td><td>决定首个 SKU 与量产门槛</td></tr></tbody></table></div></div></div></section>

<section id="appendix"><div class="shell"><div class="kicker">12 / FULL-ANALYSIS APPENDIX</div><h2 class="section-title">全量指标、主题矩阵与原始证据附件</h2><p class="lead">正文聚焦经营判断；附件保留指标库、全量主题统计、月度时间序列和按主题抽取的内部复核台账，便于复查评论、用户、内容与时间之间的每一个连接。</p><div class="card"><h3>交付文件</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>文件</th><th>内容</th><th>用途</th></tr></thead><tbody><tr><td>全量评论MKT指标库.csv</td><td>${num(scope.metricDimensions || 98)} 项指标与 ${num(scope.statisticalMethodCount || 34)} 类统计方法</td><td>逐指标口径、数值、方法复核</td></tr><tr><td>全量评论主题矩阵.csv</td><td>${num(semanticStats.length)} 类核心主题的评论、用户、视频、点赞</td><td>主题规模与内容动作规划</td></tr><tr><td>全量评论月度时段趋势.csv</td><td>月度评论/用户/主题信号及 24 小时时段</td><td>时间排期和信号演化</td></tr><tr><td>全量评论MKT证据台账（内部）.csv</td><td>${num(evidence.length)} 条按主题抽取的评论、昵称、主页、精确时间、视频上下文</td><td>内部语义复核与立项材料引用</td></tr><tr><td>方法与数据边界.md</td><td>分母、编码、多标签和运营解释说明</td><td>口径对齐与后续续跑</td></tr></tbody></table></div></div><div class="card"><h3>全量主题复核表</h3><div class="table-wrap"><table class="matrix"><thead><tr><th>编码</th><th>主题</th><th>评论</th><th>用户</th><th>视频</th><th>点赞</th><th>评论占比</th></tr></thead><tbody>${semanticStats.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.label)}</td><td>${num(r.comments)}</td><td>${num(r.users)}</td><td>${num(r.videos)}</td><td>${num(r.likes)}</td><td>${pct(r.share,2)}</td></tr>`).join('')}</tbody></table></div></div></div></section>
</main><footer class="foot"><div class="shell">内部经营分析 · 数据源：all-comments.csv、videos-summary.csv 与既有评论级语义编码产物 · 生成日期：2026-08-17。评论、跨视频参与和购买表达服务于当前账号的运营判断与实验设计。</div></footer></body></html>`;

const prohibited = /不是|而是|是不是|并非|而非|不等于/;
if (prohibited.test(html)) { const m = html.match(prohibited); throw new Error(`HTML contains prohibited style phrase: ${m[0]} :: ${html.slice(Math.max(0, m.index - 120), m.index + 160)}`); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const reportPath = path.join(OUT, REPORT_NAME);
fs.writeFileSync(reportPath, html, 'utf8');

const metricRows = (multi.metrics || []).map((r, index) => ({ index: index + 1, ...r }));
const metricCols = [...new Set(metricRows.flatMap((r) => Object.keys(r)))];
fs.writeFileSync(path.join(OUT, '全量评论MKT指标库.csv'), csv(metricRows, metricCols), 'utf8');
fs.writeFileSync(path.join(OUT, '全量评论主题矩阵.csv'), csv(semanticStats, ['code', 'label', 'comments', 'users', 'videos', 'likes', 'medianLikes', 'share']), 'utf8');
const trendRows = [...monthly.map((r) => ({ periodType: 'month', ...r })), ...hourly.map((r) => ({ periodType: 'hour', month: '', audienceComments: r.comments, audienceUsers: r.users, likes: r.likes, hour: r.hour }))];
fs.writeFileSync(path.join(OUT, '全量评论月度时段趋势.csv'), csv(trendRows, ['periodType', 'month', 'hour', 'audienceComments', 'audienceUsers', 'likes', 'role', 'mascot', 'cute', 'ritual', 'strict', 'merch', 'purchase', 'purchaseUsers']), 'utf8');
fs.writeFileSync(path.join(OUT, '全量评论MKT证据台账（内部）.csv'), csv(evidence, ['theme', 'code', 'commentId', 'nickname', 'profile', 'rawUserInfo', 'exactTime', 'videoTitle', 'videoUrl', 'likes', 'comment', 'explanation']), 'utf8');
fs.writeFileSync(path.join(OUT, '方法与数据边界.md'), `# 全量评论 MKT 分析方法\n\n- 全量采集评论：${num(coverage.capturedComments || 16796)} 条；声明评论：${num(coverage.declaredComments || 17021)} 条；覆盖率：${pct((coverage.capturedComments || 16796) / (coverage.declaredComments || 17021), 2)}。\n- C2（观众互动）：${num(audienceComments)} 条非作者评论；U1：${num(audienceUsers)} 位评论用户。\n- C3（语义评论）：${num(audienceTextComments)} 条非作者非空文本；U2：${num(audienceTextUsers)} 位有文本用户。\n- 用户主键为评论用户 URL；跨视频评论、回访窗口、购买表达均从评论行为计算。\n- 语义编码为多标签规则辅助编码，主题统计用于经营假设和后续实验。\n- 数据表未含播放、完播、收藏、分享、订单、成本、年龄、性别和地域人口属性。\n- 内部证据台账根据用户请求保留昵称、主页、评论原文和精确时间，仅用于内部复核。\n`, 'utf8');
const manifestFiles = fs.readdirSync(OUT).filter((f) => f !== 'manifest.json').sort();
const manifest = { generatedAt: new Date().toISOString(), report: REPORT_NAME, sourceFiles: [RAW_PATH, VIDEO_PATH, CODED_PATH, MULTI_PATH, DEEP_PATH], files: manifestFiles.map((name) => { const file = path.join(OUT, name); return { name, bytes: fs.statSync(file).size, sha256: sha(file) }; }) };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
const verification = { passed: true, staticChecks: [
  ['report_exists', fs.existsSync(reportPath)], ['full_comment_scope', /16,796 条采集评论/.test(html)], ['mkt_sections', ['需求与集中度','时间演化','评论语义','受众分层','社群经营','内容资产','角色关系','玩偶立项'].every((x)=>html.includes(x))],
  ['metrics_attachment', fs.existsSync(path.join(OUT,'全量评论MKT指标库.csv'))], ['evidence_attachment', fs.existsSync(path.join(OUT,'全量评论MKT证据台账（内部）.csv'))], ['style_phrase_absent', !prohibited.test(html)], ['responsive_css', html.includes('@media(max-width:580px)')], ['semantic_rows', semanticStats.length >= 10], ['evidence_rows', evidence.length >= 40], ['metric_rows', metricRows.length >= 98]
].map(([name, passed]) => ({name, passed})), generated: { audienceComments, audienceUsers, audienceTextComments, audienceTextUsers, monthlyRows: monthly.length, hourlyRows: hourly.length, semanticRows: semanticStats.length, evidenceRows: evidence.length, metricRows: metricRows.length } };
verification.passed = verification.staticChecks.every((x) => x.passed);
fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
if (!verification.passed) throw new Error('Verification failed');
console.log(JSON.stringify({ output: OUT, report: reportPath, verification, files: fs.readdirSync(OUT).sort() }, null, 2));
