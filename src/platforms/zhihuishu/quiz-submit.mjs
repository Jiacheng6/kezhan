import {verifyZhihuishuDraft,zhihuishuHomeworkKey} from './quiz.mjs';
const attempts=new WeakMap();
const confirmation=page=>page.locator('.el-message-box').filter({has:page.locator('.el-message-box__message').filter({hasText:/^\s*是否确认提交[?？]\s*提交后[,，]\s*批阅过的试卷不能再修改[!！]?\s*$/})});
export async function readZhihuishuGrade(page){
 if(page.isClosed())return null;
 const text=await page.locator('body').innerText();const match=/你本次获得的成绩是\s*(\d+(?:\.\d+)?)\s*分/.exec(text);
 if(match)return {phase:'graded',score:Number(match[1])};
 if(/作业提交成功|试卷提交成功/.test(text))return {phase:'submitted',score:null};return null;
}
/** Submission is a separate explicitly authorized action; unknown results never retry. */
export async function submitZhihuishuHomework({page,paperKey,answers,authorized=false,onStage=()=>{}}){
 if(!authorized)throw Error('尚未授权正式提交');if(attempts.has(page))return attempts.get(page);
 let confirmed=false;
 const operation=(async()=>{
  if(zhihuishuHomeworkKey(page.url())!==paperKey)throw Error('待提交作业身份改变');
  const existing=await readZhihuishuGrade(page);if(existing?.phase==='graded')return {ok:true,...existing,alreadySubmitted:true};
  const verified=await verifyZhihuishuDraft(page,{paperKey,answers});if(!verified.ok)return {ok:false,phase:'needs-review',verification:verified};
  const box=confirmation(page);let pending=await box.count()===1&&await box.isVisible();
  if(!pending){const submit=page.getByRole('button',{name:'提交作业',exact:true});if(await submit.count()!==1)throw Error('无法唯一定位提交按钮');onStage({stage:'open-submit-confirmation'});await submit.click();
   const deadline=Date.now()+8000;while(Date.now()<deadline){if(await box.count()===1&&await box.isVisible()){pending=true;break;}await page.waitForTimeout(100);}}
  if(!pending)return {ok:false,phase:'needs-review',reason:'submit-confirmation-unrecognized'};
  confirmed=true;onStage({stage:'confirm-submit',attempted:true});
  try{await box.getByRole('button',{name:'确定',exact:true}).click({timeout:8000});}catch(error){return {ok:false,phase:'needs-verification',reason:'confirmation-result-unknown',detail:error.message};}
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(page.isClosed())return {ok:false,phase:'needs-verification',reason:'page-closed-after-confirmation'};
   try{const result=await readZhihuishuGrade(page);if(result?.phase==='graded'){onStage({stage:'graded',score:result.score});return {ok:true,...result};}}catch{}
   await page.waitForTimeout(250).catch(()=>{});
  }
  return {ok:false,phase:'needs-verification',reason:'platform-result-not-confirmed'};
 })();attempts.set(page,operation);operation.finally(()=>{if(!confirmed&&attempts.get(page)===operation)attempts.delete(page);}).catch(()=>{});return operation;
}
