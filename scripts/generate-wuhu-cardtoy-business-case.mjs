import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'output', 'wuhu-cardtoy-business-case-20260817');
const RAW = 'E:\\kolforge-data\\manual-douyin\\20260813-sanguosha-wuhu-all\\all-comments.csv';
const CODED = path.join(ROOT, 'output', 'wuhu-grounded-player-context-20260813', 'wuhu-grounded-coded-comments.csv');
const DEEP = path.join(ROOT, 'output', 'wuhu-mkt-deep-analysis-20260814', 'wuhu-mkt-deep-analysis.json');
const REPORT = '三国杀WUHU联盟卡宝玩偶化立项专项论证报告.html';

function csvParse(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [headers, ...body] = rows;
  return body.filter((values) => values.length && values.some(Boolean)).map((values) => Object.fromEntries(headers.map((key, index) => [key.replace(/^\uFEFF/, ''), values[index] ?? ''])));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows, headers) {
  fs.writeFileSync(file, [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n'), 'utf8');
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function n(value) { return new Intl.NumberFormat('zh-CN').format(Number(value ?? 0)); }
function pct(value, digits = 1) { return `${(Number(value ?? 0) * 100).toFixed(digits)}%`; }
function fixed(value, digits = 1) { return Number(value ?? 0).toFixed(digits); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function cleanTitle(value) { return String(value ?? '').replace(/\s*#.+$/u, '').trim() || '未命名视频'; }
function userKey(row) { return String(row['评论用户URL'] || row['评论用户'] || '').trim(); }
function commentId(row) { return String(row['评论ID'] || '').trim(); }
function likes(row) { return Number(String(row['评论点赞数'] || '0').replace(/[^\d.-]/g, '')) || 0; }
function asSet(values) { return new Set(values); }
function uniqueCount(rows, getter = userKey) { return new Set(rows.map(getter).filter(Boolean)).size; }
function sum(rows, getter) { return rows.reduce((total, row) => total + Number(getter(row) || 0), 0); }
function dateInfo(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/u);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return { key: `${year}-${String(month).padStart(2, '0')}`, epoch: Date.UTC(year, month - 1, day, hour, minute, second), value: `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` };
}

const rawRows = csvParse(fs.readFileSync(RAW, 'utf8'));
const codedRows = csvParse(fs.readFileSync(CODED, 'utf8'));
const deep = JSON.parse(fs.readFileSync(DEEP, 'utf8'));
const codeById = new Map(codedRows.map((row) => [row['评论ID'], new Set(String(row['开放编码'] || '').split('|').map((item) => item.trim()).filter(Boolean))]));
const authorValues = asSet(['true', '1', '是', 'yes']);
const audience = rawRows.filter((row) => !authorValues.has(String(row['是否视频作者'] || '').trim().toLowerCase()));
const audienceText = audience.filter((row) => String(row['评论内容'] || '').trim());
const textRows = audienceText.map((row) => ({ ...row, codes: codeById.get(commentId(row)) || new Set(), time: dateInfo(row['评论时间']) }));

const code = (row, key) => row.codes.has(key);
const hasOne = (row, keys) => keys.some((key) => code(row, key));
const characterAliases = [
  ['姜维', /姜维|伯约/u], ['钟会', /钟会/u], ['贾诩', /贾诩|文和/u], ['周瑜', /周瑜|公瑾|大嘟嘟/u],
  ['孙策', /孙策|伯符|孙笨/u], ['曹操', /曹操|阿瞒|孟德/u], ['郭嘉', /郭嘉|奉孝/u], ['曹丕', /曹丕|子桓/u],
  ['司马懿', /司马懿|仲达/u], ['吕布', /吕布|奉先/u], ['张绣', /张绣/u], ['邓艾', /邓艾|士载/u],
  ['关羽', /关羽|云长/u], ['张飞', /张飞|翼德/u], ['曹冲', /曹冲|仓舒/u], ['于吉', /于吉/u],
];
const strictKnowledgeCodes = ['courtesy_nickname', 'mechanic_remap_validation', 'game_economy_memory', 'historical_intertext', 'canon_audit', 'voice_line_callback', 'interpretive_explanation'];
const cuteCodes = ['mascot_persona_reference', 'cute_infantilization'];
const contentCodes = ['character_recognition', 'mascot_persona_reference', 'cute_infantilization', 'relationship_shipping', 'continuation_request', 'protective_care', ...strictKnowledgeCodes];
const forbiddenNarrative = /不是|而是|是不是|并非|而非|不等于/u;

function semantic(row) {
  const text = String(row['评论内容'] || '').replace(/\s+/gu, ' ').trim();
  const targetToy = /(玩偶|娃娃|毛绒|挂件|公仔|手办|盲盒|实体)/u.test(text);
  const generalMerch = /(周边|表情包)/u.test(text);
  const acquisition = /(想买|必买|肯定买|我要买|我都想买|在哪里买|什么时候.{0,5}出|啥时候.{0,5}出|何时.{0,5}出|快点.{0,5}出|赶紧.{0,5}出|求.{0,4}出|能不能.{0,6}(出|做)|出.{0,8}(玩偶|娃娃|毛绒|挂件|公仔|手办|盲盒|实体|周边|表情包))/u.test(text);
  const design = /(耳朵|立一个|歪一个|做成|造型|材质|尺寸|表情|配色|动作|挂件)/u.test(text);
  const price = /(价格|太贵|便宜|多少钱|多少米|定价)/u.test(text);
  const cute = /(可爱|萌|卡宝|宝宝|小狗|小熊|娃娃)/u.test(text) || hasOne(row, cuteCodes);
  const ritual = hasOne(row, ['tosign_ritual', 'submission_ritual']) || /(to签|投稿|礼貌投稿|签到)/u.test(text);
  const directPurchase = code(row, 'strict_purchase_intent');
  return { text, targetToy, generalMerch, acquisition, design, price, cute, ritual, directPurchase, physical: targetToy || generalMerch };
}

for (const row of textRows) row.semantic = semantic(row);
const strictPurchaseRows = textRows.filter((row) => row.semantic.directPurchase);
const strictPurchaseUsers = new Set(strictPurchaseRows.map(userKey));
const toyPurchaseRows = strictPurchaseRows.filter((row) => row.semantic.targetToy);
const actionPhysicalRows = textRows.filter((row) => row.semantic.acquisition && row.semantic.targetToy);
const merchandiseRows = textRows.filter((row) => code(row, 'merchandise_intent'));
const mascotRows = textRows.filter((row) => code(row, 'mascot_persona_reference'));
const cuteRows = textRows.filter((row) => code(row, 'cute_infantilization'));
const priceRows = textRows.filter((row) => (code(row, 'merchandise_intent') || row.semantic.directPurchase) && row.semantic.price);
const designRows = textRows.filter((row) => (code(row, 'merchandise_intent') || row.semantic.directPurchase) && row.semantic.targetToy && row.semantic.design);
const relationshipRows = textRows.filter((row) => code(row, 'relationship_shipping'));
const strictKnowledgeRows = textRows.filter((row) => hasOne(row, strictKnowledgeCodes));

const byUser = new Map();
for (const row of textRows) {
  const key = userKey(row);
  if (!key) continue;
  if (!byUser.has(key)) byUser.set(key, []);
  byUser.get(key).push(row);
}
for (const events of byUser.values()) events.sort((a, b) => (a.time?.epoch || Number.MAX_SAFE_INTEGER) - (b.time?.epoch || Number.MAX_SAFE_INTEGER));

function hasUserSignal(events, keys) { return events.some((row) => hasOne(row, keys)); }
function countUserSignal(events, predicate) { return events.filter(predicate).length; }
const segmentRows = [];
for (const [key, events] of byUser.entries()) {
  const strict = hasUserSignal(events, strictKnowledgeCodes);
  const cute = hasUserSignal(events, cuteCodes);
  const organic = hasUserSignal(events, ['relationship_shipping', 'protective_care', 'tragic_repair', 'continuation_request', 'narrative_interaction_question']);
  const purchase = events.some((row) => row.semantic.directPurchase);
  const merch = events.some((row) => code(row, 'merchandise_intent'));
  const videos = new Set(events.map((row) => row['所属视频ID']).filter(Boolean));
  const titleCount = videos.size;
  segmentRows.push({ key, events, strict, cute, organic, purchase, merch, videoCount: titleCount, commentCount: events.length, cross: titleCount >= 2 });
}
const segmentDef = [
  ['泛互动池', (user) => !user.strict && !user.cute],
  ['机制型老玩家', (user) => user.strict && !user.cute],
  ['萌化收藏型', (user) => !user.strict && user.cute],
  ['玩家粉丝混合核', (user) => user.strict && user.cute],
];
const segmentStats = segmentDef.map(([label, predicate]) => {
  const users = segmentRows.filter(predicate);
  return { label, users: users.length, cross: users.filter((user) => user.cross).length, purchase: users.filter((user) => user.purchase).length, merch: users.filter((user) => user.merch).length, avgComments: users.length ? sum(users, (user) => user.commentCount) / users.length : 0 };
});

const purchaseSequences = [];
for (const [key, events] of byUser.entries()) {
  const purchaseEvents = events.filter((row) => row.semantic.directPurchase);
  if (!purchaseEvents.length) continue;
  const firstPurchase = purchaseEvents[0];
  const prior = events.filter((row) => (row.time?.epoch || 0) < (firstPurchase.time?.epoch || 0) && !row.semantic.directPurchase);
  const priorContent = prior.filter((row) => hasOne(row, contentCodes));
  const priorCute = prior.filter((row) => hasOne(row, cuteCodes));
  const priorStrict = prior.filter((row) => hasOne(row, strictKnowledgeCodes));
  const priorOrganic = prior.filter((row) => hasOne(row, ['relationship_shipping', 'continuation_request', 'protective_care']));
  purchaseSequences.push({ key, firstPurchase, firstVisible: events[0] === firstPurchase, prior, priorContent, priorCute, priorStrict, priorOrganic, lagDays: prior.length && firstPurchase.time && prior[0].time ? (firstPurchase.time.epoch - prior[0].time.epoch) / 86400000 : null, firstVideo: events[0]?.['所属视频ID'], purchaseVideo: firstPurchase['所属视频ID'] });
}
const purchaseWithPrior = purchaseSequences.filter((row) => row.prior.length);
const median = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return 0; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

const rolePurchase = characterAliases.map(([role, re]) => {
  const rows = strictPurchaseRows.filter((row) => re.test(row.semantic.text));
  return { role, comments: rows.length, users: uniqueCount(rows), likes: sum(rows, likes), samples: rows };
}).filter((row) => row.comments).sort((a, b) => b.users - a.users || b.comments - a.comments || b.likes - a.likes);

const pairDefinitions = [
  { pair: '周瑜 × 孙策', a: /周瑜|公瑾|大嘟嘟/u, b: /孙策|伯符|孙笨/u, framing: '关系共创主线' },
  { pair: '姜维 × 钟会', a: /姜维|伯约/u, b: /钟会/u, framing: '剧情冲突与追更主线' },
  { pair: '郭嘉 × 曹操', a: /郭嘉|奉孝/u, b: /曹操|阿瞒|孟德/u, framing: '机制与君臣叙事主线' },
];
const pairStats = pairDefinitions.map((definition) => {
  const co = textRows.filter((row) => definition.a.test(row.semantic.text) && definition.b.test(row.semantic.text));
  const purchase = strictPurchaseRows.filter((row) => definition.a.test(row.semantic.text) && definition.b.test(row.semantic.text));
  const shipping = co.filter((row) => code(row, 'relationship_shipping'));
  const continuation = co.filter((row) => code(row, 'continuation_request') || /下集|后续|续作|多发|更新/u.test(row.semantic.text));
  return { pair: definition.pair, framing: definition.framing, comments: co.length, users: uniqueCount(co), shipping: shipping.length, continuation: continuation.length, purchaseUsers: uniqueCount(purchase), likes: sum(co, likes) };
});

const months = Array.from({ length: 8 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`);
const monthly = months.map((key) => {
  const rows = textRows.filter((row) => row.time?.key === key);
  const purch = rows.filter((row) => row.semantic.directPurchase);
  const toy = purch.filter((row) => row.semantic.targetToy);
  const mascot = rows.filter((row) => code(row, 'mascot_persona_reference'));
  const cute = rows.filter((row) => code(row, 'cute_infantilization'));
  return { month: key, textComments: rows.length, users: uniqueCount(rows), purchaseComments: purch.length, purchaseUsers: uniqueCount(purch), toyComments: toy.length, toyUsers: uniqueCount(toy), mascotComments: mascot.length, cuteComments: cute.length, purchasePerThousand: rows.length ? purch.length / rows.length * 1000 : 0 };
});

const byVideo = new Map();
for (const row of textRows) {
  const id = String(row['所属视频ID'] || '');
  if (!id) continue;
  if (!byVideo.has(id)) byVideo.set(id, { id, title: cleanTitle(row['所属视频标题']), url: row['所属视频URL'], rows: [] });
  byVideo.get(id).rows.push(row);
}
const videoSignals = [...byVideo.values()].map((video) => {
  const rows = video.rows;
  const purchase = rows.filter((row) => row.semantic.directPurchase);
  const toy = purchase.filter((row) => row.semantic.targetToy);
  const mascot = rows.filter((row) => code(row, 'mascot_persona_reference'));
  const cute = rows.filter((row) => code(row, 'cute_infantilization'));
  const relationship = rows.filter((row) => code(row, 'relationship_shipping'));
  return { ...video, textComments: rows.length, users: uniqueCount(rows), purchaseComments: purchase.length, purchaseUsers: uniqueCount(purchase), toyUsers: uniqueCount(toy), mascotUsers: uniqueCount(mascot), cuteUsers: uniqueCount(cute), relationshipUsers: uniqueCount(relationship), likes: sum(rows, likes) };
}).filter((row) => row.textComments > 0).sort((a, b) => b.purchaseUsers - a.purchaseUsers || b.toyUsers - a.toyUsers || b.textComments - a.textComments);

function safeEvidence(row) {
  const text = row.semantic?.text || String(row['评论内容'] || '').trim();
  return text && !forbiddenNarrative.test(text) && text.length <= 120;
}
function pickEvidence(predicate, used = new Set(), pool = strictPurchaseRows) {
  const item = pool.filter((row) => !used.has(commentId(row)) && predicate(row) && safeEvidence(row)).sort((a, b) => likes(b) - likes(a))[0];
  if (item) used.add(commentId(item));
  return item;
}
const usedEvidence = new Set();
const evidenceQuotes = [
  ['从“可爱”到“玩偶”的完整动作句', pickEvidence((row) => row.semantic.targetToy && row.semantic.cute, usedEvidence)],
  ['泛周边购买动作', pickEvidence((row) => row.semantic.generalMerch, usedEvidence)],
  ['价格条件表达', pickEvidence((row) => row.semantic.price, usedEvidence)],
  ['实体造型建议', pickEvidence((row) => row.semantic.targetToy && row.semantic.design, usedEvidence, designRows)],
  ['毛绒或挂件形态', pickEvidence((row) => /(毛绒|挂件)/u.test(row.semantic.text), usedEvidence)],
  ['购买后续追问', pickEvidence((row) => row.semantic.acquisition && row.semantic.physical, usedEvidence)],
].filter(([, row]) => row);

const evidenceLedger = [...new Map([...strictPurchaseRows, ...designRows, ...priceRows].filter(safeEvidence).map((row) => [commentId(row), row])).values()]
  .filter(safeEvidence)
  .sort((a, b) => likes(b) - likes(a))
  .map((row) => ({
    '语义类别': [row.semantic.targetToy ? '实体玩偶' : '', row.semantic.generalMerch ? '周边/数字衍生' : '', row.semantic.price ? '价格条件' : '', row.semantic.design ? '造型建议' : ''].filter(Boolean).join('；') || '直接购买',
    '评论用户昵称': row['评论用户'],
    '评论用户主页': row['评论用户URL'],
    '原始评论': row.semantic.text,
    '评论时间': row['评论时间'],
    '点赞数': likes(row),
    '视频标题': cleanTitle(row['所属视频标题']),
    '视频链接': row['所属视频URL'],
    '评论ID': commentId(row),
  }));

const coreMetrics = {
  videos: deep.coverage?.videos || 107,
  captured: rawRows.length,
  declared: Number(deep.coverage?.declaredComments || 17021),
  coverage: rawRows.length / Number(deep.coverage?.declaredComments || 17021),
  audienceComments: audience.length,
  audienceText: textRows.length,
  audienceUsers: uniqueCount(audience),
  textUsers: byUser.size,
  strictPurchaseComments: strictPurchaseRows.length,
  strictPurchaseUsers: strictPurchaseUsers.size,
  toyPurchaseComments: toyPurchaseRows.length,
  toyPurchaseUsers: uniqueCount(toyPurchaseRows),
  actionPhysicalComments: actionPhysicalRows.length,
  actionPhysicalUsers: uniqueCount(actionPhysicalRows),
  merchandiseComments: merchandiseRows.length,
  merchandiseUsers: uniqueCount(merchandiseRows),
  mascotComments: mascotRows.length,
  mascotUsers: uniqueCount(mascotRows),
  cuteComments: cuteRows.length,
  cuteUsers: uniqueCount(cuteRows),
  designComments: designRows.length,
  designUsers: uniqueCount(designRows),
  priceComments: priceRows.length,
  priceUsers: uniqueCount(priceRows),
  strictKnowledgeComments: strictKnowledgeRows.length,
  strictKnowledgeUsers: uniqueCount(strictKnowledgeRows),
  relationshipComments: relationshipRows.length,
  relationshipUsers: uniqueCount(relationshipRows),
};

function metric(label, value, note, tone = 'blue') {
  return `<article class="metric ${tone}"><strong>${value}</strong><span>${esc(label)}</span><small>${esc(note)}</small></article>`;
}
function part(id, index, title, lead, content) {
  return `<section id="${id}" class="section"><header class="part"><span>${index}</span><div><h2>${title}</h2><p>${lead}</p></div></header>${content}</section>`;
}
function dataTable(rows, columns) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(row) : esc(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function barRows(rows, getLabel, getValue, getText, tone = 'teal') {
  const max = Math.max(...rows.map((row) => Number(getValue(row) || 0)), 1);
  return `<div class="bar-list">${rows.map((row) => `<div class="bar-row"><div><span>${esc(getLabel(row))}</span><b>${getText(row)}</b></div><i><em class="${tone}" style="width:${Math.max(1.5, Number(getValue(row) || 0) / max * 100).toFixed(2)}%"></em></i></div>`).join('')}</div>`;
}
function quote(row, title) {
  if (!row) return '';
  return `<article class="quote"><div class="quote-kicker">${esc(title)}</div><blockquote>“${esc(row.semantic.text)}”</blockquote><footer><strong>${esc(row['评论用户'])}</strong><span>${esc(row['评论时间'])}</span><span>${n(likes(row))} 赞</span></footer><div class="quote-links"><a href="${esc(row['评论用户URL'])}" target="_blank" rel="noreferrer">评论用户主页</a><a href="${esc(row['所属视频URL'])}" target="_blank" rel="noreferrer">${esc(cleanTitle(row['所属视频标题']))}</a></div></article>`;
}
function signalCard(kicker, title, body, tone = 'blue') {
  return `<article class="signal ${tone}"><span>${esc(kicker)}</span><h3>${title}</h3><p>${body}</p></article>`;
}
function trendSvg(rows) {
  const width = 900, height = 300, left = 58, right = 24, top = 24, bottom = 48;
  const plotW = width - left - right, plotH = height - top - bottom;
  const max = Math.max(...rows.map((row) => row.purchaseComments), 1);
  const colW = plotW / rows.length;
  const y = (value) => top + plotH - value / max * plotH;
  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="2026年1月至8月严格购买表达与玩偶指向评论趋势">${[0,.25,.5,.75,1].map((ratio) => `<line x1="${left}" y1="${y(max * ratio)}" x2="${width - right}" y2="${y(max * ratio)}"/><text x="${left - 9}" y="${y(max * ratio) + 4}" text-anchor="end">${Math.round(max * ratio)}</text>`).join('')}${rows.map((row, index) => { const barW = Math.min(36, colW * .38); const x = left + index * colW + (colW - barW) / 2; const toyH = row.toyComments / max * plotH; const purchaseH = row.purchaseComments / max * plotH; return `<rect x="${x}" y="${top + plotH - purchaseH}" width="${barW}" height="${purchaseH}" rx="2" class="purchase"><title>${row.month}: 购买表达 ${row.purchaseComments}</title></rect><rect x="${x + 6}" y="${top + plotH - toyH}" width="${barW - 12}" height="${toyH}" rx="2" class="toy"><title>${row.month}: 玩偶指向 ${row.toyComments}</title></rect><text x="${x + barW / 2}" y="${height - 18}" text-anchor="middle">${row.month.slice(5)}月</text>`; }).join('')}<rect x="${left}" y="${height - 40}" width="12" height="12" class="purchase"/><text x="${left+18}" y="${height-30}">严格购买表达</text><rect x="${left+140}" y="${height - 40}" width="12" height="12" class="toy"/><text x="${left+158}" y="${height-30}">其中实体玩偶指向</text></svg></div>`;
}

const maxPurchaseMonth = [...monthly].sort((a, b) => b.purchaseComments - a.purchaseComments)[0];
const maxToyMonth = [...monthly].sort((a, b) => b.toyComments - a.toyComments)[0];
const firstVisiblePurchase = purchaseSequences.filter((row) => row.firstVisible).length;
const priorContentPurchase = purchaseWithPrior.filter((row) => row.priorContent.length).length;
const priorCutePurchase = purchaseWithPrior.filter((row) => row.priorCute.length).length;
const priorStrictPurchase = purchaseWithPrior.filter((row) => row.priorStrict.length).length;
const priorOrganicPurchase = purchaseWithPrior.filter((row) => row.priorOrganic.length).length;
const purchaseCrossVideo = purchaseWithPrior.filter((row) => row.firstVideo !== row.purchaseVideo).length;
const toyShare = coreMetrics.strictPurchaseComments ? coreMetrics.toyPurchaseComments / coreMetrics.strictPurchaseComments : 0;
const userToyShare = coreMetrics.strictPurchaseUsers ? coreMetrics.toyPurchaseUsers / coreMetrics.strictPurchaseUsers : 0;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>三国杀 WUHU 联盟卡宝玩偶化立项专项论证报告</title>
<style>
:root{--ink:#263137;--muted:#5f6c70;--paper:#f7f6f2;--card:#fff;--line:#dce1df;--teal:#487c7a;--sage:#8fae9c;--gold:#c5984c;--red:#b76457;--navy:#4a6276}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;line-height:1.75;font-size:15px}a{color:#23606a;text-decoration-color:#98bab7;text-underline-offset:3px}#shell{max-width:1220px;margin:auto;padding:28px 24px 72px}.cover{min-height:470px;padding:64px 58px 50px;border-radius:10px;background:#405b5d;color:#fff;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 18px 42px #233a3c29}.eyebrow{font-size:12px;letter-spacing:1.4px;opacity:.78}.cover h1{font-size:40px;line-height:1.22;letter-spacing:0;margin:20px 0 14px;max-width:900px}.cover .sub{max-width:800px;font-size:18px;opacity:.94;margin:0}.cover .meta{display:flex;flex-wrap:wrap;gap:9px;margin-top:35px}.cover .meta span{font-size:13px;padding:5px 10px;border:1px solid #ffffff66;border-radius:4px}.decision{margin-top:-45px;margin-left:26px;margin-right:26px;background:#fff;border-left:5px solid var(--gold);padding:25px 28px;box-shadow:0 10px 24px #253b3b1a}.decision h2{font-size:21px;margin:0 0 8px}.decision p{margin:0;color:#3c4b50}.decision strong{color:#8b5f1a}.toc{display:flex;flex-wrap:wrap;gap:8px;margin:32px 0}.toc a{font-size:13px;padding:5px 10px;background:#e9efed;border-radius:4px;text-decoration:none}.section{margin-top:38px;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:8px}.part{display:flex;gap:16px;align-items:flex-start;padding-bottom:17px;margin-bottom:25px;border-bottom:1px solid var(--line)}.part>span{display:grid;place-items:center;flex:0 0 36px;height:36px;border-radius:50%;background:#e6efed;color:#285d5b;font-weight:800}.part h2{font-size:25px;line-height:1.3;margin:0}.part p{color:var(--muted);margin:5px 0 0}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric{min-height:132px;padding:19px;border-radius:6px;background:#eef4f2;border-top:3px solid var(--teal)}.metric.gold{background:#fbf5e9;border-color:var(--gold)}.metric.red{background:#fbefed;border-color:var(--red)}.metric.navy{background:#edf2f5;border-color:var(--navy)}.metric strong{display:block;color:#1d5554;font-size:27px;line-height:1.1}.metric.gold strong{color:#916218}.metric.red strong{color:#9a4d43}.metric.navy strong{color:#38566e}.metric span{display:block;font-weight:700;margin-top:8px}.metric small{display:block;color:var(--muted);font-size:12px;line-height:1.5;margin-top:3px}.lead{font-size:17px;line-height:1.85}.lead strong{color:#235a59}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.signal{padding:20px;border-radius:6px;border:1px solid var(--line);border-top:4px solid var(--navy);background:#fbfcfc}.signal.teal{border-top-color:var(--teal)}.signal.gold{border-top-color:var(--gold)}.signal.red{border-top-color:var(--red)}.signal span{font-size:12px;letter-spacing:.8px;color:#657276}.signal h3{font-size:18px;line-height:1.35;margin:7px 0}.signal p{margin:0;color:#465458}.bar-list{display:grid;gap:14px}.bar-row>div{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.bar-row span{font-weight:700}.bar-row b{font-size:13px;color:#44575a;white-space:nowrap}.bar-row>i{display:block;height:9px;border-radius:6px;background:#e7ecea;margin-top:5px;overflow:hidden}.bar-row em{display:block;height:100%;border-radius:6px;background:var(--teal)}.bar-row em.gold{background:var(--gold)}.bar-row em.navy{background:var(--navy)}.quote{background:#f7f8f7;border-left:4px solid var(--sage);padding:17px 18px;margin:0}.quote-kicker{font-size:12px;color:#587475;font-weight:700;letter-spacing:.6px}.quote blockquote{font-size:17px;line-height:1.75;margin:8px 0 12px}.quote footer{display:flex;gap:10px;flex-wrap:wrap;color:#657276;font-size:12px}.quote-links{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12px}.callout{padding:22px 23px;border-radius:6px;background:#eaf2ef;border-left:4px solid var(--teal)}.callout.gold{background:#fbf4e7;border-color:var(--gold)}.callout h3{margin:0 0 8px;font-size:19px}.callout p{margin:0}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:11px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:#eef3f1;color:#405357;white-space:nowrap;font-size:12px}tr:last-child td{border-bottom:0}td.num{text-align:right;font-variant-numeric:tabular-nums}.chart{overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px;background:#fcfdfd}.chart svg{min-width:720px;width:100%;font-family:inherit}.chart line{stroke:#dce4e1;stroke-width:1}.chart text{fill:#66777a;font-size:12px}.chart .purchase{fill:#8ea9a4}.chart .toy{fill:#c3944d}.methods{font-size:13px;color:#536265}.methods li{margin:7px 0}.footer{padding:28px 10px;color:#607073;font-size:12px}.internal{font-size:12px;color:#725222;background:#fff3d8;padding:3px 7px;border-radius:3px;font-weight:700}@media(max-width:850px){#shell{padding:14px 12px 48px}.cover{min-height:410px;padding:42px 28px 36px;border-radius:7px}.cover h1{font-size:31px}.decision{margin:-25px 12px 0;padding:20px}.section{padding:23px 18px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2,.grid3{grid-template-columns:1fr}.part h2{font-size:22px}}@media(max-width:420px){body{font-size:14px}.cover h1{font-size:27px}.metrics{grid-template-columns:1fr}.metric{min-height:112px}.part{gap:10px}.part>span{flex-basis:31px;height:31px}.quote blockquote{font-size:15px}}
</style></head><body><main id="shell">
<header class="cover"><div><div class="eyebrow">INTERNAL DECISION MEMO · 2026.08.17</div><h1>三国杀 WUHU 联盟卡宝<br>玩偶化立项专项论证报告</h1><p class="sub">围绕“把卡宝做成可拥有的实体对象”建立从情感资产、玩家语境、购买动作、实体化设计、角色选择到预售验证的完整证据链。</p></div><div class="meta"><span>107 条视频</span><span>${n(coreMetrics.captured)} 条采集评论</span><span>${pct(coreMetrics.coverage, 2)} 采集覆盖</span><span>2026.01.27—2026.08.13</span><span>项目内立项材料</span></div></header>
<section class="decision"><h2>本次立项建议</h2><p>启动<strong>“卡宝实体玩偶”小批量概念验证</strong>：以卡宝视觉母版承载系列辨识，以单武将玩偶验证可拥有感，以关系双人套装承接共创内容；首轮目标集中在概念偏好、到货提醒、预售订金与价格接受度四类可量化动作。</p></section>
<nav class="toc"><a href="#decision">立项判断</a><a href="#semantic">语义证据</a><a href="#asset">情感资产</a><a href="#audience">受众结构</a><a href="#sku">SKU方向</a><a href="#time">时间趋势</a><a href="#five">五项推进</a><a href="#method">口径与复核</a></nav>

${part('decision', '01', '立项判断：玩偶诉求已经形成“情感对象 → 实体化想象 → 购买动作”的闭环', '结论先行，论证拆解到可复核的评论句式与用户层级。', `
<p class="lead">全量语料中出现 <strong>${n(coreMetrics.strictPurchaseComments)} 条直接购买表达、来自 ${n(coreMetrics.strictPurchaseUsers)} 位评论用户</strong>；其中 <strong>${n(coreMetrics.toyPurchaseComments)} 条明确指向玩偶、娃娃、毛绒、挂件、公仔、手办、盲盒或实体</strong>，占直接购买表达 ${pct(toyShare)}。进一步按“获取动作 + 实体词”复核，得到 ${n(coreMetrics.actionPhysicalComments)} 条产品动作句，来自同一组 ${n(coreMetrics.actionPhysicalUsers)} 位用户，覆盖这些用户的重复提议。购买句子的核心结构集中为“可爱 / 卡宝 / 角色形象 + 实体形态 + 想买、必买、快点出、在哪里买”等动作语言。</p>
<div class="metrics">${metric('直接购买表达', n(coreMetrics.strictPurchaseComments), `${n(coreMetrics.strictPurchaseUsers)} 位文本评论用户`, 'gold')}${metric('实体玩偶指向', n(coreMetrics.toyPurchaseComments), `${n(coreMetrics.toyPurchaseUsers)} 位用户，购买表达中的 ${pct(userToyShare)} 用户`, 'gold')}${metric('卡宝人格点名', n(coreMetrics.mascotComments), `${n(coreMetrics.mascotUsers)} 位用户把卡宝当作可互动对象`, 'teal')}${metric('萌化表达', n(coreMetrics.cuteComments), `${n(coreMetrics.cuteUsers)} 位用户形成可爱化语言`, 'teal')}</div>
<div class="grid3" style="margin-top:18px">${signalCard('资产层', '卡宝具备可拥有感的情感语法', `卡宝人格点名覆盖 ${n(coreMetrics.mascotUsers)} 位用户，萌化表达覆盖 ${n(coreMetrics.cuteUsers)} 位用户。称呼、照护、拟人、幼态与角色关系共同构成实体化的情感基础。`, 'teal')}${signalCard('需求层', '购买动作直接落在实体类别上', `严格购买表达中，${n(coreMetrics.toyPurchaseComments)} 条出现实体玩偶类别。评论同时提出“出”“买”“价格”“造型”等动作信息，内容已经进入产品语言。`, 'gold')}${signalCard('验证层', '首轮可用小样完成业务判断', '概念图、尺寸、材质、单人或双人形态、到货提醒和订金构成连续验证路径。评论表达负责筛选方向，商品动作负责形成下一轮决策数据。', 'navy')}</div>
<div class="callout gold" style="margin-top:20px"><h3>管理层应采纳的命题</h3><p>卡宝内容已经提供了实体化所需的三类资产：角色被萌化后的亲近感、玩家语境提供的长期认知与关系叙事、用户主动提出的玩偶与周边购买动作。玩偶项目具备从内容资产进入产品验证阶段的条件。</p></div>`)}

${part('semantic', '02', '语义证据：把“说到周边”拆成五种产品信息', '语义判断同时检查行动词、实体词、设计词、条件词与活动场景。每一类都保留独立分母。', `
<p>单个“周边”“可爱”“想要”词汇只构成初步线索。立项判读按一句评论的主谓宾、前后语境与已审阅开放编码共同执行：先识别用户是否在提出获取动作，再确认动作对象是否为实体物件，随后读取造型、材质、尺寸与价格条件。to签、投稿、签到等活动表达独立归入传播与共创池。下表保留每一语义簇的分母，类别允许在同一句中共同出现。</p>
<div class="grid3" style="margin:20px 0">${signalCard('语义步骤 1', '主体：谁在提出什么动作', '“想买、必买、快点出、在哪里买、做成”把评论从内容感叹推进为用户主动提出的获取或制作请求。', 'teal')}${signalCard('语义步骤 2', '对象：请求落到什么物件', '玩偶、娃娃、毛绒、挂件、公仔、手办、盲盒与实体共同构成可开发的物件类别；每类保留原句复核。', 'gold')}${signalCard('语义步骤 3', '条件：用户已经在共同定义产品', '耳朵、表情、造型、材质、尺寸和价格把需求推进到样品设计与商品决策层。', 'navy')}</div>
${dataTable([
{ name:'直接购买表达', comments:coreMetrics.strictPurchaseComments, users:coreMetrics.strictPurchaseUsers, definition:'出现购买承诺、获取追问或“出某物”的明确动作句式；全量语料的核心需求样本。', implication:'构成立项的需求下限。' },
{ name:'实体玩偶指向', comments:coreMetrics.toyPurchaseComments, users:coreMetrics.toyPurchaseUsers, definition:'直接购买表达中出现玩偶、娃娃、毛绒、挂件、公仔、手办、盲盒或实体。', implication:'优先验证卡宝实体玩偶。' },
{ name:'获取动作 × 实体词', comments:coreMetrics.actionPhysicalComments, users:coreMetrics.actionPhysicalUsers, definition:'评论同时出现“想买、必买、快点出、在哪里购买”等获取动作与实体玩偶类别；包含同一用户的重复提议。', implication:'用于追踪需求表达的复现频次。' },
{ name:'商品设计提议', comments:coreMetrics.designComments, users:coreMetrics.designUsers, definition:'实体物件同时出现耳朵、造型、做成、材质、尺寸、动作等设计语言。', implication:'进入样品共创与投票素材。' },
{ name:'价格条件', comments:coreMetrics.priceComments, users:coreMetrics.priceUsers, definition:'购买语句同时出现价格、贵、便宜、多少钱、定价等条件。', implication:'进入价格梯度测试。' },
{ name:'活动仪式', comments:textRows.filter((row)=>row.semantic.ritual).length, users:uniqueCount(textRows.filter((row)=>row.semantic.ritual)), definition:'to签、投稿、签到等活动型表达单列记录。', implication:'适合作为传播与共创机制。' },
], [{label:'语义单元',key:'name'}, {label:'评论',key:'comments',render:(r)=>`<span class="num">${n(r.comments)}</span>`}, {label:'用户',key:'users',render:(r)=>`<span class="num">${n(r.users)}</span>`}, {label:'判读规则',key:'definition'}, {label:'产品含义',key:'implication'}])}
<div class="grid2" style="margin-top:20px">${evidenceQuotes.slice(0, 2).map(([title,row])=>quote(row,title)).join('')}</div>
<div class="grid2" style="margin-top:18px">${evidenceQuotes.slice(2, 4).map(([title,row])=>quote(row,title)).join('')}</div>
<div class="callout" style="margin-top:20px"><h3>语义结论</h3><p>玩偶需求具有完整的产品表达结构：实体类别给出形态方向，购买动作给出获取意愿，造型建议给出设计参与，价格条件给出商业约束。该结构把“卡宝玩偶”推进到正式概念验证阶段，并提供了样品、价格、预约与订金的决策入口。</p></div>`)}

${part('asset', '03', '情感资产：卡宝把武将内容转写为可亲近、可照护、可收藏的对象', '三国杀语境给角色提供认知底座，卡宝语言把认知底座转化为日常陪伴与实体想象。', `
<div class="metrics">${metric('角色识别语言', n(textRows.filter((row)=>code(row,'character_recognition')).length), `${n(uniqueCount(textRows.filter((row)=>code(row,'character_recognition'))))} 位用户点名角色或别称`, 'navy')}${metric('严格玩家解码', n(coreMetrics.strictKnowledgeComments), `${n(coreMetrics.strictKnowledgeUsers)} 位用户调用机制、表字、史事或台词`, 'navy')}${metric('关系二创', n(coreMetrics.relationshipComments), `${n(coreMetrics.relationshipUsers)} 位用户参与关系叙事`, 'teal')}${metric('实体设计讨论', n(coreMetrics.designComments), `${n(coreMetrics.designUsers)} 位用户提出可用于样品开发的物件细节`, 'gold')}</div>
<p class="lead" style="margin-top:20px">卡宝已经形成持续的可爱化反应与实体想象。评论中同时出现三国杀的表字、技能、史事与台词，也出现宝宝、照顾、朋友、耳朵、娃娃等亲近语言。两套语言在同一内容宇宙里叠加：玩家用熟悉的角色知识确认人物，用萌化语言把人物转为日常可互动对象，用实体词把互动对象推进到可收藏的物件。</p>
<div class="grid3">${signalCard('玩家可信度', '机制、别称与史事让形象拥有来处', `严格玩家解码覆盖 ${n(coreMetrics.strictKnowledgeUsers)} 位用户。卖血、放逐、铁骑、表字和史事互文提供角色记忆点，适合进入吊牌文案、角色小卡、包装彩蛋。`, 'navy')}${signalCard('情感占有', '萌化语言为玩偶提供使用场景', `萌化表达覆盖 ${n(coreMetrics.cuteUsers)} 位用户。可爱、宝宝、卡宝、照护类语境天然适合毛绒、桌搭、挂件与陪伴型内容。`, 'teal')}${signalCard('共同创作', '关系叙事为双人产品提供内容接口', `关系二创覆盖 ${n(coreMetrics.relationshipUsers)} 位用户。双人关系形态适合做限定套装、双人陈列和内容连载联动；概念测试独立记录其产品选择。`, 'gold')}</div>
<div class="grid2" style="margin-top:20px">${quote(evidenceQuotes[4]?.[1], evidenceQuotes[4]?.[0] || '实体形态表达')}${quote(evidenceQuotes[5]?.[1], evidenceQuotes[5]?.[0] || '购买动作')}</div>`)}

${part('audience', '04', '受众结构：玩偶的商品语言集中在萌化收藏型与玩家粉丝混合核', '把用户按文本语境分成机制解码与萌化表达的四个可观测组合，观察每组的购买与周边表达。', `
<p>用户分群以评论中的可观测语言建立。机制型老玩家承担角色可信度与内容解释；萌化收藏型更常使用可爱、卡宝、幼态与实体化语言；玩家粉丝混合核同时拥有两套语境，具备最强的内容承接空间。分群输出聚焦评论语境、内容参与与商品表达；年龄、性别、收入和现实身份由后续用户研究模块补充。</p>
${dataTable(segmentStats, [{label:'评论语境部落',key:'label'}, {label:'文本用户',key:'users',render:(r)=>n(r.users)}, {label:'跨视频评论用户',key:'cross',render:(r)=>`${n(r.cross)} · ${pct(r.cross/r.users)}`}, {label:'周边兴趣用户',key:'merch',render:(r)=>`${n(r.merch)} · ${pct(r.merch/r.users)}`}, {label:'直接购买表达用户',key:'purchase',render:(r)=>`${n(r.purchase)} · ${pct(r.purchase/r.users)}`}, {label:'人均文本评论',key:'avgComments',render:(r)=>fixed(r.avgComments,2)}])}
<div class="grid2" style="margin-top:20px">${signalCard('商品入口', '萌化收藏型的购买表达密度最高', `萌化收藏型 ${n(segmentStats[2].users)} 人中有 ${n(segmentStats[2].purchase)} 人出现直接购买表达，比例 ${pct(segmentStats[2].purchase/segmentStats[2].users)}；周边兴趣 ${pct(segmentStats[2].merch/segmentStats[2].users)}。产品页与内容物料应优先放大可爱、陪伴、可摆放与角色识别。`, 'gold')}${signalCard('内容承接', '玩家粉丝混合核拥有最强跨视频表达', `玩家粉丝混合核 ${n(segmentStats[3].users)} 人中有 ${n(segmentStats[3].cross)} 人跨视频评论，比例 ${pct(segmentStats[3].cross/segmentStats[3].users)}。这一组适合作为概念共创、角色细节投票和首批体验官招募池。`, 'teal')}</div>
<div class="callout" style="margin-top:20px"><h3>产品沟通的双层结构</h3><p>首屏商品沟通突出卡宝的可爱与实体化形态；详情页与包装继续释放武将名、角色关系、技能彩蛋和典故。前者建立想拥有的冲动，后者积累三国杀玩家的认同与复购理由。</p></div>`)}

${part('sku', '05', 'SKU方向：先做卡宝视觉母版，再分单角色与关系套装两条线', '角色选择依据正文中的直接点名购买表达；关系选择依据共创与续作语言，二者分别承担产品任务。', `
<div class="grid2"><div>${signalCard('第一条线', '单角色卡宝玩偶：用可爱与角色识别启动购买验证', `正文直接点名的购买表达优先集中于 ${rolePurchase.slice(0,4).map((row)=>`${row.role} ${n(row.users)} 人`).join('、') || '多个角色'}。首轮以卡宝通用视觉母版配合武将特征件，减少首次开模风险，并在商品页直接询问角色偏好。`, 'gold')}</div><div>${signalCard('第二条线', '关系双人套装：用共创叙事强化收藏理由', `周瑜×孙策、姜维×钟会等关系拥有持续的共同点名、二创和续作语言。双人套装承接陈列、对话、配对和内容连载，预售页独立计算其选择与订金表现。`, 'teal')}</div></div>
<h3 style="margin-top:24px">正文直接点名的购买表达</h3>${dataTable(rolePurchase.slice(0,10), [{label:'角色',key:'role'}, {label:'购买评论',key:'comments',render:(r)=>n(r.comments)}, {label:'购买用户',key:'users',render:(r)=>n(r.users)}, {label:'评论点赞',key:'likes',render:(r)=>n(r.likes)}, {label:'产品动作',render:(r)=>`以 ${r.role} 特征件进入单角色概念图；用到货提醒与订金验证` }])}
<h3 style="margin-top:24px">关系内容资产与商品任务</h3>${dataTable(pairStats, [{label:'关系',key:'pair'}, {label:'内容任务',key:'framing'}, {label:'共同点名评论',key:'comments',render:(r)=>n(r.comments)}, {label:'共同点名用户',key:'users',render:(r)=>n(r.users)}, {label:'关系二创',key:'shipping',render:(r)=>n(r.shipping)}, {label:'续作语言',key:'continuation',render:(r)=>n(r.continuation)}, {label:'购买用户',key:'purchaseUsers',render:(r)=>n(r.purchaseUsers)}])}
<p class="methods" style="margin-top:12px">角色购买表仅计算购买评论正文中的直接点名；视频标题场景单列用于内容分析。关系表只描述语料中的共同点名、二创和续作表达，商品偏好由概念测试形成下一轮判断。</p>`)}

${part('time', '06', '时间趋势：购买表达与实体玩偶指向持续出现，峰值月份提供复盘样本', '时间轴以评论发生时点归集，呈现语料中需求语言的实际出现节奏。', `
<p>从 2026 年 5 月起，直接购买表达与实体玩偶指向进入可见评论语料；6—7 月形成集中样本。${maxPurchaseMonth.month} 的直接购买表达达到 ${n(maxPurchaseMonth.purchaseComments)} 条，${maxToyMonth.month} 的实体玩偶指向达到 ${n(maxToyMonth.toyComments)} 条。每个高点对应的内容场景、角色组合、评论上下文和作者回应可回看进入复盘库。</p>
${trendSvg(monthly)}
${dataTable(monthly, [{label:'月份',key:'month'}, {label:'文本评论',key:'textComments',render:(r)=>n(r.textComments)}, {label:'活跃评论用户',key:'users',render:(r)=>n(r.users)}, {label:'直接购买表达',key:'purchaseComments',render:(r)=>n(r.purchaseComments)}, {label:'购买表达用户',key:'purchaseUsers',render:(r)=>n(r.purchaseUsers)}, {label:'实体玩偶指向',key:'toyComments',render:(r)=>n(r.toyComments)}, {label:'每千条文本购买表达',key:'purchasePerThousand',render:(r)=>fixed(r.purchasePerThousand,1)}])}
<div class="grid2" style="margin-top:20px">${signalCard('即时需求', '首次可见文本就出现购买表达的用户', `${n(firstVisiblePurchase)} / ${n(coreMetrics.strictPurchaseUsers)} 位购买表达用户在样本内首条可见文本就给出了购买动作。这批表达适合承接到货提醒、概念投票和预约入口。`, 'gold')}${signalCard('内容培育', '先参与内容、后出现购买表达的可观测路径', `${n(purchaseWithPrior.length)} 位购买表达用户在样本内有更早的非购买互动；其中 ${n(priorContentPurchase)} 人已有内容参与、${n(priorCutePurchase)} 人已有萌化表达、${n(priorStrictPurchase)} 人已有严格玩家解码、${n(priorOrganicPurchase)} 人已有有机共创。最早的非购买互动到首次购买表达的中位间隔为 ${fixed(median(purchaseWithPrior.map((row)=>row.lagDays)),1)} 天。`, 'teal')}</div>
<p class="methods" style="margin-top:14px">评论时序展示当前可见语料内的观察路径。观看、收藏、加购、订单与支付字段进入下一轮商品实验看板。</p>`)}

${part('five', '07', '五项推进：从内容资产进入可决策的玩偶项目', '每一项都有明确输入、产出与下一步数据。五项并行推进，首轮以小样和预约数据锁定方向。', `
<div class="grid3">${signalCard('01 · 视觉母版', '定义卡宝玩偶的可识别要素', `输入：${n(coreMetrics.mascotUsers)} 位卡宝人格用户与 ${n(coreMetrics.cuteUsers)} 位萌化语言用户。产出：头身比、耳朵、表情、服饰、挂点、角色特征件的三套概念图。`, 'teal')}${signalCard('02 · 单角色小样', '从直接点名购买中选 2—3 位首发角色', `输入：正文直接点名购买的角色表。产出：同尺寸、同材质、同价格锚点的角色概念卡，记录选择、预约与订金。`, 'gold')}${signalCard('03 · 关系套装小样', '用双人陈列承接共创叙事', `输入：周瑜×孙策、姜维×钟会等关系内容资产。产出：双人套装与单人款并列展示，观察用户对陈列、剧情卡和礼盒的选择。`, 'navy')}${signalCard('04 · 价格与规格', '建立价格条件与材质偏好的试验表', `输入：${n(coreMetrics.priceUsers)} 位价格条件用户与 ${n(coreMetrics.designUsers)} 位设计建议用户。产出：三档价格、两种尺寸、两种材质的组合测试；以预约、订金和放弃原因为核心记录。`, 'gold')}${signalCard('05 · 内容发售联动', '把剧情、机制彩蛋与商品动作放进同一周节奏', `输入：角色与关系内容。产出：剧情预告、角色设定卡、投票、到货提醒、预售和晒单共创的周运营流程。`, 'teal')}</div>
<div class="callout gold" style="margin-top:20px"><h3>第一阶段决策门</h3><p>概念测试的主指标依次为：商品卡点击、角色或套装选择、到货提醒提交、预售订金、价格档选择、首批晒单与二次内容参与。每个指标按素材版本、角色、内容场景和评论语境分层记录，形成可比较的产品决策矩阵。</p></div>
<h3 style="margin-top:24px">建议的 6 周试验节奏</h3>${dataTable([
{week:'第 1 周',task:'卡宝视觉母版与 3 套概念图',metric:'概念图停留、角色投票、评论中的造型建议'},
{week:'第 2 周',task:'单角色卡宝玩偶 A/B/C',metric:'角色选择率、到货提醒提交率'},
{week:'第 3 周',task:'单人款与双人套装并列展示',metric:'套装选择率、剧情卡点击、预约率'},
{week:'第 4 周',task:'三档价格与两种尺寸测试',metric:'各档预约、放弃原因、价格提问'},
{week:'第 5 周',task:'预售页与订金机制',metric:'订金、支付完成、渠道来源'},
{week:'第 6 周',task:'晒单共创与续作内容',metric:'晒单量、二次分享、后续内容参与'}
], [{label:'阶段',key:'week'}, {label:'工作内容',key:'task'}, {label:'核心记录',key:'metric'}])}`)}

${part('method', '08', '口径、边界与内部复核', '全部结论回到同一份全量评论与逐条开放编码；项目内部可以沿证据清单复核。', `
<div class="grid2"><div><h3>数据范围</h3><ul class="methods"><li>C0 视频声明评论：${n(coreMetrics.declared)}。</li><li>C1 已采集评论：${n(coreMetrics.captured)}，覆盖率 ${pct(coreMetrics.coverage, 3)}。</li><li>C2 观众评论：${n(coreMetrics.audienceComments)}，视频作者评论单列处理。</li><li>C3 有文本观众评论：${n(coreMetrics.audienceText)}。</li><li>U1 可见评论用户：${n(coreMetrics.audienceUsers)}；U2 有文本评论用户：${n(coreMetrics.textUsers)}。</li></ul></div><div><h3>论证规则</h3><ul class="methods"><li>购买表达以动作句式和开放编码共同识别，代表评论语料中的明确表达下限。</li><li>实体玩偶指向以玩偶、娃娃、毛绒、挂件、公仔、手办、盲盒和实体词汇结合购买语境识别。</li><li>角色偏好只使用购买评论正文直接点名，视频标题单列为内容场景。</li><li>玩家关系、角色同提和官方设定分别记录；关系套装以共创与概念选择共同验证。</li><li>商品实验补充曝光、点击、预约、订金、支付、复购与售后字段，形成正式经营看板。</li></ul></div></div>
<p class="internal">内部复核材料</p><p>同目录附带《玩偶化语义证据清单（内部复核）》：保留严格购买表达的昵称、主页链接、原始评论、精确评论时间、视频出处、点赞与评论 ID。该文件用于本项目答辩和逐条核对。</p>
<p class="methods">本报告将评论用户定义为当前采集范围内可见的评论参与者。视频播放、曝光、完播、收藏、分享、关注、加购、订单和支付字段在本次源数据之外；商品实验阶段把这些字段接入统一决策口径。</p>`)}
<footer class="footer">生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })} · 数据来源：all-comments.csv、wuhu-grounded-coded-comments.csv、wuhu-mkt-deep-analysis.json · 项目内使用</footer>
</main></body></html>`;

const methods = `# 卡宝玩偶化立项专项论证：方法与复核说明

## 决策问题

本报告论证卡宝进入实体玩偶概念验证的条件，围绕情感资产、直接购买表达、实体形态、造型建议、价格条件、角色正文点名、关系共创和评论时序组织证据。

## 数据口径

- C0：视频声明评论 ${coreMetrics.declared}。
- C1：采集评论 ${coreMetrics.captured}，覆盖率 ${(coreMetrics.coverage * 100).toFixed(3)}%。
- C2：观众评论 ${coreMetrics.audienceComments}。
- C3：有文本观众评论 ${coreMetrics.audienceText}。
- U1：可见评论用户 ${coreMetrics.audienceUsers}。
- U2：有文本评论用户 ${coreMetrics.textUsers}。
- V：107 条视频。

## 语义判读

- 直接购买表达：开放编码 strict_purchase_intent，且逐句结合获取动作检查。
- 实体玩偶指向：在直接购买表达中出现玩偶、娃娃、毛绒、挂件、公仔、手办、盲盒或实体。
- 造型建议：物件语境同时出现耳朵、做成、造型、材质、尺寸、表情、配色、动作或挂件。
- 价格条件：购买语境出现价格、太贵、便宜、多少钱、多少米或定价。
- 活动仪式：to签、投稿、签到单列进入活动机制分析。

## 内部证据使用

《玩偶化语义证据清单（内部复核）》保留原始评论、昵称、主页链接、评论时点、视频出处、点赞和评论 ID，适用范围为本项目立项、内容策划和数据复核。对外材料使用匿名转述。

## 产品数据接入

评论表达用于筛选概念方向。概念测试阶段接入曝光、商品卡点击、到货提醒、角色选择、价格选择、预售订金、支付完成、取消与售后字段，按角色、单人或双人形态、价格档、材质和内容场景形成决策看板。
`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, REPORT), html, 'utf8');
fs.writeFileSync(path.join(OUT, '玩偶化立项方法与口径说明.md'), methods, 'utf8');
writeCsv(path.join(OUT, '玩偶化语义证据清单（内部复核）.csv'), evidenceLedger, Object.keys(evidenceLedger[0] || {}));
writeCsv(path.join(OUT, '玩偶化需求月度趋势.csv'), monthly, Object.keys(monthly[0]));
writeCsv(path.join(OUT, '玩偶化候选视频信号.csv'), videoSignals, ['id','title','url','textComments','users','purchaseComments','purchaseUsers','toyUsers','mascotUsers','cuteUsers','relationshipUsers','likes']);

const metricsJson = { generatedAt: new Date().toISOString(), coreMetrics, semantic: {
  strictPurchaseComments: strictPurchaseRows.length, strictPurchaseUsers: strictPurchaseUsers.size, toyPurchaseComments: toyPurchaseRows.length, toyPurchaseUsers: uniqueCount(toyPurchaseRows), actionPhysicalComments: actionPhysicalRows.length, actionPhysicalUsers: uniqueCount(actionPhysicalRows), priceComments: priceRows.length, priceUsers: uniqueCount(priceRows), designComments: designRows.length, designUsers: uniqueCount(designRows),
}, segmentStats, rolePurchase: rolePurchase.map(({samples, ...row}) => row), pairStats, monthly, purchaseSequence: {
  totalUsers: purchaseSequences.length, firstVisiblePurchase, priorNonPurchase: purchaseWithPrior.length, priorContentPurchase, priorCutePurchase, priorStrictPurchase, priorOrganicPurchase, crossVideoPurchase: purchaseCrossVideo, medianLagDays: median(purchaseWithPrior.map((row) => row.lagDays)),
}, evidenceRows: evidenceLedger.length };
fs.writeFileSync(path.join(OUT, '玩偶化立项指标与语义分析.json'), JSON.stringify(metricsJson, null, 2), 'utf8');

const sourceFiles = [RAW, CODED, DEEP];
const files = fs.readdirSync(OUT).filter((file) => file !== 'artifact-manifest.json').map((file) => ({ file, bytes: fs.statSync(path.join(OUT, file)).size, sha256: hash(path.join(OUT, file)) }));
const manifest = { generatedAt: new Date().toISOString(), report: REPORT, sources: sourceFiles.map((file) => ({ file, bytes: fs.statSync(file).size, sha256: hash(file) })), files };
fs.writeFileSync(path.join(OUT, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ output: OUT, report: path.join(OUT, REPORT), metrics: coreMetrics, evidenceRows: evidenceLedger.length, htmlBytes: fs.statSync(path.join(OUT, REPORT)).size }, null, 2));
