import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capturePlan, applyPlan, planRule, applyRule } from '../../src/ui/selection-plan.js';
import { recalcAll } from '../../src/ui/selection.js';
const make = () => recalcAll(['a','b'].map(courseId => ({courseId,clazzId:'class-'+courseId,enabled:courseId==='a',tasks:[
  {key:courseId+'-0',knowledgeId:'s0',secNo:'1.1',type:'video',name:'示例已完成视频',finished:true,excluded:false},
  {key:courseId+'-1',knowledgeId:'s0',secNo:'1.1',type:'work',name:'示例测验',finished:false,excluded:false},
  {key:courseId+'-2',knowledgeId:'s1',secNo:'1.2',type:'video',name:'示例后续视频',finished:false,excluded:false},
  {key:courseId+'-3',knowledgeId:'s2',secNo:'1.3',type:'doc',name:'示例文档',finished:false,excluded:false},
  {key:courseId+'-4',knowledgeId:'s2',secNo:'1.3',type:'live',name:'示例直播',policyHandle:false,finished:false,excluded:false},
]})));
let courses=make(), before=capturePlan(courses), preview=planRule(courses,'video',['a']);
assert.deepEqual(capturePlan(courses),before,'预览不能修改范围');assert.equal(preview.selected,1);assert.equal(preview.removed,3);
applyRule(courses,preview);assert.deepEqual(courses[0].tasks.filter(t=>t.willHandle).map(t=>t.key),['a-2']);assert.equal(courses[1].enabled,false);
applyPlan(courses,before);assert.equal(courses[0].tasks[0].excluded,false);
applyRule(courses,planRule(courses,'unfinished',['b']));assert.equal(courses[1].enabled,true);assert.deepEqual(courses[1].tasks.filter(t=>t.willHandle).map(t=>t.key),['b-1','b-2','b-3']);
assert.equal(planRule(courses,'from-next',['a']).selected,3);
assert.equal(planRule(courses,'range',['a'],{from:'1.2',to:'1.3'}).selected,2);
assert.throws(()=>planRule(courses,'range',['a'],{from:'bad'}),/节号/);
const saved=capturePlan(courses);courses[0].tasks[1].name='示例变更测验';courses[0].tasks.push({key:'a-new',type:'video',name:'示例新增任务'});
courses.push({courseId:'new-course',clazzId:'new-class',enabled:true,tasks:[{key:'new-task',type:'video'}]});
const restored=applyPlan(courses,saved);assert.equal(restored.missing,1);assert.equal(courses[0].tasks.find(t=>t.key==='a-1').excluded,true);assert.equal(courses[0].tasks.find(t=>t.key==='a-new').excluded,true);assert.equal(courses[2].enabled,false);
assert.throws(()=>applyPlan(courses,{courses:[{}]}),/课程/);
courses=make();const other=structuredClone(capturePlan(courses));other.courses[0].clazzId='other-class';assert.equal(applyPlan(courses,other).missing,5-1);assert.equal(courses[0].enabled,false);

fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/plans-'));
const {PATHS,setPersonId}=await import('../../src/config.mjs');
const {changeSelectionPreset,listSelectionPresets}=await import('../../src/chaoxing/selection-presets.mjs');
const {saveSelection}=await import('../../src/chaoxing/checklist.mjs');
setPersonId('fixture-a',{persist:false});const plan=capturePlan(make());
const created=changeSelectionPreset({action:'create',name:'示例视频方案',plan});assert.equal(listSelectionPresets().length,1);
saveSelection({courseOrder:['a'],courses:{},taskOrder:{},excluded:['a-0']});assert.equal(listSelectionPresets()[0].id,created.id,'保存本次选择不能清掉方案');
assert.throws(()=>changeSelectionPreset({action:'create',name:'示例视频方案',plan}),/同名/);
changeSelectionPreset({action:'rename',id:created.id,name:'示例改名'});assert.equal(listSelectionPresets()[0].name,'示例改名');
const selectionBefore=JSON.parse(fs.readFileSync(PATHS.selection,'utf8')).excluded;
setPersonId('fixture-b',{persist:false});assert.equal(listSelectionPresets().length,0);assert.throws(()=>changeSelectionPreset({action:'delete',id:created.id}),/不属于/);
setPersonId('fixture-a',{persist:false});changeSelectionPreset({action:'replace',id:created.id,name:'示例改名',plan});changeSelectionPreset({action:'delete',id:created.id});assert.equal(listSelectionPresets().length,0);
assert.deepEqual(JSON.parse(fs.readFileSync(PATHS.selection,'utf8')).excluded,selectionBefore,'方案管理不能改变已保存执行范围');
fs.writeFileSync(PATHS.selection,'broken');assert.throws(()=>changeSelectionPreset({action:'create',name:'示例',plan}),/未覆盖/);assert.equal(fs.readFileSync(PATHS.selection,'utf8'),'broken');
fs.writeFileSync(PATHS.selection,'{}');
const {startServer}=await import('../../src/server.mjs');const {patchStatus}=await import('../../src/logbus.mjs');
const {server,wss,url}=await startServer();
try {
  const request=body=>fetch(new URL('/api/selection/presets',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const made=await(await request({action:'create',name:'示例接口方案',plan})).json();assert.equal(made.ok,true);
  const listed=await(await fetch(new URL('/api/selection/presets',url))).json();assert.equal(listed.result.length,1);
  assert.equal((await fetch(new URL('/api/selection/presets',url),{method:'DELETE'})).status,405);
  patchStatus({running:true});assert.equal((await request({action:'delete',id:made.result.id})).status,409);
  patchStatus({running:false});assert.equal((await request({action:'create',name:'示例无效',plan:{courses:[{}]}})).status,400);
  assert.equal(listSelectionPresets().length,1,'错误请求不能破坏已有方案');
} finally { patchStatus({running:false});for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
console.log('✓ 快捷规则预览/范围替换、撤销快照、变化任务保护、方案持久化、账号隔离、选择兼容和损坏保护通过');
