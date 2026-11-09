// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * 关键实验：视频已到 94.3%，补播到 100% 是否就通过（isPassed → true / 绿点翻转）？
 *
 * 同时验证「补播」这个修复思路是否可行：
 * 若可行，视频执行器应在"绿点未变"时**继续播到 100%**，而不是只播到 95% 就放弃。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PERSON_ID } from '../../src/config.mjs';
import { installDefence } from '../../src/browser/inject.mjs';
import { waitVideoFrame, waitVideoElement, prepare, play, getPlayerState, progressOf, pause } from '../../src/chaoxing/player.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const courseId = '900000002';
const clazzId = '900000011';
const CPI = PERSON_ID;
const kid = process.argv[2] || '900000026';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

// 抓 isPassed
const passed = [];
page.on('response', async (res) => {
  if (!/multimedia\/log/.test(res.url())) return;
  let body = '';
  try {
    body = await res.text();
  } catch {}
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  const pt = new URL(res.url()).searchParams.get('playingTime');
  passed.push({ pt, ...(parsed || {}) });
  console.log(`    上报 playingTime=${pt} → isPassed=${parsed?.isPassed}`);
});

await page.goto(
  `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${clazzId}&courseid=${courseId}&knowledgeid=${kid}` +
    `&num=0&ut=s&cpi=${CPI}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`,
  { waitUntil: 'domcontentloaded', timeout: 60000 },
);
for (let i = 0; i < 20; i += 1) {
  const n = await page.evaluate(() => document.querySelectorAll('.ans-attach-ct').length).catch(() => 0);
  if (n > 0) break;
  await page.waitForTimeout(400);
}

const readAria = () =>
  page.evaluate(() => {
    const ct = document.querySelector('.ans-attach-ct');
    const icon = ct?.querySelector('.ans-job-icon');
    return {
      aria: icon?.getAttribute('aria-label') || null,
      finishedClass: /ans-job-finished/.test(String(ct?.className || '')),
    };
  });

console.log('=== 播放前 ===');
console.log(' ', JSON.stringify(await readAria()));

const frame = await waitVideoFrame(page, 25000);
await installDefence(page);
await waitVideoElement(frame, 25000);
const prep = await prepare(frame, page, { muted: true });
console.log(`  时长 ${prep.duration}s，起播 ${prep.startAt}s（学习通恢复的位置）`);

await play(frame);

const t0 = Date.now();
let lastP = 0;
let greenAt = null;
for (;;) {
  await page.waitForTimeout(2000);
  const st = await getPlayerState(frame);
  if (!st) break;
  const p = progressOf(st);
  const sec = Math.round((Date.now() - t0) / 1000);

  // 进度变化超过 2% 或每秒打点
  if (Math.abs(p - lastP) >= 0.02 || sec % 20 === 0) {
    const a = await readAria();
    console.log(`    [${String(sec).padStart(4)}s] ${(p * 100).toFixed(1).padStart(5)}%  ${Math.round(st.currentTime)}/${st.duration}s  aria="${a.aria}"`);
    lastP = p;
    if (a.finishedClass || /已完成/.test(a.aria || '')) {
      greenAt = { sec, progress: p, aria: a.aria };
      break;
    }
  }
  if (st.currentTime >= st.duration - 0.5 || st.ended || sec > 180) break;
}

console.log('\n=== 播放后 ===');
const after = await readAria();
console.log(' ', JSON.stringify(after));

console.log('\n=== 上报汇总 ===');
for (const x of passed) console.log(`  playingTime=${x.pt}  isPassed=${x.isPassed}`);

console.log('\n=== 结论 ===');
if (after.finishedClass || /已完成/.test(after.aria || '')) {
  console.log('  ✓ 补播到 100% 后变绿了！→ 修复方向：绿点未变时继续播到 100%');
} else {
  console.log('  ✗ 播到 100% 仍未变绿 → 不是阈值问题，需继续排查');
}
if (greenAt) console.log('  变绿时刻:', JSON.stringify(greenAt));

await pause(frame).catch(() => {});
await page.close().catch(() => {});
await b.close();
