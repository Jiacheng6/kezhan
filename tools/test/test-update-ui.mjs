// 本机伪更新服务 + 隔离 Electron，不连接真实账号、不运行真实安装器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { _electron as electron } from 'playwright-core';
const root = process.cwd();
const data = fs.mkdtempSync(path.join(root, '.desktop-test', 'update-ui-'));
const body = Buffer.alloc(256 * 1024, 71);
const sha512 = crypto.createHash('sha512').update(body).digest('base64');
let badHash = false;
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/latest.yml')) {
    response.setHeader('content-type', 'text/yaml');
    response.end(`version: 9.9.9\nfiles:\n  - url: fixture-Setup.exe\n    sha512: ${badHash ? Buffer.alloc(64).toString('base64') : sha512}\n    size: ${body.length}\npath: fixture-Setup.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-14T00:00:00.000Z'\n`);
  } else if (request.url.startsWith('/fixture-Setup.exe')) {
    response.setHeader('content-length', body.length);
    response.end(body);
  } else { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}/`;
const report = { at: '2026-10-14T00:00:00.000Z', courses: [{ courseId: 'sample-course', clazzId: 'sample-class', name: '示例课程甲', taskPoints: [
  { knowledgeId: 'sample-section', secNo: '1.1', sectionName: '示例章节介绍', seq: 0, type: 'video', name: '示例视频', finished: true },
] }] };
fs.mkdirSync(path.join(data, 'data', 'probe-out'), { recursive: true });
fs.mkdirSync(path.join(data, 'edge-profile'), { recursive: true });
const fixtures = { 'state.json': { version: 3, taskPoints: { sample: { status: 'done' } }, settings: { maxRetries: 4 } },
  'local.json': { personId: 'fixture-user' }, 'recon-selection.json': { courses: { 'sample-course': { enabled: true } } },
  'data/probe-out/task-report.json': report, 'edge-profile/Cookies': 'fixture-login-data' };
for (const [name, value] of Object.entries(fixtures)) fs.writeFileSync(path.join(data, name), typeof value === 'string' ? value : JSON.stringify(value));
const before = Object.fromEntries(Object.keys(fixtures).map((name) => [name, fs.readFileSync(path.join(data, name), 'utf8')]));
let application;
async function closeApplication() {
  if (!application) return;
  const current = application;
  application = null;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试软件退出超时')), 20000);
    current.process().once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await current.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); }).catch(() => {});
  await exited;
  await current.close().catch(() => {});
}
async function launch(testData) {
  return electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--test-mode'],
    env: { ...process.env, LOCALAPPDATA: path.join(testData, 'cache-local'), XXT_TEST_DATA_DIR: testData, XXT_TEST_UPDATE_FEED: feed } });
}
try {
  application = await launch(data);
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('.tab[data-tab="courses"]').click();
  await page.locator('#treeSource').filter({ hasText: '已加载' }).waitFor();
  assert.match(await page.locator('#treeSummary').innerText(), /1 门课/);
  assert.equal((await page.evaluate(() => window.desktopApp.info())).dataDir, data);
  await page.locator('#desktopUpdate').click();
  await page.locator('#updateDownload').waitFor({ state: 'visible' });
  await page.locator('#updateDownload').click();
  await page.locator('#updateInstall').waitFor({ state: 'visible', timeout: 30000 });
  const ready = await page.evaluate(() => window.desktopApp.updateState());
  assert.equal(ready.downloadReady, true);
  assert.equal(ready.nextVersion, '9.9.9');
  assert.equal(ready.percent, 100);
  assert.equal(await page.locator('#updateCheck').isDisabled(), true);
  await page.screenshot({ path: path.join(root, '.desktop-test', 'update-ui-ready.png') });
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator('#updateInstall').click();
  assert.equal((await page.evaluate(() => window.desktopApp.updateState())).phase, 'ready', '稍后安装保留已下载文件');
  for (const name of Object.keys(fixtures)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), before[name], name);
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.locator('#updateInstall').click();
  await page.waitForFunction(async () => {
    try { const status = await window.desktopApp.updateState(); return status.phase === 'error' && status.message.includes('测试模式'); }
    catch { return false; }
  });
  assert.equal((await page.evaluate(() => window.desktopApp.updateState())).downloadReady, true);
  const backups = fs.readdirSync(path.join(data, 'updates', 'backups'));
  assert.equal(backups.length, 1, '安装前自动备份');
  for (const name of Object.keys(fixtures)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), before[name], name);
  await closeApplication();
  // 坏 SHA512 的另一实例不能显示安装按钮，且不触碰原数据。
  badHash = true;
  const corruptData = fs.mkdtempSync(path.join(root, '.desktop-test', 'update-corrupt-'));
  application = await launch(corruptData);
  const corruptPage = await application.firstWindow();
  await corruptPage.waitForURL('http://127.0.0.1:*/');
  await corruptPage.locator('#desktopUpdate').click();
  await corruptPage.locator('#updateDownload').waitFor({ state: 'visible' });
  await corruptPage.locator('#updateDownload').click();
  await corruptPage.locator('#updateMessage').filter({ hasText: '校验失败' }).waitFor({ timeout: 30000 });
  assert.equal(await corruptPage.locator('#updateInstall').isVisible(), false);
  console.log('✓ 内置更新真实检查/下载/校验、取消/保存安装、课程自动加载、登录与进度保留、坏校验阻止安装通过');
} catch (error) {
  if (application) {
    const errorPage = await application.firstWindow().catch(() => null);
    if (errorPage) {
      console.log('更新测试状态：', await errorPage.evaluate(() => window.desktopApp.updateState()).catch((e) => e.message));
      await errorPage.screenshot({ path: path.join(root, '.desktop-test', 'update-ui-failure.png') }).catch(() => {});
    }
  }
  throw error;
} finally {
  await closeApplication();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
