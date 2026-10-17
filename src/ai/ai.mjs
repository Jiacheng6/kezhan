/**
 * 千问（qianwen.com）答题通道。
 *
 * 踩过的坑与最终方案（2026-09 实测）：
 *
 *   ❌ 走「添加附件 → 上传图片 → filechooser」：
 *      上传后千问会盖一层 z-[9999] 全屏浮层，拦截所有指针事件
 *      （Playwright 报 "subtree intercepts pointer events"）。
 *      结果：输入框一直是空的（只有 placeholder）、发送按钮 disabled、
 *      强行 JS click 发出去的消息不带图，千问空转不回答。
 *
 *   ✅ 用粘贴注入：
 *      把 PNG 包成 File 塞进 ClipboardEvent('paste') 派发给编辑器。
 *      图片正常入队、无浮层、输入框与发送按钮都可用。实测回答正确。
 *
 * 另一个坑：输入框为空时 innerText 会回落到 placeholder（"向千问提问"），
 * 判空必须把 placeholder 排除，否则会误判"已填写"。
 *
 * 已探明的选择器：
 *   编辑器      [contenteditable="true"]（data-placeholder 属性存在）
 *   发送        button[aria-label="发送消息"]
 *   附件按钮    button[aria-label="添加附件"]（需真实点击）
 *   回答容器    .chat-answers-card-wrap
 *   图片就绪    img[src^="https://workspace-zb-cdn.qianwen.com"] 且 naturalWidth > 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../config.mjs';
import { throwIfStopped, interruptibleSleep, waitForRead } from '../control.mjs';
import { log } from '../logbus.mjs';
import { providerForUrl } from './providers.mjs';
import { askWebImage, webChatState } from './web-chat.mjs';
import { questionPrompt } from './question-prompt.mjs';

const READY_IMG_HOST = 'workspace-zb-cdn.qianwen.com';

/** 编辑器选择器 */
const EDITOR = '[contenteditable="true"]';
const SEND_BTN = 'button[aria-label="发送消息"]';

/**
 * 检查千问聊天界面是否就绪。没有登录按钮不代表已登录，
 * 空白、加载或错误页面也没有按钮，必须同时找到可见编辑器和发送控件。
 */
export async function checkLogin(page) {
  if(!page)return {loggedIn:false};
  const provider=providerForUrl(page.url?.());
  if(typeof page.url==='function'&&!provider)return {loggedIn:false,error:'非官方 AI 网页'};
  if(provider&&provider.id!=='qianwen')return webChatState(page,provider);
  return page.evaluate(() => {
    const visible = (e) => !!e?.checkVisibility();
    const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((x) =>
      /^(登录|立即登录|登录注册|登录\/注册|登录或注册)$/.test((x.textContent || x.getAttribute('aria-label') || '').trim()) && visible(x),
    );
    const editor = Array.from(document.querySelectorAll('[contenteditable="true"]')).find(visible);
    // 空输入框的发送按钮可以 disabled，不影响界面就绪判断。
    const send = Array.from(document.querySelectorAll('button[aria-label="发送消息"]')).find(visible);
    const loading = document.readyState === 'loading';
    const signedOut = !!btn || /(?:^|\/)(?:login|sign[-_]?in)(?:\/|$)/i.test(location.pathname);
    return { loggedIn: !loading && !signedOut && !!editor && !!send, hasLoginButton: !!btn, editor: !!editor, chatReady: !!editor && !!send };
  });
}

/** 读编辑器真实内容（排除 placeholder 回落） */
export async function readEditor(page) {
  return page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return { text: '', empty: true };
    const t = (e.innerText || '').trim();
    const ph = (e.getAttribute('data-placeholder') || '').trim();
    const isPh = !!ph && t === ph;
    return { text: isPh ? '' : t, raw: t, placeholder: ph, empty: !t || isPh };
  }, EDITOR);
}

