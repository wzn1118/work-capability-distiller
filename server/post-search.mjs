import { createHash } from 'node:crypto';
import { safeRemoteUrl } from './normalizer.mjs';

const POST_DOMAINS = ['douyin.com', 'iesdouyin.com'];
const MEDIA_DOMAINS = [
  'douyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'bytecdn.cn',
  'byteimg.com',
  'ibytedtos.com',
  'bytedance.com',
  'volces.com',
];

function text(value, maximum = 0) {
  if (value === undefined || value === null || typeof value === 'object') return '';
  const result = String(value).replace(/\s+/g, ' ').trim();
  return maximum ? result.slice(0, maximum) : result;
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return '';
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length) || [];
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = text(value).replace(/,/g, '').toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)([万亿wkmb])?/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = { 万: 10_000, 亿: 100_000_000, w: 10_000, k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2] || ''] || 1;
  return Math.round(base * multiplier);
}

function durationSecondsFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    const seconds = value > 86_400 ? Math.round(value / 1_000) : Math.round(value);
    return seconds > 0 && seconds <= 86_400 ? seconds : null;
  }
  const raw = text(value).trim();
  const clock = raw.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const hours = Number(clock[3] || 0);
    const minutes = Number(clock[1]);
    const seconds = Number(clock[2]);
    const total = clock[3] ? (hours * 3_600) + (minutes * 60) + seconds : (minutes * 60) + seconds;
    return total > 0 && total <= 86_400 ? total : null;
  }
  return null;
}

function postUrl(value) {
  try {
    const url = new URL(text(value), 'https://www.douyin.com');
    if (url.protocol !== 'https:' || !POST_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return '';
    const match = url.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
    return match ? `https://www.douyin.com/${match[1].toLowerCase()}/${match[2]}` : '';
  } catch {
    return '';
  }
}

function profileUrl(value) {
  return safeRemoteUrl(value, { baseUrl: 'https://www.douyin.com', domains: POST_DOMAINS });
}

function mediaUrl(value) {
  return safeRemoteUrl(value, { domains: MEDIA_DOMAINS });
}

function playbackMediaUrl(value) {
  const normalized = mediaUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if ((host === 'douyin.com' || host.endsWith('.douyin.com'))
      && !/(?:\.mp4|\.webm|\/aweme\/|\/video\/tos\/)/i.test(parsed.pathname)) return '';
    return normalized;
  } catch {
    return '';
  }
}

function mediaCandidates(...values) {
  const output = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') {
      output.push(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    ['url', 'src', 'source', 'uri', 'play_addr', 'playAddr', 'play_url', 'playUrl', 'image_url', 'imageUrl', 'origin_url', 'originUrl', 'download_url', 'downloadUrl'].forEach((key) => visit(value[key]));
  };
  values.forEach(visit);
  return output;
}

function normalizeMediaUrls(...values) {
  return [...new Set(mediaCandidates(...values).map(mediaUrl).filter(Boolean))].slice(0, 8);
}

function firstMediaUrl(...values) {
  return mediaCandidates(...values).map(playbackMediaUrl).find(Boolean) || '';
}

