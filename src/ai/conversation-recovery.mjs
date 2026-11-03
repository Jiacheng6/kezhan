import {throwIfStopped,interruptibleSleep,waitForRead} from '../control.mjs';
import {durableWebConversation} from './web-draft.mjs';
import {webRequestMarker} from './web-turn.mjs';

export function hasConversationMarker(marker){
 return [...document.querySelectorAll('[data-testid="send_message"]')].some(node=>(node.textContent||'').includes(marker));
}
function hasDraft(){
 const editor=[...document.querySelectorAll('[data-testid="chat_input"] .tiptap,[data-testid="chat_input"] textarea')].find(e=>e.getClientRects().length);
 const composer=editor?.closest('[data-testid="chat_input"]');
 const visible=e=>!!e.getClientRects().length&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 return !!(editor?.value??editor?.innerText??'').trim()||!![...(composer?.querySelectorAll('img')||[])].find(e=>e.getClientRects().length&&(e.getAttribute('src')||'').startsWith('blob:'))
  ||[...document.querySelectorAll('[data-testid="chat_input_stop_button"],[data-testid="stop_button"],button[aria-label*="停止"],[data-streaming="true"]')].some(visible);
}

// Read only existing, rendered history links. No account API, new question,
// answer-position inference, or guessed conversation ID is used for recovery.
export async function recoverWebConversation(page,draft,{shouldStop,maxCandidates=6,hydrateMs=2500,onProgress=()=>{}}={}){
 const marker=webRequestMarker(draft?.prompt||'');if(!marker)return {ok:false,reason:'missing-marker'};
 const original=page.url(),current=durableWebConversation(original);
 const read=operation=>waitForRead(operation,{shouldStop,timeoutMs:10000,message:'豆包原对话读取超时'});
 const navigate=url=>waitForRead(()=>page.goto(url,{waitUntil:'domcontentloaded',timeout:15000}),{shouldStop,timeoutMs:15000,message:'豆包原对话打开超时'});
 const matches=()=>read(()=>page.evaluate(hasConversationMarker,marker));
 throwIfStopped(shouldStop);
 if(current&&await matches())return {ok:true,url:current,inspected:0};
 const historyLinks=()=>read(()=>page.evaluate(()=>[...new Set([...document.querySelectorAll('a[href]')].map(a=>{
  try{const u=new URL(a.getAttribute('href'),location.href);return u.origin===location.origin&&/^\/chat\/\d+\/?$/.test(u.pathname)&&!u.search&&!u.hash?u.href:'';}catch{return '';}
 }).filter(Boolean))]));
 let candidates=await historyLinks();const historyUntil=Date.now()+Math.max(1000,hydrateMs);
 while(!candidates.length&&Date.now()<historyUntil){throwIfStopped(shouldStop);await interruptibleSleep(150,shouldStop);candidates=await historyLinks();}
 let inspected=0;
 for(const url of candidates.filter(url=>durableWebConversation(url)).slice(0,Math.max(0,Math.min(8,maxCandidates)))){
  throwIfStopped(shouldStop);if(await read(()=>page.evaluate(hasDraft)))return {ok:false,reason:'draft-present',inspected};inspected++;onProgress(inspected);
  await navigate(url);
  const until=Date.now()+hydrateMs;
  do{
   throwIfStopped(shouldStop);
   const valid=durableWebConversation(page.url());
   if(valid&&new URL(valid).origin===new URL(original).origin&&await matches())return {ok:true,url:valid,inspected};
   await interruptibleSleep(150,shouldStop);
  }while(Date.now()<until);
 }
 throwIfStopped(shouldStop);
 if(await read(()=>page.evaluate(hasDraft)))return {ok:false,reason:'draft-present',inspected};
 if(page.url()!==original)await navigate(original);
 return {ok:false,reason:'marker-not-found',inspected};
}
