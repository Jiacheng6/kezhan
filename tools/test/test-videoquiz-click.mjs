// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * 在真实弹窗题上验证「点选 → 提交 → 判定结果 → 继续」这条链。
 *
 * 前提：先跑 tools/diag/diag-videoquiz.mjs，让它把弹窗留着别关。
 * 本工具不调 AI（题目是已知的：示例学习内容的作者 = A、示例学习内容），
 * 只验证 DOM 操作与站点反馈，避免把 AI 的不确定性混进来。
 *
 * 用法: node tools/test/test-videoquiz-click.mjs [answerLetter]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { DEBUG_PORT } from '../../src/config.mjs';

const want = (process.argv[2] || 'A').toUpperCase();

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];

/* ---- 找到那张还开着弹窗题的页面 ---- */
let page = null;
let frame = null;
for (const p of ctx.pages()) {
  if (!/knowledge\/cards/.test(p.url())) continue;
  for (const f of p.frames()) {
    const ok = await f
      .evaluate(() => {
        const el = document.querySelector('.ans-videoquiz');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && el.getBoundingClientRect().height > 20;
      })
      .catch(() => false);
    if (ok) {
      page = p;
      frame = f;
      break;
    }
  }
  if (frame) break;
}

if (!frame) {
  console.error('没找到还开着的弹窗题页面。先跑: node tools/diag/diag-videoquiz.mjs 900000122 1.1 240');
  process.exit(1);
}
console.log('页面:', page.url().slice(0, 100));
console.log('frame:', frame.url().slice(0, 80));

/* ---- 1) 结构化提取（这正是将来 videoquiz.mjs 要做到的） ---- */
const q = await frame.evaluate(() => {
  const root = document.querySelector('.ans-videoquiz');
  const t = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const qtypeRaw = t(root.querySelector('.tkTopic_title'));
  const stem = t(root.querySelector('.tkItem_title'));
  const options = Array.from(root.querySelectorAll('li.ans-videoquiz-opt')).map((li, i) => {
    const input = li.querySelector('input');
    const raw = t(li);
    const m = raw.match(/^\s*([A-Za-z])\s*[、.．)）]/);
    return {
      domIndex: i,
      letter: m ? m[1].toUpperCase() : null,
      text: m ? raw.replace(/^\s*[A-Za-z]\s*[、.．)）]\s*/, '').trim() : raw,
      raw,
      kind: input ? input.type : null,
      name: input ? input.name : null,
      checked: input ? input.checked : null,
    };
  });
  const btns = Array.from(root.querySelectorAll('a')).map((a) => ({
    text: t(a),
    id: a.id,
    cls: String(a.className),
    visible: getComputedStyle(a).display !== 'none',
  }));
  return { qtypeRaw, stem, options, btns, rootId: root.id };
});

console.log('题型:', q.qtypeRaw, '| 题干:', q.stem);
for (const o of q.options) console.log(`  选项[${o.domIndex}] ${o.letter} ${o.text} (${o.kind}) checked=${o.checked}`);
console.log('按钮:', JSON.stringify(q.btns));

/* ---- 2) 点选目标选项（原生 click） ---- */
const target = q.options.find((o) => o.letter === want);
if (!target) {
  console.error('没有选项', want);
  process.exit(1);
}
await frame.locator('li.ans-videoquiz-opt').nth(target.domIndex).click({ timeout: 8000 });
await page.waitForTimeout(400);

const afterClick = await frame.evaluate(() =>
  Array.from(document.querySelectorAll('li.ans-videoquiz-opt')).map((li, i) => ({
    i,
    checked: li.querySelector('input')?.checked ?? null,
    cls: String(li.className),
  })),
);
console.log('点选后:', JSON.stringify(afterClick));

/* ---- 3) 提交（关键：必须原生 click，JS .click() 学习通会忽略） ---- */
mkdirSync('data/probe-out/videoquiz', { recursive: true });
await page.screenshot({ path: 'data/probe-out/videoquiz/after-click.png' }).catch(() => {});

await frame.locator('#videoquiz-submit').click({ timeout: 8000 });
console.log('已点提交');

/* ---- 4) 等站点反馈 ---- */
let verdict = null;
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(500);
  verdict = await frame
    .evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      };
      const t = (sel) => (document.querySelector(sel)?.textContent || '').trim();
      return {
        correct: vis('#spanHas'),
        wrong: vis('#spanNot'),
        wrongBack: vis('#spanNotBack'),
        hasText: t('#spanHas'),
        wrongText: t('#spanNot'),
        backText: t('#spanNotBack'),
        continueVisible: vis('#videoquiz-continue'),
        submitting: vis('#videoquiz-submitting'),
        quizStillThere: vis('.ans-videoquiz'),
      };
    })
    .catch(() => null);
  if (!verdict) continue;
  if (verdict.correct || verdict.wrong || verdict.wrongBack) break;
}
console.log('站点反馈:', JSON.stringify(verdict));
await page.screenshot({ path: 'data/probe-out/videoquiz/after-submit.png' }).catch(() => {});

/* ---- 5) 点「继续」恢复播放 ---- */
if (verdict?.continueVisible) {
  await frame.locator('#videoquiz-continue').click({ timeout: 8000 }).catch((e) => console.log('继续按钮点击失败:', e.message));
  await page.waitForTimeout(1500);
  console.log('已点「继续」');
}
await page.screenshot({ path: 'data/probe-out/videoquiz/after-continue.png' }).catch(() => {});

const final = await frame
  .evaluate(() => {
    const v = document.querySelector('video');
    return {
      quizVisible: (() => {
        const el = document.querySelector('.ans-videoquiz');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      paused: v ? v.paused : null,
      currentTime: v ? Math.round(v.currentTime * 10) / 10 : null,
      duration: v ? Math.round(v.duration) : null,
    };
  })
  .catch(() => null);
console.log('最终状态:', JSON.stringify(final));
console.log('截图: data/probe-out/videoquiz/after-click.png / after-submit.png / after-continue.png');

await b.close().catch(() => {});
process.exit(0);
