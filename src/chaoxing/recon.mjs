/**
 * P1 侦察模块 —— 只读，绝不播视频、绝不答题、绝不提交。
 *
 * 产出：每门课的完整章节树 + 每个小节的任务点状态。
 *
 * 已探明的学习通结构（mooc2 新版）：
 *   课程首页  mooc1.chaoxing.com/visit/stucoursemiddle?courseid&clazzid&cpi&ismooc2=1
 *     └ 跳转到 mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...
 *        └ iframe#frame_content-zj → /mooc2-ans/mycourse/studentcourse?...
 *           └ .chapter_item 若干行
 *               章   : 无 id，含 .catalog_num（如 "1"）+ .catalog_upDown（可折叠）
 *               小节 : id="cur<knowledgeId>"，onclick="toOld(courseId,knowledgeId,clazzId,0)"
 *                      含 input[name=checkbox][value=<knowledgeId>]
 *                      .catalog_state.icon_yiwanc  → 绿点=已完成
 *                      无 .catalog_state            → 黄点=未完成
 *                      .catalog_task input.knowledgeJobCount[value=N] → **未完成**的任务点数
 *                        （⚠ 不是总数！实测：已全绿的小节该 input 为 null、提示"已完成"；
 *                          未完成的小节值=1、提示"1个待完成任务点"。早期把它当总数用，
 *                          导致"视频已完成 + 测验未完成"的小节漏读测验，见 nextCardDecision）
 *                      .catalog_points_yi            → 已完成任务点数
 *                      .bntHoverTips                 → "N个待完成任务点"
 */
import fs from 'node:fs';
import {reconMetadata} from './recon-metadata.mjs';
import path from 'node:path';
import { PATHS } from '../config.mjs';
import { log } from '../logbus.mjs';
import { bringToFront } from '../browser/launch.mjs';
import { newTaskPage, releasePage } from '../browser/pages.mjs';

/* ---------------- 从页面里抽章节树的注入函数 ---------------- */

const EXTRACT_TREE = () => {
  const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

  const headText = t(document.querySelector('.chapter_head, .chapter_th'));
  const hm = (t(document.querySelector('.chapter_head')) || '').match(/(\d+)\s*\/\s*(\d+)/);

  const items = [];
  let currentChapter = null;

  for (const it of Array.from(document.querySelectorAll('.chapter_item'))) {
    const id = it.getAttribute('id') || '';
    const knowledgeId = id.startsWith('cur') ? id.slice(3) : '';
    const onclick = it.getAttribute('onclick') || '';
    const title = it.getAttribute('title') || '';
    const nameSpan = it.querySelector('.catalog_name .clicktitle span:not(.catalog_sbar)') || it.querySelector('.catalog_name span[title]');
    const name = title || nameSpan?.getAttribute('title') || t(nameSpan) || '';

    if (!knowledgeId) {
      // —— 章行 ——
      const num = t(it.querySelector('.catalog_num'));
      currentChapter = { kind: 'chapter', chapterNo: num, name: name || t(it.querySelector('.catalog_name')), sections: [] };
      items.push(currentChapter);
      continue;
    }

    // —— 小节行 ——
    const checkbox = it.querySelector('input[name="checkbox"]');
    const sid = checkbox?.getAttribute('value') || knowledgeId;

    const stateEl = it.querySelector('.catalog_state');
    const stateCls = stateEl ? String(stateEl.className) : '';
    const done = /icon_yiwanc/.test(stateCls);

    const jobInput = it.querySelector('.catalog_task input.knowledgeJobCount');
    /*
     * ⚠ 名字有历史误导性：实测这个值 = **未完成**的任务点数（不是总数）。
     *   已全绿的小节：input 不渲染 → null，提示"已完成"
     *   未完成的小节：值 = 1，提示"1个待完成任务点"
     * 所以它**不能**用来推算"这个小节一共有几个任务点" —— 早期那么用，
     * 结果"视频已完成 + 测验未完成"的小节漏读了测验。字段名保持不变是为了
     * 兼容已有报告与工具；语义见 nextCardDecision 的说明。
     */
    const jobPendingFromTree = jobInput ? Number(jobInput.getAttribute('value')) : null;

    const yi = t(it.querySelector('.catalog_points_yi'));
    const tip = t(it.querySelector('.bntHoverTips'));
    const pendingMatch = tip.match(/(\d+)\s*个待完成/);

    const section = {
      kind: 'section',
      knowledgeId: sid,
      name,
      secNo: t(it.querySelector('.catalog_sbar')),
      done,
      stateClass: stateCls,
      jobTotal: jobPendingFromTree, // ⚠ 实为"未完成的任务点数"（见上面的说明），字段名为兼容而保留
      jobPendingFromTree, // 同一含义的另一个来源（树的提示文本）
      jobDone: yi ? Number(yi) : null, // 已完成任务点数
      jobPending: pendingMatch ? Number(pendingMatch[1]) : null,
      tipText: tip,
      onclick,
    };

    currentChapter?.sections.push(section);
    items.push(section);
  }

  // 顶层汇总
  const totalMatch = (t(document.body) || '').match(/已完成任务点[:：]\s*(\d+)\s*\/\s*(\d+)/);

  return {
    url: location.href,
    headText,
    summary: hm
      ? { done: Number(hm[1]), total: Number(hm[2]) }
      : totalMatch
        ? { done: Number(totalMatch[1]), total: Number(totalMatch[2]) }
        : null,
    items,
  };
};

