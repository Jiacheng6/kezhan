/**
 * U校园 AI 版：测验类节点（Unit test 的 Vocabulary / Banked cloze / Reading / Translation）。
 *
 * 真机结构（2026-11-02）：
 *   · 一个 Unit test 节点内含 4 个 tab，每个 tab 是若干题；
 *   · 题目是纯文本：`1. ... ________ ...`，选项是 `div.option.isNotReview`（文本 "A enable"，可点）；
 *   · 不是 input[type=radio]，所以必须点 div；
 *   · 提交按钮在页面下方（文案待确认）。
 *
 * 策略（用户要求）：**只有全部答案高可靠才自动提交**，否则保留草稿进待审。
 * 因此这里把"读题 / 截图 / 点选 / 提交"做成独立步骤，由上层决定走多远。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';

/** 给异步步骤加硬超时，避免整轮挂死（真机踩过 600 秒无响应） */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message || '操作超时')), ms)),
  ]);
}

/**
 * 打开第 unitIndex 个单元（1 起）的 Unit test 节点。
 * 目录里 "Unit test" 会出现 6 次（每单元一次），按顺序点即可。
 */
export async function openUnitTest(page, unitIndex) {
  await ensurePlayableViewport(page);
  const info = await page.evaluate((idx) => {
    // 先确保目录展开
    const tab = [...document.querySelectorAll('div,span,button,a,li')].find(
      (el) => (el.innerText || '').trim() === '目录' && el.getClientRects().length,
    );
    if (tab) tab.click();
    const entries = [...document.querySelectorAll('span.pc-menu-node-name')].filter(
      (el) => (el.innerText || '').trim() === 'Unit test',
    );
    const el = entries[idx - 1];
    if (!el) return JSON.stringify({ ok: false, total: entries.length });
    el.click();
    return JSON.stringify({ ok: true, total: entries.length });
  }, unitIndex);
  const parsed = JSON.parse(info);
  if (!parsed.ok) return { ok: false, note: `目录里只有 ${parsed.total} 个 Unit test` };
  await page.waitForTimeout(4500);
  return { ok: true, total: parsed.total };
}

/**
 * 从 uai 教程页点开"必修子项"（Vocabulary / Quiz 这类），返回新打开的播放器页。
 *
 * 真机发现（2026-11-02）：视频区的 Vocabulary / Quiz **不在播放器目录里**，
 * 只能从教程页的必修清单点进去；点完会新开一个播放器标签页，
 * 落在 `<Section> > <节点> > Vocabulary learning` 这种子页面上。
 *
 * @returns {{ok:boolean, page?:import('playwright-core').Page, note?:string}}
 */
