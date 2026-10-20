import {workspace} from './app.js';
const desktop=window.desktopApp;
if(desktop){
  const details=document.createElement('details');details.className='settings-details';details.id='apiSettings';
  details.innerHTML=`<summary>API 接口 <span>OpenAI 兼容</span></summary><div class="api-config-grid"><label>API 地址<input id="apiBaseUrl" type="url" placeholder="https://服务地址/v1" autocomplete="off"></label><label>模型名称<input id="apiModel" placeholder="支持图片输入的模型" autocomplete="off"></label><label>API 密钥<input id="apiKey" type="password" placeholder="留空保留已保存密钥" autocomplete="new-password"></label></div><p class="small">模型需要支持图片输入。密钥仅在本机加密保存；接口与测试请求按服务商规则计费。</p><div class="actions"><button id="apiSave">保存 API 配置</button><button id="apiTest">测试已保存配置</button></div><p id="apiMessage" role="status"></p>`;
  document.querySelector('#settingsForm').before(details);
  const $=id=>document.getElementById(id);
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
    event.preventDefault();event.stopImmediatePropagation();void desktop.webCommand({action:'hide'});workspace.navigate('settings');details.open=true;$('apiBaseUrl').focus();
  },true);
}
