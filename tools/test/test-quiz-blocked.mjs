// Real quiz runner, synthetic routed web pages. No real coursework or AI.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/quiz-blocked-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const {ensureDirs}=await import('../../src/config.mjs');ensureDirs();
const {mutateState,loadState}=await import('../../src/state.mjs');
const {runQuizTask,recordQuizResult}=await import('../../src/chaoxing/quizrun.mjs');
const {classifyTaskResult}=await import('../../src/batch.mjs');
const {resetThrottle}=await import('../../src/ai/throttle.mjs');
mutateState(s=>{s.settings={ai:{provider:'doubao',minIntervalMs:0,jitterMs:0},submitMode:'auto'};});
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
let gate='verification';
try{
 const ctx=await browser.newContext();
 await ctx.route('**/*',async route=>{
  const url=route.request().url();let body='';
  if(url.includes('doubao.com'))body=`<div class="tiptap" contenteditable="true" style="min-height:40px"></div>${gate==='login'?'<button>登录</button>':gate==='verification'?'<div role="dialog">请完成安全验证</div>':'<div role="alert">请求频繁，请稍后再试</div>'}`;
  else if(url.includes('/knowledge/cards'))body='<div class="ans-attach-ct"><span class="ans-job-icon" aria-label="任务点未完成"></span><iframe data=\'{"name":"演示作业","jobid":"fixture-job"}\' style="width:850px;height:700px" src="https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=fixture-work"></iframe></div>';
  else if(url.includes('/work/'))body=`<h1>演示作业</h1><style>.TiMu{width:620px;min-height:180px;padding:20px;background:white}</style>${[1,2].map(i=>`<div class="TiMu"><span class="newZy_TItle">【简答题】</span><div class="Zy_TItle"><p>演示题目 ${i}</p></div><textarea name="answerEditor${i}"></textarea></div>`).join('')}<button class="btnSubmit" onclick="window.submissions++">提交</button><script>window.submissions=0</script>`;
  await route.fulfill({contentType:'text/html; charset=utf-8',body});
 });
 const ai=await ctx.newPage();
 for(const [name,code]of[['verification','verification-required'],['login','not-logged-in'],['limit','rate-limited']]){
  resetThrottle(); // Independent scenarios must not inherit account cooldown.
  gate=name;await ai.goto('https://www.doubao.com/chat/');
  const task={key:`fixture-${name}`,name:'演示作业',type:'work',courseId:'fixture-course',clazzId:'fixture-class',knowledgeId:'fixture-section',secNo:'1.1'};
  const r=await runQuizTask({ctx,qianwenPage:ai,task,personId:'fixture'});recordQuizResult(r);
  assert.equal(r.phase,'blocked-verification');assert.equal(r.aiErrorCode,code);assert.equal(r.ok,false);assert.equal(classifyTaskResult(r),'blocked');
  assert.equal(r.items.length,2);assert.equal(r.queued,2);assert.equal(r.answered,0);assert.equal(r.submitted,false);
  assert.equal(r.workPage.isClosed(),false);assert.equal(await r.workPage.frames().find(f=>f.url().includes('/work/')).evaluate(()=>window.submissions),0);
  assert.ok(r.items.every(i=>i.status==='pending-review'&&!i.textAnswer&&!i.aiAnswer));
  assert.equal(loadState().taskPoints[task.key].status,'manual');
  assert.equal(loadState().reviewQueue.filter(i=>i.taskKey===task.key).length,2);
  if(name==='limit'){
   const {submitWork}=await import('../../src/chaoxing/quizrun.mjs');const frame=r.workPage.frames().find(f=>f.url().includes('/work/'));
   await frame.evaluate(()=>{document.body.innerHTML='<button class="btnSubmit" onclick="if(confirm(\'是否提交作业？\'))document.body.innerHTML=\'<p>提交成功，本次成绩 90 分</p>\'">提交</button>';});
   assert.equal((await submitWork(frame)).ok,true,'真实执行器原有弹窗监听不能抢先处理提交确认');
   console.log('✓ 另外验证：保留页面的原有监听与受控原生提交确认兼容（模拟作业）');
  }
  await r.workPage.close();console.log(`✓ ${name}：真实执行器首题阻塞、两题入待审、保留页面、零填写/提交、未记完成`);
 }
}finally{await browser.close();}
