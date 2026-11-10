// A page can contain several video modules. Playback, popup detection and
// progress checks must keep the same task-local module for their whole run.
const selectedVideos=new WeakMap();
export function bindVideoFrame(page,frame){selectedVideos.set(page,frame);}
export function selectedVideoFrame(page){
  if(!selectedVideos.has(page))return undefined;
  const frame=selectedVideos.get(page);return frame.isDetached()?null:frame;
}
export async function videoFrameMatches(frame,task={}){
  const el=await frame.frameElement();
  try{return await el.evaluate((e,t)=>{
    let meta;try{meta=JSON.parse(e.getAttribute('data')||'{}');}catch{return false;}
    const p=meta.property||meta;
    if(t.objectId||t.objectid)return String(p.objectid||meta.objectid||'')===String(t.objectId||t.objectid);
    if(t.jobid&&String(p.jobid||meta.jobid||'')===String(t.jobid))return true;
    return !!t.name&&String(p.name||meta.name||'').trim()===String(t.name).trim();
  },task);}finally{await el.dispose();}
}
export async function findTaskVideoFrame(page,task){
  const frames=page.frames().filter(f=>/\/ananas\/modules\/video\//.test(f.url()));
  const hits=[];for(const f of frames)if(await videoFrameMatches(f,task).catch(()=>false))hits.push(f);
  if(hits.length===1)return hits[0];
  if(!hits.length&&frames.length===1){const f=frames[0];const el=await f.frameElement();try{const meta=await el.getAttribute('data');if(!meta)return f;}finally{await el.dispose();}}
  return null;
}