/** 关掉可能挡路的对话框（Escape + 找关闭按钮） */
export async function dismissDialogs(page, rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    const n = await page.evaluate(() => {
      let closed = 0;
      document.querySelectorAll('[role="dialog"][data-state="open"]').forEach((d) => {
        const btn =
          d.querySelector('[aria-label="关闭"]') ||
          d.querySelector('button[class*="close"]') ||
          Array.from(d.querySelectorAll('button')).find((x) => /^(关闭|跳过|知道了)$/.test((x.textContent || '').trim()));
        if (btn) {
          btn.click();
          closed += 1;
        }
      });
      return closed;
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    if (!n) break;
  }
}

/**
 * 新建对话，避免污染历史会话。
 */
export async function newChat(page) {
  await page.bringToFront();
  const nc = page.locator('button, a, div').filter({ hasText: /^新对话$/ }).first();
  if (await nc.count()) {
    await nc.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
  } else {
    await page.goto('https://www.qianwen.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  await dismissDialogs(page, 2);
}

/**
 * 把本地图片以「粘贴」方式送进千问输入区。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function pasteImage(page, imagePath) {
  if (!fs.existsSync(imagePath)) return { ok: false, error: `图片不存在: ${imagePath}` };

  const b64 = fs.readFileSync(imagePath).toString('base64');
  const name = path.basename(imagePath);

  // 先聚焦编辑器（用 force，避免残留浮层导致超时）
  const ed = page.locator(EDITOR).first();
  await ed.click({ timeout: 10000, force: true }).catch(() => {});
  await page.waitForTimeout(300);

  const injected = await page.evaluate(
    async ({ b64, name, sel }) => {
      const e = document.querySelector(sel);
      if (!e) return { ok: false, error: '找不到编辑器' };
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      e.focus();
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      try {
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      } catch (err) {
        /* 某些环境 clipboardData 只读，忽略 */
      }
      e.dispatchEvent(ev);
      return { ok: true, size: file.size, files: dt.files.length };
    },
    { b64, name, sel: EDITOR },
  );

  if (!injected.ok) return injected;

  // 等缩略图真正加载完成（naturalWidth > 0）
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const ready = await page.evaluate((host) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.some((e) => (e.getAttribute('src') || '').includes(host) && e.naturalWidth > 0);
    }, READY_IMG_HOST);
    if (ready) return { ok: true, waitedMs: Date.now() - t0 };
    await page.waitForTimeout(500);
  }
  return { ok: false, error: '图片缩略图 30 秒内未就绪' };
}

/** 往编辑器写文本（清空后输入） */
export async function typePrompt(page, text) {
  const ed = page.locator(EDITOR).first();
  await ed.click({ timeout: 10000, force: true }).catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.type(text, { delay: 8 });
  await page.waitForTimeout(400);
  return readEditor(page);
}

/**
 * 点发送。发送前会校验编辑器非空、按钮可用。
 */
export async function send(page) {
  const st = await readEditor(page);
  if (st.empty) return { ok: false, error: '编辑器为空，拒绝发送' };

  const btn = page.locator(SEND_BTN).first();
  if (!(await btn.count())) return { ok: false, error: '找不到发送按钮' };
  if (await btn.isDisabled().catch(() => true)) return { ok: false, error: '发送按钮不可用' };

  await btn.click({ timeout: 15000, force: true });
  return { ok: true, sent: st.text.slice(0, 60) };
}

/**
 * 读取回答容器当前文本。
 *
 * ⚠ 踩坑（2026-09-23）：必须取**最后一条**回答卡片。
 * 早期用 `querySelector('.chat-answers-card-wrap')` 取的是**第一条**，
 * 复用同一个对话时读到的是**上一题的回答** —— 实测出现"拿 1+1=2 的答案
 * 去回答 示例物质 单选题"，解析自然失败，还被误判成"AI 答不出"。
 *
 * @returns {Promise<{text:string, len:number, generating:boolean, count:number}>}
 */
