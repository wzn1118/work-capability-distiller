import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE_DIR = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const BASE_DIR = path.join(ROOT, 'output/wuhu-mkt-audience-analysis-20260814');
const GROUNDED_DIR = path.join(ROOT, 'output/wuhu-grounded-player-context-20260813');
const OUT_DIR = path.join(ROOT, 'output/wuhu-mkt-deep-analysis-20260814');
const RAW_COMMENTS_PATH = path.join(SOURCE_DIR, 'all-comments.csv');
const CODED_COMMENTS_PATH = path.join(GROUNDED_DIR, 'wuhu-grounded-coded-comments.csv');
const BASE_ANALYSIS_PATH = path.join(BASE_DIR, 'wuhu-mkt-audience-analysis.json');
const GROUNDED_ANALYSIS_PATH = path.join(GROUNDED_DIR, 'wuhu-grounded-player-context-analysis.json');

const DAY = 86_400_000;
const HOUR = 3_600_000;

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
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
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
  const lines = [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function number(value) {
  const parsed = Number(String(value ?? '').replace(/^[\s']+/, '').replace(/[, +]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseChinaDate(value) {
  const match = String(value ?? '').match(/(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function chinaDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
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

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function unique(values) {
  return new Set(values).size;
}

function bool(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function pseudonym(userKey) {
  return `aud_${crypto.createHash('sha256').update(`wuhu-mkt-v1\0${userKey}`).digest('hex').slice(0, 16)}`;
}

function hasAny(item, codes) {
  return codes.some((code) => item.codes.has(code));
}

function tierOf(count) {
  if (count === 1) return '一次性（1条）';
  if (count <= 3) return '轻度复访（2-3条）';
  if (count <= 9) return '活跃（4-9条）';
  return '核心（10条+）';
}

function summary(values) {
  return {
    n: values.length,
    p25: round(quantile(values, 0.25), 3),
    median: round(median(values), 3),
    p75: round(quantile(values, 0.75), 3),
    p90: round(quantile(values, 0.9), 3),
    mean: round(mean(values), 3),
  };
}

function inc(map, key, value = 1) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function mapToSortedRows(map, total, limit = null) {
  const rows = [...map.entries()]
    .map(([key, count]) => ({ key, count, share: rate(count, total) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return limit ? rows.slice(0, limit) : rows;
}

function primaryArchetype(video) {
  const types = new Set(video?.archetypes ?? []);
  if (types.has('mascot_showcase')) return 'mascot_showcase';
  if (types.has('game_system')) return 'game_system';
  if (types.has('modern_transplant')) return 'modern_transplant';
  if (types.has('relationship_scene')) return 'relationship_scene';
  if (types.has('dialogue')) return 'dialogue';
  if (types.has('series')) return 'series';
  return 'other';
}

const ARCHETYPE_LABELS = {
  mascot_showcase: '卡宝本体展示',
  game_system: '规则/玩家体验',
  modern_transplant: '现代生活移植',
  relationship_scene: '双角色关系戏',
  dialogue: '角色对白',
  series: '连续剧集',
  other: '其他叙事',
};

const STATE_LABELS = {
  purchase: '购买行动',
  merchandise: '周边兴趣',
  co_creation: '共创/追更',
  ritual: '活动仪式',
  intertext: '玩家互文',
  recognition: '角色识别',
  affect: '萌化情感',
  reaction: '即时反应',
};

const ENTRY_ORDER = ['purchase', 'merchandise', 'co_creation', 'ritual', 'intertext', 'recognition', 'affect', 'reaction'];
const DEPTH_ORDER = { reaction: 0, recognition: 1, intertext: 2, co_creation: 3, action: 4 };
const CO_CREATION_CODES = ['relationship_shipping', 'submission_ritual', 'continuation_request', 'tragic_repair', 'role_address_play', 'protective_care'];
const CONTENT_CODES = [
  'accessibility_request', 'ai_quality_rights', 'canon_audit', 'canon_irony', 'character_recognition',
  'content_boundary_rejection', 'continuation_request', 'counter_shipping', 'courtesy_nickname',
  'cute_infantilization', 'game_economy_memory', 'game_system_jargon',
  'historical_intertext', 'canon_audit', 'canon_irony', 'voice_line_callback', 'interpretive_explanation',
  'knowledge_threshold_question', 'mascot_identity_question', 'mechanic_remap_validation',
  'moral_personality_judgment', 'narrative_interaction_question', 'protective_care',
  'relationship_shipping', 'role_address_play', 'tragic_repair',
];
const RITUAL_CODES = ['tosign_ritual', 'submission_ritual'];
const TOSIGN_ROLE_SLOT_CODES = new Set(['character_recognition', 'courtesy_nickname', 'role_address_play']);
const ORGANIC_CO_CREATION_CODES = ['relationship_shipping', 'tragic_repair', 'protective_care', 'role_address_play', 'continuation_request'];
const ROLE_AFFECT_CODES = ['character_recognition', 'courtesy_nickname', 'cute_infantilization', 'mascot_persona_reference', 'mascot_identity_question'];
// L1 is deliberately narrow but includes all non-character, non-mechanic content cues.
// This keeps L0 as an uncoded remainder instead of silently treating entry-friction and
// community-address comments as “no content signal”.
const GENERAL_CONTENT_CODES = [
  'knowledge_threshold_question', 'narrative_interaction_question', 'moral_personality_judgment',
  'content_boundary_rejection', 'accessibility_request', 'ai_quality_rights', 'game_system_jargon',
  'canon_irony', 'outsider_self_identification', 'official_identity_confusion',
  'community_address', 'publisher_pun_grievance',
];
const TRIBE_DEFINITIONS = [
  ['mascot', '卡宝人格', (user) => user.codes.has('mascot_persona_reference')],
  ['character', '角色IP', (user) => user.codes.has('character_recognition')],
  ['nickname', '表字昵称', (user) => user.codes.has('courtesy_nickname')],
  ['cute', '萌化情感', (user) => hasAny({ codes: user.codes }, ['cute_infantilization', 'protective_care', 'mascot_identity_question'])],
  ['relationship', '关系共创', (user) => hasAny({ codes: user.codes }, ['relationship_shipping', 'submission_ritual', 'tragic_repair'])],
  ['strict', '严格玩家语境', (user) => user.strict],
  ['cocreation', '主动共创', (user) => hasAny({ codes: user.codes }, CO_CREATION_CODES)],
  ['merchandise', '周边兴趣', (user) => user.codes.has('merchandise_intent')],
  ['purchase', '严格购买', (user) => user.codes.has('strict_purchase_intent')],
];

function classifyState(item, strictCodes) {
  if (item.codes.has('strict_purchase_intent')) return 'purchase';
  if (item.codes.has('merchandise_intent') || item.codes.has('price_sensitivity')) return 'merchandise';
  if (hasAny(item, CO_CREATION_CODES)) return 'co_creation';
  if (item.codes.has('tosign_ritual')) return 'ritual';
  if (hasAny(item, strictCodes) || item.depth === 'intertext') return 'intertext';
  if (item.codes.has('character_recognition') || item.codes.has('courtesy_nickname') || item.depth === 'recognition') return 'recognition';
  if (hasAny(item, ['cute_infantilization', 'mascot_persona_reference', 'protective_care', 'mascot_identity_question'])) return 'affect';
  return 'reaction';
}

function userOutcomeSummary(users, maxDate) {
  const eligible7 = users.filter((user) => maxDate - user.firstAt >= 7 * DAY);
  const eligible30 = users.filter((user) => maxDate - user.firstAt >= 30 * DAY);
  const secondLags = users.filter((user) => user.events.length >= 2).map((user) => (user.events[1].date - user.events[0].date) / HOUR);
  return {
    users: users.length,
    userShare: rate(users.length, 4990),
    repeatRate: rate(users.filter((user) => user.events.length >= 2).length, users.length),
    crossVideoRate: rate(users.filter((user) => user.videoCount >= 2).length, users.length),
    fourPlusRate: rate(users.filter((user) => user.events.length >= 4).length, users.length),
    tenPlusRate: rate(users.filter((user) => user.events.length >= 10).length, users.length),
    return7Rate: rate(eligible7.filter((user) => user.events.some((event) => event.date - user.firstAt >= 7 * DAY)).length, eligible7.length),
    return7Eligible: eligible7.length,
    return30Rate: rate(eligible30.filter((user) => user.events.some((event) => event.date - user.firstAt >= 30 * DAY)).length, eligible30.length),
    return30Eligible: eligible30.length,
    medianSecondLagHours: round(median(secondLags), 2),
    laterStrictRate: rate(users.filter((user) => user.events.some((item) => item.date.getTime() > user.entryAt && item.strict)).length, users.length),
    laterCoCreationRate: rate(users.filter((user) => user.events.some((item) => item.date.getTime() > user.entryAt && hasAny(item, CO_CREATION_CODES))).length, users.length),
    laterPurchaseRate: rate(users.filter((user) => user.events.some((item) => item.date.getTime() > user.entryAt && item.codes.has('strict_purchase_intent'))).length, users.length),
    averageComments: round(mean(users.map((user) => user.allEvents.length)), 2),
    averageVideos: round(mean(users.map((user) => user.videoCount)), 2),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const rawRows = parseCsv(fs.readFileSync(RAW_COMMENTS_PATH, 'utf8'));
const codedRows = parseCsv(fs.readFileSync(CODED_COMMENTS_PATH, 'utf8'));
const base = JSON.parse(fs.readFileSync(BASE_ANALYSIS_PATH, 'utf8'));
const grounded = JSON.parse(fs.readFileSync(GROUNDED_ANALYSIS_PATH, 'utf8'));
const codedById = new Map(codedRows.map((row) => [String(row['评论ID']), {
  text: String(row['评论内容(去标识)'] ?? '').trim(),
  codes: new Set(String(row['开放编码'] ?? '').split('|').filter(Boolean)),
  axes: new Set(String(row['主轴编码'] ?? '').split('|').filter(Boolean)),
  depth: String(row['参与深度'] ?? ''),
}]));
const strictCodes = grounded.strictKnowledgeMetric.codes;
const videoById = new Map(base.videoPortfolio.videos.map((video) => [String(video.id), video]));

const allComments = rawRows.map((row) => {
  const coded = codedById.get(String(row['评论ID'])) ?? { text: '', codes: new Set(), axes: new Set(), depth: '' };
  const userKey = String(row['评论用户URL'] || (row['评论用户'] ? `name:${row['评论用户']}` : '')).trim();
  const date = parseChinaDate(row['评论时间']);
  return {
    id: String(row['评论ID']),
    videoId: String(row['所属视频ID']),
    threadId: String(row['线程根评论ID'] || row['评论ID']),
    relation: String(row['关系类型']),
    level: number(row['回复层级']),
    author: bool(row['是否视频作者']),
    authorReplied: bool(row['视频作者是否回复']),
    userKey,
    userId: userKey ? pseudonym(userKey) : '',
    text: coded.text,
    likes: number(row['评论点赞数']),
    date,
    codes: coded.codes,
    axes: coded.axes,
    depth: coded.depth,
    strict: hasAny(coded, strictCodes),
  };
});

const audienceAll = allComments.filter((item) => !item.author && item.userKey && item.date);
const audienceText = audienceAll.filter((item) => item.text);
const maxDate = Math.max(...audienceAll.map((item) => item.date.getTime()));

const allByUser = new Map();
for (const item of audienceAll) {
  if (!allByUser.has(item.userKey)) allByUser.set(item.userKey, []);
  allByUser.get(item.userKey).push(item);
}

const fullUsers = [...allByUser.entries()].map(([userKey, itemsUnsorted]) => {
  const items = [...itemsUnsorted].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  const firstAt = items[0].date.getTime();
  const lastAt = items.at(-1).date.getTime();
  const videoCount = unique(items.map((item) => item.videoId));
  const dayCount = unique(items.map((item) => chinaDay(item.date)));
  return {
    userKey,
    userId: pseudonym(userKey),
    items,
    firstAt,
    lastAt,
    videoCount,
    dayCount,
    activeSpanDays: (lastAt - firstAt) / DAY,
  };
});

const users = [];
for (const [userKey, allEventsUnsorted] of allByUser) {
  const allEvents = [...allEventsUnsorted].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  const events = allEvents.filter((item) => item.text);
  if (!events.length) continue;
  const codes = new Set(events.flatMap((item) => [...item.codes]));
  const videos = new Set(allEvents.map((item) => item.videoId));
  const states = events.map((item) => classifyState(item, strictCodes));
  const entryAt = events[0].date.getTime();
  const entryStates = events.filter((item) => item.date.getTime() === entryAt).map((item) => classifyState(item, strictCodes));
  const firstState = ENTRY_ORDER.find((state) => entryStates.includes(state)) ?? states[0];
  const statesByTimestamp = [];
  for (const item of events) {
    const timestamp = item.date.getTime();
    let group = statesByTimestamp.at(-1);
    if (!group || group.timestamp !== timestamp) {
      group = { timestamp, states: [] };
      statesByTimestamp.push(group);
    }
    group.states.push(classifyState(item, strictCodes));
  }
  const orderedStates = statesByTimestamp.map((group) => ENTRY_ORDER.find((state) => group.states.includes(state)) ?? group.states[0]);
  const collapsedStates = orderedStates.filter((state, index) => index === 0 || state !== orderedStates[index - 1]);
  const maxDepth = events.reduce((highest, item) => DEPTH_ORDER[item.depth] > DEPTH_ORDER[highest] ? item.depth : highest, 'reaction');
  const firstAt = allEvents[0].date.getTime();
  const lastAt = allEvents.at(-1).date.getTime();
  const user = {
    userKey,
    userId: pseudonym(userKey),
    allEvents,
    events,
    codes,
    states: orderedStates,
    collapsedStates,
    firstState,
    entryAt,
    firstAt,
    lastAt,
    videoCount: videos.size,
    activeSpanDays: (lastAt - firstAt) / DAY,
    strict: events.some((item) => item.strict),
    maxDepth,
    tier: tierOf(allEvents.length),
  };
  user.tribes = Object.fromEntries(TRIBE_DEFINITIONS.map(([id, , predicate]) => [id, predicate(user)]));
  users.push(user);
}

const userByKey = new Map(users.map((user) => [user.userKey, user]));

const observedLifecycleSegments = [
  ['单次互动', (user) => user.items.length === 1],
  ['同视频重复', (user) => user.items.length >= 2 && user.videoCount === 1],
  ['跨视频同日', (user) => user.videoCount >= 2 && user.dayCount === 1],
  ['跨视频2-7天', (user) => user.videoCount >= 2 && user.dayCount >= 2 && user.activeSpanDays <= 7],
  ['跨视频8-30天', (user) => user.videoCount >= 2 && user.activeSpanDays > 7 && user.activeSpanDays <= 30],
  ['跨视频30天以上', (user) => user.videoCount >= 2 && user.activeSpanDays > 30],
].map(([segment, predicate]) => {
  const matched = fullUsers.filter(predicate);
  return {
    segment,
    users: matched.length,
    userShare: rate(matched.length, fullUsers.length),
    comments: sum(matched, (user) => user.items.length),
    commentShare: rate(sum(matched, (user) => user.items.length), audienceAll.length),
  };
});

function effectiveContentCodes(item, purifyTosign = false, strictTosign = false) {
  const codes = [...item.codes].filter((code) => CONTENT_CODES.includes(code));
  if (!purifyTosign || !item.codes.has('tosign_ritual')) return codes;
  return codes.filter((code) => !TOSIGN_ROLE_SLOT_CODES.has(code) && !(strictTosign && code === 'cute_infantilization'));
}

function buildContentRitualEntry(purifyTosign = false, strictTosign = false) {
  const groups = new Map();
  for (const user of fullUsers) {
    const firstItems = user.items.filter((item) => item.date.getTime() === user.firstAt);
    const firstContent = firstItems.some((item) => effectiveContentCodes(item, purifyTosign, strictTosign).length > 0);
    const firstRitual = firstItems.some((item) => hasAny(item, RITUAL_CODES));
    const group = firstContent && firstRitual ? '内容+仪式' : firstContent ? '仅内容' : firstRitual ? '仅仪式' : '二者皆无';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(user);
  }
  return ['内容+仪式', '仅内容', '仅仪式', '二者皆无'].map((group) => {
    const matched = groups.get(group) ?? [];
    const eligible30 = matched.filter((user) => maxDate - user.firstAt >= 30 * DAY);
    return {
      group,
      users: matched.length,
      userShare: rate(matched.length, fullUsers.length),
      crossVideoUsers: matched.filter((user) => user.videoCount >= 2).length,
      crossVideoRate: rate(matched.filter((user) => user.videoCount >= 2).length, matched.length),
      spanOver7Users: matched.filter((user) => user.activeSpanDays > 7).length,
      spanOver7Rate: rate(matched.filter((user) => user.activeSpanDays > 7).length, matched.length),
      crossVideoEligible30Users: eligible30.filter((user) => user.videoCount >= 2).length,
      crossVideoEligible30Denominator: eligible30.length,
      crossVideoEligible30Rate: rate(eligible30.filter((user) => user.videoCount >= 2).length, eligible30.length),
    };
  });
}

const contentRitualEntry = buildContentRitualEntry(true, false);
const contentRitualEntryRaw = buildContentRitualEntry(false, false);
const contentRitualEntryStrict = buildContentRitualEntry(true, true);

const lifecycle = {
  audienceUsers: fullUsers.length,
  textUsers: users.length,
  repeatTextUsers: users.filter((user) => user.events.length >= 2).length,
  crossVideoUsers: users.filter((user) => user.videoCount >= 2).length,
  lagToSecondHours: summary(users.filter((user) => user.events.length >= 2).map((user) => (user.events[1].date - user.events[0].date) / HOUR)),
  lagToFourthDays: summary(users.filter((user) => user.events.length >= 4).map((user) => (user.events[3].date - user.events[0].date) / DAY)),
  lagToTenthDays: summary(users.filter((user) => user.events.length >= 10).map((user) => (user.events[9].date - user.events[0].date) / DAY)),
  secondInteractionWindows: {},
  entryCohorts: [],
  observedLifecycleSegments,
  concentration: {
    fourPlusUsers: fullUsers.filter((user) => user.items.length >= 4).length,
    fourPlusUserShare: rate(fullUsers.filter((user) => user.items.length >= 4).length, fullUsers.length),
    fourPlusComments: sum(fullUsers.filter((user) => user.items.length >= 4), (user) => user.items.length),
    fourPlusCommentShare: rate(sum(fullUsers.filter((user) => user.items.length >= 4), (user) => user.items.length), audienceAll.length),
    tenPlusUsers: fullUsers.filter((user) => user.items.length >= 10).length,
    tenPlusUserShare: rate(fullUsers.filter((user) => user.items.length >= 10).length, fullUsers.length),
    tenPlusComments: sum(fullUsers.filter((user) => user.items.length >= 10), (user) => user.items.length),
    tenPlusCommentShare: rate(sum(fullUsers.filter((user) => user.items.length >= 10), (user) => user.items.length), audienceAll.length),
    elevenVideoUsers: fullUsers.filter((user) => user.videoCount >= 11).length,
    elevenVideoUserShare: rate(fullUsers.filter((user) => user.videoCount >= 11).length, fullUsers.length),
    elevenVideoComments: sum(fullUsers.filter((user) => user.videoCount >= 11), (user) => user.items.length),
    elevenVideoCommentShare: rate(sum(fullUsers.filter((user) => user.videoCount >= 11), (user) => user.items.length), audienceAll.length),
  },
  contentRitualEntry,
  contentRitualEntryRaw,
  contentRitualEntryStrict,
};
const repeatUsers = users.filter((user) => user.events.length >= 2);
for (const [label, threshold] of [['1小时内', HOUR], ['24小时内', DAY], ['7天内', 7 * DAY], ['30天内', 30 * DAY]]) {
  lifecycle.secondInteractionWindows[label] = {
    users: repeatUsers.filter((user) => user.events[1].date - user.events[0].date <= threshold).length,
    shareOfRepeaters: rate(repeatUsers.filter((user) => user.events[1].date - user.events[0].date <= threshold).length, repeatUsers.length),
  };
}
for (const state of ENTRY_ORDER) {
  const cohort = users.filter((user) => user.firstState === state);
  lifecycle.entryCohorts.push({ state, label: STATE_LABELS[state], ...userOutcomeSummary(cohort, maxDate) });
}

const firstNextMap = new Map();
const allTransitionMap = new Map();
let usersWithStateChange = 0;
for (const user of users) {
  if (user.collapsedStates.length >= 2) {
    usersWithStateChange += 1;
    inc(firstNextMap, `${user.collapsedStates[0]}→${user.collapsedStates[1]}`);
  }
  for (let index = 1; index < user.collapsedStates.length; index += 1) {
    inc(allTransitionMap, `${user.collapsedStates[index - 1]}→${user.collapsedStates[index]}`);
  }
}
const migration = {
  stateLabels: STATE_LABELS,
  usersWithStateChange,
  stateChangeRate: rate(usersWithStateChange, users.length),
  firstStateDistribution: ENTRY_ORDER.map((state) => ({ state, label: STATE_LABELS[state], users: users.filter((user) => user.firstState === state).length, share: rate(users.filter((user) => user.firstState === state).length, users.length) })),
  firstNext: mapToSortedRows(firstNextMap, usersWithStateChange),
  allTransitions: mapToSortedRows(allTransitionMap, sum([...allTransitionMap.values()]), 30),
  upwardMovement: {
    entryReactionOrRecognition: users.filter((user) => ['reaction', 'recognition', 'affect'].includes(user.firstState)).length,
    laterIntertext: users.filter((user) => ['reaction', 'recognition', 'affect'].includes(user.firstState) && user.collapsedStates.slice(1).includes('intertext')).length,
    laterCoCreation: users.filter((user) => ['reaction', 'recognition', 'affect'].includes(user.firstState) && user.collapsedStates.slice(1).includes('co_creation')).length,
    laterCommerce: users.filter((user) => ['reaction', 'recognition', 'affect'].includes(user.firstState) && user.collapsedStates.slice(1).some((state) => ['merchandise', 'purchase'].includes(state))).length,
  },
};
migration.upwardMovement.laterIntertextRate = rate(migration.upwardMovement.laterIntertext, migration.upwardMovement.entryReactionOrRecognition);
migration.upwardMovement.laterCoCreationRate = rate(migration.upwardMovement.laterCoCreation, migration.upwardMovement.entryReactionOrRecognition);
migration.upwardMovement.laterCommerceRate = rate(migration.upwardMovement.laterCommerce, migration.upwardMovement.entryReactionOrRecognition);

const tribeRows = TRIBE_DEFINITIONS.map(([id, label]) => {
  const matched = users.filter((user) => user.tribes[id]);
  return { id, label, ...userOutcomeSummary(matched, maxDate) };
});
const membershipDistribution = new Map();
for (const user of users) inc(membershipDistribution, String(Object.values(user.tribes).filter(Boolean).length));
const overlapRows = [];
for (let left = 0; left < TRIBE_DEFINITIONS.length; left += 1) {
  for (let right = left + 1; right < TRIBE_DEFINITIONS.length; right += 1) {
    const [leftId, leftLabel] = TRIBE_DEFINITIONS[left];
    const [rightId, rightLabel] = TRIBE_DEFINITIONS[right];
    const leftUsers = users.filter((user) => user.tribes[leftId]);
    const rightUsers = users.filter((user) => user.tribes[rightId]);
    const intersection = users.filter((user) => user.tribes[leftId] && user.tribes[rightId]).length;
    const union = leftUsers.length + rightUsers.length - intersection;
    overlapRows.push({
      left: leftId, leftLabel, right: rightId, rightLabel, intersection,
      shareOfLeft: rate(intersection, leftUsers.length),
      shareOfRight: rate(intersection, rightUsers.length),
      jaccard: rate(intersection, union),
    });
  }
}
overlapRows.sort((a, b) => b.intersection - a.intersection || b.jaccard - a.jaccard);
const tribes = {
  segments: tribeRows,
  membershipDistribution: [...membershipDistribution.entries()].map(([memberships, count]) => ({ memberships: Number(memberships), users: count, share: rate(count, users.length) })).sort((a, b) => a.memberships - b.memberships),
  overlaps: overlapRows,
  bridges: overlapRows.filter((row) => [
    'cute|purchase', 'cute|merchandise', 'character|strict', 'relationship|cocreation',
    'mascot|purchase', 'strict|cocreation', 'character|relationship',
  ].includes([row.left, row.right].sort().join('|'))),
};

function audienceSegmentSummary(id, label, matched) {
  const eligible30 = matched.filter((user) => maxDate - user.firstAt >= 30 * DAY);
  const returned30 = eligible30.filter((user) => user.allEvents.some((event) => event.date.getTime() - user.firstAt >= 30 * DAY));
  const merchUsers = matched.filter((user) => user.codes.has('merchandise_intent')).length;
  const buyers = matched.filter((user) => user.codes.has('strict_purchase_intent')).length;
  return {
    id,
    label,
    users: matched.length,
    userShare: rate(matched.length, users.length),
    audienceComments: sum(matched, (user) => user.allEvents.length),
    textComments: sum(matched, (user) => user.events.length),
    commentsPerUser: round(mean(matched.map((user) => user.allEvents.length)), 2),
    crossVideoUsers: matched.filter((user) => user.videoCount >= 2).length,
    crossVideoRate: rate(matched.filter((user) => user.videoCount >= 2).length, matched.length),
    return30Users: returned30.length,
    return30Eligible: eligible30.length,
    return30Rate: rate(returned30.length, eligible30.length),
    merchandiseUsers: merchUsers,
    merchandiseRate: rate(merchUsers, matched.length),
    purchaseUsers: buyers,
    purchaseRate: rate(buyers, matched.length),
  };
}

for (const user of users) {
  user.organicCoCreation = hasAny({ codes: user.codes }, ORGANIC_CO_CREATION_CODES);
  user.cuteIdentity = hasAny({ codes: user.codes }, ['cute_infantilization', 'protective_care', 'mascot_identity_question']);
  user.roleAffect = hasAny({ codes: user.codes }, ROLE_AFFECT_CODES);
  user.generalContent = hasAny({ codes: user.codes }, GENERAL_CONTENT_CODES);
  user.contextLevel = user.organicCoCreation ? 'L4'
    : user.strict ? 'L3'
      : user.roleAffect ? 'L2'
        : user.generalContent ? 'L1'
          : 'L0';
}

const contextLabels = {
  L0: '未命中现有内容语义规则',
  L1: '一般内容反应与提问',
  L2: '角色认领、卡宝与萌化身份',
  L3: '表字、机制、史事与设定解码',
  L4: '关系再叙事、照护与有机共创',
};
const contextDepthSegments = ['L0', 'L1', 'L2', 'L3', 'L4'].map((level) => audienceSegmentSummary(level, contextLabels[level], users.filter((user) => user.contextLevel === level)));

const strictCuteCells = [
  ['neither', '二者皆无', (user) => !user.strict && !user.cuteIdentity],
  ['strict_only', '仅玩家解码', (user) => user.strict && !user.cuteIdentity],
  ['cute_only', '仅萌化身份', (user) => !user.strict && user.cuteIdentity],
  ['both', '玩家解码×萌化', (user) => user.strict && user.cuteIdentity],
].map(([id, label, predicate]) => audienceSegmentSummary(id, label, users.filter(predicate)));

const seedSegments = [
  ['strict_organic', '玩家解码×有机共创', (user) => user.strict && user.organicCoCreation],
  ['relationship_cute', '关系叙事×萌化', (user) => user.codes.has('relationship_shipping') && user.cuteIdentity],
  ['pure_tosign', '纯to签仪式', (user) => user.codes.has('tosign_ritual') && !effectiveContentCodesForUser(user)],
  ['content_tosign', '内容×to签仪式', (user) => user.codes.has('tosign_ritual') && effectiveContentCodesForUser(user)],
].map(([id, label, predicate]) => audienceSegmentSummary(id, label, users.filter(predicate)));

function effectiveContentCodesForUser(user) {
  return user.events.some((item) => effectiveContentCodes(item, true, false).length > 0);
}

function firstTimeFor(user, predicate) {
  const item = user.events.find(predicate);
  return item ? item.date.getTime() : null;
}

function orderingSummary(id, label, leftPredicate, rightPredicate) {
  const rows = users.map((user) => ({
    left: firstTimeFor(user, leftPredicate),
    right: firstTimeFor(user, rightPredicate),
  })).filter((row) => row.left !== null && row.right !== null);
  const simultaneous = rows.filter((row) => row.left === row.right).length;
  const leftFirst = rows.filter((row) => row.left < row.right);
  const rightFirst = rows.filter((row) => row.right < row.left);
  return {
    id,
    label,
    users: rows.length,
    simultaneousUsers: simultaneous,
    simultaneousShare: rate(simultaneous, rows.length),
    leftFirstUsers: leftFirst.length,
    leftFirstShare: rate(leftFirst.length, rows.length),
    rightFirstUsers: rightFirst.length,
    rightFirstShare: rate(rightFirst.length, rows.length),
    leftToRightMedianDays: round(median(leftFirst.map((row) => (row.right - row.left) / DAY)), 2),
    rightToLeftMedianDays: round(median(rightFirst.map((row) => (row.left - row.right) / DAY)), 2),
  };
}

const identityOrdering = [
  orderingSummary('role_strict', '角色认领→玩家解码', (item) => hasAny(item, ['character_recognition', 'courtesy_nickname']), (item) => item.strict),
  orderingSummary('role_organic', '角色认领→有机共创', (item) => hasAny(item, ['character_recognition', 'courtesy_nickname']), (item) => hasAny(item, ORGANIC_CO_CREATION_CODES)),
  orderingSummary('cute_organic', '萌化身份→有机共创', (item) => hasAny(item, ['cute_infantilization', 'protective_care', 'mascot_identity_question']), (item) => hasAny(item, ORGANIC_CO_CREATION_CODES)),
];

tribes.contextDepthSegments = contextDepthSegments;
tribes.strictCuteCells = strictCuteCells;
tribes.seedSegments = seedSegments;
tribes.identityOrdering = identityOrdering;

const acquisitionMedian = median(base.videoPortfolio.videos.map((video) => video.firstTouchUsers));
const retentionMedian = median(base.videoPortfolio.videos.map((video) => video.returningUsers));
const videoScorecards = base.videoPortfolio.videos.map((video) => {
  const archetype = primaryArchetype(video);
  const acquisitionHigh = video.firstTouchUsers >= acquisitionMedian;
  const retentionHigh = video.returningUsers >= retentionMedian;
  const quadrant = acquisitionHigh && retentionHigh ? '双引擎' : acquisitionHigh ? '拉新型' : retentionHigh ? '承接型' : '长尾型';
  const textComments = audienceText.filter((item) => item.videoId === String(video.id));
  const uniqueVideoUsers = new Set(textComments.map((item) => item.userKey));
  return {
    ...video,
    primaryArchetype: archetype,
    primaryArchetypeLabel: ARCHETYPE_LABELS[archetype],
    quadrant,
    textAudienceUsers: uniqueVideoUsers.size,
    playerContextUsers: new Set(textComments.filter((item) => item.strict).map((item) => item.userKey)).size,
    coCreationUsers: new Set(textComments.filter((item) => hasAny(item, CO_CREATION_CODES)).map((item) => item.userKey)).size,
    merchandiseUsers: new Set(textComments.filter((item) => item.codes.has('merchandise_intent')).map((item) => item.userKey)).size,
    contextUserRate: rate(new Set(textComments.filter((item) => item.strict).map((item) => item.userKey)).size, uniqueVideoUsers.size),
    coCreationUserRate: rate(new Set(textComments.filter((item) => hasAny(item, CO_CREATION_CODES)).map((item) => item.userKey)).size, uniqueVideoUsers.size),
    merchandiseUserRate: rate(new Set(textComments.filter((item) => item.codes.has('merchandise_intent')).map((item) => item.userKey)).size, uniqueVideoUsers.size),
  };
});
const videoQuadrants = ['双引擎', '拉新型', '承接型', '长尾型'].map((quadrant) => {
  const matched = videoScorecards.filter((video) => video.quadrant === quadrant);
  return {
    quadrant,
    videos: matched.length,
    audienceUsersMedian: median(matched.map((video) => video.audienceUsers)),
    firstTouchMedian: median(matched.map((video) => video.firstTouchUsers)),
    returningMedian: median(matched.map((video) => video.returningUsers)),
    strictContextRate: rate(sum(matched, (video) => video.strictContextComments), sum(matched, (video) => video.audienceTextComments)),
    purchaseUsers: sum(matched, (video) => video.strictPurchaseUsers),
  };
});

const archetypeEntryCohorts = [];
for (const archetype of Object.keys(ARCHETYPE_LABELS)) {
  const cohort = users.filter((user) => primaryArchetype(videoById.get(user.events[0].videoId)) === archetype);
  archetypeEntryCohorts.push({ archetype, label: ARCHETYPE_LABELS[archetype], ...userOutcomeSummary(cohort, maxDate) });
}

const contentTransitionMap = new Map();
let contentTransitionTotal = 0;
for (const user of users) {
  const orderedVideos = [];
  for (const item of user.events) {
    if (!orderedVideos.length || orderedVideos.at(-1) !== item.videoId) orderedVideos.push(item.videoId);
  }
  const states = orderedVideos.map((videoId) => primaryArchetype(videoById.get(videoId))).filter(Boolean);
  for (let index = 1; index < states.length; index += 1) {
    inc(contentTransitionMap, `${states[index - 1]}→${states[index]}`);
    contentTransitionTotal += 1;
  }
}

const threadsById = new Map();
for (const item of allComments) {
  if (!threadsById.has(item.threadId)) threadsById.set(item.threadId, []);
  threadsById.get(item.threadId).push(item);
}
const threadRows = [...threadsById.entries()].map(([threadId, items]) => {
  const root = items.find((item) => item.relation === '根评论') ?? items[0];
  const audienceUsers = new Set(items.filter((item) => !item.author && item.userKey).map((item) => item.userKey));
  const video = videoById.get(root.videoId);
  return {
    threadId,
    videoId: root.videoId,
    archetype: primaryArchetype(video),
    comments: items.length,
    replies: items.filter((item) => item.relation !== '根评论').length,
    audienceUsers: audienceUsers.size,
    authorInvolved: items.some((item) => item.author) || root.authorReplied,
    maxLevel: Math.max(...items.map((item) => item.level)),
    rootLikes: root.likes,
  };
});

function summarizeThreads(rows) {
  return {
    threads: rows.length,
    withReplyRate: rate(rows.filter((row) => row.replies > 0).length, rows.length),
    threePlusCommentRate: rate(rows.filter((row) => row.comments >= 3).length, rows.length),
    multiAudienceUserRate: rate(rows.filter((row) => row.audienceUsers >= 2).length, rows.length),
    deepReplyRate: rate(rows.filter((row) => row.maxLevel >= 2).length, rows.length),
    authorInvolvedRate: rate(rows.filter((row) => row.authorInvolved).length, rows.length),
    averageComments: round(mean(rows.map((row) => row.comments)), 2),
    maxComments: Math.max(0, ...rows.map((row) => row.comments)),
  };
}

const authorReplyCohort = users.map((user) => {
  const root = user.events[0];
  if (!root || root.relation !== '根评论') return null;
  const later = user.allEvents.filter((item) => item.date > root.date);
  return {
    replied: root.authorReplied,
    likes: root.likes,
    likeBand: root.likes === 0 ? '0赞' : root.likes < 10 ? '1-9赞' : '10赞+',
    eligible7: maxDate - root.date.getTime() >= 7 * DAY,
    futureComments: later.length,
    futureCrossVideo: later.some((item) => item.videoId !== root.videoId),
    future7d: later.some((item) => item.date - root.date >= 7 * DAY),
    futureStrict: later.some((item) => item.strict),
    futureOrganic: later.some((item) => hasAny(item, ORGANIC_CO_CREATION_CODES)),
    futureMerchandise: later.some((item) => item.codes.has('merchandise_intent')),
    futurePurchase: later.some((item) => item.codes.has('strict_purchase_intent')),
  };
}).filter(Boolean);

function replyAssociation(rows, label) {
  const replied = rows.filter((row) => row.replied);
  const unreplied = rows.filter((row) => !row.replied);
  const summarizeGroup = (group) => ({
    users: group.length,
    futureCrossVideoRate: rate(group.filter((row) => row.futureCrossVideo).length, group.length),
    future7dUsers: group.filter((row) => row.eligible7 && row.future7d).length,
    future7dEligible: group.filter((row) => row.eligible7).length,
    future7dRate: rate(group.filter((row) => row.eligible7 && row.future7d).length, group.filter((row) => row.eligible7).length),
    futureStrictRate: rate(group.filter((row) => row.futureStrict).length, group.length),
    futureOrganicRate: rate(group.filter((row) => row.futureOrganic).length, group.length),
    futureMerchandiseRate: rate(group.filter((row) => row.futureMerchandise).length, group.length),
    futurePurchaseRate: rate(group.filter((row) => row.futurePurchase).length, group.length),
    medianFutureComments: median(group.map((row) => row.futureComments)),
    averageInitialLikes: round(mean(group.map((row) => row.likes)), 2),
  });
  return { label, replied: summarizeGroup(replied), unreplied: summarizeGroup(unreplied) };
}

const firstInteractionStructure = [
  ['root', '根评入口', (item) => item.relation === '根评论'],
  ['level1', '一级回复入口', (item) => item.relation !== '根评论' && item.level === 1],
  ['level2plus', '二级及以上回复入口', (item) => item.relation !== '根评论' && item.level >= 2],
  ['missing', '层级缺失', (item) => item.relation !== '根评论' && item.level < 1],
].map(([id, label, predicate]) => {
  const matched = fullUsers.filter((user) => predicate(user.items[0]));
  const cross = matched.filter((user) => user.videoCount >= 2).length;
  return { id, label, users: matched.length, userShare: rate(matched.length, fullUsers.length), crossVideoUsers: cross, crossVideoRate: rate(cross, matched.length) };
});

const activityReplyRates = [
  ['one', '1次互动', (user) => user.items.length === 1],
  ['two_three', '2-3次互动', (user) => user.items.length >= 2 && user.items.length <= 3],
  ['four_nine', '4-9次互动', (user) => user.items.length >= 4 && user.items.length <= 9],
  ['ten_plus', '10次以上互动', (user) => user.items.length >= 10],
].map(([id, label, predicate]) => {
  const keys = new Set(fullUsers.filter(predicate).map((user) => user.userKey));
  const roots = audienceAll.filter((item) => keys.has(item.userKey) && item.relation === '根评论');
  const replied = roots.filter((item) => item.authorReplied).length;
  return { id, label, rootComments: roots.length, authorRepliedRoots: replied, authorReplyRate: rate(replied, roots.length) };
});

const community = {
  overallThreads: summarizeThreads(threadRows),
  threadsByArchetype: Object.keys(ARCHETYPE_LABELS).map((archetype) => ({ archetype, label: ARCHETYPE_LABELS[archetype], ...summarizeThreads(threadRows.filter((row) => row.archetype === archetype)) })),
  authorReplyAssociation: [replyAssociation(authorReplyCohort, '全部首个文本根评'), ...['0赞', '1-9赞', '10赞+'].map((band) => replyAssociation(authorReplyCohort.filter((row) => row.likeBand === band), band))],
  firstInteractionStructure,
  activityReplyRates,
  caveat: '作者可能优先回复已有热度、可回应或更早出现的评论；本表是观察相关，不是回复造成复访的因果估计。',
};

const purchaseComments = audienceText.filter((item) => item.codes.has('strict_purchase_intent'));
const purchaseSorted = [...purchaseComments].sort((a, b) => b.likes - a.likes || a.id.localeCompare(b.id));
const likesTotal = sum(purchaseComments, (item) => item.likes);
const robustness = {
  comments: purchaseComments.length,
  users: unique(purchaseComments.map((item) => item.userKey)),
  likes: likesTotal,
  medianLikes: median(purchaseComments.map((item) => item.likes)),
  p90Likes: quantile(purchaseComments.map((item) => item.likes), 0.9),
  zeroLikeShare: rate(purchaseComments.filter((item) => item.likes === 0).length, purchaseComments.length),
  top1Share: rate(purchaseSorted[0]?.likes ?? 0, likesTotal),
  top3Share: rate(sum(purchaseSorted.slice(0, 3), (item) => item.likes), likesTotal),
  top5Share: rate(sum(purchaseSorted.slice(0, 5), (item) => item.likes), likesTotal),
  afterRemovingTop3: {
    comments: purchaseSorted.slice(3).length,
    users: unique(purchaseSorted.slice(3).map((item) => item.userKey)),
    likes: sum(purchaseSorted.slice(3), (item) => item.likes),
  },
};

const purchaseUsers = users.filter((user) => user.tribes.purchase);
const pathRows = [];
const priorStateMap = new Map();
const priorCodeMap = new Map();
for (const user of purchaseUsers) {
  const firstPurchase = user.events.find((item) => item.codes.has('strict_purchase_intent'));
  const prior = user.events.filter((item) => item.date < firstPurchase.date && !item.codes.has('strict_purchase_intent'));
  const priorVideos = new Set(prior.map((item) => item.videoId));
  for (const state of new Set(prior.map((item) => classifyState(item, strictCodes)))) inc(priorStateMap, state);
  for (const code of new Set(prior.flatMap((item) => [...item.codes]))) inc(priorCodeMap, code);
  pathRows.push({
    userId: user.userId,
    firstTouch: prior.length === 0,
    priorComments: prior.length,
    priorVideos: priorVideos.size,
    daysToPurchase: prior.length ? (firstPurchase.date - prior[0].date) / DAY : 0,
    priorStates: [...new Set(prior.map((item) => classifyState(item, strictCodes)))],
  });
}
const nurturedPaths = pathRows.filter((row) => !row.firstTouch);

const purchaseByTier = ['一次性（1条）', '轻度复访（2-3条）', '活跃（4-9条）', '核心（10条+）'].map((tier) => {
  const tierUsers = users.filter((user) => user.tier === tier);
  const buyers = tierUsers.filter((user) => user.tribes.purchase);
  return { tier, users: tierUsers.length, purchaseUsers: buyers.length, purchaseRate: rate(buyers.length, tierUsers.length), shareOfPurchaseUsers: rate(buyers.length, purchaseUsers.length) };
});

const leadingSignalDefinitions = [
  ['merchandise', '首触周边兴趣', (item) => item.codes.has('merchandise_intent')],
  ['cute', '首触萌化身份', (item) => hasAny(item, ['cute_infantilization', 'protective_care', 'mascot_identity_question'])],
  ['role', '首触角色认领', (item) => hasAny(item, ['character_recognition', 'courtesy_nickname'])],
  ['ritual', '首触活动仪式', (item) => hasAny(item, RITUAL_CODES)],
  ['mascot', '首触卡宝人格', (item) => item.codes.has('mascot_persona_reference')],
  ['system', '首触系统黑话', (item) => item.codes.has('game_system_jargon')],
];
const repeatNonPurchaseEntrants = users.filter((user) => {
  const firstItems = user.events.filter((item) => item.date.getTime() === user.entryAt);
  return user.events.some((item) => item.date.getTime() > user.entryAt) && !firstItems.some((item) => item.codes.has('strict_purchase_intent'));
});
const leadingSignals = leadingSignalDefinitions.map(([id, label, predicate]) => {
  const cohort = repeatNonPurchaseEntrants.filter((user) => user.events.filter((item) => item.date.getTime() === user.entryAt).some(predicate));
  const laterBuyers = cohort.filter((user) => user.events.some((item) => item.date.getTime() > user.entryAt && item.codes.has('strict_purchase_intent')));
  return { id, label, users: cohort.length, laterPurchaseUsers: laterBuyers.length, laterPurchaseRate: rate(laterBuyers.length, cohort.length) };
});

const purchaseCategoryDefinitions = [
  ['doll', '玩偶/娃娃', (text) => /(玩偶|娃娃)/.test(text) && !/娃娃机/.test(text)],
  ['plush_hanger', '毛绒/挂件', (text) => /(毛绒|挂件)/.test(text)],
  ['generic_merch', '周边泛称', (text) => /周边/.test(text)],
  ['sticker', '表情包', (text) => /表情包/.test(text)],
  ['figure', '手办', (text) => /手办/.test(text)],
  ['figurine', '公仔', (text) => /公仔/.test(text)],
  ['blind_box', '盲盒', (text) => /盲盒/.test(text)],
].map(([id, label, predicate]) => {
  const matched = purchaseComments.filter((item) => predicate(item.text));
  return { id, label, comments: matched.length, users: unique(matched.map((item) => item.userKey)), userShare: rate(unique(matched.map((item) => item.userKey)), robustness.users) };
});

const purchaseContextDefinitions = [
  ['cute', '同条萌化', (item) => hasAny(item, ['cute_infantilization', 'protective_care', 'mascot_identity_question'])],
  ['mascot', '同条卡宝人格', (item) => item.codes.has('mascot_persona_reference')],
  ['role', '同条角色点名', (item) => hasAny(item, ['character_recognition', 'courtesy_nickname'])],
  ['strict', '同条玩家解码', (item) => item.strict],
  ['organic', '同条有机共创', (item) => hasAny(item, ORGANIC_CO_CREATION_CODES)],
  ['relationship', '同条关系配对', (item) => item.codes.has('relationship_shipping')],
  ['ritual', '同条奖励仪式', (item) => hasAny(item, RITUAL_CODES)],
].map(([id, label, predicate]) => {
  const matched = purchaseComments.filter(predicate);
  return { id, label, comments: matched.length, users: unique(matched.map((item) => item.userKey)), userShare: rate(unique(matched.map((item) => item.userKey)), robustness.users) };
});

const scenarioSeeds = base.commerce.scenarioSeeds;
const scenario = {
  assumptions: { intentUsers: 153, merchandiseUsers: 367, defaultPrice: 99, variableCost: 52, fixedCost: 5000 },
  rows: [],
};
for (const audience of [['严格购买用户', 153], ['周边兴趣用户', 367]]) {
  for (const conversion of [0.05, 0.1, 0.2, 0.3, 0.5]) {
    const units = Math.round(audience[1] * conversion);
    const revenue = units * 99;
    const contribution = units * (99 - 52) - 5000;
    scenario.rows.push({ seed: audience[0], seedUsers: audience[1], conversion, units, revenue, contribution });
  }
}
scenario.breakEvenUnits = Math.ceil(scenario.assumptions.fixedCost / (scenario.assumptions.defaultPrice - scenario.assumptions.variableCost));
scenario.breakEvenConversionStrict = rate(scenario.breakEvenUnits, 153);
scenario.breakEvenConversionMerchandise = rate(scenario.breakEvenUnits, 367);

const commerce = {
  robustness,
  path: {
    users: pathRows.length,
    firstTouchUsers: pathRows.filter((row) => row.firstTouch).length,
    nurturedUsers: nurturedPaths.length,
    nurturedShare: rate(nurturedPaths.length, pathRows.length),
    priorCommentStats: summary(nurturedPaths.map((row) => row.priorComments)),
    priorVideoStats: summary(nurturedPaths.map((row) => row.priorVideos)),
    daysToPurchaseStats: summary(nurturedPaths.map((row) => row.daysToPurchase)),
    priorStates: mapToSortedRows(priorStateMap, nurturedPaths.length),
    priorCodes: mapToSortedRows(priorCodeMap, nurturedPaths.length, 15),
  },
  purchaseByTier,
  repeatNonPurchaseEntrants: {
    users: repeatNonPurchaseEntrants.length,
    laterPurchaseUsers: repeatNonPurchaseEntrants.filter((user) => user.events.some((item) => item.date.getTime() > user.entryAt && item.codes.has('strict_purchase_intent'))).length,
  },
  leadingSignals,
  purchaseCategories: purchaseCategoryDefinitions,
  purchaseContexts: purchaseContextDefinitions,
  merchandisePurchaseOverlapUsers: users.filter((user) => user.codes.has('merchandise_intent') && user.codes.has('strict_purchase_intent')).length,
  priceSensitiveUsers: users.filter((user) => user.codes.has('price_sensitivity')).length,
  scenario,
  scenarioSeeds,
};

function scoreRole(role, weights, maxima) {
  const users = Math.log1p(role.spontaneousUsers) / Math.log1p(maxima.users);
  const comments = Math.log1p(role.spontaneousComments) / Math.log1p(maxima.comments);
  const likes = Math.log1p(role.spontaneousLikes) / Math.log1p(maxima.likes);
  return 100 * (weights.users * users + weights.comments * comments + weights.likes * likes);
}

const roleMaxima = {
  users: Math.max(...base.roleMarket.characters.map((role) => role.spontaneousUsers)),
  comments: Math.max(...base.roleMarket.characters.map((role) => role.spontaneousComments)),
  likes: Math.max(...base.roleMarket.characters.map((role) => role.spontaneousLikes)),
};
const weightSets = [
  ['用户优先', { users: 0.7, comments: 0.2, likes: 0.1 }],
  ['均衡', { users: 0.5, comments: 0.3, likes: 0.2 }],
  ['互动优先', { users: 0.4, comments: 0.3, likes: 0.3 }],
];
const roleRankMap = new Map(base.roleMarket.characters.map((role) => [role.id, { role, ranks: {}, scores: {} }]));
for (const [name, weights] of weightSets) {
  const ranked = base.roleMarket.characters
    .map((role) => ({ role, score: scoreRole(role, weights, roleMaxima) }))
    .sort((a, b) => b.score - a.score || a.role.label.localeCompare(b.role.label));
  ranked.forEach((item, index) => {
    roleRankMap.get(item.role.id).ranks[name] = index + 1;
    roleRankMap.get(item.role.id).scores[name] = round(item.score, 2);
  });
}

function proxyQuadrant(label, relationship = false) {
  const mention = relationship ? '非标题共同点名代理' : '非标题点名代理';
  return ({
    '高供给 × 高自发需求': `高标题供给 × 高${mention}`,
    '低供给 × 高自发需求': `低标题供给 × 高${mention}`,
    '高供给 × 低自发需求': `高标题供给 × 低${mention}`,
    '低供给 × 低自发需求': `低标题供给 × 低${mention}`,
  })[label] || label;
}

function normalizeRoleProxyFields(role) {
  const normalized = {
    ...role,
    titleSupplyVideos: role.supplyVideos,
    titleSupplyShare: role.supplyShare,
    titleContextCommenters: role.titleExposureUsers,
    nonTitleMentionComments: role.spontaneousComments,
    nonTitleMentionUsers: role.spontaneousUsers,
    nonTitleMentionLikes: role.spontaneousLikes,
    nonTitleMentionCommentsPer1kOutside: role.spontaneousCommentsPer1kOutside,
    nonTitleMentionUsersPer1kOutsideUsers: role.spontaneousUsersPer1kOutsideUsers,
    nonTitleMentionPurchaseUsers: role.spontaneousPurchaseUsers,
    nonTitleMentionCohortUsers: role.users,
    titleSupplyIndex: role.supplyIndex,
    nonTitleMentionIndex: role.demandIndex,
    relativeOpportunityIndex: role.gapIndex,
    quadrant: proxyQuadrant(role.quadrant),
  };
  for (const key of [
    'supplyVideos', 'supplyShare', 'titleExposureUsers',
    'spontaneousComments', 'spontaneousUsers', 'spontaneousLikes',
    'spontaneousCommentsPer1kOutside', 'spontaneousUsersPer1kOutsideUsers',
    'spontaneousPurchaseUsers', 'users', 'supplyIndex', 'demandIndex', 'gapIndex',
  ]) delete normalized[key];
  return normalized;
}

function normalizePairProxyFields(pair) {
  const normalized = {
    ...pair,
    titleSupplyVideos: pair.supplyVideos,
    nonTitleCoMentionComments: pair.spontaneousComments,
    nonTitleCoMentionUsers: pair.spontaneousUsers,
    nonTitleCoMentionLikes: pair.spontaneousLikes,
    nonTitleCoMentionShippingComments: pair.spontaneousShippingComments,
    nonTitleCoMentionActionComments: pair.spontaneousActionComments,
    nonTitleCoMentionCohortUsers: pair.users,
    titleSupplyIndex: pair.supplyIndex,
    nonTitleCoMentionIndex: pair.demandIndex,
    relativeOpportunityIndex: pair.gapIndex,
    quadrant: proxyQuadrant(pair.quadrant, true),
  };
  for (const key of [
    'supplyVideos', 'spontaneousComments', 'spontaneousUsers', 'spontaneousLikes',
    'spontaneousShippingComments', 'spontaneousActionComments', 'users',
    'supplyIndex', 'demandIndex', 'gapIndex',
  ]) delete normalized[key];
  return normalized;
}

const roleSensitivity = [...roleRankMap.values()].map(({ role, ranks, scores }) => ({
  ...normalizeRoleProxyFields(role),
  ranks,
  scores,
  bestRank: Math.min(...Object.values(ranks)),
  worstRank: Math.max(...Object.values(ranks)),
  rankRange: Math.max(...Object.values(ranks)) - Math.min(...Object.values(ranks)),
  top10Stable: Object.values(ranks).every((rank) => rank <= 10),
})).sort((a, b) => a.ranks['均衡'] - b.ranks['均衡']);

function groundedTheme(id, label, interpretation, predicate) {
  const matched = audienceText.filter(predicate);
  const topQuotes = [...matched]
    .filter((item) => item.text.length >= 4 && item.text.length <= 180)
    .sort((a, b) => b.likes - a.likes || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((item) => ({ text: item.text, likes: item.likes, videoId: item.videoId }));
  return {
    id,
    label,
    interpretation,
    comments: matched.length,
    users: unique(matched.map((item) => item.userKey)),
    videos: unique(matched.map((item) => item.videoId)),
    likes: sum(matched, (item) => item.likes),
    shareOfAudienceText: rate(matched.length, audienceText.length),
    quotes: topQuotes,
  };
}

const strictKnowledgeWithoutNickname = strictCodes.filter((code) => code !== 'courtesy_nickname');
const meaningSystem = [
  groundedTheme('identity', '表字与昵称：身份确认', '低成本确认“我认得这个角色”，是圈层通行证，但不等于机制理解。', (item) => item.codes.has('courtesy_nickname')),
  groundedTheme('mechanism', '机制剧情化：把技能变成日常动作', '评论把伤害、摸牌、技能压制和资源经济重新翻译为剧情笑点。', (item) => item.codes.has('mechanic_remap_validation')),
  groundedTheme('knowledge', '史事、设定与台词：共同校验', '观众调用史事、技能经济、设定、台词或因果解释来参与意义生产。', (item) => hasAny(item, strictKnowledgeWithoutNickname)),
  groundedTheme('relationship', '关系再叙事：从观看到续写', '角色关系被改写为护短、悲剧修复、配对和下一集请求。', (item) => hasAny(item, ['relationship_shipping', 'tragic_repair', 'protective_care', 'continuation_request'])),
  groundedTheme('affect_ownership', '萌化与实物化：从可爱到可拥有', '萌化降低玩家知识门槛，并为玩偶、毛绒和挂件提供具象商品想象。', (item) => hasAny(item, ['cute_infantilization', 'protective_care', 'mascot_identity_question', 'merchandise_intent'])),
  groundedTheme('boundary', '理解与内容边界：入口摩擦', '少量提问、拒绝与无障碍诉求暴露了非核心受众的理解成本。', (item) => hasAny(item, ['knowledge_threshold_question', 'content_boundary_rejection', 'accessibility_request', 'outsider_self_identification'])),
];

const deep = {
  generatedAt: new Date().toISOString(),
  reportType: '粉丝与受众深度MKT分析：生命周期、迁移、部落、内容、角色、社区与商业验证',
  source: {
    comments: RAW_COMMENTS_PATH,
    codedComments: CODED_COMMENTS_PATH,
    baseAnalysis: BASE_ANALYSIS_PATH,
    groundedAnalysis: GROUNDED_ANALYSIS_PATH,
  },
  coverage: {
    videos: base.coverage.videos,
    capturedComments: base.coverage.capturedComments,
    declaredComments: base.coverage.declaredComments,
    sourceCoverage: base.coverage.sourceCoverage,
    audienceCommentsWithDate: audienceAll.length,
    audienceTextComments: audienceText.length,
    audienceTextUsers: users.length,
    codedRows: codedRows.length,
  },
  methodology: {
    userKey: '评论用户URL优先，缺失时使用昵称，仅用于内存聚合；导出只保留SHA-256稳定匿名ID。',
    observationOrder: '用户状态与内容迁移按评论时间排序，代表当前可见语料中的观察路径，不等同平台完整曝光或自然因果旅程。',
    entryState: '首条非空受众评论按购买>周边>共创>活动仪式>玩家互文>角色识别>萌化情感>即时反应互斥归类。',
    retention: '7日/30日只在首条评论距观测截止至少7/30天的用户中计算。',
    contentAcquisition: '首次出现与回访用户按本数据的首次可见评论定义，受采集起点左删失影响。',
    roleRobustness: '角色点名代理以标题未出现该角色时的点名用户/评论/获赞进行对数归一，三套权重检查排序稳定性；标题未出现不代表画面、对白或剧情未出现，因此该指标不直接等于自然需求或供给缺口。',
    causality: '作者回复、内容原型、圈层与复访/购买均为观察关联；报告只提出实验假设，不宣称因果。',
  },
  lifecycle,
  migration,
  tribes,
  content: {
    acquisitionMedian,
    retentionMedian,
    quadrants: videoQuadrants,
    archetypeEntryCohorts,
    contentTransitions: mapToSortedRows(contentTransitionMap, contentTransitionTotal, 30),
    videos: videoScorecards,
  },
  community,
  commerce,
  roles: {
    weightSets: weightSets.map(([name, weights]) => ({ name, weights })),
    sensitivity: roleSensitivity,
    pairs: base.roleMarket.pairs.map(normalizePairProxyFields),
  },
  grounded: {
    meaningSystem,
    depthMetrics: grounded.depthMetrics,
    axialCategories: grounded.axialCategories,
    strictKnowledgeCodes: strictCodes,
  },
  evidenceBoundaries: [
    '107条视频只有17条可解析发布时间，不能用本数据推断全量发布节奏或时段因果。',
    '没有播放量、完播率、分享、收藏和关注转化，首次评论用户只是拉新代理，不是新增粉丝。',
    '16,796条采集评论对应17,021条声明评论，覆盖98.68%；结论代表当前可见语料。',
    '角色词典覆盖47组，不是全武将穷举；“非标题点名”仍可能由画面、对白或剧情曝光触发，只能作为相对点名代理，不能直接解释为自然需求或供给缺口。',
    'to签是活动仪式，已从自然角色需求与关系需求中拆开；同提双角色不自动等于CP。',
    '负面词在三国杀台词、反讽和角色自嘲中高歧义，未计算自动负面率。',
  ],
};

const journeyRows = users.map((user) => ({
  匿名受众ID: user.userId,
  首次入口: STATE_LABELS[user.firstState],
  首条时间: new Date(user.firstAt).toISOString(),
  评论数: user.allEvents.length,
  文本评论数: user.events.length,
  视频数: user.videoCount,
  活跃层: user.tier,
  活跃跨度天: round(user.activeSpanDays, 3),
  第二次互动时延小时: user.events.length >= 2 ? round((user.events[1].date - user.events[0].date) / HOUR, 3) : '',
  跨视频复访代理: user.videoCount >= 2,
  观察7日回访: user.events.some((item) => item.date.getTime() - user.firstAt >= 7 * DAY),
  观察30日回访: user.events.some((item) => item.date.getTime() - user.firstAt >= 30 * DAY),
  最高参与深度: user.maxDepth,
  互斥语境层级: user.contextLevel,
  状态迁移路径: user.collapsedStates.map((state) => STATE_LABELS[state]).join('>'),
  严格玩家语境: user.tribes.strict,
  关系共创: user.tribes.relationship,
  周边兴趣: user.tribes.merchandise,
  严格购买意向: user.tribes.purchase,
}));

const journeyHeaders = ['匿名受众ID', '首次入口', '首条时间', '评论数', '文本评论数', '视频数', '活跃层', '活跃跨度天', '第二次互动时延小时', '跨视频复访代理', '观察7日回访', '观察30日回访', '最高参与深度', '互斥语境层级', '状态迁移路径', '严格玩家语境', '关系共创', '周边兴趣', '严格购买意向'];
const videoHeaders = ['视频ID', '标题', 'URL', '主原型', '经营象限', '受众用户', '有文本受众用户', '首次出现用户', '回访用户', '回访占比', '严格玩家用户', '严格玩家用户占文本受众比', '共创用户', '共创用户占文本受众比', '周边兴趣用户', '周边兴趣用户占文本受众比', '严格购买用户', '作者根评回复率'];
const videoRows = videoScorecards.map((video) => ({
  视频ID: video.id,
  标题: video.title,
  URL: video.url,
  主原型: video.primaryArchetypeLabel,
  经营象限: video.quadrant,
  受众用户: video.audienceUsers,
  有文本受众用户: video.textAudienceUsers,
  首次出现用户: video.firstTouchUsers,
  回访用户: video.returningUsers,
  回访占比: round(video.returningShare, 4),
  严格玩家用户: video.playerContextUsers,
  严格玩家用户占文本受众比: round(video.contextUserRate, 4),
  共创用户: video.coCreationUsers,
  共创用户占文本受众比: round(video.coCreationUserRate, 4),
  周边兴趣用户: video.merchandiseUsers,
  周边兴趣用户占文本受众比: round(video.merchandiseUserRate, 4),
  严格购买用户: video.strictPurchaseUsers,
  作者根评回复率: round(video.authorReplyRate, 4),
}));

fs.writeFileSync(path.join(OUT_DIR, 'wuhu-mkt-deep-analysis.json'), JSON.stringify(deep, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'wuhu-mkt-deep-pseudonymous-journeys.csv'), stringifyCsv(journeyRows, journeyHeaders), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'wuhu-mkt-deep-video-scorecard.csv'), stringifyCsv(videoRows, videoHeaders), 'utf8');

console.log(JSON.stringify({
  output: OUT_DIR,
  users: users.length,
  videos: videoScorecards.length,
  lifecycle,
  purchase: commerce.robustness,
}, null, 2));
