import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/zhs-entry-'));const {findEdge}=await import('../../src/browser/launch.mjs');const {openZhihuishuTask,runZhihuishuQuiz,waitZhihuishuHomeworkEntry}=await import('../../src/platforms/zhihuishu/quiz-task.mjs');const {isSamePageUrl}=await import('../../src/browser/pages.mjs');const b=await chromium.launch({executablePath:findEdge(),headless:true});try{const c=await b.newContext();const paper='https://onlineexamh5new.zhihuishu.com/stuExamWeb.html?mode=paper#/webExamList/dohomework/t/w/p/c/s/0';await c.route('https://**.zhihuishu.com/**',r=>{const u=new URL(r.request().url());let body=u.hostname==='studyvideoh5.zhihuishu.com'?`<a href="https://stuonline.zhihuishu.com/report?courseId=c&recruitId=r">成绩</a><ul><li class="chapter"><b class="catalogue_title3">第一章</b><span class="catalogue_title">匿名章</span></li><li class="video"><b class="hour">1.1</b><span class="catalogue_title">匿名视频</span></li><li class="chapter-test" style="position:fixed;left:1900px;top:50px" onclick="window.open('https://onlineexamh5new.zhihuishu.com/stuExamWeb.html?mode=list','_blank')"><span class="name">平时测试</span></li></ul>`:u.searchParams.get('mode')==='list'?`<div class="examItemWrap"><b class="course_ewname">第一章单元测试</b><div onclick="window.open('${paper}','_blank')">继续答题</div></div>`:'<div class="examPaper_subject">匿名题</div>';return r.fulfill({contentType:'text/html; charset=utf-8',body});});const task={platform:'zhihuishu',type:'work',courseId:'zhihuishu:c:r',studyUrl:'https://studyvideoh5.zhihuishu.com/stuStudy',secNo:'第一章',platformTaskKey:'zhihuishu:c:r:test:'+encodeURIComponent('第一章')+':'+encodeURIComponent('平时测试')};const p=await openZhihuishuTask(c,task);assert.equal(p.url(),paper);assert.equal(isSamePageUrl(paper,paper.replace('/w/','/different/')),false);assert.equal(c.pages().length,1,'章节入口不应累积原生弹出页');console.log('PASS: 原生章测入口→作业列表→继续答题、严格章节匹配与跨试卷hash隔离');}finally{await b.close()}

