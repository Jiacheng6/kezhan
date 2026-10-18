// Official web clients and the separately configured OpenAI-compatible API.
export const AI_PROVIDERS = {
  api:{id:'api',label:'API',url:'',hosts:[]},
  qianwen: { id: 'qianwen', label: '千问', url: 'https://www.qianwen.com/', hosts: ['qianwen.com', 'tongyi.com'] },
  doubao: { id: 'doubao', label: '豆包', url: 'https://www.doubao.com/chat/', hosts: ['doubao.com'] },
  deepseek: { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'] },
};
export function selectedProvider(settings) { return AI_PROVIDERS[settings?.ai?.provider] || AI_PROVIDERS.qianwen; }
export function providerForUrl(url) {
  try {
    const {hostname,protocol}=new URL(url);
    if(protocol!=='https:')return null;
    return Object.values(AI_PROVIDERS).find(provider=>provider.hosts.some(host=>hostname===host||hostname.endsWith('.'+host)))||null;
  } catch { return null; }
}
const opening=new WeakMap();
export async function ensureProviderPage(context, provider, {create=true}={}) {
  if(provider.id==='api')return null;
  const pending=opening.get(context)?.get(provider.id);
  if(pending)return pending;
  let page=context.pages().find(page=>!page.isClosed()&&providerForUrl(page.url())?.id===provider.id);
  if(!page&&create){
    if(!opening.has(context))opening.set(context,new Map());
    const operation=(async()=>{const created=await context.newPage();await created.goto(provider.url,{waitUntil:'domcontentloaded',timeout:45000});return created;})();
    opening.get(context).set(provider.id,operation);
    try{return await operation;}finally{opening.get(context).delete(provider.id);}
  }
  return page||null;
}
