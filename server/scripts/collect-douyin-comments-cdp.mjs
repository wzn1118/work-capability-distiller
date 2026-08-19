import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_OUTPUT_DIR = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const DEFAULT_CDP_URL = 'http://127.0.0.1:18800';
const DEFAULT_START_VIDEO_ID = '7670799283649547570';
const TARGET_AUTHOR_SEC_UID = 'MS4wLjABAAAAp6d23uHLTkIpaJi7vE96ASfWzO-br8liFRcDwPJn6YR7RuvE00a7jhnTTIndzFyY';

function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    cdpUrl: DEFAULT_CDP_URL,
    concurrency: 8,
    startVideoId: DEFAULT_START_VIDEO_ID,
    refresh: false,
    forceBackupCdn: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--cdp-url') options.cdpUrl = argv[++index];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--start-video-id') options.startVideoId = argv[++index];
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--force-backup-cdn') options.forceBackupCdn = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error('--concurrency must be an integer between 1 and 16');
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome CDP')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Chrome CDP WebSocket connection failed'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.#onMessage(event));
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Chrome CDP WebSocket closed'));
      }
      this.pending.clear();
    });
  }

  async #onMessage(event) {
    let payload = event.data;
    if (payload instanceof Blob) payload = await payload.text();
    if (payload instanceof ArrayBuffer) payload = Buffer.from(payload).toString('utf8');
    const message = JSON.parse(String(payload));
    if (message.id) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${message.error.message} (${message.error.code})`));
      else request.resolve(message.result);
      return;
    }
    if (!message.method) return;
    this.events.push({ method: message.method, params: message.params, receivedAt: Date.now() });
    if (this.events.length > 10_000) this.events.splice(0, 2_000);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  findLatestResponse(predicate, since = 0) {
    return [...this.events].reverse().find((event) => (
      event.receivedAt >= since
      && event.method === 'Network.responseReceived'
      && predicate(event.params?.response?.url || '')
    ));
  }

  close() {
    this.socket?.close();
  }
}

async function createTarget(cdpUrl, url) {
  const response = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Unable to create CDP target: HTTP ${response.status}`);
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new Error('CDP target did not provide a WebSocket URL');
  return target;
}

async function closeTarget(cdpUrl, targetId) {
  try {
    await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`);
  } catch {
    // The collection output is already durable; target cleanup is best effort.
  }
}

async function triggerCommentPagination(client) {
  const scrollTarget = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const container = document.querySelector('.route-scroll-container')
        || [...document.querySelectorAll('*')].find((node) => {
          const style = getComputedStyle(node);
          return /(auto|scroll)/.test(style.overflowY)
            && node.scrollHeight > node.clientHeight + 200;
        });
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      return {
        x: rect.left + (rect.width * 0.75),
        y: rect.top + (rect.height * 0.8),
        deltaY: Math.min(1800, Math.max(700, container.scrollHeight - container.clientHeight)),
      };
    })()`,
    returnByValue: true,
  });
  const target = scrollTarget.result?.value;
  if (!target) return false;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: target.x,
    y: target.y,
    deltaX: 0,
    deltaY: target.deltaY,
  });
  await sleep(3_000);
  return true;
}

