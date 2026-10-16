import { summarizeReleaseNotes } from './update-notes.js';
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
  bind('desktopShowBrowser', async () => { await app.browser(true); $('desktopBrowserState').textContent = '网页已在软件内打开'; });
  bind('desktopHideBrowser', async () => { await app.browser(false); $('desktopBrowserState').textContent = '已返回工作台 · 任务继续运行'; });
  bind('desktopDataFolder', app.dataFolder);
  bind('desktopClose', app.exit);
  bind('desktopRestart', async () => { if (confirm('重启会中断当前任务并保存进度，是否继续？')) await app.restart(); });
  function openUpdate() {
    if ($('desktopClosePanel')?.open || $('onboardingPanel')?.open || document.documentElement.dataset.onboardingPending === 'true') return false;
    const panel=$('desktopUpdatePanel');
    if(!panel.open)panel.showModal();
    return true;
  }
  let notifiedVersion=null;
  let notesKey = null;
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
    $('updateNextVersion').textContent=status.nextVersion?`${status.nextVersion} · 主要变化`:'主要变化';
    const key = `${status.nextVersion}\n${status.releaseNotes || ''}`;
    if (notesKey !== key) {
      notesKey = key;
      const summary = summarizeReleaseNotes(status.releaseNotes);
      const notes = $('updateNotes'); notes.replaceChildren();
      if (summary.items.length) {
        const list = document.createElement('ul'); list.className = 'update-highlights';
        for (const item of summary.items) { const li = document.createElement('li'); li.textContent = item; list.append(li); }
        notes.append(list);
      } else notes.textContent = '此版本未提供更新说明。';
      $('updateFullNotes').textContent = status.releaseNotes || '';
      $('updateFullSection').classList.toggle('hidden', !summary.hasMore);
      $('updateFullSection').open = false;
    }
    $('updateNotesSection').classList.toggle('hidden',!status.nextVersion);
    if(status.notificationPending&&status.phase==='available'&&status.nextVersion!==notifiedVersion){
      if (openUpdate()) { notifiedVersion=status.nextVersion; app.updateNotified().catch(()=>{}); }
    }
  }
  app.onUpdate(renderUpdate);
  app.updateState().then(renderUpdate).catch(()=>{});
  document.addEventListener('desktop-close-dismissed', () => app.updateState().then(renderUpdate).catch(()=>{}));
  document.addEventListener('onboarding-dismissed', () => app.updateState().then(renderUpdate).catch(()=>{}));
  bind('desktopUpdate', async () => {
    openUpdate();
    renderUpdate(await app.updateState());
    renderUpdate(await app.checkUpdate());
  });
  bind('updateCheck', async () => renderUpdate(await app.checkUpdate()));
  bind('updateDownload', async () => renderUpdate(await app.downloadUpdate()));
  bind('updateInstall', async () => renderUpdate(await app.installUpdate()));
  bind('updateLater', async () => $('desktopUpdatePanel').close());
}
