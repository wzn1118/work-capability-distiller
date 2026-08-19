import {
  canonicalCreatorIdentity,
  formatMetric,
  isProfileSourceUrl,
  isTransportErrorPageContent,
  isUsableCreatorName,
  normalizeDouyinCreators,
  parseMetric,
  safeRemoteUrl,
  sourceUrlFor,
} from './normalizer.mjs';

const MAX_TOPIC_SIGNALS = 8;
const MAX_TEXT_SAMPLE = 480;
const MAX_BIO_LENGTH = 280;
const MAX_VISIBLE_METRICS = 24;
const MAX_VISIBLE_AUDIENCE_SIGNALS = 8;
const MAX_VISIBLE_CONTENT_SAMPLES = 12;
// This is a public-content retention ceiling, not an instruction to fetch
// private or unavailable items.  The collector reports why a run stops so the
// persona can distinguish a complete public page from a bounded capture.
const MAX_CONTENT_CAPTURE_SAMPLES = 10_000;
const MAX_CONTENT_SUMMARY_LENGTH = 280;
const MAX_CONTENT_DETAIL_LENGTH = 1600;
const CREATOR_PERSONA_SCHEMA_VERSION = 4;
const CREATOR_PERSONA_PROVENANCE_VERSION = 1;
const MAX_PROFILE_TAGS = 16;
const MAX_VERTICAL_LABELS = 16;
const MAX_COMMERCIAL_MARKERS = 16;
const MAX_BRAND_MENTIONS = 16;
const MAX_RISK_FLAGS = 16;
const MAX_PROVENANCE_SOURCE_PATHS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERACTION_ACTION_NAMES = ['likes', 'collects', 'comments', 'shares'];
const INTERACTION_METRIC_NAMES = [...INTERACTION_ACTION_NAMES, 'plays'];
const INTERACTION_METRIC_PATHS = {
  likes: ['like_count', 'likes', 'like', 'digg_count', 'digg', 'likeCount', 'diggCount'],
  collects: [
    'collect_count', 'collects', 'collect', 'favorite_count', 'favourite_count',
    'favorites', 'favourites', 'collectCount', 'favoriteCount', 'favouriteCount',
  ],
  comments: ['comment_count', 'comments', 'comment', 'commentCount'],
  shares: ['share_count', 'shares', 'share', 'forward_count', 'forward', 'repost_count', 'repost', 'shareCount'],
  plays: ['play_count', 'plays', 'play', 'view_count', 'views', 'view', 'playCount', 'viewCount'],
};
const CONTENT_INTERACTION_OBJECT_PATHS = [
  'statistics', 'stats', 'statistic', 'metrics', 'interactions', 'interaction_counts',
  'interactionCounts', 'engagement', 'engagement_metrics', 'engagementMetrics',
];
const VISIBLE_METRIC_PATHS = [
  'visible_metrics', 'visibleMetrics', 'metric_labels', 'metricLabels',
  'interaction_labels', 'interactionLabels',
];
const VISIBLE_METRIC_LABEL_PATTERNS = {
  likes: [/\u70b9\u8d5e|\u83b7\u8d5e|\u8d5e|\u559c\u6b22|like|digg/i],
  collects: [/\u6536\u85cf|collect|favo(?:rite|urite)/i],
  comments: [/\u8bc4\u8bba|comment/i],
  shares: [/\u8f6c\u53d1|\u5206\u4eab|forward|repost|share/i],
  plays: [/\u64ad\u653e|\u89c2\u770b|play|view/i],
};
const CONTENT_PUBLISHED_AT_PATHS = [
  'published_at', 'publishedAt', 'publish_at', 'publishAt', 'publish_time', 'publishTime',
  'published_at_text', 'publishedAtText', 'published_time_text', 'publishedTimeText',
  'publish_time_text', 'publishTimeText', 'posted_at', 'postedAt', 'post_time', 'postTime',
  'created_at', 'createdAt', 'create_time', 'createTime', 'release_time', 'releaseTime',
];
const CONTENT_PUBLISHED_TIME_TEXT_PATHS = [
  'published_time_text', 'publishedTimeText', 'published_at_text', 'publishedAtText',
  'publish_time_text', 'publishTimeText', 'publish_time', 'publishTime',
  'published_at', 'publishedAt', 'posted_at', 'postedAt', 'post_time', 'postTime',
  'created_at', 'createdAt', 'create_time', 'createTime', 'release_time', 'releaseTime',
];
const PROFILE_TRANSPORT_ERROR_PATHS = [
  'title', 'page_title', 'document_title',
  'observed_name', 'author', 'body',
  'profile.nickname', 'profile.name', 'profile.bio', 'profile.body',
];

function text(value, maximum = 800) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function readPath(source, path) {
  let value = source;
  for (const key of path.split('.')) value = value?.[key];
  return value;
}

function firstText(source, paths, maximum = 800) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const found = text(value, maximum);
    if (found) return found;
  }
  return '';
}

function firstMetric(source, paths) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    const parsed = parseMetric(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstTextWithSource(source, paths, maximum = 800) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const found = text(value, maximum);
    if (found) return { value: found, sourcePath: itemPath };
  }
  return { value: '', sourcePath: null };
}

function firstMetricWithSource(source, paths) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    const value = parseMetric(candidate);
    if (Number.isFinite(value)) return { value, sourcePath: itemPath };
  }
  return { value: null, sourcePath: null };
}

function firstArrayWithSource(source, paths) {
  for (const itemPath of paths) {
    const value = readPath(source, itemPath);
    if (Array.isArray(value)) return { value, sourcePath: itemPath };
  }
  return { value: [], sourcePath: null };
}

function firstObjectWithSource(source, paths) {
  for (const itemPath of paths) {
    const value = readPath(source, itemPath);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { value, sourcePath: itemPath };
    }
  }
  return { value: {}, sourcePath: null };
}

function rawProfileRecord(records) {
  if (!Array.isArray(records)) return {};
  return records.find((record) => record && typeof record === 'object') || {};
}

export function profileCaptureTransportError(records) {
  for (const source of Array.isArray(records) ? records : []) {
    const record = source?.aweme_info || source?.aweme || source?.note || source;
    if (!record || typeof record !== 'object') continue;
    for (const sourcePath of PROFILE_TRANSPORT_ERROR_PATHS) {
      const value = readPath(record, sourcePath);
      if (!isTransportErrorPageContent(value)) continue;
      return {
        code: 'PROFILE_TRANSPORT_ERROR',
        message: 'The profile capture returned a transient platform gateway or server error.',
        action: 'Wait briefly, reopen the source profile in the signed-in browser, then resume the task.',
        retryable: true,
        evidence: { sourcePath, value: text(value, 160) },
      };
    }
  }
  return null;
}

function distinct(values, maximum = MAX_TOPIC_SIGNALS) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const item = text(value, 48).replace(/^[#|\-\s]+|[#|\-\s]+$/g, '');
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= maximum) break;
  }
  return output;
}

function sourcePathsWithTextValues(source, paths, maximum = MAX_TOPIC_SIGNALS, { delimited = false } = {}) {
  return paths.filter((itemPath) => {
    const value = readPath(source, itemPath);
    const values = delimited ? delimitedTextList(value, maximum) : textList(value, maximum);
    return values.length > 0;
  });
}

function hasObservedValue(value) {
  if (typeof value === 'boolean') return true;
  if (Number.isFinite(value)) return true;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function provenanceEntry({
  value,
  sourcePaths = [],
  basis = 'direct_public_field',
  derivation = null,
  sampleCount = null,
  missingStatus = 'not_provided',
}) {
  const observed = hasObservedValue(value);
  return {
    status: observed ? 'observed' : missingStatus,
    sourcePaths: distinct(sourcePaths.filter(Boolean), MAX_PROVENANCE_SOURCE_PATHS),
    basis,
    ...(derivation ? { derivation } : {}),
    ...(Number.isFinite(sampleCount) ? { sampleCount } : {}),
  };
}

function firstArray(source, paths) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function firstObject(source, paths) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function textList(value, maximum = MAX_TOPIC_SIGNALS) {
  const values = Array.isArray(value) ? value : [value];
  return distinct(values, maximum);
}

function firstTextList(source, paths, maximum = MAX_TOPIC_SIGNALS) {
  for (const itemPath of paths) {
    const values = textList(readPath(source, itemPath), maximum);
    if (values.length) return values;
  }
  return [];
}

function delimitedTextList(value, maximum = MAX_TOPIC_SIGNALS) {
  const values = Array.isArray(value) ? value : [value];
  return distinct(values.flatMap((entry) => text(entry, 240)
    .split(/[|,\uFF0C;\uFF1B\n]/)
    .map((item) => item.trim())), maximum);
}

function allTextLists(source, paths, maximum = MAX_TOPIC_SIGNALS, { delimited = false } = {}) {
  const values = [];
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    values.push(...(delimited ? delimitedTextList(candidate, maximum) : textList(candidate, maximum)));
  }
  return distinct(values, maximum);
}

function firstBoolean(source, paths) {
  for (const itemPath of paths) {
    const candidate = readPath(source, itemPath);
    if (typeof candidate === 'boolean') return candidate;
    const value = text(candidate, 32).toLowerCase();
    if (['true', '1', 'yes', '\u662f', '\u7f6e\u9876', 'pinned'].includes(value)) return true;
    if (['false', '0', 'no', '\u5426', '\u672a\u7f6e\u9876', 'not_pinned'].includes(value)) return false;
  }
  return null;
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function interactionMetrics(source) {
  const values = Object.fromEntries(Object.entries(INTERACTION_METRIC_PATHS)
    .map(([name, paths]) => [name, firstMetric(source, paths)]));
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value)));
}

function metricEntries(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return [entry];
    return text(entry, 160)
      .split(/[|,\uFF0C;\uFF1B\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  });
}

function visibleMetricObservation(entry) {
  const label = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? firstText(entry, ['label', 'name', 'metric_label', 'metricLabel', 'type', 'title'], 120)
    : text(entry, 160);
  const value = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? firstMetric(entry, ['value', 'count', 'metric_value', 'metricValue', 'total']) ?? parseMetric(label)
    : parseMetric(entry);
  if (!label || !Number.isFinite(value)) return null;
  const matchingNames = Object.entries(VISIBLE_METRIC_LABEL_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(label)))
    .map(([name]) => name);
  if (matchingNames.length !== 1) return null;
  return { name: matchingNames[0], value };
}

function observedInteractionMetrics(item) {
  const values = {};
  const sources = [
    ...CONTENT_INTERACTION_OBJECT_PATHS.map((path) => readPath(item, path)),
    item,
  ].filter((source) => source && typeof source === 'object' && !Array.isArray(source));
  for (const source of sources) {
    for (const [name, value] of Object.entries(interactionMetrics(source))) {
      if (!Number.isFinite(values[name])) values[name] = value;
    }
  }
  for (const path of VISIBLE_METRIC_PATHS) {
    for (const entry of metricEntries(readPath(item, path))) {
      const metric = visibleMetricObservation(entry);
      if (!metric || Number.isFinite(values[metric.name])) continue;
      values[metric.name] = metric.value;
    }
  }
  return values;
}

