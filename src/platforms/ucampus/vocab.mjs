/**
 * U校园 AI 版：Vocabulary（单词卡片训练，53 张）。
 *
 * 真机结构（2026-11-02）：
 *   · 卡片区右侧有 `div.action.next`（文字「下一个」）与 `div.action.prev`；
 *   · 顶部计数器形如 `1/53`，点「下一个」就 +1；
 *   · 一路点到最后一张（或按钮变灰）即完成，平台按完成度记账。
 */
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';
import { ensurePlayableViewport, dismissUcampusDialog } from './quiz.mjs';

/** 读当前卡片进度（形如 { current, total }） */
export async function readVocabProgress(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const m = t.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { current: Number(m[1]), total: Number(m[2]) } : { current: 0, total: 0 };
  });
}

/** 点一次「下一个」，返回是否成功点到 */
export async function clickVocabNext(page, dwellMs = 700) {
  const pt = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div.action.next, [class*="action"][class*="next"]')].find(
      (n) => n.getClientRects().length && !/disabled/.test(String(n.className)),
    );
    if (!el) return '';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  });
  if (!pt) return false;
  const { x, y } = JSON.parse(pt);
  await page.mouse.click(x, y);
  await page.waitForTimeout(Math.max(200, Number(dwellMs) || 700));
  return true;
}

/**
 * 把单词卡片一路点完。
 * @param {object} o
 * @param {boolean} [o.apply] true = 真的点；false = 只读进度（安全）
 */
export async function runUcampusVocab({ page, apply = false, shouldStop = () => false, onProgress = () => {}, readProgress = null, maxSteps = 80, dwellMs = 700 }) {
  await ensurePlayableViewport(page);
  await dismissUcampusDialog(page);

  let { current, total } = await readVocabProgress(page);
  log(`   单词卡片进度 ${current}/${total}`, 'info');
  if (!total) return { ok: false, phase: 'needs-human', error: '找不到卡片进度（可能不在 Vocabulary 页）' };

  let before = null;
  let after = null;
  let steps = 0;
  if (apply) {
    if (readProgress) before = await readProgress().catch(() => null);
    while (current < total && steps < maxSteps) {
      throwIfStopped(shouldStop);
      const ok = await clickVocabNext(page, dwellMs);
      if (!ok) break;
      steps += 1;
      onProgress({ phase: 'vocab', detail: `${current}/${total}` });
      const next = await readVocabProgress(page);
      if (next.current <= current) {
        // 卡住了：可能弹了提示
        await dismissUcampusDialog(page);
        const again = await readVocabProgress(page);
        if (again.current <= current) break;
        current = again.current;
      } else {
        current = next.current;
      }
      await interruptibleSleep(120, shouldStop);
    }
    log(`   卡片已点到 ${current}/${total}（点击 ${steps} 次）`, 'ok');
    if (readProgress) {
      for (let i = 0; i < 8; i += 1) {
        await interruptibleSleep(8000, shouldStop);
        after = await readProgress().catch(() => null);
        if (after && before && Number(after.finishPointNum) > Number(before.finishPointNum)) break;
      }
      log(`   平台进度：${before?.finishPointNum ?? '?'} → ${after?.finishPointNum ?? '?'}`, after && before && Number(after.finishPointNum) > Number(before.finishPointNum) ? 'ok' : 'warn');
    }
  }

  const credited = !!(after && before && Number(after.finishPointNum) > Number(before.finishPointNum));
  return {
    ok: true,
    phase: credited ? 'submitted' : apply ? 'applied-unverified' : 'planned',
    current,
    total,
    steps,
    credited,
    before: before?.finishPointNum ?? null,
    after: after?.finishPointNum ?? null,
  };
}
