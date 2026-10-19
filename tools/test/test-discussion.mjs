// Synthetic intercepted pages only. Never accesses accounts or posts coursework.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
import {pathToFileURL} from 'node:url';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/discussion-test-'));
const moduleRoot=process.env.XXT_TEST_SOURCE_ROOT?pathToFileURL(path.resolve(process.env.XXT_TEST_SOURCE_ROOT)+path.sep):new URL('../../',import.meta.url);
const runtime=relative=>import(new URL(relative,moduleRoot).href);
const {ensureDirs,PATHS}=await runtime('src/config.mjs');ensureDirs();
const {findEdge}=await runtime('src/browser/launch.mjs');
const {runDiscussionTask,saveDiscussionDraft}=await runtime('src/chaoxing/discussion.mjs');
const {readDiscussionPage,readDiscussionPointStatus}=await runtime('src/chaoxing/discussion-page.mjs');
const {listReviewItems,loadState,mutateState}=await runtime('src/state.mjs');
const {reopenReviewWork,submitPendingReviews,syncSubmittedReviews}=await runtime('src/chaoxing/review-recovery.mjs');
const {getKeptPage,listKeptPages}=await runtime('src/chaoxing/quizrun.mjs');
const {startServer}=await runtime('src/server.mjs');
const {EXTRACT_ATTACH,reconToTaskReport}=await runtime('src/chaoxing/recon.mjs');
const {buildChecklist}=await runtime('src/chaoxing/checklist.mjs');
const {taskCompletion}=await runtime('src/ui/task-status.js');
mutateState(s=>{s.settings={discussionDrafts:true,ai:{provider:'api',minIntervalMs:0,jitterMs:0}};});
const modes=new Map(),calls=[];let aiCalls=0;
const repeated='这个结论体现了数列无限趋近某个确定值的性质，有限步骤和极限过程需要区分。';
const comments=[{uuid:'c1',createrPuid:'p1',text:'先从定义出发分析这个问题，注意概念的适用条件。'},{uuid:'c2',createrPuid:'p2',text:repeated},{uuid:'c3',createrPuid:'p3',text:repeated},{uuid:'c4',createrPuid:'p4',text:repeated.replace('体现了','体现')}];
const browser=await chromium.launch({executablePath:findEdge(),headless:true});const ctx=await browser.newContext();
let service;
ctx.on('page',p=>p.setDefaultTimeout(5000));
await ctx.route('https://**.chaoxing.com/**',async route=>{
 const u=new URL(route.request().url());
 if(u.pathname.includes('/knowledge/cards')){const id=u.searchParams.get('knowledgeid'),tracked=modes.get(id)==='tracked',finished=calls.some(c=>c.id===id);return route.fulfill({contentType:'text/html',body:`${tracked?`<div class="ans-attach-ct ${finished?'ans-job-finished':''}"><i class="ans-job-icon" aria-label="任务点未完成"></i><iframe src="/ananas/modules/insertbbs/index.html" data='{"mid":"${id}","title":"示例讨论","jobid":"job-${id}","isJob":true}'></iframe></div><div class="ans-attach-ct ans-job-finished"><iframe data='{"title":"相邻测验"}'></iframe></div>`:''}<iframe src="/mooc-ans/bbscircle/chapter?mtopicid=${id}"></iframe>`});}
 if(u.pathname==='/mooc-ans/bbscircle/chapter'){const id=u.searchParams.get('mtopicid');return route.fulfill({contentType:'text/html',body:`<div id="topicMainDiv" data="https://groupweb.chaoxing.com/course/topic/v3/bbs/demo/${id}/replysList?courseId=course&amp;classId=class">示例讨论</div>`});}
 if(u.pathname.endsWith('/addReplys')){
  const id=u.pathname.split('/')[3],body=JSON.parse(route.request().postData());calls.push({id,text:body.topic_content,pendingSaved:loadState().keptPages[id]?.info?.submissionPending===true});
  if(modes.get(id)==='moderation')return route.fulfill({json:{status:true,msg:'回复待审核',datas:null}});
  return route.fulfill({json:{status:true,msg:'回复成功',datas:{reply:{uuid:'posted-'+id,createrPuid:'self',text:body.topic_content}}}});
 }
 if(u.pathname.includes('/replysList')){
  const id=u.pathname.split('/')[6],mode=modes.get(id);
  const all=mode==='empty'?[]:mode==='own'?[{uuid:'own',createrPuid:'self',text:'本人已经回复过此话题'}]:comments;
  return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div id="bbsTopicDetail"><h1>示例讨论</h1><div class="replyContent">请结合数列极限解释该现象。</div><em class="classReplyCount">共<span>${all.length}</span>条回复</em><div class="topicDetail_replyList"></div><p class="loadText">点击加载更多</p><div class="topicDetail_editContainer"><textarea></textarea><button class="addReply">回复</button></div></div><script>
window.obj={user:{puid:'self'},topic:{title:'示例讨论',uuid:${JSON.stringify(id)}}};window.Topic_Detail=window.obj;
window.Topic_Invitation={replyList:[],poff:{lastPage:${all.length<3?1:0}}};
const all=${JSON.stringify(all)};function add(records,cache=true){for(const r of records){if(cache)Topic_Invitation.replyList.push(r);const e=document.createElement('div');e.className='topicDetail_replyItem';e.id=r.uuid;const right=document.createElement('div');right.className='topicReply_right';const c=document.createElement('div');c.className='replyContent';c.textContent=r.text;right.append(c);e.append(right);document.querySelector('.topicDetail_replyList').append(e);}}
${mode==='delayed'?"document.querySelector('.loadText').hidden=true;document.querySelector('.classReplyCount span').textContent='';setTimeout(()=>{add(all.slice(0,2));document.querySelector('.classReplyCount span').textContent=all.length;document.querySelector('.loadText').hidden=false;},350);":"add(all.slice(0,2));if(all.length<3)document.querySelector('.loadText').hidden=true;"}
document.querySelector('.loadText').onclick=()=>{add(all.slice(2));Topic_Invitation.poff.lastPage=1;document.querySelector('.loadText').hidden=true;};
document.querySelector('.addReply').onclick=async()=>{const result=await fetch('/pc/invitation/'+${JSON.stringify(id)}+'/addReplys',{method:'POST',body:JSON.stringify({topic_content:document.querySelector('textarea').value})}).then(r=>r.json());if(result.status&&result.datas)add([result.datas.reply],${mode!=='dom-only'});};
</script>`});
 }
 return route.abort();
});
const task=id=>({key:id,type:'discuss',name:'示例讨论',courseName:'示例课程',courseId:'course',clazzId:'class',knowledgeId:id,discussionId:id,cardNum:1,tracking:false,secNo:'1.1',sectionName:'示例小节'});
const askAI=async()=>{aiCalls++;return {ok:true,answer:'无限过程的极限可以是有限的，应将每一步的结果与整体极限区分。'};};
try{
 let result=await runDiscussionTask({ctx,task:task('popular'),personId:'learner'},{askAI});
 assert.equal(result.phase,'awaiting-review');assert.equal(aiCalls,0);assert.equal(calls.length,0);
 let item=listReviewItems()[0];assert.equal(item.qtype,'discussion');assert.equal(item.discussion.matches,3);assert.equal(item.discussion.complete,true);assert.equal(item.textAnswer,repeated);assert.equal(item.filled,null);
 assert.equal(loadState().taskPoints.popular.status,'manual');
 modes.set('delayed','delayed');result=await runDiscussionTask({ctx,task:task('delayed'),personId:'learner'},{askAI});
 assert.equal(result.phase,'awaiting-review');assert.equal(aiCalls,0,'评论仍在加载时不能误判为无评论而请求AI');
 result=await submitPendingReviews(ctx,{all:true},{personId:'learner'});assert.equal(result.submitted,0);assert.equal(calls.length,0,'批量提交不能发布讨论');
 saveDiscussionDraft(item.id,'人工核对后的简短讨论回答。');await getKeptPage('popular').page.close();
 result=await reopenReviewWork(ctx,'popular',{personId:'learner'});assert.equal(result.restored,1);assert.equal((await readDiscussionPage(result.page)).editorText,'人工核对后的简短讨论回答。');assert.equal(calls.length,0);
 result=await submitPendingReviews(ctx,{taskKey:'popular'},{personId:'learner'});assert.equal(result.submitted,1,JSON.stringify(result));assert.equal(calls.length,1);assert.equal(calls[0].text,'人工核对后的简短讨论回答。');assert.equal(calls[0].pendingSaved,true,'发出请求前须持久化未知状态，崩溃后不能盲目重发');assert.equal(loadState().taskPoints.popular.status,'done');

 modes.set('empty','empty');result=await runDiscussionTask({ctx,task:task('empty'),personId:'learner'},{askAI});assert.equal(result.phase,'awaiting-review');assert.equal(aiCalls,1);assert.equal(listReviewItems().find(i=>i.taskKey==='empty').discussion.source,'ai');assert.equal(calls.length,1);
 result=await runDiscussionTask({ctx,task:task('empty'),personId:'learner'},{askAI});assert.equal(aiCalls,1,'已有待审讨论不能重复生成或覆盖');
 modes.set('already','own');result=await runDiscussionTask({ctx,task:task('already'),personId:'learner'},{askAI});assert.equal(result.phase,'already-finished');assert.equal(calls.length,1);

 modes.set('moderation','moderation');await runDiscussionTask({ctx,task:task('moderation'),personId:'learner'},{askAI});
 result=await submitPendingReviews(ctx,{taskKey:'moderation'},{personId:'learner'});assert.equal(result.failed,1);assert.equal(calls.length,2);assert.equal(loadState().keptPages.moderation.info.submissionPending,true);
 result=await submitPendingReviews(ctx,{taskKey:'moderation'},{personId:'learner'});assert.equal(result.failed,1);assert.equal(calls.length,2,'未知结果或平台审核中不能重发');

 const page=await ctx.newPage();await page.setContent('<div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon" aria-label="已完成"></i><iframe src="/ananas/modules/insertbbs/index.html" data=\'{"mid":"fixture-topic","title":"示例讨论","isJob":false}\'></iframe></div>');
 const attachments=await page.evaluate(EXTRACT_ATTACH);assert.equal(attachments[0].type,'discuss');assert.equal(attachments[0].discussionId,'fixture-topic');
 assert.equal(attachments[0].finished,false,'非任务点附件默认的完成图标不能当作本人已参与讨论');
 const report=reconToTaskReport([{name:'示例课程',courseId:'course',clazzId:'class',sections:[{knowledgeId:'section',secNo:'1',name:'章节',done:true,taskPoints:attachments}]}]);
 assert.equal(report.courses[0].taskPoints.length,1,'非任务点讨论也应可选择生成草稿');
 fs.mkdirSync(path.dirname(PATHS.taskReport),{recursive:true});fs.writeFileSync(PATHS.taskReport,JSON.stringify(report));
 const checklist=buildChecklist();assert.equal(checklist.courses[0].tasks[0].willHandle,true);assert.equal(checklist.courses[0].tasks[0].completion.finished,false,'章节已完成不能证明已参与非任务点讨论');
 assert.equal(taskCompletion({type:'discuss',finished:false,sectionDone:true}).finished,false);
 const withLegacy=reconToTaskReport([{name:'示例课程',courseId:'legacy-course',clazzId:'class',sections:[{knowledgeId:'legacy-section',name:'章节',taskPoints:[{type:'video',jobid:'v',idx:0,name:'video'},...attachments.map(a=>({...a,idx:1})),{type:'work',jobid:'w',idx:2,name:'测试'}]}]}]);
 fs.writeFileSync(PATHS.taskReport,JSON.stringify({...withLegacy,at:new Date(Date.now()+1000).toISOString()}));
 const legacy=buildChecklist().courses[0].tasks;
 assert.equal(legacy.find(t=>t.type==='video').key,'legacy-course:legacy-section:t0');
 assert.equal(legacy.find(t=>t.type==='work').key,'legacy-course:legacy-section:t1','新增普通讨论不改变旧测验的持久化 key');
 modes.set('native-append','dom-only');await runDiscussionTask({ctx,task:task('native-append'),personId:'learner'},{askAI});
 result=await submitPendingReviews(ctx,{taskKey:'native-append'},{personId:'learner'});assert.equal(result.submitted,1,JSON.stringify(result));
 assert.equal((await readDiscussionPage(getKeptPage('native-append')?.page||ctx.pages().find(p=>p.url().includes('/native-append/')))).comments.find(c=>c.id==='posted-native-append').authorId,'','原站追加回复不更新作者缓存，须结合成功回执核对');
 modes.set('tracked','tracked');const trackedTask={...task('tracked'),tracking:true,jobid:'job-tracked'};
 await runDiscussionTask({ctx,task:trackedTask,personId:'learner'},{askAI});
 const pointPage=await ctx.newPage();await pointPage.goto('https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=tracked');
 assert.equal((await readDiscussionPointStatus(pointPage,trackedTask)).finished,false,'相邻测验完成不能替代讨论完成');
 assert.equal((await readDiscussionPointStatus(pointPage,{...trackedTask,discussionId:'other'})).finished,null);
 result=await submitPendingReviews(ctx,{taskKey:'tracked'},{personId:'learner'});assert.equal(result.submitted,1,JSON.stringify(result));assert.equal(loadState().taskPoints.tracked.status,'done','讨论title字段与过期aria不能妨碍完成标记核对');
 modes.set('tracked-sync','tracked');await runDiscussionTask({ctx,task:{...task('tracked-sync'),tracking:true,jobid:'job-tracked-sync'},personId:'learner'},{askAI});
 calls.push({id:'tracked-sync',text:'手动发表的已核对回复'});
 await getKeptPage('tracked-sync').page.evaluate(()=>{Topic_Invitation.replyList.push({uuid:'manual-own',createrPuid:'self'});const e=document.createElement('div');e.id='manual-own';e.className='topicDetail_replyItem';e.innerHTML='<div class="topicReply_right"><div class="replyContent">手动发表的已核对回复</div></div>';document.querySelector('.topicDetail_replyList').append(e);});
 await syncSubmittedReviews();assert.equal(loadState().taskPoints['tracked-sync'].status,'done','手动发表同步也须核对任务点');
 mutateState(s=>{s.reviewQueue=[];s.keptPages={};s.onboarding={version:2,completedAt:new Date().toISOString()};});
 await runDiscussionTask({ctx,task:task('ui-demo'),personId:'learner'},{askAI});
 service=await startServer({listKeptPages,openReview:async({taskKey})=>{const {page,...result}=await reopenReviewWork(ctx,taskKey,{personId:'learner'});return result;},editReviewAnswer:body=>saveDiscussionDraft(body.id,body.textAnswer),submitReviews:scope=>submitPendingReviews(ctx,scope,{personId:'learner'})});
 await ctx.addInitScript(()=>localStorage.setItem('xxt-library-startup','skip'));
 const ui=await ctx.newPage();await ui.goto(service.url);await ui.locator('[data-tab="review"]').click();
 await ui.getByText('讨论题目',{exact:true}).waitFor();await ui.getByText('草稿来源',{exact:true}).waitFor();
 const beforeUI=calls.length;
 await ui.getByRole('button',{name:'打开并核对',exact:true}).click();await ui.locator('.review-feedback').filter({hasText:'讨论草稿已填入网页'}).waitFor();assert.equal(calls.length,beforeUI);
 await ui.locator('.qedit textarea').fill('通过界面人工核对并修改后的讨论内容。');await ui.getByRole('button',{name:'保存讨论草稿',exact:true}).click();
 await ui.getByText('待发布草稿',{exact:true}).waitFor();assert.equal(listReviewItems()[0].textAnswer,'通过界面人工核对并修改后的讨论内容。');assert.equal(calls.length,beforeUI);
 await ui.getByRole('button',{name:'确认发布讨论',exact:true}).click();await ui.locator('#reviewBody .placeholder').waitFor();assert.equal(calls.length,beforeUI+1);assert.equal(calls.at(-1).text,'通过界面人工核对并修改后的讨论内容。');
 console.log('✓ 讨论链路：卡片识别、分页后重复原文优先、无重复才问AI、待审编辑、关闭恢复、逐条确认发布、本人已参与去重、审核未知不重发、批量不发布与完成状态隔离通过');
}finally{await ctx.close();await browser.close();if(service){for(const client of service.wss.clients)client.terminate();await new Promise(r=>service.wss.close(r));service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}}
