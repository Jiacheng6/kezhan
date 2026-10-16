// Also loaded by the local startup/error page; it does not depend on the service.
(() => {
  const app = window.desktopApp;
  if (!app?.onCloseRequest) return;
  const panel = document.createElement('dialog');
  panel.id = 'desktopClosePanel'; panel.className = 'desktop-dialog';
  panel.setAttribute('aria-labelledby', 'closeTitle'); panel.setAttribute('aria-describedby', 'closeDescription');
  panel.innerHTML = `<div class="dialog-heading"><span class="dialog-label">窗口操作</span><button id="closeCancelIcon" class="dialog-icon" aria-label="取消关闭">×</button></div>
    <h2 id="closeTitle">关闭窗口后怎么处理？</h2><p id="closeDescription">隐藏窗口，任务仍会在后台继续。</p>
    <div class="close-options"><button id="closeHide" class="close-option"><b>隐藏到托盘 <span>↘</span></b><small>任务继续运行，双击托盘图标可返回。</small></button>
    <button id="closeExit" class="close-option"><b>停止任务并退出 <span>↗</span></b><small>保存进度与登录状态，关闭软件。</small></button></div>
    <div class="dialog-footer"><span id="closeError" role="status"></span><button id="closeCancel" autofocus>取消</button></div>`;
  document.body.append(panel);
  let requestId = null, answering = false, previousFocus;
  const buttons = [...panel.querySelectorAll('button')];
  const error = panel.querySelector('#closeError');
  async function answer(choice) {
    if (answering || requestId == null) return;
    answering = true; buttons.forEach(b => { b.disabled = true; });
    try {
      const result = await app.closeChoice(requestId, choice);
      if (!result.ok) throw Error('窗口状态已变化，请重新操作。');
      requestId = null; panel.close(); previousFocus?.focus?.({ preventScroll: true });
      document.dispatchEvent(new Event('desktop-close-dismissed'));
    } catch (err) { error.textContent = err.message || '操作失败，请重试。'; }
    finally { answering = false; buttons.forEach(b => { b.disabled = false; }); }
  }
  panel.querySelector('#closeHide').onclick = () => answer('hide');
  panel.querySelector('#closeExit').onclick = () => answer('exit');
  for (const id of ['closeCancel', 'closeCancelIcon']) panel.querySelector('#' + id).onclick = () => answer('cancel');
  panel.addEventListener('cancel', event => { event.preventDefault(); answer('cancel'); });
  app.onCloseRequest(request => {
    if (!request) return;
    requestId = request.id; error.textContent = '';
    if (!panel.open) { previousFocus = document.activeElement; panel.showModal(); }
  });
})();
