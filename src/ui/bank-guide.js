const desktop = window.desktopApp;
const $ = id => document.getElementById(id);
let openGuide;

export async function confirmBankUse(policy) {
  if (!openGuide || policy?.source !== 'bank' || policy.remind === false) return true;
  const config = await desktop.bankStatus().catch(() => null);
  if (!config || config.configured) return true;
  return openGuide({ forRun: true, fallback: policy.fallback === 'random' ? policy.aboveLimit : policy.fallback });
}

if (desktop?.bankQuota && desktop?.openBankPortal) {
  const dialog = document.createElement('dialog');
  dialog.className = 'desktop-dialog bank-guide-dialog';
  dialog.setAttribute('aria-labelledby', 'bankGuideTitle');
  dialog.innerHTML = `
    <p class="eyebrow">AXE 题库 · 学习通</p>
    <h2 id="bankGuideTitle" tabindex="-1">开通题库</h2>
    <p id="bankGuideIntro">题库可加快学习通章节测验和独立作业的答题。你可以按需开通。</p>
    <ol class="bank-guide-steps">
      <li><div><b>用微信登录题库官网</b><p>课栈会打开独立的 Edge 窗口供你扫码。新用户可领取 100 次免费调用额度。</p></div><button type="button" id="bankGuidePortal">用 Edge 微信扫码 ↗</button></li>
      <li><div><b>课栈自动导入令牌</b><p>登录后会自动保存令牌并返回这里，可查看剩余额度。</p></div>
        <details id="bankGuideManual"><summary>其他登录方式</summary>
          <div class="bank-guide-manual"><label class="bank-guide-token">题库令牌<input id="bankGuideToken" type="password" autocomplete="new-password" placeholder="粘贴官网提供的令牌"></label>
          <button type="button" id="bankGuideSave" disabled>保存并检查额度</button><button type="button" id="bankGuideEmbedded">使用内置网页 ↗</button></div>
        </details>
      </li>
    </ol>
    <p id="bankGuideStatus" class="bank-guide-status" role="status"></p>
    <div class="dialog-footer bank-guide-footer">
      <button type="button" id="bankGuideMute" class="text-button" hidden>不再提醒</button>
      <button type="button" id="bankGuideLater">关闭</button>
      <button type="button" id="bankGuideContinue" class="primary" hidden>暂不设置，继续</button>
    </div>`;
  document.body.append(dialog);
  $('bankAccount').hidden = false;

  let quota = { kind: 'unknown' };
  let configured = false;
  let refreshing = false;
  let busy = false;
  let resolveRun;
  let portalOpen = false;
  let edgeWaiting = false;
  const token = $('bankGuideToken');
  const guideStatus = $('bankGuideStatus');
  const portalNotice = document.createElement('div');
  portalNotice.className = 'bank-portal-hint';
  portalNotice.hidden = true;
  const portalHint = document.createElement('p');
  portalHint.setAttribute('role', 'status');
  const portalRetry = document.createElement('button');
  portalRetry.type = 'button';
  portalRetry.textContent = '重新打开官网登录';
  portalRetry.hidden = true;
  const edgeRetry = document.createElement('button');
  edgeRetry.type = 'button';
  edgeRetry.textContent = '用 Edge 登录并自动导入';
  edgeRetry.hidden = true;
  portalNotice.append(portalHint, portalRetry, edgeRetry);
  const scanHint = '在下面的官网用微信扫码，登录后课栈会自动保存令牌并返回。';

  async function startEdgeLogin() {
    if (edgeWaiting) return;
    edgeWaiting = true;
    syncButtons();
    const message = portalOpen ? portalHint : guideStatus;
    message.textContent = '正在打开独立 Edge 窗口…';
    try {
      const result = await desktop.openBankEdge();
      if (result?.configured) {
        document.dispatchEvent(new CustomEvent('bank-credential-saved', { detail: result.config }));
      } else if (edgeWaiting) {
        guideStatus.textContent = '请在独立 Edge 窗口扫码。若停在官网首页，点击微信登录。';
      }
    } catch {
      edgeWaiting = false;
      message.textContent = '未能打开独立 Edge 窗口。请重试，或展开「其他登录方式」。';
    } finally { syncButtons(); }
  }
  edgeRetry.onclick = startEdgeLogin;
  portalRetry.onclick = async () => {
    portalRetry.disabled = true;
    try {
      await desktop.openBankPortal(true, true);
      portalHint.textContent = '请在官网再次点击微信登录，使用新生成的二维码。';
      portalRetry.hidden = edgeRetry.hidden = true;
    } catch { portalHint.textContent = '暂时打不开官网，请稍后重试。'; }
    finally { portalRetry.disabled = false; }
  };

  function quotaText() {
    if (!configured) return '尚未配置令牌';
    if (refreshing) return '正在查询额度…';
    if (quota.kind === 'known') {
      if (quota.left === 0) return '剩余 0 次 · 可去官网充值，未解答题按现有策略处理';
      return `剩余 ${quota.left.toLocaleString('zh-CN')} 次${quota.left <= 10 ? ' · 额度偏低' : ''}`;
    }
    if (quota.kind === 'needs-login') return '令牌未激活或无效，请在官网登录并核对';
    if (quota.kind === 'exhausted') return '额度不足 · 可去官网充值，未解答题按现有策略处理';
    if (quota.kind === 'unavailable') return '暂时查不到额度，可稍后刷新';
    return '令牌已保存 · 点击刷新查看额度';
  }

  function renderQuota() {
    const message = quotaText();
    const status = $('bankQuotaStatus');
    if (status.textContent !== message) status.textContent = message;
    status.dataset.tone = ['needs-login', 'exhausted'].includes(quota.kind) || quota.kind === 'known' && quota.left <= 10 ? 'warn' : '';
    $('bankQuotaRefresh').hidden = $('bankTopUp').hidden = !configured;
    $('bankQuotaRefresh').disabled = refreshing;
    $('bankGuideOpen').textContent = configured ? '题库登录向导' : '开通题库';
    $('bankGuideContinue').textContent = configured ? '继续答题' : '暂不设置，继续';
    $('bankGuidePortal').textContent = configured ? '用 Edge 打开题库账户 ↗' : '用 Edge 微信扫码 ↗';
  }

  function updateQuota(next) {
    quota = next;
    renderQuota();
  }

  async function refreshQuota() {
    refreshing = true;
    renderQuota();
    try { updateQuota(await desktop.bankQuota(true)); }
    catch { updateQuota({ kind: 'unavailable' }); }
    finally { refreshing = false; renderQuota(); }
  }

  function show({ forRun = false, fallback } = {}) {
    $('bankGuideIntro').textContent = forRun
      ? `这次有学习通作业，你选了题库优先。现在可开通，也可以先继续，题目会${fallback === 'review' ? '留到待审' : '交给已选 AI 处理'}。`
      : '题库可加快学习通章节测验和独立作业的答题。你可以按需开通。';
    $('bankGuideMute').hidden = $('bankGuideContinue').hidden = !forRun;
    $('bankGuideLater').textContent = forRun ? '返回' : '关闭';
    $('bankGuideManual').open = false;
    guideStatus.textContent = configured ? quotaText() : edgeWaiting ? '正在等待 Edge 中的微信扫码。' : '';
    if (!dialog.open) dialog.showModal();
    $('bankGuideTitle').focus();
  }

  function close(continueRun) {
    const resolve = resolveRun;
    resolveRun = undefined;
    token.value = '';
    syncButtons();
    if (dialog.open) dialog.close();
    resolve?.(continueRun);
  }

  openGuide = options => {
    if (resolveRun || portalOpen || document.querySelector('dialog[open]')) return false;
    return new Promise(resolve => {
      resolveRun = resolve;
      show(options);
    });
  };

  async function openEmbeddedPortal() {
    const importToken = !configured;
    portalOpen = true;
    if (importToken) {
      $('webViewport')?.before(portalNotice);
      portalHint.textContent = scanHint;
      portalNotice.hidden = false;
      portalRetry.hidden = edgeRetry.hidden = true;
    }
    dialog.close();
    try { await desktop.openBankPortal(importToken, importToken); }
    catch {
      portalOpen = false;
      portalNotice.hidden = true;
      dialog.showModal();
      guideStatus.textContent = '暂时打不开题库官网，请重试。';
    }
  }

  function syncButtons() {
    $('bankGuideSave').disabled = busy || !token.value.trim();
    for (const id of ['bankGuideMute', 'bankGuideLater', 'bankGuideContinue']) $(id).disabled = busy;
    $('bankGuidePortal').disabled = $('bankGuideEmbedded').disabled = busy || edgeWaiting;
    edgeRetry.disabled = portalRetry.disabled = edgeWaiting;
    token.disabled = busy;
  }

  $('bankGuideOpen').onclick = () => show();
  $('bankWorkGuide').onclick = () => { show(); void startEdgeLogin(); };
  async function openEdgeAccount(message) {
    try { await desktop.openBankEdge(true); }
    catch { message.textContent = '未能在 Edge 打开题库账户，请重试。'; }
  }
  $('bankGuidePortal').onclick = () => configured ? openEdgeAccount(guideStatus) : startEdgeLogin();
  $('bankGuideEmbedded').onclick = openEmbeddedPortal;
  $('bankTopUp').onclick = () => openEdgeAccount($('bankQuotaStatus'));
  $('bankQuotaRefresh').onclick = refreshQuota;
  $('bankGuideLater').onclick = () => close(false);
  $('bankGuideContinue').onclick = () => close(true);
  async function muteReminder() {
    const result = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { 'answerBank.remind': false } }),
    }).then(response => response.json());
    if (!result.ok) throw Error('暂时无法保存提醒偏好，请重试。');
    $('bankWorkSetup').hidden = true;
  }
  $('bankWorkMute').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await muteReminder(); $('openBankSettings').focus(); }
    catch {
      $('bankWorkFeedback').textContent = '暂时无法保存提醒偏好，请重试。';
      $('bankWorkFeedback').hidden = false;
    } finally { button.disabled = false; }
  };
  $('bankGuideMute').onclick = async () => {
    busy = true;
    syncButtons();
    try {
      await muteReminder();
      close(true);
    } catch { guideStatus.textContent = '暂时无法保存提醒偏好，请重试。'; }
    finally { busy = false; syncButtons(); }
  };
  $('bankGuideSave').onclick = async () => {
    busy = true;
    syncButtons();
    try {
      const result = await desktop.bankSave({ origin: $('bankOrigin').defaultValue, token: token.value });
      token.value = '';
      document.dispatchEvent(new CustomEvent('bank-credential-saved', { detail: result }));
      await refreshQuota();
      guideStatus.textContent = quotaText();
    } catch (error) { guideStatus.textContent = error.message || '保存令牌失败，请重试。'; }
    finally { busy = false; syncButtons(); }
  };
  token.addEventListener('input', syncButtons);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(false); });
  document.addEventListener('embedded-browser-hide', () => {
    if (!portalOpen) return;
    portalOpen = false;
    portalNotice.hidden = true;
    if (!dialog.open) dialog.showModal();
    $('bankGuideTitle').focus();
  });
  desktop.onBankImport?.(async state => {
    if (state.kind === 'saved') {
      edgeWaiting = false;
      syncButtons();
      document.dispatchEvent(new CustomEvent('bank-credential-saved', { detail: state.config }));
      guideStatus.textContent = '已自动保存令牌，正在检查额度…';
      await refreshQuota();
      guideStatus.textContent = '已自动保存令牌。' + quotaText();
    } else if (state.kind === 'edge-stopped') {
      edgeWaiting = false;
      syncButtons();
      guideStatus.textContent = 'Edge 登录未完成。可以重新打开官网重试。';
    } else if (state.kind === 'edge-error') {
      edgeWaiting = false;
      syncButtons();
      guideStatus.textContent = '未能保存 Edge 登录后的令牌。请重试或使用手动填写。';
    } else if (portalOpen) {
      const message = state.kind === 'authorization-error'
        ? '题库官网未完成微信登录，账户页未打开。请重新生成二维码后再试。'
        : state.kind === 'save-error' ? '未能保存令牌。返回向导后可手动填写。' : '自动导入已结束。可重新打开官网登录。';
      portalHint.textContent = message;
      portalRetry.hidden = state.kind === 'save-error';
      edgeRetry.hidden = state.kind !== 'authorization-error' || !desktop.openBankEdge;
      guideStatus.textContent = portalHint.textContent;
      $('bankGuideManual').open = true;
    }
  });
  document.addEventListener('bank-credential-saved', ({ detail }) => {
    configured = detail.configured;
    if (configured) edgeWaiting = false;
    renderQuota();
  });
  desktop.onBankQuota?.(updateQuota);
  desktop.bankStatus().then(config => { configured = config.configured; renderQuota(); }).catch(() => {});
  desktop.bankQuota(false).then(updateQuota).catch(() => {});
}
