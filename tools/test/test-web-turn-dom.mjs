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
 console.log('✓ 脱离文档的虚拟节点不冒充新提问，真正的后续提问仍会阻止旧回答回填');
}finally{await browser.close();}
