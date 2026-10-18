// All pages intercepted locally; no real assignment is submitted.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/submit-dialogs-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {submitWork}=await import('../../src/chaoxing/quizrun.mjs');
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage();
 await page.route('https://mooc1.chaoxing.com/**',route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/parent')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><iframe src="/mooc-ans/work/doHomeWorkNew?workId=fixture"></iframe><button id="popok" hidden>旧确认</button><div role="dialog" id="modal" hidden>是否提交作业？<button id="popok" onclick="document.querySelector('iframe').contentWindow.finish();this.parentElement.hidden=true">确认提交</button></div><script>window.shown=0;window.addEventListener('message',()=>{window.shown++;document.querySelector('#modal').hidden=false;});</script>`});
  return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><button class="btnSubmit" hidden>旧提交</button><button class="btnSubmit" onclick="parent.postMessage('submit','*')">提交作业</button><script>window.done=0;window.finish=()=>{window.done++;document.body.innerHTML='<p>已提交，本次成绩 90 分</p>';};</script>`});
 });
 await page.goto('https://mooc1.chaoxing.com/parent');let frame=page.frames().find(f=>f.url().includes('doHomeWorkNew'));
 let result=await submitWork(frame);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(await page.evaluate(()=>window.shown),1);assert.equal(await frame.evaluate(()=>window.done),1,'跨父页确认且忽略隐藏的重复按钮');
 await page.reload();frame=page.frames().find(f=>f.url().includes('doHomeWorkNew'));await frame.locator('.btnSubmit').filter({visible:true}).click();await page.locator('#modal').waitFor({state:'visible'});
 result=await submitWork(frame,{confirmationOnly:true});assert.equal(result.ok,true);assert.equal(await page.evaluate(()=>window.shown),1,'已有确认框只能继续确认，不能再次发起提交');
 await page.reload();frame=page.frames().find(f=>f.url().includes('doHomeWorkNew'));result=await submitWork(frame,{confirmationOnly:true});assert.equal(result.ok,false);assert.equal(result.pendingConfirmation,true);assert.equal(await page.evaluate(()=>window.shown),0,'未知结果且无确认框不能重交');
 await frame.evaluate(()=>{document.body.innerHTML='<button class="btnSubmit" onclick="if(confirm(\'是否提交作业？\'))document.body.innerHTML=\'<p>提交成功，本次成绩 90 分</p>\'">提交作业</button>';});
 result=await submitWork(frame);assert.equal(result.ok,true,JSON.stringify(result));
 console.log('✓ 提交确认：跨父页弹窗、隐藏重复按钮、原生确认、现有确认恢复与未知结果禁止重交通过');
}finally{await browser.close();}
