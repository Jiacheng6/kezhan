/**
 * 测验/作业的题目提取与截图（P4）。
 *
 * 已探明的学习通结构（2026-09 实测）：
 *
 *   作业真实页面：/mooc-ans/work/doHomeWorkNew?workId=..&workAnswerId=..
 *     ⚠ 不能直接访问（403，缺动态 enc）—— 必须留在 cards 页等它自己渲染，
 *       或从已渲染的 frame 里操作。
 *
 *   每道题：.TiMu.newTiMu[data]
 *     题干   .Zy_TItle
 *              题型 .newZy_TItle        → "【多选题】" / "【单选题】" / "【判断题】" / "【填空题】"
 *              正文 p                    → ⚠ 字体加密，DOM 文本是乱码，只能用截图
 *     选项   ul.Zy_ulTop > li[role=checkbox|radio][qid][qtype][aria-label]
 *              onclick="addMultipleChoice(this)" 或 "addSingleChoice(this)"
 *              data="A"  → 选项字母
 *              aria-label="A 有原创性、有价值的内容选择" → 字母 + 选项文本
 *
 *   按钮   .btnSave（暂时保存）  .btnSubmit（提交）
 *
 * 关键设计决策：
 *   因为题干是字体加密的，**不依赖 DOM 文本**来判断题目内容；
 *   截图是唯一可靠输入。DOM 只用来：定位题目、拿选项字母、点选、提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { waitForRead, throwIfStopped, interruptibleSleep } from '../control.mjs';
import { embedded, captureEmbeddedPage } from '../browser/embedded.mjs';

/** 题型归一化（判定逻辑内联在 extractQuestions 里，这里只留映射表供参考） */
const QTYPE_PATTERNS = [
  [/多选/, 'multiple'],
  [/单选/, 'single'],
  [/判断/, 'judge'],
  [/填空/, 'fill'],
  [/简答|论述|分析/, 'essay'],
];

function qtypeOf(raw) {
  for (const [re, t] of QTYPE_PATTERNS) if (re.test(raw)) return t;
  return 'unknown';
}

/**
 * 找到当前页面里的作业 frame（含题目）。
 * @param {import('playwright-core').Page} page
 */
export function findWorkFrame(page) {
  return (
    page.frames().find((f) => {
      const u = f.url();
      return /mooc-ans\/work\/|work\/selectWorkQuestion|mooc-ans\/api\/work/.test(u);
    }) || null
  );
}

