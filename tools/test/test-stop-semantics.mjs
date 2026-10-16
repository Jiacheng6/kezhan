/**
 * 「用户中止 ≠ 失败」的离线回归测试（不需要浏览器）。
 *
 * 背景（实测踩到的 bug）：用户点「停止」时执行器返回 phase='stopped'，
 * 而批量把 stopped 归进了"失败"分支 —— 于是白白重试、最后把任务点
 * 记成「待人工」而不是「待续跑」。现在记账逻辑抽成纯函数 classifyTaskResult，
 * 这里把每种结果形态都钉住。
 *
 * 用法: node tools/test/test-stop-semantics.mjs
 */
import { classifyTaskResult } from '../../src/batch.mjs';

let pass = 0;
let fail = 0;

function t(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name} → ${actual}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} → 实际 ${actual}，期望 ${expected}`);
  }
}

console.log('=== 正常完成 ===');
t('ok=true', classifyTaskResult({ ok: true, phase: 'done' }), 'done');
t('播放达标 phase=done', classifyTaskResult({ ok: true, phase: 'done', progress: 1 }), 'done');
t('非任务点', classifyTaskResult({ ok: false, phase: 'no-tracking' }), 'done');
t('学习通已标记完成', classifyTaskResult({ ok: true, phase: 'already-finished' }), 'done');
t('测验已作答待人工提交不等于完成', classifyTaskResult({ ok: true, phase: 'awaiting-review' }), 'review');
t('验证码阻塞优先于残留 ok=true', classifyTaskResult({ ok: true, phase: 'blocked-verification',needsHuman:'验证' }), 'blocked');
t('待审不能覆盖硬障碍', classifyTaskResult({ ok: true, phase: 'awaiting-review',needsHuman:'验证' }), 'blocked');

console.log('\n=== 用户中止（本次修复的重点）===');
t('视频被用户中止', classifyTaskResult({ ok: false, phase: 'stopped', error: '被用户中止' }), 'stopped');
t('测验被用户中止', classifyTaskResult({ ok: false, phase: 'stopped', stopped: true }), 'stopped');
t('中止优先于 needsHuman', classifyTaskResult({ ok: false, phase: 'stopped', needsHuman: '弹窗题' }), 'stopped');

console.log('\n=== 需要人 / 硬障碍 ===');
t('弹窗题判不准', classifyTaskResult({ ok: false, phase: 'needs-human', needsHuman: '答案不可靠' }), 'needs-human');
t('千问风控', classifyTaskResult({ ok: false, phase: 'blocked-verification', needsHuman: '千问滑块验证' }), 'blocked');
t('千问限流', classifyTaskResult({ ok: false, phase: 'blocked-throttled' }), 'blocked');
t('needsHuman 字段单独出现', classifyTaskResult({ ok: false, phase: 'x', needsHuman: '要人' }), 'blocked');

console.log('\n=== 真失败 ===');
t('播放未达标', classifyTaskResult({ ok: false, phase: 'verify-green-dot', error: '绿点未变' }), 'failed');
t('异常结果对象空缺', classifyTaskResult(null), 'failed');
t('空对象', classifyTaskResult({}), 'failed');

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
