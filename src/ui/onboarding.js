import {workspace} from './app.js';
import {PLATFORMS,PLATFORM_DESCRIPTIONS,enabledPlatformIds,platformBusy} from './platforms.js';
import {animate} from './motion.js';
import {openBankSetup} from './bank-guide.js';
document.documentElement.dataset.onboardingPending='true';
const dialog=document.createElement('dialog');dialog.id='onboardingPanel';dialog.className='desktop-dialog onboarding-dialog';
const tile=(id,info)=>`<label class="platform-choice" data-platform="${id}"><input type="checkbox" name="onboardingPlatform" value="${id}"><span class="platform-monogram" aria-hidden="true">${info.short}</span><span class="platform-choice-copy"><b>${info.name}</b><small>${PLATFORM_DESCRIPTIONS[id]}</small></span><span class="platform-choice-check" aria-hidden="true">✓</span></label>`;
dialog.innerHTML=`<div class="dialog-heading"><span class="dialog-label">课栈 · 开始之前</span><button id="onboardingLater" class="onboarding-later" aria-label="稍后设置，关闭向导">稍后设置 <span aria-hidden="true">×</span></button></div>
 <ol class="onboarding-steps" aria-label="设置步骤"><li data-step="platforms"><i>1</i>选择平台</li><li data-step="login"><i>2</i>连接账号</li><li data-step="ai"><i>3</i>答题方式</li></ol>
 <div class="onboarding-content"><section id="onboardingPlatforms" class="onboarding-section"><span class="onboarding-eyebrow">只留下你需要的</span><h2 id="onboardingTitle" tabindex="-1">你在哪些平台学习？</h2><p class="onboarding-description">可多选。选课、档案和工作台只显示已开启的平台。</p><div id="onboardingPlatformChoices" class="platform-choice-grid">${Object.entries(PLATFORMS).map(([id,info])=>tile(id,info)).join('')}</div><p class="onboarding-note">之后可在「偏好设置 → 学习平台」随时调整，课程与进度会保留。</p></section>
 <section id="onboardingLogin" class="onboarding-section" hidden><span class="onboarding-eyebrow">账号留在你的电脑里</span><h2 id="onboardingLoginTitle" tabindex="-1">连接你的学习平台</h2><p class="onboarding-description">在软件内登录。也可以稍后再连，准备好时再扫描课程。</p><div id="onboardingConnections"></div><div class="onboarding-actions"><button id="onboardingCheckLogin">检测学习通登录</button></div><p id="onboardingLoginStatus" class="onboarding-note" role="status"></p></section>
 <section id="onboardingAI" class="onboarding-section" hidden><span class="onboarding-eyebrow">按你的学习方式来</span><h2 id="onboardingAITitle" tabindex="-1">需要 AI 辅助答题吗？</h2><p class="onboarding-description">视频学习无需 AI。WeLearn 使用课件解析，也不需要 AI 账号。</p><label class="onboarding-ai-toggle"><input id="onboardingAIWanted" type="checkbox"><span><b>现在配置 AI 辅助</b><small>学习通、智慧树和 U校园 的答题辅助</small></span></label><div id="onboardingAIOptions" hidden><fieldset class="onboarding-providers"><legend class="sr-only">做题 AI</legend>${[['qianwen','千问','网页版'],['doubao','豆包','网页版'],['deepseek','DeepSeek','网页版'],['api','API','自备密钥']].map(([id,name,kind])=>`<label><input type="radio" name="onboardingProvider" value="${id}" ${id==='qianwen'?'checked':''}><span><b>${name}</b><small>${kind}</small></span></label>`).join('')}</fieldset><p id="onboardingAIStatus" class="onboarding-note" role="status"></p><div class="onboarding-actions"><button id="onboardingOpenAI">打开 AI 登录 ↗</button><button id="onboardingCheckAI">检测 AI 连接</button></div></div></section></div>
 <p id="onboardingError" role="alert"></p><div class="dialog-footer"><span id="onboardingStep" class="onboarding-step-count">1 / 3</span><div class="onboarding-actions"><button id="onboardingBack" hidden>上一步</button><button id="onboardingNext" class="onboarding-primary">继续 →</button></div></div>`;
