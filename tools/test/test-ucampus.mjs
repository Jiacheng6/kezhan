/**
 * U校园 平台层纯逻辑测试（离线，不碰浏览器）。
 * 用法: node tools/test/test-ucampus.mjs
 */
import {
  ucampusTaskKey,
  parseUcampusTaskKey,
  buildTaskPoints,
  pendingNodes,
  progressDelta,
  classifyNodeOutcome,
  summarizeTutorial,
  isTutorialComplete,
  nodeKind,
} from '../../src/platforms/ucampus/policy.mjs';

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

console.log('=== 任务标识 ===');
{
  const key = ucampusTaskKey('20001230493', '65669ba2e000ec9');
  ok('key 带平台前缀', key === 'ucampus:20001230493:65669ba2e000ec9', key);
  const back = parseUcampusTaskKey(key);
  ok('可反解', back.courseResourceId === '20001230493' && back.nodeId === '65669ba2e000ec9');
  ok('非本平台 key 报错', (() => {
    try {
      parseUcampusTaskKey('zhihuishu:1:2');
      return false;
    } catch {
      return true;
    }
  })());
}

console.log('\n=== 清单构建（6 单元 × 7 = 42，与平台口径一致）===');
{
  const units = Array.from({ length: 6 }, (_, i) => ({
    unitName: `Unit ${i + 1}`,
    requiredTask: Array.from({ length: 7 }, (_, j) => `node${i}${j}`),
  }));
  const points = buildTaskPoints({ tutorial: { id: 20001230493, instanceId: 'course-v2:abc' }, units });
  ok('节点总数 42', points.length === 42, String(points.length));
  ok('第一个节点带单元与序号', points[0].sectionName === 'Unit 1' && points[0].secNo === 'U1.1');
  ok('带教程实例 id（拼播放器地址要用）', points[0].courseInstanceId === 'course-v2:abc');
  ok('默认都不算完成（不猜）', pendingNodes(points).length === 42);
  const withDone = buildTaskPoints({ tutorial: { id: 1 }, units, progress: { node00: 'done' } });
  ok('已知完成会标 finished', withDone.find((p) => p.platformTaskKey === 'node00').finished === true);
  ok('待完成相应减少', pendingNodes(withDone).length === 41);
}

console.log('\n=== 进度对比（平台口径验收）===');
{
  ok('1→2 判定为增长（真机实测的那种）', progressDelta({ finishPointNum: 1 }, { finishPointNum: 2 }) === 'advanced');
  ok('2→2 判定未变', progressDelta({ finishPointNum: 2 }, { finishPointNum: 2 }) === 'unchanged');
  ok('2→1 判定回退', progressDelta({ finishPointNum: 2 }, { finishPointNum: 1 }) === 'regressed');
  ok('字段缺失不误判', progressDelta({}, {}) === 'unchanged');
}

console.log('\n=== 结果归类 ===');
{
  ok('进度增长 → completed', classifyNodeOutcome({ delta: 'advanced' }).phase === 'completed');
  ok('未增长 → needs-human（不谎报完成）', classifyNodeOutcome({ delta: 'unchanged' }).phase === 'needs-human');
  ok('停止 → stopped', classifyNodeOutcome({ delta: 'advanced', stopped: true }).phase === 'stopped');
  ok('报错信息会带出来', /没记录/.test(classifyNodeOutcome({ delta: 'unchanged', error: '平台没记录' }).error));
}

console.log('\n=== 教程进度摘要 ===');
{
  const s = summarizeTutorial({ finishPointNum: 1, totalPointNum: 42 });
  ok('1/42 显示为已学任务', s.label === '已学任务 1/42', s.label);
  ok('百分比 2.4%', s.percent === 2.4, String(s.percent));
  ok('未完成判定', isTutorialComplete({ finishPointNum: 1, totalPointNum: 42 }) === false);
  ok('全部完成判定', isTutorialComplete({ finishPointNum: 42, totalPointNum: 42 }) === true);
  ok('未激活（0 任务）不算完成', isTutorialComplete({ finishPointNum: 0, totalPointNum: 0 }) === false);
}

console.log('\n=== 节点类型判定 ===');
{
  ok('自评表格 → self-assessment', nodeKind({ hasSelfAssessTable: true }) === 'self-assessment');
  ok('有视频 → video', nodeKind({ hasVideo: true }) === 'video');
  ok('有音频 → audio', nodeKind({ hasAudio: true }) === 'audio');
  ok('有选项 → quiz', nodeKind({ hasOptions: true }) === 'quiz');
  ok('简答也算 quiz', nodeKind({ hasEssay: true }) === 'quiz');
  ok('都没有 → reading', nodeKind({}) === 'reading');
  ok('自评优先于视频（表格里也可能有媒体）', nodeKind({ hasSelfAssessTable: true, hasVideo: true }) === 'self-assessment');
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
