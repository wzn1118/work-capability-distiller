import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDouyinCommentArchive,
  createCsv,
  enrichCommentRelationships,
  normalizeComment,
  parseMetric,
} from './scripts/build-douyin-comment-archive.mjs';

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-comment-archive-'));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await writeJson(path.join(inputDir, 'catalog.json'), {
    platform: 'douyin',
    account_name: 'fixture account',
    douyin_id: 'fixture-id',
    profile_url: 'https://www.douyin.com/user/fixture',
    public_video_count: 2,
    videos: [
      { video_id: '1001', url: 'https://www.douyin.com/video/1001', card_text: '12\n\nFirst video' },
      { video_id: '1002', url: 'https://www.douyin.com/video/1002', card_text: '34\n\nSecond video' },
    ],
  });
  await writeJson(path.join(inputDir, 'comments', '1001.json'), {
    schema_version: 2,
    video_id: '1001',
    video_title: 'First video',
    video_url: 'https://www.douyin.com/video/1001',
    video_publish_time: '2026-08-01 12:00',
    completeness: {
      declared_comment_count: 2,
      captured_comment_count: 2,
      end_marker: true,
      remaining_expand_buttons: [],
      status: 'complete',
    },
    comments: [
      {
        comment_id: 'c-1',
        root_comment_id: 'c-1',
        relation_type: 'root',
        comment_user: 'Alice',
        comment_user_raw: 'Alice\n作者',
        comment_user_url: 'https://www.douyin.com/user/alice',
        comment_content: '=formula-looking comment',
        comment_likes_raw: '1.2万',
        comment_time_location: '2天前·浙江',
        is_video_author: true,
        video_author_replied: false,
        is_reply: false,
      },
      {
        comment_id: 'c-2',
        parent_comment_id: 'c-1',
        root_comment_id: 'c-1',
        relation_type: 'reply_to_root',
        comment_user: 'Bob',
        comment_user_url: 'https://www.douyin.com/user/bob',
        comment_content: 'reply, with comma',
        comment_likes: 3,
        comment_likes_raw: '3',
        comment_time: '1天前',
        comment_location: '上海',
        comment_time_location: '1天前·上海',
        is_reply: true,
      },
    ],
  });
  await writeJson(path.join(inputDir, 'metadata', '1001.json'), {
    metadata: {
      video_id: '1001',
      video_title: 'First video',
      video_publish_time: '2026-08-01 12:00',
      declared_comment_count: 2,
    },
  });
  await writeJson(path.join(inputDir, 'comments', '1002.json'), {
    schema_version: 1,
    video_id: '1002',
    completeness: {
      declared_comment_count: 3,
      captured_comment_count: 1,
      end_marker: true,
      remaining_expand_buttons: [],
      status: 'public_api_complete_with_gap',
      traversal_status: 'public_api_traversal_complete',
      root_pagination_exhausted: true,
      reply_pagination_exhausted: true,
    },
    comments: [
      {
        comment_id: 'old-1',
        author_name: 'Legacy user',
        author_name_raw: 'Legacy user',
        author_url: 'https://www.douyin.com/user/legacy',
        text: 'legacy text',
        like_count_raw: '8',
        time_location: '3月前·北京',
        is_author: false,
        author_replied: true,
        is_reply: false,
      },
    ],
  });
  await writeJson(path.join(inputDir, 'metadata', '1002.json'), {
    metadata: {
      video_id: '1002',
      url: 'https://www.douyin.com/video/1002',
      description: 'Second video',
      publish_time_raw: '发布时间：2026-07-01 09:30',
      declared_comment_count: 3,
    },
  });
  return { root, inputDir, outputDir };
}

test('metric and legacy comment normalization preserve requested fields', () => {
  assert.equal(parseMetric('1.2万'), 12000);
  assert.equal(parseMetric('3,456'), 3456);
  assert.equal(parseMetric('2.5k'), 2500);
  assert.equal(parseMetric(''), null);

  const comment = normalizeComment({
    author_name: 'Legacy',
    author_name_raw: 'Legacy raw',
    author_url: 'https://www.douyin.com/user/legacy',
    text: 'text',
    like_count_raw: '12',
    time_location: '5天前·江苏',
    is_author: true,
    author_replied: true,
  }, {
    video_id: 'v1',
    video_title: 'title',
    video_url: 'https://www.douyin.com/video/v1',
    video_publish_time: 'publish time',
  });
  assert.equal(comment.comment_user, 'Legacy');
  assert.equal(comment.comment_likes, 12);
  assert.equal(comment.comment_time, '5天前');
  assert.equal(comment.comment_location, '江苏');
  assert.equal(comment.is_video_author, true);
  assert.equal(comment.video_author_replied, true);
  assert.equal(comment.video_id, 'v1');
});

