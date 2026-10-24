import {pathToFileURL} from 'node:url';
// Browser regression for a virtual list's disconnected ordering flags.
import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
const moduleRoot=process.env.XXT_TEST_SOURCE_ROOT?pathToFileURL(process.env.XXT_TEST_SOURCE_ROOT.replace(/\\/g,'/')+'/'):new URL('../../',import.meta.url);
const runtime=relative=>import(new URL(relative,moduleRoot).href);
const {findEdge}=await runtime('src/browser/launch.mjs');
const {beginWebTurn,endWebTurn}=await runtime('src/ai/web-turn.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage();await page.setContent('<section data-testid="union_message" id="history"><div data-testid="send_message">历史问题</div></section>');
 const marker='22222222-3333-4444-8555-666666666666',prompt=`本次提问标记：${marker}。标记仅用于区分本次提问，答案中不要重复标记。`;
 await beginWebTurn(page,{id:'doubao'},prompt);
 await page.evaluate(marker=>{
  const user=document.createElement('section');user.dataset.testid='union_message';user.innerHTML='<div data-testid="send_message">'+marker+'</div>';
  const nativeOrder=user.compareDocumentPosition.bind(user);
  // A recycled subtree can report DISCONNECTED together with FOLLOWING.
  // FOLLOWING alone must not turn an old question into a newer user message.
  user.compareDocumentPosition=other=>other.id==='history'?Node.DOCUMENT_POSITION_DISCONNECTED|Node.DOCUMENT_POSITION_FOLLOWING:nativeOrder(other);
  const answer=document.createElement('section');answer.dataset.testid='union_message';answer.dataset.messageId='current-answer';answer.innerHTML='<div data-testid="receive_message"><div data-testid="message_text_content">答案：对</div></div>';
  document.body.append(user,answer);
 },marker);
 await page.waitForTimeout(50);
 let result=await page.evaluate(()=>{const s=globalThis[Symbol.for('xxt.web-chat-turn')].read();return {invalidated:s.invalidated,text:s.answer?.innerText};});
 assert.equal(result.invalidated,false);assert.equal(result.text,'答案：对');
 await page.evaluate(()=>{const user=document.createElement('section');user.dataset.testid='union_message';user.innerHTML='<div data-testid="send_message">本人真正又发送的新问题</div>';document.body.append(user);});
 await page.waitForTimeout(50);result=await page.evaluate(()=>globalThis[Symbol.for('xxt.web-chat-turn')].read().invalidated);
 assert.equal(result,true,'仍须拒绝真正发生在当前回答之后的新提问');
 await endWebTurn(page,marker);
 // A folded prompt has no marker in its DOM. Observe the exact native POST
 // immediately, while withholding the response so history cannot be accepted.
 await page.route('https://www.doubao.com/**',r=>r.fulfill({contentType:'text/html',body:'<section data-testid="union_message" data-message-id="history-answer"><div data-testid="receive_message"><div data-testid="message_text_content">历史回答</div></div></section>'}));
 await page.goto('https://www.doubao.com/chat/');let releaseReply;
 const replyReady=new Promise(r=>{releaseReply=r;});
 const frame=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
 await page.route('https://www.doubao.com/chat/completion',async route=>{await replyReady;await route.fulfill({contentType:'text/event-stream',body:frame('SSE_ACK',{query_list:[{local_message_id:'folded-local'}]})+frame('STREAM_MSG_NOTIFY',{meta:{message_id:'folded-answer'}})+frame('SSE_REPLY_END',{msg_finish_attr:{msgid:'folded-answer'}})+frame('SSE_REPLY_END',{end_type:3})});});
 await beginWebTurn(page,{id:'doubao'},prompt);
 await page.evaluate(marker=>{document.body.insertAdjacentHTML('beforeend','<section data-testid="union_message"><div data-testid="send_message">折叠的长问题…</div></section>');void fetch('/chat/completion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{local_message_id:'folded-local',content_block:[{content:{text_block:{text:marker}}}]}]})});},marker);
 await page.waitForFunction(()=>globalThis[Symbol.for('xxt.web-chat-turn')].read().observed);
 result=await page.evaluate(()=>{const t=globalThis[Symbol.for('xxt.web-chat-turn')].read();return{observed:t.observed,answer:!!t.answer};});assert.equal(result.observed,true);assert.equal(result.answer,false,'发送已确认仍不能读取历史回答');
 await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<section data-testid="union_message" data-message-id="folded-answer"><div data-testid="receive_message"><div data-testid="message_text_content">本题回答</div></div></section>'));
 releaseReply();await page.waitForFunction(()=>globalThis[Symbol.for('xxt.web-chat-turn')].read().receipt);
 assert.equal(await page.evaluate(()=>globalThis[Symbol.for('xxt.web-chat-turn')].read().answer?.innerText),'本题回答');await endWebTurn(page,marker);
 console.log('✓ 脱离文档的虚拟节点不冒充新提问，真正的后续提问仍会阻止旧回答回填');
}finally{await browser.close();}
