/**
 * U校园 AI 版：文本作答类节点（简答题 Quiz / 翻译 Translation / 选词填空的文本形式）。
 *
 * 真机结构（2026-11-02）：
 *   · `Reading comprehension` 节点里有 9 个 `textarea`（placeholder「请输入答案...」）；
 *   · 每个 textarea 上方就是题干（"1. What does the president promise..."）；
 *   · 没有选择题控件、也没有明显的提交按钮（作答后自动保存，节点按完成度记账）。
 *
 * 流程：读题干 → 渲染"材料 + 题干"白底图 → 问 AI → 填回 textarea → （可选）点提交 → 读平台进度验收。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';
import { ensurePlayableViewport, clickSubmitButton, requireUcampusReady } from './quiz.mjs';

/** 读页面上的所有文本框 + 题干 + 材料上下文 */
export async function readTextQuestions(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el.getClientRects().length;
    const inputs = [...document.querySelectorAll('input[type="text"], textarea')].filter(visible);
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    const rows = [];
    for (const [i, el] of inputs.entries()) {
      let prompt = '';
      let cur = el.parentElement;
      for (let k = 0; k < 5 && cur && !prompt; k += 1, cur = cur.parentElement) {
        const t = (cur.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 8 && !/^\d+\s*$/.test(t)) prompt = t.slice(0, 300);
      }
      rows.push({ index: i, prompt, placeholder: el.getAttribute('placeholder') || '', tag: el.tagName });
    }
    // 材料：尽量取题干之前的那段长文本（阅读文章）
    const firstPromptAt = bodyText.indexOf(rows[0]?.prompt?.slice(0, 20) || '');
    const material = firstPromptAt > 200 ? bodyText.slice(Math.max(0, firstPromptAt - 2600), firstPromptAt) : bodyText.slice(0, 2600);
    return { rows, material };
  });
}

/** 把"材料 + 题干"渲染成一张白底图（AI 需要看图） */
export async function renderTextCard(page, material, question, file) {
  const dataUrl = await page.evaluate(
    ({ material, question }) => {
      const W = 1100;
      const pad = 28;
      const lineH = 26;
      const font = '17px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
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
          } else line = test;
        }
        if (line) out.push(line);
        return out;
      };
      const matLines = wrap(material || '', W - pad * 2).slice(0, 46);
      const qLines = wrap(question || '', W - pad * 2);
      const H = pad * 2 + matLines.length * lineH + 16 + qLines.length * lineH + 10;
      canvas.width = W;
      canvas.height = H;
      const c = canvas.getContext('2d');
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#111111';
      c.font = font;
      let y = pad + lineH - 8;
      for (const l of matLines) {
        c.fillText(l, pad, y);
        y += lineH;
      }
      y += 16;
      c.fillStyle = '#0033aa';
      for (const l of qLines) {
        c.fillText(l, pad, y);
        y += lineH;
      }
      return canvas.toDataURL('image/png');
    },
    { material, question },
  );
  if (!dataUrl?.startsWith('data:image/png;base64,')) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  return file;
}

/** 把文本填进第 index 个文本框（走 React 的 native setter，否则页面不认） */
export async function fillTextAnswer(page, index, text) {
  return page.evaluate(
    ({ i, value }) => {
      const visible = (el) => !!el.getClientRects().length;
      const inputs = [...document.querySelectorAll('input[type="text"], textarea')].filter(visible);
      const el = inputs[i];
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      el.focus();
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return el.value === value;
    },
    { i: index, value: text },
  );
}

/**
 * 跑一个"文本作答"页面：读题干 →（逐个）问 AI → 填回 → 提交 → 验收。
 */
export async function runUcampusTextQuiz({ page, ask, apply = false, limit = 99, shouldStop = () => false, onProgress = () => {}, outDir, readProgress = null }) {
  await ensurePlayableViewport(page);
  await requireUcampusReady(page);
  const { rows, material } = await readTextQuestions(page);
  log(`   读到 ${rows.length} 个文本框`, 'info');
  if (!rows.length) return { ok: false, phase: 'needs-human', error: '页面上没有可作答的文本框' };

  const dir = outDir || path.join(process.cwd(), '.build-cache', 'uai-text');
  const plan = [];
  for (const row of rows.slice(0, limit)) {
    throwIfStopped(shouldStop);
    onProgress({ phase: 'text-quiz', detail: `第 ${row.index + 1}/${rows.length} 题` });
    if (!row.prompt || row.prompt.length < 6) {
      plan.push({ index: row.index, ok: false, error: '找不到题干' });
      continue;
    }
    const imagePath = await renderTextCard(page, material, row.prompt, path.join(dir, `q${String(row.index + 1).padStart(2, '0')}-${Date.now()}.png`));
    if (!imagePath) {
      plan.push({ index: row.index, ok: false, error: '出图失败' });
      continue;
    }
    let answer;
    try {
      answer = await ask({
        imagePath,
        prompt: [
          '下面是一道英语课本的书面回答题（材料在上、题目在下）。',
          '请依据材料作答，用完整英文句子，简洁准确。',
          '只输出答案本身，不要解释、不要复述题目、不要加"答案："前缀。',
        ].join('\n'),
        question: { qtype: 'essay' },
      });
    } catch (error) {
      plan.push({ index: row.index, ok: false, error: String(error.message || error).slice(0, 80) });
      continue;
    }
    const text = String(answer?.answer || '')
      .replace(/^\s*(答案|Answer)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const usable = answer?.ok && text.length >= 8 && !/看不清|无法判断/.test(text);
    plan.push({ index: row.index, prompt: row.prompt.slice(0, 60), text, usable:usable&&text.length<=10000, error: answer?.ok ? '' : String(answer?.error || '').slice(0, 80) });
    log(`   第 ${row.index + 1} 题：${usable ? '答案 ' + text.slice(0, 60) : '不可用（' + (answer?.answer || answer?.error || '').slice(0, 40) + '）'}`, usable ? 'info' : 'warn');
    await interruptibleSleep(300, shouldStop);
  }

  const allUsable = plan.length > 0 && plan.every((p) => p.usable);
  let filled = 0;
  let submitted = false;
  let before = null;
  let after = null;
  if (apply && allUsable) {
    if (readProgress) before = await readProgress().catch(() => null);
    for (const p of plan) {
      if (!p.usable) continue;
      if (await fillTextAnswer(page, p.index, p.text)) filled += 1;
      await page.waitForTimeout(250);
    }
    const click = await clickSubmitButton(page);
    submitted = !!click.ok;
    log(`   已填写 ${filled} 处；提交：${click.note}`, submitted ? 'ok' : 'warn');
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
    ok: !apply || credited,
    phase: credited ? 'submitted' : apply ? 'applied-unverified' : 'planned',
    ...(apply&&!credited?{error:allUsable?'U校园已尝试填写，但平台尚未确认完成，请核对原网页':'U校园仍有未取得可靠答案的题，未提交'}:{}),
    questions: plan.length,
    allUsable,
    filled,
    submitted,
    credited,
    before: before?.finishPointNum ?? null,
    after: after?.finishPointNum ?? null,
    plan,
  };
}
