// Restore saved drafts through the parent card, which renews the work iframe's
// dynamic credentials. Never navigate directly to a stale doHomeWorkNew URL.
import { buildChecklist } from './checklist.mjs';
import { cardsUrl } from './section.mjs';
import { extractQuestions, waitWorkFrame, findWorkFrame, getWorkMeta, selectOptions, readSelection } from './quiz.mjs';
import { fillEssayAnswer, readEssayAnswer } from './essay.mjs';
import { getKeptPage, registerKeptPage, dropKeptPage, submitKeptWork, workIdentity } from './quizrun.mjs';
import { loadState, listReviewItems, markReviewItem, clearReviewByTask, setTaskStatus } from '../state.mjs';
import { listKeptPages } from './quizrun.mjs';
import { normalizeEssayText } from '../ai/parse.mjs';
import { newTaskPage, releasePage, setPageBusy, markSavedReviewPage } from '../browser/pages.mjs';
import { withReviewLock } from './review-lock.mjs';
import { submissionState, pageSubmissionState } from './submission-state.mjs';
export { withReviewLock } from './review-lock.mjs';

const text=value=>String(value||'').replace(/\s+/g,' ').trim();
const optionSignature=options=>JSON.stringify((options||[]).map(o=>[String(o.letter),text(o.text)]).sort((a,b)=>a[0].localeCompare(b[0])));
// Legacy essay records used answerEditor0/1 (a render index) as a question ID.
// Those indices change with ordering and cannot be used as platform identity.
const questionId=item=>{const id=String(item.questionId||item.archive?.questionId||'');return /^\d{1,4}$/.test(id)&&item.qtype==='essay'?'':id;};

