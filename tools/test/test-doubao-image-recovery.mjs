import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright-core';import {fixturePng} from './fixture-png.mjs';
const {findEdge}=await import('../../src/browser/launch.mjs');const {beginWebTurn,endWebTurn}=await import('../../src/ai/web-turn.mjs');const {webChatState,isCurrentWebAnswer}=await import('../../src/ai/web-chat.mjs');const {recoverDoubaoImageTurn}=await import('../../src/ai/doubao-image-recovery.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const p=await b.newPage(),url='https://www.doubao.com/chat/123456',image=fixturePng(),draft={phase:'sent',pageUrl:url,imageHash:createHash('sha256').update(image).digest('hex')};
 const marker='22222222-3333-4444-8555-666666666666',prompt=`本次提问标记：${marker}。标记仅用于区分本次提问，答案中不要重复标记。`;
 await p.route('**/*',r=>r.request().resourceType()==='image'?r.fulfill({contentType:'image/png',body:image}):r.fulfill({contentType:'text/html; charset=utf-8',body:'<section data-testid="union_message"><div data-testid="receive_message"><div data-testid="message_text_content">历史回答 A</div></div></section><section data-testid="union_message"><div data-testid="send_message"><div data-message-id="original-image"><img src="https://p11-flow-imagex-sign.byteimg.com/existing.png"></div></div></section><section data-testid="union_message"><div data-testid="receive_message"><div data-message-id="original-reply"><div data-testid="message_text_content">答案：AC</div></div></div></section><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div></div>'}));
 const reset=async()=>{await p.goto(url);await beginWebTurn(p,{id:'doubao'},prompt,{resume:true});};
 await reset();const baseline=await webChatState(p,{id:'doubao'});
 assert.equal(await recoverDoubaoImageTurn(p,draft,{readImage:async()=>image}),true);
 let state=await webChatState(p,{id:'doubao'});assert.equal(isCurrentWebAnswer(state,baseline,prompt),true);assert.equal(state.text,'答案：AC');
 // A later image-only request is a real new user turn, even without text.
 await p.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<section data-testid="union_message"><div data-testid="send_message"><img src="https://p11-flow-imagex-sign.byteimg.com/new.png"></div></section>'));
 state=await webChatState(p,{id:'doubao'});assert.equal(state.turnInvalidated,true);assert.equal(isCurrentWebAnswer(state,baseline,prompt),false);
 await reset();assert.equal(await recoverDoubaoImageTurn(p,draft,{readImage:async()=>Buffer.from('wrong image')}),false);
 assert.equal(await recoverDoubaoImageTurn(p,{...draft,pageUrl:'https://www.doubao.com/chat/999'},{readImage:async()=>image}),false);
 await reset();assert.equal(await recoverDoubaoImageTurn(p,draft,{readImage:async()=>{await p.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div data-testid="send_message">后来发送的新题目</div>'));return image;}}),false,'下载期间切换题目不得绑定旧回答');
 await reset();await p.locator('img').evaluate(e=>e.src='https://internal.example/existing.png');let reads=0;assert.equal(await recoverDoubaoImageTurn(p,draft,{readImage:async()=>{reads++;return image;}}),false);assert.equal(reads,0,'不读取任意图片地址');
 await endWebTurn(p,marker);
 console.log('✓ 旧版纯图片提问：完整截图校验恢复正确回答、拒绝相似/错图/跨对话、异步竞态与后续纯图片提问保护');
}finally{await b.close();}
