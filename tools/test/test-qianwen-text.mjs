/**
 * 千问可用性自检：新对话 + 纯文字提问，确认千问本身还能不能答。
 * （用于把"千问坏了"和"我们的图片链路坏了"区分开）
 *
 * 用法: node tools/test/test-qianwen-text.mjs ["问题文本"]
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';
import { newChat, typePrompt, send, readAnswer, waitAnswer, detectVerification } from '../../src/ai/ai.mjs';

const q = process.argv[2] || '1+1等于几？只回答数字，不要解释。';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));
if (!page) {
  console.error('没有千问页');
  process.exit(1);
}

console.log('先开新对话…');
await newChat(page);
await page.waitForTimeout(1500);

const typed = await typePrompt(page, q);
console.log('编辑器:', JSON.stringify(typed));

const sent = await send(page);
console.log('发送:', JSON.stringify(sent));
if (!sent.ok) process.exit(1);

const r = await waitAnswer(page, {
  timeoutMs: 90000,
  stableRounds: 3,
  onTick: (t) => process.stdout.write(`  [${t.waitedSec}s len=${t.len} generating=${t.generating}]\n`),
});
console.log('回答:', JSON.stringify(r, null, 2));
const v = await detectVerification(page).catch(() => null);
console.log('风控:', JSON.stringify(v));

await b.close().catch(() => {});
process.exit(0);
