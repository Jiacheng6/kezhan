import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {selectedRunTasks,runScopeRequest,assertRunScope,selectOnlyTask,clearRunSelection,selectCourseTasks} from '../../src/ui/run-scope.js';
const make=()=>['a','b'].map(courseId=>({courseId,clazzId:`class-${courseId}`,name:'演示课程',enabled:true,tasks:Array.from({length:52},(_,i)=>({key:`${courseId}-${i}`,knowledgeId:`section-${i}`,type:'video',name:`演示视频 ${i}`,willHandle:true,excluded:false}))}));
let courses=make();const all=runScopeRequest(courses);assert.equal(all.taskKeys.length,104);
clearRunSelection(courses);assert.equal(selectedRunTasks(courses).length,0);
selectCourseTasks(courses[1],true);assert.equal(selectedRunTasks(courses).length,52);assert.ok(selectedRunTasks(courses).every(t=>t.courseId==='b'));
selectCourseTasks(courses[0],true);assert.equal(selectedRunTasks(courses).length,104);
selectCourseTasks(courses[1],false);assert.equal(selectedRunTasks(courses).length,52);
selectOnlyTask(courses,'a-7');assert.deepEqual(selectedRunTasks(courses).map(t=>t.key),['a-7']);assert.equal(courses[1].enabled,false);
const single=runScopeRequest(courses);assert.equal(assertRunScope(courses,single).length,1);
for(const invalid of [null,{}, {taskKeys:[]}, {...single,taskKeys:['a-7','a-7']}, {...single,taskKeys:['unknown']},all])assert.throws(()=>assertRunScope(courses,invalid),/范围|不一致/);
const changed=structuredClone(courses);changed[0].tasks[7].name='变更后的另一个任务';assert.throws(()=>assertRunScope(changed,single),/不一致/);
const expanded=make();assert.throws(()=>assertRunScope(expanded,single),/不一致/);
assert.throws(()=>selectOnlyTask(courses,'missing'),/不可选择/);
courses[0].tasks[6].willHandle=true;courses[0].tasks[6].excluded=true;
assert.deepEqual(selectedRunTasks(courses).map(t=>t.key),['a-7'],'排除任务即使遗留 willHandle=true 也不能执行');
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/run-scope-'));
const {buildRunTasks,BatchRunner}=await import('../../src/batch.mjs');assert.deepEqual(buildRunTasks({courses}).map(t=>t.key),['a-7']);
const {loadState}=await import('../../src/state.mjs');
const calls=[];
const runner=new BatchRunner({runVideo:async({task})=>{calls.push(task.key);return {...task,ok:false,phase:'needs-human',needsHuman:'视频弹窗未解决',error:'视频弹窗未解决'};}});
const videoTask=key=>({key,name:'演示视频',type:'video',willHandle:true,finished:false});
const result=await runner.start({ctx:{},tasks:[videoTask('popup-video'),videoTask('must-not-play')],command:{personId:'fixture'}});
assert.deepEqual(calls,['popup-video']);assert.equal(result.stats.done,0);assert.equal(result.stats.paused,true);assert.equal(result.stats.skipped,0);
assert.equal(loadState().taskPoints['popup-video'].status,'manual');
// Config may have been imported by batch above; use an isolated child for disk checks.
const {spawnSync}=await import('node:child_process');
const disk=spawnSync(process.execPath,['--input-type=module','-e',`
import fs from 'node:fs';import assert from 'node:assert/strict';
const {PATHS}=await import('../../src/config.mjs');const {loadSelection}=await import('../../src/chaoxing/checklist.mjs');
assert.deepEqual(loadSelection().excluded,[]);
for(const value of ['broken','null','[]','{"excluded":"bad"}','{"courses":[]}']){fs.writeFileSync(PATHS.selection,value);assert.throws(loadSelection,/无法读取选课范围/);assert.equal(fs.readFileSync(PATHS.selection,'utf8'),value);}
`],{cwd:path.resolve('tools/test'),env:process.env,encoding:'utf8'});
assert.equal(disk.status,0,disk.stderr);
console.log('✓ 104 项中仅选一项、排除任务不执行、明确范围核对、过期/扩大/错题身份拒绝、损坏选课文件禁止全选');
