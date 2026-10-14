/**
 * 课程树「选择算术」的离线单元测试（不需要浏览器）。
 *
 * 覆盖用户要的批量能力：全选/全不选/反选/只选未完成、按类型、按章节、
 * 节号区间、搜索过滤、只留前 N 个，以及"本次将刷什么"的汇总。
 *
 * 用法: node tools/test/test-selection.mjs
 */
import {
  batchSelect,
  batchSelectChapter,
  batchSelectBookChapter,
  keepFirstN,
  chapterState,
  willSummary,
  willList,
  inSecRange,
  matchesQuery,
  courseVisible,
  recalcAll,
} from '../../src/ui/selection.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/** 造一份典型清单：2 门课，含视频/测验/文档/直播 */
function makeData() {
  const mk = (over = {}) => ({
    key: over.key,
    knowledgeId: over.knowledgeId,
    secNo: over.secNo,
    sectionName: over.sectionName || '',
    name: over.name || '',
    type: over.type || 'video',
    policyHandle: over.policyHandle !== false,
    excluded: !!over.excluded,
    willHandle: false,
    finished: !!over.finished,
    sizeText: '',
  });

  const courses = [
    {
      courseId: 'C1',
      name: '示例课程甲',
      empty: false,
      enabled: true,
      sections: [
        { knowledgeId: 'k11', secNo: '1.1', name: '示例章节介绍' },
        { knowledgeId: 'k12', secNo: '1.2', name: '示例章节介绍' },
        { knowledgeId: 'k21', secNo: '2.1', name: '示例学习内容' },
      ],
      tasks: [
        mk({ key: 'C1:k11:t0', knowledgeId: 'k11', secNo: '1.1', name: '0.1.mp4', type: 'video' }),
        mk({ key: 'C1:k12:t0', knowledgeId: 'k12', secNo: '1.2', name: '0.2.mp4', type: 'video' }),
        mk({ key: 'C1:k12:t1', knowledgeId: 'k12', secNo: '1.2', name: '1.2', type: 'work' }),
        mk({ key: 'C1:k21:t0', knowledgeId: 'k21', secNo: '2.1', name: '1.1.mp4', type: 'video', finished: true }),
      ],
    },
    {
      courseId: 'C2',
      name: '示例课程乙',
      empty: false,
      enabled: true,
      sections: [
        { knowledgeId: 'k31', secNo: '3.1', name: '示例学习内容' },
        { knowledgeId: 'k32', secNo: '3.2', name: '示例学习内容' },
      ],
      tasks: [
        mk({ key: 'C2:k31:t0', knowledgeId: 'k31', secNo: '3.1', name: '3.1.mp4', type: 'video' }),
        mk({ key: 'C2:k31:t1', knowledgeId: 'k31', secNo: '3.1', name: '3.1', type: 'work' }),
        mk({ key: 'C2:k32:t0', knowledgeId: 'k32', secNo: '3.2', name: '课件.pptx', type: 'doc' }),
        mk({ key: 'C2:k32:t1', knowledgeId: 'k32', secNo: '3.2', name: '示例学习内容', type: 'live', policyHandle: false }),
      ],
    },
  ];
  recalcAll(courses);
  return courses;
}

console.log('=== 节号区间 ===');
ok('2.1 在 2.1-2.9 内', inSecRange('2.1', '2.1', '2.9'));
ok('2.10 在 2.1-2.9 外', !inSecRange('2.10', '2.1', '2.9'), '2.10 应大于 2.9');
ok('2.10 在 2.1-2.10 内', inSecRange('2.10', '2.1', '2.10'));
ok('反过来写区间也认（9-1）', inSecRange('3.1', '9', '1'));

console.log('\n=== 搜索 ===');
{
  const cs = makeData();
  ok('按课程名过滤', courseVisible(cs[0], '示例课程甲'));
  ok('无关词过滤掉', !courseVisible(cs[0], '另一门示例课程'));
  ok('按任务点名过滤', matchesQuery('示例课程甲', cs[0].tasks[0], '0.1'));
  ok('多关键词与关系', matchesQuery('示例课程甲', cs[0].tasks[1], '示例课程甲 1.2'));
}

