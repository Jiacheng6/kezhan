const app = window.desktopApp;
if (app) {
  const $ = (id) => document.getElementById(id);
  $('desktopToolbar').classList.remove('hidden');
  const bind = (id, action) => {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try { await action(); } catch (err) { alert(err.message || String(err)); }
      finally { $(id).disabled = false; }
    });
  };
  bind('desktopShowBrowser', async () => { await app.browser(true); $('desktopBrowserState').textContent = '浏览器已显示'; });
  bind('desktopHideBrowser', async () => { await app.browser(false); $('desktopBrowserState').textContent = '浏览器已隐藏 · 任务继续运行'; });
  bind('desktopDataFolder', app.dataFolder);
  bind('desktopClose', app.exit);
  bind('desktopRestart', async () => { if (confirm('重启会中断当前任务并保存进度，是否继续？')) await app.restart(); });
}
