import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalCreatorIdentity,
  dedupeCreators,
  isProfileSourceUrl,
  isUsableCreatorName,
  normalizeBilibiliCreators,
  normalizeDouyinCreators,
  normalizePartnerItems,
  normalizeXiaohongshuNotes,
  safeRemoteUrl,
} from './normalizer.mjs';

test('only accepts HTTPS platform profile URLs and returns direct canonical URLs', () => {
  assert.equal(isProfileSourceUrl('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/abc?x=1#top'), 'https://www.xiaohongshu.com/user/profile/abc');
  assert.equal(isProfileSourceUrl('douyin', 'https://www.iesdouyin.com/share/user/creator-1?from=share'), 'https://www.douyin.com/user/creator-1');
  assert.equal(isProfileSourceUrl('xiaohongshu', 'https://www.xiaohongshu.com/explore/note-id'), '');
  assert.equal(isProfileSourceUrl('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/abc/notes'), '');
  assert.equal(isProfileSourceUrl('douyin', 'https://www.douyin.com/video/123'), '');
  assert.equal(isProfileSourceUrl('douyin', 'https://www.douyin.com/user/creator/videos'), '');
  assert.equal(isProfileSourceUrl('douyin', 'http://www.douyin.com/user/abc'), '');
  assert.equal(isProfileSourceUrl('douyin', 'https://app.douyin.com/user/abc'), '');
  assert.equal(isProfileSourceUrl('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/%E0%A4%A'), '');
  assert.equal(safeRemoteUrl('javascript:alert(1)'), '');
});

test('canonical profile identity ignores query and fragment tokens', () => {
  const first = canonicalCreatorIdentity('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/creator-1?from=search#top');
  const second = canonicalCreatorIdentity('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/creator-1?from=share');
  assert.equal(first, 'xiaohongshu:creator-1');
  assert.equal(first, second);
});

test('douyin reserved navigation paths are never creator identities', () => {
  assert.equal(canonicalCreatorIdentity('douyin', 'https://www.douyin.com/user/self?from_nav=1'), '');
  assert.equal(canonicalCreatorIdentity('douyin', 'https://www.douyin.com/user/%73elf'), '');
});

test('rejects exact 5xx gateway error titles without rejecting normal creator names', () => {
  for (const title of [
    '502 Bad Gateway',
    '504 Gateway Time-out',
    '503 Service Unavailable',
    '500 Internal Server Error',
    '502 \u7f51\u5173\u9519\u8bef',
    '504 \u7f51\u5173\u8d85\u65f6',
  ]) {
    assert.equal(isUsableCreatorName(title), false, title);
  }
  assert.equal(isUsableCreatorName('Bad Gateway \u7f8e\u5986\u6d4b\u8bc4'), true);
  assert.equal(isUsableCreatorName('\u7f51\u5173\u9519\u8bef\u4fee\u590d\u5b98'), true);
});

test('xiaohongshu records require a real profile source and group samples', () => {
  const creators = normalizeXiaohongshuNotes([
    {
      author: { nickname: 'Alice' },
      author_profile: 'https://www.xiaohongshu.com/user/profile/alice',
      title: 'skin routine',
      like_count: '1.2w',
      collect_count: '30',
    },
    {
      author: { nickname: 'Alice' },
      author_profile: 'https://www.xiaohongshu.com/user/profile/alice?source=search',
      title: 'night routine',
      comment_count: '25',
    },
    {
      author: { nickname: 'Not a profile' },
      author_profile: 'https://www.xiaohongshu.com/explore/note-123',
    },
  ], 'skin', 'browser_relay');

  assert.equal(creators.length, 1);
  assert.equal(creators[0].name, 'Alice');
  assert.equal(creators[0].sampleCount, 2);
  assert.equal(creators[0].identityKey, 'xiaohongshu:alice');
  assert.equal(creators[0].interactions, 12055);
});

test('douyin official response derives a creator profile from sec_uid', () => {
  const creators = normalizeDouyinCreators([{
    aweme_info: {
      author: { nickname: 'Douyin Creator', sec_uid: 'MS4wLjABAAAA-test' },
      desc: 'beauty review',
      profile: { metrics: { followers: '10.5万', likes: '22.5万' } },
      statistics: { digg_count: 84 },
    },
  }], 'beauty', 'official_api');

  assert.equal(creators.length, 1);
  assert.equal(creators[0].sourceUrl, 'https://www.douyin.com/user/MS4wLjABAAAA-test');
  assert.equal(creators[0].identityKey, 'douyin:MS4wLjABAAAA-test');
  assert.equal(creators[0].source, 'official_api');
  assert.equal(creators[0].followers, 105000);
  assert.equal(creators[0].profileLikes, 225000);
});

