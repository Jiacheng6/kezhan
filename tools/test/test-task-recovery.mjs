import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/task-recovery-'));
const {runWithTaskRestart,canRestartTask}=await import('../../src/task-recovery.mjs');
const {PlatformRuns}=await import('../../src/platforms/runs.mjs');
const {BatchRunner}=await import('../../src/batch.mjs');
const {mutateState,loadState,listReviewItems,addHandbook}=await import('../../src/state.mjs');
const task={platform:'zhihuishu',key:'fixture-video',type:'video',name:'示例任务'};
const verification={ok:false,phase:'needs-human',code:'VERIFICATION_REQUIRED',verificationPlatform:'zhihuishu',error:'智慧树需要人工验证'};
assert.equal(canRestartTask(task,verification),true);
for(const outcome of [{...verification,code:'USER_CONSENT_REQUIRED'},{phase:'stopped'},{ok:true,phase:'awaiting-review'},{ok:false,submissionPending:true,error:'超时'},{phase:'submit',error:'超时'},{phase:'needs-human',aiErrorCode:'verification-required',error:'AI人工验证'}])assert.equal(canRestartTask(task,outcome),false);
for(const type of ['video','doc','read','work','discuss']){
 let calls=0;const checkpoint={};
 const result=await runWithTaskRestart(async({restartTask})=>{
  calls++;assert.equal(restartTask,calls===2);
  if(calls===1){checkpoint.savedAnswer='A';return {ok:false,phase:'needs-human',error:'页面加载超时'};}
  assert.equal(checkpoint.savedAnswer,'A','恢复不能重置保存的答案');return {ok:true};
 },{task:{...task,type},delayMs:0});assert.equal(result.ok,true);assert.equal(calls,2,type);
}
let calls=0;await assert.rejects(runWithTaskRestart(async()=>{calls++;throw Error('播放器超时');},{task,delayMs:0}),/播放器超时/);assert.equal(calls,2,'异常最多重启一次');
calls=0;const persistent=new PlatformRuns({restartDelayMs:0,execute:async()=>{calls++;return verification;}});
persistent.start('zhihuishu',[task,{...task,key:'not-selected-next'}]);await persistent.wait('zhihuishu');assert.equal(calls,2);assert.equal(persistent.snapshot().zhihuishu.phase,'needs-human');assert.equal(persistent.snapshot().zhihuishu.done,0,'重复验证不能冒充完成或继续下一项');
const seen=[],restarts=[];const recovered=new PlatformRuns({restartDelayMs:0,onRestart:x=>restarts.push(x.task.key),execute:async({task,restartTask})=>{seen.push(task.key);if(task.key==='first'&&!restartTask)return verification;return {ok:true};}});
recovered.start('zhihuishu',[{...task,key:'first'},{...task,key:'second'}]);await recovered.wait('zhihuishu');assert.deepEqual(seen,['first','first','second']);assert.deepEqual(restarts,['first']);assert.equal(recovered.snapshot().zhihuishu.done,2);
calls=0;const stopped=new PlatformRuns({restartDelayMs:0,onRestart:()=>stopped.stop('zhihuishu'),execute:async()=>{calls++;return verification;}});stopped.start('zhihuishu',[task]);await stopped.wait('zhihuishu');assert.equal(calls,1);assert.equal(stopped.snapshot().zhihuishu.phase,'stopped');
calls=0;await runWithTaskRestart(async()=>{calls++;return {ok:false,phase:'awaiting-review'};},{task:{...task,type:'work'},delayMs:0});assert.equal(calls,1,'待审不重启');
mutateState(s=>{s.settings={...s.settings,maxRetries:1};});
addHandbook({key:'unrelated-manual',reason:'不相关的原有待人工记录'});
for(const type of ['video','doc','work','discuss']){
 const key='chaoxing-'+type;let tries=0;
 const execute=async(args)=>{
  tries++;
  if(type==='video'&&tries===1)addHandbook({key,reason:'视频弹题暂未恢复'});
  if(type==='work'&&tries===2){assert.equal(args.restartTask,true);assert.equal(args.reviewRetry,false,'保留任务原有提交/审阅模式');assert.equal(listReviewItems().find(i=>i.taskKey===key)?.aiAnswer,'A','恢复不能清除前题草稿');}
  return {ok:tries===2,phase:tries===1?'needs-human':'done',error:tries===1?'页面加载超时':null,key,items:type==='work'?[{id:key+'#q1',taskKey:key,aiAnswer:'A',autoFilled:true,status:'pending-review'}]:[],submitted:false};
 };
 const runner=new BatchRunner({runVideo:execute,runDoc:execute,runQuiz:execute,runDiscussion:execute});
 await runner.start({ctx:{},command:{personId:'fixture'},tasks:[{key,type,willHandle:true,finished:false,name:'示例任务',courseId:'fixture',knowledgeId:'section'}]});
 assert.equal(tries,2,type+'暂停后重启当前任务一次');assert.equal(runner.stats.done,1);assert.equal(runner.stats.failed,0);
 assert.equal(loadState().handbook.some(h=>h.key===key),false,'重启成功后不能残留该任务的待人工提示');
}
assert.equal(loadState().handbook.some(h=>h.key==='unrelated-manual'),true,'不能删除其他任务的待人工记录');
assert.equal(loadState().reviewQueue.some(i=>i.aiAnswer==='A'),true);
console.log('✓ 当前任务单次恢复、智慧树验证码最多两次进入、成功续队列、失败不扩大范围、停止取消恢复、待审/提交保护及跨类型草稿保留');
