/**
 * 小节 → 卡片 的公共逻辑（视频执行器与作业执行器共用）。
 *
 * 背景（2026-09-23 实测，多卡片是本项目最隐蔽的坑之一）：
 *   `/mooc-ans/knowledge/cards?num=N` 里的 num 是**卡片序号**：
 *     示例课程甲 1.1 示例章节介绍： num=0 → 「学习目标」纯文本卡（无附件）
 *                                   num=1 → 视频任务点 0.1.mp4
 *                                   num=2 → 正文「暂无内容」= 卡片到头
 *     示例课程乙 3.1：               num=0 → 视频任务点
 *                                   num=1 → 章节测验（work）
 *   全链路写死 num=0 时，第一张是学习目标的小节会被误判成"没有任务点"，
 *   章节测验也会整批读不到 —— 用户视角就是"刷不成功"。
 */
import { log } from '../logbus.mjs';

/** 组装 cards URL（num = 卡片序号） */
export function cardsUrl({ courseId, clazzId, personId, knowledgeId, cardNum = 0 }) {
  return (
    `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards` +
    `?clazzid=${clazzId}&courseid=${courseId}&knowledgeid=${knowledgeId}` +
    `&num=${cardNum}&ut=s&cpi=${personId}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`
  );
}

/**
 * 等页面渲染出任务点（`.ans-attach-ct`）。
 *
 * 学习通的附件列表是**懒加载**的：抢跑会读到 0 个附件，
 * 于是把真任务点误判成"没有完成度追踪"。这个等待以前在视频/文档/测验
 * 三处各写了一遍，现在统一到这里。
 *
 * @returns {Promise<number>} 渲染出的任务点个数（超时则为 0）
 */
export async function waitForAttachments(page, { timeoutMs = 8000, stepMs = 400 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const n = await page
      .evaluate(() => document.querySelectorAll('.ans-attach-ct').length)
      .catch(() => 0);
    if (n > 0) return n;
    if (Date.now() - t0 >= timeoutMs) return 0;
    await page.waitForTimeout(stepMs);
  }
}

/** 等某张卡片渲染出任务点，或渲染出「暂无内容」（= 卡片到头） */
export async function waitAttachOrEmpty(page, timeoutMs = 6000) {
  const t0 = Date.now();
  let probe = { attachCount: 0, empty: false, names: [] };
  while (Date.now() - t0 < timeoutMs) {
    const p = await page
      .evaluate(() => {
        const list = Array.from(document.querySelectorAll('.ans-attach-ct'));
        const names = list.map((ct) => {
          try {
            const d = JSON.parse(ct.querySelector('iframe')?.getAttribute('data') || '{}');
            return d.name || d.title || null;
          } catch {
            return null;
          }
        });
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return { attachCount: list.length, names, empty: /暂无内容/.test(body) && list.length === 0 };
      })
      .catch(() => null);
    if (p) {
      probe = p;
      if (p.attachCount > 0 || p.empty) return probe;
    }
    await page.waitForTimeout(300);
  }
  return probe;
}

/**
 * 打开小节，并在它的多张卡片中找到「含本任务点」的那一张。
 *
 * 选择策略（按优先级）：
 *   1) 卡片里存在 name/title === task.name 的任务点 → 选它（最准）
 *   2) 否则记住第一张"有附件"的卡片（兜底）
 *   3) 卡片显示「暂无内容」→ 到头了，停止
 *
 * @returns {Promise<{cardNum:number, attachCount:number, names:Array, notFound?:boolean, cardsProbed:number}>}
 */
export async function openSectionCard(page, task, personId, { maxCards = 6, perCardWaitMs = 6000, quiet = false } = {}) {
  let firstWithAttach = null;
  let matched = null;
  let cardsProbed = 0;

  for (let n = 0; n < maxCards; n += 1) {
    await page.goto(cardsUrl({ ...task, personId, cardNum: n }), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    cardsProbed += 1;
    const probe = await waitAttachOrEmpty(page, perCardWaitMs);
    if (probe.empty) break; // 「暂无内容」→ 卡片到头
    if (probe.attachCount > 0) {
      if (!firstWithAttach) firstWithAttach = { cardNum: n, ...probe };
      const hit = (probe.names || []).some((x) => x && x === task.name);
      if (hit) {
        matched = { cardNum: n, ...probe };
        break;
      }
    }
  }

  const chosen = matched || firstWithAttach;
  if (!chosen) return { cardNum: 0, attachCount: 0, names: [], notFound: true, cardsProbed };

  // 若当前停留的不是选中的那张，回去
  if (cardsProbed > 1 && chosen.cardNum !== cardsProbed - 1) {
    await page.goto(cardsUrl({ ...task, personId, cardNum: chosen.cardNum }), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await waitAttachOrEmpty(page, perCardWaitMs);
  }
  if (!quiet && chosen.cardNum > 0) {
    log(`    任务点在第 ${chosen.cardNum + 1} 张卡片上（前面是学习目标等非任务卡）`, 'info');
  }
  return { ...chosen, cardsProbed };
}
