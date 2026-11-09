/**
 * 在「此刻真实开着的弹窗题」上跑完整自动作答流程（截图 → 千问 → 解析 → 点选 → 提交）。
 * 用于验证 src/chaoxing/videoquiz.mjs 端到端，且不抛异常（会打印真实错误）。
 *
 * 用法: node tools/test/test-videoquiz-flow.mjs [最多跑几秒]
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';
import { watchVideoQuiz, findVideoQuiz, extractVideoQuiz } from '../../src/chaoxing/videoquiz.mjs';
import { log } from '../../src/logbus.mjs';

const maxSec = Number(process.argv[2] || 180);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const qianwenPage = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));

let page = null;
for (const p of ctx.pages()) {
  if (!/knowledge\/cards/.test(p.url())) continue;
  const hit = await findVideoQuiz(p);
  if (hit) {
    page = p;
    console.log('找到带弹窗题的页面:', p.url().slice(0, 90));
    const q = await extractVideoQuiz(hit.frame);
    console.log('题目:', JSON.stringify({ type: q?.qtypeRaw, stem: q?.stemTextRaw, opts: q?.options?.map((o) => `${o.letter}:${o.text}`) }, null, 2));
    break;
  }
}
if (!page) {
  console.error('当前没有可见的弹窗题页面');
  process.exit(1);
}
console.log('千问页:', qianwenPage ? qianwenPage.url().slice(0, 60) : '(没有)');

const shared = { quizOpen: true };
const t0 = Date.now();
let done = false;

try {
  const r = await watchVideoQuiz({
    page,
    qianwenPage,
    shared,
    intervalMs: 1500,
    shouldStop: () => done || Date.now() - t0 > maxSec * 1000,
    onEvent: (e) => {
      console.log('[event]', JSON.stringify({ ok: e.ok, letters: e.letters, confidence: e.confidence, verdict: e.verdict, wrong: e.wrong }));
      done = true;
    },
  });
  console.log('watchVideoQuiz 返回:', JSON.stringify(r, null, 2));
} catch (e) {
  console.error('watchVideoQuiz 抛异常:', e.stack || e.message);
}

await b.close().catch(() => {});
process.exit(0);
