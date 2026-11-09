/**
 * 实机验证课程树的新批量选择能力（在真控制台页面上点按钮，不是模拟）。
 *
 * 验证项：
 *   · 工具条渲染出来了（搜索框 / 批量按钮 / 类型范围 / 节号区间 / 汇总条）
 *   · 全选 → 全不选 → 反选 生效，且汇总条跟着变
 *   · 搜索过滤、节号区间、整章/整节勾选、预览清单
 *   · 收尾必须「重新读取清单」把内存状态复原，别把测试用的选择留给用户
 *
 * 用法: node tools/test/verify-ui-tree.mjs
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:8787'));
if (!page) {
  console.error('找不到控制台页面（先启动服务）');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const readSummary = () => page.$eval('#treeWillSummary', (e) => e.textContent.trim());
const numbers = (t) => [...String(t).matchAll(/\d+/g)].map(Number);

console.log('=== 打开课程树并加载清单 ===');
await page.evaluate(() => {
  const t = document.querySelector('.tab[data-tab="courses"]');
  if (t) t.click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.querySelector('[data-action="loadChecklist"]')?.click();
});
await page.waitForTimeout(2500);

const tool = await page.evaluate(() => ({
  tools: !!document.querySelector('#treeTools'),
  search: !!document.querySelector('#treeSearch'),
  treeBtns: document.querySelectorAll('[data-tree]').length,
  scopes: ['scopeVideo', 'scopeWork', 'scopeDoc'].map((id) => !!document.getElementById(id)),
  range: !!document.getElementById('secFrom') && !!document.getElementById('secTo'),
  summaryEl: !!document.getElementById('treeWillSummary'),
  courses: document.querySelectorAll('.treecourse').length,
  chapters: document.querySelectorAll('.chaphead').length,
  secCbs: document.querySelectorAll('.sechead input[type=checkbox]').length,
  chapCbs: document.querySelectorAll('.chaphead input[type=checkbox]').length,
}));
ok('工具条已渲染', tool.tools && tool.search);
ok('批量按钮齐了', tool.treeBtns >= 9, `${tool.treeBtns} 个 [data-tree] 按钮`);
ok('类型范围三个勾选框在', tool.scopes.every(Boolean));
ok('节号区间输入框在', tool.range);
ok('汇总条元素在', tool.summaryEl);

/*
 * 清单为空（还没侦察）时，课程相关的检查没有意义 —— 明确跳过而不是报假失败。
 * 工具条本身仍然要验证（它是静态 HTML，不依赖数据）。
 */
if (tool.courses === 0) {
  console.log('\n⚠ 清单为空（尚未侦察），跳过课程/批量选择相关检查。');
  console.log('  先到控制台点「开始侦察课程」→「读取清单」，再跑本脚本做完整验证。');
  console.log('\n' + '='.repeat(50));
  console.log(`通过 ${pass} 项，失败 ${fail} 项（部分检查因无数据跳过）`);
  await b.close().catch(() => {});
  process.exit(fail ? 1 : 0);
}

ok('课程渲染出来了', tool.courses > 0, `${tool.courses} 门`);
ok('章级复选框渲染出来了', tool.chapCbs > 0, `${tool.chapCbs} 个章头`);
ok('小节级复选框渲染出来了', tool.secCbs > 0, `${tool.secCbs} 个小节`);

const s0 = await readSummary();
console.log('  汇总条：', s0);
ok('汇总条显示"本次将刷"', /本次将刷/.test(s0));

console.log('\n=== 批量勾选 → 汇总条联动 ===');
await page.click('[data-tree="deselect"]');
await page.waitForTimeout(400);
const s1 = await readSummary();
ok('全不选后汇总为 0', numbers(s1)[1] === 0 || /0 个任务点/.test(s1), s1);

await page.click('[data-tree="select"]');
await page.waitForTimeout(400);
const s2 = await readSummary();
ok('全选后任务点数 > 0', numbers(s2)[1] > 0, s2);

await page.click('[data-tree="invert"]');
await page.waitForTimeout(400);
const s3 = await readSummary();
ok('反选后汇总为 0', /0 个任务点/.test(s3), s3);

