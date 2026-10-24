import {verifyZhihuishuDraft,zhihuishuHomeworkKey,matchesZhihuishuResult} from './quiz.mjs';
const attempts=new WeakMap();
const confirmation=page=>page.locator('.el-message-box').filter({has:page.locator('.el-message-box__message').filter({hasText:/^\s*是否确认提交[?？]\s*提交后[,，]\s*批阅过的试卷不能再修改[!！]?\s*$/})});
export async function readZhihuishuGrade(page,{task,paperKey}={}){
 if(page.isClosed())return null;
 const url=new URL(page.url());
 if(url.hostname==='onlineexamh5new.zhihuishu.com'&&/^#\/webExamList\/checkHomework\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/?]+(?:\?|$)/.test(url.hash)){
  const result=await page.evaluate(()=>{
   const text=e=>(e?.innerText||'').replace(/\s+/g,'').trim();
   const visible=e=>!!(e?.getBoundingClientRect().width&&e?.getBoundingClientRect().height)&&getComputedStyle(e).visibility!=='hidden';
   const fields=label=>[...document.querySelectorAll('.examInfo.hasNotes > ul > li')].filter(e=>visible(e)&&text(e.querySelector('label'))===label).map(e=>text(e.querySelector('span')));
   const scores=[...document.querySelectorAll('.examInfo.first-info > ul > li')].filter(e=>visible(e)&&/^得分[:：]?$/.test(text(e.querySelector('label')))).map(e=>text(e.querySelector('div')));
   const course=fields('名称'),chapter=fields('对应章节');
   return scores.length===1&&/^\d+(?:\.\d+)?$/.test(scores[0])&&course.length===1&&chapter.length===1?{score:Number(scores[0]),courseName:course[0],chapter:chapter[0]}:null;
  });
  if(!result)return null;
  const bound=paperKey&&matchesZhihuishuResult(paperKey,page.url());
  if(paperKey&&!bound)throw Object.assign(Error('成绩页与保存的作业身份不一致，未标记完成'),{code:'TASK_IDENTITY_CHANGED'});
  if(task){const normalized=value=>String(value||'').replace(/\s+/g,'');if((task.courseName&&normalized(task.courseName)!==result.courseName)||(task.secNo&&normalized(task.secNo)!==result.chapter)||!bound&&(!task.courseName||!task.secNo))throw Object.assign(Error('成绩页课程或章节与当前任务不一致，未标记完成'),{code:'TASK_IDENTITY_CHANGED'});}
  return {phase:'graded',...result};
 }
 const text=await page.locator('body').innerText();const match=/你本次获得的成绩是\s*(\d+(?:\.\d+)?)\s*分/.exec(text);
 if(match)return {phase:'graded',score:Number(match[1])};
 if(/作业提交成功|试卷提交成功/.test(text))return {phase:'submitted',score:null};return null;
}
/** Submission is a separate explicitly authorized action; unknown results never retry. */
export async function submitZhihuishuHomework({page,paperKey,answers,task,authorized=false,onStage=()=>{}}){
 if(!authorized)throw Error('尚未授权正式提交');
 if(zhihuishuHomeworkKey(page.url())!==paperKey&&!matchesZhihuishuResult(paperKey,page.url()))throw Error('待提交作业身份改变');
 const existing=await readZhihuishuGrade(page,{task,paperKey});
 if(existing)return {ok:true,...existing,alreadySubmitted:true};
 if(attempts.has(page))return attempts.get(page);
 let confirmed=false;
 const operation=(async()=>{
  if(zhihuishuHomeworkKey(page.url())!==paperKey)throw Error('待提交作业身份改变');
  const verified=await verifyZhihuishuDraft(page,{paperKey,answers});if(!verified.ok)return {ok:false,phase:'needs-review',verification:verified};
  const box=confirmation(page);let pending=await box.count()===1&&await box.isVisible();
  if(!pending){const submit=page.getByRole('button',{name:'提交作业',exact:true});if(await submit.count()!==1)throw Error('无法唯一定位提交按钮');onStage({stage:'open-submit-confirmation'});await submit.click();
   const deadline=Date.now()+8000;while(Date.now()<deadline){if(await box.count()===1&&await box.isVisible()){pending=true;break;}await page.waitForTimeout(100);}}
  if(!pending)return {ok:false,phase:'needs-review',reason:'submit-confirmation-unrecognized'};
  confirmed=true;onStage({stage:'confirm-submit',attempted:true});
  try{await box.getByRole('button',{name:'确定',exact:true}).click({timeout:8000});}catch(error){return {ok:false,phase:'needs-verification',reason:'confirmation-result-unknown',detail:error.message};}
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(page.isClosed())return {ok:false,phase:'needs-verification',reason:'page-closed-after-confirmation'};
   try{const result=await readZhihuishuGrade(page,{task,paperKey});if(result){onStage({stage:result.phase,score:result.score});return {ok:true,...result};}}catch{}
   await page.waitForTimeout(250).catch(()=>{});
  }
  return {ok:false,phase:'needs-verification',reason:'platform-result-not-confirmed'};
 })();attempts.set(page,operation);operation.finally(()=>{if(!confirmed&&attempts.get(page)===operation)attempts.delete(page);}).catch(()=>{});return operation;
}
