import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'output/wuhu-mkt-deep-analysis-20260814');
const ANALYSIS_PATH = path.join(OUT_DIR, 'wuhu-mkt-deep-analysis.json');
const REPORT_PATH = path.join(OUT_DIR, '三国杀WUHU联盟卡宝粉丝与受众MKT深度洞察报告.html');
const METHOD_PATH = path.join(OUT_DIR, '深度MKT分析口径与复算说明.md');

const data = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));

const nf = new Intl.NumberFormat('zh-CN');
const n1 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value) => nf.format(Number(value || 0));
const dec = (value, digits = 1) => (digits === 2 ? n2 : n1).format(Number(value || 0));
const pct = (value, digits = 1) => `${dec(Number(value || 0) * 100, digits)}%`;
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
const slug = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');

function metric(label, value, note = '', tone = '') {
  return `<div class="metric ${tone}"><div class="metric-value">${value}</div><div class="metric-label">${esc(label)}</div>${note ? `<div class="metric-note">${note}</div>` : ''}</div>`;
}

function callout(title, body, tone = 'neutral', badge = '') {
  return `<div class="callout ${tone}">${badge ? `<span class="evidence-badge">${esc(badge)}</span>` : ''}<h3>${title}</h3><p>${body}</p></div>`;
}

function barRows(rows, { valueKey = 'value', maxValue, valueFormat = (v) => fmt(v), color = 'blue', labelKey = 'label', note = () => '' } = {}) {
  const max = maxValue ?? Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1);
  return `<div class="bar-list">${rows.map((row) => {
    const value = Number(row[valueKey] || 0);
    const width = Math.max(value > 0 ? 2 : 0, Math.min(100, value / max * 100));
    return `<div class="bar-row">
      <div class="bar-head"><span>${esc(row[labelKey])}</span><strong>${valueFormat(value, row)}</strong></div>
      <div class="bar-track"><span class="bar-fill ${color}" style="width:${width.toFixed(2)}%"></span></div>
      ${note(row) ? `<div class="bar-note">${note(row)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function stackedBar(items) {
  return `<div class="stacked-bar" role="img" aria-label="受众生命周期互斥分层">${items.map((item, index) => `<span class="stack c${index}" style="width:${(item.userShare * 100).toFixed(4)}%" title="${esc(item.segment)}：${fmt(item.users)}人，${pct(item.userShare, 2)}"></span>`).join('')}</div>
  <div class="stack-legend">${items.map((item, index) => `<span><i class="c${index}"></i>${esc(item.segment)} <strong>${pct(item.userShare)}</strong></span>`).join('')}</div>`;
}

function scatterSvg(points, options = {}) {
  const width = options.width || 820;
  const height = options.height || 510;
  const pad = { left: 64, right: 32, top: 32, bottom: 58 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const xMax = options.xMax || Math.max(...points.map((p) => Number(p.x || 0)), 100);
  const yMax = options.yMax || Math.max(...points.map((p) => Number(p.y || 0)), 100);
  const xMedian = Number(options.xMedian ?? 0);
  const yMedian = Number(options.yMedian ?? 0);
  const sx = (x) => pad.left + Math.max(0, Math.min(xMax, Number(x || 0))) / xMax * innerW;
  const sy = (y) => pad.top + innerH - Math.max(0, Math.min(yMax, Number(y || 0))) / yMax * innerH;
  const grid = [0, .25, .5, .75, 1].map((t) => {
    const x = pad.left + t * innerW;
    const y = pad.top + (1 - t) * innerH;
    return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${pad.top + innerH}" class="grid"/><line x1="${pad.left}" y1="${y}" x2="${pad.left + innerW}" y2="${y}" class="grid"/><text x="${x}" y="${height - 32}" class="tick" text-anchor="middle">${dec(t * xMax, 0)}</text><text x="${pad.left - 12}" y="${y + 4}" class="tick" text-anchor="end">${dec(t * yMax, 0)}</text>`;
  }).join('');
  const medianLines = `${xMedian ? `<line x1="${sx(xMedian)}" y1="${pad.top}" x2="${sx(xMedian)}" y2="${pad.top + innerH}" class="median"/>` : ''}${yMedian ? `<line x1="${pad.left}" y1="${sy(yMedian)}" x2="${pad.left + innerW}" y2="${sy(yMedian)}" class="median"/>` : ''}`;
  const dots = points.map((point) => {
    const r = Math.max(4, Math.min(13, Number(point.r || 6)));
    const dotClass = esc(point.className || 'dot');
    return `<g class="scatter-point"><circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="${r}" class="${dotClass}"><title>${esc(point.tooltip || `${point.label}：${point.x}, ${point.y}`)}</title></circle>${point.showLabel ? `<text x="${sx(point.x) + r + 3}" y="${sy(point.y) - r - 1}" class="point-label">${esc(clip(point.label, 12))}</text>` : ''}</g>`;
  }).join('');
  return `<div class="chart-scroll"><svg class="scatter" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.ariaLabel || '散点图')}">
    <rect x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" class="plot-bg"/>${grid}${medianLines}${dots}
    <text x="${pad.left + innerW / 2}" y="${height - 6}" class="axis-label" text-anchor="middle">${esc(options.xLabel || 'X')}</text>
    <text x="17" y="${pad.top + innerH / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 17 ${pad.top + innerH / 2})">${esc(options.yLabel || 'Y')}</text>
  </svg></div>`;
}

