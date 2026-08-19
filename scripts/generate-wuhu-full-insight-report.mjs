import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sourceDir = process.argv[2] || 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const outputDir = process.argv[3] || 'C:/Users/10847/Documents/MKT大师/output/wuhu-full-data-insight-20260813';

const commentsPath = path.join(sourceDir, 'all-comments.csv');
const videosPath = path.join(sourceDir, 'videos-summary.csv');
const manifestPath = path.join(sourceDir, 'manifest.json');
const metadataDir = path.join(sourceDir, 'metadata');
const referencePath = process.argv[4] || 'E:/xwechat_files/wxid_rjnr8utczy2811_22da/msg/file/2026-08/三国杀WUHU联盟卡宝专项论证报告.html';

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

  const [headers, ...body] = rows;
  return body
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header.replace(/^\uFEFF/, ''), values[index] ?? ''])));
}

function number(value) {
  const parsed = Number(String(value ?? '').replace(/^[\s']+/, '').replace(/[,+]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function quantile(values, p) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? ordered[lower] : ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatDecimal(value, digits = 1) {
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function percent(value, total, digits = 1) {
  return total ? `${formatDecimal((value / total) * 100, digits)}%` : '0.0%';
}

function dateFromPublished(raw) {
  const match = String(raw ?? '').match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
  if (!match) return null;
  return new Date(`${match[1]}T${match[2] || '00:00'}:00+08:00`);
}

function commentDate(raw) {
  const match = String(raw ?? '').match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  return match ? new Date(`${match[1]}T${match[2]}+08:00`) : null;
}

function dayKey(date) {
  return date ? date.toISOString().slice(0, 10) : '';
}

function monthKey(date) {
  return date ? date.toISOString().slice(0, 7) : '';
}

function mondayKey(date) {
  if (!date) return '';
  const adjusted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const weekday = adjusted.getUTCDay() || 7;
  adjusted.setUTCDate(adjusted.getUTCDate() - weekday + 1);
  return adjusted.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function truncate(value, maxLength = 100) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'zh-CN');
}

const CHARACTER_NAMES = [
  '曹操', '郭嘉', '司马昭', '曹髦', '孙策', '周瑜', '姜维', '钟会', '诸葛亮', '刘备', '赵云', '吕布',
  '邓艾', '贾诩', '张绣', '徐盛', '曹冲', '司马懿', '曹丕', '曹植', '刘禅', '黄盖', '马超', '孙权',
  '小乔', '大乔', '貂蝉', '荀彧', '魏延', '陆逊', '张飞', '关羽', '袁绍', '于吉', '戏志才', '孙綝',
  '庞统', '文鸯', '曹昂', '李儒', '程昱', '蒋干', '黄月英', '沮授', '钟毓', '曹睿', '曹真', '曹叡',
];

const CHARACTER_GROUPS = [
  { label: '郭嘉 / 奉孝', names: ['郭嘉', '奉孝'] },
  { label: '周瑜', names: ['周瑜'] },
  { label: '姜维 / 伯约', names: ['姜维', '伯约'] },
  { label: '曹操 / 阿瞒', names: ['曹操', '阿瞒'] },
  { label: '赵云 / 子龙', names: ['赵云', '子龙'] },
  { label: '钟会', names: ['钟会'] },
  { label: '贾诩 / 文和', names: ['贾诩', '文和'] },
  { label: '司马昭 / 小昭昭', names: ['司马昭', '小昭昭'] },
  { label: '孙策 / 孙笨', names: ['孙策', '孙笨'] },
  { label: '荀彧', names: ['荀彧'] },
  { label: '曹髦 / 小髦髦', names: ['曹髦', '小髦髦'] },
  { label: '曹丕', names: ['曹丕'] },
  { label: '曹植', names: ['曹植'] },
  { label: '诸葛亮 / 小诸葛', names: ['诸葛亮', '小诸葛', '亮亮'] },
  { label: '刘备 / 阿备备', names: ['刘备', '阿备备'] },
  { label: '张绣', names: ['张绣'] },
  { label: '邓艾', names: ['邓艾'] },
  { label: '吕布', names: ['吕布'] },
  { label: '黄盖', names: ['黄盖'] },
  { label: '貂蝉', names: ['貂蝉'] },
];

const TOPIC_RULES = [
  {
    id: 'merchandise',
    label: '实体周边/收藏诉求',
    description: '含手办、玩偶、周边、毛绒、公仔、盲盒等具体品类词',
    pattern: /手办|玩偶|周边|毛绒|公仔|抱枕|盲盒|立牌|挂件|吧唧|贴纸|钥匙扣|徽章|娃娃/g,
  },
  {
    id: 'purchase',
    label: '购买/获取表达',
    description: '含想买、求出、什么时候出、快出等明确获取表达',
    pattern: /想买|想要.*(?:手办|玩偶|周边|毛绒|公仔|盲盒)|什么时候出|啥时候出|何时出|快出|求出|出周边|出手办|出玩偶/g,
  },
  {
    id: 'affection',
    label: '喜爱与萌化表达',
    description: '含萌、可爱、喜欢、宝宝、小狗/狗狗等情感称呼',
    pattern: /好萌|太萌|萌死|萌爆|萌物|可爱|喜欢|爱死|宝宝|宝贝|小狗|狗狗|狗卡|小熊/g,
  },
  {
    id: 'game',
    label: '游戏与武将语境',
    description: '含三国杀、武将、技能、移动版、手杀、卡牌等游戏语义词',
    pattern: /三国杀|武将|技能|移动版|手杀|卡牌|排位|皮肤|界(?:\W|$)|谋(?:\W|$)/g,
  },
  {
    id: 'relationship',
    label: '角色关系与二创解读',
    description: '含CP、磕、夫妻、父子、老婆等关系/代入表达',
    pattern: /cp|CP|磕|夫妻|父子|父女|母子|老婆|老公|男朋友|女朋友|一对|官配|嗑/g,
  },
  {
    id: 'episode',
    label: '追更与系列期待',
    description: '含催更、更新、下一集、下集、续集等追更表达',
    pattern: /催更|更新|下一集|下集|续集|第\d+集|快更|快点更|什么时候更新/g,
  },
  {
    id: 'question',
    label: '理解门槛/解释需求',
    description: '含这是啥、什么意思、看不懂、什么梗、为什么等疑问表达',
    pattern: /这是啥|这是什么|什么意思|看不懂|什么梗|为啥|为什么|谁能解释|解释一下|谁啊/g,
  },
  {
    id: 'friction',
    label: '明确负向或反感词',
    description: '含丑、难看、无聊、尬、恶心、不喜欢、垃圾等明确负向词',
    pattern: /丑|难看|无聊|尬|恶心|不喜欢|垃圾|毁了|退游|烦死|low|LOW/g,
  },
];

const STOP_WORDS = new Set([
  '三国杀', '卡宝', '一个', '这个', '就是', '真的', '感觉', '怎么', '什么', '不是', '你们', '我们', '他们',
  '可以', '没有', '时候', '还是', '好像', '这么', '已经', '为啥', '为什么', '谢谢', '视频', '评论', '哈哈哈',
  '哈哈', '哈哈哈哈', 'hh', 'hhh', '啊啊啊', '啊啊', '啊', '了', '的', '吗', '呀', '吧', '呢', '也', '都', '很',
]);

function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const candidates = source.match(/[\u4e00-\u9fff]{2,8}|[a-z]{2,}/g) ?? [];
  const tokens = [];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value || STOP_WORDS.has(value)) continue;
    if (/^[\u4e00-\u9fff]+$/.test(value)) {
      const max = Math.min(4, value.length);
      for (let length = 2; length <= max; length += 1) {
        for (let start = 0; start <= value.length - length; start += 1) {
          const token = value.slice(start, start + length);
          if (!STOP_WORDS.has(token) && !/^(?:哈哈|呵呵|啊啊|嗯嗯)+$/.test(token)) tokens.push(token);
        }
      }
    } else {
      tokens.push(value);
    }
  }
  return tokens;
}

function hitCount(text, pattern) {
  const flags = pattern.flags.replace('g', '');
  const matcher = new RegExp(pattern.source, flags);
  const matches = String(text ?? '').match(matcher);
  return matches?.length ?? 0;
}

function findRuleHits(text) {
  return Object.fromEntries(TOPIC_RULES.map((rule) => [rule.id, hitCount(text, rule.pattern)]));
}

function dateRange(values) {
  const available = values.filter(Boolean).sort((left, right) => left - right);
  return { min: available[0] ?? null, max: available.at(-1) ?? null };
}

function readMetadata(directory) {
  const records = new Map();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      const metadata = value.metadata ?? {};
      if (metadata.video_id) records.set(String(metadata.video_id), metadata);
    } catch (error) {
      console.warn(`Skipped invalid metadata file ${file}: ${error.message}`);
    }
  }
  return records;
}

