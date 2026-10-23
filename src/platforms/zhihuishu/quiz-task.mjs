import fs from 'node:fs';import path from 'node:path';
import {PATHS,loadSettings} from '../../config.mjs';
import {askImage} from '../../ai/ai.mjs';import {selectedProvider,ensureProviderPage} from '../../ai/providers.mjs';
import {throwIfStopped} from '../../control.mjs';import {mutateState,loadState,listReviewItems,setTaskStatus,clearReviewByTask} from '../../state.mjs';
import {newTaskPage,releasePage,markSavedReviewPage} from '../../browser/pages.mjs';
import {registerKeptPage,getKeptPage,dropKeptPage} from '../../chaoxing/quizrun.mjs';
import {isZhihuishuUrl,readZhihuishuPage} from './read-page.mjs';import {scanGuard,waitScanPage} from './scan.mjs';
import {dismissZhihuishuNotices} from './notices.mjs';import {answerZhihuishuHomework} from './quiz-run.mjs';
import {extractZhihuishuQuestions,zhihuishuHomeworkKey,fillZhihuishuChoice,verifyZhihuishuDraft} from './quiz.mjs';
import {readZhihuishuGrade,submitZhihuishuHomework} from './quiz-submit.mjs';
const saved=key=>loadState().quizzes?.[key];
function checkpoint(task,data){
 mutateState(s=>{s.quizzes||={};s.quizzes[task.key]={...s.quizzes[task.key],...data,task,platform:'zhihuishu'};s.reviewQueue||=[];
 for(const question of data.questions||data.answers||[]){const answer=data.answers?.find(a=>a.questionId===question.questionId),id=task.key+':question:'+question.questionId,previous=s.reviewQueue.find(i=>i.id===id);const item={id,platform:'zhihuishu',taskKey:task.key,course:task.courseName,secNo:task.secNo,sectionName:task.name,...question,...answer,aiAnswer:answer?.rawAI||'',aiError:answer?null:'本题尚未完成，可继续重试',autoFilled:!!answer,confidence:answer?'high':'none',confidenceLabel:answer?'已核对选项':'待继续',validation:{safe:!!answer,errors:[]},status:'pending-review'};if(previous)Object.assign(previous,item);else s.reviewQueue.push(item);}});
}
async function followPopup(page,click,shouldStop){
 await page.evaluate(()=>{window.__scanDestinations=[]});const before=page.url();await click();
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){throwIfStopped(shouldStop);const value=await page.evaluate(()=>window.__scanDestinations?.find(u=>u&&u!=='about:blank')).catch(()=>null);
  if(value){const url=new URL(value,before);if(!isZhihuishuUrl(url.href)||url.hostname!=='onlineexamh5new.zhihuishu.com')throw Error('不是已适配的智慧树章节作业入口');await page.goto(url.href,{waitUntil:'domcontentloaded'});return;}
  if(page.url()!==before)return;await page.waitForTimeout(100);
 }throw Error('章节作业页面未打开');
}
async function activateCourseEntry(page,entry){
 if(await entry.count()!==1)throw Error('课程入口无法唯一定位');
 await dismissZhihuishuNotices(page);
 const before=page.url();
 try{await entry.click({timeout:2000});}
 catch(error){
  if(page.url()!==before||await page.evaluate(()=>window.__scanDestinations?.some(u=>u&&u!=='about:blank')).catch(()=>false))return;
  // The fixed-width course sidebar can sit outside an embedded viewport.
  // Use the identified site's own click handler, without changing its URL/state.
  if((await readZhihuishuPage(page)).blockers.length)throw Error('智慧树需要本人处理网页提示，未打开测验');
  if(await entry.count()!==1||!await entry.isVisible())throw error;
  await entry.evaluate(element=>element.click());
 }
}
export async function waitZhihuishuHomeworkEntry(page,task,{shouldStop,timeoutMs=25000,loginGraceMs=8000}={}){
 const deadline=Date.now()+timeoutMs;let loginSince=0;
 while(Date.now()<deadline){
  throwIfStopped(shouldStop);
  try{
   const state=await readZhihuishuPage(page);
   if(state.blockers.length)throw Object.assign(Error('智慧树测验入口需要本人处理网页提示'),{code:state.blockers.includes('user-consent')?'USER_CONSENT_REQUIRED':'VERIFICATION_REQUIRED'});
   if(await readZhihuishuGrade(page,{task}))return 'graded';
   if(zhihuishuHomeworkKey(page.url())&&await page.locator('.examPaper_subject').first().isVisible())return 'paper';
   if(await page.locator('.examItemWrap').first().isVisible())return 'list';
   const url=new URL(page.url()),login=state.loginState==='signed-out'||url.hostname==='studentexam-api.zhihuishu.com'&&/\/gologin\/login/.test(url.pathname);
   if(login){loginSince||=Date.now();if(Date.now()-loginSince>=loginGraceMs)throw Object.assign(Error('智慧树测验登录跳转持续未恢复，请在保留的软件内网页确认登录'),{code:'LOGIN_REQUIRED'});}else loginSince=0;
  }catch(error){if(!/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(error.message))throw error;}
  await page.waitForTimeout(150);
 }
 throw Error('智慧树本章作业列表、题面或已提交成绩尚未加载，未点击重做');
}
export async function openZhihuishuTask(context,task,{shouldStop}={}){
 if(task.platform!=='zhihuishu'||task.type!=='work'||!isZhihuishuUrl(task.studyUrl))throw Error('智慧树测验身份不完整');
 const page=await newTaskPage(context,'quiz');
 try{await page.addInitScript(scanGuard);await page.goto(task.studyUrl,{waitUntil:'domcontentloaded'});
 const state=await waitScanPage(page,s=>s.pageKind==='study'&&s.videos.length>0&&s.chapterTests.some(t=>t.key===task.platformTaskKey),{shouldStop});
 if(state.course?.key!==task.courseId)throw Error('测验课程身份改变');await dismissZhihuishuNotices(page);
 const tests=state.chapterTests.filter(t=>t.key===task.platformTaskKey);if(tests.length!==1)throw Error('无法唯一定位本章测验，请重新扫描');
 await followPopup(page,()=>activateCourseEntry(page,page.locator('li.chapter-test').nth(tests[0].index)),shouldStop);
 let destination=await waitZhihuishuHomeworkEntry(page,task,{shouldStop});
 if(destination==='graded')return page;
 if(destination==='list'){
  const rows=page.locator('.examItemWrap').filter({has:page.locator('.course_ewname').filter({hasText:task.secNo})});
  await rows.first().waitFor({timeout:15000});if(await rows.count()!==1)throw Error('同章作业不唯一，请在智慧树网页人工选择');
  const action=rows.getByText(/^(开始答题|继续答题|查看成绩|查看试卷)$/,{exact:true});if(await action.count()!==1)throw Error('本章可能已提交或不允许作答，未点击重做');
  await followPopup(page,()=>activateCourseEntry(page,action),shouldStop);
  destination=await waitZhihuishuHomeworkEntry(page,task,{shouldStop});
  if(destination==='graded')return page;
 }
 await page.locator('.examPaper_subject').first().waitFor({timeout:15000});if(!zhihuishuHomeworkKey(page.url()))throw Error('不是普通章节作业，未进入答题');
 return page;
 }catch(error){
  const host=(()=>{try{return new URL(page.url()).hostname}catch{return ''}})();
  if(['login.zhihuishu.com','passport.zhihuishu.com'].includes(host))error=Object.assign(Error('智慧树测验登录已失效，请在软件内网页重新登录后再继续'),{code:'LOGIN_REQUIRED'});
  releasePage(page);throw Object.assign(error,{taskPage:page});
 }
}
async function saveCurrent(page,{complete=true}={}){const button=page.getByRole('button',{name:'保存',exact:true});if(await button.count()!==1)throw Error('当前题保存按钮不唯一');await button.click();if(complete)await page.waitForFunction(()=>/完成率\s*100%/.test(document.body.innerText),null,{timeout:15000});}
export async function runZhihuishuQuiz({task,context,shouldStop,onProgress=()=>{},restartTask=false},{ask=askImage,open=openZhihuishuTask}={}){
 let page,completed=false;
 try{
  const previous=saved(task.key);
  if(previous?.submitted){completed=true;return {ok:true,phase:'submitted'};}
  if(!restartTask&&previous?.answers?.length===previous?.total&&previous?.total>0)return {ok:true,phase:'awaiting-review'};
  if(restartTask){
   // Answers are checkpointed per question. Close only this task's old page,
   // leaving the saved paper identity/answers intact for the normal restore path.
   const old=getKeptPage(task.key)?.page;
   if(old&&!old.isClosed()){
    const state=await readZhihuishuPage(old).catch(()=>null);
    if(state?.blockers.includes('user-consent'))return {ok:false,phase:'needs-human',code:'USER_CONSENT_REQUIRED',error:'请本人处理保留页面的承诺书'};
    releasePage(old);await old.close();dropKeptPage(task.key);
   }
  }
  page=await open(context,task,{shouldStop});
  const grade=await readZhihuishuGrade(page,{task});
  if(grade?.phase==='graded'){
   mutateState(s=>{s.quizzes||={};s.quizzes[task.key]={...s.quizzes[task.key],task,platform:'zhihuishu',submitted:true,score:grade.score,url:page.url()};});
   clearReviewByTask(task.key);completed=true;return {ok:true,phase:'already-finished',score:grade.score};
  }
  setTaskStatus(task.key,{status:'running',platform:'zhihuishu'});
  const provider=selectedProvider(loadSettings()),aiPage=await ensureProviderPage(context,provider);
  const directory=path.join(PATHS.answers,'zhihuishu',Date.now()+'-'+Math.random().toString(36).slice(2,8));fs.mkdirSync(directory,{recursive:true});
  const result=await answerZhihuishuHomework({page,shouldStop,previous:previous?.paperKey?previous:undefined,imagePathFor:index=>path.join(directory,index+'.png'),
   askImage:args=>ask({...args,page:aiPage,shouldStop,platform:'zhihuishu',taskKey:task.key,freshChat:true}),
   checkpoint:data=>checkpoint(task,{...data,url:page.url()}),onStage:stage=>onProgress({taskType:'work',phase:stage.stage,questionIndex:stage.index,questionTotal:stage.total})});
  await saveCurrent(page);await page.reload({waitUntil:'domcontentloaded'});const verify=await verifyZhihuishuDraft(page,result);if(!verify.ok)throw Error('保存后答案未匹配，已留在待审');
  checkpoint(task,{...result,url:page.url(),saved:true});return {ok:true,phase:'awaiting-review'};
 }catch(error){
  page||=error.taskPage;if(error.code==='STOPPED')return {ok:false,phase:'stopped'};
  const state=page&&!page.isClosed()?await readZhihuishuPage(page).catch(()=>null):null;
  const code=state?.blockers.includes('user-consent')?'USER_CONSENT_REQUIRED':state?.blockers.includes('human-verification')?'VERIFICATION_REQUIRED':error.code;
  return {ok:false,phase:'needs-human',error:error.message,code,verificationPlatform:code==='VERIFICATION_REQUIRED'?'zhihuishu':undefined};
 }
 finally{const hasReview=listReviewItems().some(i=>i.taskKey===task.key);setTaskStatus(task.key,{status:completed?'done':hasReview?'manual':'pending',platform:'zhihuishu'});
  if(completed){dropKeptPage(task.key);if(page&&!page.isClosed()){releasePage(page);await page.close();}}
  else if(page&&!page.isClosed()){registerKeptPage(task.key,page,{platform:'zhihuishu',course:task.courseName,secNo:task.secNo,name:task.name});markSavedReviewPage(page);releasePage(page);}
 }
}
export async function restoreZhihuishuReview(context,key){
 const record=saved(key);if(!record?.task||!record.answers?.length)throw Error('智慧树待审草稿不完整');
 let page=getKeptPage(key)?.page;if(!page||page.isClosed())page=await openZhihuishuTask(context,record.task);
 const samePaper=zhihuishuHomeworkKey(page.url())===record.paperKey,grade=await readZhihuishuGrade(page,{task:record.task});
 if(grade&&(samePaper||grade.courseName&&grade.chapter)){clearReviewByTask(key);setTaskStatus(key,{status:'done'});dropKeptPage(key);mutateState(s=>{s.quizzes[key].submitted=true;});return {page,alreadySubmitted:true};}
 if(!samePaper)throw Error('重新打开的作业身份改变，未回填');
 const questions=await extractZhihuishuQuestions(page);
 if(questions.length!==record.total)throw Error('作业题数改变，已保留草稿');
 // A fresh open begins at question 1; use stable option IDs, never old letters.
 if(!questions[0]?.visible){const url=page.url();await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('.examPaper_subject').first().waitFor();}
 const restored=[];
 const last=Math.max(...record.answers.map(a=>questions.findIndex(q=>q.questionId===a.questionId)));
 if(last<0||record.answers.some(a=>!questions.some(q=>q.questionId===a.questionId)))throw Error('已保存题目不在当前作业中');
 for(let index=0;index<=last;index++){
  const current=(await extractZhihuishuQuestions(page)).find(q=>q.visible),answer=record.answers.find(a=>a.questionId===questions[index].questionId);
  if(!current||current.questionId!==questions[index].questionId)throw Error('恢复题序变化，已停止回填');
  if(answer){
  const ids=new Set(answer.optionIds),options=current.options.filter(o=>ids.has(o.optionId));if(options.length!==ids.size)throw Error('题目选项改变，未使用旧答案');
  const result=await fillZhihuishuChoice(page,current,options.map(o=>o.letter));if(!result.ok)throw Error('恢复答案回读不一致');restored.push({...answer,letters:options.map(o=>o.letter)});
  }
  if(index<last){await page.getByRole('button',{name:'下一题',exact:true}).click();await page.waitForFunction(id=>{const root=[...document.querySelectorAll('.examPaper_subject')].find(e=>e.getBoundingClientRect().width);return root?.querySelector('.subject_num [id^=anchor_]')?.id==='anchor_'+id;},questions[index+1].questionId,{timeout:15000});}
 }
 await saveCurrent(page,{complete:record.answers.length===record.total});await page.reload({waitUntil:'domcontentloaded'});const verified=await verifyZhihuishuDraft(page,{paperKey:record.paperKey,answers:restored,allowPartial:true,total:record.total});if(!verified.ok)throw Error('恢复后保存结果未确认');
 registerKeptPage(key,page,{platform:'zhihuishu',course:record.task.courseName,secNo:record.task.secNo,name:record.task.name});markSavedReviewPage(page);checkpoint(record.task,{...record,answers:restored,saved:true});return {page,restored:restored.length,total:record.total,ready:restored.length===record.total,missing:record.total-restored.length};
}
export async function submitZhihuishuReview(context,key){
 const pending=saved(key);if(!pending?.total||pending.answers?.length!==pending.total)throw Error('仍有未完成题目，请先继续未完成题目；已保存答案不会重复询问 AI');
 const {page,alreadySubmitted}=await restoreZhihuishuReview(context,key);if(alreadySubmitted)return {submitted:1,failed:0,details:[{key,ok:true,alreadySubmitted:true}]};
 const record=saved(key),result=await submitZhihuishuHomework(page,{paperKey:record.paperKey,answers:record.answers,authorized:true});
 if(result.ok){clearReviewByTask(key);setTaskStatus(key,{status:'done',platform:'zhihuishu'});dropKeptPage(key);mutateState(s=>{s.quizzes[key].submitted=true;});}
 return {submitted:result.ok?1:0,failed:result.ok?0:1,details:[{key,ok:result.ok,error:result.ok?null:result.reason||'平台提交结果尚未确认'}]};
}
export async function editZhihuishuReview(context,item,letters){
 if(!Array.isArray(letters)||!letters.length)throw Error('答案不能为空');const options=item.options.filter(o=>letters.includes(o.letter));if(options.length!==new Set(letters).size)throw Error('答案无法映射到保存的选项');
 mutateState(s=>{const r=s.quizzes[item.taskKey],answer=r?.answers.find(a=>a.questionId===item.questionId);if(!answer)throw Error('草稿题目不存在');answer.letters=letters;answer.optionIds=options.map(o=>o.optionId);});
 await restoreZhihuishuReview(context,item.taskKey);return listReviewItems().find(i=>i.id===item.id);
}
export async function syncZhihuishuReviews(context){
 if(!context)return 0;let count=0;
 for(const key of new Set(listReviewItems().filter(i=>i.platform==='zhihuishu').map(i=>i.taskKey))){
  const record=saved(key);if(!record?.paperKey)continue;
  const page=context.pages().find(p=>zhihuishuHomeworkKey(p.url())===record.paperKey);
  if(page&&await readZhihuishuGrade(page)){clearReviewByTask(key);setTaskStatus(key,{status:'done',platform:'zhihuishu'});dropKeptPage(key);mutateState(s=>{s.quizzes[key].submitted=true;});count++;}
 }return count;
}
