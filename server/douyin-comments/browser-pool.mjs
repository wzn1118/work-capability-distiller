import { randomUUID } from 'node:crypto';
import { DouyinCommentError, asId, asText, normalizeCatalogVideo, normalizeProfileUrl, sortCatalogVideos } from './contracts.mjs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MANAGED_LANE_PARAM = '__kolforge_comment_lane';
const activeLaneRunMarkers = new Set();

export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new DouyinCommentError('CDP_WEBSOCKET_UNAVAILABLE', 'This Node runtime does not expose WebSocket.', 503);
    }
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome CDP.')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Chrome CDP WebSocket connection failed.'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.#onMessage(event));
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Chrome CDP WebSocket closed.'));
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
    if (this.events.length > 12_000) this.events.splice(0, 2_000);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (!this.socket) return Promise.reject(new Error('CDP client is not connected.'));
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

async function createTarget(cdpUrl, targetUrl) {
  const response = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) throw new DouyinCommentError('CDP_TARGET_CREATE_FAILED', `Unable to create browser tab (HTTP ${response.status}).`, 503);
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new DouyinCommentError('CDP_TARGET_INVALID', 'Chrome did not provide a debugger URL.', 503);
  return target;
}

async function closeTarget(cdpUrl, targetId) {
  if (!targetId) return;
  try {
    await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`);
  } catch {
    // Browser cleanup is best effort after page checkpoints have been written.
  }
}

export function managedLaneUrl(targetUrl, marker) {
  const url = new URL(targetUrl);
  url.searchParams.set(MANAGED_LANE_PARAM, asText(marker) || 'managed');
  return url.toString();
}

export function isManagedLaneTarget(target) {
  if (target?.type !== 'page' || !target?.id) return false;
  try {
    return new URL(target.url || '').searchParams.has(MANAGED_LANE_PARAM);
  } catch {
    return false;
  }
}

async function cleanupManagedLaneTargets(cdpUrl) {
  let targets = [];
  try {
    const response = await fetch(`${cdpUrl}/json/list`);
    if (!response.ok) return 0;
    targets = await response.json();
  } catch {
    return 0;
  }
  const managedTargets = targets.filter((target) => {
    if (!isManagedLaneTarget(target)) return false;
    const marker = new URL(target.url).searchParams.get(MANAGED_LANE_PARAM) || '';
    return ![...activeLaneRunMarkers].some((activeMarker) => marker.startsWith(`${activeMarker}-`));
  });
  await Promise.all(managedTargets.map((target) => closeTarget(cdpUrl, target.id)));
  return managedTargets.length;
}

async function waitForPageReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, 2_000);
      if (result.result?.value === 'complete') return true;
    } catch {
      // A renderer can be temporarily unavailable while Chrome commits navigation.
    }
    await sleep(400);
  }
  return false;
}

async function ensurePageReady(client, targetUrl = '') {
  await client.send('Page.enable');
  const navigationDeadline = Date.now() + 4_000;
  let currentUrl = '';
  while (Date.now() < navigationDeadline) {
    const location = await client.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    currentUrl = asText(location.result?.value);
    if (currentUrl && currentUrl !== 'about:blank') break;
    await sleep(200);
  }
  if ((!currentUrl || currentUrl === 'about:blank') && targetUrl) {
    try {
      await client.send('Page.navigate', { url: targetUrl }, 8_000);
    } catch {
      // Page.navigate can time out even after Chrome accepted the navigation.
      // Continue with readiness checks and let endpoint rotation decide the result.
    }
  }
  if (await waitForPageReady(client, 4_000)) return { usedBackupCdn: false, ready: true };
  await client.send('Network.enable');
  await client.send('Network.setBlockedURLs', {
    urls: ['*://lf-douyin-pc-web.douyinstatic.com/*', '*://lf-security.bytegoofy.com/*'],
  });
  try {
    await client.send('Page.reload', { ignoreCache: false }, 8_000);
  } catch {
    // The reload may still be in progress; the bounded readiness loop handles it.
  }
  return { usedBackupCdn: true, ready: await waitForPageReady(client, 15_000) };
}

async function dismissLoginOverlay(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
      };
      const containers = [...document.querySelectorAll('[role="dialog"],div')]
        .filter(visible)
        .filter((node) => /登录|扫码|验证码/.test(node.innerText || ''))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width >= 500 && rect.height >= 300)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const modal = containers[0];
      if (!modal) return null;
      const candidates = [...document.querySelectorAll('button,svg,i,span,div')]
        .filter(visible)
        .map((node) => ({ node, rect: node.getBoundingClientRect(), style: getComputedStyle(node) }))
        .filter(({ rect }) => rect.left >= modal.rect.right - 120
          && rect.right <= modal.rect.right + 5
          && rect.top >= modal.rect.top
          && rect.bottom <= modal.rect.top + 110
          && rect.width <= 100 && rect.height <= 100)
        .sort((a, b) => Number(b.style.cursor === 'pointer') - Number(a.style.cursor === 'pointer'));
      const candidate = candidates[0];
      return {
        x: candidate ? candidate.rect.left + candidate.rect.width / 2 : modal.rect.right - 42,
        y: candidate ? candidate.rect.top + candidate.rect.height / 2 : modal.rect.top + 48,
      };
    })()`,
    returnByValue: true,
  });
  const target = result.result?.value;
  if (!target) return false;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
  await sleep(100);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(3_000);
  return true;
}

