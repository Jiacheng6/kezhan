// Synthetic fixtures using markup inspected on the real web clients.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {chromium} from 'playwright-core';
const root=process.cwd(),data=fs.mkdtempSync(path.join(root,'.desktop-test/web-ai-'));process.env.XXT_DATA_DIR=data;
const {findEdge}=await import('../../src/browser/launch.mjs');
const {AI_PROVIDERS,providerForUrl,ensureProviderPage}=await import('../../src/ai/providers.mjs');
const {askImage,checkLogin}=await import('../../src/ai/ai.mjs');
const {webChatState}=await import('../../src/ai/web-chat.mjs');
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
  send.onclick=()=>{window.sent++;document.querySelector('${id==='doubao'?'.tiptap':'textarea'}').${id==='doubao'?'innerText':'value'}='';input.value='';document.querySelector('#attachment').innerHTML='';const response=document.createElement('div');response.innerHTML=${JSON.stringify(answer.replace('OLD ANSWER','红色'))};document.querySelector('#answers').append(response);};</script>`;
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:markup}));await page.goto(provider.url);
  assert.equal((await checkLogin(page)).loggedIn,true);
  assert.equal(await ensureProviderPage(context,provider),page,'reuse the selected provider page');
  const imagePath=path.join(root,'.desktop-test/hidden-screenshot/verified-hidden.png');
  for(let round=0;round<2;round++){
   const result=await askImage({page,imagePath,prompt:'只回答方块颜色',freshChat:false});
   assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'红色');
  }
  assert.equal(await page.evaluate(()=>window.sent),2,'same answers in consecutive turns must still be tied to new response nodes');
  await page.locator(id==='doubao'?'.tiptap':'textarea').fill('MY UNSENT DRAFT');
  const guarded=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(guarded.errorCode,'draft-not-empty');assert.equal(await page.evaluate(()=>window.sent),2);
  await page.evaluate(()=>{const e=document.createElement('div');e.setAttribute('role','dialog');e.textContent='请完成安全验证';document.body.append(e);});
  const verification=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(verification.errorCode,'verification-required');
  await page.evaluate(()=>{document.querySelector('[role=dialog]').remove();const e=document.createElement('div');e.setAttribute('role','alert');e.textContent='请求频繁，请稍后再试';document.body.append(e);});
  assert.equal((await webChatState(page,provider)).limited,true);
  const limited=await askImage({page,imagePath,prompt:'another question',freshChat:false});assert.equal(limited.errorCode,'rate-limited');assert.equal(await page.evaluate(()=>window.sent),2);
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