export async function readAnswer(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.chat-answers-card-wrap'));
    const wrap = cards.length ? cards[cards.length - 1] : null;
    const txt = wrap ? (wrap.innerText || '').trim() : '';
    const generating =
      Array.from(document.querySelectorAll('button')).some((x) =>
        /停止|stop/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')),
      ) || !!document.querySelector('[class*="loading"], [class*="generating"], [class*="typing"]');
    return { text: txt, len: txt.length, generating, count: cards.length };
  });
}

/**
 * 发送前的回答基线。
 * 有了它，waitAnswer 才能确认读到的是"这次的回答"而不是历史残留。
 */
export async function answerBaseline(page) {
  const r = await readAnswer(page).catch(() => null);
  return { count: r?.count ?? 0, lastText: r?.text ?? '' };
}

/**
 * 等回答结束。
 *
 * 「答完」判据（三重，取"或"关系但要排除仍在 receiving）：
 *   1) 回答容器里出现 .answer-receiving-card（千问的"接收中/生成中"卡片）→ 明确还没完
 *   2) 文本长度连续 N 轮不变
 *   3) 没有"停止生成"按钮
 *
 * 实测教训：千问对图片题的响应可能超过 2 分钟（第一题实测 2 分 11 秒），
 * 早期 120 秒超时会把"还在 loading"误判成"没回答"，白丢一次答题机会。
 * 所以超时放宽到 4 分钟，并且**只要还在 receiving 就不算结束**。
 */
/**
 * 「这一轮回答还要不要继续等」—— 纯函数，便于离线测试。
 *
 * 背景（用户实测反馈）：千问卡住时程序会**干等满 4 分钟**才失败，
 * 期间界面上什么都不发生；正确做法是"没进展就早点收手、重新提问"。
 *
 * 判据（按优先级）：
 *   1) 已有文本且稳定、且不在生成中 → 完成
 *   2) 长时间没有任何进展 → 收手（交给上层重问）
 *        · 正在生成中却一直不吐字  → stuck-frozen（千问卡在生成中）
 *        · 压根没反应（连"生成中"都没有）→ stuck-silent（发送没生效/被吞）
 *   3) 到总超时 → 按有没有文本/在不在生成中给出细分原因
 *
 * @param {object} o
 * @param {number} o.elapsedMs 本轮已等时长
 * @param {number} o.sinceProgressMs 距上次"有进展"（文本变长/开始生成）的时长
 * @param {boolean} o.generating 页面是否显示正在生成（receiving/loading/停止按钮）
 * @param {number} o.len 当前读到的文本长度
 * @param {number} o.stableRounds 连续稳定轮次
 * @param {number} o.needStableRounds 需要几轮稳定才算完
 * @param {number} o.stuckMs 多久没进展算卡住
 * @param {number} o.timeoutMs 总超时
 * @returns {{action:'done'|'give-up'|'wait', reason:string}}
 */
export function answerProgressVerdict({
  elapsedMs,
  sinceProgressMs,
  generating,
  len,
  stableRounds = 0,
  needStableRounds = 3,
  stuckMs = 60000,
  timeoutMs = 240000,
} = {}) {
  if (len > 0 && stableRounds >= needStableRounds && !generating) {
    return { action: 'done', reason: 'stable' };
  }
  if (sinceProgressMs >= stuckMs) {
    /*
     * 只有两种"卡住"：页面显示在生成（stuck-frozen）、或压根没反应（stuck-silent）。
     * 注意：**卡住时哪怕已经拿到半截文本也不要当答案用** —— 生成被打断的答案
     * 很可能是半句，拿去填题就是错答案。半截文本一律交给上层丢弃并重问。
     */
    return { action: 'give-up', reason: generating ? 'stuck-frozen' : 'stuck-silent' };
  }
  if (elapsedMs >= timeoutMs) {
    return {
      action: 'give-up',
      reason: len > 0 ? 'timeout-with-text' : generating ? 'timeout-still-receiving' : 'timeout-empty',
    };
  }
  return { action: 'wait', reason: '' };
}

