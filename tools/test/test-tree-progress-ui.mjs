// 隔离软件实例验证真实课程树，不连接真实账号，不启动课程任务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = process.cwd();
fs.mkdirSync(path.join(root, '.desktop-test'), { recursive: true });
const data = fs.mkdtempSync(path.join(root, '.desktop-test', 'tree-ui-'));
const report = { at: '2026-01-01T00:00:00Z', courses: [{ courseId: 'example-course', clazzId: 'example-class', name: '示例课程甲', taskPoints: [
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', name: '示例视频', type: 'video', finished: false },
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', name: '章节测验', type: 'work', finished: false },
] }] };
const state = { version: 3, taskPoints: {
  'example-course:example-section:t0': { status: 'done' },
  'example-course:example-section:t1': { status: 'manual' },
} };
fs.mkdirSync(path.join(data, 'data/probe-out'), { recursive: true });
fs.writeFileSync(path.join(data, 'data/probe-out/task-report.json'), JSON.stringify(report));
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(state));
const executablePath = process.env.XXT_TREE_TEST_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
const application = await electron.launch({ executablePath,
  args: [...(process.env.XXT_TREE_TEST_EXE ? [] : [root]), '--test-mode'],
  env: { ...process.env, XXT_TEST_DATA_DIR: data } });
try {
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('.tab[data-tab="courses"]').click();
  await page.locator('#treeSource').filter({ hasText: '已加载' }).waitFor();
  await page.locator('.treehead').click();
  assert.equal(await page.locator('.tprow').count(), 2);
  assert.equal(await page.locator('.tprow .task-status').nth(0).innerText(), '已完成');
  assert.equal(await page.locator('.tprow .task-status').nth(1).innerText(), '未完成 · 待人工');
  assert.match(await page.locator('.sechead').innerText(), /已完成 1\/2/);
  await page.screenshot({ path: path.join(root, '.desktop-test/tree-progress-fixed.png'), fullPage: true });
  await page.locator('.tprow input[type=checkbox]').nth(0).uncheck();
  assert.equal(await page.locator('#treeDirty').isVisible(), true);
  // 模拟后台执行记录更新：真实定时刷新应更新标签、保留未保存勾选与展开状态。
  state.taskPoints['example-course:example-section:t1'].status = 'done';
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(state));
  await page.locator('.sechead').filter({ hasText: '已完成 2/2' }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.tprow .task-done').count(), 2);
  assert.equal(await page.locator('.tprow input[type=checkbox]').nth(0).isChecked(), false);
  assert.equal(await page.locator('#treeDirty').isVisible(), true);
  assert.equal(await page.locator('.treecourse.open').count(), 1);
  assert.equal(fs.existsSync(path.join(data, 'recon-selection.json')), false, '刷新不自动保存选择');
  console.log('✓ 真实桌面课程树显示视频已完成/测验待人工、小节 1/2、自动刷新到 2/2 并保留未保存选择通过');
} finally {
  const exited = new Promise((resolve) => application.process().once('exit', resolve));
  await application.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 }); app.quit();
  }).catch(() => {});
  await exited;
  await application.close().catch(() => {});
}