export async function openUcampusRequiredItem(context, name, { occurrence = 0, waitMs = 9000, courseResourceId = '20001230493', unit = null } = {}) {
  let uai = context.pages().find((p) => !p.isClosed() && p.url().split(/[?#]/)[0]===`https://uai.unipus.cn/app/cmgt/resource-detail/${courseResourceId}`);
  if (!uai) {
    // 教程页被关掉时自己开一个（同一登录态）
    uai = await context.newPage();
    await uai.goto(`https://uai.unipus.cn/app/cmgt/resource-detail/${courseResourceId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await uai.waitForTimeout(5000);
  }
  if (!uai) return { ok: false, note: '打不开教程详情页' };
  const before = new Map(context.pages().map(p=>[p,p.url()]));

  // 先展开目标单元（手风琴：一次只展开一个）
  if (unit) {
    const unitOpened = await uai.evaluate((u) => {
      const el = [...document.querySelectorAll('*')].find((n) => (n.innerText || '').trim() === `Unit ${u}` && n.getClientRects().length && n.children.length <= 2);
      if (el) { el.click(); return true; }
      return false;
    }, Number(unit));
    if(!unitOpened)return {ok:false,note:`教程页无法定位 Unit ${unit}，未打开其他单元`};
    await uai.waitForTimeout(2200);
  }
  const clicked = await uai.evaluate(
    ({ want, occ }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const rows = [...document.querySelectorAll('[class*="taskNameContainer"]')].filter((el) => {
        const required = !!el.querySelector('[class*="taskRequireIcon"]');
        return required && el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden' && norm(el.innerText).startsWith(want);
      });
      const el = rows[occ];
      if (!el) return `no-item(共 ${rows.length} 个)`;
      const clickable = el.closest('[class*="task"]') || el;
      clickable.click();
      return 'clicked';
    },
    { want: name, occ: occurrence },
  );
  if (!String(clicked).startsWith('clicked')) return { ok: false, note: String(clicked) };

  // 等新标签页出现（教程页自己可能不跳转，播放器会新开一页）
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await uai.waitForTimeout(500);
    const fresh = context.pages().filter((p) => !p.isClosed() && /^https:\/\/ucontent\.unipus\.(cn|com)\//.test(p.url()) && (!before.has(p)||before.get(p)!==p.url()));
    if (fresh.length) {
      const page = fresh[fresh.length - 1];
      await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
      await page.waitForTimeout(2500);
      await dismissUcampusDialog(page);
      return { ok: true, page };
    }
  }
  // 没开新页时，退回去用现有播放器页（可能是在同一页里换了节点）
  return { ok:false,note:'所选必修项未打开新的播放器，未使用其他任务的旧页面' };
}

/**
 * 关掉挡在前面的提示弹窗（"我知道了" / "确定"）。
 *
 * 真机踩到：这个弹窗用 DOM 的 `.click()` 关不掉（React 只在真实事件上响应），
 * 它会一直吃掉后续点击 —— 表现为"提交按钮点得到、但一个请求都不发"。
 * 所以这里用**真实鼠标**点，并校验弹窗是否真的消失。
 */
export async function dismissUcampusDialog(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await page.evaluate(() => {
      const visible = (el) => !!el.getClientRects().length;
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const targets = ['我知道了', '知道了', '确定', '关闭'];
      for (const el of document.querySelectorAll('button,[role="button"],a,div,span')) {
        if (!visible(el)) continue;
        const t = norm(el.innerText);
        if (!targets.includes(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 8) continue;
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t });
      }
      return '';
    });
    if (!point) return '';
    const { x, y, text } = JSON.parse(point);
    await page.mouse.click(x, y);
    await page.waitForTimeout(1200);
    const still = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      return [...document.querySelectorAll('button,[role="button"],a,div,span')].some(
        (el) => el.getClientRects().length && ['我知道了', '知道了'].includes(norm(el.innerText)),
      );
    });
    if (!still) return text;
  }
  return 'dialog-still-open';
}
/**
 * 打开某单元的 "Reading the text" → "Vocabulary learning" → 子标签（Vocabulary / Quiz）。
 *
 * 真机结构：视频区的必修 Vocabulary / Quiz 就挂在这里。
 * 目录里 "Reading the text" 每单元出现两次（Section A / Section B），按 occurrence 取。
 */
export async function openVocabularyLearning(page, { unitOccurrence = 0, subTab = 'Quiz' } = {}) {
  await ensurePlayableViewport(page);
  await dismissUcampusDialog(page);
  await page.bringToFront().catch(() => {});

  const opened = await page.evaluate((occ) => {
    const tab = [...document.querySelectorAll('div,span,button,a,li')].find((el) => (el.innerText || '').trim() === '目录' && el.getClientRects().length);
    if (tab) tab.click();
    const list = [...document.querySelectorAll('span.pc-menu-node-name')].filter((el) => (el.innerText || '').trim() === 'Reading the text');
    const el = list[occ];
    if (!el) return `no-entry(共 ${list.length})`;
    el.click();
    return 'clicked';
  }, unitOccurrence);
  if (!String(opened).startsWith('clicked')) return { ok: false, note: String(opened) };
  await page.waitForTimeout(4500);
  await dismissUcampusDialog(page);

  // 必须点**表头**，而且要用真实鼠标（DOM click 不会切换）
  const tabOk = await clickByText(page, 'Vocabulary learning', { selector: '[class*="pc-header-tab"]' });
  if (!tabOk) return { ok: false, note: '没找到「Vocabulary learning」表头标签' };
  await page.waitForTimeout(2500);
  await dismissUcampusDialog(page);

  // 子标签：Vocabulary / Quiz（页面里通常成对出现，取可点的那个）
  /*
   * 子标签在真机上常被渲染成连体文本（页面里显示成 "VocabularyQuiz"），
   * 所以不能按"元素文字正好等于 Quiz"去找；改为把候选按**后代数量升序**排，
   * 取最内层、宽度大于 0 的那个点。
   */
  const subOk = await clickByText(page, subTab);
  if (!subOk) return { ok: false, note: `没找到子标签「${subTab}」` };
  await page.waitForTimeout(3500);
  await dismissUcampusDialog(page);
  return { ok: true, note: `已打开 Vocabulary learning › ${subTab}` };
}

/**
 * 用**真实鼠标**点某个文字元素。
 *
 * 这个站点的很多交互（弹窗按钮、页签、子标签）对 DOM 的 `el.click()` 不响应，
 * 必须是真实鼠标事件。这里统一处理：定位 → 滚进视口 → 重新测量 → mouse.click。
 */
export async function clickByText(page, text, { selector = '*', maxDepth = null, index = 0 } = {}) {
  const point = await page.evaluate(
    ({ text, selector, maxDepth, index }) => {
      const visible = (el) => !!el.getClientRects().length;
      let cands = [...document.querySelectorAll(selector)]
        .filter((n) => visible(n) && (n.innerText || '').trim() === text)
        .map((n) => ({ n, depth: n.querySelectorAll('*').length, r: n.getBoundingClientRect() }))
        .filter((c) => c.r.width > 0 && c.r.height > 0);
      if (maxDepth !== null) cands = cands.filter((c) => c.depth <= maxDepth);
      cands.sort((a, b) => a.depth - b.depth);
      const hit = cands[index];
      if (!hit) return '';
      hit.n.scrollIntoView({ block: 'center' });
      const r = hit.n.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), depth: hit.depth });
    },
    { text, selector, maxDepth, index },
  );
  if (!point) return false;
  await page.waitForTimeout(400);
  const { x, y } = JSON.parse(point);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
  return true;
}

/** 读当前 tab 里的所有题目（按选项分组识别，纯 DOM，不发请求） */
export async function readQuizQuestions(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el.getClientRects().length;
    // 真机结构：每题的选项是一组 div.option（同一父容器）；题干在这组选项之前的文本里
    const groups = new Map();
    for (const opt of document.querySelectorAll('.option')) {
      if (!visible(opt)) continue;
      const host = opt.parentElement;
      if (!host) continue;
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host).push(opt);
    }
    const out = [];
    for (const [host, opts] of groups.entries()) {
      if (opts.length < 2) continue;
      const options = opts
        .map((el) => {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          return { letter: (t.match(/^([A-Z])/) || [])[1] || '', text: t };
        })
        .filter((o) => o.letter);
      if (options.length < 2) continue;
      // 题干：宿主前面最近的、以"数字."开头的块
      let stem = '';
      let prev = host.previousElementSibling;
      for (let i = 0; i < 4 && prev; i += 1, prev = prev.previousElementSibling) {
        const t = (prev.innerText || '').replace(/\s+/g, ' ').trim();
        if (/^\d+[.、]/.test(t) && t.length < 600) {
          stem = t;
          break;
        }
      }
      if (!stem) {
        const own = (host.innerText || '').replace(/\s+/g, ' ').trim();
        stem = own.slice(0, 200);
      }
      const number = Number((stem.match(/^(\d+)/) || [])[1] || out.length + 1);
      /*
       * 阅读类题需要文章原文。真机踩到：只往上找 3 层拿不到文章（豆包回"我没有阅读原文"）。
       * 改为在祖先链里挑**文本最长、但不超过 4000 字**的那一层，通常正好是"文章 + 本题"。
       */
      let context = '';
      let scope = host.parentElement;
      for (let k = 0; k < 8 && scope; k += 1, scope = scope.parentElement) {
        const text = (scope.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length > 4000) break;
        if (text.length > context.length) context = text;
      }
      context = context.slice(0, 4000);
      out.push({ number, stem, options, context, host: out.length });
    }
    return out;
  });
}

/** 当前有哪些 tab（Vocabulary / Banked cloze / Reading / Translation） */
export async function readQuizTabs(page) {
  return page.evaluate(() => {
    const names = ['Vocabulary', 'Banked cloze', 'Reading', 'Translation', 'Writing'];
    return [...document.querySelectorAll('*')]
      .filter((el) => el.getClientRects().length && names.includes((el.innerText || '').trim()))
      .map((el) => ({ name: (el.innerText || '').trim(), active: /active|current|selected/.test(String(el.className)) }))
      .filter((v, i, a) => a.findIndex((x) => x.name === v.name) === i);
  });
}

/** 切到某个 tab */
export async function openQuizTab(page, name) {
  const ok = await page.evaluate((tabName) => {
    const el = [...document.querySelectorAll('*')].find(
      (n) => (n.innerText || '').trim() === tabName && n.getClientRects().length && n.children.length <= 2,
    );
    if (!el) return false;
    el.click();
    return true;
  }, name);
  if (ok) await page.waitForTimeout(2500);
  return ok;
}

/** 把第 index 道题截成图片（给 AI 看，避免 DOM 文本被字体加密影响） */
export async function captureQuestion(page, index, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `uai-q${String(index + 1).padStart(2, '0')}-${Date.now()}.png`);
  /*
   * 真机坑：题目/选项的布局里，`option-wrap` 与 `div.option` 的 getBoundingClientRect()
   * 宽度都是 0（flex/绝对定位把内容溢出到容器外），所以**按矩形裁剪根本拿不到图**。
   * 做法改成：把题目滚到视口里，再截整个视口（CDP，不等字体/稳定）。
   */
  const prepared = await page.evaluate((i) => {
    const visible = (el) => !!el.getClientRects().length;
    const groups = new Map();
    for (const opt of document.querySelectorAll('.option')) {
      if (!visible(opt)) continue;
      const host = opt.parentElement;
      if (!host) continue;
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host).push(opt);
    }
    const hosts = [...groups.entries()].filter(([, o]) => o.length >= 2).map(([h]) => h);
    const host = hosts[i];
    if (!host) return null;
    // 往上找可滚动的祖先，把它滚到中间
    let target = host;
    for (let k = 0; k < 6 && target; k += 1, target = target.parentElement) {
      const style = getComputedStyle(target);
      const scrollable = /(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight;
      if (scrollable) {
        target.scrollTop = Math.max(0, host.offsetTop - target.clientHeight / 2);
        break;
      }
    }
    const prev = host.previousElementSibling;
    const stem = prev && /^\d+[.、]/.test((prev.innerText || '').trim()) ? (prev.innerText || '').replace(/\s+/g, ' ').trim() : '';
    return { stem: stem.slice(0, 80), viewport: { w: innerWidth, h: innerHeight } };
  }, index);
  if (!prepared) return null;
  await page.waitForTimeout(600);

  /*
   * 视口截图：后台标签页不会产生合成帧，直接 captureScreenshot 会一直等（实测超时）。
   * 所以先 bringToFront + 唤醒渲染器，再截；fromSurface:false 时不依赖合成帧。
   */
  await page.bringToFront().catch(() => {});
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    let shot = null;
    for (const options of [
      { format: 'png', fromSurface: true },
      { format: 'png', fromSurface: false },
    ]) {
      try {
        shot = await session.send('Page.captureScreenshot', options);
        if (shot?.data) break;
      } catch (error) {
        shot = null;
      }
    }
    if (!shot?.data) return null;
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  } finally {
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await session.detach().catch(() => {});
  }  return file;
}

/**
 * 把题干与选项渲染成一张白底图片给 AI。
 *
 * 为什么不截播放器：真机上题目/选项的容器宽度是 0（flex 溢出），按矩形裁剪拿不到图；
 * 整屏截图又会抓到课程封面（页面滚动位置不受控）。而题干和选项**文本已经准确读到**，
 * 直接用 canvas 渲染一张干净的图，AI 看得更清楚、也不受页面布局影响。
 */
export async function renderQuestionImage(page, question, file) {
  const dataUrl = await page.evaluate(({ stem, options }) => {
    const W = 1000;
    const pad = 32;
    const lineH = 34;
    const font = '20px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;

    const wrap = (text, maxWidth) => {
      const out = [];
      let line = '';
      for (const ch of String(text)) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line) {
          out.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) out.push(line);
      return out.length ? out : [''];
    };

    const stemLines = wrap(stem, W - pad * 2);
    const optLines = [];
    for (const o of options) {
      const body = String(o.text).replace(/^[A-Z]\s*/, '');
      wrap(`${o.letter}. ${body}`, W - pad * 2 - 16).forEach((l, i) => optLines.push({ text: l, first: i === 0, letter: o.letter }));
    }

    const H = pad * 2 + stemLines.length * lineH + 12 + optLines.length * lineH;
    canvas.width = W;
    canvas.height = H;
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#111111';
    c.font = font;
    let y = pad + lineH - 8;
    for (const l of stemLines) {
      c.fillText(l, pad, y);
      y += lineH;
    }
    y += 12;
    for (const l of optLines) {
      if (l.first) c.fillStyle = '#111111';
      c.fillText(l.text, pad + 16, y);
      y += lineH;
    }
    return canvas.toDataURL('image/png');
  }, { stem: question.stem, options: question.options });

  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  return file;
}

/** 按字母点选某一题的选项（点 div.option，不是 radio） */
export async function chooseOption(page, index, letters) {
  const wanted = (letters || []).map((l) => String(l).toUpperCase()).filter(Boolean);
  if (!wanted.length) return 0;
  const boxes = await page.evaluate(
    ({ i, letters }) => {
      const visible = (el) => !!el.getClientRects().length;
      // 与 readQuizQuestions / captureQuestion 用同一套"选项分组"顺序
      const groups = new Map();
      for (const opt of document.querySelectorAll('.option')) {
        if (!visible(opt)) continue;
        const host = opt.parentElement;
        if (!host) continue;
        if (!groups.has(host)) groups.set(host, []);
        groups.get(host).push(opt);
      }
      const hosts = [...groups.entries()].filter(([, o]) => o.length >= 2).map(([h]) => h);
      const host = hosts[i];
      if (!host) return [];
      const out = [];
      for (const o of host.querySelectorAll('.option')) {
        if (!visible(o)) continue;
        const t = (o.innerText || '').replace(/\s+/g, ' ').trim();
        const letter = (t.match(/^([A-Z])/) || [])[1];
        if (letter && letters.includes(letter)) {
          const r = o.getBoundingClientRect();
          out.push({ letter, index: i, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
      }
      return out;
    },
    { i: index, letters: wanted },
  );
  /*
   * 真机踩到：坐标点击要求选项在视口内，题目一滚出视口就点空（5 题只点上 2 题）。
   * 实测 DOM 的 el.click() 对选项是有效的（class 会变成 option selected），
   * 所以改用 DOM 点击，并逐题校验 selected 状态。
   */
  let clicked = 0;
  for (const b of boxes) {
    const done = await page.evaluate(
      ({ i, letter }) => {
        const visible = (el) => !!el.getClientRects().length;
        const groups = new Map();
        for (const opt of document.querySelectorAll('.option')) {
          if (!visible(opt)) continue;
          const host = opt.parentElement;
          if (!host) continue;
          if (!groups.has(host)) groups.set(host, []);
          groups.get(host).push(opt);
        }
        const hosts = [...groups.entries()].filter(([, o]) => o.length >= 2).map(([h]) => h);
        const host = hosts[i];
        if (!host) return false;
        const target = [...host.querySelectorAll('.option')].find((o) => (o.innerText || '').trim().startsWith(letter));
        if (!target) return false;
        if (!/selected/.test(String(target.className))) target.click();
        return /selected/.test(String(target.className));
      },
      { i: b.index, letter: b.letter },
    );
    if (done) clicked += 1;
    await page.waitForTimeout(350);
  }
  return clicked;
}

/** 页面上的提交/保存按钮文案（供上层核对，不点） */
export async function readSubmitButtons(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button,[role="button"],div[class*="btn"],span[class*="btn"]')]
      .filter((b) => b.getClientRects().length)
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length <= 12 && /提交|保存|完成|提交答案|Submit|Save/.test(t)),
  );
}

/**
 * 保证播放器视口足够大。
 *
 * 真机根因（2026-11-02）：Edge 窗口曾是 280x280，页面里所有容器的
 * getBoundingClientRect() 宽度都是 0 —— 选项点不中、提交按钮点不中、
 * 截图裁出来是空白。把视口设成 1440x900 后一切正常。
 */
export async function ensurePlayableViewport(page) {
  const size = page.viewportSize();
  if (!size || size.width < 1200) {
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

/**
 * 点提交按钮。
 *
 * 真机要点：
 *   · 按钮是 `A.btn`，文字是「提 交」（**中间带空格**）；
 *   · 外层 `div.question-common-course-page` 的文字也是「提交」，
 *     直接按 innerText 匹配会点到外层容器 → 必须用**文本节点**定位，
 *     再往上找 cursor:pointer 的可点祖先；
 *   · 点击后平台会 POST `/course/api/v3/newExploration/submit`，
 *     body 里 `quesDatas[].answer` 就是选中的字母。
 */
export async function clickSubmitButton(page) {
  /*
   * 真机踩到：页面上有 3 个文字是"提交"的元素，点错那个不会触发保存
   * （作答完整、AI 全 high，但平台就是不记账 —— Unit 4/5 Reading 卡在这）。
   * 所以这里把候选全收集起来，从下往上逐个点，**点完看有没有发出提交请求**，
   * 发出去了才算成功。
   */
  const candidates = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = norm(walker.currentNode.textContent);
      if (t !== '提交' && t !== '提交答案') continue;
      let el = walker.currentNode.parentElement;
      for (let i = 0; i < 4 && el; i += 1, el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A' || /btn/i.test(String(el.className))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (el.innerText || '').trim(), bottom: Math.round(r.bottom) });
          }
          break;
        }
      }
    }
    // 去重（同一按钮可能被多次命中）
    const seen = new Set();
    return out.filter((c) => {
      const key = `${c.x},${c.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  if (!candidates.length) return { ok: false, note: '没找到可点的提交按钮' };

  // 从最靠下的开始试（主提交按钮通常在题目下方）
  candidates.sort((a, b) => b.bottom - a.bottom);
  for (const [i, c] of candidates.entries()) {
    // 真机踩到：按钮常在视口下方，矩形是视口外坐标 → 必须先滚进视口再点
    const point = await page.evaluate((idx) => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const all = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = norm(walker.currentNode.textContent);
        if (t !== '提交' && t !== '提交答案') continue;
        let el = walker.currentNode.parentElement;
        for (let k = 0; k < 4 && el; k += 1, el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.cursor === 'pointer' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A' || /btn/i.test(String(el.className))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) all.push({ el, bottom: r.bottom });
            break;
          }
        }
      }
      all.sort((a, b) => b.bottom - a.bottom);
      const node = all[idx]?.el;
      if (!node) return '';
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (node.innerText || '').trim() });
    }, i);
    if (!point) continue;
    await page.waitForTimeout(500);
    const pt = JSON.parse(point);
    let fired = false;
    const onRequest = (req) => {
      if (/newExploration\/submit/.test(req.url())) fired = true;
    };
    page.on('request', onRequest);
    try {
      await page.mouse.click(pt.x, pt.y);
      for (let k = 0; k < 12 && !fired; k += 1) await page.waitForTimeout(500);
    } finally {
      page.off('request', onRequest);
    }
    if (fired) return { ok: true, note: `点击「${pt.text}」@(${pt.x},${pt.y}) 已触发提交接口` };
  }
  return { ok: false, note: `点了 ${candidates.length} 个候选，都没有触发提交接口` };
}

/** 点提交（只在全部高可靠时由上层调用） */
export async function clickSubmit(page) {
  const result = await clickSubmitButton(page);
  if (result.ok) return true;
  const done = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button,[role="button"],div[class*="btn"],span[class*="btn"]')].find(
      (b) => b.getClientRects().length && /^(提交|提交答案|保存|Submit)$/.test((b.innerText || '').replace(/\s+/g, ' ').trim()),
    );
    if (!el) return false;
    el.click();
    return true;
  });
  if (done) await page.waitForTimeout(3000);
  return done;
}

