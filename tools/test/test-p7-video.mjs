/**
 * P7 回归：确认 P6 的弹窗监听没破坏视频播放。
 * 选一个短的真任务点视频跑完整流程（含弹窗监听协程）。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PERSON_ID } from '../../src/config.mjs';
import { runVideoTask } from '../../src/chaoxing/runner.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const base = 'http://127.0.0.1:8787';
const j = await (await fetch(`${base}/api/checklist`)).json();

// 从 state 里排除已完成的，选"未完成、带追踪、体积小"的视频
const fs = await import('node:fs');
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const doneKeys = new Set(
  Object.entries(state.taskPoints || {})
    .filter(([, v]) => v.status === 'done')
    .map(([k]) => k),
);

const cands = [];
for (const c of j.result.courses) {
  for (const t of c.tasks) {
    // 只要以前验证过带追踪的（jobid 非空），或体积已知的
    if (t.type === 'video' && t.willHandle && !t.finished && t.sizeBytes && !doneKeys.has(t.key)) {
      cands.push({ ...t, courseName: c.name });
    }
  }
}
cands.sort((a, b) => a.sizeBytes - b.sizeBytes);

const task = cands[0];
if (!task) {
  console.error('没有可测的视频（可能都已完成）');
  process.exit(1);
}
console.log('测试视频:', task.courseName, '|', task.secNo, '|', task.name, '|', Math.round(task.sizeBytes / 1048576), 'MB');
console.log('  key:', task.key);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const qianwenPage = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));
console.log('千问页:', qianwenPage ? '已就绪（启用弹窗监听）' : '无（不启用监听）');

const t0 = Date.now();
const r = await runVideoTask({
  ctx,
  task,
  personId: PERSON_ID,
  qianwenPage,
  onProgress: (p) => {
    if (Math.round(p.progress * 100) % 20 === 0) {
      process.stdout.write(`  ${(p.progress * 100).toFixed(0)}% `);
    }
  },
});

console.log('\n\n=== 结果 ===');
console.log('  ok        :', r.ok);
console.log('  阶段      :', r.phase);
console.log('  进度      :', ((r.progress || 0) * 100).toFixed(1) + '%');
console.log('  绿点      :', r.greenDot === null ? '未核对' : r.greenDot ? '已完成 ✓' : '未完成 ✗');
console.log('  纠偏次数  :', r.resumes);
console.log('  弹窗监听  :', r.popupWatching ? '已启用' : '未启用');
console.log('  弹窗事件  :', (r.popupEvents || []).length, '个');
console.log('  耗时      :', Math.round((Date.now() - t0) / 1000), '秒');
if (r.error) console.log('  错误      :', r.error);
if (r.needsHuman) console.log('  需人工    :', r.needsHuman);

await b.close();
