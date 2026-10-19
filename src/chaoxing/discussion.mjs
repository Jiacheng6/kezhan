import fs from 'node:fs';import path from 'node:path';
import {PATHS,loadSettings} from '../config.mjs';
import {throwIfStopped,interruptibleSleep} from '../control.mjs';
import {loadState,listReviewItems,mutateState,markReviewItem,clearReviewByTask,setTaskStatus,updateReviewAnswer} from '../state.mjs';
import {newTaskPage,releasePage,markSavedReviewPage,setPageBusy} from '../browser/pages.mjs';
import {registerKeptPage,getKeptPage,dropKeptPage} from './quizrun.mjs';
import {cardsUrl} from './section.mjs';
import {selectedProvider,ensureProviderPage} from '../ai/providers.mjs';
import {askImage} from '../ai/ai.mjs';
import {waitTurn,markAsked,reportSuccess,reportFailure} from '../ai/throttle.mjs';
import {embedded,captureEmbeddedPage} from '../browser/embedded.mjs';
import {readDiscussionPage,readDiscussionComments,discussionIdentity,validateDiscussionIdentity,fillDiscussionEditor,publishDiscussionPage} from './discussion-page.mjs';
import {repeatedDiscussionAnswer,discussionText,MAX_DISCUSSION_ANSWER} from './discussion-consensus.mjs';

