// Local site replicas only: no accounts, real videos, or submissions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});
process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/zhs-stability-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const {openZhihuishuStudy}=await import('../../src/platforms/zhihuishu/entry.mjs');
const {runZhihuishuVideo}=await import('../../src/platforms/zhihuishu/runner.mjs');
const {readZhihuishuPage}=await import('../../src/platforms/zhihuishu/read-page.mjs');
const {resumeZhihuishuVideo,handleZhihuishuVideoPrompt}=await import('../../src/platforms/zhihuishu/video.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
const task={platform:'zhihuishu',type:'video',key:'zhihuishu:fixture:term:video:1.1:t0',courseId:'zhihuishu:fixture:term',platformTaskKey:'zhihuishu:fixture:term:video:1.1',studyUrl:'https://studyvideoh5.zhihuishu.com/stuStudy',name:'示例视频'};
const identity='<a href="https://stuonline.zhihuishu.com/report?courseId=fixture&recruitId=term">成绩</a>';
const study=identity+'<li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">示例视频</span></li>';
try{
 for(const mode of ['sso','parent-login','real-login']){
  const context=await browser.newContext();let visits=0,courseClicks=0;
  await context.exposeBinding('courseClicked',()=>{courseClicks++});
  await context.route('https://**.zhihuishu.com/**',route=>{
   const host=new URL(route.request().url()).hostname;let body;
   if(host==='onlineweb.zhihuishu.com'){
    visits++;
    body=(mode==='real-login'||mode==='sso'&&visits===1)?'<script>location.href="https://login.zhihuishu.com/"</script>':`<div id="student-page"><div id="sharingClassed"><dl><div class="courseName" onclick="window.courseClicked();window.open('https://studyvideoh5.zhihuishu.com/stuStudy','_blank');${mode==='parent-login'?"setTimeout(()=>location.href='https://login.zhihuishu.com/',50)":''}">示例课程</div>${identity}</dl></div></div>`;
   }else if(host==='login.zhihuishu.com')body=mode==='sso'?'<script>setTimeout(()=>location.href="https://www.zhihuishu.com/",250)</script>':'<input type="password"><button>登录</button>';
   else if(host==='www.zhihuishu.com')body='<h1>网站首页</h1>';
   else body=study;
   return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  if(mode==='real-login'){
   const result=await runZhihuishuVideo({task,context},{openStudy:(c,t,o)=>openZhihuishuStudy(c,t,{...o,loginGraceMs:300,timeoutMs:4000})});
   assert.equal(result.phase,'needs-human','真实登录要求不能当作普通任务异常');
   assert.equal(result.ok,false);assert.equal(courseClicks,0);
   assert.equal(context.pages().length,1,'真实登录页保留给本人处理');
  }else{
   const opened=await openZhihuishuStudy(context,task,{loginGraceMs:1500,timeoutMs:8000});
   assert.equal((await readZhihuishuPage(opened.page)).pageKind,'study');assert.equal(courseClicks,1);
   assert.equal(visits,mode==='sso'?2:1,'SSO 首页回落只重入一次学堂');
  }
  await context.close();
 }
 const page=await browser.newPage();let body=study;
 await page.route('https://studyvideoh5.zhihuishu.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
 await page.goto(task.studyUrl);
 await page.locator('body').evaluate(e=>e.insertAdjacentHTML('beforeend','<div class="yidun_popup" style="position:fixed;inset:0">安全验证<div class="yidun_popup__mask" style="position:absolute;inset:0"></div></div>'));
 assert.deepEqual((await readZhihuishuPage(page)).blockers,['human-verification']);
 await page.locator('.yidun_popup').evaluate(e=>e.hidden=true);
 assert.deepEqual((await readZhihuishuPage(page)).blockers,[],'隐藏的旧验证遮罩不能误报');
 // At the last prompt, active row changes before the server completion marker.
 body=study+'<li class="video"><b class="hour">1.2</b></li><video></video><div id="vjs_container"><button class="videoArea" onclick="window.playClicks++">播放</button></div><div role="dialog" aria-label="弹题测验"><div class="el-dialog__header">弹题不会影响作业和考试的成绩</div><div class="radio"><div class="topic-title"><span class="title-tit">判断题</span>示例题</div><ul class="topic-list"><li class="topic-item" onclick="this.firstElementChild.classList.add(\'active\');document.querySelector(\'.answer\').hidden=false"><span class="topic-option-item">A.</span><span class="item-topic">正确</span></li></ul><div class="answer" hidden>已答</div></div><div class="el-dialog__footer"><div class="btn" onclick="this.closest(\'[role=dialog]\').hidden=true;const rows=document.querySelectorAll(\'li.video\');rows[0].classList.remove(\'current_play\');rows[1].classList.add(\'current_play\');setTimeout(()=>rows[0].insertAdjacentHTML(\'beforeend\',\'<i class=time_icofinish></i>\'),400)">关闭</div></div></div><script>window.playClicks=0</script>';
 await page.reload();let result=await handleZhihuishuVideoPrompt(page,{expectedKey:task.platformTaskKey});
 assert.equal(result.phase,'completed',JSON.stringify(result));assert.equal(result.ok,true);
 assert.equal(await page.evaluate(()=>window.playClicks),0,'完成后切到下一段，绝不能点击下一段的播放');
 await page.locator('.time_icofinish').evaluate(e=>e.remove());
 await assert.rejects(resumeZhihuishuVideo(page,{expectedKey:task.platformTaskKey,timeoutMs:200}),/与指定任务不一致/);
 assert.equal(await page.evaluate(()=>window.playClicks),0,'未完成时真正切错视频仍必须停止');
 // Exercise the whole task controller too: a final popup must finish the task,
 // persist completion, and never start the platform's automatically selected next.
 await page.reload();
 await page.locator('video').evaluate(v=>Object.defineProperties(v,{readyState:{get:()=>4},currentSrc:{get:()=>'https://fixture.invalid/video'},duration:{get:()=>3}}));
 result=await runZhihuishuVideo({task,context:page.context()},{openStudy:async()=>({page})});
 assert.equal(result.ok,true,'整条任务路径应接收平台完成标记');
 const {loadState}=await import('../../src/state.mjs');
 assert.equal(loadState().taskPoints[task.key].status,'done','本题完成必须持久化');
 assert.equal(page.isClosed(),true,'确认完成后只清理任务自己创建的页面');
 console.log('✓ 智慧树稳定性：SSO短暂登录/首页回落、父页登录不覆盖子页、真实登录待人工、可见验证码、弹题后自动切片和完成标记延迟、错任务不误播');
}finally{await browser.close();}
