import { atomicWrite, atomicWriteJson } from './checkpoint-store.mjs';
import { asId, asInteger, isoNow } from './contracts.mjs';

function toShanghaiTime(epoch) {
  const seconds = Number(epoch);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(seconds * 1000));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function labelsFor(comment) {
  const labels = [];
  for (const source of [comment?.labels, comment?.label_list]) {
    if (!Array.isArray(source)) continue;
    for (const label of source) {
      const value = typeof label === 'string' ? label : label?.label_text || label?.text || label?.name;
      if (value) labels.push(String(value));
    }
  }
  if (comment?.label_text) labels.push(String(comment.label_text));
  return [...new Set(labels)];
}

function imageUrlsFor(comment) {
  const values = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value)) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) if (key !== 'uri') visit(item, depth + 1);
    }
  };
  visit(comment?.image_list);
  visit(comment?.image_urls);
  return [...new Set(values)];
}

function normalizeRawComment(comment, kind, rootCommentId, video) {
  const commentId = asId(comment?.cid);
  const replyId = asId(comment?.reply_id);
  const replyToReplyId = asId(comment?.reply_to_reply_id);
  const rootId = kind === 'root' ? commentId : (replyId && replyId !== '0' ? replyId : rootCommentId);
  const parentId = kind === 'root'
    ? ''
    : (replyToReplyId && replyToReplyId !== '0' ? replyToReplyId : rootId);
  const user = comment?.user || {};
  const secUid = asId(user.sec_uid);
  const createdAt = Number(comment?.create_time || 0);
  const tagValues = labelsFor(comment);
  return {
    comment_id: commentId,
    root_comment_id: rootId,
    parent_comment_id: parentId || null,
    relation_type: kind === 'root' ? 'root' : (parentId && parentId !== rootId ? 'reply_to_reply' : 'reply_to_root'),
    is_reply: kind === 'reply',
    comment_user: String(user.nickname || ''),
    comment_user_raw: String(user.nickname || ''),
    comment_user_id: asId(user.uid),
    comment_user_sec_uid: secUid,
    comment_user_unique_id: asId(user.unique_id),
    comment_user_short_id: asId(user.short_id),
    comment_user_url: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    comment_user_verification: String(user.custom_verify || user.enterprise_verify_reason || ''),
    is_video_author: Boolean(comment?.is_author_comment || comment?.is_author_reply),
    video_author_replied: tagValues.some((value) => value.includes('author') || value.includes('作者回复')),
    comment_content: String(comment?.text || ''),
    comment_tags: tagValues,
    comment_image_urls: imageUrlsFor(comment),
    comment_likes_raw: String(asInteger(comment?.digg_count, 0)),
    comment_likes: asInteger(comment?.digg_count, 0),
    comment_time_epoch: createdAt || null,
    comment_time: toShanghaiTime(createdAt),
    comment_time_iso_utc: createdAt ? new Date(createdAt * 1000).toISOString() : '',
    comment_location: String(comment?.ip_label || ''),
    comment_time_location: [toShanghaiTime(createdAt), String(comment?.ip_label || '')].filter(Boolean).join(' | '),
    is_author_digged: Boolean(comment?.is_author_digged),
    is_hot: Boolean(comment?.is_hot),
    is_sticky: Boolean(comment?.is_stick) || asInteger(comment?.stick_position, 0) > 0,
    declared_child_reply_count: asInteger(comment?.reply_comment_total, 0),
    video_id: video.video_id,
    video_title: video.video_title || video.card_text || '',
    video_url: video.video_url || video.url || `https://www.douyin.com/video/${video.video_id}`,
    video_publish_time: video.video_publish_time || '',
    row_source: 'douyin_public_web_api_checkpoint',
  };
}

function dedupeByCommentId(rows) {
  const seen = new Set();
  const duplicateCommentIds = [];
  const output = [];
  for (const row of rows) {
    if (!row.comment_id) continue;
    if (seen.has(row.comment_id)) {
      duplicateCommentIds.push(row.comment_id);
      continue;
    }
    seen.add(row.comment_id);
    output.push(row);
  }
  return { rows: output, duplicateCommentIds };
}

