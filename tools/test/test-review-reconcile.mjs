import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/review-reconcile-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {reconcileReviewResults,zhihuishuResultUrl,matchesLegacySubmittedQuestions}=await import('../../src/review-reconcile.mjs');const {mutateState,loadState,listReviewItems}=await import('../../src/state.mjs');const {reviewOperationBlock}=await import('../../src/review-policy.mjs');
const {reconcileOneReview}=await import('../../src/review-reconcile.mjs');
const {submitWork}=await import('../../src/chaoxing/quizrun.mjs');
const {submissionState,pageSubmissionState}=await import('../../src/chaoxing/submission-state.mjs');
assert.equal(reviewOperationBlock({taskKey:'zhihuishu:a'},{chaoxingRunning:true}),null);
assert.match(reviewOperationBlock({taskKey:'zhihuishu:a'},{zhihuishuRunning:true}),/智慧树/);
assert.match(reviewOperationBlock({all:true},{chaoxingRunning:true}),/学习通/);
assert.equal(reviewOperationBlock({taskKey:'cx-a'},{zhihuishuRunning:true}),null);
assert.equal(zhihuishuResultUrl('malformed'),null);assert.equal(zhihuishuResultUrl('zhihuishu:homework:a:b:c:d:e:%2F'),null);
const legacy={questionId:'q1',qtype:'single',options:[{letter:'A',text:'示例甲'},{letter:'B',text:'示例乙'}]};
assert.equal(matchesLegacySubmittedQuestions([legacy],[{...legacy,options:[{letter:'A',text:'示例乙'},{letter:'B',text:'示例甲'}]}]),true);
assert.equal(matchesLegacySubmittedQuestions([legacy],[{...legacy,questionId:'q2'}]),false);assert.equal(matchesLegacySubmittedQuestions([legacy],[legacy,legacy]),false);
const b=await chromium.launch({executablePath:findEdge(),headless:true});try{
 const context=await b.newContext();let submits=0;
 await context.exposeFunction('submitted',()=>submits++);
 await context.route('**/*',r=>{
  const url=new URL(r.request().url());let html='';
  if(url.hostname==='onlineexamh5new.zhihuishu.com'){
   html='<div class="examInfo first-info"><ul><li><label>得 分:</label><div>80</div></li></ul></div><div class="examInfo hasNotes"><ul><li><label>名称</label><span>匿名课程</span></li><li><label>对应章节</label><span id="chapter">第一章</span></li></ul></div><script>if(location.hash.includes("/wrong/"))document.querySelector("#chapter").textContent="第二章";if(location.hash.includes("/pending/"))document.body.innerHTML="尚未提交<button onclick=\\"submitted()\\">提交作业</button>";</script>';
  }else if(url.pathname.endsWith('/selectWorkQuestionYiPiYue'))html='<h2>本次成绩：100 分</h2><div class="TiMu"><p>保留题目和答案。得分：25</p></div>';
  else if(url.pathname.includes('/knowledge/cards'))html='<iframe src="https://mooc1.chaoxing.com/mooc-ans/work/selectWorkQuestion?workId=work-demo&workAnswerId=attempt-demo"></iframe>';
  else html='<p>提交成功，本次成绩 90 分</p>';
  return r.fulfill({contentType:'text/html; charset=utf-8',body:html});
 });
 mutateState(s=>{
  for(const id of ['graded','wrong','pending']){const key='zhihuishu:'+id;s.reviewQueue.push({id:key,taskKey:key,platform:'zhihuishu',status:'pending-review',aiAnswer:'保留正文'});s.quizzes[key]={task:{key,courseName:'匿名课程',secNo:'第一章'},paperKey:`zhihuishu:homework:recruit:${id}:exam:course:school:0`,total:1,answers:[]};s.taskPoints[key]={status:'manual'};}
  s.reviewQueue.push({id:'cx-q',taskKey:'cx',status:'pending-review',aiAnswer:'保留学习通草稿'});s.quizzes.cx={submitted:false,totalQuestions:5};s.taskPoints.cx={status:'done'};
  s.keptPages.cx={url:'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?num=1',info:{personId:'demo-user',workIdentity:{workid:'work-demo',workanswerid:'attempt-demo'},task:{courseId:'course',clazzId:'class',knowledgeId:'section',cardNum:1}}};
 });
 const result=await reconcileReviewResults(context,{personId:'demo-user',waitMs:500});assert.equal(result.synced,2,JSON.stringify(result));assert.equal(submits,0);assert.equal(context.pages().length,0,'独立核对页用完即关闭，不堆积网页');
 assert.equal(loadState().quizzes['zhihuishu:graded'].submitted,true);assert.equal(loadState().quizzes.cx.submitted,true);assert.equal(loadState().taskPoints.cx.status,'done');assert.equal(loadState().quizzes.cx.totalQuestions,5);
 assert.deepEqual(listReviewItems().map(i=>i.taskKey).sort(),['zhihuishu:pending','zhihuishu:wrong']);assert.equal(loadState().reviewQueue.find(i=>i.id==='cx-q').aiAnswer,'保留学习通草稿');
 const gradedPage=await context.newPage();
 await gradedPage.goto('https://mooc1.chaoxing.com/mooc-ans/work/selectWorkQuestionYiPiYue?workId=graded-work&workAnswerId=graded-attempt');
 const expected={workid:'graded-work',workanswerid:'graded-attempt'};
 assert.equal((await pageSubmissionState(gradedPage,gradedPage.mainFrame(),{expected})).submitted,true,'已批阅结果页即使保留题目也应确认提交');
 assert.equal((await submissionState(gradedPage.mainFrame())).score,'100','总成绩不能误取题目内的单题得分');
 assert.equal((await pageSubmissionState(gradedPage,gradedPage.mainFrame(),{expected:{...expected,workanswerid:'wrong-attempt'}})).submitted,false,'结果必须属于原作答');
 assert.equal((await submitWork(gradedPage.mainFrame(),{expected,verificationOnly:true,beforeSubmit:()=>assert.fail('已提交结果不得重交')})).alreadySubmitted,true);
 mutateState(s=>{s.reviewQueue.push({id:'graded-standalone#q1',taskKey:'graded-standalone',status:'filled',aiAnswer:'保留历史答案'});s.quizzes['graded-standalone']={submitted:false,totalQuestions:4};s.taskPoints['graded-standalone']={status:'manual'};s.keptPages['graded-standalone']={url:gradedPage.url(),info:{personId:'demo-user',workIdentity:expected,submissionPending:true,submissionVerificationOnly:true,task:{standalone:true}}};});
 const synced=await reconcileOneReview(context,'graded-standalone',{personId:'demo-user',waitMs:500});
 assert.equal(synced.state,'submitted');
 assert.equal(loadState().quizzes['graded-standalone'].submitted,true);
 assert.equal(loadState().taskPoints['graded-standalone'].status,'done');
 assert.equal(listReviewItems().some(i=>i.taskKey==='graded-standalone'),false);
 assert.equal(loadState().reviewQueue.find(i=>i.id==='graded-standalone#q1').aiAnswer,'保留历史答案');
 assert.equal(submits,0);
 await gradedPage.setContent('<div class="TiMu">本次成绩：100 分，已提交。这是题目内容。</div>');
 assert.equal((await submissionState(gradedPage.mainFrame())).submitted,false,'只有题内提交字样不能冒充结果');
 await gradedPage.setContent('<h2>本次成绩：100 分</h2><button class="btnSubmit">提交</button><div class="TiMu">示例题</div>');
 assert.equal((await submissionState(gradedPage.mainFrame())).submitted,false,'仍可提交的页面不能仅凭结果字样核销');
 const completedHeader='<div class="newTestTitle"><div class="TestTitle_name">章节测验</div><div class="fr testTit_status testTit_status_complete"><i></i>已完成</div></div>';
 await gradedPage.setContent(completedHeader+'<div class="TiMu">原题与我的答案保留，没有成绩。</div>');
 assert.equal((await submissionState(gradedPage.mainFrame())).submitted,true,'实际结果页仅显示已完成标题且保留原题时也应确认');
 assert.equal((await submissionState(gradedPage.mainFrame())).score,null,'无成绩不能推测分数');
 assert.equal((await pageSubmissionState(gradedPage,gradedPage.mainFrame(),{expected:{...expected,workanswerid:'wrong-attempt'}})).submitted,false,'已完成标题仍受原作答身份约束');
 let checkpoints=0;
 const completed=await submitWork(gradedPage.mainFrame(),{expected,verificationOnly:true,beforeSubmit:()=>checkpoints++});
 assert.equal(completed.alreadySubmitted,true);assert.equal(checkpoints,0,'无成绩已完成结果不能再次提交');
 mutateState(s=>{s.reviewQueue.push({id:'completed-header#q1',taskKey:'completed-header',status:'filled',aiAnswer:'保留已提交答案'});s.quizzes['completed-header']={submitted:false,totalQuestions:2};s.taskPoints['completed-header']={status:'manual'};s.keptPages['completed-header']={url:gradedPage.url(),info:{personId:'demo-user',workIdentity:expected,submissionPending:true,submissionVerificationOnly:true,task:{standalone:true}}};});
 assert.equal((await reconcileOneReview(context,'completed-header',{personId:'demo-user',waitMs:500})).state,'submitted');
 assert.equal(loadState().taskPoints['completed-header'].status,'done');
 assert.equal(loadState().quizzes['completed-header'].submitted,true);
 assert.equal(listReviewItems().some(i=>i.taskKey==='completed-header'),false,'核对已完成结果后从待审移除');
 assert.equal(loadState().reviewQueue.find(i=>i.id==='completed-header#q1').aiAnswer,'保留已提交答案','历史答案不删除');
 for(const html of [
  '<div class="TiMu">'+completedHeader+'</div>',
  '<div hidden>'+completedHeader+'</div>',
  '<p>已完成</p><div class="TiMu">只有普通文字</div>',
  completedHeader+'<button class="btnSubmit">提交</button><div class="TiMu">仍可提交</div>',
 ]){await gradedPage.setContent(html);assert.equal((await submissionState(gradedPage.mainFrame())).submitted,false,'题内、隐藏、普通文本或仍可提交均不得核销');}
 await gradedPage.goto('https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=graded-work&workAnswerId=graded-attempt');
 await gradedPage.setContent(completedHeader+'<div class="TiMu">编辑页，不能凭标题核销</div>');
 assert.equal((await submissionState(gradedPage.mainFrame())).submitted,false,'可编辑作业路由不能仅凭已完成标题核销');
 assert.equal(submits,0,'整轮结果回查不执行提交');
 console.log('✓ 两平台关闭页面后的只读核销、完整身份核对、未交/错章草稿保护、零提交及跨平台提交权限检查通过');
}finally{await b.close();}
