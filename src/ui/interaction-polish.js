import { animate, motionEnabled } from './motion.js';
// Move existing controls with their listeners, rather than duplicate actions.
const tools=document.querySelector('#workspaceUtilities');
document.querySelector('#settingsUtilities').append(tools);
tools.open=true;
const appearance=document.querySelector('#settingsAppearanceTools');
const library=document.querySelector('#libraryTools');if(library)appearance.append(library);
const classic=document.querySelector('#toggleClassicUi');if(classic)appearance.append(classic);
// A single moving surface connects adjacent buttons instead of blinking backgrounds.
function slidingSurface(container,selector,selected) {
  if(!container)return;
  const marker=document.createElement('i');marker.className='moving-surface';marker.setAttribute('aria-hidden','true');container.prepend(marker);
  let animation,initialized=false;
  function move(target) {
    if(!target)return;
    const before=marker.getBoundingClientRect(),box=container.getBoundingClientRect(),next=target.getBoundingClientRect();
    animation?.cancel();
    marker.style.cssText=`left:${next.left-box.left+container.scrollLeft}px;top:${next.top-box.top+container.scrollTop}px;width:${next.width}px;height:${next.height}px;`;
    if(initialized&&motionEnabled())animation=marker.animate([{transform:`translate(${before.left-next.left}px,${before.top-next.top}px) scale(${before.width/next.width||1},${before.height/next.height||1})`},{transform:'none'}],{duration:260,easing:'cubic-bezier(.22,1,.36,1)'});
    initialized=true;
  }
  const reset=()=>move(container.querySelector(selected));
  container.classList.add('has-moving-surface');
  container.addEventListener('pointerover',e=>{if(e.pointerType!=='touch')move(e.target.closest(selector));});
  container.addEventListener('pointerleave',reset);
  container.addEventListener('click',()=>requestAnimationFrame(reset));
  const observer=new MutationObserver(()=>{if(!marker.isConnected)container.prepend(marker);reset();});
  observer.observe(container,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-pressed','aria-current']});
  new ResizeObserver(reset).observe(container);reset();
}
slidingSurface(document.querySelector('.tabs'),'.tab','.tab.active');
slidingSurface(document.querySelector('#platformFilters'),'button','button[aria-pressed=true]');
slidingSurface(document.querySelector('.course-view-switch'),'button','button[aria-pressed=true]');
// Visible press acknowledgement on primary operations, without delaying the request.
document.addEventListener('pointerdown',event=>{
  const button=event.target.closest('button:not(:disabled)');
  if(!button||!motionEnabled())return;
  animate(button,[{transform:'scale(1)'},{transform:'scale(.96)'},{transform:'scale(1)'}],{duration:240});
},true);
document.addEventListener('change',event=>{
  if(event.target.matches('input[type=checkbox]')) {
    const row=event.target.closest('.sd-task,.sd-course,.tprow');
    animate(row,[{opacity:.55},{opacity:1}],{duration:220});
  }
});
// Compact expandable settings share one response and one spacing language.
document.addEventListener('toggle',event=>{
  if(!event.target.open||!event.target.matches('details'))return;
  for(const child of event.target.children)if(child.tagName!=='SUMMARY')animate(child,[{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'none'}],{duration:220});
},true);