const comments = parseCsv(fs.readFileSync(commentsPath, 'utf8'));
const videoRows = parseCsv(fs.readFileSync(videosPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const metadataByVideo = readMetadata(metadataDir);

const commentByVideo = new Map();
for (const comment of comments) {
  const videoId = String(comment['所属视频ID']);
  if (!commentByVideo.has(videoId)) commentByVideo.set(videoId, []);
  commentByVideo.get(videoId).push(comment);
}

const videos = videoRows.map((row) => {
  const id = String(row['视频ID']);
  const metadata = metadataByVideo.get(id) ?? {};
  const publishedAt = dateFromPublished(row['视频发布时间'] || metadata.video_publish_time);
  const capturedComments = number(row['实际采集评论数']);
  const likes = number(metadata.video_likes ?? metadata.likes);
  const collects = number(metadata.video_collects ?? metadata.collects);
  const shares = number(metadata.video_shares ?? metadata.shares);
  const interactionObserved = [metadata.video_likes, metadata.likes, metadata.video_collects, metadata.collects, metadata.video_shares, metadata.shares]
    .some((value) => value !== undefined && value !== null && value !== '');
  const visibleInteractions = likes + capturedComments + collects + shares;
  return {
    id,
    title: row['视频标题'],
    url: row['视频URL'],
    publishedAt,
    publishedRaw: row['视频发布时间'] || metadata.video_publish_time || '',
    declaredComments: number(row['声明评论数']),
    capturedComments,
    rootComments: number(row['根评论数']),
    replies: number(row['回复数']),
    difference: number(row['声明数差值']),
    status: row['完整性状态'],
    capturedAt: row['采集时间'],
    likes,
    collects,
    shares,
    interactionObserved,
    visibleInteractions,
    comments: commentByVideo.get(id) ?? [],
  };
});

for (const video of videos) {
  video.commentLikes = sum(video.comments, (comment) => number(comment['评论点赞数']));
  video.nonEmptyTextComments = video.comments.filter((comment) => String(comment['评论内容']).trim()).length;
  video.seriesEpisode = Number((video.title.match(/第\s*(\d+)\s*集/) ?? [])[1] ?? 0);
}

const allUserKeys = comments.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`).filter(Boolean);
const rootComments = comments.filter((comment) => comment['关系类型'] === '根评论');
const replies = comments.filter((comment) => String(comment['关系类型']).startsWith('回复'));
const authorComments = comments.filter((comment) => comment['是否视频作者'] === 'true');
const markedAuthorReplyComments = comments.filter((comment) => comment['视频作者是否回复'] === 'true');
const audienceComments = comments.filter((comment) => comment['是否视频作者'] !== 'true');
const nonEmptyTextComments = comments.filter((comment) => String(comment['评论内容']).trim());
const exactVideos = videos.filter((video) => video.status === 'complete');
const gapVideos = videos.filter((video) => video.status === 'public_api_complete_with_gap');
const hasGap = videos.filter((video) => video.difference > 0);
const overCapturedVideos = videos.filter((video) => video.difference < 0);

const uniqueUsers = new Set(allUserKeys);
const uniqueRootUsers = new Set(rootComments.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`).filter(Boolean));
const uniqueAudienceUsers = new Set(audienceComments.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`).filter(Boolean));
const commentLikes = comments.map((comment) => number(comment['评论点赞数']));
const positiveLikedComments = commentLikes.filter((value) => value > 0);
const dates = comments.map((comment) => commentDate(comment['评论时间'])).filter(Boolean);
const publishDates = videos.map((video) => video.publishedAt).filter(Boolean);

const videosByMonth = new Map();
for (const video of videos) {
  const key = monthKey(video.publishedAt);
  if (!key) continue;
  if (!videosByMonth.has(key)) videosByMonth.set(key, []);
  videosByMonth.get(key).push(video);
}
const commentsByWeek = new Map();
for (const comment of comments) {
  const key = mondayKey(commentDate(comment['评论时间']));
  if (!key) continue;
  if (!commentsByWeek.has(key)) commentsByWeek.set(key, []);
  commentsByWeek.get(key).push(comment);
}
const videosByWeek = new Map();
for (const video of videos) {
  const key = mondayKey(video.publishedAt);
  if (!key) continue;
  if (!videosByWeek.has(key)) videosByWeek.set(key, []);
  videosByWeek.get(key).push(video);
}
const allWeekKeys = [...new Set([...commentsByWeek.keys(), ...videosByWeek.keys()])].sort();
const weekly = allWeekKeys.map((week) => ({
  week,
  comments: commentsByWeek.get(week)?.length ?? 0,
  videos: videosByWeek.get(week)?.length ?? 0,
}));
const monthly = [...videosByMonth.entries()]
  .map(([month, items]) => ({
    month,
    videos: items.length,
    capturedComments: sum(items, (item) => item.capturedComments),
    likes: sum(items, (item) => item.likes),
    collects: sum(items, (item) => item.collects),
    shares: sum(items, (item) => item.shares),
    visibleInteractions: sum(items, (item) => item.visibleInteractions),
  }))
  .sort((left, right) => left.month.localeCompare(right.month));

const titleHashtags = new Map();
for (const video of videos) {
  const title = video.title || '';
  const tags = title.match(/#([^#\s]+)/g) ?? [];
  for (const rawTag of tags) {
    const tag = rawTag.slice(1).replace(/[，,。.!！?？]+$/g, '');
    if (!tag) continue;
    if (!titleHashtags.has(tag)) titleHashtags.set(tag, { label: tag, videos: 0, capturedComments: 0, interaction: 0 });
    const target = titleHashtags.get(tag);
    target.videos += 1;
    target.capturedComments += video.capturedComments;
    target.interaction += video.visibleInteractions;
  }
}
const topTitleTags = [...titleHashtags.values()]
  .filter((item) => !['三国杀', '三国杀卡宝', '卡宝'].includes(item.label))
  .sort((left, right) => right.capturedComments - left.capturedComments || right.videos - left.videos || compareText(left.label, right.label))
  .slice(0, 12);

const characterMentions = CHARACTER_NAMES.map((name) => {
  const mentioned = comments.filter((comment) => String(comment['评论内容']).includes(name));
  const videoOccurrences = videos.filter((video) => String(video.title).includes(name));
  return {
    label: name,
    commentCount: mentioned.length,
    commentUsers: new Set(mentioned.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    commentLikes: sum(mentioned, (comment) => number(comment['评论点赞数'])),
    videoCount: videoOccurrences.length,
  };
})
  .filter((item) => item.commentCount > 0 || item.videoCount > 0)
  .sort((left, right) => right.commentCount - left.commentCount || right.videoCount - left.videoCount || compareText(left.label, right.label));

const characterGroupMentions = CHARACTER_GROUPS.map((group) => {
  const matched = comments.filter((comment) => group.names.some((name) => String(comment['评论内容']).includes(name)));
  const titleMatched = videos.filter((video) => group.names.some((name) => String(video.title).includes(name)));
  return {
    label: group.label,
    commentCount: matched.length,
    commentUsers: new Set(matched.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    commentLikes: sum(matched, (comment) => number(comment['评论点赞数'])),
    videoCount: titleMatched.length,
  };
})
  .filter((item) => item.commentCount > 0 || item.videoCount > 0)
  .sort((left, right) => right.commentCount - left.commentCount || right.commentLikes - left.commentLikes || compareText(left.label, right.label));

const rules = TOPIC_RULES.map((rule) => {
  const matched = comments.filter((comment) => hitCount(comment['评论内容'], rule.pattern) > 0);
  return {
    id: rule.id,
    label: rule.label,
    description: rule.description,
    comments: matched.length,
    users: new Set(matched.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    likes: sum(matched, (comment) => number(comment['评论点赞数'])),
    shareOfComments: comments.length ? matched.length / comments.length : 0,
  };
});
const ruleById = Object.fromEntries(rules.map((rule) => [rule.id, rule]));

const tokenCounts = new Map();
for (const comment of comments) {
  const uniqueTokens = new Set(tokenize(comment['评论内容']));
  for (const token of uniqueTokens) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
}
const keyPhrases = [...tokenCounts.entries()]
  .map(([label, count]) => ({ label, count }))
  .filter((item) => item.count >= 20)
  .filter((item) => !CHARACTER_NAMES.includes(item.label))
  .sort((left, right) => right.count - left.count || compareText(left.label, right.label))
  .slice(0, 35);

const locations = new Map();
for (const comment of comments) {
  const location = String(comment['评论地点'] ?? '').trim();
  if (!location || location === '未知') continue;
  locations.set(location, (locations.get(location) ?? 0) + 1);
}
const locationCoverage = sum([...locations.values()], (value) => value);
const topLocations = [...locations.entries()]
  .map(([label, count]) => ({ label, count }))
  .sort((left, right) => right.count - left.count || compareText(left.label, right.label))
  .slice(0, 12);

const userFrequency = new Map();
for (const comment of comments) {
  const key = comment['评论用户URL'] || `name:${comment['评论用户']}`;
  if (!key) continue;
  userFrequency.set(key, (userFrequency.get(key) ?? 0) + 1);
}
const frequencyBuckets = {
  one: [...userFrequency.values()].filter((count) => count === 1).length,
  twoToThree: [...userFrequency.values()].filter((count) => count >= 2 && count <= 3).length,
  fourPlus: [...userFrequency.values()].filter((count) => count >= 4).length,
};

const replyAssociation = {
  markedRootComments: rootComments.filter((comment) => comment['视频作者是否回复'] === 'true'),
  unmarkedRootComments: rootComments.filter((comment) => comment['视频作者是否回复'] !== 'true'),
};
replyAssociation.markedAverageLikes = mean(replyAssociation.markedRootComments.map((comment) => number(comment['评论点赞数'])));
replyAssociation.unmarkedAverageLikes = mean(replyAssociation.unmarkedRootComments.map((comment) => number(comment['评论点赞数'])));

const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, comments: 0 }));
for (const comment of comments) {
  const match = String(comment['评论时间']).match(/\s(\d{2}):/);
  if (match) hourCounts[Number(match[1])].comments += 1;
}
const eveningComments = sum(hourCounts.slice(18, 24), (item) => item.comments);
const peakHour = [...hourCounts].sort((left, right) => right.comments - left.comments || left.hour - right.hour)[0];

const productTerms = [
  ['玩偶', /玩偶/g],
  ['周边', /周边/g],
  ['表情包', /表情包/g],
  ['毛绒', /毛绒/g],
  ['实体', /实体/g],
  ['公仔', /公仔/g],
  ['手办', /手办/g],
  ['盲盒', /盲盒/g],
].map(([label, pattern]) => {
  const matched = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], pattern) > 0);
  return {
    label,
    comments: matched.length,
    users: new Set(matched.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    likes: sum(matched, (comment) => number(comment['评论点赞数'])),
  };
});

const merchandisePattern = /周边|玩偶|表情包|毛绒|实体|公仔|手办|盲盒/g;
const strictPurchasePattern = /想买|必买|肯定买|我要买|在哪里买|(?:什么时候|啥时候|何时|快点|赶紧|求|能不能).{0,8}(?:出|做).{0,8}(?:周边|玩偶|表情包|毛绒|公仔|手办|盲盒)/g;
const strictPurchaseComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], strictPurchasePattern) > 0);
const fanParticipationPattern = /卡宝|将军|大将军|礼貌投稿|to签|本宝|狗卡|小宝/gi;
const fanParticipationComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], fanParticipationPattern) > 0);
const cuteComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /萌|可爱/g) > 0);
const positiveComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /萌|可爱|喜欢|爱死|搞笑/g) > 0);
const updateComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /催更|更新|下一集|下集|续集|快更|快点更|什么时候更新/g) > 0);
const subtitleComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /字幕/g) > 0);
const toSignComments = nonEmptyTextComments.filter((comment) => /to签/i.test(String(comment['评论内容'])));
const submissionComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /礼貌投稿/g) > 0);
const priceComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /价格|太贵|便宜/g) > 0);
const explicitNegativeComments = nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], /丑|难看|无聊|尬|恶心|不喜欢|垃圾|毁了|退游|烦死|low|LOW/g) > 0);
const questionComments = nonEmptyTextComments.filter((comment) => /[？?]|这是啥|这是什么|什么意思|看不懂|什么梗|为啥|为什么|谁能解释|解释一下|谁啊/.test(comment['评论内容']));

function semanticMetric(id, label, description, matched) {
  return {
    id,
    label,
    description,
    comments: matched.length,
    users: new Set(matched.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    likes: sum(matched, (comment) => number(comment['评论点赞数'])),
    averageLikes: mean(matched.map((comment) => number(comment['评论点赞数']))),
    shareOfNonEmptyText: matched.length / nonEmptyTextComments.length,
  };
}

const semanticSignals = [
  semanticMetric('cute', '萌/可爱表达', '文本中明确出现“萌”或“可爱”', cuteComments),
  semanticMetric('positive', '显性正向表达', '文本中明确出现萌、可爱、喜欢、爱死或搞笑', positiveComments),
  semanticMetric('fanParticipation', '角色化互动信号', '文本中明确出现卡宝、将军、礼貌投稿、to签等互动词', fanParticipationComments),
  semanticMetric('merchandise', '周边品类讨论', '文本中明确出现周边、玩偶、表情包、毛绒、实体、公仔、手办或盲盒', nonEmptyTextComments.filter((comment) => hitCount(comment['评论内容'], merchandisePattern) > 0)),
  semanticMetric('strictPurchase', '近购买意向下限', '“想买/必买/在哪里买”或要求推出具体周边品类', strictPurchaseComments),
  semanticMetric('question', '问题/求信息', '含问号或明确解释、理解类提问', questionComments),
  semanticMetric('update', '追更/更新诉求', '明确出现催更、更新、下一集、续集等', updateComments),
  semanticMetric('negative', '强负向词', '仅命中明确反感词，未做语境人工复核', explicitNegativeComments),
  semanticMetric('subtitle', '字幕诉求', '明确提到字幕', subtitleComments),
];
const semanticById = Object.fromEntries(semanticSignals.map((item) => [item.id, item]));

const topLikeCount = Math.ceil(commentLikes.length * 0.01);
const topFiveLikeCount = Math.ceil(commentLikes.length * 0.05);
const sortedCommentLikes = [...commentLikes].sort((left, right) => right - left);
const textLengthValues = nonEmptyTextComments.map((comment) => [...String(comment['评论内容']).trim()].length);
const nonTextComments = comments.filter((comment) => !String(comment['评论内容']).trim());
const imageOnlyComments = nonTextComments.filter((comment) => String(comment['评论图片URL']).trim() && String(comment['评论图片URL']).trim() !== '[]');
const nonTextWithoutImageComments = nonTextComments.length - imageOnlyComments.length;
const uniqueTextCount = new Set(nonEmptyTextComments.map((comment) => String(comment['评论内容']).replace(/\s+/g, ' ').trim())).size;
const duplicateTextRowCount = nonEmptyTextComments.length - uniqueTextCount;
const threadCounts = new Map();
for (const comment of comments) {
  const key = String(comment['线程根评论ID'] || comment['评论ID']);
  threadCounts.set(key, (threadCounts.get(key) ?? 0) + 1);
}
const threadSizes = [...threadCounts.values()];
const threadedConversationCount = threadSizes.filter((size) => size >= 2).length;

const commentTopic = (id) => comments.filter((comment) => hitCount(comment['评论内容'], TOPIC_RULES.find((rule) => rule.id === id).pattern) > 0);
function representativeComments(id, max = 4) {
  return commentTopic(id)
    .filter((comment) => String(comment['评论内容']).trim().length >= 4)
    .sort((left, right) => number(right['评论点赞数']) - number(left['评论点赞数']) || String(left['评论时间']).localeCompare(String(right['评论时间'])))
    .slice(0, max)
    .map((comment) => ({
      text: truncate(comment['评论内容'], 112),
      likes: number(comment['评论点赞数']),
      videoId: String(comment['所属视频ID']),
      videoTitle: truncate(comment['所属视频标题'], 68),
      url: comment['所属视频URL'],
      date: String(comment['评论时间']).slice(0, 10),
    }));
}

const videosByCommentsOrdered = [...videos]
  .sort((left, right) => right.capturedComments - left.capturedComments || right.likes - left.likes || compareText(left.id, right.id));
const topVideosByComments = videosByCommentsOrdered.slice(0, 10);
const topVideosByInteraction = [...videos]
  .filter((video) => video.likes || video.collects || video.shares)
  .sort((left, right) => right.visibleInteractions - left.visibleInteractions || right.likes - left.likes || compareText(left.id, right.id))
  .slice(0, 10);
const topVideosByCommentLikes = [...videos]
  .sort((left, right) => right.commentLikes - left.commentLikes || right.capturedComments - left.capturedComments)
  .slice(0, 10);

const seriesVideos = videos.filter((video) => video.seriesEpisode > 0);
const nonSeriesVideos = videos.filter((video) => video.seriesEpisode === 0);
const videoCommentCounts = videos.map((video) => video.capturedComments);
const videosAtLeast100 = videos.filter((video) => video.capturedComments >= 100);
const performanceBands = [
  { label: '0', predicate: (value) => value === 0 },
  { label: '1-49', predicate: (value) => value >= 1 && value <= 49 },
  { label: '50-99', predicate: (value) => value >= 50 && value <= 99 },
  { label: '100-199', predicate: (value) => value >= 100 && value <= 199 },
  { label: '200-299', predicate: (value) => value >= 200 && value <= 299 },
  { label: '300+', predicate: (value) => value >= 300 },
].map((band) => {
  const matched = videos.filter((video) => band.predicate(video.capturedComments));
  return { label: band.label, videos: matched.length, comments: sum(matched, (video) => video.capturedComments) };
});
function titlePatternMetric(id, label, predicate) {
  const matched = videos.filter(predicate);
  return {
    id,
    label,
    videos: matched.length,
    comments: sum(matched, (video) => video.capturedComments),
    averageComments: mean(matched.map((video) => video.capturedComments)),
    medianComments: median(matched.map((video) => video.capturedComments)),
  };
}
const titlePatternMetrics = [
  titlePatternMetric('dialogue', '含冒号的对白式标题', (video) => /[：:]/.test(video.title)),
  titlePatternMetric('question', '含问号的悬念式标题', (video) => /[？?]/.test(video.title)),
  titlePatternMetric('comedy', '带 #搞笑 标签', (video) => /#搞笑(?:\s|$)/.test(video.title)),
  titlePatternMetric('abstract', '带 #抽象 标签', (video) => /#抽象(?:\s|$)/.test(video.title)),
  titlePatternMetric('workplace', '职场/上班/工作题材词', (video) => /职场|上班|工作/.test(video.title)),
];
const titlePatternById = Object.fromEntries(titlePatternMetrics.map((item) => [item.id, item]));
const titleCharacterPairs = [];
for (const [label, firstPattern, secondPattern] of [
  ['姜维 / 伯约 x 钟会', /姜维|伯约/, /钟会/],
  ['周瑜 x 孙策 / 孙笨', /周瑜/, /孙策|孙笨/],
  ['郭嘉 / 奉孝 x 曹操 / 阿瞒', /郭嘉|奉孝/, /曹操|阿瞒/],
  ['曹操 / 阿瞒 x 荀彧', /曹操|阿瞒/, /荀彧/],
  ['贾诩 / 文和 x 张绣', /贾诩|文和/, /张绣/],
  ['司马昭 / 小昭昭 x 曹髦', /司马昭|小昭昭/, /曹髦/],
]) {
  const matched = comments.filter((comment) => firstPattern.test(String(comment['评论内容'])) && secondPattern.test(String(comment['评论内容'])));
  titleCharacterPairs.push({
    label,
    comments: matched.length,
    users: new Set(matched.map((comment) => comment['评论用户URL'] || `name:${comment['评论用户']}`)).size,
    likes: sum(matched, (comment) => number(comment['评论点赞数'])),
    videoCount: videos.filter((video) => firstPattern.test(String(video.title)) && secondPattern.test(String(video.title))).length,
  });
}
titleCharacterPairs.sort((left, right) => right.comments - left.comments || right.likes - left.likes || compareText(left.label, right.label));

function compactVideo(video) {
  return {
    id: video.id,
    title: video.title,
    url: video.url,
    publishedAt: video.publishedAt ? video.publishedAt.toISOString() : null,
    publishedRaw: video.publishedRaw,
    declaredComments: video.declaredComments,
    capturedComments: video.capturedComments,
    rootComments: video.rootComments,
    replies: video.replies,
    difference: video.difference,
    status: video.status,
    commentLikes: video.commentLikes,
    seriesEpisode: video.seriesEpisode,
  };
}

function stripHashtags(title) {
  return String(title ?? '').replace(/\s*#[^#\s]+/g, '').replace(/\s+/g, ' ').trim();
}

function formatDateChina(value) {
  if (!value) return '未记录';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replace(/\//g, '-');
}

function svgHorizontalBars(items, options = {}) {
  const width = options.width ?? 640;
  const rowHeight = options.rowHeight ?? 42;
  const labelWidth = options.labelWidth ?? 180;
  const valueWidth = 52;
  const height = Math.max(84, items.length * rowHeight + 18);
  const values = items.map((item) => Number(item.value) || 0);
  const maximum = Math.max(...values, 1);
  const palette = options.palette ?? ['#7898a3', '#96afb5', '#b6c5c3', '#c8d0c5'];
  const unit = options.unit ?? '';
  const labelSize = options.labelSize ?? 12;
  const rows = items.map((item, index) => {
    const y = index * rowHeight + 12;
    const value = Number(item.value) || 0;
    const barStart = labelWidth;
    const barWidth = Math.max(3, (width - labelWidth - valueWidth - 12) * value / maximum);
    return `<g><text x="0" y="${y + 15}" class="svg-label" font-size="${labelSize}">${escapeHtml(truncate(item.label, options.labelMax ?? 22))}</text><rect x="${barStart}" y="${y}" width="${width - barStart - valueWidth - 12}" height="20" rx="3" fill="#edf0ed"/><rect x="${barStart}" y="${y}" width="${barWidth.toFixed(1)}" height="20" rx="3" fill="${palette[index % palette.length]}"/><text x="${width - valueWidth}" y="${y + 15}" class="svg-value">${escapeHtml(formatInteger(value))}${unit}</text></g>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.ariaLabel ?? '横向条形图')}">${rows}</svg>`;
}

