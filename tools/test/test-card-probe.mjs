/**
 * 小节"多卡片探测"的离线测试（不需要浏览器）。
 *
 * 为什么要测：这里出过一次**静默漏读**——侦察用树上的"待完成数"当"应有任务点数"
 * 提前收工，于是"视频已完成 + 章节测验未完成"的小节（待完成数=1）
 * 读到视频就停了，**下一张卡片上的章节测验整条丢失**：
 * 清单里没有它 → 程序永远不做 → 小节永远不变绿。
 * 用户实测原话："2视频任务点已完成，而3章节测验未完成"。
 *
 * 用法: node tools/test/test-card-probe.mjs
 */
import { nextCardDecision } from '../../src/chaoxing/recon.mjs';

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

const d = (o) =>
  nextCardDecision({
    attachCount: 0,
    empty: false,
    consecutiveEmpty: 0,
    probed: 1,
    maxCards: 6,
    found: 0,
    wantCount: null,
    ...o,
  });

console.log('=== 核心回归：数量够了也不能提前收工 ===');
{
  // 用户实测的那个小节：num=0 学习目标(0) → num=1 视频(1) → num=2 章节测验(1) → num=3 暂无内容
  let r = d({ attachCount: 1, probed: 2, found: 1, wantCount: 1 });
  ok('待完成数=1、已找到 1 个时**不**停止（旧版在这里停住，漏掉测验）', r.stop === false, r.reason);
  r = d({ attachCount: 1, probed: 3, found: 2, wantCount: 1 });
  ok('读到第 2 个任务点后仍不停止（继续确认到头）', r.stop === false, r.reason);
  r = d({ attachCount: 0, empty: true, probed: 4, found: 2, wantCount: 1 });
  ok('直到「暂无内容」才停止', r.stop === true, r.reason);
}
{
  // 更极端：树上的数比实际小很多，也不能停
  const r = d({ attachCount: 1, probed: 3, found: 3, wantCount: 1 });
  ok('找到数远大于待完成数时仍不停止', r.stop === false, r.reason);
  ok('并且会说明"树上的数不能当总数"', /不能当总数|不可当总数/.test(r.reason), r.reason);
}

console.log('\n=== 其他终止条件 ===');
{
  ok('「暂无内容」→ 停止', d({ empty: true }).stop === true);
  ok('连续两张没附件 → 停止', d({ attachCount: 0, consecutiveEmpty: 2, probed: 3 }).stop === true);
  ok('只连续一张没附件 → 不停止（可能只是中间夹了文字卡）', d({ attachCount: 0, consecutiveEmpty: 1, probed: 2 }).stop === false);
  ok('达到探测上限 → 停止', d({ attachCount: 1, probed: 6, maxCards: 6, found: 6 }).stop === true);
  ok('首张卡片就有附件 → 不停止', d({ attachCount: 2, probed: 1, found: 2 }).stop === false);
  ok('首张卡片空且非暂无内容 → 不停止（学习目标卡）', d({ attachCount: 0, probed: 1 }).stop === false);
  ok('wantCount 为 null 不影响判断', d({ attachCount: 1, probed: 2, found: 1, wantCount: null }).stop === false);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
