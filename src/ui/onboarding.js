import { workspace } from './app.js';

document.documentElement.dataset.onboardingPending = 'true';
const dialog = document.createElement('dialog');
dialog.id = 'onboardingPanel';
dialog.className = 'desktop-dialog onboarding-dialog';
dialog.setAttribute('aria-labelledby', 'onboardingTitle');
dialog.innerHTML = `
  <div class="dialog-heading"><span class="dialog-label">欢迎使用学习通助手</span><span id="onboardingStep" class="dialog-label">1 / 2</span></div>
  <ol class="onboarding-steps" aria-label="设置步骤"><li id="onboardingLoginStep">登录学习通</li><li id="onboardingAIStep">选择做题 AI</li></ol>
  <section id="onboardingLogin">
    <h2 id="onboardingTitle" tabindex="-1">先连接你的学习通</h2>
    <p class="onboarding-description">在软件内打开学习通，扫码或使用账号登录，再返回向导检测。</p>
    <div class="onboarding-status"><span class="onboarding-status-dot" aria-hidden="true"></span><span id="onboardingLoginStatus" role="status">正在准备浏览器…</span></div>
    <div class="onboarding-actions"><button id="onboardingOpenLogin">打开学习通登录 ↗</button><button id="onboardingCheckLogin">我已登录，检测</button></div>
  </section>
  <section id="onboardingAI" hidden>
    <h2 id="onboardingAITitle" tabindex="-1">选择你的做题 AI</h2>
    <p class="onboarding-description">使用自己的网页账号，无需 API Key。以后可以在偏好设置中切换。</p>
    <fieldset class="onboarding-providers"><legend class="sr-only">做题 AI</legend>
      <label><input type="radio" name="onboardingProvider" value="qianwen" checked><span><b>千问</b><small>网页版</small></span></label>
      <label><input type="radio" name="onboardingProvider" value="doubao"><span><b>豆包</b><small>网页版</small></span></label>
      <label><input type="radio" name="onboardingProvider" value="deepseek"><span><b>DeepSeek</b><small>网页版</small></span></label>
    </fieldset>
    <div class="onboarding-status"><span class="onboarding-status-dot" aria-hidden="true"></span><span id="onboardingAIStatus" role="status">尚未检测登录</span></div>
    <div class="onboarding-actions"><button id="onboardingOpenAI">保存并打开 AI 登录 ↗</button><button id="onboardingCheckAI">检测 AI 登录</button></div>
    <p class="onboarding-note">AI 可以稍后登录；未登录时，请先使用视频学习。网页额度以平台提示为准。</p>
  </section>
  <p id="onboardingError" role="alert"></p>
  <div class="dialog-footer"><button id="onboardingLater" class="onboarding-later">稍后设置</button><div class="onboarding-actions"><button id="onboardingBack" hidden>上一步</button><button id="onboardingNext" class="onboarding-primary">下一步</button></div></div>`;
