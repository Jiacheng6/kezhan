// Real DOM lifecycle, no accounts or external requests. The sender is entirely
// unmounted before the first polling read, matching the hidden Doubao failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
const data=fs.mkdtempSync(path.resolve('.desktop-test/web-turn-'));
process.env.XXT_DATA_DIR=data;
const {findEdge}=await import('../../src/browser/launch.mjs');
const {beginWebTurn,endWebTurn}=await import('../../src/ai/web-turn.mjs');
const {webChatState,isCurrentWebAnswer}=await import('../../src/ai/web-chat.mjs');
const provider={id:'doubao'};
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try {
  const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><div id="history"></div><div class="tiptap" contenteditable="true"></div>'}));
  await page.goto('https://www.doubao.com/chat/');
  await page.evaluate(()=>{
    window.sequence=0;
    window.message=(role,text,id)=>{
      const union=document.createElement('div');union.dataset.testid='union_message';
      const node=document.createElement('div');node.dataset.testid=role==='user'?'send_message':'receive_message';
      const content=document.createElement('div');content.dataset.testid='message_content';content.dataset.messageId=id||`message-${++window.sequence}`;
      const textNode=document.createElement('div');textNode.dataset.testid='message_text_content';textNode.textContent=text;
      content.append(textNode);node.append(content);union.append(node);return union;
    };
    for(let i=0;i<4;i++)document.querySelector('#history').append(window.message('assistant','答案：B'));
  });
  const marked=index=>`问题 ${index}\n本次提问标记：11111111-2222-4333-8444-${String(index).padStart(12,'0')}。标记仅用于区分本次提问，答案中不要重复标记。`;
  for(let index=1;index<=3;index++) {
    const prompt=marked(index),baseline=await webChatState(page,provider);
    const marker=await beginWebTurn(page,provider,prompt);
    await page.evaluate(prompt=>{
      const history=document.querySelector('#history');
      history.append(window.message('user',prompt),window.message('assistant','答案：B'));
      setTimeout(()=>{
        history.querySelector('[data-testid=send_message]').closest('[data-testid=union_message]').remove();
        history.firstElementChild.remove();
        history.innerHTML=history.innerHTML; // Every answer node is remounted.
      },20);
    },prompt);
    await new Promise(r=>setTimeout(r,60));
    const state=await webChatState(page,provider);
    assert.equal(state.hasUserTurns,false,'the question must be absent, not just hidden');
    assert.equal(state.count,4);assert.equal(state.text,baseline.text);
    assert.equal(state.turnObserved,true);assert.equal(state.turnConfirmed,true);
    assert.equal(isCurrentWebAnswer(state,baseline,prompt),true);
    await endWebTurn(page,marker);
    assert.equal(await page.evaluate(()=>!!globalThis[Symbol.for('xxt.web-chat-turn')]),false,'observer must be disposed');
  }
  console.log('✓ sender unmounted before polling, identical replies and constant counts, reply remounted with stable message ID');
  const prompt=marked(4),baseline=await webChatState(page,provider),marker=await beginWebTurn(page,provider,prompt);
  await page.evaluate(prompt=>{
    const history=document.querySelector('#history');const group=document.createElement('section');
    group.append(window.message('user',prompt),window.message('assistant','答案：C','detached-current'));
    history.append(group);
    // Both nodes are removed in the same task, before MutationObserver fires.
    group.remove();history.append(window.message('assistant','答案：C','detached-current'));
  },prompt);
  let state=await webChatState(page,provider);
  assert.equal(state.hasUserTurns,false);assert.equal(isCurrentWebAnswer(state,baseline,prompt),true);
  assert.equal(state.text,'答案：C');
  await page.evaluate(()=>document.querySelector('#history').append(window.message('user','A separate manual question'),window.message('assistant','答案：D')));
  state=await webChatState(page,provider);
  assert.equal(state.turnInvalidated,true);assert.equal(isCurrentWebAnswer(state,baseline,prompt),false);
  await endWebTurn(page,marker);
  console.log('✓ removed subtree preserves verified ownership; a later manual question invalidates the request');
  const unknown=marked(5),old=await webChatState(page,provider),unknownMarker=await beginWebTurn(page,provider,unknown);
  await page.evaluate(()=>document.querySelector('#history').append(window.message('assistant','答案：D')));
  state=await webChatState(page,provider);
  assert.equal(state.turnObserved,false);assert.equal(isCurrentWebAnswer(state,old,unknown),false,'new answer alone is not proof of ownership');
  await endWebTurn(page,unknownMarker);
  console.log('✓ unknown or historical answers rejected without a verified user-turn link');
  // The real hidden client sometimes never mounts its sender, even briefly.
  // Associate the UI's own completed response with its DOM message ID instead.
  const {askImage}=await import('../../src/ai/ai.mjs');
  await page.route('**/chat/completion',async route=>{
    const body=route.request().postDataJSON(),localId=body.messages[0].local_message_id;
    const frame=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    await route.fulfill({contentType:'text/event-stream',body:frame('SSE_ACK',{query_list:[{local_message_id:localId}]})+frame('STREAM_MSG_NOTIFY',{meta:{message_id:'reply-'+localId},content:'The receipt content is not used as the answer'})+frame('SSE_REPLY_END',{end_type:1,msg_finish_attr:{msgid:'reply-'+localId}})+frame('SSE_REPLY_END',{end_type:3})});
  });
  await page.setContent('<div id="history"></div><div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div><input type="file" accept="image/png"><div id="attachment"></div><button data-testid="chat_input_send_button">发送</button></div>');
  await page.evaluate(()=>{
    window.sent=0;const history=document.querySelector('#history'),input=document.querySelector('input');
    for(let i=0;i<4;i++)history.append(window.message('assistant','答案：B'));
    input.onchange=()=>{const img=document.createElement('img');img.alt=input.files[0].name;img.src=URL.createObjectURL(input.files[0]);document.querySelector('#attachment').append(img);};
    document.querySelector('button').onclick=async()=>{
      const editor=document.querySelector('.tiptap'),prompt=editor.innerText,localId='turn-'+(++window.sent);
      editor.innerText='';document.querySelector('#attachment').innerHTML='';
      await (await fetch('/chat/completion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{local_message_id:localId,content_block:[{content:{text_block:{text:prompt}}}]}]})})).text();
      history.append(window.message('assistant','答案：B','reply-'+localId));history.firstElementChild.remove();history.innerHTML=history.innerHTML;
    };
  });
  for(let index=0;index<3;index++){
    const result=await askImage({page,imagePath:path.resolve('.desktop-test/hidden-screenshot/verified-hidden.png'),prompt:'Only return the answer',freshChat:false});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'答案：B');
    const after=await webChatState(page,provider);assert.equal(after.count,4);assert.equal(after.hasUserTurns,false);
    assert.equal(await page.evaluate(()=>!!globalThis[Symbol.for('xxt.web-chat-turn')]),false);
  }
  console.log('✓ complete image-send/read chain with no sender ever mounted, identical answers, constant count and remounted DOM');
} finally {await browser.close();}
