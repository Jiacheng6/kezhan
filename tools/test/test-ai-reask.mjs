/**
 * 千问"没回答就重新提问"的离线测试（不需要浏览器、不需要登录）。
 *
 * 为什么值得测：用户实测反馈"千问卡了，此时若没回答应该重新提问，而不是卡着"。
 * 早期每次提问只试一遍、干等满 4 分钟才失败，一条题就白白变成"待人工"。
 * 这里把"什么时候判卡住""什么时候该重问""什么时候绝对不能重问"钉死。
 *
 * 用法: node tools/test/test-ai-reask.mjs
 */
import { answerProgressVerdict, shouldReask } from '../../src/ai/ai.mjs';

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

const v = (o) =>
  answerProgressVerdict({
    elapsedMs: 10000,
    sinceProgressMs: 1000,
    generating: false,
    len: 0,
    stableRounds: 0,
    needStableRounds: 3,
    stuckMs: 60000,
    timeoutMs: 240000,
    ...o,
  });

console.log('=== 正常路径：出字了就算完 ===');
{
  let r = v({ len: 42, stableRounds: 3, generating: false });
  ok('文本稳定且不在生成中 → 完成', r.action === 'done', r.reason);
  r = v({ len: 42, stableRounds: 2, generating: false });
  ok('还没稳定够轮次 → 继续等', r.action === 'wait', r.reason);
  r = v({ len: 42, stableRounds: 9, generating: true });
  ok('还在生成中（哪怕文本没变）→ 不乱收工', r.action === 'wait', r.reason);
}

console.log('\n=== 卡住判定：不干等满总超时（用户实测痛点）===');
{
  // 千问显示"生成中"，但 60 秒一个字都没吐
  let r = v({ generating: true, len: 0, sinceProgressMs: 60000, elapsedMs: 60000 });
  ok('生成中但长时间不吐字 → 判定卡住（stuck-frozen）', r.action === 'give-up' && r.reason === 'stuck-frozen', r.reason);

  // 压根没反应：既没生成提示、也没内容（发送被吞 / 图片没送进去）
  r = v({ generating: false, len: 0, sinceProgressMs: 60000, elapsedMs: 60000 });
  ok('完全没有反应 → stuck-silent', r.action === 'give-up' && r.reason === 'stuck-silent', r.reason);

  // 已有半截文本但长时间不增长、也还在生成中 → 同样判卡住
  // （⚠ 半截文本**绝不能当答案用**：生成被打断的多半是半句，填进题就是错答案）
  r = v({ generating: true, len: 30, sinceProgressMs: 61000, elapsedMs: 61000 });
  ok('有半截但不增长 → 仍判卡住（半截文本会被丢弃）', r.action === 'give-up' && r.reason === 'stuck-frozen', r.reason);

  // 关键：卡住的判定要比总超时**早得多**
  const early = v({ generating: true, len: 0, sinceProgressMs: 60000, elapsedMs: 60000 });
  const late = v({ generating: true, len: 0, sinceProgressMs: 30000, elapsedMs: 60000 });
  ok('卡住判定发生在 60s，而不是 240s', early.action === 'give-up' && late.action === 'wait');
}

console.log('\n=== 有进展就一直等 ===');
{
  // 文本在长 → lastProgressAt 会一直被刷新，所以 sinceProgressMs 很小
  let r = v({ generating: true, len: 200, sinceProgressMs: 2000, elapsedMs: 200000 });
  ok('生成中且持续有进展 → 继续等（不打断慢回答）', r.action === 'wait', r.reason);
  r = v({ generating: false, len: 200, stableRounds: 1, sinceProgressMs: 2000, elapsedMs: 200000 });
  ok('刚停止生成、文本还没稳定 → 继续等', r.action === 'wait');
}

console.log('\n=== 总超时兜底 ===');
{
  let r = v({ elapsedMs: 240001, len: 0, generating: false, sinceProgressMs: 1000 });
  ok('超时且什么都没有 → timeout-empty', r.reason === 'timeout-empty', r.reason);
  r = v({ elapsedMs: 240001, len: 0, generating: true, sinceProgressMs: 1000 });
  ok('超时且仍在生成 → timeout-still-receiving', r.reason === 'timeout-still-receiving', r.reason);
}

console.log('\n=== 该不该重新提问 ===');
{
  const R = (errorCode, attempt, retries = 2) => shouldReask({ errorCode, attempt, retries });

  ok('卡住（生成中不动）→ 重问', R('stuck-frozen', 1).reask === true);
  ok('没反应（什么都没发生）→ 重问', R('stuck-silent', 1).reask === true);
  ok('一直停在接收中 → 重问', R('stuck-receiving', 1).reask === true);
  ok('没取到回答 → 重问', R('empty-answer', 1).reask === true);
  ok('发送失败 → 重问（多半是没送进去，重来一次就好）', R('send-failed', 1).reask === true);
  ok('图片没粘上 → 重问', R('paste-failed', 1).reask === true);

  // 越界保护
  ok('已重问满次数 → 不再重问', R('stuck-frozen', 3, 2).reask === false, R('stuck-frozen', 3, 2).reason);
  ok('retries=0 → 一次都不重问', R('stuck-frozen', 1, 0).reask === false);

  // 硬障碍绝不能靠重问解决（会把账号越推越深）
  ok('风控验证 → 不重问（必须人工）', R('verification-required', 1).reask === false, R('verification-required', 1).reason);
  ok('未登录 → 不重问', R('not-logged-in', 1).reask === false);
  ok('提问文本写入失败 → 不重问（重问也一样）', R('type-failed', 1).reask === false);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
