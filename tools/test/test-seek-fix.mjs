// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * 决定性验证：seek 修复是否有效。
 *
 * 步骤：
 *   1) 先把目标视频播到 60%（制造"学习通记住的靠后位置"）
 *   2) 暂停并关闭页面
 *   3) 用修好的执行器跑这个任务点
 *      → 期望看到「已把起播位置前移到 Xs」并最终变绿
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, loadSettings, PERSON_ID } from '../../src/config.mjs';
import { installDefence } from '../../src/browser/inject.mjs';
import { waitVideoFrame, waitVideoElement } from '../../src/chaoxing/player.mjs';
import { runVideoTask } from '../../src/chaoxing/runner.mjs';
import { getTaskStatus } from '../../src/state.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const courseId = '900000002';
const clazzId = '900000011';
const CPI = PERSON_ID;
const kid = process.argv[2] || '900000030'; // 6.3

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];

/* ── 阶段 1：制造靠后位置 ── */
console.log('=== 阶段 1：先把视频播到 60%，制造"被恢复的靠后位置" ===');
{
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
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
  const frame = await waitVideoFrame(page, 25000);
  await installDefence(page);
  await waitVideoElement(frame, 25000);
  await frame.evaluate(() => {
    const v = document.querySelector('video');
    if (!Number.isFinite(v.duration) || v.readyState === 0) v.load();
  });
  // 等 duration
  let dur = 0;
  for (let i = 0; i < 30; i += 1) {
    dur = await frame.evaluate(() => (Number.isFinite(document.querySelector('video').duration) ? document.querySelector('video').duration : 0));
    if (dur) break;
    await page.waitForTimeout(500);
  }
  const target = Math.floor(dur * 0.6);
  console.log(`  时长 ${Math.round(dur)}s，跳到 ${target}s 并播放 12 秒…`);
  await frame.evaluate((t) => {
    const v = document.querySelector('video');
    v.muted = true;
    v.currentTime = t;
    v.play();
  }, target);
  await page.waitForTimeout(12000);
  const at = await frame.evaluate(() => Math.round(document.querySelector('video').currentTime));
  console.log(`  当前位置: ${at}s`);
  await frame.evaluate(() => document.querySelector('video').pause()).catch(() => {});
  await page.close().catch(() => {});
  console.log('  已关闭页面（位置应由学习通记住）\n');
}

/* ── 阶段 2：用修好的执行器跑 ── */
console.log('=== 阶段 2：用修好的执行器跑同一个任务点 ===');
const j = await (await fetch('http://127.0.0.1:8787/api/checklist')).json();
const task = j.result.courses.find((c) => c.courseId === courseId)?.tasks.find((t) => t.knowledgeId === kid);
if (!task) {
  console.error('找不到任务点');
  process.exit(1);
}
console.log(`  任务: ${task.secNo} ${task.name}`);
const before = getTaskStatus(task.key);
console.log(`  本地状态: ${before ? before.status : '(无记录)'}`);

const t0 = Date.now();
const r = await runVideoTask({ ctx, task, personId: CPI });

console.log('\n=== 结果 ===');
console.log('  ok        :', r.ok);
console.log('  阶段      :', r.phase);
console.log('  进度      :', ((r.progress || 0) * 100).toFixed(1) + '%');
console.log('  绿点      :', r.greenDot === null ? '未核对' : r.greenDot ? '已完成 ✓' : '未完成 ✗');
console.log('  回跳补播  :', r.loops || 0, '次');
console.log('  耗时      :', Math.round((Date.now() - t0) / 1000), '秒');
if (r.error) console.log('  错误      :', r.error);

const after = getTaskStatus(task.key);
console.log('  本地状态  :', after ? `${after.status} ${((after.progress || 0) * 100).toFixed(1)}%` : '(无)');

console.log('\n' + (r.greenDot ? '✓✓ 修复生效：绿点已翻转' : '✗ 仍未通过，需要继续排查'));

await b.close();