console.log('\n=== 批量勾选 ===');
{
  const cs = makeData();
  let r = batchSelect(cs, 'deselect');
  ok('全不选：所有可处理任务被排除', cs.every((c) => c.tasks.every((t) => t.policyHandle === false || t.excluded)), `changed=${r.changed}`);
  ok('策略上不做的（直播）不参与批量勾选', cs[1].tasks[3].excluded === false && cs[1].tasks[3].policyHandle === false);

  r = batchSelect(cs, 'select');
  ok('全选：全部恢复', cs.every((c) => c.tasks.every((t) => !t.excluded)), `changed=${r.changed}`);

  r = batchSelect(cs, 'deselect', { scope: { video: false, work: true, doc: false, other: false } });
  ok('只排除测验', cs[1].tasks[1].excluded === true && cs[1].tasks[0].excluded === false, `affected=${r.affected}`);

  batchSelect(cs, 'select');
  r = batchSelect(cs, 'invert');
  ok('反选：全变排除', cs.every((c) => c.tasks.every((t) => t.policyHandle === false || t.excluded)));

  batchSelect(cs, 'select');
  r = batchSelect(cs, 'deselect', { finishedOnly: true });
  ok(
    '只选未完成：已完成的不动',
    cs[0].tasks[3].excluded === false && cs[0].tasks[0].excluded === true,
    `affected=${r.affected}（应为 6：7 个可处理任务里排除掉 1 个已完成的）`,
  );
}

console.log('\n=== 按课程 / 按区间 ===');
{
  const cs = makeData();
  // 批量操作只动"已启用"的课程（停用的课不该被悄悄改）
  cs[1].enabled = false;
  recalcAll(cs);
  const r0 = batchSelect(cs, 'deselect');
  ok('停用的课程不受批量操作影响', cs[1].tasks[0].excluded === false && cs[0].tasks[0].excluded === true, `changed=${r0.changed}`);
  cs[1].enabled = true;
  recalcAll(cs);
  batchSelect(cs, 'select');

  batchSelect(cs, 'deselect', { courseIds: ['C2'] });
  ok('只影响 C2', cs[1].tasks[0].excluded === true && cs[0].tasks[0].excluded === false);

  batchSelect(cs, 'select');
  batchSelect(cs, 'deselect', { from: '3.1', to: '3.1' });
  ok('只排除 3.1 节', cs[1].tasks[0].excluded === true && cs[1].tasks[2].excluded === false);
}

console.log('\n=== 整章 / 只留前 N 个 ===');
{
  const cs = makeData();
  const st0 = chapterState(cs[0], cs[0].sections[1]);
  ok('小节初始状态=全选', st0.state === 'all', `1.2 节有 ${st0.total} 个任务点`);

  batchSelectChapter(cs[0], cs[0].sections[1], 'deselect');
  ok('整节取消', chapterState(cs[0], cs[0].sections[1]).state === 'none');

  batchSelectChapter(cs[0], cs[0].sections[1], 'select');
  ok('整节恢复', chapterState(cs[0], cs[0].sections[1]).state === 'all');

  // 章级：第 1 章含 1.1 与 1.2 两个小节
  const r1 = batchSelectBookChapter(cs[0], '1', 'deselect');
  ok('整章（第1章）取消：含 1.1+1.2', cs[0].tasks[0].excluded === true && cs[0].tasks[1].excluded === true && cs[0].tasks[3].excluded === false, `changed=${r1.changed}`);

  batchSelectBookChapter(cs[0], '1', 'select');
  ok('整章恢复', cs[0].tasks[0].excluded === false && cs[0].tasks[1].excluded === false);

  const r = keepFirstN(cs[0], 2);
  const kept = cs[0].tasks.filter((t) => t.policyHandle !== false && !t.excluded).length;
  ok('只留前 2 个可处理任务点', kept === 2, `kept=${r.kept}/${r.total}`);
}

console.log('\n=== 汇总 / 预览 ===');
{
  const cs = makeData();
  batchSelect(cs, 'select');
  let s = willSummary(cs);
  ok('两门课都在范围内', s.courses === 2, `任务点 ${s.tasks}`);
  ok('类型分布正确（视频4 测验2 文档1）', s.byType.video === 4 && s.byType.work === 2 && s.byType.doc === 1, JSON.stringify(s.byType));

  cs[0].enabled = false;
  recalcAll(cs);
  s = willSummary(cs);
  ok('停用一门课后不计入', s.courses === 1 && s.byType.video === 1, JSON.stringify(s));

  cs[0].enabled = true;
  recalcAll(cs);
  s = willSummary(cs); // 重新汇总后再比（别拿旧汇总去比）
  const list = willList(cs);
  ok('预览清单条数与汇总一致', list.length === s.tasks, `${list.length} 条`);
  ok('预览含课程名与节号', !!list[0].course && !!list[0].secNo, JSON.stringify(list[0]));
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
