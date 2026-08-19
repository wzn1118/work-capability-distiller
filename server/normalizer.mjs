import { createHash } from 'node:crypto';

const PLATFORM_LABELS = {
  xiaohongshu: '\u5c0f\u7ea2\u4e66',
  douyin: '\u6296\u97f3',
  bilibili: 'B\u7ad9',
};
const UNKNOWN_CREATOR = '\u672a\u8bc6\u522b\u8d26\u53f7';
const RESERVED_DOUYIN_PROFILE_IDS = new Set(['self', 'login', 'search', 'discover', 'following', 'follower']);
const PROFILE_HOSTS = {
  xiaohongshu: new Set(['xiaohongshu.com', 'www.xiaohongshu.com']),
  douyin: new Set(['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']),
  bilibili: new Set(['space.bilibili.com']),
};
const ERROR_PAGE_TITLE_PATTERNS = [
  /^(?:error[:\s-]*)?(?:[45]\d{2}\s+)?(?:bad gateway|gateway time[-\s]?out|service unavailable|internal server error|origin error)$/i,
  /^(?:[45]\d{2}\s*)?(?:\u7f51\u5173\u9519\u8bef|\u7f51\u5173\u8d85\u65f6|\u670d\u52a1\u4e0d\u53ef\u7528|\u5185\u90e8\u670d\u52a1\u5668\u9519\u8bef|\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef)$/u,
];

