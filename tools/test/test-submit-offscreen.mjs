// Reproduce the real 0.5.11 failure: a fixed confirmation inside a tall iframe
// is visible to the inner document, but clipped by the outer web view.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
import {pathToFileURL} from 'node:url';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/submit-offscreen-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const runtime=process.env.XXT_TEST_SOURCE_ROOT?pathToFileURL(path.join(process.env.XXT_TEST_SOURCE_ROOT,'src/chaoxing/quizrun.mjs')).href:new URL('../../src/chaoxing/quizrun.mjs',import.meta.url).href;
const {submitWork}=await import(runtime);
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1046,height:627}});
 await page.route('https://mooc1.chaoxing.com/**',route=>{const url=new URL(route.request().url());
  if(url.pathname==='/parent')return route.fulfill({contentType:'text/html',body:`<style>html,body{margin:0;height:100%;overflow:hidden}iframe{position:fixed;left:100px;top:30px;width:846px;height:${url.searchParams.get('height')}px;border:0}</style><iframe src="/mooc-ans/work/doHomeWorkNew?workId=fixture"></iframe>`});
  return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>body{margin:0;height:100vh}.maskDiv{position:fixed;inset:0}.popDiv{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:440px;height:210px;overflow:hidden}.popBottom{position:absolute;bottom:0;left:0;width:440px;height:70px}#popok{display:block;margin:17px 30px 0 auto;width:92px;height:36px}</style><div id="workpop" class="maskDiv"><div class="popDiv">确认提交作业？<div class="popBottom"><a id="popok" role="button" tabindex="0" aria-label="确定" href="javascript:;">提交</a></div></div></div><script>window.activations=[];document.querySelector('#popok').onclick=e=>{window.activations.push({trusted:e.isTrusted,detail:e.detail});if(e.isTrusted)document.body.innerHTML='<p>提交成功，本次成绩 90 分</p>';};</script>`});
 });
 for(const height of [1544,1260]){
  await page.goto('https://mooc1.chaoxing.com/parent?height='+height);const frame=page.frames().find(f=>f.url().includes('doHomeWorkNew'));
  await assert.rejects(frame.locator('#popok').click({timeout:350}),/outside.*viewport/,'旧鼠标路径必须能复现用户失败');
  const result=await submitWork(frame,{confirmationOnly:true});assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(await frame.evaluate(()=>window.activations),[{trusted:true,detail:0}],'只能通过一次原生键盘激活确认，不能发送伪造点击');
 }
 console.log('✓ 1544/1260 像素高 iframe：复现鼠标越界失败，原生 Enter 确认一次并核对提交成功');
}finally{await browser.close();}
