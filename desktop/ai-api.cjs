const fs=require('node:fs');const path=require('node:path');
const {renameWithRetry}=require('../src/atomic-file.cjs');
function endpoint(value){
  const url=new URL(String(value||''));
  if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('API 地址须为 HTTPS，或本机 HTTP 地址，不要在地址中包含密钥');
  url.pathname=url.pathname.replace(/\/+$/,'');
  if(!url.pathname.endsWith('/chat/completions'))url.pathname+='/chat/completions';
  return url.href;
}
/**
 * 从"OpenAI 兼容"响应里取正文 —— 覆盖常见变体（纯函数，可单测）。
 *
 * 为什么不能只读 `choices[0].message.content`（2026-11-01 用户反馈
 * "不管换成我的 API 还是豆包千问都是一样的问题"）：
 *   不同服务/模型的返回形状差异很大：
 *     · content 是字符串（标准）
 *     · content 是数组 [{type:'text',text}]（视觉模型常见）—— 已支持
 *     · choices[0].text（旧版 completions）
 *     · output_text / output[].content[].text（Responses 风格）
 *     · 根级 content 数组（Anthropic 风格，部分中转站）
 *     · reasoning_content 有内容而 content 为空（推理模型思考完未给正文）
 *   只认第一种时，其余全被判成 `api-empty` —— 看起来就像"API 坏了"。
 */
function pickText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return pickText(value.text ?? value.content ?? value.output_text ?? '');
  return '';
}

function extractApiAnswer(result) {
  if (!result || typeof result !== 'object') return { text: '', source: '', finishReason: '' };
  const choice = result.choices?.[0] || {};
  const message = choice.message || {};
  const candidates = [
    ['message.content', message.content],
    ['choice.text', choice.text],
    ['output_text', result.output_text],
    ['output[].content', result.output],
    ['content', result.content],
    ['message.reasoning_content', message.reasoning_content],
    ['choice.reasoning_content', choice.reasoning_content],
  ];
  for (const [source, value] of candidates) {
    const text = pickText(value).trim();
    if (text) return { text, source, finishReason: String(choice.finish_reason || '') };
  }
  return { text: '', source: '', finishReason: String(choice.finish_reason || '') };
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
      const result=await response.json();
      const picked=extractApiAnswer(result);
      if(!picked.text){
        /*
         * 空回答要能自证原因：finish_reason / 返回体里出现的键名，
         * 比笼统的"请核对模型和接口兼容性"有用得多（且不打印题目内容）。
         */
        const keys=Object.keys(result||{}).slice(0,6).join(',');
        const choice=result?.choices?.[0]||{};
        const hint=[
          picked.finishReason?`finish_reason=${picked.finishReason}`:'',
          `返回字段=${keys||'(空)'}`,
          choice.finish_reason==='length'?'（被 max_tokens 截断）':'',
          /content_filter|safety/i.test(String(picked.finishReason))?'（被安全策略拦截）':'',
        ].filter(Boolean).join('；');
        return {ok:false,errorCode:'api-empty',error:`API 未返回可读取的回答（${hint}）。请确认该模型支持图片输入，或换用返回 choices[0].message.content 的模型`};
      }
      return {ok:true,provider:'api',answer:picked.text,answerSource:picked.source};
    }catch{return {ok:false,errorCode:'api-error',error:'API 连接失败或等待超时，请检查地址、网络及服务状态'};}
    finally{if(jobId&&jobs.get(jobId)===controller)jobs.delete(jobId);}
  };
  return {status,save,ask,cancel:jobId=>{jobs.get(jobId)?.abort();return {cancelled:true};},test:()=>ask({prompt:'只回复 OK',test:true})};
}
module.exports={createApiService,endpoint,extractApiAnswer,pickText};
