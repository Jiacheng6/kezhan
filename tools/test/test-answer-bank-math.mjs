// All network requests are intercepted; no live token, course or submission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});
process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/bank-math-fixture-'));
const {findEdge}=await import('../../src/browser/launch.mjs');
const {extractQuestions}=await import('../../src/chaoxing/quiz.mjs');
const {bankAnswer,prepareBankAnswers}=await import('../../src/chaoxing/answer-bank.mjs');
const {matchReviewQuestions}=await import('../../src/chaoxing/review-recovery.mjs');
const {runQuizTask}=await import('../../src/chaoxing/quizrun.mjs');
const {mutateState}=await import('../../src/state.mjs');
const tex=value=>'<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">'+value+'</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL</span></span>';
const options=(values,index=1,checked=false)=>'<ul>'+values.map((body,i)=>'<li qid="math-q'+index+'" role="radio"><input type="radio" name="q'+index+'" value="'+(i?'B':'A')+'"'+(checked&&i===0?' checked':'')+'><span data="'+(i?'B':'A')+'">'+(i?'B':'A')+'</span> <span class="after">'+body+'</span></li>').join('')+'</ul>';
const question=(stem,values=['甲','乙'],index=1,checked=false)=>'<div class="TiMu" data="math-q'+index+'"><span class="newZy_TItle">【单选题】</span><div class="Zy_TItle"><span class="fontLabel">'+stem+'</span></div>'+options(values,index,checked)+'</div>';
const image='<img src="https://cdn.example.invalid/formula.png?flag=1&amp;_=1700000000">';
const cases=[
 {name:'KaTeX 源码与视觉层',html:'求极限 '+tex('\\lim_{x\\to 0}\\frac{\\sin x}{x}')+' 的值',stem:'求极限 \\lim_{x\\to 0}\\frac{\\sin x}{x}VISUAL 的值'},
 {name:'签名图片保留 query 和实体',html:'已知 '+image+' 的导数为',stem:'已知 cdn.example.invalid/formula.png?flag=1&amp;_=1700000000 的导数为'},
 {name:'无引号图片属性',html:'已知<img src=https://cdn.example.invalid/formula.png?flag=1>的值',stem:'已知cdn.example.invalid/formula.png?flag=1的值'},
 {name:'有界内联图片',html:'计算 <img src="data:image/png;base64,AAAA"> 的结果',stem:'计算 data:image/png;base64,AAAA 的结果'},
 {name:'U+2002 必须删除',html:'甲\u2002乙'+tex('x'),stem:'甲乙xVISUAL'},
 {name:'U+3000 保留且标点按原版映射',html:'下列（\u3000）正确？A、甲；B、乙！占比 50%\u3000“引号”'+tex('x'),stem:'下列(\u3000)正确?A,甲;B,乙!占比 50*\u3000*引号*xVISUAL'},
 {name:'iframe 优先 _src',html:'听音频 <iframe src="https://cdn.example.invalid/fallback.mp3" _src="https://cdn.example.invalid/primary.mp3"></iframe> 选答案',stem:'听音频 cdn.example.invalid/primary.mp3 选答案'},
 {name:'单引号旧版音频播放器',html:"<div class='audioReader'><source src='https://cdn.example.invalid/audio.mp3'>播放</div>",stem:'cdn.example.invalid/audio.mp3'},
];
const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try {
 const context=await browser.newContext();let submitted=0;
 const paper=question('求极限 '+tex('\\lim_{x\\to 0}\\frac{\\sin x}{x}'),['1','0'],1)
   +question('选择正确表达式',['<img src="https://cdn.example.invalid/one.png">','<img src="https://cdn.example.invalid/two.png">'],2)
   +question('计算'+image+'的值',['2','3'],3);
 await context.exposeBinding('fixtureSubmit',()=>{submitted++;});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.hostname!=='mooc1.chaoxing.com')return route.abort();
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><input type="hidden" name="totalQuestionNum" value="3"><form>'+paper+'<button type="button" class="btnSubmit" onclick="fixtureSubmit().then(()=>document.body.innerHTML=\'提交成功，本次成绩 100 分\')">提交</button></form>'});
 });
 const page=await context.newPage();
 for(const sample of cases){
  await page.setContent('<form>'+question(sample.html,['甲','乙'],1,true)+'</form>');
  const before=await page.evaluate(()=>({html:document.body.innerHTML,values:[...new FormData(document.querySelector('form'))]}));
  const [q]=await extractQuestions(page.mainFrame(),{decodeBankText:true});
  assert.equal(q.bankTextSafe,true,sample.name+':'+q.bankTextIssue);
  assert.equal(q.bankStem,sample.stem,sample.name);
  assert.ok(q.stemContentKey);
  assert.deepEqual(await page.evaluate(()=>({html:document.body.innerHTML,values:[...new FormData(document.querySelector('form'))]})),before,sample.name+'不能更改原页面、已选答案或表单');
 }
 for(const [name,html,issue]of [
  ['纯图形 SVG','计算<svg><path d="M0 0L1 1"></path></svg>的值','question-media'],
  ['无源码 MathML','计算<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>的值','question-media'],
  ['资源缺失','计算<img>的值','question-resource'],
  ['脚本地址','计算<img src="javascript:alert(1)">的值','question-resource'],
  ['不可携带的临时地址','计算<img src="blob:https://example.invalid/image">的值','question-resource'],
  ['过长 base64','计算<img src="data:image/png;base64,'+'A'.repeat(8100)+'">的值','question-resource'],
 ]){
  await page.setContent(question(html));
  const [q]=await extractQuestions(page.mainFrame(),{decodeBankText:true});
  assert.equal(q.bankTextSafe,false,name);assert.equal(q.bankTextIssue,issue,name);
 }
 await page.setContent('<div class="TiMu"><div class="Zy_TItle">【单选题】'+image+'</div>'+options(['甲','乙'])+'</div>');
 const [prefixed]=await extractQuestions(page.mainFrame(),{decodeBankText:true});
 assert.equal(prefixed.bankStem,'cdn.example.invalid/formula.png?flag=1&amp;_=1700000000','题型标签不能成为查题正文的一部分');
 await page.setContent(question(tex('x²'),['x²','x2']));
 let [q]=await extractQuestions(page.mainFrame(),{decodeBankText:true});
 assert.equal(bankAnswer({kind:'candidate',stem:q.bankStem,answer:'x²'},q).letters[0],'A');
 assert.equal(bankAnswer({kind:'candidate',stem:q.bankStem.replace('²','2'),answer:'x2'},q).kind,'unusable','不能把 x² 当成 x2');
 assert.equal(bankAnswer({kind:'candidate',stem:q.bankStem.slice(0,-1),answer:'x²'},q).kind,'unusable','供应商省略题干字符时不能仅凭相似度接受');
 await page.setContent(question(image,['<img src="https://cdn.example.invalid/one.png">','<img src="https://cdn.example.invalid/one.png">']));
 [q]=await extractQuestions(page.mainFrame(),{decodeBankText:true});
 assert.equal(bankAnswer({kind:'candidate',stem:q.bankStem,answer:'cdn.example.invalid/one.png'},q).kind,'unusable','相同图片选项不得猜测字母');
 await page.close();
 mutateState(s=>{s.settings={submitMode:'auto',answerBank:{source:'bank',fallback:'review'}};});
 const taskPage=await context.newPage();
 await taskPage.goto('https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=math-fixture&workAnswerId=math-attempt');
 const task={key:'math-fixture',standalone:true,name:'匿名公式样例',type:'work',workIdentity:{workid:'math-fixture',workanswerid:'math-attempt'}};
 let requests=0;
 const unexpected=()=>assert.fail('全部题库命中不应启动 AI');
 const result=await runQuizTask({ctx:context,task,personId:'fixture'},{
  configured:async()=>true,checkAi:unexpected,solve:unexpected,
  lookup:(qs,reusable,config)=>prepareBankAnswers(qs,reusable,{...config,query:async question=>{
   requests++;assert.equal(question.bankTextSafe,true);
   return bankAnswer({kind:'candidate',stem:question.bankStem,answer:question.options[question.index===2?1:0].bankAnswerKeys[0]},question);
  }}),
 });
 assert.equal(requests,3);assert.equal(result.answered,3);assert.equal(result.submitted,true,JSON.stringify(result.error));assert.equal(submitted,1);
 await taskPage.goto('https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=math-fixture&workAnswerId=math-attempt');
 await taskPage.evaluate(()=>{
  const imgs=document.querySelectorAll('.TiMu:nth-of-type(2) .after img');
  const values=[...imgs].map(i=>i.getAttribute('src'));imgs[0].setAttribute('src',values[1]);imgs[1].setAttribute('src',values[0]);
 });
 let questions=await extractQuestions(taskPage.mainFrame());
 const matches=matchReviewQuestions(result.items,questions);
 assert.deepEqual(matches.find(pair=>pair.question.index===2).letters,['A'],'图片选项换序按内容重新定位，不能沿用旧字母');
 await taskPage.evaluate(()=>document.querySelector('.TiMu:nth-of-type(3) .fontLabel img').setAttribute('src','https://cdn.example.invalid/different.png'));
 questions=await extractQuestions(taskPage.mainFrame());
 assert.throws(()=>matchReviewQuestions(result.items,questions),/公式或图片已变化/,'题干文字没变但公式图片变化也必须阻止恢复/提交');
 console.log('✓ 数学题：8 种原版字符串样例、只读取题保留已选、6 类不支持安全回退、严格公式/图片匹配、图片换序恢复、3题全题库回填和模拟提交一次通过');
} finally {await browser.close();}