document.body.append(dialog);
const $ = id => document.getElementById(id);
let status = workspace.snapshot().status || {}, step = 1, busy = false, autoPending = false, paused = false;
const provider = () => dialog.querySelector('input:checked').value;
const names = { qianwen: '千问', doubao: '豆包', deepseek: 'DeepSeek' };
const blocked = () => status.running || status.reconRunning;
const browserReady = () => status.edge?.connected && (status.ready || status.browserMode === 'embedded');
async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || data.result?.error || '操作失败，请重试');
  return data;
}
function render() {
  $('onboardingStep').textContent = `${step} / 2`;
  $('onboardingLogin').hidden = step !== 1; $('onboardingAI').hidden = step !== 2;
  dialog.setAttribute('aria-labelledby', step === 1 ? 'onboardingTitle' : 'onboardingAITitle');
  $('onboardingLoginStep').setAttribute('aria-current', step === 1 ? 'step' : 'false');
  $('onboardingAIStep').setAttribute('aria-current', step === 2 ? 'step' : 'false');
  const login = !!status.login?.loggedIn;
  $('onboardingLoginStatus').textContent = login ? '学习通已登录，可以继续' : status.bootError || (browserReady() ? '等待你在内置网页中完成登录' : '正在准备网页引擎，请稍候…');
  $('onboardingLoginStatus').parentElement.classList.toggle('is-ready', login);
  const aiReady = status.ai?.provider === provider() && status.ai.loggedIn;
  $('onboardingAIStatus').textContent = aiReady ? `${names[provider()]}已登录` : `${names[provider()]}尚未检测到登录`;
  $('onboardingAIStatus').parentElement.classList.toggle('is-ready', !!aiReady);
  $('onboardingNext').textContent = busy ? '正在处理…' : step === 1 ? '下一步 →' : '保存选择，去选课 →';
  $('onboardingBack').hidden = step !== 2;
  for (const element of dialog.querySelectorAll('button, input')) element.disabled = busy;
  for (const id of ['onboardingOpenLogin', 'onboardingCheckLogin', 'onboardingOpenAI', 'onboardingCheckAI']) $(id).disabled = busy || !browserReady() || blocked();
  for (const input of dialog.querySelectorAll('input')) input.disabled = busy || blocked();
  $('onboardingNext').disabled = busy || !login || blocked();
  if (blocked()) $('onboardingError').textContent = '请先停止任务或等待扫描完成，再进行设置。';
  else if ($('onboardingError').textContent === '请先停止任务或等待扫描完成，再进行设置。') $('onboardingError').textContent = '';
}
function dismiss() {
  paused = false;
  dialog.close();
  document.documentElement.dataset.onboardingPending = 'false';
  document.dispatchEvent(new Event('onboarding-dismissed'));
}
function open() {
  if (dialog.open) return;
  document.documentElement.dataset.onboardingPending = 'true';
  step = 1; $('onboardingError').textContent = '';
  const current = status.settings?.ai?.provider || 'qianwen';
  const radio = [...dialog.querySelectorAll('input')].find(input => input.value === current);
  if (radio) radio.checked = true;
  render(); dialog.showModal(); $('onboardingTitle').focus();
}
async function run(action) {
  if (busy) return;
  busy = true; $('onboardingError').textContent = ''; render();
  try { await action(); }
  catch (error) { $('onboardingError').textContent = error.message; }
  finally { busy = false; render(); }
}
async function refresh() { status = await api('/api/status'); render(); }
async function action(name) { await api(`/api/action/${name}`, {}); await refresh(); }
async function saveProvider() { await api('/api/settings', { patch: { 'ai.provider': provider() } }); await refresh(); }
$('onboardingOpenLogin').onclick = () => run(() => action('openChaoxing'));
$('onboardingCheckLogin').onclick = () => run(async () => {
  await action('refreshLogin');
  if (!status.login?.loggedIn) throw new Error('还未检测到学习通登录，请在软件内的学习通网页完成登录后重试。');
});
$('onboardingOpenAI').onclick = () => run(async () => { await saveProvider(); await action('openAI'); });
$('onboardingCheckAI').onclick = () => run(async () => {
  await saveProvider(); await action('checkQianwen');
  if (status.ai?.provider !== provider() || !status.ai.loggedIn) throw new Error('还未检测到所选 AI 登录，请完成网页登录后重试，也可以稍后登录。');
});
$('onboardingNext').onclick = () => {
  if (step === 1) { step = 2; $('onboardingError').textContent = ''; render(); $('onboardingAITitle').focus(); return; }
  run(async () => {
    await saveProvider();
    await api('/api/onboarding', { action: 'complete', provider: provider() });
    workspace.navigate('courses'); dismiss();
  });
};
$('onboardingBack').onclick = () => { step = 1; $('onboardingError').textContent = ''; render(); $('onboardingTitle').focus(); };
$('onboardingLater').onclick = dismiss;
dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) dismiss(); });
dialog.querySelectorAll('input').forEach(input => input.addEventListener('change', () => { $('onboardingError').textContent = ''; render(); }));
$('reopenOnboarding').addEventListener('click', open);
document.addEventListener('embedded-browser-show', () => {
  if (!dialog.open) return;
  paused = true; dialog.close(); document.dispatchEvent(new Event('onboarding-paused'));
});
document.addEventListener('embedded-browser-hide', () => {
  if (!paused) return;
  paused = false; render(); dialog.showModal();
  $(step === 1 ? 'onboardingTitle' : 'onboardingAITitle').focus();
});
workspace.subscribe(snapshot => { status = snapshot.status || {}; if (dialog.open) render(); });
function maybeOpen() {
  if (!autoPending || $('desktopClosePanel')?.open || $('desktopUpdatePanel')?.open) return;
  autoPending = false; open();
}
document.addEventListener('desktop-close-dismissed', maybeOpen);
$('desktopUpdatePanel')?.addEventListener('close', maybeOpen);
try {
  const data = await api('/api/onboarding');
  autoPending = !data.result.completedAt && !blocked();
  if (autoPending) maybeOpen();
  else document.documentElement.dataset.onboardingPending = 'false';
} catch (error) {
  document.documentElement.dataset.onboardingPending = 'false';
  console.warn('首次使用向导读取失败', error);
} finally {
  if (!autoPending && !dialog.open) document.dispatchEvent(new Event('onboarding-dismissed'));
}
