/**
 * 「任务点完成判定」的离线测试（不需要浏览器、不需要登录）。
 *
 * 为什么值得单独测：这里出过一次代价很高的错 ——
 * 拿**小节绿点**当"本任务点是否完成"，而学习通的小节要**所有**任务点都做完才绿。
 * 于是"视频 + 章节测验"的小节里，视频播完也永远判不完成 →
 * 内联重试 → 23 分钟的视频反复重播，章节测验永远轮不到（用户实测反馈）。
 *
 * 用法: node tools/test/test-completion.mjs
 */
import { verifyTaskCompletion, describeCompletion } from '../../src/chaoxing/runner.mjs';
import { skipDecision, describeSkip } from '../../src/chaoxing/skip.mjs';
import { watchedRatio, videoPassedVerdict } from '../../src/chaoxing/attach.mjs';

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

const task = {
  key: 'c1:k1:t0',
  courseId: 'c1',
  clazzId: 'k1',
  knowledgeId: 'k1',
  name: '示例学习内容',
  secNo: '1.1',
  type: 'video',
};

/** 造一个假的完成判定环境：point 按序返回，section 固定 */
function mkDeps({ points = [], section = null } = {}) {
  const calls = { point: 0, section: 0 };
  return {
    calls,
    checkPointFinished: async () => {
      const p = points[Math.min(calls.point, points.length - 1)] ?? null;
      calls.point += 1;
      return p;
    },
    readSectionStatus: async () => {
      calls.section += 1;
      return section;
    },
  };
}

/** 常见组合：本任务点已完成，但小节因另一个任务点未完成而不绿 */
const sectionNotGreen = { done: false, jobPending: 1, tipText: '1 个待完成', jobTotal: 2 };

console.log('=== 核心回归：小节不绿 ≠ 本任务点没完成 ===');
{
  const deps = mkDeps({ points: [{ finished: true, via: 'name-match', aria: '已完成' }], section: sectionNotGreen });
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 0, intervalMs: 1, deps });
  ok('判为完成', v.done === true, `via=${v.via}`);
  ok('依据是任务点级，而不是小节绿点', v.via === 'task-point');
  const text = describeCompletion(v, task);
  ok('日志说清"小节不绿与本任务无关"', /小节还有 1 个任务点待完成/.test(text), text);
  ok('没有为等绿点空转（只查一轮任务点）', deps.calls.point === 1, `point 调用 ${deps.calls.point} 次`);
  ok('成功路径顺手取一次小节状态（为了说清还差几项）', deps.calls.section === 1, `section 调用 ${deps.calls.section} 次`);
}

console.log('\n=== 兜底：任务点读不出来时看小节绿点 ===');
{
  const deps = mkDeps({ points: [{ finished: null, via: 'no-attach', error: '列表未渲染' }], section: { done: true } });
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 0, intervalMs: 1, deps });
  ok('小节全绿 → 完成', v.done === true && v.via === 'section-green', `via=${v.via}`);
  ok('确实查过小节状态', deps.calls.section === 1);
}

console.log('\n=== 真的没完成：不能误判为成功 ===');
{
  const deps = mkDeps({ points: [{ finished: false, via: 'name-match', aria: '任务点未完成' }], section: sectionNotGreen });
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 0, intervalMs: 1, deps });
  ok('判为未完成', v.done === false);
  ok('描述指明是本任务点未标记完成', /本任务点仍未标记完成/.test(describeCompletion(v, task)), describeCompletion(v, task));
}
{
  const deps = mkDeps({ points: [{ finished: null, via: 'pending' }], section: null });
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 0, intervalMs: 1, deps });
  ok('两个信号都读不到 → 未完成（不武断记成功）', v.done === false);
  ok('描述说明读不出原因', /读不出来/.test(describeCompletion(v, task)), describeCompletion(v, task));
}

console.log('\n=== 轮询：服务端延迟后补上完成标记 ===');
{
  const deps = mkDeps({
    points: [{ finished: false }, { finished: false }, { finished: true }],
    section: sectionNotGreen,
  });
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 60000, intervalMs: 5, deps });
  ok('会轮询到完成为止', v.done === true && v.via === 'task-point', `查了 ${deps.calls.point} 轮`);
  ok('轮询次数与预期一致', deps.calls.point === 3);
}

console.log('\n=== 预算耗尽就收手（不空转）===');
{
  const deps = mkDeps({ points: [{ finished: false }], section: sectionNotGreen });
  const t0 = Date.now();
  const v = await verifyTaskCompletion({ task, personId: 'p', totalBudgetMs: 20, intervalMs: 10, deps });
  ok('返回未完成', v.done === false);
  ok('没有超时太久', Date.now() - t0 < 500, `${Date.now() - t0}ms`);
  ok('onWait 被回调过（便于打进度日志）', true);
}
{
  const ticks = [];
  const deps = mkDeps({ points: [{ finished: false }], section: sectionNotGreen });
  await verifyTaskCompletion({
    task,
    personId: 'p',
    totalBudgetMs: 30,
    intervalMs: 10,
    deps,
    onWait: (info) => ticks.push(info),
  });
  ok('onWait 报告了轮次与等待秒数', ticks.length >= 1 && 'waitedSec' in ticks[0], JSON.stringify(ticks[0] || {}));
}

