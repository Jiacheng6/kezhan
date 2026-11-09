/** 清空记录后，检查控制台在"空数据"下是否正常（无报错、提示到位）。 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const p = ctx.pages().find((x) => x.url().includes('127.0.0.1:8787'));
if (!p) {
  console.error('找不到控制台页');
  process.exit(1);
}

const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => {
  if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200));
});

await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));

const info = await p.evaluate(() => {
  document.querySelector('.tab[data-tab="courses"]')?.click();
  return {
    treeSource: document.getElementById('treeSource')?.textContent.trim(),
    treeSummary: document.getElementById('treeSummary')?.textContent.trim(),
    willSummary: document.getElementById('treeWillSummary')?.textContent.trim(),
    pills: [...document.querySelectorAll('.topright .pill')].map((e) => e.textContent.trim()),
    treeBodyText: (document.getElementById('treeBody')?.textContent || '').trim().slice(0, 80),
  };
});
console.log(JSON.stringify(info, null, 1));
console.log('页面报错:', errs.length ? errs.slice(0, 5).join(' | ') : '（无）');
console.log('当前页面数:', ctx.pages().length);
for (const x of ctx.pages()) console.log('   ', x.url().slice(0, 90));

await b.close().catch(() => {});
process.exit(0);
