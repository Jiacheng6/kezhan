// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/** 核实测验是否真的提交成功 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PERSON_ID } from '../../src/config.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const [courseId = '900000008', clazzId = '900000074', kid = '900000472'] = process.argv.slice(2);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];

// 1) 打开 cards 页看该任务点的完成状态
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto(
  `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${clazzId}&courseid=${courseId}&knowledgeid=${kid}` +
    `&num=0&ut=s&cpi=${PERSON_ID}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`,
  { waitUntil: 'domcontentloaded', timeout: 60000 },
);
for (let i = 0; i < 20; i += 1) {
  const n = await page.evaluate(() => document.querySelectorAll('.ans-attach-ct').length).catch(() => 0);
  if (n > 0) break;
  await page.waitForTimeout(400);
}
await page.waitForTimeout(4000);

console.log('=== ① 任务点状态（cards 页）===');
const st = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.ans-attach-ct').forEach((ct) => {
    const icon = ct.querySelector('.ans-job-icon');
    let meta = {};
    try {
      meta = JSON.parse(ct.querySelector('iframe')?.getAttribute('data') || '{}');
    } catch {}
    out.push({
      cls: String(ct.className).slice(0, 60),
      aria: icon?.getAttribute('aria-label') || null,
      finished: /ans-job-finished/.test(String(ct.className)),
      title: meta.title || null,
      // 测验有次数信息
      workid: meta.workid || null,
    });
  });
  return out;
});
for (const x of st) {
  console.log(`  ${x.finished || /已完成/.test(x.aria || '') ? '✅ 已完成' : '⬜ 未完成'}  aria="${x.aria}"  ${x.title || ''}`);
}

// 2) 看章节树里的小节状态
console.log('\n=== ② 章节树小节状态 ===');
const tp = await ctx.newPage();
tp.on('dialog', (d) => d.accept().catch(() => {}));
await tp.goto(
  `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseId}&clazzid=${clazzId}&cpi=${PERSON_ID}&ismooc2=1&v=2`,
  { waitUntil: 'domcontentloaded', timeout: 60000 },
);
await tp.waitForTimeout(3000);
let tf = null;
for (let i = 0; i < 25 && !tf; i += 1) {
  const fr = tp.frames().find((f) => f.url().includes('mycourse/studentcourse'));
  if (fr) {
    const n = await fr.evaluate(() => document.querySelectorAll('.chapter_item').length).catch(() => 0);
    if (n > 0) tf = fr;
  }
  if (!tf) {
    await tp.locator('li[dataname="zj"]').first().click({ timeout: 8000 }).catch(() => {});
    await tp.waitForTimeout(1500);
  }
}
if (tf) {
  const s = await tf.evaluate((k) => {
    const el = document.getElementById(`cur${k}`);
    if (!el) return { error: '找不到小节' };
    return {
      done: /icon_yiwanc/.test(String(el.querySelector('.catalog_state')?.className || '')),
      stateClass: String(el.querySelector('.catalog_state')?.className || ''),
      tip: (el.querySelector('.bntHoverTips')?.textContent || '').trim(),
      pointsYi: (el.querySelector('.catalog_points_yi')?.textContent || '').trim(),
    };
  }, kid);
  console.log('  ' + JSON.stringify(s));
  console.log('  ' + (s.done ? '✅ 小节已变绿 —— 提交成功' : '⬜ 小节仍未完成'));
} else {
  console.log('  章节树未就绪');
}

await page.close().catch(() => {});
await tp.close().catch(() => {});
await b.close();
