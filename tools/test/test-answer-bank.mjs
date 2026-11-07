// Local, intercepted browser fixtures. The live AXE token is not used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { classifyBankResponse, createAnswerBank } from '../../desktop/answer-bank.cjs';
import { bankAnswer, prepareBankAnswers, randomEligible } from '../../src/chaoxing/answer-bank.mjs';

fs.mkdirSync('.desktop-test', { recursive: true });
process.env.KEBO_DATA_DIR = fs.mkdtempSync(path.resolve('.desktop-test/bank-fixture-'));
const { findEdge } = await import('../../src/browser/launch.mjs');
const { loadState, mutateState } = await import('../../src/state.mjs');
const { runQuizTask, submitWork } = await import('../../src/chaoxing/quizrun.mjs');
const { matchReviewQuestions } = await import('../../src/chaoxing/review-recovery.mjs');
const { reconcileOneReview } = await import('../../src/review-reconcile.mjs');
const { getRecentLogs } = await import('../../src/logbus.mjs');
const { extractQuestions, readIndependentQuizCount } = await import('../../src/chaoxing/quiz.mjs');

assert.equal(classifyBankResponse({code:0,msg:'相似度低于70%:11.03%'}).kind, 'miss');
assert.equal(classifyBankResponse({code:0,msg:'次数不足，请充值'}).kind, 'unavailable');
assert.equal(classifyBankResponse({code:0,msg:'未知异常'}).kind, 'unusable');
assert.equal(randomEligible(['miss','hit','hit','hit','hit'],5), true);
assert.equal(randomEligible(['miss','hit','hit','hit','hit'],null), false);
assert.equal(randomEligible(['miss','unavailable','hit','hit','hit'],5), false);
assert.equal(randomEligible(['miss','miss','hit','hit','hit'],5), false);
const judge = { qtype:'judge', stemTextRaw:'判断题', options:[{letter:'true',text:'对'},{letter:'false',text:'错'}] };
assert.equal(bankAnswer({kind:'candidate',stem:'判断题',answer:'未知'},judge).kind, 'unusable');
assert.deepEqual(bankAnswer({kind:'candidate',stem:'判断题',answer:'错误'},judge).letters, ['false']);
const options = [{letter:'A',text:'甲'},{letter:'B',text:'乙'}];
const original = {qtype:'single',questionId:'q',options,letters:['A']};
const reordered = {qtype:'single',questionId:'q',domIndex:0,options:[{letter:'A',text:'乙'},{letter:'B',text:'甲'}]};
assert.deepEqual(matchReviewQuestions([original],[reordered])[0].letters,['B']);
assert.equal(bankAnswer({kind:'candidate',stem:'同一题',answer:'A'},{...original,stemTextRaw:'同一题'}).kind,'unusable');

const mockSecret = 'x'.repeat(32);
let encryptedConfig;
let quotaReply = {code:1,data:100,hasInfo:false,msg:'success',needlogin:false};
const quotaEvents = [];
const service = createAnswerBank({ dataDir:process.env.KEBO_DATA_DIR,
  safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>{encryptedConfig=value;return Buffer.from('fixture ciphertext');},decryptString:()=>encryptedConfig},
  onQuota: quota => quotaEvents.push(quota),
  fetchImpl:async (url, req) => {
    if (url.pathname === '/api/checkLeft') {
      assert.equal(url.search, '', '查询额度时不把令牌写入 URL');
      assert.equal(req.method, 'POST');
      assert.deepEqual([...req.body], [['token', mockSecret]], '查额度不发送题目');
      assert.equal(req.redirect, 'error');
      return new Response(JSON.stringify(quotaReply));
    }
    assert.equal(url.href,'https://tk.wanjuantiku.com/api/query?v=2');
    assert.equal(req.body.get('token'),mockSecret);
    assert.equal(req.body.get('ai'),'0');
    assert.equal(req.body.has('cid'),false);
    assert.equal(req.redirect,'error');
    return new Response(JSON.stringify({code:1,data:{lefts:0,questions:[{tm:'同一题',answer:'甲',percent:100}]}}));
  },
});
assert.deepEqual(await service.refreshQuota(),{kind:'unconfigured'});
assert.throws(()=>service.save({origin:'https://example.invalid',token:mockSecret}),/已核实/);
assert.deepEqual(service.save({origin:'https://tk.wanjuantiku.com',token:mockSecret}),{origin:'https://tk.wanjuantiku.com',configured:true});
assert.equal(fs.readFileSync(path.join(process.env.KEBO_DATA_DIR,'answer-bank.bin')).includes(mockSecret),false);
assert.equal((await service.refreshQuota()).left,100);
assert.equal((await service.query({jobId:'one',stem:'同一题',type:0,options:['甲','乙'],blanks:0})).kind,'candidate','用完最后一次仍接受成功的答复');
assert.equal(service.quotaStatus().left,0);
quotaReply = {code:1,data:-1,needlogin:true};
assert.equal((await service.refreshQuota()).kind,'needs-login');
quotaReply = {code:1,data:'broken'};
assert.equal((await service.refreshQuota()).kind,'unavailable','无法读取额度与余额为零分开');
assert.deepEqual(quotaEvents.filter(value=>value.kind==='known').map(value=>value.left),[100,0]);

