import fs from 'node:fs';import path from 'node:path';
import {PATHS,loadSettings} from '../../config.mjs';
import {notifyUser} from '../../logbus.mjs';
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
 for(const answer of data.answers||[]){const id=task.key+':question:'+answer.questionId,previous=s.reviewQueue.find(i=>i.id===id);const item={id,platform:'zhihuishu',taskKey:task.key,course:task.courseName,secNo:task.secNo,sectionName:task.name,...answer,aiAnswer:answer.rawAI,autoFilled:true,confidence:'high',confidenceLabel:'已核对选项',validation:{safe:true,errors:[]},status:'pending-review'};if(previous)Object.assign(previous,item);else s.reviewQueue.push(item);}});
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
export async function openZhihuishuTask(context,task,{shouldStop}={}){
 if(task.platform!=='zhihuishu'||task.type!=='work'||!isZhihuishuUrl(task.studyUrl))throw Error('智慧树测验身份不完整');
 const page=await newTaskPage(context,'quiz');
 try{await page.addInitScript(scanGuard);await page.goto(task.studyUrl,{waitUntil:'domcontentloaded'});
 const state=await waitScanPage(page,s=>s.pageKind==='study'&&s.videos.length>0&&s.chapterTests.some(t=>t.key===task.platformTaskKey),{shouldStop});
 if(state.course?.key!==task.courseId)throw Error('测验课程身份改变');await dismissZhihuishuNotices(page);
 const tests=state.chapterTests.filter(t=>t.key===task.platformTaskKey);if(tests.length!==1)throw Error('无法唯一定位本章测验，请重新扫描');
 await followPopup(page,()=>activateCourseEntry(page,page.locator('li.chapter-test').nth(tests[0].index)),shouldStop);
 if(!zhihuishuHomeworkKey(page.url())){
  const rows=page.locator('.examItemWrap').filter({has:page.locator('.course_ewname').filter({hasText:task.secNo})});
  await rows.first().waitFor({timeout:15000});if(await rows.count()!==1)throw Error('同章作业不唯一，请在智慧树网页人工选择');
  const action=rows.getByText(/^(开始答题|继续答题)$/,{exact:true});if(await action.count()!==1)throw Error('本章可能已提交或不允许作答，未点击重做');
  await followPopup(page,()=>activateCourseEntry(page,action),shouldStop);
 }
 await page.locator('.examPaper_subject').first().waitFor({timeout:15000});if(!zhihuishuHomeworkKey(page.url()))throw Error('不是普通章节作业，未进入答题');
 return page;
 }catch(error){
  const host=(()=>{try{return new URL(page.url()).hostname}catch{return ''}})();
  if(['login.zhihuishu.com','passport.zhihuishu.com'].includes(host))error=Object.assign(Error('智慧树测验登录已失效，请在软件内网页重新登录后再继续'),{code:'LOGIN_REQUIRED'});
  releasePage(page);throw Object.assign(error,{taskPage:page});
 }
}
async function saveCurrent(page){const button=page.getByRole('button',{name:'保存',exact:true});if(await button.count()!==1)throw Error('最后一题保存按钮不唯一');await button.click();await page.waitForFunction(()=>/完成率\s*100%/.test(document.body.innerText),null,{timeout:15000});}
export async function runZhihuishuQuiz({task,context,shouldStop,onProgress=()=>{}},{ask=askImage,open=openZhihuishuTask}={}){
 let page;
 try{
  if(listReviewItems().some(i=>i.taskKey===task.key))return {ok:true,phase:'awaiting-review'};
  page=await open(context,task,{shouldStop});setTaskStatus(task.key,{status:'running',platform:'zhihuishu'});
  const provider=selectedProvider(loadSettings()),aiPage=await ensureProviderPage(context,provider);
  const directory=path.join(PATHS.answers,'zhihuishu',Date.now()+'-'+Math.random().toString(36).slice(2,8));fs.mkdirSync(directory,{recursive:true});
  const result=await answerZhihuishuHomework({page,shouldStop,imagePathFor:index=>path.join(directory,index+'.png'),
   askImage:args=>ask({...args,page:aiPage,shouldStop,platform:'zhihuishu',taskKey:task.key,freshChat:true}),
   checkpoint:data=>checkpoint(task,{...data,url:page.url()}),onStage:stage=>onProgress({taskType:'work',phase:stage.stage,questionIndex:stage.index,questionTotal:stage.total})});
  await saveCurrent(page);await page.reload({waitUntil:'domcontentloaded'});const verify=await verifyZhihuishuDraft(page,result);if(!verify.ok)throw Error('保存后答案未匹配，已留在待审');
  checkpoint(task,{...result,url:page.url(),saved:true});return {ok:true,phase:'awaiting-review'};
 }catch(error){page||=error.taskPage;if(error.code==='STOPPED')return {ok:false,phase:'stopped'};if(error.code==='LOGIN_REQUIRED')notifyUser('zhihuishu-login',{key:task.key+':login',detail:error.message});return {ok:false,phase:'needs-human',error:error.message};}
 finally{const hasReview=listReviewItems().some(i=>i.taskKey===task.key);setTaskStatus(task.key,{status:hasReview?'manual':'pending',platform:'zhihuishu'});
  if(page&&!page.isClosed()){registerKeptPage(task.key,page,{platform:'zhihuishu',course:task.courseName,secNo:task.secNo,name:task.name});markSavedReviewPage(page);releasePage(page);}
 }
}
export async function restoreZhihuishuReview(context,key){
 const record=saved(key);if(!record?.task||!record.answers?.length)throw Error('智慧树待审草稿不完整');
 let page=getKeptPage(key)?.page;if(!page||page.isClosed())page=await openZhihuishuTask(context,record.task);
 if(zhihuishuHomeworkKey(page.url())!==record.paperKey)throw Error('重新打开的作业身份改变，未回填');
 if(await readZhihuishuGrade(page)){clearReviewByTask(key);setTaskStatus(key,{status:'done'});return {page,alreadySubmitted:true};}
 const questions=await extractZhihuishuQuestions(page);
 if(questions.length!==record.total||record.answers.length!==record.total)throw Error('只保存了部分题目，请在原网页核对；不会当作整卷完成');
 // A fresh open begins at question 1; use stable option IDs, never old letters.
 if(!questions[0]?.visible){const url=page.url();await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('.examPaper_subject').first().waitFor();}
 const restored=[];
 for(let index=0;index<record.answers.length;index++){
  const answer=record.answers[index],current=(await extractZhihuishuQuestions(page)).find(q=>q.visible);
  if(!current||current.questionId!==answer.questionId)throw Error('恢复题序变化，已停止回填');
  const ids=new Set(answer.optionIds),options=current.options.filter(o=>ids.has(o.optionId));if(options.length!==ids.size)throw Error('题目选项改变，未使用旧答案');
  const result=await fillZhihuishuChoice(page,current,options.map(o=>o.letter));if(!result.ok)throw Error('恢复答案回读不一致');restored.push({...answer,letters:options.map(o=>o.letter)});
  if(index<record.answers.length-1){await page.getByRole('button',{name:'下一题',exact:true}).click();await page.waitForFunction(id=>{const root=[...document.querySelectorAll('.examPaper_subject')].find(e=>e.getBoundingClientRect().width);return root?.querySelector('.subject_num [id^=anchor_]')?.id==='anchor_'+id;},record.answers[index+1].questionId,{timeout:15000});}
 }
 await saveCurrent(page);await page.reload({waitUntil:'domcontentloaded'});const verified=await verifyZhihuishuDraft(page,{paperKey:record.paperKey,answers:restored});if(!verified.ok)throw Error('恢复后保存结果未确认');
 registerKeptPage(key,page,{platform:'zhihuishu',course:record.task.courseName,secNo:record.task.secNo,name:record.task.name});markSavedReviewPage(page);checkpoint(record.task,{...record,answers:restored,saved:true});return {page,restored:restored.length,total:restored.length};
}
export async function submitZhihuishuReview(context,key){
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
