// Intercepted local fixtures only. Exercises the real Ucampus study executor
// through the batch (object) and old single-node (getter) entry contracts.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/ucampus-context-'));
const {ucampusContext}=await import('../../src/platforms/ucampus/context.mjs');
const {readTutorialProgress,scanUcampusCourses}=await import('../../src/platforms/ucampus/scan.mjs');
const {runUcampusStudyNode}=await import('../../src/platforms/ucampus/runner.mjs');
const {PlatformRuns}=await import('../../src/platforms/runs.mjs');
const {canRestartTask}=await import('../../src/task-recovery.mjs');
const {mutateState}=await import('../../src/state.mjs');
const {findEdge}=await import('../../src/browser/launch.mjs');
mutateState(s=>{s.settings={ucampusDwellMs:5000};});
const dummy={pages:()=>[],newPage:async()=>{}};
assert.equal(ucampusContext(dummy),dummy);assert.equal(ucampusContext(()=>dummy),dummy);
for(const value of [null,{},()=>null]){
 let error;try{ucampusContext(value);}catch(e){error=e;}
 assert.equal(error?.code,'INVALID_BROWSER_CONTEXT');assert.equal(canRestartTask({platform:'ucampus'},error,{thrown:true}),false);
}
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 for(const asGetter of [false,true]){
  const context=await browser.newContext();let reads=0,nodeOpens=0;
  await context.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/api/cmgt/course/getCourseListByStudent'){
    reads++;return route.fulfill({json:{value:{courseList:[{id:'course',classId:'class',name:'Fixture',courseResourceList:[{id:'123',finishPointNum:nodeOpens?2:1,totalPointNum:7}]}]}}});
   }
   if(u.hostname==='ucontent.unipus.cn'){
    if(u.pathname.includes('/course/api/')){nodeOpens++;return route.fulfill({json:{}});}
    return route.fulfill({contentType:'text/html',body:'<button>目录</button><span class="pc-menu-node-name" onclick="fetch(\'/course/api/abcdef123456/default\')">Fixture reading</span><p>Read this passage.</p>'});
   }
   return route.fulfill({contentType:'text/html',body:'<p>Fixture portal</p>'});
  });
  const portal=await context.newPage();await portal.goto('https://uai.unipus.cn/portal');
  const player=await context.newPage();await player.goto('https://ucontent.unipus.cn/pc.html#/instance');
  const supplied=asGetter?()=>context:context;
  assert.equal((await readTutorialProgress({context:supplied,courseResourceId:'123'})).finishPointNum,1);
  const task={key:'ucampus:fixture',platform:'ucampus',platformTaskKey:'abcdef123456',courseResourceId:'123',courseInstanceId:'instance',type:'study',name:'Fixture reading'};
  let nextReached=false;
  const runs=new PlatformRuns({execute:async args=>{
   if(args.platform==='chaoxing'){nextReached=true;return {ok:true};}
   return runUcampusStudyNode({...args,context:supplied});
  }});
  runs.start('ucampus',[task],context);runs.start('chaoxing',[{key:'fixture-video',platform:'chaoxing'}],context);
  const [result]=await Promise.all([runs.wait('ucampus'),runs.wait('chaoxing')]);
  assert.equal(result.done,1,JSON.stringify(result));assert.equal(result.error,null);assert.ok(nextReached);assert.ok(reads>=3);assert.ok(nodeOpens>=1);
  await assert.rejects(()=>runUcampusStudyNode({task,context:supplied,shouldStop:()=>true}),e=>e.code==='STOPPED');
  await context.close();
 }
 // Scanning supports the same two forms without invoking a supplied object.
 const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({json:{value:{courseList:[]}}}));
 for(const supplied of [context,()=>context])assert.deepEqual((await scanUcampusCourses({context:supplied})).courses,[]);
 await context.close();
 console.log('✓ U校园批量对象/单节点函数两种连接均贯通进度读取、播放器、节点执行与回查；学习通并发、停止及失效连接不盲重试');
}finally{await browser.close();}
