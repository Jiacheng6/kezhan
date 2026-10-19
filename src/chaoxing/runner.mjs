/**
 * 执行器（P2）：把一个任务点跑完。
 *
 * 单一任务点流程：
 *   1) 打开该小节的 cards 页（已验证可独立加载，不需 enc）
 *   2) 装抗失焦防御
 *   3) 进视频 iframe → load() → 播放 → 监控到 ≥90%
 *   4) 回章节树核对绿点（第二重确认）
 *
 * 只做视频/文档两类；作业、讨论、直播一律不碰（按用户决策）。
 */
import { applyNativeSpeed, watchWithCheckpoint } from './playback-policy.mjs';
import { PATHS, loadSettings } from '../config.mjs';
import { waitForRead } from '../control.mjs';
import { log } from '../logbus.mjs';
import { setTaskStatus, getTaskStatus, isTaskDone, addHandbook } from '../state.mjs';
import { installDefence, checkDefence } from '../browser/inject.mjs';
import { newTaskPage, releasePage } from '../browser/pages.mjs';
import { watchPopups } from './popup.mjs';
import { watchVideoQuiz } from './videoquiz.mjs';
import { registerKeptPage } from './quizrun.mjs';
import { cardsUrl, openSectionCard, waitForAttachments } from './section.mjs';
import { checkTaskTracking, readPointStatusFromPage } from './attach.mjs';
import { skipDecision, describeSkip } from './skip.mjs';

/*
 * 转发导出：这两个函数搬去了 `attach.mjs`（为了让 quizrun 也能用而不形成循环依赖），
 * 但仍从 runner 导出，老的调用方（如 `tools/diag/diag-track.mjs`）不用改。
 */
export { checkTaskTracking, readPointStatusFromPage };
import {
  findVideoFrame,
  waitVideoFrame,
  getPlayerState,
  prepare,
  play,
  pause,
  watchUntilDone,
  progressOf,
} from './player.mjs';

/**
 * 「本任务点完成了吗」的核对入口在下面 —— `verifyTaskCompletion`（任务点级为主、
 * 小节绿点兜底）。
 *
 * ⚠ 这里曾经有一个 `checkGreenDotFast()`：只读**小节绿点**、拿它当"本任务点是否完成"。
 * 那正是"一直重复视频"的元凶 —— 小节里有视频 + 章节测验两项时，视频播完小节也不会绿，
 * 于是视频被判未完成、反复重播。已删除，别再写"只看小节绿点"的判定。
 */

/** 任务点类型 → 是否由执行器处理 */
export const HANDLED_TYPES = new Set(['video', 'doc', 'read', 'work', 'discuss']);

/** 组装章节树页 URL（用于核对绿点） */
export function treeUrl({ courseId, clazzId, personId }) {
  return `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseId}&clazzid=${clazzId}&cpi=${personId}&ismooc2=1&v=2`;
}

/**
 * 读取某个小节在章节树上的完成状态（绿点 = 已完成）。
 *
 * ⚠ 字段名有历史误导性：`jobTotal` 取的 `input.knowledgeJobCount` 实测是
 *   **未完成的任务点数**（已全绿的小节该 input 为 null；未完成的小节值=待完成数）。
 *   别拿它推算"这个小节一共有几个任务点" —— 早期在侦察里这么用，
 *   导致"视频已完成 + 章节测验未完成"的小节漏读了测验（见 recon.nextCardDecision）。
 *
 * @returns {Promise<{done:boolean|null, jobTotal:number|null, jobPending:number|null, sectionName:string}>}
 */
export async function readSectionStatus(ctx, { courseId, clazzId, personId, knowledgeId }) {
  const page = await newTaskPage(ctx, 'view-status');
  page.on('dialog', (d) => d.accept().catch(() => {}));
  try {
    await page.goto(treeUrl({ courseId, clazzId, personId }), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(2500);

    // 章节树可能不是默认标签
    let frame = await waitTree(page, 6000);
    if (!frame) {
      await page.locator('li[dataname="zj"]').first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2000);
      frame = await waitTree(page, 20000);
    }
    if (!frame) return { done: null, error: '章节树未就绪' };

    return await frame.evaluate((kid) => {
      const el = document.getElementById(`cur${kid}`);
      if (!el) return { done: null, error: '找不到该小节' };
      const stateCls = String(el.querySelector('.catalog_state')?.className || '');
      const tip = (el.querySelector('.bntHoverTips')?.textContent || '').trim();
      const jobInput = el.querySelector('input.knowledgeJobCount');
      const pending = tip.match(/(\d+)\s*个待完成/);
      return {
        done: /icon_yiwanc/.test(stateCls),
        stateClass: stateCls,
        tipText: tip,
        jobTotal: jobInput ? Number(jobInput.getAttribute('value')) : null,
        jobPending: pending ? Number(pending[1]) : null,
        sectionName: el.getAttribute('title') || '',
      };
    }, knowledgeId);
  } finally {
    await page.close().catch(() => {});
    releasePage(page);
  }
}

