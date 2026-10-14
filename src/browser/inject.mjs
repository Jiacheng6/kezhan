/**
 * 抗失焦 / 反节流注入（P2 核心）。
 *
 * 背景：学习通的播放器 + detect.chaoxing.com 会看页面可见性与焦点，
 * 用户切走窗口或鼠标离开页面就暂停视频。所以要在播放页注入三层防御：
 *
 *   第 1 层（启动参数）：在 config.mjs 的 EDGE_FLAGS 里，浏览器级不节流。
 *   第 2 层（本文件）：页面级伪装 —— 覆写 visibility 属性、拦截事件、
 *                      并把 setInterval/setTimeout/rAF 包装成"永不被节流"。
 *   第 3 层（player.mjs）：播放守卫 —— 真被暂停了就温和纠偏。
 *
 * 不做的事：不劫持 video.pause()（会破坏"播完自停"与弹窗题暂停逻辑），
 * 不伪造播放进度（那是伪造学习记录）。
 */

/** 注入到每个页面/frame 的防御脚本 */
function defenceSource() {
  return `(() => {
  if (window.__xxtDefence) return 'already';
  window.__xxtDefence = true;

  const log = (msg) => { try { console.debug('[xxt-defence] ' + msg); } catch (e) {} };

  // ---------- 1) 伪装页面永远可见 ----------
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
  } catch (e) { log('visibility override failed: ' + e.message); }

  // ---------- 1.5) 伪装"页面有焦点"（关键！） ----------
  // 实测发现：视频 iframe 里 document.hasFocus() 返回 false，
  // 而播放器就在这个 iframe 里判定 —— 很可能是它拒绝计入有效观看时长的原因
  // （现象：视频能播到 100%，但学习通永远不给绿点）。
  // 只伪装 hidden/visibilityState 是不够的，必须连焦点一起伪装。
  try {
    document.hasFocus = function () { return true; };
  } catch (e) { log('hasFocus override failed: ' + e.message); }

  // ---------- 2) 拦截可见性 / 焦点事件 ----------
  // 用捕获阶段 + stopImmediatePropagation，避免站点的监听器收到"失焦"信号
  const swallow = (e) => { e.stopImmediatePropagation(); };
  for (const ev of ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange']) {
    document.addEventListener(ev, swallow, true);
    window.addEventListener(ev, swallow, true);
  }
  for (const ev of ['blur', 'focusout', 'pagehide']) {
    window.addEventListener(ev, swallow, true);
  }
  // 站点常挂 window.onblur；置空以防它直接触发暂停。
  // 同时补一个"永不触发的 onblur"，并在失焦时主动派发 focus 事件（双保险）。
  try {
    window.onblur = null;
    window.onfocusout = null;
    document.onblur = null;
  } catch (e) {}
  // 一旦真的失焦，立刻手动派发一个 focus 事件把状态"纠正"回来
  try {
    window.addEventListener('blur', () => {
      setTimeout(() => {
        try {
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new Event('focus'));
        } catch (e) {}
      }, 50);
    }, true);
  } catch (e) {}

  // ---------- 1.6) 记录"页面自己弹出题目"的调用（取证用） ----------
  // cards 页里的 showCustomPop(url) 就是"弹窗题"的入口。包一层访问器，
  // 无论页面脚本在我们注入前还是注入后定义它，都能记下来。
  try {
    var _showOrig = window.showCustomPop;
    var _hideOrig = window.hideCustomPop;
    Object.defineProperty(window, 'showCustomPop', {
      configurable: true,
      get: function () {
        return function (url) {
          try {
            window.__xxtPops = window.__xxtPops || [];
            window.__xxtPops.push({ t: Date.now(), how: 'showCustomPop', url: String(url || '').slice(0, 300) });
          } catch (e) {}
          if (typeof _showOrig === 'function') return _showOrig.apply(this, arguments);
        };
      },
      set: function (v) { _showOrig = v; },
    });
    Object.defineProperty(window, 'hideCustomPop', {
      configurable: true,
      get: function () {
        return function () {
          try {
            window.__xxtPops = window.__xxtPops || [];
            window.__xxtPops.push({ t: Date.now(), how: 'hideCustomPop' });
          } catch (e) {}
          if (typeof _hideOrig === 'function') return _hideOrig.apply(this, arguments);
        };
      },
      set: function (v) { _hideOrig = v; },
    });
  } catch (e) { log('popup hook failed: ' + e.message); }

  // ---------- 1.7) 记录"谁按了暂停"（取证用） ----------
  // 现象：视频会在毫无可见原因的情况下被暂停（页面上没有弹窗、没有遮罩、
  // hidden=false、hasFocus=true、showCustomPop 也没被调用）。
  // 那就直接把调用栈记下来 —— 谁调用的、从哪调用的，一目了然。
  try {
    var _pauseOrig = HTMLMediaElement.prototype.pause;
    window.__xxtPauseLog = [];
    HTMLMediaElement.prototype.pause = function () {
      try {
        if (window.__xxtPauseLog.length < 25) {
          window.__xxtPauseLog.push({
            t: Date.now(),
            ct: Math.round((this.currentTime || 0) * 10) / 10,
            rs: this.readyState,
            net: this.networkState,
            ended: this.ended,
            stack: String((new Error()).stack || '').split('\\n').slice(1, 7).join(' | ').slice(0, 600),
          });
        }
      } catch (e) {}
      return _pauseOrig.apply(this, arguments);
    };
  } catch (e) { log('pause hook failed: ' + e.message); }

  // ---------- 3) 让定时器不被后台节流 ----------
  // 关键：同时主动往内部 timer 队列塞一个空回调，阻止 Chromium 降频
  const _setInterval = window.setInterval;
  const _setTimeout = window.setTimeout;
  window.setInterval = function (fn, ms, ...rest) {
    const wrapped = typeof fn === 'function'
      ? function () { try { return fn.apply(this, arguments); } catch (e) { console.error(e); } }
      : fn;
    const id = _setInterval.call(window, wrapped, ms, ...rest);
    try { _setInterval.call(window, () => {}, 1000); } catch (e) {}
    return id;
  };
  window.setTimeout = function (fn, ms, ...rest) {
    const wrapped = typeof fn === 'function'
      ? function () { try { return fn.apply(this, arguments); } catch (e) { console.error(e); } }
      : fn;
    return _setTimeout.call(window, wrapped, ms, ...rest);
  };

  // ---------- 4) 保持 requestAnimationFrame 心跳 ----------
  // 浏览器在页面不可见时会停 rAF，导致依赖它的播放器逻辑停摆
  try {
    const tick = () => {
      try { window.requestAnimationFrame(tick); } catch (e) {}
    };
    tick();
  } catch (e) {}

  log('installed');
  return 'ok';
})()`;
}

/**
 * 给指定 page 的所有 frame 注入防御，并在新 frame 出现时补注入。
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{ok:number, failed:number}>}
 */
export async function installDefence(page) {
  const src = defenceSource();
  let ok = 0;
  let failed = 0;

  const injectFrame = async (frame) => {
    try {
      const r = await frame.evaluate(src);
      if (r === 'ok' || r === 'already') ok += 1;
      else failed += 1;
    } catch {
      failed += 1; // about:blank、跨域受限 frame 会失败，属正常
    }
  };

  for (const f of page.frames()) await injectFrame(f);

  // 新 frame（视频模块是懒加载的，会在播放前才创建）出现时补注入
  const onFrame = (f) => {
    injectFrame(f).catch(() => {});
  };
  page.on('frameattached', onFrame);
  page.on('framenavigated', onFrame);

  return { ok, failed };
}

/** 防御是否已生效（供自检用） */
export async function checkDefence(page) {
  const results = [];
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => ({
        installed: !!window.__xxtDefence,
        hidden: document.hidden,
        visibilityState: document.visibilityState,
      }));
      results.push({ url: f.url().slice(0, 90), ...r });
    } catch {
      /* 忽略无法访问的 frame */
    }
  }
  return results;
}