/** 等作业 frame 出现并渲染出题目 */
export async function waitWorkFrame(page, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      if (!/mooc-ans\/work\/|doHomeWorkNew/.test(f.url())) continue;
      const n = await f.evaluate(() => document.querySelectorAll('.TiMu, .newTiMu').length).catch(() => 0);
      if (n > 0) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 提取所有题目（结构化，不含题干文本 —— 那是加密的）。
 *
 * @returns {Promise<Array>} 每题：
 *   { index, qid, qtype, qtypeRaw, stemTextRaw(乱码，仅供参考),
 *     options: [{ letter, text, role, onclick, qid }],
 *     hasAnswered }
 */
export async function extractQuestions(workFrame) {
  return workFrame.evaluate(() => {
    const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

    return Array.from(document.querySelectorAll('.TiMu, .newTiMu')).map((q, i) => {
      const heading=t(q.querySelector('.Zy_TItle .fontLabel, .Zy_TItle'));
      const typeRaw = t(q.querySelector('.newZy_TItle'))||heading.match(/【[^】]+】/)?.[0]||t(q.querySelector('[class*="TItle"] span'));
      const stemRaw = t(q.querySelector('.Zy_TItle .fontLabel p, .Zy_TItle p'))||heading;

      const options = Array.from(q.querySelectorAll('li[qid], li[role="radio"], li[role="checkbox"]')).map((li) => {
        /*
         * 选项字母在 li 内部的 span 上，不在 li 上。
         * 实测 DOM：
         *   <li role="checkbox" onclick="addMultipleChoice(this)" qid=".." qtype="1"
         *       aria-label="A 有原创性、有价值的内容选择">
         *     <label><span class="num_option_dx" name="answercheck.." data="A">A</span></label>
         *     <a class="after"><p>有原创性、有价值的内容</p></a>
         *   </li>
         */
        const letterSpan = li.querySelector('span[data], .num_option_dx, .num_option, span[name^="answer"]');
        const native=li.querySelector('input[type="radio"],input[type="checkbox"]');
        const rawLetter = (letterSpan?.getAttribute('data') || native?.value || '').trim();
        // 多选题是 A/B/C/D（转大写统一），判断题是 true/false（必须保持小写，
        // 因为 DOM 里就是 data="true"，转成 TRUE 会匹配不上）
        const letter = /^[a-z]$/i.test(rawLetter) ? rawLetter.toUpperCase() : rawLetter;
        const aria = li.getAttribute('aria-label') || '';
        const visibleLetter=t(letterSpan).normalize('NFKC').toUpperCase();
        const displayLetter=/^[A-Z]$/.test(visibleLetter)?visibleLetter:(aria.match(/^\s*([A-Z])(?:\s|[.、])/i)?.[1]?.toUpperCase()||null);
        // aria-label 形如 "A 有原创性、有价值的内容选择"（尾部可能带"选择"/"选项"）
        const ariaText = aria.replace(/^\s*[A-Z]\s*/, '').replace(/选择$|选项$/, '').trim();
        const innerText = t(li.querySelector('.after p, .after'));
        return {
          letter,
          displayLetter,
          text: ariaText || innerText,
          textFromAria: !!ariaText,
          role: li.getAttribute('role') || '',
          onclick: li.getAttribute('onclick') || '',
          qid: li.getAttribute('qid') || '',
          qtype: li.getAttribute('qtype') || '',
          selected: native?native.checked:!!li.querySelector('.check_answer,.check_answer_dx'),
        };
      });

      // 填空题/简答题的输入框
      const inputs = Array.from(q.querySelectorAll('textarea, input[type="text"]')).map((e) => ({
        tag: e.tagName,
        cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60),
        name: e.getAttribute('name') || '',
        placeholder: e.getAttribute('placeholder') || '',
      }));

      const editor=q.querySelector('[name^="answerEditor"], [id^="answerEditor"]');
      const editorId=(editor?.getAttribute('name')||editor?.id||'').replace(/^answerEditor[_-]?/,'');
      return {
        index: i + 1,
        questionId: q.querySelector('[qid]')?.getAttribute('qid') || editorId || q.getAttribute('data') || '',
        qtypeRaw: typeRaw,
        qtype: (() => {
          const map = [
            [/多选/, 'multiple'],
            [/单选/, 'single'],
            [/判断/, 'judge'],
            [/填空/, 'fill'],
            [/简答|论述|分析/, 'essay'],
          ];
          for (const [re, v] of map) if (re.test(typeRaw)) return v;
          return 'unknown';
        })(),
        stemTextRaw: stemRaw, // 注意：字体加密，仅供排查
        optionCount: options.length,
        options,
        inputs,
        domIndex: i,
      };
    });
  });
}

/** 题目总数与提交/保存按钮信息 */
export async function getWorkMeta(workFrame) {
  return workFrame.evaluate(() => {
    const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
    const find = (sel) => {
      const el = document.querySelector(sel);
      return el ? { text: t(el), visible: el.offsetParent !== null, cls: String(el.className) } : null;
    };
    return {
      url: location.href,
      questionTotal: document.querySelectorAll('.TiMu, .newTiMu').length,
      saveBtn: find('.btnSave'),
      submitBtn: find('.btnSubmit'),
      title: t(document.querySelector('.workTitle, h1, .tit, [class*="title"]')).slice(0, 80),
    };
  });
}

