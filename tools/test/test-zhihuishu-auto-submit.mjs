import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/zhs-auto-submit-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {runZhihuishuQuiz}=await import('../../src/platforms/zhihuishu/quiz-task.mjs');const {mutateState,loadState,listReviewItems}=await import('../../src/state.mjs');const {zhihuishuHomeworkKey}=await import('../../src/platforms/zhihuishu/quiz.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});try{
 const context=await b.newContext();let confirms=0,opens=0,asks=0,graded=false;
 await context.exposeFunction('stage',kind=>{if(kind==='confirm')confirms++;if(kind==='open')opens++;});
 const html=`<p>完成率 100%</p><div class="examPaper_subject"><input type="hidden" value='["a-id"]'><div class="subject_num"><span id="anchor_q1">1.</span></div><div class="subject_type">【单选题】</div><div class="subject_node"><div class="nodeLab"><input type="radio" value="a-id"><span>A.</span><div class="node_detail onChecked">匿名答案</div></div></div></div><button>保存</button><button onclick="stage('open');document.querySelector('.el-message-box').hidden=false">提交作业</button><div class="el-message-box" hidden><div class="el-message-box__message">是否确认提交?提交后,批阅过的试卷不能再修改!</div><button onclick="stage('confirm');document.querySelector('#result').textContent='你本次获得的成绩是 100 分'">确定</button></div><p id="result"></p>`;
 await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:r.request().url().includes('doubao.com')?'<div data-testid="chat_input"><div class="tiptap" contenteditable="true"></div></div>':graded?'<p>你本次获得的成绩是 100 分</p>':html}));
 const options=[{letter:'A',displayLetter:'A',optionId:'a-id',text:'匿名答案',domIndex:0,selected:true}];
 for(const [id,mode,retry,isGraded]of [['auto','auto',false,false],['manual','manual',false,false],['retry','auto',true,false],['manual-submitted','auto',false,true]]){
  graded=isGraded;const page=await context.newPage(),url=`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/recruit/${id}/exam/course/school/0`;await page.goto(url);const task={key:'zhihuishu:'+id,platform:'zhihuishu',courseName:'匿名课程',secNo:'第一章',reviewRetry:retry};
  mutateState(s=>{s.settings={submitMode:mode,ai:{provider:'doubao'}};s.quizzes[task.key]={task,paperKey:zhihuishuHomeworkKey(url),total:1,answers:[{questionId:'q1',questionIndex:1,qtype:'single',options,optionIds:['a-id'],letters:['A'],rawAI:'答案：A'}]};s.reviewQueue.push({id:task.key,taskKey:task.key,platform:'zhihuishu',status:'pending-review'});});
  const result=await runZhihuishuQuiz({task,context},{open:async()=>page,ask:async()=>{asks++;throw Error('已完成题不得重问');}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.phase,isGraded?'already-finished':mode==='auto'&&!retry?'submitted':'awaiting-review');
  if(result.phase!=='awaiting-review'){assert.equal(loadState().quizzes[task.key].submitted,true);assert.equal(listReviewItems().some(i=>i.taskKey===task.key),false);}else await page.close();
 }
 assert.equal(confirms,1);assert.equal(opens,1);assert.equal(asks,0);
 console.log('✓ 智慧树实际执行器：自动模式原生确认一次、人工模式与只重试保留待审、已保存题不重问、已交作业先核销通过');
}finally{await b.close();}
