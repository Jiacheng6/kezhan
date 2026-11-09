/**
 * 验证 connectOverCDP 拿到的 browser.close() 会不会真的把 Edge 关掉。
 * 结论将决定所有工具脚本要不要去掉 b.close()。
 */
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
console.log('连接成功，页面数:', b.contexts()[0].pages().length);

await b.close();
console.log('已调用 b.close()');

await new Promise((r) => setTimeout(r, 2500));

// 再用 HTTP 探一次 9222 是否还在
try {
  const r = await fetch('http://127.0.0.1:9222/json/version');
  const j = await r.json();
  console.log('9222 仍在:', j.Browser);
} catch (e) {
  console.log('9222 已消失:', e.message);
}
