import {extractZhihuishuQuestions,fillZhihuishuChoice} from './quiz.mjs';
import {parseAnswer,validateBeforeSubmit} from '../../ai/parse.mjs';
import {questionPrompt} from '../../ai/question-prompt.mjs';
import {throwIfStopped} from '../../control.mjs';
import path from 'node:path';
import {shootQuestion} from '../../chaoxing/quiz.mjs';
import {embedded,captureEmbeddedPage} from '../../browser/embedded.mjs';
/** Captures actual rendered question pixels, including stems absent from DOM text. */
export async function captureZhihuishuQuestion(page,question,file){
 const current=(await extractZhihuishuQuestions(page)).find(q=>q.questionId===question.questionId);
 if(!current?.visible||current.paperKey!==question.paperKey)throw Error('截图前题目身份或可见题改变');
 const root=page.locator('.examPaper_subject').nth(current.domIndex);
 if(embedded){
  // Use the same native hidden-window capture path as Chaoxing. Raw CDP copies
  // can stall while the coursework page is behind the AI/workspace view.
  const captured=await shootQuestion(page.mainFrame(),current.domIndex,path.dirname(file),{selector:'.examPaper_subject',nativeCapture:captureEmbeddedPage,allowCDPFallback:false});
  if(captured!==file){const {copyFile}=await import('node:fs/promises');await copyFile(captured,file);}
  const rect=await root.boundingBox();return {width:rect.width,height:rect.height};
 }
 await root.scrollIntoViewIfNeeded();
 const rect=await root.boundingBox();if(!rect||rect.width<200||rect.height<60)throw Error('题目截图区域无效');
 const offset=await page.evaluate(()=>({x:scrollX,y:scrollY}));
 const cdp=await page.context().newCDPSession(page);
 try{const image=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:Math.max(0,rect.x+offset.x),y:Math.max(0,rect.y+offset.y),width:rect.width,height:rect.height,scale:1}});const {writeFile}=await import('node:fs/promises');await writeFile(file,Buffer.from(image.data,'base64'));}finally{await cdp.detach();}
 return {width:rect.width,height:rect.height};
}
/** Fills a normal homework through the real AI callback. Does not submit it. */
export async function answerZhihuishuHomework({page,askImage,imagePathFor,onStage=()=>{},checkpoint=async()=>{},shouldStop,previous}){
 const initial=await extractZhihuishuQuestions(page);if(!initial.length||!initial.every(q=>q.questionId))throw Error('题目清单不完整');
 if(new Set(initial.map(q=>q.questionId)).size!==initial.length)throw Error('题目标识不唯一');
 const paperKey=initial[0].paperKey;
 if(previous&&(previous.paperKey!==paperKey||previous.total!==initial.length))throw Error('已存草稿的作业或题数改变，未复用答案');
 const answers=structuredClone(previous?.answers||[]);
 for(const answer of answers){const q=initial.find(q=>q.questionId===answer.questionId);if(!q||q.qtype!==answer.qtype||!answer.optionIds?.length||answer.optionIds.some(id=>q.options.filter(o=>o.optionId===id).length!==1)||JSON.stringify(q.options.map(o=>[o.optionId,o.text]))!==JSON.stringify(answer.options.map(o=>[o.optionId,o.text])))throw Error('已存题目或选项改变，未复用答案');}
 await checkpoint({paperKey,total:initial.length,questions:initial,answers,submitted:false});
 for(let index=0;index<initial.length;index++){
  throwIfStopped(shouldStop);const questions=await extractZhihuishuQuestions(page),visible=questions.filter(q=>q.visible);
  const q=visible[0];if(visible.length!==1||q.questionId!==initial[index].questionId||q.paperKey!==paperKey)throw Error('当前题序或作业身份与验收范围不一致');
  if(!['single','multiple','judge'].includes(q.qtype))throw Error('当前题型尚未验证：'+q.qtype);
  const cached=answers.find(a=>a.questionId===q.questionId);
  if(cached){
   onStage({stage:'restore-saved',index:index+1,total:initial.length});
   const letters=q.options.filter(o=>cached.optionIds.includes(o.optionId)).map(o=>o.letter);
   const filled=await fillZhihuishuChoice(page,q,letters);if(!filled.ok)throw Error('已保存答案恢复回读不一致');
   cached.letters=filled.selected;
  }else{
  onStage({stage:'capture',index:index+1,total:initial.length,qtype:q.qtype});const imagePath=imagePathFor(index+1);await captureZhihuishuQuestion(page,q,imagePath);
  throwIfStopped(shouldStop);onStage({stage:'ask-ai',index:index+1,total:initial.length});
  const prompt=questionPrompt('请根据这张当前题目的截图作答。请仔细阅读完整题干和所有选项；单选只选一项，多选选择所有正确项，判断题回答对或错。只输出“答案：”及答案，不写解析。看不清或无法确定时明确说明，不要猜测。',q);
  const response=await askImage({imagePath,prompt,question:q});
  if(!response?.ok)throw Object.assign(Error(response?.error||'AI 回答未确认'),{code:response?.errorCode||'AI_UNCONFIRMED'});
  const parsed=parseAnswer(response.answer,q),validation=validateBeforeSubmit(parsed,q);
  if(!validation.safe)throw Error('AI 答案未通过回填校验：'+JSON.stringify({parsed,validation}));
  onStage({stage:'fill',index:index+1,total:initial.length,letters:parsed.letters});throwIfStopped(shouldStop);
  const filled=await fillZhihuishuChoice(page,q,parsed.letters);if(!filled.ok)throw Error('实际回填回读不一致：'+filled.reason);
  const answer={questionId:q.questionId,questionIndex:q.questionIndex,qtype:q.qtype,options:q.options,letters:filled.selected,optionIds:q.options.filter(o=>filled.selected.includes(o.letter)).map(o=>o.optionId),rawAI:response.answer,imagePath};answers.push(answer);
  }
  await checkpoint({paperKey,total:initial.length,questions:initial,answers,submitted:false});
  if(index<initial.length-1){
   onStage({stage:'save-next',index:index+1,total:initial.length});const next=page.getByRole('button',{name:'下一题',exact:true});if(await next.count()!==1||!await next.isEnabled())throw Error('无法通过正常下一题按钮保存');
   await next.click();const deadline=Date.now()+15000;let moved=false;while(Date.now()<deadline){throwIfStopped(shouldStop);const nextQ=(await extractZhihuishuQuestions(page)).find(q=>q.visible);if(nextQ?.questionId===initial[index+1].questionId){moved=true;break;}await page.waitForTimeout(100);}if(!moved)throw Error('下一题未切换，已保留当前题');
  }
 }
 onStage({stage:'filled-all',total:initial.length});return {paperKey,total:initial.length,answers,submitted:false};
}
