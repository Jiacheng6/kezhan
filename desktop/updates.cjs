const fs = require('node:fs');
const path = require('node:path');

const { SOURCES, RELEASE_REPOSITORY, validatePreference, readPreference, writePreference,
  orderedSources, installerIdentity, sameInstaller, prepareOfflineUpdate } = require('./update-sources.cjs');
function releaseNotesText(notes) {
  const raw = Array.isArray(notes) ? notes.map(item => [item.version, item.note].filter(Boolean).join('\n')).join('\n\n') : typeof notes === 'string' ? notes : '';
  return raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({ amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' })[key])
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => { const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):''; })
    .replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 16000) || '此版本未提供更新说明。';
}
function readableError(error) {
  const text = String(error?.message || error);
  if (/404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|No published versions/i.test(text)) return '更新下载服务尚未发布新版，请稍后再检查。';
  if (/sha512|checksum|signature/i.test(text)) return '下载文件校验失败，已阻止安装，请重新下载。';
  if (/HttpError|HTTP\s*(?:403|429|50\d)|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(text)) return '当前下载渠道暂时不可用，可切换渠道或从本地安装包更新。';
  if (/timeout|ENOTFOUND|ECONN|net::|network|socket/i.test(text)) return '暂时连不上更新服务。可切换下载渠道，或从本地安装包更新。';
  return '更新失败：' + text.slice(0, 240);
}

