/**
 * 视频内「弹窗题」处理（P6 正式版）。
 *
 * ⚠ 重要的认知修正（2026-09-23 实测，截图 + DOM + 调用栈三重取证）：
 *
 *   早期以为弹窗题走的是 cards 页的 showCustomPop() / .customMaskDiv 机制
 *   （那是从 HTML 里挖出来的旧结构）。**错的** —— 实测：
 *     · showCustomPop 从未被调用（我们包了钩子，记录为 null）
 *     · cards 页里没有任何遮罩元素
 *     · 真正的弹窗题在 **视频 iframe 内部**（ananas/modules/video/index.html）
 *     · 暂停视频的正是 video.js 自己（pause 调用栈落在 video.min.js 里）
 *
 *   结构示例：
 *     div.ans-videoquiz#videoquiz-example
 *       div.tkTopic
 *         div.tkTopic_title            → "单选题" / "多选题" / "判断题"
 *         div.tkTopic_con.tkScroll
 *           div.tkItem
 *             div.tkItem_title         → 题干（这里**不是**字体加密，可直接读）
 *             ul.tkItem_ul
 *               li.ans-videoquiz-opt   → 选项，文本形如 "A、选项一"
 *                 label > span.tkRadio > input[type=radio|checkbox]
 *       div.tkTopic_oper
 *         a#videoquiz-submit           → 提交（点击必须用原生 click）
 *         a#videoquiz-submitting       → 提交中（平时 display:none）
 *         a#videoquiz-continue         → 继续（答完点它恢复播放）
 *         span#spanHas "回答正确" / span#spanNot "回答错误"
 *         span#spanNotBack "回答错误，回看 X 分钟"（会倒回去重看）
 *
 *   行为实测：选对 → 弹窗立刻消失、视频自动续播（无需点「继续」）；
 *   选错 → 会提示回答错误并回看一段。所以答错不必惊慌，继续播即可。
 *
 * 安全阀（与整体决策一致）：
 *   · 只在高可靠（high）时才自动点选提交；medium/low 一律**不猜**，
 *     留着弹窗、记入待人工、把任务标成需要人处理。
 *   · 提交前强制留档（截图 + AI原始回答 + 解析结果）。
 *   · 复用AI节流器，避免风控。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, loadSettings } from '../config.mjs';
import { log } from '../logbus.mjs';
import { askImage } from '../ai/ai.mjs';
import { parseAnswer, validateBeforeSubmit, buildArchive, confidenceLabel } from '../ai/parse.mjs';
import { waitTurn, markAsked, reportSuccess, reportFailure } from '../ai/throttle.mjs';
import { throwIfStopped } from '../control.mjs';
import { shootQuestion } from './quiz.mjs';

/** 弹窗根选择器（视频 iframe 内） */
export const QUIZ_SELECTOR = '.ans-videoquiz';

/**
 * 弹窗可见性探测（注入函数）。
 *
 * ⚠ 踩坑：**不能按根元素的高度判可见**！
 * `.ans-videoquiz` 根元素可能仅占一行高度
 * （内容是绝对定位的滚动容器，溢出来显示），于是 `height > 40` 的判据
 * 把真实存在的弹窗题判成"不存在" —— 监听器全程没反应，播放侧反而
 * 把这道题当"莫名暂停"给纠偏跳过去了。
 *
 * 所以判据改成：根元素在显示 **且** 能看到选项或提交按钮。
 */
const PROBE_FN = (sel) => {
  const root = document.querySelector(sel);
  if (!root) return { exists: false, visible: false };
  const cs = getComputedStyle(root);
  if (cs.display === 'none' || cs.visibility === 'hidden') {
    return { exists: true, visible: false, why: `display=${cs.display}` };
  }
  const box = root.getBoundingClientRect();
  const opts = Array.from(root.querySelectorAll('li.ans-videoquiz-opt'));
  const visibleOpts = opts.filter((el) => el.getBoundingClientRect().width > 50).length;
  const btn = root.querySelector('#videoquiz-submit, #videoquiz-continue');
  const btnVisible = btn ? btn.getBoundingClientRect().width > 0 && getComputedStyle(btn).display !== 'none' : false;
  const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
  return {
    exists: true,
    visible: visibleOpts > 0 || btnVisible,
    why: `opts=${visibleOpts}/${opts.length} btn=${btnVisible}`,
    box: { w: Math.round(box.width), h: Math.round(box.height) },
    optionCount: opts.length,
    text: text.slice(0, 200),
  };
};

