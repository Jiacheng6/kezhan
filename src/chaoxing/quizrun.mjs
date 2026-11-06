/**
 * 章节测验 / 作业 执行器（P4）。
 *
 * 流程：
 *   打开作业 frame → 提取题目 → 逐题截图 → 问AI → 解析 → 分级校验
 *     → 高可靠且允许自动提交 → 填答案
 *     → 否则 → 进「待审队列」等人工确认
 *   → 全部就绪后按策略提交，并强制留档
 *
 * 安全边界（对应用户第 13/17 问）：
 *   - 默认 submitMode = 'manual'：只填不交，等你在界面确认
 *   - submitMode = 'auto'：仅「高可靠」答案会被提交；中/低可靠一律转待审
 *   - 简答可自动填草稿，整份作业必须人工确认；填空仍转人工
 *   - 每次提交前强制留档（题目截图 + AI原始回答 + 解析结果）
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, loadSettings } from '../config.mjs';
import { log } from '../logbus.mjs';
import { askImage, checkLogin } from '../ai/ai.mjs';
import { ensureProviderPage, selectedProvider } from '../ai/providers.mjs';
import {
  waitWorkFrame,
  extractQuestions,
  getWorkMeta,
  shootQuestion,
  selectOptions,
  readSelection,
  readIndependentQuizCount,
  fillQuizBlanks,
} from './quiz.mjs';
import { parseAnswer, validateBeforeSubmit, buildArchive, confidenceLabel, normalizeEssayText, MAX_ESSAY_LENGTH } from '../ai/parse.mjs';
import { addHandbook, loadState, saveState, mutateState, listReviewItems, updateReviewAnswer } from '../state.mjs';
import { throttleState } from '../ai/throttle.mjs';
import { throwIfStopped } from '../control.mjs';
import { fillEssayAnswer } from './essay.mjs';
/*
 * 卡片逻辑与视频执行器共用（section.mjs）——
 * 章节测验常常在**第 2 张卡片**上（第 1 张是视频），写死 num=0 会读不到。
 */
import { cardsUrl, openSectionCard, waitForAttachments } from './section.mjs';
import { readPointStatusFromPage } from './attach.mjs';
import { skipDecision, describeSkip } from './skip.mjs';
import { newTaskPage, releasePage, setPageBusy, markSavedReviewPage } from '../browser/pages.mjs';
import { isReviewLocked } from './review-lock.mjs';
import { setBrowserVisible, isBrowserVisible } from '../browser/window-control.mjs';
import { AI_BLOCK_CODES, pendingQuizItem, queueUnanswered } from './quiz-outcome.mjs';
import { bankConfigured, prepareBankAnswers, randomBankAnswer, randomEligible } from './answer-bank.mjs';
import { pageSubmissionState, frameWorkIdentity, workIdentity, WORK_SUBMIT_SELECTOR } from './submission-state.mjs';
import {activateSubmitConfirmation} from './submit-control.mjs';

export { cardsUrl, workIdentity };
const submittingPages=new WeakSet();

export function canAutoSubmitItems(items, expectedCount = items.length, allowRandom = false) {
  return items.length > 0 && items.length === expectedCount && items.every((it) =>
    it.qtype !== 'essay' && !it.requiresReview && it.autoFilled &&
    (it.answerSource === 'random' ? allowRandom && it.bankOutcome === 'miss' : it.confidence === 'high'));
}

function resolvedBankAnswer(question, answer) {
  const random = answer.kind === 'random';
  return {
    question, answerSource: random ? 'random' : 'bank', bankOutcome: random ? 'miss' : 'hit',
    blanks: answer.blanks, aiAnswer: '', aiError: null,
    parsed: { letters: answer.letters || [], confidence: random ? 'none' : 'high', reason: random ? '随机补填' : '题库命中' },
    validation: { safe: true },
  };
}

