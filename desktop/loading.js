document.getElementById('retry').onclick = () => window.desktopApp.restart();
document.getElementById('folder').onclick = () => window.desktopApp.dataFolder();
async function refresh() {
  const info = await window.desktopApp.info();
  document.getElementById('message').textContent = info.error ? '启动遇到问题，可查看日志后重试。' : '正在启动服务与专用浏览器，请稍候…';
  document.getElementById('error').textContent = info.error || '';
}
refresh();
setInterval(refresh, 1500);
