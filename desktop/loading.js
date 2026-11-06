document.getElementById('retry').onclick = () => window.desktopApp.restart();
document.getElementById('folder').onclick = () => window.desktopApp.dataFolder();
async function refresh() {
  const info = await window.desktopApp.info();
  document.querySelector('h2').textContent = info.error ? '工作台启动失败' : '正在准备，稍候片刻。';
  document.getElementById('message').textContent = info.error ? '启动遇到问题，可查看日志后重试。' : '正在启动工作台，请稍候…';
  document.getElementById('error').textContent = info.error || '';
}
refresh();
setInterval(refresh, 1500);
