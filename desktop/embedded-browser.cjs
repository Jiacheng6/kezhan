const { BrowserWindow, WebContentsView, session, safeStorage, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function webURL(url) {
  if (url === 'about:blank') return true;
  try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; }
}

// On Windows an initially hidden WebContentsView can retain a 0x0 renderer
// viewport even after its native bounds are set. Give it the same desktop
// viewport explicitly when its first document is ready. Do not rely on a
// second DevTools connection or briefly exposing the page to initialize it.
function setViewBounds(record, bounds) {
  record.view.setBounds(bounds);
  // Electron cannot emulate a renderer before its first document is ready.
  if (record.viewportReady === false) return;
  const key = `${bounds.width}x${bounds.height}`;
  if (record.viewportKey === key) return;
  record.view.webContents.enableDeviceEmulation({ screenPosition: 'desktop',
    screenSize: { width: bounds.width, height: bounds.height },
    viewSize: { width: bounds.width, height: bounds.height }, deviceScaleFactor: 0, scale: 1 });
  record.viewportKey = key;
}

// The only remote pages in the desktop app. They share an isolated persistent
// session, never the trusted workspace's preload, cookies or desktop privileges.
class EmbeddedBrowser {
  constructor(window, { dataDir, debugPort, onState = () => {}, log = () => {} }) {
    this.window = window; this.onState = onState; this.log = log;
    this.debugPort = debugPort;
    this.session = session.fromPartition('persist:learning-web');
    this.cookieFile = path.join(dataDir, 'browser-session.bin');
    this.views = new Map(); this.active = null; this.visible = false;
    this.captureWindow = null; this.captureReady = Promise.resolve();
    this.bounds = null; this.suspended = true; this.closeSuspended = false;
    this.lastContentSize = window.getContentSize();
    this.disposed = false; this.timer = null;
    this.session.setUserAgent(this.session.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sxuexitong-auto\/\S+/g, ''));
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.cookieChanged = () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.saveCookies().catch(() => this.log('内置网页登录保存失败，下次可能需要重新登录')), 700); };
    this.session.cookies.on('changed', this.cookieChanged);
    for (const event of ['resize', 'show', 'restore']) window.on(event, () => this.applyBounds());
  }
  ensureCaptureWindow() {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) return;
    // An invisible child view has no reliable compositor surface on Windows.
    // Give inactive pages a child in a transparent, noninteractive native host.
    // This host never navigates to a remote site or exposes desktop privileges.
    this.captureWindow = new BrowserWindow({ show: false, width: 1100, height: 760,
      skipTaskbar: true, focusable: false, webPreferences: { nodeIntegration: false,
        contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    this.captureWindow.setMenu(null);
    this.captureWindow.setOpacity(0);
    this.captureWindow.setIgnoreMouseEvents(true);
    this.captureReady = this.captureWindow.loadURL('about:blank').then(async () => {
      // Windows needs one native presentation to allocate the child surfaces.
      // Zero opacity, no taskbar and no focus keep this bootstrap invisible.
      if (this.captureWindow.isDestroyed()) return;
      this.captureWindow.showInactive();
      await new Promise(resolve => setTimeout(resolve, 200));
      // The transparent, nonfocusable host keeps its native surface alive.
    }).catch(error => { this.captureBootstrapError = error; });
  }
  async restoreCookies() {
    if (!fs.existsSync(this.cookieFile) || !safeStorage.isEncryptionAvailable()) return;
    try {
      const cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.cookieFile)));
      for (const c of cookies) {
        if (c.expirationDate && c.expirationDate <= Date.now() / 1000) continue;
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        const restored = { url, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
        if (!c.hostOnly) restored.domain = c.domain;
        if (c.expirationDate) restored.expirationDate = c.expirationDate;
        await this.session.cookies.set(restored).catch(() => {});
      }
    } catch { this.log('内置网页登录状态无法恢复，请重新登录；课程数据保留'); }
  }
  async saveCookies() {
    this.cookieSave = (this.cookieSave || Promise.resolve()).catch(() => {}).then(() => this.writeCookies());
    return this.cookieSave;
  }
  async writeCookies() {
    if (!safeStorage.isEncryptionAvailable()) return;
    const cookies = await this.session.cookies.get({});
    const bytes = safeStorage.encryptString(JSON.stringify(cookies));
    const temp = this.cookieFile + '.tmp';
    fs.writeFileSync(temp, bytes); fs.renameSync(temp, this.cookieFile);
    await this.session.cookies.flushStore();
  }
  snapshot() {
    return { kind: 'embedded', visible: this.visible, active: this.active,
      tabs: [...this.views.values()].filter(r => !r.view.webContents.isDestroyed()).map(r => {
        const c = r.view.webContents;
        return { id: c.id, targetId: r.targetId, title: c.getTitle() || '正在打开网页', url: c.getURL(), loading: c.isLoading(),
          canGoBack: c.navigationHistory.canGoBack(), canGoForward: c.navigationHistory.canGoForward(), error: r.error || '', role: r.role || '', busy: !!r.busy };
      }) };
  }
  publish() { if (!this.disposed) this.onState(this.snapshot()); }
  async create({ url = 'about:blank', show = false } = {}) {
    if (!webURL(url)) throw new Error('仅支持软件内的 HTTP/HTTPS 网页');
    // Release only persisted, idle review pages. The queue can restore them;
    // never turn a page-count threshold into a dead end for a new task.
    if(this.views.size>=12){
      const idle=[...this.views.values()].filter(r=>r.role==='review'&&!r.busy&&r.view.webContents.id!==this.active).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
      for(const r of idle){if(this.views.size<10)break;await this.closePage(r);}
    }
    const view = new WebContentsView({ webPreferences: { session: this.session, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    const record = await this.register(view);
    // A newly constructed WebContents has no document. Even the initial blank
    // tab must navigate, otherwise CDP clients wait forever for its first page.
    void view.webContents.loadURL(url).catch(() => {});
    if (show) this.activate(record.view.webContents.id, true);
    return { id: view.webContents.id, targetId: record.targetId };
  }
  async register(view) {
    this.ensureCaptureWindow();
    const c = view.webContents;
    const id = c.id;
    const record = { view, host: this.captureWindow, targetId: null, error: '', viewportReady: false, createdAt:Date.now() }; this.views.set(c.id, record);
    this.captureWindow.contentView.addChildView(view); view.setVisible(false);
    setViewBounds(record, { x: 0, y: 0, width: 1100, height: 760 });
    c.on('dom-ready', () => { record.viewportReady = true; record.viewportKey = null; this.applyBounds(); });
    c.on('will-navigate', (event, url) => { if (!webURL(url)) event.preventDefault(); });
    c.on('will-redirect', (event, url) => { if (!webURL(url)) event.preventDefault(); });
    c.on('will-prevent-unload', event => event.preventDefault());
    c.on('content-bounds-updated', event => event.preventDefault());
    c.setWindowOpenHandler(({ url, disposition }) => {
      if (!webURL(url)) return { action: 'deny' };
      return { action: 'allow', createWindow: options => {
        const popup = new WebContentsView({ webContents: options.webContents, webPreferences: { ...options.webPreferences, session: this.session, preload: undefined, nodeIntegration: false, nodeIntegrationInSubFrames: false,
          contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
        void this.register(popup).then(() => this.activate(popup.webContents.id, this.visible)).catch(() => this.log('内置新页面打开失败'));
        if (disposition === 'background-tab') void popup.webContents.loadURL(url).catch(() => {});
        return popup.webContents;
      } };
    });
    for (const event of ['page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) c.on(event, () => this.publish());
    c.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) record.error = ''; });
    c.on('did-fail-load', (_e, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      record.error = '网页加载失败，请检查网络后点击刷新。'; this.publish();
    });
    c.on('render-process-gone', () => { record.error = '此网页发生异常，请点击刷新重新打开。'; this.publish(); });
    c.on('destroyed', () => {
      this.views.delete(id);
      try { if (record.host && !record.host.isDestroyed()) record.host.contentView.removeChildView(view); } catch {}
      if (this.active === id) this.active = [...this.views.keys()].at(-1) ?? null;
      this.applyBounds(); this.publish();
    });
    // Resolve ownership through Electron's public target lookup. Attaching a
    // second debugger while window.open is negotiating can block the popup.
    const deadline = Date.now() + 10000;
    while (!record.targetId && Date.now() < deadline) {
      const targets = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      record.targetId = targets.find(t => webContents.fromDevToolsTargetId(t.id)?.id === id)?.id || null;
      if (!record.targetId) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!record.targetId) { c.close({ waitForBeforeUnload: false }); throw new Error('无法注册内置网页'); }
    if (!this.active) this.active = c.id;
    this.publish(); return record;
  }
  activate(id, show = false) {
    if (!this.views.has(Number(id))) throw new Error('网页已关闭，请重新打开');
    this.active = Number(id); if (show) this.visible = true;
    this.applyBounds(); this.publish(); return this.snapshot();
  }
  setVisible(visible) { this.visible = !!visible; this.applyBounds(); this.publish(); return this.snapshot(); }
  layout({ bounds, suspended } = {}) {
    if (bounds && bounds.width > 0 && bounds.height > 0 && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k]))) this.bounds = bounds;
    this.suspended = !!suspended; this.applyBounds();
  }
  applyBounds() {
    if (this.disposed || this.window.isDestroyed() || !this.captureWindow) return;
    const currentSize = this.window.getContentSize();
    // Windows 最小化时可能临时返回 0×0，不能据此把后台网页缩成 1×1。
    if(currentSize[0]>0&&currentSize[1]>0)this.lastContentSize=currentSize;
    const [w,h]=this.lastContentSize?.every(value=>value>0)?this.lastContentSize:[1240,840];
    const b = this.bounds || { x: 210, y: 174, width: w - 210, height: h - 174 };
    const x = Math.min(w - 1, Math.max(0, Math.round(b.x))), y = Math.min(h - 1, Math.max(0, Math.round(b.y)));
    const bounds = { x, y, width: Math.max(1, Math.min(w - x, Math.round(b.width))), height: Math.max(1, Math.min(h - y, Math.round(b.height))) };
    const captureSize = `${bounds.width}x${bounds.height}`;
    if (this.captureSize !== captureSize) {
      this.captureWindow.setContentSize(bounds.width, bounds.height);
      this.captureSize = captureSize;
    }
    for (const [id, r] of this.views) {
      if (r.view.webContents.isDestroyed()) continue;
      // Keep inactive/hidden pages alive for tasks; only their presentation changes.
      const shown = this.visible && !this.suspended && !this.closeSuspended && id === this.active;
      const host = shown ? this.window : this.captureWindow;
      const previousHost = r.host;
      if (previousHost !== host) {
        previousHost?.contentView.removeChildView(r.view);
        host.contentView.addChildView(r.view);
        r.host = host;
      }
      setViewBounds(r, shown ? bounds : { x: 0, y: 0, width: bounds.width, height: bounds.height });
      r.view.setVisible(true);
    }
  }
  async closePage(record){
    const contents=record.view.webContents;if(contents.isDestroyed())return;
    await new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{contents.off('destroyed',done);reject(new Error('网页尚未关闭，请稍后重试'));},3000);
      contents.once('destroyed',done);
      try{contents.close({waitForBeforeUnload:false});}catch(error){clearTimeout(timer);contents.off('destroyed',done);reject(error);}
    });
  }
  async command({ action, id } = {}) {
    if (action === 'open-zhihuishu') {
      const existing = [...this.views.values()].find(record => {
        try { return new URL(record.view.webContents.getURL()).hostname === 'onlineweb.zhihuishu.com'; } catch { return false; }
      });
      if (existing) return this.activate(existing.view.webContents.id, true);
      await this.create({ url: 'https://onlineweb.zhihuishu.com/onlinestuh5', show: true });
      return this.snapshot();
    }
    if (action === 'hide') return this.setVisible(false);
    if (action === 'show') return this.setVisible(true);
    if (action === 'select') return this.activate(id, true);
    if(action==='close'){
      const record=this.views.get(Number(id??this.active));
      if(!record)return this.snapshot();
      if(record.busy)throw new Error('此网页正在执行任务，请先停止任务，再关闭网页');
      await this.closePage(record);
      return this.snapshot();
    }
    const c = this.views.get(this.active)?.view.webContents;
    if (!c || c.isDestroyed()) throw new Error('请先打开网页');
    if (action === 'back' && c.navigationHistory.canGoBack()) c.navigationHistory.goBack();
    else if (action === 'forward' && c.navigationHistory.canGoForward()) c.navigationHistory.goForward();
    else if (action === 'reload') c.reload();
    else if (!['back', 'forward'].includes(action)) throw new Error('不支持的网页操作');
    return this.snapshot();
  }
  async request({ method, ...params } = {}) {
    if (method === 'list') return this.snapshot();
    if (method === 'create') return this.create(params);
    if (method === 'visible') return this.setVisible(params.visible);
    if (method === 'annotate') {
      const record = [...this.views.values()].find(r => r.targetId === params.targetId);
      if (!record) throw new Error('网页不存在');
      const roles = ['task', 'video', 'quiz', 'doc', 'review', 'recon-course', 'recon-tasks', 'view-status', 'verify-point'];
      if (roles.includes(params.role)) record.role = params.role;
      if (typeof params.busy === 'boolean') record.busy = params.busy;
      this.publish(); return { ok: true };
    }
    if (method === 'capture') {
      const record = [...this.views.values()].find(record => record.targetId === params.targetId);
      if (!record || record.view.webContents.isDestroyed()) throw new Error('截图网页已关闭');
      const rect = params.rect, bounds = record.view.getBounds();
      if (!rect || !['x','y','width','height'].every(key => Number.isInteger(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height) throw new Error('题目超出原生截图区域');
      const capture = async () => {
        await this.captureReady;
        if (this.captureBootstrapError) throw new Error('内部绘制初始化失败，请重启软件后重试');
        const c = record.view.webContents;
        if (c.isDestroyed() || this.disposed) throw new Error('截图网页已关闭');
        let timer;
        try {
          c.invalidate();
          // Allow the newly exposed native child surface to submit its first
          // compositor frame before requesting a copy (otherwise Viz rejects).
          await new Promise(resolve => setTimeout(resolve, 100));
          // A nonempty capture rect changes Chromium's preferred capture size.
          // Capture the existing viewport first, then crop the NativeImage.
          const image = await Promise.race([
            c.capturePage({ x: 0, y: 0, width: 0, height: 0 }, { stayHidden: true, stayAwake: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('软件内完整画面截图超时')), 6000); }),
          ]);
          const size = image.getSize();
          if (image.isEmpty() || size.width < rect.x + rect.width || size.height < rect.y + rect.height) throw new Error('原生题目截图不完整');
          const cropped = image.crop(rect);
          if (cropped.isEmpty()) throw new Error('原生题目截图为空');
          return { data: cropped.toPNG({ scaleFactor: 1 }).toString('base64') };
        } finally {
          clearTimeout(timer);
        }
      };
      // Serialize native copies so concurrent requests keep distinct results.
      const pending = (record.captureTail || Promise.resolve()).catch(() => {}).then(capture);
      record.captureTail = pending;
      return pending;
    }
    if (method === 'post') {
      if (!webURL(params.url) || params.url === 'about:blank') throw new Error('无效的网页请求');
      const response = await this.session.fetch(params.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params.form || {}).toString(), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('网页响应过大');
      return { status: response.status, text };
    }
    if (method === 'activate') {
      const record = [...this.views.values()].find(r => r.targetId === params.targetId);
      if (!record) throw new Error('网页不存在');
      return this.activate(record.view.webContents.id, false);
    }
    throw new Error('不支持的内置网页请求');
  }
  async close() {
    clearTimeout(this.timer); this.session.cookies.removeListener('changed', this.cookieChanged);
    await this.saveCookies().catch(() => this.log('退出时内置网页登录保存失败'));
    this.session.flushStorageData(); this.disposed = true;
    for (const r of this.views.values()) if (!r.view.webContents.isDestroyed()) r.view.webContents.close({ waitForBeforeUnload: false });
    this.views.clear();
    if (this.captureWindow && !this.captureWindow.isDestroyed()) this.captureWindow.destroy();
  }
}
module.exports = { EmbeddedBrowser, webURL, setViewBounds };
