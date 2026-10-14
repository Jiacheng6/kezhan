/**
 * 视频播放器驱动（P2）。
 *
 * 已探明的学习通视频结构：
 *   视频 iframe: /ananas/modules/video/index.html
 *     <video id="video_html5_api" class="vjs-tech">        ← 真实媒体元素
 *     .video-js / .vjs-big-play-button / .vjs-play-control  ← Video.js 控件
 *
 * 关键坑：视频是懒加载的，直接读 duration 是 null、readyState 为 0。
 *        必须先调用 video.load() 才会去拉元数据，之后才能播。
 *
 * 完成判据（学习通自己写在页面上）：
 *   "完成条件 观看时长需 ≥ 总时长的 90% (未完成任务点前, 当前视频不可拖拽)"
 */
import { installDefence } from '../browser/inject.mjs';
import { log } from '../logbus.mjs';
import { capturePause } from './capture.mjs';
import { findVideoQuiz } from './videoquiz.mjs';

/** 默认设置（后续由 settings 覆盖） */
const DEFAULTS = {
  muted: true, // 默认静音（用户要求）
  /*
   * 播放完成阈值 —— 这里有个重要的实测教训（改了三次才对）。
   *
   * 学习通页面上写的是「观看时长需 ≥ 总时长的 90%」，但**实际服务端不是按 90% 判的**。
   *
   * 播放进度响应与页面标记可能不同步：
   *   服务端通过状态、已播放时长与页面 aria 标记需要分别核对。
   *   服务端返回通过后，页面标记仍可能稍后才更新。
   *   完成阈值使用设置中的值，实际完成以服务端响应为准。
   *
   * 仅在临近片尾时停止，可能仍未达到服务器的完成条件；
   * 必须让它一直播到**片尾（duration-1 秒）**才稳。
   *
   * 结论：宁可多播最后几秒，也不要早停 —— 早停的代价是 3 次重试全废 + 转人工。
   * 所以默认按「距结束 1 秒」+ 99.9% 双保险，确保一定越过服务端判定线。
   */
  progressThreshold: 0.999,
  /** 距视频结束多少秒即视为播完（实测必须接近片尾） */
  finishMarginSec: 1,
  /**
   * 起播位置策略：**保持学习通给的位置，不拖拽**。
   *
   * 踩过的坑：曾经为了让"本会话播放时长"够长，主动把起播位置前移，
   * 并在绿点未变时回跳补播。结果两个都错 —— 见下方 allowSeek 说明。
   *
   * 所以：不 seek、不补播，老老实实播完，然后耐心等服务端生效。
   */
  allowSeek: false,
  /**
   * 播到片尾后耐心等服务端生效的时长。
   * 实测绿点延迟**不稳定**：短则 11 秒，长则超过 3 分钟。
   * 3.4（20分42秒）播完后等 3 分钟仍未生效，但事后一查早已变绿。
   * 所以放宽到 6 分钟，避免把"其实成功了"判成失败。
   */
  greenDotPatientMs: 360000,
  /** 绿点仍未生效时，额外复核的间隔 */
  greenDotPatientStepMs: 10000,
  /**
   * 纠偏上限。
   *
   * 实测教训：一次 21 分钟的视频在 25.9% 处被反复暂停、纠偏了 22 次，
   * 最后页面/浏览器死掉（Target page, context or browser has been closed），
   * 前面所有播放时间全废。可见"无限纠偏"是错的 —— 一直暂停说明环境已经不对，
   * 硬撑只会把页面拖死。现在改成小上限 + 暂停风暴检测：干净地失败，
   * 记下诊断信息，让人来判断。
   */
  maxResumeAttempts: 20,
  /** 这么多秒内纠偏达到 pauseStormCount 次 → 判定暂停风暴，直接放弃 */
  pauseStormWindowMs: 90000,
  pauseStormCount: 8,
  /** 视频从哪里开始算"真实播放"：起播位置超过这个比例就判定为"恢复了历史位置" */
  stalePositionThreshold: 0.05,
  /** 绿点核对失败后等待再复核的次数与间隔（上报有延迟） */
  greenDotRetries: 3,
  greenDotWaitMs: 8000,
};