document.body.append(dialog);
const $=id=>document.getElementById(id),names={qianwen:'千问',doubao:'豆包',deepseek:'DeepSeek',api:'API'};
const bank=document.createElement('section');bank.id='onboardingBank';bank.className='onboarding-bank';bank.innerHTML='<div class="onboarding-bank-heading"><span class="platform-monogram" aria-hidden="true">题</span><div><b>学习通题库</b><small>微信扫码开通，令牌自动导入</small></div><span id="onboardingBankState" class="bank-state">尚未开通</span></div><p>先查题库可减少 AI 等待。额度以题库账户页为准，可随时查看余额和充值。</p><div class="onboarding-bank-actions"><label>答题来源<select id="onboardingAnswerSource"><option value="bank">题库优先</option><option value="ai">只用 AI</option></select></label><button type="button" id="onboardingOpenBank">扫码开通 / 查看账户 →</button></div><p id="onboardingBankQuota" role="status" class="onboarding-note">可跳过，稍后在答题与题库设置中开通。</p>';$('onboardingAIWanted').closest('label').before(bank);
let bankConfigured=false,bankQuota={kind:'unknown'};
async function refreshBank(){try{if(window.desktopApp?.bankStatus){bankConfigured=!!(await window.desktopApp.bankStatus()).configured;bankQuota=await window.desktopApp.bankQuota(false);}renderBank();}catch{$('onboardingBankQuota').textContent='暂时无法读取题库状态，可稍后在设置中检查。';}}
function renderBank(){$('onboardingBankState').textContent=bankConfigured?'已配置令牌':'尚未开通';$('onboardingBankQuota').textContent=bankConfigured?(bankQuota?.kind==='known'?`剩余 ${Number(bankQuota.left).toLocaleString('zh-CN')} 次${bankQuota.left<=10?' · 额度偏低，可去账户页充值':''}`:'令牌已保存，可在题库向导中刷新额度。'):'可跳过，稍后在答题与题库设置中开通。';}
let status=workspace.snapshot().status||{},step=0,busy=false,paused=false,autoPending=false,record={};
const chosen=()=>[...dialog.querySelectorAll('input[name="onboardingPlatform"]:checked')].map(e=>e.value);
const provider=()=>dialog.querySelector('input[name="onboardingProvider"]:checked').value;
const flows=()=>chosen().some(id=>id!=='welearn')?['platforms','login','ai']:['platforms','login'];
const blocked=()=>Object.keys(PLATFORMS).some(id=>platformBusy(status,id));
const browserReady=()=>status.edge?.connected&&(status.ready||status.browserMode==='embedded');
const actionFor={chaoxing:'openChaoxing',zhihuishu:null,ucampus:'openUcampus',welearn:'openWelearn'};
async function api(url,body){const response=await fetch(url,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok||data.ok===false||data.result?.ok===false)throw Error(data.error||data.result?.error||'操作未完成，请重试');return data;}
function connections(){const ids=chosen();$('onboardingConnections').replaceChildren(...ids.map(id=>{const row=document.createElement('div');row.className='onboarding-connection';row.dataset.platform=id;row.innerHTML=`<span class="platform-monogram" aria-hidden="true">${PLATFORMS[id].short}</span><div><b>${PLATFORMS[id].name}</b><small>${id==='welearn'?'课件解析 · 无需 AI':id==='chaoxing'&&status.login?.loggedIn?'账号已连接':'在软件内登录后扫描课程'}</small></div><button type="button" data-open-platform="${id}">打开登录 ↗</button>`;return row;}));}
function render(){
 const flow=flows();step=Math.min(step,flow.length-1);const key=flow[step],heading={platforms:'onboardingTitle',login:'onboardingLoginTitle',ai:'onboardingAITitle'}[key];
 $('onboardingPlatforms').hidden=key!=='platforms';$('onboardingLogin').hidden=key!=='login';$('onboardingAI').hidden=key!=='ai';dialog.setAttribute('aria-labelledby',heading);
 const hasBank=chosen().includes('chaoxing');bank.hidden=!hasBank;$('onboardingAITitle').textContent=hasBank?'题库与 AI，按需设置':'需要 AI 辅助答题吗？';
 for(const item of dialog.querySelectorAll('[data-step]')){item.hidden=!flow.includes(item.dataset.step);item.setAttribute('aria-current',item.dataset.step===key?'step':'false');item.classList.toggle('completed',flow.indexOf(item.dataset.step)<step);}
 $('onboardingStep').textContent=`${step+1} / ${flow.length}`;$('onboardingBack').hidden=!step;
 $('onboardingNext').textContent=busy?'正在保存…':step===flow.length-1?'进入选课 →':'继续 →';
 $('onboardingAIOptions').hidden=!$('onboardingAIWanted').checked;
 const ready=status.ai?.provider===provider()&&status.ai.loggedIn;
 $('onboardingAIStatus').textContent=ready?`${names[provider()]}已就绪`:provider()==='api'?'可稍后在偏好设置中填写地址、密钥和模型':'可在软件内登录，也可以以后再配置。';
 $('onboardingOpenAI').textContent=provider()==='api'?'前往 API 配置 →':'打开 AI 登录 ↗';
 $('onboardingCheckLogin').hidden=!chosen().includes('chaoxing');$('onboardingLoginStatus').textContent=chosen().includes('chaoxing')&&status.login?.loggedIn?'学习通已连接。其余平台在扫描课程时核对登录。':'';
 for(const e of dialog.querySelectorAll('button,input,select'))e.disabled=busy||blocked();
 $('onboardingLater').disabled=busy;$('onboardingNext').disabled=busy||blocked()||!chosen().length;
 for(const button of dialog.querySelectorAll('[data-open-platform],#onboardingCheckLogin,#onboardingOpenAI,#onboardingCheckAI'))button.disabled=busy||blocked()||!browserReady();
 if(blocked())$('onboardingError').textContent='请先停止任务或等待扫描完成，再修改接入设置。';
}
function dismiss(){paused=false;dialog.close();document.documentElement.dataset.onboardingPending='false';document.dispatchEvent(new Event('onboarding-dismissed'));}
function focusStep(){const id={platforms:'onboardingTitle',login:'onboardingLoginTitle',ai:'onboardingAITitle'}[flows()[step]];$(id).focus();animate($(id).closest('section'),[{opacity:.4,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:220});}
function open(){if(dialog.open)return;step=0;$('onboardingError').textContent='';const configured=record.completedAt||record.migrated||record.platforms?.length||Object.values(status.settings?.platforms||{}).some(value=>value===false);const ids=configured?enabledPlatformIds(status.settings):[];for(const input of dialog.querySelectorAll('input[name="onboardingPlatform"]'))input.checked=ids.includes(input.value);for(const input of dialog.querySelectorAll('input[name="onboardingProvider"]'))input.checked=input.value===(status.settings?.ai?.provider||'qianwen');$('onboardingAIWanted').checked=record.aiWanted===true;$('onboardingAnswerSource').value=status.settings?.answerBank?.source||'bank';void refreshBank();connections();render();document.documentElement.dataset.onboardingPending='true';dialog.showModal();focusStep();}
async function run(fn){if(busy)return;busy=true;$('onboardingError').textContent='';render();try{await fn();}catch(error){$('onboardingError').textContent=error.message;}finally{busy=false;render();}}
async function refresh(){status=await api('/api/status');render();}
async function action(name){await api('/api/action/'+name,{});await refresh();}
async function savePlatforms(){const ids=chosen();await api('/api/settings',{patch:Object.fromEntries(Object.keys(PLATFORMS).map(id=>['platforms.'+id,ids.includes(id)]))});record.platforms=ids;await refresh();}
async function saveProvider(){await api('/api/settings',{patch:{'ai.provider':provider()}});await refresh();}
dialog.addEventListener('change',()=>{$('onboardingError').textContent='';connections();render();});
$('onboardingConnections').onclick=event=>{const button=event.target.closest('[data-open-platform]');if(!button)return;run(async()=>{const id=button.dataset.openPlatform;if(id==='zhihuishu'){await window.desktopApp.webCommand({action:'open-zhihuishu'});}else await action(actionFor[id]);});};
$('onboardingCheckLogin').onclick=()=>run(async()=>{await action('refreshLogin');if(!status.login?.loggedIn)throw Error('尚未检测到学习通登录，可在网页完成登录后再检测，也可以稍后连接。');});
$('onboardingOpenAI').onclick=()=>run(async()=>{await saveProvider();if(provider()==='api'){dismiss();workspace.openSettings('ai');}else await action('openAI');});
$('onboardingCheckAI').onclick=()=>run(async()=>{await saveProvider();await action('checkQianwen');if(!status.ai?.loggedIn)throw Error('尚未检测到 AI 登录，可稍后配置。');});
$('onboardingNext').onclick=()=>run(async()=>{if(step===0)await savePlatforms();if(step<flows().length-1){step++;connections();render();focusStep();return;}if(chosen().includes('chaoxing'))await api('/api/settings',{patch:{'answerBank.source':$('onboardingAnswerSource').value}});const aiWanted=$('onboardingAIWanted').checked&&chosen().some(id=>id!=='welearn');if(aiWanted)await saveProvider();const response=await api('/api/onboarding',{action:'complete',platforms:chosen(),aiWanted,provider:aiWanted?provider():undefined});record=response.result;await refresh();document.dispatchEvent(new Event('assistant-open-workspace'));workspace.navigate('courses');dismiss();});
$('onboardingOpenBank').onclick=async()=>{if(busy||blocked())return;dialog.close();try{await openBankSetup();}finally{await refreshBank();if(!dialog.open&&!paused){render();dialog.showModal();focusStep();}}};
document.addEventListener('bank-credential-saved',event=>{bankConfigured=!!event.detail?.configured;renderBank();});
window.desktopApp?.onBankQuota?.(quota=>{bankQuota=quota;renderBank();});
$('onboardingBack').onclick=()=>{step=Math.max(0,step-1);$('onboardingError').textContent='';render();focusStep();};$('onboardingLater').onclick=dismiss;
dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)dismiss();});$('reopenOnboarding').addEventListener('click',open);
document.addEventListener('embedded-browser-show',()=>{if(dialog.open){paused=true;dialog.close();document.dispatchEvent(new Event('onboarding-paused'));}});
document.addEventListener('embedded-browser-hide',()=>{if(paused){paused=false;connections();render();dialog.showModal();focusStep();}});
workspace.subscribe(snapshot=>{status=snapshot.status||{};if(dialog.open)render();});
function maybeOpen(){if(!autoPending||$('desktopClosePanel')?.open||$('desktopUpdatePanel')?.open)return;autoPending=false;open();}
document.addEventListener('desktop-close-dismissed',maybeOpen);$('desktopUpdatePanel')?.addEventListener('close',maybeOpen);
try{record=(await api('/api/onboarding')).result;autoPending=!record.completedAt&&!blocked();if(autoPending)maybeOpen();else document.documentElement.dataset.onboardingPending='false';}catch(error){document.documentElement.dataset.onboardingPending='false';console.warn('向导读取失败',error);}finally{if(!autoPending&&!dialog.open)document.dispatchEvent(new Event('onboarding-dismissed'));}
