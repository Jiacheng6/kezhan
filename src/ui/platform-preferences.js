import {workspace} from './app.js';
import {PLATFORMS,PLATFORM_DESCRIPTIONS,platformEnabled,platformBusy,enabledPlatformIds} from './platforms.js';
const root=document.getElementById('platformPreferences'),message=document.getElementById('platformPreferenceMessage');
let model=workspace.snapshot(),pending=new Set();
const workMenu=document.createElement('details');workMenu.className='course-work-menu';workMenu.id='courseWorkMenu';workMenu.innerHTML='<summary>独立作业 ⌄</summary>';workMenu.append(document.getElementById('bankWorkStrip'));document.querySelector('.course-toolbar').insertBefore(workMenu,document.querySelector('.course-toolbar .inline-menu'));
for(const [id,info]of Object.entries(PLATFORMS)){
 const label=document.createElement('label');label.className='platform-choice platform-preference';label.dataset.platform=id;
 label.innerHTML=`<input type="checkbox" data-platform-setting="${id}" aria-label="启用${info.name}"><span class="platform-monogram" aria-hidden="true">${info.short}</span><span class="platform-choice-copy"><b>${info.name}</b><small>${PLATFORM_DESCRIPTIONS[id]}</small><em class="platform-choice-status"></em></span><span class="platform-toggle" aria-hidden="true"></span>`;
 const input=label.querySelector('input');input.onchange=async()=>{pending.add(id);render();try{const response=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({patch:{['platforms.'+id]:input.checked}})}),result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'开关未保存');message.textContent=`${info.name}${input.checked?'已开启':'已关闭'}，课程与进度保留。`;const status=await fetch('/api/status').then(r=>r.json());document.dispatchEvent(new CustomEvent('platform-preferences-saved',{detail:status}));}catch(error){message.textContent=error.message;}finally{pending.delete(id);render();}};
 root.append(label);
}
function render(){for(const label of root.children){const id=label.dataset.platform,input=label.querySelector('input'),enabled=platformEnabled(model.status?.settings,id),busy=platformBusy(model.status,id);if(!pending.has(id))input.checked=enabled;input.disabled=pending.has(id)||busy;label.querySelector('.platform-choice-status').textContent=pending.has(id)?'正在保存…':busy?'运行中，请先停止':enabled?'已开启':'已关闭';}}
workspace.subscribe(snapshot=>{model=snapshot;render();});
// Existing action buttons keep their handlers; preference only controls which
// platforms are offered. The service independently enforces the same scope.
workspace.subscribe(({status})=>{
 const settings=status?.settings;
 document.getElementById('bankWorkStrip').hidden=!platformEnabled(settings,'chaoxing');
 workMenu.hidden=!platformEnabled(settings,'chaoxing');
 document.getElementById('pillLogin').hidden=!platformEnabled(settings,'chaoxing');
 document.getElementById('pillQuiz').hidden=!enabledPlatformIds(settings).some(id=>id!=='welearn');
 for(const [id,actions]of Object.entries({chaoxing:['openChaoxing','refreshLogin','startRecon','startStandaloneWork']}))for(const action of actions)for(const button of document.querySelectorAll(`[data-action="${action}"]`)){if(button.id==='overviewStart')continue;button.hidden=!platformEnabled(settings,id);}
 const ids=enabledPlatformIds(settings),host=document.querySelector('.course-toolbar .inline-menu>div');
 if(host&&host.dataset.platforms!==ids.join(',')){host.dataset.platforms=ids.join(',');host.replaceChildren();const scans={chaoxing:'startRecon',zhihuishu:'readZhihuishu',ucampus:'readUcampus',welearn:'readWelearn'};for(const id of ids){const button=document.createElement('button');button.textContent=`扫描${PLATFORMS[id].name}课程`;button.onclick=()=>workspace.action(scans[id],button);host.append(button);}const button=document.createElement('button');button.textContent='管理学习平台 →';button.onclick=()=>workspace.openSettings('platforms');host.append(button);}
});
