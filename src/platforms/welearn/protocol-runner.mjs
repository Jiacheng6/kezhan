import {newTaskPage,releasePage} from '../../browser/pages.mjs';
import {loadState,mutateState,setTaskStatus} from '../../state.mjs';
import {loadSettings} from '../../config.mjs';
import {throwIfStopped,interruptibleSleep} from '../../control.mjs';
import {readCourseIdentity} from './scan.mjs';import {readLessons} from './api.mjs';
import {courseIdentity,platformId} from './policy.mjs';import {createWelearnSession} from './session.mjs';
import {prepareWelearnLesson} from './preparation.mjs';
import {startSco,setScoInfo,saveScoInfo} from './vendor/auto-welearn/core/api/sco.mjs';
import {readWelearnCmi} from './cmi.mjs';
import {parseScormTime} from './vendor/auto-welearn/core/parse/scorm-time.mjs';
import {runKeepalive} from './vendor/auto-welearn/core/run/keepalive.mjs';
import {generateInteractions} from './vendor/auto-welearn/core/parse/interactions.mjs';
import {buildScoData} from './vendor/auto-welearn/core/run/payload.mjs';
// Upstream owns parsing, heartbeats and the SCO request/payload format. Kezhan
// owns scope, cancellation, submit preferences and independent completion checks.
export async function runWelearnProtocolTask({task,context,shouldStop=()=>false,onProgress=()=>{}},{settings=loadSettings,readStatus=readLessons,sessionFactory=createWelearnSession,keepaliveDeps,confirmTimeoutMs=20000,pollMs=1500}={}){
  const ctx=typeof context==='function'?context():context,meta=courseIdentity(task.welearn||{}),scoid=platformId(task.welearn.scoid),sco={...meta,scoid};
  const page=await newTaskPage(ctx,'view-status'),abort=new AbortController();let completed=false,result;
  const watch=setInterval(()=>{if(shouldStop())abort.abort();},150);watch.unref?.();
  const finish=(phase,error,extra={})=>(result={ok:['done','already-finished'].includes(phase),phase,...(error?{error}:{}),...extra});
  const progress=(phase,extra={})=>onProgress({phase,taskType:'study',answerSource:'courseware',...extra});
  try{
    throwIfStopped(shouldStop);
    const verifyAccount=async()=>{const actual=await readCourseIdentity(page,meta.cid,{shouldStop});if(actual.uid!==meta.uid||actual.classid!==meta.classid)throw Object.assign(Error('WeLearn 账号或班级改变，请重新扫描'),{code:'TASK_IDENTITY_CHANGED',retryable:false});};
    await verifyAccount();
    const status=async()=>{const rows=await readStatus(page,meta,task.welearn.unitIndex,{shouldStop}),hits=rows.filter(r=>r.scoid===scoid);if(hits.length!==1)throw Object.assign(Error('WeLearn 原小节无法唯一核对'),{code:'TASK_IDENTITY_CHANGED',retryable:false});return hits[0];};
    const original=await status();if(original.finished){completed=true;return finish('already-finished');}
    const previous=loadState().welearnProtocol?.[task.key];
    if(previous?.submissionPending)return finish('needs-human','WeLearn 上次提交结果未确认；已回查平台仍未完成，未重复提交',{retryable:false,submissionPending:true});
    const session=sessionFactory(page,task,{shouldStop,signal:abort.signal});
    progress('courseware-read');
    const prepared=await prepareWelearnLesson(session,sco,{signal:abort.signal,skipOralQuestion:true});
    if(!prepared.questions.length)return finish('needs-human',prepared.oral?'WeLearn 该小节需要本人录音或口语作答，未调用 AI、未上报完成':'WeLearn 原版解析器未取得可提交答案，未调用 AI、未上报完成',{retryable:false});
    const bundle=generateInteractions(prepared.questions,{crate:100});
    const waitSec=Math.max(30,Math.min(900,Math.round(Number(settings().welearn?.waitSec)||300)));
    const record={strategy:prepared.strategy,questions:prepared.questions.length,answered:bundle.interactions.length,answers:prepared.questions,submissionPending:false,waitSec};
    mutateState(s=>{s.welearnProtocol||={};s.welearnProtocol[task.key]=record;});
    if(settings().submitMode!=='auto')return finish('needs-human',`WeLearn 已用原版解析器取得 ${record.questions} 题答案，无需 AI；当前是人工提交模式，请开启自动提交后重新开始本小节`,{retryable:false});
    setTaskStatus(task.key,{status:'running',platform:'welearn'});
    if(!await startSco(session,sco,{signal:abort.signal}))return finish('needs-human','WeLearn 未接受开始请求，未提交答案',{retryable:false});
    const cmi=await readWelearnCmi(session,sco,{signal:abort.signal,alreadyStarted:true});
    if(!cmi.ok&&cmi.reason!=='uninitialized')return finish('needs-human','WeLearn 历史学习数据无法核对，未覆盖或提交',{retryable:false});
    const totalBefore=Math.max(cmi.ok?cmi.totalBefore:0,parseScormTime(original.learnTime));let elapsed=0;
    const sleep=keepaliveDeps?.sleep||((ms)=>interruptibleSleep(ms,shouldStop));
    progress('courseware-wait',{currentTime:0,duration:waitSec,percent:0});
    const keepalive=await runKeepalive({session,ctx:sco,totalBefore,targetSec:waitSec,signal:abort.signal},{...keepaliveDeps,sleep:async(ms,signal)=>{await sleep(ms,signal);elapsed+=ms/1000;progress('courseware-wait',{currentTime:elapsed,duration:waitSec,percent:Math.min(.95,elapsed/waitSec)});}});
    throwIfStopped(shouldStop);await verifyAccount();
    if(settings().submitMode!=='auto')return finish('needs-human','WeLearn 自动提交已关闭，保留解析记录，未提交',{retryable:false});
    if(keepalive.supported===false||keepalive.failures)return finish('needs-human','WeLearn 心跳未全部确认，未上报完成；可重新开始',{retryable:false});
    const data=buildScoData({interactions:bundle.interactions,crate:100,sessionTime:keepalive.elapsed,totalTime:totalBefore+keepalive.elapsed},bundle.interactionInfo);
    // Persist uncertainty BEFORE the first final write. Never automatically
    // repeat final writes after timeout/restart; read the original SCO instead.
    mutateState(s=>{s.welearnProtocol[task.key]={...record,submissionPending:true,submittedAt:Date.now()};});
    setTaskStatus(task.key,{submissionPending:true});progress('courseware-submit');
    const setOk=await setScoInfo(session,sco,data,{signal:abort.signal});
    throwIfStopped(shouldStop);
    if(!setOk)return finish('needs-human','WeLearn 未确认答题数据写入，保留记录等待核对',{retryable:false,submissionPending:true});
    if(!await saveScoInfo(session,sco,{crate:100,sessionTime:keepalive.elapsed,totalTime:totalBefore+keepalive.elapsed},{signal:abort.signal}))return finish('needs-human','WeLearn 未确认进度保存，保留记录等待核对',{retryable:false,submissionPending:true});
    const deadline=Date.now()+confirmTimeoutMs;progress('verifying');
    do{throwIfStopped(shouldStop);if((await status()).finished){completed=true;return finish('done',null,{questions:record.questions,strategy:record.strategy});}await interruptibleSleep(pollMs,shouldStop);}while(Date.now()<deadline);
    return finish('needs-human','WeLearn 接口已回应，但平台尚未标记已完成；未重复提交',{retryable:false,submissionPending:true});
  }catch(error){
    if(error.code==='STOPPED'||abort.signal.aborted||error.name==='AbortError')return finish('stopped');
    return finish('needs-human',error.message,{retryable:false,errorCode:error.code});
  }finally{
    clearInterval(watch);
    setTaskStatus(task.key,{status:completed?'done':result?.phase==='stopped'?'pending':'manual',platform:'welearn',progress:completed?1:undefined,note:completed?'WeLearn 原小节已确认完成':result?.error||'已停止，保留已确认进度',...(completed?{submissionPending:false}:{})});
    if(completed)mutateState(s=>{if(s.welearnProtocol?.[task.key])s.welearnProtocol[task.key].submissionPending=false;});
    releasePage(page);await page.close().catch(()=>{});
  }
}
