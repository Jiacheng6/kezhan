/**
 * P4 题目提取链路实测（不提交、不保存）。
 *
 * 验证四项：
 *   1) 找到作业 frame 并提取题目结构
 *   2) 每题的选项字母与文本（用 aria-label，绕开字体加密）
 *   3) 精确截取单题图片
 *   4) 按字母点选 + 读回确认（**最后恢复原状，不提交**）
 *
 * 用法: node tools/test/test-quiz.mjs <courseId> <clazzId> <knowledgeId>
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PATHS, PERSON_ID } from '../../src/config.mjs';
import { waitWorkFrame, extractQuestions, getWorkMeta, shootQuestion, selectOptions, readSelection } from '../../src/chaoxing/quiz.mjs';
import path from 'node:path';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const [courseId, clazzId, kid] = process.argv.slice(2);
const CPI = PERSON_ID;

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

const cardsUrl =
  `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards` +
  `?clazzid=${clazzId}&courseid=${courseId}&knowledgeid=${kid}` +
  `&num=0&ut=s&cpi=${CPI}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`;

console.log('打开小节…');
await page.goto(cardsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 20; i += 1) {
  const n = await page.evaluate(() => document.querySelectorAll('.ans-attach-ct').length).catch(() => 0);
  if (n > 0) break;
  await page.waitForTimeout(400);
}

console.log('等作业 frame…');
const wf = await waitWorkFrame(page, 35000);
if (!wf) {
  console.error('未等到作业 frame');
  await b.close();
  process.exit(1);
}
console.log('作业 frame:', wf.url().slice(0, 130));

const meta = await getWorkMeta(wf);
console.log('\n=== 作业元信息 ===');
console.log(JSON.stringify(meta, null, 2));

const qs = await extractQuestions(wf);
console.log(`\n=== 提取到 ${qs.length} 道题 ===`);
for (const q of qs) {
  console.log(`\n【第 ${q.index} 题】题型=${q.qtype}（原始"${q.qtypeRaw}"）选项 ${q.optionCount} 个`);
  console.log(`  题干(加密原文，仅排查用): ${q.stemTextRaw.slice(0, 50)}`);
  for (const o of q.options) {
    console.log(`    ${o.letter}. ${o.text}${o.textFromAria ? '' : '  ← 文本非 aria 来源'}`);
  }
  if (q.inputs.length) {
    console.log(`  输入框 ${q.inputs.length} 个: ${q.inputs.map((i) => i.tag).join(', ')}`);
  }
}

/* ---- 3) 截图 ---- */
const outDir = path.join(PATHS.answers, 'test');
console.log('\n=== 截图测试 ===');
for (let i = 0; i < Math.min(qs.length, 2); i += 1) {
  try {
    const f = await shootQuestion(wf, i, outDir);
    console.log(`  第 ${i + 1} 题 → ${f}`);
  } catch (e) {
    console.log(`  第 ${i + 1} 题截图失败: ${e.message}`);
  }
}

/* ---- 4) 点选 + 读回 + 复原 ---- */
console.log('\n=== 点选测试（会复原，不提交）===');
for (const q of qs) {
  if (!q.optionCount) continue;
  const letters = q.options.map((o) => o.letter).filter(Boolean);
  if (!letters.length) continue;

  const before = await readSelection(wf, q.domIndex);
  // 判断题的字母是 true/false（小写），多选题是 A/B/C/D —— 直接用原值，别转大小写
  const pick = q.qtype === 'multiple' ? letters.slice(0, 2) : letters.slice(0, 1);

  console.log(`  第 ${q.index} 题：原选中 ${JSON.stringify(before.selected)} → 试点选 ${JSON.stringify(pick)}`);
  const r = await selectOptions(wf, q.domIndex, pick);
  await page.waitForTimeout(400);
  const after = await readSelection(wf, q.domIndex);
  console.log(`     点选结果: ok=${r.ok} clicked=${JSON.stringify(r.clicked)} missing=${JSON.stringify(r.missing)}`);
  console.log(`     读回选中: ${JSON.stringify(after.selected)}  ${JSON.stringify(after.selected) === JSON.stringify(pick.sort()) || after.selected.length === pick.length ? '✓' : '?'}`);

  // 复原
  if (before.selected.length) {
    await selectOptions(wf, q.domIndex, before.selected, { clearFirst: true });
  } else {
    await selectOptions(wf, q.domIndex, [], { clearFirst: true });
  }
  await page.waitForTimeout(300);
  const restored = await readSelection(wf, q.domIndex);
  console.log(`     复原后选中: ${JSON.stringify(restored.selected)} ${restored.selected.length === before.selected.length ? '✓' : '✗'}`);
}

console.log('\n（全程未提交、未保存）');
await page.close().catch(() => {});
await b.close();