async function inspectCatalogPage(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      videoLinks: document.querySelectorAll('a[href*="/video/"]').length,
      noteLinks: document.querySelectorAll('a[href*="/note/"]').length,
      headings: [...document.querySelectorAll('h1,h2,[role="tab"]')].slice(0, 12).map((node) => (node.innerText || '').trim()),
      bodySample: (document.body?.innerText || '').trim().slice(0, 1_000),
    }))()`,
    returnByValue: true,
  });
  return result.result?.value || {};
}

async function triggerCommentPagination(client) {
  const target = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const container = document.querySelector('.route-scroll-container')
        || document.querySelector('.parent-route-container')
        || [...document.querySelectorAll('*')].find((node) => {
          const style = getComputedStyle(node);
          return /(auto|scroll)/.test(style.overflowY)
            && node.scrollHeight > node.clientHeight + 200;
        });
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      return { x: rect.left + rect.width * .75, y: rect.top + rect.height * .8,
        deltaY: Math.min(1800, Math.max(700, container.scrollHeight - container.clientHeight)) };
    })()`,
    returnByValue: true,
  });
  const value = target.result?.value;
  if (!value) return false;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: value.x, y: value.y, deltaX: 0, deltaY: value.deltaY,
  });
  await sleep(3_000);
  return true;
}

async function readNetworkBody(client, event) {
  const result = await client.send('Network.getResponseBody', { requestId: event.params.requestId });
  try {
    return JSON.parse(result.body);
  } catch {
    throw new DouyinCommentError('COMMENT_RESPONSE_INVALID', 'The comment endpoint returned a non-JSON response.', 503);
  }
}

async function readNetworkBodyWhenReady(client, event, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readNetworkBody(client, event);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(400);
    }
  }
  throw lastError;
}

function reusableTargetScore(target) {
  const title = asText(target?.title);
  let score = target?.faviconUrl ? 1 : 0;
  if (title && !/^douyin\.com\/(?:video|note)\/\d+$/i.test(title)) score += 3;
  if (/\s-\s\u6296\u97f3$/.test(title)) score += 3;
  if (/^(404|error|about:blank)/i.test(title)) score -= 8;
  return score;
}

function endpointForReply(rootUrl) {
  const url = new URL(rootUrl);
  url.pathname = '/aweme/v1/web/comment/list/reply/';
  for (const key of ['aweme_id', 'item_type', 'pc_img_format', 'a_bogus', 'X-Bogus', 'x-bogus']) url.searchParams.delete(key);
  url.searchParams.set('item_id', '0');
  url.searchParams.set('comment_id', '0');
  url.searchParams.set('cursor', '0');
  url.searchParams.set('count', '50');
  return url.toString();
}