async function captureSignedEndpoints(client, videoId, { forceBackupCdn = false } = {}) {
  await client.send('Network.enable');
  await client.send('Page.enable');
  if (forceBackupCdn) {
    await client.send('Network.setBlockedURLs', {
      urls: [
        '*://lf-douyin-pc-web.douyinstatic.com/*',
        '*://lf-security.bytegoofy.com/*',
      ],
    });
  }
  const startedAt = Date.now();
  await client.send('Page.reload', { ignoreCache: true });
  await sleep(forceBackupCdn ? 12_000 : 6_000);

  let rootEvent = client.findLatestResponse((url) => (
    url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/')
  ), startedAt);
  if (!rootEvent) {
    await triggerCommentPagination(client);
    rootEvent = client.findLatestResponse((url) => (
      url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/')
    ), startedAt);
  }
  if (!rootEvent) {
    await client.send('Page.reload', { ignoreCache: true });
    await sleep(forceBackupCdn ? 12_000 : 6_000);
    await triggerCommentPagination(client);
    rootEvent = client.findLatestResponse((url) => (
      url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/')
    ), startedAt);
  }
  if (!rootEvent) {
    const pageState = await client.send('Runtime.evaluate', {
      expression: `({ title: document.title, text: (document.body?.innerText || '').slice(0, 500) })`,
      returnByValue: true,
    });
    throw new Error(`The page did not issue a root-comment request: ${JSON.stringify(pageState.result?.value)}`);
  }

  const rootBody = await client.send('Network.getResponseBody', {
    requestId: rootEvent.params.requestId,
  });
  const rootPayload = JSON.parse(rootBody.body);
  const expandableRoot = (rootPayload.comments || []).find((comment) => Number(comment.reply_comment_total || 0) > 0);
  if (!expandableRoot) throw new Error('The seed video did not expose a reply thread');

  const replyStartedAt = Date.now();
  let replyEvent = null;
  let locatedButton = false;
  for (let attempt = 0; attempt < 6 && !replyEvent; attempt += 1) {
    const coordinateResult = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => (node.innerText || '').trim().startsWith('\u5c55\u5f00')
            && (node.innerText || '').includes('\u56de\u590d'));
        if (!button) return null;
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    const coordinate = coordinateResult.result?.value;
    if (!coordinate) break;
    locatedButton = true;
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coordinate.x,
      y: coordinate.y,
      button: 'none',
    });
    await sleep(100);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: coordinate.x,
      y: coordinate.y,
      button: 'left',
      clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: coordinate.x,
      y: coordinate.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(3_500);
    replyEvent = client.findLatestResponse((url) => (
      url.includes('/aweme/v1/web/comment/list/reply/')
    ), replyStartedAt);
  }
  if (!locatedButton) throw new Error('Unable to locate an expand-replies button on the seed video');
  if (!replyEvent) throw new Error('The page did not issue a reply-list request');

  return {
    rootUrl: rootEvent.params.response.url,
    replyUrl: replyEvent.params.response.url,
  };
}