/** 找到视频 iframe */
export function findVideoFrame(page) {
  return page.frames().find((f) => f.url().includes('/ananas/modules/video/')) || null;
}

/** 等待视频 iframe 出现（懒加载，可能要几秒） */
export async function waitVideoFrame(page, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = findVideoFrame(page);
    if (f) return f;
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * 等 <video> 元素真正出现并可用。
 *
 * 踩过的坑：frame 已存在但里面还没有 <video>（Video.js 异步初始化），
 * 只检查一次就会误报 no-video-element，尤其在连续跑多个视频时必现。
 */
export async function waitVideoElement(frame, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const has = await frame
      .evaluate(() => {
        const v = document.querySelector('video');
        return v ? { ok: true, readyState: v.readyState } : { ok: false };
      })
      .catch(() => ({ ok: false }));
    if (has.ok) return true;
    await frame.waitForTimeout(400).catch(() => {});
  }
  return false;
}

/**
 * 读取播放器状态。
 * @returns {Promise<object|null>} null 表示找不到 video 元素
 */
export async function getPlayerState(frame) {
  if (!frame) return null;
  try {
    return await frame.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return {
        readyState: v.readyState,
        networkState: v.networkState,
        // duration 可能是小数（如 529.4），不要跟着 currentTime 一起四舍五入，
        // 否则 Number.isFinite 判定会失手、日志出现 NaN
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        durationExact: Number.isFinite(v.duration) ? v.duration : null,
        currentTime: Math.round(v.currentTime * 100) / 100,
        paused: v.paused,
        ended: v.ended,
        muted: v.muted,
        volume: v.volume,
        playbackRate: v.playbackRate,
        error: v.error ? { code: v.error.code, message: String(v.error.message || '') } : null,
        bufferedEnd: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1)) : 0,
        // 页面可见性伪装是否生效（防御自检）
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        defence: !!window.__xxtDefence,
      };
    });
  } catch {
    return null;
  }
}

/**
 * 等 duration 就绪（元数据加载完成）。
 * @returns {Promise<number|null>} duration 秒数，失败返回 null
 */
export async function waitDuration(frame, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await frame
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      })
      .catch(() => null);
    if (d) return d;
    await frame.waitForTimeout(400).catch(() => {});
  }
  return null;
}

/**
 * 准备播放：注入防御 + load() 拉元数据 + 设置静音/倍速。
 * @returns {Promise<{ok:boolean, duration?:number, error?:string}>}
 */
export async function prepare(frame, page, settings = {}) {
  const cfg = { ...DEFAULTS, ...settings };

  // 防御要在播放前装好，否则一开始就可能被判"不可见"
  if (page) await installDefence(page);

  // 等 <video> 真正出现 —— Video.js 是异步初始化的，
  // 连续跑多个视频时若不等待，会稳定复现 no-video-element
  const hasVideo = await waitVideoElement(frame, cfg.videoElementTimeoutMs || 25000);
  if (!hasVideo) {
    return { ok: false, error: 'no-video-element（等待 25 秒后仍未出现）' };
  }

  const r = await frame
    .evaluate((opts) => {
      const v = document.querySelector('video');
      if (!v) return { ok: false, error: 'no-video-element' };

      // 懒加载：不 load 的话 duration 是 null
      try {
        if (!Number.isFinite(v.duration) || v.readyState === 0) v.load();
      } catch (e) {
        return { ok: false, error: `load failed: ${e.message}` };
      }

      // 固定 1.0 倍速（明确不做倍速）
      try {
        v.playbackRate = 1;
      } catch (e) {}
      // 静音（用户要求默认静音）
      try {
        v.muted = !!opts.muted;
      } catch (e) {}

      /*
       * 起播位置处理放到「元数据就绪之后」单独做（见下方 seekToStart）。
       * 这里先不动 currentTime —— 此时 duration 往往还是 NaN，seek 会失效。
       */
      return {
        ok: true,
        muted: v.muted,
        playbackRate: v.playbackRate,
        startAt: Math.round(v.currentTime),
      };
  }, {
    muted: cfg.muted,
  })
    .catch((e) => ({ ok: false, error: e.message }));

  if (!r.ok) return r;

  /*
   * 不做任何 seek。
   *
   * 学习通页面明写「未完成任务点前，当前视频不可拖拽」——
   * 程序化改 currentTime 同样会被它当作拖拽处理（实测 seek 后立即连续"被暂停"），
   * 反而破坏这条视频。而且实测证明完整播放本身就有效，不需要 seek 辅助。
   */
  const dur = await waitDuration(frame, 20000);
  if (!dur) {
    return { ok: false, error: '读不到视频时长（duration）' };
  }

  // 等元数据就绪
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 20000) {
    state = await getPlayerState(frame);
    if (state && Number.isFinite(state.duration) && state.duration > 0) break;
    await frame.waitForTimeout(400).catch(() => {});
  }

  if (!state || !state.duration) {
    return { ok: false, error: '视频元数据未就绪（duration 读不到）' };
  }

  // 注意：起播位置前移只在"位置太后"时才做，且必须**在读 duration 之后**再写回，
  // 否则设置会被随后的 load()/元数据加载重置掉。
  return {
    ok: true,
    duration: state.duration,
    muted: state.muted,
    playbackRate: state.playbackRate,
    defence: state.defence,
    hidden: state.hidden,
    resumedFrom: r.resumedFrom,
    note: r.note,
    startAt: r.startAt,
  };
}

