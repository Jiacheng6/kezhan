// Local intercepted AI markup: one image send, captcha, manual continue, one answer.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {chromium} from 'playwright-core';
import {fixturePng} from './fixture-png.mjs';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/web-resume-'));process.env.XXT_DESKTOP='1';
const {findEdge}=await import('../../src/browser/launch.mjs');const {askWebImage,dismissWebObstructions}=await import('../../src/ai/web-chat.mjs');
const {AI_PROVIDERS}=await import('../../src/ai/providers.mjs');const {continueAI,aiResumeStatus}=await import('../../src/ai/resume.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage();await page.route('https://chat.deepseek.com/**',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div role="dialog" id="promotion"><p>下载电脑版</p><button aria-label="关闭" onclick="this.parentElement.remove()">×</button></div><div id="answers"></div><div class="_77cefa5"><textarea placeholder="给 DeepSeek 发送消息"></textarea><input type="file" accept="image/png"><div id="preview"></div><div role="button" class="ds-button--primary ds-button--circle">发送</div></div><script>window.sent=0;document.querySelector('input').onchange=()=>document.querySelector('#preview').innerHTML='<img src="'+URL.createObjectURL(document.querySelector('input').files[0])+'">';document.querySelector('[role=button]').onclick=()=>{window.sent++;document.querySelector('textarea').value='';document.querySelector('#preview').innerHTML='';document.body.insertAdjacentHTML('beforeend','<div role="dialog" id="captcha">请完成安全验证<button id="verified">我已验证</button></div>');document.querySelector('#verified').onclick=()=>{document.querySelector('#captcha').remove();document.querySelector('#answers').innerHTML='<div class="ds-assistant-message-main-content">答案：B</div>';}};</script>`}));
 await page.goto('https://chat.deepseek.com/');await dismissWebObstructions(page);assert.equal(await page.locator('#promotion').count(),0);
 const imagePath=path.join(process.env.XXT_DATA_DIR,'fixture.png');fs.writeFileSync(imagePath,fixturePng());let settled=false;
 const result=askWebImage({page,imagePath,prompt:'选择答案',freshChat:false},AI_PROVIDERS.deepseek).finally(()=>{settled=true;});
 const deadline=Date.now()+12000;while(!aiResumeStatus().waiting&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(aiResumeStatus().waiting,true);await assert.rejects(continueAI(),/仍要求验证/);assert.equal(await page.locator('#captcha').count(),1,'不能自动关闭人工验证');
 await page.locator('#verified').click();await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false,'网页验证完成后仍须显式继续');
 await continueAI();assert.equal((await result).answer,'答案：B');assert.equal(await page.evaluate(()=>window.sent),1,'续跑不能重复发送题目');assert.equal(aiResumeStatus().waiting,false);
 console.log('✓ 真实隔离网页：关闭推广弹窗、保留人工验证、显式继续同题、读取回答且仅发送一次通过');
}finally{await browser.close();}
