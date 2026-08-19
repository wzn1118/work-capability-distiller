import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

export const DEFAULT_INPUT_DIR = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';

const OUTPUT_FILES = Object.freeze({
  commentsXlsx: 'all-comments.xlsx',
  commentsCsv: 'all-comments.csv',
  commentsNdjson: 'all-comments.ndjson',
  videosCsv: 'videos-summary.csv',
  manifest: 'manifest.json',
  report: 'collection-report.md',
});

const COMMENT_COLUMNS = Object.freeze([
  ['评论ID', 'comment_id', 'text', '平台评论唯一标识。'],
  ['父评论ID', 'parent_comment_id', 'text', '回复所指向的直接父评论；根评论为空。'],
  ['线程根评论ID', 'thread_root_comment_id', 'text', '接口返回的评论线程根节点；即使中间父评论未返回也保留。'],
  ['关系类型', 'relationship_type', 'text', '根评论、回复根评论或回复其他回复。'],
  ['关系完整性', 'relationship_status', 'text', '根评论、已完整关联、直接父评论未采集、祖先评论链不完整或关系循环。'],
  ['回复层级', 'reply_depth', 'number', '根评论为 0；完整关系链按层级递增；链不完整时为空。'],
  ['父评论用户', 'parent_comment_user', 'text', '已采集父评论的用户名称。'],
  ['父评论内容', 'parent_comment_content', 'text', '已采集父评论的评论内容。'],
  ['评论用户', 'comment_user', 'text', '评论用户显示名称。'],
  ['用户原始信息', 'comment_user_raw', 'text', '页面采集到的原始用户文本。'],
  ['评论用户URL', 'comment_user_url', 'text', '评论用户公开主页地址。'],
  ['评论内容', 'comment_content', 'text', '评论正文；图片或贴纸评论可能为空。'],
  ['评论点赞数', 'comment_likes', 'number', '标准化后的点赞数。'],
  ['评论点赞原文', 'comment_likes_raw', 'text', '页面显示的点赞数原文。'],
  ['评论时间', 'comment_time', 'text', '页面显示的相对或绝对时间文本。'],
  ['评论地点', 'comment_location', 'text', '页面公开显示的 IP 属地。'],
  ['评论时间地点原文', 'comment_time_location', 'text', '页面采集到的时间与地点组合原文。'],
  ['评论标签', 'comment_tags', 'text', '作者赞过、作者回复过等公开标签，JSON 数组。'],
  ['评论图片URL', 'comment_image_urls', 'text', '评论图片或贴纸地址，JSON 数组。'],
  ['是否视频作者', 'is_video_author', 'boolean', '评论用户是否为视频作者。'],
  ['视频作者是否回复', 'video_author_replied', 'boolean', '该评论是否带有作者回复标记。'],
  ['所属视频ID', 'video_id', 'text', '评论所属视频唯一标识。'],
  ['所属视频标题', 'video_title', 'text', '评论所属视频标题。'],
  ['所属视频URL', 'video_url', 'text', '评论所属视频公开地址。'],
  ['视频发布时间', 'video_publish_time', 'text', '页面显示的视频发布时间。'],
  ['所属视频声明评论数', 'declared_comment_count', 'number', '平台在视频页面声明的评论总数。'],
  ['所属视频采集评论数', 'captured_comment_count', 'number', '该视频文件中去重后的已采集评论数。'],
  ['所属视频根评论数', 'root_comment_count', 'number', '该视频已采集的根评论数。'],
  ['所属视频回复数', 'reply_count', 'number', '该视频已采集的回复数。'],
  ['所属视频数量一致', 'count_matches_declared', 'boolean', '采集数是否与平台声明数一致。'],
  ['所属视频到达末尾', 'end_marker', 'boolean', '采集时页面是否显示评论末尾。'],
  ['所属视频完整性状态', 'video_completeness_status', 'text', 'complete、public_api_complete_with_gap 或 incomplete。'],
  ['采集时间', 'source_collected_at', 'datetime', '该视频评论文件记录的采集时间。'],
  ['源评论文件', 'source_comments_file', 'text', '相对于归档目录的评论 JSON 路径。'],
  ['源数据版本', 'source_schema_version', 'text', '评论 JSON 的 schema_version。'],
]);

const VIDEO_COLUMNS = Object.freeze([
  ['视频ID', 'video_id', 'text', '视频唯一标识。'],
  ['视频标题', 'video_title', 'text', '视频标题。'],
  ['视频URL', 'video_url', 'text', '视频公开地址。'],
  ['视频发布时间', 'video_publish_time', 'text', '页面显示的视频发布时间。'],
  ['评论文件', 'comments_file', 'text', '相对于归档目录的评论 JSON 路径。'],
  ['元数据文件', 'metadata_file', 'text', '相对于归档目录的元数据 JSON 路径。'],
  ['评论文件状态', 'comments_file_exists', 'text', '目录中该视频评论 JSON 的存在状态：已存在或缺失。'],
  ['元数据文件状态', 'metadata_file_exists', 'text', '目录中该视频元数据 JSON 的存在状态：已存在或缺失。'],
  ['声明评论数', 'declared_comment_count', 'number', '平台在视频页面声明的评论总数。'],
  ['实际采集评论数', 'captured_comment_count', 'number', '去重后的已采集评论数。'],
  ['根评论数', 'root_comment_count', 'number', '已采集根评论数。'],
  ['回复数', 'reply_count', 'number', '已采集回复数。'],
  ['声明数差值', 'declared_minus_captured', 'number', '声明评论数减去实际采集评论数。'],
  ['数量一致', 'count_matches_declared', 'boolean', '采集数是否与声明数一致。'],
  ['到达评论末尾', 'end_marker', 'boolean', '采集时页面是否显示评论末尾。'],
  ['剩余展开按钮数', 'remaining_expand_button_count', 'number', '采集结束时仍可见的回复展开按钮数。'],
  ['完整性状态', 'status', 'text', 'complete、public_api_complete_with_gap 或 incomplete。'],
  ['源文件状态', 'source_status', 'text', '评论源文件记录的完整性状态。'],
  ['重复评论ID数', 'duplicate_comment_count', 'number', '该视频被去重的重复评论 ID 数量。'],
  ['采集时间', 'source_collected_at', 'datetime', '评论源文件记录的采集时间。'],
  ['源数据版本', 'source_schema_version', 'text', '评论 JSON 的 schema_version。'],
  ['读取错误', 'read_error', 'text', '评论或元数据 JSON 读取错误。'],
]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function toText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = toText(value).toLowerCase();
  return ['true', '1', 'yes', 'y'].includes(text);
}

function toInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

export function parseMetric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  const text = toText(value).replaceAll(',', '');
  if (!text) return null;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(亿|万|千|[kKmM])?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multipliers = { 亿: 100000000, 万: 10000, 千: 1000, k: 1000, K: 1000, m: 1000000, M: 1000000 };
  return Math.max(0, Math.round(base * (multipliers[match[2]] || 1)));
}

function splitTimeLocation(rawValue, explicitTime, explicitLocation) {
  const raw = toText(rawValue);
  const parts = raw.split('·').map((part) => part.trim()).filter(Boolean);
  return {
    raw,
    time: toText(firstDefined(explicitTime, parts[0])),
    location: toText(firstDefined(explicitLocation, parts.slice(1).join('·'))),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(toText).filter(Boolean);
}

export function normalizeComment(source, video) {
  const timeLocation = splitTimeLocation(
    firstDefined(source.comment_time_location, source.time_location),
    source.comment_time,
    source.comment_location,
  );
  const likesRaw = toText(firstDefined(source.comment_likes_raw, source.like_count_raw));
  const likes = firstDefined(toInteger(source.comment_likes), parseMetric(likesRaw), 0);

  return {
    comment_id: toText(source.comment_id),
    parent_comment_id: toText(source.parent_comment_id),
    root_comment_id: toText(source.root_comment_id),
    source_relation_type: toText(source.relation_type),
    is_reply: toBoolean(source.is_reply),
    comment_user: toText(firstDefined(source.comment_user, source.author_name)),
    comment_user_url: toText(firstDefined(source.comment_user_url, source.author_url)),
    comment_user_raw: toText(firstDefined(source.comment_user_raw, source.author_name_raw, source.comment_user, source.author_name)),
    comment_content: toText(firstDefined(source.comment_content, source.text)),
    comment_likes: likes,
    comment_likes_raw: likesRaw,
    comment_time: timeLocation.time,
    comment_location: timeLocation.location,
    comment_time_location: timeLocation.raw,
    comment_tags: normalizeStringArray(firstDefined(source.comment_tags, source.tags)),
    comment_image_urls: normalizeStringArray(firstDefined(source.comment_image_urls, source.image_urls)),
    is_video_author: toBoolean(firstDefined(source.is_video_author, source.is_author)),
    video_author_replied: toBoolean(firstDefined(source.video_author_replied, source.author_replied)),
    video_id: video.video_id,
    video_title: video.video_title,
    video_url: video.video_url,
    video_publish_time: video.video_publish_time,
  };
}

function cleanCardTitle(cardText) {
  const lines = toText(cardText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const content = lines.filter((line) => line !== '置顶' && !/^\d+(?:\.\d+)?(?:万|亿)?$/.test(line));
  return content.join(' ');
}

function normalizeVideo(catalogVideo, commentDocument, metadataDocument) {
  const metadata = metadataDocument?.metadata || metadataDocument || {};
  const videoId = toText(firstDefined(catalogVideo.video_id, commentDocument?.video_id, metadata.video_id));
  const pageTitle = toText(metadata.page_title).replace(/\s*-\s*抖音\s*$/, '');
  return {
    video_id: videoId,
    video_title: toText(firstDefined(
      commentDocument?.video_title,
      metadata.video_title,
      metadata.description,
      pageTitle,
      cleanCardTitle(firstDefined(metadata.video_card_text, metadata.card_text, catalogVideo.card_text)),
    )),
    video_url: toText(firstDefined(
      commentDocument?.video_url,
      metadata.video_url,
      metadata.url,
      catalogVideo.url,
      videoId && `https://www.douyin.com/video/${videoId}`,
    )),
    video_publish_time: toText(firstDefined(
      commentDocument?.video_publish_time,
      metadata.video_publish_time,
      metadata.publish_time_raw,
    )),
  };
}

function countRemainingExpandButtons(value) {
  if (Array.isArray(value)) return value.length;
  return toInteger(value) || 0;
}

function dedupeComments(comments) {
  const seenIds = new Set();
  const rows = [];
  let duplicateCount = 0;
  for (const row of comments) {
    if (row.comment_id) {
      if (seenIds.has(row.comment_id)) {
        duplicateCount += 1;
        continue;
      }
      seenIds.add(row.comment_id);
    }
    rows.push(row);
  }
  return { rows, duplicateCount };
}

export function enrichCommentRelationships(rows, videoSummary, commentDocument) {
  const rowsById = new Map(rows.filter((row) => row.comment_id).map((row) => [row.comment_id, row]));

  return rows.map((row) => {
    let relationshipStatus = '根评论';
    let threadRootCommentId = row.root_comment_id || row.comment_id;
    let replyDepth = 0;
    let parentCommentUser = '';
    let parentCommentContent = '';

    if (row.is_reply) {
      relationshipStatus = '直接父评论未采集';
      threadRootCommentId = row.root_comment_id || row.parent_comment_id;
      replyDepth = null;
      const immediateParent = rowsById.get(row.parent_comment_id);
      if (immediateParent) {
        parentCommentUser = immediateParent.comment_user;
        parentCommentContent = immediateParent.comment_content;
        relationshipStatus = '已完整关联';
        replyDepth = 1;
        let current = immediateParent;
        const visited = new Set([row.comment_id]);
        while (current?.is_reply) {
          if (!current.comment_id || visited.has(current.comment_id)) {
            relationshipStatus = '关系循环';
            break;
          }
          visited.add(current.comment_id);
          replyDepth += 1;
          if (!current.parent_comment_id) {
            relationshipStatus = '祖先评论链不完整';
            replyDepth = null;
            break;
          }
          const nextParent = rowsById.get(current.parent_comment_id);
          if (!nextParent) {
            relationshipStatus = '祖先评论链不完整';
            replyDepth = null;
            break;
          }
          current = nextParent;
        }
        if (!row.root_comment_id && current && !current.is_reply) threadRootCommentId = current.comment_id;
      }
    }

    const relationshipType = !row.is_reply
      ? '根评论'
      : row.parent_comment_id && row.parent_comment_id === threadRootCommentId
        ? '回复根评论'
        : '回复其他回复';

    return {
      ...row,
      thread_root_comment_id: threadRootCommentId,
      relationship_type: relationshipType,
      relationship_status: relationshipStatus,
      reply_depth: replyDepth,
      parent_comment_user: parentCommentUser,
      parent_comment_content: parentCommentContent,
      declared_comment_count: videoSummary.declared_comment_count,
      captured_comment_count: videoSummary.captured_comment_count,
      root_comment_count: videoSummary.root_comment_count,
      reply_count: videoSummary.reply_count,
      count_matches_declared: videoSummary.count_matches_declared,
      end_marker: videoSummary.end_marker,
      video_completeness_status: videoSummary.status,
      source_collected_at: toText(commentDocument?.collected_at),
      source_comments_file: videoSummary.comments_file,
      source_schema_version: toText(commentDocument?.schema_version),
    };
  });
}

function deriveCompleteness({ commentsFileExists, commentDocument, metadataDocument, rows, duplicateCount, readError }) {
  const sourceCompleteness = commentDocument?.completeness || metadataDocument?.completeness || {};
  const metadata = metadataDocument?.metadata || metadataDocument || {};
  const declared = firstDefined(
    toInteger(sourceCompleteness.declared_comment_count),
    toInteger(metadata.declared_comment_count),
    parseMetric(metadata.declared_comment_count_raw),
  );
  const captured = rows.length;
  const rootCount = rows.filter((row) => !row.is_reply).length;
  const replyCount = rows.filter((row) => row.is_reply).length;
  const remainingExpandCount = countRemainingExpandButtons(sourceCompleteness.remaining_expand_buttons);
  const endMarker = toBoolean(sourceCompleteness.end_marker);
  const sourceStatus = toText(sourceCompleteness.status);
  const countMatches = declared !== null && declared === captured;

  let status = 'incomplete';
  if (commentsFileExists && !readError && Array.isArray(commentDocument?.comments)) {
    if (countMatches && remainingExpandCount === 0) {
      status = 'complete';
    } else if (
      sourceStatus === 'public_api_complete_with_gap'
      && sourceCompleteness.traversal_status === 'public_api_traversal_complete'
      && sourceCompleteness.root_pagination_exhausted === true
      && sourceCompleteness.reply_pagination_exhausted === true
    ) {
      // The public API was fully paginated, but its returned totals can drift
      // from the platform's declared count. Preserve that distinction.
      status = 'public_api_complete_with_gap';
    } else if (declared !== null && captured < declared && endMarker && remainingExpandCount === 0) {
      status = 'public_api_complete_with_gap';
    }
  }

  return {
    declared_comment_count: declared,
    captured_comment_count: captured,
    root_comment_count: rootCount,
    reply_count: replyCount,
    declared_minus_captured: declared === null ? null : declared - captured,
    count_matches_declared: countMatches,
    end_marker: endMarker,
    remaining_expand_button_count: remainingExpandCount,
    status,
    source_status: sourceStatus,
    duplicate_comment_count: duplicateCount,
  };
}

function spreadsheetText(value) {
  const text = value && typeof value === 'object' ? JSON.stringify(value) : toText(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = spreadsheetText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createCsv(rows, columns) {
  const header = columns.map(([label]) => csvCell(label)).join(',');
  const body = rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

async function listJsonFiles(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return { value: JSON.parse(await fs.readFile(filePath, 'utf8')), error: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null, error: '' };
    return { value: null, error: `${error.name}: ${error.message}` };
  }
}

function safeCatalogVideos(catalog) {
  const seen = new Set();
  const duplicateIds = [];
  const videos = [];
  for (const source of Array.isArray(catalog.videos) ? catalog.videos : []) {
    const videoId = toText(source.video_id);
    if (!/^[A-Za-z0-9_-]+$/.test(videoId)) {
      throw new Error(`catalog.json contains an unsafe or empty video_id: ${JSON.stringify(videoId)}`);
    }
    if (seen.has(videoId)) {
      duplicateIds.push(videoId);
      continue;
    }
    seen.add(videoId);
    videos.push(source);
  }
  return { videos, duplicateIds };
}

function markdownCell(value) {
  return toText(value).replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function buildReport(manifest, videoSummaries) {
  const coverage = manifest.coverage;
  const comments = manifest.comments;
  const missingComments = coverage.missing_comment_video_ids.length ? coverage.missing_comment_video_ids.join(', ') : '无';
  const missingMetadata = coverage.missing_metadata_video_ids.length ? coverage.missing_metadata_video_ids.join(', ') : '无';
  const parseErrors = coverage.parse_errors.length
    ? coverage.parse_errors.map((item) => `- ${item.file}: ${item.error}`).join('\n')
    : '- 无';
  const lines = [
    '# 抖音评论归档校验报告',
    '',
    `- 生成时间：${manifest.generated_at}`,
    `- 账号：${manifest.account_name || '未知'}（${manifest.douyin_id || '未知'}）`,
    `- 归档状态：${manifest.validation.archive_status}`,
    `- Catalog 视频：${coverage.catalog_video_count}（声明公开作品数：${coverage.declared_public_video_count ?? '未知'}）`,
    `- 评论文件覆盖：${coverage.comment_file_count}/${coverage.catalog_video_count}`,
    `- 元数据文件覆盖：${coverage.metadata_file_count}/${coverage.catalog_video_count}`,
    `- 唯一评论：${comments.total_comment_count}（根评论 ${comments.root_comment_count}，回复 ${comments.reply_count}）`,
    `- 视频完整性：complete=${coverage.complete_video_count}，public_api_complete_with_gap=${coverage.public_api_gap_video_count}，incomplete=${coverage.incomplete_video_count}`,
    '',
    '## 覆盖缺口',
    '',
    `- 缺少评论文件的视频：${missingComments}`,
    `- 缺少元数据文件的视频：${missingMetadata}`,
    `- Catalog 重复视频 ID：${coverage.duplicate_catalog_video_ids.length ? coverage.duplicate_catalog_video_ids.join(', ') : '无'}`,
    `- 非 Catalog 评论文件：${coverage.orphan_comment_files.length ? coverage.orphan_comment_files.join(', ') : '无'}`,
    `- 非 Catalog 元数据文件：${coverage.orphan_metadata_files.length ? coverage.orphan_metadata_files.join(', ') : '无'}`,
    '',
    '## 读取错误',
    '',
    parseErrors,
    '',
    '## 每视频校验',
    '',
    '| 视频ID | 标题 | 声明 | 采集 | 根评论 | 回复 | 状态 |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...videoSummaries.map((video) => `| ${markdownCell(video.video_id)} | ${markdownCell(video.video_title)} | ${video.declared_comment_count ?? ''} | ${video.captured_comment_count} | ${video.root_comment_count} | ${video.reply_count} | ${video.status} |`),
    '',
    '> `public_api_complete_with_gap` 表示公开接口的根评论与全部回复线程均已分页到末页，但接口返回条数与平台声明数仍有差额；差额原因不从当前载荷推断。',
    '',
  ];
  return lines.join('\n');
}

async function writeOutput(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporaryPath, filePath);
}

function excelColumnName(oneBasedIndex) {
  let index = oneBasedIndex;
  let name = '';
  while (index > 0) {
    index -= 1;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}

function workbookCellValue(value, type) {
  if (value === undefined || value === null || value === '') return type === 'text' ? '' : null;
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === 'boolean') return toBoolean(value);
  if (type === 'datetime') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? spreadsheetText(value) : parsed;
  }
  return spreadsheetText(value);
}

function columnWidth(key) {
  const widths = {
    comment_id: 22,
    parent_comment_id: 22,
    thread_root_comment_id: 22,
    relationship_type: 10,
    relationship_status: 14,
    reply_depth: 10,
    parent_comment_user: 18,
    parent_comment_content: 36,
    comment_user: 18,
    comment_user_raw: 20,
    comment_user_url: 38,
    comment_content: 46,
    comment_likes: 12,
    comment_likes_raw: 14,
    comment_time: 16,
    comment_location: 12,
    comment_time_location: 20,
    comment_tags: 24,
    comment_image_urls: 38,
    is_video_author: 14,
    video_author_replied: 18,
    video_id: 22,
    video_title: 42,
    video_url: 38,
    video_publish_time: 22,
    declared_comment_count: 18,
    captured_comment_count: 18,
    root_comment_count: 16,
    reply_count: 14,
    count_matches_declared: 18,
    end_marker: 16,
    video_completeness_status: 32,
    source_collected_at: 24,
    source_comments_file: 30,
    source_schema_version: 14,
    comments_file: 30,
    metadata_file: 30,
    comments_file_exists: 16,
    metadata_file_exists: 16,
    declared_minus_captured: 16,
    remaining_expand_button_count: 18,
    status: 32,
    source_status: 32,
    duplicate_comment_count: 16,
    read_error: 34,
  };
  return widths[key] || 18;
}

function writeTabularSheet(workbook, { name, tableName, rows, columns, statusKey = '' }) {
  const sheet = workbook.worksheets.add(name);
  const matrix = [
    columns.map(([label]) => label),
    ...rows.map((row) => columns.map(([, key, type]) => workbookCellValue(row[key], type))),
  ];
  const rowCount = matrix.length;
  const columnCount = columns.length;
  const lastColumn = excelColumnName(columnCount);
  const usedRange = sheet.getRange(`A1:${lastColumn}${rowCount}`);
  usedRange.values = matrix;
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);

  if (rows.length > 0) {
    const table = sheet.tables.add(`A1:${lastColumn}${rowCount}`, true, tableName);
    table.style = 'TableStyleMedium2';
  }

  const header = sheet.getRange(`A1:${lastColumn}1`);
  header.format = {
    fill: '#0F766E',
    font: { bold: true, color: '#FFFFFF' },
    wrapText: true,
    verticalAlignment: 'center',
  };
  header.format.rowHeight = 34;

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const [, key, type] = columns[columnIndex];
    const columnRange = sheet.getRangeByIndexes(0, columnIndex, rowCount, 1);
    columnRange.format.columnWidth = columnWidth(key);
    if (type === 'text') columnRange.format.numberFormat = '@';
    if (type === 'datetime') columnRange.format.numberFormat = 'yyyy-mm-dd hh:mm:ss';
    if (type === 'number' && rows.length > 0) {
      sheet.getRangeByIndexes(1, columnIndex, rows.length, 1).format.numberFormat = '#,##0';
    }
  }

  if (rows.length > 0) {
    const body = sheet.getRangeByIndexes(1, 0, rows.length, columnCount);
    body.format.verticalAlignment = 'top';
    for (const key of ['parent_comment_content', 'comment_content', 'video_title', 'read_error']) {
      const columnIndex = columns.findIndex(([, columnKey]) => columnKey === key);
      if (columnIndex >= 0) sheet.getRangeByIndexes(1, columnIndex, rows.length, 1).format.wrapText = true;
    }
    body.format.autofitRows();
  }

  if (statusKey && rows.length > 0) {
    const statusIndex = columns.findIndex(([, key]) => key === statusKey);
    if (statusIndex >= 0) {
      const statusRange = sheet.getRangeByIndexes(1, statusIndex, rows.length, 1);
      statusRange.conditionalFormats.add('containsText', {
        text: 'public_api_complete_with_gap',
        format: { fill: '#FEF3C7', font: { color: '#92400E' } },
      });
      statusRange.conditionalFormats.add('containsText', {
        text: 'incomplete',
        format: { fill: '#FEE2E2', font: { color: '#991B1B' } },
      });
      statusRange.conditionalFormats.add('containsText', {
        text: 'complete',
        format: { fill: '#DCFCE7', font: { color: '#166534' } },
      });
    }
  }
  return sheet;
}

function columnFormulaRange(sheetName, key, columns, dataRowCount) {
  const columnIndex = columns.findIndex(([, columnKey]) => columnKey === key);
  if (columnIndex < 0) throw new Error(`Unknown workbook column: ${key}`);
  const column = excelColumnName(columnIndex + 1);
  return `'${sheetName}'!$${column}$2:$${column}$${Math.max(2, dataRowCount + 1)}`;
}

function createAuditSheet(workbook, manifest, allComments, videoSummaries) {
  const sheet = workbook.worksheets.add('采集审计');
  sheet.showGridLines = false;
  sheet.getRange('A1:F1').merge();
  sheet.getRange('A1').values = [['抖音评论采集归档审计']];
  sheet.getRange('A1:F1').format = {
    fill: '#134E4A',
    font: { bold: true, color: '#FFFFFF', size: 16 },
    verticalAlignment: 'center',
  };
  sheet.getRange('A1:F1').format.rowHeight = 30;
  sheet.getRange('A3:B20').values = [
    ['指标', '结果'],
    ['账号', spreadsheetText(manifest.account_name)],
    ['抖音号', spreadsheetText(manifest.douyin_id)],
    ['归档生成时间', manifest.generated_at],
    ['归档状态', manifest.validation.archive_status],
    ['Catalog 视频数', null],
    ['已有评论文件视频数', null],
    ['已有元数据文件视频数', null],
    ['评论总数', null],
    ['根评论数', null],
    ['回复数', null],
    ['已完整关联回复数', null],
    ['直接父评论未采集回复数', null],
    ['祖先评论链不完整回复数', null],
    ['数量完全一致视频数', null],
    ['公开接口遍历完成但有差额视频数', null],
    ['未完成视频数', null],
    ['重复评论ID数', manifest.comments.duplicate_comment_count],
  ];

  const commentsIdRange = columnFormulaRange('全部评论', 'comment_id', COMMENT_COLUMNS, allComments.length);
  const relationshipTypeRange = columnFormulaRange('全部评论', 'relationship_type', COMMENT_COLUMNS, allComments.length);
  const relationshipStatusRange = columnFormulaRange('全部评论', 'relationship_status', COMMENT_COLUMNS, allComments.length);
  const videoIdRange = columnFormulaRange('视频汇总', 'video_id', VIDEO_COLUMNS, videoSummaries.length);
  const commentsFileExistsRange = columnFormulaRange('视频汇总', 'comments_file_exists', VIDEO_COLUMNS, videoSummaries.length);
  const metadataFileExistsRange = columnFormulaRange('视频汇总', 'metadata_file_exists', VIDEO_COLUMNS, videoSummaries.length);
  const videoStatusRange = columnFormulaRange('视频汇总', 'status', VIDEO_COLUMNS, videoSummaries.length);
  sheet.getRange('B8:B19').formulas = [
    [`=COUNTA(${videoIdRange})`],
    [`=COUNTIF(${commentsFileExistsRange},"已存在")`],
    [`=COUNTIF(${metadataFileExistsRange},"已存在")`],
    [`=COUNTA(${commentsIdRange})`],
    [`=COUNTIF(${relationshipTypeRange},"根评论")`],
    [`=COUNTIF(${relationshipTypeRange},"回复根评论")+COUNTIF(${relationshipTypeRange},"回复其他回复")`],
    [`=COUNTIF(${relationshipStatusRange},"已完整关联")`],
    [`=COUNTIF(${relationshipStatusRange},"直接父评论未采集")`],
    [`=COUNTIF(${relationshipStatusRange},"祖先评论链不完整")`],
    [`=COUNTIF(${videoStatusRange},"complete")`],
    [`=COUNTIF(${videoStatusRange},"public_api_complete_with_gap")`],
    [`=COUNTIF(${videoStatusRange},"incomplete")`],
  ];

  sheet.getRange('D3:F7').values = [
    ['完整性状态', '视频数', '含义'],
    ['complete', null, '采集评论数与平台声明数一致。'],
    ['public_api_complete_with_gap', null, '公开接口全部分页到末页，但返回条数与平台声明数仍有差额。'],
    ['incomplete', null, '仍缺评论文件、尚未到末尾、存在读取错误或其他未完成条件。'],
    ['归档状态', manifest.validation.archive_status, '只有 107 个目录视频全部具备合格文件时才可视为完整归档。'],
  ];
  sheet.getRange('E4:E6').formulas = [
    [`=COUNTIF(${videoStatusRange},"complete")`],
    [`=COUNTIF(${videoStatusRange},"public_api_complete_with_gap")`],
    [`=COUNTIF(${videoStatusRange},"incomplete")`],
  ];

  sheet.getRange('D9:F15').values = [
    ['覆盖审计', '数量', 'ID/说明'],
    ['缺少评论文件', manifest.coverage.missing_comment_video_ids.length, manifest.coverage.missing_comment_video_ids.length ? '在“视频汇总”筛选“评论文件”为空的记录查看完整视频清单。' : '无'],
    ['缺少元数据文件', manifest.coverage.missing_metadata_video_ids.length, manifest.coverage.missing_metadata_video_ids.length ? '在“视频汇总”筛选“元数据文件”为空的记录查看完整视频清单。' : '无'],
    ['非 Catalog 评论文件', manifest.coverage.orphan_comment_files.length, manifest.coverage.orphan_comment_files.join(', ') || '无'],
    ['非 Catalog 元数据文件', manifest.coverage.orphan_metadata_files.length, manifest.coverage.orphan_metadata_files.join(', ') || '无'],
    ['JSON 读取错误', manifest.coverage.parse_errors.length, manifest.coverage.parse_errors.map((item) => `${item.file}: ${item.error}`).join(' | ') || '无'],
    ['Catalog 与声明数一致', manifest.coverage.catalog_count_matches_declared, `目录 ${manifest.coverage.catalog_video_count}，声明 ${manifest.coverage.declared_public_video_count ?? '未知'}`],
  ];

  for (const range of ['A3:B3', 'D3:F3', 'D9:F9']) {
    sheet.getRange(range).format = {
      fill: '#0F766E',
      font: { bold: true, color: '#FFFFFF' },
      wrapText: true,
    };
  }
  sheet.getRange('A4:A20').format.font = { bold: true, color: '#334155' };
  sheet.getRange('B6').format.numberFormat = 'yyyy-mm-dd hh:mm:ss';
  sheet.getRange('B8:B20').format.numberFormat = '#,##0';
  sheet.getRange('E4:E6').format.numberFormat = '#,##0';
  sheet.getRange('A1:F20').format.verticalAlignment = 'top';
  sheet.getRange('A1:F20').format.borders = { preset: 'outside', style: 'thin', color: '#CBD5E1' };
  sheet.getRange('D4:F20').format.wrapText = true;
  sheet.getRange('A:A').format.columnWidth = 28;
  sheet.getRange('B:B').format.columnWidth = 24;
  sheet.getRange('C:C').format.columnWidth = 3;
  sheet.getRange('D:D').format.columnWidth = 34;
  sheet.getRange('E:E').format.columnWidth = 36;
  sheet.getRange('F:F').format.columnWidth = 52;
  sheet.getRange('A1:F20').format.autofitRows();
  sheet.freezePanes.freezeRows(1);
  return sheet;
}

function createFieldGuideSheet(workbook) {
  const rows = [
    ...COMMENT_COLUMNS.map(([label, key, type, description]) => ({ sheet: '全部评论', label, key, type, description })),
    ...VIDEO_COLUMNS.map(([label, key, type, description]) => ({ sheet: '视频汇总', label, key, type, description })),
    { sheet: '采集审计', label: 'public_api_complete_with_gap', key: 'status', type: 'text', description: '公开接口的根评论和回复线程均已分页到末页，但返回条数与平台声明数仍有差额；不据此推断差额原因。' },
    { sheet: '采集审计', label: '评论时间', key: 'comment_time', type: 'text', description: '保留页面提供的相对时间或绝对时间；无可靠基准时不伪造绝对时间。' },
  ];
  const columns = [
    ['工作表', 'sheet', 'text', '字段所在工作表。'],
    ['显示列名/术语', 'label', 'text', '工作簿中的中文列名或审计术语。'],
    ['内部字段', 'key', 'text', '归档 JSON/脚本使用的字段名。'],
    ['数据类型', 'type', 'text', 'text、number、boolean 或 datetime。'],
    ['含义', 'description', 'text', '字段含义和完整性边界。'],
  ];
  const sheet = writeTabularSheet(workbook, {
    name: '字段说明',
    tableName: 'FieldGuideTable',
    rows,
    columns,
  });
  sheet.getRange(`E2:E${rows.length + 1}`).format.wrapText = true;
  sheet.getRange('A:A').format.columnWidth = 16;
  sheet.getRange('B:B').format.columnWidth = 28;
  sheet.getRange('C:C').format.columnWidth = 32;
  sheet.getRange('D:D').format.columnWidth = 12;
  sheet.getRange('E:E').format.columnWidth = 62;
  sheet.getRange(`A1:E${rows.length + 1}`).format.autofitRows();
  return sheet;
}

export function createDouyinCommentWorkbook({ manifest, allComments, videoSummaries }) {
  const workbook = Workbook.create();
  writeTabularSheet(workbook, {
    name: '全部评论',
    tableName: 'AllCommentsTable',
    rows: allComments,
    columns: COMMENT_COLUMNS,
    statusKey: 'video_completeness_status',
  });
  writeTabularSheet(workbook, {
    name: '视频汇总',
    tableName: 'VideosSummaryTable',
    rows: videoSummaries,
    columns: VIDEO_COLUMNS,
    statusKey: 'status',
  });
  createAuditSheet(workbook, manifest, allComments, videoSummaries);
  createFieldGuideSheet(workbook);
  return workbook;
}

async function cleanupWorkbookInspectArtifacts(filePath) {
  const outputDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const prefix = `${fileName}.tmp-`;
  const suffix = '.xlsx.inspect.ndjson';
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
    .map((entry) => fs.rm(path.join(outputDir, entry.name), { force: true })));
}

