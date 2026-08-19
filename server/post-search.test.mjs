import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePostSearchResults, normalizePostSearchComments, normalizePostSearchRecord, normalizePostSearchResults } from './post-search.mjs';
import { filterKnownSearchRecords, sampleFromCard } from './scripts/collect_douyin_relay.mjs';

test('preserves normalized content URLs when preparing a send request', () => {
  const post = normalizePostSearchRecord({
    id: 'post-1',
    contentUrl: 'https://www.douyin.com/video/123456789',
    authorName: 'Creator A',
    title: 'Coffee review',
  }, 'coffee');
  assert.equal(post.contentUrl, 'https://www.douyin.com/video/123456789');
});

test('normalizes visible post fields and interaction metrics', () => {
  const [post] = normalizePostSearchResults([{
    author_profile: 'https://www.douyin.com/user/creator-1',
    observed_name: '测试作者',
    latest_samples: [{
      note_url: 'https://www.douyin.com/video/abc123',
      title: '内容标题',
      body: '内容摘要',
      cover_url: 'https://p3.douyinpic.com/cover.jpg',
      statistics: { digg_count: 1200, collect_count: 77, comment_count: 42, share_count: 13, play_count: 8900 },
      hashtags: ['话题A'],
    }],
  }], '内容关键词', 'https://www.douyin.com/search/内容关键词?type=general');

  assert.equal(post.authorName, '测试作者');
  assert.equal(post.title, '内容标题');
  assert.equal(post.contentUrl, 'https://www.douyin.com/video/abc123');
  assert.equal(post.metrics.likes, 1200);
  assert.equal(post.metrics.comments, 42);
  assert.equal(post.metrics.shares, 13);
  assert.equal(post.metrics.collects, 77);
  assert.equal(post.metrics.plays, 8900);
  assert.deepEqual(post.tags, ['话题A']);
});

test('deduplicates the same post across raw and latest sample records', () => {
  const posts = normalizePostSearchResults([
    { author: { nickname: '作者' }, author_profile: 'https://www.douyin.com/user/creator-1', note_url: 'https://www.douyin.com/video/abc123', title: '标题' },
    { author_profile: 'https://www.douyin.com/user/creator-1', latest_samples: [{ note_url: 'https://www.douyin.com/video/abc123', title: '标题' }] },
  ]);
  assert.equal(posts.length, 1);
});

test('normalizes multi-image content and bounded video keyframes', () => {
  const post = normalizePostSearchRecord({
    note_url: 'https://www.douyin.com/note/image-note-1',
    image_urls: [
      'https://p3.douyinpic.com/cover-1.jpg',
      'https://p3.douyinpic.com/cover-2.jpg',
      'https://example.com/not-allowed.jpg',
    ],
    video_frames: [
      { index: 1, time_seconds: 0.5, url: 'https://p3.douyinpic.com/frame-1.jpg', ocr_text: 'Opening' },
      { index: 2, time_seconds: 2, url: 'https://p3.douyinpic.com/frame-2.jpg' },
      { index: 3, time_seconds: 4, url: 'https://p3.douyinpic.com/frame-3.jpg' },
      { index: 4, time_seconds: 6, url: 'https://p3.douyinpic.com/frame-4.jpg' },
      { index: 5, time_seconds: 8, url: 'https://p3.douyinpic.com/frame-5.jpg' },
    ],
  });
  assert.deepEqual(post.imageUrls, [
    'https://p3.douyinpic.com/cover-1.jpg',
    'https://p3.douyinpic.com/cover-2.jpg',
  ]);
  assert.equal(post.imageCount, 2);
  assert.equal(post.videoFrames.length, 4);
  assert.equal(post.videoFrames[0].ocrText, 'Opening');
});

test('normalizes a public video playback URL separately from the post URL', () => {
  const post = normalizePostSearchRecord({
    note_url: 'https://www.douyin.com/video/video-with-playback',
    has_video: true,
    video_url: 'https://p3-dy.byteimg.com/aweme/video.mp4?expires=123&signature=abc',
  });
  assert.equal(post.hasVideo, true);
  assert.equal(post.videoUrl, 'https://p3-dy.byteimg.com/aweme/video.mp4?expires=123&signature=abc');
});

test('retains card media fields when converting relay search cards to samples', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/card-with-playback',
    image_urls: ['https://p3.douyinpic.com/cover.jpg'],
    video_url: 'https://v3-dy.bytecdn.cn/aweme/video.mp4?expires=123&signature=abc',
    has_video: true,
  });
  assert.deepEqual(sample.image_urls, ['https://p3.douyinpic.com/cover.jpg']);
  assert.equal(sample.video_url, 'https://v3-dy.bytecdn.cn/aweme/video.mp4?expires=123&signature=abc');
});

test('does not treat a Douyin search page as a playback source', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/card-without-playback',
    video_url: 'https://www.douyin.com/search/%E7%9F%AD%E5%8F%91%E5%A5%B3?type=general',
    has_video: true,
  });
  assert.equal(sample.video_url, '');
});

test('promotes cards with a visible duration to video samples', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/card-with-duration',
    body: '00:12 2.1万 short video',
    content_type: 'image_or_note',
    duration_seconds: 12,
  });
  assert.equal(sample.content_type, 'video');
  assert.equal(sample.content_format, 'video');
  assert.equal(sample.has_video, true);
  assert.equal(sample.duration_seconds, 12);
});

