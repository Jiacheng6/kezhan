/**
 * 界面自检（离线，不需要浏览器）：
 *   1) app.js 里 $('#xxx') / $$('#yyy') 引用的所有 id，必须在 index.html 里存在
 *   2) index.html 里 data-action="xxx" 的动作，必须能在后端 hooks 或前端处理里找到
 *   3) app.js 里 CSS 类名/选择器的最低限度检查（只做 id，避免误报）
 *
 * 为什么需要：改界面时最容易犯的错就是"引用了不存在的 id"，
 * 结果运行时静默失效（$() 返回 null，事件绑不上、状态不更新），
 * 而浏览器控制台未必有人看。
 *
 * 用法: node tools/test/check-ui-ids.mjs
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('src/ui/index.html', 'utf8');
const js = readFileSync('src/ui/app.js', 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set(
  [...js.matchAll(/\$\$?\(\s*'#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]),
);

let fail = 0;
let pass = 0;

console.log('=== JS 引用的 id 是否都在 HTML 里 ===');
for (const id of [...jsIds].sort()) {
  if (htmlIds.has(id)) {
    pass += 1;
    continue;
  }
  fail += 1;
  console.log(`  ✗ app.js 引用了 #${id}，但 index.html 里没有`);
}
if (!fail) console.log(`  ✓ ${jsIds.size} 个 id 全部存在`);

console.log('\n=== HTML 的 data-action 是否都有处理 ===');
const actions = [...html.matchAll(/data-action="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const frontend = new Set(['saveSelection', 'loadChecklist', 'loadReview', 'submitAllReviews']);
for (const a of [...new Set(actions)].sort()) {
  const handledFront = frontend.has(a);
  const handledBack = new RegExp(`\\b${a}:\\s*async`).test(
    readFileSync('src/main.mjs', 'utf8'),
  );
  if (handledFront || handledBack) {
    pass += 1;
    console.log(`  ✓ ${a}（${handledFront ? '前端' : '后端 hook'}）`);
  } else {
    fail += 1;
    console.log(`  ✗ ${a} 没有找到处理（前端也没在 runAction 之前的名单里，后端也没有同名 hook）`);
  }
}

console.log('\n=== HTML 的 data-tree 是否都有分支 ===');
const treeActs = [...new Set([...html.matchAll(/data-tree="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))];
for (const a of treeActs.sort()) {
  // app.js 里应出现 act === 'xxx'
  const handled = new RegExp(`act === '${a}'`).test(js);
  if (handled) {
    pass += 1;
    console.log(`  ✓ ${a}`);
  } else {
    fail += 1;
    console.log(`  ✗ data-tree="${a}" 在 app.js 里没有对应分支`);
  }
}

console.log('\n=== 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
