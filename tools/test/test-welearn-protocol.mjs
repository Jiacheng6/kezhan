import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/welearn-protocol-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {runWelearnProtocolTask}=await import('../../src/platforms/welearn/protocol-runner.mjs');
const {createWelearnSession}=await import('../../src/platforms/welearn/session.mjs');const {parseSco}=await import('../../src/platforms/welearn/vendor/auto-welearn/core/parse/sco-parser.mjs');
const {loadState,setTaskStatus}=await import('../../src/state.mjs');
const {prepareWelearnLesson}=await import('../../src/platforms/welearn/preparation.mjs');
const {readWelearnCmi}=await import('../../src/platforms/welearn/cmi.mjs');
const legacy='<et-blank answer="hello"></et-blank><et-choice key="B"></et-choice>',modern='<div data-controltype="choice"><ul data-itemtype="options"><li>A</li><li data-solution="">B</li></ul></div>';
assert.equal(parseSco(legacy).questions.length,2);assert.equal(parseSco(modern).questions[0].answer,'B');
assert.equal((await readWelearnCmi({postForm:async()=>({text:'{"ret":0,"comment":""}'})},{},{alreadyStarted:true})).reason,'uninitialized','原生平台的成功空记录');
assert.equal((await readWelearnCmi({postForm:async()=>({text:'{"ret":0,"comment":"broken"}'})},{},{alreadyStarted:true})).reason,'unavailable','损坏的已有记录不能当成零');
const resources=[];
const dynamic={baseUrl:'https://welearn.sflep.com',postForm:async()=>({status:200,text:JSON.stringify({ret:0,addr:'//centercourseware.sflep.com/demo/index.html#/1/3-1|课内练习'})}),get:async url=>{resources.push(url);return {status:200,text:url.endsWith('main.js')?'resFolder:"data",templateUrl:e.file+".html"':url.includes('/data/1/3-1.html')?legacy:'<html ng-app="app"><div ui-view></div></html>'};}};
const dynamicParsed=await prepareWelearnLesson(dynamic,{cid:'2001',scoid:'one',classid:'3001'});assert.equal(dynamicParsed.questions.length,2);assert.equal(dynamicParsed.strategy,'legacy');assert.ok(resources.some(u=>u.endsWith('/data/1/3-1.html')),'SPA 外壳转到确切小节模板');
const task={key:'welearn:1001:2001:3001:one',platform:'welearn',welearn:{uid:'1001',cid:'2001',classid:'3001',scoid:'one',unitIndex:0}};
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const context=await browser.newContext();let finished=false,rejectFinal=false,loseAck=false,keepIncomplete=false,stop=false,template=legacy;const calls=[];
 await context.route('**/*',async route=>{const u=new URL(route.request().url());
  if(u.pathname==='/student/course_info.aspx')return route.fulfill({contentType:'text/html',body:'<script>const meta={uid:1001,classid:3001};</script>'});
  if(u.pathname==='/ajax/StudyStat.aspx')return route.fulfill({json:{ret:0,info:[{id:'one',iscomplete:finished?'已完成':'未完成'}]}});
  if(u.pathname==='/Ajax/SCO.aspx'){
   const form=Object.fromEntries(new URLSearchParams(route.request().postData()));calls.push(form);
   assert.equal(form.scoid,'one');assert.equal(form.cid,'2001');assert.ok(route.request().headers().referer.includes('StudyCourse.aspx'));
   if(form.action==='scoAddr')return route.fulfill({json:{ret:0,addr:'//centercourseware.sflep.com/demo/main.html|匿名练习'}});
   if(form.action==='getscoinfo_v7')return route.fulfill({json:{ret:-1,msg:'学习数据不正确'}});
   if(form.action==='setscoinfo'&&rejectFinal)return route.fulfill({json:{ret:1}});
   if(form.action==='setscoinfo'&&loseAck)return route.abort();
   if(form.action==='savescoinfo160928'&&!keepIncomplete)finished=true;
   return route.fulfill({json:{ret:0}});
  }
  return route.abort();
 });
 const opts={settings:()=>({submitMode:'auto',welearn:{waitSec:30}}),pollMs:5,confirmTimeoutMs:20,keepaliveDeps:{sleep:async()=>{}},sessionFactory:(p,t,o)=>createWelearnSession(p,t,{...o,readTemplate:async()=>({status:200,text:template})})};
 const manual=await runWelearnProtocolTask({task,context},{...opts,settings:()=>({submitMode:'manual'})});assert.equal(manual.phase,'needs-human');assert.equal(calls.some(c=>c.action!=='scoAddr'),false,'人工模式不写学习进度');
 calls.length=0;const done=await runWelearnProtocolTask({task,context},opts);assert.equal(done.phase,'done',JSON.stringify(done));assert.equal(done.questions,2);assert.equal(done.strategy,'legacy');
 const final=calls.find(c=>c.action==='setscoinfo');assert.ok(final.data.includes('[INTERACTIONINFO]'));assert.ok(final.data.includes('hello'));assert.equal(loadState().taskPoints[task.key].status,'done');
 assert.equal(calls.filter(c=>c.action==='savescoinfo160928').length,1);assert.equal(calls.some(c=>c.action.includes('ai')),false);
 const before=calls.length;assert.equal((await runWelearnProtocolTask({task,context},opts)).phase,'already-finished');assert.equal(calls.length,before);
 const reset=()=>{finished=false;calls.length=0;setTaskStatus(task.key,{status:'pending'},{allowDowngrade:true});};
 reset();loseAck=true;const ambiguous=await runWelearnProtocolTask({task,context},opts);assert.equal(ambiguous.ok,false);assert.equal(loadState().welearnProtocol[task.key].submissionPending,true);const written=calls.filter(c=>c.action==='setscoinfo').length;
 await runWelearnProtocolTask({task,context},opts);assert.equal(calls.filter(c=>c.action==='setscoinfo').length,written,'回执丢失不重交');loseAck=false;
 const empty={...task,key:task.key+'-empty'};template='<h1>Read</h1>';calls.length=0;assert.equal((await runWelearnProtocolTask({task:empty,context},opts)).ok,false);assert.deepEqual(calls.map(c=>c.action),['scoAddr'],'无答案不冒充完成');
 template=modern;calls.length=0;const stopped=await runWelearnProtocolTask({task:{...task,key:task.key+'-stop'},context,shouldStop:()=>stop},{...opts,keepaliveDeps:{sleep:async()=>{stop=true;throw Object.assign(Error('stop'),{code:'STOPPED'});}}});assert.equal(stopped.phase,'stopped');assert.equal(calls.some(c=>['setscoinfo','savescoinfo160928'].includes(c.action)),false,'停止不补交');stop=false;
 calls.length=0;keepIncomplete=true;const pending=await runWelearnProtocolTask({task:{...task,key:task.key+'-pending'},context},opts);assert.equal(pending.ok,false,'两个 ret:0 不等于完成');assert.equal(pending.submissionPending,true);
 const p=await context.newPage();await p.goto('https://welearn.sflep.com/student/course_info.aspx');const session=createWelearnSession(p,task);await assert.rejects(session.postForm('/Ajax/SCO.aspx',{action:'setscoinfo',cid:'other',scoid:'one'}),/超出/);await assert.rejects(session.get('https://example.com/private'),/不属于/);
 console.log('✓ Auto-WeLearn 原版双模板、接口格式、无需 AI、人工开关、平台完成回查、空模板拦截、停止、回执丢失防重交通过');
}finally{await browser.close();}