/**
 * 开始播放。先试 video.play()，失败再点 Video.js 播放按钮。
 */
export async function play(frame) {
  // 优先直接调 play()（最可靠）
  const direct = await frame
    .evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return { ok: false, error: 'no-video' };
      try {
        await v.play();
        return { ok: true, how: 'video.play()' };
      } catch (e) {
        return { ok: false, error: e.message, how: 'video.play()' };
      }
    })
    .catch((e) => ({ ok: false, error: e.message }));

  if (direct.ok) return direct;

  // 兜底：点大播放按钮 / 控制栏播放键
  const clicked = await frame
    .evaluate(() => {
      const btn =
        document.querySelector('.vjs-big-play-button') ||
        document.querySelector('.vjs-play-control') ||
        document.querySelector('button[title="播放"]');
      if (!btn) return { ok: false, error: 'no-play-button' };
      btn.click();
      return { ok: true, how: 'click-play-button' };
    })
    .catch((e) => ({ ok: false, error: e.message }));

  return clicked.ok ? clicked : { ok: false, error: `${direct.error} / ${clicked.error}` };
}

export async function pause(frame) {
  return frame
    .evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.pause();
    })
    .catch(() => {});
}

/**
 * 播放守卫：发现"非自然结束的暂停"就纠偏。
 * 不劫持 pause()，只做温和 resume。
 * @returns {{resumed:boolean, reason?:string}}
 */
export async function guardResume(frame) {
  return frame
    .evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return { resumed: false, reason: 'no-video' };
      // 自然结束 或 已播到尾部 → 不纠偏
      if (v.ended) return { resumed: false, reason: 'ended' };
      if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.5) {
        return { resumed: false, reason: 'at-end' };
      }
      if (!v.paused) return { resumed: false, reason: 'playing' };

      // 真被暂停了 —— 记录当时页面可见性，便于诊断是谁干的
      const ctx = {
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        currentTime: Math.round(v.currentTime * 10) / 10,
        bufferEnd: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) * 10) / 10 : null,
      };
      try {
        await v.play();
        return { resumed: true, reason: 'was-paused', ctx };
      } catch (e) {
        return { resumed: false, reason: `play-failed: ${e.message}`, ctx };
      }
    })
    .catch((e) => ({ resumed: false, reason: `eval-failed: ${e.message}` }));
}

/** 进度比例 */
export function progressOf(state) {
  if (!state || !state.duration) return 0;
  return Math.min(1, state.currentTime / state.duration);
}

/**
 * 播放直到进度达标或超时。
 *
 * @param {object} opts
 * @param {import('playwright-core').Page} opts.page
 * @param {object} opts.settings
 * @param {Function} opts.onTick 每轮回调（用于推 UI）
 * @param {Function} opts.shouldStop 返回 true 则中止
 * @returns {Promise<object>} 结果摘要
 */