/* ---------------- 工具 ---------------- */

/**
 * 轮询等待章节 frame 就绪（iframe src 动态设置，不能取一次就完）。
 *
 * 两种情况都算"就绪"：
 *   1) 有 .chapter_item（正常课程）
 *   2) 页面显示「暂无章节内容」（空课程 —— 如 示例学习内容 / 示例学习内容 这类无任务点的课）
 *      这类不能当失败处理，否则会白等 25 秒超时。
 */
async function waitTreeFrame(page, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const fr of page.frames()) {
      if (!fr.url().includes('mycourse/studentcourse')) continue;
      const probe = await fr
        .evaluate(() => ({
          items: document.querySelectorAll('.chapter_item').length,
          body: (document.body?.innerText || '').replace(/\s+/g, ' '),
        }))
        .catch(() => null);
      if (!probe) continue;
      if (probe.items > 0) return { frame: fr, empty: false };
      if (/暂无章节内容|暂无内容/.test(probe.body)) return { frame: fr, empty: true };
    }
    await page.waitForTimeout(600);
  }
  return null;
}

/**
 * 任务点提取（从 /mooc-ans/knowledge/cards 页面里抽 .ans-attach-ct）。
 *
 * 已探明结构：
 *   .ans-attach-ct                        ← 一个任务点
 *     .ans-job-icon[aria-label]           ← "任务点未完成" / "已完成"（最可靠状态判据）
 *       .ans-job-video                    ← 类型：视频
 *     .ans-job-finished                   ← 已完成（绿点）
 *     iframe.ans-attach-online[data]      ← JSON{name,objectid,jobid,hsize,fastforward,doublespeed}
 *     .task-condition                     ← "观看时长需 ≥ 总时长的 90%"
 */
const EXTRACT_ATTACH = () => {
  const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

  return Array.from(document.querySelectorAll('.ans-attach-ct')).map((ct, idx) => {
    const icon = ct.querySelector('.ans-job-icon');
    const iconCls = icon ? String(icon.className) : '';
    const iframe = ct.querySelector('iframe.ans-attach-online, iframe');
    const src = iframe?.getAttribute('src') || '';

    let meta = null;
    const raw = iframe?.getAttribute('data');
    if (raw) {
      try {
        meta = JSON.parse(raw);
      } catch {
        meta = null;
      }
    }

    let type = 'unknown';
    if (/ans-job-video/.test(iconCls) || /modules\/video/.test(src)) type = 'video';
    else if (/ans-job-audio/.test(iconCls) || /modules\/audio/.test(src)) type = 'audio';
    else if (/modules\/work/.test(src)) type = 'work';
    else if (/modules\/read/.test(src)) type = 'read';
    else if (/modules\/live/.test(src)) type = 'live';
    else if (/modules\/doc|modules\/pdf/.test(src)) type = 'doc';
    else if (/modules\/vote/.test(src)) type = 'vote';
    else if (/modules\/forum|modules\/bbs/.test(src)) type = 'forum';

    const aria = icon?.getAttribute('aria-label') || '';

    return {
      idx,
      type,
      // 状态以 aria-label 为主判据（class 会变，无障碍标签更稳），class 作交叉校验
      finished: /已完成/.test(aria) || /ans-job-finished/.test(String(ct.className)),
      ariaLabel: aria,
      jobid: meta?.jobid || iframe?.getAttribute('jobid') || null,
      objectId: meta?.objectid || iframe?.getAttribute('objectid') || null,
      /*
       * ⚠ 名称字段不统一：视频等附件是 `name`，**作业/测验是 `title`**
       * （实测 work 附件的 data = {workid, title:"3.1", worktype:"workA", jobid:"work-.."}）。
       * 早期只读 name，导致所有章节测验在清单里 name=null ——
       * 于是被归成"未识别的作业类"，明明该做的章节测验反而全被跳过。
       */
      name: meta?.name || meta?.title || null,
      workType: meta?.worktype || null,
      // 注意字段名统一用 sizeText —— 早期版本这里叫 size，
      // 导致下游按体积排序时读不到、挑"最小视频"完全失效。
      sizeText: meta?.hsize || (meta?.size ? `${(meta.size / 1048576).toFixed(1)}MB` : null),
      sizeBytes: Number(meta?.size) || null,
      fastforward: meta?.fastforward ?? iframe?.getAttribute('fastforward') ?? null,
      doublespeed: meta?.doublespeed ?? null,
      condition: t(ct.querySelector('.task-condition')).replace(/^完成条件/, ''),
    };
  });
};