function observedInteractionAvailability(item) {
  const source = ['interaction_availability', 'interactionAvailability']
    .map((path) => readPath(item, path))
    .find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate));
  if (!source) return {};
  const availability = {};
  for (const name of INTERACTION_ACTION_NAMES) {
    const entry = source[name];
    const state = text(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.state : entry, 64);
    if (!['count_observed', 'action_visible_count_not_shown', 'not_visible'].includes(state)) continue;
    const detailSource = text(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.source : '', 64);
    availability[name] = {
      state,
      ...(detailSource ? { source: detailSource } : {}),
    };
  }
  return availability;
}

function sumInteractions(samples) {
  const totals = {};
  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample.interactions || {})) {
      if (!Number.isFinite(value)) continue;
      totals[key] = (totals[key] || 0) + value;
    }
  }
  return totals;
}

function durationSeconds(source) {
  const seconds = firstMetric(source, ['duration_seconds', 'durationSeconds', 'duration_s']);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const milliseconds = firstMetric(source, ['duration_ms', 'durationMs', 'duration_milliseconds']);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return round(milliseconds / 1000, 3);
  const raw = firstText(source, ['duration_text', 'durationText'], 32);
  const match = raw.match(/^(?:(\d{1,2}):)?([0-5]\d):([0-5]\d)$/);
  if (!match) return null;
  return (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function isoFromTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date.toISOString() : '';
}

function relativePublishedAtIso(value, capturedAt) {
  const anchor = Date.parse(capturedAt || '');
  if (!Number.isFinite(anchor)) return '';
  const raw = text(value, 80).toLowerCase();
  const relative = raw.match(/^(\d+(?:\.\d+)?)\s*(\u79d2|\u5206\u949f|\u5206|\u5c0f\u65f6|\u5929|\u5468|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?)\s*(?:\u524d|ago)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const milliseconds = (unit === '\u79d2' || /^sec/.test(unit)) ? 1000
      : (unit === '\u5206\u949f' || unit === '\u5206' || /^min/.test(unit)) ? 60 * 1000
        : (unit === '\u5c0f\u65f6' || /^hour/.test(unit)) ? 60 * 60 * 1000
          : (unit === '\u5929' || /^day/.test(unit)) ? DAY_MS
            : 7 * DAY_MS;
    return isoFromTimestamp(anchor - (amount * milliseconds));
  }
  const calendar = raw.match(/^(\u6628\u5929|\u524d\u5929|yesterday|the day before yesterday)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i);
  if (!calendar) return '';
  const days = /\u524d\u5929|day before/i.test(calendar[1]) ? 2 : 1;
  const date = new Date(anchor - (days * DAY_MS));
  if (calendar[2]) date.setUTCHours(Number(calendar[2]), Number(calendar[3]), Number(calendar[4] || 0), 0);
  return isoFromTimestamp(date.getTime());
}

function monthDayPublishedAtIso(value, capturedAt) {
  const anchor = Date.parse(capturedAt || '');
  if (!Number.isFinite(anchor)) return '';
  const match = text(value, 80).match(/^(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return '';
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hour = Number(match[3] || 0);
  const minute = Number(match[4] || 0);
  const second = Number(match[5] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return '';
  const date = new Date(anchor);
  date.setUTCFullYear(date.getUTCFullYear(), month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  if (date.getTime() > anchor + DAY_MS) date.setUTCFullYear(date.getUTCFullYear() - 1);
  return isoFromTimestamp(date.getTime());
}

function publishedAtIso(value, capturedAt = '') {
  if (value === null || value === undefined || value === '') return '';
  const raw = typeof value === 'number' ? value : text(value, 80);
  if (raw === '') return '';
  const monthDayIso = monthDayPublishedAtIso(raw, capturedAt);
  if (monthDayIso) return monthDayIso;
  const numeric = typeof raw === 'number' ? raw : /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const timestamp = Number.isFinite(numeric)
    ? numeric > 10_000_000_000 ? numeric : numeric * 1000
    : Date.parse(raw);
  return isoFromTimestamp(timestamp)
    || relativePublishedAtIso(raw, capturedAt);
}

function visibleContentSampleLimit(value) {
  if (value === null || value === undefined || value === '') return MAX_VISIBLE_CONTENT_SAMPLES;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return MAX_VISIBLE_CONTENT_SAMPLES;
  return Math.max(1, Math.min(Math.floor(requested), MAX_CONTENT_CAPTURE_SAMPLES));
}

function visibleContentSamples(value, channel, maximum = MAX_VISIBLE_CONTENT_SAMPLES, capturedAt = '') {
  if (!Array.isArray(value)) return [];
  const limit = visibleContentSampleLimit(maximum);
  const samples = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const sourceUrl = sourceUrlFor(channel, firstText(item, [
      'note_url', 'source_url', 'share_url', 'url', 'link',
    ]));
    const title = firstText(item, ['title', 'name', 'caption'], 180);
    const summary = firstText(item, ['body', 'summary', 'description', 'caption'], MAX_CONTENT_SUMMARY_LENGTH);
    // Preserve a bounded version of the already-visible body for semantic analysis;
    // the shorter summary continues to serve list and card presentation.
    const detailText = firstText(item, [
      'detail_text', 'detailText', 'body', 'description', 'caption', 'summary',
    ], MAX_CONTENT_DETAIL_LENGTH);
    const key = `${sourceUrl}|${title}|${summary.slice(0, 96)}`.toLowerCase();
    if (!key || key === '||' || seen.has(key)) continue;
    seen.add(key);
    const contentType = firstText(item, ['content_type', 'contentType', 'type'], 64);
    const contentFormat = firstText(item, ['content_format', 'contentFormat', 'format'], 64);
    const explicitHasVideo = firstBoolean(item, ['has_video', 'hasVideo']);
    const formatImpliesVideo = /(^|[_\s-])video($|[_\s-])/i.test(contentFormat)
      || /^video$/i.test(contentType);
    const formatImpliesNoVideo = /(image|photo|carousel|graphic)/i.test(contentFormat)
      || /^(image|photo|note)$/i.test(contentType);
    const publishedAt = firstText(item, CONTENT_PUBLISHED_AT_PATHS, 80);
    const publishedTimeText = firstText(item, CONTENT_PUBLISHED_TIME_TEXT_PATHS, 80);
    const sample = {
      sourceUrl,
      title,
      summary,
      detailText,
      coverUrl: safeRemoteUrl(firstText(item, ['cover_url', 'coverUrl', 'image_url', 'thumbnail_url'], 1200)),
      contentType,
      contentFormat,
      imageCount: firstMetric(item, ['content_image_count', 'contentImageCount', 'image_count', 'imageCount']),
      hasVideo: explicitHasVideo === null
        ? formatImpliesVideo ? true : formatImpliesNoVideo ? false : null
        : explicitHasVideo,
      hashtags: distinct([
        ...delimitedTextList(item.hashtags, MAX_TOPIC_SIGNALS),
        ...delimitedTextList(item.tags, MAX_TOPIC_SIGNALS),
      ]),
      publishedAt,
      publishedTimeText,
      publishedAtIso: publishedAtIso(publishedAt, capturedAt),
      durationSeconds: durationSeconds(item),
      isPinned: firstBoolean(item, ['is_pinned', 'isPinned', 'pinned']),
      commercialMarkers: allTextLists(item, [
        'commercial_markers', 'commercialMarkers', 'commercial_disclosures', 'commercialDisclosures',
      ], MAX_COMMERCIAL_MARKERS, { delimited: true }),
      brandMentions: allTextLists(item, [
        'brand_mentions', 'brandMentions', 'brands',
      ], MAX_BRAND_MENTIONS, { delimited: true }),
      publicRiskFlags: allTextLists(item, [
        'risk_flags', 'riskFlags', 'compliance_flags', 'complianceFlags',
      ], MAX_RISK_FLAGS, { delimited: true }),
      interactions: observedInteractionMetrics(item),
      interactionAvailability: observedInteractionAvailability(item),
    };
    if (!sample.sourceUrl && !sample.title && !sample.summary) continue;
    samples.push(sample);
    if (samples.length >= limit) break;
  }
  return samples;
}

function labelCounts(values, maximum = MAX_VERTICAL_LABELS) {
  const counts = new Map();
  for (const value of values) {
    const label = text(value, 96).replace(/^[#|\-\s]+|[#|\-\s]+$/g, '');
    if (!label) continue;
    const key = label.toLowerCase();
    const current = counts.get(key) || { label, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, maximum);
}

function profileTags(profile) {
  return allTextLists(profile, [
    'profile_tags', 'profile.profile_tags',
  ], MAX_PROFILE_TAGS, { delimited: true });
}

function deriveContentVerticals({ creator, profile, samples, contentSummary = {} }) {
  const publicProfileTags = profileTags(profile);
  const summaryHashtags = allTextLists(contentSummary, [
    'sample_hashtags', 'hashtags', 'sampleHashtags',
  ], MAX_VERTICAL_LABELS, { delimited: true });
  const hashtagCounts = labelCounts([
    ...samples.flatMap((sample) => sample.hashtags || []),
    ...summaryHashtags,
  ]);
  const sampleHashtags = hashtagCounts.map((entry) => entry.label);
  const discoveryContext = distinct([creator.niche, creator.angle], MAX_TOPIC_SIGNALS);
  const labels = distinct([
    ...publicProfileTags,
    ...sampleHashtags,
    ...discoveryContext,
  ], MAX_VERTICAL_LABELS);
  const basis = [
    publicProfileTags.length ? 'public_profile_tags' : '',
    sampleHashtags.length ? 'visible_content_hashtags' : '',
    discoveryContext.length ? 'saved_discovery_context' : '',
  ].filter(Boolean);
  return {
    labels,
    publicProfileTags,
    sampleHashtags: hashtagCounts.map((entry) => ({
      label: entry.label,
      sampleCount: entry.count,
    })),
    discoveryContext,
    basis,
  };
}

function deriveContentMix(samples) {
  const typeCounts = labelCounts(samples.map((sample) => sample.contentType));
  const typedSampleCount = typeCounts.reduce((total, entry) => total + entry.count, 0);
  const formatCounts = labelCounts(samples.map((sample) => sample.contentFormat));
  const formattedSampleCount = formatCounts.reduce((total, entry) => total + entry.count, 0);
  const durationValues = samples.map((sample) => sample.durationSeconds).filter(Number.isFinite);
  const pinnedObservedSampleCount = samples.filter((sample) => sample.isPinned !== null).length;
  const pinnedSampleCount = samples.filter((sample) => sample.isPinned === true).length;
  const videoObservedSampleCount = samples.filter((sample) => sample.hasVideo !== null).length;
  const videoSampleCount = samples.filter((sample) => sample.hasVideo === true).length;
  const imageCountValues = samples.map((sample) => sample.imageCount).filter(Number.isFinite);
  const imageBearingSampleCount = samples.filter((sample) => Number.isFinite(sample.imageCount) && sample.imageCount > 0).length;
  return {
    basis: 'visible_public_content_samples',
    sampleCount: samples.length,
    typedSampleCount,
    byType: typeCounts.map((entry) => ({
      type: entry.label,
      sampleCount: entry.count,
      percent: typedSampleCount ? round((entry.count / typedSampleCount) * 100) : null,
    })),
    formattedSampleCount,
    byFormat: formatCounts.map((entry) => ({
      format: entry.label,
      sampleCount: entry.count,
      percent: formattedSampleCount ? round((entry.count / formattedSampleCount) * 100) : null,
    })),
    duration: {
      observedSampleCount: durationValues.length,
      totalSeconds: durationValues.length ? round(durationValues.reduce((total, value) => total + value, 0), 3) : null,
      averageSeconds: durationValues.length ? round(durationValues.reduce((total, value) => total + value, 0) / durationValues.length, 3) : null,
      medianSeconds: durationValues.length ? round(median(durationValues), 3) : null,
    },
    pinned: {
      observedSampleCount: pinnedObservedSampleCount,
      pinnedSampleCount,
    },
    media: {
      videoObservedSampleCount,
      videoSampleCount,
      videoSampleShare: percentage(videoSampleCount, videoObservedSampleCount),
      imageCountObservedSampleCount: imageCountValues.length,
      imageBearingSampleCount,
      imageBearingSampleShare: percentage(imageBearingSampleCount, imageCountValues.length),
      totalObservedImages: imageCountValues.length ? imageCountValues.reduce((total, value) => total + value, 0) : null,
      averageObservedImagesPerSample: imageCountValues.length
        ? round(imageCountValues.reduce((total, value) => total + value, 0) / imageCountValues.length, 4)
        : null,
    },
  };
}

function derivePostingCadence(samples) {
  const timestamps = [...new Set(samples
    .map((sample) => sample.publishedAtIso)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite))].sort((left, right) => right - left);
  const newestTimestamp = timestamps[0] ?? null;
  const oldestTimestamp = timestamps.at(-1) ?? null;
  const observationWindowDays = Number.isFinite(newestTimestamp) && Number.isFinite(oldestTimestamp)
    ? round((newestTimestamp - oldestTimestamp) / DAY_MS, 3)
    : null;
  const intervals = timestamps.slice(0, -1)
    .map((timestamp, index) => (timestamp - timestamps[index + 1]) / DAY_MS)
    .filter((value) => Number.isFinite(value) && value > 0);
  const intervalSummary = numericSummary(intervals);
  const observed = timestamps.length >= 2 && Number.isFinite(observationWindowDays) && observationWindowDays > 0;
  return {
    basis: 'visible_public_content_timestamps',
    status: observed ? 'observed' : 'insufficient_observed_timestamps',
    sampleCount: samples.length,
    timestampedSampleCount: samples.filter((sample) => sample.publishedAtIso).length,
    uniqueTimestampCount: timestamps.length,
    newestPublishedAt: Number.isFinite(newestTimestamp) ? new Date(newestTimestamp).toISOString() : null,
    oldestPublishedAt: Number.isFinite(oldestTimestamp) ? new Date(oldestTimestamp).toISOString() : null,
    observationWindowDays,
    intervalCount: intervals.length,
    medianIntervalDays: intervalSummary.median,
    averageIntervalDays: intervalSummary.average,
    minimumIntervalDays: intervalSummary.minimum,
    maximumIntervalDays: intervalSummary.maximum,
    intervalStandardDeviationDays: intervalSummary.standardDeviation,
    intervalCoefficientOfVariation: intervalSummary.coefficientOfVariation,
    estimatedPostsPer30Days: observed && observationWindowDays >= 7
      ? round(((timestamps.length - 1) / observationWindowDays) * 30, 2)
      : null,
  };
}

function interactionCoverage(samples, contentSummary = {}) {
  const rawCoverage = firstObject(contentSummary, [
    'sample_interaction_coverage', 'interaction_coverage', 'sampleInteractionCoverage',
  ]);
  return Object.fromEntries(INTERACTION_METRIC_NAMES.map((name) => {
    const explicit = firstMetric(rawCoverage, [name]);
    const computed = samples.filter((sample) => Number.isFinite(sample.interactions?.[name])).length;
    return [name, Number.isFinite(explicit) && explicit >= 0 ? explicit : computed];
  }));
}

function ratioPerHundred(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return round((numerator / denominator) * 100, 4);
}

function percentage(numerator, denominator, places = 4) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return round((numerator / denominator) * 100, places);
}

function numericSummary(values) {
  const observed = values.filter(Number.isFinite);
  if (!observed.length) {
    return {
      observedCount: 0,
      total: null,
      average: null,
      median: null,
      minimum: null,
      maximum: null,
      standardDeviation: null,
      coefficientOfVariation: null,
    };
  }
  const total = observed.reduce((sum, value) => sum + value, 0);
  const average = total / observed.length;
  const variance = observed.reduce((sum, value) => sum + ((value - average) ** 2), 0) / observed.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    observedCount: observed.length,
    total: round(total, 4),
    average: round(average, 4),
    median: round(median(observed), 4),
    minimum: round(Math.min(...observed), 4),
    maximum: round(Math.max(...observed), 4),
    standardDeviation: round(standardDeviation, 4),
    coefficientOfVariation: average > 0 ? round(standardDeviation / average, 6) : null,
  };
}

function observedSampleInteractionTotals(samples, metricNames = INTERACTION_ACTION_NAMES) {
  return samples.map((sample) => {
    const values = metricNames
      .map((name) => sample.interactions?.[name])
      .filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  }).filter(Number.isFinite);
}

function deriveContentStrategy({ samples, verticals, contentMix, postingCadence, capturedAt }) {
  const hashtagCounts = labelCounts(samples.flatMap((sample) => sample.hashtags || []));
  const hashtagOccurrences = hashtagCounts.reduce((total, entry) => total + entry.count, 0);
  const directFormatCounts = labelCounts(samples.map((sample) => sample.contentFormat));
  const formatCounts = directFormatCounts.length
    ? directFormatCounts
    : labelCounts(samples.map((sample) => sample.contentType));
  const typedSampleCount = formatCounts.reduce((total, entry) => total + entry.count, 0);
  const titleObservedSampleCount = samples.filter((sample) => sample.title).length;
  const summaryObservedSampleCount = samples.filter((sample) => sample.summary).length;
  const sourceUrlObservedSampleCount = samples.filter((sample) => sample.sourceUrl).length;
  const capturedTimestamp = Date.parse(capturedAt);
  const newestTimestamp = Date.parse(postingCadence.newestPublishedAt || '');
  const newestContentAgeDays = Number.isFinite(capturedTimestamp) && Number.isFinite(newestTimestamp)
    && capturedTimestamp >= newestTimestamp
    ? round((capturedTimestamp - newestTimestamp) / DAY_MS, 3)
    : null;
  const topHashtag = hashtagCounts[0] || null;
  const topFormat = formatCounts[0] || null;
  return {
    basis: 'visible_public_content_samples_and_saved_discovery_context',
    sampleCount: samples.length,
    topics: {
      labels: verticals.labels,
      publicProfileTags: verticals.publicProfileTags,
      visibleHashtagCount: hashtagOccurrences,
      uniqueVisibleHashtagCount: hashtagCounts.length,
      dominantVisibleHashtag: topHashtag?.label || null,
      dominantVisibleHashtagShare: topHashtag ? percentage(topHashtag.count, samples.length) : null,
      hashtagSampleCounts: hashtagCounts.map((entry) => ({
        label: entry.label,
        sampleCount: entry.count,
        sampleShare: percentage(entry.count, samples.length),
      })),
      discoveryContext: verticals.discoveryContext,
    },
    formats: {
      basis: directFormatCounts.length ? 'visible_public_content_format_fields' : 'visible_public_content_type_fields',
      typedSampleCount,
      uniqueFormatCount: formatCounts.length,
      dominantFormat: topFormat?.label || null,
      dominantFormatShare: topFormat ? percentage(topFormat.count, typedSampleCount) : null,
      distribution: directFormatCounts.length ? contentMix.byFormat : contentMix.byType,
      duration: contentMix.duration,
      pinned: {
        ...contentMix.pinned,
        pinnedShare: percentage(contentMix.pinned.pinnedSampleCount, contentMix.pinned.observedSampleCount),
      },
      media: contentMix.media,
    },
    presentationCoverage: {
      titleObservedSampleCount,
      titleObservedSampleShare: percentage(titleObservedSampleCount, samples.length),
      summaryObservedSampleCount,
      summaryObservedSampleShare: percentage(summaryObservedSampleCount, samples.length),
      sourceUrlObservedSampleCount,
      sourceUrlObservedSampleShare: percentage(sourceUrlObservedSampleCount, samples.length),
    },
    publishing: {
      ...postingCadence,
      newestContentAgeDays,
    },
  };
}

function deriveContentCaptureCoverage({
  visibleSamples,
  reportedVisibleSampleCount,
  workCount,
  contentSummary,
  collectionMeta,
}) {
  const retainedSampleCount = visibleSamples.length;
  const reportedCount = Number.isFinite(reportedVisibleSampleCount) && reportedVisibleSampleCount >= 0
    ? reportedVisibleSampleCount
    : retainedSampleCount;
  const profileWorkCount = Number.isFinite(workCount) && workCount >= 0 ? workCount : null;
  const collectorSampleLimit = firstMetric(collectionMeta || {}, [
    'content_sample_limit', 'contentSampleLimit', 'profile_sample_limit', 'profileSampleLimit',
  ]);
  const stopReason = firstText(collectionMeta || {}, [
    'stop_reason', 'stopReason', 'outcome.stop_reason', 'outcome.stopReason',
  ], 100) || null;
  const sourceMode = firstText(collectionMeta || {}, ['mode', 'collection_mode', 'collectionMode'], 80) || null;
  const publicDataScope = firstText(collectionMeta || {}, [
    'public_data_scope', 'publicDataScope', 'data_scope', 'dataScope', 'scope',
  ], 100) || null;
  const sampleObservationCoverage = firstObject(contentSummary, [
    'sample_observation_coverage', 'sampleObservationCoverage',
  ]);
  const retentionStatus = reportedCount > retainedSampleCount
    ? 'retained_subset_of_reported_visible_samples'
    : reportedCount
      ? 'retained_reported_visible_samples'
      : 'no_visible_samples_retained';
  const collectionStatus = !reportedCount
    ? 'no_visible_samples_reported'
    : profileWorkCount === null
      ? 'visible_samples_captured_total_public_work_count_not_provided'
      : reportedCount >= profileWorkCount
        ? 'reported_visible_samples_match_or_exceed_current_public_work_count'
        : 'partial_against_current_public_work_count';
  return {
    basis: 'collector_reported_visible_content_and_current_public_work_count',
    collectionStatus,
    retentionStatus,
    reportedVisibleSampleCount: reportedCount,
    retainedSampleCount,
    retainedShareOfReportedVisibleSamples: percentage(retainedSampleCount, reportedCount),
    currentPublicWorkCount: profileWorkCount,
    reportedVisibleShareOfCurrentPublicWorks: percentage(reportedCount, profileWorkCount),
    collectorSampleLimit: Number.isFinite(collectorSampleLimit) ? collectorSampleLimit : null,
    stopReason,
    sourceMode,
    publicDataScope,
    fieldCoverage: sampleObservationCoverage,
    limitations: [
      profileWorkCount === null ? 'current_public_work_count_not_provided' : '',
      reportedCount > retainedSampleCount ? 'persona_retains_a_bounded_subset_of_reported_visible_samples' : '',
      !reportedCount ? 'no_visible_content_cards_returned_by_collector' : '',
    ].filter(Boolean),
  };
}

function deriveEngagement({ samples, contentSummary, totals, followerCount }) {
  const coverage = interactionCoverage(samples, contentSummary);
  const actionTotals = Object.fromEntries(INTERACTION_ACTION_NAMES.map((name) => [
    name,
    Number.isFinite(totals[name]) ? totals[name] : null,
  ]));
  const total = Object.values(actionTotals).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const hasTotals = Object.values(actionTotals).some(Number.isFinite);
  const sampleWithAnyInteraction = samples.filter((sample) => INTERACTION_ACTION_NAMES
    .some((name) => Number.isFinite(sample.interactions?.[name]))).length;
  const observedPerSampleSummary = numericSummary(observedSampleInteractionTotals(samples));
  const averages = Object.fromEntries(Object.entries(totals).map(([name, value]) => [
    name,
    Number.isFinite(value) && coverage[name] > 0 ? round(value / coverage[name], 4) : null,
  ]));
  const averageActionRatePerFollower = Object.fromEntries(INTERACTION_ACTION_NAMES.map((name) => [
    name,
    percentage(averages[name], followerCount, 6),
  ]));
  const averageTotalInteractions = hasTotals && sampleWithAnyInteraction > 0
    ? round(total / sampleWithAnyInteraction, 4)
    : null;
  const audienceEngagementRate = Number.isFinite(followerCount) && followerCount > 0 && Number.isFinite(averageTotalInteractions)
    ? round((averageTotalInteractions / followerCount) * 100, 6)
    : null;
  return {
    basis: 'visible_public_content_samples',
    sampleCount: samples.length,
    interactionObservedSampleCount: sampleWithAnyInteraction,
    interactionCoverage: coverage,
    totals,
    averages,
    totalObservedInteractionActions: hasTotals ? total : null,
    averageObservedInteractionActions: averageTotalInteractions,
    audienceEngagementRate,
    audienceEngagementRateBasis: audienceEngagementRate === null
      ? null
      : 'average_observed_public_interaction_actions_per_sample / current_public_follower_count',
    averageActionRatePerFollower,
    observedPerSampleInteractionActions: {
      ...observedPerSampleSummary,
      highestSampleShare: percentage(observedPerSampleSummary.maximum, observedPerSampleSummary.total),
      basis: 'sum_of_available_public_interaction_actions_per_visible_sample',
    },
    interactionMixPer100Likes: {
      comments: ratioPerHundred(totals.comments, totals.likes),
      collects: ratioPerHundred(totals.collects, totals.likes),
      shares: ratioPerHundred(totals.shares, totals.likes),
    },
    viewPerformance: {
      basis: 'visible_public_play_metrics_and_available_public_actions',
      playObservedSampleCount: coverage.plays,
      totalObservedPlays: Number.isFinite(totals.plays) ? totals.plays : null,
      averageObservedPlays: averages.plays ?? null,
      actionRatePer100Plays: Object.fromEntries(INTERACTION_ACTION_NAMES.map((name) => [
        name,
        ratioPerHundred(totals[name], totals.plays),
      ])),
      status: Number.isFinite(totals.plays) && totals.plays > 0
        ? 'observed'
        : coverage.plays > 0
          ? 'play_metric_without_usable_total'
          : 'not_observed_in_visible_samples',
    },
  };
}

function deriveCommercialSignals(profile, samples, contentSummary) {
  const profileSignals = allTextLists(profile, [
    'commercial_signals', 'public_commercial_signals', 'profile.commercial_signals', 'profile.public_commercial_signals',
  ], MAX_COMMERCIAL_MARKERS, { delimited: true });
  const summaryMarkers = allTextLists(contentSummary, [
    'sample_commercial_markers', 'commercial_markers', 'sampleCommercialMarkers',
  ], MAX_COMMERCIAL_MARKERS, { delimited: true });
  const sampleMarkers = distinct(samples.flatMap((sample) => sample.commercialMarkers || []), MAX_COMMERCIAL_MARKERS);
  const disclosureMarkers = distinct([...profileSignals, ...summaryMarkers, ...sampleMarkers], MAX_COMMERCIAL_MARKERS);
  const markerObservedSampleCount = samples.filter((sample) => (sample.commercialMarkers || []).length > 0).length;
  const markerOccurrenceCount = samples.reduce((total, sample) => total + (sample.commercialMarkers || []).length, 0);
  const explicitDisclosureSampleCount = firstMetric(contentSummary, [
    'sample_commercial_disclosure_count', 'commercial_disclosure_count', 'sampleCommercialDisclosureCount',
  ]);
  const detectedSampleCount = Number.isFinite(explicitDisclosureSampleCount) && explicitDisclosureSampleCount >= 0
    ? explicitDisclosureSampleCount
    : markerObservedSampleCount;
  const profileBrands = allTextLists(profile, [
    'brand_mentions', 'brands', 'profile.brand_mentions', 'profile.brands',
  ], MAX_BRAND_MENTIONS, { delimited: true });
  const summaryBrands = allTextLists(contentSummary, [
    'sample_brand_mentions', 'brand_mentions', 'sampleBrandMentions',
  ], MAX_BRAND_MENTIONS, { delimited: true });
  const sampleBrands = distinct(samples.flatMap((sample) => sample.brandMentions || []), MAX_BRAND_MENTIONS);
  const brands = distinct([...profileBrands, ...summaryBrands, ...sampleBrands], MAX_BRAND_MENTIONS);
  const brandMentionObservedSampleCount = samples.filter((sample) => (sample.brandMentions || []).length > 0).length;
  const brandMentionOccurrenceCount = samples.reduce((total, sample) => total + (sample.brandMentions || []).length, 0);
  return {
    basis: 'explicit_public_profile_labels_and_visible_content_markers',
    publicSignals: profileSignals,
    explicitDisclosure: {
      labels: disclosureMarkers,
      sampleCount: samples.length,
      detectedSampleCount,
      status: detectedSampleCount > 0 || disclosureMarkers.length > 0
        ? 'observed'
        : samples.length
          ? 'not_observed_in_visible_sample'
          : 'no_visible_sample',
    },
    brandMentions: {
      labels: brands,
      source: brands.length ? 'explicit_public_fields_only' : 'not_observed',
    },
    coverage: {
      visibleSampleCount: samples.length,
      markerObservedSampleCount,
      markerObservedSampleShare: percentage(markerObservedSampleCount, samples.length),
      markerOccurrenceCount,
      summaryDisclosureSampleCount: Number.isFinite(explicitDisclosureSampleCount)
        ? explicitDisclosureSampleCount
        : null,
      disclosureSampleShare: detectedSampleCount <= samples.length
        ? percentage(detectedSampleCount, samples.length)
        : null,
      brandMentionObservedSampleCount,
      brandMentionObservedSampleShare: percentage(brandMentionObservedSampleCount, samples.length),
      brandMentionOccurrenceCount,
      uniqueObservedBrandCount: brands.length,
      uniqueDisclosureLabelCount: disclosureMarkers.length,
    },
  };
}

function deriveRiskSignals(profile, samples, contentSummary) {
  const profileFlags = allTextLists(profile, [
    'risk_flags', 'compliance_flags', 'restriction_labels',
    'profile.risk_flags', 'profile.compliance_flags', 'profile.restriction_labels',
  ], MAX_RISK_FLAGS, { delimited: true });
  const summaryFlags = allTextLists(contentSummary, [
    'sample_risk_flags', 'risk_flags', 'compliance_flags', 'sampleRiskFlags',
  ], MAX_RISK_FLAGS, { delimited: true });
  const sampleFlags = distinct(samples.flatMap((sample) => sample.publicRiskFlags || []), MAX_RISK_FLAGS);
  const publicFlags = distinct([...profileFlags, ...summaryFlags, ...sampleFlags], MAX_RISK_FLAGS);
  const flaggedVisibleSampleCount = samples.filter((sample) => (sample.publicRiskFlags || []).length > 0).length;
  return {
    basis: 'explicit_public_profile_or_content_labels_only',
    status: publicFlags.length ? 'explicit_public_signal_observed' : 'no_explicit_public_signal_observed',
    publicFlags,
    visibleSampleCount: samples.length,
    sourceBreakdown: {
      publicProfileLabels: profileFlags,
      contentSummaryLabels: summaryFlags,
      visibleContentLabels: sampleFlags,
      flaggedVisibleSampleCount,
      flaggedVisibleSampleShare: percentage(flaggedVisibleSampleCount, samples.length),
    },
    unassessedDimensions: [
      'platform_enforcement_history',
      'private_or_removed_content',
      'contractual_or_off_platform_compliance',
    ],
    assessment: null,
  };
}

function metricChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const change = current - previous;
  return {
    current,
    previous,
    change,
    changePercent: previous > 0 ? round((change / previous) * 100, 6) : null,
  };
}

function deriveGrowth({
  followerCount,
  totalLikes,
  workCount,
  averageObservedInteractionActions,
  historicalPersona,
  capturedAt,
  identityKey,
}) {
  const currentSnapshot = {
    capturedAt,
    followerCount: Number.isFinite(followerCount) ? followerCount : null,
    totalLikes: Number.isFinite(totalLikes) ? totalLikes : null,
    workCount: Number.isFinite(workCount) ? workCount : null,
    averageObservedInteractionActions: Number.isFinite(averageObservedInteractionActions)
      ? averageObservedInteractionActions
      : null,
  };
  const historicalIdentity = text(historicalPersona?.identityKey, 220);
  const historicalCapturedAt = text(historicalPersona?.capturedAt, 80);
  const priorTimestamp = Date.parse(historicalCapturedAt);
  const currentTimestamp = Date.parse(capturedAt);
  if (!historicalPersona || !historicalCapturedAt || (historicalIdentity && historicalIdentity !== identityKey)
    || !Number.isFinite(priorTimestamp) || !Number.isFinite(currentTimestamp) || currentTimestamp <= priorTimestamp) {
    return {
      basis: 'two_public_profile_snapshots_for_the_same_creator',
      status: 'insufficient_history',
      observationWindowDays: null,
      previousSnapshot: null,
      currentSnapshot,
      metrics: {},
      velocity: {
        basis: 'net_observed_metric_change_divided_by_snapshot_interval_days',
        status: 'not_computable',
        perDay: {},
      },
    };
  }
  const previousSnapshot = {
    capturedAt: historicalCapturedAt,
    followerCount: Number.isFinite(historicalPersona?.profile?.followerCount) ? historicalPersona.profile.followerCount : null,
    totalLikes: Number.isFinite(historicalPersona?.profile?.totalLikes) ? historicalPersona.profile.totalLikes : null,
    workCount: Number.isFinite(historicalPersona?.profile?.workCount) ? historicalPersona.profile.workCount : null,
    averageObservedInteractionActions: Number.isFinite(historicalPersona?.performance?.engagement?.averageObservedInteractionActions)
      ? historicalPersona.performance.engagement.averageObservedInteractionActions
      : null,
  };
  const metrics = Object.fromEntries([
    ['followers', metricChange(currentSnapshot.followerCount, previousSnapshot.followerCount)],
    ['totalLikes', metricChange(currentSnapshot.totalLikes, previousSnapshot.totalLikes)],
    ['works', metricChange(currentSnapshot.workCount, previousSnapshot.workCount)],
    ['averageObservedInteractionActions', metricChange(
      currentSnapshot.averageObservedInteractionActions,
      previousSnapshot.averageObservedInteractionActions,
    )],
  ].filter(([, value]) => value));
  const observationWindowDays = round((currentTimestamp - priorTimestamp) / DAY_MS, 3);
  const perDay = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [
    name,
    Number.isFinite(observationWindowDays) && observationWindowDays > 0
      ? round(metric.change / observationWindowDays, 6)
      : null,
  ]));
  return {
    basis: 'two_public_profile_snapshots_for_the_same_creator',
    status: Object.keys(metrics).length ? 'observed' : 'incomparable_public_metrics',
    observationWindowDays,
    previousSnapshot,
    currentSnapshot,
    metrics,
    velocity: {
      basis: 'net_observed_metric_change_divided_by_snapshot_interval_days',
      status: Object.keys(perDay).length ? 'observed' : 'not_computable',
      perDay,
    },
  };
}

function topicSignals({ creator, profile }) {
  const rawTags = firstText(profile, ['tags', 'card_tags', 'profile.tags'], 280);
  const title = firstText(profile, ['title', 'profile.title'], 180);
  const body = firstText(profile, ['body', 'description', 'bio', 'profile.bio'], MAX_TEXT_SAMPLE);
  const tags = rawTags.split(/[|,\uFF0C\n]/).flatMap((value) => value.split(/\s+/));
  const hashTags = body.match(/#[^#\s]{2,30}/g) || [];
  return distinct([
    ...tags,
    ...hashTags,
    creator?.niche,
    creator?.angle,
    title,
  ]);
}

function profileTier(followers) {
  if (!Number.isFinite(followers)) return { id: null, label: '\u672a\u77e5\u91cf\u7ea7' };
  if (followers >= 1_000_000) return { id: 'mega', label: '\u5934\u90e8' };
  if (followers >= 100_000) return { id: 'macro', label: '\u8170\u90e8' };
  if (followers >= 10_000) return { id: 'mid', label: '\u6210\u957f\u578b' };
  return { id: 'micro', label: '\u57fa\u7840\u578b' };
}

function evidenceQuality({
  followerCount,
  followingCount,
  totalLikes,
  workCount,
  bio,
  location,
  verified,
  topics,
  profileTagCount = 0,
  contentSample,
  profileName,
  visibleMetricCount = 0,
  visibleSampleCount = 0,
  audienceSignalCount = 0,
  interactionObservedSampleCount = 0,
  timestampedSampleCount = 0,
  commercialSignalCount = 0,
}) {
  const profileFields = [
    profileName ? 'displayName' : '',
    Number.isFinite(followerCount) ? 'followers' : '',
    Number.isFinite(followingCount) ? 'following' : '',
    Number.isFinite(totalLikes) ? 'totalLikes' : '',
    Number.isFinite(workCount) ? 'workCount' : '',
    bio ? 'bio' : '',
    location ? 'location' : '',
    verified === true ? 'verified' : '',
    profileTagCount > 0 ? 'publicProfileTags' : '',
    visibleMetricCount > 0 ? 'visibleMetrics' : '',
  ].filter(Boolean);
  const contentFields = [
    topics.length ? 'topicSignals' : '',
    contentSample ? 'profileText' : '',
    visibleSampleCount > 0 ? 'visibleContent' : '',
    audienceSignalCount > 0 ? 'publicAudienceSignals' : '',
    interactionObservedSampleCount > 0 ? 'contentInteractions' : '',
    timestampedSampleCount > 0 ? 'contentTimestamps' : '',
    commercialSignalCount > 0 ? 'publicCommercialSignals' : '',
  ].filter(Boolean);
  const observedFields = [...profileFields, ...contentFields];
  const possibleFields = 17;
  const score = Math.round((observedFields.length / possibleFields) * 100);
  return {
    observedFields,
    completeness: score,
    confidence: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low',
    basis: 'observed_public_profile_and_visible_content_field_coverage',
    coverage: {
      profileObservedFieldCount: profileFields.length,
      contentObservedFieldCount: contentFields.length,
      observedFieldCount: observedFields.length,
      possibleFieldCount: possibleFields,
    },
  };
}

function deriveAccountDimension({
  displayName,
  handle,
  sourceUrl,
  identityKey,
  bio,
  location,
  avatar,
  verified,
  verifiedLabel,
  accountType,
  followerCount,
  followingCount,
  totalLikes,
  workCount,
  publicProfileTags,
  tier,
  accountCreatedAt,
  capturedAt,
}) {
  const createdTimestamp = Date.parse(accountCreatedAt || '');
  const capturedTimestamp = Date.parse(capturedAt || '');
  const accountAgeDays = Number.isFinite(createdTimestamp) && Number.isFinite(capturedTimestamp)
    && capturedTimestamp >= createdTimestamp
    ? round((capturedTimestamp - createdTimestamp) / DAY_MS, 3)
    : null;
  const fieldAvailability = {
    displayName: Boolean(displayName),
    handle: Boolean(handle),
    bio: Boolean(bio),
    location: Boolean(location),
    avatar: Boolean(avatar),
    verification: verified !== null || Boolean(verifiedLabel),
    accountType: Boolean(accountType),
    followers: Number.isFinite(followerCount),
    following: Number.isFinite(followingCount),
    totalLikes: Number.isFinite(totalLikes),
    works: Number.isFinite(workCount),
    profileTags: publicProfileTags.length > 0,
    accountCreatedAt: Boolean(accountCreatedAt),
  };
  const observedFieldNames = Object.entries(fieldAvailability)
    .filter(([, observed]) => observed)
    .map(([name]) => name);
  const missingFieldNames = Object.entries(fieldAvailability)
    .filter(([, observed]) => !observed)
    .map(([name]) => name);
  return {
    basis: 'observed_public_profile_fields_and_saved_discovery_identity',
    identity: {
      displayName,
      handle,
      sourceUrl,
      identityKey,
    },
    credentials: {
      verified,
      verifiedLabel,
      accountType,
    },
    publicProfile: {
      bio,
      location,
      hasAvatar: Boolean(avatar),
      publicProfileTags,
      publicProfileTagCount: publicProfileTags.length,
    },
    scale: {
      followerCount,
      followingCount,
      totalLikes,
      workCount,
      creatorTier: tier.id,
      creatorTierLabel: tier.label,
    },
    ratios: {
      followingToFollowerRatio: Number.isFinite(followingCount) && Number.isFinite(followerCount) && followerCount > 0
        ? round(followingCount / followerCount, 6)
        : null,
      likesPerFollower: Number.isFinite(totalLikes) && Number.isFinite(followerCount) && followerCount > 0
        ? round(totalLikes / followerCount, 6)
        : null,
      worksPerFollower: Number.isFinite(workCount) && Number.isFinite(followerCount) && followerCount > 0
        ? round(workCount / followerCount, 8)
        : null,
      followersPerWork: Number.isFinite(followerCount) && Number.isFinite(workCount) && workCount > 0
        ? round(followerCount / workCount, 4)
        : null,
      likesPerWork: Number.isFinite(totalLikes) && Number.isFinite(workCount) && workCount > 0
        ? round(totalLikes / workCount, 4)
        : null,
    },
    lifecycle: {
      accountCreatedAt: accountCreatedAt || null,
      accountAgeDays,
    },
    coverage: {
      basis: 'observed_public_profile_fields_and_saved_discovery_identity',
      status: observedFieldNames.length === Object.keys(fieldAvailability).length
        ? 'observed'
        : observedFieldNames.length
          ? 'partial'
          : 'not_observed',
      observedFieldCount: observedFieldNames.length,
      possibleFieldCount: Object.keys(fieldAvailability).length,
      coverageRate: round(observedFieldNames.length / Object.keys(fieldAvailability).length, 4),
      observedFields: observedFieldNames,
      missingFields: missingFieldNames,
    },
  };
}

function deriveAudienceDimension({ publicAudienceSignals, followerCount, collectionMeta }) {
  const publicSignalStatus = publicAudienceSignals.length ? 'observed' : 'not_provided';
  const publicProfileScope = text(
    collectionMeta?.public_data_scope || collectionMeta?.publicDataScope || collectionMeta?.dataScope || collectionMeta?.scope,
    100,
  ) || 'public_profile_observation';
  const visibleProfileSignalStatus = publicAudienceSignals.length
    ? 'observed'
    : 'not_visible_on_captured_public_profile';
  return {
    dataScope: 'public_profile_signals',
    publicSignals: publicAudienceSignals,
    publicSignalCount: publicAudienceSignals.length,
    scale: {
      currentPublicFollowerCount: Number.isFinite(followerCount) ? followerCount : null,
      status: Number.isFinite(followerCount) ? 'observed' : 'not_provided',
      basis: 'current_public_profile_follower_count',
    },
    availability: {
      publicProfileSignals: publicSignalStatus,
      demographicAggregate: 'not_provided',
      geographicAggregate: 'not_provided',
      interestAggregate: 'not_provided',
      activeTimeAggregate: 'not_provided',
    },
    coverage: {
      publicProfileSignals: {
        status: visibleProfileSignalStatus,
        observedSignalCount: publicAudienceSignals.length,
        sourceScope: publicProfileScope,
        basis: 'explicit_public_profile_labels_only',
      },
      aggregateAudience: {
        status: 'not_attached',
        dataScope: 'aggregate_only',
        supportedDimensions: ['demographic', 'geographic', 'interest', 'active_time'],
      },
      individualFanRecords: {
        status: 'not_collected',
        dataScope: 'not_applicable_to_creator_portrait',
      },
    },
    aggregate: null,
  };
}

function dimensionAvailabilityStatus({ observed, partial = false }) {
  if (observed) return 'observed';
  return partial ? 'partial' : 'not_provided';
}

function deriveDataQualityDetail({
  quality,
  records,
  publicDataScope,
  capturedAt,
  followerCount,
  followingCount,
  totalLikes,
  workCount,
  visibleSamples,
  visibleSampleCount,
  postingCadence,
  engagement,
  commercialSignals,
  audience,
  growth,
  risk,
  account,
  contentStrategy,
  contentCoverage,
}) {
  const profileMetricObservedCount = [followerCount, followingCount, totalLikes, workCount]
    .filter(Number.isFinite).length;
  const visibleContentSampleCount = visibleSamples.length;
  const limitations = [
    profileMetricObservedCount < 4 ? 'some_public_account_metrics_not_provided' : '',
    visibleContentSampleCount === 0 ? 'no_visible_public_content_samples' : '',
    postingCadence.timestampedSampleCount < 2 ? 'insufficient_content_timestamps_for_cadence' : '',
    engagement.interactionObservedSampleCount === 0 ? 'no_visible_content_interaction_metrics' : '',
    audience.publicSignalCount === 0 ? 'no_public_audience_signals' : '',
    contentCoverage.collectionStatus === 'partial_against_current_public_work_count'
      ? 'visible_content_capture_is_partial_against_current_public_work_count'
      : '',
    contentCoverage.retentionStatus === 'retained_subset_of_reported_visible_samples'
      ? 'persona_retains_a_bounded_subset_of_visible_content_samples'
      : '',
    growth.status !== 'observed' ? 'no_comparable_prior_public_snapshot' : '',
  ].filter(Boolean);
  return {
    ...quality,
    sourceRecord: {
      rawRecordCount: Array.isArray(records) ? records.length : 0,
      publicDataScope,
      capturedAt,
    },
    coverage: {
      ...quality.coverage,
      profileMetricObservedCount,
      profileMetricPossibleCount: 4,
      visibleContentSampleCount,
      timestampedVisibleContentSampleCount: postingCadence.timestampedSampleCount,
      interactionObservedVisibleContentSampleCount: engagement.interactionObservedSampleCount,
      commercialMarkerVisibleContentSampleCount: commercialSignals.coverage.markerObservedSampleCount,
      riskFlaggedVisibleContentSampleCount: risk.sourceBreakdown.flaggedVisibleSampleCount,
      reportedVisibleContentSampleCount: contentCoverage.reportedVisibleSampleCount,
      retainedVisibleContentSampleCount: contentCoverage.retainedSampleCount,
      currentPublicWorkCount: contentCoverage.currentPublicWorkCount,
      retainedVisibleContentShare: contentCoverage.retainedShareOfReportedVisibleSamples,
      reportedVisibleContentShareOfCurrentPublicWorks: contentCoverage.reportedVisibleShareOfCurrentPublicWorks,
    },
    dimensionAvailability: {
      account: dimensionAvailabilityStatus({
        observed: Boolean(account.identity.displayName) || profileMetricObservedCount > 0,
      }),
      contentStrategy: dimensionAvailabilityStatus({
        observed: visibleContentSampleCount > 0,
        partial: contentStrategy.topics.labels.length > 0,
      }),
      engagement: dimensionAvailabilityStatus({ observed: engagement.interactionObservedSampleCount > 0 }),
      commercial: dimensionAvailabilityStatus({
        observed: commercialSignals.publicSignals.length > 0 || commercialSignals.explicitDisclosure.labels.length > 0,
        partial: visibleContentSampleCount > 0,
      }),
      audience: dimensionAvailabilityStatus({ observed: audience.publicSignalCount > 0 }),
      growth: growth.status,
      risk: risk.status,
    },
    limitations,
  };
}

function observedBooleanWithSource(profile) {
  for (const itemPath of ['verified', 'profile.verified']) {
    const direct = readPath(profile, itemPath);
    if (typeof direct === 'boolean') return { value: direct, sourcePath: itemPath };
    const label = text(direct, 60).toLowerCase();
    if (['true', 'verified', '\u5df2\u8ba4\u8bc1'].includes(label)) return { value: true, sourcePath: itemPath };
    if (['false', 'unverified', '\u672a\u8ba4\u8bc1'].includes(label)) return { value: false, sourcePath: itemPath };
  }
  const body = firstTextWithSource(profile, ['body', 'description'], 1200);
  if (/\u5df2\u8ba4\u8bc1|officially verified/i.test(body.value)) return { value: true, sourcePath: body.sourcePath };
  return { value: null, sourcePath: null };
}

function repairedCreatorSnapshot(creator) {
  if (creator?.channel !== 'douyin') return creator || {};
  const observedCardText = text(creator?.name, 1000);
  const repaired = normalizeDouyinCreators([{
    author: { nickname: observedCardText },
    observed_name: observedCardText,
    author_profile: creator?.sourceUrl,
    body: observedCardText,
    followers: creator?.followers,
    profile_likes: creator?.profileLikes,
    avatar_url: creator?.avatar,
  }], creator?.niche || creator?.angle || '', creator?.source || 'saved_discovery_public_card')[0];
  if (!repaired) return creator || {};
  const existingHandle = text(creator?.handle, 140);
  const existingHandleIsProfilePath = /^\/?user\//i.test(existingHandle);
  return {
    ...creator,
    name: repaired.name || creator?.name,
    handle: repaired.handle && (existingHandleIsProfilePath || !existingHandle)
      ? repaired.handle
      : existingHandle,
    followers: Number.isFinite(creator?.followers) ? creator.followers : repaired.followers,
    followersLabel: Number.isFinite(creator?.followers)
      ? text(creator?.followersLabel, 60) || formatMetric(creator.followers)
      : repaired.followersLabel,
    profileLikes: Number.isFinite(creator?.profileLikes) ? creator.profileLikes : repaired.profileLikes,
  };
}

export function normalizeEnrichmentTarget(creator) {
  const snapshot = repairedCreatorSnapshot(creator);
  const channel = snapshot?.channel === 'douyin' || snapshot?.channel === 'xiaohongshu' ? snapshot.channel : '';
  const sourceUrl = channel ? isProfileSourceUrl(channel, snapshot?.sourceUrl) : '';
  const identityKey = canonicalCreatorIdentity(channel, sourceUrl);
  const name = text(snapshot?.name, 120);
  if (!channel || !sourceUrl || !identityKey || !text(snapshot?.id, 180) || !isUsableCreatorName(name)) return null;
  return {
    id: text(snapshot.id, 180),
    ...(text(snapshot.targetId, 180) ? { targetId: text(snapshot.targetId, 180) } : {}),
    name,
    channel,
    platform: text(snapshot.platform, 40),
    sourceUrl,
    identityKey,
    handle: text(snapshot.handle, 140),
    niche: text(snapshot.niche, 180),
    angle: text(snapshot.angle, 180),
    fit: Number.isFinite(snapshot.fit) ? snapshot.fit : null,
    followers: Number.isFinite(snapshot.followers) ? snapshot.followers : null,
    followersLabel: text(snapshot.followersLabel, 60),
    profileLikes: Number.isFinite(snapshot.profileLikes) ? snapshot.profileLikes : null,
    interactions: Number.isFinite(snapshot.interactions) ? snapshot.interactions : null,
    sampleCount: Number.isFinite(snapshot.sampleCount) ? snapshot.sampleCount : 0,
    avatar: safeRemoteUrl(snapshot.avatar),
  };
}

export function selectEnrichmentTargets(discoveryJob, requestedCreatorIds, maximum) {
  const available = (Array.isArray(discoveryJob?.results) ? discoveryJob.results : [])
    .map(normalizeEnrichmentTarget)
    .filter(Boolean);
  const byId = new Map(available.map((creator) => [creator.id, creator]));
  const requested = requestedCreatorIds === null
    ? [...byId.keys()]
    : [...new Set((Array.isArray(requestedCreatorIds) ? requestedCreatorIds : [])
      .map((id) => text(id, 180))
      .filter(Boolean))];
  const missingIds = requested.filter((id) => !byId.has(id));
  const selected = requested.map((id) => byId.get(id)).filter(Boolean);
  const cap = Math.max(1, Number(maximum) || available.length || 1);
  return {
    availableCount: available.length,
    requestedCount: requested.length,
    missingIds,
    targets: selected.slice(0, cap),
    truncated: selected.length > cap,
  };
}

export function deriveCreatorPersona({
  creator,
  records,
  source = 'browser_relay',
  collectionMeta = null,
  historicalPersona = null,
  visibleContentSampleLimit = MAX_VISIBLE_CONTENT_SAMPLES,
  capturedAt = new Date().toISOString(),
}) {
  const profile = rawProfileRecord(records);
  const profileUrlObservation = firstTextWithSource(profile, [
    'author_profile', 'source_profile_url', 'profile_url', 'profile.url',
  ]);
  const profileUrl = isProfileSourceUrl(creator.channel, profileUrlObservation.value) || creator.sourceUrl;
  const profileUrlSourcePath = profileUrlObservation.sourcePath || 'saved_discovery.sourceUrl';
  const identityKey = canonicalCreatorIdentity(creator.channel, profileUrl) || creator.identityKey;
  const displayNameObservation = firstTextWithSource(profile, [
    'observed_name', 'author.nickname', 'author.name', 'author', 'nickname', 'name',
    'profile.nickname', 'profile.name',
  ], 120);
  const observedDisplayName = isUsableCreatorName(displayNameObservation.value)
    ? displayNameObservation.value
    : '';
  const savedDisplayName = isUsableCreatorName(creator.name) ? creator.name : '';
  const displayName = observedDisplayName || savedDisplayName;
  const displayNameSourcePath = observedDisplayName
    ? displayNameObservation.sourcePath
    : savedDisplayName
      ? 'saved_discovery.name'
      : null;
  const handleObservation = firstTextWithSource(profile, ['handle', 'profile.handle', 'author.unique_id'], 140);
  const handle = handleObservation.value || creator.handle;
  const handleSourcePath = handleObservation.sourcePath || (creator.handle ? 'saved_discovery.handle' : null);
  const homepageUrlObservation = firstTextWithSource(profile, [
    'homepage_url', 'profile.homepage_url', 'author_profile', 'source_profile_url',
  ], 1_200);
  const homepageUrl = isProfileSourceUrl(creator.channel, homepageUrlObservation.value) || profileUrl;
  const profileTitleObservation = firstTextWithSource(profile, [
    'profile_title', 'profile.title',
  ], 180);
  const profileTitle = profileTitleObservation.value;
  const profileTextObservation = firstTextWithSource(profile, [
    'profile_text', 'profile.text',
  ], 5_000);
  const profileTextSnapshot = profileTextObservation.value;
  const bioObservation = firstTextWithSource(profile, [
    'bio', 'signature', 'profile.bio', 'profile.signature',
  ], MAX_BIO_LENGTH);
  const bio = bioObservation.value;
  const bodyObservation = firstTextWithSource(profile, ['body', 'description', 'profile.body'], MAX_TEXT_SAMPLE);
  const body = bodyObservation.value;
  const locationObservation = firstTextWithSource(profile, [
    'location', 'ip_location', 'profile.location', 'author.location',
  ], 100);
  const location = locationObservation.value;
  const avatarObservation = firstTextWithSource(profile, [
    'avatar_url', 'avatar', 'card_cover_url', 'cover_url', 'profile.avatar',
  ]);
  const avatar = safeRemoteUrl(avatarObservation.value) || creator.avatar;
  const avatarSourcePath = avatarObservation.sourcePath || (creator.avatar ? 'saved_discovery.avatar' : null);
  const followerObservation = firstMetricWithSource(profile, [
    'follower_count', 'followers', 'fans',
    'profile.follower_count', 'profile.followers', 'profile.fans',
    'metrics.followers', 'profile.metrics.followers',
  ]);
  const followerCount = followerObservation.value ?? (Number.isFinite(creator.followers) ? creator.followers : null);
  const followerSourcePath = followerObservation.sourcePath
    || (Number.isFinite(creator.followers) ? 'saved_discovery.followers' : null);
  const followingObservation = firstMetricWithSource(profile, [
    'following_count', 'following', 'follow_count',
    'profile.following_count', 'profile.following', 'profile.follow_count',
    'metrics.following', 'profile.metrics.following',
  ]);
  const followingCount = followingObservation.value;
  const totalLikesObservation = firstMetricWithSource(profile, [
    'like_count', 'likes', 'liked_count', 'total_likes',
    'profile.like_count', 'profile.likes', 'profile.liked_count', 'profile.total_likes',
    'metrics.likes', 'profile.metrics.likes',
  ]);
  const totalLikes = totalLikesObservation.value ?? (Number.isFinite(creator.profileLikes) ? creator.profileLikes : null);
  const totalLikesSourcePath = totalLikesObservation.sourcePath
    || (Number.isFinite(creator.profileLikes) ? 'saved_discovery.profileLikes' : null);
  const workObservation = firstMetricWithSource(profile, [
    'work_count', 'works', 'aweme_count', 'note_count', 'video_count',
    'profile.work_count', 'profile.works', 'profile.aweme_count', 'profile.note_count', 'profile.video_count',
    'metrics.works', 'metrics.work_count', 'metrics.aweme_count', 'metrics.note_count',
    'profile.metrics.works', 'profile.metrics.work_count', 'profile.metrics.aweme_count', 'profile.metrics.note_count',
  ]);
  const workCount = workObservation.value;
  const verifiedObservation = observedBooleanWithSource(profile);
  const verified = verifiedObservation.value;
  const verifiedLabelObservation = firstTextWithSource(profile, [
    'verified_label', 'verification_label', 'profile.verified_label', 'profile.verification_label',
  ], 120);
  const verifiedLabel = verifiedLabelObservation.value;
  const accountTypeObservation = firstTextWithSource(profile, [
    'account_type', 'creator_type', 'profile.account_type', 'profile.creator_type',
  ], 120);
  const accountType = accountTypeObservation.value;
  const accountCreatedAtObservation = firstTextWithSource(profile, [
    'account_created_at', 'registration_time', 'register_time',
    'profile.account_created_at', 'profile.registration_time', 'profile.register_time', 'profile.created_at',
  ], 80);
  const accountCreatedAt = publishedAtIso(accountCreatedAtObservation.value);
  const publicProfileTags = profileTags(profile);
  const topics = topicSignals({ creator, profile });
  const visibleMetrics = allTextLists(profile, ['visible_metrics', 'profile.visible_metrics'], MAX_VISIBLE_METRICS, {
    delimited: true,
  });
  const publicAudienceSignals = allTextLists(profile, [
    'public_audience_signals', 'profile.public_audience_signals',
  ], MAX_VISIBLE_AUDIENCE_SIGNALS, { delimited: true });
  const visibleSampleObservation = firstArrayWithSource(profile, [
    'latest_samples', 'profile.latest_samples',
  ]);
  const visibleSamples = visibleContentSamples(
    visibleSampleObservation.value,
    creator.channel,
    visibleContentSampleLimit,
    capturedAt,
  );
  const contentSummaryObservation = firstObjectWithSource(profile, ['content_summary', 'profile.content_summary']);
  const contentSummary = contentSummaryObservation.value;
  const summaryInteractionObservation = firstObjectWithSource(contentSummary, [
    'sample_interactions', 'interactions',
  ]);
  const summaryInteractions = interactionMetrics(summaryInteractionObservation.value);
  const sampleInteractions = {
    ...sumInteractions(visibleSamples),
    ...summaryInteractions,
  };
  const visibleSampleCountObservation = firstMetricWithSource(profile, [
    'content_summary.visible_sample_count', 'profile.content_summary.visible_sample_count',
  ]);
  const visibleSampleCount = visibleSampleCountObservation.value ?? visibleSamples.length;
  const verticals = deriveContentVerticals({ creator, profile, samples: visibleSamples, contentSummary });
  const contentMix = deriveContentMix(visibleSamples);
  const postingCadence = derivePostingCadence(visibleSamples);
  const contentStrategy = deriveContentStrategy({
    samples: visibleSamples,
    verticals,
    contentMix,
    postingCadence,
    capturedAt,
  });
  const contentCoverage = deriveContentCaptureCoverage({
    visibleSamples,
    reportedVisibleSampleCount: visibleSampleCount,
    workCount,
    contentSummary,
    collectionMeta,
  });
  const engagement = deriveEngagement({
    samples: visibleSamples,
    contentSummary,
    totals: sampleInteractions,
    followerCount,
  });
  const commercialSignals = deriveCommercialSignals(profile, visibleSamples, contentSummary);
  const risk = deriveRiskSignals(profile, visibleSamples, contentSummary);
  const growth = deriveGrowth({
    followerCount,
    totalLikes,
    workCount,
    averageObservedInteractionActions: engagement.averageObservedInteractionActions,
    historicalPersona,
    capturedAt,
    identityKey,
  });
  const publicDataScope = text(
    collectionMeta?.public_data_scope || collectionMeta?.dataScope || collectionMeta?.scope,
    80,
  ) || (visibleSamples.length ? 'profile_and_visible_content' : 'profile');
  const tier = profileTier(followerCount ?? creator.followers);
  const account = deriveAccountDimension({
    displayName,
    handle,
    sourceUrl: profileUrl,
    identityKey,
    bio,
    location,
    avatar,
    verified,
    verifiedLabel,
    accountType,
    followerCount,
    followingCount,
    totalLikes,
    workCount,
    publicProfileTags,
    tier,
    accountCreatedAt,
    capturedAt,
  });
  const audience = deriveAudienceDimension({
    publicAudienceSignals,
    followerCount,
    collectionMeta,
  });
  const qualityBase = evidenceQuality({
    followerCount,
    followingCount,
    totalLikes,
    workCount,
    bio,
    location,
    verified,
    topics,
    profileTagCount: publicProfileTags.length,
    contentSample: body,
    profileName: displayName,
    visibleMetricCount: visibleMetrics.length,
    visibleSampleCount,
    audienceSignalCount: publicAudienceSignals.length,
    interactionObservedSampleCount: engagement.interactionObservedSampleCount,
    timestampedSampleCount: postingCadence.timestampedSampleCount,
    commercialSignalCount: commercialSignals.publicSignals.length + commercialSignals.explicitDisclosure.labels.length,
  });
  const quality = deriveDataQualityDetail({
    quality: qualityBase,
    records,
    publicDataScope,
    capturedAt,
    followerCount,
    followingCount,
    totalLikes,
    workCount,
    visibleSamples,
    visibleSampleCount,
    postingCadence,
    engagement,
    commercialSignals,
    audience,
    growth,
    risk,
    account,
    contentStrategy,
    contentCoverage,
  });
  const publicProfileTagSourcePaths = sourcePathsWithTextValues(profile, [
    'profile_tags', 'profile.profile_tags',
  ], MAX_PROFILE_TAGS, { delimited: true });
  const visibleMetricSourcePaths = sourcePathsWithTextValues(profile, [
    'visible_metrics', 'profile.visible_metrics',
  ], MAX_VISIBLE_METRICS, { delimited: true });
  const audienceSignalSourcePaths = sourcePathsWithTextValues(profile, [
    'public_audience_signals', 'profile.public_audience_signals',
  ], MAX_VISIBLE_AUDIENCE_SIGNALS, { delimited: true });
  const provenance = {
    schemaVersion: CREATOR_PERSONA_PROVENANCE_VERSION,
    source: {
      collector: source,
      capturedAt,
      publicDataScope,
      rawRecordCount: Array.isArray(records) ? records.length : 0,
    },
    dimensions: {
      account: {
        displayName: provenanceEntry({ value: displayName, sourcePaths: [displayNameSourcePath] }),
        handle: provenanceEntry({ value: handle, sourcePaths: [handleSourcePath] }),
        sourceUrl: provenanceEntry({ value: profileUrl, sourcePaths: [profileUrlSourcePath] }),
        homepageUrl: provenanceEntry({ value: homepageUrl, sourcePaths: [homepageUrlObservation.sourcePath, profileUrlSourcePath] }),
        profileTitle: provenanceEntry({ value: profileTitle, sourcePaths: [profileTitleObservation.sourcePath] }),
        profileText: provenanceEntry({ value: profileTextSnapshot, sourcePaths: [profileTextObservation.sourcePath] }),
        bio: provenanceEntry({ value: bio, sourcePaths: [bioObservation.sourcePath] }),
        location: provenanceEntry({ value: location, sourcePaths: [locationObservation.sourcePath] }),
        avatar: provenanceEntry({ value: avatar, sourcePaths: [avatarSourcePath] }),
        verification: provenanceEntry({
          value: verified,
          sourcePaths: [verifiedObservation.sourcePath, verifiedLabelObservation.sourcePath],
        }),
        accountType: provenanceEntry({ value: accountType, sourcePaths: [accountTypeObservation.sourcePath] }),
        followers: provenanceEntry({ value: followerCount, sourcePaths: [followerSourcePath] }),
        following: provenanceEntry({ value: followingCount, sourcePaths: [followingObservation.sourcePath] }),
        totalLikes: provenanceEntry({ value: totalLikes, sourcePaths: [totalLikesSourcePath] }),
        works: provenanceEntry({ value: workCount, sourcePaths: [workObservation.sourcePath] }),
        profileTags: provenanceEntry({ value: publicProfileTags, sourcePaths: publicProfileTagSourcePaths }),
        lifecycle: provenanceEntry({ value: accountCreatedAt, sourcePaths: [accountCreatedAtObservation.sourcePath] }),
        ratios: provenanceEntry({
          value: Object.values(account.ratios).filter(Number.isFinite),
          sourcePaths: [followerSourcePath, followingObservation.sourcePath, totalLikesSourcePath, workObservation.sourcePath],
          basis: 'derived_from_observed_public_account_metrics',
          derivation: 'account_metric_ratio',
          missingStatus: 'not_computable',
        }),
        coverage: provenanceEntry({
          value: account.coverage,
          sourcePaths: [
            displayNameSourcePath,
            handleSourcePath,
            bioObservation.sourcePath,
            locationObservation.sourcePath,
            avatarSourcePath,
            verifiedObservation.sourcePath,
            accountTypeObservation.sourcePath,
            followerSourcePath,
            followingObservation.sourcePath,
            totalLikesSourcePath,
            workObservation.sourcePath,
          ],
          basis: 'observed_public_profile_fields_and_saved_discovery_identity',
          derivation: 'public_account_field_availability_count',
          missingStatus: 'not_provided',
        }),
      },
      contentStrategy: {
        visibleSamples: provenanceEntry({
          value: visibleSamples,
          sourcePaths: [visibleSampleObservation.sourcePath],
          basis: 'visible_public_content_samples',
          sampleCount: visibleSamples.length,
        }),
        profileText: provenanceEntry({ value: body, sourcePaths: [bodyObservation.sourcePath] }),
        contentSummary: provenanceEntry({ value: contentSummary, sourcePaths: [contentSummaryObservation.sourcePath] }),
        presentationAndFormat: provenanceEntry({
          value: contentStrategy.formats.distribution,
          sourcePaths: [visibleSampleObservation.sourcePath],
          basis: 'derived_from_visible_public_content_samples',
          derivation: 'format_and_asset_coverage_aggregation',
          sampleCount: visibleSamples.length,
          missingStatus: 'not_computable',
        }),
        topics: provenanceEntry({
          value: contentStrategy.topics.labels,
          sourcePaths: [...publicProfileTagSourcePaths, visibleSampleObservation.sourcePath, bodyObservation.sourcePath, 'saved_discovery.niche', 'saved_discovery.angle'],
          basis: 'observed_public_tags_visible_sample_hashtags_and_saved_discovery_context',
          derivation: 'bounded_distinct_topic_aggregation',
          sampleCount: visibleSamples.length,
        }),
        cadence: provenanceEntry({
          value: postingCadence.uniqueTimestampCount,
          sourcePaths: [visibleSampleObservation.sourcePath],
          basis: 'derived_from_visible_public_content_timestamps',
          derivation: 'timestamp_interval_aggregation',
          sampleCount: visibleSamples.length,
          missingStatus: 'not_computable',
        }),
        captureCoverage: provenanceEntry({
          value: contentCoverage,
          sourcePaths: [visibleSampleObservation.sourcePath, contentSummaryObservation.sourcePath],
          basis: 'collector_reported_visible_content_and_current_public_work_count',
          derivation: 'visible_sample_retention_and_public_work_count_comparison',
          sampleCount: visibleSamples.length,
          missingStatus: 'not_provided',
        }),
      },
      engagement: {
        visibleSampleInteractions: provenanceEntry({
          value: engagement.interactionObservedSampleCount,
          sourcePaths: [visibleSampleObservation.sourcePath],
          basis: 'visible_public_content_interaction_fields',
          derivation: 'sum_and_average_of_available_interaction_actions',
          sampleCount: visibleSamples.length,
          missingStatus: 'not_computable',
        }),
        summaryInteractions: provenanceEntry({
          value: Object.values(summaryInteractions).filter(Number.isFinite),
          sourcePaths: [contentSummaryObservation.sourcePath, summaryInteractionObservation.sourcePath],
          basis: 'collector_content_summary_fields',
          missingStatus: 'not_provided',
        }),
        followerNormalizedRates: provenanceEntry({
          value: Object.values(engagement.averageActionRatePerFollower).filter(Number.isFinite),
          sourcePaths: [followerSourcePath, visibleSampleObservation.sourcePath],
          basis: 'derived_from_observed_sample_interactions_and_current_public_follower_count',
          derivation: 'average_action_per_sample_divided_by_follower_count',
          sampleCount: engagement.interactionObservedSampleCount,
          missingStatus: 'not_computable',
        }),
      },
      commercial: {
        publicSignals: provenanceEntry({
          value: commercialSignals.publicSignals,
          sourcePaths: sourcePathsWithTextValues(profile, [
            'commercial_signals', 'public_commercial_signals', 'profile.commercial_signals', 'profile.public_commercial_signals',
          ], MAX_COMMERCIAL_MARKERS, { delimited: true }),
        }),
        disclosuresAndBrands: provenanceEntry({
          value: [...commercialSignals.explicitDisclosure.labels, ...commercialSignals.brandMentions.labels],
          sourcePaths: [contentSummaryObservation.sourcePath, visibleSampleObservation.sourcePath],
          basis: 'explicit_public_profile_labels_and_visible_content_markers',
          sampleCount: visibleSamples.length,
        }),
      },
      audience: {
        publicSignals: provenanceEntry({ value: publicAudienceSignals, sourcePaths: audienceSignalSourcePaths }),
        coverage: provenanceEntry({
          value: audience.coverage,
          sourcePaths: audienceSignalSourcePaths,
          basis: 'public_profile_signal_coverage_and_aggregate_attachment_status',
          missingStatus: 'not_provided',
        }),
        aggregate: provenanceEntry({
          value: audience.aggregate,
          sourcePaths: [],
          basis: 'not_collected_by_public_profile_enrichment',
          missingStatus: 'not_provided',
        }),
      },
      growth: {
        snapshotComparison: provenanceEntry({
          value: Object.values(growth.metrics),
          sourcePaths: [followerSourcePath, totalLikesSourcePath, workObservation.sourcePath],
          basis: 'two_public_profile_snapshots_for_the_same_creator',
          derivation: 'current_minus_matching_prior_snapshot',
          missingStatus: 'not_computable',
        }),
      },
      risk: {
        explicitPublicLabels: provenanceEntry({
          value: risk.publicFlags,
          sourcePaths: [contentSummaryObservation.sourcePath, visibleSampleObservation.sourcePath, ...sourcePathsWithTextValues(profile, [
            'risk_flags', 'compliance_flags', 'restriction_labels',
            'profile.risk_flags', 'profile.compliance_flags', 'profile.restriction_labels',
          ], MAX_RISK_FLAGS, { delimited: true })],
          basis: 'explicit_public_profile_or_content_labels_only',
          sampleCount: visibleSamples.length,
          missingStatus: visibleSamples.length ? 'not_observed_in_visible_sample' : 'not_provided',
        }),
      },
      dataQuality: {
        coverage: provenanceEntry({
          value: quality.coverage.observedFieldCount,
          sourcePaths: [
            followerSourcePath,
            followingObservation.sourcePath,
            totalLikesSourcePath,
            workObservation.sourcePath,
            visibleSampleObservation.sourcePath,
          ],
          basis: 'observed_public_profile_and_visible_content_field_coverage',
          derivation: 'field_availability_count',
        }),
      },
    },
  };

  return {
    schemaVersion: CREATOR_PERSONA_SCHEMA_VERSION,
    id: `${creator.id}-persona`,
    targetId: creator.id,
    discoveryCreatorId: creator.id,
    channel: creator.channel,
    platform: creator.platform || creator.channel,
    identityKey,
    name: displayName,
    handle,
    sourceUrl: profileUrl,
    capturedAt,
    status: 'enriched',
    profile: {
      displayName,
      bio,
      location,
      homepageUrl,
      profileTitle,
      profileText: profileTextSnapshot,
      verified,
      verifiedLabel,
      accountType,
      avatar,
      followerCount,
      followerLabel: formatMetric(followerCount),
      followingCount,
      followingLabel: formatMetric(followingCount),
      totalLikes,
      totalLikesLabel: formatMetric(totalLikes),
      workCount,
      workCountLabel: formatMetric(workCount),
      metricSources: {
        followers: followerSourcePath,
        following: followingObservation.sourcePath,
        totalLikes: totalLikesSourcePath,
        works: workObservation.sourcePath,
      },
      metricsCapturedAt: capturedAt,
      missingReasons: {
        followers: Number.isFinite(followerCount) ? null : 'not_observed_on_public_profile_or_discovery_card',
        following: Number.isFinite(followingCount) ? null : 'not_observed_on_public_profile',
        totalLikes: Number.isFinite(totalLikes) ? null : 'not_observed_on_public_profile_or_discovery_card',
        works: Number.isFinite(workCount) ? null : 'not_observed_on_public_profile',
      },
      followingToFollowerRatio: account.ratios.followingToFollowerRatio,
      accountCreatedAt: account.lifecycle.accountCreatedAt,
      accountAgeDays: account.lifecycle.accountAgeDays,
      visibleMetrics,
      publicAudienceSignals,
      publicProfileTags,
      coverage: account.coverage,
    },
    content: {
      primaryTopics: topics,
      discoveryNiche: creator.niche,
      discoveryAngle: creator.angle,
      contentSample: body,
      discoverySampleCount: creator.sampleCount,
      visibleSampleCount,
      reportedVisibleSampleCount: contentCoverage.reportedVisibleSampleCount,
      retainedVisibleSampleCount: contentCoverage.retainedSampleCount,
      visibleSamples,
      sampleInteractions,
      sampledFromPublicProfile: Boolean(contentSummary.sampled_from_public_profile) || visibleSamples.length > 0,
      coverage: contentCoverage,
      verticals,
      contentMix,
      postingCadence,
      engagement,
      contentStrategy,
      captureCoverage: contentCoverage,
      contentCoverage,
    },
    performance: {
      basis: 'visible_public_content_samples',
      contentMix,
      postingCadence,
      engagement,
      contentStrategy,
    },
    commercial: {
      creatorTier: tier.id,
      creatorTierLabel: tier.label,
      discoveryInteractions: creator.interactions,
      discoveryFollowers: creator.followers,
      discoveryFit: creator.fit,
      signals: commercialSignals.publicSignals,
      explicitDisclosure: commercialSignals.explicitDisclosure,
      brandMentions: commercialSignals.brandMentions,
      coverage: commercialSignals.coverage,
    },
    audience,
    fit: {
      basis: 'saved_discovery_ranking_and_observed_public_topic_labels',
      discoveryScore: creator.fit,
      discoveryNiche: creator.niche,
      discoveryAngle: creator.angle,
      observedTopics: topics,
    },
    growth,
    risk,
    quality,
    dimensions: {
      account,
      contentStrategy,
      contentCoverage,
      engagement,
      commercial: commercialSignals,
      audience,
      growth,
      risk,
      dataQuality: quality,
    },
    provenance,
    evidence: {
      source,
      profileUrl,
      capturedAt,
      collectionMeta: collectionMeta && typeof collectionMeta === 'object' ? collectionMeta : null,
      publicDataScope,
      observedFields: quality.observedFields,
      rawRecordCount: Array.isArray(records) ? records.length : 0,
      schemaVersion: CREATOR_PERSONA_SCHEMA_VERSION,
      provenanceSchemaVersion: CREATOR_PERSONA_PROVENANCE_VERSION,
    },
  };
}