async function exportWorkbook(workbook, filePath) {
  await cleanupWorkbookInspectArtifacts(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`;
  const inspectPath = `${temporaryPath}.inspect.ndjson`;
  try {
    const output = await SpreadsheetFile.exportXlsx(workbook);
    await output.save(temporaryPath);
    await fs.rm(filePath, { force: true });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(inspectPath, { force: true });
  }
}

export async function buildDouyinCommentArchive({ inputDir = DEFAULT_INPUT_DIR, outputDir = inputDir, now = () => new Date() } = {}) {
  const resolvedInputDir = path.resolve(inputDir);
  const resolvedOutputDir = path.resolve(outputDir);
  const catalogPath = path.join(resolvedInputDir, 'catalog.json');
  const catalogResult = await readJson(catalogPath);
  if (catalogResult.error) throw new Error(`Unable to read catalog.json: ${catalogResult.error}`);
  if (!catalogResult.value) throw new Error(`catalog.json was not found at ${catalogPath}`);

  const catalog = catalogResult.value;
  const { videos: catalogVideos, duplicateIds: duplicateCatalogVideoIds } = safeCatalogVideos(catalog);
  const commentsDir = path.join(resolvedInputDir, 'comments');
  const metadataDir = path.join(resolvedInputDir, 'metadata');
  const [commentFileNames, metadataFileNames] = await Promise.all([
    listJsonFiles(commentsDir),
    listJsonFiles(metadataDir),
  ]);
  const commentFileSet = new Set(commentFileNames);
  const metadataFileSet = new Set(metadataFileNames);
  const catalogFileNames = new Set(catalogVideos.map((video) => `${toText(video.video_id)}.json`));

  const allComments = [];
  const videoSummaries = [];
  const parseErrors = [];

  for (const catalogVideo of catalogVideos) {
    const videoId = toText(catalogVideo.video_id);
    const fileName = `${videoId}.json`;
    const commentsFileExists = commentFileSet.has(fileName);
    const metadataFileExists = metadataFileSet.has(fileName);
    const [commentResult, metadataResult] = await Promise.all([
      commentsFileExists ? readJson(path.join(commentsDir, fileName)) : { value: null, error: '' },
      metadataFileExists ? readJson(path.join(metadataDir, fileName)) : { value: null, error: '' },
    ]);
    if (commentResult.error) parseErrors.push({ file: `comments/${fileName}`, error: commentResult.error });
    if (metadataResult.error) parseErrors.push({ file: `metadata/${fileName}`, error: metadataResult.error });

    const video = normalizeVideo(catalogVideo, commentResult.value, metadataResult.value);
    const sourceRows = Array.isArray(commentResult.value?.comments) ? commentResult.value.comments : [];
    const normalizedRows = sourceRows.map((comment) => normalizeComment(comment, video));
    const { rows, duplicateCount } = dedupeComments(normalizedRows);

    const readError = [commentResult.error, metadataResult.error].filter(Boolean).join(' | ');
    const completeness = deriveCompleteness({
      commentsFileExists,
      commentDocument: commentResult.value,
      metadataDocument: metadataResult.value,
      rows,
      duplicateCount,
      readError: commentResult.error,
    });
    const videoSummary = {
      ...video,
      comments_file: commentsFileExists ? `comments/${fileName}` : '',
      metadata_file: metadataFileExists ? `metadata/${fileName}` : '',
      comments_file_exists: commentsFileExists ? '已存在' : '缺失',
      metadata_file_exists: metadataFileExists ? '已存在' : '缺失',
      ...completeness,
      source_collected_at: toText(commentResult.value?.collected_at),
      source_schema_version: toText(commentResult.value?.schema_version),
      read_error: readError,
    };
    videoSummaries.push(videoSummary);
    allComments.push(...enrichCommentRelationships(rows, videoSummary, commentResult.value));
  }

  const missingCommentVideoIds = videoSummaries.filter((video) => !video.comments_file).map((video) => video.video_id);
  const missingMetadataVideoIds = videoSummaries.filter((video) => !video.metadata_file).map((video) => video.video_id);
  const completeVideoCount = videoSummaries.filter((video) => video.status === 'complete').length;
  const publicApiGapVideoCount = videoSummaries.filter((video) => video.status === 'public_api_complete_with_gap').length;
  const incompleteVideoCount = videoSummaries.filter((video) => video.status === 'incomplete').length;
  const rootCommentCount = allComments.filter((comment) => !comment.is_reply).length;
  const replyCount = allComments.filter((comment) => comment.is_reply).length;
  const linkedReplyCount = allComments.filter((comment) => comment.relationship_status === '已完整关联').length;
  const directParentMissingReplyCount = allComments.filter((comment) => comment.relationship_status === '直接父评论未采集').length;
  const ancestorChainIncompleteReplyCount = allComments.filter((comment) => comment.relationship_status === '祖先评论链不完整').length;
  const relationshipCycleReplyCount = allComments.filter((comment) => comment.relationship_status === '关系循环').length;
  const orphanReplyCount = directParentMissingReplyCount + ancestorChainIncompleteReplyCount + relationshipCycleReplyCount;
  const duplicateCommentCount = videoSummaries.reduce((sum, video) => sum + video.duplicate_comment_count, 0);
  const catalogCountMatchesDeclared = toInteger(catalog.public_video_count) === catalogVideos.length;

  let archiveStatus = 'complete';
  if (missingCommentVideoIds.length || missingMetadataVideoIds.length || incompleteVideoCount || parseErrors.length || !catalogCountMatchesDeclared) {
    archiveStatus = 'incomplete';
  } else if (publicApiGapVideoCount) {
    archiveStatus = 'public_api_complete_with_gap';
  }

  const generatedAt = now().toISOString();
  const manifest = {
    schema_version: 1,
    generated_at: generatedAt,
    source_directory: resolvedInputDir,
    output_directory: resolvedOutputDir,
    platform: toText(firstDefined(catalog.platform, 'douyin')),
    account_name: toText(catalog.account_name),
    douyin_id: toText(catalog.douyin_id),
    profile_url: toText(catalog.profile_url),
    coverage: {
      catalog_video_count: catalogVideos.length,
      declared_public_video_count: toInteger(catalog.public_video_count),
      catalog_count_matches_declared: catalogCountMatchesDeclared,
      comment_file_count: videoSummaries.filter((video) => video.comments_file).length,
      metadata_file_count: videoSummaries.filter((video) => video.metadata_file).length,
      complete_video_count: completeVideoCount,
      public_api_gap_video_count: publicApiGapVideoCount,
      incomplete_video_count: incompleteVideoCount,
      missing_comment_video_ids: missingCommentVideoIds,
      missing_metadata_video_ids: missingMetadataVideoIds,
      duplicate_catalog_video_ids: duplicateCatalogVideoIds,
      orphan_comment_files: commentFileNames.filter((name) => !catalogFileNames.has(name)),
      orphan_metadata_files: metadataFileNames.filter((name) => !catalogFileNames.has(name)),
      parse_errors: parseErrors,
    },
    comments: {
      total_comment_count: allComments.length,
      root_comment_count: rootCommentCount,
      reply_count: replyCount,
      linked_reply_count: linkedReplyCount,
      direct_parent_missing_reply_count: directParentMissingReplyCount,
      ancestor_chain_incomplete_reply_count: ancestorChainIncompleteReplyCount,
      relationship_cycle_reply_count: relationshipCycleReplyCount,
      orphan_reply_count: orphanReplyCount,
      duplicate_comment_count: duplicateCommentCount,
    },
    validation: {
      archive_status: archiveStatus,
      all_catalog_videos_have_comment_files: missingCommentVideoIds.length === 0,
      all_catalog_videos_have_metadata_files: missingMetadataVideoIds.length === 0,
      all_comment_counts_exact: publicApiGapVideoCount === 0 && incompleteVideoCount === 0,
      public_api_exhausted: incompleteVideoCount === 0,
    },
    outputs: OUTPUT_FILES,
    videos: videoSummaries,
  };

  const commentsNdjson = allComments.length ? `${allComments.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  const report = buildReport(manifest, videoSummaries);
  await fs.mkdir(resolvedOutputDir, { recursive: true });
  const workbook = createDouyinCommentWorkbook({ manifest, allComments, videoSummaries });
  await exportWorkbook(workbook, path.join(resolvedOutputDir, OUTPUT_FILES.commentsXlsx));
  await Promise.all([
    writeOutput(path.join(resolvedOutputDir, OUTPUT_FILES.commentsCsv), createCsv(allComments, COMMENT_COLUMNS)),
    writeOutput(path.join(resolvedOutputDir, OUTPUT_FILES.commentsNdjson), commentsNdjson),
    writeOutput(path.join(resolvedOutputDir, OUTPUT_FILES.videosCsv), createCsv(videoSummaries, VIDEO_COLUMNS)),
    writeOutput(path.join(resolvedOutputDir, OUTPUT_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`),
    writeOutput(path.join(resolvedOutputDir, OUTPUT_FILES.report), report),
  ]);

  return { manifest, allComments, videoSummaries };
}

function parseArguments(argv) {
  let inputDir = DEFAULT_INPUT_DIR;
  let outputDir = '';
  let help = false;
  let positionalInputSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--input-dir') {
      inputDir = argv[++index];
    } else if (argument.startsWith('--input-dir=')) {
      inputDir = argument.slice('--input-dir='.length);
    } else if (argument === '--output-dir') {
      outputDir = argv[++index];
    } else if (argument.startsWith('--output-dir=')) {
      outputDir = argument.slice('--output-dir='.length);
    } else if (!argument.startsWith('-') && !positionalInputSeen) {
      // npm on Windows can consume the --input-dir option name while forwarding its value.
      inputDir = argument;
      positionalInputSeen = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!inputDir) throw new Error('--input-dir requires a value.');
  return { inputDir, outputDir: outputDir || inputDir, help };
}

function printHelp() {
  console.log([
    'Usage: node server/scripts/build-douyin-comment-archive.mjs [options]',
    '',
    `  --input-dir <path>   Source directory (default: ${DEFAULT_INPUT_DIR})`,
    '  --output-dir <path>  Output directory (default: same as input)',
    '  --help               Show this help',
    '',
    'The command performs no network access and never modifies catalog.json, comments/, or metadata/.',
  ].join('\n'));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const { manifest } = await buildDouyinCommentArchive(options);
      console.log(JSON.stringify({
        status: manifest.validation.archive_status,
        output_directory: manifest.output_directory,
        videos: manifest.coverage.catalog_video_count,
        comment_files: manifest.coverage.comment_file_count,
        metadata_files: manifest.coverage.metadata_file_count,
        comments: manifest.comments.total_comment_count,
        complete_videos: manifest.coverage.complete_video_count,
        public_api_gap_videos: manifest.coverage.public_api_gap_video_count,
        incomplete_videos: manifest.coverage.incomplete_video_count,
      }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