export const isDiscussionReview=key=>listReviewItems().some(item=>item.taskKey===key&&item.qtype==='discussion');
async function waitTopic(page,shouldStop=()=>false){
 const deadline=Date.now()+25000;let last;
 while(Date.now()<deadline){throwIfStopped(shouldStop);try{return await readDiscussionPage(page);}catch(error){last=error;}await interruptibleSleep(250,shouldStop);}
 throw last||new Error('讨论页面加载超时');
}
async function openTopic(ctx,task,personId,shouldStop){
 const page=await newTaskPage(ctx,'discussion');
 try{
  await page.goto(cardsUrl({...task,personId,cardNum:task.cardNum??0}),{waitUntil:'domcontentloaded',timeout:60000});
  let url;const deadline=Date.now()+20000;
  while(Date.now()<deadline&&!url){
   throwIfStopped(shouldStop);
   for(const frame of page.frames()){
    if(!/\/bbscircle\/chapter/.test(frame.url()))continue;
    const match=await frame.evaluate(()=>({id:new URL(location.href).searchParams.get('mtopicid'),text:document.querySelector('#topicMainDiv')?.innerText||'',url:document.querySelector('#topicMainDiv')?.getAttribute('data')})).catch(()=>null);
    if(match?.url&&(task.discussionId?String(task.discussionId)===match.id:match.text.includes(task.name)))url=match.url;
   }
   if(!url)await interruptibleSleep(200,shouldStop);
  }
  const identity=discussionIdentity(url);
  if(!identity||identity.courseId!==String(task.courseId)||identity.clazzId!==String(task.clazzId))throw new Error('没有找到与当前任务唯一对应的讨论链接，请重新扫描课程');
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await waitTopic(page,shouldStop);
  return page;
 }catch(error){await page.close().catch(()=>{});releasePage(page);throw error;}
}
async function topicImage(page,key){
 const element=page.locator('#bbsTopicDetail .replyContent').first();
 await element.scrollIntoViewIfNeeded();
 const folder=path.join(PATHS.answers,`discussion-${Date.now()}`);fs.mkdirSync(folder,{recursive:true});
 const file=path.join(folder,'topic.png');
 if(embedded){const box=await element.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));if(!box)throw new Error('讨论题面不可见');const rect={x:Math.max(0,Math.floor(box.x)),y:Math.max(0,Math.floor(box.y)),width:Math.min(Math.ceil(box.width),viewport.width-Math.max(0,Math.floor(box.x))),height:Math.min(Math.ceil(box.height),viewport.height-Math.max(0,Math.floor(box.y)))};if(rect.width<20||rect.height<20)throw new Error('讨论题面无法成像');const image=await captureEmbeddedPage(page,rect);fs.writeFileSync(file,Buffer.from(image.data,'base64'));}
 else await element.screenshot({path:file});
 return file;
}
function finishDiscussion(key,taskFinished,note){
 clearReviewByTask(key,'submitted');setTaskStatus(key,{status:taskFinished?'done':'manual',progress:taskFinished?1:null,note,submittedAt:new Date().toISOString()});dropKeptPage(key);
}
export async function runDiscussionTask({ctx,task,personId,qianwenPage=null,shouldStop=()=>false,onProgress=()=>{}},{askAI=askImage}={}){
 if(listReviewItems().some(item=>item.taskKey===task.key&&item.qtype==='discussion')){setTaskStatus(task.key,{status:'manual',note:'已有讨论草稿，待你核对后发布'});return {ok:false,phase:'awaiting-review',key:task.key,queued:1};}
 let page;
 try{
  throwIfStopped(shouldStop);onProgress({phase:'读取讨论'});
  page=await openTopic(ctx,task,personId,shouldStop);
  const topic=await readDiscussionComments(page,{shouldStop,onProgress});
  if(topic.comments.some(c=>c.isSelf)){
   const verified=task.tracking===false||(await (await import('./runner.mjs')).checkPointFinished(ctx,task,personId)).finished===true;
   setTaskStatus(task.key,{status:verified?'done':'manual',note:verified?'已核对本人讨论参与记录':'已参与讨论，任务点完成状态尚未确认'});
   await page.close();releasePage(page);
   return verified?{ok:true,phase:'already-finished',key:task.key}:{ok:false,phase:'needs-human',error:'已参与讨论，任务点尚未确认完成，未重复回复'};
  }
  let selected=repeatedDiscussionAnswer(topic.comments),text=selected.text,aiAnswer='',imagePath=null;
  if(!selected.found){
   onProgress({phase:'AI 生成讨论草稿'});throwIfStopped(shouldStop);
   const provider=selectedProvider(loadSettings()),aiPage=qianwenPage||await ensureProviderPage(ctx,provider);
   imagePath=await topicImage(page,task.key);
   const prompt=`请简短回答这道课程讨论题。题目：${topic.title}\n${topic.body}\n只输出可直接发表的回答正文，建议1到3句话、150字以内，不要重复题干，不要自报AI身份，不要附加说明。数学结论应准确，不确定时明确说明。`;
   await waitTurn({shouldStop,onWait:()=>onProgress({phase:'等待 AI 提问间隔'})});markAsked();
   const answer=await askAI({page:aiPage,imagePath,prompt,shouldStop,freshChat:true});
   if(!answer.ok){reportFailure(answer);throw Object.assign(new Error(answer.error||'AI 未返回讨论回答'),{aiErrorCode:answer.errorCode});}reportSuccess();
   text=discussionText(answer.answer||answer.raw).replace(/^(?:答案|回答|答)[:：]\s*/,'');aiAnswer=answer.raw||answer.answer||'';
   if(!text||text.length>400)throw new Error('AI 讨论回答为空或过长，未加入可发布草稿，请人工处理');
   selected={source:'ai',matches:0,scanned:topic.comments.length};
  }
  throwIfStopped(shouldStop);
  const info={type:'discussion',task,personId:String(personId),identity:topic.identity,userId:topic.userId,totalQuestions:1,name:topic.title,course:task.courseName,secNo:task.secNo,tracking:task.tracking!==false,source:selected.source,scanned:topic.comments.length,complete:topic.complete,submissionPending:false};
  const item={id:`${task.key}#discussion`,taskKey:task.key,course:task.courseName,courseId:task.courseId,clazzId:task.clazzId,knowledgeId:task.knowledgeId,secNo:task.secNo,sectionName:task.sectionName,questionIndex:1,qtype:'discussion',qtypeRaw:'讨论草稿',questionId:topic.identity.topicId,options:[],letters:[],textAnswer:text,aiAnswer,imagePath,requiresReview:true,autoFilled:false,filled:null,status:'pending-review',archive:{stemTextRaw:topic.title+'\n'+topic.body},discussion:{...selected,complete:topic.complete,total:topic.total},parseReason:selected.source==='popular-copy'?`复制已有回答：相同或近似内容出现 ${selected.matches} 次（已读取 ${topic.comments.length} 条${topic.complete?'，已读完':'，未读完全部评论'}）`:'未找到可用重复回答，由所选 AI 生成简短草稿'};
  mutateState(state=>{state.reviewQueue??=[];const index=state.reviewQueue.findIndex(it=>it.id===item.id);if(index<0)state.reviewQueue.push(item);else if(!state.reviewQueue[index].editedByHuman)state.reviewQueue[index]=item;});
  registerKeptPage(task.key,page,info);markSavedReviewPage(page);
  setTaskStatus(task.key,{status:'manual',note:'讨论草稿已生成，待你逐条核对后发布',progress:null});
  return {ok:false,phase:'awaiting-review',key:task.key,queued:1,source:selected.source};
 }catch(error){
  if(page&&!page.isClosed()){await page.close().catch(()=>{});releasePage(page);}
  if(error.code==='STOPPED')return {ok:false,phase:'stopped'};
  if(error.code==='VERIFICATION_REQUIRED')return {ok:false,phase:'needs-human',error:error.message};
  return {ok:false,phase:error.aiErrorCode?'blocked-ai':'failed',error:error.message,aiErrorCode:error.aiErrorCode,needsHuman:error.aiErrorCode?error.message:null};
 }
}
export async function reopenDiscussionReview(ctx,key,{personId,restoreAnswers=true}={}){
 const item=listReviewItems().find(item=>item.taskKey===key&&item.qtype==='discussion'),record=loadState().keptPages?.[key];
 if(!item||!record?.info?.identity)throw new Error('讨论草稿缺少定位信息，请重新读取讨论');
 const info=record.info;
 if(info.personId!==String(personId))throw new Error('学习通账号已变化，未打开讨论');
 let entry=getKeptPage(key),page=entry?.page;
 if(!page){page=await newTaskPage(ctx,'review');try{validateDiscussionIdentity(discussionIdentity(record.url),info.identity);await page.goto(record.url,{waitUntil:'domcontentloaded',timeout:60000});await waitTopic(page);registerKeptPage(key,page,info);}catch(error){await page.close().catch(()=>{});releasePage(page);throw error;}}
 setPageBusy(page,true);
 try{
  validateDiscussionIdentity(discussionIdentity(page.url()),info.identity);
  let topic=await readDiscussionComments(page);
  if(topic.userId!==info.userId)throw new Error('学习通账号已变化，未填写讨论');
  const own=topic.comments.find(c=>c.isSelf);
  if(own){const finished=info.tracking===false||(await (await import('./runner.mjs')).checkPointFinished(ctx,info.task,personId)).finished===true;finishDiscussion(key,finished,finished?'已核对本人讨论发布记录':'已发表讨论，尚未确认任务点完成');return {page,discussion:true,alreadySubmitted:true,ready:true,restored:0,taskFinished:finished};}
  if(info.submissionPending){
   // Only a fresh complete server list may resolve an uncertain request.
   await page.reload({waitUntil:'domcontentloaded'});await waitTopic(page);topic=await readDiscussionComments(page);
   if(topic.comments.some(c=>c.isSelf)){const finished=info.tracking===false||(await (await import('./runner.mjs')).checkPointFinished(ctx,info.task,personId)).finished===true;finishDiscussion(key,finished,finished?'已核对本人讨论发表与任务完成':'已核对本人讨论发布记录，任务点待确认');return {page,discussion:true,alreadySubmitted:true,ready:true,restored:0,taskFinished:finished};}
   throw new Error('上次讨论发布结果尚未确认，暂不重复发布；请在页面核对，草稿已保留');
  }
  if(restoreAnswers){
   if(topic.editorText&&discussionText(topic.editorText)!==discussionText(item.textAnswer)&&!item.editedByHuman)throw new Error('讨论编辑器已有不同草稿，未覆盖；请核对后保存');
   await fillDiscussionEditor(page,item.textAnswer);markReviewItem(item.id,{filled:{verified:true},status:'filled'});
  }
  return {page,discussion:true,alreadySubmitted:false,ready:!!item.textAnswer,restored:restoreAnswers?1:0,total:1};
 }finally{markSavedReviewPage(page);}
}
export function saveDiscussionDraft(id,text){
 text=discussionText(text);if(!text||text.length>MAX_DISCUSSION_ANSWER)throw new Error(`讨论正文须为1到${MAX_DISCUSSION_ANSWER}字符`);
 return updateReviewAnswer(id,{textAnswer:text,filled:null});
}
export async function syncDiscussionReview(key,entry){
 const info=entry.info,state=await readDiscussionPage(entry.page);
 validateDiscussionIdentity(state.identity,info.identity);
 if(state.userId!==info.userId||!state.comments.some(c=>c.isSelf))return false;
 const finished=info.tracking===false||(await (await import('./runner.mjs')).checkPointFinished(entry.page.context(),info.task,info.personId)).finished===true;
 finishDiscussion(key,finished,finished?'已核对本人讨论发表与任务完成':'已发表讨论，任务点完成状态待确认');return true;
}
export async function submitDiscussionReview(ctx,key,options={}){
 const prepared=await reopenDiscussionReview(ctx,key,{...options,restoreAnswers:true});
 if(prepared.alreadySubmitted)return {ok:true,alreadySubmitted:true,taskFinished:prepared.taskFinished};
 const info=getKeptPage(key).info,item=listReviewItems().find(it=>it.taskKey===key&&it.qtype==='discussion');
 setPageBusy(prepared.page,true);
 try{
  const savePending=value=>{const next={...info,submissionPending:value};mutateState(state=>{if(!state.keptPages?.[key])throw new Error('讨论定位记录丢失，未发布');state.keptPages[key].info=next;});const entry=getKeptPage(key);if(entry)entry.info=next;};
  const result=await publishDiscussionPage(prepared.page,{text:item.textAnswer,identity:info.identity,userId:info.userId,beforePublish:async()=>savePending(true)});
  if(!result.ok){if(!result.pending)savePending(false);return result;}
  const finished=info.tracking===false||(await (await import('./runner.mjs')).checkPointFinished(ctx,info.task,options.personId)).finished===true;
  finishDiscussion(key,finished,finished?'已核对讨论发表与任务完成':'讨论已发表，尚未确认任务点完成');
  return {...result,taskFinished:finished};
 }finally{if(!prepared.page.isClosed())markSavedReviewPage(prepared.page);}
}
