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
export async function runWithTaskRestart(execute,{task,shouldStop=()=>false,onRestart=()=>{},retryWhen=()=>true,delayMs=1500}={}){
  for(let attempt=0;attempt<2;attempt++){
    if(shouldStop())return {ok:false,phase:'stopped'};
    let result,error;
    try{result=await execute({restartTask:attempt===1,restartAttempt:attempt});}
    catch(caught){error=caught;}
    if(shouldStop()||error?.code==='STOPPED'){
      if(result&&(result.submitted||['done','already-finished','no-tracking','awaiting-review','submitted'].includes(result.phase)||result.ok&&!result.needsHuman&&!result.phase?.startsWith('blocked-')))return result;
      return {ok:false,phase:'stopped'};
    }
    const outcome=error||result;
    if(attempt===1||!retryWhen(result,error)||!canRestartTask(task,outcome,{thrown:!!error})){
      if(error)throw error;return result;
    }
    await onRestart({task,result,error,attempt:1});
    const deadline=Date.now()+delayMs;
    while(Date.now()<deadline){if(shouldStop())return {ok:false,phase:'stopped'};await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));}
  }
}
