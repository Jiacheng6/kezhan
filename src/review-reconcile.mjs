// Read-only platform reconciliation. Never fills answers or activates submission.
import {loadState,listReviewItems} from './state.mjs';
import {newTaskPage,releasePage,isPageBusy} from './browser/pages.mjs';
import {getKeptPage,workIdentity} from './chaoxing/quizrun.mjs';
import {finishManualReview} from './chaoxing/review-recovery.mjs';
import {withReviewLock,isReviewLocked} from './chaoxing/review-lock.mjs';
import {cardsUrl} from './chaoxing/section.mjs';
import {findWorkFrame,extractQuestions} from './chaoxing/quiz.mjs';
import {pageSubmissionState} from './chaoxing/submission-state.mjs';
import {readZhihuishuGrade} from './platforms/zhihuishu/quiz-submit.mjs';
import {recordZhihuishuSubmitted} from './platforms/zhihuishu/quiz-task.mjs';
import {throwIfStopped,waitForRead} from './control.mjs';
import {recoverReviewIdentity} from './chaoxing/review-identity.mjs';

export function zhihuishuResultUrl(paperKey){
 const prefix='zhihuishu:homework:';
 if(typeof paperKey!=='string'||!paperKey.startsWith(prefix))return null;
 const parts=paperKey.slice(prefix.length).split(':');
 if(parts.length!==6||parts.some(p=>!p))return null;
 try{if(parts.some(p=>/[\/?#]/.test(decodeURIComponent(p))))return null;}catch{return null;}
 return 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/checkHomework/'+parts.slice(0,5).join('/');
}
export function matchesLegacySubmittedQuestions(items,questions){
 const id=q=>String(q.questionId||q.archive?.questionId||'');
 const text=v=>String(v||'').replace(/\s+/g,' ').trim();
 if(!items.length||questions.length!==items.length||new Set(items.map(id)).size!==items.length||items.some(i=>!id(i)))return false;
 return items.every(item=>{
  const matches=questions.filter(q=>id(q)===id(item));if(matches.length!==1||matches[0].qtype!==item.qtype)return false;
  const options=matches[0].options||[],old=item.options||[];if(options.length!==old.length)return false;
  const ids=options.map(o=>o.optionId),saved=old.map(o=>o.optionId);
  if(ids.length&&ids.every(Boolean)&&saved.every(Boolean))return new Set(ids).size===ids.length&&JSON.stringify([...ids].sort())===JSON.stringify([...saved].sort());
  return options.length?JSON.stringify(options.map(o=>text(o.text)).sort())===JSON.stringify(old.map(o=>text(o.text)).sort()):text(item.archive?.stemTextRaw)===text(matches[0].stemTextRaw)&&!!text(item.archive?.stemTextRaw);
 });
}
export async function reconcileOneReview(context,key,{personId,shouldStop,waitMs=10000}={}){
 if(!context)throw Error('内置网页未连接');
 const live=getKeptPage(key)?.page;
 if(isReviewLocked(key)||live&&isPageBusy(live))return {key,state:'busy'};
 return withReviewLock(key,async()=>{
  const state=loadState(),items=listReviewItems().filter(i=>i.taskKey===key);
  if(!items.length)return {key,state:'already-synced'};
  if(items.some(i=>i.qtype==='discussion'))return {key,state:'skipped'};
  const zhs=key.startsWith('zhihuishu:'),record=state.quizzes?.[key],kept=state.keptPages?.[key];let info=kept?.info||{};
  if(!zhs){const identity=recoverReviewIdentity(key,info,items,{personId});if(identity)info={...info,workIdentity:identity};}
  let url;
  if(zhs){url=zhihuishuResultUrl(record?.paperKey);if(!url)return {key,state:'unconfirmed',reason:'缺少原试卷身份，草稿保留'};}
  else{
   if(info.personId&&String(info.personId)!==String(personId))return {key,state:'unconfirmed',reason:'登录账号与草稿不一致'};
   const t=info.task||{},item=items[0],task={...t,courseId:t.courseId||item.courseId,clazzId:t.clazzId||item.clazzId,knowledgeId:t.knowledgeId||item.knowledgeId};
   let cardNum=task.cardNum;
   try{const old=new URL(kept?.url);if(!old.hostname.endsWith('chaoxing.com'))return {key,state:'unconfirmed',reason:'原页面域名不匹配'};cardNum??=Number(old.searchParams.get('num'));}catch{}
   if(!personId||!task.courseId||!task.clazzId||!task.knowledgeId||!Number.isInteger(cardNum)||cardNum<0)return {key,state:'unconfirmed',reason:'缺少原课程、小节或账号身份，草稿保留'};
   url=cardsUrl({...task,personId,cardNum});
  }
  throwIfStopped(shouldStop);const page=await newTaskPage(context,'view-status');
  try{
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
   const deadline=Date.now()+waitMs;
   do{
    throwIfStopped(shouldStop);
    const current=new URL(page.url());if(/login|passport/.test(current.hostname)||/\/login|\/gologin/.test(current.pathname))return {key,state:'login-required',reason:'平台要求重新登录，草稿保留'};
    try{if(zhs){
     const grade=await waitForRead(()=>readZhihuishuGrade(page,{task:record.task,paperKey:record.paperKey}),{shouldStop,timeoutMs:2000,message:'平台结果页未响应，草稿保留'});
     if(grade){recordZhihuishuSubmitted(key,grade);return {key,state:'submitted',score:grade.score};}
    }else{
     const result=await waitForRead(()=>pageSubmissionState(page,findWorkFrame(page)),{shouldStop,timeoutMs:2000,message:'学习通结果页未响应，草稿保留'});
     if(result.submitted){const actual=workIdentity(result.frame.url());
      if(info.workIdentity?.workid&&info.workIdentity?.workanswerid){if(Object.entries(info.workIdentity).some(([k,v])=>v&&actual[k]!==v))return {key,state:'unconfirmed',reason:'平台作业或作答身份改变，草稿保留'};}
      else if(!matchesLegacySubmittedQuestions(items,await waitForRead(()=>extractQuestions(result.frame),{shouldStop,timeoutMs:2000})))return {key,state:'unconfirmed',reason:'旧记录身份缺失且平台题目无法完整对应，草稿保留'};
      finishManualReview(key,'已重新核对平台提交结果',result);return {key,state:'submitted',score:result.score};
     }
    }}catch(error){if(!/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(error.message))throw error;}
    // A still-editable homework is not a completed submission.
    if(zhs&&current.hash.startsWith('#/webExamList/dohomework/')&&await waitForRead(()=>page.locator('.examPaper_subject').count(),{shouldStop,timeoutMs:2000}))return {key,state:'unsubmitted'};
    await page.waitForTimeout(250);
   }while(Date.now()<deadline);
   return {key,state:'unconfirmed',reason:'平台尚未提供可核对的提交结果，草稿保留'};
  }catch(error){if(error.code==='STOPPED')throw error;return {key,state:'unconfirmed',reason:error.message};}
  finally{releasePage(page);await waitForRead(()=>page.close(),{timeoutMs:2000}).catch(()=>{});}
 });
}
export async function reconcileReviewResults(context,{keys,personId,onProgress=()=>{},shouldStop,waitMs}={}){
 const pending=[...new Set(listReviewItems().filter(i=>i.qtype!=='discussion'&&(!keys||keys.includes(i.taskKey))).map(i=>i.taskKey))];
 const results=[],loginRequired=new Set();for(const [index,key]of pending.entries()){
  throwIfStopped(shouldStop);onProgress({running:true,index,total:pending.length,synced:results.filter(r=>r.state==='submitted').length});
  const platform=key.startsWith('zhihuishu:')?'zhihuishu':'chaoxing';
  if(loginRequired.has(platform)){results.push({key,state:'login-required',reason:'此平台登录需要处理，草稿保留'});continue;}
  const result=await reconcileOneReview(context,key,{personId,shouldStop,waitMs});results.push(result);if(result.state==='login-required')loginRequired.add(platform);
 }
 return {running:false,index:pending.length,total:pending.length,synced:results.filter(r=>r.state==='submitted').length,results};
}