async function waitTree(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      if (!f.url().includes('mycourse/studentcourse')) continue;
      const n = await f.evaluate(() => document.querySelectorAll('.chapter_item').length).catch(() => 0);
      if (n > 0) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 判定「本次这个任务点」是否已完成 —— **任务点级**判据。
 *
 * 为什么必须与"小节绿点"分开（用户实测反馈，本项目最贵的坑之一）：
 *   学习通的小节只有**它下面所有任务点都完成**才会变绿。
 *   一个小节里有两项（视频 + 章节测验）时，视频播完小节照样不绿 ——
 *   早期拿小节绿点判视频是否完成，于是：
 *     视频播完 → 小节不绿 → 判"未完成" → 内联重试 → **把视频又播一遍**，
 *     章节测验永远轮不到，用户看到的就是"一直重复视频"。
 *   而代码其实早就读到了小节提示里的"N 个待完成"，只是没拿它做判断。
 *
 * 判据：在该小节的卡片附件列表里按名字找到本任务点，看它自己的
 *   `.ans-job-icon[aria-label="已完成"]` 或 `.ans-job-finished` 类。
 *
 * @returns {Promise<{finished:boolean|null, via:string, aria?:string, attachCount?:number, error?:string}>}
 *   finished === null 表示"读不出结论"（列表没渲染 / 名字对不上），由上层兜底，别武断
 */
export async function checkPointFinished(ctx, task, personId) {
  const page = await newTaskPage(ctx, 'verify-point');
  page.on('dialog', (d) => d.accept().catch(() => {}));
  try {
    if(task.type==='discuss'){
      const {readDiscussionPointStatus}=await import('./discussion-page.mjs');
      await page.goto(cardsUrl({...task,personId,cardNum:task.cardNum??0}),{waitUntil:'domcontentloaded',timeout:60000});
      await waitForAttachments(page);
      const deadline=Date.now()+8000;let result;
      do{result=await readDiscussionPointStatus(page,task);if(result.finished===true||result.hasTracking===false)break;await page.waitForTimeout(250);}while(Date.now()<deadline);
      return result;
    }
    const card = await openSectionCard(page, task, personId, {
      maxCards: loadSettings().maxCardProbe ?? 6,
      quiet: true,
    });
    if (card.notFound) return { finished: null, via: 'no-attach', error: '该小节没读到任务点列表' };
    return await readPointStatusFromPage(page, task.name, { isVideo: task.type === 'video' });
  } catch (err) {
    return { finished: null, via: 'error', error: err.message };
  } finally {
    await page.close().catch(() => {});
    releasePage(page);
  }
}

/**
 * 核对"这个任务点到底完成没有" —— 任务点级为主，小节绿点兜底。
 *
 * 两个信号的关系：
 *   · 任务点级（本点自己的已完成标记）—— 正确判据，小节里还有别的任务点时也准
 *   · 小节绿点（整节全绿）—— 全绿必然蕴含本点完成，作为兜底与佐证
 * 任一为真即算完成；两者都读不出来才算"没完成"。
 *
 * @param {object} opts
 * @param {number} [opts.totalBudgetMs] 总等待预算（超时即返回未完成）
 * @param {number} [opts.intervalMs] 轮询间隔
 * @param {(info:object)=>void} [opts.onWait] 每轮未完成时回调（用于打日志）
 * @returns {Promise<{done:boolean, via:'task-point'|'section-green'|null, point:object|null, section:object|null, waitedSec:number}>}
 */
export async function verifyTaskCompletion({
  ctx,
  task,
  personId,
  totalBudgetMs = 24000,
  intervalMs = 8000,
  onWait = null,
  shouldStop = () => false,
  deps = null, // 测试注入：{ checkPointFinished, readSectionStatus }
} = {}) {
  const checkPoint = deps?.checkPointFinished || checkPointFinished;
  const readStatus = deps?.readSectionStatus || readSectionStatus;
  const ids = { courseId: task.courseId, clazzId: task.clazzId, personId, knowledgeId: task.knowledgeId };
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  let point = null;
  let section = null;
  const stopped = () => ({ done: false, stopped: true, via: null, point, section, waitedSec: secs() });
  const read = (operation) => waitForRead(operation, { shouldStop, timeoutMs: 60000, message: '完成状态读取超时' });
  const sectionRead = () => read(() => readStatus(ctx, ids)).catch((err) => {
    if (err.code === 'STOPPED') throw err;
    return null;
  });

  try {
  for (let round = 1; ; round += 1) {
    if (shouldStop()) return stopped();
    point = await read(() => checkPoint(ctx, task, personId));
    if (point.finished === true) {
      /*
       * 本任务点已完成 —— 但这里**特意再读一次小节状态**（多开一个页面，相对
       * 一条几十分钟的视频可以忽略）：只为在日志里说清"小节还有几项没做完、
       * 所以它不会变绿"。用户就是因为看到"小节不绿"才以为程序卡住了。
       */
      if (!section && !shouldStop()) section = await sectionRead();
      return { done: true, via: 'task-point', point, section, waitedSec: secs() };
    }
    if (shouldStop()) return stopped();

    /*
     * 读不出任务点级结论时，用小节绿点兜底；
     * 读得出"未完成"时也隔几轮取一次小节状态 —— 只为在日志里说清"还差几个"，
     * 顺带覆盖"小节全绿但本点标记没刷新"的情况。
     */
    if (point.finished === null || round === 1 || round % 3 === 0) {
      section = await sectionRead();
      if (section && section.done === true) {
        return { done: true, via: 'section-green', point, section, waitedSec: secs() };
      }
    }
    if (shouldStop()) return stopped();

    const elapsed = Date.now() - t0;
    if (elapsed + intervalMs > totalBudgetMs) {
      return { done: false, via: null, point, section, waitedSec: secs() };
    }
    if (onWait) onWait({ round, waitedSec: secs(), point, section });
    const waitUntil = Date.now() + intervalMs;
    while (Date.now() < waitUntil) {
      if (shouldStop()) return stopped();
      await new Promise((r) => setTimeout(r, Math.min(100, waitUntil - Date.now())));
    }
  }
  } catch (err) {
    // 已读到权威的完成标记时，取消补读说明不能丢掉完成记录。
    if (err.code === 'STOPPED' && point?.finished === true) return { done: true, via: 'task-point', point, section, waitedSec: secs() };
    if (err.code === 'STOPPED') return stopped();
    throw err;
  }
}

/**
 * 把"完成核对"的结论翻译成人类可读的一句话 —— 尤其要点明
 * **小节不绿不等于本任务点没完成**（这正是"一直重复视频"的误解来源）。
 */
export function describeCompletion(verdict, task) {
  const sec = verdict.section;
  const pending = sec && typeof sec.jobPending === 'number' ? sec.jobPending : null;
  if (verdict.done && verdict.via === 'task-point') {
    if (pending && pending > 0) {
      return `本任务点已完成；该小节还有 ${pending} 个任务点待完成（小节要等它们都做完才变绿，与本次任务无关）`;
    }
    return '本任务点已完成';
  }
  if (verdict.done) return '小节已全绿（本任务点必然完成）';
  if (verdict.point && verdict.point.finished === false) {
    return `本任务点仍未标记完成（${sec?.tipText || verdict.point.aria || '学习通未更新'}）`;
  }
  return `完成状态读不出来（${verdict.point?.error || sec?.error || '未知原因'}）`;
}

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
/**
 * 跑一个「文档 / PPT / 阅读材料」类任务点。
 *
 * 策略（用户第 9 问决策：只做"点开即完成"的类型）：
 *   打开小节 → 确认任务点存在 → 停留若干秒（触发学习通的浏览上报）
 *   → 核对绿点。若没变就多等一轮；仍不变则转「待人工」，不硬刷。
 *
 * 不做的事：不模拟滚动到文末（部分文档有时长/翻页要求，规则不确定，
 * 硬刷容易产生异常记录，交给人工更稳）。
 */
export async function runDocTask({ ctx, task, personId, onProgress, shouldStop }) {
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
    greenDot: null,
    elapsedSec: 0,
    error: null,
  };

  const page = await newTaskPage(ctx, 'doc');
  page.on('dialog', (d) => d.accept().catch(() => {}));

  try {
    // 先看本地记录 / 侦察快照（省一次开页）—— 口径统一在 skip.mjs
    const pre = skipDecision({ task, stateStatus: getTaskStatus(task.key)?.status });
    if (pre.skip) {
      result.phase = 'already-finished';
      result.ok = true;
      result.greenDot = true;
      result.skippedBecause = pre.source;
      result.skipReason = pre.reason;
      log(`    ${describeSkip(pre)}`, 'ok');
      return result;
    }

    result.phase = 'open-section';
    log(`    打开小节：${task.secNo} ${task.sectionName}`, 'info');
    const card = await openSectionCard(page, task, personId, { maxCards: settings.maxCardProbe ?? 6 });
    result.cardNum = card.cardNum;
    // 卡片序号的日志已在 openSectionCard 里打过，这里不重复
    if (card.notFound) {
      log(`    ? 该小节的卡片里没读到任何任务点（试了 ${card.cardsProbed} 张）`, 'warn');
    }

    // 等任务点渲染（懒加载；抢跑会把真任务点误判成"没有追踪"）
    const attachCount = await waitForAttachments(page);
    if (!attachCount) throw new Error('小节里没有渲染出任务点');

    await installDefence(page);

    // 确认这个任务点确实存在（用名称匹配），并读它的类型与状态
    const info = await page.evaluate((name) => {
      const list = Array.from(document.querySelectorAll('.ans-attach-ct'));
      const metaOf = (ct) => {
        try {
          return JSON.parse(ct.querySelector('iframe')?.getAttribute('data') || '{}');
        } catch {
          return {};
        }
      };
      let hit = list.find((ct) => metaOf(ct).name === name) || (list.length === 1 ? list[0] : null);
      if (!hit) return { found: false, total: list.length };
      const icon = hit.querySelector('.ans-job-icon');
      const ifr = hit.querySelector('iframe');
      return {
        found: true,
        total: list.length,
        hasJobIcon: !!icon,
        jobid: metaOf(hit).jobid || null,
        aria: icon?.getAttribute('aria-label') || null,
        finished: /ans-job-finished/.test(String(hit.className)) || /已完成/.test(icon?.getAttribute('aria-label') || ''),
        iframeSrc: (ifr?.getAttribute('src') || '').slice(0, 100),
      };
    }, task.name);

    result.taskPoint = info;

    if (!info.found) {
      result.phase = 'no-tracking';
      result.error = `该小节 ${info.total} 个附件中未找到此任务点`;
      log(`    ⊘ ${result.error}`, 'warn');
      return result;
    }
    if (!info.hasJobIcon && !info.jobid) {
      result.phase = 'no-tracking';
      result.error = '该内容不是任务点（无完成度追踪）';
      log(`    ⊘ ${result.error}`, 'warn');
      return result;
    }
    if (info.finished) {
      const d = skipDecision({ task, stateStatus: getTaskStatus(task.key)?.status, pointFinished: true });
      result.phase = 'already-finished';
      result.ok = true;
      result.greenDot = true;
      result.skipReason = d.reason;
      log(`    ${describeSkip(d)}`, 'ok');
      return result;
    }

    // 停留，触发浏览上报
    result.phase = 'dwelling';
    const dwellSec = settings.docDwellSec ?? 12;
    log(`    停留 ${dwellSec} 秒以触发完成上报…`, 'info');
    for (let i = 0; i < dwellSec; i += 1) {
      if (shouldStop && shouldStop()) {
        result.phase = 'stopped';
        result.error = '被用户中止';
        return result;
      }
      if (onProgress) onProgress({ progress: (i + 1) / dwellSec, phase: 'dwelling' });
      await page.waitForTimeout(1000);
    }

    // 核对完成状态（带复核）—— 判据与视频一致：任务点级为主，小节绿点兜底
    result.phase = 'verify-green-dot';
    await page.close().catch(() => {});
    releasePage(page);
    const verdict = await verifyTaskCompletion({
      ctx,
      task,
      personId,
      totalBudgetMs: (settings.greenDotRetries ?? 3) * (settings.greenDotWaitMs ?? 8000),
      intervalMs: settings.greenDotWaitMs ?? 8000,
    });
    result.greenDot = verdict.done;
    result.greenVia = verdict.via;
    result.sectionStatus = verdict.section || null;

    if (verdict.done) {
      result.ok = true;
      result.phase = 'done';
      log(`    ✓ ${describeCompletion(verdict, task)}`, 'ok');
    } else {
      result.error = `${describeCompletion(verdict, task)} —— 转「待人工」（不硬刷）`;
      log(`    ! ${result.error}`, 'warn');
    }
    return result;
  } catch (err) {
    result.error = err.message;
    log(`    ✗ 失败：${err.message}`, 'error');
    return result;
  } finally {
    result.elapsedSec = Math.round((Date.now() - started) / 1000);
    try {
      const prev = getTaskStatus(task.key) || {};
      const writeIfNotDone = (patch) => {
        if (prev.status === 'done') return;
        setTaskStatus(task.key, { ...patch, name: task.name, secNo: task.secNo });
      };
      if (result.phase === 'done' || result.phase === 'already-finished') {
        setTaskStatus(task.key, {
          status: 'done',
          greenDot: result.greenDot ?? true,
          elapsedSec: result.elapsedSec,
          name: task.name,
          secNo: task.secNo,
          finishedAt: prev.finishedAt || new Date().toISOString(),
        });
      } else if (result.phase === 'no-tracking') {
        writeIfNotDone({ status: 'done', note: '非任务点（无完成度追踪），无需处理' });
      } else if (result.phase === 'stopped') {
        writeIfNotDone({ status: 'pending', note: '被用户中止' });
      } else {
        writeIfNotDone({ status: 'failed', lastError: result.error });
      }
    } catch {
      /* 落盘失败不影响返回 */
    }
    await page.close().catch(() => {});
    releasePage(page);
  }
}

