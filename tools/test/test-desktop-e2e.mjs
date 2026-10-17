// 使用空测试数据和 about:blank；不访问学习通，不使用用户登录态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { ROOT } from '../../src/config.mjs';
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
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).showInactive());
  await window.evaluate(()=>localStorage.setItem('xxt-library-startup','skip'));
  await window.reload();
  await revealTestTools(window);
  await window.locator('#desktopToolbar').waitFor({ state: 'visible' });
  assert.equal(await window.locator('h1').innerText(), '学习通助手');
  const run = window.locator('[data-action="startRun"]');
  assert.ok(await run.count() >= 1);
  for(let i=0;i<await run.count();i++)assert.equal(await run.nth(i).isDisabled(), true);
  assert.equal(await window.locator('#overviewStart').isDisabled(),true);
  assert.equal(await window.evaluate(async()=> (await window.desktopApp.info()).browser), 'embedded');
  await window.evaluate(()=>window.desktopApp.browser(true));
  await window.locator('#embeddedBrowser').waitFor({state:'visible'});
  await window.locator('#webReturn').click();
  await window.locator('#embeddedBrowser').waitFor({state:'hidden'});
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).showInactive();
    BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).close();
  });
  await window.locator('#closeHide').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).isVisible()), false);
  assert.equal(await window.locator('h1').innerText(), '学习通助手', '隐藏后页面和后台仍可用');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).show();
    BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).close();
  });
  await window.locator('#closeCancel').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).isVisible()), true);
  console.log('✓ 独立窗口、未登录任务入口禁用、关闭选择隐藏、取消退出通过');
  const exited = new Promise(resolve => application.process().once('exit',resolve));
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).close();
  });
  await window.locator('#closeExit').click();
  await exited;
  assert.match(fs.readFileSync(path.join(data, 'logs', 'desktop.log'), 'utf8'), /后台退出 0/);
  console.log('✓ 选择退出后，后台有序退出通过');
} finally { await requestTestExit(application).catch(()=>{}); await application.close().catch(() => {}); }
