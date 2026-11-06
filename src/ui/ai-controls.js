import {workspace} from './app.js';
const desktop=window.desktopApp;
const $ = id => document.getElementById(id);
const canConfigureBank = Boolean(desktop?.bankSave && desktop?.bankStatus);
let bankConfig;
let bankStatusFailed = false;

function setBankState(id, label, tone = '') {
  const element = $(id);
  if (element.textContent !== label) element.textContent = label;
  element.dataset.tone = tone;
}

function renderBankContext({ status, platformFilter }) {
  $('bankWorkStrip').hidden = !['all', 'chaoxing'].includes(platformFilter);
  if (!canConfigureBank) setBankState('bankConfigState', '请在桌面端配置', 'warn');
  else if (bankStatusFailed) setBankState('bankConfigState', '配置状态未知', 'warn');
  else if (bankConfig?.configured) setBankState('bankConfigState', '题库令牌已配置', 'ready');
  else if (bankConfig) setBankState('bankConfigState', '题库令牌未配置', 'warn');
  const policy = status?.settings?.answerBank;
  $('bankWorkSetup').hidden = !desktop?.onBankImport || policy?.source !== 'bank' || policy.remind === false || bankConfig?.configured !== false;
  if (!policy) return;
  if (policy.source === 'ai') setBankState('bankWorkMode', '只用 AI');
  else if (bankConfig?.configured) {
    const mode = { ai: 'AI 补答', review: '未命中转待审', random: '未命中 ≤20% 时随机补填' };
    setBankState('bankWorkMode', '题库优先 · ' + (mode[policy.fallback] || mode.ai), 'ready');
  } else if (!canConfigureBank || bankConfig || bankStatusFailed) {
    setBankState('bankWorkMode', bankStatusFailed ? '题库状态未知' : '题库未配置', 'warn');
  }
}

workspace.subscribe(renderBankContext);
document.addEventListener('workspace-action-result', ({ detail }) => {
  if (detail?.name !== 'startStandaloneWork' || detail.result?.cancelled) return;
  const feedback = $('bankWorkFeedback');
  const started = detail.result?.ok && detail.result.result?.started;
  feedback.textContent = started ? '作业已开始，下方进度条会显示当前题目。' : detail.result?.error || '暂未开始，请确认作业页已加载。';
  feedback.dataset.tone = started ? 'ready' : 'warn';
  feedback.hidden = false;
});

if (canConfigureBank) {
  $('bankCredential').hidden = false;
  const token = $('bankToken');
  const saveButton = $('bankSave');
  const clearButton = $('bankClear');
  const message = text => { $('bankMessage').textContent = text; };
  const renderConfig = config => {
    bankConfig = config;
    bankStatusFailed = false;
    const origin = $('bankOrigin');
    origin.value = config.origin || origin.defaultValue;
    clearButton.hidden = !config.configured;
    message(config.configured ? '令牌已加密保存' : '尚未配置题库令牌');
    renderBankContext(workspace.snapshot());
  };
  const syncButtons = () => {
    saveButton.disabled = !token.value.trim();
    clearButton.disabled = false;
  };
  desktop.bankStatus().then(renderConfig).catch(() => {
    bankStatusFailed = true;
    message('暂时无法读取题库配置');
    renderBankContext(workspace.snapshot());
  });
  document.addEventListener('bank-credential-saved', ({ detail }) => renderConfig(detail));
  const save = async clear => {
    saveButton.disabled = clearButton.disabled = true;
    token.disabled = true;
    try {
      const config = await desktop.bankSave({ origin: $('bankOrigin').value, token: token.value, clear });
      document.dispatchEvent(new CustomEvent('bank-credential-saved', { detail: config }));
    } catch (error) { message(error.message); }
    finally {
      token.value = '';
      token.disabled = false;
      syncButtons();
      token.focus();
    }
  };
  token.addEventListener('input', syncButtons);
  saveButton.onclick = () => save(false);
  clearButton.onclick = () => save(true);
  syncButtons();
}

