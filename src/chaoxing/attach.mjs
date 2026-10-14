/**
 * 读取「小节卡片页上的任务点状态」—— 视频 / 文档 / 测验三条路共用。
 *
 * 单独成模块的原因：`quizrun.mjs` 也要用，而 `runner.mjs` 反过来要 import
 * `quizrun.mjs`（`registerKeptPage`）—— 直接互相 import 会形成循环依赖。
 * 这些函数是纯粹"读页面"的，没有任何执行器依赖，放这里两边都能干净地用。
 */
import { waitForAttachments } from './section.mjs';

/**
 * 预检查：这个视频到底有没有"任务点追踪"？
 *
 * 实测的两种数据形态（关键区别）：
 *
 *   真任务点：
 *     .ans-attach-ct + .ans-job-icon[aria-label="任务点未完成"]
 *     iframe[data] = {objectid, name, hsize, size, type, mid,
 *                     _jobid, jobid, fastforward, doublespeed}   ← 有 jobid
 *
 *   纯内容附件（不是任务点）：
 *     .ans-attach-ct.videoContainer，**没有 .ans-job-icon**
 *     iframe[data] = {objectid, name, type, size, hsize, mid,
 *                     _jobid, fastforward, doublespeed, ywbf}     ← 只有 _jobid
 *
 * `_jobid` 是附件 id，`jobid` 才是任务点 id —— 别把前者当后者。
 * 判据：有 .ans-job-icon **或** 有 jobid 才算任务点。
 *
 * 重要：`.ans-attach-ct` 在 **cards 父文档**里，不在视频 iframe 内
 * （视频 iframe 是 /ananas/modules/video/ 跨域子帧）。所以要在父 frame 上查，
 * 否则永远得到"列表尚未渲染"的 null 结论，导致非任务点被当任务点白播。
 *
 * @param {import('playwright-core').Frame} frame 任务点所在的 frame（cards 页），
 *        传视频 iframe 也行 —— 会自动向上找父 frame
 * @returns {{hasTracking:boolean|null, aria, jobid, alreadyFinished, via, reason?}}
 */
export async function checkTaskTracking(frame, taskName) {
  // 若传进来的是视频子帧，往上找到真正含附件列表的父 frame
  let host = frame;
  for (let i = 0; i < 3 && host; i += 1) {
    const n = await host.evaluate(() => document.querySelectorAll('.ans-attach-ct').length).catch(() => 0);
    if (n > 0) break;
    host = host.parentFrame();
  }
  if (!host) return { hasTracking: null, reason: '找不到含附件列表的 frame', via: 'no-host' };

  return host
    .evaluate((name) => {
      const list = Array.from(document.querySelectorAll('.ans-attach-ct'));

      const metaOf = (ct) => {
        try {
          return JSON.parse(ct.querySelector('iframe')?.getAttribute('data') || '{}');
        } catch {
          return {};
        }
      };

      const judge = (ct) => {
        const icon = ct.querySelector('.ans-job-icon');
        const d = metaOf(ct);
        return {
          hasTracking: !!icon || !!d.jobid,
          aria: icon?.getAttribute('aria-label') || null,
          jobid: d.jobid || null,
          alreadyFinished:
            /已完成/.test(icon?.getAttribute('aria-label') || '') ||
            /ans-job-finished/.test(String(ct.className)),
        };
      };

      // 页面还没渲染出任务点列表 → 让上层稍后重试（不要武断下结论）
      if (!list.length) {
        return { hasTracking: null, reason: '任务点列表尚未渲染', via: 'pending' };
      }

      // 按文件名精确匹配（同一小节可能有多个任务点）
      if (name) {
        for (const ct of list) {
          if (metaOf(ct).name === name) {
            return { ...judge(ct), via: 'name-match', sectionAttachCount: list.length };
          }
        }
      }

      // 只有一个附件时直接判定
      if (list.length === 1) {
        return { ...judge(list[0]), via: 'single-attach', sectionAttachCount: 1 };
      }

      /*
       * 多附件且没匹配到名字：这个视频不在任务点列表里 → 判定为非任务点。
       * 之前这里走"宽容"策略（拿第一个带 job-icon 的当替身），结果是
       * 把 23 个纯视频附件的小节误判为"有追踪"，白播 83 秒还确认不了绿点。
       */
      return {
        hasTracking: false,
        reason: `该小节 ${list.length} 个附件中未找到此视频对应的任务点`,
        via: 'no-match',
        sectionAttachCount: list.length,
      };
    }, taskName)
    .catch((e) => ({ hasTracking: null, reason: `预检查异常: ${e.message}`, via: 'error' }));
}

/**
 * 视频模块自己的进度记录（**服务端权威**，比页面 aria 可靠）。
 *
 * 为什么必须读它：
 *   页面 aria 可能仍显示「任务点未完成」，
 *   但视频模块的记录已经返回 `isPassed=true`，
 *   播放时长与续播位置也表明已完成——服务器已认定通过，
 *   只是卡片页的 aria / 章节树没刷新。
 *   只信 aria 可能导致重复播放已完成的视频。
 *
 * ⚠ 单位坑：`playTime` 是**毫秒**，而 `attDuration` 是**秒×1000 的整数**
 *   例如一方以毫秒、另一方以秒返回，直接相除会放大结果，
 *   所以这里统一换算成"比例"，两种量纲都认。
 */

