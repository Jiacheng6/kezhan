// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * P5 提交链路测试 —— **在同一进程内**完成"跑测验 → 保持页面 → 提交"，
 * 这样 Playwright 的 page 句柄不会跨进程丢失。
 *
 * ⚠️ 会真实提交一次测验（消耗该测验的提交机会）。
 *    只应在测试用的小测验上运行。
 *
 * 用法: node tools/test/test-submit.mjs <courseId> <clazzId> <knowledgeId> [--no-submit]
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { DEBUG_PORT, loadSettings, PATHS, PERSON_ID } from '../../src/config.mjs';
import { runQuizTask, recordQuizResult, listKeptPages, submitKeptWork } from '../../src/chaoxing/quizrun.mjs';
import { listReviewItems, reviewStats, clearReviewByTask, setTaskStatus, mutateState } from '../../src/state.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const args = process.argv.slice(2);
const doSubmit = !args.includes('--no-submit');
const [courseId = '900000008', clazzId = '900000074', kid = '900000472'] = args.filter((a) => !a.startsWith('--'));

console.log('='.repeat(88));
console.log('P5 提交链路测试（同进程）');
console.log('  是否真的提交:', doSubmit ? '是（会消耗提交机会）' : '否');
console.log('='.repeat(88));

// 清空队列，从干净状态开始
mutateState((s) => {
  s.reviewQueue = [];
  s.quizzes = {};
  s.keptPages = {};
});

const base = 'http://127.0.0.1:8787';
const j = await (await fetch(`${base}/api/checklist`)).json();
const task = j.result.courses.find((c) => c.courseId === courseId)?.tasks.find((t) => t.knowledgeId === kid);
if (!task) {
  console.error('找不到任务点');
  process.exit(1);
}

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const qianwenPage = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));

console.log(`\n① 跑测验：${task.secNo} ${task.name || task.sectionName}`);
const t0 = Date.now();
const result = await runQuizTask({ ctx, qianwenPage, task, personId: PERSON_ID });
recordQuizResult(result);

console.log(`   阶段=${result.phase} 题数=${result.totalQuestions} 填入=${result.answered} 待人工=${result.queued}`);
for (const it of result.items || []) {
  console.log(`     第${it.questionIndex}题 [${it.qtype}] ${it.confidenceLabel} → ${(it.letters || []).join('')} | ${it.status}`);
}

console.log('\n② 保留页与待审队列');
const kept = listKeptPages();
console.log('   keptPages:', JSON.stringify(kept.map((k) => ({ key: k.key.slice(-24), closed: k.closed, submittable: k.submittable })), null, 2));
console.log('   队列:', JSON.stringify(reviewStats()));
console.log('   可提交题数:', listReviewItems().length);

if (!doSubmit) {
  console.log('\n③ 未提交（--no-submit）');
  await b.close();
  process.exit(0);
}

const submittable = kept.filter((k) => k.submittable);
if (!submittable.length) {
  console.log('\n③ ✗ 没有可提交的页面（句柄丢失）');
  await b.close();
  process.exit(1);
}

console.log('\n③ 提交…');
let ok = 0;
let fail = 0;
for (const k of submittable) {
  const r = await submitKeptWork(k.key);
  console.log(`   ${k.key.slice(-24)} → ${r.ok ? '✓ 已提交' : '✗ ' + r.error}${r.note ? ' (' + r.note + ')' : ''}`);
  if (r.ok) {
    ok += 1;
    clearReviewByTask(k.key, 'submitted');
    setTaskStatus(k.key, { status: 'done', note: '人工确认后已提交', submittedAt: new Date().toISOString() });
  } else {
    fail += 1;
  }
}

console.log(`\n   提交成功 ${ok} · 失败 ${fail}`);
console.log('   提交后队列:', JSON.stringify(reviewStats()));

// 核对学习通是否认可
await new Promise((r) => setTimeout(r, 3000));
const after = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'));
console.log('\n④ state 记录:');
console.log('   quizzes:', JSON.stringify(Object.entries(after.quizzes || {}).map(([k, v]) => ({ k: k.slice(-20), phase: v.phase, submitted: v.submitted }))));
console.log('   任务点状态:', JSON.stringify(after.taskPoints[task.key]));

console.log(`\n耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
await b.close();
