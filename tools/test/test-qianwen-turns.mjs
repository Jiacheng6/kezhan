// Current Qianwen selectors in intercepted markup, no real AI request.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
import {fixturePng} from './fixture-png.mjs';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/qianwen-turns-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {askImage,readEditor}=await import('../../src/ai/ai.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage(),imagePath=path.join(process.env.XXT_DATA_DIR,'fixture.png'),png=fixturePng();fs.writeFileSync(imagePath,png);
 await page.route('https://workspace-zb-cdn.qianwen.com/**',route=>route.fulfill({contentType:'image/png',body:png}));
 await page.route('https://www.qianwen.com/**',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div contenteditable="true" hidden>隐藏旧编辑器</div><button aria-label="发送消息" hidden>隐藏发送</button><button aria-label="停止生成" hidden>旧停止</button><div class="answer-receiving-card" hidden>旧加载</div><img src="https://workspace-zb-cdn.qianwen.com/old.png"><div id="answers"><div class="chat-answers-card-wrap">A</div></div><div id="composer"><div contenteditable="true" data-placeholder="向千问提问"></div><div id="attachment"></div><button aria-label="发送消息">发送</button></div><script>window.sent=0;const editor=document.querySelector('#composer [contenteditable]');editor.onpaste=()=>setTimeout(()=>document.querySelector('#attachment').innerHTML='<img src="https://workspace-zb-cdn.qianwen.com/new.png">',350);document.querySelector('#composer button').onclick=()=>{window.sent++;editor.innerText='';document.querySelector('#attachment').innerHTML='';document.querySelector('#answers').innerHTML='<div class="chat-answers-card-wrap">A</div>';};</script>`}));
 await page.goto('https://www.qianwen.com/');assert.equal((await readEditor(page)).empty,true);
 for(let i=0;i<2;i++){const result=await askImage({page,imagePath,prompt:'只返回答案',freshChat:false});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.answer,'A');}
 assert.equal(await page.evaluate(()=>window.sent),2,'同一答案、同一卡片数仍须读取本轮新回答');
 await page.locator('#composer [contenteditable]').fill('用户自己的草稿');const protectedDraft=await askImage({page,imagePath,prompt:'不可覆盖',freshChat:true});assert.equal(protectedDraft.errorCode,'draft-not-empty');assert.equal((await readEditor(page)).text,'用户自己的草稿');
 console.log('✓ 千问：可见编辑器与按钮、隐藏加载排除、旧图片不算本次上传、连续相同答案与草稿保护通过');
}finally{await browser.close();}