test('relationship enrichment preserves API roots and separates direct-parent from ancestor gaps', () => {
  const rows = [
    { comment_id: 'root', root_comment_id: 'root', parent_comment_id: '', is_reply: false, comment_user: 'Root', comment_content: 'root' },
    { comment_id: 'child', root_comment_id: 'root', parent_comment_id: 'missing', is_reply: true, comment_user: 'Child', comment_content: 'child' },
    { comment_id: 'grandchild', root_comment_id: 'root', parent_comment_id: 'child', is_reply: true, comment_user: 'Grandchild', comment_content: 'grandchild' },
  ];
  const enriched = enrichCommentRelationships(rows, {}, {});
  assert.equal(enriched[1].thread_root_comment_id, 'root');
  assert.equal(enriched[1].relationship_type, '回复其他回复');
  assert.equal(enriched[1].relationship_status, '直接父评论未采集');
  assert.equal(enriched[1].reply_depth, null);
  assert.equal(enriched[2].thread_root_comment_id, 'root');
  assert.equal(enriched[2].relationship_status, '祖先评论链不完整');
  assert.equal(enriched[2].reply_depth, null);
});

test('archive builder supports old and new schemas, reports public gaps, and leaves inputs unchanged', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const protectedPaths = [
    path.join(fixture.inputDir, 'catalog.json'),
    path.join(fixture.inputDir, 'comments', '1001.json'),
    path.join(fixture.inputDir, 'comments', '1002.json'),
    path.join(fixture.inputDir, 'metadata', '1001.json'),
    path.join(fixture.inputDir, 'metadata', '1002.json'),
  ];
  const before = await Promise.all(protectedPaths.map((filePath) => fs.readFile(filePath)));

  const result = await buildDouyinCommentArchive({
    inputDir: fixture.inputDir,
    outputDir: fixture.outputDir,
    now: () => new Date('2026-08-13T00:00:00.000Z'),
  });

  assert.equal(result.manifest.coverage.catalog_video_count, 2);
  assert.equal(result.manifest.coverage.comment_file_count, 2);
  assert.equal(result.manifest.coverage.metadata_file_count, 2);
  assert.equal(result.manifest.coverage.complete_video_count, 1);
  assert.equal(result.manifest.coverage.public_api_gap_video_count, 1);
  assert.equal(result.manifest.coverage.incomplete_video_count, 0);
  assert.equal(result.manifest.validation.archive_status, 'public_api_complete_with_gap');
  assert.equal(result.manifest.comments.total_comment_count, 3);
  assert.equal(result.manifest.comments.root_comment_count, 2);
  assert.equal(result.manifest.comments.reply_count, 1);
  assert.equal(result.manifest.comments.linked_reply_count, 1);
  assert.equal(result.manifest.comments.direct_parent_missing_reply_count, 0);
  assert.equal(result.manifest.comments.ancestor_chain_incomplete_reply_count, 0);

  const outputs = await fs.readdir(fixture.outputDir);
  assert.deepEqual(outputs.sort(), [
    'all-comments.csv',
    'all-comments.ndjson',
    'all-comments.xlsx',
    'collection-report.md',
    'manifest.json',
    'videos-summary.csv',
  ]);
  const csv = await fs.readFile(path.join(fixture.outputDir, 'all-comments.csv'), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /所属视频ID/);
  assert.match(csv, /'=formula-looking comment/);
  const ndjson = (await fs.readFile(path.join(fixture.outputDir, 'all-comments.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ndjson[0].comment_user_raw, 'Alice\n作者');
  assert.equal(ndjson[0].comment_likes, 12000);
  assert.equal(ndjson[0].video_title, 'First video');
  assert.equal(ndjson[1].thread_root_comment_id, 'c-1');
  assert.equal(ndjson[1].relationship_type, '回复根评论');
  assert.equal(ndjson[1].relationship_status, '已完整关联');
  assert.equal(ndjson[1].reply_depth, 1);
  assert.equal(ndjson[2].comment_user, 'Legacy user');
  assert.equal(ndjson[2].video_publish_time, '发布时间：2026-07-01 09:30');
  const report = await fs.readFile(path.join(fixture.outputDir, 'collection-report.md'), 'utf8');
  assert.match(report, /public_api_complete_with_gap=1/);

  const after = await Promise.all(protectedPaths.map((filePath) => fs.readFile(filePath)));
  before.forEach((buffer, index) => assert.deepEqual(after[index], buffer));
});

test('archive builder marks missing per-video files as incomplete', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.rm(path.join(fixture.inputDir, 'comments', '1002.json'));
  await fs.rm(path.join(fixture.inputDir, 'metadata', '1002.json'));

  const { manifest, videoSummaries } = await buildDouyinCommentArchive({
    inputDir: fixture.inputDir,
    outputDir: fixture.outputDir,
  });
  assert.equal(manifest.validation.archive_status, 'incomplete');
  assert.deepEqual(manifest.coverage.missing_comment_video_ids, ['1002']);
  assert.deepEqual(manifest.coverage.missing_metadata_video_ids, ['1002']);
  assert.equal(videoSummaries.find((video) => video.video_id === '1002').status, 'incomplete');
});

test('CSV generation quotes delimiters and protects formula-looking cells', () => {
  const csv = createCsv([{ value: 'hello,"world"\nnext', formula: '@SUM(A1:A2)' }], [
    ['Value', 'value'],
    ['Formula', 'formula'],
  ]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"hello,""world""\nnext"/);
  assert.match(csv, /'@SUM\(A1:A2\)/);
});