/** 探测当前页面的弹窗题状态（含"存在但不可见"的诊断信息） */
export async function probeVideoQuiz(page) {
  for (const f of page.frames()) {
    const u = f.url();
    if (!u || u === 'about:blank') continue;
    const r = await f.evaluate(PROBE_FN, QUIZ_SELECTOR).catch(() => null);
    if (r && (r.visible || (r.exists && r.visible !== false))) {
      if (r.visible) return { frame: f, via: /modules\/video/.test(u) ? 'video-frame' : 'other-frame', probe: r };
      // 存在但不可见：仅用于日志诊断
      if (process.env.XXT_QUIZ_DEBUG) log(`      [quiz-probe] 存在但不可见 (${r.why}) ${u.slice(0, 60)}`, 'debug');
    }
  }
  return null;
}

/**
 * 找出当前可见的弹窗题。
 * @returns {Promise<{frame:import('playwright-core').Frame, via:string}|null>}
 */
export async function findVideoQuiz(page) {
  const hit = await probeVideoQuiz(page);
  return hit ? { frame: hit.frame, via: hit.via, probe: hit.probe } : null;
}

/** 题型归一化 */
function normQtype(raw) {
  const s = String(raw || '');
  if (/多选/.test(s)) return 'multiple';
  if (/单选/.test(s)) return 'single';
  if (/判断/.test(s)) return 'judge';
  if (/填空/.test(s)) return 'fill';
  if (/简答|论述|分析/.test(s)) return 'essay';
  return 'unknown';
}

/**
 * 提取弹窗题结构。
 *
 * ⚠ 坑：evaluate 的回调是**在浏览器里**执行的，不能引用本模块的函数
 * （早期在这里调用了 normQtype()，浏览器里没有这个符号 → 抛错被 catch 吞掉
 * → 永远返回 null → 监听器空转、弹窗题一直没人答）。所以题型归一化放到 Node 侧做。
 *
 * @returns {Promise<object|null>} 与 quiz.mjs 的 question 同构，便于复用 parseAnswer
 */
export async function extractVideoQuiz(frame) {
  const raw = await frame
    .evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

      const qtypeRaw = t(root.querySelector('.tkTopic_title'));
      const stem = t(root.querySelector('.tkItem_title'));

      const options = Array.from(root.querySelectorAll('li.ans-videoquiz-opt')).map((li, i) => {
        const input = li.querySelector('input');
        const txt = t(li);
        // "A、选项一" / "B. 示例学习内容" / "对" / "错"
        const m = txt.match(/^\s*([A-Za-z])\s*[、.．)）:：]\s*/);
        let letter = m ? m[1].toUpperCase() : null;
        const text = m ? txt.slice(m[0].length).trim() : txt;

        // 判断题可能没有字母前缀 → 用 true/false 作选项标识（与作业页一致）
        if (!letter && /对|正确|√|✓/.test(txt) && !/不对|不正确|错误|否/.test(txt)) letter = 'true';
        else if (!letter && /错|不正确|否|×|✗/.test(txt)) letter = 'false';

        return {
          domIndex: i,
          letter,
          text,
          raw: txt,
          kind: input ? input.type : null,
          name: input ? input.name : null,
          checked: input ? !!input.checked : null,
        };
      });

      const contEl = root.querySelector('#videoquiz-continue');

      return {
        rootId: root.id,
        qtypeRaw,
        stemTextRaw: stem,
        optionCount: options.length,
        options,
        continueVisible: contEl
          ? getComputedStyle(contEl).display !== 'none' && contEl.getBoundingClientRect().width > 0
          : false,
      };
    }, QUIZ_SELECTOR)
    .catch(() => null);

  if (!raw) return null;
  return { ...raw, qtype: normQtype(raw.qtypeRaw), domIndex: 0, index: 1 };
}