await page.click('[data-tree="unfinished"]');
await page.waitForTimeout(400);
const s4 = await readSummary();
ok('只选未完成后 > 0', numbers(s4)[1] > 0, s4);

console.log('\n=== 搜索 / 节号区间 / 预览 ===');
await page.fill('#treeSearch', '示例学习内容');
await page.waitForTimeout(400);
const searched = await page.evaluate(() => document.querySelectorAll('.treecourse').length);
ok('搜索后课程数减少', searched >= 1 && searched < tool.courses, `${tool.courses} → ${searched}`);
await page.fill('#treeSearch', '');
await page.waitForTimeout(300);

await page.click('[data-tree="select"]');
await page.waitForTimeout(300);
/*
 * 节号区间要拿**已启用课程**里真实存在的小节来测：
 *   · 已完成的小节不会进清单（侦察只深挖未完成小节）；
 *   · 批量操作只作用于已启用的课程（停用课不受影响，这是刻意的）。
 * 早期按"全页面最小节号"取，取到的是停用课程的小节 → 测出假失败。
 */
const firstSec = await page.evaluate(() => {
  const snos = [];
  for (const wrap of document.querySelectorAll('.treecourse')) {
    const cb = wrap.querySelector('.treehead input[type=checkbox]');
    if (!cb || !cb.checked) continue; // 只看已启用的课
    for (const e of wrap.querySelectorAll('.sechead .sno')) {
      const t = e.textContent.trim();
      if (t) snos.push(t);
    }
  }
  const val = (s) => {
    const m = String(s).match(/^(\d+)(?:\.(\d+))?/);
    return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : NaN;
  };
  return snos.sort((a, b) => val(a) - val(b))[0] || '';
});
ok('已启用课程里有可用的小节号', !!firstSec, firstSec);
await page.fill('#secFrom', firstSec);
await page.fill('#secTo', firstSec);
await page.click('[data-tree="rangeDeselect"]');
await page.waitForTimeout(400);
const sRange = await readSummary();
ok(
  `节号区间取消生效（只取消 ${firstSec}）`,
  numbers(sRange)[1] < numbers(s2)[1],
  `${numbers(s2)[1]} → ${numbers(sRange)[1]}`,
);
await page.click('[data-tree="rangeSelect"]');
await page.waitForTimeout(400);
// 清空区间：区间只对区间按钮生效，但清掉更不容易让人误会
await page.click('[data-tree="clearRange"]');
await page.waitForTimeout(200);

// 预览是"开关"：上一次跑可能把它留在打开状态，先读状态再保证它是打开的
const pvBefore = await page.evaluate(() =>
  document.getElementById('treePreview').classList.contains('hidden'),
);
if (pvBefore) {
  await page.click('[data-tree="preview"]');
  await page.waitForTimeout(400);
}
const pv = await page.evaluate(() => ({
  hidden: document.getElementById('treePreview').classList.contains('hidden'),
  rows: document.querySelectorAll('#treePreview tbody tr').length,
}));
ok('预览面板打开且有内容', !pv.hidden && pv.rows > 0, `${pv.rows} 行`);
// 收尾时关掉预览，别给下一次留状态
if (!pv.hidden) {
  await page.click('[data-tree="preview"]');
  await page.waitForTimeout(300);
}

// 截图仅作辅助证据：后台标签页可能等字体等超时 —— 先切到前台再截
try {
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'data/probe-out/ui-tree-tools.png', fullPage: false, timeout: 15000 });
  console.log('  截图：data/probe-out/ui-tree-tools.png');
} catch (e) {
  console.log('  （截图跳过：' + String(e.message).split('\n')[0] + '）');
}

console.log('\n=== 收尾：复原内存状态（别把测试选择留给用户）===');
await page.evaluate(() => document.querySelector('[data-action="loadChecklist"]')?.click());
await page.waitForTimeout(2000);
const restored = await page.evaluate(() => ({
  dirty: document.getElementById('treeDirty')?.classList.contains('hidden'),
  summary: document.getElementById('treeWillSummary')?.textContent.trim(),
}));
ok('已重新加载清单（未保存标记消失）', restored.dirty === true, restored.summary || '');

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
await b.close().catch(() => {});
process.exit(fail ? 1 : 0);