function svgHourBars(items) {
  const width = 800;
  const height = 246;
  const left = 32;
  const right = 16;
  const top = 20;
  const bottom = 46;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maximum = Math.max(...items.map((item) => item.comments), 1);
  const step = plotWidth / items.length;
  const barWidth = Math.max(5, step - 6);
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = top + plotHeight * (1 - ratio);
    return `<g><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="svg-grid"/><text x="0" y="${y + 4}" class="svg-axis">${formatInteger(maximum * ratio)}</text></g>`;
  }).join('');
  const bars = items.map((item, index) => {
    const barHeight = item.comments / maximum * plotHeight;
    const x = left + index * step + (step - barWidth) / 2;
    const y = top + plotHeight - barHeight;
    const highlighted = item.hour >= 18 && item.hour <= 23;
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${highlighted ? '#9db5a0' : '#7b9ea8'}"/><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 18}" class="svg-axis" text-anchor="middle">${String(item.hour).padStart(2, '0')}</text></g>`;
  }).join('');
  return `<svg class="chart-svg hour-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="评论发布时间小时分布"><text x="${left}" y="12" class="svg-small">评论条数</text>${grid}${bars}<text x="${width - right}" y="${height - 5}" class="svg-small" text-anchor="end">评论时间（小时）</text></svg>`;
}

function svgDistribution(items) {
  const width = 760;
  const height = 186;
  const left = 126;
  const right = 70;
  const top = 14;
  const row = 34;
  const total = Math.max(...items.map((item) => item.value), 1);
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="内容主题信号分布">${items.map((item, index) => {
    const y = top + index * row;
    const length = Math.max(2, (width - left - right) * item.value / total);
    return `<g><text x="0" y="${y + 14}" class="svg-label">${escapeHtml(item.label)}</text><rect x="${left}" y="${y}" width="${width - left - right}" height="18" rx="3" fill="#edf0ed"/><rect x="${left}" y="${y}" width="${length.toFixed(1)}" height="18" rx="3" fill="${item.color}"/><text x="${width - right + 10}" y="${y + 14}" class="svg-value">${escapeHtml(item.display)}</text></g>`;
  }).join('')}</svg>`;
}

function svgVideoBands(items) {
  const width = 760;
  const height = 232;
  const left = 118;
  const right = 96;
  const top = 18;
  const row = 32;
  const maximum = Math.max(...items.map((item) => item.videos), 1);
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="视频评论量分层"><text x="0" y="10" class="svg-small">视频数</text>${items.map((item, index) => {
    const y = top + index * row;
    const barWidth = Math.max(item.videos ? 3 : 0, (width - left - right) * item.videos / maximum);
    return `<g><text x="0" y="${y + 14}" class="svg-label">${escapeHtml(item.label)} 条评论</text><rect x="${left}" y="${y}" width="${width - left - right}" height="18" rx="3" fill="#edf0ed"/><rect x="${left}" y="${y}" width="${barWidth.toFixed(1)}" height="18" rx="3" fill="${index >= 3 ? '#9db5a0' : '#7b9ea8'}"/><text x="${width - right + 10}" y="${y + 14}" class="svg-value">${formatInteger(item.videos)} 条</text></g>`;
  }).join('')}</svg>`;
}

function statCard(value, label, note, tone = 'blue') {
  return `<div class="stat-card ${tone}"><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-note">${escapeHtml(note)}</div></div>`;
}

function tag(text, tone = '') {
  return `<span class="tag ${tone}">${escapeHtml(text)}</span>`;
}

function quoteCard(quote, emphasis = '') {
  if (!quote) return '';
  const link = quote.url ? `<a href="${escapeHtml(quote.url)}" target="_blank" rel="noreferrer">查看对应视频</a>` : '';
  return `<figure class="quote ${emphasis}"><blockquote>“${escapeHtml(quote.text)}”</blockquote><figcaption>${formatInteger(quote.likes)} 赞 <span>${escapeHtml(quote.date || '')}</span>${link}</figcaption></figure>`;
}

function videoTableRows(items) {
  return items.map((video, index) => `<tr><td>${index + 1}</td><td><a href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">${escapeHtml(stripHashtags(video.title))}</a><div class="table-tags">${tag(video.seriesEpisode ? `第${video.seriesEpisode}集` : '非集数标题', video.seriesEpisode ? 'blue' : 'neutral')} ${tag(video.status === 'complete' ? '数值一致' : '接口末页仍有差额', video.status === 'complete' ? 'green' : 'orange')}</div></td><td>${formatInteger(video.capturedComments)}</td><td>${formatInteger(video.commentLikes)}</td><td>${formatInteger(video.replies)}<span class="muted"> / ${percent(video.replies, video.capturedComments)}</span></td></tr>`).join('');
}

const topComments = [...comments]
  .filter((comment) => String(comment['评论内容']).trim().length >= 4)
  .sort((left, right) => number(right['评论点赞数']) - number(left['评论点赞数']) || String(left['评论时间']).localeCompare(String(right['评论时间'])))
  .slice(0, 20)
  .map((comment) => ({
    text: truncate(comment['评论内容'], 120),
    likes: number(comment['评论点赞数']),
    videoId: String(comment['所属视频ID']),
    videoTitle: truncate(comment['所属视频标题'], 78),
    url: comment['所属视频URL'],
    date: String(comment['评论时间']).slice(0, 10),
  }));

function anonymousQuoteFromPattern(pattern) {
  const comment = comments
    .filter((item) => pattern.test(String(item['评论内容'])))
    .sort((left, right) => number(right['评论点赞数']) - number(left['评论点赞数']))[0];
  if (!comment) return null;
  return {
    text: truncate(String(comment['评论内容']).replace(/\s+/g, ' ').trim(), 150),
    likes: number(comment['评论点赞数']),
    videoId: String(comment['所属视频ID']),
    videoTitle: truncate(comment['所属视频标题'], 78),
    url: comment['所属视频URL'],
    date: String(comment['评论时间']).slice(0, 10),
  };
}

const curatedQuotes = {
  affection: anonymousQuoteFromPattern(/全网三国杀唯一可爱之物/),
  purchaseToy: anonymousQuoteFromPattern(/武将玩偶.*必买/),
  purchaseMerch: anonymousQuoteFromPattern(/出周边.*肯定买/),
  price: anonymousQuoteFromPattern(/价格不要太贵/),
  sticker: anonymousQuoteFromPattern(/考虑出表情包/),
  relationship: anonymousQuoteFromPattern(/姜维没骗过人.*钟会/),
  captions: anonymousQuoteFromPattern(/字幕/),
  criticism: anonymousQuoteFromPattern(/我不想看你这个卡宝/),
};

const topicSamples = Object.fromEntries(['affection', 'merchandise', 'purchase', 'game', 'episode', 'question', 'friction', 'relationship'].map((id) => [id, representativeComments(id)]));

const summary = {
  reportGeneratedAt: new Date().toISOString(),
  source: {
    sourceDir,
    accountName: manifest.account_name,
    douyinId: manifest.douyin_id,
    profileUrl: manifest.profile_url,
    dataGeneratedAt: manifest.generated_at,
    reportArchiveStatus: manifest.validation.archive_status,
  },
  coverage: {
    catalogVideoCount: manifest.coverage.catalog_video_count,
    declaredPublicVideoCount: manifest.coverage.declared_public_video_count,
    comments: comments.length,
    rootComments: rootComments.length,
    replies: replies.length,
    uniqueCommentUsers: uniqueUsers.size,
    uniqueAudienceCommentUsers: uniqueAudienceUsers.size,
    uniqueRootCommentUsers: uniqueRootUsers.size,
    exactVideos: exactVideos.length,
    gapVideos: gapVideos.length,
    incompleteVideos: manifest.coverage.incomplete_video_count,
    totalDeclaredComments: sum(videos, (video) => video.declaredComments),
    totalCapturedComments: sum(videos, (video) => video.capturedComments),
    netDeclaredGap: sum(videos, (video) => video.difference),
    positiveDeclaredGap: sum(hasGap, (video) => video.difference),
    overCapturedCount: Math.abs(sum(overCapturedVideos, (video) => video.difference)),
    videosWithPositiveGap: hasGap.length,
    videosWithOverCapture: overCapturedVideos.length,
    commentDateRange: dateRange(dates),
    publishDateRange: dateRange(publishDates),
    videosWithPublishTime: publishDates.length,
    allCommentFilesCovered: manifest.validation.all_catalog_videos_have_comment_files,
    allMetadataFilesCovered: manifest.validation.all_catalog_videos_have_metadata_files,
    publicApiExhausted: manifest.validation.public_api_exhausted,
    duplicateCommentCount: manifest.comments.duplicate_comment_count,
    orphanReplyCount: manifest.comments.orphan_reply_count,
  },
  interactions: {
    videoLikes: sum(videos, (video) => video.likes),
    videoCollects: sum(videos, (video) => video.collects),
    videoShares: sum(videos, (video) => video.shares),
    visibleInteractions: sum(videos, (video) => video.visibleInteractions),
    videosWithInteractionMetrics: videos.filter((video) => video.interactionObserved).length,
    totalCommentLikes: sum(comments, (comment) => number(comment['评论点赞数'])),
    commentsWithLikes: positiveLikedComments.length,
    medianCommentLikes: median(commentLikes),
    p90CommentLikes: quantile(commentLikes, 0.9),
    medianCommentsPerVideo: median(videos.map((video) => video.capturedComments)),
    meanCommentsPerVideo: mean(videos.map((video) => video.capturedComments)),
    authorComments: authorComments.length,
    markedAuthorReplyComments: markedAuthorReplyComments.length,
    commentLikeP95: quantile(commentLikes, 0.95),
    commentLikeP99: quantile(commentLikes, 0.99),
    commentLikeTop1Share: sum([...commentLikes].sort((left, right) => right - left).slice(0, Math.ceil(commentLikes.length * 0.01)), (value) => value) / sum(commentLikes, (value) => value),
  },
  participation: {
    replyShare: replies.length / comments.length,
    rootShare: rootComments.length / comments.length,
    repeatUserRate: 1 - frequencyBuckets.one / uniqueUsers.size,
    userFrequency: frequencyBuckets,
    locationCoverage,
    locationCoverageShare: locationCoverage / comments.length,
    topLocations,
    audienceCommentShare: audienceComments.length / comments.length,
    authorCommentShare: authorComments.length / comments.length,
    replyAssociation: {
      markedRootComments: replyAssociation.markedRootComments.length,
      markedRate: replyAssociation.markedRootComments.length / rootComments.length,
      markedAverageLikes: replyAssociation.markedAverageLikes,
      unmarkedAverageLikes: replyAssociation.unmarkedAverageLikes,
      ratio: replyAssociation.unmarkedAverageLikes ? replyAssociation.markedAverageLikes / replyAssociation.unmarkedAverageLikes : 0,
    },
    hourCounts,
    eveningComments,
    eveningShare: eveningComments / comments.length,
    peakHour,
    threadCount: threadCounts.size,
    threadedConversationCount,
    threadedConversationShare: threadedConversationCount / threadCounts.size,
  },
  commentTextQuality: {
    nonEmptyTextComments: nonEmptyTextComments.length,
    nonTextComments: nonTextComments.length,
    imageOnlyComments: imageOnlyComments.length,
    nonTextWithoutImageComments,
    uniqueTextCount,
    duplicateTextRowCount,
    duplicateTextRowShare: duplicateTextRowCount / nonEmptyTextComments.length,
    medianLength: median(textLengthValues),
    p90Length: quantile(textLengthValues, 0.9),
    shortTextShare: textLengthValues.filter((value) => value <= 10).length / textLengthValues.length,
  },
  rules,
  semanticSignals,
  productTerms,
  toSign: semanticMetric('toSign', 'to签', '明确出现 to签，英文字母不区分大小写', toSignComments),
  submissions: semanticMetric('submissions', '礼貌投稿', '明确出现礼貌投稿', submissionComments),
  priceSignal: semanticMetric('priceSignal', '价格表达', '明确出现价格、太贵或便宜', priceComments),
  monthly,
  weekly,
  topTitleTags,
  characterMentions,
  characterGroupMentions,
  titleCharacterPairs,
  contentFormats: {
    seriesVideos: seriesVideos.length,
    nonSeriesVideos: nonSeriesVideos.length,
    seriesAverageComments: mean(seriesVideos.map((video) => video.capturedComments)),
    nonSeriesAverageComments: mean(nonSeriesVideos.map((video) => video.capturedComments)),
    seriesMedianComments: median(seriesVideos.map((video) => video.capturedComments)),
    nonSeriesMedianComments: median(nonSeriesVideos.map((video) => video.capturedComments)),
  },
  videoPerformance: {
    p25Comments: quantile(videoCommentCounts, 0.25),
    p75Comments: quantile(videoCommentCounts, 0.75),
    p90Comments: quantile(videoCommentCounts, 0.9),
    maximumComments: Math.max(...videoCommentCounts),
    videosAtLeast100: videosAtLeast100.length,
    commentsFromVideosAtLeast100: sum(videosAtLeast100, (video) => video.capturedComments),
    shareFromVideosAtLeast100: sum(videosAtLeast100, (video) => video.capturedComments) / comments.length,
    top1Share: sum(videosByCommentsOrdered.slice(0, 1), (video) => video.capturedComments) / comments.length,
    top10Share: sum(videosByCommentsOrdered.slice(0, 10), (video) => video.capturedComments) / comments.length,
    top30Share: sum(videosByCommentsOrdered.slice(0, 30), (video) => video.capturedComments) / comments.length,
    performanceBands,
  },
  titlePatternMetrics,
  keyPhrases,
  topVideosByComments: topVideosByComments.map(compactVideo),
  topVideosByCommentLikes: topVideosByCommentLikes.map(compactVideo),
  topVideosByInteraction: topVideosByInteraction.map(compactVideo),
  topComments,
  topicSamples,
  curatedQuotes,
};

function buildReportHtml(data) {
  const { coverage, interactions, participation, commentTextQuality, videoPerformance, contentFormats } = data;
  const signal = Object.fromEntries(data.semanticSignals.map((item) => [item.id, item]));
  const commentStart = formatDateChina(coverage.commentDateRange.min);
  const commentEnd = formatDateChina(coverage.commentDateRange.max);
  const topCharacters = data.characterGroupMentions.slice(0, 8);
  const topPairs = data.titleCharacterPairs.slice(0, 4);
  const topVideos = data.topVideosByComments.slice(0, 10);
  const dialogue = data.titlePatternMetrics.find((item) => item.id === 'dialogue');
  const question = data.titlePatternMetrics.find((item) => item.id === 'question');
  const currentSourceName = escapeHtml(path.basename(sourceDir));
  const productTermBars = data.productTerms.slice(0, 5).map((item) => ({ label: item.label, value: item.comments }));
  const characterBars = topCharacters.map((item) => ({ label: item.label, value: item.commentCount }));
  const pairBars = topPairs.map((item) => ({ label: item.label, value: item.comments }));
  const topVideoBars = topVideos.map((item) => ({ label: stripHashtags(item.title), value: item.capturedComments }));
  const participationBars = [
    { label: '角色化互动信号', value: signal.fanParticipation.comments, display: `${formatInteger(signal.fanParticipation.comments)} 条`, color: '#7b9ea8' },
    { label: '萌/可爱表达', value: signal.cute.comments, display: `${formatInteger(signal.cute.comments)} 条`, color: '#9db5a0' },
    { label: 'to签', value: data.toSign.comments, display: `${formatInteger(data.toSign.comments)} 条`, color: '#bdc9b1' },
    { label: '礼貌投稿', value: data.submissions.comments, display: `${formatInteger(data.submissions.comments)} 条`, color: '#c4956c' },
  ];
  const quotes = data.curatedQuotes;
  const generatedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(data.reportGeneratedAt)).replace(/\//g, '-');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>三国杀WUHU联盟卡宝全量数据洞察报告</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      --page: #faf9f6;
      --paper: #ffffff;
      --ink: #363d3e;
      --muted: #687172;
      --line: #e5e6e0;
      --cover: #5c6b6f;
      --blue: #7b9ea8;
      --blue-soft: #e9f0f1;
      --sage: #9db5a0;
      --sage-soft: #edf3eb;
      --orange: #c4956c;
      --orange-soft: #f7eee7;
      --sand: #f7f6f3;
      --shadow: 0 8px 22px rgba(49, 57, 56, .055);
    }
    * { box-sizing: border-box; }
    html { background: var(--page); }
    body {
      margin: 0;
      background: var(--page);
      color: var(--ink);
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.72;
      letter-spacing: 0;
    }
    a { color: #486b76; text-decoration: none; border-bottom: 1px solid rgba(72, 107, 118, .28); }
    a:hover { color: #274b55; border-bottom-color: currentColor; }
    .report { width: min(1100px, calc(100% - 48px)); margin: 32px auto 56px; }
    .cover {
      overflow: hidden;
      position: relative;
      min-height: 410px;
      padding: 52px 58px 46px;
      border-radius: 10px;
      background: var(--cover);
      color: #fff;
      box-shadow: var(--shadow);
    }
    .cover-mark { position: relative; z-index: 1; display: inline-block; padding: 4px 10px; border: 1px solid rgba(255,255,255,.48); color: rgba(255,255,255,.9); font-size: 12px; }
    .cover h1 { position: relative; z-index: 1; max-width: 760px; margin: 30px 0 12px; font-size: 40px; line-height: 1.28; font-weight: 700; }
    .cover .lead { position: relative; z-index: 1; max-width: 690px; margin: 0; color: rgba(255,255,255,.88); font-size: 18px; }
    .cover-meta { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 32px; }
    .cover-meta span { padding: 7px 11px; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.08); color: rgba(255,255,255,.94); font-size: 13px; }
    .cover-summary { position: relative; z-index: 1; max-width: 718px; margin: 30px 0 0; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.26); font-size: 15px; color: #fff; }
    .part { margin-top: 34px; }
    .part-header { display: flex; align-items: baseline; gap: 14px; margin: 0 0 15px; padding: 14px 18px; border-left: 3px solid var(--blue); background: var(--paper); box-shadow: var(--shadow); }
    .part-index { color: var(--blue); font-size: 12px; font-weight: 700; }
    .part-header h2 { margin: 0; font-size: 24px; line-height: 1.35; }
    .section { margin-top: 18px; padding: 28px 32px; border-radius: 8px; background: var(--paper); box-shadow: var(--shadow); }
    .section h3 { margin: 0 0 9px; font-size: 20px; line-height: 1.45; }
    .section h4 { margin: 0 0 6px; font-size: 16px; line-height: 1.45; }
    p { margin: 8px 0; }
    .eyebrow { margin: 0 0 7px; color: var(--blue); font-size: 12px; font-weight: 700; }
    .section-intro { margin: 0; color: var(--muted); }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
    .stat-card { min-height: 126px; padding: 17px 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--sand); }
    .stat-card.blue { border-top: 3px solid var(--blue); }
    .stat-card.green { border-top: 3px solid var(--sage); }
    .stat-card.orange { border-top: 3px solid var(--orange); }
    .stat-value { color: var(--ink); font-size: 29px; line-height: 1.14; font-weight: 700; }
    .stat-label { margin-top: 8px; font-size: 13px; font-weight: 700; }
    .stat-note { margin-top: 3px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .evidence { margin-top: 20px; padding: 17px 19px; border-left: 4px solid #c5c0b5; background: #fafafa; }
    .evidence.success { border-left-color: var(--sage); background: var(--sage-soft); }
    .evidence.warning { border-left-color: var(--orange); background: var(--orange-soft); }
    .evidence.neutral { border-left-color: var(--blue); background: var(--blue-soft); }
    .evidence p:last-child { margin-bottom: 0; }
    .evidence .evidence-title { margin: 0; color: var(--ink); font-size: 16px; font-weight: 700; }
    .evidence .evidence-kpi { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; margin-top: 22px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
    .chart-panel { min-width: 0; padding: 17px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    .chart-panel h4 { margin-bottom: 2px; }
    .chart-note { margin: 2px 0 12px; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .chart-svg { display: block; width: 100%; height: auto; overflow: visible; }
    .svg-label { fill: #4d5656; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 12px; }
    .svg-value { fill: #566061; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 12px; font-weight: 700; }
    .svg-axis, .svg-small { fill: #7a8383; font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 10px; }
    .svg-grid { stroke: #e1e6e3; stroke-width: 1; }
    .quote-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .quote { display: flex; flex-direction: column; min-height: 132px; margin: 0; padding: 17px; border-left: 3px solid #c5c0b5; background: #f8f8f7; }
    .quote.success { border-left-color: var(--sage); background: var(--sage-soft); }
    .quote.warning { border-left-color: var(--orange); background: var(--orange-soft); }
    .quote.neutral { border-left-color: var(--blue); background: var(--blue-soft); }
    .quote blockquote { margin: 0; color: #465051; font-size: 14px; line-height: 1.6; }
    .quote figcaption { margin-top: auto; padding-top: 11px; color: #65706f; font-size: 12px; }
    .quote figcaption span { margin-left: 8px; }
    .quote figcaption a { margin-left: 8px; font-size: 11px; }
    .tag { display: inline-flex; align-items: center; min-height: 23px; margin: 5px 5px 0 0; padding: 2px 7px; border-radius: 3px; background: #ececeb; color: #606968; font-size: 11px; line-height: 1.4; }
    .tag.blue { background: var(--blue-soft); color: #55737d; }
    .tag.green { background: var(--sage-soft); color: #56705b; }
    .tag.orange { background: var(--orange-soft); color: #956442; }
    .tag.neutral { background: #f0efec; color: #777572; }
    .mini-kpis { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
    .mini-kpi { padding: 5px 8px; border: 1px solid var(--line); background: #fff; color: #596261; font-size: 12px; }
    .two-col-copy { columns: 2 260px; column-gap: 32px; margin-top: 10px; color: var(--muted); font-size: 13px; }
    .two-col-copy p { break-inside: avoid; }
    .table-wrap { overflow-x: auto; margin-top: 20px; border: 1px solid var(--line); border-radius: 6px; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; background: #fff; font-size: 13px; }
    th, td { padding: 11px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #f4f5f2; color: #5b6463; font-size: 12px; font-weight: 700; white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    td:nth-child(1), td:nth-child(3), td:nth-child(4), td:nth-child(5) { white-space: nowrap; }
    .table-tags { margin-top: 2px; }
    .muted { color: var(--muted); font-size: 12px; }
    .strategy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
    .strategy { min-height: 214px; padding: 20px; border: 1px solid var(--line); border-top: 3px solid var(--blue); border-radius: 6px; background: #fff; }
    .strategy:nth-child(2) { border-top-color: var(--sage); }
    .strategy:nth-child(3) { border-top-color: var(--orange); }
    .strategy:nth-child(4) { border-top-color: #8d9695; }
    .strategy-no { color: var(--blue); font-size: 12px; font-weight: 700; }
    .strategy h4 { margin-top: 7px; }
    .strategy p { color: var(--muted); font-size: 13px; }
    .strategy .metric { margin-top: 12px; color: #4f5d5c; font-size: 12px; font-weight: 700; }
    .method-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 26px; margin: 18px 0 0; padding: 0; list-style: none; }
    .method-list li { position: relative; padding-left: 14px; color: var(--muted); font-size: 13px; }
    .method-list li::before { content: ""; position: absolute; left: 0; top: .72em; width: 5px; height: 5px; background: var(--blue); }
    .footer { padding: 20px 6px 0; color: var(--muted); font-size: 12px; text-align: center; }
    .footer p { margin: 4px 0; }
    @media (max-width: 900px) {
      .report { width: min(100% - 28px, 760px); margin-top: 14px; }
      .cover { min-height: 0; padding: 36px 28px; }
      .cover h1 { font-size: 32px; }
      .section { padding: 23px 21px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-2, .strategy-grid { grid-template-columns: 1fr; }
      .part-header { align-items: flex-start; flex-direction: column; gap: 2px; }
    }
    @media (max-width: 580px) {
      body { font-size: 14px; }
      .report { width: min(100% - 20px, 520px); }
      .cover { padding: 30px 22px; border-radius: 7px; }
      .cover h1 { font-size: 27px; }
      .cover .lead { font-size: 16px; }
      .cover-meta { margin-top: 24px; }
      .section { padding: 20px 16px; border-radius: 6px; }
      .part-header { padding: 12px 14px; }
      .part-header h2 { font-size: 20px; }
      .section h3 { font-size: 18px; }
      .stats, .quote-grid, .grid-3, .method-list { grid-template-columns: 1fr; }
      .stat-card { min-height: 106px; }
      .stat-value { font-size: 26px; }
      .chart-panel { padding: 13px; }
      .two-col-copy { columns: 1; }
    }
  </style>
</head>
<body>
  <main class="report">
    <header class="cover">
      <span class="cover-mark">全量数据洞察 / OFFLINE REPORT</span>
      <h1>三国杀WUHU联盟<br>卡宝全量数据洞察报告</h1>
      <p class="lead">内容供给与评论反馈 · 用户关系信号 · 社区运营与周边验证</p>
      <div class="cover-meta">
        <span>评论窗口：${commentStart} 至 ${commentEnd}</span>
        <span>全量视频：${formatInteger(coverage.catalogVideoCount)} 条</span>
        <span>实采评论：${formatInteger(coverage.comments)} 条</span>
        <span>报告版本：2026.08.13</span>
      </div>
      <p class="cover-summary"><strong>核心判断：</strong>当前内容已经形成“角色关系小剧场 + 卡宝萌化人格 + 仪式型评论参与”的稳定讨论底盘；周边需求存在清晰、可量化的早期信号，但仍应通过投票、价位和预售数据完成商业化验证，而不是把评论热度直接视为销量。</p>
    </header>

    <section class="part" aria-labelledby="part-1-title">
      <div class="part-header"><span class="part-index">PART 1</span><h2 id="part-1-title">全量内容与互动反馈底盘</h2></div>
      <div class="section">
        <p class="eyebrow">样本概览</p>
        <h3>107 条内容提供了广泛的中高位讨论供给，并非由单一爆款支撑</h3>
        <p class="section-intro">本部分以视频目录和全量评论快照为基准。视频的传统播放、点赞、收藏、转发指标仅在 ${formatInteger(interactions.videosWithInteractionMetrics)} / ${formatInteger(coverage.catalogVideoCount)} 条中可见，因此本报告将“评论量、评论点赞、线程和回复”作为主证据，不构造不可复核的播放互动率。</p>
        <div class="stats">
          ${statCard(formatInteger(coverage.catalogVideoCount), '全量视频', `${formatInteger(coverage.videosWithPublishTime)} 条有可解析发布时间`, 'blue')}
          ${statCard(formatInteger(coverage.comments), '实采评论', `声明 ${formatInteger(coverage.totalDeclaredComments)} 条`, 'green')}
          ${statCard(formatInteger(coverage.uniqueAudienceCommentUsers), '受众评论者标识', '按评论用户 URL 去重', 'blue')}
          ${statCard(percent(participation.replyShare, 1), '回复型评论', `${formatInteger(coverage.replies)} 条回复`, 'orange')}
        </div>
        <div class="evidence neutral">
          <p class="evidence-title">数据完整性：评论采集覆盖 ${percent(coverage.totalCapturedComments, coverage.totalDeclaredComments, 2)}，但需保留目录声明与实采差额。</p>
          <p class="evidence-kpi">${formatInteger(coverage.exactVideos)} 条视频评论数精确一致；${formatInteger(coverage.gapVideos)} 条处于“接口末页仍有差额”状态；其中 ${formatInteger(coverage.videosWithPositiveGap)} 条少采合计 ${formatInteger(coverage.positiveDeclaredGap)} 条，另 ${formatInteger(coverage.videosWithOverCapture)} 条多 1 条，净差 ${formatInteger(coverage.netDeclaredGap)} 条。评论 ID 无重复；${formatInteger(coverage.orphanReplyCount)} 条回复的父链不完整，不影响总量但不应用于精细链路归因。</p>
        </div>
        <div class="grid-2">
          <div class="chart-panel">
            <h4>评论量分层</h4>
            <p class="chart-note">71 / 107 条视频达到 100 条评论，贡献全部评论的 ${percent(videoPerformance.shareFromVideosAtLeast100, 1)}。</p>
            ${svgVideoBands(videoPerformance.performanceBands)}
          </div>
          <div class="chart-panel">
            <h4>评论数 Top 10 视频</h4>
            <p class="chart-note">Top 1 占 ${percent(videoPerformance.top1Share, 1)}，Top 10 合计仅占 ${percent(videoPerformance.top10Share, 1)}；讨论分布不是单条内容垄断。</p>
            ${svgHorizontalBars(topVideoBars, { labelWidth: 255, labelMax: 27, rowHeight: 36, ariaLabel: '评论数 Top 10 视频' })}
          </div>
        </div>
        <div class="evidence success">
          <p class="evidence-title">内容反馈存在稳定底盘，而非仅一个爆点。</p>
          <p class="evidence-kpi">单条视频评论中位数 ${formatInteger(interactions.medianCommentsPerVideo)}、均值 ${formatDecimal(interactions.meanCommentsPerVideo)}、P25/P75 为 ${formatInteger(videoPerformance.p25Comments)} / ${formatInteger(videoPerformance.p75Comments)}；Top 10 仅占 ${percent(videoPerformance.top10Share, 1)}。这支持持续优化内容矩阵，而非将资源全部压在一次性爆款模板上。</p>
        </div>
      </div>

      <div class="section">
        <p class="eyebrow">内容形式信号</p>
        <h3>对白式角色小剧场优于悬念问句式标题，系列内容有正向但未充分隔离的信号</h3>
        <div class="grid-3">
          <div class="chart-panel">
            <h4>对白式标题</h4>
            <p class="chart-note">${formatInteger(dialogue.videos)} 条；均值 ${formatDecimal(dialogue.averageComments)}，中位 ${formatInteger(dialogue.medianComments)}。</p>
            ${tag('如“礼貌：你郭奉孝吗？”', 'blue')}
          </div>
          <div class="chart-panel">
            <h4>悬念问句标题</h4>
            <p class="chart-note">${formatInteger(question.videos)} 条；均值 ${formatDecimal(question.averageComments)}，中位 ${formatInteger(question.medianComments)}。</p>
            ${tag('与对白式标题为样本关联', 'neutral')}
          </div>
          <div class="chart-panel">
            <h4>“第 N 集”系列内容</h4>
            <p class="chart-note">${formatInteger(contentFormats.seriesVideos)} 条；均值 ${formatDecimal(contentFormats.seriesAverageComments)}，中位 ${formatInteger(contentFormats.seriesMedianComments)}。非系列中位 ${formatInteger(contentFormats.nonSeriesMedianComments)}。</p>
            ${tag('发布时间与累积时长混杂', 'orange')}
          </div>
        </div>
        <div class="evidence warning">
          <p class="evidence-title">优先把“角色冲突/关系 + 对白”当作待验证的内容方向，而不是绝对因果结论。</p>
          <p class="evidence-kpi">对白式标题的中位评论高于问句式标题（${formatInteger(dialogue.medianComments)} vs ${formatInteger(question.medianComments)}）。但视频发布时间仅 ${formatInteger(coverage.videosWithPublishTime)} / ${formatInteger(coverage.catalogVideoCount)} 条可用，且没有全量播放/完播数据，不能据此宣布某种标题或系列形式必然更优。后续应以同角色、同发布时间窗、同素材量级的 A/B 记录补足验证。</p>
        </div>
      </div>
    </section>

    <section class="part" aria-labelledby="part-2-title">
      <div class="part-header"><span class="part-index">PART 2</span><h2 id="part-2-title">用户关系、参与和商业化信号论证</h2></div>
      <div class="section">
        <p class="eyebrow">结论一 / 已验证</p>
        <h3>角色关系线是讨论的核心载体，用户会在具体组合上进行情绪化二创</h3>
        <p class="section-intro">角色提及统计采用角色名与常见别名合并；共现统计仅代表在同一条评论中共同出现，不等同用户总体偏好投票。角色及组合的曝光量受视频选题影响，应解读为“内容响应信号”。</p>
        <div class="grid-2">
          <div class="chart-panel">
            <h4>角色提及 Top 8</h4>
            <p class="chart-note">按评论条数统计，别名已并入主角色标签。</p>
            ${svgHorizontalBars(characterBars, { labelWidth: 180, rowHeight: 36, ariaLabel: '角色提及 Top 8' })}
          </div>
          <div class="chart-panel">
            <h4>高讨论角色组合</h4>
            <p class="chart-note">同一条评论中同时命中两个角色/别名的条数。</p>
            ${svgHorizontalBars(pairBars, { labelWidth: 260, labelMax: 26, rowHeight: 40, ariaLabel: '角色组合共现' })}
          </div>
        </div>
        <div class="mini-kpis">
          ${topPairs.map((pair) => `<span class="mini-kpi">${escapeHtml(pair.label)}：${formatInteger(pair.comments)} 条 / ${formatInteger(pair.users)} 人 / ${formatInteger(pair.likes)} 赞</span>`).join('')}
        </div>
        <div class="quote-grid">
          ${quoteCard(quotes.relationship, 'success')}
          ${quoteCard(data.topComments.find((item) => item.videoId === topVideos[0]?.id), 'neutral')}
        </div>
        <div class="evidence success">
          <p class="evidence-title">建议将“角色关系小剧场”保留为内容矩阵主轴。</p>
          <p class="evidence-kpi">姜维 / 伯约 x 钟会有 ${formatInteger(topPairs.find((item) => item.label.startsWith('姜维'))?.comments ?? 0)} 条共现评论、${formatInteger(topPairs.find((item) => item.label.startsWith('姜维'))?.likes ?? 0)} 赞；周瑜 x 孙策 / 孙笨有 ${formatInteger(topPairs.find((item) => item.label.startsWith('周瑜'))?.comments ?? 0)} 条、${formatInteger(topPairs.find((item) => item.label.startsWith('周瑜'))?.likes ?? 0)} 赞。接下来按“高讨论组合 + 新冲突设定 + 连载回钩”生产，并对每条视频记录角色、关系、冲突、是否续集。</p>
        </div>
      </div>

      <div class="section">
        <p class="eyebrow">结论二 / 已验证</p>
        <h3>“卡宝”已经不只是内容标签，而是可驱动评论仪式和拟人化互动的社区角色</h3>
        <div class="stats">
          ${statCard(formatInteger(signal.fanParticipation.comments), '角色化互动信号', `${percent(signal.fanParticipation.shareOfNonEmptyText, 1)} 的非空文本`, 'blue')}
          ${statCard(formatInteger(signal.cute.comments), '萌/可爱表达', `${formatInteger(signal.cute.users)} 个评论者标识`, 'green')}
          ${statCard(formatInteger(data.toSign.comments), 'to签评论', `${formatInteger(data.toSign.users)} 个评论者标识`, 'blue')}
          ${statCard(formatInteger(data.submissions.comments), '礼貌投稿', `平均 ${formatDecimal(data.submissions.averageLikes)} 赞`, 'orange')}
        </div>
        <div class="grid-2">
          <div class="chart-panel">
            <h4>社区互动信号分布</h4>
            <p class="chart-note">多标签规则统计，以 ${formatInteger(commentTextQuality.nonEmptyTextComments)} 条非空评论文本为分母，标签可重叠。</p>
            ${svgDistribution(participationBars)}
          </div>
          <div class="chart-panel">
            <h4>评论发生时段</h4>
            <p class="chart-note">18:00 至 23:59 贡献 ${formatInteger(participation.eveningComments)} 条，占 ${percent(participation.eveningShare, 1)}；18 点单小时 ${formatInteger(participation.peakHour.comments)} 条。</p>
            ${svgHourBars(participation.hourCounts)}
          </div>
        </div>
        <div class="quote-grid">
          ${quoteCard(quotes.affection, 'success')}
          ${quoteCard(quotes.sticker, 'neutral')}
        </div>
        <div class="evidence success">
          <p class="evidence-title">建立“投稿 - 投票 - 采纳 - to签/署名奖励”的周度循环，比单向征集更符合现有互动结构。</p>
          <p class="evidence-kpi">${formatInteger(data.submissions.comments)} 条“礼貌投稿”来自 ${formatInteger(data.submissions.users)} 个评论者标识，平均 ${formatDecimal(data.submissions.averageLikes)} 赞；${formatInteger(data.toSign.comments)} 条 to签诉求来自 ${formatInteger(data.toSign.users)} 个评论者标识。建议固定每周选题池、评论投票、采纳公示，并将“被采纳”与“角色签名”作为轻量反馈。18:00 至 22:00 可安排首发问题和集中回复，但此时段也会受视频发布时间影响，不应视为纯自然活跃规律。</p>
        </div>
        <div class="evidence neutral">
          <p class="evidence-title">创作者回复与高赞根评高度相关，但不能据此倒推因果。</p>
          <p class="evidence-kpi">${formatInteger(participation.replyAssociation.markedRootComments)} 条根评标记为“作者回复”，覆盖 ${percent(participation.replyAssociation.markedRate, 1)} 的根评；这些评论平均 ${formatDecimal(participation.replyAssociation.markedAverageLikes)} 赞，未标记根评为 ${formatDecimal(participation.replyAssociation.unmarkedAverageLikes)} 赞，约 ${formatDecimal(participation.replyAssociation.ratio)} 倍。创作者可能优先回复本已高赞的评论，因此应通过回复时效、回复覆盖率和后续二创表现进一步验证。</p>
        </div>
      </div>

      <div class="section">
        <p class="eyebrow">结论三 / 早期商业化信号</p>
        <h3>玩偶、周边和表情包有可量化需求，适合做小规模商品化验证</h3>
        <p class="section-intro">以下口径只基于非空评论文本。品类讨论与近购买表达分别统计：前者描述“有多少人在谈”，后者只保留更明确的购买/推出动作，用作需求下限，而不是预计订单量。</p>
        <div class="stats">
          ${statCard(formatInteger(signal.merchandise.comments), '周边品类讨论', `${formatInteger(signal.merchandise.users)} 个评论者标识`, 'blue')}
          ${statCard(formatInteger(signal.strictPurchase.comments), '近购买意向下限', `${formatInteger(signal.strictPurchase.users)} 个评论者标识`, 'green')}
          ${statCard(formatDecimal(signal.strictPurchase.averageLikes), '近购买评论均赞', `全量评论均赞 ${formatDecimal(interactions.totalCommentLikes / coverage.comments)}`, 'green')}
          ${statCard(formatInteger(data.priceSignal.comments), '价格相关表达', '样本小，只宜做价位测试', 'orange')}
        </div>
        <div class="grid-2">
          <div class="chart-panel">
            <h4>用户最常提及的周边品类</h4>
            <p class="chart-note">同一评论可同时命中多个品类词，因此各项不可相加。</p>
            ${svgHorizontalBars(productTermBars, { labelWidth: 150, rowHeight: 40, ariaLabel: '周边品类讨论量' })}
          </div>
          <div class="chart-panel">
            <h4>需求验证应按漏斗推进</h4>
            <p class="chart-note">评论信号已经足以决定优先验证方向，但尚不足以确认价格、转化率、履约规模或 SKU 数量。</p>
            <div class="mini-kpis">
              ${tag('角色投票', 'blue')}${tag('样机/表情包试投放', 'green')}${tag('价位 A/B', 'orange')}${tag('预约/定金', 'blue')}${tag('支付转化', 'neutral')}
            </div>
            <p class="two-col-copy"><span>优先品类：玩偶 ${formatInteger(data.productTerms.find((item) => item.label === '玩偶')?.comments ?? 0)} 条、周边 ${formatInteger(data.productTerms.find((item) => item.label === '周边')?.comments ?? 0)} 条、表情包 ${formatInteger(data.productTerms.find((item) => item.label === '表情包')?.comments ?? 0)} 条。</span><span>近购买规则：直接出现“想买/必买/肯定买/我要买/在哪里买”，或“时间/催促/请求词 + 出/做 + 具体品类”。</span></p>
          </div>
        </div>
        <div class="quote-grid">
          ${quoteCard(quotes.purchaseToy, 'success')}
          ${quoteCard(quotes.purchaseMerch, 'success')}
          ${quoteCard(quotes.price, 'warning')}
          ${quoteCard(quotes.sticker, 'neutral')}
        </div>
        <div class="evidence success">
          <p class="evidence-title">周边需求已经是可启动验证的早期机会，不是“直接扩 SKU”的结论。</p>
          <p class="evidence-kpi">${formatInteger(signal.merchandise.comments)} 条评论出现 8 类周边词，涉及 ${formatInteger(signal.merchandise.users)} 个评论者标识；其中 ${formatInteger(signal.strictPurchase.comments)} 条满足近购买意向规则，涉及 ${formatInteger(signal.strictPurchase.users)} 人，获得 ${formatInteger(signal.strictPurchase.likes)} 赞，单条均赞 ${formatDecimal(signal.strictPurchase.averageLikes)}，约为全量均赞的 ${formatDecimal(signal.strictPurchase.averageLikes / (interactions.totalCommentLikes / coverage.comments))} 倍。建议先由角色投票筛选玩偶/毛绒方向，用表情包作低成本先导，再用价位测试与预约/定金确认需求质量。</p>
        </div>
        <div class="evidence warning">
          <p class="evidence-title">价格表达只有 ${formatInteger(data.priceSignal.comments)} 条，不能从一句“不要太贵”推导最终定价。</p>
          <p class="evidence-kpi">可在下一轮通过 2 至 3 个价格带的匿名投票或预约页比较选择率，并把支付、退款和交付成本纳入最终商业判断。</p>
        </div>
      </div>

      <div class="section">
        <p class="eyebrow">结论四 / 运营机会与风险</p>
        <h3>需要用连续剧情拉升复访，同时把低成本可达性问题标准化处理</h3>
        <div class="grid-2">
          <div class="evidence neutral">
            <p class="evidence-title">复访基础有待扩大。</p>
            <p class="evidence-kpi">按评论用户 URL 作为身份近似标识，${formatInteger(participation.userFrequency.one)} / ${formatInteger(coverage.uniqueCommentUsers)} 个标识只出现 1 次（${percent(participation.userFrequency.one, coverage.uniqueCommentUsers, 1)}）；${formatInteger(participation.userFrequency.twoToThree)} 个出现 2 至 3 次，${formatInteger(participation.userFrequency.fourPlus)} 个至少出现 4 次。建议用连续角色线、周任务和采纳反馈跟踪“首次评论后 30 天复评”。</p>
          </div>
          <div class="evidence warning">
            <p class="evidence-title">个别反感与可达性诉求值得纳入产品流程，而非用词频自动定性。</p>
            <p class="evidence-kpi">字幕明确诉求 ${formatInteger(signal.subtitle.comments)} 条，样本很小但实现成本低，建议全片标准化。强负向词命中 ${formatInteger(signal.negative.comments)} 条，包含反讽、剧情引用等语境，不能直接当负面率，应对高赞样本人工编码。</p>
          </div>
        </div>
        <div class="quote-grid">
          ${quoteCard(quotes.captions, 'neutral')}
          ${quoteCard(quotes.criticism, 'warning')}
        </div>
      </div>
    </section>

    <section class="part" aria-labelledby="part-3-title">
      <div class="part-header"><span class="part-index">PART 3</span><h2 id="part-3-title">下一阶段策略与测量闭环</h2></div>
      <div class="section">
        <p class="eyebrow">策略建议</p>
        <h3>从已观察到的讨论行为，转向可测量的内容、运营和商品化实验</h3>
        <div class="strategy-grid">
          <article class="strategy">
            <div class="strategy-no">01 / 内容矩阵</div>
            <h4>用高讨论角色关系做“冲突 - 反转 - 回钩”连载</h4>
            <p>优先围绕姜维 / 伯约 x 钟会、周瑜 x 孙策 / 孙笨、郭嘉 / 奉孝 x 曹操 / 阿瞒等现有高响应组合，每周保留一条续集和一条新组合探索。标题优先测试对白式开场。</p>
            <div class="metric">记录：角色组合、冲突类型、集数、评论中位数、回复占比、续集复评率。</div>
          </article>
          <article class="strategy">
            <div class="strategy-no">02 / 社区运营</div>
            <h4>把“礼貌投稿 + to签”产品化为可回访的互动机制</h4>
            <p>设置周度投稿池与评论投票，公开采纳结果；对被采纳内容给予角色 to签、置顶或后续小剧场彩蛋。18:00 发布征集问题，18:00 至 22:00 集中回复和二创追问。</p>
            <div class="metric">记录：去重投稿者、投票参与、采纳率、作者回复率、被采纳用户的 30 天复评率。</div>
          </article>
          <article class="strategy">
            <div class="strategy-no">03 / 周边验证</div>
            <h4>以玩偶/毛绒为主验证方向，表情包做低成本先导</h4>
            <p>先做角色偏好投票与表情包试投放，再展示玩偶/毛绒概念图，针对不同价格带测预约率；只有在预约/定金形成稳定信号后，再决定实体 SKU 和生产规模。</p>
            <div class="metric">记录：投票独立参与者、落地页到预约率、各价位选择率、定金支付率、退款/交付成本。</div>
          </article>
          <article class="strategy">
            <div class="strategy-no">04 / 数据治理</div>
            <h4>补齐发布时间和视频侧互动字段，分开看内容与运营效果</h4>
            <p>保留评论抓取覆盖率与差额，同时为每条视频补齐发布时间、播放、点赞、收藏、转发、完播和活动标签。将作者评论与受众评论拆开，避免互动自循环抬高判断。</p>
            <div class="metric">记录：全字段覆盖率、视频 A/B 分组、受众独立评论者、评论线程率、严格购买意向、支付转化。</div>
          </article>
        </div>
      </div>

      <div class="section">
        <p class="eyebrow">附录 A / 视频证据</p>
        <h3>评论数 Top 10 视频</h3>
        <p class="section-intro">评论点赞为对应视频下全部实采评论点赞之和；回复占比为该视频回复数 / 实采评论数。链接指向原视频页面。</p>
        <div class="table-wrap"><table>
          <thead><tr><th>排名</th><th>视频标题</th><th>实采评论</th><th>评论获赞合计</th><th>回复 / 占比</th></tr></thead>
          <tbody>${videoTableRows(topVideos)}</tbody>
        </table></div>
      </div>

      <div class="section">
        <p class="eyebrow">附录 B / 方法与边界</p>
        <h3>数据口径、可复核性与不能外推的部分</h3>
        <ul class="method-list">
          <li>数据源：${currentSourceName} 下的 <code>all-comments.csv</code>、<code>videos-summary.csv</code>、<code>manifest.json</code> 及视频元数据；全量目录为 ${formatInteger(coverage.catalogVideoCount)} 条视频。</li>
          <li>评论快照：声明 ${formatInteger(coverage.totalDeclaredComments)} 条，实采 ${formatInteger(coverage.totalCapturedComments)} 条；覆盖与差额如 PART 1 所述。不会把抓取差额隐藏为零。</li>
          <li>用户数：使用评论用户 URL 去重，属于身份近似标识，不等于平台完整去重用户或粉丝数；作者账号评论 ${formatInteger(interactions.authorComments)} 条，占 ${percent(interactions.authorComments, coverage.comments, 1)}。</li>
          <li>语义统计：以 ${formatInteger(commentTextQuality.nonEmptyTextComments)} 条非空文本为分母，规则透明、多标签可重叠；${formatInteger(commentTextQuality.nonTextComments)} 条为空文本，不归类为中性。</li>
          <li>评论文本：${formatInteger(commentTextQuality.duplicateTextRowCount)} 条非空文本为重复出现的梗/复制话术行，占 ${percent(commentTextQuality.duplicateTextRowShare, 1)}；评论 ID 本身无重复。</li>
          <li>角色提及和组合：会受视频是否选中该角色、内容发布时间和累积曝光影响，描述的是样本内内容响应，不是整体角色人气排名。</li>
          <li>时段：评论时刻并不等于用户自然活跃时刻，可能被发布时间、推流和活动节奏共同影响；因此仅作为运营排班的待验证输入。</li>
          <li>商业化：周边与近购买信号是评论意向下限，不是销量、GMV 或实际购买人数。最终决策必须连接预约、支付、退款和履约数据。</li>
          <li>缺失字段：可解析发布时间仅 ${formatInteger(coverage.videosWithPublishTime)} 条；传统视频互动字段仅 ${formatInteger(interactions.videosWithInteractionMetrics)} 条可见，因此没有在本报告中构造全量播放互动率或发布时间趋势。</li>
          <li>地域字段来自评论地点标签，只可描述评论 IP 标签分布，不应外推为用户真实居住地、年龄、性别或消费能力。</li>
        </ul>
      </div>
    </section>

    <footer class="footer">
      <p>生成时间：${escapeHtml(generatedAt)}（Asia/Shanghai） · 离线单文件报告 · <a href="wuhu-full-data-insight.json">查看结构化指标 JSON</a> · <a href="artifact-manifest.json">查看产物哈希清单</a></p>
      <p>报告叙事与版式参考用户提供的专项论证报告，当前数字、评论引语与结论均来自本次全量 CSV 复算。</p>
    </footer>
  </main>
</body>
</html>`;
}

fs.mkdirSync(outputDir, { recursive: true });
const jsonOutputPath = path.join(outputDir, 'wuhu-full-data-insight.json');
const reportOutputPath = path.join(outputDir, '三国杀WUHU联盟卡宝全量数据洞察报告.html');
const manifestOutputPath = path.join(outputDir, 'artifact-manifest.json');
fs.writeFileSync(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
fs.writeFileSync(reportOutputPath, `${buildReportHtml(summary)}\n`, 'utf8');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const artifactManifest = {
  generatedAt: summary.reportGeneratedAt,
  report: path.basename(reportOutputPath),
  reportStyleReference: fs.existsSync(referencePath) ? referencePath : null,
  sourceFiles: [commentsPath, videosPath, manifestPath].map((filePath) => ({
    path: filePath,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
  })),
  outputs: [reportOutputPath, jsonOutputPath].map((filePath) => ({
    path: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
  })),
};
fs.writeFileSync(manifestOutputPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  outputDir,
  reportOutputPath,
  jsonOutputPath,
  manifestOutputPath,
  coverage: summary.coverage,
  interactions: summary.interactions,
  participation: summary.participation,
  topics: summary.rules,
  topByComments: summary.topVideosByComments.slice(0, 5).map((video) => ({ title: video.title, comments: video.capturedComments, likes: video.likes, collects: video.collects, shares: video.shares })),
}, null, 2));
