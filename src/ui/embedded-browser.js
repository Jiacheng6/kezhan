import { workspace } from './app.js';
import { renderTaskProgress } from './task-progress.js';
import { currentTaskPage, pageKind, sortedPages } from './web-pages.js';
const app = window.desktopApp;
if (app?.webState) {
  const shortcuts = document.createElement('div'); shortcuts.className = 'web-shortcuts';
  shortcuts.innerHTML = '<button id="webOpenLearning">学习通网页 <span>↗</span></button><button id="webOpenAI">AI 网页 <span>↗</span></button>';
  document.querySelector('.sidebar .tabs').after(shortcuts);
  const pane = document.createElement('section'); pane.id = 'embeddedBrowser'; pane.className = 'embedded-pane'; pane.hidden = true;
  pane.setAttribute('aria-label', '软件内网页');
  pane.innerHTML = `<div class="embedded-heading"><div><span class="embedded-caption">软件内网页</span><span id="webDomain"></span></div><button id="webReturn">返回工作台 →</button></div>
    <div class="embedded-toolbar"><div id="webTabs" class="embedded-tabs" role="tablist" aria-label="已打开的网页"></div><div class="embedded-navigation"><button id="webBack" aria-label="网页后退">←</button><button id="webForward" aria-label="网页前进">→</button><button id="webReload" aria-label="刷新网页">↻</button></div></div>
    <div id="webTaskProgress" hidden></div><p id="webError" role="alert" hidden></p><div id="webViewport" class="embedded-viewport" role="tabpanel" aria-label="网页内容"></div>`;
  document.body.append(pane);
  const picker = document.createElement('dialog'); picker.id = 'webPagesDialog'; picker.className = 'web-pages-dialog';
  picker.setAttribute('aria-labelledby', 'webPagesTitle'); picker.setAttribute('aria-describedby', 'webPagesDescription');
  picker.innerHTML = `<div class="wp-heading"><div><span class="wp-eyebrow">WEB / 软件内网页</span><h2 id="webPagesTitle">查看网页<span>.</span></h2></div><button id="webPagesClose" aria-label="关闭网页列表" autofocus>×</button></div>
    <p id="webPagesDescription">查看正在学习的页面，或切换到已登录的 AI。返回工作台后任务继续运行。</p>
    <button id="webTaskJump" class="wp-task" hidden><span><small>正在进行的任务</small><b id="webTaskTitle"></b></span><span aria-hidden="true">↗</span></button>
    <div class="wp-list-heading"><b>已打开的网页</b><span id="webPagesTotal"></span></div><div id="webPagesList" class="wp-list"></div>
    <p id="webPagesMessage" role="status"></p><div class="wp-actions"><button id="webPagesLearning">打开学习通</button><button id="webPagesAI">打开 AI 网页</button></div>`;
  document.body.append(picker);
  const $ = id => document.getElementById(id);
  let state = { visible: false, tabs: [], active: null }, busy = false, connected = false, layoutFrame = null, tabsKey = '', pagesKey = '';
  $('viewWebPages').hidden = false;
  const layout = () => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      const left = Math.ceil(document.querySelector('.sidebar').getBoundingClientRect().right);
      pane.style.left = left + 'px';
      const b = $('webViewport').getBoundingClientRect();
      app.webLayout({ ...(!pane.hidden && b.width > 0 && b.height > 0 ? { bounds: { x: b.x, y: b.y, width: b.width, height: b.height } } : {}),
        suspended: pane.hidden || !!document.querySelector('dialog[open]') }).catch(() => {});
    });
  };
  const command = async action => {
    try { const next = await app.webCommand(action); if (next) render(next); $('webError').hidden = true; return true; }
    catch (error) { $('webError').textContent = error.message; $('webError').hidden = false; layout(); return false; }
  };
  const openPage = async id => {
    if (await command({ action: 'select', id })) picker.close();
    else $('webPagesMessage').textContent = '这个网页已关闭，请选择其他页面或重新打开。';
  };
  const renderPages = () => {
    const task = currentTaskPage(state.tabs);
    $('webPageCount').textContent = state.tabs.length;
    $('viewWebPages').setAttribute('aria-label', `查看网页，${state.tabs.length} 个已打开页面`);
    $('viewWebPages').classList.toggle('has-task', !!task);
    $('viewWebPages').setAttribute('aria-expanded', String(picker.open));
    $('webTaskJump').hidden = !task;
    $('webTaskTitle').textContent = task?.title || '正在打开任务网页';
    $('webPagesTotal').textContent = `${state.tabs.length} 个`;
    $('webPagesLearning').disabled = !connected;
    const ai = state.tabs.find(t => pageKind(t) === 'AI 网页');
    $('webPagesAI').disabled = !connected || (busy && !ai);
    $('webPagesAI').title = busy && !ai ? '任务结束后可打开新的 AI 页面' : '查看 AI 网页';
    const key = JSON.stringify([state.active, state.tabs.map(t => [t.id, t.title, t.url, t.role, t.busy, t.loading])]);
    if (key === pagesKey) return;
    pagesKey = key;
    const focusId = document.activeElement?.dataset?.pageId;
    $('webPagesList').replaceChildren(...sortedPages(state.tabs).map(tab => {
      const button = document.createElement('button'); button.className = 'wp-page'; button.dataset.pageId = tab.id;
      button.classList.toggle('wp-page-active', tab.id === state.active);
      const icon = document.createElement('span'); icon.className = 'wp-page-icon'; icon.textContent = pageKind(tab) === 'AI 网页' ? 'AI' : taskRolesLabel(tab);
      const copy = document.createElement('span'); copy.className = 'wp-page-copy';
      const title = document.createElement('b'); title.textContent = tab.url === 'about:blank' ? '正在打开网页…' : tab.title || '网页';
      const detail = document.createElement('small'); let host = ''; try { host = new URL(tab.url).host; } catch {}
      detail.textContent = [pageKind(tab), host, tab.loading ? '加载中' : ''].filter(Boolean).join(' · ');
      const arrow = document.createElement('span'); arrow.className = 'wp-page-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      copy.append(title, detail); button.append(icon, copy, arrow); button.onclick = () => openPage(tab.id); return button;
    }));
    $('webPagesMessage').textContent = state.tabs.length ? '' : '还没有打开网页，可以先打开学习通或 AI 登录页。';
    if (focusId) ($('webPagesList').querySelector(`[data-page-id="${Number(focusId)}"]`) || $('webPagesClose')).focus();
  };
  const taskRolesLabel = tab => ({ video: '▶', quiz: '答', doc: '阅', review: '审' })[tab.role] || '↗';
  const showPages = async (mode = 'all') => {
    try { render(await app.webState()); } catch {}
    const task = currentTaskPage(state.tabs);
    if (mode === 'task' && task) { await openPage(task.id); return; }
    if (!picker.open) picker.showModal();
    if (mode === 'task' && !task) $('webPagesMessage').textContent = '当前任务网页尚未就绪或已关闭，可从下面选择已有页面。';
    renderPages(); layout();
  };
  const render = next => {
    const changed = next.visible !== state.visible;
    state = next; pane.hidden = !state.visible;
    if (changed) document.dispatchEvent(new Event(state.visible ? 'embedded-browser-show' : 'embedded-browser-hide'));
    const active = state.tabs.find(t => t.id === state.active);
    const key = JSON.stringify([state.active, state.tabs.map(t => [t.id, t.title, t.url])]);
    if (tabsKey !== key) {
    tabsKey = key;
    const focusId = document.activeElement?.dataset?.webId;
    $('webTabs').replaceChildren(...state.tabs.map(tab => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.id === state.active)); button.dataset.webId = tab.id;
      button.textContent = tab.url === 'about:blank' ? '待打开网页' : tab.title || '正在打开网页'; button.title = button.textContent;
      button.onclick = () => command({ action: 'select', id: tab.id }); return button;
    }));
    if (focusId) $('webTabs').querySelector(`[data-web-id="${Number(focusId)}"]`)?.focus();
    }
    let domain = ''; try { domain = new URL(active?.url).host; } catch {}
    $('webDomain').textContent = active?.loading ? '正在加载…' : domain;
    $('webBack').disabled = busy || !active?.canGoBack; $('webForward').disabled = busy || !active?.canGoForward;
    $('webReload').disabled = busy || !active;
    $('webError').hidden = !active?.error; $('webError').textContent = active?.error || '';
    renderPages(); layout();
  };
  $('webOpenLearning').onclick = () => workspace.action('openChaoxing');
  $('webOpenAI').onclick = () => workspace.action('openAI');
  $('viewWebPages').onclick = () => showPages();
  $('webPagesClose').onclick = () => picker.close();
  $('webTaskJump').onclick = () => { const task = currentTaskPage(state.tabs); if (task) void openPage(task.id); };
  for (const [id, action] of [['webPagesLearning', 'openChaoxing'], ['webPagesAI', 'openAI']]) $(id).onclick = async () => {
    const existing = id === 'webPagesAI' && state.tabs.find(tab => pageKind(tab) === 'AI 网页');
    if (existing) { await openPage(existing.id); return; }
    const result = await workspace.action(action);
    if (result?.ok === false) $('webPagesMessage').textContent = result.error || '网页未能打开，请稍后重试。';
    else picker.close();
  };
  picker.addEventListener('close', () => { $('viewWebPages').setAttribute('aria-expanded', 'false'); layout(); });
  document.addEventListener('click', event => { const button = event.target.closest('[data-open-web]'); if (button) void showPages(button.dataset.openWeb); });
  document.addEventListener('open-web-pages', event => { void showPages(event.detail?.mode || 'all'); });
  $('webReturn').onclick = () => command({ action: 'hide' });
  for (const [id, action] of [['webBack', 'back'], ['webForward', 'forward'], ['webReload', 'reload']]) $(id).onclick = () => command({ action });
  document.querySelectorAll('.tab, #enterLibrary').forEach(button => button.addEventListener('click', () => { if (state.visible) void command({ action: 'hide' }); }));
  document.addEventListener('onboarding-paused', () => { $('webReturn').textContent = '返回设置向导 →'; });
  document.addEventListener('onboarding-dismissed', () => { $('webReturn').textContent = '返回工作台 →'; });
  workspace.subscribe(({ status }) => {
    busy = !!(status?.running || status?.reconRunning);
    connected = !!status?.edge?.connected;
    renderTaskProgress($('webTaskProgress'), status || {});
    $('webOpenLearning').disabled = !status?.edge?.connected;
    $('webOpenAI').disabled = !status?.edge?.connected || busy;
    render(state);
  });
  new ResizeObserver(layout).observe($('webViewport'));
  new MutationObserver(layout).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  window.addEventListener('resize', layout);
  app.onWebState(render); app.webState().then(render).catch(() => {});
}