// Real task opener + executor + queue against anonymous local website fixtures.
const {readZhihuishuGrade}=await import('../../src/platforms/zhihuishu/quiz-submit.mjs');
const {restoreZhihuishuReview}=await import('../../src/platforms/zhihuishu/quiz-task.mjs');
const {loadState,mutateState,listReviewItems}=await import('../../src/state.mjs');
const {PlatformRuns}=await import('../../src/platforms/runs.mjs');
const {canRestartTask}=await import('../../src/task-recovery.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const context=await browser.newContext();let mode='result',chapter='第一章';
 const resultUrl='https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/checkHomework/t/w/c/s/0';
 const loginUrl='https://studentexam-api.zhihuishu.com/studentExam/gateway/f/v1/gologin/login';
 const task={key:'graded-task',platform:'zhihuishu',type:'work',courseName:'匿名课程',courseId:'zhihuishu:c:r',studyUrl:'https://studyvideoh5.zhihuishu.com/stuStudy',secNo:'第一章',platformTaskKey:'zhihuishu:c:r:test:'+encodeURIComponent('第一章')+':'+encodeURIComponent('平时测试')};
 await context.route('https://**.zhihuishu.com/**',route=>{
  const u=new URL(route.request().url());let html='';
  if(u.hostname==='studyvideoh5.zhihuishu.com'){
   const destination=mode==='sso'?'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html?sso=1':mode==='list'?'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html?list=1':resultUrl;
   html=`<a href="https://stuonline.zhihuishu.com/report?courseId=c&recruitId=r">成绩</a><ul><li class="chapter"><b class="catalogue_title3">第一章</b></li><li class="video"><b class="hour">1.1</b></li><li class="chapter-test" onclick="window.open('${destination}')"><span class="name">平时测试</span></li></ul>`;
  }else if(u.hostname==='studentexam-api.zhihuishu.com')html=`<p>登录跳转中</p><script>setTimeout(()=>location.href=${JSON.stringify(resultUrl)},350)</script>`;
  else if(u.searchParams.has('sso'))html=`<script>location.replace(${JSON.stringify(loginUrl)})</script>`;
  else if(u.searchParams.has('list'))html=`<div class="examItemWrap"><b class="course_ewname">第一章单元测试</b><div onclick="window.open('${resultUrl}')">查看成绩</div></div>`;
  else html=`<div class="examInfo infoList first-info clearfix"><ul><li><label>得 分:</label><div><span>100</span></div></li></ul></div><div class="examInfo infoList hasNotes"><ul><li><label>名称</label><span>匿名课程</span></li><li><label>对应章节</label><span>${chapter}</span></li><li><label>总分数</label><span>100</span></li></ul></div>`;
  return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
 });
 for(const entryMode of ['result','list','sso']){mode=entryMode;const page=await openZhihuishuTask(context,task);assert.equal((await readZhihuishuGrade(page,{task})).score,100);await page.close();}
 mode='result';let next=0,asked=0;
 mutateState(s=>{s.reviewQueue.push({id:'old-review',taskKey:task.key,status:'pending-review'});});
 const queue=new PlatformRuns({restartDelayMs:0,execute:async({task:t,...args})=>t.key===task.key?runZhihuishuQuiz({task:t,...args},{ask:async()=>{asked++;throw Error('已提交不能再问 AI')}}):(next++,{ok:true})});
 queue.start('zhihuishu',[task,{key:'next-video',platform:'zhihuishu',type:'video'}],context);
 const finished=await queue.wait('zhihuishu');assert.equal(finished.phase,'completed');assert.equal(finished.done,2);assert.equal(finished.skipped,1);assert.equal(next,1);assert.equal(asked,0);
 assert.equal(loadState().taskPoints[task.key].status,'done');assert.equal(loadState().quizzes[task.key].submitted,true);assert.ok(!listReviewItems().some(i=>i.taskKey===task.key));
 assert.equal((await runZhihuishuQuiz({task,context})).phase,'submitted');assert.equal(loadState().taskPoints[task.key].status,'done','finally 不能把已提交改回 pending');
 const restoreTask={...task,key:'restore-submitted'};
 mutateState(s=>{s.quizzes[restoreTask.key]={task:restoreTask,paperKey:'saved-paper',answers:[{questionId:'saved-question'}],total:1};s.reviewQueue.push({id:'restore-review',taskKey:restoreTask.key,status:'pending-review'});});
 const restored=await restoreZhihuishuReview(context,restoreTask.key);assert.equal(restored.alreadySubmitted,true);assert.equal(loadState().taskPoints[restoreTask.key].status,'done');assert.equal(loadState().quizzes[restoreTask.key].submitted,true);assert.ok(!listReviewItems().some(i=>i.taskKey===restoreTask.key));await restored.page.close();
 chapter='第二章';await assert.rejects(openZhihuishuTask(context,task),e=>e.code==='TASK_IDENTITY_CHANGED');assert.equal(canRestartTask(task,{code:'TASK_IDENTITY_CHANGED',error:'不一致'}),false);
 const loginPage=await context.newPage();await loginPage.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<p>login</p>'}));await loginPage.goto(loginUrl);await assert.rejects(waitZhihuishuHomeworkEntry(loginPage,task,{timeoutMs:1000,loginGraceMs:100}),e=>e.code==='LOGIN_REQUIRED');
 const incomplete=await context.newPage();await incomplete.goto(resultUrl);await incomplete.locator('.first-info').evaluate(e=>e.remove());assert.equal(await readZhihuishuGrade(incomplete),null,'只有总分不能当作实得成绩');
 console.log('PASS: 已提交成绩直达/列表/短暂SSO、课程章节核对、完成持久化、清理待审、零AI零提交并继续下一任务、真实登录阻断');
}finally{await browser.close();}
