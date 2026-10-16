import { requestTestExit, enterTestWorkspace, revealTestTools, openTestArchive } from './desktop-test-helpers.mjs';
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
let feedVersion='9.9.9',checks=0,downloads=0;
const notes='• 启动时检查新版本\n• 课程完成状态显示修复\n• 登录与学习进度保留';
let feedNotes = '# 学习通助手 9.9.9\n\n## 本次更新\n\n' + notes + '\n• 更多细节说明\n\n## 下载与升级\n\n- Windows 10 / 11，64 位\n- 安装版：fixture-Setup.exe';
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/latest.yml')) {
    checks++;
    response.setHeader('content-type', 'text/yaml');
    response.end(`version: ${feedVersion}\nreleaseNotes: ${JSON.stringify(feedNotes)}\nfiles:\n  - url: fixture-Setup.exe\n    sha512: ${badHash ? Buffer.alloc(64).toString('base64') : sha512}\n    size: ${body.length}\npath: fixture-Setup.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-14T00:00:00.000Z'\n`);
  } else if (request.url.startsWith('/fixture-Setup.exe')) {
    downloads++;
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
// This fixture has already completed the current guide. Upgrade migration and
// first-use priority are covered separately, so updating must preserve it exactly.
const fixtures = { 'state.json': { version: 3, onboarding: {version: 2, completedAt: '2026-01-01T00:00:00.000Z'}, taskPoints: { sample: { status: 'done' } }, settings: { maxRetries: 4 } },
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
  await requestTestExit(current).catch(()=>{});
  await exited;
  await current.close().catch(() => {});
}
async function launch(testData) {
  const packagedExe=process.env.XXT_UPDATE_TEST_EXE;
  const instance = await electron.launch({ executablePath: packagedExe||path.join(root, 'node_modules/electron/dist/electron.exe'), args: [...(packagedExe?[]:[root]), '--test-mode'],
    env: { ...process.env, LOCALAPPDATA: path.join(testData, 'cache-local'), XXT_TEST_DATA_DIR: testData, XXT_TEST_UPDATE_FEED: feed } });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  return instance;
}
try {
  application = await launch(data);
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('#desktopUpdatePanel[open]').waitFor();
  assert.deepEqual(await page.locator('#updateNotes li').allTextContents(),notes.split('\n').map(note=>note.slice(2)));
  assert.equal(await page.locator('#updateFullSection').getAttribute('open'),null);
  assert.equal(await page.locator('#updateFullNotes').isVisible(),false);
  await page.locator('#updateFullSection summary').click();
  assert.equal(await page.locator('#updateFullNotes').innerText(),feedNotes);
  await page.locator('#updateFullSection summary').click();
  assert.match(await page.locator('#updateNextVersion').innerText(),/9.9.9/);
  assert.equal(checks,1,'启动自动检查一次');assert.equal(downloads,0);
  await page.screenshot({path:path.join(root,'.desktop-test/update-startup-popup.png')});
  await page.evaluate(()=>{ void window.desktopApp.exit(); });
  await page.locator('#desktopClosePanel[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#desktopClosePanel').waitFor({state:'hidden'});
  assert.equal(await page.locator('#desktopUpdatePanel').isVisible(),true,'关闭确认取消后可继续查看更新');
  await page.locator('#updateLater').click();
  await page.reload();
  await page.locator('#panel-overview.active').waitFor({state:'attached'});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#desktopUpdatePanel').isVisible(),false,'重载不重复打扰');
  assert.equal(checks,1);
  await enterTestWorkspace(page);
  await page.locator('.tab[data-tab="courses"]').click();
  await page.locator('#treeSource').filter({ hasText: '已加载' }).waitFor({state:'attached'});
  assert.match(await page.locator('#deskCourseCount').innerText(), /1 门/);
  assert.equal((await page.evaluate(() => window.desktopApp.info())).dataDir, data);
  await revealTestTools(page);await page.locator('#desktopUpdate').click();
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
  const backupRoot = path.join(data, 'updates', 'backups');
  for (let attempt=0;attempt<50 && !fs.existsSync(backupRoot);attempt++) await new Promise(resolve=>setTimeout(resolve,100));
  const backups = fs.readdirSync(backupRoot);
  assert.equal(backups.length, 1, '安装前自动备份');
  for (const name of Object.keys(fixtures)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), before[name], name);
  await closeApplication();
  // 坏 SHA512 的另一实例不能显示安装按钮，且不触碰原数据。
  badHash = true;
  const corruptData = fs.mkdtempSync(path.join(root, '.desktop-test', 'update-corrupt-'));
  application = await launch(corruptData);
  const corruptPage = await application.firstWindow();
  await corruptPage.waitForURL('http://127.0.0.1:*/');
  await corruptPage.locator('#onboardingPanel[open]').waitFor();
  await corruptPage.waitForFunction(async () => (await window.desktopApp.updateState()).phase === 'available');
  assert.equal(await corruptPage.locator('#desktopUpdatePanel').isVisible(), false, '首次向导优先于更新提示');
  await corruptPage.locator('#onboardingLater').click();
  await corruptPage.locator('#desktopUpdatePanel[open]').waitFor();
  await corruptPage.locator('#updateLater').click();
  await enterTestWorkspace(corruptPage);
  await revealTestTools(corruptPage);await corruptPage.locator('#desktopUpdate').click();
  await corruptPage.locator('#updateDownload').waitFor({ state: 'visible' });
  await corruptPage.locator('#updateDownload').click();
  await corruptPage.locator('#updateMessage').filter({ hasText: '校验失败' }).waitFor({ timeout: 30000 });
  assert.equal(await corruptPage.locator('#updateInstall').isVisible(), false);
  await closeApplication();
  badHash=false;feedVersion=JSON.parse(fs.readFileSync('package.json','utf8')).version;
  const beforeCurrent=checks;
  application=await launch(fs.mkdtempSync(path.join(root,'.desktop-test','update-current-')));
  const currentPage=await application.firstWindow();await currentPage.waitForURL('http://127.0.0.1:*/');
  await currentPage.waitForFunction(async()=>(await window.desktopApp.updateState()).phase==='current');
  assert.equal(checks,beforeCurrent+1);assert.equal(await currentPage.locator('#desktopUpdatePanel').isVisible(),false,'没有新版不弹窗');
  console.log('✓ 启动自动检查/更新内容弹窗、重载不重复、最新版静默、下载校验、取消/保存安装、数据保留、坏校验阻止安装通过');
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
