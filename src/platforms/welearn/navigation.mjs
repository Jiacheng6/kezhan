import {throwIfStopped,interruptibleSleep} from '../../control.mjs';
import {readCourseIdentity} from './scan.mjs';
import {studyUrl,WELEARN_ORIGIN,platformId} from './policy.mjs';
const changed=()=>Object.assign(Error('WeLearn 实际课件与所选小节不一致，已停止，未回填或提交'),{code:'TASK_IDENTITY_CHANGED',retryable:false});
export async function lessonStamp(page,scoid){
  const selected=await page.evaluate(()=>({ids:[...document.querySelectorAll('li.courseware_current[id^="liSCO_"]')].map(e=>e.id.slice(6)),src:document.querySelector('iframe#contentFrame')?.src||''}));
  if(selected.ids.length!==1||selected.ids[0]!==scoid||!selected.src)return null;
  let origin;try{origin=new URL(selected.src).hostname;}catch{return null;}
  if(!/(^|\.)sflep\.com$/.test(origin))return null;
  return page.frames().some(f=>f.parentFrame()===page.mainFrame()&&f.url()===selected.src)?selected.src:null;
}
export async function assertNativeLesson(page,meta,scoid,stamp){
  const current=new URL(page.url());
  if(current.origin!==WELEARN_ORIGIN||current.searchParams.get('cid')!==meta.cid||current.searchParams.get('classid')!==meta.classid||current.searchParams.get('sco')!==scoid)throw changed();
  const actual=await lessonStamp(page,scoid);
  if(!actual||stamp&&actual!==stamp)throw changed();
  return actual;
}
export async function openNativeLesson(page,meta,scoid,{shouldStop,timeoutMs=20000}={}){
  platformId(scoid);throwIfStopped(shouldStop);
  // The official course-information page clears its own last-SCO navigation
  // state. Enter through that page so a reused tab cannot silently restore a
  // different lesson despite a correct ?sco= URL.
  const identity=await readCourseIdentity(page,meta.cid,{shouldStop});
  if(identity.uid!==meta.uid||identity.classid!==meta.classid)throw changed();
  await page.goto(studyUrl(meta,scoid),{waitUntil:'domcontentloaded',timeout:45000});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    throwIfStopped(shouldStop);
    const stamp=await lessonStamp(page,scoid);
    if(stamp)return assertNativeLesson(page,meta,scoid,stamp);
    if(new URL(page.url()).origin!==WELEARN_ORIGIN)throw Object.assign(Error('WeLearn 需要登录，原网页已保留'),{code:'AUTH_EXPIRED',retryable:false});
    await interruptibleSleep(200,shouldStop);
  }
  throw changed();
}
