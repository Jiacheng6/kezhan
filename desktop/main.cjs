const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, utilityProcess, powerSaveBlocker, Notification, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createUpdates, backupUserData } = require('./updates.cjs');
const { CloseConfirmation } = require('./close-confirmation.cjs');
const { EmbeddedBrowser } = require('./embedded-browser.cjs');
const { NotificationCenter } = require('./notifications.cjs');
const {createApiService}=require('./ai-api.cjs');

const title = '课栈';
const smokeTest = process.argv.includes('--smoke-test');
const embeddedTest = process.argv.includes('--embedded-test');
const testMode = smokeTest || process.argv.includes('--test-mode') || embeddedTest;
const dataDir = testMode && process.env.XXT_TEST_DATA_DIR
  ? path.resolve(process.env.XXT_TEST_DATA_DIR)
  : path.join(app.getPath('appData'), 'XuexitongAssistant');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('com.xuexitong.assistant');
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const desktopStartedAt = Date.now();
const loadingUrl = pathToFileURL(path.join(__dirname, 'loading.html')).href;
let mainWindow, tray, worker, serviceUrl, error = '', quitting = false, closeDialog = false, restarting = false;
let heartbeat, startupTimer, blocker;
let updates, internalBrowser, rendererGone = false;
let notifications, previousUpdatePhase = null;
let apiService;
async function handleBrowserRequest(request){
  if(request.method==='api-status')return apiService.status();
  if(request.method==='api-cancel')return apiService.cancel(request.jobId);
  if(request.method==='api-ask')return apiService.ask(request);
  return internalBrowser.request(request);
}
const closeConfirmation = new CloseConfirmation(request => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:close-request', request);
});
const logFile = path.join(dataDir, 'logs', 'desktop.log');
function log(message) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch {}
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function safePage(url) {
  return url === loadingUrl || (!!serviceUrl && new URL(url).origin === new URL(serviceUrl).origin);
}
function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !safePage(event.senderFrame.url)) {
    throw new Error('不允许从此页面调用桌面功能');
  }
}
async function serviceAction(name) {
  if (!serviceUrl) throw new Error('服务尚未就绪');
  const response = await fetch(new URL(`/api/action/${name}`, serviceUrl), { method: 'POST', signal: AbortSignal.timeout(7000) });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || '操作失败');
  return result.result;
}
function showError(message) {
  error = String(message); log(`ERROR ${error}`);
  if (mainWindow && !mainWindow.isDestroyed() && !serviceUrl) mainWindow.loadURL(loadingUrl);
  if (tray) tray.setToolTip(`${title}：服务异常，请打开软件查看`);
  notifications?.push({kind:'service-error',key:'service-error',detail:error});
}
async function stopWorker({ requireGraceful = false } = {}) {
  clearInterval(heartbeat); clearTimeout(startupTimer);
  const child = worker;
  worker = null;
  if (!child) return;
  if (!child.pid) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (!child.pid) { child.kill(); return; }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      if (requireGraceful) reject(new Error('后台未能及时保存并退出，已取消安装。请重启服务后再试。'));
      else resolve();
    }, requireGraceful ? 45000 : 12000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (requireGraceful && code !== 0) reject(new Error('后台保存退出失败，已取消安装。'));
      else resolve();
    });
    child.postMessage({ type: 'shutdown' });
  });
}
async function exitApplication() {
  if (quitting) return;
  quitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${title} — 正在保存进度并退出…`);
  await stopWorker();
  await internalBrowser?.close();
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  tray?.destroy();
  app.quit();
}
async function requestClose() {
  if (quitting) return;
  // A close request can already be pending when the renderer fails. Recover
  // the local page before checking the pending flag so the choice remains usable.
  if (rendererGone) { rendererGone = false; await mainWindow.loadURL(loadingUrl); }
  if (closeDialog) return;
  closeDialog = true;
  if (internalBrowser) { internalBrowser.closeSuspended = true; internalBrowser.applyBounds(); }
  try {
    // The local startup/error page and the workspace share this same prompt.
    const choice = await closeConfirmation.request();
    if (choice === 'hide') mainWindow.hide();
    if (choice === 'exit') await exitApplication();
  } finally { closeDialog = false; if (internalBrowser) { internalBrowser.closeSuspended = false; internalBrowser.applyBounds(); } }
}
async function internalDebugPort() {
  const file = path.join(dataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const [port, endpoint] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      if (fs.statSync(file).mtimeMs < desktopStartedAt - 1000) throw new Error('旧连接');
      const version = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
      if (Number(port) > 0 && new URL(version.webSocketDebuggerUrl).pathname === endpoint) return Number(port);
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('内置网页引擎启动失败，请重启软件');
}
async function startWorker() {
  error = ''; serviceUrl = null;
  const debugPort = await internalDebugPort();
  const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], {
    cwd: app.getAppPath(), stdio: 'pipe', serviceName: title + '后台服务',
    env: { ...process.env, XXT_DATA_DIR: dataDir, XXT_DEBUG_PORT: String(debugPort), XXT_DESKTOP: '1', XXT_EMBEDDED_BROWSER: '1',
      XXT_OWNER_PID: String(process.pid), XXT_EMBEDDED_TEST: embeddedTest ? '1' : '',
      XXT_EMBEDDED_TEST_HOME: embeddedTest ? process.env.XXT_EMBEDDED_TEST_HOME || '' : '',
      ...(testMode && !embeddedTest ? { XXT_SMOKE_TEST: '1' } : {}) },
  });
  worker = child;
  child.on('error', (details) => showError(`后台进程异常：${details?.type || '未知错误'}`));
  child.stdout?.on('data', (data) => log(data.toString().trimEnd()));
  child.stderr?.on('data', (data) => log(data.toString().trimEnd()));
  child.on('message', async (message) => {
    if (worker !== child) return;
    if (message.type === 'user-notice') { notifications?.push(message.notice); return; }
    if (message.type === 'browser-request') {
      try { const result=await handleBrowserRequest(message.request);child.postMessage({ type: 'browser-response', id: message.id, result }); }
      catch (error) { child.postMessage({ type: 'browser-response', id: message.id, error: error.message }); }
      return;
    }
    if (message.type === 'server-ready') {
      const url = new URL(message.url);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return showError('后台服务返回了无效地址');
      serviceUrl = message.url;
      clearTimeout(startupTimer);
      log(`服务就绪 ${serviceUrl}`);
      await mainWindow.loadURL(serviceUrl);
      void updates.checkAtStartup();
      if (tray) tray.setToolTip(title + '：服务运行中');
      notifications?.publish();
      if (smokeTest) {
        setTimeout(async () => {
          try {
            const status = await fetch(new URL('/api/status', serviceUrl)).then((r) => r.json());
            const png = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(dataDir, 'smoke-window.png'), png.toPNG());
            fs.writeFileSync(path.join(dataDir, 'smoke-result.json'), JSON.stringify({ packaged: app.isPackaged,
              title: mainWindow.getTitle(), url: mainWindow.webContents.getURL(), status, nodeInstalledRequired: false }, null, 2));
          } catch (err) { showError(err.message); }
          await exitApplication();
        }, 3000);
      }
    }
    if (message.type === 'fatal') showError(message.message);
  });
  child.on('exit', (code) => {
    log(`后台退出 ${code}`);
    if (worker === child) {
      worker = null; serviceUrl = null; clearInterval(heartbeat);
      showError('后台服务意外退出，请点击重新启动。运行记录已保留。');
    }
  });
  if (!(testMode && process.env.XXT_TEST_SKIP_HEARTBEAT === '1')) {
    heartbeat = setInterval(() => { if (child.pid) child.postMessage({ type: 'heartbeat' }); }, 2000);
  }
  startupTimer = setTimeout(() => showError('服务启动超时，请查看数据文件夹中的 logs/desktop.log 后重试。'), 45000);
}
async function restartService() {
  if (restarting || quitting) return;
  restarting = true;
  try { await stopWorker(); serviceUrl = null; await mainWindow.loadURL(loadingUrl); await startWorker(); }
  catch (err) { showError(err.message); }
  finally { restarting = false; }
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showMain);
  app.on('activate', showMain);
  app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); requestClose(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const icon = path.join(__dirname, 'assets', 'icon.png');
    mainWindow = new BrowserWindow({ title, width: 1240, height: 840, minWidth: 960, minHeight: 660,
      backgroundColor: '#f7f6f1', icon, show: !testMode,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); requestClose(); } });
    notifications = new NotificationCenter({ dataDir, Notification, icon, log,
      nativeEnabled: !testMode || process.env.XXT_TEST_NATIVE_NOTIFICATIONS === '1',
      onState: state => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:notifications', state);
        tray?.setToolTip(state.unread ? `${title}：${state.unread} 条未读提醒` : title);
        mainWindow.setOverlayIcon(state.unread ? nativeImage.createFromPath(icon) : null, state.unread ? '有未读提醒' : '');
      },
      onAttention: item => { if (item.urgent && !mainWindow.isFocused()) mainWindow.flashFrame(true); },
      onOpen: item => { showMain(); mainWindow.webContents.send('desktop:notice-open', item); },
    });
    mainWindow.on('focus', () => mainWindow.flashFrame(false));
    if (testMode) module.exports.notificationCenter = notifications;
    const notifyVisibility = () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:visibility', mainWindow.isVisible() && !mainWindow.isMinimized());
    };
    for (const event of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(event, notifyVisibility);
    mainWindow.webContents.on('did-finish-load', () => { rendererGone = false; notifyVisibility(); });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!safePage(url)) event.preventDefault(); });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    internalBrowser = new EmbeddedBrowser(mainWindow, { dataDir, debugPort: await internalDebugPort(), log, onState: state => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:web-state', state);
      worker?.postMessage({ type: 'browser-state', state });
    } });
    if(testMode)module.exports.embeddedBrowser=internalBrowser;
    mainWindow.webContents.on('render-process-gone', () => { rendererGone = true; showError('界面发生异常，请从托盘重新打开或重启服务。'); });
    updates = createUpdates({ app, dataDir, testMode,
      onStatus: (status) => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:update-status', status);
        if (status.phase === 'current') {
          for (const item of notifications.snapshot().items) {
            if (!item.read && ['update-available', 'update-ready'].includes(item.kind)) notifications.read(item.id);
          }
        }
        if (status.phase !== previousUpdatePhase) {
          previousUpdatePhase = status.phase;
          const kind = ({available:'update-available',ready:'update-ready',error:'update-error'})[status.phase];
          if (kind) notifications.push({kind,key:`${kind}:${status.nextVersion||''}`});
        }
      },
      prepareInstall: async () => {
        const status = updates.snapshot();
        const confirmation = await dialog.showMessageBox(mainWindow, { type: 'question', title: '安装更新',
          message: `安装 ${status.nextVersion}？`,
          detail: '安装会停止当前任务、保存进度并退出软件。登录状态、课程清单和选择会保留。' +
            (status.installed ? '' : '\n当前是免安装版；安装程序会创建安装版，使用同一份账号和课程数据。'),
          buttons: ['保存并安装', '稍后'], defaultId: 1, cancelId: 1, noLink: true });
        if (confirmation.response !== 0) return false;
        quitting = true;
        await stopWorker({ requireGraceful: true });
        await internalBrowser.saveCookies();
        internalBrowser.session.flushStorageData();
        backupUserData(dataDir, app.getVersion());
        log(`更新前数据备份完成，准备安装 ${status.nextVersion}`);
        if (testMode) throw new Error('测试模式已保存数据，禁止启动真实安装程序');
        return true;
      },
      recoverInstall: async () => {
        quitting = false;
        if (!worker) await restartService();
      },
    });
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }));
    tray.setToolTip(title + '：正在启动');
    notifications.publish();
    tray.on('double-click', showMain);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开课栈', click: showMain },
      { label: '通知与待处理', click: () => { showMain(); mainWindow.webContents.send('desktop:notice-open', {action:'notices'}); } },
      { label: '打开内置网页', click: () => { showMain(); internalBrowser.setVisible(true); } },
      { label: '返回工作台（任务继续运行）', click: () => internalBrowser.setVisible(false) },
      { type: 'separator' }, { label: '打开数据与日志文件夹', click: () => shell.openPath(dataDir) },
      { label: '重启后台服务', click: restartService }, { type: 'separator' },
      { label: '关闭软件…', click: () => { showMain(); requestClose(); } },
    ]));
    const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => { assertSender(event); return fn(...args); });
    apiService=createApiService({dataDir,safeStorage});
    if(testMode)module.exports.handleBrowserRequest=handleBrowserRequest;
    handle('desktop:api-status',()=>apiService.status());
    handle('desktop:api-save',patch=>apiService.save(patch));
    handle('desktop:api-test',()=>apiService.test());
    handle('desktop:browser', (visible) => internalBrowser.setVisible(visible));
    handle('desktop:web-state', () => internalBrowser.snapshot());
    handle('desktop:web-command', command => internalBrowser.command(command));
    handle('desktop:web-layout', layout => internalBrowser.layout(layout));
    handle('desktop:hide', () => mainWindow.hide());
    handle('desktop:exit', requestClose);
    handle('desktop:close-state', () => closeConfirmation.snapshot());
    handle('desktop:close-choice', (id, choice) => ({ ok: closeConfirmation.choose(id, choice) }));
    handle('desktop:restart', restartService);
    handle('desktop:data-folder', () => shell.openPath(dataDir));
    handle('desktop:info', () => ({ version: app.getVersion(), dataDir, error, serviceUrl, browser: 'embedded' }));
    handle('desktop:visibility', () => mainWindow.isVisible() && !mainWindow.isMinimized());
    handle('desktop:notifications', () => notifications.snapshot());
    handle('desktop:notification-read', id => notifications.read(id));
    handle('desktop:notification-open', id => notifications.activate(id));
    handle('desktop:update-state', () => updates.snapshot());
    handle('desktop:update-check', () => updates.check());
    handle('desktop:update-download', () => updates.download());
    handle('desktop:update-install', () => updates.install());
    handle('desktop:update-notified', () => updates.acknowledgeNotification());
    blocker = powerSaveBlocker.start('prevent-app-suspension');
    await mainWindow.loadURL(loadingUrl);
    await internalBrowser.restoreCookies();
    await internalBrowser.create();
    await startWorker();
  }).catch((err) => { showError(err.message); dialog.showErrorBox(title, err.message); });
}