/** 弹窗题去重键：题目一样就不重复处理 */
export function quizKey(q) {
  return `${q.qtypeRaw}|${q.stemTextRaw}|${q.options.map((o) => o.raw).join('/')}`;
}

/**
 * 截取弹窗区域（题目 + 选项 + 按钮，一次成像）。
 *
 * ⚠ 不能直接截 `.ans-videoquiz` 根元素！实测它只有 **40px 高**（内容绝对定位溢出），
 * 截出来就是一条黑边 —— AI收到这种图会直接不回答（实测 4 分钟 0 字）。
 * 所以要往上找一个"装得下整道题"的祖先容器（≥150px 高）再截。
 */
export async function shootVideoQuiz(frame, outDir, {shouldStop,nativeCapture} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  let file;

  const target = await frame
    .evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      let el = root;
      let best = root;
      for (let i = 0; i < 6 && el; i += 1) {
        const b = el.getBoundingClientRect();
        if (b.height > 150 && b.width > 300) {
          best = el;
          break;
        }
        el = el.parentElement;
      }
      for (const e of Array.from(document.querySelectorAll('[data-xxt-shot]'))) e.removeAttribute('data-xxt-shot');
      best.setAttribute('data-xxt-shot', '1');
      const b = best.getBoundingClientRect();
      return { tag: best.tagName, cls: String(best.className || '').slice(0, 80), w: Math.round(b.width), h: Math.round(b.height) };
    }, QUIZ_SELECTOR)
    .catch(() => null);

  try {
    file = await shootQuestion(frame, 0, outDir, {selector:'[data-xxt-shot="1"]',shouldStop,...(nativeCapture ? {nativeCapture} : {})});
  } finally {
    await frame
      .evaluate(() => {
        for (const e of Array.from(document.querySelectorAll('[data-xxt-shot]'))) e.removeAttribute('data-xxt-shot');
      })
      .catch(() => {});
  }
  if (target) log(`        弹窗截图目标：${target.tag}.${target.cls} ${target.w}×${target.h}`, 'debug');
  return file;
}

