import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { taskCompletion, completionCounts, mergeTaskCompletion } from '../../src/ui/task-status.js';
import { batchSelect } from '../../src/ui/selection.js';

const root = path.resolve('.desktop-test');
fs.mkdirSync(root, { recursive: true });
process.env.XXT_DATA_DIR = fs.mkdtempSync(path.join(root, 'tree-progress-'));
const { PATHS, ensureDirs } = await import('../../src/config.mjs');
const { buildChecklist } = await import('../../src/chaoxing/checklist.mjs');
const { setTaskStatus } = await import('../../src/state.mjs');
ensureDirs();
const report = { at: '2026-01-01T00:00:00Z', courses: [{ courseId: 'example-course', clazzId: 'example-class', name: '示例课程甲', taskPoints: [
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', type: 'video', finished: false },
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', type: 'work', finished: false },
] }] };
fs.writeFileSync(PATHS.taskReport, JSON.stringify(report));
setTaskStatus('example-course:example-section:t0', { status: 'done' });
setTaskStatus('example-course:example-section:t1', { status: 'manual' });
const before = fs.readFileSync(PATHS.state, 'utf8');
const cl = buildChecklist({ includeProgress: true });
const course = cl.courses[0];
assert.equal(course.tasks.length, 2, '视频完成后仍保留答题任务');
assert.equal(course.tasks[0].completion.label, '已完成');
assert.equal(course.tasks[1].completion.label, '待你核对');
assert.deepEqual(completionCounts(course.tasks), { total: 2, done: 1, remaining: 1 });
assert.equal(course.tasks[0].finished, false, '仅展示合并状态，不改侦察结果或执行输入');
assert.equal(buildChecklist().courses[0].tasks[0].completion.finished, false, '执行清单保留原有判定');
assert.equal(fs.readFileSync(PATHS.state, 'utf8'), before, '读取课程树不写入任务状态');

for (const t of course.tasks) t.excluded = true;
batchSelect([course], 'select', { finishedOnly: true });
assert.equal(course.tasks[0].excluded, true, '只选未完成时识别本机完成记录');
assert.equal(course.tasks[1].excluded, false);
course.enabled = false;
course.tasks.reverse();
setTaskStatus('example-course:example-section:t1', { status: 'done' });
assert.equal(mergeTaskCompletion(cl, buildChecklist({ includeProgress: true })), true);
assert.deepEqual(completionCounts(course.tasks), { total: 2, done: 2, remaining: 0 });
assert.equal(course.enabled, false);
assert.equal(course.tasks[0].type, 'work', '刷新不覆盖排序');
assert.equal(course.tasks[1].excluded, true, '刷新不覆盖勾选');
assert.equal(mergeTaskCompletion(cl, buildChecklist({ includeProgress: true })), false);
assert.equal(taskCompletion({ finished: true }, { status: 'manual' }).finished, true);
assert.equal(taskCompletion({ finished: false }, { status: 'running' }).finished, false);
assert.equal(taskCompletion({}).state, 'unknown');
assert.equal(taskCompletion({ finished: false }, { status: 'skipped' }).finished, false);
const discussionView={courses:[{courseId:'discussion-course',enabled:true,tasks:[{key:'discussion',type:'discuss',policyHandle:false,blockedReason:'需开启讨论草稿',excluded:false,willHandle:false}]}]};
const freshDiscussion={courses:[{courseId:'discussion-course',tasks:[{key:'discussion',type:'discuss',policyHandle:true,blockedReason:null}]}]};
assert.equal(mergeTaskCompletion(discussionView,freshDiscussion),true);
assert.equal(discussionView.courses[0].tasks[0].policyHandle,true,'保存讨论开关后已有清单即刻解锁');
assert.equal(discussionView.courses[0].tasks[0].excluded,true,'解锁不自动扩大本次学习范围');
assert.equal(discussionView.courses[0].tasks[0].willHandle,false);
console.log('✓ 分任务完成状态、视频完成但答题待审、只选未完成、刷新保留选择和排序、只读展示通过');