/**
 * 这次失败要不要**重新提问**？—— 纯函数，便于离线测试。
 *
 * 只对"千问没给出东西"的失败重问；硬障碍（风控验证、未登录）不能靠重问解决，
 * 重问只会把账号往风控里推得更深。
 *
 * @param {object} o
 * @param {string} o.errorCode 上一次的失败码
 * @param {number} o.attempt 已经试过几次（从 1 开始）
 * @param {number} o.retries 允许额外重问几次
 * @returns {{reask:boolean, reason:string}}
 */
export function shouldReask({ errorCode, attempt, retries }) {
  const REASKABLE = new Set(['stuck-frozen', 'stuck-silent', 'empty-answer', 'stuck-receiving', 'timeout-empty', 'timeout-with-text', 'send-failed', 'paste-failed']);
  if (attempt > retries) return { reask: false, reason: `已重问 ${retries} 次仍无回答` };
  if (!REASKABLE.has(errorCode)) return { reask: false, reason: `${errorCode} 不是"没回答"，重问没用` };
  return { reask: true, reason: '' };
}

/**
 * 等千问出答案。
 *
 * ⚠ 关键行为：**没进展就早停**（默认 `stuckMs` 无进展即返回 stuck-*），
 * 不再"干等满总超时"。上层据此重新提问（见 askImage 的重问循环）。
 */
export async function waitAnswer(page, { timeoutMs = 240000, stuckMs = 60000, stableRounds = 3, onTick, baseline = null, shouldStop } = {}) {
  throwIfStopped(shouldStop);
  const t0 = Date.now();
  let lastLen = -1;
  let stable = 0;
  let best = '';
  let sawReceiving = false;
  let lastProgressAt = Date.now();

  for (;;) {
    await interruptibleSleep(2000, shouldStop);

    const st = await waitForRead(() => page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.chat-answers-card-wrap'));
      const wrap = cards.length ? cards[cards.length - 1] : null;
      const txt = wrap ? (wrap.innerText || '').trim() : '';
      const receiving = !!document.querySelector('.answer-receiving-card, [class*="receiving"]');
      const loading = !!document.querySelector('.chat-answers-card-wrap [class*="loading"]');
      const stopBtn = Array.from(document.querySelectorAll('button')).some((x) =>
        /停止|stop/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')),
      );
      return { txt, len: txt.length, receiving, loading, stopBtn, count: cards.length };
    }), { shouldStop, timeoutMs: 10000, message: '千问页面读取超时' });

    if (st.receiving || st.loading) sawReceiving = true;
    const generating = st.receiving || st.loading || st.stopBtn;

    /*
     * 只认"这次"的回答：
     *   卡片数变多 → 新回答；卡片文本变了 → 新回答；
     *   或者正在生成中等（说明这一轮确实在产出，哪怕文本碰巧一样）。
     */
    const isNew =
      !baseline ||
      st.count > (baseline.count || 0) ||
      (st.count > 0 && st.txt !== (baseline.lastText || '')) ||
      (st.count >= (baseline.count || 0) && generating);

    const txt = isNew ? st.txt : '';
    const len = txt.length;

    if (len > 0) best = txt;
    // onTick 可能是 async（内部要检测风控弹窗并抛异常），必须 await
    if (onTick) await onTick({ len, generating, elapsed: Date.now() - t0, receiving: st.receiving });

    // 有进展就刷新"最后进展时刻"：文本变长，或刚开始生成
    if (len > lastLen || (generating && lastLen <= 0)) lastProgressAt = Date.now();

    if (len > 0 && len === lastLen) stable += 1;
    else stable = 0;
    lastLen = len;

    const v = answerProgressVerdict({
      elapsedMs: Date.now() - t0,
      sinceProgressMs: Date.now() - lastProgressAt,
      generating,
      len,
      stableRounds: stable,
      needStableRounds: stableRounds,
      stuckMs,
      timeoutMs,
    });

    if (v.action === 'done') {
      return { text: best, ok: true, reason: v.reason, waitedMs: Date.now() - t0 };
    }
    if (v.action === 'give-up') {
      return {
        text: best,
        /*
         * 只有"等满总超时但确实拿到了文本"才算可用（ok）。
         * 卡住/没反应时**即便有半截文本也标 ok=false** —— 上层会丢弃它并重新提问，
         * 避免把被打断的半句答案填进题目。
         */
        ok: !!best && v.reason === 'timeout-with-text',
        reason: v.reason,
        waitedMs: Date.now() - t0,
        sawReceiving,
      };
    }
  }
}