/**
 * 截取单道题的图片（精确裁剪）。
 * @returns {Promise<string>} 图片文件路径
 */
export async function shootQuestion(workFrame, domIndex, outDir, { shouldStop, readTimeoutMs = 8000, onRecovery, selector = '.TiMu, .newTiMu', nativeCapture = embedded ? captureEmbeddedPage : null, allowCDPFallback = true } = {}) {
  throwIfStopped(shouldStop);
  fs.mkdirSync(outDir, { recursive: true });
  const read = async (stage, operation) => {
    try {
      return await waitForRead(operation, { shouldStop, timeoutMs: readTimeoutMs, message: `题目截图超时（${stage}）` });
    } catch (error) {
      if (error.code === 'STOPPED') throw error;
      error.captureStage = stage;
      throw error;
    }
  };
  const els = await read('定位题目', () => workFrame.$$(selector));
  const el = els[domIndex];
  if (!el) throw new Error(`找不到第 ${domIndex + 1} 题的元素`);

  // Win32 隐藏窗口没有稳定的动画帧；元素截图/scrollIntoViewIfNeeded
  // 会一直等「元素稳定」。直接滚动、读坐标，用 CDP 捕获，不需要先显示窗口。
  await read('滚动题目', () => el.evaluate((node) => node.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' })));
  // fonts.ready waits for *every* font on the page, including unrelated editor
  // toolbars. Wait only for text actually used in the question/options instead.
  // Never send an encrypted question rendered with a missing fallback font.
  const fontsStarted = Date.now();
  for (;;) {
    const fonts = await read('检查题目字体', () => el.evaluate((node) => {
      const roots = [...node.querySelectorAll('.Zy_TItle, .Zy_ulTop, .Zy_ulBottom')];
      const requests = new Map();
      for (const root of roots.length ? roots : [node]) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent.trim(), parent = walker.currentNode.parentElement;
          if (!text || !parent || !parent.getClientRects().length) continue;
          const style = getComputedStyle(parent);
          if (style.visibility !== 'visible' || style.display === 'none') continue;
          const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          requests.set(font, (requests.get(font) || '') + text);
        }
      }
      let pending = 0, failed = false;
      const normalize = (value) => value.replace(/["']/g, '').trim().toLowerCase();
      for (const [font, text] of requests) {
        const families = font.slice(font.indexOf('px') + 2).split(',').map(normalize);
        if (!document.fonts.check(font, text)) {
          pending++;
          if ([...document.fonts].some(face => families.includes(normalize(face.family)) && face.status === 'error')) failed = true;
        }
      }
      return { pending, failed };
    }));
    if (fonts.failed) throw Object.assign(new Error('题目字体加载失败，请刷新题目后重试；未发送可能乱码的截图'), { captureStage: '题目字体' });
    if (!fonts.pending) break;
    if (Date.now() - fontsStarted >= readTimeoutMs) throw Object.assign(new Error('题目截图超时（题目字体尚未加载）'), { captureStage: '题目字体' });
    await interruptibleSleep(100, shouldStop);
  }
  await interruptibleSleep(100, shouldStop);
  const box = await read('读取题目坐标', () => el.boundingBox());
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new Error('题目没有可截图的显示区域');
  }
  if (box.width > 16000 || box.height > 16000) throw new Error('题目截图区域过大，请人工处理');
  const page = workFrame.page();
  const file = path.join(outDir, `q${String(domIndex + 1).padStart(2, '0')}-${Date.now()}.png`);
  if (nativeCapture) {
    try {
      let currentBox=box;
      for(let attempt=0;attempt<3;attempt++){
        const rect = { x: Math.max(0, Math.floor(currentBox.x)), y: Math.max(0, Math.floor(currentBox.y)), width: Math.ceil(currentBox.width), height: Math.ceil(currentBox.height) };
        const result = await read('软件内成像', () => nativeCapture(page, rect));
        const after=await read('核对截图位置',()=>el.boundingBox());
        // A native copy/viewport update may reflow or finish scrolling the page.
        // Discard pixels from the previous position rather than sending a header.
        if(!after)throw Error('截图后题目已不可见');
        if(['x','y','width','height'].some(key=>Math.abs(after[key]-currentBox[key])>1)){currentBox=after;continue;}
        const image = Buffer.from(result.data, 'base64');
        if (image.length < 24 || image.readUInt32BE(0) !== 0x89504e47 || image.readUInt32BE(16) !== rect.width || image.readUInt32BE(20) !== rect.height) throw new Error('软件内题目截图尺寸不完整');
        throwIfStopped(shouldStop); fs.writeFileSync(file, image); return file;
      }
      throw Error('题目位置持续变化，未发送不完整截图，请重试');
    } catch (error) {
      if (error.code === 'STOPPED') throw error;
      if(!allowCDPFallback)throw error;
      onRecovery?.('正在尝试另一种题目成像方式');
    }
  }
  // A fresh session per attempt avoids reusing a timed-out capture connection.
  // Focus emulation wakes the target renderer without showing the native window
  // or switching the user's selected tab.
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await read('连接浏览器成像', () => page.context().newCDPSession(page));
    let focusEmulated = false;
    try {
      if (attempt) {
        await read('恢复页面绘制', () => session.send('Page.setWebLifecycleState', { state: 'active' }));
        focusEmulated = true;
        await read('恢复页面焦点', () => session.send('Emulation.setFocusEmulationEnabled', { enabled: true }));
      }
      const metrics = await read('读取页面尺寸', () => session.send('Page.getLayoutMetrics'));
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
      const result = await read('浏览器成像', () => session.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: Math.max(0, box.x + viewport.pageX), y: Math.max(0, box.y + viewport.pageY),
          width: box.width, height: box.height, scale: 1 },
      }));
      throwIfStopped(shouldStop);
      const image = Buffer.from(result.data, 'base64');
      if (image.length < 24 || image.readUInt32BE(0) !== 0x89504e47) throw new Error('浏览器没有返回有效截图');
      fs.writeFileSync(file, image);
      return file;
    } catch (error) {
      if (error.code === 'STOPPED' || attempt || error.captureStage !== '浏览器成像') throw error;
      onRecovery?.('浏览器成像未返回，正在恢复绘制并重新截图一次');
    } finally {
      if (focusEmulated) await waitForRead(() => session.send('Emulation.setFocusEmulationEnabled', { enabled: false }), { timeoutMs: 1000 }).catch(() => {});
      await waitForRead(() => session.detach(), { timeoutMs: 1000 }).catch(() => {});
    }
  }
}