/** 一次答题的留档目录 */
function archiveDir() {
  const d = path.join(PATHS.answers, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 读一道题 + 问AI + 解析。不填、不交。
 *
 * @returns {Promise<object>} 含 question / imagePath / aiAnswer / parsed / validation
 */
async function solveOne({ workFrame, domIndex, qianwenPage, question, prompt, shouldStop, taskKey,resendMissingConversation=false }) {
  const dir = archiveDir();

  // 截图（唯一可靠输入 —— 题干是自定义字体加密的）
  const fontNotes = [];
  const imagePath = await shootQuestion(workFrame, domIndex, dir, {
    shouldStop,
    fontNotes,
    onRecovery: (message) => log(`    ${message}`, 'warn'),
  });
  log('        题目截图已就绪，准备发送给AI', 'info');

  // 节流：保护AI账号不被风控（踩过坑）
  throwIfStopped(shouldStop);

  const settings = loadSettings();
  const ai = await askImage({
    taskKey, platform:'chaoxing',
    question,
    page: qianwenPage,
    imagePath,
    prompt,
    freshChat: settings.ai?.freshChatPerQuestion ?? false,
    resendMissingConversation,
    shouldStop,
  });
  throwIfStopped(shouldStop);

  if (!ai.ok) {
    log(`        AI请求失败（${ai.errorCode || 'unknown'}）：${ai.error || '无错误详情'}`, 'error');
  }

  const parsed = parseAnswer(ai.ok ? ai.answer : '', question);
  const validation = validateBeforeSubmit(parsed, question);

  return {
    question,
    imagePath,
    fontWarning: fontNotes.length ? fontNotes.join('；') : null,
    aiAnswer: ai.ok ? ai.answer : '',
    aiError: ai.ok ? null : ai.error,
    aiErrorCode: ai.ok ? null : ai.errorCode || 'unknown',
    aiWaitedMs: ai.waitedMs,
    parsed,
    validation,
  };
}

/**
 * 执行一次测验/作业。
 *
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} opts.ctx
 * @param {import('playwright-core').Page} opts.qianwenPage AI标签页
 * @param {object} opts.task 执行清单里的任务点
 * @param {string} opts.personId
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.shouldStop]
 * @returns {Promise<object>} 结果摘要
 */
export async function runQuizTask({ ctx, qianwenPage, task, personId, onProgress, shouldStop, reviewRetry=false,restartTask=false },
  {solve=solveOne, configured=bankConfigured, lookup=prepareBankAnswers, checkAi=checkLogin}={}) {
  const settings = loadSettings();
  const started = Date.now();

  const result = {
    key: task.key,
    name: task.name,
    secNo: task.secNo,
    sectionName: task.sectionName,
    type: task.type,
    ok: false,
    phase: 'start',
    totalQuestions: 0,
    answered: 0,
    queued: 0,
    submitted: false,
    submitMode: reviewRetry ? 'manual' : settings.submitMode,
    items: [],
    error: null,
    elapsedSec: 0,
  };

  if(restartTask){
    const previous=getKeptPage(task.key),saved=loadState().keptPages?.[task.key]?.info;
    /*
     * 真机日志（2026-11-03 用户重跑）：
     *   ✗ 失败：题目字体文件加载失败 → 当前任务暂停…重启一次（1/1）
     *   → 1.6 秒后「批量执行结束：待审 1」   ← 重启被吞掉了，一步都没跑
     * 原因是重开那一刻「待审锁」被别人占着，旧代码直接当 awaiting-review 返回。
     * 现在：先等锁释放（最多 10 秒），真等不到才退；只有**已提交待确认**才直接返回。
     */
    if(saved?.submissionPending)return {...result,phase:'awaiting-review',submissionPending:true};
    if(isReviewLocked(task.key)){
      const deadline=Date.now()+10000;
      while(isReviewLocked(task.key)&&Date.now()<deadline)await sleep(200);
      if(isReviewLocked(task.key)){
        log('    ! 待审仍在处理中，暂时无法重开这道作业', 'warn');
        return {...result,phase:'awaiting-review',submissionPending:false};
      }
      log('    待审处理已结束，继续重开作业页', 'info');
    }
    if(!task.standalone&&previous?.page&&!previous.page.isClosed()){releasePage(previous.page);await previous.page.close();}
    log('    重新打开作业页（字体/页面类失败，换页通常即可恢复）', 'info');
    // Keep persisted work identity and answers for the normal checkpoint match.
  }
  if (loadState().keptPages?.[task.key]?.info?.submissionPending) {
    return { ...result, ok:true, phase:'awaiting-review', submissionPending:true };
  }
  /*
   * 真机取证（2026-11-03）：单选题截图是成功的（硬盘上有 PNG），
   * 失败只从「多选题」那题开始 —— 说明是那份字体文件本身下载不下来，
   * 不是"隐藏窗口导致全部字体不加载"。所以这里不再强制弹窗口，
   * 只在字体真的失败时再显示网页重试一次（见下面 catch 里）。
   */
  const page = task.standalone ? await findStandaloneWork(ctx, { expected: task.workIdentity, personId }) : await newTaskPage(ctx, 'quiz');
  if (!page) return { ...result, error: '请从课程作业列表打开原作业，再继续作答' };
  const dismissQuizDialog = d => {if(!submittingPages.has(page))void d.accept().catch(() => {});};
  if (!task.standalone) page.on('dialog', dismissQuizDialog);
  setPageBusy(page, true);
  let workFrame = null, questions = [],validatedQuestions=false;
  const keepForReview = ({busy=false}={}) => {
    result.keepPageOpen = true; result.workPage = page;
    result.workFrameUrl = workFrame.url();
    registerKeptPage(task.key, page, {
      task: {courseId:task.courseId,clazzId:task.clazzId,knowledgeId:task.knowledgeId,name:task.name,type:task.type,jobid:task.jobid,cardNum:result.cardNum,standalone:task.standalone,workIdentity:task.workIdentity},
      workIdentity: result.workIdentity, personId: String(personId),
      submissionPending: !!result.submissionPending,
      submissionVerificationOnly: !!result.submissionPending,
      course: task.courseName || task.courseId, secNo: task.secNo, name: task.name,
      totalQuestions: result.totalQuestions, answered: result.answered, queued: result.queued,
      items: result.items.map(i => ({questionIndex:i.questionIndex,qtype:i.qtype,letters:i.letters,textAnswer:i.textAnswer,requiresReview:i.requiresReview,confidence:i.confidence,autoFilled:i.autoFilled})),
    },{busy});
  };
  const checkpoint=()=>{keepForReview({busy:true});recordQuizResult(result,{checkpoint:true});};

  try {
    // —— 0) 已完成则跳过（本地记录 / 上次侦察快照）——
    const { isTaskDone, getTaskStatus } = await import('../state.mjs');
    let pre = skipDecision({
      task,
      stateStatus: getTaskStatus(task.key)?.status,
      pointFinished: null,
    });
    if (pre.skip) {
      result.phase = 'already-finished';
      result.ok = true;
      result.skipReason = pre.reason;
      log(`    ${describeSkip(pre)}`, 'ok');
      return result;
    }

    // —— 1) 打开作业所在小节（多卡片：作业常常在第 2 张卡片上）——
    if (!task.standalone) {
    result.phase = 'open-section';
    log(`    打开小节：${task.secNo} ${task.sectionName}`, 'info');
    const card = await openSectionCard(page, task, personId, { maxCards: loadSettings().maxCardProbe ?? 6 });
    result.cardNum = card.cardNum;
    if (card.cardNum > 0) log(`    作业在第 ${card.cardNum + 1} 张卡片上`, 'info');

    // 等任务点渲染出来（懒加载；抢跑会让后面的作业 frame 等待白费）
    await waitForAttachments(page);

    /*
     * —— 1.5) **实时**确认这个测验做没做过 ——
     * 这是"避免重复"的关键一环：本地快照可能过期（用户可能在手机上做过，
     * 或上次跑完没来得及记账）。刚打开的卡片页上就有权威标记，直接读它，
     * 不用再开页面。做完/已交就直接跳过，不去重做一遍测验（可能覆盖已交答案）。
     */
    const point = await readPointStatusFromPage(page, task.name, { isVideo: false }).catch(() => ({ finished: null }));
    pre = skipDecision({
      task,
      stateStatus: getTaskStatus(task.key)?.status,
      pointFinished: point.finished,
    });
    result.pointStatus = point;
    if (pre.skip) {
      const { setTaskStatus } = await import('../state.mjs');
      setTaskStatus(task.key, {
        status: 'done',
        name: task.name,
        secNo: task.secNo,
        note: `跳过：${pre.reason}`,
        source: 'reconcile',
        finishedAt: new Date().toISOString(),
      });
      result.phase = 'already-finished';
      result.ok = true;
      result.skipReason = pre.reason;
      log(`    ${describeSkip(pre)}`, 'ok');
      return result;
    }

    }
    // —— 2) 等作业 frame 渲染出题目 ——
    result.phase = 'wait-work-frame';
    workFrame = await waitWorkFrame(page, 35000);
    if (!workFrame) throw new Error('作业 frame 未出现或题目未渲染');

    const meta = await getWorkMeta(workFrame);
    result.workIdentity = await frameWorkIdentity(workFrame);
    if (task.standalone && (!sameWorkAttempt(task.workIdentity, result.workIdentity) || !meta.submitBtn ||
        (await pageSubmissionState(page, workFrame, { expected: result.workIdentity })).submitted)) {
      throw new Error('无法确认当前独立作业可编辑，或平台已显示提交结果');
    }
    result.totalQuestions = meta.questionTotal;
    log(`    作业「${meta.title || task.name}」共 ${meta.questionTotal} 题`, 'info');

    if (!meta.questionTotal) throw new Error('未读到任何题目');
    if (!meta.submitBtn) log('    ! 未找到提交按钮，将只填不交', 'warn');

    questions = await extractQuestions(workFrame);
    // Resume only answers belonging to this exact work/attempt and a stable
    // question mapping. A number alone is never enough to reuse an answer.
    const cached=listReviewItems().filter(item=>item.taskKey===task.key);
    const reusable=new Map();
    if(cached.length){
      const identity=loadState().keptPages?.[task.key]?.info?.workIdentity;
      const actual=result.workIdentity;
      if(!identity?.workid||Object.entries(identity).some(([key,value])=>actual[key]!==value))throw Error('作业或作答次数改变，已保留旧答案，请先人工核对');
      const {matchReviewQuestions}=await import('./review-recovery.mjs');
      for(const {item,question,letters}of matchReviewQuestions(cached.filter(item=>(item.aiAnswer&&!item.aiError)||item.editedByHuman||['bank','random'].includes(item.answerSource)&&(item.autoFilled||item.savedAnswer)),questions)){
        if (item.answerSource === 'bank' || item.answerSource === 'random') {
          reusable.set(question.index, {...item,...resolvedBankAnswer(question,{kind:item.answerSource === 'random' ? 'random' : 'hit',letters,blanks:item.blanks})});
          continue;
        }
        const parsed=parseAnswer(item.aiAnswer||'',question);
        if(item.editedByHuman){parsed.letters=letters;parsed.textAnswer=item.textAnswer||'';parsed.confidence='high';parsed.canFill=true;}
        else if (letters.length && parsed.letters?.length) parsed.letters = letters;
        const validation=validateBeforeSubmit(parsed,question);
        if((!item.aiError||item.editedByHuman)&&(question.qtype==='essay'?parsed.canFill:validation.safe&&parsed.confidence==='high'))reusable.set(question.index,{...item,parsed,validation});
      }
    }
    for(const [index,previous]of reusable)result.items.push({...previous,questionIndex:index,autoFilled:false,filled:null,savedAnswer:true,status:'pending-review'});
    validatedQuestions=true;
    checkpoint();
    const independentCount = await readIndependentQuizCount(workFrame);
    const bank = settings.answerBank || {};
    const preferBank = bank.source !== 'ai';
    const useBank = preferBank && await configured();
    const bankAnswers = useBank ? await lookup(questions, reusable, { shouldStop,
      onProgress: () => onProgress?.({ index: 0, total: questions.length, phase: 'bank-lookup', answerSource: 'bank' }),
    }) : new Map();
    const bankOutcomes = questions.map(q => reusable.get(q.index)?.bankOutcome ?? (reusable.has(q.index) ? 'restored' : bankAnswers.get(q.index)?.kind));
    const allowRandom = useBank && bank.fallback === 'random' && randomEligible(bankOutcomes, independentCount);
    const fallback = bank.fallback === 'random' ? bank.aboveLimit : bank.fallback;
    if (useBank) log(`    题库查询完成：命中 ${bankOutcomes.filter(kind=>kind==='hit').length} 题，明确未命中 ${bankOutcomes.filter(kind=>kind==='miss').length} 题`, 'info');
    let aiReady = false;
    let aiRequests = 0;
    const ask = async opts => {
      if (!aiReady) {
        const provider = selectedProvider(settings);
        if (checkAi === checkLogin && provider.id !== 'api' && (!qianwenPage || qianwenPage.isClosed())) {
          qianwenPage = await ensureProviderPage(ctx, provider).catch(() => null);
        }
        const login = await checkAi(qianwenPage);
        if (!login.loggedIn) return { parsed: {}, validation: {}, aiErrorCode: 'not-logged-in', aiError: 'AI 未登录，请在软件内完成登录后继续' };
        aiReady = true;
      }
      aiRequests++;
      return solve({...opts,qianwenPage});
    };

    // —— 4) 逐题处理 ——
    let captureFailures = 0;
    const canResolveLocally = q => {
      const previous = reusable.get(q.index);
      const answer = bankAnswers.get(q.index);
      return Boolean(previous && (previous.answerSource !== 'random' || allowRandom) || answer?.kind === 'hit' || allowRandom && answer?.kind === 'miss');
    };
    const ordered = useBank ? [...questions].sort((a,b) => Number(canResolveLocally(b)) - Number(canResolveLocally(a))) : questions;

    for (let i = 0; i < ordered.length; i += 1) {
      if (shouldStop && shouldStop()) {
        /*
         * 用户主动停止 ≠ 失败。
         * 必须显式标成 stopped：否则批量那边会把这次结束当成"跑挂了"，
         * 白白重试 3 次，最后把任务点记成「待人工」（实测踩到）。
         */
        result.phase = 'stopped';
        result.error = '被用户中止';
        result.stopped = true;
        break;
      }
      const q = ordered[i];
      log(`    [${q.index}/${questions.length}] ${q.qtypeRaw} ${q.optionCount} 选项`, 'info');

      let previous=reusable.get(q.index);
      const bankAnswer = bankAnswers.get(q.index);
      if (previous?.answerSource === 'random' && !allowRandom) previous = null;
      const chosen = bankAnswer?.kind === 'hit' ? bankAnswer : allowRandom && bankAnswer?.kind === 'miss' ? randomBankAnswer(q) : null;
      if (!previous && !chosen && preferBank && (allowRandom || fallback === 'review')) {
        const item = pendingQuizItem(task, q, '题库未取得可回填答案，按设置转待审', {bankOutcome:bankAnswer?.kind});
        const existing = result.items.findIndex(value => value.questionIndex === q.index);
        if (existing >= 0) result.items[existing] = item; else result.items.push(item);
        result.queued++;
        checkpoint();
        continue;
      }
      const answerSource = previous?.answerSource ?? (chosen?.kind === 'hit' ? 'bank' : undefined);
      onProgress?.({ index: i, total: questions.length, phase: 'asking', answerSource });
      if(previous)log(`        复用第 ${q.index} 题已保存答案，仅核对并恢复填写，不重复问 AI`, 'info');
      /*
       * 用户反馈（2026-11-03）：做到一题时字体加载失败，整张卷子就此停住
       * （「题目完成了 4 个，不继续了」）。逐题处理不该因为**一题**截不到而中断：
       * 记下这题转待审，继续做后面的题；只有连续多题都截不到才真正放弃。
       */
      let solved;
      try {
        solved = previous ? {...previous,question:q,aiError:null,aiErrorCode:null} : chosen ? resolvedBankAnswer(q, chosen) : await ask({
          taskKey:task.key,
          resendMissingConversation:!restartTask,
          workFrame,
          domIndex: q.domIndex,
          qianwenPage,
          question: q,
          prompt: q.qtype === 'essay' ? settings.essayPrompt : settings.quizPrompt,
          shouldStop,
        });
        captureFailures = 0;
      } catch (err) {
        if (err.code === 'STOPPED') throw err;
        /*
         * 关键发现（用户 2026-11-03）：「有时我手动做完剩下的题提交后就又正常了」
         * —— 内置网页被隐藏时，浏览器可能根本不请求那套加密字体；
         * 用户自己看着（窗口可见）时字体就加载成功了。
         * 所以这里：字体类失败时，先把内置网页显示出来、等一会儿、再试一次。
         */
        const fontish = err.captureStage === '题目字体' || /字体|fonts?/i.test(String(err.message || ''));
        if (fontish && process.env.KEBO_DESKTOP === '1' && !isBrowserVisible()) {
          log('    题目字体没加载，先把内置网页显示出来再试一次（可见时浏览器才会真正请求字体）', 'warn');
          await setBrowserVisible(true).catch(() => {});
          await sleep(1500);
          try {
            solved = await ask({
              taskKey: task.key,
              resendMissingConversation:!restartTask,
              workFrame,
              domIndex: q.domIndex,
              qianwenPage,
              question: q,
              prompt: q.qtype === 'essay' ? settings.essayPrompt : settings.quizPrompt,
              shouldStop,
            });
            log('    显示网页后重新读取题目：成功', 'ok');
            captureFailures = 0;
          } catch (retryErr) {
            if (retryErr.code === 'STOPPED') throw retryErr;
            err = retryErr;
          }
        }
        if (solved) { /* 上面重试成功，走正常流程 */ } else {
        captureFailures += 1;
        log(`        ✗ 第 ${i + 1} 题读取失败（连续 ${captureFailures} 题）：${err.message}`, 'warn');
        if (captureFailures >= 3) {
          err.message = `连续 ${captureFailures} 题读取失败：${err.message}`;
          throw err;
        }
        // 这一题先记成待审，继续处理后面的题
        result.items.push({
          id: `${task.key}#q${q.index}`,
          taskKey: task.key,
          course: task.courseName || task.courseId,
          courseId: task.courseId,
          knowledgeId: task.knowledgeId,
          secNo: task.secNo,
          sectionName: task.sectionName,
          questionIndex: q.index,
          domIndex: q.domIndex,
          qtype: q.qtype,
          qtypeRaw: q.qtypeRaw,
          options: (q.options || []).map((o) => ({ letter: o.letter, displayLetter: o.displayLetter, text: o.text })),
          confidence: 'low',
          confidenceLabel: '🔴 低',
          letters: [],
          status: 'pending-review',
          requiresReview: true,
          autoFilled: false,
          captureError: err.message,
          note: `题目读取失败，已跳过：${err.message}`,
        });
        continue;
        }
      }

      const tag = solved.answerSource === 'random' ? '随机补填' : confidenceLabel(solved.parsed.confidence);
      if (!solved.aiError) {
      log(
        `        ${solved.answerSource === 'bank' ? '题库' : solved.answerSource === 'random' ? '随机' : 'AI'}：${solved.blanks ? `${solved.blanks.length} 空` : q.qtype === 'essay' ? `简答正文 ${solved.parsed.textAnswer?.length || 0} 字符` : solved.parsed.letters.join('') || '(无)'}  ${tag}  ${solved.parsed.reason}`,
        solved.parsed.confidence === 'high' ? 'ok' : 'warn',
      );
      }

      // 风控验证：立刻停止整批，不继续无意义地等待
      if (AI_BLOCK_CODES.has(solved.aiErrorCode)) {
        result.phase = 'blocked-verification';
        result.error = solved.aiError;
        result.needsHuman = solved.aiError || '请检查 AI 网页';
        result.aiErrorCode = solved.aiErrorCode;
        log(`    ⛔ ${solved.aiError}`, 'error');
        log('    ⛔ 当前作业已挂起，将暂停本批次；请查看软件内 AI 网页', 'error');
        queueUnanswered(result, task, questions, result.error);
        const current = result.items.find(item => item.questionIndex === q.index);
        Object.assign(current, {imagePath:solved.imagePath,aiErrorCode:solved.aiErrorCode,aiError:solved.aiError});
        break;
      }

      // AI连续未返回（疑似被限流）→ 也停下，别继续撞
      {
        const st = throttleState();
        const limit = loadSettings().ai?.consecutiveFailLimit ?? 2;
        if (solved.aiError && st.consecutiveFail >= limit) {
          result.phase = 'blocked-throttled';
          result.error = `AI连续 ${st.consecutiveFail} 次未正常返回（疑似限流），已停止`;
          result.needsHuman = `等待约 ${Math.round(st.cooldownLeftMs / 60000)} 分钟后重试，或减少每批题量`;
          result.aiErrorCode = 'rate-limited';
          log(`    ⛔ ${result.error}`, 'error');
          queueUnanswered(result, task, questions, result.error);
          break;
        }
      }

      // 是否允许自动填
      const isEssay = q.qtype === 'essay';
      /*
       * 有字体警告的题：截图里的字可能是好的，也可能被 fallback 字体换掉了。
       * 为了不把"可能错的答案"自动填进去，这类题一律不自动填，转待审
       * （AI 答案和截图都会保留，你核对一下就行）。
       */
      const fontWarned = !!solved.fontWarning;
      if (fontWarned) log('        ! 该题字体未完全加载，答案不自动填，转待审核对', 'warn');
      const mayFill = !fontWarned && !solved.aiError && (isEssay ? settings.essayAutoFill && solved.parsed.canFill
        : (solved.parsed.confidence === 'high' || solved.answerSource === 'random' && allowRandom) && solved.validation.safe);
      let filled = null;
      let autoFilled = false;
      let fillError = null;
      throwIfStopped(shouldStop);
      if (mayFill) {
        try {
          if (result.workIdentity.workanswerid && !sameWorkAttempt(result.workIdentity, await frameWorkIdentity(workFrame))) throw new Error('作答身份已变化');
          if (isEssay) {
            filled = await fillEssayAnswer(workFrame, q.domIndex, solved.parsed.textAnswer, { shouldStop });
            autoFilled = filled.ok && filled.verified;
            fillError = filled.error || null;
          } else if (q.qtype === 'fill' && solved.blanks) {
            filled = await fillQuizBlanks(workFrame, q.domIndex, solved.blanks);
            autoFilled = filled.ok;
            if (!autoFilled) fillError = '填空的表单值未通过核对';
          } else {
            const current = await readSelection(workFrame, q.domIndex);
            const alreadyFilled = current?.selected.length === solved.parsed.letters.length && solved.parsed.letters.every(letter => current.selected.includes(letter));
            const r = alreadyFilled ? {ok:true} : current?.selected.length ? {ok:false} : await selectOptions(workFrame, q.domIndex, solved.parsed.letters);
            if (!solved.answerSource && !alreadyFilled) await page.waitForTimeout(400);
            const back = await readSelection(workFrame, q.domIndex);
            filled = { requested: solved.parsed.letters, result: r, readBack: back.selected };
            autoFilled = r.ok && back.selected.length === solved.parsed.letters.length &&
              solved.parsed.letters.every((letter) => back.selected.includes(letter));
            if (!autoFilled) fillError = current?.selected.length ? '页面已有不同答案，留待核对' : '点选与回读答案不一致';
          }
        } catch (err) {
          if (err.code === 'STOPPED') throw err;
          fillError = err.message;
        }
        log(autoFilled ? (isEssay ? `        ✓ 已填入简答草稿 ${filled.chars} 字符，待人工核对` : solved.blanks ? `        ✓ 已填入并核对 ${solved.blanks.length} 空` : `        ✓ 已填入 ${solved.parsed.letters.join('')}`)
          : `        ! 填写未完成：${fillError}`, autoFilled ? 'ok' : 'warn');
      } else {
        log(`        ⊘ 不自动填（${isEssay && !settings.essayAutoFill ? '简答自动填写已关闭' : solved.parsed.reason}）`, 'warn');
      }

      const archive = buildArchive({
        question: q,
        imagePath: solved.imagePath,
        aiAnswer: solved.aiAnswer,
        parsed: solved.parsed,
        validation: solved.validation,
        action: autoFilled ? (isEssay ? '简答草稿已填入待确认' : '已填入') : '转待审',
        note: solved.aiError,
      });

      const item = {
        id: previous?.id || `${task.key}#q${q.index}`,
        taskKey: task.key,
        course: task.courseName || task.courseId,
        courseId: task.courseId,
        clazzId: task.clazzId,
        knowledgeId: task.knowledgeId,
        secNo: task.secNo,
        sectionName: task.sectionName,
        questionIndex: q.index,
        questionId: q.questionId || '',
        domIndex: q.domIndex,
        qtype: q.qtype,
        qtypeRaw: q.qtypeRaw,
        options: (q.options || []).map((o) => ({ letter: o.letter, displayLetter:o.displayLetter, text: o.text })),
        imagePath: solved.imagePath,
        aiAnswer: solved.aiAnswer,
        aiError: solved.aiError,
        aiWaitedMs: solved.aiWaitedMs,
        aiErrorCode: solved.aiErrorCode,
        answerSource: solved.answerSource,
        bankOutcome: solved.bankOutcome || bankAnswer?.kind,
        blanks: solved.blanks,
        confidence: solved.parsed.confidence,
        confidenceLabel: tag,
        letters: solved.parsed.letters,
        textAnswer: solved.parsed.textAnswer,
        requiresReview: isEssay,
        fillError,
        judge: solved.parsed.judge,
        parseReason: solved.parsed.reason,
        validation: solved.validation,
        autoFilled,
        filled,
        archive,
        status: autoFilled ? 'filled' : 'pending-review',
      };
      const existing=result.items.findIndex(it=>it.questionIndex===item.questionIndex);
      if(existing>=0)result.items[existing]=item;else result.items.push(item);

      if (autoFilled) result.answered += 1;
      if (isEssay || !autoFilled) result.queued += 1;
      checkpoint();

      if (onProgress) onProgress({ index: i, total: questions.length, phase: 'done', answerSource: item.answerSource, item });
      if (!solved.answerSource) await sleep(600);
    }

    if (result.stopped) {queueUnanswered(result,task,questions,'任务已停止，可继续未完成题目');keepForReview();return result;}
    throwIfStopped(shouldStop);
    if (result.needsHuman) {
      // Preserve the blocker. Never overwrite it with awaiting-review / ok=true.
      keepForReview(); return result;
    }
    result.phase = 'decide-submit';

    // —— 5) 提交决策 ——
    const subm = result.submitMode;
    const allHigh = result.queued === 0 && independentCount === questions.length &&
      canAutoSubmitItems(result.items, questions.length, allowRandom);
    const verified = allHigh && await verifyQuizBeforeSubmit(workFrame, result.items, result.workIdentity);
    result.answerTiming = {
      elapsedMs: Date.now() - started + (task.standalone ? meta.navigationMs : 0), bank: result.items.filter(item => item.autoFilled && item.answerSource === 'bank').length,
      random: result.items.filter(item => item.autoFilled && item.answerSource === 'random').length, aiRequests,
      filled: result.answered, total: independentCount ?? meta.questionTotal, coverageVerified: verified,
    };
    log(`    本次打开到回填核对 ${(result.answerTiming.elapsedMs / 1000).toFixed(2)} 秒，已填 ${result.answered}/${result.answerTiming.total}，题库 ${result.answerTiming.bank}，随机 ${result.answerTiming.random}，AI 请求 ${aiRequests}`, 'info');

    if (subm === 'auto' && verified && meta.submitBtn?.visible) {
      log('    题数与表单回读均已核对，开始提交', 'info');
      const submission = await submitWork(workFrame, { expected: result.workIdentity, beforeSubmit: () => {
        result.submissionPending = true;
        checkpoint();
        if (!loadState().keptPages?.[task.key]?.info?.submissionPending) throw new Error('未能保存提交检查点');
      }});
      if(submission.ok){
        result.submitted = true;
        result.score = submission.score;
        result.phase = 'submitted';
        dropKeptPage(task.key);
        if (!task.standalone) { await page.close().catch(() => {}); releasePage(page); }
      }else{
        result.submissionPending=!!submission.pendingConfirmation;
        log(`    未确认提交成功，转入待审：${submission.error}`, 'warn');
      }
    }
    if (subm === 'auto' && !verified) log('    提交前未能独立核对整份作业，已转待审', 'warn');
    if(!result.submitted){
      /*
       * 需要人工确认：**保持作业页打开**，让人能核对答案后点提交。
       *
       * 之前这里直接 close 了页面，导致人工确认时答案已经随页面消失 ——
       * 那"人工确认"就变成了空话。现在保留页面，并把 page 句柄交给上层存起来。
       */
      result.phase = 'awaiting-review';
      keepForReview();
      log(
        `    未自动提交（模式=${subm}${result.queued ? `，待人工 ${result.queued} 题` : '，需你确认'}）`,
        'info',
      );
      log(`    作业页保持打开，可在「待审队列」核对后提交`, 'info');
    }

    result.ok = true;
    return result;
  } catch (err) {
    if (err.code === 'STOPPED') {
      result.phase = 'stopped'; result.stopped = true; result.error = err.message;
      if(workFrame&&validatedQuestions){queueUnanswered(result,task,questions,'任务已停止，可继续未完成题目');keepForReview();}
      return result;
    }
    result.error = err.message;
    if (workFrame && validatedQuestions) {
      queueUnanswered(result, task, questions, err.message);
      result.phase = 'needs-human'; result.needsHuman = err.message;
      keepForReview();
    }
    if (err.captureStage) result.captureStage = err.captureStage;
    log(`    ✗ 失败：${err.message}`, 'error');
    return result;
  } finally {
    page.off('dialog', dismissQuizDialog);
    result.elapsedSec = Math.round((Date.now() - started) / 1000);
    if(workFrame&&validatedQuestions){result.answered=result.items.filter(i=>i.autoFilled).length;result.queued=result.items.filter(i=>i.requiresReview||!i.autoFilled).length;recordQuizResult(result);if(!page.isClosed())setPageBusy(page,false);}
    if (result.submissionPending && !shouldStop?.()) {
      const { reconcileOneReview } = await import('../review-reconcile.mjs');
      const verified = await reconcileOneReview(ctx, task.key, {personId, shouldStop, waitMs:3500}).catch(() => null);
      if (verified?.state === 'submitted') Object.assign(result, {ok:true, submitted:true, submissionPending:false, phase:'submitted', score:verified.score});
    }
    // 为人工确认而保留的页面不能在这里关掉
    if (!result.keepPageOpen && !task.standalone) {
      await page.close().catch(() => {});
      releasePage(page);
    }
    if (!page.isClosed()) setPageBusy(page, false);
  }
}

/** 为人工确认而保持打开的作业页：taskKey → { page, savedAt, info } */
const keptWorkPages = new Map();

/**
 * 最多同时保留多少个"等人处理"的页面。
 *
 * 为什么要有上限：整夜无人值守跑课时，视频弹窗题一旦判不准就会保留页面等人，
 * 几十个挂着的标签页（每个都含 video 元素）会吃掉几个 GB 内存，
 * 反而把整批跑挂。所以只保留最近 N 个，更早的关掉但**记录留着**
 * （任务点状态仍是 manual，可在「待审答案」重新打开并恢复草稿）。
 */
const MAX_KEPT_PAGES = 6;

export function registerKeptPage(key, page, info = {}, {busy=false}={}) {
  const previous=keptWorkPages.get(key)?.info||loadState().keptPages?.[key]?.info||{};
  if(previous.personId&&info.personId&&String(previous.personId)!==String(info.personId))throw Error('账号已变更，原作业身份与草稿已保留');
  info={...previous,...info,...(previous.task||info.task?{task:{...previous.task,...info.task}}:{})};
  if(previous.workIdentity?.workid&&!info.workIdentity?.workid)info.workIdentity=previous.workIdentity;
  setPageBusy(page, busy);
  keptWorkPages.set(key, { page, savedAt: Date.now(), info });

  // 超出上限 → 关掉最旧的（新注册的这个一定是"最近"的，不动）
  if (keptWorkPages.size > MAX_KEPT_PAGES) {
    const sorted = [...keptWorkPages.entries()]
      .filter(([k]) => k !== key && !isReviewLocked(k))
      .sort((a, b) => a[1].savedAt - b[1].savedAt);
    while (keptWorkPages.size > MAX_KEPT_PAGES && sorted.length) {
      const [oldKey, old] = sorted.shift();
      try {
        if (!old.info?.task?.standalone && !old.page.isClosed()) old.page.close().catch(() => {});
        log(`    （保留页面已达上限，关掉较早的：${oldKey}）`, 'warn');
      } catch {
        /* 关不掉就算了 */
      }
      keptWorkPages.delete(oldKey);
    }
  }

  // 同时落盘一份（页面句柄本身不能序列化，落的是元信息），
  // 这样"另一个进程"（如 CLI 测试）注册的页面，服务端也能知道存在。
  try {
    mutateState((s) => {
      s.keptPages = s.keptPages || {};
      s.keptPages[key] = { savedAt: Date.now(), info, url: page.url() };
    });
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

export function sameWorkAttempt(expected, actual) {
  return Boolean(expected?.workid && expected?.workanswerid && expected.workid === actual?.workid && expected.workanswerid === actual?.workanswerid);
}

export async function findStandaloneWork(ctx, { expected, personId, results = false } = {}) {
  const candidates = [];
  for (const page of ctx?.pages() || []) {
    if (page.isClosed()) continue;
    try {
      const url = new URL(page.url());
      if (url.protocol !== 'https:' || !['mooc1.chaoxing.com','mooc1-api.chaoxing.com','mooc1-2.chaoxing.com'].includes(url.hostname)) continue;
      if (!/^\/mooc-ans\/(?:api\/)?work\/(?:doHomeWorkNew|selectWorkQuestion)$/i.test(url.pathname) &&
          !(results && /^\/mooc-ans\/(?:api\/)?work\/(?:viewWork|workView|workAnswer)$/i.test(url.pathname))) continue;
      if (personId && url.searchParams.has('cpi') && url.searchParams.get('cpi') !== String(personId)) continue;
      const identity = await frameWorkIdentity(page.mainFrame());
      if (sameWorkAttempt(expected || identity, identity)) candidates.push(page);
    } catch { /* Detached or closed page. */ }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function verifyQuizBeforeSubmit(frame, items, expected) {
  if (!sameWorkAttempt(expected, await frameWorkIdentity(frame))) return false;
  const questions = await extractQuestions(frame);
  if (await readIndependentQuizCount(frame) !== questions.length || items.length !== questions.length ||
      questions.some(question => !question.questionId) || new Set(questions.map(question => question.questionId)).size !== questions.length) return false;
  const { matchReviewQuestions } = await import('./review-recovery.mjs');
  try {
    const matches = matchReviewQuestions(items, questions);
    for (const { item, question, letters } of matches) {
      if (question.qtype === 'fill') {
        const back = await fillQuizBlanks(frame, question.domIndex);
        if (!back.ok || JSON.stringify(back.values) !== JSON.stringify(item.blanks)) return false;
      } else {
        const back = await readSelection(frame, question.domIndex);
        if (!letters?.length || back?.selected.length !== letters.length || letters.some(letter => !back.selected.includes(letter))) return false;
      }
    }
    return sameWorkAttempt(expected, await frameWorkIdentity(frame));
  } catch { return false; }
}

export function getKeptPage(key) {
  const e = keptWorkPages.get(key);
  if (!e) return null;
  if (e.page.isClosed()) {
    keptWorkPages.delete(key);
    return null;
  }
  return e;
}

/**
 * 列出保留的作业页。
 *
 * 合并两个来源：
 *   1) 本进程内存里的（能真正提交，因为持有 Playwright page 句柄）
 *   2) state.json 与待审队列中的定位记录（没有句柄时允许重新打开并恢复）
 */
export function listKeptPages() {
  const out = [];
  const state = loadState();
  const completedVideo = (key, info) => info?.type === 'video-quiz' && state.taskPoints?.[key]?.status === 'done';
  for (const [k, v] of keptWorkPages.entries()) {
    if (completedVideo(k, v.info)) continue;
    out.push({
      key: k,
      savedAt: v.savedAt,
      closed: v.page.isClosed(),
      submittable: !v.page.isClosed(),
      url: v.page.url().slice(0, 120),
      info: v.info,
    });
  }
  // 补上磁盘里记录但本进程没有句柄的
  try {
    const disk = loadState().keptPages || {};
    for (const [k, v] of Object.entries(disk)) {
        if (completedVideo(k, v.info)) continue;
      if (out.some((x) => x.key === k)) continue;
      out.push({
        key: k,
        savedAt: v.savedAt,
        closed: true,
        submittable: false,
        url: v.url || '',
        info: v.info,
        note: '页面尚未连接，可重新打开并恢复已保存答案',
      });
    }
  } catch {
    /* 忽略 */
  }
  // Old startup cleanup could remove the page record. The answer queue still
  // contains the course coordinates needed to reconstruct its parent card.
  for(const item of listReviewItems())if(!out.some(record=>record.key===item.taskKey)){
    out.push({key:item.taskKey,closed:true,submittable:false,url:'',info:{course:item.course,secNo:item.secNo,name:item.sectionName}});
  }
  return out;
}

export function dropKeptPage(key) {
  keptWorkPages.delete(key);
  try {
    mutateState((s) => {
      if (s.keptPages) delete s.keptPages[key];
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 对"保持打开"的作业页执行提交（供待审队列的「确认提交」按钮调用）。
 *
 * @param {string} key 任务点 key
 */
export async function fillKeptEssayAnswer(key, domIndex, text) {
  const e = getKeptPage(key);
  if (!e) return { ok: false, error: '作业页已关闭，请重新打开该任务后填写' };
  const { findWorkFrame } = await import('./quiz.mjs');
  const wf = findWorkFrame(e.page);
  if (!wf) return { ok: false, error: '找不到作业 frame' };
  // 此入口仅由待审队列的人工保存按钮调用，允许替换该题现有草稿。
  return fillEssayAnswer(wf, domIndex, text, { overwrite: true });
}

export async function editKeptEssayReviewAnswer(id, value, { ensurePage } = {}) {
  const item = listReviewItems().find((it) => it.id === id);
  if (!item) return null;
  if (item.qtype !== 'essay' || typeof value !== 'string') throw new Error('请填写简答正文');
  const text = normalizeEssayText(value);
  if (!text || text.length > MAX_ESSAY_LENGTH) throw new Error('简答正文须为 1～10000 字符');
  updateReviewAnswer(id, { textAnswer: text, filled: null });
  let filled;
  try{
    if(ensurePage){const prepared=await ensurePage(item.taskKey);if(prepared?.alreadySubmitted)return {id,alreadySubmitted:true};}
    const current=listReviewItems().find(it=>it.id===id);
    filled = await fillKeptEssayAnswer(item.taskKey, current.domIndex, text);
    if (!filled.ok) throw new Error(filled.error);
  }catch(error){throw new Error(`草稿已保存，但未能填入作业页：${error.message}`);}
  return updateReviewAnswer(id, { textAnswer: text, filled });
}

export async function submitKeptWork(key) {
  const e = getKeptPage(key);
  if (!e) return { ok: false, error: '作业页已不在（可能被手动关闭或已提交）' };
  const page = e.page;
  const { findWorkFrame } = await import('./quiz.mjs');
  const wf = findWorkFrame(page);
  if (!wf) return { ok: false, error: '找不到作业 frame' };
  const wasPending = !!e.info?.submissionPending;
  const r = await submitWork(wf, {
    confirmationOnly: wasPending, verificationOnly: !!e.info?.submissionVerificationOnly,
    expected: e.info?.workIdentity?.workanswerid ? e.info.workIdentity : null,
    beforeSubmit: () => {
      e.info = {...e.info, submissionPending:true, submissionVerificationOnly:true};
      if (!mutateState(state => {
        if (!state.keptPages?.[key]) throw new Error('缺少待审作业检查点');
        state.keptPages[key].info = e.info;
        return true;
      })) throw new Error('未能保存提交检查点');
    },
  });
  if(r.pendingConfirmation){
    e.info={...e.info,submissionPending:true};
    mutateState(state=>{if(state.keptPages?.[key])state.keptPages[key].info=e.info;});
  }
  if (!r.ok && !r.pendingConfirmation && !wasPending && e.info?.submissionPending) {
    e.info = {...e.info,submissionPending:false,submissionVerificationOnly:false};
    mutateState(state=>{if(state.keptPages?.[key])state.keptPages[key].info=e.info;});
  }
  if (r.ok) {
    if (!e.info?.task?.standalone) { await page.close().catch(() => {}); releasePage(page); }
    dropKeptPage(key);
  }
  return r;
}

/**
 * 点提交按钮并处理二次确认弹窗。
 *
 * 学习通提交流程：
 *   <a class="btnSubmit workBtnIndex" onclick="btnBlueSubmit();">提交</a>
 *     → 弹出确认框 <div class="popDiv wid440 Marking"> "提示 / 确认提交？"
 *          <a id="popok" class="jb_btn">提交</a>     ← 必须点这个
 *          <a id="popno" class="bluebtn">取消</a>
 *     → 提交后页面显示"已完成 / 本次成绩 XX 分"
 *
 * 两个坑：
 *   1) 早期只点 .btnSubmit 然后去找 #submitBackOk（那是交卷**之后**的返回按钮），
 *      确认框一直挂着，提交从未发生 —— 表现为"点了提交但任务点仍未完成"。
 *   2) 确认框按钮**必须用真实指针事件**。JS 原生 el.click() 点不动 #popok
 *      （疑似绑的是 jQuery 事件），使用真实鼠标或按钮原生 Enter 激活。
 */
export async function submitWork(workFrame,{confirmationOnly=false,verificationOnly=false,expected=null,beforeSubmit=()=>{}}={}) {
  const page=workFrame.page();let clicked=false,confirmed=false,nativeError='';
  if (submittingPages.has(page)) return {ok:false,pendingConfirmation:true,error:'作业正在核对提交结果'};
  submittingPages.add(page);
  const frames=()=>[workFrame,...page.frames()].filter((f,i,a)=>f&&a.indexOf(f)===i);
  const findControl=async(selector,confirm=false)=>{
    for(const frame of confirm ? frames() : [workFrame]){
      const control=frame.locator(selector).filter({visible:true});
      const count=await control.count().catch(()=>0);
      for(let i=0;i<count;i++){
        const item=control.nth(i);
        if(confirm&&!await item.evaluate(e=>/提交|交卷/.test((e.closest('.popDiv,.layui-layer,[role="dialog"],#confirmSubWin')||e.parentElement)?.innerText||'')).catch(()=>false))continue;
        return item;
      }
    }
    return null;
  };
  const onDialog=dialog=>{
    if((clicked||confirmed)&&dialog.type()==='confirm'&&/提交|交卷/.test(dialog.message())){confirmed=true;void dialog.accept().catch(()=>{});}
    else{nativeError=dialog.message().slice(0,160);void dialog.dismiss().catch(()=>{});}
  };
  page.on('dialog',onDialog);
  try{
    if((await pageSubmissionState(page,workFrame,{expected})).submitted)return {ok:true,alreadySubmitted:true};
    if (verificationOnly) return {ok:false,pendingConfirmation:true,error:'上次提交仍待平台确认，已保留待审记录'};
    if (expected && !sameWorkAttempt(expected,await frameWorkIdentity(workFrame))) return {ok:false,error:'原作答身份已变化'};
    const confirmationSelector = '#popok, #popOk, #confirmSubWin a[onclick^="submitCheckTimes("]';
    let confirmation=await findControl(confirmationSelector,true);
    if(!confirmation){
      if(confirmationOnly)return {ok:false,pendingConfirmation:true,error:'上次提交结果尚未确认，当前没有待确认弹窗，暂不重复提交'};
      const submit=await findControl(WORK_SUBMIT_SELECTOR);
      if(!submit)return {ok:false,error:'未找到可用的提交按钮，请核对作业页面'};
      beforeSubmit();clicked=true;await submit.click({timeout:10000});
    }
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const result=await pageSubmissionState(page,workFrame,{expected});
      if(result.submitted)return {ok:true,status:'success',score:result.score};
      if(nativeError)return {ok:false,pendingConfirmation:!/未答|必填|不能为空|请完成|未完成/.test(nativeError),error:nativeError};
      if(!confirmed){
        confirmation=confirmation||await findControl(confirmationSelector,true);
        if(confirmation){if(!clicked)beforeSubmit();confirmed=true;await activateSubmitConfirmation(confirmation,page);confirmation=null;}
      }
      await page.waitForTimeout(300);
    }
    return {ok:false,pendingConfirmation:clicked||confirmed,error:'提交结果尚未确认，答案已保留；请核对网页结果，暂不重复提交'};
  }catch(error){return {ok:false,pendingConfirmation:clicked||confirmed,error:'提交未完成：'+error.message};}
  finally{page.off('dialog',onDialog);submittingPages.delete(page);}
}

/**
 * 记录作业结果到 state（含待审队列）。
 *
 * 走 mutateState 做原子"读-改-写" —— 早期用 loadState()+saveState()，
 * 在"外部进程也改了同一文件"的场景下会被覆盖，导致待审队列写不进去。
 */
export function recordQuizResult(result,{checkpoint=false}={}) {
  const saved=mutateState((state) => {
    state.quizzes = state.quizzes || {};
    const previous=state.quizzes[result.key]||{},emptySkip=result.phase==='already-finished'&&!result.totalQuestions;
    state.quizzes[result.key] = {
      ...previous,
      at: new Date().toISOString(),
      ok: result.ok,
      phase: emptySkip&&previous.submitted?'submitted':result.phase,
      totalQuestions: emptySkip?(previous.totalQuestions||0):result.totalQuestions,
      answered: emptySkip?(previous.answered||0):result.answered,
      queued: emptySkip?(previous.queued||0):result.queued,
      submitted: result.submitted||emptySkip&&previous.submitted===true,
      error: result.error,
      aiErrorCode: result.aiErrorCode || null,
      needsHuman: result.needsHuman || null,
      ...(result.answerTiming ? {answerTiming:result.answerTiming} : {}),
    };

    /*
     * 任务点状态也要落。
     * 早期只有视频执行器写 taskPoints，测验执行器不写 ——
     * 批量里跑完的测验会永远停在 `running`，界面看起来像"卡住了"。
     */
    state.taskPoints = state.taskPoints || {};
    const prev = state.taskPoints[result.key] || { retries: 0 };
    if (!checkpoint && prev.status !== 'done') {
      if (result.submitted) {
        state.taskPoints[result.key] = {
          ...prev,
          status: 'done',
          name: result.name,
          secNo: result.secNo,
          submitted: true,
          progress: 1,
          score: result.score ?? prev.score ?? null,
          note: '测验已自动提交',
          updatedAt: new Date().toISOString(),
        };
      } else if (result.phase === 'awaiting-review') {
        state.taskPoints[result.key] = {
          ...prev,
          status: 'manual',
          name: result.name,
          secNo: result.secNo,
          answered: result.answered,
          queued: result.queued,
          note: `测验已作答 ${result.answered} 题待人工确认提交（页面已保留）`,
          updatedAt: new Date().toISOString(),
        };
      } else if (result.needsHuman || result.phase === 'needs-human' || result.phase?.startsWith('blocked-')) {
        state.taskPoints[result.key] = {...prev, status:'manual', name:result.name, secNo:result.secNo, lastError:result.error,
          note:'任务未完成，已暂停并保存待处理题目', updatedAt:new Date().toISOString()};
      } else if (!result.ok) {
        state.taskPoints[result.key] = {
          ...prev,
          status: 'failed',
          name: result.name,
          secNo: result.secNo,
          lastError: result.error,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // 需要人工确认的题目进队；已自动提交的不进队
    state.reviewQueue = state.reviewQueue || [];
    if(result.submitted)for(const item of state.reviewQueue)if(item.taskKey===result.key&&item.status!=='discarded')item.status='submitted';
    const keep = result.items.filter((it) => it.status === 'pending-review' || (!result.submitted && it.autoFilled));
    for (const it of keep) {
      const idx = state.reviewQueue.findIndex((x) => x.id === it.id);
      const entry = { ...it, status: result.submitted ? 'submitted' : it.status };
      if (idx >= 0) state.reviewQueue[idx] = entry;
      else state.reviewQueue.push(entry);
    }
    return { queueLen: state.reviewQueue.length, kept: keep.length };
  });
  const kept=getKeptPage(result.key);if(kept)markSavedReviewPage(kept.page);
  return saved;
}
