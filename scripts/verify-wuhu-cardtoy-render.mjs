import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('C:\\Users\\10847\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright');
const out = 'C:\\Users\\10847\\Documents\\MKT大师\\output\\wuhu-cardtoy-business-case-20260817';
const report = path.join(out, '三国杀WUHU联盟卡宝玩偶化立项专项论证报告.html');
const targets = [
  { name: 'desktop', width: 1440, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'compact', width: 320, height: 760 },
];
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
});
const results = [];
for (const target of targets) {
  const page = await browser.newPage({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.goto(pathToFileURL(report).href, { waitUntil: 'load' });
  const layout = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const pageOverflow = document.documentElement.scrollWidth > viewport + 1 || document.body.scrollWidth > viewport + 1;
    const offenders = [...document.querySelectorAll('h1,h2,h3,p,span,small,blockquote,td,th,a,strong')]
      .filter((element) => {
        const parent = element.closest('.table-wrap,.chart');
        return !parent && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
      })
      .slice(0, 10)
      .map((element) => ({ tag: element.tagName, text: (element.textContent || '').trim().slice(0, 80) }));
    return { pageOverflow, pageScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, viewport, offenders, sections: document.querySelectorAll('section').length };
  });
  const screenshot = path.join(out, `玩偶化立项报告-${target.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  results.push({ ...target, screenshot: path.basename(screenshot), consoleErrors, ...layout, passed: !layout.pageOverflow && layout.offenders.length === 0 && consoleErrors.length === 0 && layout.sections >= 8 });
  await page.close();
}
await browser.close();
const result = { generatedAt: new Date().toISOString(), passed: results.every((item) => item.passed), views: results };
fs.writeFileSync(path.join(out, 'browser-rendering.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
