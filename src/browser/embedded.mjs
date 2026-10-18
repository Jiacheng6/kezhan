let sequence = 0;
const pending = new Map();
let state = { visible: false, tabs: [] };
export const embedded = process.env.XXT_EMBEDDED_BROWSER === '1';
if (embedded && process.parentPort) process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'browser-state') state = data.state;
  if (data?.type !== 'browser-response') return;
  const request = pending.get(data.id); if (!request) return;
  pending.delete(data.id); clearTimeout(request.timer);
  if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
});
export function embeddedRequest(method, params = {}) {
  if (!embedded || !process.parentPort) return Promise.reject(new Error('内置网页服务不可用'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('内置网页响应超时')); }, method === 'api-ask'?125000:method === 'post' ? 25000 : 15000);
    pending.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({ type: 'browser-request', id, request: { method, ...params } });
  });
}
export function embeddedVisible() { return state.visible; }
export async function captureEmbeddedPage(page, rect) {
  return embeddedRequest('capture', { targetId: await targetOf(page), rect });
}
const identities = new WeakMap();
export function targetOf(page) {
  if (!identities.has(page)) identities.set(page, (async () => {
    const session = await page.context().newCDPSession(page);
    try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
  })());
  return identities.get(page);
}
export async function embeddedContext(browser) {
  const raw = browser.contexts()[0], pages = new Map();
  const discover = async page => {
    try { const id = await targetOf(page); if (!page.isClosed()) { pages.set(page, id); page.once('close', () => pages.delete(page)); } } catch {}
  };
  raw.on('page', page => { void discover(page); });
  await Promise.all(raw.pages().map(discover));
  state = await embeddedRequest('list');
  const owned = () => {
    const ids = new Set(state.tabs.map(t => t.targetId));
    return [...pages].filter(([page, id]) => !page.isClosed() && ids.has(id)).map(([page]) => page);
  };
  const create = async () => {
    const result = await embeddedRequest('create');
    state = await embeddedRequest('list');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await Promise.all(raw.pages().filter(p => !pages.has(p)).map(discover));
      const page = [...pages].find(([page, id]) => !page.isClosed() && id === result.targetId)?.[0];
      if (page) return page;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('内置网页创建失败，请重启服务后重试');
  };
  return new Proxy(raw, { get(target, key) {
    if (key === 'pages') return owned;
    if (key === 'newPage') return create;
    if (key === 'request') return { post: async (url, options = {}) => {
      const response = await embeddedRequest('post', { url, form: options.form });
      return { ok: () => response.status >= 200 && response.status < 300, status: () => response.status, text: async () => response.text };
    } };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