function evidenceTable(rows, columns, className = '') {
  return `<div class="table-wrap ${className}"><table><thead><tr>${columns.map((column) => `<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td class="${esc(column.className || '')}">${column.render ? column.render(row) : esc(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function quoteBlock(quote) {
  return `<blockquote><p>“${esc(quote.text)}”</p><footer>匿名评论样本 · ${fmt(quote.likes)} 赞 · ${esc(clip(quote.videoTitle, 36))}</footer></blockquote>`;
}

function ordinal(index) {
  return String(index + 1).padStart(2, '0');
}

function quadrantClass(label) {
  return ({
    '双引擎': 'q-both',
    '拉新型': 'q-acquisition',
    '承接型': 'q-retention',
    '长尾型': 'q-tail',
    '高标题供给 × 高非标题点名代理': 'q-both',
    '低标题供给 × 高非标题点名代理': 'q-acquisition',
    '高标题供给 × 低非标题点名代理': 'q-retention',
    '低标题供给 × 低非标题点名代理': 'q-tail',
  })[label] || 'q-default';
}

function roleQuadrantLabel(label) {
  return label;
}

function relationshipQuadrantLabel(label) {
  return label;
}

const coverage = data.coverage;
const lifecycle = data.lifecycle;
const textUsers = coverage.audienceTextUsers;
const allAudienceUsers = lifecycle.audienceUsers;
const strictCute = data.tribes.strictCuteCells;
const depth = data.tribes.contextDepthSegments;
const roles = data.roles.sensitivity;
const pairs = data.roles.pairs;
const videos = data.content.videos;
const meaningThemes = data.grounded.meaningSystem;
const replyAssociation = data.community.authorReplyAssociation[0];
const lifecycleSegments = lifecycle.observedLifecycleSegments;
const crossVideoAll = lifecycleSegments.filter((row) => row.segment.startsWith('跨视频')).reduce((sum, row) => sum + row.users, 0);
const stableCrossVideo = lifecycleSegments.filter((row) => row.segment.includes('8-30') || row.segment.includes('30天以上')).reduce((sum, row) => sum + row.users, 0);
const highHighRoles = roles.filter((role) => role.quadrant === '高标题供给 × 高非标题点名代理').sort((a, b) => b.nonTitleMentionIndex - a.nonTitleMentionIndex);
const gapRoles = roles.filter((role) => role.quadrant === '低标题供给 × 高非标题点名代理').sort((a, b) => b.relativeOpportunityIndex - a.relativeOpportunityIndex);
const acquisitionTop = [...videos].sort((a, b) => b.firstTouchUsers - a.firstTouchUsers).slice(0, 12);
const retentionTop = [...videos].filter((video) => video.audienceUsers >= 40).sort((a, b) => b.returningShare - a.returningShare).slice(0, 12);
const topVideos = [...videos].sort((a, b) => (b.firstTouchUsers + b.returningUsers) - (a.firstTouchUsers + a.returningUsers)).slice(0, 24);
const videoPoints = videos.map((video) => ({
  x: video.firstTouchUsers,
  y: video.returningUsers,
  r: 4 + Math.sqrt(video.audienceUsers || 0) / 5,
  label: video.title,
  tooltip: `${video.title}\n首次出现用户 ${video.firstTouchUsers}\n已在此前视频出现 ${video.returningUsers}\n象限 ${video.quadrant}`,
  className: `dot ${quadrantClass(video.quadrant)}`,
  showLabel: acquisitionTop.slice(0, 5).some((item) => item.id === video.id) || retentionTop.slice(0, 4).some((item) => item.id === video.id),
}));
const rolePoints = roles.map((role) => ({
  x: role.titleSupplyIndex,
  y: role.nonTitleMentionIndex,
  r: 4 + Math.sqrt(role.nonTitleMentionUsers || 0),
  label: role.label.split(' / ')[0],
  tooltip: `${role.label}\n标题供给指数 ${dec(role.titleSupplyIndex)}\n非标题点名代理指数 ${dec(role.nonTitleMentionIndex)}\n非标题点名代理 ${role.nonTitleMentionUsers}人/${role.nonTitleMentionComments}评\n${roleQuadrantLabel(role.quadrant)}`,
  className: `dot ${quadrantClass(role.quadrant)}`,
  showLabel: highHighRoles.slice(0, 8).includes(role) || gapRoles.slice(0, 8).includes(role),
}));

const lifecycleRows = lifecycleSegments.map((row) => ({ ...row, label: row.segment }));
const depthRows = depth.map((row) => ({ ...row, label: `${row.id} ${row.label}` }));
const categoryRows = data.commerce.purchaseCategories.filter((row) => row.users > 0);

const managementTheses = [
  {
    title: '玩家语境与回访相关，萌化身份与商品表达共现',
    body: `仅玩家解码人群的30日跨视频回访代理为 <strong>${pct(strictCute.find((row) => row.id === 'strict_only').return30Rate)}</strong>，仅萌化人群的严格购买表达率为 <strong>${pct(strictCute.find((row) => row.id === 'cute_only').purchaseRate)}</strong>。这是自选择评论样本中的分群差异，不代表语境或萌化造成对应行为。`,
    grade: 'A级：用户级全量观察',
  },
  {
    title: '混合核是账号最值得经营的粉丝资产',
    body: `玩家解码×萌化共 <strong>${fmt(strictCute.find((row) => row.id === 'both').users)} 人</strong>，仅占文本用户 ${pct(strictCute.find((row) => row.id === 'both').userShare)}，但跨视频率达 <strong>${pct(strictCute.find((row) => row.id === 'both').crossVideoRate)}</strong>，30日回访代理 ${pct(strictCute.find((row) => row.id === 'both').return30Rate)}。`,
    grade: 'A级：互斥分群',
  },
  {
    title: '视频组合呈现“首次出现代理×既有参与代理”的任务差异',
    body: `107条视频中，<strong>${data.content.quadrants.find((row) => row.quadrant === '双引擎').videos}条</strong>同时高于首次出现用户中位数 ${fmt(data.content.acquisitionMedian)} 和此前已出现用户中位数 ${fmt(data.content.retentionMedian)}；该组合只描述评论样本结构，不等于平台获客或留存效果。`,
    grade: 'A级：视频组合观察',
  },
  {
    title: '周边需求已可验证，销量仍不可外推',
    body: `严格购买表达 <strong>${fmt(data.commerce.robustness.users)}人/${fmt(data.commerce.robustness.comments)}评</strong>；移除点赞最高3条后仍有 ${fmt(data.commerce.robustness.afterRemovingTop3.users)} 人，但没有曝光、点击、预约或支付分母，现阶段只能称需求信号。`,
    grade: 'B级：表达证据',
  },
];

const deepSections = [
  ['01', '管理结论', '把评论转成可执行的受众经营判断'],
  ['02', '证据边界', '分母、观测窗口与推断等级'],
  ['03', '生命周期', '从一次评论到跨视频稳定参与'],
  ['04', '入口与迁移', '内容、仪式与兴趣递进的真实关系'],
  ['05', '意义系统', '玩家如何共同解码、再叙事与占有'],
  ['06', '粉丝部落', '语境深度、混合核与人群价值分工'],
  ['07', '内容组合', '拉新、承接、双引擎与长尾任务'],
  ['08', '角色资产', '标题供给与非标题点名代理的相对位置'],
  ['09', '关系资产', 'CP共创、君臣信誉与探索样本分开经营'],
  ['10', '社群机制', '线程、入口与作者回复的实验机会'],
  ['11', '商品证据', '意向强度、品类、培育路径与鲁棒性'],
  ['12', '90天实验', '把相关性升级为经营因果'],
  ['13', '指标体系', '周报看板、复算规则与限制'],
];

const reportHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>三国杀WUHU联盟卡宝粉丝与受众MKT深度洞察报告</title>
<style>
:root{--paper:#f5f4ef;--surface:#fff;--ink:#2f3433;--muted:#68706d;--line:#d8d9d3;--deep:#445755;--blue:#648795;--blue-soft:#e9f0f2;--green:#718f78;--green-soft:#ebf1ec;--amber:#aa7a43;--amber-soft:#f6eee4;--red:#a35f56;--red-soft:#f5e9e7;--violet:#77708e;--violet-soft:#eeecf3;--radius:7px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif;line-height:1.72;letter-spacing:0}a{color:#476f7e;text-decoration-thickness:1px;text-underline-offset:3px}strong{color:#28312f}.page{max-width:1180px;margin:0 auto;padding:24px 22px 80px}.cover{min-height:650px;background:var(--deep);color:#f7f7f3;padding:64px 64px 48px;border-radius:var(--radius);display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}.cover:after{content:"";position:absolute;right:-90px;bottom:-140px;width:380px;height:380px;border:1px solid rgba(255,255,255,.14);transform:rotate(19deg)}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:#bcd0cd}.cover h1{font-size:48px;line-height:1.18;max-width:850px;margin:20px 0 18px;letter-spacing:0}.cover .deck{font-size:20px;max-width:820px;color:#dde7e4;margin:0}.cover-thesis{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:44px;position:relative;z-index:1}.cover-thesis div{border-top:1px solid rgba(255,255,255,.28);padding-top:14px}.cover-thesis strong{display:block;color:#fff;font-size:18px;margin-bottom:4px}.cover-thesis span{font-size:13px;color:#d4dfdc}.cover-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:34px;position:relative;z-index:1}.cover-meta span{border:1px solid rgba(255,255,255,.23);padding:6px 10px;font-size:12px;color:#eaf0ee}.next-hint{font-size:12px;color:#bfcdca;margin-top:32px}.report-nav{position:sticky;top:0;z-index:20;display:flex;gap:4px;overflow-x:auto;background:rgba(245,244,239,.96);backdrop-filter:blur(8px);padding:10px 0;margin:16px 0 10px;border-bottom:1px solid var(--line);scrollbar-width:thin}.report-nav a{flex:0 0 auto;text-decoration:none;font-size:12px;color:var(--muted);padding:6px 9px;border-radius:4px}.report-nav a:hover{background:var(--blue-soft);color:var(--ink)}.part-head{margin:48px 0 16px;padding:0 0 12px;border-bottom:1px solid var(--line);display:flex;align-items:flex-end;gap:18px}.part-no{font-size:13px;font-weight:800;color:var(--blue)}.part-head h2{font-size:29px;line-height:1.22;margin:0;letter-spacing:0}.part-head p{margin:0 0 2px;color:var(--muted);font-size:13px}.section{background:var(--surface);padding:34px 38px;margin-bottom:18px;border-radius:var(--radius);border:1px solid #e6e6e1}.section h3{font-size:21px;line-height:1.35;margin:0 0 10px}.section h4{font-size:16px;margin:24px 0 8px}.lead{font-size:18px;line-height:1.75;max-width:920px;margin:0 0 24px}.muted{color:var(--muted)}.tiny{font-size:11px;color:var(--muted)}.note{font-size:12px;color:var(--muted);margin-top:12px}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}.metric{background:#f7f7f4;padding:17px 16px;border-top:3px solid #c7cbc7;min-height:118px}.metric.blue{border-top-color:var(--blue)}.metric.green{border-top-color:var(--green)}.metric.amber{border-top-color:var(--amber)}.metric.red{border-top-color:var(--red)}.metric-value{font-size:27px;line-height:1.1;font-weight:750;color:#385c67}.metric-label{font-size:12px;font-weight:700;margin-top:8px}.metric-note{font-size:11px;color:var(--muted);margin-top:4px}.thesis-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.callout{position:relative;border-left:4px solid #b9beb9;background:#f8f8f5;padding:20px 20px 18px;min-height:150px}.callout.success{border-left-color:var(--green);background:var(--green-soft)}.callout.opportunity{border-left-color:var(--amber);background:var(--amber-soft)}.callout.risk{border-left-color:var(--red);background:var(--red-soft)}.callout.info{border-left-color:var(--blue);background:var(--blue-soft)}.callout h3{font-size:17px;margin:0 0 7px}.callout p{margin:0;font-size:14px}.evidence-badge{display:inline-block;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:8px}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px}.three-col{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.bar-list{display:grid;gap:15px}.bar-head{display:flex;justify-content:space-between;gap:12px;font-size:13px}.bar-head strong{white-space:nowrap}.bar-track{height:9px;background:#e9ebe7;overflow:hidden}.bar-fill{height:100%;display:block;background:var(--blue)}.bar-fill.green{background:var(--green)}.bar-fill.amber{background:var(--amber)}.bar-fill.red{background:var(--red)}.bar-note{font-size:11px;color:var(--muted);margin-top:3px}.stacked-bar{display:flex;height:34px;overflow:hidden;background:#ecece8;margin:22px 0 10px}.stack{display:block;height:100%;min-width:1px}.c0{background:#b9c4c2}.c1{background:#89a4aa}.c2{background:#d2b07b}.c3{background:#8da888}.c4{background:#738fa0}.c5{background:#7c708d}.stack-legend{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px}.stack-legend span{font-size:11px;color:var(--muted)}.stack-legend i{display:inline-block;width:9px;height:9px;margin-right:6px}.chart-scroll{overflow-x:auto;border:1px solid #e4e5e0;background:#fbfbf9;padding:8px}.scatter{width:100%;min-width:720px;display:block}.plot-bg{fill:#fbfbf9}.grid{stroke:#e2e4df;stroke-width:1}.median{stroke:#9b9f9b;stroke-width:1.2;stroke-dasharray:5 5}.tick{fill:#818783;font-size:10px}.axis-label{fill:#545b58;font-size:12px;font-weight:700}.point-label{fill:#3c4542;font-size:10px;font-weight:650;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}.dot{fill:#698b96;fill-opacity:.72;stroke:#fff;stroke-width:1}.dot.高供给---高自发需求,.dot.双引擎{fill:#688a70}.dot.低供给---高自发需求,.dot.拉新型{fill:#ad7e44}.dot.高供给---低自发需求,.dot.承接型{fill:#77708f}.dot.低供给---低自发需求,.dot.长尾型{fill:#9da5a2}.table-wrap{overflow-x:auto;border:1px solid #e0e1dc}.table-wrap table{width:100%;border-collapse:collapse;min-width:760px;font-size:12px}.table-wrap th{position:sticky;top:0;background:#f0f1ed;color:#4d5552;text-align:left;padding:10px 11px;white-space:nowrap}.table-wrap td{padding:10px 11px;border-top:1px solid #ecece8;vertical-align:top}.table-wrap tr:hover td{background:#fafaf7}.num{text-align:right;font-variant-numeric:tabular-nums}.tag{display:inline-block;padding:2px 7px;background:#ecefea;color:#53605b;font-size:10px;white-space:nowrap}.tag.high{background:var(--green-soft);color:#526d58}.tag.gap{background:var(--amber-soft);color:#865f35}.tag.explore{background:var(--violet-soft);color:#625a78}.quote-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}blockquote{margin:0;background:#f7f7f4;border-left:3px solid #aab5b1;padding:16px 18px}blockquote p{margin:0;font-size:14px}blockquote footer{font-size:10px;color:var(--muted);margin-top:8px}.funnel-note{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}.funnel-note>div{background:#fff;padding:18px}.funnel-note strong{display:block;font-size:24px;color:#446a76}.warning-strip{border:1px solid #e3c9ae;background:#fbf5ee;padding:14px 17px;font-size:13px;color:#71583e}.decision-list{counter-reset:decision;display:grid;gap:13px}.decision{counter-increment:decision;display:grid;grid-template-columns:46px 1fr;gap:13px;padding:15px 0;border-bottom:1px solid #e7e7e2}.decision:before{content:counter(decision,decimal-leading-zero);font-size:19px;color:var(--blue);font-weight:800}.decision h4{margin:0 0 4px;font-size:15px}.decision p{margin:0;font-size:13px;color:#4d5552}.experiment-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.experiment{border:1px solid var(--line);padding:20px;background:#fff}.experiment .exp-no{font-size:11px;color:var(--blue);font-weight:800}.experiment h3{font-size:18px;margin:6px 0 8px}.experiment dl{display:grid;grid-template-columns:88px 1fr;gap:5px 10px;font-size:12px;margin:12px 0 0}.experiment dt{color:var(--muted)}.experiment dd{margin:0}.kpi-tree{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}.kpi-tree>div{background:#fff;padding:18px}.kpi-tree h4{margin:0 0 8px;font-size:14px}.kpi-tree ul{padding-left:17px;margin:0;font-size:12px}.method-list{display:grid;gap:9px}.method-list div{display:grid;grid-template-columns:150px 1fr;gap:18px;padding:9px 0;border-bottom:1px solid #ecece8;font-size:12px}.method-list strong{font-size:12px}.footer{padding:34px 0 10px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:20px}.print-only{display:none}
@media(max-width:820px){.page{padding:0 12px 50px}.cover{min-height:690px;padding:40px 28px}.cover h1{font-size:36px}.cover .deck{font-size:17px}.cover-thesis{grid-template-columns:1fr}.cover-thesis div:nth-child(3){display:none}.part-head{align-items:flex-start;flex-wrap:wrap}.part-head h2{font-size:25px}.section{padding:26px 22px}.metric-grid{grid-template-columns:repeat(2,1fr)}.thesis-grid,.two-col,.three-col,.quote-grid,.experiment-grid{grid-template-columns:1fr}.stack-legend{grid-template-columns:repeat(2,1fr)}.funnel-note{grid-template-columns:1fr}.kpi-tree{grid-template-columns:repeat(2,1fr)}.method-list div{grid-template-columns:1fr;gap:2px}.scatter{width:760px}.footer{display:block}}
@media(max-width:420px){.page{padding:0 8px 40px}.cover{min-height:710px;padding:34px 22px;border-radius:0}.cover h1{font-size:31px}.cover .deck{font-size:15px}.cover-meta{gap:6px}.cover-meta span{font-size:10px}.section{padding:23px 17px}.metric-grid{gap:6px}.metric{padding:14px 12px;min-height:110px}.metric-value{font-size:23px}.kpi-tree{grid-template-columns:1fr}.stack-legend{grid-template-columns:1fr}.part-head{margin-top:38px}.report-nav{margin-top:8px}.lead{font-size:16px}.experiment dl{grid-template-columns:1fr}.experiment dd{margin-bottom:5px}}
@media print{body{background:#fff}.page{max-width:none;padding:0}.report-nav{display:none}.section{break-inside:avoid;border-color:#ddd}.cover{min-height:700px}.print-only{display:block}}
.dot.q-both{fill:#688a70}.dot.q-acquisition{fill:#ad7e44}.dot.q-retention{fill:#77708f}.dot.q-tail{fill:#9da5a2}
.two-col>*,.three-col>*,.thesis-grid>*,.experiment-grid>*{min-width:0}.table-wrap,.chart-scroll{max-width:100%}
</style>
</head>
<body>
<main class="page">
  <header class="cover" id="top">
    <div>
      <div class="eyebrow">MKT DEEP DIVE · FULL CORPUS · 2026.08.14</div>
      <h1>三国杀WUHU联盟卡宝<br>粉丝与受众MKT深度洞察报告</h1>
      <p class="deck">不是“评论说了什么”的摘要，而是回答：谁被吸引、谁持续参与、什么内容承担拉新或承接、玩家语境如何形成粉丝资产，以及商品化应先验证哪一层需求。</p>
      <div class="cover-thesis">
        <div><strong>深语境关联更高复访</strong><span>L0→L4 的样本内跨视频参与从 ${pct(depth[0].crossVideoRate)} 单调升至 ${pct(depth[4].crossVideoRate)}</span></div>
        <div><strong>萌化关联更多购意</strong><span>仅萌化身份人群购买表达率 ${pct(strictCute.find((row) => row.id === 'cute_only').purchaseRate)}，高于仅玩家解码</span></div>
        <div><strong>混合核呈现双高参与</strong><span>${fmt(strictCute.find((row) => row.id === 'both').users)} 位玩家粉丝混合核，样本内跨视频参与为 ${pct(strictCute.find((row) => row.id === 'both').crossVideoRate)}</span></div>
      </div>
    </div>
    <div>
      <div class="cover-meta"><span>107 条视频</span><span>${fmt(coverage.capturedComments)} 条实采评论</span><span>${fmt(allAudienceUsers)} 位观众评论者</span><span>${fmt(textUsers)} 位有文本观众</span><span>采集覆盖 ${pct(coverage.capturedComments / coverage.declaredComments, 2)}</span></div>
      <div class="next-hint">向下阅读：先看管理结论，再进入可复算的证据链与90天实验计划</div>
    </div>
  </header>

  <nav class="report-nav" aria-label="报告章节">${deepSections.map(([no, title]) => `<a href="#part-${no}">${no} ${esc(title)}</a>`).join('')}</nav>

  <div class="part-head" id="part-01"><span class="part-no">01</span><h2>管理结论</h2><p>把评论转成可执行的受众经营判断</p></div>
  <section class="section">
    <p class="lead"><strong>核心判断：</strong>卡宝评论生态不是“萌”或“三国杀知识”二选一。样本中，角色识别、玩家解码、关系再叙事与可拥有的萌化对象构成一套共同参与语法；语境越深与更高重复参与相关，萌化身份与更多商品表达共现，二者交叉人群呈现最高的样本内跨视频参与。</p>
    <div class="thesis-grid">${managementTheses.map((item, index) => callout(item.title, item.body, ['success', 'info', 'opportunity', 'risk'][index], item.grade)).join('')}</div>
    <h4>此刻最应做的四个动作</h4>
    <div class="decision-list">
      <div class="decision"><div><h4>按“首次出现代理 / 既有参与代理 / 双高”编排内容，不再用单条评论数评价所有视频</h4><p>分别观察首次出现在样本中的评论者与此前已出现的评论者；先把它们作为视频任务代理，再用完整曝光数据验证真实获客与留存。</p></div></div>
      <div class="decision"><div><h4>把“玩家解码×萌化”设为核心经营人群，把纯to签单列为活动人群</h4><p>两者行为质量不同。仪式可放大已有关系，却不足以证明自然粉丝认同或商品需求。</p></div></div>
      <div class="decision"><div><h4>角色增供先小样验证曹冲、张飞、关羽、于吉；关系主线聚焦周瑜×孙策、姜维×钟会</h4><p>前者仅表现为“低标题供给、高非标题点名代理”，仍可能受画面、对白或剧情曝光驱动；后者已观察到关系共创与跨视频参与，曹操×郭嘉更适合玩家信誉而非CP商品路线。</p></div></div>
      <div class="decision"><div><h4>商品化先做可点击/可预约概念测试，不用评论量直接估销量</h4><p>以单武将玩偶、卡宝通用挂件、双人关系套装三个概念对照；价格另做分层测试。</p></div></div>
    </div>
  </section>

  <div class="part-head" id="part-02"><span class="part-no">02</span><h2>证据边界</h2><p>分母、观测窗口与推断等级</p></div>
  <section class="section">
    <div class="metric-grid">
      ${metric('实采评论', fmt(coverage.capturedComments), `声明 ${fmt(coverage.declaredComments)} 条 · 覆盖 ${pct(coverage.capturedComments / coverage.declaredComments, 2)}`, 'blue')}
      ${metric('观众评论', fmt(coverage.audienceCommentsWithDate), '已排除作者评论 · 生命周期主分母', 'green')}
      ${metric('有文本观众', fmt(textUsers), `${fmt(coverage.audienceTextComments)} 条非空观众文本 · 语义主分母`, 'amber')}
      ${metric('视频样本', fmt(videos.length), '仅17条有可靠发布时间，不做全量时序因果', 'red')}
    </div>
    <div class="three-col">
      ${callout('A级：行为观察', '用户去重、评论次数、跨视频、跨度、首次可见评论、视频组合等可直接复算。它们描述样本内行为，不等于平台曝光、观看或关注。', 'success', '可复算')}
      ${callout('B级：文本代理', '玩家语境、萌化、关系、购买表达由透明词典与上下文编码得到。适合比较与实验设计，不等于真实人口身份或支付能力。', 'info', '规则辅助编码')}
      ${callout('C级：经营假设', '作者回复、内容格式、角色增供、商品概念对后续行为的影响尚未随机验证。报告给出实验先验，不把相关性写成因果。', 'opportunity', '待实验')}
    </div>
    <h4>四个关键分母不可混用</h4>
    <div class="method-list">
      <div><strong>${fmt(coverage.capturedComments)} 条实采评论</strong><span>用于采集覆盖、评论结构和总量审计；含作者、空文本和图片评论。</span></div>
      <div><strong>${fmt(coverage.audienceCommentsWithDate)} 条观众评论</strong><span>用于用户生命周期与互动集中度；排除作者评论，保留空文本。</span></div>
      <div><strong>${fmt(coverage.audienceTextComments)} 条观众文本</strong><span>用于语义规则、三国杀语境、商品表达与关系编码；空文本不被强行判为中性。</span></div>
      <div><strong>${fmt(textUsers)} 位有文本观众</strong><span>用于粉丝部落、语境深度和商业信号率；用户以评论用户URL去重后再匿名化。</span></div>
    </div>
  </section>

  <div class="part-head" id="part-03"><span class="part-no">03</span><h2>生命周期</h2><p>从一次评论到跨视频稳定参与</p></div>
  <section class="section">
    <p class="lead">账号的评论人群仍以一次互动为主，但价值高度集中在小规模多次参与者。<strong>${fmt(crossVideoAll)} 人（${pct(crossVideoAll / allAudienceUsers)}）</strong>跨过至少两条视频；其中 ${fmt(stableCrossVideo)} 人的跨视频跨度超过7天，是更接近稳定粉丝的行为代理。</p>
    ${stackedBar(lifecycleSegments)}
    <div class="metric-grid">
      ${metric('跨视频用户', fmt(crossVideoAll), `${pct(crossVideoAll / allAudienceUsers)} 的全部观众评论者`, 'blue')}
      ${metric('跨视频 >7天', fmt(stableCrossVideo), `${pct(stableCrossVideo / allAudienceUsers)} 的全部观众评论者`, 'green')}
      ${metric('4+互动用户', fmt(lifecycle.concentration.fourPlusUsers), `仅${pct(lifecycle.concentration.fourPlusUserShare)}用户贡献${pct(lifecycle.concentration.fourPlusCommentShare)}评论`, 'amber')}
      ${metric('11+视频用户', fmt(lifecycle.concentration.elevenVideoUsers), `仅${pct(lifecycle.concentration.elevenVideoUserShare)}用户贡献${pct(lifecycle.concentration.elevenVideoCommentShare)}评论`, 'red')}
    </div>
    <div class="two-col">
      <div>
        <h3>第二次互动多快发生？</h3>
        ${barRows(Object.entries(lifecycle.secondInteractionWindows).map(([label, item]) => ({ label, ...item })), { valueKey: 'shareOfRepeaters', maxValue: 1, valueFormat: (v, row) => `${fmt(row.users)}人 · ${pct(v)}`, color: 'green' })}
        <p class="note">分母为 ${fmt(lifecycle.repeatTextUsers)} 位有至少两次文本互动的观众；24小时内不是“次日留存”，只是样本内第二次评论发生时间。</p>
      </div>
      <div>
        <h3>经营解释</h3>
        ${callout('一周是最重要的再触达窗口', `${pct(lifecycle.secondInteractionWindows['7天内'].shareOfRepeaters)} 的重复文本用户在7天内产生第二次互动。内容编排应让新用户在一周内再次遇到熟悉的角色、关系或叙事规则。`, 'success', '窗口证据')}
        ${callout('不要被评论均值掩盖集中度', `850位4+互动用户贡献58.2%的观众评论，149位跨11+视频用户贡献26.9%。周报必须同时看独立用户数、重复参与用户数和集中度。`, 'risk', '集中度风险')}
      </div>
    </div>
    <h4>互斥生命周期全表</h4>
    ${evidenceTable(lifecycleRows, [
      { label: '阶段', key: 'segment' },
      { label: '用户', render: (row) => fmt(row.users), className: 'num' },
      { label: '用户占比', render: (row) => pct(row.userShare), className: 'num' },
      { label: '评论', render: (row) => fmt(row.comments), className: 'num' },
      { label: '评论贡献', render: (row) => pct(row.commentShare), className: 'num' },
      { label: 'MKT含义', render: (row) => esc({ '单次互动': '入口池，优先设计二触理由', '同视频重复': '局部讨论，不等于账号复访', '跨视频同日': '短时浏览链', '跨视频2-7天': '近期再触达', '跨视频8-30天': '中期关系资产', '跨视频30天以上': '稳定账号级粉丝代理' }[row.segment] || '') },
    ])}
  </section>

  <div class="part-head" id="part-04"><span class="part-no">04</span><h2>入口与迁移</h2><p>内容、仪式与兴趣递进的真实关系</p></div>
  <section class="section">
    <p class="lead">“to签/礼貌投稿”不能与自然内容需求混为一谈。不同词典边界下，“内容+仪式”的规模从 ${fmt(data.lifecycle.contentRitualEntryStrict.find((row) => row.group === '内容+仪式').users)} 到 ${fmt(data.lifecycle.contentRitualEntryRaw.find((row) => row.group === '内容+仪式').users)} 人，说明批量召集角色名会显著抬高内容认同。报告因此把仪式当活动行为，不当购买漏斗。</p>
    <div class="three-col">
      <div><h3>原始口径</h3><p class="tiny">角色名/表字也算内容，容易把to签模板当角色需求。</p>${barRows(data.lifecycle.contentRitualEntryRaw, { valueKey: 'users', valueFormat: (v, row) => `${fmt(v)}人 · 跨视频${pct(row.crossVideoRate)}` })}</div>
      <div><h3>主报告净化口径</h3><p class="tiny">从仪式文本中剥离模板化角色召集，作为经营主口径。</p>${barRows(data.lifecycle.contentRitualEntry, { valueKey: 'users', valueFormat: (v, row) => `${fmt(v)}人 · 跨视频${pct(row.crossVideoRate)}`, color: 'green' })}</div>
      <div><h3>严格口径</h3><p class="tiny">进一步收紧内容定义，用于灵敏度下界。</p>${barRows(data.lifecycle.contentRitualEntryStrict, { valueKey: 'users', valueFormat: (v, row) => `${fmt(v)}人 · 跨视频${pct(row.crossVideoRate)}`, color: 'amber' })}</div>
    </div>
    <h4>身份递进不是单向漏斗，而是“同评共现 + 部分顺序”</h4>
    ${evidenceTable(data.tribes.identityOrdering, [
      { label: '共现关系', key: 'label' },
      { label: '共同用户', render: (row) => fmt(row.users), className: 'num' },
      { label: '首次同评出现', render: (row) => `${fmt(row.simultaneousUsers)} / ${pct(row.simultaneousShare)}`, className: 'num' },
      { label: '左侧先出现', render: (row) => `${fmt(row.leftFirstUsers)} / ${pct(row.leftFirstShare)}`, className: 'num' },
      { label: '右侧先出现', render: (row) => `${fmt(row.rightFirstUsers)} / ${pct(row.rightFirstShare)}`, className: 'num' },
      { label: '左→右中位天数', render: (row) => `${dec(row.leftToRightMedianDays, 2)}天`, className: 'num' },
    ])}
    <div class="warning-strip">大多数“角色认领×玩家解码”在同一条评论首次共现（${pct(data.tribes.identityOrdering[0].simultaneousShare)}），所以不应画成“先认识角色→再成为玩家”的必然转化漏斗。可观测顺序只用于设计内容路径。</div>
    <h4>第一次语义状态变化：粉丝不是沿一条漏斗前进，而是在“认角—反应—互文”之间往返</h4>
    <div class="two-col">
      <div>
        ${barRows(data.migration.firstNext.slice(0, 10).map((row) => ({
          ...row,
          label: row.key.split('→').map((key) => data.migration.stateLabels[key] || key).join('→'),
        })), { valueKey: 'count', valueFormat: (value, row) => `${fmt(value)}人 · ${pct(row.share)}`, color: 'green' })}
      </div>
      <div class="thesis-grid">
        ${callout('状态发生变化', `${fmt(data.migration.usersWithStateChange)}位文本用户（${pct(data.migration.stateChangeRate)}）至少出现一次语义状态变化。最大两条路径是“角色识别→即时反应”和反向路径，说明粉丝经营更像循环加深，不是单向下漏。`, 'info', 'Observed path')}
        ${callout('从浅入口走向玩家互文', `以即时反应或角色识别进入的${fmt(data.migration.upwardMovement.entryReactionOrRecognition)}人中，后续${fmt(data.migration.upwardMovement.laterIntertext)}人出现玩家互文，占${pct(data.migration.upwardMovement.laterIntertextRate)}。`, 'success', 'Depth signal')}
        ${callout('从浅入口走向共创', `同一入口人群中，后续${fmt(data.migration.upwardMovement.laterCoCreation)}人出现共创/追更，占${pct(data.migration.upwardMovement.laterCoCreationRate)}。这为开放结尾、评论续写提供了基线。`, 'opportunity', 'Co-creation signal')}
        ${callout('商业表达是小概率分支', `同一入口人群中，后续${fmt(data.migration.upwardMovement.laterCommerce)}人出现周边或购买行动，占${pct(data.migration.upwardMovement.laterCommerceRate)}。经营上应单独验证，不把内容互动直接当成交。`, 'risk', 'Commerce boundary')}
      </div>
    </div>
  </section>

  <div class="part-head" id="part-05"><span class="part-no">05</span><h2>意义系统</h2><p>玩家如何共同解码、再叙事与占有</p></div>
  <section class="section">
    <p class="lead">评论区的核心价值不是单纯情绪，而是一套<strong>三层编码</strong>：表层是卡宝拟人喜剧，中层是人物关系与历史/演义互文，深层是武将技能、版本和玩家黑话。圈内用户会把剧情动作再翻译成规则笑话，同时用关系续写和商品想象扩展IP。</p>
    <div class="metric-grid">
      ${meaningThemes.slice(0, 4).map((theme, index) => metric(theme.label.split('：')[0], fmt(theme.users), `${fmt(theme.comments)}评 · ${fmt(theme.videos)}视频 · ${fmt(theme.likes)}赞`, ['blue', 'green', 'amber', 'red'][index])).join('')}
    </div>
    ${meaningThemes.map((theme, index) => `<div class="meaning-block">
      <h3>${ordinal(index)} ${esc(theme.label)}</h3>
      <p class="muted">${fmt(theme.comments)}条评论 · ${fmt(theme.users)}位用户 · ${fmt(theme.videos)}条视频 · ${fmt(theme.likes)}赞</p>
      <div class="quote-grid">${(theme.quotes || []).filter((quote) => !quote.author).slice(0, 2).map(quoteBlock).join('') || '<p class="muted">无可展示匿名引语。</p>'}</div>
    </div>`).join('')}
    <h4>三国杀语境的三条硬边界</h4>
    <div class="three-col">
      ${callout('“卖血”不是负面情绪', '“卖血将/卖血宝宝”在三国杀中指受伤后获益的机制型武将。它是规则理解的第二字幕，不是攻击或虐待语义。', 'info', '机制语境')}
      ${callout('“铁骑锁技能”不是霸凌', '界马超“铁骑”会令目标非锁定技失效；评论在重述技能压制链。需要结合视频角色与技能解释，不能按字面做情感分类。', 'info', '技能语境')}
      ${callout('关系配对不是官方关系', '周瑜×孙策、姜维×钟会等shipping是玩家二创和共创需求。报告只把它当受众关系资产，不写成官方情侣设定。', 'risk', '叙事边界')}
    </div>
    <p class="note">官方语境核验：<a href="https://www.sanguosha.cn/pc/guide-info-135.html">郭嘉“卖血将”攻略</a>、<a href="https://www.sanguosha.cn/hero-detail-156.html">界马超“铁骑”说明</a>、<a href="https://www.sanguosha.cn/pc/hero-detail-51.html">邓艾“屯田”技能说明</a>。其中“屯田”也可能指活动，仍需逐视频判定。</p>
  </section>

  <div class="part-head" id="part-06"><span class="part-no">06</span><h2>粉丝部落</h2><p>语境深度、混合核与人群价值分工</p></div>
  <section class="section">
    <p class="lead">用可观测语境深度替代“老玩家/路人”静态标签。随着语境从L0走向L4，人均评论与跨视频参与单调上升；但购买表达并不单调，峰值出现在L2角色/萌化身份层。这意味着留存价值与商品价值必须分开经营。</p>
    <div class="two-col">
      <div>
        <h3>五层语境深度：跨视频参与</h3>
        ${barRows(depthRows, { valueKey: 'crossVideoRate', maxValue: .7, valueFormat: (v, row) => `${pct(v)} · ${fmt(row.users)}人`, color: 'green', note: (row) => `人均${dec(row.commentsPerUser, 2)}条 · 30日代理${pct(row.return30Rate)} · 购买表达${pct(row.purchaseRate)}` })}
      </div>
      <div>
        <h3>五层语境深度：商品表达</h3>
        ${barRows(depthRows, { valueKey: 'purchaseRate', maxValue: .05, valueFormat: (v, row) => `${pct(v)} · ${fmt(row.purchaseUsers)}人`, color: 'amber', note: (row) => `周边兴趣${pct(row.merchandiseRate)} · 跨视频${pct(row.crossVideoRate)}` })}
      </div>
    </div>
    <h4>最关键的2×2：玩家解码 × 萌化身份</h4>
    <div class="funnel-note">${strictCute.map((row) => `<div><span class="tag ${row.id === 'both' ? 'high' : row.id === 'cute_only' ? 'gap' : ''}">${esc(row.label)}</span><strong>${fmt(row.users)}人</strong><span class="tiny">跨视频 ${pct(row.crossVideoRate)} · 30日 ${pct(row.return30Rate)} · 周边 ${pct(row.merchandiseRate)} · 购买 ${pct(row.purchaseRate)}</span></div>`).join('')}</div>
    <div class="thesis-grid" style="margin-top:18px">
      ${callout('机制型老玩家：信誉与留存', `仅玩家解码 ${fmt(strictCute.find((row) => row.id === 'strict_only').users)} 人，跨视频 ${pct(strictCute.find((row) => row.id === 'strict_only').crossVideoRate)}，购买表达仅 ${pct(strictCute.find((row) => row.id === 'strict_only').purchaseRate)}。适合机制冲突、台词回调、设定校验。`, 'info', 'Retention job')}
      ${callout('萌化收藏型：商品想象入口', `仅萌化 ${fmt(strictCute.find((row) => row.id === 'cute_only').users)} 人，周边兴趣 ${pct(strictCute.find((row) => row.id === 'cute_only').merchandiseRate)}、购买表达 ${pct(strictCute.find((row) => row.id === 'cute_only').purchaseRate)}。适合玩偶、挂件和视觉可拥有性。`, 'opportunity', 'Commerce job')}
      ${callout('玩家粉丝混合核：核心资产', `严格+萌化 ${fmt(strictCute.find((row) => row.id === 'both').users)} 人，人均 ${dec(strictCute.find((row) => row.id === 'both').commentsPerUser, 2)} 条，跨视频 ${pct(strictCute.find((row) => row.id === 'both').crossVideoRate)}。适合“轻梗入口→机制验证→共创→商品测试”。`, 'success', 'Core tribe')}
      ${callout('纯仪式人群：活动而非漏斗', `纯to签 ${fmt(data.tribes.seedSegments.find((row) => row.id === 'pure_tosign').users)} 人，30日回访代理 ${pct(data.tribes.seedSegments.find((row) => row.id === 'pure_tosign').return30Rate)}，购买表达 ${pct(data.tribes.seedSegments.find((row) => row.id === 'pure_tosign').purchaseRate)}。应看活动参与，不纳入自然角色需求。`, 'risk', 'Separate cohort')}
    </div>
    <h4>高价值种子层</h4>
    ${evidenceTable(data.tribes.seedSegments, [
      { label: '种子层', key: 'label' },
      { label: '用户', render: (row) => `${fmt(row.users)} (${pct(row.userShare)})`, className: 'num' },
      { label: '人均评论', render: (row) => dec(row.commentsPerUser, 2), className: 'num' },
      { label: '跨视频', render: (row) => pct(row.crossVideoRate), className: 'num' },
      { label: '30日代理', render: (row) => `${fmt(row.return30Users)}/${fmt(row.return30Eligible)} · ${pct(row.return30Rate)}`, className: 'num' },
      { label: '周边兴趣', render: (row) => pct(row.merchandiseRate), className: 'num' },
      { label: '购买表达', render: (row) => pct(row.purchaseRate), className: 'num' },
      { label: '证据提醒', render: (row) => row.users < 50 ? '<span class="tag explore">探索样本</span>' : row.id === 'pure_tosign' ? '<span class="tag">仪式单列</span>' : '<span class="tag high">可运营</span>' },
    ])}
    <h4>部落不是互斥标签：多重身份越多，越接近账号核心</h4>
    <div class="two-col">
      <div>
        <h3>每位用户命中的部落身份数</h3>
        ${barRows(data.tribes.membershipDistribution.map((row) => ({ ...row, label: `${row.memberships}个部落身份` })), {
          valueKey: 'users',
          valueFormat: (value, row) => `${fmt(value)}人 · ${pct(row.share)}`,
          color: 'blue',
        })}
        <p class="note">部落身份包括角色、表字、卡宝人格、萌化、严格玩家、关系、主动共创、周边和购买。0个命中只表示未命中当前词典，不等于没有兴趣。</p>
      </div>
      <div>
        <h3>最关键的跨部落桥接</h3>
        ${evidenceTable(data.tribes.bridges, [
          { label: '桥接关系', render: (row) => `${esc(row.leftLabel)} × ${esc(row.rightLabel)}` },
          { label: '交集用户', render: (row) => fmt(row.intersection), className: 'num' },
          { label: '占左侧', render: (row) => pct(row.shareOfLeft), className: 'num' },
          { label: '占右侧', render: (row) => pct(row.shareOfRight), className: 'num' },
          { label: 'Jaccard', render: (row) => pct(row.jaccard), className: 'num' },
        ])}
        <div class="warning-strip">角色识别覆盖${pct(data.tribes.bridges.find((row) => row.left === 'character' && row.right === 'strict').shareOfRight)}的严格玩家语境用户，也覆盖${pct(data.tribes.bridges.find((row) => row.left === 'character' && row.right === 'relationship').shareOfRight)}的关系共创用户；“角色”是连接硬核解码与共创的共同入口。萌化则连接${pct(data.tribes.bridges.find((row) => row.left === 'cute' && row.right === 'purchase').shareOfRight)}的严格购买用户，是商品想象的重要桥。</div>
      </div>
    </div>
  </section>

  <div class="part-head" id="part-07"><span class="part-no">07</span><h2>内容组合</h2><p>拉新、承接、双引擎与长尾任务</p></div>
  <section class="section">
    <p class="lead">没有平台播放曝光时，最可用的内容经营框架是：同一视频下，多少评论者首次出现在样本中，多少评论者此前已经在别的视频出现。它不是获客成本或真实留存率，但能识别内容在账号评论生态中的“入口任务”和“承接任务”。</p>
    <div class="metric-grid">${data.content.quadrants.map((row, index) => metric(row.quadrant, `${fmt(row.videos)}条`, `首次中位${dec(row.firstTouchMedian, 2)} · 回访中位${dec(row.returningMedian, 2)} · 购意${fmt(row.purchaseUsers)}人次`, ['green', 'amber', 'blue', 'red'][index])).join('')}</div>
    ${scatterSvg(videoPoints, { xMax: Math.max(240, ...videoPoints.map((p) => p.x)), yMax: Math.max(240, ...videoPoints.map((p) => p.y)), xMedian: data.content.acquisitionMedian, yMedian: data.content.retentionMedian, xLabel: `首次出现评论用户（中位 ${data.content.acquisitionMedian}）`, yLabel: `此前已出现评论用户（中位 ${data.content.retentionMedian}）`, ariaLabel: '107条视频的首次出现用户与回访用户散点图' })}
    <div class="two-col" style="margin-top:20px">
      <div><h3>最强入口视频</h3>${barRows(acquisitionTop, { valueKey: 'firstTouchUsers', valueFormat: (v, row) => `${fmt(v)}首触 · ${fmt(row.returningUsers)}回访`, note: (row) => esc(clip(row.title, 42)) })}</div>
      <div><h3>高承接占比视频</h3>${barRows(retentionTop, { valueKey: 'returningShare', maxValue: 1, valueFormat: (v, row) => `${pct(v)} · ${fmt(row.returningUsers)}回访`, color: 'green', note: (row) => `${fmt(row.audienceUsers)}位观众 · ${esc(clip(row.title, 38))}` })}</div>
    </div>
    <h4>视频经营明细（按评论用户规模前24）</h4>
    ${evidenceTable(topVideos, [
      { label: '视频', render: (row) => `<a href="${esc(row.url)}">${esc(clip(row.title, 44))}</a>` },
      { label: '任务', render: (row) => `<span class="tag">${esc(row.quadrant)}</span>` },
      { label: '观众用户', render: (row) => fmt(row.audienceUsers), className: 'num' },
      { label: '有文本用户', render: (row) => fmt(row.textAudienceUsers), className: 'num' },
      { label: '首次出现', render: (row) => fmt(row.firstTouchUsers), className: 'num' },
      { label: '此前出现', render: (row) => fmt(row.returningUsers), className: 'num' },
      { label: '承接占比', render: (row) => pct(row.returningShare), className: 'num' },
      { label: '严格玩家（/文本）', render: (row) => `${fmt(row.playerContextUsers)} / ${pct(row.contextUserRate)}`, className: 'num' },
      { label: '共创（/文本）', render: (row) => `${fmt(row.coCreationUsers)} / ${pct(row.coCreationUserRate)}`, className: 'num' },
      { label: '周边', render: (row) => fmt(row.merchandiseUsers), className: 'num' },
      { label: '购意', render: (row) => fmt(row.strictPurchaseUsers), className: 'num' },
    ])}
    <p class="note">“首次出现”是样本内首次评论，不是首次观看；“此前出现”是账号级评论历史代理，不保证由该视频促成回访。严格玩家、共创与周边比例均以该视频“有文本用户”为分母；发布时间仅覆盖17/107条，未做自然流量时序因果。</p>
  </section>

  <div class="part-head" id="part-08"><span class="part-no">08</span><h2>角色资产</h2><p>标题供给与非标题点名代理的相对位置</p></div>
  <section class="section">
    <p class="lead">标题里出现角色会机械抬高评论点名，因此本节统计<strong>该角色未出现在视频标题时</strong>的点名用户、评论和点赞，并进行对数加权。由于现有数据没有逐视频内容曝光编码，无法排除角色在画面、对白或剧情中出现；“非标题点名”只能作为本账号内的相对实验线索，不能直接称为自然需求、供给缺口或市场TAM。</p>
    ${scatterSvg(rolePoints, { xMax: 100, yMax: 100, xMedian: 50, yMedian: 61.1, xLabel: '标题供给指数（对数压缩）', yLabel: '非标题点名代理指数（用户50%/评论30%/点赞20%）', ariaLabel: '47个角色的标题供给与非标题点名代理散点图' })}
    <div class="two-col" style="margin-top:20px">
      <div><h3>低标题供给×高点名代理：小样验证</h3>${barRows(gapRoles.slice(0, 10).map((row) => ({ ...row, label: row.label })), { valueKey: 'relativeOpportunityIndex', valueFormat: (v, row) => `相对差 +${dec(v)} · ${fmt(row.nonTitleMentionUsers)}人`, color: 'amber', note: (row) => `${fmt(row.titleSupplyVideos)}条标题供给 · ${fmt(row.nonTitleMentionComments)}评 · ${fmt(row.nonTitleMentionLikes)}赞` })}</div>
      <div><h3>高标题供给×高点名代理：持续观察</h3>${barRows(highHighRoles.slice(0, 10).map((row) => ({ ...row, label: row.label })), { valueKey: 'nonTitleMentionIndex', maxValue: 100, valueFormat: (v, row) => `点名代理指数${dec(v)} · ${fmt(row.nonTitleMentionUsers)}人`, color: 'green', note: (row) => `${fmt(row.titleSupplyVideos)}条标题供给 · 跨视频${pct(row.crossVideoRate)} · 玩家语境${pct(row.strictContextRate)}` })}</div>
    </div>
    <h4>角色全表与指数灵敏度</h4>
    ${evidenceTable(roles, [
      { label: '角色/别名', key: 'label' },
      { label: '象限', render: (row) => `<span class="tag ${row.quadrant.startsWith('低标题供给 × 高') ? 'gap' : row.quadrant.startsWith('高标题供给 × 高') ? 'high' : ''}">${esc(roleQuadrantLabel(row.quadrant))}</span>` },
      { label: '标题供给', render: (row) => fmt(row.titleSupplyVideos), className: 'num' },
      { label: '标题下评论者', render: (row) => fmt(row.titleContextCommenters), className: 'num' },
      { label: '非标题点名代理', render: (row) => `${fmt(row.nonTitleMentionUsers)}人/${fmt(row.nonTitleMentionComments)}评`, className: 'num' },
      { label: '点名代理评论赞', render: (row) => fmt(row.nonTitleMentionLikes), className: 'num' },
      { label: '标题供给指数', render: (row) => dec(row.titleSupplyIndex), className: 'num' },
      { label: '点名代理指数', render: (row) => dec(row.nonTitleMentionIndex), className: 'num' },
      { label: '相对机会指数', render: (row) => `${row.relativeOpportunityIndex >= 0 ? '+' : ''}${dec(row.relativeOpportunityIndex)}`, className: 'num' },
      { label: '三权重排名', render: (row) => `${row.ranks['用户优先']}/${row.ranks['均衡']}/${row.ranks['互动优先']}`, className: 'num' },
    ])}
    <p class="note">角色词典含47组常见姓名、表字和稳定昵称，不是全武将穷举；“操操/嘟嘟/令君/大宝”等存在语义碰撞风险。Top排名在三套权重下同时给出；正式增供前必须补视频内容层角色曝光编码，或用随机化内容实验验证。</p>
  </section>

  <div class="part-head" id="part-09"><span class="part-no">09</span><h2>关系资产</h2><p>CP共创、君臣信誉与探索样本分开经营</p></div>
  <section class="section">
    <p class="lead">同提两个角色不自动等于CP。关系资产至少要拆成三类：显式shipping、行动/续作请求、严格玩家语境。周瑜×孙策和姜维×钟会在当前样本中呈现较强共创信号；郭嘉×曹操更偏玩家信誉与君臣/谋士叙事。非标题共同点名同样只是代理，不能跳过内容曝光编码直接解释为自然关系需求。</p>
    <div class="three-col">
      ${callout('周瑜×孙策：关系共创主线', `${fmt(pairs[0].nonTitleCoMentionUsers)}位非标题共同点名代理用户，${fmt(pairs[0].nonTitleCoMentionShippingComments)}条shipping、${fmt(pairs[0].nonTitleCoMentionActionComments)}条行动/续作，跨视频${pct(pairs[0].crossVideoRate)}。适合开放结尾、投稿共创与成对概念测试。`, 'success', '样本内强信号')}
      ${callout('姜维×钟会：入口代理 + 追更', `${fmt(pairs[1].nonTitleCoMentionUsers)}位非标题共同点名代理用户，跨视频${pct(pairs[1].crossVideoRate)}、周边兴趣${pct(pairs[1].merchandiseRate)}、购买表达${pct(pairs[1].purchaseRate)}。适合冲突/误会/护持的连续微剧情。`, 'success', '样本内强信号')}
      ${callout('郭嘉×曹操：玩家信誉资产', `${fmt(pairs[2].nonTitleCoMentionUsers)}位非标题共同点名代理用户中严格玩家语境${pct(pairs[2].strictContextRate)}，但shipping仅${fmt(pairs[2].nonTitleCoMentionShippingComments)}评、购买为0。宜做机制、台词、君臣护持，不宜硬套CP商品。`, 'info', '定位校正')}
    </div>
    ${evidenceTable(pairs, [
      { label: '关系', key: 'label' },
      { label: '象限', render: (row) => `<span class="tag ${row.nonTitleCoMentionCohortUsers < 10 ? 'explore' : 'high'}">${row.nonTitleCoMentionCohortUsers < 10 ? '探索样本' : esc(relationshipQuadrantLabel(row.quadrant))}</span>` },
      { label: '标题供给', render: (row) => fmt(row.titleSupplyVideos), className: 'num' },
      { label: '非标题共同点名代理', render: (row) => `${fmt(row.nonTitleCoMentionUsers)}人/${fmt(row.nonTitleCoMentionComments)}评`, className: 'num' },
      { label: '点赞', render: (row) => fmt(row.nonTitleCoMentionLikes), className: 'num' },
      { label: 'shipping', render: (row) => fmt(row.nonTitleCoMentionShippingComments), className: 'num' },
      { label: '行动/续作', render: (row) => fmt(row.nonTitleCoMentionActionComments), className: 'num' },
      { label: '跨视频', render: (row) => pct(row.crossVideoRate), className: 'num' },
      { label: '玩家语境', render: (row) => pct(row.strictContextRate), className: 'num' },
      { label: '共创', render: (row) => pct(row.coCreationRate), className: 'num' },
      { label: '周边/购意', render: (row) => `${pct(row.merchandiseRate)} / ${pct(row.purchaseRate)}`, className: 'num' },
    ])}
    <p class="note">曹丕×曹植等关系的非标题共同点名用户不足10人，只能作为小样方向；队列内部的高比例不能弥补绝对样本过小。关系供给是“标题同时出现双方”，不保证双方都是剧情中心；在补齐画面、对白与剧情曝光编码前，非标题共同点名只能解释为相对代理。</p>
  </section>

  <div class="part-head" id="part-10"><span class="part-no">10</span><h2>社群机制</h2><p>线程、入口与作者回复的实验机会</p></div>
  <section class="section">
    <div class="metric-grid">
      ${metric('评论线程', fmt(data.community.overallThreads.threads), `均值${dec(data.community.overallThreads.averageComments, 2)}条 · 最大${fmt(data.community.overallThreads.maxComments)}条`, 'blue')}
      ${metric('有回复线程', pct(data.community.overallThreads.withReplyRate), '至少2条评论，不等于多人讨论', 'green')}
      ${metric('多观众线程', pct(data.community.overallThreads.multiAudienceUserRate), '至少2位不同观众参与', 'amber')}
      ${metric('作者参与线程', pct(data.community.overallThreads.authorInvolvedRate), '线程中出现作者评论', 'red')}
    </div>
    <div class="two-col">
      <div>
        <h3>首个可观察互动入口</h3>
        ${barRows(data.community.firstInteractionStructure, { valueKey: 'users', valueFormat: (v, row) => `${fmt(v)}人 · 跨视频${pct(row.crossVideoRate)}` })}
      </div>
      <div>
        <h3>作者回复与后续行为：强关联，不是因果</h3>
        ${barRows([
          { label: '首根评被回复', value: replyAssociation.replied.future7dRate, users: replyAssociation.replied.future7dUsers, denominator: replyAssociation.replied.future7dEligible },
          { label: '首根评未回复', value: replyAssociation.unreplied.future7dRate, users: replyAssociation.unreplied.future7dUsers, denominator: replyAssociation.unreplied.future7dEligible },
        ], { valueKey: 'value', maxValue: .55, valueFormat: (v, row) => `${pct(v)} · ${fmt(row.users)}/${fmt(row.denominator)}`, color: 'green' })}
        <p class="note">字段没有回复发生时间，且被回复者首评平均赞${dec(replyAssociation.replied.averageInitialLikes, 2)}，未回复者${dec(replyAssociation.unreplied.averageInitialLikes, 2)}，存在明显选择偏差。</p>
      </div>
    </div>
    <h4>为什么必须做随机回复实验</h4>
    ${evidenceTable(data.community.activityReplyRates, [
      { label: '用户活跃层', key: 'label' },
      { label: '根评论', render: (row) => fmt(row.rootComments), className: 'num' },
      { label: '作者回复标记', render: (row) => fmt(row.authorRepliedRoots), className: 'num' },
      { label: '回复率', render: (row) => pct(row.authorReplyRate), className: 'num' },
    ])}
    <div class="warning-strip">用户越活跃，根评被作者回复的观测率越高，说明“作者选择高质量/高活跃用户”或“多次评论带来更多被回复机会”可能共同驱动差异。当前数据只适合作为RCT的先验，不适合宣称回复使回访提升。</div>
  </section>

  <div class="part-head" id="part-11"><span class="part-no">11</span><h2>商品证据</h2><p>意向强度、品类、培育路径与鲁棒性</p></div>
  <section class="section">
    <p class="lead">严格购买意向是“想买/必买/肯定买/在哪里买/催促推出具体周边”等近购买句式的下限。它比广义“想要”干净，但仍是评论表达，不是订单、预约或点击。</p>
    <div class="metric-grid">
      ${metric('严格购买表达者', fmt(data.commerce.robustness.users), `${fmt(data.commerce.robustness.comments)}评 · 占文本用户${pct(data.commerce.robustness.users / textUsers, 2)}`, 'green')}
      ${metric('意向评论点赞', fmt(data.commerce.robustness.likes), `中位${fmt(data.commerce.robustness.medianLikes)} · P90 ${fmt(data.commerce.robustness.p90Likes)}`, 'blue')}
      ${metric('去掉Top3后', fmt(data.commerce.robustness.afterRemovingTop3.users), `${fmt(data.commerce.robustness.afterRemovingTop3.comments)}评 · ${fmt(data.commerce.robustness.afterRemovingTop3.likes)}赞`, 'amber')}
      ${metric('价格敏感用户', fmt(data.commerce.priceSensitiveUsers), '样本不足以直接确定价格带', 'red')}
    </div>
    <div class="two-col">
      <div><h3>品类偏好（多标签，不可相加）</h3>${barRows(categoryRows, { valueKey: 'userShare', maxValue: .6, valueFormat: (v, row) => `${fmt(row.users)}人 · ${pct(v)}`, color: 'amber', note: (row) => `${fmt(row.comments)}条严格购买评论` })}</div>
      <div><h3>购买句同条语境</h3>${barRows(data.commerce.purchaseContexts, { valueKey: 'users', maxValue: 50, valueFormat: (v, row) => `${fmt(v)}人 · ${pct(row.userShare)}`, color: 'green' })}</div>
    </div>
    <h4>商业路径不是漏斗，是两种可观测入口</h4>
    <div class="funnel-note">
      <div><span class="tag">首个可见文本即表达购买</span><strong>${fmt(data.commerce.path.firstTouchUsers)}人</strong><span class="tiny">占全部严格购买表达者 ${pct(data.commerce.path.firstTouchUsers / data.commerce.path.users)}；此前可能已有不可见观看。</span></div>
      <div><span class="tag gap">此前有非购买互动</span><strong>${fmt(data.commerce.path.nurturedUsers)}人</strong><span class="tiny">占 ${pct(data.commerce.path.nurturedShare)}；先前互动到购买表达中位 ${dec(data.commerce.path.daysToPurchaseStats.median, 2)} 天。</span></div>
      <div><span class="tag high">周边兴趣交集</span><strong>${fmt(data.commerce.merchandisePurchaseOverlapUsers)}人</strong><span class="tiny">占购买表达者 ${pct(data.commerce.merchandisePurchaseOverlapUsers / data.commerce.path.users)}；另有${fmt(data.commerce.path.users - data.commerce.merchandisePurchaseOverlapUsers)}人未命中宽周边词。</span></div>
    </div>
    <h4>先行信号：后来出现购买表达的观测率</h4>
    ${evidenceTable(data.commerce.leadingSignals, [
      { label: '首次可见信号', key: 'label' },
      { label: '可观察重复用户', render: (row) => fmt(row.users), className: 'num' },
      { label: '后来出现购买表达', render: (row) => fmt(row.laterPurchaseUsers), className: 'num' },
      { label: '观测率', render: (row) => pct(row.laterPurchaseRate), className: 'num' },
      { label: '经营解释', render: (row) => esc({ merchandise: '最接近商品问题，可优先进入概念测试', cute: '萌化是较强商品想象入口', role: '角色认领提供SKU方向，但仍需直接点名', ritual: '活动参与不等于购买', mascot: '人格亲近不自动转成购买', system: '硬核机制主要服务信誉/留存' }[row.id] || '') },
    ])}
    <div class="quote-grid" style="margin-top:18px">
      ${quoteBlock({ text: '我现在越看卡宝越可爱啥时候出这种武将玩偶，必买', likes: 556, videoTitle: '当孙笨的朋友有了新朋友' })}
      ${quoteBlock({ text: '这个啥时候出周边我肯定买', likes: 494, videoTitle: '文和何在' })}
      ${quoteBlock({ text: '快点出玩偶，价格不要太贵', likes: 406, videoTitle: '贪吃小昭昭在线喷火' })}
      ${quoteBlock({ text: '卡宝，有没有考虑出表情包，想要', likes: 131, videoTitle: '三顾茅庐' })}
    </div>
    <p class="note">意向点赞高度集中：Top3评论占${pct(data.commerce.robustness.top3Share)}点赞，但去掉Top3后仍有${fmt(data.commerce.robustness.afterRemovingTop3.users)}位用户，说明需求不只来自三条热评。与此同时，0赞意向评论占${pct(data.commerce.robustness.zeroLikeShare)}，不能只筛热评。</p>
  </section>

  <div class="part-head" id="part-12"><span class="part-no">12</span><h2>90天实验</h2><p>把相关性升级为经营因果</p></div>
  <section class="section">
    <p class="lead">未来90天不应继续堆“更多评论”，而要让每条内容承担一个明确验证任务。实验先控制角色、时长、时段和发布密度，再分别观察首次出现、跨视频回访、严格玩家语境、共创与商业点击。</p>
    <div class="experiment-grid">
      <div class="experiment"><span class="exp-no">EXP 01</span><h3>萌化钩子 × 机制钩子 2×2</h3><p class="muted">验证两套价值是否互补，而不是互相替代。</p><dl><dt>设计</dt><dd>同一角色四格，各至少6条</dd><dt>主指标</dt><dd>7日跨视频用户/千首触评论者、30日回访代理</dd><dt>次指标</dt><dd>严格玩家语境、周边兴趣、购买表达/千文本用户</dd><dt>当前先验</dt><dd>仅机制30日${pct(strictCute.find((row) => row.id === 'strict_only').return30Rate)}；仅萌化购意${pct(strictCute.find((row) => row.id === 'cute_only').purchaseRate)}；两者兼具30日${pct(strictCute.find((row) => row.id === 'both').return30Rate)}</dd></dl></div>
      <div class="experiment"><span class="exp-no">EXP 02</span><h3>低标题供给角色小样验证</h3><p class="muted">验证曹冲、张飞、关羽、于吉的非标题点名代理能否在控制内容曝光后复现。</p><dl><dt>设计</dt><dd>每角色“机制/史事版”与“萌化版”，配高标题供给角色对照，共16条；同时编码画面、对白和剧情曝光</dd><dt>主指标</dt><dd>后续不含该角色内容曝光的视频中的点名用户/千外部评论者</dd><dt>次指标</dt><dd>跨视频、严格语境、共创、周边兴趣</dd><dt>停止线</dt><dd>只有当期曝光内提及上升、跨内容主动召回不升，则不扩系列</dd></dl></div>
      <div class="experiment"><span class="exp-no">EXP 03</span><h3>关系格式实验</h3><p class="muted">区分“显性互动”与“史事/机制冲突”的人群任务。</p><dl><dt>设计</dt><dd>周孙、姜钟各2种格式×3条，共12条</dd><dt>主指标</dt><dd>shipping、行动/续作、自发双方点名分别/千评论者</dd><dt>次指标</dt><dd>跨视频、共创；购买单列</dd><dt>边界</dt><dd>不把同提当CP，不把二创关系写成官方设定</dd></dl></div>
      <div class="experiment"><span class="exp-no">EXP 04</span><h3>作者回复随机实验</h3><p class="muted">验证回复是否真正提高后续参与。</p><dl><dt>设计</dt><dd>按视频、小时、语境分层随机回复/不回复，每组至少400首触根评</dd><dt>主指标</dt><dd>7日跨视频回访用户</dd><dt>次指标</dt><dd>后续严格语境、共创、周边兴趣</dd><dt>当前先验</dt><dd>被回复${pct(replyAssociation.replied.future7dRate)} vs 未回复${pct(replyAssociation.unreplied.future7dRate)}，只作样本量先验</dd></dl></div>
      <div class="experiment"><span class="exp-no">EXP 05</span><h3>商品概念与价格分层</h3><p class="muted">把评论意向推进到可观测行动。</p><dl><dt>设计</dt><dd>同渲染质量展示单武将玩偶、双人套装、卡宝挂件；价格另做3档</dd><dt>主指标</dt><dd>到货提醒/订金点击率、有效联系方式提交</dd><dt>次指标</dt><dd>角色直接点名、价格敏感、评论解释</dd><dt>边界</dt><dd>不以标题角色归因SKU偏好，不用15位价格样本定价</dd></dl></div>
      <div class="experiment"><span class="exp-no">EXP 06</span><h3>首周再触达编排</h3><p class="muted">利用重复用户中${pct(lifecycle.secondInteractionWindows['7天内'].shareOfRepeaters)}在7天内发生二触的观察窗口。</p><dl><dt>设计</dt><dd>入口片后7天内安排角色续篇、机制解释、开放投稿各1条</dd><dt>主指标</dt><dd>同入口片首触用户的7日跨视频复访代理</dd><dt>次指标</dt><dd>角色→严格、角色→共创的分离事件占比</dd><dt>边界</dt><dd>需记录完整发布时间与内容曝光，逐步补足当前数据缺口</dd></dl></div>
    </div>
    <h4>90天排期</h4>
    <div class="three-col">
      ${callout('0–30天：建基线', '统一视频标签、发布时间、内容任务、作者回复处理组；上线周报并固定分母。完成2×2语境实验与首周再触达小样。', 'info', 'Phase 1')}
      ${callout('31–60天：验证资产', '执行低标题供给角色与关系格式实验，并补录画面/对白/剧情曝光；淘汰只有当期曝光热度、没有跨内容主动召回的方向。', 'opportunity', 'Phase 2')}
      ${callout('61–90天：验证商业', '对高响应角色/关系开展三个商品概念与价格分层测试，以点击、预约或订金而非评论作为主指标。', 'success', 'Phase 3')}
    </div>
  </section>

  <div class="part-head" id="part-13"><span class="part-no">13</span><h2>指标体系</h2><p>周报看板、复算规则与限制</p></div>
  <section class="section">
    <h3>四层经营KPI树</h3>
    <div class="kpi-tree">
      <div><h4>入口 / Reach proxy</h4><ul><li>首次出现评论用户</li><li>根评入口用户</li><li>非标题角色点名代理</li><li>知识门槛问题/千评论者</li></ul></div>
      <div><h4>留存 / Return proxy</h4><ul><li>7日、30日跨视频回访代理</li><li>跨视频>7天用户</li><li>4+互动用户及评论贡献</li><li>拉新片→承接片迁移</li></ul></div>
      <div><h4>关系 / Community</h4><ul><li>多观众线程率</li><li>严格玩家语境率</li><li>有机共创与续作请求</li><li>作者回复RCT差异</li></ul></div>
      <div><h4>商业 / Commerce</h4><ul><li>周边兴趣、严格购买表达</li><li>概念点击/预约/订金</li><li>品类与角色直接点名</li><li>价格档响应与退款/取消</li></ul></div>
    </div>
    <h4>必须保留的限制</h4>
    <div class="method-list">${data.evidenceBoundaries.map((boundary, index) => `<div><strong>LIMIT ${ordinal(index)}</strong><span>${esc(boundary)}</span></div>`).join('')}</div>
    <h4>复算与交付</h4>
    <div class="method-list">
      <div><strong>分析脚本</strong><span>scripts/analyze-wuhu-mkt-deep-dive.mjs</span></div>
      <div><strong>结构化结果</strong><span>output/wuhu-mkt-deep-analysis-20260814/wuhu-mkt-deep-analysis.json</span></div>
      <div><strong>匿名用户旅程</strong><span>output/wuhu-mkt-deep-analysis-20260814/wuhu-mkt-deep-pseudonymous-journeys.csv</span></div>
      <div><strong>视频经营记分卡</strong><span>output/wuhu-mkt-deep-analysis-20260814/wuhu-mkt-deep-video-scorecard.csv</span></div>
      <div><strong>生成时间</strong><span>${esc(data.generatedAt)}</span></div>
    </div>
    <p class="note">本报告是计算辅助的扎根式分析与MKT用户级观察，不声称完成理论饱和或统计因果识别。所有建议都配套验证实验，避免把当前评论生态直接外推为市场规模。</p>
  </section>

  <footer class="footer"><span>WUHU联盟卡宝粉丝与受众MKT深度洞察 · 全量评论语料</span><span>默认交付版本 · 2026-08-14</span></footer>
</main>
</body>
</html>`;

const methodMd = `# 三国杀WUHU联盟卡宝粉丝与受众MKT深度分析：口径与复算说明

## 1. 交付定位

本次交付把原来的“评论主题摘要”升级为用户级深度MKT研究，回答六类经营问题：

1. 谁只互动一次，谁跨视频持续参与；
2. 内容、活动仪式、角色认领、玩家解码与共创如何共现或递进；
3. 哪些视频更像入口、承接、双引擎或长尾；
4. 哪些角色和关系值得进入“补曝光后复测”的点名代理实验池；
5. 哪些群体更接近周边与严格购买表达；
6. 下一步如何通过实验把观察相关性升级为经营因果。

## 2. 数据口径

- 视频：${fmt(videos.length)} 条。
- 声明评论：${fmt(coverage.declaredComments)} 条；实际采集：${fmt(coverage.capturedComments)} 条；覆盖率：${pct(coverage.capturedComments / coverage.declaredComments, 3)}。
- 非作者观众评论：${fmt(coverage.audienceCommentsWithDate)} 条；去重观众：${fmt(allAudienceUsers)} 位。
- 非作者有文本评论：${fmt(coverage.audienceTextComments)} 条；去重有文本观众：${fmt(textUsers)} 位。
- 用户主键：评论用户URL；在交付CSV中替换为不可逆匿名ID。
- 生命周期时间窗：样本内首条可见评论到后续评论；不是首次观看、关注、自然留存或平台推荐曝光。

## 3. 核心定义

### 3.1 生命周期互斥分层

- 单次互动：样本内仅1条观众评论。
- 同视频重复：至少2条评论但仅出现于1条视频。
- 跨视频同日：至少2条视频，首末互动在同一自然日。
- 跨视频2–7天、8–30天、30天以上：按首末可见互动跨度划分。

### 3.2 五层语境深度

- L0：未命中现有内容语义规则；不是已验证“泛受众”。
- L1：一般内容反应、问题与边界反馈。
- L2：角色认领、卡宝人格、萌化身份。
- L3：表字昵称、技能机制、经济记忆、史事互文、设定校验、台词回调或解释。
- L4：关系再叙事、照护/护短、悲剧修复、角色扮演、追更或有机共创；明确排除纯to签仪式。

用户按 L4 > L3 > L2 > L1 > L0 互斥归层。

### 3.3 内容入口与承接

- 首次出现用户：该视频评论者的样本内第一次可见评论发生在该视频。
- 回访用户：评论该视频前，已在另一条视频出现过。
- 视频经营象限：以107条视频的首次出现用户中位数 ${fmt(data.content.acquisitionMedian)} 与回访用户中位数 ${fmt(data.content.retentionMedian)} 切分双引擎、拉新型、承接型、长尾型。
- 视频中的严格玩家、共创与周边比例均以该视频“有文本受众用户”为分母；记分卡同时导出计数和分母。

### 3.4 角色点名代理

- 标题供给：视频标题出现角色/别名的视频数，经对数压缩为供给指数。
- 非标题点名代理：角色未出现在标题时，正文点名该角色的去重用户、评论和点赞。
- 点名指数权重：用户50%、评论30%、点赞20%，三项均对数压缩。
- 同时提供用户优先70/20/10、均衡50/30/20、互动优先40/30/30三套排名作灵敏度检查。
- 标题未出现不代表画面、对白或剧情未出现；因此相对差只能筛选实验候选，不是自然需求、供给缺口或全市场TAM。

### 3.5 商业表达

- 周边兴趣：玩偶、周边、表情包、毛绒、实体、公仔、手办、盲盒等宽兴趣。
- 严格购买表达：想买、必买、肯定买、我要买、在哪里买，或“催促推出 + 具体周边”的近购买句式。
- 两者是高度重叠的平行信号：${fmt(data.commerce.merchandisePurchaseOverlapUsers)}/${fmt(data.commerce.robustness.users)} 位购买表达者同时命中周边兴趣；不画成嵌套转化漏斗。
- 评论表达不等于订单；商品验证应使用概念点击、预约、订金或支付。

## 4. 三国杀玩家语境边界

- “卖血将/卖血宝宝”描述受伤后获益的技能机制，不按负面情绪自动编码。
- 界马超“铁骑”会令目标非锁定技失效；“锁技能”是规则压制链，不是字面霸凌。
- “屯田”可能指邓艾技能，也可能指活动，必须结合视频上下文。
- 周瑜×孙策、姜维×钟会等shipping属于玩家二创需求，不写成官方情侣设定。
- “卡宝”在报告中指官方内容运营使用的拟人化称谓，不擅自声明为已正式定义的独立吉祥物IP。

官方语境核验：

- 郭嘉攻略：https://www.sanguosha.cn/pc/guide-info-135.html
- 界马超：https://www.sanguosha.cn/hero-detail-156.html
- 邓艾：https://www.sanguosha.cn/pc/hero-detail-51.html
- 三国杀卡宝内容示例：https://www.sanguosha.cn/pc/news-detail-1422.html

## 5. 主要限制

${data.evidenceBoundaries.map((item) => `- ${item}`).join('\n')}

## 6. 复算命令

在工作区根目录运行：

\`\`\`powershell
node .\\scripts\\analyze-wuhu-mkt-deep-dive.mjs
node .\\scripts\\generate-wuhu-mkt-deep-report.mjs
python .\\scripts\\verify-wuhu-mkt-deep-report.py
\`\`\`

## 7. 产物

- \`三国杀WUHU联盟卡宝粉丝与受众MKT深度洞察报告.html\`：离线单文件报告。
- \`wuhu-mkt-deep-analysis.json\`：全部汇总、分群、视频、角色、关系和商业指标。
- \`wuhu-mkt-deep-pseudonymous-journeys.csv\`：匿名用户级旅程表。
- \`wuhu-mkt-deep-video-scorecard.csv\`：视频经营记分卡。
- \`verification.json\`：一致性、隐私和浏览器验证结果。
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, reportHtml, 'utf8');
fs.writeFileSync(METHOD_PATH, methodMd, 'utf8');

console.log(JSON.stringify({
  report: REPORT_PATH,
  reportBytes: Buffer.byteLength(reportHtml),
  method: METHOD_PATH,
  methodBytes: Buffer.byteLength(methodMd),
  sections: deepSections.length,
  videosRendered: topVideos.length,
  rolesRendered: roles.length,
  pairsRendered: pairs.length,
}, null, 2));
