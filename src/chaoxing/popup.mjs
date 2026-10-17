/**
 * 视频内「弹窗题」处理（P6）。
 *
 * 已探明的机制（从 cards 页 HTML 里挖出来的）：
 *
 *   <div class="customMaskDiv" style="display:none">      ← 弹窗遮罩（默认隐藏）
 *     <iframe id="popFrameId" style="640x480">            ← 弹窗内容加载在这里
 *   <div class="customMaskDiv2" style="display:none">
 *     <iframe id="hidePopFrameId">
 *   <div class="voteContainer"><iframe id="voteIframe">
 *
 *   function showCustomPop(url) { popFrameId.src = url; $(".customMaskDiv").show(); }
 *   function hideCustomPop()    { $(".customMaskDiv").hide(); popPlayState = true; }
 *
 * 也就是说：视频播到设定时间点 → 学习通调用 showCustomPop(url) 载入题目页
 * → 遮罩显示、播放暂停 → 答完后页面自己调用 hideCustomPop() → 播放恢复。
 *
 * 设计要点：
 *   - 弹窗可能在**播放过程中的任意时刻**出现，必须边播边盯（轮询）
 *   - 弹窗内容是标准题目页，可复用 quiz.mjs 的提取/点选逻辑
 *   - 兜底优先：识别不了就**暂停并告警叫人**，绝不瞎猜
 *   - 复用千问节流器，避免风控
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, loadSettings } from '../config.mjs';
import { log } from '../logbus.mjs';
import { askImage, detectVerification } from '../ai/ai.mjs';
import { parseAnswer, confidenceLabel } from '../ai/parse.mjs';
import { waitTurn, markAsked, reportSuccess, reportFailure } from '../ai/throttle.mjs';
import { extractQuestions, shootQuestion, selectOptions, readSelection } from './quiz.mjs';
import { submitWork } from './quizrun.mjs';

/** 弹窗相关的选择器（实测） */
const POPUP_SELECTORS = {
  mask: '.customMaskDiv',
  mask2: '.customMaskDiv2',
  frame: '#popFrameId',
  frame2: '#hidePopFrameId',
  vote: '#voteIframe',
};

/**
 * 检查当前是否有弹窗题出现。
 * @param {import('playwright-core').Page} page cards 页
 * @returns {Promise<{visible:boolean, kind?:string, frameUrl?:string}>}
 */
export async function detectPopup(page) {
  return page
    .evaluate((sel) => {
      const isVisible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 50 && r.height > 50;
      };

      const mask = document.querySelector(sel.mask);
      const mask2 = document.querySelector(sel.mask2);
      const f1 = document.querySelector(sel.frame);
      const f2 = document.querySelector(sel.frame2);
      const vote = document.querySelector(sel.vote);

      if (isVisible(mask)) {
        return { visible: true, kind: 'popup', frameUrl: (f1?.getAttribute('src') || '').slice(0, 150) };
      }
      if (isVisible(mask2)) {
        return { visible: true, kind: 'popup2', frameUrl: (f2?.getAttribute('src') || '').slice(0, 150) };
      }
      if (isVisible(vote)) {
        return { visible: true, kind: 'vote', frameUrl: (vote?.getAttribute('src') || '').slice(0, 150) };
      }
      return { visible: false };
    }, POPUP_SELECTORS)
    .catch(() => ({ visible: false }));
}

/**
 * 找弹窗对应的 frame（Playwright frame 对象）。
 *
 * 优先按 iframe 的 **id** 匹配（最可靠 —— 弹窗内容可能是 srcdoc 或第三方域名，
 * 光看 URL 会漏）。URL 特征作为兜底。
 */
export async function findPopupFrame(page) {
  // 1) 按 id 匹配 #popFrameId / #hidePopFrameId / #voteIframe
  for (const f of page.frames()) {
    const hit = await f
      .evaluate(() => {
        try {
          const el = window.frameElement;
          return el ? el.id || '' : '';
        } catch {
          return '';
        }
      })
      .catch(() => '');
    if (hit && ['popFrameId', 'hidePopFrameId', 'voteIframe'].includes(hit)) return f;
  }

  // 2) 按 URL 特征兜底
  return (
    page
      .frames()
      .find((f) => /mooc-ans\/work|doHomeWorkNew|selectWorkQuestion|api\/work|\/vote|exam-ans/i.test(f.url())) || null
  );
}

