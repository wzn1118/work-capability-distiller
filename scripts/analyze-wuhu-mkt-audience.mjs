import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/10847/Documents/MKT大师';
const SOURCE_DIR = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const GROUNDED_DIR = path.join(ROOT, 'output/wuhu-grounded-player-context-20260813');
const OUTPUT_DIR = path.join(ROOT, 'output/wuhu-mkt-audience-analysis-20260814');
const SOURCE_COMMENTS = path.join(SOURCE_DIR, 'all-comments.csv');
const SOURCE_VIDEOS = path.join(SOURCE_DIR, 'videos-summary.csv');
const SOURCE_MANIFEST = path.join(SOURCE_DIR, 'manifest.json');
const METADATA_DIR = path.join(SOURCE_DIR, 'metadata');
const CODED_COMMENTS = path.join(GROUNDED_DIR, 'wuhu-grounded-coded-comments.csv');
const GROUNDED_ANALYSIS = path.join(GROUNDED_DIR, 'wuhu-grounded-player-context-analysis.json');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  if (!rows.length) return [];
  const [rawHeaders, ...body] = rows;
  const headers = rawHeaders.map((header) => header.replace(/^\uFEFF/, ''));
  return body
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function stringifyCsv(rows, headers) {
  return `\uFEFF${[headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\r\n')}\r\n`;
}

