import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';import {fixturePng} from './fixture-png.mjs';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/conversation-recovery-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {askWebImage}=await import('../../src/ai/web-chat.mjs');const {AI_PROVIDERS}=await import('../../src/ai/providers.mjs');
const {draftKey,createWebDraft,saveWebDraft,savedWebConversation}=await import('../../src/ai/web-draft.mjs');const {loadState}=await import('../../src/state.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const p=await b.newPage(),basePrompt='测试原题',marker='22222222-3333-4444-8555-666666666666',prompt=`${basePrompt}\n\n本次提问标记：${marker}。标记仅用于区分本次提问，答案中不要重复标记。`;
 const imagePath=path.join(process.env.XXT_DATA_DIR,'fixture.png');fs.writeFileSync(imagePath,fixturePng());
 const args={page:p,imagePath,prompt:basePrompt,taskKey:'restore-chat',question:{questionId:'q2',qtype:'single',options:[{letter:'A',text:'甲'},{letter:'B',text:'乙'}]}};
 const key=draftKey('doubao',args.taskKey,args.question),url='https://www.doubao.com/chat/123456';
 const seed=()=>{createWebDraft(key,{prompt,basePrompt,pageUrl:url,imagePath});saveWebDraft(key,{phase:'sent'});};
 let sends=0,uploads=0,redirect=false;
 await p.exposeFunction('sent',()=>sends++);await p.exposeFunction('uploaded',()=>uploads++);
 await p.route('https://www.doubao.com/**',r=>{
  const saved=r.request().url()===url;
  return r.fulfill({contentType:'text/html; charset=utf-8',body:`${saved&&redirect?'<script>history.replaceState(null,"","/chat/")</script>':''}<div id="messages">${saved?`<section data-testid="union_message"><div data-testid="send_message">${prompt}</div></section><section data-testid="union_message" data-message-id="current"><div data-testid="receive_message"><div data-testid="message_text_content">答案：B</div></div></section>`:'<div data-testid="receive_message"><div data-testid="message_text_content">历史回答：A</div></div>'}</div><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div><input type="file" onchange="uploaded()"><button data-testid="chat_input_send_button" onclick="sent()">发送</button></div>`});
 });
 seed();await p.goto(AI_PROVIDERS.doubao.url);
 let result=await askWebImage(args,AI_PROVIDERS.doubao);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'答案：B');assert.equal(p.url(),url);assert.equal(sends,0);assert.equal(uploads,0);assert.deepEqual(loadState().aiWebDrafts,{});
 seed();await p.goto(AI_PROVIDERS.doubao.url);await p.locator('.tiptap').fill('我自己的草稿');
 result=await askWebImage(args,AI_PROVIDERS.doubao);assert.equal(result.errorCode,'draft-not-empty');assert.equal(p.url(),AI_PROVIDERS.doubao.url);assert.equal(await p.locator('.tiptap').innerText(),'我自己的草稿');
 await p.locator('.tiptap').fill('');redirect=true;
 result=await askWebImage(args,AI_PROVIDERS.doubao);assert.equal(result.errorCode,'conversation-unavailable');assert.ok(loadState().aiWebDrafts[key]);assert.equal(sends,0);assert.equal(uploads,0);
 assert.equal(savedWebConversation({phase:'sent',pageUrl:'https://evil.example/chat/123456'},AI_PROVIDERS.doubao.url),'');
 assert.equal(savedWebConversation({phase:'sent',pageUrl:'https://www.doubao.com/chat/123456?redirect=other'},AI_PROVIDERS.doubao.url),'');
 assert.equal(savedWebConversation({phase:'prepared',pageUrl:url},AI_PROVIDERS.doubao.url),'');
 console.log('✓ 重启后恢复原对话并读取原回答：零发送、零上传、拒绝首页旧答案、保护用户草稿、失效对话保留检查点');
}finally{await b.close();}
