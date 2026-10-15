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
import { waitTurn, markAsked, reportSuccess, reportFailure, throttleState } from '../ai/throttle.mjs';
import { throwIfStopped } from '../control.mjs';
import { fillEssayAnswer } from './essay.mjs';
/*
 * 卡片逻辑与视频执行器共用（section.mjs）——
 * 章节测验常常在**第 2 张卡片**上（第 1 张是视频），写死 num=0 会读不到。
 */
import { cardsUrl, openSectionCard, waitForAttachments } from './section.mjs';
import { readPointStatusFromPage } from './attach.mjs';
import { skipDecision, describeSkip } from './skip.mjs';
import { newTaskPage, releasePage } from '../browser/pages.mjs';

export { cardsUrl };

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
async function solveOne({ workFrame, domIndex, qianwenPage, question, prompt, shouldStop }) {
  const dir = archiveDir();

  // 截图（唯一可靠输入 —— 题干是自定义字体加密的）
  const imagePath = await shootQuestion(workFrame, domIndex, dir, { shouldStop, onRecovery: (message) => log(`    ${message}`, 'warn') });
  log('        题目截图已就绪，准备发送给AI', 'info');

  // 节流：保护AI账号不被风控（踩过坑）
  await waitTurn({ shouldStop });
  throwIfStopped(shouldStop);

  const settings = loadSettings();
  const ai = await askImage({
    page: qianwenPage,
    imagePath,
    prompt,
    freshChat: settings.ai?.freshChatPerQuestion ?? false,
    shouldStop,
  });
  markAsked();
  throwIfStopped(shouldStop);

  if (ai.ok) reportSuccess();
  else reportFailure({ errorCode: ai.errorCode, error: ai.error });

  const parsed = parseAnswer(ai.ok ? ai.answer : `（AI调用失败：${ai.error}）`, question);
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
export async function runQuizTask({ ctx, qianwenPage, task, personId, onProgress, shouldStop }) {
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
    submitMode: settings.submitMode,
    items: [],
    error: null,
    elapsedSec: 0,
  };

  const page = await newTaskPage(ctx, 'quiz');
  page.on('dialog', (d) => d.accept().catch(() => {}));

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
    const workFrame = await waitWorkFrame(page, 35000);
    if (!workFrame) throw new Error('作业 frame 未出现或题目未渲染');

    const meta = await getWorkMeta(workFrame);
    result.totalQuestions = meta.questionTotal;
    log(`    作业「${meta.title || task.name}」共 ${meta.questionTotal} 题`, 'info');

    if (!meta.questionTotal) throw new Error('未读到任何题目');
    if (!meta.submitBtn) log('    ! 未找到提交按钮，将只填不交', 'warn');

    // —— 3) AI登录检查 ——
    const login = await checkLogin(qianwenPage);
    if (!login.loggedIn) throw new Error('AI未登录 —— 请在受控 Edge 里登录AI后重试');

    // —— 4) 逐题处理 ——
    const questions = await extractQuestions(workFrame);
    const items = [];

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

      const solved = await solveOne({
        workFrame,
        domIndex: q.domIndex,
        qianwenPage,
        question: q,
        prompt: q.qtype === 'essay' ? settings.essayPrompt : settings.quizPrompt,
        shouldStop,
      });

      const tag = confidenceLabel(solved.parsed.confidence);
      log(
        `        AI：${q.qtype === 'essay' ? `简答正文 ${solved.parsed.textAnswer?.length || 0} 字符` : solved.parsed.letters.join('') || '(无)'}  ${tag}  ${solved.parsed.reason}`,
        solved.parsed.confidence === 'high' ? 'ok' : 'warn',
      );

      // 风控验证：立刻停止整批，不继续无意义地等待
      if (['verification-required','rate-limited','not-logged-in','draft-not-empty','draft-attachment','already-generating','wrong-ai-page'].includes(solved.aiErrorCode)) {
        result.phase = 'blocked-verification';
        result.error = solved.aiError;
        result.needsHuman = solved.aiError || '请检查 AI 网页';
        log(`    ⛔ ${solved.aiError}`, 'error');
        log(`    ⛔ 已停止本批次 —— 请在AI标签页完成验证后重新开始`, 'error');
        break;
      }

      // AI连续未返回（疑似被限流）→ 也停下，别继续撞
      {
        const st = throttleState();
        const limit = loadSettings().ai?.consecutiveFailLimit ?? 2;
        if (st.consecutiveFail >= limit) {
          result.phase = 'blocked-throttled';
          result.error = `AI连续 ${st.consecutiveFail} 次未正常返回（疑似限流），已停止`;
          result.needsHuman = `等待约 ${Math.round(st.cooldownLeftMs / 60000)} 分钟后重试，或减少每批题量`;
          log(`    ⛔ ${result.error}`, 'error');
          break;
        }
      }

      // 是否允许自动填
      const isEssay = q.qtype === 'essay';
      const mayFill = isEssay ? settings.essayAutoFill && solved.parsed.canFill
        : solved.parsed.confidence === 'high' && solved.validation.safe;
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
        id: `${task.key}#q${q.index}`,
        taskKey: task.key,
        course: task.courseName || task.courseId,
        courseId: task.courseId,
        clazzId: task.clazzId,
        knowledgeId: task.knowledgeId,
        secNo: task.secNo,
        sectionName: task.sectionName,
        questionIndex: q.index,
        domIndex: q.domIndex,
        qtype: q.qtype,
        qtypeRaw: q.qtypeRaw,
        options: (q.options || []).map((o) => ({ letter: o.letter, text: o.text })),
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
      items.push(item);
      result.items.push(item);

      if (autoFilled) result.answered += 1;
      if (isEssay || !autoFilled) result.queued += 1;

      if (onProgress) onProgress({ index: i, total: questions.length, phase: 'done', item });
      await sleep(600);
    }

    if (result.stopped) return result;
    throwIfStopped(shouldStop);
    result.phase = 'decide-submit';

    // —— 5) 提交决策 ——
    const subm = settings.submitMode;
    const allHigh = result.queued === 0 && canAutoSubmitItems(result.items, questions.length);

    if (subm === 'auto' && allHigh && meta.submitBtn) {
      log('    全部题目均为高可靠 → 自动提交', 'info');
      await submitWork(workFrame);
      result.submitted = true;
      result.phase = 'submitted';
      await page.close().catch(() => {});
      releasePage(page);
    } else {
      /*
       * 需要人工确认：**保持作业页打开**，让人能核对答案后点提交。
       *
       * 之前这里直接 close 了页面，导致人工确认时答案已经随页面消失 ——
       * 那"人工确认"就变成了空话。现在保留页面，并把 page 句柄交给上层存起来。
       */
      result.phase = 'awaiting-review';
      result.keepPageOpen = true;
      result.workPage = page;
      result.workFrameUrl = workFrame.url();
      registerKeptPage(task.key, page, {
        course: task.courseName || task.courseId,
        secNo: task.secNo,
        name: task.name,
        totalQuestions: result.totalQuestions,
        answered: result.answered,
        queued: result.queued,
        items: result.items.map((i) => ({
          questionIndex: i.questionIndex,
          qtype: i.qtype,
          letters: i.letters,
          textAnswer: i.textAnswer,
          requiresReview: i.requiresReview,
          confidence: i.confidence,
          autoFilled: i.autoFilled,
        })),
      });
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
      return result;
    }
    result.error = err.message;
    if (err.captureStage) result.captureStage = err.captureStage;
    log(`    ✗ 失败：${err.message}`, 'error');
    return result;
  } finally {
    result.elapsedSec = Math.round((Date.now() - started) / 1000);
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
 * （任务点状态仍是 manual，人可在「待审队列」看到并手动重跑）。
 */
const MAX_KEPT_PAGES = 6;

export function registerKeptPage(key, page, info = {}) {
  keptWorkPages.set(key, { page, savedAt: Date.now(), info });

  // 超出上限 → 关掉最旧的（新注册的这个一定是"最近"的，不动）
  if (keptWorkPages.size > MAX_KEPT_PAGES) {
    const sorted = [...keptWorkPages.entries()]
      .filter(([k]) => k !== key)
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
      s.keptPages[key] = { savedAt: Date.now(), info, url: page.url().slice(0, 200) };
    });
  } catch {
    /* 落盘失败不影响主流程 */
  }
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
 *   2) state.json 里记录的（别的进程注册的，只用于"告知用户有这么个页面"）
 */
