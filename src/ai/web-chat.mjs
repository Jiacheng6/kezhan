// Visible web UI adapters. Login/verification are always performed by the user.
import fs from 'node:fs';
import path from 'node:path';
import {interruptibleSleep,throwIfStopped,waitForRead} from '../control.mjs';
import {loadSettings} from '../config.mjs';
import {log} from '../logbus.mjs';
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
    const visible=e=>!!e?.getClientRects().length;
    const editor=[...document.querySelectorAll(ui.editor)].find(visible);
    const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const signedOut=/sign_in|login/i.test(location.pathname)||buttons.some(e=>/^(登录|立即登录|登录注册)$/.test((e.innerText||'').trim()));
    const dialogs=[...document.querySelectorAll('[role="dialog"], [class*="captcha"], iframe[src*="captcha"]')].filter(visible);
    const verification=dialogs.some(e=>/captcha/i.test(e.className||e.getAttribute('src')||'')||/完成验证|安全验证|拖动滑块|人机验证/.test(e.innerText||''));
    const notices=[...document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"]')].filter(visible).map(e=>e.innerText||'').join(' ');
    const limited=/操作频繁|请求频繁|达到.*上限|额度.*用完|稍后再试|rate limit/i.test(notices);
    const cards=[...document.querySelectorAll(ui.answer)].filter(visible);
    // Discard nested duplicates when the site exposes both wrapper and content selectors.
    const answers=cards.filter(e=>!cards.some(other=>other!==e&&e.contains(other)));
    const last=answers.at(-1);
    const generating=last?.getAttribute('data-streaming')==='true'||!![...document.querySelectorAll(ui.stop)].find(visible)||buttons.some(e=>/^(停止生成|停止回答|Stop generating)$/i.test((e.innerText||e.getAttribute('aria-label')||'').trim()))
      ||(id==='deepseek'&&!!document.querySelector('.ds-button--primary.ds-button--circle svg rect'));
    return {loggedIn:!!editor&&!signedOut,verification,limited,editor:!!editor,editorText:(editor?.value??editor?.innerText??'').trim(),count:answers.length,text:last?.innerText?.trim()||'',generating};
  },{ui:WEB_UI[provider.id],id:provider.id});
}
function webBlock(state,provider) {
  if(state.verification)return {ok:false,errorCode:'verification-required',error:`${provider.label}要求人工验证，请在软件内的 AI 网页完成后重新开始`};
  if(state.limited)return {ok:false,errorCode:'rate-limited',error:`${provider.label}提示使用频繁或额度限制，请按网页提示稍后再试`};
  if(!state.loggedIn)return {ok:false,errorCode:'not-logged-in',error:`${provider.label}未登录或页面未就绪，请打开答题网页并登录`};
  return null;
}
export async function askWebImage({page,imagePath,prompt,shouldStop,freshChat=false},provider) {
  const started=Date.now(),ui=WEB_UI[provider.id],settings=loadSettings().ai||{};
  const read=operation=>waitForRead(operation,{shouldStop,timeoutMs:10000,message:`${provider.label}页面读取超时`});
  try{
    throwIfStopped(shouldStop);
    let state=await read(()=>webChatState(page,provider)),blocked=webBlock(state,provider);if(blocked)return blocked;
    if(state.generating)return {ok:false,errorCode:'already-generating',error:`${provider.label}仍在回答上一条消息，请等待结束后再开始`};
    if(state.editorText&&state.editorText!==prompt)return {ok:false,errorCode:'draft-not-empty',error:`${provider.label}输入框已有草稿，请先处理，避免覆盖你的内容`};
    if(!fs.existsSync(imagePath))return {ok:false,errorCode:'image-missing',error:'题目图片不存在'};
    if(freshChat){await page.goto(provider.url,{waitUntil:'domcontentloaded',timeout:45000});state=await read(()=>webChatState(page,provider));blocked=webBlock(state,provider);if(blocked)return blocked;}
    const editor=page.locator(ui.editor).filter({visible:true}).first();
    if(state.editorText&&state.editorText!==prompt)return {ok:false,errorCode:'draft-not-empty',error:`${provider.label}输入框已有草稿，请先处理，避免覆盖你的内容`};
    await editor.fill(prompt,{timeout:10000});
    const existing=await read(()=>page.evaluate(()=>[...document.querySelectorAll('input[type="file"]')].map((e,i)=>({i,accept:e.accept,selected:e.files.length,testid:e.getAttribute('data-testid')}))));
    const input=existing.find(e=>e.testid==='upload-file-input')||existing.find(e=>/image|\.png/i.test(e.accept))||existing.find(e=>!e.accept);
    if(existing.some(e=>e.selected))return {ok:false,errorCode:'draft-attachment',error:`${provider.label}输入区已有附件，请先处理原草稿，避免混入其他题目`};
    if(input)await page.locator('input[type="file"]').nth(input.i).setInputFiles(imagePath,{timeout:15000});
    else {
      const chooser=page.waitForEvent('filechooser',{timeout:10000});
      try {await page.locator(ui.upload).first().click({timeout:8000});await (await chooser).setFiles(imagePath,{timeout:15000});}
      catch(error){await chooser.catch(()=>{});throw error;}
    }
    // Attachment confirmation must be in the composer, never a previous chat image.
    let ready=false;
    while(Date.now()-started<45000){
      throwIfStopped(shouldStop);
      state=await read(()=>webChatState(page,provider));blocked=webBlock(state,provider);if(blocked)return blocked;
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
          const busy=!!composer.querySelector('[aria-busy="true"], [role="progressbar"], .ds-loading')||/正在上传|上传中|解析中/.test(text)
            ||[...text.matchAll(/\b(\d{1,3})%/g)].some(match=>Number(match[1])<100);
          return attachment&&!busy&&!send.disabled&&send.getAttribute('aria-disabled')!=='true'&&!send.classList.contains('ds-button--disabled');
        }
        return false;
      },{ui,name:path.basename(imagePath)}));
      if(ready)break;await interruptibleSleep(350,shouldStop);
    }
    if(!ready)return {ok:false,errorCode:'upload-not-ready',error:`${provider.label}未确认图片上传完成，已停止发送，避免发出无图题目`};
    const baseline=await read(()=>webChatState(page,provider));
    throwIfStopped(shouldStop);await page.locator(ui.send).filter({visible:true}).last().click({timeout:10000});
    log(`    ${provider.label}已发送图片题，等待回答`, 'info');
    let last='',stable=0,lastProgress=Date.now(),sawNew=false;
    const timeout=Math.max(60000,Number(settings.answerTimeoutMs)||240000),stuck=Math.max(15000,Number(settings.answerStuckMs)||60000);
    while(Date.now()-started<timeout){
      await interruptibleSleep(1200,shouldStop);
      state=await read(()=>webChatState(page,provider));blocked=webBlock(state,provider);if(blocked)return blocked;
      sawNew ||= state.count>baseline.count||(state.text!==baseline.text&&state.count>0);
      const text=sawNew?state.text:'';
      if(text!==last){lastProgress=Date.now();stable=0;}else if(text)stable++;
      last=text;
      if(sawNew&&text&&stable>=3&&!state.generating)return {ok:true,answer:text,provider:provider.id,waitedMs:Date.now()-started};
      if(Date.now()-lastProgress>stuck)return {ok:false,errorCode:'stuck-receiving',error:`${provider.label}长时间没有新内容，未使用未完成的回答`,waitedMs:Date.now()-started};
    }
    return {ok:false,errorCode:'timeout-empty',error:`${provider.label}回答等待超时，未使用历史或未完成的回答`};
  }catch(error){if(error.code==='STOPPED')throw error;return {ok:false,errorCode:'exception',error:`${provider.label}网页操作失败：${error.message}`};}
}
