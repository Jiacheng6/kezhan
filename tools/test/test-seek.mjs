// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * 关键测试：学习通允许不允许"向前跳"（jump forward）？
 *
 * 因为判定用的是本会话播放时长，我需要让起播位置靠前来攒时长。
 * 未完成任务点通常禁止拖拽，但"向前跳"和"向后拖"可能待遇不同。
 *
 * 测试：从恢复位置（约 300s）尝试跳到 0 / 10% / 30% / 50%，各读回实际位置，
 *       并观察上报的 playingTime 从多少开始。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PERSON_ID } from '../../src/config.mjs';
import { installDefence } from '../../src/browser/inject.mjs';
import { waitVideoFrame, waitVideoElement } from '../../src/chaoxing/player.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const courseId = '900000002';
const clazzId = '900000011';
const kid = process.argv[2] || '900000026';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

// 记录上报的 playingTime
const reports = [];
page.on('request', (req) => {
  if (!/multimedia\/log/.test(req.url())) return;
  reports.push(Number(new URL(req.url()).searchParams.get('playingTime')));
});

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

const frame = await waitVideoFrame(page, 25000);
await installDefence(page);
await waitVideoElement(frame, 25000);

// 先 load 拿 duration 与恢复位置
await frame.evaluate(() => {
  const v = document.querySelector('video');
  if (!Number.isFinite(v.duration) || v.readyState === 0) v.load();
});
await page.waitForTimeout(4000);

const info = await frame.evaluate(() => {
  const v = document.querySelector('video');
  return { duration: v.duration, currentTime: v.currentTime, readyState: v.readyState };
});
console.log(`视频: duration=${info.duration}s  恢复位置=${Math.round(info.currentTime)}s`);

console.log('\n=== 逐个尝试跳转 ===');
const targets = [0, 0.1, 0.3, 0.5, 0.8];
for (const t of targets) {
  const sec = Math.round(info.duration * t);
  const r = await frame.evaluate(
    ({ target }) => {
      const v = document.querySelector('video');
      const before = v.currentTime;
      try {
        v.currentTime = target;
      } catch (e) {
        return { error: e.message };
      }
      return { before: Math.round(before), target, afterImmediate: Math.round(v.currentTime) };
    },
    { target: sec },
  );
  await page.waitForTimeout(1200);
  const after = await frame.evaluate(() => Math.round(document.querySelector('video').currentTime));
  const ok = Math.abs(after - sec) < 5;
  console.log(`  目标 ${String(sec).padStart(4)}s (${(t * 100).toFixed(0)}%)  设置后立即读: ${r.afterImmediate}s  1.2秒后: ${after}s  ${ok ? '✓ 成功' : '✗ 被拦回'}`);
}

console.log('\n=== 跳转后的上报（playingTime 从多少开始）===');
// 播几秒触发上报
await frame.evaluate(() => document.querySelector('video').play());
await page.waitForTimeout(8000);
console.log('  捕获到的 playingTime 序列:', JSON.stringify(reports));
if (reports.length) {
  console.log(`  首次上报 playingTime=${reports[0]}`);
  console.log(reports[0] > 30 ? '  ⚠ 服务端已记住历史进度（不是从 0 重算）' : '  ✓ 本会话计时（从 0 起算）');
}

await frame.evaluate(() => document.querySelector('video').pause()).catch(() => {});
await page.close().catch(() => {});
await b.close();