/**
 * 「还要不要继续探下一张卡片」—— 纯函数，方便离线测试。
 *
 * 背景（本项目最贵的坑之一，2026-09-24 用户实测暴露）：
 *   早期用 `input.knowledgeJobCount` 当"该小节应有几个任务点"来**提前收工**
 *   （`all.length >= wantCount` 就 break）。实测发现这个数其实是
 *   **未完成的任务点数**，不是总数：
 *     已全绿的小节 → knowledgeJobCount = null、提示"已完成"
 *     未完成的小节 → knowledgeJobCount = 1、提示"1个待完成任务点"
 *   于是"视频已完成 + 章节测验未完成"这种小节（待完成数=1）会在读到**视频**
 *   之后就收工，**把下一张卡片上的章节测验整条漏掉** ——
 *   清单里没有它 → 程序永远不去做 → 小节永远不变绿。
 *   用户原话："2视频任务点已完成，而3章节测验未完成"，症状完全对得上。
 *
 * 现在的规则：**只以"卡片到头"为准**（暂无内容 / 连续两张卡都没有附件 / 到上限），
 * 不再因为"数量够了"提前收工。多探 1~2 张卡片的代价，远小于漏掉一个任务点。
 *
 * @param {object} o
 * @param {number} o.attachCount 本张卡片上的附件数
 * @param {boolean} o.empty 本张卡片是否显示「暂无内容」
 * @param {number} o.consecutiveEmpty 连续多少张卡片没有附件（含本张）
 * @param {number} o.probed 已经探过的卡片数（含本张）
 * @param {number} o.maxCards 上限
 * @param {number} o.found 目前已收集到的任务点数
 * @param {number|null} [o.wantCount] 树上的"待完成数"（**仅供参考/告警**，不再用于提前收工）
 * @returns {{stop:boolean, reason:string}}
 */
export function nextCardDecision({ attachCount, empty, consecutiveEmpty, probed, maxCards, found, wantCount = null }) {
  if (empty) return { stop: true, reason: '卡片到头（暂无内容）' };
  if (consecutiveEmpty >= 2) return { stop: true, reason: '连续两张卡片都没有任务点' };
  if (probed >= maxCards) return { stop: true, reason: `达到探测上限（${maxCards} 张）` };
  if (wantCount && found > wantCount) {
    // 不改行为，只把"树上的数不可靠"这件事说清楚
    return { stop: false, reason: `已找到 ${found} 个任务点，超过树上的待完成数 ${wantCount}（该数不可当总数用）` };
  }
  return { stop: false, reason: '' };
}

/**
 * 进入一个小节，读取它的任务点清单。
 *
 * 关键：/mooc-ans/knowledge/cards 这个 URL 可以脱离点击流程独立加载
 * （只要 courseid/clazzid/knowledgeid/cpi/ut=s，不需要 enc），
 * 所以用一个标签页反复导航即可，比"每小节开一个标签页"快一个数量级。
 *
 * ⚠ 多卡片（1.1 示例章节介绍 实测）：一个小节可能被切成多张"卡片"，
 *   num=0 可能只是「学习目标」纯文本卡，真正的视频任务点在 num=1，
 *   再往后正文变成「暂无内容」——那就是卡片到头了。
 * 只读 num=0 会漏掉这些任务点（现象：清单里整章的第一节凭空消失）。
 *
 * @param {object} opts
 * @param {number} opts.maxCards 最多探几张卡片
 * @param {number|null} opts.wantCount 该小节应有多少任务点（够数就提前收工，省时间）
 * @returns {Promise<Array>} 任务点数组（每项带 cardNum）
 */
