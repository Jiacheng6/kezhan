import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/zhs-entry-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {runZhihuishuVideo}=await import('../../src/platforms/zhihuishu/runner.mjs');const {loadState}=await import('../../src/state.mjs');
const task={platform:'zhihuishu',type:'video',key:'zhihuishu:demo:term:video:1.1:t0',courseId:'zhihuishu:demo:term',platformTaskKey:'zhihuishu:demo:term:video:1.1',studyUrl:'https://studyvideoh5.zhihuishu.com/stuStudy?stale=1',name:'演示视频'};
const b=await chromium.launch({executablePath:findEdge(),headless:true});let clicks=0,mode='complete';
try{
 const ctx=await b.newContext();await ctx.addInitScript(()=>{Object.defineProperties(HTMLMediaElement.prototype,{readyState:{get:()=>4},currentSrc:{get:()=>'https://fixture.invalid/video'}})});await ctx.exposeBinding('entryClicked',()=>{clicks++});
 await ctx.route('https://**.zhihuishu.com/**',route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='onlineweb.zhihuishu.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="student-page"><div id="sharingClassed"><dl><div class="courseName" onclick="window.entryClicked();window.open('https://studyvideoh5.zhihuishu.com/stuStudy?fresh=1','_blank')">演示课程</div><a href="https://stuonline.zhihuishu.com/report?courseId=demo&recruitId=term">成绩</a></dl></div></div>`});
  assert.equal(u.searchParams.has('stale'),false,'视频执行不得直开扫描旧地址');assert.match(route.request().headers().referer||'',/onlineweb\.zhihuishu\.com/,'必须通过真实门户点击形成来源');
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="https://stuonline.zhihuishu.com/report?courseId=demo&recruitId=term">成绩</a><li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">演示视频</span></li><video></video><div id="vjs_container"><button class="videoArea" onclick="window.playing=true">播放</button></div><script>window.t=0;window.playing=false;const v=document.querySelector('video');v.pause=()=>window.playing=false;Object.defineProperties(v,{currentTime:{get:()=>window.t},duration:{get:()=>3},paused:{get:()=>!window.playing},ended:{get:()=>false}});setInterval(()=>{if(window.playing)window.t+=.2;if(window.t>=1&&'${mode}'==='complete'&&!document.querySelector('.time_icofinish'))document.querySelector('li.video').insertAdjacentHTML('beforeend','<i class="time_icofinish"></i>')},100)</script>`});
 });
 let result=await runZhihuishuVideo({task,context:ctx});assert.equal(result.ok,true);assert.equal(loadState().taskPoints[task.key].status,'done');assert.equal(clicks,1);assert.equal(ctx.pages().length,0,'已完成时清理自建入口和任务页');
 mode='stop';let stop=false;result=await runZhihuishuVideo({task:{...task,key:task.key+'-stop'},context:ctx,shouldStop:()=>stop,onProgress:()=>{stop=true}});assert.equal(result.phase,'stopped');assert.equal(ctx.pages().length,1);assert.equal(await ctx.pages()[0].evaluate(()=>window.playing),false);assert.equal(loadState().taskPoints[task.key+'-stop'].status,'pending');
 console.log('✓ 智慧树原生学堂入口：真实课程点击和新窗口、自然 referrer、未访问旧地址、完成回读、停止暂停及自建页面清理');
}finally{await b.close();}