test('parses clock durations and leading Douyin interaction counts from relay cards', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/card-with-text-duration',
    body: '00:27 14.3\u4e07 short video',
    duration_text: '00:27',
    content_type: 'image_or_note',
  });
  assert.equal(sample.content_type, 'video');
  assert.equal(sample.duration_seconds, 27);
  assert.equal(sample.statistics.digg_count, '14.3\u4e07');
});

test('retains all public interaction statistics from a relay card', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/card-with-all-statistics',
    statistics: {
      digg_count: '1200',
      comment_count: '42',
      share_count: '13',
      collect_count: '77',
      play_count: '8900',
    },
  });
  assert.deepEqual(sample.statistics, {
    digg_count: '1200',
    collect_count: '77',
    comment_count: '42',
    share_count: '13',
    play_count: '8900',
  });
});

test('keeps enriched latest sample media and duration when outer profile record repeats the URL', () => {
  const [post] = normalizePostSearchResults([{
    author: { nickname: 'Creator' },
    author_profile: 'https://www.douyin.com/user/creator-1',
    note_url: 'https://www.douyin.com/video/enriched-1',
    title: 'Outer card',
    latest_samples: [{
      note_url: 'https://www.douyin.com/video/enriched-1',
      video_url: 'https://v3-dy.bytecdn.cn/aweme/video.mp4?signature=abc',
      duration_text: '00:27',
      statistics: { digg_count: '14.3\u4e07' },
    }],
  }]);
  assert.equal(post.videoUrl, 'https://v3-dy.bytecdn.cn/aweme/video.mp4?signature=abc');
  assert.equal(post.hasVideo, true);
  assert.equal(post.durationSeconds, 27);
  assert.equal(post.metrics.likes, 143000);
});

test('keeps image notes as image samples even when their post path uses video', () => {
  const sample = sampleFromCard({
    note_url: 'https://www.douyin.com/video/image-note-path',
    body: '图文 6.4万 image note',
    content_type: 'image_or_note',
  });
  assert.equal(sample.content_type, 'image_or_note');
  assert.equal(sample.has_video, false);
});

test('rejects a post without a public post URL for send validation', () => {
  const post = normalizePostSearchRecord({ authorName: '作者', title: '只有标题' });
  assert.equal(post.contentUrl, '');
  assert.equal(post.title, '只有标题');
});

test('normalizes and bounds hot comments to the ten most-liked entries', () => {
  const comments = normalizePostSearchComments([
    ...Array.from({ length: 12 }, (_, index) => ({
      comment_id: `comment-${index}`,
      author_name: `用户${index}`,
      text: `评论内容${index}`,
      like_count: index === 11 ? 1 : index * 10,
      reply_count: index,
    })),
  ], 10);
  assert.equal(comments.length, 10);
  assert.equal(comments[0].authorName, '用户10');
  assert.equal(comments[0].rank, 1);
  assert.equal(comments.at(-1).authorName, '用户1');
  assert.equal(comments.at(-1).likeCount, 10);
});

test('keeps only unseen search samples when resuming from a checkpoint', () => {
  const records = [{
    author_profile: 'https://www.douyin.com/user/creator-1',
    latest_samples: [
      { note_url: 'https://www.douyin.com/video/already-saved', title: 'Old' },
      { note_url: 'https://www.douyin.com/video/new-result', title: 'New' },
    ],
  }];
  const filtered = filterKnownSearchRecords(records, ['https://www.douyin.com/video/already-saved?modal_id=1']);
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].latest_samples.map((sample) => sample.note_url), [
    'https://www.douyin.com/video/new-result',
  ]);
});

test('retains per-post top comments in the normalized search snapshot', () => {
  const [post] = normalizePostSearchResults([{
    note_url: 'https://www.douyin.com/video/commented-post',
    comments: [
      { comment_id: 'low', author_name: 'Low', text: 'low', like_count: 2 },
      { comment_id: 'high', author_name: 'High', text: 'high', like_count: 20 },
    ],
  }], 'topic');
  assert.equal(post.comments.length, 2);
  assert.equal(post.comments[0].authorName, 'High');
  assert.equal(post.comments[0].rank, 1);
});

test('merges continuation results into the same ordered search snapshot', () => {
  const existing = normalizePostSearchResults([
    { note_url: 'https://www.douyin.com/video/existing', title: 'Existing', comments: [{ id: 'c1', text: 'old', like_count: 2 }] },
  ], 'topic');
  const incoming = normalizePostSearchResults([
    { note_url: 'https://www.douyin.com/video/existing', title: 'Existing refreshed', likes: 88 },
    { note_url: 'https://www.douyin.com/video/new', title: 'New result' },
  ], 'topic');
  const merged = mergePostSearchResults(existing, incoming);
  assert.deepEqual(merged.map((post) => post.contentUrl), [
    'https://www.douyin.com/video/existing',
    'https://www.douyin.com/video/new',
  ]);
  assert.equal(merged[0].title, 'Existing refreshed');
  assert.equal(merged[0].metrics.likes, 88);
});