export async function watchUntilDone({ page, settings = {}, onTick, shouldStop, shared = {} }) {
  const cfg = { ...DEFAULTS, ...settings };
  const started = Date.now();
  let resumes = 0;
  const resumeTimes = [];
  let lastProgress = 0;
  let stuckRounds = 0;
  let maxProgress = 0;
  let lastTime = null;
  let jumpRounds = 0;
  const events = [];

  // 逐轮监控
  for (;;) {
    if (shouldStop && shouldStop()) {
      return { ok: false, stopped: true, reason: 'user-stop', progress: maxProgress, events };
    }

    /*
     * 弹窗题判不出来 / 需要人工作答 → 立刻交还控制权。
     * 别硬撑：视频停着等人答题才是正确姿势（tasks 会记「待人工」）。
     */
    if (shared.needsHuman) {
      return { ok: false, stopped: true, reason: 'quiz-needs-human', progress: maxProgress, resumes, events };
    }

    const frame = findVideoFrame(page);
    const state = await getPlayerState(frame);
    if (!state) {
      await page.waitForTimeout(1500);
      continue;
    }

    const p = progressOf(state);
    if (p > maxProgress) maxProgress = p;

    /*
     * 进度跳变检测（重要）：
     * 如果 currentTime 在一轮（约 2 秒）内增长远超墙钟时间，说明进度被"跳"过去了，
     * 而不是真实播放出来的。学习通很可能不认这种进度（实测出现过 6 秒到 90%、
     * 且绿点不翻的情况）。发现跳变就判定失败，避免"看起来跑完了其实白跑"。
     */
    if (lastTime != null) {
      const delta = state.currentTime - lastTime;
      const wallDelta = 2; // 监控间隔大致 2 秒
      if (delta > wallDelta * 3 + 5) {
        jumpRounds += 1;
        events.push({ t: Date.now(), type: 'progress-jump', from: lastTime, to: state.currentTime, delta });
        if (jumpRounds >= 2) {
          await pause(frame);
          return {
            ok: false,
            reason: 'progress-jumped',
            progress: p,
            currentTime: state.currentTime,
            duration: state.duration,
            resumes,
            elapsedSec: Math.round((Date.now() - started) / 1000),
            events,
          };
        }
      }
    }
    lastTime = state.currentTime;

    if (onTick) {
      onTick({
        currentTime: state.currentTime,
        duration: state.duration,
        progress: p,
        paused: state.paused,
        resumes,
        defence: state.defence,
        hidden: state.hidden,
      });
    }

    /*
     * 达标判定：必须播到片尾。
     *
     * 判据取"或"里**最晚**的那个 —— 实测早停会失败：
     *   97%(307/309s) 停 → 绿点不变
     *   播到 308.5s     → 绿点变「任务点已完成」
     * 所以默认 finishMarginSec=1 / progressThreshold=0.999。
     */
    const nearEnd =
      Number.isFinite(state.duration) && state.duration > 0
        ? state.duration - state.currentTime <= (cfg.finishMarginSec ?? 1)
        : false;

    if (p >= cfg.progressThreshold || nearEnd) {
      // 再多给 1.5 秒，让学习通把最后一次观看时长上报出去
      await page.waitForTimeout(1500);
      await pause(frame);
      return {
        ok: true,
        reason: nearEnd ? 'near-end' : 'threshold-reached',
        progress: p,
        currentTime: state.currentTime,
        duration: state.duration,
        resumes,
        elapsedSec: Math.round((Date.now() - started) / 1000),
        events,
      };
    }

    // 播完了但没到阈值（时长判定差异），也算结束
    if (state.ended) {
      return {
        ok: p >= cfg.progressThreshold,
        reason: 'ended',
        progress: p,
        currentTime: state.currentTime,
        duration: state.duration,
        resumes,
        elapsedSec: Math.round((Date.now() - started) / 1000),
        events,
      };
    }

    // 被暂停 → 纠偏
    if (state.paused) {
      /*
       * 视频弹窗题：站点自己暂停视频来出题（实测暂停调用栈就落在 video.js 里）。
       * 这个时候**绝不能**去"纠偏强推播放" —— 那等于替用户跳过这道题，
       * 既不礼貌也不安全。让播放监控冻结，等 videoquiz 协程答完再放开。
       *
       * 这里额外做一次**直接探测**（不依赖监听协程的时序）：
       * 万一监听协程还没来得及打标记，也不能把这道题跳过去。
       */
      if (!shared.quizOpen) {
        let hit = await findVideoQuiz(page).catch(() => null);
        /*
         * 弹窗的 DOM 有时比"暂停"晚一拍出现（实测：暂停瞬间还没插进 DOM，
         * 直接判"没有弹窗"就会把它当普通暂停纠偏过去，等于跳过了这道题）。
         * 所以再等一拍复查一次。
         */
        if (!hit) {
          await page.waitForTimeout(900);
          hit = await findVideoQuiz(page).catch(() => null);
        }
        if (hit) {
          shared.quizOpen = true;
          log(`    ⏸ 暂停原因：视频弹窗题（${hit.probe?.why || ''}），不再纠偏，等作答`, 'info');
        }
      }

      if (shared.quizOpen) {
        stuckRounds = 0;
        lastProgress = state.currentTime;
        if (onTick) onTick({ currentTime: state.currentTime, duration: state.duration, progress: p, paused: true, resumes, quizOpen: true, defence: state.defence, hidden: state.hidden });
        await page.waitForTimeout(2000);
        continue;
      }

      /*
       * 取证（XXT_CAPTURE=1 时开启）：被暂停的瞬间很可能正是弹窗题出现的时候，
       * 趁这个时候把现场抓下来，才知道真实弹窗长什么样。
       */
      if (process.env.XXT_CAPTURE && resumes < 4) {
        await capturePause(page, `pause-${(p * 100).toFixed(0)}pct`).catch(() => {});
      }

      if (resumes >= cfg.maxResumeAttempts) {
        events.push({ t: Date.now(), type: 'give-up', resumes });
        return {
          ok: false,
          reason: 'too-many-resumes',
          progress: p,
          resumes,
          elapsedSec: Math.round((Date.now() - started) / 1000),
          events,
        };
      }
      const g = await guardResume(frame);
      if (g.resumed) {
        resumes += 1;
        resumeTimes.push(Date.now());
        // 暂停风暴：短时间内反复被暂停 → 环境已经不对，别把页面拖死
        const win = resumeTimes.filter((t) => Date.now() - t <= (cfg.pauseStormWindowMs ?? 90000));
        events.push({ t: Date.now(), type: 'resumed', n: resumes, progress: p, ctx: g.ctx });
        log(
          `    播放被暂停，已纠偏（第 ${resumes} 次）于 ${(p * 100).toFixed(1)}%` +
            ` · hidden=${g.ctx?.hidden} hasFocus=${g.ctx?.hasFocus}`,
          'warn',
        );
        if (win.length >= (cfg.pauseStormCount ?? 8)) {
          log(
            `    ✗ 暂停风暴：${Math.round((cfg.pauseStormWindowMs ?? 90000) / 1000)} 秒内被暂停 ${win.length} 次，` +
              `判定环境异常，停止硬撑（进度 ${(p * 100).toFixed(1)}%）`,
            'error',
          );
          await pause(frame);
          return {
            ok: false,
            reason: 'pause-storm',
            progress: p,
            resumes,
            elapsedSec: Math.round((Date.now() - started) / 1000),
            lastPauseCtx: g.ctx,
            events,
          };
        }
      }
    }

    // 进度停滞检测（网络卡住 / 被限流）
    if (Math.abs(state.currentTime - lastProgress) < 0.3) {
      stuckRounds += 1;
      if (stuckRounds >= 20) {
        events.push({ t: Date.now(), type: 'stuck', at: state.currentTime });
        return {
          ok: false,
          reason: 'progress-stuck',
          progress: p,
          currentTime: state.currentTime,
          resumes,
          elapsedSec: Math.round((Date.now() - started) / 1000),
          events,
        };
      }
    } else {
      stuckRounds = 0;
      lastProgress = state.currentTime;
    }

    await page.waitForTimeout(2000);
  }
}
