// 使用空测试数据和 about:blank；不访问学习通，不使用用户登录态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, chromium } from 'playwright-core';
import { ROOT } from '../../src/config.mjs';
import { findEdge } from '../../src/browser/launch.mjs';
import { requestTestExit, revealTestTools } from './desktop-test-helpers.mjs';

fs.mkdirSync(path.join(ROOT,'.desktop-test'), { recursive: true });
const data = fs.mkdtempSync(path.join(ROOT, '.desktop-test', 'e2e-'));
const application = await electron.launch({ args: [ROOT, '--test-mode'],
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  env: { ...process.env, XXT_TEST_DATA_DIR: data },
});
// 使用测试模式，不触发自动任务和真实账号登录。
try {
  const window = await application.firstWindow();
  await window.waitForURL('http://127.0.0.1:*/');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
  await window.evaluate(()=>localStorage.setItem('xxt-library-startup','skip'));
  await window.reload();
  await revealTestTools(window);
  await window.locator('#desktopToolbar').waitFor({ state: 'visible' });
  assert.equal(await window.locator('h1').innerText(), '学习通助手');
  const run = window.locator('[data-action="startRun"]');
  assert.ok(await run.count() >= 1);
  for(let i=0;i<await run.count();i++)assert.equal(await run.nth(i).isDisabled(), true);
  assert.equal(await window.locator('#overviewStart').isDisabled(),true);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    BrowserWindow.getAllWindows()[0].close();
  });
  await window.locator('#closeHide').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(await window.locator('h1').innerText(), '学习通助手', '隐藏后页面和后台仍可用');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show();
    BrowserWindow.getAllWindows()[0].close();
  });
  await window.locator('#closeCancel').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  console.log('✓ 独立窗口、未登录任务入口禁用、关闭选择隐藏、取消退出通过');
  const exited = new Promise(resolve => application.process().once('exit',resolve));
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await window.locator('#closeExit').click();
  await exited;
  assert.match(fs.readFileSync(path.join(data, 'logs', 'desktop.log'), 'utf8'), /后台退出 0/);
  console.log('✓ 选择退出后，后台有序退出通过');
} finally { await requestTestExit(application).catch(()=>{}); await application.close().catch(() => {}); }

process.env.XXT_DESKTOP = '1';
const { startWindowControl, setBrowserVisible, stopWindowControl } = await import('../../src/browser/window-control.mjs');
const context = await chromium.launchPersistentContext(path.join(data, 'empty-edge-profile'), {
  executablePath: findEdge(), headless: false, args: ['--no-first-run', '--disable-sync'],
});
try {
  await startWindowControl(context.browser());
  const hidden = await setBrowserVisible(false);
  assert.equal(hidden.visible, false);
  assert.ok(hidden.count > 0);
  assert.equal(hidden.visibleCount, 0, 'Windows 确认窗口已隐藏');
  assert.equal(hidden.closeDisabledCount, hidden.count, '浏览器窗口关闭入口已禁用');
  const page = context.pages()[0];
  await page.setContent('<body>background test</body>');
  assert.equal(await page.evaluate(() => 21 * 2), 42, '隐藏浏览器后页面继续运行');
  const shown = await setBrowserVisible(true);
  assert.equal(shown.visible, true);
  assert.ok(shown.count > 0);
  assert.equal(shown.visibleCount, shown.count, 'Windows 确认窗口重新可见');
  console.log('✓ 专用 Edge 实窗隐藏、后台执行、重新显示通过');
} finally { stopWindowControl(); await context.close(); }