function withParams(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function evaluateFetch(client, url) {
  const expression = `(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: controller.signal });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    } finally { clearTimeout(timeout); }
  })()`;
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, 30_000);
  const value = result.result?.value;
  if (!value || !value.ok) throw new DouyinCommentError('COMMENT_HTTP_ERROR', `Comment endpoint returned HTTP ${value?.status || 'unknown'}.`, 503);
  if (!value.text) throw new DouyinCommentError('COMMENT_EMPTY_RESPONSE', 'The comment endpoint returned an empty response; the browser session may need attention.', 503);
  let data;
  try { data = JSON.parse(value.text); } catch { throw new DouyinCommentError('COMMENT_RESPONSE_INVALID', 'The comment endpoint returned invalid JSON.', 503); }
  if (Number(data.status_code || 0) !== 0) {
    throw new DouyinCommentError('COMMENT_API_STATUS', `Douyin returned status_code ${data.status_code}.`, 503);
  }
  return data;
}

async function catalogInPage(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const seen = new Map();
      const read = () => {
        for (const node of document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
          const href = node.href || node.getAttribute('href') || '';
          const match = href.match(/\\/(video|note)\\/(\\d{10,32})/);
          if (!match) continue;
          const card = node.closest('li, article, [data-e2e]') || node;
          const text = (card.innerText || node.innerText || '').trim().slice(0, 800);
          seen.set(match[2], { video_id: match[2], content_type: match[1], url: href.split(/[?#]/)[0], card_text: text });
        }
      };
      let stable = 0;
      let previous = 0;
      for (let pass = 0; pass < 120 && stable < 8; pass += 1) {
        read();
        const containers = [document.querySelector('.semi-tabs-content'), document.querySelector('[data-e2e="user-post-list"]'), document.scrollingElement].filter(Boolean);
        for (const container of containers) container.scrollTop = container.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 700));
        read();
        if (seen.size === previous) stable += 1; else stable = 0;
        previous = seen.size;
      }
      const name = (document.querySelector('[data-e2e="user-info"]')?.innerText || document.title || '').split('\\n')[0].trim();
      return { account_name: name, public_video_count: seen.size, videos: [...seen.values()] };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, 150_000);
  return result.result?.value || { videos: [] };
}

function compactProfileName(value) {
  return asText(value).normalize('NFKC').toLocaleLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
}

export function selectProfileCandidate(profileName, candidates) {
  const expected = compactProfileName(profileName);
  if (!expected) return null;
  const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    let profileUrl = '';
    try {
      profileUrl = normalizeProfileUrl(candidate?.profileUrl || candidate?.href || '');
    } catch {
      return null;
    }
    const lines = [candidate?.name, ...(Array.isArray(candidate?.lines) ? candidate.lines : []), candidate?.text]
      .map(compactProfileName).filter(Boolean);
    const exact = lines.some((line) => line === expected);
    const partial = lines.some((line) => line.includes(expected) || expected.includes(line));
    return { profileUrl, matchedText: asText(candidate?.name || candidate?.text), score: exact ? 200 - index : partial ? 100 - index : 0 };
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  return ranked[0]?.score > 0 ? ranked[0] : null;
}

async function searchProfilesInPage(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => [...document.querySelectorAll('a[href*="/user/"]')].map((node) => {
      let card = node;
      let text = (node.innerText || '').trim();
      for (let depth = 0; depth < 8 && card?.parentElement; depth += 1) {
        card = card.parentElement;
        const candidateText = (card.innerText || '').trim();
        if (candidateText.length >= text.length && candidateText.length <= 1_200) text = candidateText;
        if (card.matches?.('[data-e2e], article, li')) break;
      }
      return { href: node.href || node.getAttribute('href') || '', name: (node.innerText || '').trim(), text, lines: text.split(/\\n+/).slice(0, 12) };
    }))()`,
    returnByValue: true,
  });
  return result.result?.value || [];
}

async function submitProfileSearch(client, profileName) {
  const focused = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const input = inputs.find((node) => (node.placeholder || '').includes('\\u641c\\u7d22'))
        || inputs.find((node) => node.type === 'search')
        || inputs.find((node) => ['text', ''].includes(node.type) && node.getClientRects().length);
      if (!input) return false;
      input.focus();
      input.select?.();
      return true;
    })()`,
    returnByValue: true,
  });
  if (!focused.result?.value) return false;
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await client.send('Input.insertText', { text: asText(profileName) });
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  return true;
}

