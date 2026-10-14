const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, utilityProcess, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

const title = '学习通助手';
const smokeTest = process.argv.includes('--smoke-test');
const testMode = smokeTest || process.argv.includes('--test-mode');
const dataDir = testMode && process.env.XXT_TEST_DATA_DIR
  ? path.resolve(process.env.XXT_TEST_DATA_DIR)
  : path.join(app.getPath('appData'), 'XuexitongAssistant');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('com.xuexitong.assistant');
const loadingUrl = pathToFileURL(path.join(__dirname, 'loading.html')).href;
let mainWindow, tray, worker, serviceUrl, error = '', quitting = false, closeDialog = false, restarting = false;
let heartbeat, startupTimer, blocker;
const logFile = path.join(dataDir, 'logs', 'desktop.log');
function log(message) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch {}
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
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
}
async function stopWorker() {
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
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 12000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.postMessage({ type: 'shutdown' });
  });
}
async function exitApplication() {
  if (quitting) return;
  quitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${title} — 正在保存进度并退出…`);
  await stopWorker();
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  tray?.destroy();
  app.quit();
}
async function requestClose() {
  if (closeDialog || quitting) return;
  closeDialog = true;
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question', title, message: '关闭窗口后要怎样处理？',
      detail: '隐藏到托盘会继续运行任务。退出会停止任务、保存进度，并关闭本软件的专用浏览器。',
      buttons: ['隐藏到托盘，继续运行', '停止任务并退出', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (result.response === 0) mainWindow.hide();
    if (result.response === 1) await exitApplication();
  } finally { closeDialog = false; }
}
async function startWorker() {
  error = ''; serviceUrl = null;
  const debugPort = await freePort();
  const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], {
    cwd: app.getAppPath(), stdio: 'pipe', serviceName: title + '后台服务',
    env: { ...process.env, XXT_DATA_DIR: dataDir, XXT_DEBUG_PORT: String(debugPort), XXT_DESKTOP: '1',
      XXT_OWNER_PID: String(process.pid), ...(testMode ? { XXT_SMOKE_TEST: '1' } : {}) },
  });
  worker = child;
  child.on('error', (details) => showError(`后台进程异常：${details?.type || '未知错误'}`));
  child.stdout?.on('data', (data) => log(data.toString().trimEnd()));
  child.stderr?.on('data', (data) => log(data.toString().trimEnd()));
  child.on('message', async (message) => {
    if (worker !== child) return;
    if (message.type === 'server-ready') {
      const url = new URL(message.url);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return showError('后台服务返回了无效地址');
      serviceUrl = message.url;
      clearTimeout(startupTimer);
      log(`服务就绪 ${serviceUrl}`);
      await mainWindow.loadURL(serviceUrl);
      if (tray) tray.setToolTip(title + '：服务运行中');
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
      backgroundColor: '#f4f7fc', icon, show: !testMode,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); requestClose(); } });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!safePage(url)) event.preventDefault(); });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('render-process-gone', () => showError('界面发生异常，请从托盘重新打开或重启服务。'));
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }));
    tray.setToolTip(title + '：正在启动');
    tray.on('double-click', showMain);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开学习通助手', click: showMain },
      { label: '显示浏览器', click: () => serviceAction('showBrowser').catch((err) => showError(err.message)) },
      { label: '隐藏浏览器（任务继续运行）', click: () => serviceAction('hideBrowser').catch((err) => showError(err.message)) },
      { type: 'separator' }, { label: '打开数据与日志文件夹', click: () => shell.openPath(dataDir) },
      { label: '重启后台服务', click: restartService }, { type: 'separator' },
      { label: '关闭软件…', click: () => { showMain(); requestClose(); } },
    ]));
    const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => { assertSender(event); return fn(...args); });
    handle('desktop:browser', (visible) => serviceAction(visible ? 'showBrowser' : 'hideBrowser'));
    handle('desktop:hide', () => mainWindow.hide());
    handle('desktop:exit', requestClose);
    handle('desktop:restart', restartService);
    handle('desktop:data-folder', () => shell.openPath(dataDir));
    handle('desktop:info', () => ({ version: app.getVersion(), dataDir, error, serviceUrl }));
    blocker = powerSaveBlocker.start('prevent-app-suspension');
    await mainWindow.loadURL(loadingUrl);
    await startWorker();
  }).catch((err) => { showError(err.message); dialog.showErrorBox(title, err.message); });
}