function buildVideoExpression(videoId, rootBaseUrl, replyBaseUrl) {
  return `(async () => {
    const videoId = ${JSON.stringify(videoId)};
    const rootBase = ${JSON.stringify(rootBaseUrl)};
    const replyBase = ${JSON.stringify(replyBaseUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function getJson(url) {
      let lastError = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetch(url, { credentials: 'include', signal: controller.signal });
          const text = await response.text();
          clearTimeout(timer);
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = JSON.parse(text);
          if (Number(data.status_code || 0) !== 0) throw new Error('status_code ' + data.status_code);
          return data;
        } catch (error) {
          clearTimeout(timer);
          lastError = String(error?.message || error);
          if (attempt < 2) await sleep(300 * (2 ** attempt) + Math.floor(Math.random() * 180));
        }
      }
      throw new Error(lastError || 'request failed');
    }

    function withParams(base, params) {
      const url = new URL(base);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      return url.toString();
    }

    async function mapLimit(items, limit, mapper) {
      const output = new Array(items.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          output[index] = await mapper(items[index], index);
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
      return output;
    }

    function slim(comment) {
      const user = comment?.user || {};
      const labels = [];
      if (comment?.label_text) labels.push(String(comment.label_text));
      for (const label of comment?.label_list || []) {
        const value = typeof label === 'string' ? label : label?.label_text || label?.text || label?.name;
        if (value) labels.push(String(value));
      }
      const imageUrls = [];
      const seenUrls = new Set();
      function visit(value, depth) {
        if (depth > 5 || value == null) return;
        if (typeof value === 'string') {
          if (/^https?:\\/\\//.test(value) && !seenUrls.has(value)) {
            seenUrls.add(value);
            imageUrls.push(value);
          }
          return;
        }
        if (Array.isArray(value)) {
          for (const item of value) visit(item, depth + 1);
          return;
        }
        if (typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            if (key !== 'uri') visit(item, depth + 1);
          }
        }
      }
      visit(comment?.image_list, 0);
      return {
        cid: String(comment?.cid || ''),
        text: String(comment?.text || ''),
        aweme_id: String(comment?.aweme_id || videoId),
        create_time: Number(comment?.create_time || 0),
        digg_count: Number(comment?.digg_count || 0),
        ip_label: String(comment?.ip_label || ''),
        reply_id: String(comment?.reply_id || '0'),
        reply_to_reply_id: String(comment?.reply_to_reply_id || '0'),
        reply_comment_total: Number(comment?.reply_comment_total || 0),
        is_author_digged: Boolean(comment?.is_author_digged),
        is_hot: Boolean(comment?.is_hot),
        stick_position: Number(comment?.stick_position || 0),
        labels: [...new Set(labels)],
        image_urls: imageUrls,
        user: {
          nickname: String(user.nickname || ''),
          uid: String(user.uid || ''),
          sec_uid: String(user.sec_uid || ''),
          unique_id: String(user.unique_id || ''),
          short_id: String(user.short_id || ''),
          custom_verify: String(user.custom_verify || ''),
          enterprise_verify_reason: String(user.enterprise_verify_reason || ''),
        },
      };
    }

    const first = await getJson(withParams(rootBase, { aweme_id: videoId, cursor: 0, count: 50 }));
    const declaredTotal = Number(first.total || 0);
    const rootCursors = [];
    for (let cursor = 50; cursor <= declaredTotal; cursor += 50) rootCursors.push(cursor);
    const remainingRootPages = await mapLimit(rootCursors, 6, async (cursor) => {
      const page = await getJson(withParams(rootBase, { aweme_id: videoId, cursor, count: 50 }));
      return {
        requested_cursor: cursor,
        cursor: Number(page.cursor || 0),
        has_more: Number(page.has_more || 0),
        total: Number(page.total || 0),
        comments: page.comments || [],
      };
    });
    const rootPages = [{
      requested_cursor: 0,
      cursor: Number(first.cursor || 0),
      has_more: Number(first.has_more || 0),
      total: declaredTotal,
      comments: first.comments || [],
    }, ...remainingRootPages];
    const rootMap = new Map();
    for (const page of rootPages) {
      for (const comment of page.comments) {
        if (comment?.cid && !rootMap.has(String(comment.cid))) rootMap.set(String(comment.cid), comment);
      }
    }
    const roots = [...rootMap.values()];
    const replyRoots = roots.filter((comment) => Number(comment.reply_comment_total || 0) > 0);
    const replyBundles = await mapLimit(replyRoots, 10, async (root) => {
      const firstReply = await getJson(withParams(replyBase, {
        item_id: videoId,
        comment_id: root.cid,
        cursor: 0,
        count: 50,
      }));
      const replyTotal = Number(firstReply.total || root.reply_comment_total || 0);
      const cursors = [];
      for (let cursor = 50; cursor < replyTotal; cursor += 50) cursors.push(cursor);
      const remainingPages = await mapLimit(cursors, 5, async (cursor) => {
        const page = await getJson(withParams(replyBase, {
          item_id: videoId,
          comment_id: root.cid,
          cursor,
          count: 50,
        }));
        return {
          requested_cursor: cursor,
          cursor: Number(page.cursor || 0),
          has_more: Number(page.has_more || 0),
          total: Number(page.total || 0),
          comments: page.comments || [],
        };
      });
      return {
        root_comment_id: String(root.cid),
        declared_reply_count: Number(root.reply_comment_total || 0),
        api_reply_total: replyTotal,
        pages: [{
          requested_cursor: 0,
          cursor: Number(firstReply.cursor || 0),
          has_more: Number(firstReply.has_more || 0),
          total: replyTotal,
          comments: firstReply.comments || [],
        }, ...remainingPages],
      };
    });
    const replyMap = new Map();
    for (const bundle of replyBundles) {
      for (const page of bundle.pages) {
        for (const comment of page.comments) {
          if (comment?.cid && !replyMap.has(String(comment.cid))) replyMap.set(String(comment.cid), comment);
        }
      }
    }
    return JSON.stringify({
      video_id: videoId,
      declared_total: declaredTotal,
      roots: roots.map(slim),
      replies: [...replyMap.values()].map(slim),
      root_pages: rootPages.map((page) => ({
        requested_cursor: page.requested_cursor,
        cursor: page.cursor,
        has_more: page.has_more,
        total: page.total,
        received: page.comments.length,
      })),
      reply_bundles: replyBundles.map((bundle) => ({
        root_comment_id: bundle.root_comment_id,
        declared_reply_count: bundle.declared_reply_count,
        api_reply_total: bundle.api_reply_total,
        pages: bundle.pages.map((page) => ({
          requested_cursor: page.requested_cursor,
          cursor: page.cursor,
          has_more: page.has_more,
          total: page.total,
          received: page.comments.length,
        })),
      })),
    });
  })()`;
}