function number(value) {
  const parsed = Number(String(value ?? '').replace(/^[\s']+/, '').replace(/[, +]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCompactCount(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(万|w)?$/i);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] ? 10000 : 1));
}

function extractCardLikes(metadata) {
  const structured = finiteNumber(metadata.video_likes) ?? finiteNumber(metadata.likes);
  if (structured !== null) return { value: structured, source: 'structured_metadata' };
  const tokens = String(metadata.video_card_text ?? metadata.card_text ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== '置顶');
  for (const token of tokens.slice(0, 3)) {
    const parsed = parseCompactCount(token);
    if (parsed !== null) return { value: parsed, source: 'video_card_text_snapshot' };
  }
  return { value: null, source: 'missing' };
}

function parseChinaDate(value) {
  const match = String(value ?? '').match(/(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function monthKey(date) {
  if (!date) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' });
  return formatter.format(date).slice(0, 7);
}

function dayKey(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function addMonths(key, offset) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function unique(values) {
  return new Set(values).size;
}

function sum(values, selector = (value) => value) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function rate(value, denominator) {
  return denominator ? value / denominator : 0;
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function percent(value, denominator, digits = 2) {
  return round(rate(value, denominator) * 100, digits);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function pseudonym(userKey) {
  return `aud_${crypto.createHash('sha256').update(`wuhu-mkt-v1\0${userKey}`).digest('hex').slice(0, 16)}`;
}

function gini(values) {
  if (!values.length || sum(values) === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const weighted = ordered.reduce((total, value, index) => total + (index + 1) * value, 0);
  return (2 * weighted) / (ordered.length * sum(ordered)) - (ordered.length + 1) / ordered.length;
}

function topShare(values, fraction) {
  if (!values.length || sum(values) === 0) return 0;
  const ordered = [...values].sort((left, right) => right - left);
  const count = Math.max(1, Math.ceil(ordered.length * fraction));
  return rate(sum(ordered.slice(0, count)), sum(ordered));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesPattern(names) {
  return new RegExp([...names].sort((left, right) => right.length - left.length).map(escapeRegex).join('|'), 'u');
}

const CHARACTER_GROUPS = [
  ['cao_cao', '曹操 / 阿瞒', ['曹操', '阿瞒', '操操']],
  ['guo_jia', '郭嘉 / 奉孝', ['郭嘉', '奉孝', '嘉嘉', '郭奉孝']],
  ['jiang_wei', '姜维 / 伯约', ['姜维', '伯约']],
  ['zhong_hui', '钟会 / 士季', ['钟会', '士季']],
  ['zhou_yu', '周瑜 / 公瑾', ['周瑜', '公瑾', '大嘟嘟', '嘟嘟']],
  ['sun_ce', '孙策 / 伯符', ['孙策', '伯符', '孙笨']],
  ['jia_xu', '贾诩 / 文和', ['贾诩', '文和']],
  ['xun_yu', '荀彧 / 文若', ['荀彧', '文若', '荀令君', '令君']],
  ['sima_yi', '司马懿 / 仲达', ['司马懿', '仲达']],
  ['sima_zhao', '司马昭 / 小昭昭', ['司马昭', '小昭昭']],
  ['cao_mao', '曹髦 / 小髦髦', ['曹髦', '小髦髦']],
  ['liu_bei', '刘备 / 玄德', ['刘备', '玄德', '备备', '阿备备']],
  ['zhao_yun', '赵云 / 子龙', ['赵云', '子龙']],
  ['zhuge_liang', '诸葛亮 / 孔明', ['诸葛亮', '孔明', '亮亮', '小诸葛']],
  ['wei_yan', '魏延 / 文长', ['魏延', '文长']],
  ['liu_shan', '刘禅 / 阿斗', ['刘禅', '阿斗']],
  ['deng_ai', '邓艾 / 士载', ['邓艾', '士载']],
  ['cao_pi', '曹丕 / 子桓', ['曹丕', '子桓']],
  ['cao_zhi', '曹植 / 子建', ['曹植', '子建']],
  ['xi_zhi_cai', '戏志才 / 志才', ['戏志才', '志才']],
  ['huang_gai', '黄盖 / 公覆', ['黄盖', '公覆']],
  ['ma_chao', '马超 / 孟起', ['马超', '孟起']],
  ['lu_bu', '吕布 / 奉先', ['吕布', '奉先']],
  ['zhang_xiu', '张绣', ['张绣']],
  ['cao_chong', '曹冲', ['曹冲']],
  ['sun_quan', '孙权 / 仲谋', ['孙权', '仲谋']],
  ['lu_xun', '陆逊 / 伯言', ['陆逊', '伯言', '陆老板']],
  ['xu_sheng', '徐盛 / 文向', ['徐盛', '文向', '大宝']],
  ['guan_yu', '关羽 / 云长', ['关羽', '云长']],
  ['zhang_fei', '张飞 / 翼德', ['张飞', '翼德', '小飞飞']],
  ['da_qiao', '大乔', ['大乔']],
  ['xiao_qiao', '小乔', ['小乔']],
  ['diao_chan', '貂蝉', ['貂蝉']],
  ['pang_tong', '庞统 / 士元', ['庞统', '士元']],
  ['huang_yue_ying', '黄月英', ['黄月英', '月英']],
  ['wen_yang', '文鸯', ['文鸯']],
  ['yu_ji', '于吉', ['于吉']],
  ['zhong_yu', '钟毓', ['钟毓']],
  ['ju_shou', '沮授', ['沮授']],
  ['li_ru', '李儒', ['李儒']],
  ['cheng_yu', '程昱', ['程昱']],
  ['sun_chen', '孙綝', ['孙綝']],
  ['yuan_shao', '袁绍', ['袁绍']],
  ['jiang_gan', '蒋干', ['蒋干']],
  ['wei_feng', '魏讽', ['魏讽']],
  ['cao_ang', '曹昂', ['曹昂']],
  ['huang_zhong', '黄忠 / 汉升', ['黄忠', '汉升']],
].map(([id, label, names]) => ({ id, label, names, pattern: namesPattern(names) }));

const PAIRS = [
  ['jiang_wei__zhong_hui', '姜维 / 伯约 × 钟会 / 士季', 'jiang_wei', 'zhong_hui'],
  ['zhou_yu__sun_ce', '周瑜 / 公瑾 × 孙策 / 伯符', 'zhou_yu', 'sun_ce'],
  ['guo_jia__cao_cao', '郭嘉 / 奉孝 × 曹操 / 阿瞒', 'guo_jia', 'cao_cao'],
  ['cao_cao__xun_yu', '曹操 / 阿瞒 × 荀彧 / 文若', 'cao_cao', 'xun_yu'],
  ['guo_jia__xi_zhi_cai', '郭嘉 / 奉孝 × 戏志才', 'guo_jia', 'xi_zhi_cai'],
  ['jia_xu__zhang_xiu', '贾诩 / 文和 × 张绣', 'jia_xu', 'zhang_xiu'],
  ['sima_zhao__cao_mao', '司马昭 × 曹髦', 'sima_zhao', 'cao_mao'],
  ['cao_pi__cao_zhi', '曹丕 × 曹植', 'cao_pi', 'cao_zhi'],
];

const rawComments = parseCsv(fs.readFileSync(SOURCE_COMMENTS, 'utf8'));
const rawVideos = parseCsv(fs.readFileSync(SOURCE_VIDEOS, 'utf8'));
const codedRows = parseCsv(fs.readFileSync(CODED_COMMENTS, 'utf8'));
const grounded = JSON.parse(fs.readFileSync(GROUNDED_ANALYSIS, 'utf8'));
const sourceManifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf8'));

const codedById = new Map(codedRows.map((row) => [String(row['评论ID']), {
  text: String(row['评论内容(去标识)'] ?? '').trim(),
  codes: new Set(String(row['开放编码'] ?? '').split('|').filter(Boolean)),
  axes: new Set(String(row['主轴编码'] ?? '').split('|').filter(Boolean)),
  depth: String(row['参与深度'] ?? ''),
}]));

const rawById = new Map(rawComments.map((row) => [String(row['评论ID']), row]));
const missingCoded = rawComments.filter((row) => !codedById.has(String(row['评论ID']))).length;
const extraCoded = codedRows.filter((row) => !rawById.has(String(row['评论ID']))).length;

const comments = rawComments.map((row) => {
  const coded = codedById.get(String(row['评论ID'])) ?? { text: '', codes: new Set(), axes: new Set(), depth: '' };
  const userKey = String(row['评论用户URL'] || (row['评论用户'] ? `name:${row['评论用户']}` : ''));
  return {
    id: String(row['评论ID']),
    videoId: String(row['所属视频ID']),
    parentId: String(row['父评论ID'] ?? ''),
    threadId: String(row['线程根评论ID'] ?? ''),
    relation: String(row['关系类型'] ?? ''),
    level: number(row['回复层级']),
    author: String(row['是否视频作者']).toLowerCase() === 'true',
    authorReplied: String(row['视频作者是否回复']).toLowerCase() === 'true',
    userKey,
    userId: userKey ? pseudonym(userKey) : '',
    text: coded.text,
    likes: number(row['评论点赞数']),
    date: parseChinaDate(row['评论时间']),
    day: dayKey(parseChinaDate(row['评论时间'])),
    month: monthKey(parseChinaDate(row['评论时间'])),
    location: String(row['评论地点'] ?? '').trim(),
    codes: coded.codes,
    axes: coded.axes,
    depth: coded.depth,
  };
});

const metadataById = new Map();
let invalidMetadataFiles = 0;
for (const file of fs.readdirSync(METADATA_DIR).filter((name) => name.endsWith('.json'))) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(METADATA_DIR, file), 'utf8'));
    const metadata = parsed.metadata ?? {};
    if (metadata.video_id) metadataById.set(String(metadata.video_id), metadata);
  } catch {
    invalidMetadataFiles += 1;
  }
}

const commentsByVideo = new Map();
for (const comment of comments) {
  if (!commentsByVideo.has(comment.videoId)) commentsByVideo.set(comment.videoId, []);
  commentsByVideo.get(comment.videoId).push(comment);
}

const strictCodes = new Set(grounded.strictKnowledgeMetric.codes);
const contentCodes = new Set([
  'mascot_persona_reference', 'community_address', 'publisher_pun_grievance', 'character_recognition',
  'courtesy_nickname', 'game_system_jargon', 'mechanic_remap_validation', 'game_economy_memory',
  'historical_intertext', 'canon_audit', 'canon_irony', 'voice_line_callback', 'interpretive_explanation',
  'relationship_shipping', 'counter_shipping', 'tragic_repair', 'cute_infantilization', 'protective_care',
  'moral_personality_judgment', 'role_address_play', 'continuation_request', 'knowledge_threshold_question',
  'narrative_interaction_question', 'outsider_self_identification', 'mascot_identity_question',
  'content_boundary_rejection', 'accessibility_request', 'ai_quality_rights',
]);
const ritualCodes = new Set(['tosign_ritual', 'submission_ritual']);
const coCreationCodes = new Set(['relationship_shipping', 'tragic_repair', 'protective_care', 'role_address_play', 'submission_ritual', 'continuation_request']);
const hasAny = (comment, codeSet) => [...codeSet].some((code) => comment.codes.has(code));
const isExactToSign = (comment) => /to\s*签/iu.test(comment.text);

const audienceAll = comments.filter((comment) => !comment.author && comment.userKey);
const audienceText = audienceAll.filter((comment) => comment.text);
const audienceStrictContextComments = audienceText.filter((comment) => hasAny(comment, strictCodes));
const audienceStrictContextUsers = new Set(audienceStrictContextComments.map((comment) => comment.userKey));
const audienceByUser = new Map();
for (const comment of audienceAll) {
  if (!audienceByUser.has(comment.userKey)) audienceByUser.set(comment.userKey, []);
  audienceByUser.get(comment.userKey).push(comment);
}
for (const items of audienceByUser.values()) items.sort((left, right) => (left.date?.getTime() ?? 0) - (right.date?.getTime() ?? 0) || left.id.localeCompare(right.id));

const maximumCommentDate = new Date(Math.max(...audienceAll.map((comment) => comment.date?.getTime() ?? 0)));
const DAY_MS = 86400000;

function observedReturn(items, days) {
  const dated = items.filter((item) => item.date);
  if (!dated.length) return false;
  const first = dated[0].date.getTime();
  return dated.some((item) => item.date.getTime() - first >= days * DAY_MS);
}

function userTier(stats) {
  if (stats.comments === 1) return '一次性（1条）';
  if (stats.comments <= 3) return '轻度复访（2-3条）';
  if (stats.comments <= 9) return '活跃（4-9条）';
  return '核心（10条+）';
}

const userStats = [...audienceByUser.entries()].map(([userKey, items]) => {
  const textItems = items.filter((item) => item.text);
  const first = items.find((item) => item.date)?.date ?? null;
  const last = [...items].reverse().find((item) => item.date)?.date ?? null;
  const roots = items.filter((item) => item.relation === '根评论');
  const rootWithText = roots.filter((item) => item.text);
  const rootAuthorReplied = rootWithText.filter((item) => item.authorReplied);
  const videos = new Set(items.map((item) => item.videoId));
  const months = new Set(items.map((item) => item.month).filter(Boolean));
  const days = new Set(items.map((item) => item.day).filter(Boolean));
  const codes = new Set(textItems.flatMap((item) => [...item.codes]));
  const exactToSignComments = textItems.filter(isExactToSign).length;
  const contentComments = textItems.filter((item) => hasAny(item, contentCodes)).length;
  const ritualComments = textItems.filter((item) => hasAny(item, ritualCodes) || isExactToSign(item)).length;
  const stats = {
    userKey,
    userId: pseudonym(userKey),
    comments: items.length,
    textComments: textItems.length,
    likesReceived: sum(items, (item) => item.likes),
    videos: videos.size,
    days: days.size,
    months: months.size,
    firstAt: first?.toISOString() ?? '',
    lastAt: last?.toISOString() ?? '',
    activeSpanDays: first && last ? (last.getTime() - first.getTime()) / DAY_MS : 0,
    roots: roots.length,
    textRoots: rootWithText.length,
    replies: items.length - roots.length,
    deepReplies: items.filter((item) => item.level >= 2).length,
    authorRepliedRoots: rootAuthorReplied.length,
    authorReplyRate: rate(rootAuthorReplied.length, rootWithText.length),
    codes,
    contentComments,
    ritualComments,
    exactToSignComments,
    exactToSignOnly: textItems.length > 0 && exactToSignComments === textItems.length,
    mixedToSignAndContent: exactToSignComments > 0 && textItems.some((item) => !isExactToSign(item) && hasAny(item, contentCodes)),
    repeat: items.length >= 2,
    crossVideo: videos.size >= 2,
    stable: videos.size >= 4,
    core: items.length >= 10,
    return7: observedReturn(items, 7),
    return30: observedReturn(items, 30),
    eligible7: first ? maximumCommentDate.getTime() - first.getTime() >= 7 * DAY_MS : false,
    eligible30: first ? maximumCommentDate.getTime() - first.getTime() >= 30 * DAY_MS : false,
    strictContext: textItems.some((item) => hasAny(item, strictCodes)),
    mascot: codes.has('mascot_persona_reference'),
    character: codes.has('character_recognition'),
    nickname: codes.has('courtesy_nickname'),
    cute: codes.has('cute_infantilization') || codes.has('protective_care') || codes.has('mascot_identity_question'),
    relationship: codes.has('relationship_shipping') || codes.has('submission_ritual') || codes.has('tragic_repair'),
    coCreation: textItems.some((item) => hasAny(item, coCreationCodes)),
    continuation: codes.has('continuation_request'),
    ritual: ritualComments > 0,
    exactToSign: exactToSignComments > 0,
    merchandise: codes.has('merchandise_intent'),
    purchase: codes.has('strict_purchase_intent'),
    price: codes.has('price_sensitivity'),
  };
  stats.tier = userTier(stats);
  return stats;
});

const userStatByKey = new Map(userStats.map((user) => [user.userKey, user]));
const textUserStats = userStats.filter((user) => user.textComments > 0);
const firstVideoByUser = new Map();
for (const [userKey, items] of audienceByUser) {
  const first = items[0];
  if (first) firstVideoByUser.set(userKey, first.videoId);
}

function summarizeUsers(users) {
  const eligible7 = users.filter((user) => user.eligible7);
  const eligible30 = users.filter((user) => user.eligible30);
  const roots = sum(users, (user) => user.textRoots);
  const replied = sum(users, (user) => user.authorRepliedRoots);
  return {
    users: users.length,
    comments: sum(users, (user) => user.comments),
    userShare: rate(users.length, userStats.length),
    commentShare: rate(sum(users, (user) => user.comments), audienceAll.length),
    averageComments: mean(users.map((user) => user.comments)),
    medianComments: median(users.map((user) => user.comments)),
    averageVideos: mean(users.map((user) => user.videos)),
    medianVideos: median(users.map((user) => user.videos)),
    repeatRate: rate(users.filter((user) => user.repeat).length, users.length),
    crossVideoRate: rate(users.filter((user) => user.crossVideo).length, users.length),
    stableRate: rate(users.filter((user) => user.stable).length, users.length),
    return7Rate: rate(eligible7.filter((user) => user.return7).length, eligible7.length),
    return7Eligible: eligible7.length,
    return30Rate: rate(eligible30.filter((user) => user.return30).length, eligible30.length),
    return30Eligible: eligible30.length,
    medianActiveSpanDays: median(users.filter((user) => user.repeat).map((user) => user.activeSpanDays)),
    rootAuthorReplyRate: rate(replied, roots),
    strictContextRate: rate(users.filter((user) => user.strictContext).length, users.length),
    purchaseRate: rate(users.filter((user) => user.purchase).length, users.length),
    purchaseUsers: users.filter((user) => user.purchase).length,
  };
}

const TIER_ORDER = ['一次性（1条）', '轻度复访（2-3条）', '活跃（4-9条）', '核心（10条+）'];
const activityTiers = TIER_ORDER.map((tier) => ({ tier, ...summarizeUsers(userStats.filter((user) => user.tier === tier)) }));

const returnSegments = [
  ['单条评论', (user) => user.comments === 1],
  ['同视频内重复', (user) => user.comments >= 2 && user.videos === 1],
  ['跨视频复访', (user) => user.videos >= 2],
  ['跨视频且跨度7天+', (user) => user.videos >= 2 && user.activeSpanDays >= 7],
  ['跨视频且跨度30天+', (user) => user.videos >= 2 && user.activeSpanDays >= 30],
  ['11个视频以上核心', (user) => user.videos >= 11],
].map(([segment, predicate]) => ({ segment, ...summarizeUsers(userStats.filter(predicate)) }));

const overallPurchaseRate = rate(textUserStats.filter((user) => user.purchase).length, textUserStats.length);
const segmentDefinitions = [
  ['卡宝人格受众', '至少一次精确点名“卡宝”', (user) => user.mascot],
  ['角色/IP受众', '至少一次点名武将、表字或稳定昵称', (user) => user.character],
  ['表字圈层受众', '至少一次调用表字或玩家稳定昵称', (user) => user.nickname],
  ['萌化情感受众', '至少一次萌化、照护或物种识别表达', (user) => user.cute],
  ['关系共创受众', '至少一次CP、礼貌投稿或悲剧修复表达', (user) => user.relationship],
  ['严格玩家语境受众', '至少一次命中严格圈层解码代码', (user) => user.strictContext],
  ['追更受众', '至少一次提出续集、更新或延展请求', (user) => user.continuation],
  ['奖励仪式受众', '至少一次to签或礼貌投稿', (user) => user.ritual],
  ['周边兴趣受众', '至少一次表达周边、玩偶、表情包等实物化诉求', (user) => user.merchandise],
  ['严格购买意向受众', '至少一次出现透明规则定义的近购买语境', (user) => user.purchase],
];

const audienceSegments = segmentDefinitions.map(([segment, definition, predicate]) => {
  const users = textUserStats.filter(predicate);
  const summary = summarizeUsers(users);
  return {
    segment,
    definition,
    ...summary,
    textUserShare: rate(users.length, textUserStats.length),
    purchaseLift: overallPurchaseRate ? summary.purchaseRate / overallPurchaseRate : 0,
    exactToSignRate: rate(users.filter((user) => user.exactToSign).length, users.length),
    contentEngagedRate: rate(users.filter((user) => user.contentComments > 0).length, users.length),
  };
});

const ritualQuality = [
  ['纯to签用户', (user) => user.exactToSignOnly],
  ['to签+其他内容用户', (user) => user.exactToSign && !user.exactToSignOnly],
  ['礼貌投稿用户', (user) => user.codes.has('submission_ritual')],
  ['无仪式文本用户', (user) => user.textComments > 0 && !user.ritual],
].map(([segment, predicate]) => ({ segment, ...summarizeUsers(userStats.filter(predicate)) }));

const purchaseUsers = textUserStats.filter((user) => user.purchase);
const merchandiseUsers = textUserStats.filter((user) => user.merchandise);
const purchaseMerchandiseOverlapUsers = purchaseUsers.filter((user) => user.merchandise).length;
const purchasePath = { firstTouch: 0, nurtured: 0, sameMomentWithPrior: 0, priorCommentsMedian: 0, daysToIntentMedian: 0 };
const priorCounts = [];
const daysToIntent = [];
const purchaseCategoryPatterns = [
  ['玩偶/娃娃', /玩偶|娃娃/u], ['毛绒/挂件', /毛绒|挂件/u], ['表情包', /表情包/u], ['手办', /手办/u],
  ['公仔', /公仔/u], ['盲盒', /盲盒/u], ['周边泛称', /周边/u], ['实体化', /实体/u],
];
const purchaseCategoryCounts = Object.fromEntries(purchaseCategoryPatterns.map(([label]) => [label, { comments: 0, users: new Set() }]));
for (const user of purchaseUsers) {
  const items = audienceByUser.get(user.userKey).filter((item) => item.text);
  const purchaseItems = items.filter((item) => item.codes.has('strict_purchase_intent'));
  const firstPurchase = purchaseItems[0];
  const prior = items.filter((item) => item.date && firstPurchase.date && item.date < firstPurchase.date && !item.codes.has('strict_purchase_intent'));
  if (!prior.length) purchasePath.firstTouch += 1;
  else {
    purchasePath.nurtured += 1;
    priorCounts.push(prior.length);
    daysToIntent.push((firstPurchase.date.getTime() - prior[0].date.getTime()) / DAY_MS);
  }
  for (const purchaseItem of purchaseItems) {
    for (const [label, pattern] of purchaseCategoryPatterns) {
      if (pattern.test(purchaseItem.text)) {
        purchaseCategoryCounts[label].comments += 1;
        purchaseCategoryCounts[label].users.add(user.userKey);
      }
    }
  }
}
purchasePath.priorCommentsMedian = median(priorCounts);
purchasePath.daysToIntentMedian = median(daysToIntent);

const purchaseCategories = Object.entries(purchaseCategoryCounts).map(([category, item]) => ({ category, comments: item.comments, users: item.users.size }));
const purchaseInterestOverlap = [
  ['有内容讨论', (user) => user.contentComments > 0], ['萌化/可爱', (user) => user.cute], ['角色识别', (user) => user.character],
  ['卡宝点名', (user) => user.mascot], ['表字/昵称', (user) => user.nickname], ['仪式互动', (user) => user.ritual],
  ['严格玩家语境', (user) => user.strictContext], ['关系/CP', (user) => user.relationship],
].map(([interest, predicate]) => ({ interest, users: purchaseUsers.filter(predicate).length, share: rate(purchaseUsers.filter(predicate).length, purchaseUsers.length) }));

const userMonthSets = new Map();
for (const user of userStats) userMonthSets.set(user.userKey, new Set((audienceByUser.get(user.userKey) ?? []).map((item) => item.month).filter(Boolean)));
const months = [...new Set(audienceAll.map((item) => item.month).filter(Boolean))].sort();
const monthlyAudience = months.map((month) => {
  const events = audienceAll.filter((item) => item.month === month);
  const activeKeys = new Set(events.map((item) => item.userKey));
  const newKeys = new Set([...activeKeys].filter((key) => monthKey(parseChinaDate(userStatByKey.get(key).firstAt)) === month));
  const returnKeys = new Set([...activeKeys].filter((key) => !newKeys.has(key)));
  const next = addMonths(month, 1);
  const next2 = addMonths(month, 2);
  const m1Eligible = months.includes(next);
  const m2Eligible = months.includes(next2);
  const m1Retained = [...newKeys].filter((key) => userMonthSets.get(key)?.has(next)).length;
  const m2Retained = [...newKeys].filter((key) => userMonthSets.get(key)?.has(next2)).length;
  return {
    month,
    comments: events.length,
    activeUsers: activeKeys.size,
    newUsers: newKeys.size,
    returningUsers: returnKeys.size,
    returningShare: rate(returnKeys.size, activeKeys.size),
    commentsPerUser: rate(events.length, activeKeys.size),
    cohortM1Eligible: m1Eligible,
    cohortM1Retention: m1Eligible ? rate(m1Retained, newKeys.size) : null,
    cohortM2Eligible: m2Eligible,
    cohortM2Retention: m2Eligible ? rate(m2Retained, newKeys.size) : null,
  };
});

const metadataLikeSources = { structured_metadata: 0, video_card_text_snapshot: 0, missing: 0 };
const videos = rawVideos.map((row) => {
  const id = String(row['视频ID']);
  const metadata = metadataById.get(id) ?? {};
  const like = extractCardLikes(metadata);
  metadataLikeSources[like.source] += 1;
  const videoComments = commentsByVideo.get(id) ?? [];
  const audience = videoComments.filter((comment) => !comment.author && comment.userKey);
  const textAudience = audience.filter((comment) => comment.text);
  const users = new Set(audience.map((comment) => comment.userKey));
  const firstTouch = new Set([...users].filter((key) => firstVideoByUser.get(key) === id));
  const returning = new Set([...users].filter((key) => firstVideoByUser.get(key) !== id));
  const roots = textAudience.filter((comment) => comment.relation === '根评论');
  const published = parseChinaDate(row['视频发布时间'] || metadata.video_publish_time || metadata.publish_time_raw);
  const lifecycle = { h1: 0, h6: 0, h24: 0, d7: 0 };
  if (published) {
    for (const comment of audience) {
      if (!comment.date) continue;
      const lag = comment.date.getTime() - published.getTime();
      if (lag < 0) continue;
      if (lag <= 3600000) lifecycle.h1 += 1;
      if (lag <= 6 * 3600000) lifecycle.h6 += 1;
      if (lag <= 24 * 3600000) lifecycle.h24 += 1;
      if (lag <= 7 * DAY_MS) lifecycle.d7 += 1;
    }
  }
  return {
    id,
    title: String(row['视频标题'] ?? ''),
    url: String(row['视频URL'] ?? metadata.video_url ?? ''),
    publishedAt: published?.toISOString() ?? '',
    publishedAvailable: Boolean(published),
    displayedLikes: like.value,
    likeSource: like.source,
    declaredComments: number(row['声明评论数']),
    capturedComments: number(row['实际采集评论数']),
    audienceComments: audience.length,
    audienceTextComments: textAudience.length,
    audienceUsers: users.size,
    firstTouchUsers: firstTouch.size,
    returningUsers: returning.size,
    returningShare: rate(returning.size, users.size),
    firstTouchPer1kLikes: like.value ? (firstTouch.size / like.value) * 1000 : null,
    audiencePer1kLikes: like.value ? (users.size / like.value) * 1000 : null,
    commentsPer1kLikes: like.value ? (audience.length / like.value) * 1000 : null,
    strictContextComments: textAudience.filter((comment) => hasAny(comment, strictCodes)).length,
    strictContextShare: rate(textAudience.filter((comment) => hasAny(comment, strictCodes)).length, textAudience.length),
    coCreationComments: textAudience.filter((comment) => hasAny(comment, coCreationCodes)).length,
    coCreationShare: rate(textAudience.filter((comment) => hasAny(comment, coCreationCodes)).length, textAudience.length),
    exactToSignComments: textAudience.filter(isExactToSign).length,
    strictPurchaseUsers: unique(textAudience.filter((comment) => comment.codes.has('strict_purchase_intent')).map((comment) => comment.userKey)),
    strictPurchaseComments: textAudience.filter((comment) => comment.codes.has('strict_purchase_intent')).length,
    authorReplyRate: rate(roots.filter((comment) => comment.authorReplied).length, roots.length),
    lifecycle,
  };
});

const videoById = new Map(videos.map((video) => [video.id, video]));
const allCharacterNames = CHARACTER_GROUPS.flatMap((group) => group.names);
const allCharacterPattern = namesPattern(allCharacterNames);

const titleArchetypes = [
  ['series', '连续剧集编号', (title) => /第\s*\d+\s*集/u.test(title)],
  ['dialogue', '角色对白式标题', (title) => /[:：]/u.test(title)],
  ['relationship_scene', '双角色关系戏', (title) => CHARACTER_GROUPS.filter((group) => group.pattern.test(title)).length >= 2],
  ['game_system', '规则/玩家体验', (title) => /技能|武将|卖血|锁定技|铁骑|雄乱|放逐|屯田|开盒|爆率|斗地主|排位|主公|忠臣|反贼|内奸|摸牌|卡牌/u.test(title)],
  ['modern_transplant', '现代生活移植', (title) => /上班|职场|工作|老板|工资|房地产|出租|娃娃机|外卖|奶茶|手机|甲方|开会|同事/u.test(title)],
  ['mascot_showcase', '卡宝本体展示', (title) => {
    const body = String(title).replace(/#[^\s#]+/gu, '');
    return /卡宝/u.test(body) && !allCharacterPattern.test(body);
  }],
];

for (const video of videos) video.archetypes = titleArchetypes.filter(([, , test]) => test(video.title)).map(([id]) => id);

const portfolioMedian = {
  displayedLikes: median(videos.map((video) => video.displayedLikes).filter((value) => value !== null)),
  capturedComments: median(videos.map((video) => video.capturedComments)),
  audienceUsers: median(videos.map((video) => video.audienceUsers)),
  firstTouchUsers: median(videos.map((video) => video.firstTouchUsers)),
  returningShare: median(videos.map((video) => video.returningShare)),
};

const archetypeMetrics = titleArchetypes.map(([id, label]) => {
  const matched = videos.filter((video) => video.archetypes.includes(id));
  return {
    id,
    label,
    videos: matched.length,
    likesMedian: median(matched.map((video) => video.displayedLikes).filter((value) => value !== null)),
    commentsMedian: median(matched.map((video) => video.capturedComments)),
    audienceUsersMedian: median(matched.map((video) => video.audienceUsers)),
    firstTouchUsersMedian: median(matched.map((video) => video.firstTouchUsers)),
    returningShareMedian: median(matched.map((video) => video.returningShare)),
    strictContextShare: rate(sum(matched, (video) => video.strictContextComments), sum(matched, (video) => video.audienceTextComments)),
    purchaseUsers: sum(matched, (video) => video.strictPurchaseUsers),
    likeIndex: portfolioMedian.displayedLikes ? median(matched.map((video) => video.displayedLikes).filter((value) => value !== null)) / portfolioMedian.displayedLikes : 0,
    audienceIndex: portfolioMedian.audienceUsers ? median(matched.map((video) => video.audienceUsers)) / portfolioMedian.audienceUsers : 0,
    firstTouchIndex: portfolioMedian.firstTouchUsers ? median(matched.map((video) => video.firstTouchUsers)) / portfolioMedian.firstTouchUsers : 0,
  };
});

function userCohortMetrics(userKeys) {
  const cohort = [...userKeys].map((key) => userStatByKey.get(key)).filter(Boolean);
  return {
    users: cohort.length,
    repeatRate: rate(cohort.filter((user) => user.repeat).length, cohort.length),
    crossVideoRate: rate(cohort.filter((user) => user.crossVideo).length, cohort.length),
    stableRate: rate(cohort.filter((user) => user.stable).length, cohort.length),
    strictContextRate: rate(cohort.filter((user) => user.strictContext).length, cohort.length),
    coCreationRate: rate(cohort.filter((user) => user.coCreation).length, cohort.length),
    merchandiseRate: rate(cohort.filter((user) => user.merchandise).length, cohort.length),
    purchaseRate: rate(cohort.filter((user) => user.purchase).length, cohort.length),
    averageComments: mean(cohort.map((user) => user.comments)),
    averageVideos: mean(cohort.map((user) => user.videos)),
  };
}

const characterMetrics = CHARACTER_GROUPS.map((group) => {
  const suppliedVideos = videos.filter((video) => group.pattern.test(video.title));
  const suppliedIds = new Set(suppliedVideos.map((video) => video.id));
  const outsideComments = audienceText.filter((comment) => !comment.codes.has('tosign_ritual') && !suppliedIds.has(comment.videoId));
  const spontaneous = outsideComments.filter((comment) => group.pattern.test(comment.text));
  const spontaneousUsers = new Set(spontaneous.map((comment) => comment.userKey));
  const exposed = audienceText.filter((comment) => suppliedIds.has(comment.videoId));
  return {
    id: group.id,
    label: group.label,
    supplyVideos: suppliedVideos.length,
    supplyShare: rate(suppliedVideos.length, videos.length),
    titleExposureUsers: unique(exposed.map((comment) => comment.userKey)),
    spontaneousComments: spontaneous.length,
    spontaneousUsers: spontaneousUsers.size,
    spontaneousLikes: sum(spontaneous, (comment) => comment.likes),
    spontaneousCommentsPer1kOutside: rate(spontaneous.length, outsideComments.length) * 1000,
    spontaneousUsersPer1kOutsideUsers: rate(spontaneousUsers.size, unique(outsideComments.map((comment) => comment.userKey))) * 1000,
    spontaneousPurchaseUsers: unique(spontaneous.filter((comment) => comment.codes.has('strict_purchase_intent')).map((comment) => comment.userKey)),
    ...userCohortMetrics(spontaneousUsers),
  };
});

const eligibleCharacters = characterMetrics.filter((item) => item.supplyVideos > 0 || item.spontaneousUsers >= 3);
const maxCharacterSupply = Math.max(...eligibleCharacters.map((item) => item.supplyVideos), 0);
const maxCharacterUsers = Math.max(...eligibleCharacters.map((item) => item.spontaneousUsers), 0);
const maxCharacterComments = Math.max(...eligibleCharacters.map((item) => item.spontaneousComments), 0);
const maxCharacterLikes = Math.max(...eligibleCharacters.map((item) => item.spontaneousLikes), 0);
for (const item of characterMetrics) {
  item.supplyIndex = maxCharacterSupply ? 100 * Math.log1p(item.supplyVideos) / Math.log1p(maxCharacterSupply) : 0;
  item.demandIndex = 100 * (
    0.5 * (maxCharacterUsers ? Math.log1p(item.spontaneousUsers) / Math.log1p(maxCharacterUsers) : 0)
    + 0.3 * (maxCharacterComments ? Math.log1p(item.spontaneousComments) / Math.log1p(maxCharacterComments) : 0)
    + 0.2 * (maxCharacterLikes ? Math.log1p(item.spontaneousLikes) / Math.log1p(maxCharacterLikes) : 0)
  );
  item.gapIndex = item.demandIndex - item.supplyIndex;
}
const supplyThreshold = median(eligibleCharacters.map((item) => item.supplyIndex));
const demandThreshold = median(eligibleCharacters.map((item) => item.demandIndex));
for (const item of characterMetrics) {
  const supply = item.supplyIndex >= supplyThreshold ? '高供给' : '低供给';
  const demand = item.demandIndex >= demandThreshold ? '高自发需求' : '低自发需求';
  item.quadrant = `${supply} × ${demand}`;
}
characterMetrics.sort((left, right) => right.demandIndex - left.demandIndex || right.spontaneousUsers - left.spontaneousUsers);

const characterById = new Map(CHARACTER_GROUPS.map((group) => [group.id, group]));
const pairMetrics = PAIRS.map(([id, label, leftId, rightId]) => {
  const left = characterById.get(leftId);
  const right = characterById.get(rightId);
  const suppliedVideos = videos.filter((video) => left.pattern.test(video.title) && right.pattern.test(video.title));
  const suppliedIds = new Set(suppliedVideos.map((video) => video.id));
  const outside = audienceText.filter((comment) => !comment.codes.has('tosign_ritual') && !suppliedIds.has(comment.videoId));
  const spontaneous = outside.filter((comment) => left.pattern.test(comment.text) && right.pattern.test(comment.text));
  const users = new Set(spontaneous.map((comment) => comment.userKey));
  return {
    id,
    label,
    supplyVideos: suppliedVideos.length,
    spontaneousComments: spontaneous.length,
    spontaneousUsers: users.size,
    spontaneousLikes: sum(spontaneous, (comment) => comment.likes),
    spontaneousShippingComments: spontaneous.filter((comment) => comment.codes.has('relationship_shipping')).length,
    spontaneousActionComments: spontaneous.filter((comment) => ['submission_ritual', 'continuation_request', 'merchandise_intent', 'strict_purchase_intent'].some((code) => comment.codes.has(code))).length,
    ...userCohortMetrics(users),
  };
});

const maxPairSupply = Math.max(...pairMetrics.map((item) => item.supplyVideos), 0);
const maxPairUsers = Math.max(...pairMetrics.map((item) => item.spontaneousUsers), 0);
const maxPairComments = Math.max(...pairMetrics.map((item) => item.spontaneousComments), 0);
const maxPairLikes = Math.max(...pairMetrics.map((item) => item.spontaneousLikes), 0);
for (const item of pairMetrics) {
  item.supplyIndex = maxPairSupply ? 100 * Math.log1p(item.supplyVideos) / Math.log1p(maxPairSupply) : 0;
  item.demandIndex = 100 * (
    0.5 * (maxPairUsers ? Math.log1p(item.spontaneousUsers) / Math.log1p(maxPairUsers) : 0)
    + 0.3 * (maxPairComments ? Math.log1p(item.spontaneousComments) / Math.log1p(maxPairComments) : 0)
    + 0.2 * (maxPairLikes ? Math.log1p(item.spontaneousLikes) / Math.log1p(maxPairLikes) : 0)
  );
  item.gapIndex = item.demandIndex - item.supplyIndex;
}
const pairSupplyThreshold = median(pairMetrics.map((item) => item.supplyIndex));
const pairDemandThreshold = median(pairMetrics.map((item) => item.demandIndex));
for (const item of pairMetrics) {
  const supply = item.supplyIndex >= pairSupplyThreshold ? '高供给' : '低供给';
  const demand = item.demandIndex >= pairDemandThreshold ? '高自发需求' : '低自发需求';
  item.quadrant = `${supply} × ${demand}`;
}
pairMetrics.sort((left, right) => right.demandIndex - left.demandIndex || right.spontaneousUsers - left.spontaneousUsers);

const lifecycleBins = [
  ['0-1小时', 0, 1 / 24], ['1-6小时', 1 / 24, 6 / 24], ['6-24小时', 6 / 24, 1], ['1-3天', 1, 3],
  ['3-7天', 3, 7], ['7-30天', 7, 30], ['30天以上', 30, Infinity],
];
const lifecycleVideos = videos.filter((video) => video.publishedAvailable);
const lifecycleRows = lifecycleBins.map(([bin, minimum, maximum]) => {
  const matched = [];
  for (const video of lifecycleVideos) {
    const published = parseChinaDate(video.publishedAt);
    for (const comment of (commentsByVideo.get(video.id) ?? []).filter((item) => !item.author && item.userKey && item.date)) {
      const lagDays = (comment.date.getTime() - published.getTime()) / DAY_MS;
      if (lagDays >= minimum && lagDays < maximum) matched.push(comment);
    }
  }
  const roots = matched.filter((comment) => comment.relation === '根评论' && comment.text);
  return {
    bin,
    comments: matched.length,
    users: unique(matched.map((comment) => comment.userKey)),
    likes: sum(matched, (comment) => comment.likes),
    authorReplyRate: rate(roots.filter((comment) => comment.authorReplied).length, roots.length),
    coreUserCommentShare: rate(matched.filter((comment) => userStatByKey.get(comment.userKey)?.core).length, matched.length),
  };
});

const locationMetrics = [...new Set(audienceAll.map((comment) => comment.location).filter(Boolean))].map((location) => {
  const matched = audienceAll.filter((comment) => comment.location === location);
  const users = new Set(matched.map((comment) => comment.userKey));
  const textUsers = [...users].map((key) => userStatByKey.get(key)).filter((user) => user?.textComments > 0);
  return {
    location,
    comments: matched.length,
    users: users.size,
    commentShare: rate(matched.length, audienceAll.length),
    userShare: rate(users.size, userStats.length),
    purchaseUsers: textUsers.filter((user) => user.purchase).length,
    purchaseRate: rate(textUsers.filter((user) => user.purchase).length, textUsers.length),
  };
}).sort((left, right) => right.users - left.users);

function topVideos(selector, filter = () => true, count = 10) {
  return videos.filter(filter).sort((left, right) => (selector(right) ?? -Infinity) - (selector(left) ?? -Infinity)).slice(0, count).map((video) => ({ ...video }));
}

const videoRankings = {
  displayedLikes: topVideos((video) => video.displayedLikes),
  firstTouchUsers: topVideos((video) => video.firstTouchUsers),
  returningUsers: topVideos((video) => video.returningUsers),
  returningShare: topVideos((video) => video.returningShare, (video) => video.audienceUsers >= 50),
  conversationDensity: topVideos((video) => video.commentsPer1kLikes, (video) => video.displayedLikes >= 500),
  strictContextShare: topVideos((video) => video.strictContextShare, (video) => video.audienceTextComments >= 50),
  purchaseUsers: topVideos((video) => video.strictPurchaseUsers),
};

const concentration = {
  commentGini: gini(userStats.map((user) => user.comments)),
  likeGini: gini(userStats.map((user) => user.likesReceived)),
  top1CommentShare: topShare(userStats.map((user) => user.comments), 0.01),
  top5CommentShare: topShare(userStats.map((user) => user.comments), 0.05),
  top10CommentShare: topShare(userStats.map((user) => user.comments), 0.10),
  top1LikeShare: topShare(userStats.map((user) => user.likesReceived), 0.01),
  top5LikeShare: topShare(userStats.map((user) => user.likesReceived), 0.05),
};

const interactionStructure = {
  roots: audienceAll.filter((comment) => comment.relation === '根评论').length,
  firstLevelReplies: audienceAll.filter((comment) => comment.relation !== '根评论' && comment.level === 1).length,
  deepReplies: audienceAll.filter((comment) => comment.level >= 2).length,
  replyUsers: userStats.filter((user) => user.replies > 0).length,
  deepReplyUsers: userStats.filter((user) => user.deepReplies > 0).length,
  textRoots: audienceText.filter((comment) => comment.relation === '根评论').length,
  authorRepliedTextRoots: audienceText.filter((comment) => comment.relation === '根评论' && comment.authorReplied).length,
};

const contentRitualMatrix = [
  ['仅内容', (comment) => hasAny(comment, contentCodes) && !(hasAny(comment, ritualCodes) || isExactToSign(comment))],
  ['仅仪式', (comment) => !hasAny(comment, contentCodes) && (hasAny(comment, ritualCodes) || isExactToSign(comment))],
  ['内容且仪式', (comment) => hasAny(comment, contentCodes) && (hasAny(comment, ritualCodes) || isExactToSign(comment))],
  ['其他/规则未命中', (comment) => !hasAny(comment, contentCodes) && !(hasAny(comment, ritualCodes) || isExactToSign(comment))],
].map(([segment, predicate]) => {
  const matched = audienceText.filter(predicate);
  return { segment, comments: matched.length, commentShare: rate(matched.length, audienceText.length), users: unique(matched.map((item) => item.userKey)) };
});

const sourceHashes = [SOURCE_COMMENTS, SOURCE_VIDEOS, SOURCE_MANIFEST, CODED_COMMENTS, GROUNDED_ANALYSIS].map((file) => ({
  file,
  bytes: fs.statSync(file).size,
  sha256: sha256File(file),
}));

const result = {
  generatedAt: new Date().toISOString(),
  reportType: '粉丝与受众MKT经营分析（评论受众代理）',
  methodology: {
    unit: '评论事件、去重评论用户、视频；用户以评论用户URL优先、昵称回退构造内部主键。',
    audienceBoundary: '5,410位用户仅代表采集窗口内可识别的非作者评论者，不代表全部粉丝、观看者或触达人群。',
    returnBoundary: '复访为跨视频或跨日期再次发表评论的行为代理，不等于平台观看留存、关注留存。',
    videoLikeBoundary: '107条视频点赞为采集时点的显示快照；结构化字段优先，否则从video_card_text首个数值恢复。评论/千赞是讨论密度，不是互动率。',
    lifecycleBoundary: `只有${lifecycleVideos.length}/107条视频有可用发布时间，生命周期仅作局部样本描述。`,
    commerceBoundary: '周边与购买意向是表达信号，不等于订单、销量、支付或市场规模；情景测算是决策参数，不是预测。',
    groundedBoundary: grounded.methodology.evidenceBoundary,
  },
  integrity: {
    rawComments: rawComments.length,
    codedComments: codedRows.length,
    joinedComments: comments.length,
    missingCoded,
    extraCoded,
    videos: videos.length,
    metadataRecords: metadataById.size,
    invalidMetadataFiles,
    sourceManifestVersion: sourceManifest.schema_version ?? sourceManifest.version ?? null,
    sourceHashes,
  },
  coverage: {
    declaredComments: sum(videos, (video) => video.declaredComments),
    capturedComments: sum(videos, (video) => video.capturedComments),
    captureRate: rate(sum(videos, (video) => video.capturedComments), sum(videos, (video) => video.declaredComments)),
    allComments: comments.length,
    audienceComments: audienceAll.length,
    authorComments: comments.filter((comment) => comment.author).length,
    audienceTextComments: audienceText.length,
    audienceUsers: userStats.length,
    textAudienceUsers: textUserStats.length,
    dateStart: new Date(Math.min(...audienceAll.map((comment) => comment.date?.getTime() ?? Infinity))).toISOString(),
    dateEnd: maximumCommentDate.toISOString(),
    likeSnapshotsAvailable: videos.filter((video) => video.displayedLikes !== null).length,
    likeSources: metadataLikeSources,
    publishTimesAvailable: lifecycleVideos.length,
    collectShareFieldsAvailable: [...metadataById.values()].filter((metadata) => finiteNumber(metadata.video_collects ?? metadata.collects) !== null && finiteNumber(metadata.video_shares ?? metadata.shares) !== null).length,
  },
  audienceAsset: {
    overall: summarizeUsers(userStats),
    activityTiers,
    returnSegments,
    concentration,
    interactionStructure,
    contentRitualMatrix,
  },
  monthlyAudience,
  audienceSegments,
  ritualQuality,
  commerce: {
    textAudienceUsers: textUserStats.length,
    merchandiseUsers: merchandiseUsers.length,
    merchandiseUserRate: rate(merchandiseUsers.length, textUserStats.length),
    purchaseUsers: purchaseUsers.length,
    purchaseUserRate: overallPurchaseRate,
    purchaseMerchandiseOverlapUsers,
    purchaseOutsideMerchandiseUsers: purchaseUsers.length - purchaseMerchandiseOverlapUsers,
    purchaseMerchandiseOverlapRate: rate(purchaseMerchandiseOverlapUsers, purchaseUsers.length),
    purchaseComments: audienceText.filter((comment) => comment.codes.has('strict_purchase_intent')).length,
    purchaseCommentLikes: sum(audienceText.filter((comment) => comment.codes.has('strict_purchase_intent')), (comment) => comment.likes),
    priceUsers: textUserStats.filter((user) => user.price).length,
    purchasePath,
    purchaseCategories,
    purchaseInterestOverlap,
    purchaseActivity: summarizeUsers(purchaseUsers),
    scenarioSeeds: [0.10, 0.20, 0.30].map((conversion) => ({ conversion, deposits: Math.round(purchaseUsers.length * conversion) })),
  },
  videoPortfolio: {
    medians: portfolioMedian,
    videos,
    rankings: videoRankings,
    archetypes: archetypeMetrics,
    lifecycleSample: { videos: lifecycleVideos.length, rows: lifecycleRows },
  },
  roleMarket: {
    dictionaryCharacters: CHARACTER_GROUPS.length,
    definitions: {
      supply: '视频标题或标签命中角色；关系供给要求同一标题同时命中双方。',
      spontaneousDemand: '标题未命中该角色/关系时，非作者评论正文仍点名该角色/双方；主口径排除to签奖励仪式，避免批量点名虚增需求。',
      index: '供给指数=100×ln(1+供给视频)/ln(1+最大供给)；需求指数=100×[50%自发用户+30%自发评论+20%自发评论获赞]，三项均经ln(1+x)和全体最大值标准化。指数是选题排序启发式，不是市场规模。',
      quadrant: `47个角色以供给指数中位数${round(supplyThreshold, 2)}和需求指数中位数${round(demandThreshold, 2)}划分；8组关系使用各自集合中位数。`,
      caveat: '角色点名受选题曝光、词典边界和采集窗口影响，是内容需求代理，不是总体角色偏好投票。',
    },
    thresholds: { supplyIndexMedian: supplyThreshold, demandIndexMedian: demandThreshold, pairSupplyIndexMedian: pairSupplyThreshold, pairDemandIndexMedian: pairDemandThreshold },
    characters: characterMetrics,
    pairs: pairMetrics,
  },
  locations: {
    caveat: '评论地点是平台显示的IP标签，不等同常住地、粉丝所在地或可配送地址。',
    top: locationMetrics.slice(0, 20),
  },
  groundedEvidence: {
    strictKnowledgeMetric: grounded.strictKnowledgeMetric,
    audienceStrictKnowledgeMetric: {
      comments: audienceStrictContextComments.length,
      users: audienceStrictContextUsers.size,
      shareOfAudienceText: rate(audienceStrictContextComments.length, audienceText.length),
      userShareOfTextAudience: rate(audienceStrictContextUsers.size, textUserStats.length),
      authorCommentsExcluded: grounded.strictKnowledgeMetric.authorComments,
    },
    depthMetrics: grounded.depthMetrics,
    openCodes: grounded.openCodes.map(({ id, label, comments: matchedComments, users, likes, shareOfNonEmpty }) => ({ id, label, comments: matchedComments, users, likes, shareOfNonEmpty })),
    method: grounded.methodology,
  },
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const analysisPath = path.join(OUTPUT_DIR, 'wuhu-mkt-audience-analysis.json');
fs.writeFileSync(analysisPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

const userRows = userStats.map((user) => ({
  '匿名受众ID': user.userId,
  '活跃层': user.tier,
  '评论数': user.comments,
  '有文本评论数': user.textComments,
  '评论视频数': user.videos,
  '活跃天数': user.days,
  '活跃跨度天': round(user.activeSpanDays, 3),
  '根评论数': user.roots,
  '有文本根评论数': user.textRoots,
  '回复数': user.replies,
  '二级及以上回复数': user.deepReplies,
  '作者回复根评数': user.authorRepliedRoots,
  '跨视频复访代理': user.crossVideo,
  '观察7日回访': user.return7,
  '观察30日回访': user.return30,
  '卡宝人格': user.mascot,
  '角色IP': user.character,
  '表字昵称': user.nickname,
  '萌化情感': user.cute,
  '关系共创': user.relationship,
  '严格玩家语境': user.strictContext,
  '奖励仪式': user.ritual,
  '纯to签': user.exactToSignOnly,
  '周边兴趣': user.merchandise,
  '严格购买意向': user.purchase,
  '评论获赞': user.likesReceived,
}));
const userHeaders = Object.keys(userRows[0]);
const userPath = path.join(OUTPUT_DIR, 'wuhu-mkt-pseudonymous-audience-segments.csv');
fs.writeFileSync(userPath, stringifyCsv(userRows, userHeaders), 'utf8');

console.log(JSON.stringify({
  analysisPath,
  userPath,
  coverage: result.coverage,
  activityTiers: result.audienceAsset.activityTiers,
  commerce: result.commerce,
  roleTop5: result.roleMarket.characters.slice(0, 5).map(({ label, supplyVideos, spontaneousUsers, spontaneousComments, spontaneousUsersPer1kOutsideUsers, quadrant }) => ({ label, supplyVideos, spontaneousUsers, spontaneousComments, spontaneousUsersPer1kOutsideUsers, quadrant })),
}, null, 2));