async function waitReviewFrame(page,waitMs){
  const deadline=Date.now()+waitMs;
  while(Date.now()<deadline){
    for(const frame of page.frames()){
      if(!/mooc-ans\/(?:api\/)?work\/|\/work\/selectWorkQuestion/.test(frame.url()))continue;
      const hasQuestions=await frame.evaluate(()=>document.querySelectorAll('.TiMu,.newTiMu').length>0).catch(()=>false);
      if(hasQuestions||(await submissionState(frame).catch(()=>({}))).submitted)return frame;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

export function matchReviewQuestions(items, questions) {
  const used=new Set();
  return items.map(item=>{
    const id=questionId(item),stem=text(item.archive?.stemTextRaw);
    const candidates=questions.filter(q=>q.qtype===item.qtype && (id ? String(q.questionId)===id :
      !!stem&&text(q.stemTextRaw)===stem&&optionSignature(item.options)===optionSignature(q.options)));
    if(candidates.length!==1||used.has(candidates[0].domIndex))throw new Error(`第 ${item.questionIndex} 题无法唯一对应，题目可能已变化；已保留草稿，请人工核对`);
    const question=candidates[0];
    if(optionSignature(item.options)!==optionSignature(question.options))throw new Error(`第 ${item.questionIndex} 题的选项已变化，未恢复或提交`);
    used.add(question.domIndex);
    return {item,question};
  });
}

async function readAnswer(frame, question) {
  if(['single','multiple','judge'].includes(question.qtype)){
    const result=await readSelection(frame,question.domIndex);
    const selected=result?.selected||[];
    return {ready:(question.qtype==='multiple'?selected.length>0:selected.length===1)&&selected.every(letter=>question.options.some(option=>option.letter===letter)),value:selected};
  }
  if(question.qtype==='essay'){
    const answer=await readEssayAnswer(frame,question.domIndex);
    return {ready:!!answer.ok&&!!text(answer.visibleText)&&text(answer.visibleText)===text(answer.storedText),value:normalizeEssayText(answer.visibleText)};
  }
  if(question.qtype==='fill'){
    const ready=await frame.evaluate(index=>{
      const q=document.querySelectorAll('.TiMu, .newTiMu')[index];
      const inputs=[...(q?.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')||[])];
      return inputs.length>0&&inputs.every(input=>String(input.value??input.textContent??'').trim());
    },question.domIndex);
    return {ready:!!ready,value:null};
  }
  return {ready:false,value:null};
}

export async function restoreReviewAnswers(frame, items, {expectedCount, restoreAnswers=true}={}) {
  const questions=await extractQuestions(frame);
  if(!questions.length)throw new Error('未读到作业题目，请检查登录或页面加载状态');
  if(expectedCount>0&&questions.length!==expectedCount)throw new Error('作业题数已变化，未恢复或提交，请人工核对');
  const matches=matchReviewQuestions(items,questions);
  const plan=[];
  // Validate the whole mapping and existing drafts before changing any answer.
  for(const pair of matches){
    const {item,question}=pair;
    const approved=item.autoFilled===true||item.filled?.verified===true||item.editedByHuman===true;
    const value=question.qtype==='essay'?normalizeEssayText(item.textAnswer):item.letters;
    if(!restoreAnswers||!approved||!value?.length)continue;
    if(!['essay','single','multiple','judge'].includes(question.qtype))continue;
    if(question.qtype!=='essay'&&(!Array.isArray(value)||value.some(letter=>!question.options.some(option=>option.letter===letter))))throw new Error(`第 ${question.index} 题的已存答案不在当前选项中`);
    const current=await readAnswer(frame,question);
    const equal=question.qtype==='essay'?text(current.value)===text(value):JSON.stringify([...current.value].sort())===JSON.stringify([...value].sort());
    if(current.ready&&!equal&&!item.editedByHuman)throw new Error(`第 ${question.index} 题已有不同答案，未覆盖；请在待审答案中核对修改后重试`);
    plan.push({...pair,value,equal});
  }
  let restored=0;
  for(const {item,question,value,equal}of plan){
    if(!equal){
      const result=question.qtype==='essay'?await fillEssayAnswer(frame,question.domIndex,value,{overwrite:!!item.editedByHuman}):await selectOptions(frame,question.domIndex,value);
      if(!result.ok)throw new Error(`第 ${question.index} 题恢复失败：${result.error||'点选失败'}`);
      restored++;
    }
    const back=await readAnswer(frame,question);
    const verified=question.qtype==='essay'?text(back.value)===text(value):JSON.stringify([...back.value].sort())===JSON.stringify([...value].sort());
    if(!back.ready||!verified)throw new Error(`第 ${question.index} 题恢复后回读不一致，未提交`);
    markReviewItem(item.id,{status:'filled',filled:{verified:true,restored:true},fillError:null,lastVerifiedAt:new Date().toISOString()});
  }
  for(const {item,question}of matches)markReviewItem(item.id,{domIndex:question.domIndex,questionId:question.questionId||questionId(item)});
  const missing=[];
  for(const question of questions)if(!(await readAnswer(frame,question)).ready)missing.push(question.index);
  return {restored,ready:missing.length===0,missing,total:questions.length};
}

export async function readSubmissionState(frame) {
  return submissionState(frame);
}

function finishManualReview(key) {
  clearReviewByTask(key,'submitted');
  setTaskStatus(key,{status:'done',note:'已核对平台手动提交结果',submittedAt:new Date().toISOString()});
  dropKeptPage(key);
}

export async function syncSubmittedReviews() {
  let synced=0;
  for(const record of listKeptPages().filter(r=>!r.closed&&!r.key.startsWith('zhihuishu:'))){
    try{await withReviewLock(record.key,async()=>{
      const entry=getKeptPage(record.key);if(!entry)return;
      if(entry.info?.type==='discussion'){if(await (await import('./discussion.mjs')).syncDiscussionReview(record.key,entry))synced++;return;}
      const expected=entry.info?.workIdentity||{};
      const result=await pageSubmissionState(entry.page,findWorkFrame(entry.page));
      if(!result.submitted)return;
      const actual=workIdentity(result.frame.url());
      if(!expected.workid||actual.workid!==expected.workid)return;
      if(Object.entries(expected).some(([field,value])=>actual[field]&&actual[field]!==value))return;
      finishManualReview(record.key);synced++;
    });}catch{ /* Busy or still loading: check on the next read. */ }
  }
  return {synced};
}

export async function reopenReviewWork(ctx,key,options={}) {
  if((await import('./discussion.mjs')).isDiscussionReview(key))return (await import('./discussion.mjs')).reopenDiscussionReview(ctx,key,options);
  const previous=getKeptPage(key)?.page;let result;if(previous)setPageBusy(previous,true);
  try{result=await reopenReviewWorkCore(ctx,key,options);return result;}
  finally{const current=getKeptPage(key)?.page;if(current)markSavedReviewPage(current);else{const page=result?.page||previous;if(page&&!page.isClosed())setPageBusy(page,false);}}
}
async function reopenReviewWorkCore(ctx,key,{personId,restoreAnswers=true,waitMs=30000,reconcilePending=true}={}) {
  if(!ctx)throw new Error('浏览器未连接，请先打开并登录学习通');
  const items=listReviewItems().filter(item=>item.taskKey===key);
  if(!items.length)throw new Error('此作业没有待审记录，请刷新列表');
  const record=loadState().keptPages?.[key];
  let entry=getKeptPage(key),reopened=false;
  const info=entry?.info||record?.info||{};
  if(info.personId&&String(info.personId)!==String(personId))throw new Error('账号已变更，请重新核对待审记录');
  if(!entry&&record?.url){
    const hit=ctx.pages().find(page=>!page.isClosed()&&page.url()===record.url);
    if(hit){registerKeptPage(key,hit,info,{busy:true});entry=getKeptPage(key);}
  }
  if(!entry){
    const known=buildChecklist()?.courses.flatMap(course=>course.tasks||[]).find(task=>task.key===key);
    const task={...known,...info.task};
    for(const field of ['courseId','clazzId','knowledgeId'])task[field]??=items[0][field];
    if(!personId||['courseId','clazzId','knowledgeId'].some(field=>!task[field]||!/^[\w-]+$/.test(String(task[field]))))throw new Error('缺少作业定位信息，请登录学习通并读取课程清单；已保存答案仍保留');
    if(items.some(item=>['courseId','clazzId','knowledgeId'].some(field=>item[field]&&String(item[field])!==String(task[field]))))throw new Error('待审记录的课程定位不一致，未打开作业');
    let cardNum=task.cardNum;
    try{
      const parent=new URL(record?.url);
      if(parent.searchParams.get('cpi')&&parent.searchParams.get('cpi')!==String(personId))throw new Error('账号已变更，请重新核对课程与待审记录');
      if(cardNum==null&&parent.searchParams.has('num'))cardNum=Number(parent.searchParams.get('num'));
    }catch(error){if(error.message.startsWith('账号已变更'))throw error;}
    const page=await newTaskPage(ctx,'review');
    try{
      // Prefer the recorded card. Legacy queues without a card number use the
      // same bounded card lookup as the runner, followed by question validation.
      if(Number.isInteger(cardNum)&&cardNum>=0){await page.goto(cardsUrl({...task,personId,cardNum}),{waitUntil:'domcontentloaded',timeout:60000});}
      else{const {openSectionCard}=await import('./section.mjs');const card=await openSectionCard(page,{...task,name:task.name||info.name},personId);cardNum=card.cardNum;}
      const frame=await waitReviewFrame(page,waitMs)||findWorkFrame(page);
      if(!frame)throw new Error('作业页面未加载，请检查学习通登录或验证提示');
      registerKeptPage(key,page,{...info,task:{...task,cardNum},personId:String(personId)},{busy:true});
      entry=getKeptPage(key);reopened=true;
    }catch(error){await page.close().catch(()=>{});releasePage(page);throw error;}
  }
  const detected=await pageSubmissionState(entry.page,findWorkFrame(entry.page));
  const detectedIdentity=detected.frame?workIdentity(detected.frame.url()):{};
  if(detected.submitted&&info.workIdentity?.workid&&detectedIdentity.workid===info.workIdentity.workid&&!Object.entries(info.workIdentity).some(([field,value])=>detectedIdentity[field]&&detectedIdentity[field]!==value)){finishManualReview(key);return {page:entry.page,alreadySubmitted:true,reopened,ready:true,restored:0};}
  let frame=await waitReviewFrame(entry.page,waitMs)||findWorkFrame(entry.page);
  if(!frame)throw new Error('作业页面未加载，请检查登录或验证提示');
  let actual=workIdentity(frame.url());
  if(Object.entries(info.workIdentity||{}).some(([field,value])=>value&&actual[field]!==value))throw new Error('作业或作答次数已变化，未恢复或提交，请人工核对');
  if((await readSubmissionState(frame)).submitted){
    if(!info.workIdentity?.workid){
      const questions=await extractQuestions(frame);
      if(!questions.length)throw new Error('旧记录缺少作业标识，无法确认此提交结果，请在页面人工核对；草稿已保留');
      matchReviewQuestions(items,questions);
    }
    finishManualReview(key);
    return {page:entry.page,alreadySubmitted:true,reopened,ready:true,restored:0};
  }
  let pendingRecovered=false;
  if(info.submissionPending){
    const hasConfirmation=async()=>{
      const counts=await Promise.all(entry.page.frames().map(f=>f.locator('#popok, #popOk').filter({visible:true}).count().catch(()=>0)));
      return counts.some(Boolean);
    };
    if(await hasConfirmation()){
      const result=await restoreReviewAnswers(frame,items,{restoreAnswers:false,expectedCount:info.totalQuestions});
      return {...result,page:entry.page,reopened,alreadySubmitted:false,pendingConfirmation:true};
    }
    // A submission retry must never reset an uncertain request. Only the user's
    // separate open/restore or edit action may reconcile a fresh server page.
    if(!reconcilePending)throw new Error('上次提交结果尚未确认，请先点击“打开并核对”恢复平台状态，再决定是否提交；待审记录已保留');
    if(!reopened){
      await entry.page.reload({waitUntil:'domcontentloaded',timeout:60000});
      frame=await waitReviewFrame(entry.page,waitMs)||findWorkFrame(entry.page);
      if(!frame)throw new Error('未能重新核对平台状态，待审答案已保留，请检查登录或验证提示');
      actual=workIdentity(frame.url());
    }
    if(!info.workIdentity?.workid||!info.workIdentity?.workanswerid||Object.entries(info.workIdentity).some(([field,value])=>value&&actual[field]!==value))throw new Error('无法核对原作业与作答次数，未恢复或提交；待审答案已保留');
    const refreshed=await pageSubmissionState(entry.page,frame);
    if(refreshed.submitted){
      const identity=workIdentity(refreshed.frame.url());
      if(Object.entries(info.workIdentity).some(([field,value])=>value&&identity[field]!==value))throw new Error('平台结果与原作业不一致，待审答案已保留');
      finishManualReview(key);
      return {page:entry.page,alreadySubmitted:true,reopened,ready:true,restored:0};
    }
    if(await hasConfirmation())throw new Error('平台仍有提交确认，请先核对确认框；待审答案已保留');
    const editable=await frame.evaluate(()=>{
      if(!/\/work\/(?:doHomeWorkNew|selectWorkQuestion)(?:[/?]|$)/i.test(location.pathname))return false;
      return [...document.querySelectorAll('.btnSubmit')].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.matches(':disabled')&&e.getAttribute('aria-disabled')!=='true');
    });
    if(!editable)throw new Error('平台尚未显示可编辑的原作业，未恢复或提交；请人工核对，待审答案已保留');
    pendingRecovered=true;
  }
  const meta=await getWorkMeta(frame);
  const result=await restoreReviewAnswers(frame,items,{restoreAnswers,expectedCount:info.totalQuestions||loadState().quizzes?.[key]?.totalQuestions});
  registerKeptPage(key,entry.page,{...entry.info,workIdentity:actual,totalQuestions:meta.questionTotal,...(pendingRecovered?{submissionPending:false}: {})},{busy:true});
  return {...result,page:entry.page,reopened,alreadySubmitted:false,pendingRecovered};
}

export async function submitReviewWork(ctx,key,options) {
  return withReviewLock(key,async()=>{
    if((await import('./discussion.mjs')).isDiscussionReview(key))return (await import('./discussion.mjs')).submitDiscussionReview(ctx,key,options);
    const prepared=await reopenReviewWork(ctx,key,{...options,reconcilePending:false});
    if(prepared.alreadySubmitted){await prepared.page.close().catch(()=>{});releasePage(prepared.page);dropKeptPage(key);return {ok:true,alreadySubmitted:true};}
    if(!prepared.ready)return {ok:false,error:`第 ${prepared.missing.join('、')} 题尚未填写完整，已保留答案，请补全后提交`};
    setPageBusy(prepared.page,true);
    try{return await submitKeptWork(key);}finally{if(!prepared.page.isClosed())setPageBusy(prepared.page,false);}
  });
}

export async function submitPendingReviews(ctx,scope={},options={}) {
  const active=new Set(listReviewItems().map(item=>item.taskKey));
  const targets=listKeptPages().filter(record=>!record.key.startsWith('zhihuishu:')&&active.has(record.key)&&(scope.all||record.key===scope.taskKey));
  if(!targets.length)return {submitted:0,failed:0,note:'没有匹配的待审作业，请刷新列表'};
  let submitted=0,failed=0;
  const details=[];
  for(const target of targets){
    let result;
    if(scope.all&&target.info?.type==='discussion'){
      details.push({key:target.key,ok:false,error:'讨论草稿需要逐条核对，点击该条的“确认发布讨论”'});failed++;continue;
    }
    try{result=await submitReviewWork(ctx,target.key,options);}
    catch(error){result={ok:false,error:error.message};}
    if(result.ok){
      clearReviewByTask(target.key,'submitted');
      if(result.taskFinished!==false)setTaskStatus(target.key,{status:'done',note:result.alreadySubmitted?'已核对平台提交结果':'人工确认后已提交',submittedAt:new Date().toISOString()});
      submitted++;
    }else failed++;
    details.push({key:target.key,ok:result.ok,error:result.error||null});
  }
  return {submitted,failed,details};
}