export async function readSectionTasks(
  ctx,
  { courseId, clazzId, personId, knowledgeId, maxCards = 6, wantCount = null },
) {
  const page = await newTaskPage(ctx, 'recon-course');
  const all = [];
  let consecutiveEmpty = 0;
  try {
    for (let n = 0; n < maxCards; n += 1) {
      const url =
        `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards` +
        `?clazzid=${clazzId}&courseid=${courseId}&knowledgeid=${knowledgeId}` +
        `&num=${n}&ut=s&cpi=${personId}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // 等任务点渲染，或等到「暂无内容」判定卡片到头
      let probe = { attachCount: 0, empty: false };
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const p = await page
          .evaluate(() => {
            const n2 = document.querySelectorAll('.ans-attach-ct').length;
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
            return { attachCount: n2, empty: /暂无内容/.test(body) && n2 === 0 };
          })
          .catch(() => null);
        if (p) {
          probe = p;
          if (p.attachCount > 0 || p.empty) break;
        }
        await page.waitForTimeout(350);
      }
      if (probe.empty) break;

      if (probe.attachCount > 0) {
        consecutiveEmpty = 0;
        const list = await page.evaluate(EXTRACT_ATTACH);
        all.push(...list.map((a) => ({ ...a, cardNum: n })));
        if (wantCount && all.length > wantCount) {
          log(
            `      ! 小节 ${knowledgeId} 找到 ${all.length} 个任务点，超过树上的待完成数 ${wantCount}` +
              `（该数只是"未完成数"，不能当总数 —— 已按实际读到的为准）`,
            'debug',
          );
        }
      } else {
        consecutiveEmpty += 1;
      }

      /*
       * 是否继续探下一张卡片：**只看"卡片到头"**，不因为"数量够了"提前收工。
       * 早期版本在这里用树上的待完成数当总数，导致"视频已完成 + 测验未完成"的
       * 小节漏掉测验（详见 nextCardDecision 的说明）。
       */
      const d = nextCardDecision({
        attachCount: probe.attachCount,
        empty: probe.empty,
        consecutiveEmpty,
        probed: n + 1,
        maxCards,
        found: all.length,
        wantCount,
      });
      if (d.stop) {
        if (d.reason !== '卡片到头（暂无内容）') log(`      停止探测：${d.reason}`, 'debug');
        break;
      }
    }
    return all;
  } finally {
    await page.close().catch(() => {});
      releasePage(page);
  }
}

/**
 * 显式切到「章节」标签。
 *
 * 已探明：学习通课程主页默认标签因课而异 —— 有的默认「任务」
 * （iframe#frame_content-hd 指向 mobilelearn 活动列表），有的默认「章节」
 * （iframe#frame_content-zj → studentcourse）。所以不能靠默认，必须点。
 *
 * 导航结构：
 *   li[dataname="zj"] > a[title="章节"] > span.tag_new > span.nav_content "章节"
 */
async function clickChapterTab(page) {
  const li = page.locator('li[dataname="zj"]').first();
  if (await li.count()) {
    await li.evaluate(element => element.click()).catch(() => {});
    return true;
  }
  // 兜底：按文字找
  const fallback = page.locator('span.nav_content', { hasText: '章节' }).first();
  if (await fallback.count()) {
    await fallback.evaluate(element => element.click()).catch(() => {});
    return true;
  }
  return false;
}

/** 展开所有折叠的章（点击 .catalog_upDown） */
async function expandAll(frame) {
  const collapsed = await frame
    .evaluate(() =>
      Array.from(document.querySelectorAll('.catalog_upDown'))
        .filter((e) => !/catalog_upDown_active/.test(String(e.className)))
        .length,
    )
    .catch(() => 0);
  if (!collapsed) return 0;
  await frame
    .evaluate(() => {
      for (const e of Array.from(document.querySelectorAll('.catalog_upDown'))) {
        if (!/catalog_upDown_active/.test(String(e.className))) e.click();
      }
    })
    .catch(() => {});
  await frame.waitForTimeout(2500);
  return collapsed;
}

/* ---------------- 主流程 ---------------- */

/**
 * 侦察单门课。
 * @returns {Promise<object>} 课程结构
 */
export async function reconCourse(ctx, course, { expand = true } = {}) {
  const page = await newTaskPage(ctx, 'recon-tasks');
  const out = {
    courseId: course.courseId,
    clazzId: course.clazzId,
    name: course.name,
    teacher: course.teacher,
    progressFromList: { done: course.done, total: course.total, percent: course.percent },
    chapters: [],
    sections: [],
    summary: null,
    error: null,
  };

  try {
    log(`  进入课程：《${course.name}》`, 'info');
    await page.goto(course.detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // 关键：先看默认标签是不是「章节」，不是就点过去
    let found = await waitTreeFrame(page, 4000);
    if (!found) {
      const clicked = await clickChapterTab(page);
      if (clicked) {
        log('    默认非章节页，已点击「章节」标签', 'debug');
        await page.waitForTimeout(1500);
      }
      found = await waitTreeFrame(page, 22000);
    }
    if (!found) throw new Error('章节树 frame 未就绪（可能登录态失效或页面改版）');

    const { frame, empty } = found;
    if (empty) {
      out.empty = true;
      out.summary = { done: 0, total: 0 };
      log('    该课程暂无章节内容（无任务点）', 'warn');
      return out;
    }

    if (expand) {
      const n = await expandAll(frame);
      if (n) log(`    展开了 ${n} 个折叠章节`, 'debug');
    }

    const tree = await frame.evaluate(EXTRACT_TREE);

    out.summary = tree.summary;
    out.chapters = tree.items.filter((i) => i.kind === 'chapter');
    out.sections = tree.items.filter((i) => i.kind === 'section');

    const doneCount = out.sections.filter((s) => s.done).length;
    const pendingJobs = out.sections.reduce((n, s) => n + (s.jobPending || 0), 0);
    log(
      `    小节 ${out.sections.length} 个（已完成 ${doneCount}）· 待完成任务点合计 ${pendingJobs}`,
      'ok',
    );
  } catch (err) {
    out.error = err.message;
    log(`    侦察失败: ${err.message}`, 'error');
  } finally {
    await page.close().catch(() => {});
      releasePage(page);
  }
  return out;
}

/**
 * 侦察全部课程。
 *
 * 产出两级信息：
 *   1) 章节树（章 / 小节 / 黄绿点 / 任务点计数）
 *   2) 每个未完成小节的任务点明细（类型 / 状态 / 文件名 / 大小 / jobid）
 *
 * @param {object} opts
 * @param {object} opts.ctx 浏览器 context
 * @param {Array}  opts.courses 课程列表（来自 listCourses）
 * @param {boolean} opts.deep 是否深入每小节读任务点（默认 true）
 * @param {number} opts.maxSections 每门课最多深挖多少小节（默认 200）
 * @param {Function} opts.onProgress 进度回调
 */
export async function reconAll(ctx, courses, { deep = true, maxSections = 200, onProgress, shouldStop = () => false } = {}) {
  const results = [];
  const checkStop = () => {
    if (shouldStop()) throw Object.assign(new Error('已停止读取课程'), { code: 'STOPPED' });
  };

  for (let i = 0; i < courses.length; i += 1) {
    checkStop();
    const c = courses[i];
    if (onProgress) onProgress({ index: i, total: courses.length, course: c });
    log(`[${i + 1}/${courses.length}] 侦察《${c.name}》`, 'info');

    const r = await reconCourse(ctx, c);
    checkStop();
    results.push(r);

    if (r.error || !deep || r.empty) continue;

    // 只深挖未完成小节 —— 已完成的不需要刷，没必要读
    const pending = r.sections.filter((s) => !s.done).slice(0, maxSections);
    if (!pending.length) continue;

    log(`    读取 ${pending.length} 个未完成小节的任务点…`, 'info');

    // 用一个标签页反复导航（比每小节开页快一个数量级）；
    // 小节内部的多张卡片由 readSectionTasks 逐张探到底
    for (let j = 0; j < pending.length; j += 1) {
      checkStop();
      const s = pending[j];
      try {
        s.taskPoints = await readSectionTasks(ctx, {
          courseId: c.courseId,
          clazzId: c.clazzId,
          personId: c.personId,
          knowledgeId: s.knowledgeId,
          wantCount: s.jobTotal || null,
        });
      } catch (err) {
        s.taskPointError = err.message.slice(0, 90);
      }
      if (onProgress && j % 5 === 0) onProgress({ index: i, total: courses.length, course: c, section: j + 1, sections: pending.length });
      checkStop();
    }

    // 汇总任务点
    const byType = {};
    let total = 0;
    let unfinished = 0;
    for (const s of pending) {
      for (const a of s.taskPoints || []) {
        byType[a.type] = (byType[a.type] || 0) + 1;
        total += 1;
        if (!a.finished) unfinished += 1;
      }
    }
    r.taskPointTotals = { seen: total, unfinished, byType };
    log(`    任务点 ${total} 个（未完成 ${unfinished}）${JSON.stringify(byType)}`, 'ok');
  }

  checkStop();
  return results;
}

/* ---------------- 课程清单（正式版） ---------------- */

const EXTRACT_COURSES = () => {
  const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  return Array.from(document.querySelectorAll('.course.learnCourse')).map((c) => {
    const courseId = c.querySelector('input.courseId')?.value || (c.id || '').replace(/^c_/, '');
    const clazzId = c.querySelector('input.clazzId')?.value || (c.getAttribute('info') || '').split('_')[0];
    const personId = c.querySelector('input.curPersonId')?.value || (c.getAttribute('info') || '').split('_')[1];
    const name = c.querySelector('.course-name')?.getAttribute('title') || t(c.querySelector('.course-name'));
    const progressText = t(c.querySelector('.btm-cover .l-txt'));
    const pm = progressText.match(/(\d+)\s*\/\s*(\d+)/);
    const pct = Number(String(t(c.querySelector('.btm-cover .bar-tip'))).replace('%', '')) || 0;
    return {
      courseId,
      clazzId,
      personId,
      name,
      teacher: t(c.querySelector('.course-info p.color3')),
      openTime: (Array.from(c.querySelectorAll('.course-info p')).map(t).find((x) => /开课时间/.test(x)) || '').replace(/^开课时间[:：]\s*/, ''),
      done: pm ? Number(pm[1]) : null,
      total: pm ? Number(pm[2]) : null,
      percent: pct,
      detailUrl: `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseId}&clazzid=${clazzId}&cpi=${personId}&ismooc2=1&v=2`,
    };
  });
};

/**
 * 读取课程清单（12 门课）。
 * @param {import('playwright-core').Page} mainPage 个人空间页面
 */
export async function listCourses(mainPage) {
  const tryFind = async (timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const fr of mainPage.frames()) {
        if (!fr.url().includes('mooc2-ans.chaoxing.com')) continue;
        const n = await fr.evaluate(() => document.querySelectorAll('.course.learnCourse').length).catch(() => 0);
        if (n > 0) return fr;
      }
      await mainPage.waitForTimeout(600);
    }
    return null;
  };

  log('读取课程清单…', 'info');
  let frame = await tryFind(6000);

  if (!frame) {
    log('课程列表未加载，点击「全部课程」标签', 'debug');
    const oldTab = mainPage.locator('.label-item', { hasText: '全部课程' }).first();
    if (await oldTab.count()) await oldTab.evaluate(element => element.click()).catch(() => {});
    else await mainPage.evaluate(() => {
      const entry = [...document.querySelectorAll('.menu-list-ul li')].find(element => element.textContent.trim() === '全部课程');
      (entry?.querySelector('h3') || entry)?.click();
    }).catch(() => {});
    frame = await tryFind(20000);
  }
  if (!frame) throw new Error('找不到课程列表（可能登录态失效或页面改版）');

  const courses = await frame.evaluate(EXTRACT_COURSES);
  const total = courses.reduce((n, c) => n + (c.total || 0), 0);
  const done = courses.reduce((n, c) => n + (c.done || 0), 0);
  log(`共 ${courses.length} 门课，任务点 ${done}/${total} 已完成`, 'ok');
  return courses;
}

/* ---------------- 报告落盘 ---------------- */

/** 类型中文名（与界面/报告一致） */
const TYPE_NAMES = {
  video: '视频',
  audio: '音频',
  discuss: '讨论/话题',
  vote: '问卷/投票',
  work: '作业/测验',
  read: '阅读材料',
  live: '直播',
  doc: '文档/PPT/PDF',
  forum: '论坛',
  other: '未识别',
};

/**
 * 把侦察结果转成「任务点清单报告」格式。
 *
 * 为什么要转：执行清单（src/chaoxing/checklist.mjs）读的是
 *   data/probe-out/task-report.json —— 结构是"平铺的 taskPoints"。
 * 而侦察结果是"课程 → 小节 → 任务点"的树。
 * 早期这两条线各走各的：界面点「开始侦察」只写了 logs/recon-*.json，
 * 清单却还在读旧的普查文件 —— 于是"重新侦察了，清单却没变"，
 * 用户看到的任务点永远是最早那一次普查的结果（还漏掉多卡片小节）。
 * 现在统一：侦察完成后**同一份结果**写成清单报告。
 */
export function reconToTaskReport(results) {
  const courses = [];
  const grand = {};

  for (const c of results) {
    if (c.empty) {
      courses.push({ name: c.name, courseId: c.courseId, clazzId: c.clazzId, empty: true });
      continue;
    }

    const seen = new Set();
    const taskPoints = [];
    const byType = {};
    const unfinishedByType = {};
    const nonTaskPoints = {};

    for (const s of c.sections || []) {
      for (const a of s.taskPoints || []) {
        /*
         * 是否真任务点：有 jobid（任务点 id）或学习通自己标的 aria-label。
         * 只有 _jobid 的是普通附件（问卷/讨论），不计入完成度。
         */
        const hasTracking = !!a.jobid || /任务点|已完成/.test(String(a.ariaLabel || ''));
        if (!hasTracking) {
          nonTaskPoints[a.type] = (nonTaskPoints[a.type] || 0) + 1;
          continue;
        }

        const key = a.jobid || `${s.knowledgeId}#${a.idx}`;
        if (seen.has(key)) continue;
        seen.add(key);

        byType[a.type] = (byType[a.type] || 0) + 1;
        if (!a.finished) unfinishedByType[a.type] = (unfinishedByType[a.type] || 0) + 1;

        taskPoints.push({
          type: a.type,
          typeName: TYPE_NAMES[a.type] || a.type,
          finished: !!a.finished,
          inPendingSection: !s.done,
          sectionDone: !!s.done,
          name: a.name || null,
          sizeText: a.sizeText || null,
          sizeBytes: a.sizeBytes ?? null,
          jobid: a.jobid || null,
          idx: a.idx,
          cardNum: a.cardNum ?? 0,
          secNo: s.secNo,
          sectionName: s.name,
          knowledgeId: s.knowledgeId,
          condition: a.condition || null,
        });
      }
    }

    for (const [k, v] of Object.entries(byType)) grand[k] = (grand[k] || 0) + v;
    for (const [k, v] of Object.entries(unfinishedByType)) grand[`未完成_${k}`] = (grand[`未完成_${k}`] || 0) + v;
    for (const [k, v] of Object.entries(nonTaskPoints)) grand[`非任务点_${k}`] = (grand[`非任务点_${k}`] || 0) + v;

    courses.push({
      name: c.name,
      courseId: c.courseId,
      clazzId: c.clazzId,
      ...reconMetadata(c),
      sectionsProbed: (c.sections || []).length,
      taskPoints,
      byType,
      unfinishedByType,
      nonTaskPoints,
      total: taskPoints.length,
      unfinished: taskPoints.filter((t) => !t.finished).length,
    });
  }

  return { at: new Date().toISOString(), courses, grand };
}

/**
 * 写清单报告（执行清单的唯一输入）。
 * 旧报告先备份成 task-report.prev.json —— 万一本轮侦察异常，
 * 还能对照上一份，不至于把可用清单直接冲掉。
 */
export function writeTaskReport(results) {
  const report = reconToTaskReport(results);
  const file = PATHS.taskReport;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(path.dirname(file), 'task-report.prev.json'));
    }
  } catch {
    /* 备份失败不影响主流程 */
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');

  const total = report.courses.reduce((n, c) => n + (c.total || 0), 0);
  const unfinished = report.courses.reduce((n, c) => n + (c.unfinished || 0), 0);
  log(`清单报告已更新：${report.courses.length} 门课 · 任务点 ${total} 个（未完成 ${unfinished}）`, 'ok');
  return { file, total, unfinished, courses: report.courses.length };
}

export function saveReconReport(report) {
  fs.mkdirSync(PATHS.logs, { recursive: true });
  const file = path.join(PATHS.logs, `recon-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}
