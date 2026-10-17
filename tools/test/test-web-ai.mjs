// Synthetic fixtures using markup inspected on the real web clients.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {chromium} from 'playwright-core';
const root=process.cwd(),data=fs.mkdtempSync(path.join(root,'.desktop-test/web-ai-'));process.env.XXT_DATA_DIR=data;
const {findEdge}=await import('../../src/browser/launch.mjs');
const {AI_PROVIDERS,providerForUrl,ensureProviderPage}=await import('../../src/ai/providers.mjs');
const {askImage,checkLogin}=await import('../../src/ai/ai.mjs');
const {webChatState,writeWebPrompt}=await import('../../src/ai/web-chat.mjs');
const {normalizeSettings}=await import('../../src/settings.mjs');
const {loadSettings}=await import('../../src/config.mjs');
assert.equal(normalizeSettings({'ai.provider':'doubao'},loadSettings()).settings.ai.provider,'doubao');
assert.ok(normalizeSettings({'ai.provider':'unknown'},loadSettings()).errors.length);
for(const url of ['https://doubao.com.evil.test/','https://evil.test/?q=chat.deepseek.com','http://www.doubao.com/'])assert.equal(providerForUrl(url),null);
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const context=await browser.newContext();
 for(const id of ['doubao','deepseek']){
  const provider=AI_PROVIDERS[id],page=await context.newPage();
  const editor=id==='doubao'?'<div class="tiptap" contenteditable="true"></div>':'<textarea placeholder="给 DeepSeek 发送消息 "></textarea>';
  const send=id==='doubao'?'<button data-testid="chat_input_send_button">发送</button>':'<div role="button" class="ds-button--primary ds-button--circle">发送</div>';
  const answer=id==='doubao'?'<div data-testid="receive_message"><div data-testid="message_text_content">OLD ANSWER</div></div>':'<div class="ds-assistant-message-main-content">OLD ANSWER</div>';
  const markup=`<meta charset="utf-8"><div id="answers">${answer}</div><div data-testid="chat_input" class="_77cefa5">${editor}<input type="file" accept="image/png"><div id="attachment"></div>${send}</div><script>
  const input=document.querySelector('input'),send=document.querySelector('button,[role=button]');
  window.sent=0;input.onchange=()=>{document.querySelector('#attachment').innerHTML='<img alt="'+input.files[0].name+'" src="'+URL.createObjectURL(input.files[0])+'">';};
  send.onclick=()=>{window.sent++;document.querySelector('${id==='doubao'?'.tiptap':'textarea'}').${id==='doubao'?'innerText':'value'}='';${id==='doubao'?'':'input.value="";'}document.querySelector('#attachment').innerHTML='';const response=document.createElement('div');response.innerHTML=${JSON.stringify(answer.replace('OLD ANSWER','红色'))};document.querySelector('#answers').append(response);};</script>`;
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:markup}));await page.goto(provider.url);
  assert.equal((await checkLogin(page)).loggedIn,true);
  assert.equal(await ensureProviderPage(context,provider),page,'reuse the selected provider page');
  const imagePath=path.join(root,'.desktop-test/hidden-screenshot/verified-hidden.png');
  for(let round=0;round<2;round++){
   const result=await askImage({page,imagePath,prompt:'只回答方块颜色',freshChat:false});
   assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'红色');
  }
  assert.equal(await page.evaluate(()=>window.sent),2,'same answers in consecutive turns must still be tied to new response nodes');
  if(id==='doubao')assert.equal(await page.locator('input[type=file]').evaluate(input=>input.files.length),1,'fixture must retain the sent FileList');
  await page.locator('input[type=file]').evaluate(input=>{input.value='';});
  await page.locator('input[type=file]').setInputFiles(imagePath);
  await page.locator('#attachment img').waitFor({state:'visible'});
  await page.locator('input[type=file]').evaluate(input=>{input.value='';});
  const attachmentDraft=await askImage({page,imagePath,prompt:'DO NOT REPLACE DRAFT IMAGE',freshChat:false});
  assert.equal(attachmentDraft.errorCode,'draft-attachment');assert.equal(await page.evaluate(()=>window.sent),2);
  await page.evaluate(()=>document.querySelector('#attachment').innerHTML='');
  // Real browser input events through CDP, after a selector timeout. No AI send
  // is retried and a draft typed while recovering must stay untouched.
  const editorSelector=id==='doubao'?'.tiptap':'textarea';
  await writeWebPrompt(page,provider,'FIRST\n\nSECOND');
  assert.match((await webChatState(page,provider)).editorText,/FIRST\s+SECOND/);
  await page.locator(editorSelector).fill('');
  await page.evaluate(selector=>document.querySelector(selector).addEventListener('input',()=>window.lastInput=document.querySelector(selector).value??document.querySelector(selector).innerText),editorSelector);
  let beforeTimeout=async()=>{};
  const timedOut={filter(){return this},first(){return this},locator(){return this},async fill(){await beforeTimeout();throw Error('locator.fill: Timeout 3000ms exceeded')}};
  const recovering=new Proxy(page,{get(target,key){if(key==='locator')return()=>timedOut;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}});
  await writeWebPrompt(recovering,provider,'RECOVERED PROMPT');
  assert.equal((await webChatState(page,provider)).editorText,'RECOVERED PROMPT');
  assert.equal(await page.evaluate(()=>window.lastInput),'RECOVERED PROMPT','recovery must trigger the actual editor input event');
  assert.equal(await page.evaluate(()=>window.sent),2,'recovering text must never send or duplicate a request');
  await page.locator(editorSelector).fill('');
  beforeTimeout=()=>page.locator(editorSelector).fill('NEW USER DRAFT');
  await assert.rejects(writeWebPrompt(recovering,provider,'DO NOT OVERWRITE'),/draft/);
  assert.equal((await webChatState(page,provider)).editorText,'NEW USER DRAFT');
  await page.locator(editorSelector).fill('');
  const brokenLocator=locator=>new Proxy(locator,{get(target,key){
    if(key==='fill')return async()=>{throw Error('Input is not editable')};
    if(['filter','first','locator','nth'].includes(key))return(...args)=>brokenLocator(target[key](...args));
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const brokenPage=new Proxy(page,{get(target,key){if(key==='locator')return(...args)=>brokenLocator(target.locator(...args));const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}});
  const failedInput=await askImage({page:brokenPage,imagePath,prompt:'CANNOT TYPE',freshChat:false});
  assert.equal(failedInput.errorCode,'editor-unavailable');assert.equal(failedInput.sent,false);
  assert.match(failedInput.error,/填写输入框失败/);assert.equal(await page.evaluate(()=>window.sent),2);
  await page.locator(id==='doubao'?'.tiptap':'textarea').fill('MY UNSENT DRAFT');
  const guarded=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(guarded.errorCode,'draft-not-empty');assert.equal(await page.evaluate(()=>window.sent),2);
  await page.evaluate(()=>{const e=document.createElement('div');e.setAttribute('role','dialog');e.textContent='请完成安全验证';document.body.append(e);});
  const verification=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(verification.errorCode,'verification-required');
  await page.evaluate(()=>{document.querySelector('[role=dialog]').remove();const e=document.createElement('div');e.setAttribute('role','alert');e.textContent='请求频繁，请稍后再试';document.body.append(e);});
  assert.equal((await webChatState(page,provider)).limited,true);
  const limited=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(limited.errorCode,'rate-limited');assert.equal(await page.evaluate(()=>window.sent),2);
  // Fresh real clients can mount the hidden upload input only after typing.
  // Remove it again after each send to exercise the first and second questions.
  await page.setContent(`<meta charset="utf-8"><div id="answers"></div><div data-testid="chat_input" class="_77cefa5">${editor}<div id="attachment"></div>${send}</div><script>(function(){
    const composer=document.querySelector('[data-testid=chat_input]'),editor=composer.querySelector('[contenteditable],textarea'),send=composer.querySelector('button,[role=button]');
    window.sent=0;editor.addEventListener('input',()=>{if(composer.querySelector('input'))return;const input=document.createElement('input');input.type='file';input.accept='image/png';input.hidden=true;input.dataset.testid='upload-file-input';composer.append(input);input.onchange=()=>{document.querySelector('#attachment').innerHTML='<img alt="'+input.files[0].name+'" src="'+URL.createObjectURL(input.files[0])+'">'}});
    send.onclick=()=>{if(!composer.querySelector('input')?.files.length)return;window.sent++;editor.${id==='doubao'?'innerText':'value'}='';composer.querySelector('input').remove();document.querySelector('#attachment').innerHTML='';document.querySelector('#answers').insertAdjacentHTML('beforeend',${JSON.stringify(answer.replace('OLD ANSWER','红色'))})};
  })();</script>`);
  assert.equal(await page.locator('[data-testid=chat_input] input').count(),0);
  for(let round=0;round<2;round++){
   const lazy=await askImage({page,imagePath,prompt:'lazy upload fixture',freshChat:false});
   assert.equal(lazy.ok,true,JSON.stringify(lazy));assert.equal(lazy.answer,'红色');
   assert.equal(await page.locator('[data-testid=chat_input] input').count(),0);
  }
  assert.equal(await page.evaluate(()=>window.sent),2);
  console.log(`✓ ${provider.label}：首次输入后动态挂载上传控件、连续两题重建上传控件`);
  await page.close();console.log(`✓ ${provider.label}：图片上传、真实新轮次回答、同答案多轮、草稿保护、验证与限额停止`);
 }
 const q=await context.newPage();let qMarkup='';
 await q.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:qMarkup}));
 const composer='<div contenteditable="true" data-placeholder="向千问提问" style="min-height:40px"> </div><button aria-label="发送消息" disabled>发送</button>';
 for(const [name,body,expected] of [
  ['空白页','',false],
  ['加载页','<p>正在加载…</p>',false],
  ['错误页','<h1>该页面暂时不可用</h1>',false],
  ['缺少发送控件','<div contenteditable="true">输入</div>',false],
  ['隐藏聊天控件',`<div hidden>${composer}</div>`,false],
  ['未登录按钮','<button>登录</button>'+composer,false],
  ['未登录链接','<a href="/login">登录/注册</a>'+composer,false],
  ['未登录角色控件','<div role="button">立即登录</div>'+composer,false],
  ['已登录聊天界面',composer,true],
  ['隐藏登录按钮','<button hidden>登录</button>'+composer,true],
 ]) {
  qMarkup=body;await q.goto(AI_PROVIDERS.qianwen.url);
  assert.equal((await checkLogin(q)).loggedIn,expected,`千问：${name}`);
 }
 qMarkup=composer;await q.goto('https://www.qianwen.com/login');
 assert.equal((await checkLogin(q)).loggedIn,false,'登录路径不能误报就绪');
 console.log('✓ 千问就绪检测：空白、加载、错误、隐藏控件及不同登录入口均不误报');
 console.log('✓ 官方域名识别、通道设置、页面复用和千问兼容');
}finally{await browser.close();}