function cleanVideoTitle(cardText) {
  const lines = String(cardText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line, index) => (
    line !== '\u7f6e\u9876'
    && !(index < 3 && /^\d+(?:\.\d+)?(?:\u4e07|\u4ebf)?$/.test(line))
  )).join(' ');
}

function toShanghaiTime(epoch) {
  const value = Number(epoch || 0);
  if (!value) return '';
  return new Date((value + (8 * 60 * 60)) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeVideo(apiDocument, catalogVideo) {
  const videoId = String(apiDocument.video_id);
  const videoTitle = cleanVideoTitle(catalogVideo?.card_text);
  const videoUrl = String(catalogVideo?.url || `https://www.douyin.com/video/${videoId}`);
  const rows = [];

  for (const [kind, comments] of [['root', apiDocument.roots || []], ['reply', apiDocument.replies || []]]) {
    for (const comment of comments) {
      const isReply = kind === 'reply';
      const rootCommentId = isReply
        ? String(comment.reply_id && comment.reply_id !== '0' ? comment.reply_id : '')
        : String(comment.cid);
      const parentCommentId = isReply
        ? String(comment.reply_to_reply_id && comment.reply_to_reply_id !== '0'
          ? comment.reply_to_reply_id
          : rootCommentId)
        : '';
      const labels = Array.isArray(comment.labels) ? comment.labels : [];
      rows.push({
        comment_id: String(comment.cid || ''),
        root_comment_id: rootCommentId,
        parent_comment_id: parentCommentId || null,
        relation_type: isReply
          ? (parentCommentId && parentCommentId !== rootCommentId ? 'reply_to_reply' : 'reply_to_root')
          : 'root',
        is_reply: isReply,
        comment_user: String(comment.user?.nickname || ''),
        comment_user_raw: String(comment.user?.nickname || ''),
        comment_user_id: String(comment.user?.uid || ''),
        comment_user_sec_uid: String(comment.user?.sec_uid || ''),
        comment_user_unique_id: String(comment.user?.unique_id || ''),
        comment_user_short_id: String(comment.user?.short_id || ''),
        comment_user_url: comment.user?.sec_uid
          ? `https://www.douyin.com/user/${comment.user.sec_uid}`
          : '',
        comment_user_verification: String(
          comment.user?.custom_verify || comment.user?.enterprise_verify_reason || '',
        ),
        is_video_author: String(comment.user?.sec_uid || '') === TARGET_AUTHOR_SEC_UID,
        video_author_replied: labels.some((label) => String(label).includes('\u4f5c\u8005\u56de\u590d')),
        comment_content: String(comment.text || ''),
        comment_tags: labels,
        comment_image_urls: Array.isArray(comment.image_urls) ? comment.image_urls : [],
        comment_likes_raw: String(Number(comment.digg_count || 0)),
        comment_likes: Number(comment.digg_count || 0),
        comment_time_epoch: Number(comment.create_time || 0),
        comment_time: toShanghaiTime(comment.create_time),
        comment_time_iso_utc: comment.create_time
          ? new Date(Number(comment.create_time) * 1000).toISOString()
          : '',
        comment_location: String(comment.ip_label || ''),
        comment_time_location: [toShanghaiTime(comment.create_time), String(comment.ip_label || '')]
          .filter(Boolean)
          .join('\u00b7'),
        is_author_digged: Boolean(comment.is_author_digged),
        is_hot: Boolean(comment.is_hot),
        is_sticky: Number(comment.stick_position || 0) > 0,
        declared_child_reply_count: Number(comment.reply_comment_total || 0),
        video_id: videoId,
        video_title: videoTitle,
        video_url: videoUrl,
        video_publish_time: '',
      });
    }
  }

  const seenIds = new Set();
  const dedupedRows = rows.filter((row) => {
    if (!row.comment_id || seenIds.has(row.comment_id)) return false;
    seenIds.add(row.comment_id);
    return true;
  });
  const authorReplyRoots = new Set(dedupedRows
    .filter((row) => row.is_reply && row.is_video_author)
    .map((row) => row.root_comment_id));
  for (const row of dedupedRows) {
    if (!row.is_reply && authorReplyRoots.has(row.comment_id)) row.video_author_replied = true;
  }

  const rootCount = dedupedRows.filter((row) => !row.is_reply).length;
  const replyCount = dedupedRows.length - rootCount;
  const rootPaginationExhausted = (apiDocument.root_pages || [])
    .some((page) => Number(page.has_more || 0) === 0);
  const replyPaginationExhausted = (apiDocument.reply_bundles || [])
    .every((bundle) => (bundle.pages || []).some((page) => Number(page.has_more || 0) === 0));
  const declaredCount = Number(apiDocument.declared_total || 0);
  const countMatches = dedupedRows.length === declaredCount;
  const status = countMatches && rootPaginationExhausted && replyPaginationExhausted
    ? 'complete'
    : (rootPaginationExhausted && replyPaginationExhausted
      ? 'public_api_complete_with_gap'
      : 'incomplete');

  return {
    schema_version: 3,
    platform: 'douyin',
    account_name: '\u4e09\u56fd\u6740WUHU\u8054\u76df',
    douyin_id: 'sgswuhu666',
    video_id: videoId,
    video_title: videoTitle,
    video_url: videoUrl,
    video_publish_time: '',
    collected_at: new Date().toISOString(),
    collection_method: 'signed_public_web_api_via_logged_in_page',
    completeness: {
      declared_comment_count: declaredCount,
      captured_comment_count: dedupedRows.length,
      root_comment_count: rootCount,
      reply_count: replyCount,
      count_matches_declared: countMatches,
      root_pagination_exhausted: rootPaginationExhausted,
      reply_pagination_exhausted: replyPaginationExhausted,
      expected_reply_count_from_api: (apiDocument.reply_bundles || [])
        .reduce((total, bundle) => total + Number(bundle.api_reply_total || 0), 0),
      status,
    },
    api_audit: {
      root_pages: apiDocument.root_pages,
      reply_bundles: apiDocument.reply_bundles,
    },
    comments: dedupedRows,
  };
}

async function writeVideo(outputDir, document, catalogVideo) {
  const commentPath = path.join(outputDir, 'comments', `${document.video_id}.json`);
  const metadataPath = path.join(outputDir, 'metadata', `${document.video_id}.json`);
  const temporaryCommentPath = `${commentPath}.tmp`;
  const temporaryMetadataPath = `${metadataPath}.tmp`;
  const metadata = {
    schema_version: 3,
    platform: 'douyin',
    account_name: document.account_name,
    douyin_id: document.douyin_id,
    video_id: document.video_id,
    metadata: {
      video_id: document.video_id,
      video_title: document.video_title,
      video_url: document.video_url,
      video_card_text: String(catalogVideo?.card_text || ''),
      declared_comment_count: document.completeness.declared_comment_count,
    },
    completeness: document.completeness,
    collected_at: document.collected_at,
    collection_method: document.collection_method,
  };
  await fs.writeFile(temporaryCommentPath, JSON.stringify(document, null, 2), 'utf8');
  await fs.rename(temporaryCommentPath, commentPath);
  await fs.writeFile(temporaryMetadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  await fs.rename(temporaryMetadataPath, metadataPath);
}

async function writeJobState(outputDir, catalogCount, completedIds, results, status = 'running') {
  const document = {
    status,
    updated_at: new Date().toISOString(),
    total_videos: catalogCount,
    completed_videos: completedIds.size,
    remaining_videos: Math.max(0, catalogCount - completedIds.size),
    method: 'signed_public_web_api_high_concurrency',
    last_batch: results.slice(-20),
  };
  await fs.writeFile(path.join(outputDir, 'state', 'job.json'), JSON.stringify(document, null, 2), 'utf8');
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(await fs.readFile(path.join(options.outputDir, 'catalog.json'), 'utf8'));
  const videos = Array.isArray(catalog.videos) ? catalog.videos : [];
  if (videos.length === 0) throw new Error('catalog.json does not contain videos');
  await fs.mkdir(path.join(options.outputDir, 'comments'), { recursive: true });
  await fs.mkdir(path.join(options.outputDir, 'metadata'), { recursive: true });
  await fs.mkdir(path.join(options.outputDir, 'state'), { recursive: true });

  const existingNames = await fs.readdir(path.join(options.outputDir, 'comments'));
  const completedIds = new Set(existingNames
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length)));
  const queue = options.refresh
    ? videos
    : videos.filter((video) => !completedIds.has(String(video.video_id)));
  console.log(`[douyin-comments] queue=${queue.length} existing=${completedIds.size} concurrency=${options.concurrency}`);
  if (queue.length === 0) {
    await writeJobState(options.outputDir, videos.length, completedIds, [], 'complete');
    return;
  }

  const seedUrl = `https://www.douyin.com/video/${options.startVideoId}`;
  const target = await createTarget(options.cdpUrl, seedUrl);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  const runResults = [];
  try {
    await client.connect();
    const endpoints = await captureSignedEndpoints(client, options.startVideoId, {
      forceBackupCdn: options.forceBackupCdn,
    });
    console.log('[douyin-comments] signed root and reply endpoints captured');

    await mapConcurrent(queue, options.concurrency, async (catalogVideo, index) => {
      const videoId = String(catalogVideo.video_id);
      const startedAt = Date.now();
      let lastError = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const evaluation = await client.send('Runtime.evaluate', {
            expression: buildVideoExpression(videoId, endpoints.rootUrl, endpoints.replyUrl),
            awaitPromise: true,
            returnByValue: true,
          }, 180_000);
          if (evaluation.exceptionDetails) {
            throw new Error(evaluation.exceptionDetails.exception?.description
              || evaluation.exceptionDetails.text
              || 'Runtime.evaluate failed');
          }
          const apiDocument = JSON.parse(evaluation.result?.value || '');
          const normalized = normalizeVideo(apiDocument, catalogVideo);
          await writeVideo(options.outputDir, normalized, catalogVideo);
          completedIds.add(videoId);
          const result = {
            ok: true,
            video_id: videoId,
            declared: normalized.completeness.declared_comment_count,
            captured: normalized.completeness.captured_comment_count,
            roots: normalized.completeness.root_comment_count,
            replies: normalized.completeness.reply_count,
            status: normalized.completeness.status,
            elapsed_ms: Date.now() - startedAt,
          };
          runResults.push(result);
          await writeJobState(options.outputDir, videos.length, completedIds, runResults);
          console.log(`[douyin-comments] ${index + 1}/${queue.length} ${videoId} ${result.captured}/${result.declared} ${result.status} ${result.elapsed_ms}ms`);
          return result;
        } catch (error) {
          lastError = String(error?.message || error);
          if (attempt === 0) await sleep(1_000 + Math.floor(Math.random() * 500));
        }
      }
      const result = {
        ok: false,
        video_id: videoId,
        error: lastError,
        elapsed_ms: Date.now() - startedAt,
      };
      runResults.push(result);
      await writeJobState(options.outputDir, videos.length, completedIds, runResults);
      console.error(`[douyin-comments] ${index + 1}/${queue.length} ${videoId} FAILED: ${lastError}`);
      return result;
    });
  } finally {
    client.close();
    await closeTarget(options.cdpUrl, target.id);
  }

  const failures = runResults.filter((result) => !result.ok);
  await writeJobState(
    options.outputDir,
    videos.length,
    completedIds,
    runResults,
    failures.length === 0 && completedIds.size >= videos.length ? 'complete' : 'partial',
  );
  console.log(`[douyin-comments] finished completed=${completedIds.size}/${videos.length} failures=${failures.length}`);
  if (failures.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[douyin-comments] fatal: ${error?.stack || error}`);
  process.exitCode = 1;
});