async function inspectProfileSearch(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      inputs: [...document.querySelectorAll('input')].slice(0, 8).map((node) => ({
        type: node.type,
        placeholder: node.placeholder || '',
        value: node.value || '',
        visible: Boolean(node.getClientRects().length),
      })),
      userLinks: [...document.querySelectorAll('a[href*="/user/"]')].slice(0, 8).map((node) => ({
        href: node.href,
        text: (node.innerText || node.parentElement?.innerText || '').trim().slice(0, 240),
      })),
      bodySample: (document.body?.innerText || '').trim().slice(0, 800),
    }))()`,
    returnByValue: true,
  });
  return result.result?.value || {};
}

export class DouyinBrowserPool {
  constructor({ cdpUrl, forceBackupCdn = false, onDiagnostic = () => {} } = {}) {
    this.cdpUrl = cdpUrl;
    this.forceBackupCdn = forceBackupCdn;
    this.onDiagnostic = onDiagnostic;
    this.lanes = [];
    this.endpoints = null;
    this.runMarker = randomUUID();
  }

  async openLane(url) {
    const target = await createTarget(this.cdpUrl, url);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    try {
      await client.connect();
    } catch (error) {
      await closeTarget(this.cdpUrl, target.id);
      throw error;
    }
    return { id: randomUUID(), target, client, busy: false };
  }

  async resolveProfileName(profileName) {
    const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(profileName)}?type=user`;
    const lane = await this.openLane(searchUrl);
    try {
      const pageState = await ensurePageReady(lane.client, searchUrl);
      await Promise.resolve(this.onDiagnostic({ type: 'profile_search_page_ready', ...pageState }));
      await Promise.resolve(this.onDiagnostic({ type: 'profile_search_loaded', ...(await inspectProfileSearch(lane.client)) }));
      let candidate = selectProfileCandidate(profileName, await searchProfilesInPage(lane.client));
      if (candidate) return candidate;
      const submitted = await submitProfileSearch(lane.client, profileName);
      if (!submitted) throw new Error('Douyin search input was not found.');
      await Promise.resolve(this.onDiagnostic({ type: 'profile_search_submitted', profileName }));
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await sleep(1_000);
        candidate = selectProfileCandidate(profileName, await searchProfilesInPage(lane.client));
        if (candidate) return candidate;
        if (attempt > 0 && attempt % 4 === 0) {
          await lane.client.send('Runtime.evaluate', {
            expression: 'window.scrollBy(0, Math.max(720, window.innerHeight * 0.9));',
            returnByValue: true,
          });
        }
      }
      await Promise.resolve(this.onDiagnostic({ type: 'profile_search_exhausted', ...(await inspectProfileSearch(lane.client)) }));
      throw new DouyinCommentError(
        'PROFILE_NAME_NOT_RESOLVED',
        'The creator name could not be resolved to a public profile in the current browser session.',
        503,
        'Keep the logged-in Douyin browser available, then resume or paste the creator profile link.',
      );
    } finally {
      lane.client.close();
      await closeTarget(this.cdpUrl, lane.target.id);
    }
  }

  async resolveProfileLink(profileSourceUrl) {
    const lane = await this.openLane(profileSourceUrl);
    try {
      await lane.client.send('Page.enable');
      await sleep(2_500);
      const result = await lane.client.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      const profileUrl = normalizeProfileUrl(result.result?.value || '');
      return { profileUrl, matchedText: '' };
    } catch (error) {
      if (error instanceof DouyinCommentError) throw error;
      throw new DouyinCommentError(
        'PROFILE_LINK_NOT_RESOLVED',
        'The Douyin link did not resolve to a public creator profile in the current browser session.',
        503,
        'Keep the logged-in Douyin browser available, then resume or enter the creator name.',
      );
    } finally {
      lane.client.close();
      await closeTarget(this.cdpUrl, lane.target.id);
    }
  }

  async catalogProfile(profileUrl) {
    const lane = await this.openLane(profileUrl);
    try {
      const pageState = await ensurePageReady(lane.client, profileUrl);
      await Promise.resolve(this.onDiagnostic({ type: 'profile_catalog_page_ready', ...pageState }));
      const overlayDismissed = await dismissLoginOverlay(lane.client);
      await Promise.resolve(this.onDiagnostic({ type: 'profile_catalog_overlay_checked', overlayDismissed }));
      const result = await catalogInPage(lane.client);
      const videos = sortCatalogVideos((result.videos || []).map(normalizeCatalogVideo).filter(Boolean));
      if (!videos.length) {
        await Promise.resolve(this.onDiagnostic({ type: 'profile_catalog_empty', ...(await inspectCatalogPage(lane.client)) }));
        throw new DouyinCommentError('PROFILE_EMPTY', 'No public video or note cards were observed on the profile.', 503, 'Keep the Douyin profile open and verify the browser session is logged in.');
      }
      return {
        account_name: asText(result.account_name),
        public_video_count: Number(result.public_video_count || videos.length),
        profile_url: profileUrl,
        videos,
      };
    } finally {
      lane.client.close();
      await closeTarget(this.cdpUrl, lane.target.id);
    }
  }

  async captureEndpoints(videoId) {
    const videoUrl = `https://www.douyin.com/video/${videoId}`;
    const lane = await this.openLane(videoUrl);
    try {
      await lane.client.send('Network.enable');
      await lane.client.send('Page.enable');
      if (this.forceBackupCdn) {
        await lane.client.send('Network.setBlockedURLs', {
          urls: ['*://lf-douyin-pc-web.douyinstatic.com/*', '*://lf-security.bytegoofy.com/*'],
        });
      }
      const startedAt = Date.now();
      const pageState = await ensurePageReady(lane.client, videoUrl);
      await Promise.resolve(this.onDiagnostic({ type: 'comment_seed_page_ready', videoId, ...pageState }));
      await sleep(1_500);
      const overlayDismissed = await dismissLoginOverlay(lane.client);
      await Promise.resolve(this.onDiagnostic({ type: 'comment_seed_overlay_checked', videoId, overlayDismissed }));
      let event = lane.client.findLatestResponse((url) => url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/'), startedAt);
      for (let attempt = 0; !event && attempt < 6; attempt += 1) {
        await triggerCommentPagination(lane.client);
        event = lane.client.findLatestResponse((url) => url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/'), startedAt);
        if (!event && attempt === 2) await dismissLoginOverlay(lane.client);
      }
      if (!event) {
        await Promise.resolve(this.onDiagnostic({ type: 'comment_seed_endpoint_missing', videoId, ...(await inspectCatalogPage(lane.client)) }));
        throw new DouyinCommentError('COMMENT_ENDPOINT_NOT_OBSERVED', 'The browser did not issue a root comment request.', 503, 'Open the Douyin page, dismiss any login overlay, then resume.');
      }
      const rootPayload = await readNetworkBody(lane.client, event);
      const rootUrl = event.params.response.url;
      const replyUrl = endpointForReply(rootUrl);
      this.onDiagnostic({ type: 'endpoints_captured', videoId, rootComments: Array.isArray(rootPayload.comments) ? rootPayload.comments.length : 0 });
      return { rootUrl, replyUrl };
    } finally {
      lane.client.close();
      await closeTarget(this.cdpUrl, lane.target.id);
    }
  }

  async captureEndpointsFromOpenTabs() {
    let targets = [];
    try {
      const response = await fetch(`${this.cdpUrl}/json/list`);
      if (response.ok) targets = await response.json();
    } catch {
      return null;
    }
    const seenVideoIds = new Set();
    const candidates = targets
      .filter((target) => target.type === 'page'
        && target.webSocketDebuggerUrl
        && /https:\/\/www\.douyin\.com\/(video|note)\//.test(target.url || ''))
      .sort((left, right) => reusableTargetScore(right) - reusableTargetScore(left))
      .filter((target) => {
        const videoId = asId((target.url || '').match(/\/(?:video|note)\/(\d+)/)?.[1]);
        if (!videoId || seenVideoIds.has(videoId)) return false;
        seenVideoIds.add(videoId);
        return true;
      })
      .slice(0, 3);
    for (const target of candidates) {
      const client = new CdpClient(target.webSocketDebuggerUrl);
      try {
        await client.connect();
        await client.send('Network.enable');
        const startedAt = Date.now();
        await dismissLoginOverlay(client);
        let event = null;
        for (let attempt = 0; !event && attempt < 2; attempt += 1) {
          await triggerCommentPagination(client);
          event = client.findLatestResponse((url) => url.includes('/aweme/v1/web/comment/list/') && !url.includes('/reply/'), startedAt);
        }
        if (!event) continue;
        const rootPayload = await readNetworkBodyWhenReady(client, event);
        if (!rootPayload || Number(rootPayload.status_code || 0) !== 0) continue;
        const rootUrl = event.params.response.url;
        const seedVideoId = asId((target.url || '').match(/\/(?:video|note)\/(\d+)/)?.[1]);
        await Promise.resolve(this.onDiagnostic({
          type: 'endpoints_reused_from_open_tab',
          seedVideoId,
          rootComments: Array.isArray(rootPayload.comments) ? rootPayload.comments.length : 0,
        }));
        return { rootUrl, replyUrl: endpointForReply(rootUrl), seedVideoId };
      } catch {
        // A stale tab is skipped; the normal seed rotation remains available.
      } finally {
        client.close();
      }
    }
    return null;
  }

  async openLanes(count, seedVideoId) {
    const targetCount = Math.max(1, Math.min(10, Number(count) || 1));
    await this.close();
    const url = `https://www.douyin.com/video/${seedVideoId}`;
    activeLaneRunMarkers.add(this.runMarker);
    try {
      const cleanedTargets = await cleanupManagedLaneTargets(this.cdpUrl);
      if (cleanedTargets > 0) {
        await Promise.resolve(this.onDiagnostic({ type: 'stale_comment_lanes_cleaned', cleanedTargets }));
      }
      for (let index = 0; index < targetCount; index += 1) {
        const laneUrl = managedLaneUrl(url, `${this.runMarker}-${index + 1}`);
        this.lanes.push(await this.openLane(laneUrl));
      }
      await Promise.all(this.lanes.map(async (lane, index) => {
        await lane.client.send('Network.enable');
        const pageState = await ensurePageReady(lane.client, url);
        const overlayDismissed = await dismissLoginOverlay(lane.client);
        lane.ready = pageState.ready;
        lane.overlayDismissed = overlayDismissed;
        await Promise.resolve(this.onDiagnostic({
          type: 'comment_lane_ready',
          lane: index + 1,
          usedBackupCdn: pageState.usedBackupCdn,
          ready: pageState.ready,
          overlayDismissed,
        }));
      }));
      this.lanes.sort((left, right) => Number(Boolean(right.ready)) - Number(Boolean(left.ready)));
    } catch (error) {
      await this.close();
      throw error;
    }
    return this.lanes;
  }

  async fetchPage(lane, { kind, videoId, rootCommentId = '', cursor = 0 }) {
    if (!this.endpoints) throw new DouyinCommentError('COMMENT_ENDPOINT_MISSING', 'Signed comment endpoints are not ready.', 503);
    const base = kind === 'reply' ? this.endpoints.replyUrl : this.endpoints.rootUrl;
    const url = withParams(base, kind === 'reply'
      ? { item_id: videoId, comment_id: rootCommentId, cursor, count: 50 }
      : { aweme_id: videoId, cursor, count: 50 });
    lane.busy = true;
    try {
      let data;
      try {
        data = await evaluateFetch(lane.client, url);
      } catch (error) {
        if (error?.code !== 'COMMENT_EMPTY_RESPONSE') throw error;
        const pageUrl = `https://www.douyin.com/video/${videoId}`;
        await ensurePageReady(lane.client, pageUrl);
        await dismissLoginOverlay(lane.client);
        await triggerCommentPagination(lane.client);
        data = await evaluateFetch(lane.client, url);
      }
      return {
        requested_cursor: Number(cursor),
        cursor: Number(data.cursor || 0),
        has_more: Number(data.has_more || 0),
        total: Number(data.total || 0),
        comments: Array.isArray(data.comments) ? data.comments : [],
        received: Array.isArray(data.comments) ? data.comments.length : 0,
        kind,
        video_id: videoId,
        root_comment_id: kind === 'reply' ? rootCommentId : '',
      };
    } finally {
      lane.busy = false;
    }
  }

  async close() {
    const lanes = this.lanes.splice(0);
    await Promise.all(lanes.map(async (lane) => {
      lane.client.close();
      await closeTarget(this.cdpUrl, lane.target.id);
    }));
    activeLaneRunMarkers.delete(this.runMarker);
  }
}

export { endpointForReply, withParams };