/**
 * 跑一个视频任务点。
 *
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} opts.ctx
 * @param {object} opts.task  执行清单里的一条任务点（含 courseId/clazzId/knowledgeId/name 等）
 * @param {string} opts.personId
 * @param {Function} opts.onProgress 进度回调
 * @param {Function} opts.shouldStop 中止判据
 */
export async function runVideoTask({ ctx, task, personId, onProgress, shouldStop, qianwenPage = null }) {
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
    progress: 0,
    durationSec: null,
    elapsedSec: 0,
    resumes: 0,
    greenDot: null,
    error: null,
    events: [],
  };

  const page = await newTaskPage(ctx, 'video');
  page.on('dialog', (d) => d.accept().catch(() => {}));

  try {
    // —— 0) 已完成的直接跳过（断点续跑的关键）——
    // 判据用 state.json 里的记录，而不是清单 —— 清单是侦察时的快照，
    // 跑过之后不会自动刷新，靠它会重复刷已完成的视频。
    // （口径统一在 skip.mjs；更权威的"学习通实时标记"在下面打开卡片后再读一次。）
    const pre = skipDecision({ task, stateStatus: getTaskStatus(task.key)?.status });
    if (pre.skip) {
      result.phase = 'already-finished';
      result.ok = true;
      result.greenDot = true;
      result.skippedBecause = pre.source;
      result.skipReason = pre.reason;
      log(`    ${describeSkip(pre)}`, 'ok');
      return result;
    }

    // —— 1) 打开小节（自动在多张卡片里找到含本任务点的那张）——
    result.phase = 'open-section';
    log(`    打开小节：${task.secNo} ${task.sectionName}`, 'info');
    const card = await openSectionCard(page, task, personId, { maxCards: settings.maxCardProbe ?? 6 });
    result.cardNum = card.cardNum;
    result.cardsProbed = card.cardsProbed;
    // 卡片序号的日志已在 openSectionCard 里打过，这里不重复
    if (card.notFound) {
      log(`    ? 该小节的卡片里没读到任何任务点（试了 ${card.cardsProbed} 张）`, 'warn');
    }

    // 等任务点渲染出来（懒加载，抢跑会读到 0 个附件导致误判"无追踪"）
    await waitForAttachments(page);

    // —— 2) 装防御 ——
    result.phase = 'install-defence';
    const def = await installDefence(page);
    const defCheck = await checkDefence(page);
    result.defence = { injected: def, frames: defCheck };

    // —— 3) 准备视频 ——
    result.phase = 'prepare-video';
    const frame = await waitVideoFrame(page, 25000);
    if (!frame) throw new Error('视频 iframe 未出现（该任务点可能不是视频，或页面改版）');

    // —— 3.5) 预检查：有没有任务点追踪 ——
    // 放在 prepare() 之前：不是任务点就不必 load、更不必播几十分钟。
    // hasTracking 为 null 表示页面还没渲染好，轮询等一下再判。
    let track = null;
    for (let i = 0; i < 12; i += 1) {
      track = await checkTaskTracking(frame, task.name);
      if (track.hasTracking !== null) break;
      await page.waitForTimeout(500);
    }
    result.tracking = track;

    if (track.hasTracking === false) {
      result.phase = 'no-tracking';
      result.error = `不是任务点（无完成度追踪）${track.reason ? ` —— ${track.reason}` : ''}`;
      log(`    ⊘ 跳过：${result.error}`, 'warn');
      return result;
    }
    if (track.hasTracking === null) {
      // 仍然判不出来 —— 保守起见按任务点处理（宁可多播，也不误跳真实任务点）
      log(`    ? 追踪预检查仍未判定（${track.reason}），按正常流程继续`, 'warn');
    }
    /*
     * 跳过判断：**服务端记录优先**。
     *
     * 这里曾经只看 `track.alreadyFinished`（页面 aria）—— 实测踩到：
     * aria 说"任务点未完成"，而视频模块记录 `isPassed=true`、播放量 100%，
     * 于是这条 23 分钟的视频被反复重播。aria 是会过期的缓存渲染，
     * 服务端记录才是权威。`readPointStatusFromPage(isVideo:true)` 两层都读，
     * 冲突时以服务端记录为准。
     */
    const pointStatus = await readPointStatusFromPage(page, task.name, { isVideo: true });
    result.pointStatus = pointStatus;
    const d = skipDecision({
      task,
      stateStatus: getTaskStatus(task.key)?.status,
      pointFinished: pointStatus.finished,
    });
    if (d.skip) {
      result.phase = 'already-finished';
      result.ok = true;
      result.greenDot = true;
      result.skippedBecause = d.source;
      result.skipReason = d.reason;
      log(`    ${describeSkip(d)}${pointStatus.note ? `（${pointStatus.note}）` : ''}`, 'ok');
      return result;
    }

    const prep = await prepare(frame, page, { muted: settings.muted });
    if (!prep.ok) throw new Error(`视频准备失败：${prep.error}`);

    result.durationSec = prep.duration;
    result.muted = prep.muted;
    result.phase = 'playing';
    if (prep.note) log(`    ! ${prep.note}`, 'warn');

    const mm = Math.floor((prep.duration || 0) / 60);
    const ss = Math.round((prep.duration || 0) % 60);
    log(
      `    时长 ${mm}分${ss}秒 · 静音=${prep.muted} · 起播=${prep.startAt ?? 0}s · ` +
        `防御已装（${def.ok} frame）· 可见性伪装=${prep.hidden === false ? '生效' : '未生效'}`,
      'info',
    );

    const started2 = await play(frame);
    if (!started2.ok) throw new Error(`播放启动失败：${started2.error}`);
    log(`    开始播放（${started2.how}）`, 'ok');

    /*
     * 边播边盯「视频内弹窗题」（P6）。
     *
     * ⚠ 认知修正（实证见 videoquiz.mjs 顶部注释）：
     *   弹窗题不在 cards 页（showCustomPop 从未被调用），而是在**视频 iframe 内**
     *   以 .ans-videoquiz 出现，由 video.js 自己暂停视频来出题。
     *   所以主监听器是 watchVideoQuiz；cards 页那套（watchPopups）留作可选，
     *   默认关闭（settings.cardsPopupWatch = true 才开）。
     *
     * 监听协程与监控循环并行跑；视频达标后通过 popupStop 标志让它退出。
     */
    let popupStop = false;
    let popupTask = null;
    const popupLog = [];
    /** 共享状态：弹窗开着时冻结播放侧的重试/纠偏逻辑 */
    const shared = { quizOpen: false };
    result.shared = shared;

    const onQuizEvent = (r) => {
      popupLog.push(r);
      if (r.needsHuman) {
        shared.needsHuman = true;
        shared.quizOpen = true;
        addHandbook({
          key: task.key,
          course: task.courseName || task.courseId,
          secNo: task.secNo,
          sectionName: task.sectionName,
          type: 'video-quiz',
          typeName: '视频内弹窗题',
          name: task.name,
          reason: r.error || '弹窗题需要人工处理',
        });
      }
    };

    {
      // 未连接 AI 也要检测弹窗，明确转待人工，不能让播放监控一直等待。
      result.popupWatching = true;
      popupTask = watchVideoQuiz({
        page,
        qianwenPage,
        shared,
        task,
        shouldStop: () => popupStop || (shouldStop && shouldStop()),
        onEvent: onQuizEvent,
      }).catch((e) => ({ error: e.message }));

      // cards 页弹窗（旧机制）默认不监听；如确有个别课程用它，可打开开关
      if (settings.cardsPopupWatch) {
        watchPopups({
          page,
          qianwenPage,
          shouldStop: () => popupStop || (shouldStop && shouldStop()),
          onPopup: onQuizEvent,
        }).catch(() => {});
      }
    }

    result.speed = await applyNativeSpeed(frame, settings.playbackSpeed, shouldStop);
    log(`    播放速度 ${result.speed.actual}×${result.speed.fallback ? '（该课程未应用所选倍速，回到正常播放）' : ''}`, 'info');
    // Keep popup watchers alive through both the checkpoint and continued playback.
    let watch;
    let checkpoint;
    try {
      const policy = await watchWithCheckpoint({
        settings, shouldStop, needsHuman: () => shared.needsHuman,
        watch: watchSettings => watchUntilDone({
          page, settings: watchSettings, shared, shouldStop,
          onTick: t => {
            result.progress = t.progress; result.resumes = t.resumes;
            if (onProgress) onProgress({ ...t, task, phase: t.quizOpen ? 'quiz' : 'playing' });
          },
        }),
        verify: () => verifyTaskCompletion({ ctx, task, personId, totalBudgetMs: 15000, intervalMs: 5000,
          shouldStop: () => !!shared.needsHuman || !!shouldStop?.() }),
        resume: () => play(frame),
        onPhase: phase => {
          const message = phase === 'checkpoint' ? '已到 90%，正在核对平台完成状态' : '平台尚未确认完成，继续播放到片尾';
          log(`    ${message}`, 'info');
          if (onProgress) onProgress({ task, progress: result.progress, phase: phase === 'checkpoint' ? 'verifying' : 'playing', playbackPhase: message, playbackRate: result.speed.actual });
        },
      });
      watch = policy.watch; checkpoint = policy.checkpoint;
      result.checkpoint = checkpoint;
    } finally {
      // 视频结束 → 停掉弹窗监听
      popupStop = true;
      if (popupTask) {
        await Promise.race([popupTask, new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
      }
    }

    result.popupEvents = popupLog;
    if (popupLog.some((p) => p.needsHuman)) {
      result.needsHuman = popupLog.find((p) => p.needsHuman).error;
      result.aiErrorCode = popupLog.find((p) => p.needsHuman).aiErrorCode;
    }

    /*
     * 播到片尾之后：**只耐心等服务端生效，绝不做任何 seek**。
     *
     * 两次错误教训（都已实测证实）：
     *   1) 早期只复核 3×8 秒就判失败 —— 但绿点延迟不稳定（短则 11 秒，
     *      长则超过 3 分钟）。3.4 播完等 3 分钟仍"未生效"，事后再查**早已变绿**。
     *   2) 曾用"回跳补播"来凑时长 —— 错了。学习通页面明写
     *      「未完成任务点前，当前视频不可拖拽」，程序化 seek 会被当拖拽处理
     *      （实测 seek 后立刻连续"被暂停"），反而破坏这条视频。
     *
     * 所以现在的策略：播到片尾 → 耐心等最多 6 分钟 → 还不生效就转「待人工」，
     * 由人工决定要不要再跑一遍（而不是自己乱动进度条）。
     */
    /*
     * 弹窗题判不出来 / 需要人工作答 → **立刻收手**，不进"等服务端生效"的等待。
     * 视频正停在那道题上，再等绿点纯属浪费；弹窗留在屏幕上等人来答。
     */
    if (watch.reason === 'quiz-needs-human') {
      result.progress = watch.progress ?? result.progress;
      result.resumes = watch.resumes ?? result.resumes;
      result.phase = 'needs-human';
      result.error = result.needsHuman || '视频弹窗题需要人工作答（弹窗已留在屏幕上）';
      log('    ⛔ 任务挂起：等人工处理弹窗题（已记入待人工）', 'warn');
      return result;
    }

    if (watch.stopped && !watch.ok) {
      await pause(frame).catch(() => {});
      result.progress = watch.progress ?? result.progress;
      result.resumes = watch.resumes ?? result.resumes;
      result.events = watch.events || [];
      result.watchReason = watch.reason;
      result.phase = 'stopped';
      result.error = '被用户中止';
      return result;
    }
    if (!watch.ok) throw new Error(`播放未达标：${watch.reason}（进度 ${((watch.progress ?? result.progress) * 100).toFixed(1)}%）`);
    const patientMs = settings.greenDotPatientMs ?? 360000;
    const patientStep = settings.greenDotPatientStepMs ?? 10000;
    if (!checkpoint?.done && onProgress) onProgress({ task, progress: watch.progress, currentTime: watch.currentTime, duration: watch.duration, playbackRate: result.speed.actual, phase: 'verifying', playbackPhase: '正在核对平台完成状态' });
    log(`    播放结束，核对完成状态（最多等 ${Math.round(patientMs / 60000)} 分钟）…`, 'info');

    /*
     * ⚠ 这里是"一直重复视频"的直接现场（用户实测反馈，2026-09-24）。
     *
     * 旧逻辑：播完 → 只看**小节绿点** → 小节里有"视频 + 章节测验"两项时，
     * 测验没做小节就不会绿 → 判"未完成" → 内联重试 → **23 分钟的视频又播一遍**，
     * 章节测验永远轮不到。原始日志：
     *   13:52:02 播放结束，等待学习通生效（最多 6 分钟）…
     *   13:55:15   …仍在等服务端生效（192s）   ← 白等，小节永远不绿
     *
     * 现逻辑：以**本任务点自己的**已完成标记为主判据，小节绿点只作兜底/佐证。
     * 于是"视频已完成、小节因测验未做完而不绿"能立刻判定成功并往下走。
     */
    const verdict = checkpoint?.done ? checkpoint : await verifyTaskCompletion({
      ctx,
      task,
      personId,
      totalBudgetMs: patientMs,
      intervalMs: patientStep,
      shouldStop,
      onWait: ({ waitedSec, point, section }) => {
        const pending = section && typeof section.jobPending === 'number' ? `，小节还有 ${section.jobPending} 个任务点待完成` : '';
        log(
          `      …仍在核对（${waitedSec}s）：本任务点=${point?.finished === false ? '未完成' : '读不出'}${pending}`,
          'debug',
        );
      },
    });
    const green = verdict.done;

    result.greenDotWaited = verdict.waitedSec;
    result.loops = 0;
    result.greenDot = verdict.done;
    result.greenVia = verdict.via;
    result.sectionStatus = verdict.section || null;

    result.progress = watch.progress ?? result.progress;
    result.resumes = watch.resumes ?? result.resumes;
    result.events = watch.events || [];
    result.watchReason = watch.reason;

    /*
     * 用户中止的处理要分两种，别一律当失败：
     *   1) 视频已经播到片尾（watch.ok）→ 学习通那边"其实已经达标"，
     *      已确认完成就记完成；未确认时保留待续跑，不再追加长时间查询。
     *   2) 视频没播完 → 直接记 stopped（保留进度，下次续播）。
     */
    if (verdict.stopped && !green) {
      result.phase = 'stopped';
      result.error = '播到片尾后用户中止（完成状态尚未确认，下次续跑只需再等）';
      log('    ⏸ 已中止：视频已播完但完成状态未确认，记为「待续跑」', 'warn');
      return result;
    }

    if (!watch.ok && !watch.stopped) {
      throw new Error(`播放未达标：${watch.reason}（进度 ${(result.progress * 100).toFixed(1)}%）`);
    }
    if (watch.stopped) {
      result.phase = 'stopped';
      result.error = '被用户中止';
      return result;
    }

    // —— 5) 完成任务点（上面的 verdict 已包含第二重确认）——
    result.phase = 'verify-green-dot';
    await page.close().catch(() => {});
    releasePage(page);

    const st = verdict.section || { done: null };
    if (verdict.done) {
      result.ok = true;
      result.phase = 'done';
      log(`    ✓ ${describeCompletion(verdict, task)}`, 'ok');
    } else if (st.done === false) {
      result.ok = false;
      result.error = `本任务点仍未完成（${st.tipText || '学习通仍显示未完成'}）`;
      log(`    ! ${result.error}`, 'warn');
    } else {
      result.ok = false;
      result.error = `完成状态读不出来：${verdict.point?.error || st.error || '未知'}`;
      log(`    ? ${result.error}`, 'warn');
    }

    return result;
  } catch (err) {
    result.error = err.message;
    log(`    ✗ 失败：${err.message}`, 'error');
    return result;
  } finally {
    result.elapsedSec = Math.round((Date.now() - started) / 1000);

    /*
     * 任务点级状态落盘（断点续跑的基础）。
     * 放在 runner 里而不是 batch 里 —— 这样无论谁调用（CLI / 界面 / 批量），
     * 状态都会记下来，不会出现"跑了但没记、重开又重刷"的情况。
     *
     * 关键：把已有状态一并读出来。**已 done 的记录绝不降级覆盖** ——
     * 曾经因为在 finally 里无条件写入，把一次成功（90.1%）的记录
     * 覆盖成了"非任务点 0.0%"，等于把战果丢了。
     */
    try {
      const prev = getTaskStatus(task.key) || {};

      const writeIfNotDone = (patch) => {
        if (prev.status === 'done') return; // 已完成的战果不可被覆盖
        setTaskStatus(task.key, { ...patch, name: task.name, secNo: task.secNo });
      };

      if (result.phase === 'done' || result.phase === 'already-finished') {
        // 进度取"本次"与"历史"的较大值 —— 跳过时本次进度是 0，
        // 用 ?? 拦不住 0，会把之前跑出来的 90.1% 覆盖掉。
        const best = Math.max(Number(result.progress) || 0, Number(prev.progress) || 0);
        setTaskStatus(task.key, {
          status: 'done',
          progress: best,
          greenDot: result.greenDot ?? prev.greenDot,
          elapsedSec: result.elapsedSec || prev.elapsedSec,
          resumes: result.resumes ?? prev.resumes,
          name: task.name,
          secNo: task.secNo,
          finishedAt: prev.finishedAt || new Date().toISOString(),
          note: prev.note,
        });
      } else if (result.phase === 'no-tracking') {
        writeIfNotDone({ status: 'done', progress: 0, note: '非任务点（无完成度追踪），无需播放' });
      } else if (result.phase === 'needs-human') {
        writeIfNotDone({ status: 'manual', progress: result.progress, note: result.error });
      } else if (result.phase === 'stopped') {
        writeIfNotDone({ status: 'pending', progress: result.progress, note: '被用户中止' });
      } else {
        writeIfNotDone({ status: 'failed', progress: result.progress, lastError: result.error });
      }
    } catch {
      /* 落盘失败不影响返回结果 */
    }

    /*
     * 弹窗题等人作答时**不要关页面**。
     * 早期这里无条件 close，结果"留给你手动作答"的弹窗随页面一起消失，
     * 人工想答都答不了。现在保留页面并登记进「保留页面」清单。
     */
    if (result.phase === 'needs-human') {
      try {
        registerKeptPage(task.key, page, {
          course: task.courseName || task.courseId,
          secNo: task.secNo,
          sectionName: task.sectionName,
          name: task.name,
          type: 'video-quiz',
          reason: result.error,
        });
        log('    页面保持打开：请在学习通视频弹窗中手动作答；处理记录见「需要你处理」，此题不在「待审答案」队列', 'warn');
      } catch {
        /* 登记失败不影响结果 */
      }
    } else {
      await page.close().catch(() => {});
    releasePage(page);
    }
  }
}
