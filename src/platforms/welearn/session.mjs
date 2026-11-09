import {WELEARN_ORIGIN,courseIdentity,platformId} from './policy.mjs';
import {throwIfStopped,waitForRead} from '../../control.mjs';
const ACTIONS=new Set(['scoAddr','startsco160928','getscoinfo_v7','keepsco_with_getticket_with_updatecmitime','setscoinfo','savescoinfo160928']);
export function createWelearnSession(page,task,{shouldStop=()=>false,signal,readTemplate}={}){
  const meta=courseIdentity(task.welearn),scoid=platformId(task.welearn.scoid);
  const guard=()=>{throwIfStopped(shouldStop);signal?.throwIfAborted();};
  return {baseUrl:WELEARN_ORIGIN,
    async postForm(path,form,options={}){
      guard();
      if(path!=='/Ajax/SCO.aspx'||!ACTIONS.has(form.action)||form.cid!==meta.cid||form.scoid!==scoid||form.uid!=null&&form.uid!==meta.uid)throw Error('WeLearn 请求超出所选小节，未发送');
      if(new URL(page.url()).origin!==WELEARN_ORIGIN)throw Object.assign(Error('WeLearn 登录失效，请在原网页登录'),{code:'AUTH_EXPIRED',retryable:false});
      const key=crypto.randomUUID(),cancel=()=>{void page.evaluate(key=>globalThis.__kezhanWelearnRequests?.get(key)?.abort(),key).catch(()=>{});};
      signal?.addEventListener('abort',cancel,{once:true});
      try{
        const result=await waitForRead(()=>page.evaluate(async({form,key,referrer})=>{
          const controller=new AbortController();globalThis.__kezhanWelearnRequests||=new Map();globalThis.__kezhanWelearnRequests.set(key,controller);
          const timer=setTimeout(()=>controller.abort(),18000);
          try{const response=await fetch('/Ajax/SCO.aspx',{method:'POST',credentials:'include',referrer,headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json, text/javascript, */*; q=0.01'},body:new URLSearchParams(form).toString(),signal:controller.signal});return {status:response.status,url:response.url,text:(await response.text()).slice(0,2000001),redirects:[]};}
          finally{clearTimeout(timer);globalThis.__kezhanWelearnRequests.delete(key);}
        },{form,key,referrer:options.referer}),{shouldStop,timeoutMs:20000,message:'WeLearn 接口等待超时'});
        guard();
        if(new URL(result.url).origin!==WELEARN_ORIGIN||[401,403].includes(result.status))throw Object.assign(Error('WeLearn 登录失效，保留原进度'),{code:'AUTH_EXPIRED',retryable:false});
        if(result.status!==200||result.text.length>2000000)throw Error('WeLearn 接口响应异常，未确认结果');
        return result;
      }finally{signal?.removeEventListener('abort',cancel);cancel();}
    },
    async get(url,options={}){
      guard();let current=new URL(url,WELEARN_ORIGIN);
      for(let hop=0;hop<5;hop++){
        if(current.protocol!=='https:'||!/(^|\.)sflep\.com$/.test(current.hostname))throw Error('WeLearn 课件地址不属于平台，未读取');
        if(readTemplate)return readTemplate(current.href,options);
        const timeout=AbortSignal.timeout(18000),requestSignal=signal?AbortSignal.any([timeout,signal]):timeout;
        const response=await fetch(current,{redirect:'manual',signal:requestSignal,headers:{Referer:WELEARN_ORIGIN+'/'}});
        if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('WeLearn 课件跳转异常');current=new URL(location,current);continue;}
        const text=await response.text();guard();if(text.length>2000000)throw Error('WeLearn 课件过大，未解析');return {status:response.status,text,url:current.href,redirects:[]};
      }
      throw Error('WeLearn 课件跳转次数过多');
    }
  };
}
