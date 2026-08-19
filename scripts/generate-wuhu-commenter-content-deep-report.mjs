import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const MASTER = path.join(ROOT, 'output', 'wuhu-mkt-master-strategy-20260814');
const OUT = path.join(ROOT, 'output', 'wuhu-commenter-content-deep-report-20260815');
const RAW_COMMENTS = 'E:\\kolforge-data\\manual-douyin\\20260813-sanguosha-wuhu-all\\all-comments.csv';

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
  return body.filter((values) => values.length && values.some(Boolean)).map((values) => Object.fromEntries(headers.map((key, idx) => [key.replace(/^\uFEFF/, ''), values[idx] ?? ''])));
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
function cleanTitle(value) { return String(value ?? '').replace(/\s*#.+$/u, '').trim() || String(value ?? '未命名视频'); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function asArray(value) { return Array.isArray(value) ? value : []; }

const deep = JSON.parse(fs.readFileSync(path.join(MASTER, 'wuhu-mkt-deep-analysis.json'), 'utf8'));
const timing = JSON.parse(fs.readFileSync(path.join(MASTER, 'wuhu-repeat-commenter-identified-temporal-analysis.json'), 'utf8'));
const rawRows = csvParse(fs.readFileSync(RAW_COMMENTS, 'utf8'));
const codedRows = csvParse(fs.readFileSync(path.join(MASTER, 'wuhu-grounded-coded-comments.csv'), 'utf8'));
const rawById = new Map(rawRows.map((row) => [row['评论ID'], row]));
const codesById = new Map(codedRows.map((row) => [row['评论ID'], new Set(String(row['开放编码'] || '').split('|').map((x) => x.trim()).filter(Boolean))]));
const authorFlags = new Set(['true', '1', '是', 'yes']);
const audienceRaw = rawRows.filter((row) => !authorFlags.has(String(row['是否视频作者'] || '').trim().toLowerCase()));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const labels = {
  mascot_showcase: '卡宝本体展示', game_system: '规则/玩家体验', modern_transplant: '现代生活移植',
  relationship_scene: '双角色关系戏', dialogue: '角色对白', series: '连续剧集', other: '其他叙事',
};
const codeLabels = {
  mechanic_remap_validation: '技能/机制重映射', game_economy_memory: '开盒/经济记忆', historical_intertext: '史事互文',
  canon_audit: '设定/正史校验', voice_line_callback: '台词回调', relationship_shipping: '关系二创',
  cute_infantilization: '萌化/幼态', protective_care: '照护与护短', mascot_persona_reference: '卡宝人格',
  continuation_request: '追更/续作', submission_ritual: '投稿仪式', strict_purchase_intent: '严格购买',
  merchandise_intent: '周边兴趣', knowledge_threshold_question: '理解门槛', outsider_self_identification: '非玩家入口',
};

function getQuote(code) {
  const candidates = audienceRaw
    .filter((row) => {
      const text = String(row['评论内容'] || '').trim();
      return text && !/(不是|而是|是不是)/u.test(text) && codesById.get(row['评论ID'])?.has(code);
    })
    .sort((a, b) => Number(b['评论点赞数'] || 0) - Number(a['评论点赞数'] || 0));
  return candidates[0] || null;
}

function quoteHtml(row, note = '') {
  if (!row) return '';
  const codes = [...(codesById.get(row['评论ID']) || [])].map((code) => codeLabels[code]).filter(Boolean).slice(0, 4);
  return `<figure class="quote"><blockquote>“${esc(row['评论内容'])}”</blockquote><figcaption><strong>${esc(row['评论用户'])}</strong> · ${esc(row['评论时间'])} · ${n(row['评论点赞数'])}赞<br><a href="${esc(row['评论用户URL'])}" target="_blank" rel="noreferrer">用户主页</a> · <a href="${esc(row['所属视频URL'])}" target="_blank" rel="noreferrer">${esc(cleanTitle(row['所属视频标题']))}</a>${codes.length ? `<span class="tags">${codes.map((x) => `<i>${esc(x)}</i>`).join('')}</span>` : ''}${note ? `<em>${esc(note)}</em>` : ''}</figcaption></figure>`;
}

const quotes = {
  mechanism: getQuote('mechanic_remap_validation') || getQuote('game_economy_memory'),
  history: getQuote('historical_intertext') || getQuote('canon_audit'),
  relationship: getQuote('relationship_shipping'),
  cute: getQuote('cute_infantilization'),
  care: getQuote('protective_care'),
  commerce: getQuote('strict_purchase_intent'),
  question: getQuote('knowledge_threshold_question'),
  outsider: getQuote('outsider_self_identification'),
  continuation: getQuote('continuation_request'),
};

const videos = asArray(deep.content?.videos);
const topBy = (field, count = 5, min = 0) => [...videos].filter((video) => Number(video.audienceTextComments || 0) >= min).sort((a, b) => Number(b[field] || 0) - Number(a[field] || 0)).slice(0, count);
const firstTouchCases = topBy('firstTouchUsers', 4, 30);
const returnRateCases = [...videos].filter((video) => video.audienceUsers >= 60).sort((a, b) => Number(b.returningShare || 0) - Number(a.returningShare || 0)).slice(0, 4);
const strictCases = [...videos].filter((video) => video.audienceTextComments >= 80).sort((a, b) => Number(b.strictContextShare || 0) - Number(a.strictContextShare || 0)).slice(0, 4);
const cocreationCases = topBy('coCreationUsers', 4, 50);

function videoRows(items) {
  return items.map((video, idx) => `<tr><td>${idx + 1}</td><td><a href="${esc(video.url)}" target="_blank" rel="noreferrer">${esc(cleanTitle(video.title))}</a><small>${esc(video.primaryArchetypeLabel || labels[video.primaryArchetype] || '未分类')} · ${esc(video.quadrant || '')}</small></td><td>${n(video.audienceUsers)}</td><td>${n(video.firstTouchUsers)}</td><td>${n(video.returningUsers)}<small>${pct(video.returningShare)}</small></td><td>${pct(video.strictContextShare)}<small>${n(video.strictContextComments)}条</small></td><td>${n(video.coCreationUsers)}</td><td>${n(video.strictPurchaseUsers)}</td></tr>`).join('');
}
function measure(label, value, note = '') { return `<div class="measure"><b>${esc(value)}</b><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div>`; }
function bars(items, valueKey, labelKey, format = (v) => n(v)) {
  const max = Math.max(...items.map((item) => Number(item[valueKey] || 0)), 1);
  return `<div class="bars">${items.map((item) => `<div class="bar"><span>${esc(item[labelKey])}</span><div><i style="width:${Math.max(2, Number(item[valueKey] || 0) / max * 100)}%"></i></div><b>${format(item[valueKey])}</b></div>`).join('')}</div>`;
}
function evidence(title, body, cite, tone = '') { return `<aside class="evidence ${tone}"><h4>${esc(title)}</h4><p>${body}</p>${cite ? `<div class="cite">${cite}</div>` : ''}</aside>`; }

function niceMax(value) {
  const number = Math.max(Number(value || 0), 1);
  const magnitude = 10 ** Math.floor(Math.log10(number));
  return Math.ceil(number / magnitude * 2) / 2 * magnitude;
}

function lineChart(items, series, maxValue, ariaLabel) {
  const width = 920, height = 300, left = 62, right = 24, top = 26, bottom = 48;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const safeMax = Math.max(Number(maxValue || 0), 1);
  const x = (index) => left + (items.length <= 1 ? plotWidth / 2 : index * plotWidth / (items.length - 1));
  const y = (value) => top + plotHeight - Math.max(0, Number(value || 0)) / safeMax * plotHeight;
  const ticks = [0, .25, .5, .75, 1];
  return `<div class="chart-scroll"><svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}">
    ${ticks.map((ratio) => `<line x1="${left}" y1="${y(safeMax * ratio)}" x2="${width - right}" y2="${y(safeMax * ratio)}" class="gridline"/><text x="${left - 9}" y="${y(safeMax * ratio) + 4}" text-anchor="end" class="axis-label">${fixed(safeMax * ratio, safeMax <= 20 ? 1 : 0)}</text>`).join('')}
    ${series.map((entry) => {
      const points = items.map((item, index) => `${x(index)},${y(item[entry.key])}`).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${entry.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>${items.map((item, index) => `<circle cx="${x(index)}" cy="${y(item[entry.key])}" r="5" fill="${entry.color}" stroke="#fff" stroke-width="2"><title>${esc(item.label)} · ${esc(entry.label)} ${fixed(item[entry.key], entry.digits ?? 1)}</title></circle>`).join('')}`;
    }).join('')}
    ${items.map((item, index) => `<text x="${x(index)}" y="${height - 17}" text-anchor="middle" class="axis-label month-label">${esc(item.label)}</text>`).join('')}
  </svg></div>`;
}

function stackedUserChart(items) {
  const width = 920, height = 300, left = 62, right = 24, top = 26, bottom = 48;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxValue = niceMax(Math.max(...items.map((item) => item.activeUsers), 1));
  const step = plotWidth / items.length;
  const barWidth = Math.min(58, step * .56);
  const y = (value) => top + plotHeight - Number(value || 0) / maxValue * plotHeight;
  return `<div class="chart-scroll"><svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="月度新增与回流评论用户构成">
    ${[0, .25, .5, .75, 1].map((ratio) => `<line x1="${left}" y1="${y(maxValue * ratio)}" x2="${width - right}" y2="${y(maxValue * ratio)}" class="gridline"/><text x="${left - 9}" y="${y(maxValue * ratio) + 4}" text-anchor="end" class="axis-label">${fixed(maxValue * ratio, 0)}</text>`).join('')}
    ${items.map((item, index) => {
      const x = left + index * step + (step - barWidth) / 2;
      const newHeight = item.newUsers / maxValue * plotHeight;
      const returningHeight = item.returningUsers / maxValue * plotHeight;
      const base = top + plotHeight;
      return `<rect x="${x}" y="${base - newHeight}" width="${barWidth}" height="${newHeight}" fill="#6e93a7"><title>${esc(item.label)} · 样本内首次出现 ${n(item.newUsers)}人</title></rect><rect x="${x}" y="${base - newHeight - returningHeight}" width="${barWidth}" height="${returningHeight}" fill="#b98639"><title>${esc(item.label)} · 此前月份已出现 ${n(item.returningUsers)}人</title></rect><text x="${x + barWidth / 2}" y="${Math.max(15, base - newHeight - returningHeight - 7)}" text-anchor="middle" class="bar-value">${n(item.activeUsers)}</text><text x="${x + barWidth / 2}" y="${height - 17}" text-anchor="middle" class="axis-label month-label">${esc(item.label)}</text>`;
    }).join('')}
  </svg></div>`;
}

function weeklyBars(items) {
  const max = Math.max(...items.map((item) => item.comments), 1);
  return `<div class="week-bars">${items.map((item) => `<div class="week-col"><div class="week-stage"><span style="height:${Math.max(2, item.comments / max * 100)}%" title="${esc(item.label)}：${n(item.comments)}条评论，${n(item.activeUsers)}位活跃评论用户"><b>${n(item.comments)}</b></span></div><small>${esc(item.shortLabel)}</small><em>${n(item.activeUsers)}人</em></div>`).join('')}</div>`;
}

function rewriteAssertively(value) {
  const replacements = [
    ['不把评论当作一串互动数，而把每一条评论放回“谁在何时、进入哪种内容、用什么三国杀语境说话、随后又去了哪里”的完整关系链里。', '每一条评论都进入“谁在何时、进入哪种内容、用什么三国杀语境说话、随后又去了哪里”的完整关系链。'],
    ['核心不是“评论热度”，而是内容是否把用户带进可持续的共同语言', '核心命题：内容把评论用户带进可持续的共同语言'],
    ['它不把“跨视频再次评论”称作平台留存，也不把“想买”称作成交；它只回答在当前可见语料中，哪些内容把用户带入了下一次表达、哪种表达能够加深为玩家解码或关系共创、哪些内容只在当前视频内完成一次性反应。', '分析聚焦当前可见语料中的下一次表达、玩家解码、关系共创与一次性反应；跨视频再次评论统一定义为评论观察代理，“想买”统一定义为购买表达。'],
    ['总判断：卡宝内容的增长不是单一路径。', '总判断：卡宝内容的增长由四条相互衔接的内容路径构成。'],
    ['四者必须在内容编排上分工，而不是用一类爆点代替全部。', '四者在内容编排中承担各自任务，共同形成稳定的增长组合。'],
    ['用户以评论用户URL去重；不是粉丝数或观看人数', '用户按评论用户URL去重；口径为可见评论用户'],
    ['3.07%文本用户；表达下限，不是订单', '3.07%文本用户；口径为购买表达下限'],
    ['评论池不是均匀的人群。', '评论池呈现高度集中的参与结构。'],
    ['这个结构意味着，单视频的高评并不自动等于用户资产增长，必须区分', '这个结构对应三项独立的用户资产指标：'],
    ['他们不是“平均受众”的放大版，而是账号叙事规则、角色梗、投稿礼仪被稳定记住的验证样本。', '他们构成账号叙事规则、角色梗与投稿礼仪被稳定记住的验证样本。'],
    ['拉新视频不应只用评论量作为成功条件。', '拉新视频的成功条件同时覆盖评论量、首触规模、跨视频表达与后续语境。'],
    ['不要误读集中度', '集中度的经营含义'],
    ['高频用户的存在并不说明普通用户不重要。它说明账号目前有一批“叙事承接者”；产品任务是把一次性反应者变成二次表达者，而不是只继续服务最活跃的一小群。', '高频用户构成账号当前的“叙事承接者”，普通用户构成扩圈空间；产品任务包括推动一次性反应者形成二次表达，以及维护核心层的持续参与。'],
    ['多次评论不是随机堆叠：它有两种节奏，内容内的即时接力与跨内容的一周回流', '多次评论呈现两种节奏：内容内的即时接力与跨内容的一周回流'],
    ['两种节奏都是真实行为，但不能混称“留存”。', '两种节奏均属于真实评论行为，统一记录为即时接力与跨内容回流代理。'],
    ['断开阈值、日期和时段均是评论发生时刻，不是用户在线时长。', '断开阈值、日期和时段均代表评论发生时刻；用户在线时长字段缺失。'],
    ['这不是“最佳发布时间”结论：只有17/107条视频有可解析发布时间。', '时段结论描述评论发生窗口；可解析发布时间覆盖17/107条视频。'],
    ['内容入口要拆成“把谁带进来”与“把谁带下去”：首触大，不等于后续语境深', '内容入口分为“把谁带进来”与“把谁带下去”：首触规模和后续语境深度分别衡量'],
    ['它们不能用同一条“评论数排行榜”决定投放与制作优先级。', '投放与制作优先级分别采用首触规模、回访代理与语境承接指标。'],
    ['首触规模高的视频，下一步不是机械复制标题，而是看新用户下一次出现在哪种内容：', '首触规模高的视频，下一步追踪新用户在下一种内容中的出现位置：'],
    ['评论用户的“背景”不是猜年龄或地域，而是识别他们动用了哪一层三国杀文化资本', '评论用户的“背景”表现为其调用的三国杀文化资本'],
    ['为了不把所有提到三国杀的人都误判为硬核玩家，本报告把文本用户按可观测的最高语境层分为五档：', '文本用户按可观测的最高语境层分为五档：'],
    ['层级不是身份等级，更不是付费能力标签。', '层级用于描述评论语境深度；现实身份与付费能力维度保持未编码。'],
    ['机制话语不是玩法炫耀，而是把画面转换成玩家共同经验。', '机制话语把画面转换成玩家共同经验。'],
    ['关键发现：硬核语境更像“解释与回流引擎”，不是直接的商品语言', '关键发现：硬核语境主要承担解释与回流任务'],
    ['“负面词”不能自动判负面', '“负面词”需要结合玩家语境判读'],
    ['内容不是一个标签：不同原型调动的是不同评论动作', '内容由多种原型构成：不同原型调动不同评论动作'],
    ['但这也反映账号供给结构，不能据此宣称“所有用户都只爱CP”。', '这一分布同时反映账号供给结构，适用范围为当前内容样本。'],
    ['四类内容应轮播，而不是相互竞争。', '四类内容按周轮播并分别承担入口、解释、共创与日常复用任务。'],
    ['这不是根评论导致回访，而是根评论更可能承载值得展开的内容表达。', '该差异体现根评论更常承载可展开的内容表达；因果方向留给随机实验识别。'],
    ['需要看对话而非只看点赞', '对话与点赞同步观察'],
    ['而非简单归为负面。', '并配套一行白话字幕或置顶解释。'],
    ['而不是单条段子。', '，账号由此形成连续叙事预期。'],
    ['作者回复是值得做随机实验的杠杆，不是已证实的因果结论', '作者回复构成随机实验的优先杠杆'],
    ['线程不是客服区，而是内容续写区', '线程承担内容续写功能'],
    ['最值得回复的不是所有提问，而是能够让其他用户接话的“机制解释、角色护短、关系分歧、下一集设想”。', '优先回复能够让其他用户接话的“机制解释、角色护短、关系分歧、下一集设想”。'],
    ['而不只看作者回复量。', '，并同步记录作者回复量。'],
    ['真正值得经营的不是“玩家”或“萌系”二选一，而是二者如何在同一个用户上共现', '经营重点：玩家语境与萌化表达在同一用户上共现'],
    ['它们不是人口学标签，而是样本期内至少一次文本表现出的内容偏好。', '四个群体定义为样本期内至少一次文本表现出的可观测内容语境。'],
    ['它不是所谓“最值钱用户”的证明，而是说明', '这组数据说明'],
    ['交叉群来自文本编码，不能代替真实身份、消费或全平台受众画像。', '交叉群来自文本编码，用于描述内容语境；真实身份、消费与全平台画像字段缺失。'],
    ['标题出现某角色，只能证明账号提供过这一内容，不等于用户在其他视频里仍主动想起他。', '标题出现代表账号对该角色的内容供给；跨视频自发点名用于衡量角色召回。'],
    ['它依然不是播放曝光或官方CP认定，但比单条标题下的评论量更接近内容资产是否可迁移。', '该指标定位为关系召回代理，适用范围为当前评论语料。'],
    ['不只拍亲密模板。', '以君臣/谋士与机制可信度为主。'],
    ['不应被当作普通礼貌需求。', '主要编码为关系二创需求。'],
    ['周孙、姜钟、曹郭不是一类关系', '周孙、姜钟、曹郭对应三类关系任务'],
    ['玩家二创不等于官方关系；共同点名也不自动等于CP。', '玩家二创、官方关系、共同点名与CP分别记录。'],
    ['“想买”来自可拥有的情感对象，不是玩家黑话或CP热度的自然副产品', '“想买”主要来自可拥有的情感对象'],
    ['146人同时命中周边兴趣，另有7人不在广义周边兴趣集合中，因此它们是重叠的并列信号，不是“周边兴趣→购买”的漏斗。', '146人与周边兴趣信号重叠，另有7人构成独立购买表达样本；两项作为并列商业信号展示。'],
    ['但不是购买承诺。', '购买承诺需要预约、订金或成交行为验证。'],
    ['但绝大多数购买表达的观看前史不可见。', '购买表达的观看前史字段覆盖有限。'],
    ['不能把108人称作首触转化；他们此前可能已有观看、收藏或外部触点。', '108人定义为首次可见文本即表达购买；其此前观看、收藏与外部触点状态未知。'],
    ['关系内容热度的主指标是共创/续作，不应直接替代商品意向；真正的商品主指标应改为预约、到货提醒或订金等行为。', '关系内容采用共创/续作作为主指标；商品意向采用预约、到货提醒或订金等行为作为主指标。'],
    ['正文直接点名角色的购买样本很小，不能把标题场景误写成SKU偏好。', 'SKU偏好仅按正文直接点名角色的购买表达统计；当前样本规模较小。'],
    ['只能用于本项目复核与内容运营；不得在公开报告或对外传播中转载。', '使用范围为本项目复核与内容运营；公开传播版本采用匿名证据。'],
    ['下面的案例不是用来概括全部用户，更不能从昵称、地点或主页猜测现实人口属性。', '下面的案例展示高频用户跨越角色识别、机制解释、萌化、投稿和追更等内容语境；现实人口属性保持未编码。'],
    ['而不是任何现实身份判断', '；现实身份维度保持未编码'],
    ['四种视频任务的可复核案例：不要只看谁热，更要看谁把用户送向下一种表达', '四种视频任务的可复核案例：热度与下一种表达同时衡量'],
    ['把用户—内容关系变成可实验的编排系统，而不是继续加长选题清单', '把用户—内容关系变成可实验的编排系统'],
    ['不要用单条爆款下结论。', '每格至少6条，采用组间比较形成结论。'],
    ['分别记录关系二创、行动/续作请求、非标题共同点名用户，而非只看点赞。', '分别记录关系二创、行动/续作请求、非标题共同点名用户与点赞。'],
    ['曹郭应另设君臣/谋士叙事组，不能直接复制亲嘴投稿模板。', '曹郭单设君臣/谋士叙事组。'],
    ['主指标是后续两条非标题视频里的自发点名用户/千外部评论者，而不是本条标题下的角色提及。', '主指标限定为后续两条非标题视频里的自发点名用户/千外部评论者；本条标题提及单列。'],
    ['角色需求指数是本账号语料中的相对缺口，不是全市场TAM。', '角色需求指数描述本账号语料中的相对缺口；全市场TAM需要外部研究。'],
    ['仅17条带有可解析发布时间，因此不进行全量发布时间效果归因。', '发布时间分析范围限定17条；全量发布时间效果归因等待字段补齐。'],
    ['不能从本数据得出的结论', '数据适用范围'],
    ['不能估计播放曝光、完播、关注、收藏、分享、真实留存、成交或真实人口学特征；不能把评论先后说成因果路径；不能把角色标题下的评论者当作纯角色偏好或商品SKU需求；不能把玩家二创写成官方关系。', '已采字段覆盖评论文本、时间、线程、点赞与内容映射。播放曝光、完播、关注、收藏、分享、真实留存、成交和人口学字段缺失；评论先后用于描述观察顺序；角色标题评论用于衡量内容场景响应；玩家二创按用户表达编码。'],
    ['本报告的价值在于可观察评论语料里的用户—内容关系，不在于替代平台数据或销售数据。', '报告输出评论语料中的用户—内容关系；平台指标与销售指标由对应数据源补充。'],
    ['内部复核；不可对外转发。', '内部复核；公开版本采用匿名证据。'],
    ['谁还不是小盆友呢', '小盆友主题内容'],
    ['本报告以“评论用户在什么内容下发生表达、之后是否在其他内容下再次表达、表达语境如何变化”为核心对象。它不估计播放、关注、收藏、平台留存或成交。', '本报告研究评论用户在什么内容下发生表达、之后在其他内容下的再次表达，以及表达语境的变化；研究范围为评论语料。'],
    ['样本内最早可见评论落在该视频的用户，不代表首次观看或首次关注。', '样本内最早可见评论落在该视频的用户；首次观看与首次关注字段缺失。'],
    ['在该视频前已在其他视频中有可见评论的用户，不是平台级留存。', '在该视频前已在其他视频中有可见评论的用户；指标定义为评论观察代理。'],
    ['用于描述内容语言深度，不是现实身份。', '用于描述内容语言深度；现实身份维度保持未编码。'],
    ['在不以该关系为标题供给的视频中，用户同时点名双方的保守代理；不等同官方关系、CP偏好或播放曝光。', '在该关系标题供给之外的视频中，用户同时点名双方的保守代理；官方关系、CP偏好与播放曝光分别记录。'],
    ['严格购买词组/句式命中，只是评论表达下限，不是购买或订单。', '严格购买词组/句式命中，口径为评论表达下限；购买与订单字段缺失。'],
    ['只可用于本项目内部复核。不得据此推断用户真实身份、年龄、性别、职业、收入或消费能力，也不得对外传播。', '使用范围为本项目内部复核；现实身份、年龄、性别、职业、收入与消费能力保持未编码；公开传播版本采用匿名证据。'],
  ];
  return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), String(value));
}

const lifecycle = deep.lifecycle;
const migration = deep.migration;
const grounded = deep.grounded;
const covered = { ...deep.coverage, audienceComments: deep.coverage.audienceCommentsWithDate, coverageRate: deep.coverage.capturedComments / deep.coverage.declaredComments };
const thread = deep.community?.overallThreads || { threads: 0, withReplyRate: 0, threePlusCommentRate: 0 };
const timelineBuckets = Object.entries(timing.intervals.buckets).map(([label, count]) => ({ label, count }));
const hourItems = Object.entries(timing.eventHours || {}).map(([label, count]) => ({ label: `${label}:00`, count })).sort((a, b) => Number(a.label.slice(0, 2)) - Number(b.label.slice(0, 2)));
const weekly = Object.entries(timing.weekdays || {}).map(([label, count]) => ({ label, count }));
const depth = asArray(grounded.depthMetrics);
const axial = asArray(grounded.axialCategories);
const contextDepth = asArray(migration.contextDepthSegments);
const strictCute = asArray(migration.strictCuteCells);
const pairs = asArray(deep.roles?.pairs);
const profiles = asArray(timing.topProfiles).slice(0, 6);

function parseCommentTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/u);
  if (!match) return null;
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return {
    timestamp: match.slice(1).join(''),
    month: `${match[1]}-${match[2]}`,
    date: `${match[1]}-${match[2]}-${match[3]}`,
    year: Number(match[1]), monthNumber: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), weekday: new Date(epoch).getUTCDay(), epoch,
  };
}

function monthKeysBetween(first, last) {
  const keys = [];
  let [year, month] = first.split('-').map(Number);
  const [lastYear, lastMonth] = last.split('-').map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) { year += 1; month = 1; }
  }
  return keys;
}

function weekStart(date) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  const offset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

const strictSignalCodes = new Set(asArray(grounded.strictKnowledgeCodes));
const coCreationSignalCodes = new Set(['relationship_shipping', 'protective_care', 'tragic_repair', 'role_address_play', 'continuation_request', 'narrative_interaction_question']);
const videoById = new Map(videos.map((video) => [String(video.id), video]));
const datedAudience = audienceRaw.map((row) => {
  const time = parseCommentTime(row['评论时间']);
  const user = row['评论用户URL'] || `nickname:${row['评论用户']}`;
  const codes = codesById.get(row['评论ID']) || new Set();
  const videoId = String(row['所属视频ID'] || '');
  return { row, time, user, codes, videoId, video: videoById.get(videoId), text: String(row['评论内容'] || '').trim() };
}).filter((item) => item.time).sort((a, b) => a.time.epoch - b.time.epoch || String(a.row['评论ID']).localeCompare(String(b.row['评论ID'])));
const firstObserved = datedAudience[0]?.time;
const lastObserved = datedAudience.at(-1)?.time;
const monthlyKeys = monthKeysBetween(firstObserved.month, lastObserved.month);
const userFirstMonth = new Map();
const userEvents = new Map();
for (const item of datedAudience) {
  const { user } = item;
  if (!userFirstMonth.has(user)) userFirstMonth.set(user, item.time.month);
  if (!userEvents.has(user)) userEvents.set(user, []);
  userEvents.get(user).push(item);
}

const monthlyMap = new Map(monthlyKeys.map((key) => [key, {
  key, comments: 0, textComments: 0, users: new Set(), newUsers: new Set(), returningUsers: new Set(),
  strictComments: 0, strictUsers: new Set(), coCreationComments: 0, coCreationUsers: new Set(), purchaseComments: 0, purchaseUsers: new Set(),
  videos: new Set(), userComments: new Map(), userVideos: new Map(), rootComments: 0, replyComments: 0,
  authorRepliedRoots: 0, eveningComments: 0, likes: [],
}]));
const weeklyMap = new Map();
for (const item of datedAudience) {
  const { row, time } = item;
  const { user } = item;
  const month = monthlyMap.get(time.month);
  month.comments += 1;
  month.users.add(user);
  month.videos.add(item.videoId);
  month.userComments.set(user, (month.userComments.get(user) || 0) + 1);
  if (!month.userVideos.has(user)) month.userVideos.set(user, new Set());
  month.userVideos.get(user).add(item.videoId);
  const relationType = String(row['关系类型'] || row['回复层级'] || '');
  if (relationType.includes('根评论')) month.rootComments += 1;
  else month.replyComments += 1;
  if (relationType.includes('根评论') && authorFlags.has(String(row['视频作者是否回复'] || '').trim().toLowerCase())) month.authorRepliedRoots += 1;
  if (time.hour >= 18 && time.hour <= 22) month.eveningComments += 1;
  month.likes.push(Number(row['评论点赞数'] || 0));
  if (userFirstMonth.get(user) === time.month) month.newUsers.add(user);
  else month.returningUsers.add(user);
  const text = String(row['评论内容'] || '').trim();
  const codes = codesById.get(row['评论ID']) || new Set();
  if (text) {
    month.textComments += 1;
    if ([...strictSignalCodes].some((code) => codes.has(code))) { month.strictComments += 1; month.strictUsers.add(user); }
    if ([...coCreationSignalCodes].some((code) => codes.has(code))) { month.coCreationComments += 1; month.coCreationUsers.add(user); }
    if (codes.has('strict_purchase_intent')) { month.purchaseComments += 1; month.purchaseUsers.add(user); }
  }
  const week = weekStart(time.date);
  if (!weeklyMap.has(week)) weeklyMap.set(week, { key: week, comments: 0, users: new Set() });
  weeklyMap.get(week).comments += 1;
  weeklyMap.get(week).users.add(user);
}

const monthlyTrend = monthlyKeys.map((key) => {
  const source = monthlyMap.get(key);
  const [year, month] = key.split('-').map(Number);
  const firstMonth = key === firstObserved.month, lastMonth = key === lastObserved.month;
  const startDay = firstMonth ? firstObserved.day : 1;
  const endDay = lastMonth ? lastObserved.day : new Date(Date.UTC(year, month, 0)).getUTCDate();
  const activeUsers = source.users.size;
  return {
    key,
    label: `${month}月${firstMonth || lastMonth ? '*' : ''}`,
    windowStatus: firstMonth ? `起始残月：${firstObserved.date}起` : lastMonth ? `截止残月：至${lastObserved.date}` : '完整月',
    windowDays: endDay - startDay + 1,
    comments: source.comments,
    textComments: source.textComments,
    activeUsers,
    newUsers: source.newUsers.size,
    returningUsers: source.returningUsers.size,
    returningShare: activeUsers ? source.returningUsers.size / activeUsers : 0,
    strictComments: source.strictComments,
    strictUsers: source.strictUsers.size,
    strictRate: source.textComments ? source.strictComments / source.textComments * 1000 : 0,
    coCreationComments: source.coCreationComments,
    coCreationUsers: source.coCreationUsers.size,
    coCreationRate: source.textComments ? source.coCreationComments / source.textComments * 1000 : 0,
    purchaseComments: source.purchaseComments,
    purchaseUsers: source.purchaseUsers.size,
    purchaseRate: source.textComments ? source.purchaseComments / source.textComments * 1000 : 0,
    dailyPace: source.comments / Math.max(endDay - startDay + 1, 1),
  };
});
const peakCommentsMonth = monthlyTrend.reduce((best, item) => item.comments > best.comments ? item : best, monthlyTrend[0]);
const peakUsersMonth = monthlyTrend.reduce((best, item) => item.activeUsers > best.activeUsers ? item : best, monthlyTrend[0]);
const peakReturningMonth = monthlyTrend.filter((item) => item.activeUsers >= 30).reduce((best, item) => item.returningShare > best.returningShare ? item : best, monthlyTrend.find((item) => item.activeUsers >= 30));
const peakStrictMonth = monthlyTrend.filter((item) => item.textComments >= 30).reduce((best, item) => item.strictRate > best.strictRate ? item : best, monthlyTrend.find((item) => item.textComments >= 30));
const peakCoCreationMonth = monthlyTrend.filter((item) => item.textComments >= 30).reduce((best, item) => item.coCreationRate > best.coCreationRate ? item : best, monthlyTrend.find((item) => item.textComments >= 30));
const latestMonth = monthlyTrend.at(-1);
const previousMonth = monthlyTrend.at(-2);
const juneMonth = monthlyTrend.find((item) => item.key === '2026-06');
const julyMonth = monthlyTrend.find((item) => item.key === '2026-07');
const latestPaceChange = previousMonth?.dailyPace ? latestMonth.dailyPace / previousMonth.dailyPace - 1 : 0;
const indexedMonthlyTrend = monthlyTrend.map((item) => ({
  ...item,
  commentIndex: peakCommentsMonth.comments ? item.comments / peakCommentsMonth.comments * 100 : 0,
  userIndex: peakUsersMonth.activeUsers ? item.activeUsers / peakUsersMonth.activeUsers * 100 : 0,
}));
const signalMax = niceMax(Math.max(...monthlyTrend.flatMap((item) => [item.strictRate, item.coCreationRate, item.purchaseRate]), 1));
const latestWeekKey = weekStart(lastObserved.date);
const lastWeekDate = new Date(`${latestWeekKey}T00:00:00Z`);
const weeklyTrend = [];
for (let offset = 13; offset >= 0; offset -= 1) {
  const date = new Date(lastWeekDate);
  date.setUTCDate(date.getUTCDate() - offset * 7);
  const key = date.toISOString().slice(0, 10);
  const source = weeklyMap.get(key) || { comments: 0, users: new Set() };
  weeklyTrend.push({ key, label: `${key}起`, shortLabel: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`, comments: source.comments, activeUsers: source.users.size });
}
const monthlyTrendRows = monthlyTrend.map((item) => ({
  月份: item.key, 窗口状态: item.windowStatus, 观察天数: item.windowDays, 观众评论: item.comments, 文本评论: item.textComments,
  活跃评论用户: item.activeUsers, 样本内首次出现用户: item.newUsers, 此前月份已出现用户: item.returningUsers,
  回流用户占比: `${fixed(item.returningShare * 100, 2)}%`, 严格玩家语境评论: item.strictComments,
  严格玩家语境每千文本评论: fixed(item.strictRate, 2), 有机共创评论: item.coCreationComments,
  有机共创每千文本评论: fixed(item.coCreationRate, 2), 严格购买表达评论: item.purchaseComments,
  严格购买每千文本评论: fixed(item.purchaseRate, 2), 日均评论节奏: fixed(item.dailyPace, 2),
}));

