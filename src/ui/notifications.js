import { workspace } from './app.js';
const app = window.desktopApp;
if (app?.notifications) {
  const entry = document.createElement('button'); entry.id='notificationEntry'; entry.className='web-pages-entry'; entry.setAttribute('aria-haspopup','dialog');
  document.querySelector('.header-right').prepend(entry);
  const banner = document.createElement('aside'); banner.id='notificationBanner'; banner.className='notification-banner'; banner.hidden=true; banner.setAttribute('role','status');
  const bannerText = document.createElement('span'), bannerAction = document.createElement('button'); bannerAction.textContent='查看并处理 →'; banner.append(bannerText,bannerAction);
  document.querySelector('.workspace > main').before(banner);
  const center = document.createElement('dialog'); center.id='notificationCenter'; center.className='desktop-dialog notification-dialog'; center.setAttribute('aria-labelledby','notificationTitle');
  center.innerHTML='<div class="dialog-heading"><span class="dialog-label">通知与待处理</span><button class="dialog-icon" aria-label="关闭通知列表">×</button></div><h2 id="notificationTitle">通知与待处理</h2><p class="notification-note">查看提醒不会自动继续学习或提交答案。</p><div class="notification-list"></div><p class="notification-note" data-delivery></p>';
  const prompt = document.createElement('dialog'); prompt.id='notificationPrompt'; prompt.className='desktop-dialog'; prompt.setAttribute('aria-labelledby','notificationPromptTitle'); prompt.setAttribute('aria-describedby','notificationPromptBody');
  prompt.innerHTML='<div class="dialog-heading"><span class="dialog-label">需要你处理</span></div><h2 id="notificationPromptTitle"></h2><p id="notificationPromptBody"></p><div class="dialog-footer"><button data-later>稍后处理</button><button class="notification-primary" data-handle>打开并处理 →</button></div>';
  document.body.append(center,prompt);
  let state={items:[],unread:0},visible=true,active=null;
  const shown=new Set();
  const openCenter=()=>{ if(!center.open)center.showModal(); };
  entry.onclick=openCenter;
  center.querySelector('.dialog-icon').onclick=()=>center.close();
  const later=()=>{prompt.close();document.dispatchEvent(new Event('assistant-notice-dismissed'));};
  prompt.querySelector('[data-later]').onclick=later;
  prompt.addEventListener('cancel',e=>{e.preventDefault();later();});
  prompt.querySelector('[data-handle]').onclick=()=>{const id=active?.id;later();if(id)void app.openNotification(id);};
  async function route(item) {
    center.close(); prompt.close();
    document.dispatchEvent(new Event('assistant-open-workspace'));
    try {
      if(item.action==='notices'){openCenter();return;}
      if(item.action==='zhihuishu'){
        const web=await app.webState();
        const isSite=tab=>{try{const u=new URL(tab.url);return u.protocol==='https:'&&(u.hostname==='zhihuishu.com'||u.hostname.endsWith('.zhihuishu.com'));}catch{return false;}};
        const existing=web.tabs.filter(isSite).find(tab=>['login.zhihuishu.com','passport.zhihuishu.com'].includes(new URL(tab.url).hostname))||web.tabs.filter(isSite).at(-1);
        if(existing)await app.webCommand({action:'select',id:existing.id});
        else await app.webCommand({action:'open-zhihuishu'});
      } else if(item.action==='ai'||item.action==='login'){
        const web=await app.webState();
        const provider=item.provider||workspace.snapshot().status?.settings?.ai?.provider||'qianwen';
        const hosts=item.action==='login'?['chaoxing.com']:({qianwen:['qianwen.com','tongyi.com'],doubao:['doubao.com'],deepseek:['chat.deepseek.com']})[provider]||[];
        const existing=web.tabs.find(tab=>{try{const u=new URL(tab.url);return u.protocol==='https:'&&hosts.some(host=>u.hostname===host||u.hostname.endsWith('.'+host));}catch{return false;}});
        if(existing)await app.webCommand({action:'select',id:existing.id});
        else await workspace.action(item.action==='ai'?'openAI':'openChaoxing');
      } else if(item.action==='updates')document.getElementById('desktopUpdate').click();
      else workspace.navigate(['review','logs','courses'].includes(item.action)?item.action:'logs');
    } catch(error) {banner.hidden=false;bannerText.textContent=`页面暂时无法打开：${error.message}`;}
    document.dispatchEvent(new Event('assistant-notice-dismissed'));
  }
  app.onNoticeOpen(item=>void route(item));
  function maybePrompt() {
    if(!visible||document.querySelector('dialog[open]')||document.documentElement.dataset.onboardingPending==='true')return;
    active=state.items.find(item=>item.urgent&&!item.read&&!shown.has(item.id));
    if(!active)return;
    shown.add(active.id);
    prompt.querySelector('h2').textContent=active.title;prompt.querySelector('p').textContent=active.body;
    prompt.showModal();
  }
  function render(next) {
    state=next;entry.textContent=`通知${state.unread?' · '+state.unread:''}`;
    const important=state.items.find(item=>!item.read&&item.urgent)||state.items.find(item=>!item.read);
    banner.hidden=!important;
    if(important){bannerText.textContent=important.title+' · '+important.body;bannerAction.onclick=()=>app.openNotification(important.id);}
    const list=center.querySelector('.notification-list');list.replaceChildren();
    if(!state.items.length){const p=document.createElement('p');p.textContent='暂时没有通知。';list.append(p);}
    for(const item of state.items){
      const row=document.createElement('article');row.className='notification-item';row.dataset.unread=String(!item.read);
      const heading=document.createElement('h3');heading.textContent=item.title;
      const time=document.createElement('time');time.textContent=new Date(item.at).toLocaleString('zh-CN',{hour12:false});
      const text=document.createElement('p');text.textContent=item.body;
      const actions=document.createElement('div');actions.className='notification-actions';
      const open=document.createElement('button');open.textContent='打开并处理 →';open.onclick=()=>app.openNotification(item.id);actions.append(open);
      if(!item.read){const read=document.createElement('button');read.textContent='标为已读';read.onclick=()=>app.readNotification(item.id);actions.append(read);}
      row.append(heading,time,text);
      if(item.detail){const detail=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');summary.textContent='查看详情';body.textContent=item.detail;detail.append(summary,body);row.append(detail);}
      row.append(actions);list.append(row);
    }
    center.querySelector('[data-delivery]').textContent=state.saveError?'通知历史保存失败，当前提醒仍保留在本次会话中。':state.nativeSupported?'系统弹窗遵循 Windows 通知与勿扰设置；未读提醒会保留在这里。':'Windows 原生通知当前不可用；未读提醒仍保留在这里。';
    document.dispatchEvent(new CustomEvent('assistant-notifications',{detail:{unread:state.unread}}));
    maybePrompt();
  }
  app.onNotifications(render);app.notifications().then(render).catch(()=>{});
  app.onVisibility(value=>{visible=value;if(value)maybePrompt();});
  document.addEventListener('open-assistant-notifications',openCenter);
  for(const event of ['desktop-close-dismissed','onboarding-dismissed'])document.addEventListener(event,maybePrompt);
  document.getElementById('desktopUpdatePanel')?.addEventListener('close',maybePrompt);
}