/** 点掉千问的"停止生成"（重问前先把卡住的那一轮掐掉） */
export async function stopGenerating(page) {
  return page
    .evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((x) =>
        /停止|stop/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')),
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

/** 默认提问词 */
export const DEFAULT_PROMPT =
  '请给出这道题的答案。只回答答案本身，不要解释：选择题回答选项字母（多选题形如 AB），判断题回答「对」或「错」。';

/**
 * 检测千问是否弹出了「风控验证」（需要人工扫码/拖滑块）。
 *
 * 实测指纹（阿里系风控 baxia）：
 *   <div class="baxia-dialog-mask">
 *   <div class="baxia-dialog-content">       ← 420x320 的验证框
 *   <iframe src=".../_____tmd_____/punish?x5secdata=...">
 *
 * 为什么会触发：短时间自动化提问过多。
 * 一旦出现，页面会一直停在"接收中"，**永远等不到回答** ——
 * 早期没有这个检测，白等 4 分钟还把结果标成"AI 没回答"，掩盖了真实原因。
 *
 * 重要：本工具**不会尝试绕过验证**（不做打码/绕滑块），
 * 只负责"检测到就停下并明确告诉用户去扫码"。
 */
export async function detectVerification(page) {
  return page
    .evaluate(() => {
      // 验证完成后千问会保留隐藏的弹层和 iframe，不能仅凭节点存在阻断。
      const visible = element => element.checkVisibility() && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const mask = Array.from(document.querySelectorAll('.baxia-dialog-mask, .baxia-dialog, [class*="baxia-dialog"]')).find(visible);
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const punish = iframes.find((f) => /_____tmd_____|punish|x5secdata/.test(f.getAttribute('src') || '') && visible(f));
      return {
        required: !!mask || !!punish,
        hasMask: !!mask,
        punishIframe: punish ? (punish.getAttribute('src') || '').slice(0, 120) : null,
      };
    })
    .catch(() => ({ required: false }));
}

/** 验证框里的提示文本（在 iframe 内，需要单独读） */
export async function readVerificationText(page) {
  for (const f of page.frames()) {
    if (!/_____tmd_____|punish|x5secdata/.test(f.url())) continue;
    const t = await f
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200))
      .catch(() => '');
    if (t) return t;
  }
  return '';
}

/**
 * 一步到位：让千问回答一张图片。
 *
 * @param {object} opts
 * @param {import('playwright-core').Page} opts.page 千问标签页
 * @param {string} opts.imagePath 题目截图
 * @param {string} [opts.prompt]
 * @param {boolean} [opts.freshChat] 是否新建对话（默认 true，避免上下文干扰）
 * @returns {Promise<{ok:boolean, answer?:string, raw?:string, error?:string, errorCode?:string, waitedMs?:number}>}
 */
