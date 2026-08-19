import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'C:\\Users\\10847\\Documents\\MKT大师';
const OUT_DIR = path.join(ROOT, 'output', 'wuhu-mkt-audience-analysis-20260814');
const ANALYSIS_PATH = path.join(OUT_DIR, 'wuhu-mkt-audience-analysis.json');
const GROUNDED_PATH = path.join(ROOT, 'output', 'wuhu-grounded-player-context-20260813', 'wuhu-grounded-player-context-analysis.json');
const HTML_PATH = path.join(OUT_DIR, '三国杀WUHU联盟卡宝粉丝与受众MKT全量洞察报告.html');
const METHOD_PATH = path.join(OUT_DIR, 'MKT指标口径与复算说明.md');

const data = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
const grounded = JSON.parse(fs.readFileSync(GROUNDED_PATH, 'utf8'));

const pct = (value, digits = 1) => `${(Number(value || 0) * 100).toFixed(digits)}%`;
const num = (value, digits = 0) => Number(value || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const shortTitle = (value, max = 26) => {
  const raw = String(value || '').split('#')[0].trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
};
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const med = data.videoPortfolio.medians;
const overall = data.audienceAsset.overall;
const tiers = data.audienceAsset.activityTiers;
const segments = data.audienceSegments;
const roleChars = data.roleMarket.characters;
const rolePairs = data.roleMarket.pairs;
const archetypes = data.videoPortfolio.archetypes;
const rankings = data.videoPortfolio.rankings;
const commerce = data.commerce;
const ritual = data.ritualQuality;

function findSegment(name) {
  return segments.find((item) => item.segment === name);
}

function findCode(id) {
  return grounded.openCodes.find((item) => item.id === id);
}

function quoteFor(textFragment) {
  for (const code of grounded.openCodes) {
    const quote = (code.quotes || []).find((item) => item.text.includes(textFragment));
    if (quote) return quote;
  }
  return null;
}

const quotes = [
  quoteFor('全网三国杀唯一可爱之物'),
  quoteFor('武将玩偶，必买'),
  quoteFor('出周边我肯定买'),
  quoteFor('价格不要太贵'),
  quoteFor('考虑出表情包'),
].filter(Boolean);

function barRows(items, { value, label, detail, max, color = '#22766f' }) {
  const cap = max || Math.max(...items.map(value), 1);
  return items.map((item) => {
    const raw = value(item);
    const width = Math.max(2, Math.min(100, (raw / cap) * 100));
    return `<div class="bar-row">
      <div class="bar-head"><span>${esc(label(item))}</span><strong>${esc(detail(item))}</strong></div>
      <div class="bar-track"><span style="width:${width.toFixed(2)}%;background:${color}"></span></div>
    </div>`;
  }).join('');
}

function lineChart(points) {
  const width = 820;
  const height = 250;
  const pad = { left: 50, right: 22, top: 24, bottom: 42 };
  const max = Math.max(...points.map((item) => item.activeUsers), 1);
  const x = (i) => pad.left + (i * (width - pad.left - pad.right)) / Math.max(points.length - 1, 1);
  const y = (v) => height - pad.bottom - (v / max) * (height - pad.top - pad.bottom);
  const pathData = points.map((item, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(item.activeUsers).toFixed(1)}`).join(' ');
  const area = `${pathData} L ${x(points.length - 1)} ${height - pad.bottom} L ${x(0)} ${height - pad.bottom} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const yy = y(max * ratio);
    return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" class="grid-line" />
      <text x="${pad.left - 10}" y="${yy + 4}" text-anchor="end" class="axis-label">${num(max * ratio)}</text>`;
  }).join('');
  const labels = points.map((item, i) => `<text x="${x(i)}" y="${height - 14}" text-anchor="middle" class="axis-label">${esc(item.month.slice(5))}月</text>`).join('');
  const dots = points.map((item, i) => `<circle cx="${x(i)}" cy="${y(item.activeUsers)}" r="4.5" fill="#d45842"><title>${esc(item.month)} 活跃评论用户 ${num(item.activeUsers)}</title></circle>`).join('');
  return `<div class="chart-scroll"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="月度活跃评论用户趋势">${ticks}<path d="${area}" fill="rgba(34,118,111,.10)"/><path d="${pathData}" fill="none" stroke="#22766f" stroke-width="3" stroke-linejoin="round"/>${dots}${labels}</svg></div>`;
}

function completeMonthlySeries(points) {
  const byMonth = new Map(points.map((item) => [item.month, item]));
  const [startYear, startMonth] = data.coverage.dateStart.slice(0, 7).split('-').map(Number);
  const [endYear, endMonth] = data.coverage.dateEnd.slice(0, 7).split('-').map(Number);
  const completed = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const observed = byMonth.get(key);
    completed.push(observed
      ? { ...observed, observed: true }
      : { month: key, comments: 0, activeUsers: 0, newUsers: 0, returningUsers: 0, returningShare: 0, observed: false });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return completed;
}

function roleQuadrant(chars) {
  const width = 780;
  const height = 430;
  const pad = 54;
  const sx = data.roleMarket.thresholds.supplyIndexMedian;
  const sy = data.roleMarket.thresholds.demandIndexMedian;
  const x = (v) => pad + (v / 100) * (width - pad * 2);
  const y = (v) => height - pad - (v / 100) * (height - pad * 2);
  const focus = new Set(['曹冲', '张飞 / 翼德', '关羽 / 云长', '于吉', '曹操 / 阿瞒', '钟会 / 士季', '姜维 / 伯约', '周瑜 / 公瑾', '吕布 / 奉先', '司马懿 / 仲达']);
  const points = chars.filter((item) => focus.has(item.label)).map((item) => {
    const lowSupply = item.supplyIndex < sx;
    const highDemand = item.demandIndex >= sy;
    const fill = lowSupply && highDemand ? '#d45842' : '#22766f';
    const anchor = item.supplyIndex > 82 ? 'end' : 'start';
    const dx = anchor === 'end' ? -9 : 9;
    return `<g><circle cx="${x(item.supplyIndex)}" cy="${y(item.demandIndex)}" r="${5 + Math.sqrt(item.spontaneousUsers) / 3}" fill="${fill}" opacity=".9"><title>${esc(item.label)}｜标题视频 ${item.supplyVideos}｜自发用户 ${item.spontaneousUsers}｜需求指数 ${item.demandIndex.toFixed(1)}</title></circle><text x="${x(item.supplyIndex) + dx}" y="${y(item.demandIndex) + 4}" text-anchor="${anchor}" class="point-label">${esc(item.label.split(' / ')[0])}</text></g>`;
  }).join('');
  return `<svg class="chart-svg quadrant" viewBox="0 0 ${width} ${height}" role="img" aria-label="角色供给需求象限">
    <rect x="${pad}" y="${pad}" width="${x(sx) - pad}" height="${y(sy) - pad}" fill="#fff7f1"/>
    <rect x="${pad}" y="${y(sy)}" width="${x(sx) - pad}" height="${height - pad - y(sy)}" fill="#fff0ec"/>
    <rect x="${x(sx)}" y="${pad}" width="${width - pad - x(sx)}" height="${y(sy) - pad}" fill="#edf6f4"/>
    <rect x="${x(sx)}" y="${y(sy)}" width="${width - pad - x(sx)}" height="${height - pad - y(sy)}" fill="#f4f7f6"/>
    <line x1="${x(sx)}" y1="${pad}" x2="${x(sx)}" y2="${height - pad}" stroke="#8c9792" stroke-dasharray="5 5"/>
    <line x1="${pad}" y1="${y(sy)}" x2="${width - pad}" y2="${y(sy)}" stroke="#8c9792" stroke-dasharray="5 5"/>
    <text x="${pad}" y="24" class="quad-label">低供给 × 高需求：补位测试</text>
    <text x="${width - pad}" y="24" text-anchor="end" class="quad-label">高供给 × 高需求：核心资产</text>
    <text x="${width / 2}" y="${height - 12}" text-anchor="middle" class="axis-title">内容供给指数 →</text>
    <text transform="translate(16 ${height / 2}) rotate(-90)" text-anchor="middle" class="axis-title">自然需求指数 →</text>
    ${points}
  </svg>`;
}

function quoteCards(items) {
  return items.map((item) => `<blockquote><p>“${esc(item.text)}”</p><footer>${num(item.likes)} 赞 · 匿名评论原文</footer></blockquote>`).join('');
}

const oneTime = tiers[0];
const activeCore = {
  users: tiers[2].users + tiers[3].users,
  comments: tiers[2].comments + tiers[3].comments,
};
const pureToSign = ritual.find((item) => item.segment === '纯to签用户');
const mixedToSign = ritual.find((item) => item.segment === 'to签+其他内容用户');
const cuteSegment = findSegment('萌化情感受众');
const continuationSegment = findSegment('追更受众');
const strictSegment = findSegment('严格玩家语境受众');
const merchSegment = findSegment('周边兴趣受众');
const purchaseSegment = findSegment('严格购买意向受众');
const strictAudienceMetric = data.groundedEvidence.audienceStrictKnowledgeMetric;
const monthlyAudience = completeMonthlySeries(data.monthlyAudience);

const lowSupplyHighDemand = roleChars
  .filter((item) => item.quadrant === '低供给 × 高自发需求')
  .sort((a, b) => b.gapIndex - a.gapIndex)
  .slice(0, 6);
const highSupplyHighDemand = roleChars
  .filter((item) => item.quadrant === '高供给 × 高自发需求')
  .sort((a, b) => b.demandIndex - a.demandIndex)
  .slice(0, 8);

const rolePairRows = rolePairs.map((item) => `<tr>
  <td><strong>${esc(item.label.replaceAll(' / ', '/'))}</strong></td>
  <td>${item.supplyVideos}</td><td>${item.spontaneousUsers}</td><td>${item.spontaneousComments}</td><td>${num(item.spontaneousLikes)}</td>
  <td>${item.spontaneousShippingComments}</td><td>${item.spontaneousActionComments}</td>
  <td>${esc(item.quadrant.replaceAll('自发', ''))}</td>
</tr>`).join('');

const segmentRows = segments.filter((item) => [
  '卡宝人格受众', '角色/IP受众', '表字圈层受众', '萌化情感受众', '关系共创受众', '严格玩家语境受众', '追更受众', '周边兴趣受众', '严格购买意向受众',
].includes(item.segment)).map((item) => `<tr>
  <td><strong>${esc(item.segment)}</strong><small>${esc(item.definition)}</small></td>
  <td>${num(item.users)}</td>
  <td>${pct(item.crossVideoRate)}</td>
  <td>${pct(item.return7Rate)}<small>n=${num(item.return7Eligible)}</small></td>
  <td>${pct(item.rootAuthorReplyRate)}</td>
  <td>${pct(item.purchaseRate)}</td>
  <td>${item.purchaseLift ? `${item.purchaseLift.toFixed(2)}×` : '—'}</td>
</tr>`).join('');

const archetypeRows = archetypes.map((item) => `<tr>
  <td><strong>${esc(item.label)}</strong><small>${item.videos} 条视频</small></td>
  <td>${num(item.likesMedian)}</td><td>${num(item.audienceUsersMedian, 1)}</td><td>${num(item.firstTouchUsersMedian, 1)}</td>
  <td>${pct(item.returningShareMedian)}</td><td>${pct(item.strictContextShare)}</td>
</tr>`).join('');

const topAcqRows = rankings.firstTouchUsers.slice(0, 6).map((item, index) => `<tr><td>${index + 1}</td><td><strong>${esc(shortTitle(item.title, 30))}</strong></td><td>${num(item.firstTouchUsers)}</td><td>${num(item.firstTouchPer1kLikes, 1)}</td><td>${pct(item.returningShare)}</td></tr>`).join('');
const topRetRows = rankings.returningUsers.slice(0, 6).map((item, index) => `<tr><td>${index + 1}</td><td><strong>${esc(shortTitle(item.title, 30))}</strong></td><td>${num(item.returningUsers)}</td><td>${pct(item.returningShare)}</td><td>${num(item.firstTouchUsers)}</td></tr>`).join('');

const experimentRows = [
  ['获客', '4条', '对白/双角色关系戏', '周瑜×孙策、姜维×钟会；轻梗先行', `单条首次触达用户 ≥ ${num(med.firstTouchUsers)}；每千赞首次触达 ≥ 20`],
  ['留存', '3条', '连续编号小剧场', '结尾留未完成关系张力，48小时内承接下一集', '回访用户占比 ≥ 65%；同题追更用户跨视频出现'],
  ['角色补位', '2条', '低供给角色A/B', '曹冲、张飞优先；各做泛娱乐版与机制彩蛋版', '后续非标题视频主动点名用户 ≥ 10，且两条均出现'],
  ['圈层增厚', '1条', '机制重映射', '把技能/版本黑话翻译为剧情第二字幕', '有效机制/史事二次解码评论 ≥ 10条；逐条复核语义'],
  ['社区共创', '1条', '无奖励投稿', '选题投票→采纳公示→次条署名感谢（不含to签）', '有效提案用户 ≥ 20；重复模板率单列'],
  ['商业验证', '1条', '玩偶候选款验证', '角色投票→价格带→预约/小额定金', '以有效预约、定金和退款率决策，不以评论“想要”代替'],
].map((row) => `<tr>${row.map((cell, i) => `<td${i === 0 ? ' class="phase"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>三国杀 WUHU 联盟卡宝｜粉丝与受众 MKT 全量洞察</title>
  <style>
    :root{--ink:#202624;--muted:#65706c;--paper:#f7f6f2;--white:#fff;--line:#d9ddd9;--teal:#22766f;--teal2:#5b918a;--red:#d45842;--red2:#f2d7d0;--gold:#a77b32;--green:#5f8266;--soft:#eef2ef;--radius:6px}
    *{box-sizing:border-box} html{scroll-behavior:smooth} body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif;line-height:1.65;letter-spacing:0}
    a{color:inherit} .shell{width:min(1160px,calc(100% - 40px));margin:0 auto}.cover{background:#263b38;color:#fff;padding:72px 0 58px;position:relative;overflow:hidden}.cover:after{content:"";position:absolute;right:0;bottom:0;width:30%;height:7px;background:var(--red)}
    .eyebrow{font-size:12px;font-weight:700;letter-spacing:0;text-transform:uppercase;color:#a9c4bf}.cover h1{font-size:44px;line-height:1.16;margin:15px 0 18px;max-width:900px;letter-spacing:0}.cover .lead{font-size:18px;color:#d9e4e1;max-width:850px;margin:0}.cover-meta{display:flex;gap:28px;flex-wrap:wrap;margin-top:38px;color:#c2d2cf;font-size:13px}.cover-meta strong{color:#fff;display:block;font-size:16px;margin-bottom:2px}
    nav{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:4}.nav-inner{display:flex;gap:22px;align-items:center;overflow:auto;white-space:nowrap;height:48px;font-size:12px;font-weight:700}.nav-inner a{text-decoration:none;color:#52605c}.nav-inner a:hover{color:var(--red)}
    .band{padding:58px 0}.band.alt{background:#fff}.section-kicker{font-size:12px;font-weight:800;color:var(--red);margin-bottom:8px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;border-bottom:1px solid var(--line);padding-bottom:15px;margin-bottom:26px}.section-title h2{font-size:30px;line-height:1.25;margin:0}.section-title p{margin:0;max-width:580px;color:var(--muted);font-size:14px;text-align:right}
    .decision-banner{border-left:4px solid var(--red);padding:16px 20px;background:#fff7f4;margin:22px 0 28px}.decision-banner strong{display:block;font-size:17px;margin-bottom:4px}.decision-banner p{margin:0;color:#565f5b}
    .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:24px 0}.metric{background:var(--soft);padding:18px;border-radius:var(--radius);min-height:120px}.metric.red{background:#fff0ec}.metric.green{background:#edf4ef}.metric .value{font-size:28px;font-weight:800;line-height:1.15;color:var(--teal)}.metric.red .value{color:var(--red)}.metric label{font-size:12px;color:var(--muted);display:block;margin-top:10px}.metric small{font-size:11px;color:#7c8581;display:block;margin-top:5px}
    .thesis-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line);margin-top:26px}.thesis{padding:20px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.thesis span{display:block;color:var(--red);font-size:12px;font-weight:800}.thesis h3{font-size:16px;line-height:1.35;margin:8px 0}.thesis p{font-size:12px;color:var(--muted);margin:0}
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:28px}.split-60{display:grid;grid-template-columns:1.15fr .85fr;gap:30px}.panel{border:1px solid var(--line);background:#fff;padding:22px;border-radius:var(--radius)}.panel h3{font-size:17px;margin:0 0 6px}.panel>.sub{font-size:12px;color:var(--muted);margin:0 0 18px}.panel.flush{padding:0;overflow:hidden}.panel-head{padding:18px 20px;border-bottom:1px solid var(--line)}
    .bar-row{margin:16px 0}.bar-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;margin-bottom:6px}.bar-head strong{font-size:12px}.bar-track{height:10px;background:#e8ece9;overflow:hidden}.bar-track span{display:block;height:100%}
    .chart-scroll{overflow-x:auto}.chart-svg{display:block;width:100%;height:auto}.grid-line{stroke:#dce1de;stroke-width:1}.axis-label{font-size:11px;fill:#6f7874}.axis-title{font-size:12px;fill:#59635f;font-weight:700}.point-label{font-size:11px;fill:#2d3431;font-weight:700}.quad-label{font-size:12px;fill:#4c5652;font-weight:800}
    table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#6d7773;font-weight:700;background:#f1f3f1}th,td{padding:11px 12px;border-bottom:1px solid #e3e6e3;vertical-align:top}tr:last-child td{border-bottom:0}td small{display:block;color:#7c8581;margin-top:2px}.table-wrap{overflow:auto}.phase{color:var(--red);font-weight:800}
    .insight-list{list-style:none;padding:0;margin:0}.insight-list li{padding:15px 0;border-bottom:1px solid var(--line)}.insight-list li:last-child{border:0}.insight-list strong{display:block;font-size:14px}.insight-list span{font-size:12px;color:var(--muted)}
    .return-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0 8px}.return-cell{border:1px solid var(--line);background:#f7f9f7;padding:12px;min-height:88px}.return-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted)}.return-head strong{font-size:15px;color:var(--ink)}.return-track{height:8px;background:#e4e9e6;margin:9px 0 7px;overflow:hidden}.return-track i{display:block;height:100%;background:var(--teal)}.return-cell.current .return-track i{background:var(--red)}.return-cell small{display:block;font-size:10px;line-height:1.45;color:#78817d}
    blockquote{margin:0;padding:18px 20px;border-left:3px solid var(--teal);background:#f5f7f5;min-height:126px}blockquote p{margin:0;font-size:14px;font-weight:700}blockquote footer{font-size:11px;color:var(--muted);margin-top:12px}.quote-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .signal-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:20px 0}.signal-card{padding:20px;text-align:center;border:1px solid var(--line);background:#edf3f1}.signal-card.red{background:#fff0ec;border-color:#edc9c0}.signal-card strong{font-size:25px;display:block;color:var(--teal)}.signal-card.red strong{color:var(--red)}.signal-card span{display:block;font-size:11px;color:var(--muted);margin-top:4px}.signal-card small{display:block;font-size:10px;color:#7c8581;margin-top:6px}
    .calculator{background:#263b38;color:#fff;padding:26px;border-radius:var(--radius)}.calculator h3{margin-top:0}.calc-controls{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.calc-controls label{font-size:11px;color:#c7d5d2}.calc-controls input{width:100%;margin-top:6px;border:1px solid #78908b;background:#fff;color:#202624;padding:10px;font:inherit}.calc-output{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}.calc-output div{background:rgba(255,255,255,.08);padding:13px}.calc-output strong{font-size:20px;display:block}.calc-output span{font-size:10px;color:#c7d5d2}
    .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.step{border-top:4px solid var(--teal);background:#fff;padding:20px}.step:nth-child(2){border-color:var(--gold)}.step:nth-child(3){border-color:var(--red)}.step .day{font-size:12px;color:var(--muted);font-weight:700}.step h3{margin:7px 0;font-size:18px}.step ul{margin:10px 0 0;padding-left:18px;font-size:12px;color:#56605c}
    .method-note{font-size:12px;color:var(--muted);padding:14px 0;border-bottom:1px solid var(--line)}.method-note strong{color:var(--ink)}.callout{padding:14px 16px;border:1px solid #e4c9c2;background:#fff8f5;font-size:12px;color:#5f514d}.foot{background:#1f2b29;color:#bdc9c6;padding:34px 0;font-size:11px}.foot strong{color:#fff}.foot-grid{display:grid;grid-template-columns:2fr 1fr;gap:40px}
    @media(max-width:920px){.metric-grid{grid-template-columns:repeat(2,1fr)}.thesis-grid{grid-template-columns:repeat(2,1fr)}.two-col,.split-60{grid-template-columns:1fr}.section-title{align-items:flex-start;flex-direction:column}.section-title p{text-align:left}.calc-controls,.calc-output{grid-template-columns:repeat(2,1fr)}.steps{grid-template-columns:1fr}.cover h1{font-size:36px}}
    @media(max-width:620px){.shell{width:min(100% - 24px,1160px)}.cover{padding:52px 0 44px}.cover h1{font-size:29px}.cover .lead{font-size:15px}.band{padding:42px 0}.section-title h2{font-size:24px}.metric-grid,.thesis-grid,.quote-grid{grid-template-columns:1fr}.metric{min-height:auto}.signal-grid{grid-template-columns:1fr}.return-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.calc-controls,.calc-output{grid-template-columns:1fr}.nav-inner{gap:16px}.table-wrap{margin-right:-12px}.chart-scroll .chart-svg{min-width:720px}.quadrant{min-width:620px}.panel.quad-panel{overflow:auto}}
    @media print{nav{display:none}.band{break-inside:avoid}.cover{background:#263b38!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.shell{width:100%}body{background:#fff}}
  </style>
</head>
<body>
  <header class="cover">
    <div class="shell">
      <div class="eyebrow">WUHU联盟卡宝 · Audience & Fan Operating Intelligence</div>
      <h1>粉丝与受众 MKT 全量洞察</h1>
      <p class="lead">从“评论很多”推进到“谁在来、谁在回、哪些内容与首触达和再评论相关、哪些角色值得增供、商业意向如何验证”。扎根式语义编码保留为证据层，经营决策置于主叙事。</p>
      <div class="cover-meta">
        <div><strong>${num(data.coverage.videos || data.integrity.videos)} 条视频</strong>全量视频汇总</div>
        <div><strong>${num(data.coverage.capturedComments)} 条评论</strong>捕获率 ${pct(data.coverage.captureRate, 2)}</div>
        <div><strong>${num(data.coverage.audienceUsers)} 位评论受众</strong>非作者去重用户代理</div>
        <div><strong>2026.01.27–08.13</strong>观察窗口</div>
      </div>
    </div>
  </header>
  <nav><div class="shell nav-inner"><a href="#executive">经营结论</a><a href="#asset">受众资产</a><a href="#tribes">人群部落</a><a href="#portfolio">内容组合</a><a href="#roles">角色供需</a><a href="#ritual">社区机制</a><a href="#commerce">商业验证</a><a href="#action">行动计划</a><a href="#method">方法边界</a></div></nav>

  <main>
    <section class="band" id="executive"><div class="shell">
      <div class="section-kicker">01 / MANAGEMENT READOUT</div>
      <div class="section-title"><h2>先做经营判断，再看分析方法</h2><p>这不是“泛萌内容账号”。样本显示关系剧情与较高首次触达相关，连续内容与较高观测回访占比相关；玩家黑话负责圈层确认，卡宝人格连接陪伴与实物化意愿。</p></div>
      <div class="metric-grid">
        <div class="metric"><div class="value">${pct(oneTime.userShare)}</div><label>一次性评论用户</label><small>${num(oneTime.users)} 人仅出现 1 次，最大的经营问题是首评后未形成可见复访。</small></div>
        <div class="metric green"><div class="value">${pct(activeCore.comments / data.coverage.audienceComments)}</div><label>4条+用户贡献评论</label><small>${num(activeCore.users)} 人，仅占 ${pct(activeCore.users / data.coverage.audienceUsers)} 的受众。</small></div>
        <div class="metric"><div class="value">${pct(overall.crossVideoRate)}</div><label>跨视频评论用户率</label><small>${num(data.audienceAsset.returnSegments.find(x=>x.segment==='跨视频复访').users)} 人；是账号内复访代理，不是观看留存。</small></div>
        <div class="metric red"><div class="value">${num(commerce.purchaseUsers)}</div><label>严格购买意向用户</label><small>占有文本受众 ${pct(commerce.purchaseUserRate)}；${num(commerce.purchaseComments)} 条表达获 ${num(commerce.purchaseCommentLikes)} 赞。</small></div>
      </div>
      <div class="thesis-grid">
        <article class="thesis"><span>获客代理</span><h3>关系戏与对白样本的首触达较高</h3><p>双角色关系戏的语料内首次出现用户中位数 ${num(archetypes.find(x=>x.id==='relationship_scene').firstTouchUsersMedian)}，处于描述性组合高位，待同周期实验验证。</p></article>
        <article class="thesis"><span>回访代理</span><h3>系列化样本的观测回访占比较高</h3><p>连续剧集回访用户占比中位 ${pct(archetypes.find(x=>x.id==='series').returningShareMedian)}，高于组合整体 ${pct(med.returningShare)}；未做显著性或因果检验。</p></article>
        <article class="thesis"><span>社区</span><h3>to签是仪式，不是增长归因</h3><p>纯to签人群7日再评论仅 ${pct(pureToSign.return7Rate)}；to签+内容人群为 ${pct(mixedToSign.return7Rate)}，两者需拆开运营。</p></article>
        <article class="thesis"><span>商业</span><h3>可爱感与“可拥有”表达相关</h3><p>萌化情感人群购买意向率 ${pct(cuteSegment.purchaseRate)}，观测率为有文本受众基线的 ${cuteSegment.purchaseLift.toFixed(2)} 倍；不是转化增量。</p></article>
        <article class="thesis"><span>IP角色</span><h3>卡宝应是叙事接口</h3><p>卡宝本体展示的受众中位仅 ${num(archetypes.find(x=>x.id==='mascot_showcase').audienceUsersMedian,1)}，不宜替代武将关系剧情。</p></article>
      </div>
      <div class="decision-banner"><strong>待验证的增长链路假设：关系剧情首触达 → 连续内容再评论 → 玩家语境确认身份 → 卡宝人格连接共创与实物化。</strong><p>用下一轮12条视频和预约/定金实验逐段验证；本轮不把点赞、评论、to签或“想要”直接解释为粉丝增长、平台留存或销量。</p></div>
    </div></section>

    <section class="band alt" id="asset"><div class="shell">
      <div class="section-kicker">02 / AUDIENCE ASSET</div>
      <div class="section-title"><h2>受众不是均匀人群：小核心支撑大部分互动</h2><p>将 ${num(data.coverage.audienceUsers)} 位非作者评论用户按活跃频次分层；用户主键优先使用评论用户URL，名称仅作缺失回退。</p></div>
      <div class="split-60">
        <div class="panel"><h3>评论用户活跃阶梯</h3><p class="sub">条形长度为用户数；右侧同时展示用户占比与评论贡献。</p>${barRows(tiers,{value:x=>x.users,label:x=>x.tier,detail:x=>`${num(x.users)}人 · 用户${pct(x.userShare)} · 评论${pct(x.commentShare)}`,max:oneTime.users,color:'#22766f'})}</div>
        <div class="panel"><h3>互动高度集中</h3><p class="sub">不能只报均值。点赞与评论均存在明显长尾。</p>
          <ul class="insight-list">
            <li><strong>Top 1% 用户贡献 ${pct(data.audienceAsset.concentration.top1CommentShare)} 评论</strong><span>同时贡献 ${pct(data.audienceAsset.concentration.top1LikeShare)} 评论赞。</span></li>
            <li><strong>Top 5% 用户贡献 ${pct(data.audienceAsset.concentration.top5CommentShare)} 评论</strong><span>同时贡献 ${pct(data.audienceAsset.concentration.top5LikeShare)} 评论赞。</span></li>
            <li><strong>${num(data.audienceAsset.returnSegments.find(x=>x.segment==='11个视频以上核心').users)} 人评论过 11 条以上视频</strong><span>仅占 ${pct(data.audienceAsset.returnSegments.find(x=>x.segment==='11个视频以上核心').userShare)}，贡献 ${pct(data.audienceAsset.returnSegments.find(x=>x.segment==='11个视频以上核心').commentShare)} 评论。</span></li>
            <li><strong>作者回复资源应分层配置</strong><span>一次性用户根评回复关联率 ${pct(tiers[0].rootAuthorReplyRate)}，核心用户 ${pct(tiers[3].rootAuthorReplyRate)}。这是相关性，不是回复导致活跃。</span></li>
          </ul>
        </div>
      </div>
      <div class="panel" style="margin-top:28px"><h3>月度活跃评论用户与回访结构</h3><p class="sub">8月仅截至13日；“新/回访”是本评论语料内首次出现或再次出现，不等于平台新增粉丝。</p>${lineChart(monthlyAudience)}
        <div class="return-grid">${monthlyAudience.map((item)=>`<div class="return-cell${item.month==='2026-08'?' current':''}"><div class="return-head"><span>${esc(item.month.slice(5))}月</span><strong>${pct(item.returningShare)}</strong></div><div class="return-track"><i style="width:${(item.returningShare*100).toFixed(2)}%"></i></div><small>${item.observed?`${num(item.returningUsers)}位回访 / ${num(item.activeUsers)}位活跃`:'无观察评论，补0展示'}</small></div>`).join('')}</div>
        <p class="sub">条宽与标注均编码回访用户占当月活跃评论用户的比例；2—3月无观察评论，明确补0而非省略。</p>
      </div>
    </div></section>

    <section class="band" id="tribes"><div class="shell">
      <div class="section-kicker">03 / FAN TRIBES</div>
      <div class="section-title"><h2>从“粉丝画像”升级为可运营的行为部落</h2><p>部落可重叠，不能相加。其价值不在贴标签，而在定义内容承诺、运营动作和转化路径。</p></div>
      <div class="decision-banner"><strong>优先验证三类经营对象：追更型、萌化情感型、严格玩家语境型。</strong><p>追更人群跨视频率 ${pct(continuationSegment.crossVideoRate)}；萌化情感购买意向观测率为基线的 ${cuteSegment.purchaseLift.toFixed(2)} 倍；严格玩家语境覆盖 ${num(strictSegment.users)} 位受众。三者均是样本分层，不是平台标签或因果归因。</p></div>
      <div class="panel flush"><div class="panel-head"><h3>九类受众的行为差异</h3><p class="sub">7日再评论率仅在首次评论后有足够观察窗口的用户中计算；作者回复率以有文本根评为分母。</p></div><div class="table-wrap"><table><thead><tr><th>行为部落</th><th>用户</th><th>跨视频</th><th>观察7日再评论</th><th>根评获回复</th><th>购买意向</th><th>购买率/基线</th></tr></thead><tbody>${segmentRows}</tbody></table></div></div>
      <div class="two-col" style="margin-top:28px">
        <div class="panel"><h3>三国杀玩家语境不是“小众噪音”</h3><p class="sub">严格圈层解码：表字昵称、机制重映射、开盒记忆、史事互文、设定校验、台词回调与动机解释。</p>
          <div class="metric-grid" style="grid-template-columns:repeat(2,1fr);margin:12px 0">
            <div class="metric"><div class="value">${num(strictAudienceMetric.comments)}</div><label>受众严格语境评论</label><small>占非作者非空文本 ${pct(strictAudienceMetric.shareOfAudienceText)}</small></div>
            <div class="metric"><div class="value">${num(strictAudienceMetric.users)}</div><label>受众严格语境用户</label><small>占有文本受众 ${pct(strictAudienceMetric.userShareOfTextAudience)}</small></div>
          </div>
          <p class="callout"><strong>内容设计：</strong>表层先让泛受众看懂“吵架、反差、可爱”，中层用人物关系承接，深层把技能、版本、史事做成玩家才能读出的第二字幕。不要把“卖血、屯田、铁骑”等按普通情绪词处理。</p>
        </div>
        <div class="panel"><h3>粉丝价值链不是单向漏斗</h3><p class="sub">同一用户可以在不同视频中切换身份。</p>
          <ol class="insight-list">
            <li><strong>泛娱乐入口</strong><span>视觉梗、身份反差、双人冲突负责降低理解门槛。</span></li>
            <li><strong>角色认领</strong><span>角色名、表字、稳定昵称把“看梗”变成“认人”。</span></li>
            <li><strong>圈层确认</strong><span>技能、版本、史事与台词让老玩家确认内容懂行。</span></li>
            <li><strong>关系共创</strong><span>投稿、追更、角色直呼将观看转为连续参与。</span></li>
            <li><strong>可拥有化</strong><span>萌化与陪伴感将角色资产连接到玩偶、挂件和表情包验证。</span></li>
          </ol>
        </div>
      </div>
    </div></section>

    <section class="band alt" id="portfolio"><div class="shell">
      <div class="section-kicker">04 / CONTENT PORTFOLIO</div>
      <div class="section-title"><h2>不同内容对应不同经营假设</h2><p>107条视频均有采集时点点赞快照，但仅17条有发布时间。下表为描述性组合对比，不构成因果实验。</p></div>
      <div class="panel flush"><div class="panel-head"><h3>内容原型经营角色</h3><p class="sub">原型可重叠，视频数不可相加；首次触达/回访均为当前评论语料内代理；“每千赞评论”是讨论密度，不是互动率。</p></div><div class="table-wrap"><table><thead><tr><th>原型</th><th>赞中位</th><th>受众中位</th><th>首次触达中位</th><th>回访占比中位</th><th>严格语境占比</th></tr></thead><tbody>${archetypeRows}</tbody></table></div></div>
      <div class="two-col" style="margin-top:28px">
        <div class="panel flush"><div class="panel-head"><h3>获客代理 Top 6</h3><p class="sub">按视频带来的语料内首次出现用户排序。</p></div><div class="table-wrap"><table><thead><tr><th>#</th><th>视频</th><th>首次触达</th><th>/千赞</th><th>回访占比</th></tr></thead><tbody>${topAcqRows}</tbody></table></div></div>
        <div class="panel flush"><div class="panel-head"><h3>观察回访用户 Top 6</h3><p class="sub">按此前已在语料中出现的用户数排序，不等于平台留存。</p></div><div class="table-wrap"><table><thead><tr><th>#</th><th>视频</th><th>回访用户</th><th>占比</th><th>首次触达</th></tr></thead><tbody>${topRetRows}</tbody></table></div></div>
      </div>
      <div class="decision-banner"><strong>组合策略：优先测试“对白/关系戏”的首触达效率，并检验“连续编号/规则体验”能否提高后续观测回访；卡宝保持为角色关系的主持人和情感接口。</strong><p>卡宝本体展示样本的点赞中位 ${num(archetypes.find(x=>x.id==='mascot_showcase').likesMedian)}、受众中位 ${num(archetypes.find(x=>x.id==='mascot_showcase').audienceUsersMedian,1)}，在描述性中位数上低于关系戏的 ${num(archetypes.find(x=>x.id==='relationship_scene').likesMedian)} 赞和 ${num(archetypes.find(x=>x.id==='relationship_scene').audienceUsersMedian)} 位受众；需在同周期做内容A/B。</p></div>
    </div></section>

    <section class="band" id="roles"><div class="shell">
      <div class="section-kicker">05 / CHARACTER DEMAND</div>
      <div class="section-title"><h2>角色供给与自然需求必须分开</h2><p>标题中出现角色定义为供给；非该角色标题视频中的主动点名定义为自然需求，并排除to签评论。指数只用于账号内部排优先级，不是全市场TAM。</p></div>
      <div class="split-60">
        <div class="panel quad-panel"><h3>角色供需象限</h3><p class="sub">只标注核心与优先补位角色；气泡大小近似自发用户量。</p>${roleQuadrant(roleChars)}</div>
        <div>
          <div class="panel"><h3>补位测试优先级</h3><p class="sub">低供给 × 高自然需求，适合小批量增供验证。</p>${barRows(lowSupplyHighDemand,{value:x=>x.gapIndex,label:x=>x.label,detail:x=>`S${x.supplyVideos} · 自发${x.spontaneousUsers}人 · Gap +${x.gapIndex.toFixed(1)}`,max:45,color:'#d45842'})}</div>
          <div class="panel" style="margin-top:14px"><h3>成熟核心资产</h3><p class="sub">高供给 × 高自然需求，承担稳定内容供给。</p>${barRows(highSupplyHighDemand.slice(0,6),{value:x=>x.demandIndex,label:x=>x.label,detail:x=>`需求${x.demandIndex.toFixed(1)} · Gap ${x.gapIndex>=0?'+':''}${x.gapIndex.toFixed(1)}`,max:100,color:'#22766f'})}</div>
        </div>
      </div>
      <div class="panel flush" style="margin-top:28px"><div class="panel-head"><h3>八条关系资产的跨内容召回</h3><p class="sub">双角色同提只是认知关联，不自动等于CP；“显式关系/行动”为自发评论条数，而非用户数。</p></div><div class="table-wrap"><table><thead><tr><th>关系资产</th><th>供给视频</th><th>自发用户</th><th>自发评论</th><th>评论赞</th><th>显式关系评</th><th>行动评</th><th>象限</th></tr></thead><tbody>${rolePairRows}</tbody></table></div></div>
      <div class="decision-banner"><strong>关系主轴：周瑜×孙策、姜维×钟会可直接进入系列化；曹操×郭嘉应走主公/谋士与史事机制，不应复制单一CP模板。</strong><p>曹丕×曹植目前仅6位净化自发用户、8条评论，属于“小样值得测”，不是成熟爆款关系。曹操×荀彧等供给内响应高、跨内容主动召回弱，应先验证邻接视频召回。</p></div>
    </div></section>

    <section class="band alt" id="ritual"><div class="shell">
      <div class="section-kicker">06 / COMMUNITY MECHANICS</div>
      <div class="section-title"><h2>奖励仪式聚集参与，也会混淆真实需求</h2><p>to签、礼貌投稿、角色点名和自然内容讨论必须拆分，否则会把奖励召集误写成角色偏好或内容留存。</p></div>
      <div class="two-col">
        <div class="panel"><h3>纯to签 vs. 内容型to签</h3><p class="sub">相同“参加活动”表面行为，背后的用户质量完全不同。</p>
          ${barRows([pureToSign,mixedToSign],{value:x=>x.return7Rate,label:x=>x.segment,detail:x=>`${num(x.users)}人 · 7日再评论${pct(x.return7Rate)} · 跨视频${pct(x.crossVideoRate)}`,max:0.8,color:'#a77b32'})}
          <ul class="insight-list">
            <li><strong>纯to签：${num(pureToSign.users)} 人，购买意向 0 人</strong><span>跨视频率 ${pct(pureToSign.crossVideoRate)}，表现为浅层活动流量。</span></li>
            <li><strong>to签+内容：${num(mixedToSign.users)} 人，${num(mixedToSign.purchaseUsers)} 人有购买意向</strong><span>跨视频率 ${pct(mixedToSign.crossVideoRate)}，更像既有活跃用户进入奖励仪式。</span></li>
          </ul>
        </div>
        <div class="panel"><h3>社区机制重构</h3><p class="sub">将奖励从“发一句话”转向“贡献内容资产”。</p>
          <ol class="insight-list">
            <li><strong>选题池</strong><span>每周收集角色冲突、技能梗、史事修复三类提案，用户去重。</span></li>
            <li><strong>二段投票</strong><span>先投角色/关系，再投剧情走向；减少模板复制。</span></li>
            <li><strong>采纳公示</strong><span>下一条视频展示被采纳洞察，奖励贡献质量而非重复频次。</span></li>
            <li><strong>分层回复</strong><span>18–22点集中处理高潜根评、机制争议、追更与周边问题；时间窗口受发布时间混杂。</span></li>
          </ol>
        </div>
      </div>
    </div></section>

    <section class="band" id="commerce"><div class="shell">
      <div class="section-kicker">07 / COMMERCE VALIDATION</div>
      <div class="section-title"><h2>商业信号已出现，但仍处于验证前</h2><p>“周边/想买”是意向表达，不是订单。应从评论线索进入预约、定金、价格与退款的可观测验证链。</p></div>
      <div class="metric-grid">
        <div class="metric"><div class="value">${num(commerce.merchandiseUsers)}</div><label>周边兴趣用户</label><small>占有文本受众 ${pct(commerce.merchandiseUserRate)}</small></div>
        <div class="metric red"><div class="value">${num(commerce.purchaseUsers)}</div><label>严格近购买意向</label><small>${num(commerce.purchaseComments)} 条评论，${num(commerce.purchaseCommentLikes)} 赞</small></div>
        <div class="metric"><div class="value">${pct(commerce.purchaseActivity.crossVideoRate)}</div><label>购买意向用户跨视频率</label><small>其中 ${pct(commerce.purchaseActivity.repeatRate)} 在窗口内评论2次以上</small></div>
        <div class="metric"><div class="value">${num(commerce.priceUsers)}</div><label>价格敏感用户</label><small>样本过小，不支持直接定价；适合做分层价格测试</small></div>
      </div>
      <div class="signal-grid">
        <div class="signal-card"><strong>${num(commerce.textAudienceUsers)}</strong><span>有文本评论受众</span><small>两个意向信号的共同分析分母</small></div>
        <div class="signal-card"><strong>${num(commerce.merchandiseUsers)}</strong><span>周边兴趣 ${pct(commerce.merchandiseUserRate)}</span><small>至少一次出现周边/玩偶等实物化诉求</small></div>
        <div class="signal-card red"><strong>${num(commerce.purchaseUsers)}</strong><span>严格购买意向 ${pct(commerce.purchaseUserRate)}</span><small>透明近购买句式，不等于订单</small></div>
      </div>
      <div class="callout" style="margin-bottom:22px"><strong>不是连续转化漏斗：</strong>${num(commerce.purchaseUsers)} 位严格购买意向用户中，${num(commerce.purchaseMerchandiseOverlapUsers)} 位同时属于周边兴趣，另有 ${num(commerce.purchaseOutsideMerchandiseUsers)} 位不在该标签内；两类是并列且重叠的观测信号，交集占严格购买意向 ${pct(commerce.purchaseMerchandiseOverlapRate)}。</div>
      <div class="two-col">
        <div class="panel"><h3>需求品类：先玩偶，再做低成本先导</h3><p class="sub">品类可重叠，数字不能相加为总需求。</p>${barRows(commerce.purchaseCategories.filter(x=>x.comments>0),{value:x=>x.comments,label:x=>x.category,detail:x=>`${x.comments}条 · ${x.users}人`,max:90,color:'#d45842'})}</div>
        <div class="panel"><h3>购买意向不是纯冲动人群</h3><p class="sub">基于观察窗口内首次严格购买表达前的历史评论。</p>
          <ul class="insight-list">
            <li><strong>${num(commerce.purchasePath.firstTouch)} 人首次观察即表达意向</strong><span>可能是内容即时激发，也可能是窗口左截断前已有接触，不能视为新转化。</span></li>
            <li><strong>${num(commerce.purchasePath.nurtured)} 人在此前评论后表达意向</strong><span>此前评论中位 ${num(commerce.purchasePath.priorCommentsMedian)} 条，间隔中位 ${num(commerce.purchasePath.daysToIntentMedian,1)} 天。</span></li>
            <li><strong>萌化情感是最强可见关联</strong><span>${num(cuteSegment.purchaseUsers)} 位萌化受众表达严格购买意向，观测率为有文本受众基线的 ${cuteSegment.purchaseLift.toFixed(2)} 倍；不代表由萌化内容带来的转化增量。</span></li>
            <li><strong>角色优先用投票+预约验证</strong><span>先测角色、造型、尺寸、价格带，再进入打样与定金。</span></li>
          </ul>
        </div>
      </div>
      <div class="quote-grid" style="margin-top:28px">${quoteCards(quotes)}</div>
      <div class="calculator" style="margin-top:28px">
        <h3>意向池 → 定金验证情景计算器</h3><p style="font-size:12px;color:#c7d5d2">默认以153位严格购买意向用户为种子。所有输入均为管理假设，输出不是销量预测。</p>
        <div class="calc-controls">
          <label>意向池人数<input id="seed" type="number" min="0" value="153"></label>
          <label>定金转化率（%）<input id="conv" type="number" min="0" max="100" step="1" value="20"></label>
          <label>商品含税价（元）<input id="price" type="number" min="0" step="1" value="99"></label>
          <label>单件变动成本（元）<input id="cost" type="number" min="0" step="1" value="52"></label>
          <label>固定开发成本（元）<input id="fixed" type="number" min="0" step="100" value="5000"></label>
          <label>退款/未付尾款率（%）<input id="refund" type="number" min="0" max="100" step="1" value="10"></label>
        </div>
        <div class="calc-output"><div><strong id="deposits">31</strong><span>预计定金人数（情景）</span></div><div><strong id="paid">28</strong><span>有效成交人数（情景）</span></div><div><strong id="revenue">¥2,772</strong><span>收入（情景）</span></div><div><strong id="net">-¥3,684</strong><span>扣变动与固定成本后</span></div></div>
      </div>
    </div></section>

    <section class="band alt" id="action"><div class="shell">
      <div class="section-kicker">08 / OPERATING PLAN</div>
      <div class="section-title"><h2>用12条视频完成一次经营闭环</h2><p>所有阈值是下一轮的预设决策规则，不是已验证行业基准。先固定口径，再执行，再按增量结果调整。</p></div>
      <div class="panel flush"><div class="table-wrap"><table><thead><tr><th>任务</th><th>配额</th><th>内容形态</th><th>具体方向</th><th>预设验证门槛</th></tr></thead><tbody>${experimentRows}</tbody></table></div></div>
      <div class="steps" style="margin-top:28px">
        <article class="step"><div class="day">0–30 天</div><h3>统一量尺与小样</h3><ul><li>上线内容标签、首次触达、回访、角色自发点名口径</li><li>跑完12条视频矩阵</li><li>周边完成角色与价格带投票，不开大货</li></ul></article>
        <article class="step"><div class="day">31–60 天</div><h3>扩优胜组</h3><ul><li>只扩达到门槛的关系线与补位角色</li><li>建立周投稿池与采纳公示</li><li>上线玩偶候补名单/预约页，记录来源内容</li></ul></article>
        <article class="step"><div class="day">61–90 天</div><h3>验证商业闭环</h3><ul><li>小额定金验证有效支付与退款</li><li>比较角色、价格、内容来源的转化差异</li><li>决定打样、继续测试或停止，不用评论热度替代订单</li></ul></article>
      </div>
      <div class="two-col" style="margin-top:28px">
        <div class="panel"><h3>KPI 树：增长</h3><ul class="insight-list"><li><strong>获客代理</strong><span>单视频语料内首次出现用户；每千显示赞首次触达用户。</span></li><li><strong>留存代理</strong><span>跨视频评论用户率；观察7/30日再评论率；连续剧集回访占比。</span></li><li><strong>圈层质量</strong><span>严格玩家语境用户/评论；有效追更；非标题角色主动点名。</span></li><li><strong>社区效率</strong><span>作者根评回复率；有效提案用户；模板重复率；回复线程深度。</span></li></ul></div>
        <div class="panel"><h3>KPI 树：商业</h3><ul class="insight-list"><li><strong>意向</strong><span>周边兴趣用户、严格购买意向用户、价格带选择。</span></li><li><strong>验证</strong><span>有效预约率、定金转化率、退款/未付尾款率。</span></li><li><strong>单元经济</strong><span>客单价、单件变动成本、毛贡献、固定成本回收件数。</span></li><li><strong>归因</strong><span>内容来源、角色偏好、受众分层；只做观察归因与对照实验。</span></li></ul></div>
      </div>
    </div></section>

    <section class="band" id="method"><div class="shell">
      <div class="section-kicker">09 / METHOD & BOUNDARY</div>
      <div class="section-title"><h2>扎根分析保留，但只做证据层</h2><p>计算辅助扎根式分析用于解释玩家如何把萌化剧情解码为角色、机制、历史、关系、共创和购买意向；经营量化以去重用户与视频为主单位。</p></div>
      <div class="two-col">
        <div class="panel">
          <div class="method-note"><strong>样本覆盖：</strong>${num(data.coverage.capturedComments)} / ${num(data.coverage.declaredComments)} 条声明评论，${pct(data.coverage.captureRate,2)}；107条视频。</div>
          <div class="method-note"><strong>受众边界：</strong>${num(data.coverage.audienceUsers)} 位是可识别非作者评论者，不代表全部粉丝、观看者或触达用户。</div>
          <div class="method-note"><strong>留存边界：</strong>跨视频与7/30日为再次评论代理，不等于观看留存或关注留存；窗口存在左/右截断。</div>
          <div class="method-note"><strong>视频指标：</strong>107条均有采集时点赞快照；90条缺发布时间，100条点赞来自卡片文本恢复。无播放、完播、收藏、转发全量数据。</div>
          <div class="method-note"><strong>角色需求：</strong>排除标题供给视频与to签评论后，自发点名作为需求代理；47组角色词典并非全武将穷举。</div>
        </div>
        <div class="panel">
          <div class="method-note"><strong>语义方法：</strong>${esc(data.groundedEvidence.method.approach)}。</div>
          <div class="method-note"><strong>严格购买规则：</strong>“想买/必买/肯定买/我要买/在哪里买”等，或“什么时候/快点/能不能 + 出/做 + 周边/玩偶/毛绒/表情包”等近购买句式。</div>
          <div class="method-note"><strong>关系边界：</strong>双角色同提不等于CP；relationship_shipping才是显式关系再叙事下限。玩家二创不能写成官方正史关系。</div>
          <div class="method-note"><strong>地点边界：</strong>平台评论IP标签不等于常住地、粉丝所在地或可配送地址，本报告不用于地域投放或库存分配。</div>
          <div class="method-note"><strong>隐私：</strong>附表使用不可逆哈希代理ID，不导出昵称、URL、评论原文或评论ID；报告引语仅匿名呈现。</div>
        </div>
      </div>
      <div class="callout" style="margin-top:22px"><strong>结论证据强度：</strong>“已观察”用于本数据窗口内可复核计数；“相关信号”用于分层差异；“待验证”用于内容增量、付费意愿与因果主张。报告不把评论热度直接外推为市场规模。</div>
    </div></section>
  </main>

  <footer class="foot"><div class="shell foot-grid"><div><strong>WUHU联盟卡宝 · 粉丝与受众MKT全量洞察</strong><br>本地离线单文件报告，生成于 2026-08-14。数据窗口截至 2026-08-13。</div><div>附表：匿名受众分层CSV<br>附录：指标口径与复算说明<br>分析JSON：可复核中间层</div></div></footer>
  <script>
    const ids = ['seed','conv','price','cost','fixed','refund'];
    function calculate(){
      const values = Object.fromEntries(ids.map(id=>[id,Math.max(0,Number(document.getElementById(id).value)||0)]));
      const deposits = Math.round(values.seed * Math.min(values.conv,100) / 100);
      const paid = Math.round(deposits * (1 - Math.min(values.refund,100)/100));
      const revenue = paid * values.price;
      const net = paid * (values.price - values.cost) - values.fixed;
      document.getElementById('deposits').textContent = deposits.toLocaleString('zh-CN');
      document.getElementById('paid').textContent = paid.toLocaleString('zh-CN');
      document.getElementById('revenue').textContent = '¥' + revenue.toLocaleString('zh-CN');
      document.getElementById('net').textContent = (net<0?'-':'') + '¥' + Math.abs(net).toLocaleString('zh-CN');
    }
    ids.forEach(id=>document.getElementById(id).addEventListener('input',calculate));
    calculate();
  </script>
</body>
</html>`;

const method = `# WUHU联盟卡宝 MKT 指标口径与复算说明

生成日期：2026-08-14
观察窗口：2026-01-27 至 2026-08-13

## 1. 数据覆盖

- 视频：107 条。
- 声明评论：17,021 条；实际捕获：16,796 条；覆盖率：98.678%。
- 非作者评论：14,715 条；非作者非空文本评论：13,320 条。
- 非作者评论用户：5,410 位；其中有文本评论用户：4,990 位。
- 严格玩家语境仅按非作者口径汇报：${num(strictAudienceMetric.comments)} 条评论、${num(strictAudienceMetric.users)} 位用户，占非作者非空文本 ${pct(strictAudienceMetric.shareOfAudienceText)}。
- 用户主键：优先使用评论用户URL；URL缺失时使用名称构造回退键。对外附表仅输出哈希代理ID。

## 2. 经营指标

- **一次性用户**：观察窗口内仅出现1条非作者评论。
- **跨视频复访**：同一用户在至少2个视频发表评论。仅为账号评论行为代理，不是观看或关注留存。
- **观察7/30日再评论**：用户首次评论后7/30天仍位于数据窗口内，并在对应时间后再次评论。分母只含具有完整观察机会的用户。
- **首次触达用户**：对每位用户按时间排序，其第一次出现在本语料中的视频。受窗口左截断影响，不等于平台新增粉丝。
- **回访用户**：在该视频评论前已于本语料其他视频出现的用户。
- **讨论密度**：评论用户或评论数 / 采集时视频显示赞 × 1,000。不是互动率。
- **作者根评回复率**：标注作者回复的非作者有文本根评 / 非作者有文本根评。

## 3. 角色供需指数

- 供给：标题正文或标签命中角色的不同视频数。
- 自发需求：排除该角色标题视频后，非作者非空评论主动命中角色；同时排除to签仪式评论。
- 供给指数：\`100 × ln(1+S) / ln(1+maxS)\`。
- 需求指数：\`100 × [0.5×ln(1+U)/ln(1+maxU) + 0.3×ln(1+C)/ln(1+maxC) + 0.2×ln(1+L)/ln(1+maxL)]\`。
- S=标题视频数，U=自发去重用户，C=自发评论，L=自发评论赞。点赞只占20%且对数压缩。
- Gap=需求指数−供给指数。Gap只用于当前账号语料内相对排序，不代表市场规模。

## 4. 语义编码

- 方法：全量透明规则编码、高风险编码定向审阅、原始线程复核的计算辅助扎根式分析。
- 严格玩家语境包括表字/昵称、机制重映射、游戏经济记忆、史事互文、设定校验、台词回调和角色动机解释。
- 严格购买意向是透明近购买句式下限；周边兴趣与购买意向是并列且重叠的信号，不是连续漏斗。${num(commerce.purchaseUsers)} 位购买意向用户中有 ${num(commerce.purchaseMerchandiseOverlapUsers)} 位同时属于周边兴趣。
- 多标签可重叠，各部落和品类不可相加为总受众。

## 5. 数据边界

- 只有17/107条视频有发布时间，不做全量发布时间因果或完整视频生命周期结论。
- 缺少全量播放、完播、收藏、分享，不能计算传统互动率或转化率。
- 107条点赞是采集时点显示快照，其中100条由视频卡片文本首个数值恢复。
- 评论IP标签不等于常住地或配送地。
- 词典含47组角色，不是三国杀全武将穷举；昵称存在碰撞可能。
- CP/关系编码反映玩家二创，不代表官方正史或官方情侣关系。

## 6. 当前文件校验

- 分析JSON SHA-256：\`${sha256(ANALYSIS_PATH)}\`
- 匿名用户CSV SHA-256：\`${sha256(path.join(OUT_DIR, 'wuhu-mkt-pseudonymous-audience-segments.csv'))}\`
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(HTML_PATH, html, 'utf8');
fs.writeFileSync(METHOD_PATH, method, 'utf8');

console.log(JSON.stringify({
  htmlPath: HTML_PATH,
  methodPath: METHOD_PATH,
  htmlBytes: fs.statSync(HTML_PATH).size,
  htmlSha256: sha256(HTML_PATH),
  methodSha256: sha256(METHOD_PATH),
}, null, 2));
