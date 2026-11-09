import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {PATHS} from '../../config.mjs';
import {captureArea} from '../../chaoxing/shot.mjs';
import {throwIfStopped} from '../../control.mjs';
const BLOCKS='[data-controltype],et-choice,et-multi,et-tof,et-blank,et-match,et-order';
const FIELDS='input:not([type]),input[type="text"],textarea,[contenteditable]:not([contenteditable="false"])';
const OPTIONS='ul[data-itemtype="options"] > li';
// Only visible question/answer controls. Never read data-solution, result text,
// answer attributes, or a courseware's SCORM implementation.
export async function readPractice(frame){
  return frame.evaluate(({selector,fieldsSelector,optionsSelector})=>{
    const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
    return [...document.querySelectorAll(selector)].map((block,domIndex)=>{
      if(!visible(block)||block.querySelector(selector))return null;
      const type=String(block.getAttribute('data-controltype')||block.tagName.replace(/^ET-/, '')).toLowerCase();
      const fields=[...block.querySelectorAll(fieldsSelector)].filter(e=>visible(e)&&!e.disabled&&!e.readOnly);
      const legacy=block.tagName.startsWith('ET-');
      const nodes=[...block.querySelectorAll(legacy?'li':optionsSelector)].filter(visible);
      const options=nodes.map((el,i)=>({letter:String.fromCharCode(65+i),text:el.innerText.trim(),selected:!!el.querySelector('input:checked')||el.getAttribute('aria-checked')==='true'||['selected','checked','chosen','active'].some(c=>el.classList.contains(c))}));
      const qtype=fields.length===1?'essay':/multi|checkbox/.test(type)?'multiple':options.length>=2?'single':'unknown';
      const contextParent=legacy&&qtype==='essay';
      const promptRoot=contextParent?block.parentElement:block;
      const blanks=contextParent?[...promptRoot.querySelectorAll('et-blank')]:[];
      const blankOrdinal=contextParent?blanks.indexOf(block)+1:1;
      const walker=document.createTreeWalker(promptRoot,NodeFilter.SHOW_TEXT);let text='';
      while(walker.nextNode()){const node=walker.currentNode;if(visible(node.parentElement)&&!node.parentElement.closest('script,style,textarea,[contenteditable],[data-itemtype="result"],span.key'))text+=' '+node.data;}
      text=text.replace(/\s+/g,' ').trim();
      return {domIndex,id:block.getAttribute('data-id')||block.id||String(domIndex),type,qtype,options,text,legacy,contextParent,blankOrdinal,
        value:fields.length===1?String(fields[0].isContentEditable?fields[0].textContent:fields[0].value||''):'',
        existing:fields.some(e=>String(e.isContentEditable?e.textContent:e.value||'').trim())||options.some(o=>o.selected),supported:(qtype==='essay'||options.length>=2&&options.length<=26)&&!/record|oral|speak|pron|match|order/.test(type),
        signature:JSON.stringify([type,text,options.map(o=>o.text),blankOrdinal])};
    }).filter(Boolean);
  },{selector:BLOCKS,fieldsSelector:FIELDS,optionsSelector:OPTIONS});
}
export async function fillPractice(frame,question,answer,{shouldStop}={}){
  const latest=(await readPractice(frame)).find(q=>q.domIndex===question.domIndex);
  if(!latest||latest.signature!==question.signature)throw Object.assign(Error('WeLearn 题面或选项变化，未回填'),{code:'TASK_IDENTITY_CHANGED',retryable:false});
  if(latest.existing)return {ok:false,requiresManual:true,error:'WeLearn 此题已有答案，保留原作答，请人工核对'};
  throwIfStopped(shouldStop);
  const block=frame.locator(BLOCKS).nth(question.domIndex);
  if(question.qtype==='essay'){
    const value=String(answer.textAnswer||'').trim();if(!value)return {ok:false,error:'未取得可回填的文字答案'};
    const field=block.locator(FIELDS).filter({visible:true});
    if(await field.count()!==1)return {ok:false,error:'输入框不唯一，保留给人工处理'};
    await field.fill(value);await field.blur();
    return {ok:await field.evaluate(e=>e.isContentEditable?e.textContent:e.value)===value};
  }
  const letters=answer.letters||[];
  if(!letters.length||new Set(letters).size!==letters.length||letters.some(l=>!question.options.some(o=>o.letter===l))||question.qtype==='single'&&letters.length!==1)return {ok:false,error:'AI 答案不能唯一对应可见选项'};
  for(const letter of letters){throwIfStopped(shouldStop);await block.locator(question.legacy?'li':OPTIONS).filter({visible:true}).nth(question.options.findIndex(o=>o.letter===letter)).click();}
  const after=(await readPractice(frame)).find(q=>q.domIndex===question.domIndex);
  return {ok:JSON.stringify(after?.options.filter(o=>o.selected).map(o=>o.letter).sort())===JSON.stringify([...letters].sort())};
}
export async function assistPractice(page,frame,questions,{ask,saved={},save=()=>{},shouldStop,checkIdentity=async()=>{}}={}){
  let requiresReview=false;
  for(const q of questions){
    throwIfStopped(shouldStop);
    await checkIdentity();
    if(!q.supported)return {ok:false,error:'WeLearn 此类练习尚未适配，需要在原网页处理'};
    if(q.qtype==='essay')requiresReview=true;
    const key=crypto.createHash('sha256').update(q.id+'|'+q.signature).digest('hex'),prior=saved[key];
    if(prior?.filled&&q.existing){
      const matches=q.qtype==='essay'?q.value.trim()===String(prior.parsed.textAnswer||'').trim():JSON.stringify(q.options.filter(o=>o.selected).map(o=>o.letter).sort())===JSON.stringify([...(prior.parsed.letters||[])].sort());
      if(!matches)return {ok:false,error:'WeLearn 网页答案已被修改，保留人工更改，请在原网页核对'};
      continue;
    }
    if(q.existing)return {ok:false,error:'WeLearn 存在人工或历史答案，未覆盖，请在原网页核对'};
    let parsed=prior?.parsed;
    if(!parsed){
      fs.mkdirSync(PATHS.answers,{recursive:true});
      const imagePath=path.join(PATHS.answers,'welearn-'+crypto.randomUUID()+'.png');
      const block=frame.locator(BLOCKS).nth(q.domIndex),target=q.contextParent?block.locator('xpath=..'):block;await target.scrollIntoViewIfNeeded({timeout:3000});
      await captureArea(page,target,imagePath);
      const prompt=q.qtype==='essay'?`这是英语课内填空。目标是截图所在句子或段落中的第 ${q.blankOrdinal} 个空。只输出这个空需要填入的词或短语，不要重写整句，不要解释；看不清或上下文不足时明确说明。`:undefined;
      const reply=await ask({imagePath,prompt,question:{qtype:q.qtype,options:q.options,questionId:q.id}});
      if(!reply?.ok)return {ok:false,error:reply?.error||'AI 尚未取得可靠回答',aiErrorCode:reply?.errorCode};
      parsed=reply.parsed;
      if(!parsed||(q.qtype==='essay'?!parsed.canFill:parsed.confidence!=='high'))return {ok:false,error:'WeLearn AI 答案可靠度不足，请人工核对'};
      saved[key]={parsed,filled:false};save(saved);
    }
    await checkIdentity();
    const filled=await fillPractice(frame,q,parsed,{shouldStop});
    if(!filled.ok)return {...filled,error:filled.error||'WeLearn 回填后未读到一致答案，未提交'};
    saved[key]={parsed,filled:true};save(saved);
  }
  return {ok:true,requiresReview};
}
