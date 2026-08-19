import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_DATA_DIR = 'E:\\kolforge-data\\manual-douyin\\20260813-sanguosha-wuhu-all';

const ACCOUNT_NAME = '\u4e09\u56fd\u6740WUHU\u8054\u76df';
const DOUYIN_ID = 'sgswuhu666';
const TARGET_AUTHOR_SEC_UID = 'MS4wLjABAAAAp6d23uHLTkIpaJi7vE96ASfWzO-br8liFRcDwPJn6YR7RuvE00a7jhnTTIndzFyY';
const COLLECTION_METHOD = 'offline_api_checkpoint_merge';

function asId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function cleanVideoTitle(cardText) {
  const lines = String(cardText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line, index) => (
    line !== '\u7f6e\u9876'
    && !(index < 3 && /^\d+(?:\.\d+)?(?:\u4e07|\u4ebf)?$/.test(line))
  )).join(' ');
}

function toShanghaiTime(epoch) {
  const value = asNumber(epoch);
  if (!value) return '';
  return new Date((value + (8 * 60 * 60)) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeLabels(comment) {
  const labels = [];
  for (const source of [comment?.label_list, comment?.labels]) {
    if (!Array.isArray(source)) continue;
    for (const label of source) {
      if (typeof label === 'string') labels.push(label);
      else if (label && typeof label === 'object') {
        labels.push(label.text || label.label_text || label.name || '');
      }
    }
  }
  if (comment?.label_text) labels.push(comment.label_text);
  return uniqueStrings(labels);
}

function firstUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || '';
  if (typeof value === 'object') {
    return firstUrl(value.url_list)
      || firstUrl(value.origin_url)
      || firstUrl(value.medium_url)
      || firstUrl(value.download_url)
      || firstUrl(value.thumb_url)
      || firstUrl(value.url);
  }
  return '';
}

function normalizeImageUrls(comment) {
  if (Array.isArray(comment?.image_urls)) return uniqueStrings(comment.image_urls);
  if (!Array.isArray(comment?.image_list)) return [];
  return uniqueStrings(comment.image_list.map(firstUrl));
}

function checkpointTime(documents) {
  const timestamps = documents
    .map((document) => Date.parse(document?.captured_at || ''))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : '';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonResult(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { document: JSON.parse(text), error: '' };
  } catch (error) {
    return { document: null, error: String(error?.message || error) };
  }
}

async function readOptionalJson(filePath) {
  if (!(await pathExists(filePath))) return null;
  const result = await readJsonResult(filePath);
  return result.document;
}

async function listJsonFiles(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function listReplyCheckpointFiles(replyRoot) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(replyRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const videoId = entry.name;
    for (const name of await listJsonFiles(path.join(replyRoot, videoId))) {
      files.push({
        video_id: videoId,
        root_comment_id: name.slice(0, -'.json'.length),
        path: path.join(replyRoot, videoId, name),
      });
    }
  }
  return files;
}

function normalizeApiComment(comment, kind, checkpointRootId, video) {
  const commentId = asId(comment?.cid);
  const isReply = kind === 'reply';
  const apiReplyId = asId(comment?.reply_id);
  const apiReplyToReplyId = asId(comment?.reply_to_reply_id);
  const rootCommentId = isReply
    ? (apiReplyId && apiReplyId !== '0' ? apiReplyId : checkpointRootId)
    : commentId;
  const parentCommentId = isReply
    ? (apiReplyToReplyId && apiReplyToReplyId !== '0' ? apiReplyToReplyId : rootCommentId)
    : '';
  const labels = normalizeLabels(comment);
  const epoch = asNumber(comment?.create_time);
  const nickname = String(comment?.user?.nickname || '');
  const secUid = asId(comment?.user?.sec_uid);
  return {
    comment_id: commentId,
    root_comment_id: rootCommentId,
    parent_comment_id: parentCommentId || null,
    relation_type: isReply
      ? (parentCommentId && parentCommentId !== rootCommentId ? 'reply_to_reply' : 'reply_to_root')
      : 'root',
    is_reply: isReply,
    api_reply_id: apiReplyId,
    api_reply_to_reply_id: apiReplyToReplyId,
    comment_user: nickname,
    comment_user_raw: nickname,
    comment_user_id: asId(comment?.user?.uid),
    comment_user_sec_uid: secUid,
    comment_user_unique_id: asId(comment?.user?.unique_id),
    comment_user_short_id: asId(comment?.user?.short_id),
    comment_user_url: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    comment_user_verification: String(
      comment?.user?.custom_verify || comment?.user?.enterprise_verify_reason || '',
    ),
    is_video_author: secUid === TARGET_AUTHOR_SEC_UID
      || asBoolean(comment?.is_author_comment)
      || asBoolean(comment?.is_author_reply),
    video_author_replied: labels.some((label) => label.includes('\u4f5c\u8005\u56de\u590d')),
    comment_content: String(comment?.text || ''),
    comment_tags: labels,
    comment_image_urls: normalizeImageUrls(comment),
    comment_likes_raw: String(asNumber(comment?.digg_count)),
    comment_likes: asNumber(comment?.digg_count),
    comment_time_epoch: epoch || null,
    comment_time: toShanghaiTime(epoch),
    comment_time_iso_utc: epoch ? new Date(epoch * 1000).toISOString() : '',
    comment_location: String(comment?.ip_label || ''),
    comment_time_location: [toShanghaiTime(epoch), String(comment?.ip_label || '')]
      .filter(Boolean)
      .join('\u00b7'),
    is_author_digged: asBoolean(comment?.is_author_digged),
    is_hot: asBoolean(comment?.is_hot),
    is_sticky: asBoolean(comment?.is_stick) || asNumber(comment?.stick_position) > 0,
    declared_child_reply_count: asNumber(comment?.reply_comment_total),
    video_id: video.video_id,
    video_title: video.video_title,
    video_url: video.video_url,
    video_publish_time: video.video_publish_time,
    row_source: 'douyin_public_web_api_checkpoint',
    dom_fallback_fields: [],
  };
}

function dedupeApiRows(rootDocument, replyDocuments, video) {
  const rows = [];
  const seen = new Set();
  const duplicateIds = [];
  const invalidRows = [];

  const add = (comment, kind, checkpointRootId) => {
    const row = normalizeApiComment(comment, kind, checkpointRootId, video);
    if (!row.comment_id) {
      invalidRows.push({ kind, checkpoint_root_comment_id: checkpointRootId || null, reason: 'missing_comment_id' });
      return;
    }
    if (seen.has(row.comment_id)) {
      duplicateIds.push(row.comment_id);
      return;
    }
    seen.add(row.comment_id);
    rows.push(row);
  };

  for (const comment of rootDocument?.roots || []) add(comment, 'root', '');
  for (const bundle of replyDocuments) {
    for (const comment of bundle.document?.replies || []) {
      add(comment, 'reply', bundle.root_comment_id);
    }
  }

  const authorReplyRoots = new Set(rows
    .filter((row) => row.is_reply && row.is_video_author)
    .map((row) => row.root_comment_id));
  for (const row of rows) {
    if (!row.is_reply && authorReplyRoots.has(row.comment_id)) row.video_author_replied = true;
  }

  const ids = new Set(rows.map((row) => row.comment_id));
  const missingParents = rows
    .filter((row) => row.is_reply && (!row.parent_comment_id || !ids.has(row.parent_comment_id)))
    .map((row) => ({
      comment_id: row.comment_id,
      root_comment_id: row.root_comment_id,
      parent_comment_id: row.parent_comment_id,
    }));

  return {
    rows,
    duplicateIds: uniqueStrings(duplicateIds),
    duplicateRowCount: duplicateIds.length,
    invalidRows,
    missingParents,
  };
}

function isRootCheckpointValid(document, videoId) {
  const reasons = [];
  if (!document || typeof document !== 'object') reasons.push('invalid_root_checkpoint_json');
  else {
    if (asId(document.video_id) !== videoId) reasons.push('root_checkpoint_video_id_mismatch');
    if (!Array.isArray(document.roots)) reasons.push('root_checkpoint_roots_not_array');
    if (document.root_pagination_exhausted !== true) reasons.push('root_pagination_not_exhausted');
  }
  return reasons;
}

function replyCheckpointReasons(document, videoId, rootCommentId) {
  const reasons = [];
  if (!document || typeof document !== 'object') reasons.push('invalid_reply_checkpoint_json');
  else {
    if (asId(document.video_id) !== videoId) reasons.push('reply_checkpoint_video_id_mismatch');
    if (asId(document.root_comment_id) !== rootCommentId) reasons.push('reply_checkpoint_root_id_mismatch');
    if (!Array.isArray(document.replies)) reasons.push('reply_checkpoint_replies_not_array');
    if (document.pagination_exhausted !== true) reasons.push('reply_pagination_not_exhausted');
  }
  return reasons;
}

function paginationReasons(document, {
  rowsField,
  pagesField,
  exhaustedField,
  prefix,
}) {
  const reasons = [];
  const rows = document?.[rowsField];
  const pages = document?.[pagesField];
  if (!Array.isArray(rows) || !Array.isArray(pages)) return reasons;
  if (pages.length === 0) {
    reasons.push(`${prefix}_pages_empty`);
    return reasons;
  }
  if (asNumber(pages[0]?.requested_cursor, -1) !== 0) {
    reasons.push(`${prefix}_first_requested_cursor_not_zero`);
  }
  for (let index = 1; index < pages.length; index += 1) {
    if (asNumber(pages[index]?.requested_cursor, -1) !== asNumber(pages[index - 1]?.cursor, -2)) {
      reasons.push(`${prefix}_cursor_chain_broken`);
      break;
    }
  }
  if (asNumber(pages.at(-1)?.has_more, -1) !== 0) reasons.push(`${prefix}_last_page_has_more`);
  if (pages.slice(0, -1).some((page) => asNumber(page?.has_more) === 0)) {
    reasons.push(`${prefix}_early_terminal_page`);
  }
  const receivedRows = pages.reduce((sum, page) => sum + asNumber(page?.received), 0);
  if (receivedRows !== rows.length) reasons.push(`${prefix}_page_received_count_mismatch`);
  if (document?.[exhaustedField] !== true) reasons.push(`${prefix}_pagination_not_exhausted`);
  return uniqueStrings(reasons);
}

function rootCheckpointReasons(document, videoId) {
  return uniqueStrings([
    ...isRootCheckpointValid(document, videoId),
    ...paginationReasons(document, {
      rowsField: 'roots',
      pagesField: 'root_pages',
      exhaustedField: 'root_pagination_exhausted',
      prefix: 'root',
    }),
  ]);
}

function fullReplyCheckpointReasons(document, videoId, rootCommentId) {
  return uniqueStrings([
    ...replyCheckpointReasons(document, videoId, rootCommentId),
    ...paginationReasons(document, {
      rowsField: 'replies',
      pagesField: 'pages',
      exhaustedField: 'pagination_exhausted',
      prefix: 'reply',
    }),
  ]);
}

async function inspectVideo(dataDir, catalogVideo, replyCheckpointFiles = null) {
  const videoId = asId(catalogVideo?.video_id);
  const rootPath = path.join(dataDir, 'state', 'root-api', `${videoId}.json`);
  const replyDirectory = path.join(dataDir, 'state', 'reply-api', videoId);
  const rootPresent = await pathExists(rootPath);
  const rootResult = rootPresent
    ? await readJsonResult(rootPath)
    : { document: null, error: '' };
  const rootDocument = rootResult.document;
  const rootReasons = !rootPresent
    ? []
    : (rootResult.error ? ['root_checkpoint_unreadable'] : rootCheckpointReasons(rootDocument, videoId));
  const actualReplyIds = replyCheckpointFiles
    ? replyCheckpointFiles.map((file) => file.root_comment_id)
    : (await listJsonFiles(replyDirectory)).map((name) => name.slice(0, -'.json'.length));

  const uniqueRoots = [];
  const seenRootIds = new Set();
  const duplicateRootIds = [];
  const rootRowsWithoutId = [];
  for (const [index, root] of (rootDocument?.roots || []).entries()) {
    const rootId = asId(root?.cid);
    if (!rootId) {
      rootRowsWithoutId.push(index);
      continue;
    }
    if (seenRootIds.has(rootId)) {
      duplicateRootIds.push(rootId);
      continue;
    }
    seenRootIds.add(rootId);
    uniqueRoots.push(root);
  }
  const expectedRoots = uniqueRoots.filter((root) => asNumber(root?.reply_comment_total) > 0);
  const expectedIds = expectedRoots.map((root) => asId(root.cid));
  const expectedSet = new Set(expectedIds);
  const existingExpectedIds = [];
  const missingReplyIds = [];
  const invalidReplyCheckpoints = [];
  const replyDocuments = [];

  for (const root of expectedRoots) {
    const rootCommentId = asId(root.cid);
    const filePath = path.join(replyDirectory, `${rootCommentId}.json`);
    if (!actualReplyIds.includes(rootCommentId)) {
      missingReplyIds.push(rootCommentId);
      continue;
    }
    existingExpectedIds.push(rootCommentId);
    const replyResult = await readJsonResult(filePath);
    const reasons = replyResult.error
      ? ['reply_checkpoint_unreadable']
      : fullReplyCheckpointReasons(replyResult.document, videoId, rootCommentId);
    if (reasons.length) {
      invalidReplyCheckpoints.push({
        root_comment_id: rootCommentId,
        path: filePath,
        reasons,
        error: replyResult.error || undefined,
      });
      continue;
    }
    replyDocuments.push({ root_comment_id: rootCommentId, document: replyResult.document, path: filePath });
  }

  const extraReplyIds = actualReplyIds.filter((rootCommentId) => !expectedSet.has(rootCommentId));
  const blockingReplyIds = uniqueStrings([
    ...missingReplyIds,
    ...invalidReplyCheckpoints.map((item) => item.root_comment_id),
  ]);
  const ready = rootPresent && rootReasons.length === 0 && blockingReplyIds.length === 0;

  const oldComments = await readOptionalJson(path.join(dataDir, 'comments', `${videoId}.json`));
  const oldMetadata = await readOptionalJson(path.join(dataDir, 'metadata', `${videoId}.json`));
  const video = {
    video_id: videoId,
    video_title: String(
      oldComments?.video_title
      || oldMetadata?.metadata?.video_title
      || oldMetadata?.video_title
      || cleanVideoTitle(catalogVideo?.card_text),
    ),
    video_url: String(
      oldComments?.video_url
      || oldMetadata?.metadata?.video_url
      || oldMetadata?.video_url
      || catalogVideo?.url
      || `https://www.douyin.com/video/${videoId}`,
    ),
    video_publish_time: String(
      oldComments?.video_publish_time
      || oldMetadata?.metadata?.video_publish_time
      || oldMetadata?.video_publish_time
      || '',
    ),
  };
  const rowAudit = dedupeApiRows(rootDocument, replyDocuments, video);
  const rootCount = rowAudit.rows.filter((row) => !row.is_reply).length;
  const replyCount = rowAudit.rows.length - rootCount;
  const declaredCount = asNumber(rootDocument?.declared_total);
  const declaredGap = declaredCount - rowAudit.rows.length;
  const integrityClean = rowAudit.duplicateRowCount === 0 && rowAudit.invalidRows.length === 0;
  const status = !ready
    ? 'incomplete'
    : (declaredGap === 0 && integrityClean ? 'complete' : 'public_api_complete_with_gap');
  const expectedReplyRows = expectedRoots.reduce(
    (total, root) => total + asNumber(root.reply_comment_total),
    0,
  );
  const apiReplyTotal = replyDocuments.reduce(
    (total, bundle) => total + asNumber(bundle.document?.api_reply_total),
    0,
  );
  const declaredReplyCount = replyDocuments.reduce(
    (total, bundle) => total + asNumber(bundle.document?.declared_reply_count),
    0,
  );
  const rawReplyRows = replyDocuments.reduce(
    (total, bundle) => total + (Array.isArray(bundle.document?.replies) ? bundle.document.replies.length : 0),
    0,
  );
  const replyThreadsMatchingDeclared = replyDocuments.filter((bundle) => (
    (bundle.document?.replies || []).length === asNumber(bundle.document?.declared_reply_count)
  )).length;
  const replyThreadsMatchingApiTotal = replyDocuments.filter((bundle) => (
    (bundle.document?.replies || []).length === asNumber(bundle.document?.api_reply_total)
  )).length;
  const replyThreadsMatchingBoth = replyDocuments.filter((bundle) => {
    const count = (bundle.document?.replies || []).length;
    return count === asNumber(bundle.document?.declared_reply_count)
      && count === asNumber(bundle.document?.api_reply_total);
  }).length;

  const reasons = [...rootReasons];
  if (!rootPresent) reasons.push('root_checkpoint_missing');
  if (missingReplyIds.length) reasons.push('expected_reply_checkpoint_missing');
  if (invalidReplyCheckpoints.length) reasons.push('expected_reply_checkpoint_invalid');

  const report = {
    video_id: videoId,
    root_checkpoint: {
      path: rootPath,
      present: rootPresent,
      valid: rootPresent && rootReasons.length === 0,
      reasons: rootReasons,
      error: rootResult.error || undefined,
      raw_root_rows: Array.isArray(rootDocument?.roots) ? rootDocument.roots.length : 0,
      unique_root_rows: uniqueRoots.length,
      duplicate_root_ids: uniqueStrings(duplicateRootIds),
      duplicate_root_row_count: duplicateRootIds.length,
      rows_without_id: rootRowsWithoutId,
      pagination_exhausted: rootDocument?.root_pagination_exhausted === true,
    },
    reply_checkpoints: {
      expected_threads: expectedIds.length,
      existing_expected_threads: existingExpectedIds.length,
      valid_expected_threads: replyDocuments.length,
      missing_thread_ids: missingReplyIds,
      invalid_threads: invalidReplyCheckpoints,
      blocking_thread_ids: blockingReplyIds,
      extra_thread_ids: extraReplyIds,
      actual_files_in_video_directory: actualReplyIds.length,
      expected_reply_rows_from_roots: expectedReplyRows,
      declared_reply_rows_from_valid_checkpoints: declaredReplyCount,
      api_reply_total_from_valid_checkpoints: apiReplyTotal,
      captured_raw_reply_rows: rawReplyRows,
      captured_unique_reply_rows: replyCount,
      declared_reply_row_gap: declaredReplyCount - rawReplyRows,
      api_reply_row_gap: apiReplyTotal - rawReplyRows,
      threads_matching_declared_reply_count: replyThreadsMatchingDeclared,
      threads_matching_api_reply_total: replyThreadsMatchingApiTotal,
      threads_matching_both_counts: replyThreadsMatchingBoth,
    },
    comments: {
      declared_count: declaredCount,
      captured_unique_count: rowAudit.rows.length,
      declared_gap: declaredGap,
      structural_expected_count: uniqueRoots.length + expectedReplyRows,
      declared_vs_structural_gap: declaredCount - uniqueRoots.length - expectedReplyRows,
      root_count: rootCount,
      reply_count: replyCount,
      duplicate_comment_ids: rowAudit.duplicateIds,
      duplicate_comment_row_count: rowAudit.duplicateRowCount,
      invalid_rows: rowAudit.invalidRows,
      missing_parents: rowAudit.missingParents,
    },
    checkpoint_captured_at: checkpointTime([
      rootDocument,
      ...replyDocuments.map((bundle) => bundle.document),
    ]),
    ready_to_merge: ready,
    traversal_status: ready ? 'public_api_traversal_complete' : 'incomplete',
    status,
    blocking_reasons: uniqueStrings(reasons),
  };

  return {
    catalogVideo,
    video,
    rootDocument,
    replyDocuments,
    oldComments,
    oldMetadata,
    rowAudit,
    report,
  };
}

function roundPercent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 100;
}

