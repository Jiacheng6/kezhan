// All course/work pages below are intercepted local fixtures. No real account,
// AI request, assignment, or platform submission is used by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});
const data=fs.mkdtempSync(path.resolve('.desktop-test/review-browser-'));
process.env.XXT_DATA_DIR=data;
const moduleRoot=process.env.XXT_TEST_SOURCE_ROOT?pathToFileURL(path.resolve(process.env.XXT_TEST_SOURCE_ROOT)+path.sep):new URL('../../',import.meta.url);
const runtime=relative=>import(new URL(relative,moduleRoot).href);
const {ensureDirs}=await runtime('src/config.mjs');ensureDirs();
const {findEdge}=await runtime('src/browser/launch.mjs');
const {startServer}=await runtime('src/server.mjs');
const {mutateState,loadState,listReviewItems,updateReviewAnswer}=await runtime('src/state.mjs');
const {getKeptPage,listKeptPages,editKeptEssayReviewAnswer}=await runtime('src/chaoxing/quizrun.mjs');
const {reopenReviewWork,submitPendingReviews,withReviewLock,syncSubmittedReviews}=await runtime('src/chaoxing/review-recovery.mjs');
const {cardsUrl}=await runtime('src/chaoxing/section.mjs');
const {readSelection,findWorkFrame}=await runtime('src/chaoxing/quiz.mjs');
const {readEssayAnswer}=await runtime('src/chaoxing/essay.mjs');
const personId='fixture-student',draft='示例简答第一段。\n示例简答第二段。';
const options=[{letter:'A',text:'示例选项甲'},{letter:'B',text:'示例选项乙'}];
const variants=new Map(),confirmed=[];
function seed(key,{mode='normal',missing=false,edited=false,append=false,pending=false}={}){
  variants.set(key,mode);
  const task={courseId:'fixture-course',clazzId:'fixture-class',knowledgeId:key,cardNum:1,type:'work',name:'章节测验'};
  const items=[
    {id:key+'#q1',taskKey:key,questionId:'choice-demo',questionIndex:1,domIndex:0,qtype:'single',qtypeRaw:'单选题',options,letters:edited?['B']:['A'],editedByHuman:edited,autoFilled:!edited,status:'filled'},
    {id:key+'#q2',taskKey:key,questionId:'essay-demo',questionIndex:2,domIndex:1,qtype:'essay',qtypeRaw:'简答题',options:[],textAnswer:draft,requiresReview:true,autoFilled:!missing,status:missing?'pending-review':'filled'},
  ].map(item=>({...item,courseId:task.courseId,clazzId:task.clazzId,knowledgeId:key,course:'示例课程',secNo:'1.2',sectionName:'示例小节'}));
  if(mode==='legacy-essay'){items[1].questionId='1';items[1].archive={stemTextRaw:'示例简答题干'};}
  mutateState(state=>{
    state.onboarding={version:2,completedAt:new Date().toISOString()};
    state.reviewQueue=append?[...state.reviewQueue,...items]:items;
    state.taskPoints[key]={status:'manual'};
    state.quizzes[key]={phase:'awaiting-review',submitted:false};
    state.keptPages[key]={savedAt:Date.now(),url:cardsUrl({...task,personId}),info:{task,personId,totalQuestions:2,submissionPending:pending,workIdentity:{workid:key,workanswerid:'answer-'+key}}};
  });
  return items;
}
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
const context=await browser.newContext({viewport:{width:1280,height:960}});
await context.addInitScript(()=>localStorage.setItem('xxt-library-startup','skip'));
await context.exposeBinding('fixtureSubmitted',(_,value)=>confirmed.push(value));
context.on('page',page=>{const wait=page.waitForTimeout.bind(page);page.waitForTimeout=ms=>wait(Math.min(ms,10));});
await context.route('https://mooc1.chaoxing.com/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.includes('/knowledge/cards')){
    const key=url.searchParams.get('knowledgeid'),mode=variants.get(key);
    const answer=mode==='different-attempt'?'new-attempt':'answer-'+key;
    return route.fulfill({contentType:'text/html',body:`<iframe src="/mooc-ans/work/doHomeWorkNew?workId=${key}&workAnswerId=${answer}"></iframe>`});
  }
  if(url.pathname.includes('/work/doHomeWorkNew')){
    const key=url.searchParams.get('workId'),mode=variants.get(key);
    if(mode==='completed')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><p>已提交，本次成绩 90 分</p>'});
    return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8">
<div class="TiMu" data="essay-demo"><div class="TiMuHead"><span class="newZy_TItle">【简答题】</span></div><div class="Zy_TItle"><p>示例简答题干</p></div><textarea name="answerEditor-${mode==='legacy-essay'?'0':'essay-demo'}"></textarea></div>
<div class="TiMu"><span class="newZy_TItle">【单选题】</span><div class="Zy_TItle"><p>示例选择题干</p></div><ul class="Zy_ulTop">${options.map(option=>`<li role="radio" qid="${mode==='changed'?'changed-question':'choice-demo'}"><span class="num_option ${mode==='prefilled'&&option.letter==='A'?'check_answer':''}" data="${option.letter}">${option.letter}</span><a class="after"><p>${option.text}</p></a></li>`).join('')}</ul></div>
${mode==='pending'?'<p>我的答案：已完成。本次成绩 100 分（这是题目示例，仍未提交）。</p>':''}
<button class="btnSubmit" ${mode==='readonly'?'disabled':''} onclick="document.querySelector('#popok').hidden=false">提交</button><button id="popok" hidden>确认提交</button>
<script>document.querySelectorAll('li[qid]').forEach(li=>li.onclick=()=>{li.parentElement.querySelectorAll('span[data]').forEach(span=>span.classList.remove('check_answer'));li.querySelector('span').classList.add('check_answer');});
document.querySelector('#popok').onclick=()=>{window.fixtureSubmitted({key:${JSON.stringify(key)},choice:[...document.querySelectorAll('.check_answer')].map(span=>span.getAttribute('data')),essay:document.querySelector('textarea').value});${mode==='pending'?"document.querySelector('#popok').hidden=true;":"document.body.innerHTML='<p>提交成功，本次成绩 90 分</p>';"}};</script>`});
  }
  return route.abort();
});
const service=await startServer({
  retryReview:async req=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);return {started:true,count:1,taskKey:body.taskKey};},
  listKeptPages,
  openReview:async({taskKey})=>withReviewLock(taskKey,async()=>{const {page,...result}=await reopenReviewWork(context,taskKey,{personId,waitMs:150});return result;}),
  submitReviews:scope=>submitPendingReviews(context,scope,{personId,waitMs:150}),
  editReviewAnswer:body=>{
    const item=listReviewItems().find(item=>item.id===body.id);
    if(item.qtype!=='essay')return updateReviewAnswer(body.id,body.letters);
    return withReviewLock(item.taskKey,()=>editKeptEssayReviewAnswer(body.id,body.textAnswer,{ensurePage:key=>reopenReviewWork(context,key,{personId,waitMs:150,restoreAnswers:false})}));
  },
});
const post=(route,body)=>fetch(new URL('/api/review/'+route,service.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(response=>response.json());
try{
  seed('closed-demo');
  const ui=await context.newPage();await ui.goto(service.url);await ui.locator('[data-tab="review"]').click();
  await ui.getByText('作业页已关闭，可恢复',{exact:true}).waitFor();
  assert.equal(await ui.getByText('作业页已打开',{exact:true}).count(),0,'关闭记录不能误报打开');
  await ui.getByRole('button',{name:'重新打开并恢复',exact:true}).click();
  await ui.locator('.review-feedback').filter({hasText:'恢复 2 题'}).waitFor();
  let entry=getKeptPage('closed-demo'),frame=findWorkFrame(entry.page);
  assert.equal((await readEssayAnswer(frame,0)).storedText,draft);
  assert.deepEqual((await readSelection(frame,1)).selected,['A']);
  assert.equal(loadState().reviewQueue[0].domIndex,1,'恢复时以题目标识重新定位');
  assert.equal(confirmed.length,0,'恢复不提交');
  const draftEditor=ui.locator('.qedit textarea');await draftEditor.fill('尚未保存的人工编辑');await new Promise(resolve=>setTimeout(resolve,5200));
  assert.equal(await draftEditor.inputValue(),'尚未保存的人工编辑','自动刷新待审状态不能清空用户编辑');await draftEditor.fill(draft);
  await ui.screenshot({path:path.join(data,'restored-review.png')});
  await entry.page.close();
  await ui.locator('#panel-review [data-action="loadReview"]').click();
  await ui.getByRole('button',{name:'恢复后提交这一组',exact:true}).click();
  await ui.locator('#reviewBody .placeholder').waitFor();
  assert.equal(confirmed.length,1);
  assert.equal(loadState().taskPoints['closed-demo'].status,'done');
  assert.equal(loadState().quizzes['closed-demo'].submitted,true,'待审确认提交后不能遗留未提交摘要');
  assert.equal(loadState().quizzes['closed-demo'].phase,'submitted');
  assert.equal(loadState().keptPages['closed-demo'],undefined);
  assert.equal(listReviewItems().length,0);
  assert.match(await ui.locator('#reviewSummary').innerText(),/待处理 0 题/);
  assert.match(await ui.locator('#reviewSummary').innerText(),/历史记录：已提交 2 题/);

  seed('incomplete-demo',{missing:true});
  await ui.locator('#panel-review [data-action="loadReview"]').click();
  await ui.getByRole('button',{name:'恢复后提交这一组',exact:true}).click();
  await ui.locator('.review-feedback').filter({hasText:'尚未填写完整'}).waitFor();
  assert.equal(confirmed.length,1);assert.equal(listReviewItems().length,2);
  assert.equal(loadState().taskPoints['incomplete-demo'].status,'manual');
  await ui.screenshot({path:path.join(data,'incomplete-preserved.png')});

  seed('changed-demo',{mode:'changed'});
  let response=await post('submit',{taskKey:'changed-demo'});
  assert.equal(response.ok,false);assert.match(response.error,/无法唯一对应/);
  assert.equal((await readEssayAnswer(findWorkFrame(getKeptPage('changed-demo').page),0)).visibleText,'','身份不匹配时不能先写入其他题');
  response=await post('edit',{id:'changed-demo#q2',textAnswer:'恢复失败也应保存的人工草稿'});
  assert.equal(response.ok,false);assert.match(response.error,/草稿已保存/);
  assert.equal(listReviewItems()[1].textAnswer,'恢复失败也应保存的人工草稿');
  assert.equal(listReviewItems()[1].filled,null);

  seed('edited-demo',{mode:'prefilled',edited:true});
  response=await post('submit',{taskKey:'edited-demo'});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(confirmed.length,2);
  assert.deepEqual(confirmed.at(-1).choice,['B'],'提交时使用人工修改后的实际选项');
  assert.equal(confirmed.at(-1).essay,draft);

  seed('uncertain-demo',{mode:'pending'});
  response=await post('submit',{taskKey:'uncertain-demo'});
  assert.equal(response.ok,false);assert.match(response.error,/提交结果尚未确认/);
  assert.equal(confirmed.length,3);assert.equal(listReviewItems().length,2);
  assert.equal(loadState().keptPages['uncertain-demo'].info.submissionPending,true);
  response=await post('submit',{taskKey:'uncertain-demo'});
  assert.equal(response.ok,false);assert.equal(confirmed.length,3,'提交结果未知时不得重复点击提交');
  assert.equal(loadState().taskPoints['uncertain-demo'].status,'manual');

  // Use the actual primary button and toolbar, not just the open endpoint.
  // The reported path was submit -> blocked, while the separate open worked.
  seed('ui-pending-demo',{pending:true,mode:'legacy-essay'});
  await ui.locator('#panel-review [data-action="loadReview"]').click();
  let uiSubmitRequests=0;
  const countUISubmit=request=>{if(new URL(request.url()).pathname==='/api/review/submit')uiSubmitRequests++;};
  ui.on('request',countUISubmit);
  await ui.getByRole('button',{name:'恢复并核对',exact:true}).click();
  await ui.locator('.review-feedback').filter({hasText:'恢复 2 题'}).waitFor();
  assert.equal(uiSubmitRequests,0,'恢复操作不能调用提交接口');
  assert.equal(loadState().keptPages['ui-pending-demo'].info.submissionPending,false);
  assert.equal((await readEssayAnswer(findWorkFrame(getKeptPage('ui-pending-demo').page),0)).storedText,draft);
  assert.equal(confirmed.length,3);
  await ui.getByRole('button',{name:'✔ 提交这一组',exact:true}).waitFor();

  seed('toolbar-pending-demo',{pending:true,mode:'legacy-essay'});
  seed('toolbar-ready-demo',{append:true});
  await ui.locator('#panel-review [data-action="loadReview"]').click();
  await ui.locator('[data-action="submitAllReviews"]').click();
  await ui.locator('.review-feedback').filter({hasText:'恢复 2 题'}).waitFor();
  assert.equal(uiSubmitRequests,0,'批量入口遇到待恢复项时也只恢复，本次不提交其他组');
  assert.equal(loadState().keptPages['toolbar-pending-demo'].info.submissionPending,false);
  assert.equal(confirmed.length,3);
  ui.off('request',countUISubmit);
  seed('uncertain-demo',{pending:true,mode:'pending'});

  // A persisted uncertain flag must not permanently block restoring a server
  // draft after restart. Retrying submission alone remains blocked above.
  response=await post('open',{taskKey:'uncertain-demo'});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(response.result.pendingRecovered,true);
  assert.equal(response.result.restored,2,'已有不确定页必须重新读取服务器草稿再恢复');
  assert.equal(loadState().keptPages['uncertain-demo'].info.submissionPending,false);
  assert.equal(confirmed.length,3,'恢复平台草稿不会自动提交');

  seed('restart-pending-demo',{pending:true,mode:'legacy-essay'});
  response=await post('submit',{taskKey:'restart-pending-demo'});
  assert.equal(response.ok,false);assert.match(response.error,/先点击/);
  assert.equal(loadState().keptPages['restart-pending-demo'].info.submissionPending,true);
  assert.equal(confirmed.length,3,'关闭后直接重试提交不能清除未知标记');
  await getKeptPage('restart-pending-demo').page.close();
  response=await post('open',{taskKey:'restart-pending-demo'});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(response.result.pendingRecovered,true);assert.equal(response.result.restored,2);
  assert.equal(loadState().keptPages['restart-pending-demo'].info.submissionPending,false);
  assert.equal((await readEssayAnswer(findWorkFrame(getKeptPage('restart-pending-demo').page),0)).storedText,draft);
  assert.equal(confirmed.length,3);

  seed('edit-pending-demo',{pending:true,mode:'legacy-essay'});
  response=await post('edit',{id:'edit-pending-demo#q2',textAnswer:'重新核对后保存并填入的正文'});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal((await readEssayAnswer(findWorkFrame(getKeptPage('edit-pending-demo').page),0)).storedText,'重新核对后保存并填入的正文');
  assert.equal(loadState().keptPages['edit-pending-demo'].info.submissionPending,false);
  assert.equal(confirmed.length,3,'保存并填入同样不能提交');

  for(const mode of ['different-attempt','changed','readonly']){
    const key='unsafe-pending-'+mode;seed(key,{pending:true,mode});
    response=await post('open',{taskKey:key});
    assert.equal(response.ok,false,mode+'不能解除提交保护');
    assert.equal(loadState().keptPages[key].info.submissionPending,true);
    assert.equal((await readEssayAnswer(findWorkFrame(getKeptPage(key).page),0)).storedText,'','核对失败不能提前回填');
    assert.equal(confirmed.length,3);
  }

  seed('already-demo',{mode:'completed',pending:true});
  response=await post('submit',{taskKey:'already-demo'});
  assert.equal(response.ok,true,JSON.stringify(response));assert.equal(confirmed.length,3,'平台已提交时只核对，不重交');

  seed('attempt-demo',{mode:'different-attempt'});
  response=await post('submit',{taskKey:'attempt-demo'});
  assert.equal(response.ok,false);assert.match(response.error,/作答次数已变化/);
  assert.equal(confirmed.length,3);

  seed('parallel-demo');
  const parallel=await Promise.all([post('submit',{taskKey:'parallel-demo'}),post('submit',{taskKey:'parallel-demo'})]);
  assert.equal(parallel.filter(result=>result.ok).length,1);assert.equal(confirmed.length,4);

  seed('bulk-good');seed('bulk-missing',{missing:true,append:true});
  response=await post('submit',{all:true});
  assert.equal(response.ok,false);assert.equal(response.result.submitted,1);assert.equal(response.result.failed,1);
  assert.ok(listReviewItems().every(item=>item.taskKey==='bulk-missing'));
  assert.equal(confirmed.length,5);
  seed('legacy-demo',{mode:'legacy-essay'});
  const legacy=await reopenReviewWork(context,'legacy-demo',{personId,waitMs:150});
  assert.equal(legacy.restored,2);assert.equal(legacy.total,2,'嵌套 TiMuHead 不是额外一道题');
  seed('manual-demo');
  const manual=await reopenReviewWork(context,'manual-demo',{personId,waitMs:150});
  const manualFrame=findWorkFrame(manual.page);await manualFrame.locator('.btnSubmit').click();await manualFrame.locator('#popok').click();
  assert.equal((await syncSubmittedReviews()).synced,1);assert.equal(listReviewItems().length,0,'手动提交应清除待审');
  assert.equal(loadState().taskPoints['manual-demo'].status,'done');
  assert.equal(loadState().quizzes['manual-demo'].phase,'submitted','手动提交后摘要也要同步');
  assert.equal(loadState().quizzes['manual-demo'].submitted,true);
  assert.equal(loadState().keptPages['manual-demo'],undefined,'已确认提交后移除持久化恢复入口');
  seed('retry-only-demo',{missing:true});await ui.reload();await ui.locator('[data-tab="review"]').click();
  const retryRequest=ui.waitForRequest(req=>new URL(req.url()).pathname==='/api/action/retryReview');
  await ui.getByRole('button',{name:'只重试未完成题目',exact:true}).click();
  assert.deepEqual((await retryRequest).postDataJSON(),{taskKey:'retry-only-demo'},'重试按钮只传本组任务标识，不能提交或启动其他作业');
  await ui.locator('.review-feedback').filter({hasText:'只向 AI 询问未完成题目'}).waitFor();
  console.log('✓ 真实隔离页面：关闭/重启记录恢复、题序变化、选择与简答回填、人工修改、缺题/错题/换次拦截、提交结果核实、未知结果不重交、并发和批量部分失败通过');
  console.log(`截图：${path.join(data,'restored-review.png')}`);
}finally{
  await context.close();await browser.close();
  for(const client of service.wss.clients)client.terminate();await new Promise(resolve=>service.wss.close(resolve));
  service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));
}
