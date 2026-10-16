import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { UpdateController, backupUserData, releaseNotesText } = require('../../desktop/updates.cjs');
const { waitForOwnedExit } = await import('../../src/browser/launch.mjs');
const browserProcess = new EventEmitter();
Object.assign(browserProcess, { pid: 1, exitCode: null, signalCode: null });
setTimeout(() => { browserProcess.exitCode = 0; browserProcess.emit('exit', 0); }, 20);
assert.equal(await waitForOwnedExit(browserProcess, 500), true, '等待正常关闭完成，避免打断登录状态落盘');
const stuckBrowser = new EventEmitter();
Object.assign(stuckBrowser, { pid: 2, exitCode: null, signalCode: null });
assert.equal(await waitForOwnedExit(stuckBrowser, 20), false, '关闭超时才允许后续清理');
assert.equal(stuckBrowser.listenerCount('exit'), 0);
class FakeUpdater extends EventEmitter {
  installs = 0;
  async checkForUpdates() { this.emit('checking-for-update'); this.emit('update-available', { version: '0.4.0' }); return {}; }
  async downloadUpdate() { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded', { version: '0.4.0' }); return ['installer.exe']; }
  quitAndInstall() { this.installs++; }
}
const events = [];
assert.equal(releaseNotesText('<h2>改进</h2><ul><li>启动检查</li><li>保留 &amp; 进度</li></ul><script>alert(1)</script>'),'改进\n• 启动检查\n• 保留 & 进度');
assert.match(releaseNotesText([{version:'0.4.1',note:'修复课程显示'}]),/0.4.1\n修复课程显示/);
assert.equal(releaseNotesText(null),'此版本未提供更新说明。');
let startupChecks=0,startupDownloads=0;
const startupFake=new FakeUpdater();
startupFake.checkForUpdates=async()=>{startupChecks++;startupFake.emit('checking-for-update');await new Promise(resolve=>setTimeout(resolve,10));startupFake.emit('update-available',{version:'0.4.1',releaseNotes:'修复课程显示'});return {};};
startupFake.downloadUpdate=async()=>{startupDownloads++;};
const startup=new UpdateController(startupFake,{version:'0.4.0'});
await Promise.all([startup.checkAtStartup(),startup.checkAtStartup(),startup.check()]);
assert.equal(startupChecks,1,'同一启动并发检查合并，只联网一次');
assert.equal(startup.snapshot().notificationPending,true);
assert.equal(startup.snapshot().releaseNotes,'修复课程显示');
assert.equal(startupDownloads,0,'启动提醒不会自动下载或安装');
startup.acknowledgeNotification();
await startup.checkAtStartup();
assert.equal(startupChecks,1);
assert.equal(startup.snapshot().notificationPending,false,'重载界面不重复通知');
const currentFake=new FakeUpdater();
currentFake.checkForUpdates=async()=>{currentFake.emit('update-not-available');return {};};
const current=new UpdateController(currentFake,{version:'0.4.1'});
await current.checkAtStartup();
assert.equal(current.snapshot().notificationPending,false,'最新版静默');
const offlineFake=new FakeUpdater();offlineFake.checkForUpdates=async()=>{throw new Error('network unavailable');};
const offline=new UpdateController(offlineFake,{version:'0.4.1'});
await offline.checkAtStartup();
assert.equal(offline.snapshot().phase,'error');
assert.equal(offline.snapshot().notificationPending,false,'启动断网不弹框');
const disabled=new UpdateController(startupFake,{version:'0.4.1',startupEnabled:false});await disabled.checkAtStartup();
assert.equal(startupChecks,1,'隔离测试默认不检查正式更新源');
const fake = new FakeUpdater();
let cancel = true;
const update = new UpdateController(fake, { version: '0.3.0', prepareInstall: async () => {
  if (cancel) return false;
  events.push('saved');
  return true;
} });
assert.equal(fake.autoDownload, false);
assert.equal(fake.autoInstallOnAppQuit, false, '下载完成不能在普通退出时偷偷安装');
await update.install();
assert.equal(fake.installs, 0, '未校验下载不可安装');
await update.check();
assert.equal(update.snapshot().phase, 'available');
assert.equal(fake.installs, 0);
await update.download();
assert.equal(update.snapshot().phase, 'ready');
await update.install();
assert.equal(fake.installs, 0, '选择稍后不会安装或退出');
assert.equal(update.snapshot().downloadReady, true);
cancel = false;
fake.quitAndInstall = () => { events.push('installer'); fake.installs++; };
await update.install();
assert.deepEqual(events, ['saved', 'installer'], '完成保存后才启动安装器');
assert.equal(fake.installs, 1);
await update.install();
assert.equal(fake.installs, 1, '安装开始后重复点击不会再次安装');

let recovered = false;
const failed = new FakeUpdater();
const failure = new UpdateController(failed, { version: '0.3.0', prepareInstall: async () => { throw new Error('保存失败'); }, recoverInstall: async () => { recovered = true; } });
await failure.check(); await failure.download(); await failure.install();
assert.equal(failed.installs, 0, '保存失败时绝不启动安装器');
assert.equal(recovered, true);
assert.equal(failure.snapshot().phase, 'error');

const corrupt = new FakeUpdater();
corrupt.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
const corruption = new UpdateController(corrupt, { version: '0.3.0', prepareInstall: async () => true });
await corruption.check(); await corruption.download(); await corruption.install();
assert.equal(corrupt.installs, 0, '校验失败不可安装');
assert.equal(corruption.snapshot().downloadReady, false);
assert.match(corruption.snapshot().message, /校验失败/);

const data = fs.mkdtempSync(path.join(process.env.XXT_DATA_DIR || '.desktop-test', 'update-data-'));
fs.mkdirSync(path.join(data, 'edge-profile'), { recursive: true });
fs.mkdirSync(path.join(data, 'data', 'probe-out'), { recursive: true });
const fixture = {
  'state.json': { version: 3, taskPoints: { sample: { status: 'done' } }, settings: { maxRetries: 4 } },
  'local.json': { personId: 'fixture-user' },
  'recon-selection.json': { excluded: ['fixture-task'] },
  'data/probe-out/task-report.json': { courses: [{ name: '示例课程甲' }] },
};
for (const [name, contents] of Object.entries(fixture)) fs.writeFileSync(path.join(data, name), JSON.stringify(contents));
fs.writeFileSync(path.join(data, 'edge-profile', 'Cookies'), 'fixture-login-data');
const encryptedSession = Buffer.from([0, 255, 128, 1, 42]);
fs.writeFileSync(path.join(data, 'browser-session.bin'), encryptedSession);
const backup = backupUserData(data, '0.3.0');
for (const name of Object.keys(fixture)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), fs.readFileSync(path.join(backup, name), 'utf8'));
assert.equal(fs.readFileSync(path.join(data, 'edge-profile', 'Cookies'), 'utf8'), 'fixture-login-data');
assert.deepEqual(fs.readFileSync(path.join(backup, 'browser-session.bin')), encryptedSession, '内置网页登录快照按二进制原样备份');
fs.writeFileSync(path.join(data, 'state.json'), '{broken');
assert.throws(() => backupUserData(data, '0.3.0'), SyntaxError, '损坏数据必须中止安装，不能当成空数据');
assert.equal(fs.readFileSync(path.join(data, 'state.json'), 'utf8'), '{broken');
console.log('✓ 手动下载安装、取消安装、保存失败、校验失败、安装顺序、登录数据与课程备份通过');