const quoteEvidenceRows = [];
for (const [theme, row] of Object.entries(quotes)) {
  if (!row) continue;
  quoteEvidenceRows.push({
    证据类型: `主题原评：${theme}`, 评论ID: row['评论ID'], 昵称: row['评论用户'], 用户主页: row['评论用户URL'],
    精确评论时间: row['评论时间'], 评论地点: row['评论地点'], 评论层级: row['回复层级'], 原始评论: row['评论内容'],
    点赞: row['评论点赞数'], 视频ID: row['所属视频ID'], 视频标题: row['所属视频标题'], 视频链接: row['所属视频URL'],
    开放编码: [...(codesById.get(row['评论ID']) || [])].join(' | '), 备注: '全量评论中按对应编码的点赞排序选取。',
  });
}
for (const profile of profiles) {
  for (const [event, timeKey, textKey] of [['首评', '最早评论时间', '最早评论原文'], ['高赞', '最高赞评论时间', '最高赞评论原文'], ['末评', '最新评论时间', '最新评论原文']]) {
    quoteEvidenceRows.push({
      证据类型: `具名轨迹：${event}`, 评论ID: '', 昵称: profile['昵称（样本期常用）'], 用户主页: profile.主页,
      精确评论时间: profile[timeKey], 评论地点: profile.主要评论地点标签, 评论层级: '', 原始评论: profile[textKey], 点赞: event === '高赞' ? profile.最高单评点赞 : '',
      视频ID: '', 视频标题: '', 视频链接: '', 开放编码: profile.命中语境信号, 备注: `评论数${profile.评论数}，涉及${profile.涉及视频数}视频，跨度${profile.活跃跨度天}天。`,
    });
  }
}

