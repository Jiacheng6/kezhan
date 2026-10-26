import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/review-reconcile-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {reconcileReviewResults,zhihuishuResultUrl,matchesLegacySubmittedQuestions}=await import('../../src/review-reconcile.mjs');const {mutateState,loadState,listReviewItems}=await import('../../src/state.mjs');const {reviewOperationBlock}=await import('../../src/review-policy.mjs');
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
  }else if(url.pathname.includes('/knowledge/cards'))html='<iframe src="https://mooc1.chaoxing.com/mooc-ans/work/selectWorkQuestion?workId=work-demo&workAnswerId=attempt-demo"></iframe>';
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
 console.log('✓ 两平台关闭页面后的只读核销、完整身份核对、未交/错章草稿保护、零提交及跨平台提交权限检查通过');
}finally{await b.close();}
