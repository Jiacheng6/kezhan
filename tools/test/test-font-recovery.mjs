/**
 * 题目字体就绪判定（离线纯函数测试）。
 *
 * 背景（用户 2026-11-03 反馈）：跑到某章第 4 题后停住，报
 * 「题目字体文件加载失败（已主动加载 1 次）；未发送可能乱码的截图」。
 * 旧逻辑 failed 就立刻 fail；新逻辑要求**先恢复几次**再判失败。
 */
import assert from 'node:assert/strict';
import { fontReadyVerdict } from '../../src/chaoxing/quiz.mjs';

let pass = 0;
const check = (name, fn) => {
  fn();
  pass += 1;
  console.log('   ✓ ' + name);
};

check('字体全部就绪 → ready', () => {
  assert.deepEqual(fontReadyVerdict({ pending: 0, failed: false }), { action: 'ready' });
});

check('仍在加载且没超时 → wait', () => {
  assert.equal(fontReadyVerdict({ pending: 2, failed: false, elapsedMs: 1000 }).action, 'wait');
});

check('加载超时且没失败 → fail(font-not-ready)', () => {
  const v = fontReadyVerdict({ pending: 1, failed: false, elapsedMs: 30001, budgetMs: 30000 });
  assert.equal(v.action, 'fail');
  assert.equal(v.code, 'font-not-ready');
});

check('字体失败但还没恢复过 → 先 recover（不再立刻放弃）', () => {
  const v = fontReadyVerdict({ pending: 1, failed: true, elapsedMs: 500, recoverAttempts: 0 });
  assert.equal(v.action, 'recover');
});

check('字体失败且恢复次数未用完 → 继续 recover', () => {
  assert.equal(fontReadyVerdict({ pending: 1, failed: true, elapsedMs: 5000, recoverAttempts: 2, recoverBudget: 3 }).action, 'recover');
});

check('恢复次数用完 → fail(font-failed)', () => {
  const v = fontReadyVerdict({ pending: 1, failed: true, elapsedMs: 5000, recoverAttempts: 3, recoverBudget: 3 });
  assert.equal(v.action, 'fail');
  assert.equal(v.code, 'font-failed');
});

check('恢复次数用完但耗尽了总预算 → 也 fail', () => {
  const v = fontReadyVerdict({ pending: 1, failed: true, elapsedMs: 70000, budgetMs: 30000, recoverAttempts: 1, recoverBudget: 3 });
  assert.equal(v.action, 'fail');
});

check('默认预算放宽到 25 秒（给恢复留时间）', () => {
  assert.equal(fontReadyVerdict({ pending: 1, failed: false, elapsedMs: 20000 }).action, 'wait');
  assert.equal(fontReadyVerdict({ pending: 1, failed: false, elapsedMs: 26000 }).action, 'fail');
});

check('请求挂住时也进入恢复分支', () => {
  assert.equal(fontReadyVerdict({pending:1,stalled:true,elapsedMs:2500}).action,'recover');
});
check('挂住请求的恢复次数用完后等待总预算，不无限重载', () => {
  assert.equal(fontReadyVerdict({pending:1,stalled:true,elapsedMs:5000,recoverAttempts:3}).action,'wait');
  assert.equal(fontReadyVerdict({pending:1,stalled:true,elapsedMs:26000,recoverAttempts:3}).code,'font-not-ready');
});
console.log(`\n通过 ${pass} 项，失败 0 项`);