export function normalizeVideoCheckpoint({ video, rootPages, replyPagesByRoot, rootTask, replyTasks }) {
  const sourceRows = [];
  for (const page of rootPages) for (const comment of page.comments || []) sourceRows.push(normalizeRawComment(comment, 'root', '', video));
  for (const [rootCommentId, pages] of replyPagesByRoot.entries()) {
    for (const page of pages) for (const comment of page.comments || []) sourceRows.push(normalizeRawComment(comment, 'reply', rootCommentId, video));
  }
  const { rows, duplicateCommentIds } = dedupeByCommentId(sourceRows);
  const rootRows = rows.filter((row) => !row.is_reply);
  const replyRows = rows.filter((row) => row.is_reply);
  const firstRoot = rootPages[0] || {};
  const allRepliesTerminal = replyTasks.every((task) => ['complete', 'public_api_complete_with_gap'].includes(task.status));
  const rootTerminal = ['complete', 'public_api_complete_with_gap'].includes(rootTask?.status);
  const traversalComplete = rootTerminal && allRepliesTerminal;
  const declaredRootCount = Number(rootTask?.declaredTotal || firstRoot.total || 0);
  const declaredReplyCount = replyTasks.reduce((sum, task) => (
    sum + Number(task?.declaredTotal || task?.declaredReplyCount || 0)
  ), 0);
  const declared = declaredRootCount + declaredReplyCount;
  const countMatchesDeclared = declared > 0 ? declared === rows.length : false;
  const status = !traversalComplete
    ? 'incomplete'
    : countMatchesDeclared ? 'complete' : 'public_api_complete_with_gap';
  const byId = new Map(rows.map((item) => [item.comment_id, item]));
  const commentsWithRelations = rows.map((row) => {
    if (!row.is_reply) return row;
    const parent = row.parent_comment_id ? byId.get(row.parent_comment_id) : null;
    return {
      ...row,
      parent_comment_user: parent?.comment_user || '',
      parent_comment_content: parent?.comment_content || '',
      direct_parent_known: Boolean(parent),
      relationship_quality: parent ? 'exact' : 'parent_unavailable',
    };
  });
  const completeness = {
    status,
    traversal_status: traversalComplete ? 'public_api_traversal_complete' : 'technical_pending',
    declared_comment_count: declared || null,
    declared_root_comment_count: declaredRootCount || null,
    declared_reply_count: declaredReplyCount || null,
    captured_comment_count: commentsWithRelations.length,
    root_comment_count: rootRows.length,
    reply_count: replyRows.length,
    declared_minus_captured: declared ? declared - commentsWithRelations.length : null,
    count_matches_declared: countMatchesDeclared,
    end_marker: traversalComplete,
    remaining_expand_buttons: 0,
    root_pagination_exhausted: rootTerminal,
    reply_pagination_exhausted: allRepliesTerminal,
    duplicate_comment_count: duplicateCommentIds.length,
    root_task_status: rootTask?.status || 'missing',
    reply_tasks_total: replyTasks.length,
    reply_tasks_terminal: replyTasks.filter((task) => ['complete', 'public_api_complete_with_gap'].includes(task.status)).length,
  };
  return {
    comments: commentsWithRelations,
    metadata: {
      video_id: video.video_id,
      video_title: video.video_title || video.card_text || '',
      video_url: video.video_url || video.url || `https://www.douyin.com/video/${video.video_id}`,
      declared_comment_count: completeness.declared_comment_count,
      captured_comment_count: completeness.captured_comment_count,
      root_comment_count: completeness.root_comment_count,
      reply_count: completeness.reply_count,
      completeness,
    },
    completeness,
  };
}

export async function writeNormalizedVideo({ store, jobId, video, rootPages, replyPagesByRoot, rootTask, replyTasks }) {
  const normalized = normalizeVideoCheckpoint({ video, rootPages, replyPagesByRoot, rootTask, replyTasks });
  const ndjson = normalized.comments.map((row) => JSON.stringify(row)).join('\n');
  await Promise.all([
    atomicWrite(store.file(jobId, 'normalized', 'comments', `${video.video_id}.ndjson`), ndjson ? `${ndjson}\n` : ''),
    atomicWriteJson(store.file(jobId, 'normalized', 'videos', `${video.video_id}.json`), {
      generated_at: isoNow(),
      video,
      completeness: normalized.completeness,
    }),
    store.writeSourceDocument(jobId, video.video_id, normalized),
  ]);
  return normalized;
}
