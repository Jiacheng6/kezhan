import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {chromium} from 'playwright-core';
import {findEdge} from '../../src/browser/launch.mjs';
import {inspectQuestionFonts} from '../../src/chaoxing/question-fonts.mjs';
import {shootQuestion} from '../../src/chaoxing/quiz.mjs';
const bytes=fs.readFileSync(path.join(process.env.WINDIR || 'C:\\Windows','Fonts','arial.ttf'));
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try {
 const page=await browser.newPage();const hits=new Map();
 await page.route('https://font-recovery.invalid/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/page')return route.fulfill({contentType:'text/html',body:`<style>
   @font-face{font-family:QuestionA;src:url('/a.ttf?signature=preserved');font-weight:400}
   @font-face{font-family:QuestionB;src:url('/b.ttf');font-weight:700}
   .a{font:400 22px QuestionA}.b{font:700 22px QuestionB}</style>
   <div id="question"><div class="Zy_TItle"><span class="a">Synthetic question A</span><span class="b">Synthetic question B</span></div></div>`});
   assert.ok(['/a.ttf','/b.ttf'].includes(url.pathname),'must only load original font sources');
   if(url.pathname==='/a.ttf')assert.equal(url.search,'?signature=preserved');
   const n=(hits.get(url.pathname)||0)+1;hits.set(url.pathname,n);
   return route.fulfill(n===1?{status:503,body:'temporary error'}:{contentType:'font/ttf',body:bytes});
 });
 await page.goto('https://font-recovery.invalid/page');
 await page.waitForFunction(()=>[...document.fonts].filter(f=>f.status==='error').length===2);
 const question=page.locator('#question');
 const failed=await question.evaluate(inspectQuestionFonts);assert.equal(failed.failed,true);
 await question.evaluate(inspectQuestionFonts,{recover:true});
 await page.waitForFunction(()=>document.fonts.check('400 22px QuestionA','Synthetic question A')&&document.fonts.check('700 22px QuestionB','Synthetic question B'),null,{timeout:5000}).catch(async error=>{console.log([...hits],await page.evaluate(()=>[...document.fonts].map(f=>({family:f.family,status:f.status,weight:f.weight}))),await question.evaluate(inspectQuestionFonts));throw error;});
 const recovered=await question.evaluate(inspectQuestionFonts);
 assert.equal(recovered.pending,0);assert.equal(recovered.failed,false);
 const descriptors=await page.evaluate(()=>[...document.fonts].filter(f=>f.status==='loaded').map(f=>[f.family,f.weight]));
 assert.ok(descriptors.some(([f,w])=>f==='QuestionA'&&w==='400'));
 assert.ok(descriptors.some(([f,w])=>f==='QuestionB'&&w==='700'));
 assert.equal(hits.get('/a.ttf'),2);assert.equal(hits.get('/b.ttf'),2);
 const output=fs.mkdtempSync(path.resolve('.desktop-test/font-recovery-capture-'));
 for(let i=0;i<3;i++) {
   const file=await shootQuestion(page.mainFrame(),0,output,{selector:'#question',readTimeoutMs:1500,fontTimeoutMs:1500});
   const image=fs.readFileSync(file);assert.equal(image.readUInt32BE(0),0x89504e47);assert.ok(image.length>1000);
 }
 console.log('✓ 两种真实字体从503恢复：来源精确匹配、字重保留、签名URL未改、未错配字体');
 console.log('✓ 恢复后连续三次取得真实PNG，未再次请求失败字体');
} finally {await browser.close();}
