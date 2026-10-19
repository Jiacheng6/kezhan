import {throwIfStopped,interruptibleSleep} from '../control.mjs';

// A document may share its card with a quiz and a video. Identify its actual
// attachment before touching the viewer or reading a completion marker.
export async function readDocumentAttachment(page,task){
 return page.evaluate(expected=>{
  const entries=[...document.querySelectorAll('.ans-attach-ct')].map((ct,index)=>{
   const frame=ct.querySelector('iframe');let meta={};try{meta=JSON.parse(frame?.getAttribute('data')||'{}');}catch{}
   return {ct,index,meta,src:frame?.getAttribute('src')||''};
  }).filter(e=>/modules\/(?:pdf|doc|read)(?:\/|\.)/.test(e.src));
  const matches=entries.filter(e=>expected.jobid?String(e.meta.jobid||'')===String(expected.jobid):expected.objectId?String(e.meta.objectid||'')===String(expected.objectId):expected.name&&[e.meta.name,e.meta.title].includes(expected.name));
  if(matches.length!==1)return {found:false,finished:null,via:'document-no-match',error:'没有找到唯一对应的阅读附件'};
  const {ct,index,meta}=matches[0],icon=ct.querySelector('.ans-job-icon'),aria=icon?.getAttribute('aria-label')||'';
  return {found:true,index,hasTracking:!!meta.jobid||!!icon,finished:ct.classList.contains('ans-job-finished')||/已完成/.test(aria),aria,via:'document-attach'};
 },{jobid:task.jobid,objectId:task.objectId,name:task.name});
}

const viewerState=frame=>frame.evaluate(()=>{
 const root=document.scrollingElement||document.documentElement;
 const images=[...document.querySelectorAll('.fileBox img, .pdfViewer img')];
 const first=images[0],rendered=!!document.querySelector('.fileBox img, .fileBox canvas, .pdfViewer .page, #viewer .page');
 return {top:root.scrollTop,height:root.scrollHeight,viewport:root.clientHeight,rendered,
  ready:rendered&&(!first||first.complete&&first.naturalWidth>0),bottom:root.scrollTop+root.clientHeight>=root.scrollHeight-20};
});

export async function openDocumentViewer(page,task,{shouldStop=()=>false,onProgress=()=>{},timeoutMs=25000}={}){
 const attachment=await readDocumentAttachment(page,task);
 if(!attachment.found)throw new Error(attachment.error);
 const element=await page.locator('.ans-attach-ct').nth(attachment.index).locator('iframe').first().elementHandle();
 let module;
 const deadline=Date.now()+timeoutMs;
 while(!module&&Date.now()<deadline){throwIfStopped(shouldStop);module=await element.contentFrame();if(!module)await interruptibleSleep(100,shouldStop);}
 if(!module)throw new Error('阅读附件页面未加载');
 // Use the platform's visible start control. Never invoke finishJob, forge a
 // completion message, or construct a task-credit request.
 const mask=module.locator('#maskLayer, .maskLayer').filter({visible:true});let started=false;
 let viewer;
 while(Date.now()<deadline){
  throwIfStopped(shouldStop);
  if(!started&&await mask.count()===1){await mask.click({timeout:5000});started=true;}
  for(const handle of await module.locator('#panView, #wpsView').elementHandles()){
   if(!await handle.isVisible())continue;
   const candidate=await handle.contentFrame();
   if(candidate&&(await viewerState(candidate).catch(()=>null))?.ready){viewer=candidate;break;}
  }
  if(!viewer&&(await viewerState(module).catch(()=>null))?.ready)viewer=module;
  if(viewer)break;
  await interruptibleSleep(200,shouldStop);
 }
 if(!viewer)throw new Error('阅读正文未加载或此预览暂不支持自动浏览，请在软件内查看网页');
 onProgress({phase:'浏览阅读正文'});
 const browseDeadline=Date.now()+60000;
 let steps=0,lastTop=-1,stalled=0,state;
 while(Date.now()<browseDeadline&&steps<200){
  throwIfStopped(shouldStop);state=await viewerState(viewer);
  if(!state.ready)throw new Error('阅读正文加载中断，未确认完成');
  if(state.bottom){await interruptibleSleep(600,shouldStop);return {opened:true,steps,viewerPath:new URL(viewer.url()).pathname};}
  if(state.top===lastTop)stalled++;else stalled=0;
  if(stalled>=4)throw new Error('阅读正文无法继续翻页，请在软件内查看网页');
  lastTop=state.top;
  // Scroll the real document rather than relying on keyboard focus: an
  // embedded page kept behind the workbench cannot reliably receive PageDown.
  // This produces the viewer's ordinary scroll event; its own completion
  // handler stays in charge, with no synthetic completion message.
  await viewer.evaluate(()=>{const root=document.scrollingElement||document.documentElement;root.scrollBy({top:Math.max(100,root.clientHeight*0.85),behavior:'instant'});});
  steps++;await interruptibleSleep(350,shouldStop);
 }
 throw new Error('阅读正文超出本次浏览范围，保留给人工继续；未伪报完成');
}
