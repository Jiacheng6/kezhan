import fs from 'node:fs';import path from 'node:path';import {PATHS} from '../config.mjs';
const signature=items=>JSON.stringify(items.map(i=>({id:String(i.questionId||i.archive?.questionId||''),type:i.qtype,options:(i.options||[]).map(o=>String(o.optionId||o.text||'').replace(/\s+/g,' ').trim()).sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
// Upgrade backups retain the original work/attempt binding. Recover metadata
// only when account, full task coordinates and the entire question set agree.
export function recoverReviewIdentity(key,info,items,{personId,root=PATHS.userData}={}){
 if(info?.workIdentity?.workid&&info.workIdentity.workanswerid)return info.workIdentity;
 if(!personId||!items.length||items.some(i=>!i.questionId&&!i.archive?.questionId))return null;
 const task=info?.task||items[0],fields=['courseId','clazzId','knowledgeId'];if(fields.some(k=>!task[k]))return null;
 const directory=path.join(root,'updates','backups'),found=new Map();let dirs;
 try{dirs=fs.readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink());}catch{return null;}
 if(dirs.length>64)return null;
 for(const dir of dirs){
  try{
   const file=path.join(directory,dir.name,'state.json');if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>16*1024*1024)continue;
   const state=JSON.parse(fs.readFileSync(file,'utf8')),saved=state.keptPages?.[key]?.info,id=saved?.workIdentity,old=saved?.task||{};
   if(!id?.workid||!id.workanswerid||String(saved.personId)!==String(personId)||fields.some(k=>String(old[k])!==String(task[k])))continue;
   if(task.jobid&&old.jobid&&task.jobid!==old.jobid)continue;
   const previous=(state.reviewQueue||[]).filter(i=>i.taskKey===key);
   if(signature(items)!==signature(previous))continue;
   found.set(JSON.stringify([id.workid,id.workanswerid]),id);
  }catch{ /* Invalid backups cannot authorize clearing a draft. */ }
 }
 return found.size===1?[...found.values()][0]:null;
}
