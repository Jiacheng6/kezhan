import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/platform-content-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const {dismissUcampusDialog,requireUcampusReady}=await import('../../src/platforms/ucampus/quiz.mjs');
const {ensurePlayer}=await import('../../src/platforms/ucampus/runner.mjs');
const {runUcampusTextQuiz}=await import('../../src/platforms/ucampus/textquiz.mjs');
const {isWelearnReadingTemplate,prepareWelearnLesson}=await import('../../src/platforms/welearn/preparation.mjs');
const {runWelearnSelectedTask}=await import('../../src/platforms/welearn/dispatch.mjs');
const {confirmedUcampusOutcome}=await import('../../src/platforms/ucampus/policy.mjs');
assert.equal(confirmedUcampusOutcome({ok:true,phase:'applied-unverified'}).ok,false);
assert.equal(confirmedUcampusOutcome({ok:true,phase:'submitted',credited:true,before:3,after:3}).ok,false);
assert.equal(confirmedUcampusOutcome({ok:true,phase:'submitted',credited:true,before:3,after:4}).ok,true);
assert.equal(confirmedUcampusOutcome({ok:true,phase:'completed',delta:'advanced',before:3,after:4}).ok,true);
assert.equal(confirmedUcampusOutcome({ok:true,phase:'already-finished'}).ok,true);
const reading='<et-item><et-sub-title></et-sub-title><et-preface><div class="main-title">Listening Skill</div><div class="main-content">Listen and anticipate what you will hear.</div></et-preface><et-my-words>words</et-my-words></et-item>';
assert.ok(isWelearnReadingTemplate(reading));
for(const html of ['', '<h1>Network error</h1>',reading.replace('</et-item>','<et-blank answer="hello"></et-blank></et-item>'),reading.replace('</et-item>','<et-recorder></et-recorder></et-item>'),reading.replace('</et-item>','<input data-solution="answer"></et-item>')])assert.equal(isWelearnReadingTemplate(html),false);
let nativeCalls=0;
assert.equal(await runWelearnSelectedTask({task:{name:'04. Listening Skill'}},{native:async()=>{nativeCalls++;return 'native';},protocol:async()=>({nativeContent:true})}),'native');
assert.equal(nativeCalls,1);
const unresolved={ok:false,phase:'needs-human'};
assert.equal(await runWelearnSelectedTask({task:{name:'04. Listening Skill'}},{native:async()=>{throw Error('must not fallback');},protocol:async()=>unresolved}),unresolved);
const session={baseUrl:'https://welearn.sflep.com',postForm:async()=>({status:200,text:JSON.stringify({ret:0,addr:'//centercourseware.sflep.com/demo/index.html#/1/4-1|Listening Skill'})}),get:async url=>({status:200,text:url.endsWith('main.js')?'resFolder:"data",templateUrl:e.file+".html"':url.endsWith('/data/1/4-1.html')?reading:'<div ui-view></div>'})};
const prepared=await prepareWelearnLesson(session,{cid:'one',scoid:'one',classid:'one'});assert.equal(prepared.contentOnly,true);assert.equal(prepared.questions.length,0);
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 const modal=(text,close=true)=>`<button onclick="window.backgroundClicks=(window.backgroundClicks||0)+1">确定</button><div role="dialog" class="ant-modal" style="position:fixed;inset:0;background:#fff;padding:100px">${text}<button onclick="window.dialogClicks=(window.dialogClicks||0)+1;${close?'this.parentElement.remove()':''}"><span>确 定</span></button></div>`;
 await page.setContent(modal('本单元学习时间：无限制；是否必修：必修'));
 assert.equal(await dismissUcampusDialog(page),'确定');assert.equal(await page.locator('[role=dialog]').count(),0);
 assert.equal(await page.evaluate(()=>window.backgroundClicks||0),0,'不能点击弹窗后的同名按钮');
 await page.setContent(modal('本单元学习时间：无限制',false));
 assert.equal(await dismissUcampusDialog(page),'dialog-still-open','不把仍显示的确定框当作已关闭');
 await assert.rejects(requireUcampusReady(page),/提示窗口尚未关闭/);
 for(const text of ['确认提交作业？','请完成验证码','我已阅读并同意隐私协议','是否必修：必修，请签署诚信承诺']){
  await page.setContent(modal(text));await page.evaluate(()=>window.dialogClicks=0);
  assert.equal(await dismissUcampusDialog(page),'dialog-needs-human');assert.equal(await page.evaluate(()=>window.dialogClicks),0);
 }
 await page.setContent('<p>1. Translate this sentence into Chinese.</p><textarea></textarea>');
 const answer='A complete translation should preserve the entire answer. '.repeat(5);
 const draft=await runUcampusTextQuiz({page,ask:async()=>({ok:true,answer})});assert.equal(draft.plan[0].text,answer.trim(),'翻译答案不能被日志展示长度截断');
 const unfilled=await runUcampusTextQuiz({page,apply:true,ask:async()=>({ok:false,error:'fixture failure'})});assert.equal(unfilled.ok,false,'apply 模式不允许把未完成作答标记成功');
 // Simulate the native cross-origin SSO hop. The first player URL is only
 // a transient shell and must not be returned as a ready player.
 let opened=0;
 await context.route('https://uai.unipus.cn/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<button onclick="window.open(\'https://ucontent.unipus.cn/pc.html#/instance\')">继续学习</button>'}));
 await context.route('https://ucontent.unipus.cn/**',r=>{opened++;return r.fulfill({contentType:'text/html',body:opened===1?'<script>location.replace("https://sso.unipus.cn/return")</script>':'<span class="pc-menu-node-name">Unit 1</span>'});});
 await context.route('https://sso.unipus.cn/**',r=>r.fulfill({contentType:'text/html',body:'<script>setTimeout(()=>location.replace("https://ucontent.unipus.cn/pc.html#/instance"),200)</script>'}));
 const player=await ensurePlayer(context,{instanceId:'instance',courseResourceId:'123',entryWaitMs:5000});
 assert.ok(player.url().startsWith('https://ucontent.unipus.cn/'));assert.equal(await player.locator('span.pc-menu-node-name').count(),1);
 assert.equal(await ensurePlayer(context,{instanceId:'instance',courseResourceId:'123'}),player);
 await context.route('https://uai.unipus.cn/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<button onclick="location.href=\'https://ucontent.unipus.cn/pc.html#/instance-same\'">继续学习</button>'}));
 const wrapped={pages:()=>context.pages(),newPage:async()=>new Proxy(await context.newPage(),{get(target,key){const v=target[key];return typeof v==='function'?v.bind(target):v;}})};
 const same=await ensurePlayer(wrapped,{instanceId:'instance-same',courseResourceId:'456',entryWaitMs:5000});
 assert.equal(same.isClosed(),false,'同页续学不能被误当成临时教程页关闭');assert.match(same.url(),/#\/instance-same$/);
 console.log('✓ U校园原生入口等待完整 SSO、信息窗真关闭、未知确认不点击、长翻译不截断；WeLearn 内容模板证据与原生分流');
}finally{await browser.close();}