function buildAudit(dataDir, catalog, entries, rootFiles, replyFiles) {
  const reports = entries.map((entry) => entry.report);
  const expectedReplyThreads = reports.reduce((sum, report) => sum + report.reply_checkpoints.expected_threads, 0);
  const existingExpectedReplyThreads = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.existing_expected_threads,
    0,
  );
  const validExpectedReplyThreads = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.valid_expected_threads,
    0,
  );
  const missingReplyFiles = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.missing_thread_ids.length,
    0,
  );
  const invalidReplyFiles = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.invalid_threads.length,
    0,
  );
  const catalogIds = new Set(entries.map((entry) => entry.video.video_id));
  const rootFileIds = rootFiles.map((name) => name.slice(0, -'.json'.length));
  const readyCount = reports.filter((report) => report.ready_to_merge).length;
  const completeCount = reports.filter((report) => report.status === 'complete').length;
  const gapCount = reports.filter((report) => report.status === 'public_api_complete_with_gap').length;
  const incompleteCount = reports.filter((report) => report.status === 'incomplete').length;
  const declaredCount = reports.reduce((sum, report) => sum + report.comments.declared_count, 0);
  const capturedCount = reports.reduce((sum, report) => sum + report.comments.captured_unique_count, 0);
  const structuralExpectedCount = reports.reduce(
    (sum, report) => sum + report.comments.structural_expected_count,
    0,
  );
  const declaredReplyRows = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.declared_reply_rows_from_valid_checkpoints,
    0,
  );
  const apiReplyRows = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.api_reply_total_from_valid_checkpoints,
    0,
  );
  const capturedRawReplyRows = reports.reduce(
    (sum, report) => sum + report.reply_checkpoints.captured_raw_reply_rows,
    0,
  );
  const duplicateRows = reports.reduce((sum, report) => sum + report.comments.duplicate_comment_row_count, 0);
  const missingParents = reports.reduce((sum, report) => sum + report.comments.missing_parents.length, 0);

  const globalIdOwners = new Map();
  for (const entry of entries) {
    for (const row of entry.rowAudit.rows) {
      if (!globalIdOwners.has(row.comment_id)) globalIdOwners.set(row.comment_id, []);
      globalIdOwners.get(row.comment_id).push(entry.video.video_id);
    }
  }
  const crossVideoDuplicateIds = [...globalIdOwners.entries()]
    .filter(([, videoIds]) => new Set(videoIds).size > 1)
    .map(([commentId, videoIds]) => ({ comment_id: commentId, video_ids: uniqueStrings(videoIds) }));

  return {
    schema_version: 1,
    audit_type: 'douyin_api_checkpoint_coverage',
    generated_at: new Date().toISOString(),
    data_dir: path.resolve(dataDir),
    read_only: true,
    summary: {
      catalog_video_count: entries.length,
      root_checkpoint_files: rootFiles.length,
      catalog_videos_with_root_checkpoint: reports.filter((report) => report.root_checkpoint.present).length,
      valid_root_checkpoints: reports.filter((report) => report.root_checkpoint.valid).length,
      missing_catalog_root_checkpoints: reports.filter((report) => !report.root_checkpoint.present).length,
      extra_root_checkpoint_files: rootFileIds.filter((videoId) => !catalogIds.has(videoId)).length,
      root_checkpoint_coverage_percent: roundPercent(
        reports.filter((report) => report.root_checkpoint.present).length,
        entries.length,
      ),
      reply_checkpoint_files: replyFiles.length,
      expected_reply_threads: expectedReplyThreads,
      existing_expected_reply_checkpoint_files: existingExpectedReplyThreads,
      valid_expected_reply_checkpoints: validExpectedReplyThreads,
      missing_reply_checkpoint_files: missingReplyFiles,
      invalid_expected_reply_checkpoints: invalidReplyFiles,
      blocking_reply_threads: expectedReplyThreads - validExpectedReplyThreads,
      extra_reply_checkpoint_files: reports.reduce(
        (sum, report) => sum + report.reply_checkpoints.extra_thread_ids.length,
        0,
      ) + replyFiles.filter((file) => !catalogIds.has(file.video_id)).length,
      reply_thread_coverage_percent: roundPercent(validExpectedReplyThreads, expectedReplyThreads),
      ready_to_merge_videos: readyCount,
      skipped_videos: entries.length - readyCount,
      status_counts: {
        complete: completeCount,
        public_api_complete_with_gap: gapCount,
        incomplete: incompleteCount,
      },
      ready_videos_matching_declared_comment_count: reports.filter((report) => (
        report.ready_to_merge && report.comments.declared_gap === 0
      )).length,
      ready_videos_with_all_reply_counts_exact: reports.filter((report) => (
        report.ready_to_merge
        && report.reply_checkpoints.threads_matching_both_counts === report.reply_checkpoints.expected_threads
      )).length,
      ready_videos_with_no_missing_parent_relations: reports.filter((report) => (
        report.ready_to_merge && report.comments.missing_parents.length === 0
      )).length,
      declared_comment_count: declaredCount,
      structural_expected_comment_count: structuralExpectedCount,
      declared_vs_structural_comment_gap: declaredCount - structuralExpectedCount,
      captured_unique_comment_count: capturedCount,
      declared_comment_gap: declaredCount - capturedCount,
      declared_reply_rows_in_valid_checkpoints: declaredReplyRows,
      api_reply_total_in_valid_checkpoints: apiReplyRows,
      captured_raw_reply_rows: capturedRawReplyRows,
      declared_reply_row_gap: declaredReplyRows - capturedRawReplyRows,
      api_reply_row_gap: apiReplyRows - capturedRawReplyRows,
      reply_threads_matching_declared_count: reports.reduce(
        (sum, report) => sum + report.reply_checkpoints.threads_matching_declared_reply_count,
        0,
      ),
      reply_threads_matching_api_total: reports.reduce(
        (sum, report) => sum + report.reply_checkpoints.threads_matching_api_reply_total,
        0,
      ),
      reply_threads_matching_both_counts: reports.reduce(
        (sum, report) => sum + report.reply_checkpoints.threads_matching_both_counts,
        0,
      ),
      duplicate_comment_rows: duplicateRows,
      missing_parent_relations: missingParents,
      cross_video_duplicate_comment_ids: crossVideoDuplicateIds.length,
    },
    cross_video_duplicate_comment_ids: crossVideoDuplicateIds,
    videos: reports,
  };
}

