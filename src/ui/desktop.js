const app = window.desktopApp;
if (app) {
  const $ = (id) => document.getElementById(id);
  $('desktopToolbar').classList.remove('hidden');
  const bind = (id, action) => {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try { await action(); } catch (err) { alert(err.message || String(err)); }
      finally {
        $(id).disabled = false;
        if (id.startsWith('update')) renderUpdate(await app.updateState());
      }
    });
  };
  bind('desktopShowBrowser', async () => { await app.browser(true); $('desktopBrowserState').textContent = '浏览器已显示'; });
  bind('desktopHideBrowser', async () => { await app.browser(false); $('desktopBrowserState').textContent = '浏览器已隐藏 · 任务继续运行'; });
  bind('desktopDataFolder', app.dataFolder);
  bind('desktopClose', app.exit);
  bind('desktopRestart', async () => { if (confirm('重启会中断当前任务并保存进度，是否继续？')) await app.restart(); });
  function renderUpdate(status) {
    $('updateCurrentVersion').textContent = `当前 ${status.currentVersion}`;
    $('updateMessage').textContent = status.message;
    const busy = ['checking', 'downloading', 'installing'].includes(status.phase);
    $('updateCheck').disabled = busy || !status.enabled || status.downloadReady;
    $('updateDownload').classList.toggle('hidden', !status.nextVersion || status.downloadReady);
    $('updateDownload').disabled = busy;
    $('updateInstall').classList.toggle('hidden', !status.downloadReady);
    $('updateInstall').disabled = busy;
    $('updateInstall').textContent = status.installed ? '保存并安装' : '安装新版（保留数据）';
    $('updateProgress').classList.toggle('hidden', !['downloading', 'ready', 'installing'].includes(status.phase));
    $('updateProgress').value = status.percent;
  }
  app.onUpdate(renderUpdate);
  bind('desktopUpdate', async () => {
    $('desktopUpdatePanel').classList.remove('hidden');
    renderUpdate(await app.updateState());
    renderUpdate(await app.checkUpdate());
  });
  bind('updateCheck', async () => renderUpdate(await app.checkUpdate()));
  bind('updateDownload', async () => renderUpdate(await app.downloadUpdate()));
  bind('updateInstall', async () => renderUpdate(await app.installUpdate()));
  bind('updateLater', async () => $('desktopUpdatePanel').classList.add('hidden'));
}
