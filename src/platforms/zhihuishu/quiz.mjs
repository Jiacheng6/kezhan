import {isZhihuishuUrl,readZhihuishuPage} from './read-page.mjs';
export function zhihuishuHomeworkKey(value){
 try{const u=new URL(value);if(!isZhihuishuUrl(value)||u.hostname!=='onlineexamh5new.zhihuishu.com'||!u.hash.startsWith('#/webExamList/dohomework/'))return null;const parts=u.hash.split('?')[0].split('/').slice(3);return parts.length>=6&&parts.every(Boolean)?'zhihuishu:homework:'+parts.map(encodeURIComponent).join(':'):null;}catch{return null;}
}
// The site's result route preserves recruit/student-exam/exam/course/school;
// only the homework route adds meetCourseType. Never match by title alone.
export function matchesZhihuishuResult(paperKey,value){
 try{
  const prefix='zhihuishu:homework:',u=new URL(value);
  if(typeof paperKey!=='string'||!paperKey.startsWith(prefix)||!isZhihuishuUrl(value)||u.hostname!=='onlineexamh5new.zhihuishu.com'||!u.hash.startsWith('#/webExamList/checkHomework/'))return false;
  const expected=paperKey.slice(prefix.length).split(':'),actual=u.hash.split('?')[0].split('/').slice(3);
  return expected.length===6&&actual.length===5&&actual.every(Boolean)&&actual.every((v,i)=>encodeURIComponent(v)===expected[i]);
 }catch{return false;}
}
/** Question identity/options are DOM based; the displayed stem must be captured as an image. */
export async function extractZhihuishuQuestions(page){
 const paperKey=zhihuishuHomeworkKey(page.url());if(!paperKey)throw Error('不是已识别的智慧树普通章节作业页面');
 const questions=await page.locator('.examPaper_subject').evaluateAll(roots=>roots.map((root,domIndex)=>{
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const raw=text(root.querySelector('.subject_type')),qtype=/多选/.test(raw)?'multiple':/单选/.test(raw)?'single':/判断/.test(raw)?'judge':/填空/.test(raw)?'fill':/简答|论述|分析/.test(raw)?'essay':'unknown';
  const questionId=root.querySelector('.subject_num [id^=anchor_]')?.id.slice(7)||null;
  let selectedIds=[];try{const a=JSON.parse(root.querySelector(':scope > input[type=hidden]')?.value||'[]');if(Array.isArray(a))selectedIds=a.map(String);}catch{}
  const options=[...root.querySelectorAll('.subject_node .nodeLab')].map((e,optionIndex)=>{
   const input=e.querySelector('input[type=radio],input[type=checkbox]'),body=text(e.querySelector('.node_detail'));
   const label=[...e.querySelectorAll('span')].map(text).find(s=>/^[A-Z][.．、]$/.test(s))||'';const displayLetter=label.replace(/[.．、]$/,'');
   const truth=/^(对|正确|是|true)$/i.test(body)?'true':/^(错|错误|否|false)$/i.test(body)?'false':null;
   return {letter:qtype==='judge'?(truth||displayLetter):displayLetter,displayLetter,optionId:input?.value||null,text:body,domIndex:optionIndex,selected:!!input?.checked||selectedIds.includes(String(input?.value))||!!e.querySelector('.ABCase.onChecked,.mr10.onChecked,.node_detail.onChecked')};
  });
  return {questionId,questionIndex:Number(text(root.querySelector('.subject_num')).replace(/\D/g,''))||null,domIndex,qtype,qtypeRaw:raw,visible:!!root.getBoundingClientRect().width,requiresImage:true,options,selected:options.filter(o=>o.selected).map(o=>o.letter)};
 }));
 if(zhihuishuHomeworkKey(page.url())!==paperKey)throw Error('读取期间作业身份改变');return questions.map(q=>({...q,paperKey}));
}
const fingerprint=q=>JSON.stringify(q.options.map(o=>[o.letter,o.displayLetter,o.optionId,o.text]));
export async function fillZhihuishuChoice(page,question,letters){
 if(!question?.questionId||question.paperKey!==zhihuishuHomeworkKey(page.url()))throw Error('作业身份或题目标识不匹配');
 const current=(await extractZhihuishuQuestions(page)).find(q=>q.questionId===question.questionId);
 if(!current?.visible||current.qtype!==question.qtype||fingerprint(current)!==fingerprint(question))throw Error('题目或选项顺序已变化，请重新读取');
 if(!['single','multiple','judge'].includes(current.qtype))throw Error('当前题型尚未验证');
 const chosen=[...new Set(letters||[])];if(!chosen.length||chosen.length!==(letters||[]).length||current.qtype!=='multiple'&&chosen.length!==1||chosen.some(l=>!current.options.some(o=>o.letter===l))||new Set(current.options.map(o=>o.letter)).size!==current.options.length)throw Error('答案不能唯一映射到本题选项');
 const root=page.locator('.examPaper_subject').nth(current.domIndex);
 const readback=async()=>{
  const state=await readZhihuishuPage(page);if(state.blockers.length)throw Object.assign(Error('智慧树回填被网页验证或提示阻挡，保留本题'),{code:state.blockers.includes('user-consent')?'USER_CONSENT_REQUIRED':state.blockers.includes('progress-save-failed')?'PROGRESS_SAVE_FAILED':'VERIFICATION_REQUIRED'});
  const q=(await extractZhihuishuQuestions(page)).find(q=>q.questionId===question.questionId);
  if(!q?.visible||q.qtype!==current.qtype||fingerprint(q)!==fingerprint(current))throw Object.assign(Error('回填期间题目或选项身份改变，已停止'),{code:'TASK_IDENTITY_CHANGED'});
  return q;
 };
 for(const option of current.options){
  const need=chosen.includes(option.letter),before=await readback();
  if(need!==before.options[option.domIndex].selected&&(current.qtype==='multiple'||need)){
   await root.locator('.subject_node .nodeLab .label').nth(option.domIndex).click();
   const deadline=Date.now()+5000;let changed=false;
   while(Date.now()<deadline){const q=await readback();if(q.options[option.domIndex].selected===need){changed=true;break;}await page.waitForTimeout(100);}
   if(!changed)return {ok:false,reason:'selection-readback-mismatch',selected:(await readback()).selected};
  }
 }
 const expected=[...chosen].sort(),deadline=Date.now()+5000;let after,stableAt=0;
 while(Date.now()<deadline){after=await readback();if(JSON.stringify([...after.selected].sort())===JSON.stringify(expected)){stableAt||=Date.now();if(Date.now()-stableAt>=250)break;}else stableAt=0;await page.waitForTimeout(100);}
 if(!stableAt||Date.now()-stableAt<250)return {ok:false,reason:'selection-readback-mismatch',selected:after.selected};
 return {ok:true,selected:after.selected,questionId:after.questionId};
}
export async function saveZhihuishuDraft(page,{paperKey,timeoutMs=10000}={}){
 if(!paperKey||zhihuishuHomeworkKey(page.url())!==paperKey)throw Error('暂存前作业身份不匹配');
 const confirmation=page.locator('.el-message-box').filter({has:page.locator('.el-message-box__message').filter({hasText:/^\s*你确定要暂存作业吗[？?]?\s*$/})});
 const pending=await confirmation.count()===1&&await confirmation.isVisible();
 const quietDeadline=Date.now()+6000;while(await page.locator('.el-message__content:visible').count()){if(Date.now()>quietDeadline)return {ok:false,phase:'needs-verification',reason:'previous-message-still-visible',confirmed:false};await page.waitForTimeout(100);}
 if(!pending){const save=page.getByRole('button',{name:'暂存作业',exact:true});if(await save.count()!==1)throw Error('无法唯一定位暂存按钮');await save.click();}
 const deadline=Date.now()+timeoutMs;let confirmed=false;
 try{
 while(Date.now()<deadline){
  if(!confirmed&&await confirmation.count()===1&&await confirmation.isVisible()){
   if(zhihuishuHomeworkKey(page.url())!==paperKey)throw Error('暂存确认前作业身份改变');
   confirmed=true;await confirmation.getByRole('button',{name:'确定',exact:true}).click();
  }
  const messages=await page.locator('.el-message__content').allTextContents(),message=messages.join(' ');
  if(/暂存成功|保存成功|作业已暂存/.test(message))return {ok:true,message,confirmed};
  if(/失败|错误/.test(message))return {ok:false,message,confirmed};await page.waitForTimeout(100);
 }
 }catch(error){if(page.isClosed())return {ok:false,phase:'needs-verification',reason:confirmed?'page-closed-after-confirmation':'page-closed',confirmed};throw error;}
 return {ok:false,phase:'needs-verification',reason:'save-result-unconfirmed',confirmed};
}