if(desktop){
  const details=document.createElement('details');details.className='settings-details';details.id='apiSettings';
  details.innerHTML=`<summary>API 接口 <span>OpenAI 兼容</span></summary><div class="api-config-grid"><label>API 地址<input id="apiBaseUrl" type="url" placeholder="https://服务地址/v1" autocomplete="off"></label><label>模型名称<input id="apiModel" placeholder="支持图片输入的模型" autocomplete="off"></label><label>API 密钥<input id="apiKey" type="password" placeholder="留空保留已保存密钥" autocomplete="new-password"></label></div><p class="small">模型需要支持图片输入。密钥仅在本机加密保存；接口与测试请求按服务商规则计费。</p><div class="actions"><button id="apiSave">保存 API 配置</button><button id="apiTest">测试已保存配置</button></div><p id="apiMessage" role="status"></p>`;
  $('settingsApiSlot').append(details);
  workspace.subscribe(({status}) => {
    const label = status?.ai?.provider === 'api' ? '打开 API 配置' : '打开所选 AI 网页 ↗';
    if ($('settingsOpenAI').textContent !== label) $('settingsOpenAI').textContent = label;
  });
  const message=text=>$('apiMessage').textContent=text;
  const render=config=>{$('apiBaseUrl').value=config.baseUrl||'';$('apiModel').value=config.model||'';$('apiKey').value='';message(config.hasKey?'密钥已加密保存；选择 API 答题通道并保存设置后生效。':'尚未保存 API 密钥。');};
  desktop.apiStatus?.().then(render).catch(error=>message(error.message));
  $('apiSave').onclick=async()=>{
    $('apiSave').disabled=true;
    try{render(await desktop.apiSave({baseUrl:$('apiBaseUrl').value,model:$('apiModel').value,apiKey:$('apiKey').value}));await workspace.action('checkQianwen');}
    catch(error){message(error.message);}finally{$('apiSave').disabled=false;}
  };
  $('apiTest').onclick=async()=>{
    $('apiTest').disabled=true;message('正在测试已保存的接口…');
    try{const result=await desktop.apiTest();message(result.ok?'接口连接成功。答题模型仍须支持图片输入。':result.error);}
    catch(error){message(error.message);}finally{$('apiTest').disabled=false;}
  };
  const banner=document.createElement('section');banner.className='ai-resume-banner';banner.hidden=true;banner.setAttribute('aria-live','polite');
  banner.innerHTML='<div><b id="aiResumeTitle">需要人工验证</b><p>请在软件内 AI 网页完成验证，然后继续当前题目。</p><span id="aiResumeError" role="status"></span></div><div class="actions"><button id="aiResumeOpen">打开 AI 网页</button><button id="aiResumeContinue" class="primary">验证已完成，继续本题</button><button id="aiResumeStop">停止任务</button></div>';
  document.querySelector('main').prepend(banner);
  $('aiResumeOpen').onclick=()=>workspace.action('openAI');
  $('aiResumeStop').onclick=async()=>{const platform=workspace.snapshot().status?.aiQueue?.active?.platform;await fetch('/api/action/stopRun',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(platform?{platform}:{})});};
  $('aiResumeContinue').onclick=async()=>{
    $('aiResumeContinue').disabled=true;$('aiResumeError').textContent='';
    try{const response=await fetch('/api/action/continueAI',{method:'POST'}).then(r=>r.json());if(!response.ok)throw Error(response.error);}
    catch(error){$('aiResumeError').textContent=error.message;}finally{$('aiResumeContinue').disabled=false;}
  };
  const position=()=>{
    const pane=$('embeddedBrowser');
    if(pane&&!pane.hidden)pane.querySelector('.embedded-toolbar').before(banner);
    else document.querySelector('main').prepend(banner);
  };
  document.addEventListener('embedded-browser-show',position);document.addEventListener('embedded-browser-hide',position);
  workspace.subscribe(({status})=>{const wait=status?.aiWaiting;banner.hidden=!wait?.waiting;if(wait?.waiting){$('aiResumeTitle').textContent=`${wait.label}需要人工验证 · 当前题目已暂停`;position();}});
  document.addEventListener('click',event=>{
    if(workspace.snapshot().status?.ai?.provider!=='api'||!event.target.closest('[data-action="openAI"],#webOpenAI,#webPagesAI'))return;
    event.preventDefault();event.stopImmediatePropagation();void desktop.webCommand({action:'hide'});workspace.openSettings('ai');details.open=true;$('apiBaseUrl').focus();
  },true);
}