/** 截取弹窗区域（连同题目一起） */
export async function shootPopup(page, outDir, tag = 'popup') {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${tag}-${Date.now()}.png`);
  const el = await page.$(POPUP_SELECTORS.mask);
  if (el) {
    await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file });
  }
  return file;
}

/**
 * 尽力关闭弹窗。
 *
 * 优先点弹窗自带的关闭按钮；没有就调用页面自己的 hideCustomPop()
 * （学习通就是这么关的，等价于"答完自动恢复播放"）；
 * 再不行就直接隐藏遮罩，至少让视频能继续。
 */
export async function closePopup(page) {
  return page
    .evaluate((sel) => {
      const mask = document.querySelector(sel.mask);
      if (!mask) return { closed: false, reason: 'no-mask' };

      // 1) 弹窗内的关闭按钮
      const btn =
        mask.querySelector('.popClose, [class*="popClose"], [class*="close"], [class*="Close"]') ||
        Array.from(mask.querySelectorAll('a, button')).find((x) =>
          /^(关闭|确定|知道了|完成|×)$/.test((x.textContent || '').trim()),
        );
      if (btn) {
        btn.click();
        return { closed: true, how: 'close-button' };
      }

      // 2) 调用页面自己的关闭函数（学习通的标准做法）
      try {
        if (typeof window.hideCustomPop === 'function') {
          window.hideCustomPop();
          return { closed: true, how: 'hideCustomPop()' };
        }
      } catch (e) {
        /* 继续走兜底 */
      }

      // 3) 直接隐藏遮罩（jQuery 站点，用 style 直接改最稳）
      mask.style.display = 'none';
      const mask2 = document.querySelector(sel.mask2);
      if (mask2) mask2.style.display = 'none';
      return { closed: true, how: 'force-hide' };
    }, POPUP_SELECTORS)
    .catch((e) => ({ closed: false, reason: e.message }));
}

/**
 * 处理一次弹窗题。
 *
 * @returns {Promise<object>} 结果摘要（含 ok / answered / needsHuman / error）
 */
export async function handlePopupOnce({ page, qianwenPage, onProgress }) {
  const settings = loadSettings();
  const outDir = path.join(PATHS.answers, new Date().toISOString().slice(0, 10));

  const info = await detectPopup(page);
  if (!info.visible) return { ok: true, skipped: true, reason: 'no-popup' };

  log(`    检测到弹窗题（${info.kind}）：${info.frameUrl || '(无 url)'}`, 'info');

  const frame = await findPopupFrame(page);
  if (!frame) {
    return { ok: false, needsHuman: true, error: '弹窗出现但找不到题目 frame —— 请手动作答' };
  }

  // 等题目渲染
  let questions = [];
  for (let i = 0; i < 20; i += 1) {
    questions = await extractQuestions(frame).catch(() => []);
    if (questions.length) break;
    await page.waitForTimeout(600);
  }
  if (!questions.length) {
    return { ok: false, needsHuman: true, error: '弹窗里没读到题目 —— 请手动作答' };
  }
  log(`    弹窗内 ${questions.length} 题：${questions.map((q) => q.qtype).join(', ')}`, 'info');

  const results = [];
  for (const q of questions) {
    if (onProgress) onProgress({ phase: 'popup-asking', questionIndex: q.index });

    const imagePath = await shootQuestion(frame, q.domIndex, outDir);
    await waitTurn();

    const ai = await askImage({
      question: q,
      page: qianwenPage,
      imagePath,
      prompt: settings.quizPrompt,
      freshChat: settings.ai?.freshChatPerQuestion ?? false,
    });
    markAsked();
    if (ai.ok) reportSuccess();
    else reportFailure({ errorCode: ai.errorCode, error: ai.error });

    if (ai.errorCode === 'verification-required') {
      return { ok: false, needsHuman: true, error: ai.error, results };
    }

    const parsed = parseAnswer(ai.ok ? ai.answer : '', q);
    const tag = confidenceLabel(parsed.confidence);
    log(`      Q${q.index}: 千问 → ${parsed.letters.join('') || '(无)'} ${tag} ${parsed.reason}`, parsed.confidence === 'high' ? 'ok' : 'warn');

    let filled = null;
    if (parsed.confidence === 'high' && parsed.letters.length) {
      const r = await selectOptions(frame, q.domIndex, parsed.letters);
      await page.waitForTimeout(400);
      const back = await readSelection(frame, q.domIndex);
      filled = { requested: parsed.letters, result: r, readBack: back?.selected || [] };
      if (!r.ok) {
        log(`      ! 点选未成功（请求 ${parsed.letters.join('')}，回读 ${(back?.selected || []).join('')}）`, 'warn');
      } else {
        log(`      ✓ 已选 ${(back?.selected || []).join('')}`, 'ok');
      }
    } else {
      // 可靠度不够 → 不猜，叫人
      return {
        ok: false,
        needsHuman: true,
        error: `弹窗题 Q${q.index} 答案可靠性不足（${parsed.reason}）—— 请手动作答`,
        results,
      };
    }

    results.push({
      questionIndex: q.index,
      qtype: q.qtype,
      qtypeRaw: q.qtypeRaw,
      letters: parsed.letters,
      confidence: parsed.confidence,
      imagePath,
      aiAnswer: ai.answer || '',
      aiError: ai.error || null,
      filled,
    });
  }

  // 提交弹窗内的作答（弹窗题通常自带"提交/确定"按钮）
  const submitted = await submitWork(frame).catch((e) => ({ ok: false, error: e.message }));
  log(`    弹窗提交：${submitted.ok ? '✓' : '✗ ' + submitted.error}`, submitted.ok ? 'ok' : 'warn');

  // 兜底关掉遮罩，让视频继续
  const closed = await closePopup(page);
  if (!closed.closed) log(`    ! 弹窗未能自动关闭（${closed.reason}）—— 视频可能仍暂停`, 'warn');

  return {
    ok: submitted.ok,
    kind: info.kind,
    answered: results.length,
    submitted,
    closed,
    results,
  };
}

/**
 * 边播边盯：在视频播放期间轮询弹窗，出现就处理。
 *
 * 与 watchUntilDone 并存的方式：由视频执行器在监控循环里调用本函数，
 * 或（当前实现）在视频页全程跑一个独立的监听协程。
 *
 * @param {object} opts
 * @param {import('playwright-core').Page} opts.page
 * @param {import('playwright-core').Page} opts.qianwenPage
 * @param {Function} opts.shouldStop 返回 true 则退出
 * @param {Function} opts.onPopup 处理结果回调
 * @param {number} opts.intervalMs 轮询间隔
 */
export async function watchPopups({ page, qianwenPage, shouldStop, onPopup, intervalMs = 3000 }) {
  const handled = [];
  let rounds = 0;
  for (;;) {
    if (shouldStop && shouldStop()) break;
    await page.waitForTimeout(intervalMs);
    rounds += 1;

    const info = await detectPopup(page);
    if (!info.visible) continue;

    // 同一个弹窗不要重复处理：用 frameUrl 做去重键
    const key = `${info.kind}:${info.frameUrl || rounds}`;
    if (handled.some((h) => h.key === key)) continue;
    handled.push({ key, at: Date.now() });

    log(`    发现弹窗题 → 处理中…`, 'info');
    const r = await handlePopupOnce({ page, qianwenPage }).catch((e) => ({ ok: false, error: e.message }));
    if (onPopup) onPopup(r);

    if (r.needsHuman) {
      log(`    ⛔ 弹窗题需要人工：${r.error}`, 'error');
      break; // 停下来叫人，别继续瞎跑
    }
  }
  return { handled };
}
