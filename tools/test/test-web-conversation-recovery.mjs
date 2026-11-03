import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';import {fixturePng} from './fixture-png.mjs';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/conversation-recovery-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {askWebImage}=await import('../../src/ai/web-chat.mjs');const {AI_PROVIDERS}=await import('../../src/ai/providers.mjs');
const {draftKey,createWebDraft,saveWebDraft,savedWebConversation}=await import('../../src/ai/web-draft.mjs');const {loadState}=await import('../../src/state.mjs');
const {recoverWebConversation}=await import('../../src/ai/conversation-recovery.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const p=await b.newPage(),basePrompt='测试原题',marker='22222222-3333-4444-8555-666666666666',prompt=`${basePrompt}\n\n本次提问标记：${marker}。标记仅用于区分本次提问，答案中不要重复标记。`;
 const imagePath=path.join(process.env.KEBO_DATA_DIR,'fixture.png');fs.writeFileSync(imagePath,fixturePng());
 const args={page:p,imagePath,prompt:basePrompt,taskKey:'restore-chat',question:{questionId:'q2',qtype:'single',options:[{letter:'A',text:'甲'},{letter:'B',text:'乙'}]}};
 const key=draftKey('doubao',args.taskKey,args.question),url='https://www.doubao.com/chat/123456';
 const seed=(pageUrl=url)=>{createWebDraft(key,{prompt,basePrompt,pageUrl,imagePath});saveWebDraft(key,{phase:'sent'});};
 let sends=0,uploads=0,redirect=false;
 await p.exposeFunction('sent',()=>sends++);await p.exposeFunction('uploaded',()=>uploads++);
 await p.route('https://www.doubao.com/**',r=>{
  const saved=r.request().url()===url;
  return r.fulfill({contentType:'text/html; charset=utf-8',body:`${saved&&redirect?'<script>history.replaceState(null,"","/chat/")</script>':''}<nav><a href="/chat/999999">同名的其他题目</a><a href="/chat/123456">原题</a><a href="https://evil.example/chat/123456">外站</a></nav><div id="messages">${saved?`<section data-testid="union_message"><div data-testid="send_message">${prompt}</div></section><section data-testid="union_message" data-message-id="current"><div data-testid="receive_message"><div data-testid="message_text_content">答案：B</div></div></section>`:'<section data-testid="union_message"><div data-testid="send_message">同一个题干，但不含本题标记</div></section><div data-testid="receive_message"><div data-testid="message_text_content">历史回答：A</div></div>'}</div><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div><input type="file" onchange="uploaded()"><button data-testid="chat_input_send_button" onclick="sent()">发送</button></div>`});
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
 redirect=false;seed('https://www.doubao.com/chat/local_1234567890123456');await p.goto(AI_PROVIDERS.doubao.url);
 result=await askWebImage(args,AI_PROVIDERS.doubao);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'答案：B');assert.equal(p.url(),url);assert.equal(sends,0);assert.equal(uploads,0);assert.deepEqual(loadState().aiWebDrafts,{});
 seed('https://www.doubao.com/chat/local_1234567890123456');await p.goto(AI_PROVIDERS.doubao.url);await p.locator('.tiptap').fill('保留新草稿');
 result=await askWebImage(args,AI_PROVIDERS.doubao);assert.equal(result.errorCode,'draft-not-empty');assert.equal(await p.locator('.tiptap').innerText(),'保留新草稿');assert.equal(sends,0);assert.equal(uploads,0);
 console.log('✓ 临时 local 会话记录通过唯一标记找回正式对话：不误用同名旧题、不上传、不重发、不覆盖草稿');
 // A real native-button send first gets a local route; the canonical route
 // arrives later, before a stop/restart. Preserve it while still waiting.
 const moving=await b.newPage();let actualSends=0,actualUploads=0,reply=false,checkpoint;
 await moving.exposeFunction('countSend',()=>actualSends++);await moving.exposeFunction('countUpload',()=>actualUploads++);
 await moving.route('https://www.doubao.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="messages">${reply&&r.request().url().endsWith('/333333')?`<div data-testid="send_message">${checkpoint.prompt}</div><div data-testid="receive_message"><div data-testid="message_text_content">答案：B</div></div>`:''}</div><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div><input type="file"><div id="attachment"></div><button data-testid="chat_input_send_button">发送</button></div><script>
 const editor=document.querySelector('.tiptap'),input=document.querySelector('input');input.onchange=()=>{countUpload();document.querySelector('#attachment').innerHTML='<img alt="'+input.files[0].name+'" src="'+URL.createObjectURL(input.files[0])+'">';};
 document.querySelector('button').onclick=()=>{countSend();const user=document.createElement('div');user.dataset.testid='send_message';user.textContent=editor.innerText;document.querySelector('#messages').append(user);editor.innerText='';document.querySelector('#attachment').innerHTML='';history.replaceState(null,'','/chat/local_1234567');setTimeout(()=>history.replaceState(null,'','/chat/333333'),300);};</script>`}));
 await moving.goto(AI_PROVIDERS.doubao.url);const movingArgs={...args,page:moving,taskKey:'moving-conversation'};const movingKey=draftKey('doubao',movingArgs.taskKey,movingArgs.question),stopAt=Date.now()+4000;
 await assert.rejects(askWebImage({...movingArgs,shouldStop:()=>Date.now()>=stopAt},AI_PROVIDERS.doubao),e=>e.code==='STOPPED');
 checkpoint=loadState().aiWebDrafts[movingKey];assert.equal(checkpoint.pageUrl,'https://www.doubao.com/chat/333333');assert.equal(checkpoint.phase,'sent');
 reply=true;await moving.goto(AI_PROVIDERS.doubao.url);result=await askWebImage(movingArgs,AI_PROVIDERS.doubao);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'答案：B');assert.equal(actualSends,1);assert.equal(actualUploads,1);await moving.close();
 console.log('✓ 发送后正式会话延迟出现时持续落盘；中止后从首页恢复，累计仅一次上传、一次发送');
 const guarding=await b.newPage();await guarding.route('https://www.doubao.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="/chat/111111">其他对话</a><a href="/chat/222222">下条对话</a><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div></div>${r.request().url().endsWith('/111111')?'<script>setTimeout(()=>document.querySelector(".tiptap").innerText="新输入的用户草稿",30)</script>':''}`}));
 await guarding.goto(AI_PROVIDERS.doubao.url);let navigations=0;guarding.on('framenavigated',()=>navigations++);
 const protectedDuringSearch=await recoverWebConversation(guarding,{prompt},{hydrateMs:200});assert.equal(protectedDuringSearch.reason,'draft-present');assert.equal(navigations,1);assert.equal(await guarding.locator('.tiptap').innerText(),'新输入的用户草稿');
 await assert.rejects(recoverWebConversation(guarding,{prompt},{shouldStop:()=>true}),e=>e.code==='STOPPED');assert.equal(navigations,1);await guarding.close();
 console.log('✓ 恢复搜索途中出现的新草稿受到保护；停止后不继续导航');
 const orphan=await b.newPage();let reasks=0,reuploads=0;
 await orphan.exposeFunction('recordReask',()=>reasks++);await orphan.exposeFunction('recordReupload',()=>reuploads++);
 await orphan.route('https://www.doubao.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="/chat/444444">不匹配的旧对话</a><div id="messages"></div><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div><input type="file"><div id="attachment"></div><button data-testid="chat_input_send_button">发送</button></div><script>
 const editor=document.querySelector('.tiptap'),input=document.querySelector('input');input.onchange=()=>{recordReupload();document.querySelector('#attachment').innerHTML='<img alt="'+input.files[0].name+'" src="'+URL.createObjectURL(input.files[0])+'">';};document.querySelector('button').onclick=()=>{recordReask();const u=document.createElement('div');u.dataset.testid='send_message';u.textContent=editor.innerText;document.querySelector('#messages').append(u);editor.innerText='';document.querySelector('#attachment').innerHTML='';document.querySelector('#messages').insertAdjacentHTML('beforeend','<div data-testid="receive_message"><div data-testid="message_text_content">答案：B</div></div>');history.replaceState(null,'','/chat/555555');};</script>`}));
 const orphanArgs={...args,page:orphan,taskKey:'manual-orphan'},orphanKey=draftKey('doubao',orphanArgs.taskKey,orphanArgs.question);
 const seedOrphan=recoveryReasked=>{createWebDraft(orphanKey,{prompt,basePrompt,pageUrl:'https://www.doubao.com/chat/local_1234',imagePath});saveWebDraft(orphanKey,{phase:'sent',recoveryReasked});};
 seedOrphan(false);await orphan.goto(AI_PROVIDERS.doubao.url);result=await askWebImage(orphanArgs,AI_PROVIDERS.doubao);assert.equal(result.errorCode,'conversation-unavailable');assert.equal(reasks,0);assert.equal(reuploads,0,'automatic recovery cannot upload again');
 seedOrphan(true);result=await askWebImage({...orphanArgs,resendMissingConversation:true},AI_PROVIDERS.doubao);assert.equal(result.errorCode,'conversation-unavailable');assert.equal(reasks,0,'an already attempted reask cannot be repeated automatically');
 seedOrphan(false);result=await askWebImage({...orphanArgs,resendMissingConversation:true},AI_PROVIDERS.doubao);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'答案：B');assert.equal(reasks,1);assert.equal(reuploads,1);assert.ok(loadState().aiWebDrafts[key],'other saved task checkpoints stay intact');await orphan.close();
 console.log('✓ 普通恢复不重发；明确的未完成题重试只重问一次；其他检查点和已答草稿保留');
 console.log('✓ 重启后恢复原对话并读取原回答：零发送、零上传、拒绝首页旧答案、保护用户草稿、失效对话保留检查点');
}finally{await b.close();}