/** 原生点击某个选项（JS .click() 学习通会忽略，必须原生） */
export async function selectVideoQuizOption(frame, domIndex) {
  try {
    await frame.locator('li.ans-videoquiz-opt').nth(domIndex).click({ timeout: 8000 });
    const back = await frame.evaluate(
      (i) => {
        const li = document.querySelectorAll('li.ans-videoquiz-opt')[i];
        return li ? { checked: !!li.querySelector('input')?.checked } : null;
      },
      domIndex,
    );
    return { ok: !!back?.checked, checked: back?.checked ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 读取当前勾选情况 */
export async function readVideoQuizSelection(frame) {
  return frame
    .evaluate(() =>
      Array.from(document.querySelectorAll('li.ans-videoquiz-opt')).map((li, i) => ({
        i,
        checked: !!li.querySelector('input')?.checked,
        raw: (li.textContent || '').trim(),
      })),
    )
    .catch(() => []);
}

/**
 * 点提交，并等站点给结果。
 *
 * 结果判据（实测）：
 *   · 弹窗消失 + 视频续播         → 成功（答对时页面直接收摊）
 *   · #spanNot / #spanNotBack 可见 → 答错（可能回看）
 * 因此这里以「弹窗消失」为主判据，`#spanHas` 只是加分项。
 */
export async function submitVideoQuiz(frame, { timeoutMs = 20000, shouldStop } = {}) {
  throwIfStopped(shouldStop);
  try {
    await frame.locator('#videoquiz-submit').click({ timeout: 8000 });
  } catch (e) {
    return { ok: false, error: `提交按钮点击失败: ${e.message}` };
  }

  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    throwIfStopped(shouldStop);
    await new Promise((r) => setTimeout(r, 500));
    last = await frame
      .evaluate((sel) => {
        const vis = (q) => {
          const el = document.querySelector(q);
          return el ? getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 : false;
        };
        const txt = (q) => (document.querySelector(q)?.textContent || '').trim();
        return {
          quizVisible: vis(sel),
          correct: vis('#spanHas'),
          wrong: vis('#spanNot') || vis('#spanNotBack'),
          wrongText: txt('#spanNot') || txt('#spanNotBack'),
          continueVisible: vis('#videoquiz-continue'),
        };
      }, QUIZ_SELECTOR)
      .catch(() => null);

    if (!last) continue;
    if (last.wrong) return { ok: false, wrong: true, verdict: 'wrong', detail: last, elapsedMs: Date.now() - t0 };
    if (!last.quizVisible) return { ok: true, verdict: last.correct ? 'correct' : 'closed', detail: last, elapsedMs: Date.now() - t0 };
  }
  return { ok: false, timeout: true, error: '提交后弹窗一直没消失', detail: last };
}

/** 点「继续」恢复播放（多数情况下站点会自己恢复，这个是兜底） */
export async function continueVideoQuiz(frame) {
  return frame
    .evaluate((sel) => {
      const btn = document.querySelector('#videoquiz-continue');
      if (btn && getComputedStyle(btn).display !== 'none' && btn.getBoundingClientRect().width > 0) {
        btn.click();
        return { clicked: true };
      }
      return { clicked: false };
    }, QUIZ_SELECTOR)
    .catch(() => ({ clicked: false }));
}

/** 答案留档 */
function archiveAnswer(record) {
  try {
    const dir = path.join(PATHS.answers, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `videoquiz-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 处理一次弹窗题：截图 → 问AI → 解析 → （高可靠才）点选 → 提交 → 留档。
 *
 * @returns {Promise<object>} {ok, answered, needsHuman?, error?, ...}
 */
export async function handleVideoQuiz({ page, frame, qianwenPage, task, onEvent, shouldStop, nativeCapture }) {
  throwIfStopped(shouldStop);
  const settings = loadSettings();
  const outDir = path.join(PATHS.answers, new Date().toISOString().slice(0, 10));

  const q = await extractVideoQuiz(frame);
  if (!q) return { ok: true, skipped: true, reason: 'no-quiz' };

  log(`    📝 视频弹窗题（${q.qtypeRaw}）：${q.stemTextRaw.slice(0, 60)}`, 'info');
  for (const o of q.options) log(`         ${o.letter || '?'} ${o.text}`, 'debug');

  const imagePath = await shootVideoQuiz(frame, outDir, {shouldStop,nativeCapture}).catch((e) => {
    if(e.code==='STOPPED')throw e;
    log(`    ! 弹窗截图失败: ${e.message}`, 'warn');
    return null;
  });

  if (!qianwenPage) {
    return { ok: false, needsHuman: true, aiErrorCode:'not-logged-in', error: '没有可用的AI页面，无法自动作答', question: q, imagePath };
  }

  await waitTurn({ shouldStop });
  const ai = await askImage({
    page: qianwenPage,
    imagePath,
    prompt: settings.quizPrompt,
    freshChat: settings.ai?.freshChatPerQuestion ?? false,
    shouldStop,
  });
  markAsked();
  if (ai.ok) reportSuccess();
  else reportFailure({ errorCode: ai.errorCode, error: ai.error });

  const parsed = parseAnswer(ai.ok ? ai.answer : '', q);
  const validation = validateBeforeSubmit(parsed, q);
  log(
    `        AI → ${parsed.letters.join('') || '(无)'} ${confidenceLabel(parsed.confidence)} ${parsed.reason}` +
      (ai.ok ? `；已收到 ${String(ai.answer || '').trim().length} 字回答` : `；未收到回答（${ai.errorCode || 'unknown'}：${ai.error || '无错误详情'}）`),
    parsed.confidence === 'high' ? 'ok' : 'warn',
  );

  const base = {
    kind: 'video-quiz',
    taskKey: task?.key || null,
    taskName: task?.name || null,
    secNo: task?.secNo || null,
    question: q,
    imagePath,
    aiAnswer: ai.answer || '',
    aiError: ai.error || null,
    parsed: { confidence: parsed.confidence, letters: parsed.letters, judge: parsed.judge, reason: parsed.reason },
    validation,
  };

  if (['verification-required','rate-limited','not-logged-in','draft-not-empty','draft-attachment','already-generating','wrong-ai-page'].includes(ai.errorCode)) {
    archiveAnswer({ ...base, action: 'halt', note: 'AI触发风控验证' });
    return { ok: false, needsHuman: true, aiErrorCode:ai.errorCode, error: ai.error, question: q, imagePath };
  }

  /*
   * 安全阀：只有高可靠 + 防呆校验通过才动手。
   * 其余情况**绝不猜**：留着弹窗叫人（视频会一直停着，任务转「待人工」）。
   */
  if (parsed.confidence !== 'high' || !validation.safe) {
    const why = validation.errors.join('；') || '可靠性不足';
    archiveAnswer({ ...base, action: 'needs-human', note: why });
    return {
      ok: false,
      needsHuman: true,
      error: `弹窗题答案不可靠（${why}）—— 已留档，请手动作答`,
      question: q,
      imagePath,
    };
  }

  // 点选（按解析出的选项字母 → domIndex）
  const picked = [];
  for (const letter of parsed.letters) {
    throwIfStopped(shouldStop);
    const opt = q.options.find(
      (o) => String(o.letter).toUpperCase() === String(letter).toUpperCase() || o.letter === letter,
    );
    if (!opt) continue;
    const r = await selectVideoQuizOption(frame, opt.domIndex);
    picked.push({ letter: opt.letter, domIndex: opt.domIndex, ok: r.ok, checked: r.checked });
    if (!r.ok) log(`        ! 选项 ${opt.letter} 点选失败`, 'warn');
  }
  const readBack = await readVideoQuizSelection(frame);

  const expected = parsed.letters.map(letter => q.options.find(option => String(option.letter).toUpperCase() === String(letter).toUpperCase())?.domIndex).sort((a,b) => a-b);
  const actual = readBack.filter(option => option.checked).map(option => option.i).sort((a,b) => a-b);
  if (!picked.length || picked.some((p) => !p.ok) || JSON.stringify(expected) !== JSON.stringify(actual)) {
    archiveAnswer({ ...base, action: 'select-failed', picked, readBack });
    return { ok: false, needsHuman: true, error: '选项回读与预期不一致，已停止提交，请手动核对', question: q, imagePath };
  }

  // 提交
  const sub = await submitVideoQuiz(frame, { timeoutMs: settings.quizSubmitTimeoutMs ?? 20000, shouldStop });
  const archiveFile = archiveAnswer({
    ...base,
    action: sub.ok ? 'submitted' : 'submit-failed',
    picked,
    readBack,
    submit: sub,
  });

  if (sub.ok) {
    log(`        ✓ 已提交（${sub.verdict === 'correct' ? '回答正确' : '弹窗已关闭'}，留档 ${path.basename(archiveFile || '')}）`, 'ok');
  } else if (sub.wrong) {
    log(`        ! 提交后提示「${sub.detail?.wrongText || '回答错误'}」—— 站点可能要求回看，按它来`, 'warn');
  } else {
    log(`        ! 提交异常：${sub.error || '未知'}`, 'warn');
  }

  // 兜底点「继续」
  await new Promise((r) => setTimeout(r, 500));
  throwIfStopped(shouldStop);
  const cont = await continueVideoQuiz(frame);
  if (cont.clicked) log('        已点「继续」恢复播放', 'debug');

  const out = {
    ok: sub.ok,
    answered: picked.length,
    letters: parsed.letters,
    confidence: parsed.confidence,
    verdict: sub.verdict || null,
    wrong: !!sub.wrong,
    question: q,
    imagePath,
    archiveFile,
  };
  if (onEvent) onEvent(out);
  return out;
}

/**
 * 边播边盯视频弹窗题。
 *
 * 与 watchUntilDone 的配合：弹窗出现时站点会自己暂停视频，
 * 我们把 shared.quizOpen 置 true，让播放监控**不要**去"纠偏"强推播放
 * （强推会和弹窗互相打架），答完/提交后再放开。
 *
 * @param {object} opts
 * @param {object} opts.shared 共享状态对象（含 quizOpen）
 */
export async function watchVideoQuiz({ page, qianwenPage, shared = {}, shouldStop, onEvent, intervalMs = 2000, task, nativeCapture }) {
  const handled = [];
  let rounds = 0;
  let lastHandled = null;
  let consecFail = 0;
  let unreadableSince = null;

  for (;;) {
    if (shouldStop && shouldStop()) break;
    await page.waitForTimeout(intervalMs);
    if (shouldStop?.()) break;
    rounds += 1;

    const hit = await findVideoQuiz(page);
    if (!hit) {
      // 弹窗消失 → 放开播放监控
      if (shared.quizOpen) shared.quizOpen = false;
      unreadableSince = null;
      continue;
    }
    shared.quizOpen = true;

    const q = await extractVideoQuiz(hit.frame).catch((e) => {
      log(`      [quiz] 提取弹窗题失败: ${e.message}`, 'warn');
      return null;
    });
    if (!q || !q.options?.length) {
      unreadableSince ??= Date.now();
      if (Date.now() - unreadableSince >= 8000) {
        const result = { ok: false, needsHuman: true, error: '视频弹窗题结构无法识别，已保留页面，请人工处理' };
        shared.needsHuman = true;
        if (onEvent) onEvent(result);
        break;
      }
      continue;
    }
    unreadableSince = null;
    const key = quizKey(q);

    // 同一个弹窗：已成功处理过就别再动（防抖/防循环）
    if (lastHandled && lastHandled.key === key) {
      if (lastHandled.ok) continue;
      if (Date.now() - lastHandled.at < 15000) continue;
    }

    /*
     * 弹窗出现 → 冻结播放侧的重试逻辑。
     * 注意：宁可让视频停着等人答题，也不要"强推播放把题跳过去" ——
     * 那等于替用户放弃这道题。
     */
    if (!shared.quizOpen) {
      shared.quizOpen = true;
      log('    ⏸ 检测到视频弹窗题，播放监控暂停纠偏，等待作答', 'info');
    }

    log(`    发现视频弹窗题 → 处理中…（第 ${handled.length + 1} 次）`, 'info');
    const r = await handleVideoQuiz({ page, frame: hit.frame, qianwenPage, task, shouldStop, nativeCapture }).catch((e) => {
      if (e.code === 'STOPPED') throw e;
      return {
      ok: false,
      needsHuman: true,
      error: e.message,
    }; });
    if (onEvent) onEvent(r);
    handled.push({ key, at: Date.now(), ok: !!r.ok, error: r.error || null });
    lastHandled = { key, at: Date.now(), ok: !!r.ok };

    if (r.needsHuman) {
      // 交给人：冻结不再纠偏，并通知播放监控立刻收手（任务记「待人工」）
      shared.quizOpen = true;
      shared.needsHuman = true;
      consecFail += 1;
      log(`    ⛔ 弹窗题需要人工：${r.error}`, 'error');
      log('       已停下等你处理（任务将记为「待人工」；弹窗会留在屏幕上）', 'warn');
      break;
    }
    if (!r.ok) {
      consecFail += 1;
      if (consecFail >= 3) {
        log('    ⛔ 弹窗题连续处理失败 3 次，停止自动作答', 'error');
        shared.needsHuman = true;
        if (onEvent) onEvent({ok:false,needsHuman:true,error:'视频弹窗题连续处理失败，已保留页面，请人工处理'});
        break;
      }
    } else {
      consecFail = 0;
    }

    // 处理完等一下，确认弹窗真的消失了
    await page.waitForTimeout(1500);
    const still = await findVideoQuiz(page);
    if (!still) shared.quizOpen = false;
  }

  shared.quizOpen = false;
  return { handled };
}
