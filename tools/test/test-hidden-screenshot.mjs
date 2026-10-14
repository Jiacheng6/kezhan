import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, EDGE_FLAGS } from '../../src/config.mjs';
import { findEdge } from '../../src/browser/launch.mjs';
import { shootQuestion } from '../../src/chaoxing/quiz.mjs';
process.env.XXT_DESKTOP = '1';
const { startWindowControl, setBrowserVisible, stopWindowControl } = await import('../../src/browser/window-control.mjs');
const data = path.join(ROOT, '.desktop-test', 'hidden-screenshot');
fs.mkdirSync(data, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(data, 'empty-profile'), {
  executablePath: findEdge(), headless: false,
  args: EDGE_FLAGS.filter((flag) => !flag.startsWith('--user-data-dir=') && !flag.startsWith('--remote-debugging-port=') && flag !== '--restore-last-session'),
});
try {
  const page = context.pages()[0];
  await page.setContent('<body style="margin:0;padding:40px"><iframe style="border:0;width:800px;height:540px"></iframe></body>');
  const frame = page.frames()[1];
  await frame.setContent('<style>body{margin:0}.TiMu{width:600px;height:280px;background:#daf4e7;border:0;font:24px sans-serif;padding:12px;box-sizing:border-box}.square{width:90px;height:90px;background:#c93926}</style><div style="height:700px"></div><div class="TiMu"><b id="label">VISIBLE</b><p>Hidden window screenshot regression</p><div class="square"></div></div>');
  await startWindowControl(context.browser());
  const visible = await shootQuestion(frame, 0, data);
  assert.ok(fs.statSync(visible).size > 1000);
  // 稳定性检查的故障机制：持续变化的元素会让旧截图永远等待。
  await frame.addStyleTag({ content: '@keyframes moving{from{transform:translateX(0)}to{transform:translateX(30px)}}.TiMu{animation:moving .5s linear infinite alternate}' });
  await assert.rejects(() => frame.locator('.TiMu').screenshot({ timeout: 1500 }), /Timeout/);
  console.log('已复现元素持续变化时旧截图等待稳定超时');
  await frame.locator('.TiMu').evaluate((node) => { node.style.animation = 'none'; });
  await setBrowserVisible(false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    await frame.locator('.TiMu').screenshot({ timeout: 1500 });
    console.log('旧元素截图此次可用，继续验证隐藏截图内容');
  } catch (err) {
    assert.match(err.message, /Timeout/);
    console.log('已复现旧元素截图等待稳定超时');
  }
  await frame.locator('#label').evaluate((node) => { node.textContent = 'HIDDEN NEW CONTENT'; });
  const started = Date.now();
  const hidden = await shootQuestion(frame, 0, data);
  assert.ok(Date.now() - started < 8000);
  const image = fs.readFileSync(hidden);
  assert.equal(image.readUInt32BE(16), 600);
  assert.equal(image.readUInt32BE(20), 280);
  assert.equal((await setBrowserVisible(false)).visibleCount, 0, '截图不得显示浏览器');
  await setBrowserVisible(true);
  const reference = await shootQuestion(frame, 0, data);
  assert.deepEqual(fs.readFileSync(reference), image, '隐藏截图必须与可见时内容一致，不能返回空白或旧帧');
  await assert.rejects(() => shootQuestion(frame, 0, data, { shouldStop: () => true }), { code: 'STOPPED' });
  fs.copyFileSync(hidden, path.join(data, 'verified-hidden.png'));
  console.log('✓ 隐藏窗口截图、iframe 裁剪、内容更新、像素一致、取消截图通过');
} finally { stopWindowControl(); await context.close(); }