/** Reloaded homework restores selections after the question skeleton mounts. */
export async function verifyZhihuishuDraft(page,{paperKey,answers,timeoutMs=15000,allowPartial=false,total}={}){
 if(!paperKey||!Array.isArray(answers)||!answers.length)throw Error('缺少待核对的作业与答案');
 const deadline=Date.now()+timeoutMs;let stableAt=0,lastMismatch=[];
 while(Date.now()<deadline){
  if(page.isClosed()||zhihuishuHomeworkKey(page.url())!==paperKey)return {ok:false,reason:'paper-closed-or-changed'};
  const questions=await extractZhihuishuQuestions(page);lastMismatch=[];
  for(const answer of answers){const q=questions.find(q=>q.questionId===answer.questionId),ids=q?.options.filter(o=>o.selected).map(o=>o.optionId).sort()||[];if(!q||JSON.stringify(ids)!==JSON.stringify([...answer.optionIds].sort()))lastMismatch.push(answer.questionIndex);}
  if((allowPartial?questions.length===total:questions.length===answers.length)&&!lastMismatch.length){if(!stableAt)stableAt=Date.now();if(Date.now()-stableAt>=600)return {ok:true,total:questions.length,matched:answers.length};}else stableAt=0;
  await page.waitForTimeout(150);
 }
 return {ok:false,reason:'saved-answers-not-confirmed',mismatchedQuestions:lastMismatch};
}
