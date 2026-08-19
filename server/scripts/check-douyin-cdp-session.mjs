const cdpUrl = process.argv[2] || 'http://127.0.0.1:18801';

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async (event) => {
      let raw = event.data;
      if (raw instanceof Blob) raw = await raw.text();
      const message = JSON.parse(String(raw));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const targets = await (await fetch(`${cdpUrl}/json`)).json();
const target = targets.find((item) => item.type === 'page' && /^https:\/\/www\.douyin\.com\//.test(item.url));
if (!target) throw new Error(`No Douyin page found at ${cdpUrl}`);

const client = new CdpClient(target.webSocketDebuggerUrl);
try {
  await client.connect();
  const evaluation = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body?.innerText || '';
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return {
        ready_state: document.readyState,
        title: document.title,
        body_text_length: text.length,
        contains_login_text: /\\u767b\\u5f55/.test(text),
        contains_reply_gate_text: /\\u767b\\u5f55[^\\n]{0,20}\\u56de\\u590d|\\u767b\\u5f55[^\\n]{0,20}\\u5c55\\u5f00/.test(text),
        login_text_contexts: text.split('\\n')
          .filter((line) => /\\u767b\\u5f55/.test(line))
          .slice(0, 8)
          .map((line) => line.slice(0, 120)),
        login_modal_visible: [...document.querySelectorAll('button,a,[role="button"],input')]
          .filter(visible)
          .some((node) => /扫码登录|验证码登录|密码登录|登录后即可/.test(
            (node.innerText || node.placeholder || node.getAttribute('aria-label') || '').trim(),
          )),
        visible_captcha: [...document.querySelectorAll('iframe,[role="dialog"]')]
          .filter(visible)
          .some((node) => /captcha|验证|verify/i.test(
            (node.id || '') + ' ' + (node.className || '') + ' '
              + (node.title || '') + ' ' + (node.src || ''),
          )),
        comment_expand_buttons: [...document.querySelectorAll('button')]
          .filter(visible)
          .filter((node) => /展开\\d+条回复/.test(node.innerText || '')).length,
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(evaluation.result?.value || null));
} finally {
  client.close();
}
