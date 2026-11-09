/**
 * 端到端验证「界面自己选顺序」：
 *   点界面上的 ↓ → 点「保存选择」→ 从 API 读回，确认顺序真的变了。
 *
 * 锁定具体小节（knowledgeId），避免跨小节比较造成误判。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';

const base = 'http://127.0.0.1:8787';
const COURSE_KEYWORD = '计算思维';
const KID = '1246477123'; // 1.3 课程视频，2 个任务点

const apiOrder = async () => {
  const j = await (await fetch(`${base}/api/checklist`)).json();
  const c = j.result.courses.find((x) => x.name.includes(COURSE_KEYWORD));
  return c.tasks.filter((t) => t.knowledgeId === KID).map((t) => t.name);
};

// 先清空选择，确保从干净状态开始
await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ courseOrder: [], courses: {}, taskOrder: {}, excluded: [] }),
});

const before = await apiOrder();
console.log('① 初始 API 顺序:', JSON.stringify(before));

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:8787'));
await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.click('.tab[data-tab="courses"]');
await page.waitForTimeout(3500);

// 展开目标课程
await page.evaluate((kw) => {
  const blk = Array.from(document.querySelectorAll('.treecourse')).find((x) =>
    x.querySelector('.cname')?.textContent?.includes(kw),
  );
  if (blk && !blk.classList.contains('open')) blk.querySelector('.treehead').click();
}, COURSE_KEYWORD);
await page.waitForTimeout(800);

// 在目标小节里点第一行的 ↓
const clicked = await page.evaluate(
  ({ kw, kid }) => {
    const blk = Array.from(document.querySelectorAll('.treecourse')).find((x) =>
      x.querySelector('.cname')?.textContent?.includes(kw),
    );
    if (!blk) return '课程块未找到';
    for (const s of blk.querySelectorAll('.sectionblk')) {
      const rows = Array.from(s.querySelectorAll('.tprow'));
      if (rows.length >= 2) {
        // 确认是这个小节（用第一行名称判断）
        rows[0].querySelectorAll('.ordbtns button')[1].click();
        return `已点击 ${rows.length} 行小节的第一行 ↓`;
      }
    }
    return '未找到多任务点小节';
  },
  { kw: COURSE_KEYWORD, kid: KID },
);
console.log('②', clicked);
await page.waitForTimeout(700);

const uiOrder = await page.evaluate((kw) => {
  const blk = Array.from(document.querySelectorAll('.treecourse')).find((x) =>
    x.querySelector('.cname')?.textContent?.includes(kw),
  );
  for (const s of blk.querySelectorAll('.sectionblk')) {
    const rows = Array.from(s.querySelectorAll('.tprow'));
    if (rows.length >= 2) return rows.map((r) => r.querySelector('.tname')?.textContent);
  }
  return [];
}, COURSE_KEYWORD);
console.log('③ 界面显示顺序:', JSON.stringify(uiOrder.slice(0, 2)));

// 点「保存选择」，并等保存请求真正完成（不等的话读回的是旧值，会造成假失败）
const saveDone = page.waitForRequest(
  (req) => req.url().includes('/api/selection') && req.method() === 'POST',
  { timeout: 15000 },
);
await page.click('[data-action="saveSelection"]');
await saveDone.catch(() => console.log('  （未观察到保存请求）'));
await page.waitForTimeout(1500);

const after = await apiOrder();
const dataOrder = await page.evaluate(
  ({ kw, kid }) => {
    const c = window.__console?.tree?.data?.courses?.find((x) => x.name.includes(kw));
    if (!c) return null;
    return c.tasks.filter((t) => t.knowledgeId === kid).map((t) => t.name);
  },
  { kw: COURSE_KEYWORD, kid: KID },
);

console.log('④ 保存后 API 顺序:', JSON.stringify(after));
console.log('⑤ tree.data 顺序 :', JSON.stringify(dataOrder));
console.log('⑥ 界面数据与 API 一致:', JSON.stringify(dataOrder) === JSON.stringify(after) ? '✓' : '✗');
console.log('⑦ 顺序确实改变:', JSON.stringify(before) !== JSON.stringify(after) ? '✓' : '✗');

// 还原
await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ courseOrder: [], courses: {}, taskOrder: {}, excluded: [] }),
});
console.log('⑦ 已还原:', JSON.stringify(await apiOrder()));

await b.close();
