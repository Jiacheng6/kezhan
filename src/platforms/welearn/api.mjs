import {waitForRead,throwIfStopped} from '../../control.mjs';
import {WELEARN_ORIGIN,platformId,normalizeLessons} from './policy.mjs';
// Reads deliberately cannot call SCO write endpoints. The native courseware
// owns its normal save/heartbeat behaviour; credentials stay in its session.
export async function readWelearn(page,pathname,query={}, {shouldStop}={}){
  const allowed=pathname==='/ajax/authCourse.aspx'&&query.action==='gmc'||pathname==='/ajax/StudyStat.aspx'&&['courseunits','scoLeaves'].includes(query.action);
  if(!allowed)throw Error('WeLearn 只读接口范围无效');
  if(new URL(page.url()).origin!==WELEARN_ORIGIN)throw Object.assign(Error('请先在软件内登录 WeLearn'),{code:'AUTH_EXPIRED',retryable:false});
  throwIfStopped(shouldStop);
  const response=await waitForRead(()=>page.evaluate(async({origin,url})=>{
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
    try{const r=await fetch(url,{method:'GET',credentials:'include',headers:{Accept:'application/json'},signal:abort.signal});
      const text=await r.text();return {status:r.status,sameOrigin:new URL(r.url).origin===origin,text:text.slice(0,2000001)};
    }finally{clearTimeout(timer);}
  },{origin:WELEARN_ORIGIN,url:pathname+'?'+new URLSearchParams(query)}),{shouldStop,timeoutMs:18000,message:'WeLearn 目录读取超时，原清单保留'});
  throwIfStopped(shouldStop);
  if(!response.sameOrigin||[401,403].includes(response.status)||/<input[^>]+type=["']password|Account\/Login|\/prelogin\.aspx/i.test(response.text))throw Object.assign(Error('WeLearn 登录已失效，请在软件内重新登录，原进度保留'),{code:'AUTH_EXPIRED',retryable:false});
  if(response.status!==200)throw Error('WeLearn 目录读取失败（HTTP '+response.status+'）');
  if(response.text.length>2000000)throw Error('WeLearn 目录过大，未覆盖原清单');
  let data;try{data=JSON.parse(response.text);}catch{throw Error('WeLearn 返回的目录不是 JSON，可能需要登录或页面验证');}
  if(data.ret!=null&&Number(data.ret)!==0)throw Error('WeLearn 未接受目录读取请求，原清单保留');
  return data;
}
export async function readCourses(page,options){
  const data=await readWelearn(page,'/ajax/authCourse.aspx',{action:'gmc'},options);
  if(!Array.isArray(data.clist))throw Error('WeLearn 课程列表结构改变，原清单保留');
  const seen=new Set();
  return data.clist.map(c=>{const cid=platformId(c.cid);if(seen.has(cid))throw Error('WeLearn 课程标识重复');seen.add(cid);return {cid,name:String(c.name||'WeLearn 课程')};});
}
export async function readUnits(page,meta,options){
  const data=await readWelearn(page,'/ajax/StudyStat.aspx',{action:'courseunits',cid:meta.cid,uid:meta.uid},options);
  if(!Array.isArray(data.info)||data.info.length>200)throw Error('WeLearn 单元目录结构改变，原清单保留');
  return data.info;
}
export async function readLessons(page,meta,unitIndex,options){
  if(!Number.isInteger(unitIndex)||unitIndex<0||unitIndex>=200)throw Error('WeLearn 单元定位无效');
  const data=await readWelearn(page,'/ajax/StudyStat.aspx',{action:'scoLeaves',cid:meta.cid,uid:meta.uid,classid:meta.classid,unitidx:String(unitIndex)},options);
  return normalizeLessons(data.info,unitIndex);
}