// 后台结束写入后才备份；备份位于用户数据目录，不进入发布包。
function backupUserData(dataDir, version) {
  const relativeFiles = ['state.json', 'local.json', 'recon-selection.json', 'data/probe-out/task-report.json'];
  const files = relativeFiles.filter((file) => fs.existsSync(path.join(dataDir, file)));
  for (const file of files) JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  if (fs.existsSync(path.join(dataDir, 'browser-session.bin'))) files.push('browser-session.bin');
  if (fs.existsSync(path.join(dataDir, 'api-config.bin'))) files.push('api-config.bin');
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
  constructor(updater, { version, enabled = true, startupEnabled = true, installed = true, onStatus = () => {}, prepareInstall, recoverInstall = async () => {},
    sources = null, sourcePreference = 'auto', savePreference = () => {}, prepareLocal = null }) {
    this.updater = updater;
    this.prepareInstall = prepareInstall;
    this.recoverInstall = recoverInstall;
    this.onStatus = onStatus;
    this.locked = false;
    this.downloadReady = false;
    this.startupEnabled = startupEnabled;
    this.startupChecked = false;
    this.checkPromise = null;
    this.sources = sources;
    this.savePreference = savePreference;
    this.prepareLocal = prepareLocal;
    this.activeSource = null;
    this.availableIdentity = null;
    this.suppressErrors = false;
    this.muteInfo = false;
    this.state = { phase: 'idle', currentVersion: version, nextVersion: null, percent: 0, enabled, installed,
      sourcePreference, sourceName: '', localEnabled: !!prepareLocal,
      releaseNotes: '', notificationPending: false,
      message: enabled ? '检查是否有新版本。' : '开发模式不连接正式更新服务。' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('checking-for-update', () => this.patch({ phase: 'checking', message: '正在检查新版…' }));
    updater.on('update-available', (info) => {
      if (this.muteInfo) return;
      this.downloadReady = false;
      this.patch({ phase: 'available', nextVersion: info.version, releaseNotes: releaseNotesText(info.releaseNotes), percent: 0, message: `发现新版 ${info.version}。` });
    });
    updater.on('update-not-available', () => { if (!this.muteInfo) this.patch({ phase: 'current', nextVersion: null, releaseNotes: '', notificationPending: false, message: '当前渠道暂无新版。' }); });
    updater.on('download-progress', (info) => this.patch({ phase: 'downloading', percent: Math.max(0, Math.min(100, info.percent || 0)), message: '正在下载新版，任务可以继续运行…' }));
    updater.on('update-downloaded', (info) => {
      this.downloadReady = true;
      this.patch({ phase: 'ready', nextVersion: info.version, percent: 100,
        message: installed ? '下载并校验完成，可以安装。' : '下载并校验完成；安装后将切换为安装版，原数据保留。' });
    });
    updater.on('error', (error) => { if (!this.suppressErrors) this.patch({ phase: 'error', message: readableError(error) }); });
  }
  snapshot() { return { ...this.state, downloadReady: this.downloadReady, busy: this.locked }; }
  patch(patch) { Object.assign(this.state, patch); this.onStatus(this.snapshot()); }
  setSource(preference) {
    validatePreference(preference);
    if (this.locked || this.downloadReady) throw new Error('请等当前更新操作完成，再切换渠道。');
    this.savePreference(preference);
    this.activeSource = null; this.availableIdentity = null;
    this.patch({ sourcePreference: preference, sourceName: '', phase: 'idle', nextVersion: null, releaseNotes: '', notificationPending: false,
      message: preference === 'auto' ? '优先检查国内源，连接失败时自动尝试 GitHub。' : '渠道已切换，点击“检查新版”继续。' });
    return this.snapshot();
  }
  async checkAtStartup() {
    if (this.startupChecked || !this.startupEnabled || !this.state.enabled) return this.snapshot();
    this.startupChecked = true;
    await this.check();
    if (this.state.phase === 'available') this.patch({ notificationPending: true });
    return this.snapshot();
  }
  acknowledgeNotification() { this.patch({ notificationPending: false }); return this.snapshot(); }
  async check() {
    if (this.checkPromise) return this.checkPromise;
    if (!this.state.enabled || this.locked || this.downloadReady) return this.snapshot();
    this.locked = true;
    this.checkPromise = this.performCheck();
    try { return await this.checkPromise; } finally { this.checkPromise = null; }
  }
  async performCheck() {
    this.suppressErrors = true;
    try {
      if (!this.sources) {
        const result = await this.updater.checkForUpdates();
        if (!result) throw new Error('此运行环境暂不支持联网更新。');
      } else {
        this.activeSource = null; this.availableIdentity = null;
        this.patch({ nextVersion: null, releaseNotes: '', notificationPending: false });
        let currentSource = null, lastError = null, found = false;
        for (const source of orderedSources(this.sources, this.state.sourcePreference)) {
          this.patch({ phase: 'checking', sourceName: source.name, message: `正在连接${source.name}…` });
          try {
            this.updater.setFeedURL(source.provider);
            const result = await this.updater.checkForUpdates();
            if (!result) throw new Error('此运行环境暂不支持联网更新。');
            if (this.state.phase === 'available') {
              this.activeSource = source; this.availableIdentity = installerIdentity(result.updateInfo);
              this.patch({ message: `发现新版 ${this.state.nextVersion} · ${source.name}` });
              found = true; break;
            }
            currentSource ||= source;
          } catch (error) { lastError = error; }
        }
        if (!found) {
          if (currentSource) this.patch({ phase: 'current', sourceName: currentSource.name, nextVersion: null, releaseNotes: '', notificationPending: false,
            message: lastError ? `${currentSource.name}暂无新版；其他渠道暂时不可用，可稍后再查。` : '当前已是最新版。' });
          else throw lastError || new Error('没有可用的更新渠道。');
        }
      }
    } catch (error) { this.patch({ phase: 'error', message: readableError(error) }); }
    finally { this.suppressErrors = false; this.locked = false; this.onStatus(this.snapshot()); }
    return this.snapshot();
  }
  async download() {
    if (!this.state.enabled || this.locked || !this.state.nextVersion || this.downloadReady) return this.snapshot();
    this.locked = true;
    this.suppressErrors = true;
    this.patch({ phase: 'downloading', percent: 0, message: '正在下载新版…' });
    try {
      try { await this.updater.downloadUpdate(); }
      catch (error) {
        if (!this.sources || this.state.sourcePreference !== 'auto' || !this.activeSource || /sha512|checksum|signature/i.test(String(error?.message || error))) throw error;
        const expected = this.availableIdentity;
        let failure = error, downloaded = false;
        this.muteInfo = true;
        for (const source of this.sources.filter(item => item.id !== this.activeSource.id)) {
          this.patch({ phase: 'downloading', percent: 0, message: `当前下载中断，正在尝试${source.name}…` });
          try {
            this.updater.setFeedURL(source.provider);
            const result = await this.updater.checkForUpdates();
            if (!sameInstaller(expected, installerIdentity(result?.updateInfo))) throw new Error('备用渠道的版本或校验值不同，已停止切换，请稍后重新检查。');
            this.activeSource = source;
            this.patch({ phase: 'downloading', sourceName: source.name, message: `正在从${source.name}下载同一版本…` });
            await this.updater.downloadUpdate();
            downloaded = true; break;
          } catch (nextError) {
            failure = nextError;
            if (/sha512|checksum|signature/i.test(String(nextError?.message || nextError))) break;
          }
        }
        if (!downloaded) throw failure;
      }
    }
    catch (error) {
      this.activeSource = null; this.availableIdentity = null;
      this.patch({ phase: 'error', nextVersion: null, message: readableError(error) });
    }
    finally { this.muteInfo = false; this.suppressErrors = false; this.locked = false; this.onStatus(this.snapshot()); }
    return this.snapshot();
  }
  async importLocal(selectFiles) {
    if (!this.prepareLocal || this.locked || this.downloadReady) return this.snapshot();
    this.locked = true;
    let local;
    try {
      const files = await selectFiles();
      if (files) {
        this.patch({ phase: 'checking', nextVersion: null, releaseNotes: '', notificationPending: false, sourceName: '本地安装包', message: '正在校验本地安装包…' });
        local = await this.prepareLocal(files);
        this.suppressErrors = true;
        this.updater.setFeedURL(local.provider);
        const result = await this.updater.checkForUpdates();
        if (!result || this.state.phase !== 'available') throw new Error('本地安装包不是可用的新版本。');
        this.activeSource = { id: 'local', name: '本地安装包' };
        this.patch({ phase: 'downloading', message: '正在准备本地安装包…' });
        await this.updater.downloadUpdate();
      }
    } catch (error) {
      // An earlier online offer is invalid after changing its provider. Require a
      // fresh check rather than downloading a mismatched package on retry.
      this.activeSource = null; this.availableIdentity = null;
      this.patch({ phase: 'error', nextVersion: null, releaseNotes: '', sourceName: '', message: readableError(error) });
    } finally {
      await local?.close();
      this.suppressErrors = false; this.locked = false;
      this.onStatus(this.snapshot());
    }
    return this.snapshot();
  }
  async install() {
    if (!this.downloadReady || this.locked || this.state.phase === 'installing') return this.snapshot();
    this.locked = true;
    try {
      const prepared = await this.prepareInstall();
      if (prepared) {
        this.patch({ phase: 'installing', message: '数据已保存，正在启动新版安装程序…' });
        this.updater.quitAndInstall(false, true);
        // NSIS 启动失败时会同步发出 error，保持旧版可用。
        if (this.state.phase === 'error') await this.recoverInstall();
      }
    } catch (error) {
      this.patch({ phase: 'error', message: readableError(error) });
      await this.recoverInstall();
    } finally { this.locked = false; }
    return this.snapshot();
  }
}

function createUpdates({ app, dataDir, testMode, onStatus, prepareInstall, recoverInstall }) {
  const { NsisUpdater } = require('electron-updater');
  let provider = { provider: 'github', owner: 'Jiacheng6', repo: 'kezhan-releases' };
  const testSources = testMode && process.env.XXT_TEST_UPDATE_SOURCES ? JSON.parse(process.env.XXT_TEST_UPDATE_SOURCES) : null;
  if (testSources) {
    if (!Array.isArray(testSources) || testSources.length !== 2 || testSources.some((source, i) =>
      source.id !== ['cnb', 'github'][i] || source.provider?.provider !== 'generic' || new URL(source.provider.url).hostname !== '127.0.0.1' || new URL(source.provider.url).protocol !== 'http:')) throw new Error('测试更新渠道只能使用本机回环地址');
  }
  const testFeed = testMode && (process.env.XXT_TEST_UPDATE_FEED || testSources?.[0].provider.url);
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
    startupEnabled: !testMode || !!testFeed,
    sources: testSources || (testFeed ? null : SOURCES), sourcePreference: readPreference(dataDir), savePreference: value => writePreference(dataDir, value),
    prepareLocal: app.isPackaged || testMode ? files => prepareOfflineUpdate(files, { dataDir, currentVersion: app.getVersion() }) : null,
    onStatus, prepareInstall, recoverInstall });
}
module.exports = { UpdateController, backupUserData, readableError, releaseNotesText, createUpdates, RELEASE_REPOSITORY };
