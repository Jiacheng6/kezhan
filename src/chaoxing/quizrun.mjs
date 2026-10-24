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
import {
  waitWorkFrame,
  extractQuestions,
  getWorkMeta,
  shootQuestion,
  selectOptions,
  readSelection,
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
import { AI_BLOCK_CODES, queueUnanswered } from './quiz-outcome.mjs';
import { pageSubmissionState } from './submission-state.mjs';
import {activateSubmitConfirmation} from './submit-control.mjs';

export { cardsUrl };
const submittingPages=new WeakSet();

export function canAutoSubmitItems(items, expectedCount = items.length) {
  return items.length > 0 && items.length === expectedCount && items.every((it) =>
    it.qtype !== 'essay' && !it.requiresReview && it.confidence === 'high' && it.autoFilled);
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
async function solveOne({ workFrame, domIndex, qianwenPage, question, prompt, shouldStop, taskKey }) {
  const dir = archiveDir();

  // 截图（唯一可靠输入 —— 题干是自定义字体加密的）
  const imagePath = await shootQuestion(workFrame, domIndex, dir, { shouldStop, onRecovery: (message) => log(`    ${message}`, 'warn') });
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
export async function runQuizTask({ ctx, qianwenPage, task, personId, onProgress, shouldStop, reviewRetry=false,restartTask=false }, {solve=solveOne}={}) {
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
    if(saved?.submissionPending||isReviewLocked(task.key))return {...result,phase:'awaiting-review',submissionPending:!!saved?.submissionPending};
    if(previous?.page&&!previous.page.isClosed()){releasePage(previous.page);await previous.page.close();}
    // Keep persisted work identity and answers for the normal checkpoint match.
  }
  const page = await newTaskPage(ctx, 'quiz');
  page.on('dialog', (d) => {if(!submittingPages.has(page))void d.accept().catch(() => {});});
  let workFrame = null, questions = [],validatedQuestions=false;
  const keepForReview = ({busy=false}={}) => {
    result.keepPageOpen = true; result.workPage = page;
    result.workFrameUrl = workFrame.url();
    registerKeptPage(task.key, page, {
      task: {courseId:task.courseId,clazzId:task.clazzId,knowledgeId:task.knowledgeId,name:task.name,type:task.type,jobid:task.jobid,cardNum:result.cardNum},
      workIdentity: workIdentity(workFrame.url()), personId: String(personId),
      submissionPending: !!result.submissionPending,
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

    // —— 2) 等作业 frame 渲染出题目 ——
    result.phase = 'wait-work-frame';
    workFrame = await waitWorkFrame(page, 35000);
    if (!workFrame) throw new Error('作业 frame 未出现或题目未渲染');

    const meta = await getWorkMeta(workFrame);
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
      const actual=workIdentity(workFrame.url());
      if(!identity?.workid||Object.entries(identity).some(([key,value])=>actual[key]!==value))throw Error('作业或作答次数改变，已保留旧答案，请先人工核对');
      const {matchReviewQuestions}=await import('./review-recovery.mjs');
      for(const {item,question}of matchReviewQuestions(cached.filter(item=>(item.aiAnswer&&!item.aiError)||item.editedByHuman),questions)){
        const parsed=parseAnswer(item.aiAnswer||'',question);
        if(item.editedByHuman){parsed.letters=item.letters||[];parsed.textAnswer=item.textAnswer||'';parsed.confidence='high';parsed.canFill=true;}
        const validation=validateBeforeSubmit(parsed,question);
        if((!item.aiError||item.editedByHuman)&&(question.qtype==='essay'?parsed.canFill:validation.safe&&parsed.confidence==='high'))reusable.set(question.index,{...item,parsed,validation});
      }
    }
    for(const [index,previous]of reusable)result.items.push({...previous,questionIndex:index,autoFilled:false,filled:null,savedAnswer:true,status:'pending-review'});
    validatedQuestions=true;
    checkpoint();
    // —— 3) AI登录检查 ——
    const login = await checkLogin(qianwenPage);
    if (!login.loggedIn) {
      result.phase = 'blocked-verification'; result.aiErrorCode = 'not-logged-in';
      result.error = result.needsHuman = 'AI 未登录或页面尚未就绪，请在软件内完成登录后重新开始';
      queueUnanswered(result, task, questions, result.error); keepForReview();
      return result;
    }

    // —— 4) 逐题处理 ——

    for (let i = 0; i < questions.length; i += 1) {
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
      const q = questions[i];
      log(`    [${i + 1}/${questions.length}] ${q.qtypeRaw} ${q.optionCount} 选项 —— 读取题目截图…`, 'info');

      if (onProgress) onProgress({ index: i, total: questions.length, phase: 'asking' });

      const previous=reusable.get(q.index);
      if(previous)log(`        复用第 ${q.index} 题已保存答案，仅核对并恢复填写，不重复问 AI`, 'info');
      const solved = previous ? {...previous,question:q,aiError:null,aiErrorCode:null} : await solve({
        taskKey:task.key,
        workFrame,
        domIndex: q.domIndex,
        qianwenPage,
        question: q,
        prompt: q.qtype === 'essay' ? settings.essayPrompt : settings.quizPrompt,
        shouldStop,
      });

      const tag = confidenceLabel(solved.parsed.confidence);
      if (!solved.aiError) {
      log(
        `        AI：${q.qtype === 'essay' ? `简答正文 ${solved.parsed.textAnswer?.length || 0} 字符` : solved.parsed.letters.join('') || '(无)'}  ${tag}  ${solved.parsed.reason}`,
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
      const mayFill = !solved.aiError && (isEssay ? settings.essayAutoFill && solved.parsed.canFill
        : solved.parsed.confidence === 'high' && solved.validation.safe);
      let filled = null;
      let autoFilled = false;
      let fillError = null;
      throwIfStopped(shouldStop);
      if (mayFill) {
        try {
          if (isEssay) {
            filled = await fillEssayAnswer(workFrame, q.domIndex, solved.parsed.textAnswer, { shouldStop });
            autoFilled = filled.ok && filled.verified;
            fillError = filled.error || null;
          } else {
            const r = await selectOptions(workFrame, q.domIndex, solved.parsed.letters);
            await page.waitForTimeout(400);
            const back = await readSelection(workFrame, q.domIndex);
            filled = { requested: solved.parsed.letters, result: r, readBack: back.selected };
            autoFilled = r.ok && back.selected.length === solved.parsed.letters.length &&
              solved.parsed.letters.every((letter) => back.selected.includes(letter));
            if (!autoFilled) fillError = '点选与回读答案不一致';
          }
        } catch (err) {
          if (err.code === 'STOPPED') throw err;
          fillError = err.message;
        }
        log(autoFilled ? (isEssay ? `        ✓ 已填入简答草稿 ${filled.chars} 字符，待人工核对` : `        ✓ 已填入 ${solved.parsed.letters.join('')}`)
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

      if (onProgress) onProgress({ index: i, total: questions.length, phase: 'done', item });
      await sleep(600);
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
    const allHigh = result.queued === 0 && canAutoSubmitItems(result.items, questions.length);

    if (subm === 'auto' && allHigh && meta.submitBtn) {
      log('    全部题目均为高可靠 → 自动提交', 'info');
      const submission = await submitWork(workFrame);
      if(submission.ok){
        result.submitted = true;
        result.score = submission.score;
        result.phase = 'submitted';
        await page.close().catch(() => {});
        releasePage(page);
      }else{
        result.submissionPending=!!submission.pendingConfirmation;
        log(`    未确认提交成功，转入待审：${submission.error}`, 'warn');
      }
    }
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
    result.elapsedSec = Math.round((Date.now() - started) / 1000);
    if(workFrame&&validatedQuestions){result.answered=result.items.filter(i=>i.autoFilled).length;result.queued=result.items.filter(i=>i.requiresReview||!i.autoFilled).length;recordQuizResult(result);if(!page.isClosed())setPageBusy(page,false);}
    // 为人工确认而保留的页面不能在这里关掉
    if (!result.keepPageOpen) {
      await page.close().catch(() => {});
      releasePage(page);
    }
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
        if (!old.page.isClosed()) old.page.close().catch(() => {});
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

export function workIdentity(url) {
  try{
    const params=[...new URL(url).searchParams];
    return Object.fromEntries(params.filter(([key])=>/^(?:workid|workanswerid)$/i.test(key)).map(([key,value])=>[key.toLowerCase(),value]));
  }catch{return {};}
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
  const r = await submitWork(wf,{confirmationOnly:!!e.info?.submissionPending});
  if(r.pendingConfirmation){
    e.info={...e.info,submissionPending:true};
    mutateState(state=>{if(state.keptPages?.[key])state.keptPages[key].info=e.info;});
  }
  if (r.ok) {
    await page.close().catch(() => {});
      releasePage(page);
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
export async function submitWork(workFrame,{confirmationOnly=false}={}) {
  const page=workFrame.page();let clicked=false,confirmed=false,nativeError='';
  submittingPages.add(page);
  const frames=()=>[workFrame,...page.frames()].filter((f,i,a)=>f&&a.indexOf(f)===i);
  const findControl=async(selector,confirm=false)=>{
    for(const frame of frames()){
      const control=frame.locator(selector).filter({visible:true});
      const count=await control.count().catch(()=>0);
      for(let i=0;i<count;i++){
        const item=control.nth(i);
        if(confirm&&!await item.evaluate(e=>/提交|交卷/.test((e.closest('.popDiv,.layui-layer,[role="dialog"]')||e.parentElement)?.innerText||'')).catch(()=>false))continue;
        return item;
      }
    }
    return null;
  };
  const onDialog=dialog=>{
    if(dialog.type()==='confirm'&&/提交|交卷/.test(dialog.message())){confirmed=true;void dialog.accept().catch(()=>{});}
    else{nativeError=dialog.message().slice(0,160);void dialog.dismiss().catch(()=>{});}
  };
  page.on('dialog',onDialog);
  try{
    if((await pageSubmissionState(page,workFrame)).submitted)return {ok:true,alreadySubmitted:true};
    let confirmation=await findControl('#popok, #popOk',true);
    if(!confirmation){
      if(confirmationOnly)return {ok:false,pendingConfirmation:true,error:'上次提交结果尚未确认，当前没有待确认弹窗，暂不重复提交'};
      const submit=await findControl('.btnSubmit');
      if(!submit)return {ok:false,error:'未找到可用的提交按钮，请核对作业页面'};
      clicked=true;await submit.click({timeout:10000});
    }
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const result=await pageSubmissionState(page,workFrame);
      if(result.submitted)return {ok:true,status:'success',score:result.score};
      if(nativeError)return {ok:false,pendingConfirmation:!/未答|必填|不能为空|请完成|未完成/.test(nativeError),error:nativeError};
      if(!confirmed){
        confirmation=confirmation||await findControl('#popok, #popOk',true);
        if(confirmation){confirmed=true;await activateSubmitConfirmation(confirmation,page);confirmation=null;}
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
    state.quizzes[result.key] = {
      at: new Date().toISOString(),
      ok: result.ok,
      phase: result.phase,
      totalQuestions: result.totalQuestions,
      answered: result.answered,
      queued: result.queued,
      submitted: result.submitted,
      error: result.error,
      aiErrorCode: result.aiErrorCode || null,
      needsHuman: result.needsHuman || null,
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
