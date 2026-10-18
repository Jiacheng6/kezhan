const fs=require('node:fs');const path=require('node:path');
const {renameWithRetry}=require('../src/atomic-file.cjs');
function endpoint(value){
  const url=new URL(String(value||''));
  if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('API 地址须为 HTTPS，或本机 HTTP 地址，不要在地址中包含密钥');
  url.pathname=url.pathname.replace(/\/+$/,'');
  if(!url.pathname.endsWith('/chat/completions'))url.pathname+='/chat/completions';
  return url.href;
}
function createApiService({dataDir,safeStorage,fetchImpl=fetch}){
  const jobs=new Map();
  const file=path.join(dataDir,'api-config.bin');
  const load=()=>{
    if(!fs.existsSync(file))return {};
    if(!safeStorage.isEncryptionAvailable())throw Error('Windows 本机加密暂不可用，无法读取 API 密钥');
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  };
  const status=()=>{const c=load();return {baseUrl:c.baseUrl||'',model:c.model||'',hasKey:!!c.apiKey,configured:!!(c.baseUrl&&c.model&&c.apiKey)};};
  const save=patch=>{
    const previous=load();const baseUrl=endpoint(patch.baseUrl),model=String(patch.model||'').trim();
    if(!model||model.length>200||/[\r\n\0]/.test(model))throw Error('请填写有效的模型名称');
    if(previous.baseUrl&&new URL(previous.baseUrl).origin!==new URL(baseUrl).origin&&!patch.apiKey)throw Error('更换 API 服务地址后，请重新填写密钥');
    const apiKey=patch.clearKey?'':String(patch.apiKey||previous.apiKey||'').trim();
    if(apiKey.length>4096||/[\r\n\0]/.test(apiKey))throw Error('API 密钥格式无效');
    if(!safeStorage.isEncryptionAvailable())throw Error('Windows 本机加密暂不可用，未保存密钥');
    fs.mkdirSync(dataDir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify({baseUrl,model,apiKey})));renameWithRetry(tmp,file);
    return status();
  };
  const ask=async({prompt,image,signal,test=false,jobId}={})=>{
    const c=load();if(!c.baseUrl||!c.model||!c.apiKey)return {ok:false,errorCode:'api-not-configured',error:'请先在偏好设置中配置 API 地址、密钥和模型'};
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>20000)return {ok:false,errorCode:'api-invalid-input',error:'API 提问内容无效'};
    if(!test&&(typeof image!=='string'||image.length>14*1024*1024||!Buffer.from(image,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))return {ok:false,errorCode:'api-invalid-image',error:'题目截图无效或过大，未发送 API'};
    const controller=new AbortController();if(jobId)jobs.set(jobId,controller);
    try{
      const content=test?prompt:[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:image/png;base64,'+image}}];
      const response=await fetchImpl(endpoint(c.baseUrl),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Authorization:'Bearer '+c.apiKey},body:JSON.stringify({model:c.model,messages:[{role:'user',content}],stream:false,max_tokens:test?16:4096}),signal:AbortSignal.any([controller.signal,signal||AbortSignal.timeout(120000)])});
      if(!response.ok){const reason=({401:'密钥无效或无权限',403:'无访问权限',429:'额度不足或请求受限',400:'请求不兼容，请确认模型支持图片输入'})[response.status]||'服务返回错误';return {ok:false,errorCode:'api-error',error:`API HTTP ${response.status}：${reason}`};}
      const result=await response.json();let answer=result.choices?.[0]?.message?.content;
      if(Array.isArray(answer))answer=answer.filter(x=>x.type==='text').map(x=>x.text).join('\n');
      if(typeof answer!=='string'||!answer.trim())return {ok:false,errorCode:'api-empty',error:'API 未返回可读取的回答，请核对模型和接口兼容性'};
      return {ok:true,provider:'api',answer:answer.trim()};
    }catch{return {ok:false,errorCode:'api-error',error:'API 连接失败或等待超时，请检查地址、网络及服务状态'};}
    finally{if(jobId&&jobs.get(jobId)===controller)jobs.delete(jobId);}
  };
  return {status,save,ask,cancel:jobId=>{jobs.get(jobId)?.abort();return {cancelled:true};},test:()=>ask({prompt:'只回复 OK',test:true})};
}
module.exports={createApiService,endpoint};