export async function inspectCheckpointDataset(dataDir = DEFAULT_DATA_DIR) {
  const resolvedDataDir = path.resolve(dataDir);
  const catalogPath = path.join(resolvedDataDir, 'catalog.json');
  const catalogResult = await readJsonResult(catalogPath);
  if (!catalogResult.document || !Array.isArray(catalogResult.document.videos)) {
    throw new Error(`Unable to read catalog videos from ${catalogPath}: ${catalogResult.error || 'invalid catalog'}`);
  }
  const catalog = catalogResult.document;
  const rootFiles = await listJsonFiles(path.join(resolvedDataDir, 'state', 'root-api'));
  const replyFiles = await listReplyCheckpointFiles(path.join(resolvedDataDir, 'state', 'reply-api'));
  const replyFilesByVideo = new Map();
  for (const file of replyFiles) {
    if (!replyFilesByVideo.has(file.video_id)) replyFilesByVideo.set(file.video_id, []);
    replyFilesByVideo.get(file.video_id).push(file);
  }
  const entries = [];
  for (const catalogVideo of catalog.videos) {
    entries.push(await inspectVideo(
      resolvedDataDir,
      catalogVideo,
      replyFilesByVideo.get(asId(catalogVideo?.video_id)) || [],
    ));
  }
  const audit = buildAudit(resolvedDataDir, catalog, entries, rootFiles, replyFiles);
  return { audit, catalog, entries };
}

