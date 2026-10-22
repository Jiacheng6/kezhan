import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/partial-retry-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {ensureDirs}=await import('../../src/config.mjs');ensureDirs();
const {loadState,mutateState}=await import('../../src/state.mjs');const {runQuizTask}=await import('../../src/chaoxing/quizrun.mjs');const {parseAnswer,validateBeforeSubmit}=await import('../../src/ai/parse.mjs');
mutateState(s=>{s.settings={submitMode:'auto',essayAutoFill:true,ai:{provider:'doubao'}};});
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const ctx=await b.newContext();let attempt='one';
 await ctx.route('**/*',route=>{const url=route.request().url();const body=url.includes('doubao.com')?'<div data-testid="chat_input"><div class="tiptap" contenteditable="true"> </div></div>':url.includes('/knowledge/cards')?`<div class="ans-attach-ct"><span class="ans-job-icon" aria-label="任务点未完成"></span><iframe data='{"name":"示例作业","jobid":"fixture-job"}' src="https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=fixture-work&workAnswerId=${attempt}"></iframe></div>`:`<h1>示例作业</h1>${[1,2,3].map(i=>`<div class="TiMu"><div class="newZy_TItle">【简答题】</div><div class="Zy_TItle"><p>独立测试题干 ${i}</p></div><textarea name="answerEditor${i}"></textarea></div>`).join('')}<button class="btnSubmit" onclick="window.submissions++">提交</button><script>window.submissions=0</script>`;return route.fulfill({contentType:'text/html; charset=utf-8',body});});
 const ai=await ctx.newPage();await ai.goto('https://www.doubao.com/chat/');
 const task={key:'partial-demo',name:'示例作业',type:'work',courseId:'fixture-course',clazzId:'fixture-class',knowledgeId:'fixture-section',secNo:'1.1'};
 const asked=[];
 const solve=async({question:q})=>{
  asked.push(q.index);
  if(q.index===3){const saved=loadState().reviewQueue.filter(i=>i.taskKey===task.key&&i.autoFilled);assert.equal(saved.length,2,'前两题必须在第三题开始前已写入磁盘');}
  const answer=q.index===3&&asked.length===3?'':`答案：这是第 ${q.index} 题的已保存简答内容。`;
  const parsed=parseAnswer(answer,q);return {question:q,imagePath:'',aiAnswer:answer,aiError:answer?null:'发送控件暂不可用',aiErrorCode:answer?null:'send-failed',parsed,validation:validateBeforeSubmit(parsed,q)};
 };
 let result=await runQuizTask({ctx,qianwenPage:ai,task,personId:'fixture'}, {solve});
 assert.equal(result.phase,'blocked-verification');assert.equal(result.answered,2);assert.equal(loadState().reviewQueue.filter(i=>i.taskKey===task.key).length,3);
 await result.workPage.close();
 result=await runQuizTask({ctx,qianwenPage:ai,task,personId:'fixture',reviewRetry:true},{solve});
 assert.deepEqual(asked,[1,2,3,3],'续跑只允许询问第三题，前两题复用并恢复');assert.equal(result.answered,3);assert.equal(result.phase,'awaiting-review');assert.equal(result.submitted,false);
 const frame=result.workPage.frames().find(f=>f.url().includes('/work/'));assert.equal(await frame.evaluate(()=>window.submissions),0);assert.ok((await frame.locator('textarea').evaluateAll(es=>es.map(e=>e.value))).every(Boolean));
 await result.workPage.close();attempt='different-attempt';
 result=await runQuizTask({ctx,qianwenPage:ai,task,personId:'fixture',reviewRetry:true},{solve});
 assert.match(result.error,/作答次数改变/);assert.deepEqual(asked,[1,2,3,3],'作答次数改变时不得询问或覆盖旧答案');
 assert.equal(loadState().reviewQueue.filter(i=>i.taskKey===task.key&&i.aiAnswer).length,3,'身份变化不能把已存答案覆盖为空白占位题');
 console.log('✓ 学习通三题实际执行器：前两题即时落盘、第三题失败、关页后恢复前两题、只重试第三题、零提交、作答次数变更保护');
}finally{await b.close();}