/**
 * 按字母点选选项。
 *
 * 关键：学习通的选项是 `li[onclick="addMultipleChoice(this)"]`，
 * 不是真正的 input，所以要用 click 而不是 setChecked。
 *
 * 选中判据（实测比对得出）—— 不同题型加不同的类：
 *   多选题 `li[onclick="addMultipleChoice(this)"][role=checkbox]`
 *     未选 `<span class="num_option_dx choice123456789 " data="A">`
 *     已选 `<span class="num_option_dx choice123456789  check_answer_dx" data="A">`
 *   判断题 `li[onclick="addChoice(this)"][role=radio]`
 *     未选 `<span class="num_option choice987654321 " data="true">`
 *     已选 `<span class="num_option choice987654321 check_answer" data="true">`
 *     （`choice` 后面那串是题目 ID，示例数字是编的）
 *   所以判据 = classList 里有 check_answer 或 check_answer_dx。
 *
 * 早期用宽泛正则 `/check|select|active|cur|click/i` 匹配 li+span 的 class，
 * 会把基础类误判成"已选"，导致多选题四个选项全被判为已选、点不动。
 * 用 `classList.contains` 做精确匹配可彻底避免这类误判。
 */
const SELECTED_CLASSES = ['check_answer', 'check_answer_dx'];