export function listKeptPages() {
  const out = [];
  for (const [k, v] of keptWorkPages.entries()) {
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
      if (out.some((x) => x.key === k)) continue;
      out.push({
        key: k,
        savedAt: v.savedAt,
        closed: true,
        submittable: false,
        url: v.url || '',
        info: v.info,
        note: '由其他进程（如命令行测试）注册，本进程无法直接提交',
      });
    }
  } catch {
    /* 忽略 */
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

export async function editKeptEssayReviewAnswer(id, value) {
  const item = listReviewItems().find((it) => it.id === id);
  if (!item) return null;
  if (item.qtype !== 'essay' || typeof value !== 'string') throw new Error('请填写简答正文');
  const text = normalizeEssayText(value);
  if (!text || text.length > MAX_ESSAY_LENGTH) throw new Error('简答正文须为 1～10000 字符');
  const filled = await fillKeptEssayAnswer(item.taskKey, item.domIndex, text);
  if (!filled.ok) throw new Error(filled.error);
  return updateReviewAnswer(id, { textAnswer: text, filled });
}

export async function submitKeptWork(key) {
  const e = getKeptPage(key);
  if (!e) return { ok: false, error: '作业页已不在（可能被手动关闭或已提交）' };
  const page = e.page;
  const { findWorkFrame } = await import('./quiz.mjs');
  const wf = findWorkFrame(page);
  if (!wf) return { ok: false, error: '找不到作业 frame' };
  const r = await submitWork(wf);
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
 *      （疑似绑的是 jQuery 事件），必须用 Playwright 的 locator.click()。
 */
export async function submitWork(workFrame) {
  const page = workFrame.page();

  // 1) 点"提交"（真实指针事件）
  try {
    await workFrame.locator('.btnSubmit').first().click({ timeout: 15000 });
  } catch (err) {
    return { ok: false, error: `点提交按钮失败：${err.message}` };
  }

  // 2) 等确认框出现，并用真实指针事件点 #popok
  let confirmed = false;
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(700);
    const visible = await workFrame
      .evaluate(() => {
        const ok = document.querySelector('#popok');
        return !!(ok && ok.getBoundingClientRect().width > 0);
      })
      .catch(() => false);
    if (!visible) continue;

    try {
      await workFrame.locator('#popok').click({ timeout: 8000 });
      confirmed = true;
      log(`    已点确认框的「提交」（真实指针事件）`, 'debug');
    } catch (err) {
      log(`    点确认框失败：${err.message}`, 'warn');
    }
    break;
  }

  if (!confirmed) {
    return { ok: false, error: '确认框未出现或未能点到确认按钮' };
  }

  // 3) 等提交结果
  let result = null;
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(1200);
    const st = await workFrame
      .evaluate(() => {
        const body = document.body.innerText || '';
        const score = body.match(/本次成绩\s*([\d.]+)\s*分/) || body.match(/得分[:：]?\s*([\d.]+)/);
        const done = /已完成|提交成功|已提交|测评结果|我的答案/.test(body);
        return { done, score: score ? score[1] || score[0] : null };
      })
      .catch(() => ({ done: false, score: null }));

    if (st.done) {
      result = { status: 'success', score: st.score };
      break;
    }
    // 有的版本会弹一个"确定"返回框
    const backVisible = await workFrame
      .evaluate(() => {
        const b2 = document.querySelector('#submitBackOk');
        return !!(b2 && b2.getBoundingClientRect().width > 0);
      })
      .catch(() => false);
    if (backVisible) {
      await workFrame.locator('#submitBackOk').click({ timeout: 5000 }).catch(() => {});
      result = { status: 'success', note: '经返回框确认' };
      break;
    }
  }

  if (!result) return { ok: true, note: '已点确认提交，但未捕获到成功提示（需人工核对）' };
  return { ok: true, ...result };
}

/**
 * 记录作业结果到 state（含待审队列）。
 *
 * 走 mutateState 做原子"读-改-写" —— 早期用 loadState()+saveState()，
 * 在"外部进程也改了同一文件"的场景下会被覆盖，导致待审队列写不进去。
 */
export function recordQuizResult(result) {
  return mutateState((state) => {
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
    };

    /*
     * 任务点状态也要落。
     * 早期只有视频执行器写 taskPoints，测验执行器不写 ——
     * 批量里跑完的测验会永远停在 `running`，界面看起来像"卡住了"。
     */
    state.taskPoints = state.taskPoints || {};
    const prev = state.taskPoints[result.key] || { retries: 0 };
    if (prev.status !== 'done') {
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
    const keep = result.items.filter((it) => it.status === 'pending-review' || (!result.submitted && it.autoFilled));
    for (const it of keep) {
      const idx = state.reviewQueue.findIndex((x) => x.id === it.id);
      const entry = { ...it, status: result.submitted ? 'submitted' : it.status };
      if (idx >= 0) state.reviewQueue[idx] = entry;
      else state.reviewQueue.push(entry);
    }
    return { queueLen: state.reviewQueue.length, kept: keep.length };
  });
}
