import {newTaskPage,releasePage,setPageBusy} from '../../browser/pages.mjs';
import {loadState,mutateState,setTaskStatus} from '../../state.mjs';
import {loadSettings} from '../../config.mjs';
import {throwIfStopped,interruptibleSleep} from '../../control.mjs';
import {readCourseIdentity} from './scan.mjs';
import {readLessons} from './api.mjs';
import {courseIdentity,studyUrl,WELEARN_ORIGIN} from './policy.mjs';
import {readPractice,assistPractice} from './practice.mjs';
import {openNativeLesson,assertNativeLesson} from './navigation.mjs';
export async function readNativeState(page){
  const states=[];
  for(const frame of page.frames()){
    let host='';try{host=new URL(frame.url()).hostname;}catch{}
    if(!/(^|\.)sflep\.com$/.test(host))continue;
    const state=await frame.evaluate(()=>{
      const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
      const dialogs=[...document.querySelectorAll('[role="dialog"],.modal.show,.layui-layer')].filter(visible).map(e=>e.innerText||'').join(' ');
      const blockers=/验证码|人机验证|安全验证|captcha/i.test(dialogs)?'页面需要本人验证':/承诺书|诚信承诺|隐私政策/.test(dialogs)?'页面需要本人阅读并确认':null;
      const media=[...document.querySelectorAll('video,audio')].map((m,index)=>({m,index})).filter(({m})=>visible(m)||visible(m.closest('.video-js,et-audio,et-video,.mejs-container')))
        .map(({m,index})=>({index,currentTime:m.currentTime,duration:Number.isFinite(m.duration)?m.duration:0,paused:m.paused,ended:m.ended}));
      const actions=[...document.querySelectorAll('button,a,input[type="button"],input[type="submit"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true')
        .map((e,index)=>({index,text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim()}));
      const confirmations=[...document.querySelectorAll('[role="dialog"],.modal.show,.layui-layer')].filter(visible).filter(e=>/是否.*提交|确认提交|确认.*提交|confirm.*submit/i.test(e.innerText||''))
        .map(e=>({text:e.innerText,buttons:[...e.querySelectorAll('button,input[type="button"]')].filter(visible).map(b=>(b.innerText||b.value||'').trim())}));
      return {blockers,media,actions,confirmations};
    }).catch(()=>null);
    if(state)states.push({frame,...state});
  }
  return states;
}
const keptTaskPages=new WeakMap();
export async function runWelearnTask({task,context,shouldStop=()=>false,onProgress=()=>{}},{ask,settings=loadSettings,readStatus=readLessons,pollMs=1500,statusEveryMs=5000,confirmTimeoutMs=20000,maxMs=45*60*1000}={}){
  const ctx=typeof context==='function'?context():context,meta=courseIdentity(task.welearn||{}),scoid=String(task.welearn.scoid||''),url=studyUrl(meta,scoid);
  if(!keptTaskPages.has(ctx))keptTaskPages.set(ctx,new Map());
  const pages=keptTaskPages.get(ctx);let page=pages.get(task.key);
  if(!page||page.isClosed())page=await newTaskPage(ctx,'task');else setPageBusy(page,true);
  let check;
  let keep=false,completed=false,stopped=false,result;
  const drafts=structuredClone(loadState().welearnDrafts?.[task.key]||{});
  const save=value=>mutateState(s=>{s.welearnDrafts||={};s.welearnDrafts[task.key]=value;});
  const finish=(phase,extra={})=>({ok:phase==='done'||phase==='already-finished',phase,...extra});
  try{
    check=await newTaskPage(ctx,'view-status');
    const actual=await readCourseIdentity(check,meta.cid,{shouldStop});
    if(actual.uid!==meta.uid||actual.classid!==meta.classid)throw Object.assign(Error('WeLearn 账号或班级身份改变，请重新扫描，未启动任务'),{code:'TASK_IDENTITY_CHANGED',retryable:false});
    const status=async()=>{const list=await readStatus(check,meta,task.welearn.unitIndex,{shouldStop}),hits=list.filter(x=>x.scoid===scoid);if(hits.length!==1)throw Object.assign(Error('WeLearn 原小节无法唯一核对，请重新扫描'),{code:'TASK_IDENTITY_CHANGED',retryable:false});return hits[0];};
    if((await status()).finished){completed=true;return finish('already-finished');}
    setTaskStatus(task.key,{status:'running',platform:'welearn'});
    let stamp;
    try{stamp=page.url()===url?await assertNativeLesson(page,meta,scoid):null;}catch{}
    if(!stamp)stamp=await openNativeLesson(page,meta,scoid,{shouldStop});
    const checkIdentity=()=>assertNativeLesson(page,meta,scoid,stamp);
    const start=Date.now();let lastCheck=0,submissionPending=loadState().taskPoints?.[task.key]?.submissionPending===true;
    const clicked=new Set();let submittedAt=null,confirmationClicked=false;
    while(Date.now()-start<maxMs){
      throwIfStopped(shouldStop);
      const current=new URL(page.url());
      if(current.origin!==WELEARN_ORIGIN||/login|passport|signin/i.test(current.pathname))return result=finish('needs-human',{retryable:false,error:'WeLearn 需要登录或处理页面验证，原网页已保留'});
      if(current.searchParams.get('cid')!==meta.cid||current.searchParams.get('sco')!==scoid||current.searchParams.get('classid')!==meta.classid)throw Object.assign(Error('WeLearn 课程或小节身份变化，已停止操作'),{code:'TASK_IDENTITY_CHANGED',retryable:false});
      await checkIdentity();
      if(Date.now()-lastCheck>=statusEveryMs){lastCheck=Date.now();onProgress({phase:'verifying',taskType:'study'});if((await status()).finished){completed=true;return finish('done');}}
      const states=await readNativeState(page);
      for(const state of states){
        if(state.blockers)return result=finish('needs-human',{retryable:false,error:'WeLearn '+state.blockers+'，请处理后重新开始；已保存答案保留'});
        if(submissionPending){
          if(submittedAt&&settings().submitMode==='auto'&&!confirmationClicked&&state.confirmations.length===1){
            const dialog=state.frame.locator('[role="dialog"],.modal.show,.layui-layer').filter({visible:true}).filter({hasText:/是否.*提交|确认提交|确认.*提交|confirm.*submit/i});
            const confirm=dialog.getByRole('button',{name:/^(?:确定|确认|确认提交|提交|OK|Submit|Confirm)$/i});
            if(await dialog.count()===1&&await confirm.count()===1){throwIfStopped(shouldStop);confirmationClicked=true;await confirm.click();}
          }
          continue;
        }
        const medium=state.media.find(m=>!m.ended);
        if(medium&&!submissionPending){
          onProgress({phase:'playing',taskType:'video',percent:medium.duration?medium.currentTime/medium.duration:null,currentTime:medium.currentTime,duration:medium.duration,paused:medium.paused,playbackRate:1});
          if(medium.paused){throwIfStopped(shouldStop);await state.frame.locator('video,audio').nth(medium.index).evaluate(m=>{m.playbackRate=1;return m.play();}).catch(()=>{});}
          continue;
        }
        const questions=await readPractice(state.frame);
        if(questions.length){
          onProgress({phase:'asking',taskType:'work',questionIndex:0,questionTotal:questions.length});
          if(!ask)return result=finish('needs-human',{retryable:false,error:'WeLearn 练习需要 AI 辅助或本人作答，请先设置 AI'});
          const answer=await assistPractice(page,state.frame,questions,{ask,saved:drafts,save,shouldStop,checkIdentity});
          if(!answer.ok)return result=finish('needs-human',{retryable:false,...answer});
          if(answer.requiresReview||settings().submitMode!=='auto')return result=finish('needs-human',{retryable:false,error:'WeLearn 练习已回填'+(answer.requiresReview?'（含填空草稿）':'')+'，请在原网页核对并提交；平台确认前不计完成'});
          const action=state.actions.find(a=>/^(?:检查答案|核对答案|Check(?: answers)?|提交|Submit|确定|确认提交|下一页|下一步|Next|Continue)$/i.test(a.text));
          const signature=questions.map(q=>q.signature).join('|')+action?.text;
          if(action&&!clicked.has(signature)){
            throwIfStopped(shouldStop);await checkIdentity();
            const exact=new RegExp('^'+action.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i');
            const matching=state.frame.getByRole('button',{name:exact}).or(state.frame.locator('a').filter({hasText:exact})).filter({visible:true});
            if(await matching.count()!==1)return result=finish('needs-human',{retryable:false,error:'WeLearn 练习按钮无法唯一定位，请在原网页继续'});
            // A final submit is never retried on an ambiguous acknowledgement.
            if(/提交|Submit/i.test(action.text)){submissionPending=true;submittedAt=Date.now();setTaskStatus(task.key,{submissionPending:true});}
            clicked.add(signature);await matching.click();
          }
        }
      }
      if(submissionPending&&(!submittedAt||Date.now()-submittedAt>=confirmTimeoutMs))return result=finish('needs-human',{retryable:false,submissionPending:true,error:'WeLearn 提交结果尚未确认，请核对原网页，未重复提交'});
      await interruptibleSleep(pollMs,shouldStop);
    }
    return result=finish('needs-human',{retryable:false,error:'WeLearn 平台尚未确认本小节完成，请核对原网页；不计为完成'});
  }catch(error){if(error.code==='STOPPED'){stopped=true;return finish('stopped');}throw error;}
  finally{
    // Stop only this task's own media, and let the native player save normally.
    for(const frame of page.frames())await frame.evaluate(()=>document.querySelectorAll('video,audio').forEach(m=>m.pause())).catch(()=>{});
    keep=!completed&&!stopped&&page.url()!=='about:blank';
    setTaskStatus(task.key,{status:completed?'done':stopped?'pending':'manual',platform:'welearn',progress:completed?1:undefined,note:completed?'WeLearn 原小节已确认完成':stopped?'已停止，保留原进度':result?.error||'需要核对原网页',...(completed?{submissionPending:false}: {})});
    if(completed)mutateState(s=>{if(s.welearnDrafts)delete s.welearnDrafts[task.key];});
    if(check){releasePage(check);await check.close().catch(()=>{});}
    if(keep){pages.set(task.key,page);setPageBusy(page,false);}
    else{pages.delete(task.key);releasePage(page);await page.close().catch(()=>{});}
  }
}
