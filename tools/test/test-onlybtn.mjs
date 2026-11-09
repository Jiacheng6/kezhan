/** 验证「只刷这门课」按钮：点一下应禁用其它课程并保存 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';

const base = 'http://127.0.0.1:8787';

// 先清空选择，模拟用户的初始状态
await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ courseOrder: [], courses: {}, taskOrder: {}, excluded: [] }),
});
const before = await (await fetch(`${base}/api/checklist`)).json();
console.log('初始启用课程数:', before.result.courses.filter((c) => !c.empty && c.enabled).length);
console.log('初始将处理:', before.result.summary.handleable);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:8787'));
await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.click('.tab[data-tab="courses"]');
await page.waitForFunction(() => document.querySelectorAll('.treecourse').length > 0, { timeout: 20000 });
await page.waitForTimeout(800);

// 找"示例学习内容"那门课，点它的「只刷这门课」
const clicked = await page.evaluate(() => {
  const blocks = Array.from(document.querySelectorAll('.treecourse'));
  const target = blocks.find((b) => b.querySelector('.cname')?.textContent?.includes('突发事件'));
  if (!target) return { error: '没找到目标课程' };
  const btn = target.querySelector('.onlybtn');
  if (!btn) return { error: '没找到 onlybtn' };
  btn.click();
  return { ok: true, course: target.querySelector('.cname')?.textContent };
});
console.log('点击结果:', JSON.stringify(clicked));
await page.waitForTimeout(3000);

const after = await (await fetch(`${base}/api/checklist`)).json();
const enabled = after.result.courses.filter((c) => !c.empty && c.enabled);
console.log('\n点击后:');
console.log('  启用课程:', enabled.map((c) => c.name).join(', ') || '(无)');
console.log('  将处理:', after.result.summary.handleable);

// 模拟 buildRunTasks
const run = [];
for (const c of after.result.courses) {
  if (c.empty || c.enabled === false) continue;
  for (const t of c.tasks) if (t.willHandle) run.push(c.name);
}
const uniq = [...new Set(run)];
console.log('  执行时会刷的课程:', uniq.join(', '));
console.log('\n' + (uniq.length === 1 && uniq[0].includes('突发事件') ? '✓ 「只刷这门课」生效' : '✗ 未生效'));

// 还原
await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ courseOrder: [], courses: {}, taskOrder: {}, excluded: [] }),
});
console.log('\n（已还原为默认全部启用）');

await b.close();