const DOM_FALLBACK_FIELDS = [
  'comment_user',
  'comment_user_raw',
  'comment_user_id',
  'comment_user_sec_uid',
  'comment_user_unique_id',
  'comment_user_short_id',
  'comment_user_url',
  'comment_user_verification',
  'comment_content',
  'comment_tags',
  'comment_image_urls',
  'comment_time',
  'comment_time_iso_utc',
  'comment_location',
  'comment_time_location',
  'video_publish_time',
];

function missingValue(value) {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function usableDomValue(field, value, oldRow) {
  if (missingValue(value)) return false;
  if (field !== 'comment_content') return true;
  const text = String(value).trim();
  if (!text || text === '\u4f5c\u8005\u56de\u590d\u8fc7') return false;
  const tags = Array.isArray(oldRow?.comment_tags) ? oldRow.comment_tags.map(String) : [];
  return !tags.includes(text);
}

function applyDomFallback(rows, oldComments) {
  const oldRows = Array.isArray(oldComments?.comments) ? oldComments.comments : [];
  const oldById = new Map(oldRows
    .filter((row) => asId(row?.comment_id))
    .map((row) => [asId(row.comment_id), {
      ...row,
      comment_user: missingValue(row.comment_user) ? row.author_name : row.comment_user,
      comment_user_raw: missingValue(row.comment_user_raw) ? row.author_name_raw : row.comment_user_raw,
      comment_user_url: missingValue(row.comment_user_url) ? row.author_url : row.comment_user_url,
      comment_content: missingValue(row.comment_content) ? row.text : row.comment_content,
      comment_tags: missingValue(row.comment_tags) ? row.tags : row.comment_tags,
      comment_image_urls: missingValue(row.comment_image_urls) ? row.image_urls : row.comment_image_urls,
      comment_time_location: missingValue(row.comment_time_location)
        ? row.time_location
        : row.comment_time_location,
    }]));
  let matchedRows = 0;
  let fallbackValues = 0;
  for (const row of rows) {
    const oldRow = oldById.get(row.comment_id);
    if (!oldRow) continue;
    matchedRows += 1;
    for (const field of DOM_FALLBACK_FIELDS) {
      if (!missingValue(row[field]) || !usableDomValue(field, oldRow[field], oldRow)) continue;
      row[field] = oldRow[field];
      row.dom_fallback_fields.push(field);
      fallbackValues += 1;
    }
  }
  return {
    matched_same_id_rows: matchedRows,
    fallback_value_count: fallbackValues,
    ignored_dom_only_rows: Math.max(0, oldRows.length - matchedRows),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildMergedVideoDocuments(entry) {
  if (!entry.report.ready_to_merge) {
    throw new Error(`Video ${entry.video.video_id} is not checkpoint-complete`);
  }
  const rows = clone(entry.rowAudit.rows);
  const domFallback = applyDomFallback(rows, entry.oldComments);
  const completeness = {
    declared_comment_count: entry.report.comments.declared_count,
    captured_comment_count: entry.report.comments.captured_unique_count,
    declared_comment_gap: entry.report.comments.declared_gap,
    root_comment_count: entry.report.comments.root_count,
    reply_count: entry.report.comments.reply_count,
    count_matches_declared: entry.report.comments.declared_gap === 0,
    root_pagination_exhausted: true,
    reply_pagination_exhausted: true,
    expected_reply_threads: entry.report.reply_checkpoints.expected_threads,
    captured_reply_threads: entry.report.reply_checkpoints.valid_expected_threads,
    expected_reply_count_from_roots: entry.report.reply_checkpoints.expected_reply_rows_from_roots,
    declared_reply_count_from_checkpoints: entry.report.reply_checkpoints.declared_reply_rows_from_valid_checkpoints,
    api_reply_total_from_checkpoints: entry.report.reply_checkpoints.api_reply_total_from_valid_checkpoints,
    captured_raw_reply_count: entry.report.reply_checkpoints.captured_raw_reply_rows,
    declared_reply_count_gap: entry.report.reply_checkpoints.declared_reply_row_gap,
    api_reply_total_gap: entry.report.reply_checkpoints.api_reply_row_gap,
    duplicate_comment_row_count: entry.report.comments.duplicate_comment_row_count,
    missing_parent_relation_count: entry.report.comments.missing_parents.length,
    traversal_status: entry.report.traversal_status,
    status: entry.report.status,
  };
  const collectedAt = entry.report.checkpoint_captured_at
    || entry.oldComments?.collected_at
    || entry.oldMetadata?.collected_at
    || '';
  const commentDocument = {
    schema_version: 3,
    platform: 'douyin',
    account_name: String(entry.oldComments?.account_name || entry.oldMetadata?.account_name || ACCOUNT_NAME),
    douyin_id: String(entry.oldComments?.douyin_id || entry.oldMetadata?.douyin_id || DOUYIN_ID),
    video_id: entry.video.video_id,
    video_title: entry.video.video_title,
    video_url: entry.video.video_url,
    video_publish_time: entry.video.video_publish_time,
    collected_at: collectedAt,
    collection_method: COLLECTION_METHOD,
    completeness,
    api_audit: {
      root_checkpoint_path: entry.report.root_checkpoint.path,
      root_pages: clone(entry.rootDocument?.root_pages || []),
      reply_threads: entry.replyDocuments.map((bundle) => ({
        root_comment_id: bundle.root_comment_id,
        checkpoint_path: bundle.path,
        declared_reply_count: asNumber(bundle.document?.declared_reply_count),
        api_reply_total: asNumber(bundle.document?.api_reply_total),
        captured_reply_rows: Array.isArray(bundle.document?.replies) ? bundle.document.replies.length : 0,
        pages: clone(bundle.document?.pages || []),
        pagination_exhausted: bundle.document?.pagination_exhausted === true,
      })),
      missing_reply_thread_ids: [],
      invalid_reply_threads: [],
      extra_reply_thread_ids: clone(entry.report.reply_checkpoints.extra_thread_ids),
      duplicate_comment_ids: clone(entry.report.comments.duplicate_comment_ids),
      invalid_comment_rows: clone(entry.report.comments.invalid_rows),
      missing_parent_relations: clone(entry.report.comments.missing_parents),
      dom_same_id_fallback: domFallback,
    },
    comments: rows,
  };

  const oldMetadataFields = entry.oldMetadata?.metadata && typeof entry.oldMetadata.metadata === 'object'
    ? clone(entry.oldMetadata.metadata)
    : {};
  const metadataDocument = {
    ...(entry.oldMetadata && typeof entry.oldMetadata === 'object' ? clone(entry.oldMetadata) : {}),
    schema_version: 3,
    platform: 'douyin',
    account_name: commentDocument.account_name,
    douyin_id: commentDocument.douyin_id,
    video_id: entry.video.video_id,
    metadata: {
      ...oldMetadataFields,
      video_id: entry.video.video_id,
      video_title: entry.video.video_title,
      video_url: entry.video.video_url,
      video_card_text: String(entry.catalogVideo?.card_text || oldMetadataFields.video_card_text || ''),
      video_publish_time: entry.video.video_publish_time,
      declared_comment_count: completeness.declared_comment_count,
      captured_comment_count: completeness.captured_comment_count,
      root_comment_count: completeness.root_comment_count,
      reply_count: completeness.reply_count,
      checkpoint_captured_at: collectedAt,
    },
    completeness,
    collected_at: collectedAt,
    collection_method: COLLECTION_METHOD,
    checkpoint_merge: {
      root_checkpoint_path: entry.report.root_checkpoint.path,
      expected_reply_threads: completeness.expected_reply_threads,
      captured_reply_threads: completeness.captured_reply_threads,
      dom_same_id_fallback: domFallback,
    },
  };
  return { commentDocument, metadataDocument };
}

async function writeTextFile(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Cleanup is best effort; the original error is more useful to the caller.
  }
}

async function replaceFileWithBackup(stagePath, destinationPath, backupPath) {
  const existed = await pathExists(destinationPath);
  if (existed) await fs.rename(destinationPath, backupPath);
  try {
    await fs.rename(stagePath, destinationPath);
    return existed;
  } catch (error) {
    if (existed && await pathExists(backupPath)) await fs.rename(backupPath, destinationPath);
    throw error;
  }
}

export async function writeMergedVideo(outputDir, videoId, documents) {
  const commentsPath = path.join(outputDir, 'comments', `${videoId}.json`);
  const metadataPath = path.join(outputDir, 'metadata', `${videoId}.json`);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const commentsStage = `${commentsPath}.stage-${token}`;
  const metadataStage = `${metadataPath}.stage-${token}`;
  const commentsBackup = `${commentsPath}.backup-${token}`;
  const metadataBackup = `${metadataPath}.backup-${token}`;
  let commentsReplaced = false;
  let metadataReplaced = false;
  let commentsExisted = false;
  let metadataExisted = false;

  try {
    await writeTextFile(commentsStage, `${JSON.stringify(documents.commentDocument, null, 2)}\n`);
    await writeTextFile(metadataStage, `${JSON.stringify(documents.metadataDocument, null, 2)}\n`);
    commentsExisted = await replaceFileWithBackup(commentsStage, commentsPath, commentsBackup);
    commentsReplaced = true;
    metadataExisted = await replaceFileWithBackup(metadataStage, metadataPath, metadataBackup);
    metadataReplaced = true;
    await removeIfExists(commentsBackup);
    await removeIfExists(metadataBackup);
  } catch (error) {
    if (metadataReplaced) {
      await removeIfExists(metadataPath);
      if (metadataExisted && await pathExists(metadataBackup)) await fs.rename(metadataBackup, metadataPath);
    }
    if (commentsReplaced) {
      await removeIfExists(commentsPath);
      if (commentsExisted && await pathExists(commentsBackup)) await fs.rename(commentsBackup, commentsPath);
    }
    await removeIfExists(commentsStage);
    await removeIfExists(metadataStage);
    throw error;
  }
  return { commentsPath, metadataPath };
}

export function buildMergeJob(audit, mergedVideoIds, writeFailures = []) {
  const mergedSet = new Set(mergedVideoIds);
  const skipped = audit.videos
    .filter((video) => !mergedSet.has(video.video_id))
    .map((video) => ({
      video_id: video.video_id,
      reasons: video.blocking_reasons.length ? video.blocking_reasons : ['merge_write_failed'],
    }));
  for (const failure of writeFailures) {
    const existing = skipped.find((item) => item.video_id === failure.video_id);
    if (existing) existing.error = failure.error;
  }
  const totalVideos = audit.summary.catalog_video_count;
  const allCheckpointReady = audit.summary.ready_to_merge_videos === totalVideos;
  const allExact = audit.summary.status_counts.complete === totalVideos;
  const status = allCheckpointReady ? (allExact ? 'complete' : 'complete_with_gaps') : 'partial';
  return {
    schema_version: 3,
    status,
    updated_at: new Date().toISOString(),
    total_videos: totalVideos,
    completed_videos: mergedVideoIds.length,
    remaining_videos: Math.max(0, totalVideos - mergedVideoIds.length),
    method: COLLECTION_METHOD,
    merge_policy: 'overwrite_video_only_when_root_and_all_expected_reply_checkpoints_are_valid_and_exhausted',
    checkpoint_coverage: clone(audit.summary),
    merged_video_ids: [...mergedVideoIds],
    skipped_videos: skipped,
    write_failures: writeFailures,
  };
}

export async function writeJobState(outputDir, job) {
  const destinationPath = path.join(outputDir, 'state', 'job.json');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagePath = `${destinationPath}.stage-${token}`;
  const backupPath = `${destinationPath}.backup-${token}`;
  await writeTextFile(stagePath, `${JSON.stringify(job, null, 2)}\n`);
  const existed = await replaceFileWithBackup(stagePath, destinationPath, backupPath);
  if (existed) await removeIfExists(backupPath);
  return destinationPath;
}

export async function mergeCheckpointDataset({
  dataDir = DEFAULT_DATA_DIR,
  outputDir = dataDir,
  dryRun = false,
} = {}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const { audit, entries } = await inspectCheckpointDataset(dataDir);
  const mergedVideoIds = [];
  const writeFailures = [];
  const outputs = [];

  for (const entry of entries) {
    if (!entry.report.ready_to_merge) continue;
    try {
      const documents = buildMergedVideoDocuments(entry);
      if (!dryRun) {
        outputs.push(await writeMergedVideo(resolvedOutputDir, entry.video.video_id, documents));
      }
      mergedVideoIds.push(entry.video.video_id);
    } catch (error) {
      writeFailures.push({
        video_id: entry.video.video_id,
        error: String(error?.message || error),
      });
    }
  }

  const job = buildMergeJob(audit, mergedVideoIds, writeFailures);
  const jobPath = dryRun ? '' : await writeJobState(resolvedOutputDir, job);
  return {
    dry_run: dryRun,
    data_dir: path.resolve(dataDir),
    output_dir: resolvedOutputDir,
    audit_summary: audit.summary,
    merge_summary: {
      eligible_videos: audit.summary.ready_to_merge_videos,
      merged_videos: mergedVideoIds.length,
      skipped_videos: audit.summary.catalog_video_count - mergedVideoIds.length,
      write_failures: writeFailures.length,
      status: job.status,
    },
    merged_video_ids: mergedVideoIds,
    write_failures: writeFailures,
    output_files: outputs,
    job_path: jobPath,
    job,
  };
}