/*
 * 选项字母：多选题是 A/B/C/D，判断题是 true/false（小写）。
 * 所以只在"确实是字母"时转大写，否则保持原值（否则 true → TRUE，
 * 而 DOM 里是 data="true"，会匹配不上）。
 */
const LETTER_SRC = `
function __letterOf(li) {
  const s = li.querySelector('span[data], .num_option_dx, .num_option, span[name^="answer"]');
  const native=li.querySelector('input[type="radio"],input[type="checkbox"]');
  const raw = ((s && s.getAttribute('data')) || (native&&native.value) || '').trim();
  return /^[a-z]$/i.test(raw) ? raw.toUpperCase() : raw;
}
function __isSelected(li) {
  const native=li.querySelector('input[type="radio"],input[type="checkbox"]');
  if(native)return native.checked;
  const s = li.querySelector('span');
  if (!s) return false;
  return ${JSON.stringify(SELECTED_CLASSES)}.some(function (c) { return s.classList.contains(c); });
}
function __clickOption(li){const native=li.querySelector('input[type="radio"],input[type="checkbox"]');if(native)native.click();else li.click();}
`;

const HELPERS_SRC = LETTER_SRC;

/**
 * 点选选项（多选题按字母多选，判断题 true/false）。
 *
 * @param {import('playwright-core').Frame} workFrame 作业 frame
 * @param {number} domIndex 第几题（DOM 顺序，从 0 开始）
 * @param {string[]} letters 要选的字母，如 ['A','C']
 * @param {{clearFirst?: boolean}} [opts] clearFirst=true 时先清掉已选（重复提交时的保险）
 */
export async function selectOptions(workFrame, domIndex, letters, { clearFirst = true } = {}) {
  /*
   * 注意两点：
   *   1) Set 无法跨 evaluate 序列化，必须传数组
   *   2) **不能统一转大写** —— 多选题选项是 A/B/C/D，判断题是 true/false，
   *      后者转成 TRUE 就匹配不上 DOM 里的 data="true" 了。
   */
  const wanted = [...new Set(letters.map((s) => String(s).trim()).filter(Boolean))];
  return workFrame.evaluate(
    ({ idx, want, clear, helpers }) => {
      // eslint-disable-next-line no-eval
      eval(helpers);

      const q = document.querySelectorAll('.TiMu, .newTiMu')[idx];
      if (!q) return { ok: false, error: '题目元素不存在' };

      const items = Array.from(q.querySelectorAll('li[qid],li[role="radio"],li[role="checkbox"]'));

      if (clear) {
        for (const li of items) if (__isSelected(li)) __clickOption(li);
      }

      const clicked = [];
      for (const li of items) {
        const letter = __letterOf(li);
        if (!want.includes(letter)) continue;
        if (!__isSelected(li)) __clickOption(li);
        clicked.push(letter);
      }

      return {
        ok: clicked.length === want.length,
        clicked,
        missing: want.filter((l) => !clicked.includes(l)),
        availableLetters: items.map(__letterOf),
        verified: items.filter(__isSelected).map(__letterOf),
      };
    },
    { idx: domIndex, want: wanted, clear: clearFirst, helpers: HELPERS_SRC },
  );
}

/**
 * 读取当前已选中的选项（用于提交前核对）。
 */
export async function readSelection(workFrame, domIndex) {
  return workFrame.evaluate(
    ({ idx, helpers }) => {
      // eslint-disable-next-line no-eval
      eval(helpers);
      const q = document.querySelectorAll('.TiMu, .newTiMu')[idx];
      if (!q) return null;
      const items = Array.from(q.querySelectorAll('li[qid],li[role="radio"],li[role="checkbox"]'));
      return {
        selected: items.filter(__isSelected).map(__letterOf).filter(Boolean),
        all: items.map(__letterOf).filter(Boolean),
      };
    },
    { idx: domIndex, helpers: HELPERS_SRC },
  );
}
