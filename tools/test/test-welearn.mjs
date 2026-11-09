// Every website request is intercepted. No live account, AI or platform writes.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/welearn-fixture-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const {readMeta,makeCourse,normalizeLessons,courseKey,studyUrl}=await import('../../src/platforms/welearn/policy.mjs');
const {scanWelearnCourses}=await import('../../src/platforms/welearn/scan.mjs');
const {readWelearn}=await import('../../src/platforms/welearn/api.mjs');
const {readPractice,fillPractice,assistPractice}=await import('../../src/platforms/welearn/practice.mjs');
const {runWelearnTask,readNativeState}=await import('../../src/platforms/welearn/runner.mjs');
const {assertNativeLesson}=await import('../../src/platforms/welearn/navigation.mjs');
const {readPlatformCatalog}=await import('../../src/platforms/catalog.mjs');
const {buildChecklist}=await import('../../src/chaoxing/checklist.mjs');
const {loadState,setTaskStatus}=await import('../../src/state.mjs');
const {PlatformRuns}=await import('../../src/platforms/runs.mjs');
const meta={uid:'1001',cid:'2001',classid:'3001'};
assert.deepEqual(readMeta('<script>const a={uid:1001,classid:3001};const b={uid:function(){},classid:classid,stuid:99}</script>',meta.cid),meta);
assert.throws(()=>readMeta('{uid:1,classid:2},{uid:3,classid:2}',meta.cid),/身份/);
assert.notEqual(courseKey(meta),courseKey({...meta,uid:'other'}),'账号隔离');
assert.equal(normalizeLessons([{id:'one',iscomplete:'未完成',crate:'100'}],0)[0].finished,false,'满分或未完成不冒充完成');
assert.throws(()=>normalizeLessons([{id:'one'},{id:'one'}],0),/重复/);
const demo=makeCourse({name:'匿名英语课'},meta,[{unitname:'Unit 1',lessons:normalizeLessons([{id:'one',name:'Listening & Speaking',iscomplete:'未完成'},{id:'oral',name:'Read aloud',iscomplete:'未完成'},{id:'locked',isvisible:'false'}],0)}]);
assert.equal(demo.taskPoints[0].type,'study');assert.equal(demo.taskPoints[1].type,'welearn-manual');assert.equal(demo.taskPoints[2].blockedReason,'平台尚未开放');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const context=await browser.newContext(),requests=[];let finished=false,submits=0,badScan=false,askCount=0,wrongIdentity=false;
 await context.exposeBinding('finishFixture',()=>{submits++;finished=true;});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());requests.push({method:route.request().method(),path:url.pathname,action:url.searchParams.get('action')});
  if(url.hostname!=='welearn.sflep.com')return route.abort();
  if(url.pathname==='/ajax/authCourse.aspx')return route.fulfill({json:{ret:0,clist:[{cid:meta.cid,name:'匿名英语课'}]}});
  if(url.pathname==='/ajax/StudyStat.aspx')return route.fulfill({json:{ret:0,info:url.searchParams.get('action')==='courseunits'?[{unitname:'Unit 1'}]:badScan?[{id:'one'},{id:'one'}]:[{id:'one',name:'Listening',iscomplete:finished?'已完成':'未完成'}]}});
  if(url.pathname==='/student/course_info.aspx')return route.fulfill({contentType:'text/html',body:`<script>const identity={uid:${wrongIdentity?'9999':meta.uid},classid:${meta.classid}};</script>`});
  if(/StudyCourse\.aspx/.test(url.pathname)){
   const id=url.searchParams.get('sco');return route.fulfill({contentType:'text/html',body:`<li id="liSCO_${id}" class="courseware_current"></li><iframe id="contentFrame" src="/fixture-courseware?sco=${id}"></iframe>`});
  }
  if(url.pathname==='/fixture-courseware'&&url.searchParams.get('sco')==='partial'){
   const question=i=>`<div data-controltype="choice" data-id="partial-${i}">Question ${i}<ul data-itemtype="options"><li onclick="this.parentElement.querySelectorAll('li').forEach(e=>e.classList.remove('chosen'));this.classList.add('chosen')">甲</li><li onclick="this.parentElement.querySelectorAll('li').forEach(e=>e.classList.remove('chosen'));this.classList.add('chosen')">乙</li></ul></div>`;
   return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8">'+question(1)+question(2)+'<button onclick="finishFixture();document.body.innerHTML=\'保存中\'">Submit</button>'});
  }
  if(url.pathname==='/fixture-courseware')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div data-controltype="choice" data-id="fixture-choice">Choose an answer<ul data-itemtype="options"><li data-solution="never-read" onclick="this.parentElement.querySelectorAll('li').forEach(e=>e.classList.remove('chosen'));this.classList.add('chosen')">甲</li><li onclick="this.parentElement.querySelectorAll('li').forEach(e=>e.classList.remove('chosen'));this.classList.add('chosen')">乙</li></ul></div><button onclick="finishFixture();document.body.innerHTML='平台正在保存'">Submit</button>`});
  return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><p>fixture</p>'});
 });
 const home=await context.newPage();await home.goto('https://welearn.sflep.com/student/index.aspx');
 assert.deepEqual(await scanWelearnCourses(context),{courses:1,nodes:1});
 assert.equal(requests.some(r=>r.method!=='GET'||/SCO\.aspx|StudyCourse\.aspx/i.test(r.path)),false,'扫描不进入课件、不上报');
 const before=fs.readFileSync(path.join(process.env.KEBO_DATA_DIR,'data/platform-catalog.json'),'utf8');badScan=true;
 await assert.rejects(scanWelearnCourses(context),/重复/);badScan=false;
 assert.equal(fs.readFileSync(path.join(process.env.KEBO_DATA_DIR,'data/platform-catalog.json'),'utf8'),before,'异常保留旧清单');
 await assert.rejects(readWelearn(home,'/Ajax/SCO.aspx',{action:'savescoinfo'}),/只读/);
 const cl=buildChecklist(),task=cl.courses[0].tasks[0];assert.equal(task.platform,'welearn');assert.equal(task.welearn.scoid,'one');assert.equal(task.willHandle,true);
 const legacy=await context.newPage();await legacy.setContent('<et-choice id="legacy-q"><div><ul><li onclick="this.classList.add(\'chosen\')">选项甲</li><li>选项乙</li></ul></div></et-choice><et-blank id="legacy-fill">Fill: <span contenteditable="true" style="display:inline-block;min-width:80px;min-height:18px"></span><span class="key" hidden>NEVER SEND THIS SECRET</span></et-blank>');
 let q=await readPractice(legacy.mainFrame());assert.equal(q.length,2);assert.equal(q[0].options.length,2);assert.equal(q[1].supported,true);assert.equal(q.some(x=>x.text.includes('NEVER SEND')),false,'隐藏答案不进入题干');
 assert.equal((await fillPractice(legacy.mainFrame(),q[1],{textAnswer:'native draft'})).ok,true);
 const back=await readPractice(legacy.mainFrame());assert.equal(back[1].signature,q[1].signature,'填写后题面身份保持稳定');assert.equal(back[1].existing,true);
 assert.equal((await fillPractice(legacy.mainFrame(),back[1],{textAnswer:'do not overwrite'})).requiresManual,true);
 assert.equal((await fillPractice(legacy.mainFrame(),q[0],{letters:['A']})).ok,true,'旧版 chosen 状态回读');
 await legacy.setContent('<p>Complete this sentence: <et-blank id="one-blank"><span contenteditable="true" style="display:inline-block;min-width:80px;min-height:18px"></span></et-blank>.</p>');
 const blankDrafts={};let blankCalls=0;
 const blankOptions={saved:blankDrafts,ask:async()=>{blankCalls++;return {ok:true,parsed:{canFill:true,confidence:'medium',textAnswer:'draft'}};}};
 assert.equal((await assistPractice(legacy,legacy.mainFrame(),await readPractice(legacy.mainFrame()),blankOptions)).requiresReview,true,'填空只作草稿，需核对');
 assert.equal((await assistPractice(legacy,legacy.mainFrame(),await readPractice(legacy.mainFrame()),blankOptions)).ok,true);assert.equal(blankCalls,1,'同一草稿不重复请求');
 await legacy.locator('[contenteditable]').fill('manual change');
 assert.equal((await assistPractice(legacy,legacy.mainFrame(),await readPractice(legacy.mainFrame()),blankOptions)).ok,false,'保留人工更改');
 await legacy.locator('[contenteditable]').fill('');let identityChecks=0;
 await assert.rejects(assistPractice(legacy,legacy.mainFrame(),await readPractice(legacy.mainFrame()),{...blankOptions,saved:{},checkIdentity:async()=>{if(++identityChecks===2)throw Error('fixture 小节变化');}}),/小节变化/);
 assert.equal(await legacy.locator('[contenteditable]').textContent(),'','等待 AI 期间更换小节，未回填');
 await legacy.setContent('<div class="video-js"><audio style="display:none"></audio><button>Play</button></div>');
 // Page was setContent at a blank URL; give the fixture an allowed origin.
 await legacy.goto('https://welearn.sflep.com/fixture');await legacy.setContent('<div class="video-js"><audio style="display:none"></audio><button>Play</button></div>');
 assert.equal((await readNativeState(legacy))[0].media.length,1,'原生 audio 隐藏但可见自定义播放器仍可识别');await legacy.close();
 const ask=async()=>{askCount++;return {ok:true,parsed:{confidence:'high',letters:['B']}};};
 const options={ask,pollMs:10,statusEveryMs:10,maxMs:2000,settings:()=>({submitMode:'manual'})};
 const first=await runWelearnTask({task,context},options);assert.equal(first.phase,'needs-human');assert.equal(submits,0);assert.equal(askCount,1);assert.equal(loadState().taskPoints[task.key].status,'manual');
 const second=await runWelearnTask({task,context},{...options,settings:()=>({submitMode:'auto'})});
 assert.equal(second.phase,'done',JSON.stringify(second));assert.equal(submits,1);assert.equal(askCount,1,'恢复保存的同题答案，不重复问AI');assert.equal(loadState().taskPoints[task.key].status,'done');
 assert.equal((await runWelearnTask({task,context},options)).phase,'already-finished');assert.equal(submits,1,'平台已完成不重交');
 finished=false;submits=0;setTaskStatus(task.key,{status:'pending',submissionPending:true},{allowDowngrade:true});
 const uncertain=await runWelearnTask({task,context},options);assert.equal(uncertain.submissionPending,true);assert.equal(submits,0,'不确定的提交不能重发');
 wrongIdentity=true;await assert.rejects(runWelearnTask({task:{...task,key:task.key+'-wrong'},context},options),/账号或班级身份改变/);wrongIdentity=false;assert.equal(submits,0);
 let partialCalls=0,failedOnce=false;finished=false;
 const partial={...task,key:task.key+'-partial',welearn:{...task.welearn,scoid:'partial'}};
 const partialOptions={...options,settings:()=>({submitMode:'auto'}),readStatus:async()=>[{scoid:'partial',finished}],ask:async({question})=>{partialCalls++;if(question.questionId==='partial-2'&&!failedOnce){failedOnce=true;return {ok:false,error:'fixture AI 暂停'};}return {ok:true,parsed:{confidence:'high',letters:['B']}};}};
 assert.equal((await runWelearnTask({task:partial,context},partialOptions)).phase,'needs-human');assert.equal(partialCalls,2);assert.equal(submits,0);
 assert.equal((await runWelearnTask({task:partial,context},partialOptions)).phase,'done');assert.equal(partialCalls,3,'只重试未完成的第二题');assert.equal(submits,1);
 const native=await context.newPage();await native.goto(studyUrl(meta,'one'));await native.frameLocator('#contentFrame').locator('button').waitFor();
 await assertNativeLesson(native,meta,'one');
 await native.locator('.courseware_current').evaluate(e=>e.id='liSCO_different');
 await assert.rejects(assertNativeLesson(native,meta,'one'),/实际课件/,'网址正确但实际小节错误时拦截');await native.close();
 const ctrl=new PlatformRuns({execute:async({shouldStop})=>{await new Promise(r=>setTimeout(r,30));return shouldStop()?{phase:'stopped'}:{ok:true};}});
 ctrl.start('welearn',[{platform:'welearn',key:'w'}]);ctrl.start('zhihuishu',[{platform:'zhihuishu',key:'z'}]);ctrl.stop('welearn');await Promise.all([ctrl.wait('welearn'),ctrl.wait('zhihuishu')]);assert.equal(ctrl.snapshot().welearn.done,0);assert.equal(ctrl.snapshot().zhihuishu.done,1);
 assert.equal(requests.some(r=>r.method!=='GET'||r.path==='/Ajax/SCO.aspx'),false,'适配器不会合成学习进度或成绩请求');
 console.log('✓ WeLearn：只读扫描/异常保留、账号与任务隔离、旧版控件/隐藏媒体、草稿续跑/零重复AI、手动与自动提交、平台完成回查/不确定不重交、独立停止通过');
}finally{await browser.close();}
