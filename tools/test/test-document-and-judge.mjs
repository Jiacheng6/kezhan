import {pathToFileURL} from 'node:url';
// Intercepted synthetic pages; never accesses an account or submits coursework.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
const moduleRoot=process.env.XXT_TEST_SOURCE_ROOT?pathToFileURL(process.env.XXT_TEST_SOURCE_ROOT.replace(/\\/g,'/')+'/'):new URL('../../',import.meta.url);
const runtime=relative=>import(new URL(relative,moduleRoot).href);
process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/document-judge-'));
const {findEdge}=await runtime('src/browser/launch.mjs');
const {readDocumentAttachment,openDocumentViewer}=await runtime('src/chaoxing/document.mjs');
const {runDocTask}=await runtime('src/chaoxing/runner.mjs');
const {mutateState,loadState}=await runtime('src/state.mjs');
const {extractQuestions,selectOptions,readSelection}=await runtime('src/chaoxing/quiz.mjs');
const {parseAnswer,validateBeforeSubmit}=await runtime('src/ai/parse.mjs');
mutateState(s=>{s.settings={docDwellSec:0,maxCardProbe:1,greenDotWaitMs:1,greenDotRetries:1};});
const browser=await chromium.launch({executablePath:findEdge(),headless:true});const ctx=await browser.newContext();
let finished=false,completions=0;
await ctx.route('https://**.chaoxing.com/**',async route=>{
 const url=new URL(route.request().url());
 if(url.pathname.includes('/knowledge/cards'))return route.fulfill({contentType:'text/html',body:`<div class="ans-attach-ct ans-job-finished"><iframe src="/ananas/modules/video/index.html" data='{"name":"示例视频","jobid":"video"}'></iframe></div><div class="ans-attach-ct ${finished?'ans-job-finished':''}"><i class="ans-job-icon" aria-label="任务点未完成"></i><iframe src="/ananas/modules/pdf/index.html" data='{"title":"示例阅读.pdf","jobid":"doc-job","objectid":"file-id"}' style="width:850px;height:500px"></iframe></div><div class="ans-attach-ct"><iframe src="/ananas/modules/pdf/other.html" data='{"name":"示例阅读.pdf","jobid":"other-job"}'></iframe></div>`});
 if(url.pathname==='/ananas/modules/pdf/index.html')return route.fulfill({contentType:'text/html',body:`<div id="maskLayer" onclick="this.hidden=true;document.querySelector('iframe').src='/screen/v2/fixture'">打开正文</div><iframe id="panView" style="width:800px;height:460px"></iframe><script>addEventListener('message',async e=>{if(e.source!==document.querySelector('iframe').contentWindow||!e.data.isFinished)return;await fetch('/native-doc-record');parent.document.querySelectorAll('.ans-attach-ct')[1].classList.add('ans-job-finished');});</script>`});
 if(url.pathname==='/screen/v2/fixture')return route.fulfill({contentType:'text/html',body:`<div class="fileBox"><img style="width:750px;height:2100px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div><script>let sent=false;addEventListener('scroll',()=>{if(!sent&&scrollY+innerHeight>=document.documentElement.scrollHeight-20){sent=true;parent.postMessage({isFinished:1},'*');}});</script>`});
 if(url.pathname==='/native-doc-record'){finished=true;completions++;return route.fulfill({json:{status:true}});}
 return route.fulfill({contentType:'text/html',body:'未处理的相邻附件'});
});
const task={key:'document',type:'doc',name:'示例阅读.pdf',jobid:'doc-job',objectId:'file-id',courseId:'course',clazzId:'class',knowledgeId:'section',cardNum:0,secNo:'1.1',finished:false};
try{
 const result=await runDocTask({ctx,task,personId:'student'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.greenDot,true);assert.equal(completions,1);assert.equal(loadState().taskPoints.document.status,'done');
 const page=await ctx.newPage();await page.goto('https://mooc1.chaoxing.com/mooc-ans/knowledge/cards');
 assert.equal((await readDocumentAttachment(page,task)).finished,true);
 assert.equal((await readDocumentAttachment(page,{...task,jobid:'other-job'})).finished,false,'相邻文档不能被当成完成');
 const missing=await runDocTask({ctx,task:{...task,key:'missing',jobid:'missing-job'},personId:'student'});assert.equal(missing.phase,'needs-human');assert.equal(loadState().taskPoints.missing.status,'manual','未找到附件绝不能作为非任务点标为完成');
 await assert.rejects(openDocumentViewer(page,task,{shouldStop:()=>true}),e=>e.code==='STOPPED');
 const quiz=await ctx.newPage();await quiz.setContent(`<div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【判断题】</span><p>示例判断</p></div><ul>${['true','false'].map((v,i)=>`<li qid="question" role="radio" onclick="document.querySelectorAll('li span').forEach(s=>s.classList.remove('check_answer'));this.querySelector('span').classList.add('check_answer');document.querySelector('input').value='${v}'"><span class="num_option" data="${v}">${'AB'[i]}</span><a class="after"><p>${i?'错':'对'}</p></a></li>`).join('')}</ul><input type="hidden"></div>`);
 const [question]=await extractQuestions(quiz.mainFrame());assert.deepEqual(question.options.map(o=>[o.letter,o.displayLetter]),[['true','A'],['false','B']]);
 for(const raw of ['答案：B','答案：B','答案：A']){const parsed=parseAnswer(raw,question);assert.equal(validateBeforeSubmit(parsed,question).safe,true);assert.equal((await selectOptions(quiz.mainFrame(),0,parsed.letters)).ok,true);assert.deepEqual((await readSelection(quiz.mainFrame(),0)).selected,parsed.letters);assert.equal(await quiz.locator('input').inputValue(),parsed.letters[0]);}
 await quiz.setContent(`<div class="TiMu singleQuesId" data="native-question"><div class="Zy_TItle"><div class="fontLabel">【判断题】示例原生表单判断题。</div></div><ul class="Zy_ulBottom"><li role="radio" aria-label="对选择"><label>对<input type="radio" name="answer-native" value="true"></label></li><li role="radio" aria-label="错选择"><label>错<input type="radio" name="answer-native" value="false"></label></li></ul></div>`);
 const [nativeQuestion]=await extractQuestions(quiz.mainFrame());assert.equal(nativeQuestion.qtype,'judge');assert.equal(nativeQuestion.questionId,'native-question');assert.equal(nativeQuestion.options.length,2);
 for(const answer of ['答案：错','答案：对']){const parsed=parseAnswer(answer,nativeQuestion);assert.equal(parsed.confidence,'high');assert.equal((await selectOptions(quiz.mainFrame(),0,parsed.letters)).ok,true);assert.deepEqual((await readSelection(quiz.mainFrame(),0)).selected,parsed.letters);assert.equal(await quiz.locator('input:checked').inputValue(),parsed.letters[0]);}
 console.log('✓ 阅读真实正文滚动与平台原生记录、同名附件身份、后台浏览、未知不冒充完成，以及判断题A/B到true/false点选回读通过');
}finally{await ctx.close();await browser.close();}
