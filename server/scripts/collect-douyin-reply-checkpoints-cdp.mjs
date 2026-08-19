import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_OUTPUT_DIR = 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const DEFAULT_CDP_URL = 'http://127.0.0.1:18801';

function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    cdpUrl: DEFAULT_CDP_URL,
    concurrency: 2,
    limit: 20,
    count: 3,
    delayMin: 800,
    delayMax: 1400,
    refreshUnderDeclared: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--cdp-url') options.cdpUrl = argv[++index];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--count') options.count = Number(argv[++index]);
    else if (arg === '--delay-min') options.delayMin = Number(argv[++index]);
    else if (arg === '--delay-max') options.delayMax = Number(argv[++index]);
    else if (arg === '--refresh-under-declared') options.refreshUnderDeclared = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) {
    throw new Error('--concurrency must be an integer between 1 and 12');
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error('--limit must be a non-negative integer; 0 means all pending tasks');
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 50) {
    throw new Error('--count must be an integer between 1 and 50');
  }
  if (options.delayMin < 0 || options.delayMax < options.delayMin) {
    throw new Error('Invalid delay range');
  }
  return options;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.pending = new Map();
    this.nextId = 1;
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
    this.socket.addEventListener('message', async (event) => {
      let raw = event.data;
      if (raw instanceof Blob) raw = await raw.text();
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome CDP WebSocket closed'));
      }
      this.pending.clear();
    });
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

  close() {
    this.socket?.close();
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validExistingCheckpoint(filePath, task, { refreshUnderDeclared = false } = {}) {
  try {
    const checkpoint = await readJson(filePath);
    const structurallyValid = checkpoint?.pagination_exhausted === true
      && String(checkpoint.video_id) === task.video_id
      && String(checkpoint.root_comment_id) === task.comment_id
      && Array.isArray(checkpoint.replies)
      && Array.isArray(checkpoint.pages)
      && checkpoint.pages.length > 0
      && Number(checkpoint.pages.at(-1)?.has_more || 0) === 0;
    if (!structurallyValid) return false;
    return !refreshUnderDeclared || checkpoint.replies.length >= task.declared_reply_count;
  } catch {
    return false;
  }
}

async function loadPendingTasks(outputDir, { refreshUnderDeclared = false } = {}) {
  const rootDir = path.join(outputDir, 'state', 'root-api');
  const replyDir = path.join(outputDir, 'state', 'reply-api');
  const rootFiles = (await fs.readdir(rootDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const all = [];
  for (const fileName of rootFiles) {
    const checkpoint = await readJson(path.join(rootDir, fileName));
    const videoId = String(checkpoint.video_id || fileName.slice(0, -5));
    for (const root of checkpoint.roots || []) {
      if (Number(root.reply_comment_total || 0) <= 0 || !root.cid) continue;
      all.push({
        video_id: videoId,
        comment_id: String(root.cid),
        declared_reply_count: Number(root.reply_comment_total || 0),
      });
    }
  }
  const pending = [];
  for (const task of all) {
    const checkpointPath = path.join(replyDir, task.video_id, `${task.comment_id}.json`);
    if (!await validExistingCheckpoint(checkpointPath, task, { refreshUnderDeclared })) pending.push(task);
  }
  return { all, pending, replyDir };
}

function buildReplyExpression(rootBaseUrl, task, count) {
  return `(async () => {
    const rootBase = ${JSON.stringify(rootBaseUrl)};
    const task = ${JSON.stringify(task)};
    const count = ${JSON.stringify(count)};
    const request = (url) => new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.withCredentials = true;
      xhr.timeout = 15000;
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText || '' });
      xhr.onerror = () => resolve({ status: 0, text: '', error: 'network_error' });
      xhr.ontimeout = () => resolve({ status: 0, text: '', error: 'timeout' });
      xhr.send();
    });
    const replies = [];
    const pages = [];
    const seen = new Set();
    let cursor = '0';
    let apiReplyTotal = null;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const url = new URL(rootBase, location.origin);
      url.pathname = '/aweme/v1/web/comment/list/reply/';
      for (const key of [
        'aweme_id', 'insert_ids', 'hotsoon_filtered_count', 'whale_cut_token',
        'cut_version', 'rcFT', 'pc_img_format', 'item_type', 'a_bogus', 'X-Bogus'
      ]) url.searchParams.delete(key);
      url.searchParams.set('item_id', task.video_id);
      url.searchParams.set('comment_id', task.comment_id);
      url.searchParams.set('cursor', cursor);
      url.searchParams.set('count', String(count));
      const response = await request(url.toString());
      const bytes = response.text.length;
      if (response.status === 200 && bytes === 0) {
        return { ok: false, task, error: { error: 'transport_empty', status: 200, bytes: 0 } };
      }
      if (response.error) {
        return { ok: false, task, error: { error: response.error, status: response.status, bytes } };
      }
      if (response.status !== 200) {
        return { ok: false, task, error: { error: 'http_error', status: response.status, bytes } };
      }
      let payload;
      try {
        payload = JSON.parse(response.text);
      } catch {
        return { ok: false, task, error: { error: 'invalid_json', status: response.status, bytes } };
      }
      if (Number(payload.status_code || 0) !== 0) {
        return {
          ok: false,
          task,
          error: {
            error: 'api_error',
            status: response.status,
            bytes,
            api_status_code: payload.status_code,
            api_status_msg: payload.status_msg || '',
          },
        };
      }
      const comments = Array.isArray(payload.comments) ? payload.comments : [];
      if (apiReplyTotal === null) apiReplyTotal = Number(payload.total || 0);
      for (const comment of comments) {
        const id = String(comment?.cid || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        replies.push(comment);
      }
      const nextCursor = String(payload.cursor ?? '0');
      const hasMore = Number(payload.has_more || 0);
      pages.push({
        requested_cursor: Number(cursor),
        cursor: Number(nextCursor),
        has_more: hasMore,
        total: Number(payload.total || 0),
        received: comments.length,
      });
      if (hasMore === 0) {
        return {
          ok: true,
          task,
          api_reply_total: Number(apiReplyTotal || 0),
          replies,
          pages,
          pagination_exhausted: true,
        };
      }
      if (nextCursor === cursor) {
        return { ok: false, task, error: { error: 'cursor_stalled', cursor } };
      }
      cursor = nextCursor;
    }
    return { ok: false, task, error: { error: 'page_limit_exceeded' } };
  })()`;
}

async function writeCheckpoint(replyDir, result) {
  const task = result.task;
  const directory = path.join(replyDir, task.video_id);
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${task.comment_id}.json`);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const checkpoint = {
    schema_version: 1,
    video_id: task.video_id,
    root_comment_id: task.comment_id,
    declared_reply_count: task.declared_reply_count,
    api_reply_total: Number(result.api_reply_total || 0),
    replies: result.replies,
    pages: result.pages,
    pagination_exhausted: true,
    captured_at: new Date().toISOString(),
    source: 'douyin_public_web_comment_reply_api',
  };
  await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
}

async function findDouyinTarget(cdpUrl) {
  const targets = await (await fetch(`${cdpUrl}/json`)).json();
  const target = targets.find((item) => (
    item.type === 'page'
    && /^https:\/\/www\.douyin\.com\/video\//.test(item.url)
    && item.webSocketDebuggerUrl
  ));
  if (!target) throw new Error(`No Douyin video page found at ${cdpUrl}`);
  return target;
}

async function captureRootBaseUrl(client) {
  const expression = `(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .reverse()
    .find((url) => url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/')) || '')()`;
  let evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  let rootUrl = evaluated.result?.value || '';
  if (rootUrl) return rootUrl;
  await client.send('Network.enable');
  await client.send('Page.reload', { ignoreCache: true });
  await sleep(8_000);
  evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  rootUrl = evaluated.result?.value || '';
  if (!rootUrl) throw new Error('No in-memory root-comment request was available on the page');
  return rootUrl;
}

async function writeRunLedger(outputDir, ledger) {
  const directory = path.join(outputDir, 'state', 'reply-api-attempts');
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(directory, `${stamp}.json`);
  await fs.writeFile(destination, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return destination;
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const { all, pending, replyDir } = await loadPendingTasks(options.outputDir, {
  refreshUnderDeclared: options.refreshUnderDeclared,
});
const queue = options.limit === 0 ? pending : pending.slice(0, options.limit);
console.log(`[reply-cdp] expected=${all.length} pending=${pending.length} queue=${queue.length} concurrency=${options.concurrency}`);

if (queue.length === 0) {
  console.log(JSON.stringify({ status: 'complete', expected: all.length, pending: pending.length }));
  process.exit(0);
}

const target = await findDouyinTarget(options.cdpUrl);
const client = new CdpClient(target.webSocketDebuggerUrl);
const failures = [];
let saved = 0;
let attempted = 0;
let nextIndex = 0;
let circuitOpen = false;

try {
  await client.connect();
  const rootBaseUrl = await captureRootBaseUrl(client);

  async function worker(workerId) {
    for (;;) {
      if (circuitOpen) return;
      const index = nextIndex++;
      if (index >= queue.length) return;
      const task = queue[index];
      attempted += 1;
      let result;
      try {
        const evaluation = await client.send('Runtime.evaluate', {
          expression: buildReplyExpression(rootBaseUrl, task, options.count),
          awaitPromise: true,
          returnByValue: true,
        }, 120_000);
        result = evaluation.result?.value;
      } catch (error) {
        result = { ok: false, task, error: { error: 'cdp_error', message: String(error?.message || error) } };
      }

      if (result?.ok && result.pagination_exhausted) {
        await writeCheckpoint(replyDir, result);
        saved += 1;
        if (saved % 10 === 0 || saved === queue.length) {
          console.log(`[reply-cdp] saved=${saved}/${queue.length} worker=${workerId}`);
        }
      } else {
        const error = result?.error || { error: 'missing_result' };
        failures.push({
          video_id: task.video_id,
          root_comment_id: task.comment_id,
          worker_id: workerId,
          attempted_at: new Date().toISOString(),
          ...error,
        });
        if (['transport_empty', 'network_error', 'timeout', 'cdp_error'].includes(error.error)) {
          circuitOpen = true;
          console.error(`[reply-cdp] circuit-open error=${error.error} saved=${saved}`);
          return;
        }
      }

      if (!circuitOpen && nextIndex < queue.length) {
        const delay = options.delayMin
          + Math.floor(Math.random() * (options.delayMax - options.delayMin + 1));
        await sleep(delay);
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(options.concurrency, queue.length) },
    (_, index) => worker(index + 1),
  ));
} finally {
  client.close();
}

const ledger = {
  schema_version: 1,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  cdp_url: options.cdpUrl,
  expected_reply_threads: all.length,
  pending_before: pending.length,
  queued: queue.length,
  attempted,
  saved,
  failed: failures.length,
  circuit_open: circuitOpen,
  concurrency: options.concurrency,
  count: options.count,
  refresh_under_declared: options.refreshUnderDeclared,
  delay_min_ms: options.delayMin,
  delay_max_ms: options.delayMax,
  failures,
};
const ledgerPath = await writeRunLedger(options.outputDir, ledger);
console.log(JSON.stringify({ ...ledger, ledger_path: ledgerPath }));
if (failures.length > 0 || circuitOpen) process.exitCode = 2;
