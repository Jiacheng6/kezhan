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
import { newTaskPage, releasePage } from '../browser/pages.mjs';
import { withReviewLock } from './review-lock.mjs';
export { withReviewLock } from './review-lock.mjs';

const text=value=>String(value||'').replace(/\s+/g,' ').trim();
const optionSignature=options=>JSON.stringify((options||[]).map(o=>[String(o.letter),text(o.text)]).sort((a,b)=>a[0].localeCompare(b[0])));
const questionId=item=>String(item.questionId||item.archive?.questionId||'');

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
      const q=document.querySelectorAll('.TiMu, [class*="TiMu"]')[index];
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
  return frame.evaluate(()=>{
    const button=document.querySelector('.btnSubmit');
    const visible=!!button&&button.getBoundingClientRect().width>0;
    return {submitted:!visible&&/提交成功|已提交|测评结果|本次成绩\s*[\d.]+\s*分/.test(document.body?.innerText||'')};
  });
}

export async function reopenReviewWork(ctx,key,{personId,restoreAnswers=true,waitMs=30000}={}) {
  if(!ctx)throw new Error('浏览器未连接，请先打开并登录学习通');
  const items=listReviewItems().filter(item=>item.taskKey===key);
  if(!items.length)throw new Error('此作业没有待审记录，请刷新列表');
  const record=loadState().keptPages?.[key];
  let entry=getKeptPage(key),reopened=false;
  const info=entry?.info||record?.info||{};
  if(info.personId&&String(info.personId)!==String(personId))throw new Error('账号已变更，请重新核对待审记录');
  if(!entry&&record?.url){
    const hit=ctx.pages().find(page=>!page.isClosed()&&page.url()===record.url);
    if(hit){registerKeptPage(key,hit,info);entry=getKeptPage(key);}
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
      const frame=await waitWorkFrame(page,waitMs)||findWorkFrame(page);
      if(!frame)throw new Error('作业页面未加载，请检查学习通登录或验证提示');
      registerKeptPage(key,page,{...info,task:{...task,cardNum},personId:String(personId)});
      entry=getKeptPage(key);reopened=true;
    }catch(error){await page.close().catch(()=>{});releasePage(page);throw error;}
  }
  const frame=await waitWorkFrame(entry.page,waitMs)||findWorkFrame(entry.page);
  if(!frame)throw new Error('作业页面未加载，请检查登录或验证提示');
  const actual=workIdentity(frame.url());
  if(Object.entries(info.workIdentity||{}).some(([field,value])=>value&&actual[field]!==value))throw new Error('作业或作答次数已变化，未恢复或提交，请人工核对');
  if((await readSubmissionState(frame)).submitted){
    if(!info.workIdentity?.workid){
      const questions=await extractQuestions(frame);
      if(!questions.length)throw new Error('旧记录缺少作业标识，无法确认此提交结果，请在页面人工核对；草稿已保留');
      matchReviewQuestions(items,questions);
    }
    return {page:entry.page,alreadySubmitted:true,reopened,ready:true,restored:0};
  }
  if(info.submissionPending)throw new Error('上次提交结果尚未确认，请在页面核对，避免重复提交；待审记录已保留');
  const meta=await getWorkMeta(frame);
  const result=await restoreReviewAnswers(frame,items,{restoreAnswers,expectedCount:info.totalQuestions||loadState().quizzes?.[key]?.totalQuestions});
  registerKeptPage(key,entry.page,{...entry.info,workIdentity:actual,totalQuestions:meta.questionTotal});
  return {...result,page:entry.page,reopened,alreadySubmitted:false};
}

export async function submitReviewWork(ctx,key,options) {
  return withReviewLock(key,async()=>{
    const prepared=await reopenReviewWork(ctx,key,options);
    if(prepared.alreadySubmitted){await prepared.page.close().catch(()=>{});releasePage(prepared.page);dropKeptPage(key);return {ok:true,alreadySubmitted:true};}
    if(!prepared.ready)return {ok:false,error:`第 ${prepared.missing.join('、')} 题尚未填写完整，已保留答案，请补全后提交`};
    return submitKeptWork(key);
  });
}

export async function submitPendingReviews(ctx,scope={},options={}) {
  const active=new Set(listReviewItems().map(item=>item.taskKey));
  const targets=listKeptPages().filter(record=>active.has(record.key)&&(scope.all||record.key===scope.taskKey));
  if(!targets.length)return {submitted:0,failed:0,note:'没有匹配的待审作业，请刷新列表'};
  let submitted=0,failed=0;
  const details=[];
  for(const target of targets){
    let result;
    try{result=await submitReviewWork(ctx,target.key,options);}
    catch(error){result={ok:false,error:error.message};}
    if(result.ok){
      clearReviewByTask(target.key,'submitted');
      setTaskStatus(target.key,{status:'done',note:result.alreadySubmitted?'已核对平台提交结果':'人工确认后已提交',submittedAt:new Date().toISOString()});
      submitted++;
    }else failed++;
    details.push({key:target.key,ok:result.ok,error:result.error||null});
  }
  return {submitted,failed,details};
}