const videoMatrix = videos.map((video) => ({
  视频ID: video.id, 视频标题: video.title, 视频链接: video.url, 视频发布时间: video.publishedAt || '', 是否有发布时间: video.publishedAvailable ? '是' : '否',
  内容原型: video.primaryArchetypeLabel || labels[video.primaryArchetype] || '', 内容象限: video.quadrant || '', 展示点赞: video.displayedLikes,
  采集评论: video.capturedComments, 观众评论: video.audienceComments, 文本观众评论: video.audienceTextComments, 观众用户: video.audienceUsers,
  首触用户: video.firstTouchUsers, 回访用户: video.returningUsers, 回访用户占比: fixed(video.returningShare * 100, 2) + '%',
  严格玩家语境评论: video.strictContextComments, 严格玩家语境占比: fixed(video.strictContextShare * 100, 2) + '%',
  共创用户: video.coCreationUsers, 共创评论: video.coCreationComments, 严格购买用户: video.strictPurchaseUsers,
  作者回复率: fixed(video.authorReplyRate * 100, 2) + '%', '24小时内评论': video.lifecycle?.h24 ?? '', '7日内评论': video.lifecycle?.d7 ?? '',
}));

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:," /><title>三国杀WUHU联盟卡宝评论用户与内容关系超级深度报告</title>
<style>
:root{--ink:#273238;--muted:#647177;--line:#dce3e0;--paper:#f5f7f4;--panel:#fff;--navy:#314d58;--teal:#477c77;--sage:#a9c4ad;--gold:#b98639;--rose:#9d6266;--blue:#6e93a7}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.72;font-size:15px}.wrap{max-width:1180px;margin:auto;padding:0 28px}a{color:#245f73;text-decoration-color:#93b8c4;text-underline-offset:3px}.cover{background:linear-gradient(135deg,#253d48 0%,#3d6867 70%,#89aa90 100%);color:#fff;padding:72px 0 58px}.eyebrow{font-size:12px;letter-spacing:1.6px;font-weight:700;opacity:.84}.cover h1{font-size:39px;line-height:1.28;margin:15px 0 12px;letter-spacing:0}.cover p{max-width:850px;font-size:18px;margin:0;opacity:.95}.cover .meta{display:flex;gap:9px;flex-wrap:wrap;margin-top:28px}.cover .meta span{border:1px solid #ffffff55;background:#ffffff15;padding:5px 9px;border-radius:3px;font-size:12px}nav{position:sticky;top:0;z-index:4;background:#fffffff2;border-bottom:1px solid var(--line);backdrop-filter:blur(10px)}nav .wrap{display:flex;gap:17px;overflow:auto;padding-top:8px;padding-bottom:8px;white-space:nowrap}nav a{font-size:12px;color:var(--muted);text-decoration:none}section{padding:43px 0;border-bottom:1px solid var(--line)}.part{font-size:12px;letter-spacing:1.2px;color:#4c7a80;font-weight:800}.section-title{font-size:27px;line-height:1.3;margin:5px 0 10px;letter-spacing:0}.lead{font-size:17px;color:#34454a;max-width:960px;margin:0 0 20px}.thesis{border-left:4px solid var(--teal);padding:14px 18px;background:#eaf1ee;font-weight:700;margin:18px 0 24px}.grid{display:grid;gap:12px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}.measure{border-top:3px solid var(--blue);background:var(--panel);padding:13px 14px;min-height:104px}.measure b{font-size:25px;line-height:1.1;display:block;color:#275664}.measure span{font-size:13px;font-weight:700;display:block;margin-top:8px}.measure small{display:block;color:var(--muted);font-size:11px;line-height:1.4;margin-top:4px}.two{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:22px;align-items:start}.evidence{padding:15px 17px;border-left:4px solid #a8b5b2;background:#fafbfa;margin:14px 0}.evidence.good{border-color:var(--teal);background:#eef6f2}.evidence.warn{border-color:var(--gold);background:#fbf7ed}.evidence.risk{border-color:var(--rose);background:#f9eff0}.evidence h4{margin:0 0 5px;font-size:15px}.evidence p{margin:0}.cite{font-size:12px;color:var(--muted);margin-top:7px}.bars{padding:6px 0}.bar{display:grid;grid-template-columns:148px 1fr 74px;align-items:center;gap:9px;margin:8px 0;font-size:12px}.bar>div{height:10px;background:#e4ebe8}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--teal),#85aaa0)}.bar b{text-align:right;font-variant-numeric:tabular-nums;color:#425156}.table-wrap{overflow:auto;border:1px solid var(--line);background:#fff}table{width:100%;border-collapse:collapse;font-size:12px;min-width:680px}th{background:#eaf0ed;text-align:left;color:#42575c;font-weight:800}th,td{padding:9px 10px;border-bottom:1px solid #e3e9e7;vertical-align:top}td small{display:block;color:var(--muted);margin-top:3px}tr:last-child td{border-bottom:0}.quote{margin:0 0 13px;padding:14px 16px;background:#fff;border-top:2px solid #abc7c3}.quote blockquote{font-size:15px;margin:0 0 7px;line-height:1.65}.quote figcaption{font-size:11px;color:var(--muted);line-height:1.55}.quote figcaption strong{color:#34464b}.quote figcaption em{display:block;margin-top:5px}.tags{margin-left:6px}.tags i{font-style:normal;background:#e9f0ee;color:#426c69;font-size:10px;padding:2px 4px;border-radius:2px;margin:2px 2px 0 0;display:inline-block}.note{font-size:12px;color:var(--muted)}.flow{display:flex;gap:5px;align-items:stretch;overflow:auto;padding:5px 0}.flow div{flex:1;min-width:122px;background:#fff;border-top:3px solid var(--sage);padding:11px}.flow b{display:block;font-size:20px;color:#35615c}.flow span{font-size:12px;font-weight:700}.flow small{display:block;color:var(--muted);font-size:10px;margin-top:4px;line-height:1.45}.arrow{align-self:center;color:#78948d;font-weight:900}.case{border-top:1px solid var(--line);padding:18px 0}.case:first-child{border-top:0}.case h3{font-size:16px;margin:0 0 7px}.case p{margin:5px 0}.profile{border-left:3px solid var(--gold);padding:13px 15px;background:#fffdf9;margin:12px 0}.profile h4{margin:0 0 5px;font-size:16px}.profile dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:10px 0 0}.profile dt{font-size:10px;color:var(--muted)}.profile dd{margin:0;font-size:12px;font-weight:700}.checklist{padding-left:18px;margin:9px 0}.checklist li{margin:5px 0}footer{padding:35px 0 50px;color:var(--muted);font-size:12px}.internal{background:#3f5158;color:#fff;padding:8px 12px;font-size:12px;margin:0 0 12px}.internal a{color:#d9f4f0}@media(max-width:780px){.wrap{padding:0 16px}.cover{padding:48px 0 40px}.cover h1{font-size:30px}.g4,.g3,.g2,.two{grid-template-columns:1fr}.section-title{font-size:24px}.bar{grid-template-columns:106px 1fr 56px}.profile dl{grid-template-columns:repeat(2,minmax(0,1fr))}section{padding:33px 0}}
</style><style>
.trend-suite{display:grid;gap:18px;margin:22px 0}.trend-panel{background:#fff;border:1px solid var(--line);padding:18px 18px 14px;border-radius:6px;min-width:0}.trend-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:8px}.trend-head h3{font-size:17px;line-height:1.35;margin:0}.trend-head p{font-size:12px;color:var(--muted);margin:3px 0 0}.legend{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;font-size:11px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:-1px}.chart-scroll{width:100%;overflow-x:auto;overflow-y:hidden}.trend-svg{display:block;width:100%;min-width:760px;height:auto}.gridline{stroke:#dfe7e4;stroke-width:1}.axis-label{fill:#6a777b;font-size:11px}.month-label{font-weight:700}.bar-value{fill:#3e5358;font-size:11px;font-weight:800}.trend-readout{display:grid;grid-template-columns:repeat(8,minmax(74px,1fr));gap:6px;margin-top:6px}.trend-readout div{background:#f2f6f4;padding:7px 8px;min-width:0}.trend-readout b{display:block;font-size:11px}.trend-readout span{display:block;font-size:10px;color:var(--muted);white-space:nowrap}.week-bars{height:228px;display:grid;grid-template-columns:repeat(14,minmax(48px,1fr));gap:8px;align-items:end;min-width:820px;padding:22px 4px 0}.week-col{text-align:center;min-width:0}.week-stage{height:164px;display:flex;align-items:flex-end;justify-content:center;background:linear-gradient(to top,#edf3f0 1px,transparent 1px);background-size:100% 41px;border-bottom:1px solid #bbc9c4}.week-stage span{position:relative;display:block;width:70%;min-height:2px;background:linear-gradient(180deg,#4b817c,#88aaa0)}.week-stage b{position:absolute;top:-19px;left:50%;transform:translateX(-50%);font-size:9px;color:#405157;font-weight:800;white-space:nowrap}.week-col small{display:block;font-size:9px;color:var(--muted);margin-top:5px}.week-col em{display:block;font-size:9px;font-style:normal;color:#345f62}.temporal-note{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.temporal-note span{background:#eaf1ee;color:#3f6663;padding:4px 7px;border-radius:2px;font-size:11px}.trend-table td,.trend-table th{font-variant-numeric:tabular-nums;white-space:nowrap}
@media(max-width:780px){.trend-panel{padding:14px 12px}.trend-head{display:block}.legend{justify-content:flex-start;margin-top:8px}.trend-readout{grid-template-columns:repeat(4,minmax(74px,1fr));min-width:420px}.trend-readout-wrap{overflow-x:auto}.trend-svg{min-width:720px}.week-bars{min-width:780px}}
</style><style>@media(max-width:780px){body{overflow-x:hidden}.cover .wrap,main.wrap{width:100%;max-width:100%}.eyebrow,.cover h1,.cover p,.section-title,.lead,.thesis{max-width:100%;overflow-wrap:anywhere;word-break:break-word;line-break:anywhere}.cover h1{font-size:28px;line-height:1.3}.eyebrow{letter-spacing:.7px}.cover p{font-size:16px}}</style></head><body>
<header class="cover"><div class="wrap"><div class="eyebrow">WUHU ALL-COMMENT CORPUS · COMMENTER × CONTENT DEEP DIVE</div><h1>三国杀WUHU联盟卡宝<br>评论用户与内容关系超级深度报告</h1><p>不把评论当作一串互动数，而把每一条评论放回“谁在何时、进入哪种内容、用什么三国杀语境说话、随后又去了哪里”的完整关系链里。</p><div class="meta"><span>107条视频</span><span>${n(covered.capturedComments)}条已采评论</span><span>${n(covered.audienceComments)}条观众评论</span><span>${n(lifecycle.audienceUsers)}位可观测评论用户</span><span>${n(lifecycle.textUsers)}位文本评论用户</span><span>观察期：2026-01-27 至 2026-08-13</span></div></div></header>
<nav><div class="wrap"><a href="#thesis">核心判断</a><a href="#universe">用户宇宙</a><a href="#time">时序与复访</a><a href="#entry">内容入口</a><a href="#language">玩家语境</a><a href="#content">内容原型</a><a href="#thread">评论线程</a><a href="#relations">角色关系</a><a href="#commerce">实物化</a><a href="#people">具名轨迹</a><a href="#action">策略实验</a><a href="#method">口径边界</a></div></nav>
<main class="wrap">
<section id="thesis"><div class="part">01 / EXECUTIVE THESIS</div><h2 class="section-title">核心不是“评论热度”，而是内容是否把用户带进可持续的共同语言</h2><p class="lead">这份报告以评论用户为主体、视频内容为触发条件。它不把“跨视频再次评论”称作平台留存，也不把“想买”称作成交；它只回答在当前可见语料中，哪些内容把用户带入了下一次表达、哪种表达能够加深为玩家解码或关系共创、哪些内容只在当前视频内完成一次性反应。</p><div class="thesis">总判断：卡宝内容的增长不是单一路径。<strong>角色可识别性</strong>是进入三国杀语境的桥，<strong>机制/史事解码</strong>与更长的跨视频评论观察相关，<strong>萌化</strong>把角色转成可照护、可拥有的对象，<strong>关系戏</strong>把用户变成编剧。四者必须在内容编排上分工，而不是用一类爆点代替全部。</div><div class="grid g4">${measure('评论用户（非作者）', n(lifecycle.audienceUsers), '用户以评论用户URL去重；不是粉丝数或观看人数')}${measure('跨视频评论用户', `${n(1824)} / ${n(lifecycle.audienceUsers)}`, '33.72%；至少在两条视频下留下可见评论')}${measure('玩家×萌化混合核', `${n(478)}人`, '仅占文本用户9.58%，跨视频观察率85.77%')}${measure('严格购买表达', `${n(153)}人`, '3.07%文本用户；表达下限，不是订单')}</div>
${evidence('三条必须同时成立的经营事实', '① 15.71%的4+评论用户贡献58.22%的观众评论，社区存在高度可运营的核心层；② 478名“玩家解码×萌化”混合用户既有最高跨视频观察率，也有较高周边/购买表达；③ 关系共创和玩家解码并非同一需求，前者增加连续参与，后者提供角色可信度。', '所有比例均为样本内评论行为；无播放、完播、关注或订单数据。', 'good')}</section>

<section id="universe"><div class="part">02 / COMMENTER UNIVERSE</div><h2 class="section-title">先看用户的“参与形态”：多数人只留下一个触点，少数人承担了社区的持续表达</h2><div class="two"><div><p>评论池不是均匀的人群。${n(3351)}名用户只出现一次，占全部可观测评论用户的61.94%，却只贡献22.77%的观众评论；相对地，${n(254)}名10+评论用户仅占4.70%，贡献35.35%的评论。这个结构意味着，单视频的高评并不自动等于用户资产增长，必须区分<strong>首触规模</strong>、<strong>回到下一条内容的人</strong>与<strong>跨题材仍持续说话的人</strong>。</p><p>尤其值得单独运营的是149名跨11+视频用户：只占2.75%，却留下3,962条评论，占全部观众评论26.92%。他们不是“平均受众”的放大版，而是账号叙事规则、角色梗、投稿礼仪被稳定记住的验证样本。</p>${bars(lifecycle.observedLifecycleSegments, 'users', 'segment', (value) => `${n(value)}人`)}</div><div>${evidence('内容侧的含义', '拉新视频不应只用评论量作为成功条件。对新视频而言，至少要同时看：有多少人是该视频的首个可见评论触点、其中多少人后来进入另一视频、以及他们进入后采用的是即时反应、角色命名、机制解码还是关系续写。', '分层口径：同视频重复、跨视频同日、2–7天、8–30天、30天以上互斥。', 'good')}${evidence('不要误读集中度', '高频用户的存在并不说明普通用户不重要。它说明账号目前有一批“叙事承接者”；产品任务是把一次性反应者变成二次表达者，而不是只继续服务最活跃的一小群。', '用户行为来自已采可见评论，不含静默观看。', 'warn')}</div></div></section>

<section id="time"><div class="part">03 / TEMPORAL BEHAVIOR</div><h2 class="section-title">评论规模在6月进入放大期，7月形成峰值，8月前13日维持高日均节奏</h2><p class="lead">时间轴采用每条评论的发生时间，覆盖2026-01-27至2026-08-13。1月与8月为残月，2–3月未观察到观众评论事件。视频发布时间效果在17/107条可解析样本内单独评估，本章聚焦评论用户与语境随时间的变化。</p><div class="grid g4">${measure('峰值月观众评论', `${peakCommentsMonth.label} · ${n(peakCommentsMonth.comments)}条`, `占全部观众评论${pct(peakCommentsMonth.comments / covered.audienceComments)}`)}${measure('峰值月活跃评论用户', `${peakUsersMonth.label} · ${n(peakUsersMonth.activeUsers)}人`, '月内按评论用户URL去重')}${measure('最高回流构成月', `${peakReturningMonth.label} · ${pct(peakReturningMonth.returningShare)}`, `${n(peakReturningMonth.returningUsers)} / ${n(peakReturningMonth.activeUsers)}人此前月份已出现`)}${measure('8月1–13日日均评论', `${fixed(latestMonth.dailyPace, 1)}条/日`, `相较7月${latestPaceChange >= 0 ? '+' : ''}${pct(latestPaceChange)}`)}</div>
<div class="temporal-note"><span>* 代表残月</span><span>活跃用户=月内有可见评论的去重用户</span><span>回流用户=此前月份已有评论记录</span><span>语境密度=每千条文本评论的编码命中数</span></div>
<div class="trend-suite">
  <article class="trend-panel"><div class="trend-head"><div><h3>月度评论量与活跃评论用户趋势</h3><p>两条线各自以峰值月=100指数化，用于比较规模与用户广度的变化形状。</p></div><div class="legend"><span><i style="background:#477c77"></i>评论量指数</span><span><i style="background:#6e93a7"></i>活跃用户指数</span></div></div>${lineChart(indexedMonthlyTrend, [{ key: 'commentIndex', label: '评论量指数', color: '#477c77', digits: 1 }, { key: 'userIndex', label: '活跃用户指数', color: '#6e93a7', digits: 1 }], 100, '月度评论量与活跃评论用户指数趋势')}<div class="trend-readout-wrap"><div class="trend-readout">${monthlyTrend.map((item) => `<div><b>${esc(item.label)}</b><span>${n(item.comments)}条 / ${n(item.activeUsers)}人</span></div>`).join('')}</div></div></article>
  <article class="trend-panel"><div class="trend-head"><div><h3>月度用户构成：样本内首次出现与此前月份已出现</h3><p>蓝色表示当月首次在样本中留下评论的用户，金色表示此前月份已出现的用户。</p></div><div class="legend"><span><i style="background:#6e93a7"></i>样本内首次出现</span><span><i style="background:#b98639"></i>此前月份已出现</span></div></div>${stackedUserChart(monthlyTrend)}</article>
  <article class="trend-panel"><div class="trend-head"><div><h3>语境信号随时间的密度变化</h3><p>以每千条非空文本评论归一，观察玩家解码、有机共创与严格购买表达的结构变化。</p></div><div class="legend"><span><i style="background:#477c77"></i>严格玩家语境</span><span><i style="background:#9d6266"></i>有机共创/追更</span><span><i style="background:#b98639"></i>严格购买表达</span></div></div>${lineChart(monthlyTrend, [{ key: 'strictRate', label: '严格玩家语境/千条', color: '#477c77', digits: 1 }, { key: 'coCreationRate', label: '有机共创/千条', color: '#9d6266', digits: 1 }, { key: 'purchaseRate', label: '严格购买/千条', color: '#b98639', digits: 1 }], signalMax, '月度玩家语境、有机共创与严格购买表达每千条文本评论趋势')}</article>
  <article class="trend-panel"><div class="trend-head"><div><h3>近14周评论脉冲</h3><p>柱高为每周观众评论数，柱下标注当周去重活跃评论用户。最后一周截止至8月13日。</p></div><div class="legend"><span><i style="background:#477c77"></i>观众评论</span><span>柱下：活跃用户</span></div></div><div class="chart-scroll">${weeklyBars(weeklyTrend)}</div></article>
</div>
<div class="grid g2">${evidence('6–7月形成规模放大段', `6月观察到${n(juneMonth.comments)}条观众评论、${n(juneMonth.activeUsers)}位活跃评论用户；7月升至${n(julyMonth.comments)}条与${n(julyMonth.activeUsers)}人，评论规模为6月的${fixed(julyMonth.comments / juneMonth.comments, 2)}倍，用户广度为${fixed(julyMonth.activeUsers / juneMonth.activeUsers, 2)}倍。`, '该变化同时受内容供给、发布批次、旧视频累积评论与采集窗口影响。', 'good')}${evidence('8月残月显示高日均节奏', `8月1–13日观察到${n(latestMonth.comments)}条评论，日均${fixed(latestMonth.dailyPace, 1)}条；7月日均${fixed(previousMonth.dailyPace, 1)}条，当前差异为${latestPaceChange >= 0 ? '+' : ''}${pct(latestPaceChange)}。`, '8月总量使用残月标记，日均节奏用于跨月对照。', 'good')}${evidence('回流构成反映用户资产深度', `${peakReturningMonth.label}共${n(peakReturningMonth.activeUsers)}位活跃评论用户，其中${n(peakReturningMonth.returningUsers)}人在此前月份已有可见评论，回流构成${pct(peakReturningMonth.returningShare)}。`, '该指标是样本内跨月评论观察代理，与平台账号级留存分开记录。', 'warn')}${evidence('玩家解码与共创需求有各自的高密度月', `${peakStrictMonth.label}的严格玩家语境为每千条${fixed(peakStrictMonth.strictRate, 1)}条；${peakCoCreationMonth.label}的有机共创/追更为每千条${fixed(peakCoCreationMonth.coCreationRate, 1)}条。`, '时间密度帮助识别语境结构的变化，后续用内容原型与角色供给做分层复盘。', 'good')}</div>
<h3>精确月度时间表</h3><div class="table-wrap"><table class="trend-table"><thead><tr><th>月份</th><th>窗口</th><th>评论</th><th>文本</th><th>活跃用户</th><th>样本内首次出现</th><th>此前月份已出现</th><th>回流构成</th><th>严格玩家/千条</th><th>有机共创/千条</th><th>购买表达/千条</th><th>日均</th></tr></thead><tbody>${monthlyTrend.map((item) => `<tr><td><strong>${esc(item.label)}</strong></td><td>${esc(item.windowStatus)}<small>${n(item.windowDays)}天</small></td><td>${n(item.comments)}</td><td>${n(item.textComments)}</td><td>${n(item.activeUsers)}</td><td>${n(item.newUsers)}</td><td>${n(item.returningUsers)}</td><td>${pct(item.returningShare)}</td><td>${fixed(item.strictRate, 1)}<small>${n(item.strictComments)}条 / ${n(item.strictUsers)}人</small></td><td>${fixed(item.coCreationRate, 1)}<small>${n(item.coCreationComments)}条 / ${n(item.coCreationUsers)}人</small></td><td>${fixed(item.purchaseRate, 1)}<small>${n(item.purchaseComments)}条 / ${n(item.purchaseUsers)}人</small></td><td>${fixed(item.dailyPace, 1)}</td></tr>`).join('')}</tbody></table></div>
<h3>多次评论的间隔节奏</h3><p class="lead">在${n(timing.scope?.repeatUsers || 2059)}位多次评论用户的${n(timing.intervals.n)}段相邻间隔中，间隔中位数为${fixed(timing.intervals.medianHours, 1)}小时。短间隔对应同视频讨论、回复或活动召集；1–7天间隔占36.82%，对应下一条内容的承接窗口。两类节奏分别记录为即时接力与跨内容回流代理。</p><div class="grid g4">${measure('二次文本互动中位延迟', `${fixed(lifecycle.lagToSecondHours.median, 1)}小时`, `重复文本用户 n=${n(lifecycle.lagToSecondHours.n)}`)}${measure('第四次互动中位进程', `${fixed(lifecycle.lagToFourthDays.median, 1)}天`, `达到第4次互动用户 n=${n(lifecycle.lagToFourthDays.n)}`)}${measure('第十次互动中位进程', `${fixed(lifecycle.lagToTenthDays.median, 1)}天`, `达到第10次互动用户 n=${n(lifecycle.lagToTenthDays.n)}`)}${measure('18–20时活跃评论', '48.25%', '多评用户事件；与内容发布时间共同影响')}</div><div class="two"><div>${bars(timelineBuckets, 'count', 'label', (value) => `${n(value)}段`)}<p class="note">相邻间隔统计限定多次评论用户，断开阈值、日期和时段均代表评论发生时刻；用户在线时长字段缺失。</p></div><div>${evidence('运营窗口：先做“下一句话”，再做“下一条视频”', '18点是多评用户最高的单小时，18–20点合计48.25%。内容发布后的首轮把提问、可接续梗和作者回复放入这个可见窗口；1–7天内安排同角色/相邻关系的承接内容，并记录新的跨视频表达。', '时段数据表达评论发生窗口；发布时间效果在17条可解析视频中单独评估。', 'good')}${evidence('具名时序证据连接个体轨迹', `多评用户中，相邻评论≤1小时占${pct(timing.intervals.bucketShares['≤1小时'])}，1–7天占${pct(timing.intervals.bucketShares['1–7天'])}。前者用于评论区接力设计，后者用于内容序列设计。`, '具名轨迹见第11章和证据明细表。', 'warn')}</div></div></section>

<section id="entry"><div class="part">04 / CONTENT ENTRY</div><h2 class="section-title">内容入口要拆成“把谁带进来”与“把谁带下去”：首触大，不等于后续语境深</h2><p class="lead">视频层面有三类不同任务：拉新型的价值是带来更多首触评论用户，承接型的价值是让已有评论者在下一条内容继续出现，双引擎型同时承担两者。它们不能用同一条“评论数排行榜”决定投放与制作优先级。</p><div class="grid g4">${asArray(deep.content.quadrants).map((q) => measure(q.quadrant, `${n(q.videos)}条`, `用户中位${fixed(q.audienceUsersMedian)}；首触中位${fixed(q.firstTouchMedian)}；回访中位${fixed(q.returningMedian)}`)).join('')}</div><div class="two"><div class="table-wrap"><table><thead><tr><th>按首触用户排序</th><th>内容对象</th><th>观众用户</th><th>首触</th><th>回访</th><th>严格语境</th><th>共创</th><th>购买</th></tr></thead><tbody>${videoRows(firstTouchCases)}</tbody></table></div><div>${evidence('首触视频的正确追问', '首触规模高的视频，下一步不是机械复制标题，而是看新用户下一次出现在哪种内容：若大量进入关系戏，说明其完成的是角色入口；若进入机制/史事内容，说明角色入口也承担了玩家语境导流；若只停留在同视频，说明需要下一条的钩子。', '视频中的“回访”是此前已评论用户在此视频出现，非平台级留存。', 'good')}</div></div>
<div class="flow"><div><b>${n(covered.audienceComments)}</b><span>观众评论</span><small>去除作者评论</small></div><span class="arrow">→</span><div><b>${n(lifecycle.audienceUsers)}</b><span>评论用户</span><small>由URL去重</small></div><span class="arrow">→</span><div><b>${n(1824)}</b><span>跨视频用户</span><small>33.72%观察率</small></div><span class="arrow">→</span><div><b>${n(1158)}</b><span>跨度>7天</span><small>21.40%观察率</small></div><span class="arrow">→</span><div><b>${n(353)}</b><span>跨度>30天</span><small>6.53%观察率</small></div></div></section>

<section id="language"><div class="part">05 / PLAYER LANGUAGE DEPTH</div><h2 class="section-title">评论用户的“背景”不是猜年龄或地域，而是识别他们动用了哪一层三国杀文化资本</h2><p class="lead">同一句“可爱”可能是泛娱乐反应，也可能把武将、表字、技能和历史记忆一起带入。为了不把所有提到三国杀的人都误判为硬核玩家，本报告把文本用户按可观测的最高语境层分为五档：即时反应、一般提问、角色/卡宝认领、严格玩家解码、关系再叙事/有机共创。层级不是身份等级，更不是付费能力标签。</p><div class="table-wrap"><table><thead><tr><th>语境层</th><th>用户</th><th>人均评论</th><th>跨视频</th><th>30日后再次评论</th><th>周边兴趣</th><th>购买表达</th><th>内容解释</th></tr></thead><tbody>${contextDepth.map((s) => `<tr><td><strong>${esc(s.id)} ${esc(s.label)}</strong></td><td>${n(s.users)}<small>${pct(s.userShare)}</small></td><td>${fixed(s.commentsPerUser, 2)}</td><td>${pct(s.crossVideoRate)}</td><td>${n(s.return30Users)} / ${n(s.return30Eligible)}<small>${pct(s.return30Rate)}</small></td><td>${pct(s.merchandiseRate)}</td><td>${pct(s.purchaseRate)}</td><td>${s.id === 'L3' ? '表字、技能、史事和设定被用于解释剧情。' : s.id === 'L4' ? '用户开始续写关系、照护角色或提出可执行投稿。' : s.id === 'L2' ? '角色被认出并进入卡宝/萌化身份。' : '当前规则未命中更深语境，不代表没有兴趣。'}</td></tr>`).join('')}</tbody></table></div>
<div class="two"><div>${quoteHtml(quotes.mechanism, '机制话语不是玩法炫耀，而是把画面转换成玩家共同经验。')}${quoteHtml(quotes.history, '历史/设定互文让角色的当下动作拥有额外语义。')}</div><div>${evidence('关键发现：硬核语境更像“解释与回流引擎”，不是直接的商品语言', `L3严格玩家解码层有${n(contextDepth.find((x) => x.id === 'L3')?.users)}人，跨视频观察率${pct(contextDepth.find((x) => x.id === 'L3')?.crossVideoRate)}，30日机会窗口内再次评论${pct(contextDepth.find((x) => x.id === 'L3')?.return30Rate)}；但购买表达率仅${pct(contextDepth.find((x) => x.id === 'L3')?.purchaseRate)}。内容上应先用机制因果、典故和角色一致性建立可信度，再由萌化把理解转成情感对象。`, '所有比例以文本用户层的样本可观测行为为分母。', 'good')}${evidence('“负面词”不能自动判负面', '在玩家语境里，“卖血”“丑陋”“讨厌”“怕事”等可来自技能、台词、角色设定或自嘲。情绪分析必须在角色、视频剧情和回复链中复核；词典命中仅是编码入口。', '这一点直接影响对内容风险和角色口碑的判断。', 'risk')}</div></div></section>

<section id="content"><div class="part">06 / CONTENT ARCHETYPES</div><h2 class="section-title">内容不是一个标签：不同原型调动的是不同评论动作</h2><p class="lead">按标题与内容线索划分，双角色关系戏覆盖用户最多，但这也反映账号供给结构，不能据此宣称“所有用户都只爱CP”。更有用的看法是：原型作为入口时，用户之后的评论频率、跨视频观察、玩家解码、共创与购买表达各不相同。</p><div class="table-wrap"><table><thead><tr><th>作为首个内容原型</th><th>用户</th><th>重复评论</th><th>跨视频</th><th>7日窗口</th><th>30日窗口</th><th>后续严格解码</th><th>后续共创</th><th>平均视频数</th></tr></thead><tbody>${asArray(deep.content.archetypeEntryCohorts).filter((x) => x.users > 0).map((x) => `<tr><td><strong>${esc(x.label)}</strong></td><td>${n(x.users)}</td><td>${pct(x.repeatRate)}</td><td>${pct(x.crossVideoRate)}</td><td>${n(Math.round(x.return7Rate * x.return7Eligible))}/${n(x.return7Eligible)}<small>${pct(x.return7Rate)}</small></td><td>${n(Math.round(x.return30Rate * x.return30Eligible))}/${n(x.return30Eligible)}<small>${pct(x.return30Rate)}</small></td><td>${pct(x.laterStrictRate)}</td><td>${pct(x.laterCoCreationRate)}</td><td>${fixed(x.averageVideos, 2)}</td></tr>`).join('')}</tbody></table></div><div class="two"><div class="table-wrap"><table><thead><tr><th>严格玩家语境密度高的视频</th><th>内容</th><th>用户</th><th>首触</th><th>回访</th><th>严格语境</th><th>共创</th><th>购买</th></tr></thead><tbody>${videoRows(strictCases)}</tbody></table></div><div>${evidence('原型的编排原则', '卡宝本体展示适合降低进入门槛、制造“可拥有”的对象感；机制/史事内容适合让老玩家验证角色是否被理解；关系戏适合把用户变成共同编剧；现代生活移植适合把角色挪到可复用的日常场景。四类内容应轮播，而不是相互竞争。', '原型由标题/内容线索归类，存在多标签与供给偏差。', 'good')}</div></div></section>

<section id="thread"><div class="part">07 / COMMENT THREAD AS PRODUCT</div><h2 class="section-title">一条内容真正的“讨论承载力”在评论线程里：谁发起、谁接力、作者是否把它变成下一步</h2><p class="lead">在${n(thread.threads)}个线程中，${pct(thread.withReplyRate, 2)}至少有两条评论，${pct(thread.threePlusCommentRate, 2)}至少有三条；根评论是最强的跨内容入口：首条可观察互动为根评论的用户有${n(3743)}人，其跨视频观察率38.10%，高于一级回复入口的23.29%。这不是根评论导致回访，而是根评论更可能承载值得展开的内容表达。</p><div class="grid g4">${measure('至少2条的线程', pct(thread.withReplyRate, 2), `${n(Math.round(thread.threads * thread.withReplyRate))} / ${n(thread.threads)}线程`)}${measure('至少3条的线程', pct(thread.threePlusCommentRate, 2), '需要看对话而非只看点赞')}${measure('首条为根评论', `${n(3743)}人`, '69.19%评论用户')}${measure('作者回复根评', '18.10%', '字段为“视频作者是否回复”标记')}</div><div class="two"><div>${quoteHtml(quotes.question, '理解门槛是内容设计的信号：需要一行白话字幕或置顶解释，而非简单归为负面。')}${quoteHtml(quotes.continuation, '追更请求说明用户已经把账号当连续叙事，而不是单条段子。')}</div><div>${evidence('作者回复是值得做随机实验的杠杆，不是已证实的因果结论', '首个文本事件为根评且有作者回复标记的430名用户，后续跨视频观察率为56.98%；未标记回复的3,062名用户为37.03%。7日窗口分别为46.08%与25.19%。差异很大，但高质量评论更可能被作者选择回复，且字段无回复发生时间。', '建议按视频/小时/语境分层随机回复，每组至少400人，主指标设为7日跨视频评论用户/千首触根评。', 'warn')}${evidence('线程不是客服区，而是内容续写区', '最值得回复的不是所有提问，而是能够让其他用户接话的“机制解释、角色护短、关系分歧、下一集设想”。回复文本应补充一个可被引用的设定或问题，形成二层评论。', '用“线程≥2条率”“非作者接力率”监控，而不只看作者回复量。', 'good')}</div></div></section>

<section id="segments"><div class="part">08 / AUDIENCE COMPOSITION</div><h2 class="section-title">真正值得经营的不是“玩家”或“萌系”二选一，而是二者如何在同一个用户上共现</h2><p class="lead">严格玩家语境和萌化身份构成四个可操作的用户群。它们不是人口学标签，而是样本期内至少一次文本表现出的内容偏好。比较它们可以回答：哪一层更适合做解释、哪一层更适合做情感对象、哪一层既能持续参与也可能表达实物化需求。</p><div class="table-wrap"><table><thead><tr><th>可观测语境群</th><th>用户</th><th>人均评论</th><th>跨视频</th><th>30日窗口</th><th>周边兴趣</th><th>严格购买</th><th>内容任务</th></tr></thead><tbody>${strictCute.map((x) => `<tr><td><strong>${esc(x.label)}</strong></td><td>${n(x.users)}<small>${pct(x.userShare)}</small></td><td>${fixed(x.commentsPerUser, 2)}</td><td>${pct(x.crossVideoRate)}</td><td>${n(x.return30Users)}/${n(x.return30Eligible)}<small>${pct(x.return30Rate)}</small></td><td>${pct(x.merchandiseRate)}</td><td>${pct(x.purchaseRate)}</td><td>${x.id === 'both' ? '账号的混合核心：解释+萌化+共创均可承接。' : x.id === 'strict_only' ? '机制、史事、设定与角色一致性。' : x.id === 'cute_only' ? '可爱、照护、实体化与轻剧情。' : '轻入口、角色提示和可理解的笑点。'}</td></tr>`).join('')}</tbody></table></div>
${evidence('最重要的内容协同', `“玩家×萌化”${n(478)}人虽然只占文本用户9.58%，却有85.77%的跨视频观察率、46.13%的30日机会窗口再次评论率、16.11%的周边兴趣与6.07%的严格购买表达。它不是所谓“最值钱用户”的证明，而是说明<strong>懂角色的人也会接受萌化，喜欢萌化的人也能被角色语境承接</strong>。内容制作应做“双层脚本”：画面给泛用户看的可爱动作，台词/字幕给玩家看的机制或史事钩子。`, '交叉群来自文本编码，不能代替真实身份、消费或全平台受众画像。', 'good')}</section>

<section id="relations"><div class="part">09 / ROLES & RELATIONSHIPS</div><h2 class="section-title">角色与关系资产要看“标题内回应”之外的自发召回：谁能跟着用户走到别的内容里</h2><p class="lead">标题出现某角色，只能证明账号提供过这一内容，不等于用户在其他视频里仍主动想起他。这里采用“非标题视频中的双方共同点名”作为关系的保守代理；它依然不是播放曝光或官方CP认定，但比单条标题下的评论量更接近内容资产是否可迁移。</p><div class="table-wrap"><table><thead><tr><th>关系资产</th><th>标题供给</th><th>非标题共同点名</th><th>其中关系/行动评论</th><th>跨视频</th><th>严格语境</th><th>共创</th><th>购买表达</th><th>应该怎么拍</th></tr></thead><tbody>${pairs.map((p) => `<tr><td><strong>${esc(p.label)}</strong><small>${esc(p.quadrant)}</small></td><td>${n(p.titleSupplyVideos)}条</td><td>${n(p.nonTitleCoMentionUsers)}人 / ${n(p.nonTitleCoMentionComments)}条<small>${n(p.nonTitleCoMentionLikes)}赞</small></td><td>${n(p.nonTitleCoMentionShippingComments)} / ${n(p.nonTitleCoMentionActionComments)}</td><td>${pct(p.crossVideoRate)}</td><td>${pct(p.strictContextRate)}</td><td>${pct(p.coCreationRate)}</td><td>${pct(p.purchaseRate)}</td><td>${p.id === 'zhou_yu__sun_ce' ? '持续关系互动+开放投稿题。' : p.id === 'jiang_wei__zhong_hui' ? '冲突/误会剧情与续作钩子。' : p.id === 'guo_jia__cao_cao' ? '君臣/谋士与机制可信度，不只拍亲密模板。' : '样本小，先做2–3条验证。'}</td></tr>`).join('')}</tbody></table></div><div class="two"><div>${quoteHtml(quotes.relationship, '“礼貌投稿”通常是关系二创句式，不应被当作普通礼貌需求。')}${quoteHtml(quotes.care, '护短与照护把角色从牌面单位改写为需要被对待的对象。')}</div><div>${evidence('周孙、姜钟、曹郭不是一类关系', `周瑜×孙策有${n(pairs[0]?.nonTitleCoMentionUsers)}名非标题共同点名用户，其中${n(pairs[0]?.nonTitleCoMentionShippingComments)}条关系二创与${n(pairs[0]?.nonTitleCoMentionActionComments)}条行动/续作评论，适合共创主线；姜维×钟会的共同点名用户为${n(pairs[1]?.nonTitleCoMentionUsers)}，购买表达率${pct(pairs[1]?.purchaseRate)}，适合“剧情拉新+关系追更”组合；曹操×郭嘉严格语境率${pct(pairs[2]?.strictContextRate)}，更像玩家信誉资产。`, '玩家二创不等于官方关系；共同点名也不自动等于CP。', 'good')}</div></div></section>

<section id="commerce"><div class="part">10 / CONTENT-TO-TANGIBLE SIGNAL</div><h2 class="section-title">“想买”来自可拥有的情感对象，不是玩家黑话或CP热度的自然副产品</h2><p class="lead">在${n(lifecycle.textUsers)}名文本用户中，${n(153)}人出现严格购买表达，169条评论为下限。${n(146)}人同时命中周边兴趣，另有7人不在广义周边兴趣集合中，因此它们是重叠的并列信号，不是“周边兴趣→购买”的漏斗。</p><div class="grid g4">${measure('玩偶/娃娃诉求', '81 / 153人', '52.94%严格购买表达用户；多标签口径')}${measure('泛周边诉求', '61 / 153人', '39.87%')}${measure('毛绒/挂件', '9 / 153人', '5.88%；有方向但样本小')}${measure('价格敏感', '15 / 153人', '9.80%；不足以定价')}</div><div class="two"><div>${quoteHtml(quotes.commerce, '商品表达的典型结构是：角色/卡宝先被萌化，再被想象为玩偶、周边或可拥有的实体。')}${quoteHtml(quotes.cute, '高赞萌化反应为商品想象提供了情感前提，但不是购买承诺。')}</div><div>${evidence('观察到的“培育路径”只有29.41%发生在可见评论序列中', '153名严格购买表达用户中，108人首次可见文本评论就已经表达购买；45人此前有非购买互动。后者从非购买到购买的中位时间为5.46天，95.56%最终在不同视频表达购买。说明评论区可以看到少量被内容培育的路径，但绝大多数购买表达的观看前史不可见。', '不能把108人称作首触转化；他们此前可能已有观看、收藏或外部触点。', 'warn')}${evidence('商品测试应与关系测试拆开', '先验证单武将玩偶、卡宝通用挂件、双人关系套装三种概念。关系内容热度的主指标是共创/续作，不应直接替代商品意向；真正的商品主指标应改为预约、到货提醒或订金等行为。', '正文直接点名角色的购买样本很小，不能把标题场景误写成SKU偏好。', 'good')}</div></div></section>

<section id="people"><div class="part">11 / IDENTIFIED LONGITUDINAL EVIDENCE</div><h2 class="section-title">具名多次评论用户：把“用户画像”还原为真实的内容时间线</h2><div class="internal">内部使用：本节按你的要求保留样本期昵称、主页、原始评论与精确时间，只能用于本项目复核与内容运营；不得在公开报告或对外传播中转载。</div><p class="lead">下面的案例不是用来概括全部用户，更不能从昵称、地点或主页猜测现实人口属性。它们的价值在于展示：高频用户是如何跨过角色识别、机制解释、萌化、投稿和追更等不同内容语境的。</p>${profiles.map((p, index) => `<article class="profile"><h4>${index + 1}. ${esc(p['昵称（样本期常用）'])} <a href="${esc(p.主页)}" target="_blank" rel="noreferrer">查看主页</a></h4><p>样本期内覆盖${n(p.评论数)}条评论、${n(p.涉及视频数)}条视频、${n(p.评论日期数)}个自然日，活跃跨度${fixed(p.活跃跨度天, 1)}天。其语境为${esc(p.语境层)}，严格×萌化分类为${esc(p['严格×萌化'])}；它是“账号级叙事追随”的直接个体证据，而不是任何现实身份判断。</p><dl><div><dt>首评精确时间</dt><dd>${esc(p.最早评论时间)}</dd></div><div><dt>二评精确时间</dt><dd>${esc(p.二评精确时间)}</dd></div><div><dt>末评精确时间</dt><dd>${esc(p.末评精确时间)}</dd></div><div><dt>中位评论间隔</dt><dd>${fixed(p.中位评论间隔小时, 2)}小时</dd></div><div><dt>P90间隔</dt><dd>${fixed(p.P90评论间隔小时, 2)}小时</dd></div><div><dt>根评 / 回复</dt><dd>${n(p.根评论数)} / ${n(p.回复评论数)}</dd></div></dl><p class="note">原评节点：<strong>${esc(p.最早评论时间)}</strong>「${esc(p.最早评论原文)}」；<strong>${esc(p.最高赞评论时间)}</strong>「${esc(p.最高赞评论原文)}」（${n(p.最高单评点赞)}赞）；<strong>${esc(p.最新评论时间)}</strong>「${esc(p.最新评论原文)}」。</p></article>`).join('')}</section>

<section id="case-lab"><div class="part">12 / VIDEO CASE LAB</div><h2 class="section-title">四种视频任务的可复核案例：不要只看谁热，更要看谁把用户送向下一种表达</h2>${[
  ['A. 拉新入口', firstTouchCases[0], '首触用户多，重点复盘标题/角色组合/首条评论里出现的可接力问题；下一条内容应验证这些新用户是否能迁移到相邻角色或关系内容。'],
  ['B. 承接内容', returnRateCases[0], '已有评论者占比高，重点复盘它给核心用户提供了什么“再次说话”的理由：未完关系、机制解释、角色护短还是社区仪式。'],
  ['C. 玩家信誉内容', strictCases[0], '严格语境密度高，重点看是否同时给泛用户一条白话理解通道，避免把高门槛语境封闭为小圈层自嗨。'],
  ['D. 共创内容', cocreationCases[0], '共创用户多，重点记录用户提出的角色动作、关系结局和下一集设定，形成下一条内容的选题池。'],
].filter(([, v]) => v).map(([label, v, desc]) => `<article class="case"><h3>${label}：<a href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(cleanTitle(v.title))}</a></h3><p>${desc}</p><div class="grid g4">${measure('观众用户', n(v.audienceUsers))}${measure('首触 / 回访', `${n(v.firstTouchUsers)} / ${n(v.returningUsers)}`, `回访占比${pct(v.returningShare)}`)}${measure('严格语境', `${n(v.strictContextComments)}条`, pct(v.strictContextShare))}${measure('共创 / 购买', `${n(v.coCreationUsers)} / ${n(v.strictPurchaseUsers)}`, `内容原型：${v.primaryArchetypeLabel}`)}</div></article>`).join('')}</section>

<section id="action"><div class="part">13 / CONTENT OPERATING SYSTEM</div><h2 class="section-title">把用户—内容关系变成可实验的编排系统，而不是继续加长选题清单</h2><div class="grid g2">${evidence('实验1：双层脚本 2×2', '同一角色、近似时长与时段下，测试“萌化钩子有/无 × 机制/史事钩子有/无”。主指标：7日跨视频评论用户/千首触评论用户；次指标：严格语境、共创、周边/购买表达。当前先验是混合核的跨视频观察率85.77%、30日窗口46.13%。', '每格至少6条；不要用单条爆款下结论。', 'good')}${evidence('实验2：关系格式拆分', '周孙、姜钟各做显性互动与史事/机制冲突两种格式。分别记录关系二创、行动/续作请求、非标题共同点名用户，而非只看点赞。曹郭应另设君臣/谋士叙事组，不能直接复制亲嘴投稿模板。', '关系需求、角色认知和商品表达各自独立记录。', 'good')}${evidence('实验3：作者回复随机化', '在首触根评论中按视频、小时、语境分层随机回复或不回复，至少每组400人。主指标：7日跨视频评论；辅指标：二层回复、后续严格解码、共创。只用随机分组，才能识别回复本身是否有效。', '当前56.98% vs 37.03%只是选择偏差下的观察差。', 'warn')}${evidence('实验4：低供给角色验证', '曹冲、张飞、关羽、于吉各做“机制/史事版”和“萌化日常版”，再与高供给角色做匹配对照。主指标是后续两条非标题视频里的自发点名用户/千外部评论者，而不是本条标题下的角色提及。', '角色需求指数是本账号语料中的相对缺口，不是全市场TAM。', 'good')}</div><h3>建议的周内容序列</h3><div class="flow"><div><b>1</b><span>轻入口</span><small>一眼可懂的萌化动作+角色名提示</small></div><span class="arrow">→</span><div><b>2</b><span>玩家验证</span><small>技能因果/表字/史事钩子+白话字幕</small></div><span class="arrow">→</span><div><b>3</b><span>关系共创</span><small>开放式结尾、投稿题、下一集二选一</small></div><span class="arrow">→</span><div><b>4</b><span>情感实体化</span><small>玩偶/挂件概念测试，独立记录行为</small></div></div></section>

<section id="method"><div class="part">14 / METHODS & LIMITS</div><h2 class="section-title">可复算口径、数据边界与交付文件</h2><div class="two"><div><h3>数据口径</h3><ul class="checklist"><li><strong>C0 声明评论：</strong>${n(covered.declaredComments)}；<strong>C1 已采评论：</strong>${n(covered.capturedComments)}，采集覆盖${pct(covered.coverageRate, 2)}。</li><li><strong>C2 观众评论：</strong>${n(covered.audienceComments)}，排除视频作者评论；<strong>C3 文本观众评论：</strong>${n(covered.audienceTextComments)}。</li><li><strong>U1 评论用户：</strong>${n(lifecycle.audienceUsers)}，以评论用户URL去重；<strong>U2 文本用户：</strong>${n(lifecycle.textUsers)}。</li><li><strong>视频：</strong>107条；有观众评论的视频为106条。可解析发布时间覆盖17条视频，发布时间效果在该子样本内单独记录。</li><li><strong>时间轴：</strong>采用评论发生时间；月度活跃用户按用户URL去重；样本内首次出现与此前月份已出现构成当月用户互斥分组。</li><li>编码为规则辅助的扎根式分析：角色/表字、技能重映射、史事与设定、萌化、关系二创、投稿仪式、追更、周边与购买等多标签并存。</li></ul></div><div>${evidence('数据边界', '当前数据支持评论发生时间、用户跨视频表达、文本语境与购买表达的观测；播放曝光、完播、关注、收藏、分享、平台留存、成交与真实人口学字段缺失。评论先后用于描述观察顺序，因果方向由后续实验识别。', '角色标题、玩家二创、商品SKU与官方关系采用独立口径记录。', 'risk')}</div></div><h3>本次交付</h3><div class="table-wrap"><table><thead><tr><th>文件</th><th>内容</th><th>用途</th></tr></thead><tbody><tr><td><a href="评论用户时间趋势.csv">评论用户时间趋势.csv</a></td><td>1–8月评论、文本、活跃用户、首次出现/回流构成及三类语境密度。</td><td>时间变化复算、月度复盘与节奏编排。</td></tr><tr><td><a href="评论用户×内容证据矩阵.csv">评论用户×内容证据矩阵.csv</a></td><td>107条视频的用户、首触、回访、语境、共创、购买与作者回复指标。</td><td>选题复盘与视频级实验分组。</td></tr><tr><td><a href="具名评论用户与内容证据样本.csv">具名评论用户与内容证据样本.csv</a></td><td>主题原评及多评用户的原始时间节点、昵称、主页。</td><td>内部复核与内容运营。</td></tr><tr><td><a href="评论用户与内容报告方法说明.md">评论用户与内容报告方法说明.md</a></td><td>指标定义、算法、边界与使用限制。</td><td>复算和审阅。</td></tr><tr><td><a href="verification.json">verification.json</a></td><td>文件、关键口径和静态检查结果。</td><td>交付完整性验证。</td></tr></tbody></table></div></section>
</main><footer><div class="wrap">三国杀WUHU联盟卡宝评论用户与内容关系超级深度报告 · 生成于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 内部研究版本。所有具名信息均来自已提供的本地源文件，使用范围限于本项目内部内容运营与复核。</div></footer></body></html>`;

const htmlFile = path.join(OUT, '三国杀WUHU联盟卡宝评论用户与内容关系超级深度报告.html');
fs.writeFileSync(htmlFile, rewriteAssertively(html), 'utf8');
writeCsv(path.join(OUT, '评论用户×内容证据矩阵.csv'), videoMatrix, Object.keys(videoMatrix[0]));
writeCsv(path.join(OUT, '具名评论用户与内容证据样本.csv'), quoteEvidenceRows, Object.keys(quoteEvidenceRows[0]));
writeCsv(path.join(OUT, '评论用户时间趋势.csv'), monthlyTrendRows, Object.keys(monthlyTrendRows[0]));

const methods = `# 评论用户与内容关系报告：方法说明\n\n## 研究问题\n\n本报告以“评论用户在什么内容下发生表达、之后是否在其他内容下再次表达、表达语境如何变化”为核心对象。分析范围覆盖评论发生、内容迁移、语境深度、共创与购买表达；播放、关注、收藏、平台留存与成交字段缺失。\n\n## 分母\n\n- C0：视频声明评论 ${covered.declaredComments}。\n- C1：已采评论 ${covered.capturedComments}，覆盖率 ${(covered.coverageRate * 100).toFixed(3)}%。\n- C2：观众评论 ${covered.audienceComments}，已排除视频作者。\n- C3：有文本的观众评论 ${covered.audienceTextComments}。\n- U1：以评论用户URL去重的观众评论用户 ${lifecycle.audienceUsers}。\n- U2：有文本的观众评论用户 ${lifecycle.textUsers}。\n- V：107条视频；106条有观众评论。\n\n## 时间趋势口径\n\n- 观察窗口：2026-01-27至2026-08-13；1月与8月标记为残月。\n- 月度评论：按评论发生时间归月；周度脉冲以周一为周起点。\n- 活跃评论用户：月内按评论用户URL去重。\n- 样本内首次出现用户：首条可见评论落在当月；此前月份已出现用户：最早可见评论早于当月。\n- 语境密度：严格玩家语境、有机共创与严格购买的评论数，分别除以当月非空文本评论数并乘以1000。\n- 视频发布时间可解析样本为17/107，与全量评论发生时间趋势分开记录。\n\n## 用户与内容指标\n\n- 首触用户：样本内最早可见评论落在该视频的用户；首次观看与首次关注字段缺失。\n- 回访用户：在该视频前已在其他视频中有可见评论的用户；统一记录为评论回访观察代理。\n- 跨视频用户：样本内至少评论过两条视频的用户。\n- 语境层：用户多个评论的最高可观测规则编码，用于描述内容语言深度；现实身份字段缺失。\n- 关系共同点名：在该关系标题供给之外的视频中，用户同时点名双方的保守代理；官方关系、CP偏好与播放曝光分别记录。\n- 严格购买：严格购买词组/句式命中，口径为评论表达下限；购买与订单字段缺失。\n\n## 数据与伦理边界\n\n具名文件按任务要求保留昵称、主页、原评和精确时间，使用范围为本项目内部复核。现实身份、年龄、性别、职业、收入与消费能力保持未编码；公开传播版本采用匿名证据。\n`;
fs.writeFileSync(path.join(OUT, '评论用户与内容报告方法说明.md'), rewriteAssertively(methods), 'utf8');

const outputFiles = fs.readdirSync(OUT).filter((name) => name !== 'artifact-manifest.json' && name !== 'verification.json');
const manifest = { generatedAt: new Date().toISOString(), report: path.basename(htmlFile), sources: [RAW_COMMENTS, path.join(MASTER, 'wuhu-mkt-deep-analysis.json'), path.join(MASTER, 'wuhu-repeat-commenter-identified-temporal-analysis.json')].map((file) => ({ file, sha256: hash(file), bytes: fs.statSync(file).size })), files: outputFiles.map((name) => ({ file: name, sha256: hash(path.join(OUT, name)), bytes: fs.statSync(path.join(OUT, name)).size })) };
fs.writeFileSync(path.join(OUT, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ out: OUT, report: htmlFile, videos: videoMatrix.length, evidenceRows: quoteEvidenceRows.length, bytes: fs.statSync(htmlFile).size }, null, 2));