function normalizeVideoFrames(record, nested, inherited = {}) {
  const sources = [
    record.video_frames, record.videoFrames, record.keyframes, record.key_frames,
    nested.frames, nested.video?.frames, inherited.videoFrames,
  ];
  const frames = sources.find((value) => Array.isArray(value) && value.length) || [];
  return frames.slice(0, 4).map((frame, index) => {
    const item = frame && typeof frame === 'object' ? frame : { url: frame };
    const timeSeconds = Number(item.timeSeconds ?? item.time_seconds ?? item.timestamp ?? item.position);
    return {
      index: Number.isInteger(Number(item.index ?? item.frameIndex ?? item.frame_index))
        ? Math.max(1, Number(item.index ?? item.frameIndex ?? item.frame_index))
        : index + 1,
      timeSeconds: Number.isFinite(timeSeconds) && timeSeconds >= 0 ? timeSeconds : null,
      artifactPath: text(item.artifactPath ?? item.artifact_path, 500),
      url: mediaUrl(item.url ?? item.imageUrl ?? item.image_url ?? item.src),
      ocrText: text(item.ocrText ?? item.ocr_text ?? item.text, 240),
      semanticText: text(item.semanticText ?? item.semantic_text ?? item.description, 240),
      timelineAnchor: text(item.timelineAnchor ?? item.timeline_anchor, 40),
      samplingReason: text(item.samplingReason ?? item.sampling_reason, 80),
    };
  }).filter((frame) => frame.artifactPath || frame.url || frame.ocrText || frame.semanticText);
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString();
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return '';
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function stableId(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function metricValue(source, keys) {
  return numberValue(keys.reduce((value, key) => value ?? source?.[key], null));
}

function normalizeMetrics(record, statistics, visibleMetrics = []) {
  const visibleMetric = (labels) => {
    for (const value of visibleMetrics) {
      const raw = text(value);
      if (!labels.some((label) => raw.includes(label))) continue;
      const match = raw.match(/[0-9]+(?:\.[0-9]+)?(?:[wkmb\u4e07\u4ebf])?/i);
      const parsed = numberValue(match?.[0]);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const metrics = {};
  const values = {
    likes: metricValue(statistics, ['digg_count', 'diggCount', 'like_count', 'likes', 'likeCount'])
      ?? metricValue(record, ['likes', 'like_count', 'likeCount', 'digg_count', 'diggCount'])
      ?? visibleMetric(['\u70b9\u8d5e', '\u8d5e', '\u559c\u6b22']),
    comments: metricValue(statistics, ['comment_count', 'commentCount', 'comments'])
      ?? metricValue(record, ['comments', 'comment_count', 'commentCount'])
      ?? visibleMetric(['\u8bc4\u8bba']),
    shares: metricValue(statistics, ['share_count', 'shareCount', 'shares'])
      ?? metricValue(record, ['shares', 'share_count', 'shareCount'])
      ?? visibleMetric(['\u8f6c\u53d1', '\u5206\u4eab']),
    collects: metricValue(statistics, ['collect_count', 'collectCount', '收藏'])
      ?? metricValue(record, ['collects', 'collect_count', 'collectCount'])
      ?? visibleMetric(['\u6536\u85cf']),
    plays: metricValue(statistics, ['play_count', 'playCount', 'views', 'view_count'])
      ?? metricValue(record, ['plays', 'play_count', 'playCount', 'views', 'view_count'])
      ?? visibleMetric(['\u64ad\u653e', '\u89c2\u770b']),
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value !== null) metrics[key] = value;
  });
  return metrics;
}

function normalizeTags(record) {
  const values = firstArray(record.hashtags, record.tags, record.challenge_info, record.text_extra);
  return [...new Set(values.map((value) => text(value?.hashtag_name ?? value?.name ?? value?.title ?? value, 80)).filter(Boolean))].slice(0, 16);
}

function commentSources(record, nested) {
  const wrappers = [
    record.comments, record.comment_list, record.commentList, record.hot_comments, record.hotComments,
    record.comment_data, record.commentData, nested.comments, nested.comment_list, nested.commentList,
  ];
  for (const value of wrappers) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const items = firstArray(value.comments, value.comment_list, value.commentList, value.hot_comments, value.hotComments, value.items, value.data);
      if (items.length) return items;
    }
  }
  return [];
}