/**
 * 跑一个测验 tab：读题 → 截图 → 问 AI →（可选）点选 + 提交。
 *
 * @param {object} o
 * @param {import('playwright-core').Page} o.page       播放器页（ucontent）
 * @param {string} o.tab                                标签名（Vocabulary / Banked cloze / Reading / Translation）
 * @param {number} [o.limit]                            最多处理几题（默认全部）
 * @param {boolean} [o.apply]                           true = 真的点选并提交；false = 只算不点（安全）
 * @param {Function} o.ask                              ({imagePath,prompt}) => {ok,answer,confidence,...}
 * @param {Function} [o.shouldStop]
 * @param {Function} [o.onProgress]
 */
export async function runUcampusQuizTab({ page, tab, limit = 99, apply = false, ask, shouldStop = () => false, onProgress = () => {}, outDir, readProgress = null }) {
  await ensurePlayableViewport(page);
  await dismissUcampusDialog(page);
  // tab 为空表示"页面已经是对的"（例如从教程页直接点开的必修 Quiz），不要再切
  if (tab) {
    const opened = await openQuizTab(page, tab);
    if (!opened) return { ok: false, phase: 'needs-human', error: `播放器里找不到标签「${tab}」` };
  }
  const questions = await readQuizQuestions(page);
  log(`   【${tab}】读到 ${questions.length} 道题`, 'info');
  if (!questions.length) return { ok: false, phase: 'needs-human', error: `【${tab}】没有读到题目` };

  const dir = outDir || path.join(process.cwd(), '.build-cache', 'uai-quiz');
  const plan = [];
  for (const [i, q] of questions.slice(0, limit).entries()) {
    throwIfStopped(shouldStop);
    onProgress({ phase: 'quiz', detail: `${tab} 第 ${i + 1}/${Math.min(limit, questions.length)} 题` });
    log(`   【${tab}】第 ${i + 1} 题：开始截图`, 'info');
    const imagePath = await withTimeout(renderQuestionImage(page, q, path.join(dir, `uai-q${String(i + 1).padStart(2, '0')}-${Date.now()}.png`)), 20000, '题目出图超时');
    if (!imagePath) {
      plan.push({ number: q.number, ok: false, error: '截图失败' });
      continue;
    }
    const prompt = [
      '这是一道英语选择题，请只给出正确选项的字母。',
      `选项字母依次为：${q.options.map((o) => o.letter).join('、')}`,
      q.context ? `题目所在的阅读材料/上下文（供参考）：\n${q.context}` : '',
      '只输出「答案：X」；不确定就说看不清，不要猜。',
    ]
      .filter(Boolean)
      .join('\n');
    let answer;
    try {
      log(`   【${tab}】第 ${i + 1} 题：截图完成，开始问 AI`, 'info');
      answer = await withTimeout(ask({ imagePath, prompt, question: { qtype: 'single', options: q.options } }), 180000, 'AI 回答超时');
    } catch (error) {
      plan.push({ number: q.number, ok: false, error: String(error.message || error).slice(0, 80) });
      continue;
    }
    const letters = answer?.letters || [];
    log(
      `   【${tab}】第 ${q.number} 题：AI 回答字母 [${letters.join('')}] 可靠性=${answer?.confidence || 'none'}` +
        (answer?.answer ? ` 原文：${String(answer.answer).replace(/\s+/g, ' ').slice(0, 90)}` : ` 错误：${answer?.error || ''}`),
      letters.length ? 'info' : 'warn',
    );
    plan.push({
      number: q.number,
      stem: q.stem.slice(0, 60),
      options: q.options.length,
      letters,
      confidence: answer?.confidence || 'none',
      error: answer?.ok === false ? String(answer.error || '').slice(0, 80) : '',
    });
    await interruptibleSleep(300, shouldStop);
  }

  const allHigh = plan.length > 0 && plan.every((p) => p.confidence === 'high' && p.letters.length);
  let applied = 0;
  let submitted = false;
  let before = null;
  let after = null;
  if (apply && allHigh) {
    if (readProgress) before = await readProgress().catch(() => null);
    for (const [i, p] of plan.entries()) {
      if (!p.letters?.length) continue;
      applied += await chooseOption(page, i, p.letters);
    }
    submitted = await clickSubmit(page);
    log(`   已点选 ${applied} 处，提交：${submitted ? '已点提交' : '没找到提交按钮'}`, submitted ? 'ok' : 'warn');
    if (submitted && readProgress) {
      // 平台记账有几十秒延迟，等一会儿再读（真机实测）
      for (let i = 0; i < 8; i += 1) {
        await interruptibleSleep(8000, shouldStop);
        after = await readProgress().catch(() => null);
        if (after && before && Number(after.finishPointNum) > Number(before.finishPointNum)) break;
      }
      /*
       * 真机踩到：偶尔第一次"点提交"没生效（页面状态、滚动位置都可能影响），
       * 但作答已经保存——这时再点一次提交通常就记账了（Unit 3 Reading 就是这样过的）。
       * 所以没记账就重试一次提交，再等一轮。
       */
      if (before && after && Number(after.finishPointNum) <= Number(before.finishPointNum)) {
        log('   首次提交未记账，重试一次提交', 'warn');
        await clickSubmit(page);
        for (let i = 0; i < 6; i += 1) {
          await interruptibleSleep(8000, shouldStop);
          after = await readProgress().catch(() => null);
          if (after && Number(after.finishPointNum) > Number(before.finishPointNum)) break;
        }
      }
      log(
        `   平台进度：${before?.finishPointNum ?? '?'} → ${after?.finishPointNum ?? '?'}`,
        after && before && Number(after.finishPointNum) > Number(before.finishPointNum) ? 'ok' : 'warn',
      );
    }
  }

  const credited =
    !!(after && before && Number(after.finishPointNum) > Number(before.finishPointNum));
  return {
    ok: true,
    phase: credited ? 'submitted' : applied || submitted ? 'applied-unverified' : 'planned',
    tab,
    questions: plan.length,
    allHigh,
    applied,
    submitted,
    credited,
    before: before?.finishPointNum ?? null,
    after: after?.finishPointNum ?? null,
    plan,
  };
}