const browser = await chromium.launch({executablePath:findEdge(),headless:true});
try {
  const context = await browser.newContext();
  const identityPage = await context.newPage();
  await identityPage.setContent('<div class="TiMu"><div class="Zy_TItle">1. 【单选题】 <span class="fontLabel">示例题干</span></div><ul><li role="radio" qid="identity"><span data="A">A</span><span class="after">甲</span></li><li role="radio" qid="identity"><span data="B">B</span><span class="after">乙</span></li></ul></div>');
  for (const decodeBankText of [false, true]) {
    const [question] = await extractQuestions(identityPage.mainFrame(), {decodeBankText});
    assert.equal(question.stemTextRaw, '1. 【单选题】 示例题干', '题库开关不能改变旧版草稿的题干身份');
    assert.deepEqual(question.stemTextRawVariants, ['示例题干']);
    assert.equal(question.bankStem, '示例题干', '查题使用独立题干文字');
    assert.equal(matchReviewQuestions([{...original,questionId:'identity',archive:{stemTextRaw:'1. 【单选题】 示例题干'}}],[question]).length,1);
  }
  await identityPage.setContent('<input type="hidden" name="totalQuestionNum" value="5"><div class="newTestType">一、单选题（共 3 题）</div><div class="newTestType">二、多选题（共 2 题）</div>');
  assert.equal(await readIndependentQuizCount(identityPage.mainFrame()),5,'混合题型的分组题数应相加，再与平台总题数核对');
  await identityPage.locator('input').evaluate(field=>field.value='6');
  assert.equal(await readIndependentQuizCount(identityPage.mainFrame()),null,'分组总数与隐藏字段不一致时不得自动提交');
  await identityPage.close();
  const origin = 'https://mooc1.chaoxing.com';
  const workUrl = id => `${origin}/mooc-ans/work/doHomeWorkNew?workId=${id}${id === 'legacy' ? '' : `&workAnswerId=${id}-attempt`}`;
  let submissions = 0;
  let currentKey = '';
  await context.exposeBinding('fixtureSubmit', () => {
    assert.equal(loadState().keptPages[currentKey]?.info?.submissionPending,true,'先落盘再点击');
    submissions++;
  });
  const assignment = id => {
    const hasMissingDom = id === 'short-dom';
    const body = Array.from({length:hasMissingDom ? 4 : 5}, (_, index) => {
      const n = index + 1;
      if (id === 'fill' && n === 3) return '<div class="TiMu" data="fixture-fill"><div class="newZy_TItle">【填空题】</div><div class="Zy_TItle">示例填空</div><input type="text" name="blank1"><input type="text" name="blank2"></div>';
      if (id === 'legacy') return `<div class="questionLi" data="fixture-q${n}"><span class="fontLabel">示例题 ${n}</span><input name="answertype${n}" type="hidden" value="0"><ul>${options.map(option=>`<li><input type="radio" name="q${n}" value="${option.letter}">${option.letter} ${option.text}</li>`).join('')}</ul></div>`;
      const font = id.startsWith('font-') ? ' style="font-family: font-cxsecret, sans-serif"' : '';
      return `<div class="TiMu" data="fixture-q${n}"><div class="newZy_TItle">【单选题】</div><div class="Zy_TItle"${font}>示例题 ${n}</div><ul>${options.map(option=>`<li qid="fixture-q${n}" role="radio"><input type="radio" name="q${n}" value="${option.letter}"><span class="after">${option.text}</span></li>`).join('')}</ul></div>`;
    }).join('');
    const submit = id === 'legacy' ? '<input type="hidden" name="workAnswerId" value="legacy-attempt"><a class="workBtnIndex" href="#" onclick="validateTime()">提交</a>' : '<button class="btnSubmit" type="button" onclick="fixtureSubmit().then(()=>{document.body.innerHTML=\'<p>已提交，本次成绩 90 分</p>\'})">提交</button>';
    const totals = id === 'platform-total-field' ? '<input type="hidden" name="totalQuestionNum" value="5">'
      : id === 'platform-total-header' ? '<div class="newTestType">章节测验（共 5 题）</div>'
      : id === 'platform-total-conflict' ? '<input type="hidden" name="totalQuestionNum" value="6"><div class="newTestType">章节测验（共 5 题）</div>'
      : `<nav data-answer-card>${[1,2,3,4,5].map(i=>`<button>${i}</button>`).join('')}</nav>`;
    return `<meta charset="utf-8"><h1>测试作业</h1>${totals}<form>${body}${submit}</form>`;
  };
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const body = url.pathname.endsWith('/cards') ? `<div class="ans-attach-ct"><span class="ans-job-icon" aria-label="任务点未完成"></span><iframe data='{"name":"测试作业","jobid":"fixture-job"}' src="${workUrl('chapter')}"></iframe></div>` : assignment(url.searchParams.get('workId'));
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  const setMode = (fallback, aboveLimit = 'ai', submitMode = 'auto', source = 'bank') => mutateState(state => {
    state.settings = {submitMode,answerBank:{source,fallback,aboveLimit}};
  });
  const chapter = {key:'chapter',courseId:'fixture',clazzId:'fixture',knowledgeId:'fixture',jobid:'fixture-job',name:'测试作业',type:'work'};
  const execute = async (task, outcomes, checkAi, solve) => {
    currentKey = task.key;
    return runQuizTask({ctx:context,task,personId:'fixture'}, {configured:async()=>true,checkAi,solve,
      lookup:(questions,reusable,config)=>prepareBankAnswers(questions,reusable,{...config,query:async q => {
        const kind = outcomes[q.index-1] || 'hit';
        if (kind !== 'hit') return {kind};
        return q.qtype === 'fill' ? {kind,blanks:['第一空','第二空']} : {kind,letters:['A']};
      }}),
    });
  };
  const unexpected = () => { throw new Error('这条路径不应访问 AI'); };
  setMode('random');
  const first = await execute(chapter,['miss'],unexpected,unexpected);
  assert.equal(first.submitted,true,JSON.stringify(first.error));
  assert.equal(first.items.filter(item=>item.answerSource==='random').length,1);
  assert.equal(first.items[0].confidence,'none');
  assert.equal(submissions,1);

  const standalone = async id => {
    const page = await context.newPage();
    await page.goto(workUrl(id));
    return {page, task:{key:id,standalone:true,name:'测试作业',type:'work',workIdentity:{workid:id,workanswerid:`${id}-attempt`}}};
  };
  setMode('random','review');
  const short = await standalone('short-dom');
  const blocked = await execute(short.task,[],unexpected,unexpected);
  assert.equal(blocked.answered,4);
  assert.equal(blocked.submitted,false,'独立答题卡报五题，不能提交四题');
  assert.equal(submissions,1);
  await short.page.close();

  const outage = await standalone('outage');
  const draft = await execute(outage.task,['hit','hit','hit','hit','unavailable'],unexpected,unexpected);
  assert.equal(draft.items.some(item=>item.answerSource==='random'),false);
  assert.equal(draft.queued,1);
  assert.equal(submissions,1);
  await outage.page.close();

  const encrypted = await standalone('font-review');
  currentKey = encrypted.task.key;
  const fontDraft = await runQuizTask({ctx:context,task:encrypted.task,personId:'fixture'}, {
    configured:async()=>true,checkAi:unexpected,solve:unexpected,
  });
  assert.equal(fontDraft.queued,5);
  assert.equal(fontDraft.submitted,false);
  assert.ok(fontDraft.items.every(item=>item.bankOutcome==='unsupported' && /混淆字体，未向题库查询，留到待审/.test(item.parseReason)));
  assert.ok(getRecentLogs().some(({message})=>message.includes('不支持，未查询 5 题')));
  await encrypted.page.close();

  setMode('random','ai','manual');
  mutateState(state=>{state.settings.ai={provider:'doubao'};});
  const encryptedAi = await standalone('font-ai');
  currentKey = encryptedAi.task.key;
  let fontAiCalls = 0;
  const filledByAi = await runQuizTask({ctx:context,task:encryptedAi.task,personId:'fixture'}, {
    configured:async()=>true,checkAi:async()=>({loggedIn:true}),solve:async()=>{
      fontAiCalls++;
      assert.match(getRecentLogs().at(-1).message,/混淆字体，未向题库查询，按设置交给 豆包 补答/);
      return {aiAnswer:'答案：A',parsed:{letters:['A'],confidence:'high'},validation:{safe:true}};
    },
  });
  assert.equal(fontAiCalls,5);
  assert.equal(filledByAi.answered,5);
  assert.ok(filledByAi.items.every(item=>item.answerSource!=='random' && item.bankOutcome==='unsupported'));
  await encryptedAi.page.close();

  setMode('ai');
  const noLogin = await standalone('no-ai-login');
  const remaining = await execute(noLogin.task,['miss'],async()=>({loggedIn:false}),unexpected);
  assert.equal(remaining.answered,4,'AI 未登录也应先回填全部题库命中题');
  assert.equal(remaining.phase,'blocked-verification');
  await noLogin.page.close();

  setMode('ai','ai','manual');
  const fill = await standalone('fill');
  const prepared = await execute(fill.task,[],unexpected,unexpected);
  assert.equal(prepared.answered,5);
  assert.equal(prepared.items[2].filled.ok,true);
  const values = await fill.page.evaluate(() => new FormData(document.querySelector('form')).getAll('blank2'));
  assert.deepEqual(values,['第二空']);
  const retry = await submitWork(fill.page.mainFrame(),{expected:fill.task.workIdentity,verificationOnly:true});
  assert.equal(retry.pendingConfirmation,true);
  assert.equal(submissions,1,'回执未知时只核对，不能再次发起提交');
  const showReceipt = () => { document.body.innerHTML = '<p>已提交，本次成绩 90 分</p>'; };
  await fill.page.goto(workUrl('different-attempt'));
  await fill.page.evaluate(showReceipt);
  assert.equal((await reconcileOneReview(context,fill.task.key,{personId:'fixture'})).state,'unconfirmed');
  await fill.page.goto(workUrl('fill'));
  await fill.page.evaluate(showReceipt);
  assert.equal((await reconcileOneReview(context,fill.task.key,{personId:'fixture'})).state,'submitted');
  assert.equal(submissions,1,'原作答结果回查只读，不能补发提交');
  await fill.page.close();

  const legacy = await standalone('legacy');
  const legacyResult = await execute(legacy.task,[],unexpected,unexpected);
  assert.equal(legacyResult.answered,5,'旧作业题型字段、原生选项和隐藏作答标识可回填');
  await legacy.page.reload();
  let repeatQueries = 0;
  currentKey = legacy.task.key;
  const continued = await runQuizTask({ctx:context,task:legacy.task,personId:'fixture',reviewRetry:true},{
    configured:async()=>true,checkAi:unexpected,solve:unexpected,
    lookup:(questions,reusable,config)=>prepareBankAnswers(questions,reusable,{...config,query:async()=>{repeatQueries++;return {kind:'miss'};}}),
  });
  assert.equal(continued.answered,5);
  assert.equal(repeatQueries,0,'重新打开原作答后复用已核对答案');
  await legacy.page.close();

  setMode('random');
  const over = await standalone('over');
  let aiCalls = 0;
  const done = await execute(over.task,['miss','miss'],async()=>({loggedIn:true}),async()=>{
    aiCalls++;
    return {aiAnswer:'答案：A',parsed:{letters:['A'],confidence:'high'},validation:{safe:true}};
  });
  assert.equal(aiCalls,2);
  assert.equal(done.items.some(item=>item.answerSource==='random'),false);
  assert.equal(done.submitted,true);
  assert.equal(submissions,2);
  setMode('review');
  for (const id of ['platform-total-field','platform-total-header']) {
    const fixture = await standalone(id);
    assert.equal(await readIndependentQuizCount(fixture.page.mainFrame()),5);
    const completed = await execute(fixture.task,[],unexpected,unexpected);
    assert.equal(completed.submitted,true,'平台隐藏总题数字段或独立汇总标题都应支持完整核对后自动提交');
    await fixture.page.close();
  }
  assert.equal(submissions,4);
  const conflicting = await standalone('platform-total-conflict');
  assert.equal(await readIndependentQuizCount(conflicting.page.mainFrame()),null);
  const notSubmitted = await execute(conflicting.task,[],unexpected,unexpected);
  assert.equal(notSubmitted.answered,5);
  assert.equal(notSubmitted.submitted,false,'平台两个独立总题数互相冲突时仍须留待审');
  assert.equal(submissions,4);
  await conflicting.page.close();
  console.log('✓ 章节测验与独立作业：题库无需 AI 登录，20% 随机边界、超过上限 AI 兜底、故障待审、独立题数、表单回读和提交检查点通过');
} finally {
  await browser.close();
}
