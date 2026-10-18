import {interruptibleSleep,throwIfStopped,waitForRead} from '../control.mjs';
let pending=null,listener=()=>{};
export const canPauseAI=()=>process.env.XXT_DESKTOP==='1';
export const aiResumeStatus=()=>pending?{waiting:true,provider:pending.provider,label:pending.label,since:pending.since}:{waiting:false};
export function onAIResumeChange(fn){listener=fn;}
export async function waitForAIResume({provider,page,shouldStop,check}){
  if(pending)throw Error('已有题目正在等待人工处理');
  const item={provider:provider.id,label:provider.label,since:Date.now(),ready:false,check};pending=item;listener(aiResumeStatus());
  try{
    while(!item.ready){throwIfStopped(shouldStop);if(page?.isClosed())throw Error('AI 网页已关闭，请重新打开后再开始');await interruptibleSleep(200,shouldStop);}
    return Date.now()-item.since;
  }finally{if(pending===item){pending=null;listener(aiResumeStatus());}}
}
export async function continueAI(){
  if(!pending)return {continued:false,note:'当前没有等待人工处理的题目'};
  const item=pending;
  if(!await waitForRead(()=>item.check(),{timeoutMs:10000,message:'AI 网页暂时无法读取，请稍后重试继续'}))throw Error('页面仍要求验证或尚未就绪，请先完成网页提示');
  if(pending!==item)return {continued:false,note:'此题等待已结束，请刷新任务状态'};
  item.ready=true;return {continued:true};
}
