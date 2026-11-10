/**
 * U校园 AI 版：Banked cloze（拖拽式选词填空）。
 *
 * 真机结构（2026-11-02）：
 *   · 文章在 `[class*="banked-cloze-scoop"]` 里，每个空是
 *     `span.fe-scoop[data-scoop-index] > span.input-wrapper > div.comp-abs-input > input`；
 *   · 词库是 `div.option`（拖拽组件 react-beautiful-dnd）；
 *   · 拖拽 / 点词 / 键盘输入都**不生效**，但 Playwright 的 `fill()` 可以（走原生事件，React 认）；
 *   · 提交仍是底部 `A.btn`「提 交」。
 */
import path from 'node:path';
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';
import { ensurePlayableViewport, clickSubmitButton } from './quiz.mjs';
import { renderTextCard } from './textquiz.mjs';

/** 读文章（带空标记）+ 词库 */
export async function readCloze(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el.getClientRects().length;
    const scoop = [...document.querySelectorAll('[class*="banked-cloze-scoop"]')].find(visible);
    if (!scoop) return { ok: false };
    const clone = scoop.cloneNode(true);
    const blanks = [...clone.querySelectorAll('.fe-scoop')];
    for (const [i, b] of blanks.entries()) {
      const holder = document.createElement('span');
      holder.textContent = ` [${i + 1}] `;
      b.replaceWith(holder);
    }
    const passage = (clone.innerText || '').replace(/\s+/g, ' ').trim();
    const words = [...document.querySelectorAll('div.option')]
      .filter((el) => visible(el))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean);
    const uniq = [];
    for (const w of words) if (!uniq.includes(w)) uniq.push(w);
    return { ok: true, passage, words: uniq, blankCount: blanks.length };
  });
}

/** 把词填进第 index 个空（用 Playwright 的 fill，原生事件才被 React 接受） */
export async function fillClozeBlank(page, index, word) {
  const inputs = page.locator('.fe-scoop input');
  const count = await inputs.count();
  if (index >= count) return false;
  await inputs.nth(index).scrollIntoViewIfNeeded().catch(() => {});
  await inputs.nth(index).fill(String(word).trim(), { timeout: 8000 });
  await page.waitForTimeout(150);
  const value = await inputs.nth(index).inputValue().catch(() => '');
  return String(value).trim().toLowerCase() === String(word).trim().toLowerCase();
}

/**
 * 跑一个 Banked cloze：读文章 → 问 AI 选词 → fill → 提交 → 验收。
 */
export async function runUcampusCloze({ page, ask, apply = false, shouldStop = () => false, onProgress = () => {}, outDir, readProgress = null }) {
  await ensurePlayableViewport(page);
  const data = await readCloze(page);
  if (!data.ok) return { ok: false, phase: 'needs-human', error: '页面上找不到 Banked cloze 文章' };
  log(`   读到 ${data.blankCount} 个空，词库 ${data.words.length} 个词`, 'info');

  if (data.blankCount === 0 || data.words.length === 0) {
    return { ok: false, phase: 'needs-human', error: '空格或词库为空' };
  }

  onProgress({ phase: 'cloze', detail: `${data.blankCount} 个空` });
  const card = await renderTextCard(
    page,
    `文章（[n] 处是空）：\n${data.passage}`,
    `词库（只能从这里选，每个词最多用一次）：${data.words.join(' / ')}\n\n请为 1..${data.blankCount} 每个空选一个词。`,
    path.join(outDir || path.join(process.cwd(), '.build-cache', 'uai-cloze'), `cloze-${Date.now()}.png`),
  );
  if (!card) return { ok: false, phase: 'needs-human', error: '出图失败' };

  let answer;
  try {
    answer = await ask({
      imagePath: card,
      prompt: [
        '下面是英语选词填空（banked cloze）。词库里的词只能用一次。',
        `请为第 1 到第 ${data.blankCount} 个空各选一个词。`,
        '严格按这个格式输出，每行一个，不要解释：',
        '1) word',
        '2) word',
        '...',
        '只输出答案行。看不清就说明，不要猜。',
      ].join('\n'),
      question: { qtype: 'essay' },
    });
  } catch (error) {
    return { ok: false, phase: 'blocked-ai', error: String(error.message || error).slice(0, 100) };
  }

  const raw = String(answer?.answer || '');
  log(`   AI 原文：${raw.replace(/\s+/g, ' ').slice(0, 220)}`, 'info');
  const picks = [];
  for (const line of raw.split(/[\n;；]+/)) {
    const m = line.match(/(\d{1,2})\s*[).、:：]\s*([A-Za-z][A-Za-z'-]*)/);
    if (m) picks.push({ index: Number(m[1]) - 1, word: m[2] });
  }
  /*
   * 真机踩到：豆包经常不按 "1) word" 的格式，而是**直接按顺序把词排一行**
   * （例：`motivates professional beneficial various ...`）。
   * 这种情况只要词数够，就按顺序对应 1..N。
   */
  if (!picks.length) {
    const bank = data.words.map((w) => w.toLowerCase());
    const tokens = raw.split(/[\s,，、;；]+/).map((w) => w.replace(/[^A-Za-z'-]/g, '')).filter((w) => w.length > 1);
    const ordered = tokens.filter((w) => bank.includes(w.toLowerCase()));
    if (ordered.length >= data.blankCount) {
      for (let i = 0; i < data.blankCount; i += 1) picks.push({ index: i, word: ordered[i] });
    }
  }
  const plan = picks
    .filter((p) => p.index >= 0 && p.index < data.blankCount)
    .map((p) => ({ ...p, inBank: data.words.map((w) => w.toLowerCase()).includes(p.word.toLowerCase()) }));

  const allUsable = plan.length === data.blankCount && plan.every((p) => p.inBank);
  log(`   AI 给出 ${plan.length}/${data.blankCount} 个词，合法=${allUsable}`, allUsable ? 'info' : 'warn');

  let filled = 0;
  let submitted = false;
  let before = null;
  let after = null;
  if (apply && allUsable) {
    if (readProgress) before = await readProgress().catch(() => null);
    for (const p of plan) {
      throwIfStopped(shouldStop);
      const okFill = await fillClozeBlank(page, p.index, data.words.find((w) => w.toLowerCase() === p.word.toLowerCase()) || p.word);
      if (okFill) filled += 1;
      await interruptibleSleep(120, shouldStop);
    }
    const click = await clickSubmitButton(page);
    submitted = !!click.ok;
    log(`   已填 ${filled}/${data.blankCount} 个空；提交：${click.note}`, submitted ? 'ok' : 'warn');
    if (readProgress && submitted) {
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
    ok: !apply || credited,
    phase: credited ? 'submitted' : apply ? 'applied-unverified' : 'planned',
    ...(apply&&!credited?{error:allUsable?'U校园已尝试填写，但平台尚未确认完成，请核对原网页':'U校园仍有未取得可靠答案的空，未提交'}:{}),
    blanks: data.blankCount,
    words: data.words.length,
    allUsable,
    filled,
    submitted,
    credited,
    before: before?.finishPointNum ?? null,
    after: after?.finishPointNum ?? null,
    plan,
  };
}