/** 把 playTime/attDuration 归一成 0~1 的比例（两者量纲可能不同） */
export function watchedRatio(playTime, attDuration) {
  const p = Number(playTime);
  const d = Number(attDuration);
  if (!Number.isFinite(p) || !Number.isFinite(d) || p <= 0 || d <= 0) return null;
  // attDuration 可能使用秒或毫秒两种量纲。
  const dMs = d * 1000 < p ? d * 1000 : d;
  return Math.min(1, p / dMs);
}

/**
 * 由视频模块记录判断"这条视频到底过没过"。
 * @returns {{finished:boolean|null, ratio:number|null, note:string}}
 *   finished=null 表示读不出结论，交给上层兜底
 */
export function videoPassedVerdict({ found, isPassed, playTime, attDuration } = {}) {
  if (!found) return { finished: null, ratio: null, note: '页面上没有视频模块记录' };
  const ratio = watchedRatio(playTime, attDuration);
  if (isPassed === true) {
    return { finished: true, ratio, note: `服务端已判通过（已记录 ${ratio === null ? '?' : (ratio * 100).toFixed(1) + '%'}）` };
  }
  if (isPassed === false) {
    return {
      finished: false,
      ratio,
      note: `服务端尚未判通过（已记录 ${ratio === null ? '?' : (ratio * 100).toFixed(1) + '%'}）`,
    };
  }
  return { finished: null, ratio, note: '视频模块记录里没有 isPassed 字段' };
}

/**
 * 读当前页面上视频模块的记录（在 cards 父帧或视频子帧里找 `mArg`）。
 * @returns {Promise<{found:boolean, isPassed?:boolean, playTime?:number, attDuration?:number, headOffset?:number, name?:string}>}
 */
export async function readVideoModuleRecord(page) {
  const readFn = () => {
    const m = window.mArg || window.__mArg || null;
    if (!m) return { found: false };
    const a = (m.attachments || [])[0] || null;
    if (!a) return { found: false };
    return {
      found: true,
      isPassed: a.isPassed,
      playTime: a.playTime,
      attDuration: a.attDuration,
      headOffset: a.headOffset,
      name: a.name || null,
    };
  };

  const fromPage = await page.evaluate(readFn).catch(() => ({ found: false }));
  if (fromPage.found) return fromPage;

  for (const f of page.frames()) {
    if (!/ananas\/modules\/video|modules\/video/.test(f.url())) continue;
    const got = await f.evaluate(readFn).catch(() => ({ found: false }));
    if (got.found) return got;
  }
  return { found: false };
}

/**
 * 在**已经打开的小节卡片页**上读本任务点的状态。
 *
 * 三层判据，从可靠到兜底：
 *   ① 视频模块记录 `isPassed`（服务端权威；页面 aria 可能过期 —— 见上面的说明）
 *   ② 卡片附件自己的 `.ans-job-icon[aria-label=已完成]` / `.ans-job-finished`
 *   ③ 读不出来 → finished=null，交给上层（不武断）
 *
 * 抽出来是为了让"要不要跳过"的判断零额外开销：视频/文档执行器本来就会打开
 * 卡片页，测验执行器也会 —— 直接在同一个页面上读，不必再开一个页面。
 *
 * @returns {Promise<{finished:boolean|null, via:string, aria?:string, attachCount?:number, error?:string}>}
 */
export async function readPointStatusFromPage(page, taskName, { isVideo = false } = {}) {
  await waitForAttachments(page);
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = await checkTaskTracking(page, taskName);
    if (last.hasTracking !== null) break;
    await page.waitForTimeout(500);
  }
  if (!last || last.hasTracking === null) {
    return { finished: null, via: last?.via || 'pending', error: last?.reason || '任务点列表未渲染' };
  }

  /*
   * 视频：先看视频模块的服务端记录。
   * 实测踩到 —— 页面 aria 说"任务点未完成"，而模块记录 isPassed=true、
   * 播放量 100%，于是视频被反复重播。以模块记录为准。
   */
  let videoNote = null;
  if (isVideo) {
    const rec = await readVideoModuleRecord(page).catch(() => ({ found: false }));
    const v = videoPassedVerdict(rec);
    videoNote = v.note;
    if (v.finished === true) {
      return { finished: true, via: 'video-module', videoRecord: rec, note: v.note, aria: last.aria || null };
    }
    // 模块明确说没过 → 也别用 aria 的"已完成"去推翻它，但要如实报告
    if (v.finished === false && last.alreadyFinished) {
      return {
        finished: false,
        via: 'video-module',
        videoRecord: rec,
        note: `${v.note}（页面 aria 显示已完成，以服务端记录为准）`,
        aria: last.aria || null,
      };
    }
  }

  return {
    finished: !!last.alreadyFinished,
    via: last.via || 'attach',
    aria: last.aria || null,
    attachCount: last.sectionAttachCount ?? null,
    note: videoNote || undefined,
  };
}
