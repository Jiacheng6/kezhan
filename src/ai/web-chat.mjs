// Visible web UI adapters. Login/verification are always performed by the user.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {interruptibleSleep,throwIfStopped,waitForRead} from '../control.mjs';
import {loadSettings} from '../config.mjs';
import {log} from '../logbus.mjs';
import {beginWebTurn,endWebTurn,webRequestMarker} from './web-turn.mjs';
import {canPauseAI,waitForAIResume} from './resume.mjs';
export const WEB_UI = {
  doubao: {
    composer: '[data-testid="chat_input"]',
    editor: '.tiptap[contenteditable="true"], textarea',
    upload: '[data-testid="upload_file_button"]',
    send: '[data-testid="chat_input_send_button"], [data-testid="send_button"], button[aria-label="发送"]',
    answer: '[data-testid="receive_message"] [data-testid="message_text_content"]',
    stop: '[data-testid="chat_input_stop_button"], [data-testid="stop_button"], button[aria-label*="停止"]',
  },
  deepseek: {
    composer: '._77cefa5',
    editor: 'textarea[placeholder*="DeepSeek"]',
    upload: '.f02f0e25[role="button"]',
    send: '.ds-button--primary.ds-button--circle[role="button"]',
    answer: '.ds-assistant-message-main-content',
    stop: '[role="button"][aria-label*="停止"], button[aria-label*="停止"]',
  },
};
export async function webChatState(page,provider) {
  return page.evaluate(({ui,id})=>{
    const visible=e=>!!e?.getClientRects().length&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const editor=[...document.querySelectorAll(ui.editor)].find(visible);
    const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const signedOut=/sign_in|login/i.test(location.pathname)||buttons.some(e=>/^(登录|立即登录|登录注册)$/.test((e.innerText||'').trim()));
    const dialogs=[...document.querySelectorAll('[role="dialog"], [class*="captcha"], iframe[src*="captcha"]')].filter(visible);
    const verification=dialogs.filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>4&&e.getBoundingClientRect().height>4).some(e=>/captcha/i.test(e.className||e.getAttribute('src')||'')||/完成验证|安全验证|拖动滑块|人机验证/.test(e.innerText||''));
    const notices=[...document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"]')].filter(visible).map(e=>e.innerText||'').join(' ');
    const limited=/操作频繁|请求频繁|达到.*上限|额度.*用完|稍后再试|rate limit/i.test(notices);
    const cards=[...document.querySelectorAll(ui.answer)].filter(visible);
    // Discard nested duplicates when the site exposes both wrapper and content selectors.
    const answers=cards.filter(e=>!cards.some(other=>other!==e&&e.contains(other)));
    const turn=id==='doubao'?globalThis[Symbol.for('xxt.web-chat-turn')]?.read():null;
    const last=turn?.answer&&visible(turn.answer)?turn.answer:answers.at(-1);
    // Virtualized chat history removes older bubbles. A new answer can have
    // both the same text and the same visible count as the previous answer.
    const identitySymbol=Symbol.for('xxt.web-chat-dom-identities');
    const identities=globalThis[identitySymbol] ||= {nodes:new WeakMap(),next:0,prefix:Date.now().toString(36)+Math.random().toString(36)};
    const key=node=>{if(!node)return '';if(!identities.nodes.has(node))identities.nodes.set(node,`${identities.prefix}:${++identities.next}`);return identities.nodes.get(node);};
    const root=node=>node?.closest('[data-testid="union_message"]')||node;
    const users=id==='doubao'?[...document.querySelectorAll('[data-testid="send_message"]')].filter(visible):[];
    const textUsers=users.filter(e=>(e.innerText||'').trim());
    const user=textUsers.at(-1),imageUser=users.filter(e=>e.querySelector('img')).at(-1);
    const answerRoot=root(last);
    const beforeAnswer=textUsers.filter(e=>answerRoot&&(root(e).compareDocumentPosition(answerRoot)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
    const generating=last?.getAttribute('data-streaming')==='true'||!![...document.querySelectorAll(ui.stop)].find(visible)||buttons.some(e=>/^(停止生成|停止回答|Stop generating)$/i.test((e.innerText||e.getAttribute('aria-label')||'').trim()))
      ||(id==='deepseek'&&!!document.querySelector('.ds-button--primary.ds-button--circle svg rect'));
    return {loggedIn:!!editor&&!signedOut,verification,limited,editor:!!editor,editorText:(editor?.value??editor?.innerText??'').trim(),count:answers.length,text:last?.innerText?.trim()||'',generating,
      answerKey:key(answerRoot),hasUserTurns:users.length>0,userKey:key(root(user)),userText:(user?.textContent||'').trim(),imageKey:key(root(imageUser)),replyUserKey:key(root(beforeAnswer)),
      trackedMarker:turn?.marker||'',turnObserved:!!turn?.observed,turnConfirmed:!!turn?.answer&&last===turn.answer,turnInvalidated:!!turn?.invalidated};
  },{ui:WEB_UI[provider.id],id:provider.id});
}
function webBlock(state,provider) {
  if(state.verification)return {ok:false,errorCode:'verification-required',error:`${provider.label}要求人工验证，请在软件内的 AI 网页完成后重新开始`};
  if(state.limited)return {ok:false,errorCode:'rate-limited',error:`${provider.label}提示使用频繁或额度限制，请按网页提示稍后再试`};
  if(!state.loggedIn)return {ok:false,errorCode:'not-logged-in',error:`${provider.label}未登录或页面未就绪，请打开答题网页并登录`};
  return null;
}
const normalizedPrompt=text=>String(text||'').replace(/[\u200b\ufeff]/g,'').replace(/\s+/g,' ').trim();
const samePrompt=(left,right)=>normalizedPrompt(left)===normalizedPrompt(right);
export function isCurrentWebAnswer(state,baseline,prompt) {
  const newNode=!!state.answerKey&&state.answerKey!==baseline.answerKey;
  // Doubao recycles nodes and decorates prompts with spacing and timestamps.
  // The unique request tag and reply order survive those display changes.
  const marker=webRequestMarker(prompt);
  if(marker&&state.trackedMarker)return state.trackedMarker===marker&&state.turnConfirmed&&!state.turnInvalidated;
  if(marker)return !!state.hasUserTurns&&!!state.userKey&&state.replyUserKey===state.userKey&&state.userText.includes(marker);
  if(state.hasUserTurns||baseline.hasUserTurns) {
    return newNode&&!!state.userKey&&state.userKey!==baseline.userKey
      &&!!state.imageKey&&state.imageKey!==baseline.imageKey
      &&state.replyUserKey===state.userKey&&samePrompt(state.userText,prompt);
  }
  return newNode||state.count>baseline.count||(state.text!==baseline.text&&state.count>0);
}
function hasComposerAttachment(page,provider) {
  return page.evaluate(ui=>{
    const visible=e=>!!e.getClientRects().length&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const composer=[...document.querySelectorAll(ui.composer)].find(visible);
    if(!composer)return false;
    const names=[...composer.querySelectorAll('input[type="file"]')].flatMap(input=>[...input.files].map(file=>file.name));
    const text=composer.innerText||'';
    // A file input may keep its FileList after a successful send. Only actual
    // draft UI counts: the preview, filename chip, or visible upload progress.
    const preview=[...composer.querySelectorAll('img')].some(image=>{
      if(!visible(image))return false;
      const rect=image.getBoundingClientRect();
      return image.src.startsWith('blob:')||names.includes(image.alt)||(rect.width>=40&&rect.height>=40);
    });
    return preview||names.some(name=>text.includes(name))
      ||[...composer.querySelectorAll('[aria-busy="true"],[role="progressbar"],.ds-loading,[data-testid*="attachment"]')].some(visible);
  },WEB_UI[provider.id]);
}
// Hidden Electron views can expose a DOM editor while the automation selector
// waits for its renderer. Recover only text entry, never repeat an AI send.
export async function writeWebPrompt(page,provider,prompt,{shouldStop}={}) {
  const ui=WEB_UI[provider.id];
  throwIfStopped(shouldStop);
  const initial=await webChatState(page,provider);
  if(initial.editorText&&!samePrompt(initial.editorText,prompt))throw new Error('输入框已有其他草稿，未覆盖');
  if(samePrompt(initial.editorText,prompt))return;
  try {
    await page.locator(ui.composer).filter({visible:true}).first().locator(ui.editor).filter({visible:true}).first().fill(prompt,{timeout:3000});
  } catch(error) {
    throwIfStopped(shouldStop);
    if(!/timeout/i.test(error.message))throw error;
    const session=await page.context().newCDPSession(page);
    let focused=false;
    try {
      await session.send('Page.setWebLifecycleState',{state:'active'});
      await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});focused=true;
      const status=await page.evaluate(({ui,prompt})=>{
        const visible=e=>!!e.getClientRects().length;
        const composer=[...document.querySelectorAll(ui.composer)].find(visible);
        const editors=[...(composer?.querySelectorAll(ui.editor)||[])].filter(visible);
        if(editors.length!==1)return 'missing';
        const editor=editors[0],text=(editor.value??editor.innerText??'').trim();
        const normalize=value=>value.replace(/[\u200b\ufeff]/g,'').replace(/\s+/g,' ').trim();
        if(normalize(text)===normalize(prompt))return 'ready';
        if(text)return 'draft';
        if(editor.disabled||editor.readOnly||editor.getAttribute('aria-disabled')==='true')return 'disabled';
        editor.focus();
        if(document.activeElement!==editor)return 'unfocused';
        return 'empty';
      },{ui,prompt});
      if(status==='empty') {
        throwIfStopped(shouldStop);
        await session.send('Input.insertText',{text:prompt});
      } else if(status!=='ready')throw new Error(`输入框未能安全恢复（${status}），未覆盖草稿`);
      log(`    ${provider.label}输入区已恢复，正在核对题干`, 'info');
    }finally{
      if(focused)await waitForRead(()=>session.send('Emulation.setFocusEmulationEnabled',{enabled:false}),{timeoutMs:1000}).catch(()=>{});
      await waitForRead(()=>session.detach(),{timeoutMs:1000}).catch(()=>{});
    }
  }
  throwIfStopped(shouldStop);
  const state=await webChatState(page,provider);
  if(!samePrompt(state.editorText,prompt))throw new Error('题干写入后回读不一致，已停止上传和发送');
}
export async function askWebImage({page,imagePath,prompt,shouldStop,freshChat=false},provider) {
  // A unique user-turn marker also rejects remounted historical bubbles when
  // the virtual list recycles every DOM node. The model need not echo it.
  if(provider.id==='doubao')prompt+=`\n\n本次提问标记：${randomUUID()}。标记仅用于区分本次提问，答案中不要重复标记。`;
  let started=Date.now(),pausedMs=0;
  const ui=WEB_UI[provider.id],settings=loadSettings().ai||{};
  const read=operation=>waitForRead(operation,{shouldStop,timeoutMs:10000,message:`${provider.label}页面读取超时`});
  const readState=async()=>{
    let state=await read(()=>webChatState(page,provider));
    while(state.verification&&canPauseAI()){
      const elapsed=await waitForAIResume({provider,page,shouldStop,check:async()=>{const next=await webChatState(page,provider);return !next.verification&&next.loggedIn;}});
      started+=elapsed;pausedMs+=elapsed;state=await read(()=>webChatState(page,provider));
    }
    return state;
  };
  let stage='page',sent=false,turnMarker='';
  try{
    throwIfStopped(shouldStop);
    await dismissWebObstructions(page);
    let state=await readState(),blocked=webBlock(state,provider);if(blocked)return blocked;
    if(state.generating)return {ok:false,errorCode:'already-generating',error:`${provider.label}仍在回答上一条消息，请等待结束后再开始`};
    if(state.editorText&&!samePrompt(state.editorText,prompt))return {ok:false,errorCode:'draft-not-empty',error:`${provider.label}输入框已有草稿，请先处理，避免覆盖你的内容`};
    if(!fs.existsSync(imagePath))return {ok:false,errorCode:'image-missing',error:'题目图片不存在'};
    if(freshChat){await page.goto(provider.url,{waitUntil:'domcontentloaded',timeout:45000});state=await readState();blocked=webBlock(state,provider);if(blocked)return blocked;}
    if(state.editorText&&!samePrompt(state.editorText,prompt))return {ok:false,errorCode:'draft-not-empty',error:`${provider.label}输入框已有草稿，请先处理，避免覆盖你的内容`};
    const composer=page.locator(ui.composer).filter({visible:true}).first();
    const inputs=()=>read(()=>composer.locator('input[type="file"]').evaluateAll(inputs=>inputs.map((e,i)=>({i,accept:e.accept,selected:e.files.length,testid:e.getAttribute('data-testid')}))));
    if(await read(()=>hasComposerAttachment(page,provider)))return {ok:false,errorCode:'draft-attachment',error:`${provider.label}输入区已有附件，请先处理原草稿，避免混入其他题目`};
    stage='editor';await writeWebPrompt(page,provider,prompt,{shouldStop});
    stage='upload';
    // Doubao mounts its file inputs after the first focus/text update. Never use
    // the pre-input snapshot for the upload target.
    const existing=await inputs();
    if(await read(()=>hasComposerAttachment(page,provider)))return {ok:false,errorCode:'draft-attachment',error:`${provider.label}输入区已有附件，请先处理原草稿，避免混入其他题目`};
    const input=existing.find(e=>e.testid==='upload-file-input')||existing.find(e=>/image|\.png/i.test(e.accept))||existing.find(e=>!e.accept);
    if(input){
      const target=composer.locator('input[type="file"]').nth(input.i);
      // No visible draft exists (checked above). Clear the stale browser value
      // without a change event so selecting the same file triggers upload again.
      throwIfStopped(shouldStop);await target.evaluate(input=>{input.value='';});
      throwIfStopped(shouldStop);await target.setInputFiles(imagePath,{timeout:15000});
    }
    else {
      const chooser=page.waitForEvent('filechooser',{timeout:10000});
      try {await page.locator(ui.upload).first().click({timeout:8000});await (await chooser).setFiles(imagePath,{timeout:15000});}
      catch(error){await chooser.catch(()=>{});throw error;}
    }
    // Attachment confirmation must be in the composer, never a previous chat image.
    let ready=false;
    while(Date.now()-started<45000){
      throwIfStopped(shouldStop);
      state=await readState();blocked=webBlock(state,provider);if(blocked)return blocked;
      ready=await read(()=>page.evaluate(({ui,name})=>{
        const editor=[...document.querySelectorAll(ui.editor)].find(e=>e.getClientRects().length);
        const composer=editor?.closest(ui.composer);
        if(composer){
          const send=composer.querySelector(ui.send);
          if(!send)return false;
          const text=composer.innerText||'';
          const image=[...composer.querySelectorAll('img')].some(e=>e.complete&&e.naturalWidth>0&&(e.alt===name||(e.getAttribute('src')||'').startsWith('blob:')));
          const attachment=text.includes(name)||image;
          if(!attachment)return false;
          const busy=[...composer.querySelectorAll('[aria-busy="true"], [role="progressbar"], .ds-loading')].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!!e.getClientRects().length)||/正在上传|上传中|解析中/.test(text)
            ||[...text.matchAll(/\b(\d{1,3})%/g)].some(match=>Number(match[1])<100);
          return attachment&&!busy&&!send.disabled&&send.getAttribute('aria-disabled')!=='true'&&!send.classList.contains('ds-button--disabled');
        }
        return false;
      },{ui,name:path.basename(imagePath)}));
      if(ready)break;await interruptibleSleep(350,shouldStop);
    }
    if(!ready)return {ok:false,errorCode:'upload-not-ready',error:`${provider.label}未确认图片上传完成，已停止发送，避免发出无图题目`};
    const baseline=await read(()=>webChatState(page,provider));
    turnMarker=await read(()=>beginWebTurn(page,provider,prompt));
    stage='send';
    await dismissWebObstructions(page);
    throwIfStopped(shouldStop);await page.locator(ui.send).filter({visible:true}).last().click({timeout:10000});
    sent=true;stage='answer';
    log(`    ${provider.label}已发送图片题，等待回答`, 'info');
    let last='',stable=0,lastProgress=Date.now();
    const timeout=Math.max(60000,Number(settings.answerTimeoutMs)||240000),stuck=Math.max(15000,Number(settings.answerStuckMs)||60000);
    while(Date.now()-started<timeout){
      await interruptibleSleep(1200,shouldStop);
      const beforePaused=pausedMs;state=await readState();lastProgress+=pausedMs-beforePaused;blocked=webBlock(state,provider);if(blocked)return blocked;
      const current=isCurrentWebAnswer(state,baseline,prompt);
      const text=current?state.text:'';
      if(text!==last){lastProgress=Date.now();stable=0;}else if(text)stable++;
      last=text;
      if(current&&text&&stable>=3&&!state.generating)return {ok:true,answer:text,provider:provider.id,waitedMs:Date.now()-started};
      if(Date.now()-lastProgress>stuck){
        log(`    ${provider.label}回答核对：页面回答 ${state.count} 条；本次提问回执${state.turnObserved?'已捕获':'未捕获'}；回答关联${state.turnConfirmed?'已确认':'未确认'}${state.turnInvalidated?'；检测到其他提问':''}`, 'warn');
        return {ok:false,errorCode:'answer-not-confirmed',error:`${provider.label}本次回答未能确认，已保留本题；请打开软件内 AI 网页核对，不代表平台限流`,waitedMs:Date.now()-started};
      }
    }
    return {ok:false,errorCode:'answer-not-confirmed',error:`${provider.label}回答等待超时，已保留本题；未使用历史或未完成的回答`};
  }catch(error){
    if(error.code==='STOPPED')throw error;
    const code=({editor:'editor-unavailable',upload:'upload-failed',send:'send-failed'})[stage]||'exception';
    const label=({editor:'填写输入框失败',upload:'图片上传失败',send:'点击发送失败',answer:'回答读取失败',page:'页面读取失败'})[stage];
    return {ok:false,errorCode:code,sent,error:`${provider.label}${label}${sent?'':'（尚未确认发送）'}：${error.message}`};
  }finally{
    await waitForRead(()=>endWebTurn(page,turnMarker),{timeoutMs:2000}).catch(()=>{});
  }
}

export async function dismissWebObstructions(page){
  for(let i=0;i<3;i++){
    const dialogs=page.locator('[role="dialog"]').filter({visible:true});let closed=false;
    for(let n=0;n<await dialogs.count();n++){
      const dialog=dialogs.nth(n),text=await dialog.innerText().catch(()=>'');
      if(/验证|captcha|登录|注册|密码|扫码/i.test(text))continue;
      const close=dialog.getByRole('button',{name:/^(关闭|跳过|知道了|以后再说|暂不)$/}).first();
      if(await close.count()){await close.click({timeout:1500}).catch(()=>{});closed=true;break;}
    }
    if(!closed)break;
  }
}