function booleanFlag(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    const normalized = text(value).toLowerCase();
    if (['1', 'true', 'yes', 'hot', 'pinned'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
  }
  return false;
}

function flattenCommentRecords(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenCommentRecords(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const nested = firstArray(
    value.comments, value.comment_list, value.commentList, value.hot_comments, value.hotComments,
    value.items, value.data,
  );
  if (nested.length) nested.forEach((item) => flattenCommentRecords(item, output));
  else output.push(value);
  return output;
}

function normalizeCommentRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const comment = firstObject(record.comment, record.comment_info, record.commentInfo);
  const author = firstObject(record.author, record.user, record.user_info, record.userInfo, comment.author, comment.user);
  const body = firstText(
    record.text, record.content, record.comment_text, record.commentText, record.body, record.desc,
    comment.text, comment.content, comment.comment_text, comment.commentText,
  ).slice(0, 1_200);
  const authorName = firstText(
    record.author_name, record.authorName, record.nickname, record.user_name, record.userName,
    author.nickname, author.nick_name, author.name, author.unique_id,
  ).slice(0, 120);
  if (!body && !authorName) return null;
  const likeCount = numberValue(
    record.like_count ?? record.likeCount ?? record.likes ?? record.like_num
      ?? record.digg_count ?? record.diggCount ?? comment.like_count ?? comment.likeCount,
  );
  const replyCount = numberValue(
    record.reply_count ?? record.replyCount ?? record.replies ?? comment.reply_count ?? comment.replyCount,
  );
  const publishedAt = isoDate(firstText(
    record.published_at, record.publishedAt, record.create_time, record.createTime, record.time,
    comment.published_at, comment.publishedAt, comment.create_time, comment.createTime,
  ));
  const publishedAtText = firstText(
    record.published_at_text, record.publishedAtText, record.time_text, record.timeText, record.time,
    comment.published_at_text, comment.publishedAtText,
  ).slice(0, 60);
  const rawId = firstText(
    record.comment_id, record.commentId, record.cid, record.id,
    comment.comment_id, comment.commentId, comment.cid, comment.id,
  );
  return {
    id: `comment-${stableId(rawId || `${authorName}|${body}|${index}`)}`,
    commentId: rawId || '',
    authorName: authorName || '未知用户',
    authorProfile: profileUrl(firstText(
      record.author_profile, record.authorProfile, record.user_url, record.userUrl,
      author.profile_url, author.profileUrl, author.url,
    )),
    text: body || '暂无评论内容',
    likeCount,
    replyCount,
    publishedAt,
    publishedAtText,
    isHot: booleanFlag(record.is_hot, record.isHot, record.hot, record.is_pinned, record.isPinned, record.pinned),
    _inputIndex: index,
  };
}

export function normalizePostSearchComments(records, limit = 10) {
  const maximum = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(10, Math.floor(Number(limit)))) : 10;
  const normalized = flattenCommentRecords(records)
    .map((record, index) => normalizeCommentRecord(record, index))
    .filter(Boolean);
  const hasLikeCounts = normalized.some((comment) => comment.likeCount !== null);
  const sorted = hasLikeCounts
    ? normalized.slice().sort((left, right) => {
      if (left.likeCount === null && right.likeCount !== null) return 1;
      if (left.likeCount !== null && right.likeCount === null) return -1;
      if (left.likeCount !== right.likeCount) return (right.likeCount || 0) - (left.likeCount || 0);
      return left._inputIndex - right._inputIndex;
    })
    : normalized;
  return sorted.slice(0, maximum).map(({ _inputIndex, ...comment }, index) => ({ ...comment, rank: index + 1 }));
}

