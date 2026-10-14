const fs = require('node:fs');
const path = require('node:path');

const RELEASE_REPOSITORY = 'Jiacheng6/xuexitong-assistant-releases';
function readableError(error) {
  const text = String(error?.message || error);
  if (/404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|No published versions/i.test(text)) return '更新下载服务尚未发布新版，请稍后再检查。';
  if (/sha512|checksum|signature/i.test(text)) return '下载文件校验失败，已阻止安装，请重新下载。';
  if (/timeout|ENOTFOUND|ECONN|net::|network|socket/i.test(text)) return '连接更新服务失败，请检查网络后重试。';
  return '更新失败：' + text.slice(0, 240);
}

// 后台结束写入后才备份；备份位于用户数据目录，不进入发布包。
function backupUserData(dataDir, version) {
  const relativeFiles = ['state.json', 'local.json', 'recon-selection.json', 'data/probe-out/task-report.json'];
  const files = relativeFiles.filter((file) => fs.existsSync(path.join(dataDir, file)));
  for (const file of files) JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  fs.mkdirSync(path.join(dataDir, 'updates', 'backups'), { recursive: true });
  const backup = fs.mkdtempSync(path.join(dataDir, 'updates', 'backups', `${version.replace(/[^\w.-]/g, '_')}-`));
  for (const file of files) {
    const target = path.join(backup, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dataDir, file), target);
  }
  fs.writeFileSync(path.join(backup, 'backup-info.json'), JSON.stringify({ version, files, at: new Date().toISOString() }, null, 2));
  return backup;
}

class UpdateController {
  constructor(updater, { version, enabled = true, installed = true, onStatus = () => {}, prepareInstall, recoverInstall = async () => {} }) {
    this.updater = updater;
    this.prepareInstall = prepareInstall;
    this.recoverInstall = recoverInstall;
    this.onStatus = onStatus;
    this.locked = false;
    this.downloadReady = false;
    this.state = { phase: 'idle', currentVersion: version, nextVersion: null, percent: 0, enabled, installed,
      message: enabled ? '点击检查更新。登录状态、课程清单和进度会继续保留。' : '开发模式不连接正式更新服务。' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('checking-for-update', () => this.patch({ phase: 'checking', message: '正在检查新版…' }));
    updater.on('update-available', (info) => {
      this.downloadReady = false;
      this.patch({ phase: 'available', nextVersion: info.version, percent: 0, message: `发现新版 ${info.version}，点击下载后仍可继续使用软件。` });
    });
    updater.on('update-not-available', () => this.patch({ phase: 'current', nextVersion: null, message: '当前已是最新版。' }));
    updater.on('download-progress', (info) => this.patch({ phase: 'downloading', percent: Math.max(0, Math.min(100, info.percent || 0)), message: '正在下载新版，任务可以继续运行…' }));
    updater.on('update-downloaded', (info) => {
      this.downloadReady = true;
      this.patch({ phase: 'ready', nextVersion: info.version, percent: 100,
        message: installed ? '新版下载并校验完成。安装前会停止任务、保存进度。' : '新版下载并校验完成。此免安装版本将升级为安装版，当前账号和课程数据会保留。' });
    });
    updater.on('error', (error) => this.patch({ phase: 'error', message: readableError(error) }));
  }
  snapshot() { return { ...this.state, downloadReady: this.downloadReady }; }
  patch(patch) { Object.assign(this.state, patch); this.onStatus(this.snapshot()); }
  async check() {
    if (!this.state.enabled || this.locked || this.downloadReady) return this.snapshot();
    this.locked = true;
    try {
      const result = await this.updater.checkForUpdates();
      if (!result) this.patch({ phase: 'error', message: '此运行环境暂不支持联网更新。' });
    } catch (error) { this.patch({ phase: 'error', message: readableError(error) }); }
    finally { this.locked = false; this.onStatus(this.snapshot()); }
    return this.snapshot();
  }
  async download() {
    if (!this.state.enabled || this.locked || !this.state.nextVersion || this.downloadReady) return this.snapshot();
    this.locked = true;
    this.patch({ phase: 'downloading', percent: 0, message: '正在下载新版…' });
    try { await this.updater.downloadUpdate(); }
    catch (error) { this.patch({ phase: 'error', message: readableError(error) }); }
    finally { this.locked = false; this.onStatus(this.snapshot()); }
    return this.snapshot();
  }
  async install() {
    if (!this.downloadReady || this.locked || this.state.phase === 'installing') return this.snapshot();
    this.locked = true;
    try {
      const prepared = await this.prepareInstall();
      if (!prepared) return this.snapshot();
      this.patch({ phase: 'installing', message: '数据已保存，正在启动新版安装程序…' });
      this.updater.quitAndInstall(false, true);
      // NSIS 启动失败时会同步发出 error，保持旧版可用。
      if (this.state.phase === 'error') await this.recoverInstall();
    } catch (error) {
      this.patch({ phase: 'error', message: readableError(error) });
      await this.recoverInstall();
    } finally { this.locked = false; }
    return this.snapshot();
  }
}

function createUpdates({ app, dataDir, testMode, onStatus, prepareInstall, recoverInstall }) {
  const { NsisUpdater } = require('electron-updater');
  let provider = { provider: 'github', owner: 'Jiacheng6', repo: 'xuexitong-assistant-releases' };
  const testFeed = testMode && process.env.XXT_TEST_UPDATE_FEED;
  if (testFeed) {
    const url = new URL(testFeed);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('测试更新源只能使用本机回环地址');
    provider = { provider: 'generic', url: url.href };
  }
  // 使用组件内置 Electron 适配器，以保留真实 HTTP 下载和安装能力。
  const updater = new NsisUpdater(provider);
  updater.logger = null;
  if (testFeed) {
    const configFile = path.join(dataDir, 'test-update-config.yml');
    fs.writeFileSync(configFile, `provider: generic\nurl: ${JSON.stringify(provider.url)}\nupdaterCacheDirName: update-test-cache\n`);
    updater.updateConfigPath = configFile;
    updater.forceDevUpdateConfig = true;
    updater.disableDifferentialDownload = true;
  }
  const installed = fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall 学习通助手.exe'));
  return new UpdateController(updater, { version: app.getVersion(), enabled: app.isPackaged || !!testFeed, installed,
    onStatus, prepareInstall, recoverInstall });
}
module.exports = { UpdateController, backupUserData, readableError, createUpdates, RELEASE_REPOSITORY };