function asText(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

export function isTransportErrorPageTitle(value) {
  const title = asText(value);
  return Boolean(title) && ERROR_PAGE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export function isTransportErrorPageContent(value) {
  if (value === null || value === undefined || typeof value === 'object') return false;
  const lines = String(value).split(/\r?\n/).map(asText).filter(Boolean);
  return lines.some(isTransportErrorPageTitle);
}

export function isUsableCreatorName(value) {
  const name = asText(value);
  return Boolean(name)
    && name !== UNKNOWN_CREATOR
    && !isTransportErrorPageTitle(name);
}

function firstText(item, paths) {
  for (const candidatePath of paths) {
    let value = item;
    for (const key of candidatePath.split('.')) value = value?.[key];
    if (Array.isArray(value)) value = value[0];
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function identity(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function platformDomains(platform) {
  if (platform === 'xiaohongshu') return ['xiaohongshu.com'];
  if (platform === 'douyin') return ['douyin.com', 'iesdouyin.com'];
  if (platform === 'bilibili') return ['bilibili.com'];
  return [];
}

export function safeRemoteUrl(value, { baseUrl = '', domains = [] } = {}) {
  const text = asText(value);
  if (!text) return '';
  try {
    const url = new URL(text, baseUrl || undefined);
    if (url.protocol !== 'https:') return '';
    if (domains.length && !domains.some((domain) => hostMatches(url.hostname, domain))) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function sourceUrlFor(platform, value) {
  const domains = platformDomains(platform);
  const baseUrl = platform === 'xiaohongshu'
    ? 'https://www.xiaohongshu.com'
    : platform === 'douyin'
      ? 'https://www.douyin.com'
      : platform === 'bilibili'
        ? 'https://space.bilibili.com'
      : '';
  return safeRemoteUrl(value, { baseUrl, domains });
}

function decodedProfileId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || /[\\/\x00-\x1f\x7f]/.test(decoded)) return '';
    return decoded;
  } catch {
    return '';
  }
}

function profileIdFromSourceUrl(platform, sourceUrl) {
  const url = new URL(sourceUrl);
  if (!PROFILE_HOSTS[platform]?.has(url.hostname.toLowerCase())) return '';
  const pathname = url.pathname;
  const match = platform === 'xiaohongshu'
    ? pathname.match(/^\/user\/profile\/([^/]+)\/?$/i)
    : platform === 'douyin'
      ? pathname.match(/^\/(?:user|share\/user)\/([^/]+)\/?$/i)
      : pathname.match(/^\/(\d+)\/?$/i);
  if (!match) return '';
  const profileId = decodedProfileId(match[1]);
  if (!profileId) return '';
  if (platform === 'douyin' && RESERVED_DOUYIN_PROFILE_IDS.has(profileId.toLowerCase())) return '';
  return profileId;
}

function canonicalProfileUrl(platform, profileId) {
  const encodedId = encodeURIComponent(profileId);
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/user/profile/${encodedId}`;
  if (platform === 'douyin') return `https://www.douyin.com/user/${encodedId}`;
  if (platform === 'bilibili') return `https://space.bilibili.com/${encodedId}`;
  return '';
}

export function isProfileSourceUrl(platform, value) {
  const sourceUrl = sourceUrlFor(platform, value);
  if (!sourceUrl) return '';
  const profileId = profileIdFromSourceUrl(platform, sourceUrl);
  return profileId ? canonicalProfileUrl(platform, profileId) : '';
}

export function canonicalCreatorIdentity(platform, value) {
  const sourceUrl = isProfileSourceUrl(platform, value);
  if (!sourceUrl) return '';
  const profileId = profileIdFromSourceUrl(platform, sourceUrl);
  return profileId ? `${platform}:${profileId}` : '';
}

function sourcePath(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).pathname;
  } catch {
    return '';
  }
}

function compactTopic(values) {
  const text = values.filter(Boolean).join(' ').replace(/[#|]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 38) : '\u5185\u5bb9\u65b9\u5411\u5f85\u8865\u5145';
}

function scoreMatch(text, query) {
  const queryTerms = asText(query).toLowerCase().split(/[\s,\uFF0C\u3002]+/).filter((term) => term.length > 1);
  if (!queryTerms.length) return null;
  const haystack = text.toLowerCase();
  const hits = queryTerms.filter((term) => haystack.includes(term)).length;
  return Math.max(35, Math.min(98, Math.round(35 + (hits / queryTerms.length) * 63)));
}

export function parseMetric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = asText(value).toLowerCase().replace(/,/g, '');
  if (!text) return null;
  const match = text.match(/([\d.]+)/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (text.includes('\u4ebf')) return Math.round(amount * 100000000);
  if (text.includes('\u4e07') || text.includes('w')) return Math.round(amount * 10000);
  if (text.includes('k')) return Math.round(amount * 1000);
  return Math.round(amount);
}

export function formatMetric(value) {
  if (!Number.isFinite(value)) return '\u672a\u63d0\u4f9b';
  if (value >= 100000000) return `${(value / 100000000).toFixed(value % 100000000 ? 1 : 0)}\u4ebf`;
  if (value >= 10000) return `${(value / 10000).toFixed(value % 10000 ? 1 : 0)}\u4e07`;
  return String(value);
}

function compactDouyinSearchCardName(value) {
  const observed = asText(value);
  if (!observed) return '';
  const boundary = observed.match(/(?:\u8d26\u53f7)?\u5173\u6ce8\s*(?:\u6296\u97f3\u53f7\s*)?[:\uff1a]/u);
  if (!boundary?.index) return observed;
  const name = observed.slice(0, boundary.index)
    .replace(/\u8ba4\u8bc1\u5fbd\u7ae0\s*\u65d7\u8230\u5e97$/u, '')
    .trim();
  return name || observed;
}

function parseSearchCardMetric(value) {
  const token = asText(value);
  const parsed = parseMetric(token);
  // A count above one billion from a compact search-card string is an account
  // ID that ran into the metric, not a trustworthy public metric.
  return Number.isFinite(parsed) && parsed <= 1000000000 ? parsed : null;
}

function douyinSearchCardProfileStats(value) {
  const observed = asText(value);
  const metricBefore = (suffix) => {
    const pattern = new RegExp(`(\\d+(?:\\.\\d+)?\\s*(?:\\u4e07|\\u4ebf|w|k)?)\\s*${suffix}`, 'giu');
    const matches = [...observed.matchAll(pattern)].reverse();
    for (const match of matches) {
      const metric = parseSearchCardMetric(match[1]);
      if (metric !== null) return metric;
    }
    return null;
  };
  return {
    followers: metricBefore('\\u7c89\\u4e1d'),
    profileLikes: metricBefore('(?:\\u83b7\\u8d5e|\\u83b7\\u5f97\\u8d5e|\\u7d2f\\u8ba1\\u8d5e)'),
  };
}

function douyinSearchCardPublicHandle(value) {
  const observed = asText(value);
  const marker = observed.match(/\u6296\u97f3\u53f7\s*[:\uff1a]\s*/u);
  if (!marker) return '';
  const remainder = observed.slice(marker.index + marker[0].length);
  const metricSuffix = '(?:\\d+(?:\\.\\d+)?\\s*(?:\\u4e07|\\u4ebf|w|k)?\\s*(?:\\u83b7\\u8d5e|\\u83b7\\u5f97\\u8d5e|\\u7d2f\\u8ba1\\u8d5e|\\u7c89\\u4e1d))';
  const match = remainder.match(new RegExp(`^([a-z0-9._-]+?)(?=\\s*(?:${metricSuffix}|$))`, 'iu'));
  return match?.[1] || '';
}

function canonicalDouyinContentUrl(value) {
  const sourceUrl = sourceUrlFor('douyin', value);
  if (!sourceUrl) return '';
  try {
    const url = new URL(sourceUrl);
    const match = url.pathname.match(/^\/(video|note)\/([a-z0-9_-]+)\/?$/i);
    return match ? `https://www.douyin.com/${match[1].toLowerCase()}/${match[2]}` : '';
  } catch {
    return '';
  }
}

function douyinContentSamples(record) {
  const candidates = [
    record,
    ...(Array.isArray(record?.latest_samples) ? record.latest_samples : []),
    ...(Array.isArray(record?.profile?.latest_samples) ? record.profile.latest_samples : []),
  ];
  const samples = new Map();
  for (const candidate of candidates) {
    const noteUrl = canonicalDouyinContentUrl(firstText(candidate, [
      'note_url', 'share_url', 'aweme_url', 'video_url', 'url',
    ]));
    if (!noteUrl || samples.has(noteUrl)) continue;
    samples.set(noteUrl, { ...candidate, note_url: noteUrl });
  }
  return [...samples.values()];
}

function isDouyinSearchCardIdentityText(value) {
  return /\u6296\u97f3\u53f7\s*[:\uff1a]/u.test(asText(value));
}

function makeCreator({ platform, key, identityKey, name, handle, sourceUrl, avatar, topic, followers, profileLikes = null, notes, interactions, query, source }) {
  const contentText = `${name} ${topic} ${notes.map((note) => `${note.title || ''} ${note.body || ''} ${note.tags || ''}`).join(' ')}`;
  const fit = scoreMatch(contentText, query);
  return {
    id: `${platform}-${identity(key)}`,
    identityKey,
    name: name || UNKNOWN_CREATOR,
    handle: handle || '\u672a\u63d0\u4f9b\u8d26\u53f7\u6807\u8bc6',
    platform: PLATFORM_LABELS[platform] || platform,
    channel: platform,
    sourceUrl: sourceUrl || '',
    avatar: avatar || '',
    niche: topic,
    followers,
    followersLabel: formatMetric(followers),
    profileLikes: Number.isFinite(profileLikes) ? profileLikes : null,
    engagement: null,
    engagementLabel: `${notes.length} \u6761\u771f\u5b9e\u5185\u5bb9\u6837\u672c${Number.isFinite(interactions) ? ` \u00b7 ${formatMetric(interactions)} \u6b21\u4e92\u52a8` : ''}`,
    fit,
    price: null,
    priceLabel: '\u672a\u63d0\u4f9b',
    angle: compactTopic([notes[0]?.title, notes[0]?.tags, notes[0]?.body]),
    sampleCount: notes.length,
    interactions: Number.isFinite(interactions) ? interactions : null,
    source,
  };
}

export function normalizeXiaohongshuNotes(records, query, source = 'browser_relay') {
  const groups = new Map();
  for (const rawRecord of records || []) {
    const record = rawRecord?.note || rawRecord || {};
    const sourceUrl = isProfileSourceUrl('xiaohongshu', firstText(record, [
      'author_profile', 'card_author_profile', 'source_profile_url', 'author.profile_url', 'author.url',
    ]));
    const identityKey = canonicalCreatorIdentity('xiaohongshu', sourceUrl);
    if (!identityKey) continue;
    const name = firstText(record, ['author.nickname', 'author.name', 'author', 'card_author']);
    const group = groups.get(identityKey) || {
      key: identityKey,
      identityKey,
      name: isUsableCreatorName(name) ? name : '',
      sourceUrl,
      notes: [],
    };
    group.notes.push(record);
    if (!group.name && isUsableCreatorName(name)) group.name = name;
    if (!group.sourceUrl && sourceUrl) group.sourceUrl = sourceUrl;
    groups.set(identityKey, group);
  }

  return [...groups.values()].map((group) => {
    const interactions = group.notes.reduce((total, note) => total
      + (parseMetric(note.like_count) || 0)
      + (parseMetric(note.collect_count) || 0)
      + (parseMetric(note.comment_count) || 0), 0);
    return makeCreator({
      platform: 'xiaohongshu',
      key: group.key,
      identityKey: group.identityKey,
      name: group.name,
      handle: sourcePath(group.sourceUrl, 'https://www.xiaohongshu.com'),
      sourceUrl: group.sourceUrl,
      avatar: safeRemoteUrl(firstText(group.notes[0] || {}, ['card_cover_url', 'cover_url', 'cover.url'])),
      topic: compactTopic(group.notes.map((note) => note.tags || note.card_tags || note.title)),
      followers: null,
      notes: group.notes,
      interactions,
      query,
      source,
    });
  }).filter((creator) => isUsableCreatorName(creator.name) && creator.sourceUrl && creator.identityKey);
}

export function normalizeDouyinCreators(records, query, source = 'browser_relay') {
  return (records || []).map((rawRecord, index) => {
    const record = rawRecord?.aweme_info || rawRecord?.aweme || rawRecord || {};
    const observedName = firstText(record, [
      'author.nickname', 'author.name', 'author_info.nickname', 'author_info.name',
      'user.nickname', 'user.name', 'nickname', 'name', 'author',
    ]);
    const cardMetricText = firstText(record, ['observed_name', 'body', 'description', 'desc', 'text']);
    const cardMetricStats = douyinSearchCardProfileStats(cardMetricText);
    const observedNameStats = douyinSearchCardProfileStats(observedName);
    const searchCardStats = {
      followers: cardMetricStats.followers ?? observedNameStats.followers,
      // Search-card account IDs can run directly into the likes count. Only
      // accept likes from a separate card field, never the compacted name.
      profileLikes: cardMetricStats.profileLikes,
    };
    const publicHandle = douyinSearchCardPublicHandle(cardMetricText)
      || douyinSearchCardPublicHandle(observedName);
    const compactName = compactDouyinSearchCardName(observedName);
    const name = isUsableCreatorName(compactName) ? compactName : UNKNOWN_CREATOR;
    const secUid = firstText(record, [
      'author.sec_uid', 'author.secUid', 'author_info.sec_uid', 'author_info.secUid', 'user.sec_uid', 'sec_uid',
    ]);
    const explicitSourceUrl = isProfileSourceUrl('douyin', firstText(record, [
      'author_profile', 'profile_url', 'source_profile_url', 'author.profile_url',
      'author.url', 'author_info.profile_url', 'user.profile_url', 'user.url',
    ]));
    const sourceUrl = explicitSourceUrl || (secUid
      ? isProfileSourceUrl('douyin', `https://www.douyin.com/user/${encodeURIComponent(secUid)}`)
      : '');
    const identityKey = canonicalCreatorIdentity('douyin', sourceUrl);
    const followers = parseMetric(firstText(record, [
      'author.followers', 'author.follower_count', 'author_info.follower_count',
      'user.followers', 'profile.metrics.followers', 'metrics.followers',
      'followers', 'follower_count', 'fans',
    ])) ?? searchCardStats.followers;
    const profileLikes = parseMetric(firstText(record, [
      'author.total_favorited', 'author.total_favourite', 'author_info.total_favorited',
      'profile.metrics.likes', 'metrics.likes', 'total_likes', 'totalLikes', 'profile_likes',
    ])) ?? searchCardStats.profileLikes;
    const interactions = parseMetric(firstText(record, [
      'statistics.digg_count', 'statistics.like_count', 'like_count', 'likes',
      'digg_count', 'interaction_count',
    ]));
    const notes = douyinContentSamples(record);
    const topicText = firstText(record, ['desc', 'title', 'description', 'body', 'text']);
    const topic = compactTopic([
      !notes.length && isDouyinSearchCardIdentityText(topicText) ? '' : topicText,
      firstText(record, ['tags', 'hashtags']),
    ]);
    return makeCreator({
      platform: 'douyin',
      key: identityKey || firstText(record, ['author.uid', 'author_info.uid', 'author_id', 'aweme_id', 'id']) || `${name}-${index}`,
      identityKey,
      name,
      handle: firstText(record, [
        'author.unique_id', 'author_info.unique_id', 'handle', 'unique_id',
      ]) || publicHandle || sourcePath(sourceUrl, 'https://www.douyin.com'),
      sourceUrl,
      avatar: safeRemoteUrl(firstText(record, [
        'author.avatar_url', 'author.avatar', 'author_info.avatar_url', 'author_info.avatar',
        'avatar_url', 'avatar', 'cover_url', 'video.cover.url',
      ])),
      topic,
      followers,
      profileLikes,
      notes,
      interactions,
      query,
      source,
    });
  }).filter((creator) => isUsableCreatorName(creator.name) && creator.sourceUrl && creator.identityKey);
}

export function normalizeBilibiliCreators(records, query, source = 'browser_relay') {
  return (records || []).map((rawRecord, index) => {
    const record = rawRecord?.creator || rawRecord?.data || rawRecord || {};
    const observedName = firstText(record, [
      'owner.name', 'author.name', 'author.uname', 'up.name', 'member.uname',
      'profile.name', 'name', 'uname', 'author',
    ]);
    const name = isUsableCreatorName(observedName) ? observedName : UNKNOWN_CREATOR;
    const mid = firstText(record, [
      'owner.mid', 'author.mid', 'up.mid', 'member.mid', 'profile.mid', 'mid', 'uid', 'author_id',
    ]);
    const explicitSourceUrl = isProfileSourceUrl('bilibili', firstText(record, [
      'author_profile', 'profile_url', 'source_profile_url', 'owner.profile_url',
      'author.profile_url', 'up.profile_url', 'member.profile_url', 'url',
    ]));
    const sourceUrl = explicitSourceUrl || (mid
      ? isProfileSourceUrl('bilibili', `https://space.bilibili.com/${encodeURIComponent(mid)}`)
      : '');
    const identityKey = canonicalCreatorIdentity('bilibili', sourceUrl);
    const followers = parseMetric(firstText(record, [
      'owner.follower_count', 'author.follower_count', 'up.follower_count', 'member.fans',
      'profile.follower_count', 'follower_count', 'followers', 'fans',
    ]));
    const interactions = parseMetric(firstText(record, [
      'stat.view', 'stat.like', 'statistics.view', 'statistics.like', 'statistics.play_count',
      'interaction_count', 'like_count', 'likes', 'view_count', 'play_count',
    ]));
    const latestSamples = Array.isArray(record.latest_samples) && record.latest_samples.length
      ? record.latest_samples
      : [record];
    const topic = compactTopic([
      firstText(record, ['title', 'description', 'desc', 'body', 'text', 'signature', 'bio']),
      firstText(record, ['tags', 'hashtags', 'topic_labels']),
    ]);
    return makeCreator({
      platform: 'bilibili',
      key: identityKey || mid || firstText(record, ['bvid', 'aid', 'id']) || `${name}-${index}`,
      identityKey,
      name,
      handle: firstText(record, ['owner.handle', 'author.handle', 'up.handle', 'member.uname', 'handle', 'uname'])
        || sourcePath(sourceUrl, 'https://space.bilibili.com'),
      sourceUrl,
      avatar: safeRemoteUrl(firstText(record, [
        'owner.face', 'owner.avatar', 'author.face', 'author.avatar', 'up.face', 'member.face',
        'profile.avatar', 'avatar_url', 'avatar', 'cover_url',
      ])),
      topic,
      followers,
      notes: latestSamples,
      interactions,
      query,
      source,
    });
  }).filter((creator) => isUsableCreatorName(creator.name) && creator.sourceUrl && creator.identityKey);
}

export function normalizePartnerItems(platform, items, query, source = 'partner_http') {
  return (items || []).map((item, index) => {
    const observedName = firstText(item, [
      'author.name', 'author.nickname', 'creator.name', 'creator.nickname',
      'name', 'nickname', 'user.name', 'user.nickname',
    ]);
    const name = isUsableCreatorName(observedName) ? observedName : UNKNOWN_CREATOR;
    const sourceUrl = isProfileSourceUrl(platform, firstText(item, [
      'author.url', 'author.profile_url', 'creator.url', 'creator.profile_url', 'profile_url', 'url',
    ]));
    const identityKey = canonicalCreatorIdentity(platform, sourceUrl);
    const followers = parseMetric(firstText(item, [
      'author.followers', 'creator.followers', 'followers', 'follower_count', 'fans',
    ]));
    const interactions = parseMetric(firstText(item, [
      'engagements', 'interaction_count', 'like_count', 'likes',
    ]));
    return makeCreator({
      platform,
      key: identityKey || `${name}-${index}`,
      identityKey,
      name,
      handle: firstText(item, ['author.handle', 'creator.handle', 'handle', 'username']),
      sourceUrl,
      avatar: safeRemoteUrl(firstText(item, [
        'author.avatar', 'author.avatar_url', 'creator.avatar', 'creator.avatar_url',
        'avatar', 'avatar_url', 'cover_url',
      ])),
      topic: compactTopic([
        firstText(item, ['title', 'description', 'body', 'text']),
        firstText(item, ['tags', 'hashtags']),
      ]),
      followers,
      notes: [item],
      interactions,
      query,
      source,
    });
  }).filter((creator) => isUsableCreatorName(creator.name) && creator.sourceUrl && creator.identityKey);
}

export function dedupeCreators(creators) {
  const merged = new Map();
  for (const creator of creators) {
    const key = `${creator.channel}:${creator.identityKey || creator.sourceUrl || creator.name}`;
    const current = merged.get(key);
    if (!current || creator.sampleCount > current.sampleCount) merged.set(key, creator);
  }
  return [...merged.values()].sort((left, right) => (right.fit || 0) - (left.fit || 0)
    || (right.sampleCount || 0) - (left.sampleCount || 0));
}
