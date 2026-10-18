import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {embeddedRequest} from '../browser/embedded.mjs';
import {throwIfStopped,waitForRead} from '../control.mjs';
export const apiStatus=()=>embeddedRequest('api-status');
export async function askApiImage({imagePath,prompt,shouldStop}){
  throwIfStopped(shouldStop);
  if(!fs.existsSync(imagePath))return {ok:false,errorCode:'image-missing',error:'题目截图不存在'};
  const jobId=randomUUID();
  try{
    const request=embeddedRequest('api-ask',{jobId,prompt,image:fs.readFileSync(imagePath).toString('base64')});
    const result=await waitForRead(()=>request,{shouldStop,timeoutMs:125000,message:'API 回答等待超时'});
    throwIfStopped(shouldStop);return result;
  }finally{void embeddedRequest('api-cancel',{jobId}).catch(()=>{});}
}