export async function askImage({ page, imagePath, prompt = DEFAULT_PROMPT, freshChat = true, shouldStop, question }) {
  throwIfStopped(shouldStop);
  prompt = questionPrompt(prompt, question);
  if(!page)return {ok:false,errorCode:'not-logged-in',error:'没有可用的 AI 网页，请先打开所选平台并登录'};
  const provider=providerForUrl(page.url?.());
  if(typeof page.url==='function'&&!provider)return {ok:false,errorCode:'wrong-ai-page',error:'答题网页不属于所选官方 AI 平台，已停止发送'};
  if(provider&&provider.id!=='qianwen')return askWebImage({page,imagePath,prompt,freshChat,shouldStop},provider);
  const started = Date.now();
  const cfg = loadSettings().ai || {};
  const retries = Math.max(0, Math.min(4, Number(cfg.askRetries ?? 2)));
  const stuckMs = Math.max(15000, Number(cfg.answerStuckMs ?? 60000));
  const timeoutMs = Math.max(60000, Number(cfg.answerTimeoutMs ?? 240000));

  try {
    throwIfStopped(shouldStop);
    const login = await checkLogin(page);
    if (!login.loggedIn) {
      return { ok: false, errorCode: 'not-logged-in', error: '千问未登录，请先打开千问网页并登录' };
    }

    /*
     * 重问循环：千问"没给出东西"时，不干等也不放弃，而是**重新提问**。
     *
     * 用户实测反馈："千问卡了，此时若没回答应该重新提问，而不是卡着"。
     * 早期每次提问只试一遍，等满 4 分钟才失败 —— 界面上什么都看不到，
     * 一条题目就这么白白变成"待人工"。
     *
     * 只对"没回答"重问；风控验证 / 未登录属于硬障碍，重问只会加深风控，
     * 一律立刻返回并交给上层暂停。
     */
    let lastFail = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      throwIfStopped(shouldStop);
      if (attempt > 1) {
        log(`    千问没回答（${lastFail?.errorCode}）→ 重新提问（第 ${attempt}/${retries + 1} 次）`, 'warn');
      }

      // 进任何操作前先看有没有风控验证挂着
      const pre = await detectVerification(page);
      if (pre.required) {
        const hint = await readVerificationText(page);
        return {
          ok: false,
          errorCode: 'verification-required',
          error: `千问要求人工身份验证（短时间提问过多触发风控）${hint ? `：${hint}` : ''} —— 请到千问标签页扫码完成验证后继续`,
        };
      }

      // 重问时先把上一轮"卡住"的生成掐掉，避免和新一轮打架
      if (attempt > 1) {
        await stopGenerating(page).catch(() => false);
        await page.waitForTimeout(1200);
      }

      if (freshChat) await newChat(page);

      // 新对话后可能立刻弹验证
      const postChat = await detectVerification(page);
      if (postChat.required) {
        const hint = await readVerificationText(page);
        return {
          ok: false,
          errorCode: 'verification-required',
          error: `千问要求人工身份验证${hint ? `：${hint}` : ''} —— 请扫码后继续`,
        };
      }

      /*
       * 重新粘贴图片：失败原因常常就是"上一次的图片/提问没送进去"，
       * 所以重问必须整轮重来，而不是只再点一次发送。
       */
      const pasted = await pasteImage(page, imagePath);
      throwIfStopped(shouldStop);
      if (!pasted.ok) {
        lastFail = { errorCode: 'paste-failed', error: `图片上传失败：${pasted.error}` };
      } else {
        const typed = await typePrompt(page, prompt);
        if (typed.empty) {
          lastFail = { errorCode: 'type-failed', error: '提问文本写入失败（编辑器为空）' };
        } else {
          // 发送前记下"回答基线"，确保随后读到的是**这次**的回答（不是历史残留）
          const baseline = await answerBaseline(page);

          throwIfStopped(shouldStop);
          const sent = await send(page);
          if (!sent.ok) {
            lastFail = { errorCode: 'send-failed', error: `发送失败：${sent.error}` };
            log(`    千问图片题发送失败：${sent.error}`, 'warn');
          } else {
            log('    千问已发送图片题，等待回答', 'info');
            // 等回答时输出心跳 + 中途检测验证弹窗
            let lastTick = 0;
            let lastVerifyCheck = 0;
            const ans = await waitAnswer(page, {
              baseline,
              timeoutMs,
              stuckMs,
              shouldStop,
              onTick: async ({ len, generating, elapsed }) => {
                if (elapsed - lastTick >= 15000) {
                  lastTick = elapsed;
                  log(
                    `      … 等待千问回答 ${Math.round(elapsed / 1000)}s（已收到 ${len} 字${generating ? '，生成中' : ''}）`,
                    'debug',
                  );
                }
                // 每 5 秒查一次验证弹窗（可能是提问后才弹的）
                if (elapsed - lastVerifyCheck >= 5000) {
                  lastVerifyCheck = elapsed;
                  const v = await detectVerification(page).catch(() => ({ required: false }));
                  if (v.required) throw Object.assign(new Error('verification-required'), { code: 'verification-required' });
                }
              },
            });

            if (ans.ok && ans.text) {
              return {
                ok: true,
                answer: ans.text,
                attempts: attempt,
                waitedMs: ans.waitedMs || Date.now() - started,
              };
            }
            /*
             * 拿到半截文本但没稳定下来（卡住 / 只等到一半）→ **丢弃并重问**。
             * 半句答案拿去填题就是错答案，宁可多问一次。
             */
            if (ans.text) {
              log(`    ! 只拿到半截回答（${ans.reason}，${ans.text.length} 字）—— 不作数，重新提问`, 'warn');
            }

            const code =
              ans.reason === 'stuck-frozen'
                ? 'stuck-frozen'
                : ans.reason === 'stuck-silent'
                  ? 'stuck-silent'
                  : ans.reason === 'timeout-still-receiving'
                    ? 'stuck-receiving'
                    : 'empty-answer';
            lastFail = {
              errorCode: code,
              error:
                code === 'stuck-frozen'
                  ? `千问卡在"生成中"超过 ${Math.round(stuckMs / 1000)} 秒没有吐字`
                  : code === 'stuck-silent'
                    ? `千问没有反应（${Math.round(stuckMs / 1000)} 秒内既没有生成提示也没有内容）`
                    : code === 'stuck-receiving'
                      ? `千问一直停在"生成中"未返回内容（可能被限流或风控）`
                      : `未取到回答（${ans.reason}）`,
              waitedMs: ans.waitedMs,
            };
          }
        }
      }

      // 决定要不要再问一次
      const d = shouldReask({ errorCode: lastFail.errorCode, attempt, retries });
      if (!d.reask) {
        if (/不是"没回答"/.test(d.reason)) break; // 硬障碍（风控/未登录/写入失败），重问无意义
        log(`    ⚠ ${d.reason} —— 记为待人工`, 'warn');
        break;
      }
      // 重问之间留一点间隔（并计入节流，避免把账号推向风控）
      await interruptibleSleep(Math.min(12000, 4000 + attempt * 3000), shouldStop);
    }

    return {
      ok: false,
      errorCode: lastFail?.errorCode || 'empty-answer',
      error: `${lastFail?.error || '未取到回答'}${retries > 0 ? `（已重新提问 ${retries} 次）` : ''}`,
      attempts: retries + 1,
      waitedMs: Date.now() - started,
    };
  } catch (err) {
    if (err?.code === 'STOPPED') throw err;
    if (err && err.code === 'verification-required') {
      const hint = await readVerificationText(page).catch(() => '');
      return {
        ok: false,
        errorCode: 'verification-required',
        error: `千问要求人工身份验证${hint ? `：${hint}` : ''} —— 请扫码后继续`,
      };
    }
    return { ok: false, errorCode: 'exception', error: err.message };
  }
}