function normalizePostRecord(record, inherited = {}, query = '', sourceUrl = '', index = 0) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const nested = firstObject(record.aweme_info, record.aweme, record.item, record.video, record.data);
  const author = firstObject(record.author, record.author_info, record.user, nested.author, inherited.author);
  const statistics = firstObject(record.statistics, record.stats, nested.statistics, nested.stats);
  const contentUrl = postUrl(firstText(
    record.note_url, record.noteUrl, record.aweme_url, record.awemeUrl, record.share_url,
    record.content_url, record.contentUrl, record.url, record.link,
    nested.note_url, nested.aweme_url,
    nested.share_url, nested.url, inherited.contentUrl,
  ));
  const title = firstText(record.title, record.desc, record.description, nested.title, nested.desc, inherited.title).slice(0, 300);
  const body = firstText(record.body, record.text, record.caption, record.desc, record.description, nested.body, nested.text, nested.desc, inherited.body).slice(0, 1200);
  const authorName = firstText(
    record.author_name, record.authorName, record.nickname, record.name,
    author.nickname, author.nick_name, author.name, author.unique_id, inherited.authorName,
  ).slice(0, 120);
  const authorProfile = profileUrl(firstText(
    record.author_profile, record.authorProfile, record.profile_url, record.source_profile_url,
    author.profile_url, author.profileUrl, author.url, inherited.authorProfile,
  ));
  const coverUrl = mediaUrl(firstText(
    record.cover_url, record.coverUrl, record.thumbnail_url, record.thumbnail,
    record.cover?.url, nested.cover_url, nested.cover?.url, inherited.coverUrl,
  ));
  const imageUrls = normalizeMediaUrls(
    record.image_urls, record.imageUrls, record.images, record.image_list, record.imageList,
    record.photos, record.photo_urls, record.photoUrls, nested.image_urls, nested.imageUrls,
    nested.images, nested.image_list, inherited.imageUrls,
  );
  if (coverUrl && !imageUrls.includes(coverUrl)) imageUrls.unshift(coverUrl);
  const videoUrl = firstMediaUrl(
    record.video_url, record.videoUrl, record.play_addr, record.playAddr, record.play_url, record.playUrl,
    nested.video_url, nested.videoUrl, nested.video, nested.play_addr, nested.playAddr,
  );
  const videoFrames = normalizeVideoFrames(record, nested, inherited);
  const visibleMetrics = firstArray(record.visible_metrics, record.visibleMetrics, inherited.visibleMetrics)
    .map((value) => text(value, 80)).filter(Boolean).slice(0, 16);
  const metrics = normalizeMetrics(record, statistics, visibleMetrics);
  const comments = normalizePostSearchComments(commentSources(record, nested), 10);
  const commentCount = metricValue(record, ['comment_count', 'commentCount', 'comments'])
    ?? metricValue(statistics, ['comment_count', 'commentCount', 'comments']);
  const publishedAt = isoDate(firstText(
    record.published_at, record.publishedAt, record.create_time, record.createTime,
    nested.create_time, nested.createTime, inherited.publishedAt,
  ));
  const publishedAtText = firstText(record.published_at_text, record.publishedAtText, inherited.publishedAtText).slice(0, 40);
  const tags = [...new Set([...normalizeTags(record), ...(Array.isArray(inherited.tags) ? inherited.tags : [])])].slice(0, 16);
  const durationValue = durationSecondsFromValue(
    record.duration_seconds ?? record.durationSeconds ?? record.duration_text ?? record.durationText
      ?? nested.duration_seconds ?? nested.durationSeconds ?? nested.duration_text ?? nested.durationText,
  );
  const contentType = firstText(record.content_type, record.contentType, nested.content_type, inherited.contentType)
    || (videoUrl || (Number.isFinite(durationValue) && durationValue > 0) ? 'video' : imageUrls.length ? 'image_or_note' : 'note');
  const hasVideo = Boolean(record.has_video || record.hasVideo || videoUrl
    || (Number.isFinite(durationValue) && durationValue > 0)
    || contentType === 'video');
  const rawId = firstText(record.postId, record.post_id, record.aweme_id, record.awemeId, record.item_id, record.itemId, record.id, nested.aweme_id, nested.id);
  if (!contentUrl && !title && !body) return null;
  const id = `post-${stableId(contentUrl || `${authorName}|${title}|${body}|${index}`)}`;
  return {
    id,
    postId: rawId || id,
    platform: 'douyin',
    query,
    sourceUrl,
    contentUrl,
    title: title || body.slice(0, 120) || '未命名帖子',
    body,
    authorName: authorName || '未识别账号',
    authorProfile,
    coverUrl,
    imageUrls,
    imageCount: Math.max(imageUrls.length, numberValue(record.content_image_count ?? record.imageCount) || 0),
    videoUrl,
    tags,
    contentType,
    hasVideo,
    durationSeconds: Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : null,
    videoFrames,
    keyframeCount: videoFrames.length,
    metrics,
    visibleMetrics,
    comments,
    commentCount: commentCount ?? comments.length,
    publishedAt,
    publishedAtText,
  };
}

export function normalizePostSearchRecord(record, query = '', sourceUrl = '', index = 0) {
  return normalizePostRecord(record, {}, query, sourceUrl, index);
}

