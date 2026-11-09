import {getCmi} from './vendor/auto-welearn/core/api/sco.mjs';
// The official native host uses its default CMI when ret=0/comment="".
// Upstream handles ret=-1/uninitialized, but not this equivalent empty form.
export async function readWelearnCmi(session,meta,options={}){
  let raw;
  const reader={...session,postForm:async(...args)=>{const response=await session.postForm(...args);if(args[1]?.action==='getscoinfo_v7')raw=response.text;return response;}};
  const result=await getCmi(reader,meta,options);if(result.ok||result.reason!=='unavailable')return result;
  try{const data=JSON.parse(raw);if(data.ret===0&&data.comment==='')return {ok:false,reason:'uninitialized'};}catch{}
  return result;
}