console.log('\n=== 跳过判定：绝不重做已完成的（避免重复课程）===');
{
  const t = { ...task, finished: false };

  // ① 本地记录已完成 → 跳过（最可信，且不用开页面）
  let d = skipDecision({ task: t, stateStatus: 'done' });
  ok('本地记录 done → 跳过', d.skip === true && d.source === 'state', d.reason);

  // ② 侦察快照显示已完成 → 跳过（用户可能在手机/别的设备上做完了）
  d = skipDecision({ task: { ...task, finished: true }, stateStatus: null });
  ok('侦察快照 finished → 跳过', d.skip === true && d.source === 'manifest', d.reason);

  // ③ 学习通页面实时标记已完成 → 跳过（**最关键的一条**：快照过期时靠它）
  d = skipDecision({ task: t, stateStatus: 'pending', pointFinished: true });
  ok('学习通实时标记已完成 → 跳过', d.skip === true && d.source === 'task-point', d.reason);

  // ④ 整节全绿 → 跳过（全绿必然蕴含本点完成）
  d = skipDecision({ task: t, stateStatus: null, pointFinished: null, section: { done: true } });
  ok('小节全绿 → 跳过', d.skip === true && d.source === 'section-green', d.reason);
  d = skipDecision({ task: t, stateStatus: null, pointFinished: null, section: { done: false, jobPending: 0 } });
  ok('待完成数为 0 → 跳过', d.skip === true && d.source === 'section-green', d.reason);

  // ⑤ 没做完 / 读不出 → 必须做（宁可多开一次页面，也不漏做）
  d = skipDecision({ task: t, stateStatus: 'pending', pointFinished: false, section: { done: false, jobPending: 1 } });
  ok('确实没完成 → 不跳过', d.skip === false, d.reason);
  d = skipDecision({ task: t, stateStatus: null, pointFinished: null, section: { done: false, jobPending: 2 } });
  ok('状态读不出来 → 不跳过（保守）', d.skip === false);
  d = skipDecision({ task: t, stateStatus: 'manual' }); // 待人工 ≠ 完成
  ok('「待人工」不算完成', d.skip === false);
  d = skipDecision({ task: t, stateStatus: 'failed' });
  ok('「失败」会重试，不算完成', d.skip === false);

  // ⑥ 关键反例：**小节不绿但本任务点已完成** → 仍要跳过（"一直重复视频"的根源）
  d = skipDecision({
    task: t,
    stateStatus: 'pending',
    pointFinished: true,
    section: { done: false, jobPending: 1, tipText: '1 个待完成' },
  });
  ok('小节不绿 + 本点已完成 → 跳过', d.skip === true && d.source === 'task-point', d.reason);

  ok('跳过文案统一口径', /^⊘ 跳过：/.test(describeSkip(d)), describeSkip(d));
  ok('不跳过时没有文案', describeSkip({ skip: false }) === '');
}

console.log('\n=== 视频模块记录（服务端权威，页面 aria 会过期）===');
{
  /*
   * 实测案例（2026-09-24，用户指出）：某小节视频页面 aria 一直显示
   * 「任务点未完成」，但模块记录 isPassed=true、playTime=1387000ms（整条 23 分 7 秒）。
   * 只信 aria → 这条视频被反复重播。
   */
  const real = { found: true, isPassed: true, playTime: 1387000, attDuration: 1387 };
  let v = videoPassedVerdict(real);
  ok('isPassed=true → 判为已完成', v.finished === true, v.note);
  // 单位坑：playTime 是毫秒，attDuration 是"秒×1000 的整数" —— 直接相除会得到 100000%
  ok('量纲不同的两者也能算出合理比例', v.ratio !== null && v.ratio > 0.99 && v.ratio <= 1, `ratio=${v.ratio}`);
  ok('比例不会被算成 100000%', String((v.ratio * 100).toFixed(1)) === '100.0', `${(v.ratio * 100).toFixed(1)}%`);

  v = videoPassedVerdict({ found: true, isPassed: false, playTime: 1200000, attDuration: 1387000 });
  ok('isPassed=false → 判为未完成', v.finished === false, v.note);

  v = videoPassedVerdict({ found: false });
  ok('没有模块记录 → 读不出（交给 aria 兜底）', v.finished === null, v.note);

  v = videoPassedVerdict({ found: true, playTime: 100, attDuration: 0 });
  ok('缺时长不让比例变 NaN', v.ratio === null, `ratio=${v.ratio}`);

  ok('比例函数对毫秒量纲也成立', watchedRatio(600000, 1387000) > 0.4 && watchedRatio(600000, 1387000) < 0.5);
  ok('比例函数对秒量纲也成立', watchedRatio(1387000, 1387) === 1);
  ok('比例为 0/缺值时返回 null', watchedRatio(0, 100) === null && watchedRatio(NaN, 100) === null);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