export function normalizePostSearchResults(records, query = '', sourceUrl = '') {
  const output = [];
  const seen = new Set();
  const visit = (record, inherited = {}) => {
    if (!record || typeof record !== 'object') return;
    const samples = firstArray(record.latest_samples, record.latestSamples, record.profile?.latest_samples, record.content?.samples);
    const author = firstObject(record.author, record.author_info, record.user, inherited.author);
    const inheritedPost = {
      author,
      authorName: firstText(record.observed_name, record.author_name, record.authorName, author.nickname, inherited.authorName),
      authorProfile: firstText(record.author_profile, record.source_profile_url, inherited.authorProfile),
      coverUrl: firstText(record.cover_url, record.avatar_url, inherited.coverUrl),
      imageUrls: firstArray(record.image_urls, record.imageUrls, record.images, inherited.imageUrls),
      videoFrames: firstArray(record.video_frames, record.videoFrames, record.keyframes, inherited.videoFrames),
    };
    const item = normalizePostRecord(record, inheritedPost, query, sourceUrl, output.length);
    const nextInherited = { ...inheritedPost, ...(item || {}) };
    // Search records keep lightweight author data at the outer level and the
    // actual media/statistics in latest_samples. Visit samples first so the
    // enriched record wins the duplicate URL instead of being discarded.
    samples.forEach((sample) => visit(sample, nextInherited));
    const nested = firstArray(record.posts, record.notes, record.items, record.videos);
    nested.forEach((child) => visit(child, nextInherited));
    if (item && item.contentUrl && !seen.has(item.id)) {
      seen.add(item.id);
      output.push(item);
    }
  };
  for (const record of Array.isArray(records) ? records : []) visit(record);
  return output;
}

function postResultIdentity(post) {
  return text(post?.contentUrl) || text(post?.postId) || text(post?.id);
}

function mergeUniqueValues(left, right, maximum = 0) {
  const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
    .map((value) => text(value))
    .filter(Boolean);
  const unique = [...new Set(values)];
  return maximum ? unique.slice(0, maximum) : unique;
}

function mergePostRecord(previous, next) {
  const merged = { ...previous, ...next };
  ['contentUrl', 'title', 'body', 'authorName', 'authorProfile', 'coverUrl', 'videoUrl', 'publishedAt', 'publishedAtText']
    .forEach((key) => {
      if (!text(next?.[key]) && text(previous?.[key])) merged[key] = previous[key];
    });
  merged.metrics = { ...(previous?.metrics || {}), ...(next?.metrics || {}) };
  merged.tags = mergeUniqueValues(previous?.tags, next?.tags, 16);
  merged.visibleMetrics = mergeUniqueValues(previous?.visibleMetrics, next?.visibleMetrics, 16);
  merged.imageUrls = mergeUniqueValues(previous?.imageUrls, next?.imageUrls, 8);
  merged.imageCount = Math.max(Number(previous?.imageCount) || 0, Number(next?.imageCount) || 0, merged.imageUrls.length);
  merged.videoFrames = [...(Array.isArray(previous?.videoFrames) ? previous.videoFrames : []), ...(Array.isArray(next?.videoFrames) ? next.videoFrames : [])]
    .filter((frame, index, frames) => frames.findIndex((candidate) => (
      (candidate?.url && candidate.url === frame?.url) || candidate?.index === frame?.index
    )) === index)
    .slice(0, 4);
  merged.keyframeCount = merged.videoFrames.length;
  const comments = [...(Array.isArray(previous?.comments) ? previous.comments : []), ...(Array.isArray(next?.comments) ? next.comments : [])]
    .filter((comment, index, values) => values.findIndex((candidate) => (
      (candidate?.commentId && candidate.commentId === comment?.commentId) || candidate?.id === comment?.id
    )) === index)
    .sort((left, right) => (Number(right?.likeCount) || 0) - (Number(left?.likeCount) || 0))
    .slice(0, 10)
    .map((comment, index) => ({ ...comment, rank: index + 1 }));
  merged.comments = comments;
  merged.commentCount = Math.max(Number(previous?.commentCount) || 0, Number(next?.commentCount) || 0, comments.length);
  merged.hasVideo = Boolean(previous?.hasVideo || next?.hasVideo || merged.videoUrl || merged.videoFrames.length);
  return merged;
}

export function mergePostSearchResults(existing, incoming) {
  const output = [];
  const indexByIdentity = new Map();
  const add = (post) => {
    if (!post || typeof post !== 'object') return;
    const identity = postResultIdentity(post);
    if (!identity) return;
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, output.length);
      output.push(post);
      return;
    }
    output[existingIndex] = mergePostRecord(output[existingIndex], post);
  };
  (Array.isArray(existing) ? existing : []).forEach(add);
  (Array.isArray(incoming) ? incoming : []).forEach(add);
  return output;
}