test('douyin search cards split compacted profile labels into public account signals', () => {
  const creators = normalizeDouyinCreators([{
    author: {
      nickname: '\u6fb3\u5170\u9edb\u62a4\u80a4\u65d7\u8230\u5e97\u8ba4\u8bc1\u5fbd\u7ae0\u65d7\u8230\u5e97\u8d26\u53f7\u5173\u6ce8\u6296\u97f3\u53f7: Aocilenda 15878450074292.0\u4e07\u83b7\u8d5e566.0\u4e07\u7c89\u4e1d',
    },
    source_profile_url: 'https://www.douyin.com/user/search-card-creator',
    body: '\u6fb3\u5170\u9edb\u62a4\u80a4\u65d7\u8230\u5e97 4292.0\u4e07\u83b7\u8d5e 566.0\u4e07\u7c89\u4e1d',
  }], '\u62a4\u80a4', 'browser_relay');

  assert.equal(creators.length, 1);
  assert.equal(creators[0].name, '\u6fb3\u5170\u9edb\u62a4\u80a4\u65d7\u8230\u5e97');
  assert.equal(creators[0].followers, 5660000);
  assert.equal(creators[0].profileLikes, 42920000);
});

test('douyin xiaozhao search card keeps account metrics and rejects the search page as content', () => {
  const compactLabel = '小赵哥达人关注抖音号: jingjing_lang22.5万获赞10.5万粉丝小赵哥 （抖音达人）小赵哥达人';
  const searchUrl = 'https://www.douyin.com/search/%E6%8A%A4%E8%82%A4%20%E8%BE%BE%E4%BA%BA';
  const creators = normalizeDouyinCreators([{
    author: { nickname: compactLabel },
    observed_name: compactLabel,
    author_profile: 'https://www.douyin.com/user/MS4wLjABAAAAlit400ii28GJksTF7YDhD9SaxAyqXtwjJaJjfQDkFoo',
    note_url: searchUrl,
    body: '小赵哥达人 关注 抖音号: jingjing_lang22.5万获赞10.5万粉丝 小赵哥 （抖音达人）',
    latest_samples: [{ note_url: searchUrl, published_at_text: '22.5' }],
    profile: { latest_samples: [{ note_url: searchUrl, published_at_text: '22.5' }] },
  }], '护肤', 'browser_relay');

  assert.equal(creators.length, 1);
  assert.equal(creators[0].name, '小赵哥达人');
  assert.equal(creators[0].handle, 'jingjing_lang');
  assert.equal(creators[0].followers, 105000);
  assert.equal(creators[0].profileLikes, 225000);
  assert.equal(creators[0].sampleCount, 0);
  assert.equal(creators[0].niche, '内容方向待补充');
});

test('bilibili profiles normalize to a canonical space URL and retain visible video samples', () => {
  const creators = normalizeBilibiliCreators([{
    owner: { name: 'Bili Creator', mid: '7788', follower_count: '12.5w' },
    latest_samples: [
      { title: 'Review one', url: 'https://www.bilibili.com/video/BV1fixture' },
      { title: 'Review two', url: 'https://www.bilibili.com/video/BV2fixture' },
    ],
    stat: { view: 356 },
  }], 'review');

  assert.equal(creators.length, 1);
  assert.equal(creators[0].sourceUrl, 'https://space.bilibili.com/7788');
  assert.equal(creators[0].identityKey, 'bilibili:7788');
  assert.equal(creators[0].sampleCount, 2);
  assert.equal(creators[0].followers, 125000);
});

test('discovery normalizers discard gateway error pages rather than emitting creators', () => {
  const xiaohongshu = normalizeXiaohongshuNotes([{
    author: { nickname: '502 Bad Gateway' },
    author_profile: 'https://www.xiaohongshu.com/user/profile/error-page',
    title: 'gateway response',
  }, {
    author: { nickname: 'Alice' },
    author_profile: 'https://www.xiaohongshu.com/user/profile/alice',
    title: 'skin routine',
  }], 'skin');
  assert.deepEqual(xiaohongshu.map((creator) => creator.name), ['Alice']);

  const douyin = normalizeDouyinCreators([{
    author: { nickname: '504 Gateway Time-out', sec_uid: 'error-page' },
  }, {
    author: { nickname: 'Douyin Creator', sec_uid: 'creator-a' },
  }], 'beauty');
  assert.deepEqual(douyin.map((creator) => creator.name), ['Douyin Creator']);

  const partner = normalizePartnerItems('douyin', [{
    name: '503 Service Unavailable',
    profile_url: 'https://www.douyin.com/user/error-page',
  }, {
    name: 'Partner Creator',
    profile_url: 'https://www.douyin.com/user/partner-creator',
  }], 'beauty');
  assert.deepEqual(partner.map((creator) => creator.name), ['Partner Creator']);
});

test('partner items and dedupe keep only usable account identities', () => {
  const creators = normalizePartnerItems('douyin', [
    { name: 'Unsafe', profile_url: 'https://example.com/user/unsafe' },
    { name: 'Creator', profile_url: 'https://www.douyin.com/user/creator' },
    { name: 'Creator duplicate', profile_url: 'https://www.douyin.com/user/creator?from=search' },
  ], 'creator');

  assert.equal(creators.length, 2);
  assert.equal(dedupeCreators(creators).length, 1);
});
