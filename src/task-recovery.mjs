// One task-local restart. Saved progress belongs to executors and is never reset.
const hardAI=new Set(['verification-required','not-logged-in','rate-limited','draft-not-empty','draft-attachment','already-generating']);
const recoverableAI=new Set(['editor-unavailable','upload-failed','upload-not-ready','send-failed','exception','answer-timeout','network-error']);
export function canRestartTask(task,outcome,{thrown=false}={}){
  if(!outcome)return false;
  const phase=outcome.phase||'',code=outcome.code||outcome.aiErrorCode||'';
  if(phase==='stopped'||code==='STOPPED'||outcome.stopped)return false;
  if(outcome.submitted||outcome.submissionPending||outcome.pendingConfirmation||outcome.submissionAttempted)return false;
  if(/submit|publish/.test(phase))return false;
  if(['awaiting-review','submitted','done','already-finished','no-tracking'].includes(phase))return false;
  if(outcome.ok&&!outcome.needsHuman&&!phase.startsWith('blocked-'))return false;
  if(outcome.retryable===false||['USER_CONSENT_REQUIRED','TASK_IDENTITY_CHANGED'].includes(code)||hardAI.has(outcome.aiErrorCode||code))return false;
  // The user explicitly requested ONE native task re-entry for Zhihuishu
  // verification. This neither answers nor manipulates the verification UI.
  if(code==='VERIFICATION_REQUIRED')return task.platform==='zhihuishu'&&outcome.verificationPlatform!=='ai';
  const text=String(outcome.error||outcome.message||outcome.needsHuman||'');
  if(/身份.*(改变|不一致)|课程.*(选择不一致|身份不)|弹题内容变化|选项改变|答案未通过|答案不可靠|题型.*未|人工选择|已参与讨论|不允许作答|已提交|提交结果|提交未完成|承诺书|验证码|人机验证|人工验证|需要本人/.test(text))return false;
  if(recoverableAI.has(outcome.aiErrorCode||code))return true;
  // Unexpected exceptions during a write are ambiguous. Only executors with a
  // known pre-submit/checkpoint state may opt into restarting those operations.
  if(thrown&&['work','discuss'].includes(task.type))return outcome.retryable===true;
  if(phase.startsWith('blocked-')||outcome.needsHuman)return outcome.retryable===true||/超时|Timeout|网络|连接|加载|未就绪|未渲染|未出现|上下文|已关闭|发送失败|上传失败/.test(text);
  return true;
}
export async function runWithTaskRestart(execute,{task,shouldStop=()=>false,onRestart=()=>{},retryWhen=()=>true,delayMs=1500,maxAttempts=2}={}){
  /*
   * 用户反馈（2026-11-03）：「有时我手动做完剩下的题提交后就又正常了」——
   * 说明字体/页面类问题**换一个页面就能好**，只是原实现只给了 1 次重开。
   * 现在页面级重开次数可配（默认仍是 1 次重开，字体类调用方给 3 次）。
   */
  const attempts = Math.min(6, Math.max(1, Math.round(Number(maxAttempts) || 2)));
  for(let attempt=0;attempt<attempts;attempt++){
    if(shouldStop())return {ok:false,phase:'stopped'};
    let result,error;
    try{result=await execute({restartTask:attempt===1,restartAttempt:attempt});}
    catch(caught){error=caught;}
    if(shouldStop()||error?.code==='STOPPED'){
      if(result&&(result.submitted||['done','already-finished','no-tracking','awaiting-review','submitted'].includes(result.phase)||result.ok&&!result.needsHuman&&!result.phase?.startsWith('blocked-')))return result;
      return {ok:false,phase:'stopped'};
    }
    const outcome=error||result;
    if(attempt===attempts-1||!retryWhen(result,error)||!canRestartTask(task,outcome,{thrown:!!error})){
      if(error)throw error;return result;
    }
    /*
     * 字体/页面类失败：重开前多等一会，让字体请求有机会恢复
     * （用户实测：手动提交后页面一换就正常了，说明换页 + 等一会儿是关键）。
     */
    const text = String(outcome?.error || outcome?.needsHuman || outcome?.message || '');
    const isFontish = /字体|fonts?|截图|capture/i.test(text);
    await onRestart({task,result,error,attempt:attempt+1});
    const deadline=Date.now()+(isFontish?Math.max(delayMs,4000):delayMs);
    while(Date.now()<deadline){if(shouldStop())return {ok:false,phase:'stopped'};await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));}
  }
}
