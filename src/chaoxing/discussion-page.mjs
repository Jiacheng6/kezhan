import {throwIfStopped,interruptibleSleep} from '../control.mjs';
import {discussionText} from './discussion-consensus.mjs';

export function discussionIdentity(url){
 try{const u=new URL(url),match=u.pathname.match(/^\/course\/topic\/v3\/bbs\/([\w-]+)\/([\w-]+)\/replysList\/?$/);if(u.protocol!=='https:'||u.hostname!=='groupweb.chaoxing.com'||!match)return null;return {bbsid:match[1],topicId:match[2],courseId:u.searchParams.get('courseId')||'',clazzId:u.searchParams.get('classId')||''};}catch{return null;}
}
export function validateDiscussionIdentity(actual,expected){
 if(!actual||['bbsid','topicId','courseId','clazzId'].some(field=>!expected?.[field]||String(actual[field])!==String(expected[field])))throw new Error('讨论或课程已变化，未填写或发布，请重新读取讨论');
}
// Discussion cards use `title` rather than the video attachment's `name`.
// Match the stable topic ID so a neighbouring quiz's marker cannot stand in.
export async function readDiscussionPointStatus(page,task){
 return page.evaluate(expected=>{
  const list=[...document.querySelectorAll('.ans-attach-ct')].map(ct=>{const frame=ct.querySelector('iframe');let data={};try{data=JSON.parse(frame?.getAttribute('data')||'{}');}catch{}return {ct,data,src:frame?.getAttribute('src')||''};});
  const matches=list.filter(({data,src})=>/modules\/(?:insertbbs|forum|bbs)/.test(src)&&expected.discussionId&&String(data.mid||'')===String(expected.discussionId));
  if(matches.length!==1)return {finished:null,via:'discussion-no-match',error:'没有找到唯一对应的讨论任务点'};
  const {ct,data}=matches[0],icon=ct.querySelector('.ans-job-icon'),aria=icon?.getAttribute('aria-label')||'';
  if(expected.jobid&&String(data.jobid||'')!==String(expected.jobid))return {finished:null,via:'discussion-job-mismatch',error:'讨论任务点标识不一致'};
  if(data.isJob===false||!data.jobid&&!icon)return {finished:null,hasTracking:false,via:'discussion-untracked'};
  return {finished:ct.classList.contains('ans-job-finished')||/已完成/.test(aria),hasTracking:true,via:'discussion-attach',aria};
 },{discussionId:task.discussionId,jobid:task.jobid});
}
export async function readDiscussionPage(page){
 const identity=discussionIdentity(page.url());if(!identity)throw new Error('不是已支持的课程讨论页面');
 const result=await page.evaluate(()=>{
  const detail=window.Topic_Detail||{},obj=window.obj||{},list=window.Topic_Invitation||{};
  const userId=String(detail.user?.puid||obj.user?.puid||'');
  const records=[...(list.replyList||[]),...(list.replyTopList||[])];
  const visible=e=>e?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const comments=[...document.querySelectorAll('.topicDetail_replyList > .topicDetail_replyItem')].filter(visible).map(e=>{
   const data=records.find(record=>String(record.uuid)===e.id)||{};
   const content=e.querySelector('.topicReply_right > .replyContent')||e.querySelector('.replyContent');
   const authorId=String(data.createrPuid||e.getAttribute('data-puid')||'');
   return {id:e.id||e.getAttribute('realid'),authorId,text:content?.innerText||'',isSelf:!!userId&&authorId===userId};
  });
  const title=String(detail.topic?.title||obj.topic?.title||document.querySelector('.topicDetail_title,h1')?.innerText||'').trim();
  const source=document.querySelector('#bbsTopicDetail .replyContent');
  const editor=[...document.querySelectorAll('.topicDetail_editContainer textarea')].find(visible);
  return {title,body:source?.innerText||'',userId,comments,total:Number(document.querySelector('.classReplyCount span')?.textContent?.replace(/[^\d]/g,''))||comments.length,
   lastPage:list.poff?.lastPage===1||list.poff?.lastPage==='1',hasMore:[...document.querySelectorAll('.loadText')].some(visible),
   commentsReady:comments.length>0||Number(list.poff?.pageSize)>0||list.poff?.lastPage===1||list.poff?.lastPage==='1'||visible(document.querySelector('.allowViewReplyTip')),
   canView:!visible(document.querySelector('.allowViewReplyTip')),editorReady:!!editor,editorText:editor?.value||'',
   verification:[...document.querySelectorAll('[class*=captcha],iframe[src*=captcha],[role=dialog]')].filter(visible).some(e=>/验证|captcha/i.test(e.innerText||e.getAttribute('src')||e.className||''))};
 });
 if(!result.userId||!result.title)throw new Error('讨论页面未就绪，请检查学习通登录和页面加载');
 return {...result,identity};
}
export async function readDiscussionComments(page,{shouldStop=()=>false,maxPages=50,maxComments=2000,onProgress=()=>{}}={}){
 let state=await readDiscussionPage(page),pages=1,capped=false;const seen=new Map();
 const readyDeadline=Date.now()+15000;
 while(!state.commentsReady&&Date.now()<readyDeadline){if(state.verification)throw Object.assign(new Error('学习通讨论页面需要人工验证，请在软件内网页完成后重试'),{code:'VERIFICATION_REQUIRED'});await interruptibleSleep(200,shouldStop);state=await readDiscussionPage(page);}
 if(state.verification)throw Object.assign(new Error('学习通讨论页面需要人工验证'),{code:'VERIFICATION_REQUIRED'});
 if(!state.commentsReady)throw new Error('讨论评论尚未加载完成，未将空白页面当成没有评论');
 const add=()=>{for(const comment of state.comments)if(comment.id){if(seen.has(comment.id)||seen.size<maxComments)seen.set(comment.id,comment);else capped=true;}};add();
 if(!state.canView)return {...state,comments:[],pages,complete:false,restricted:true};
 while(!state.lastPage&&state.hasMore&&pages<maxPages&&seen.size<maxComments){
  throwIfStopped(shouldStop);const before=seen.size;
  await page.locator('.loadText').filter({visible:true}).first().click({timeout:5000});
  const deadline=Date.now()+12000;
  do{await interruptibleSleep(200,shouldStop);state=await readDiscussionPage(page);add();if(state.lastPage||seen.size>before)break;}while(Date.now()<deadline);
  if(seen.size===before&&!state.lastPage)throw new Error('讨论评论加载未完成，已停止生成，避免把加载失败当成没有评论');
  pages++;onProgress({phase:'读取讨论评论',loaded:seen.size,total:state.total});
 }
 throwIfStopped(shouldStop);
 return {...state,comments:[...seen.values()],pages,complete:!capped&&(state.lastPage||state.total>0&&seen.size>=state.total)};
}
export async function fillDiscussionEditor(page,text){
 const editor=page.locator('.topicDetail_editContainer textarea').filter({visible:true});
 if(await editor.count()!==1)throw new Error('找不到唯一的讨论回复编辑器');
 await editor.fill(text);await editor.dispatchEvent('input');
 if(discussionText(await editor.inputValue())!==discussionText(text))throw new Error('讨论草稿回读不一致，未发布');
 return {verified:true};
}

// Exactly one native click. The own reply and successful platform response must
// agree; an uncertain result remains blocked until a separate reconciliation.
export async function publishDiscussionPage(page,{text,identity,userId,shouldStop=()=>false,timeoutMs=20000,beforePublish=async()=>{}}={}){
 validateDiscussionIdentity(discussionIdentity(page.url()),identity);
 let state=await readDiscussionComments(page,{shouldStop});
 if(state.userId!==String(userId))throw new Error('学习通账号已变化，未发布');
 const own=state.comments.filter(c=>c.isSelf);
 if(own.length)return {ok:true,alreadyPublished:true,replyId:own[0].id};
 if(state.restricted||!state.complete)throw new Error('尚未完整核对本人参与记录，未发布，避免重复回复');
 throwIfStopped(shouldStop);await fillDiscussionEditor(page,text);
 const before=new Set(state.comments.map(c=>c.id));
 let receipt=null,attempted=false;
 const onResponse=async response=>{
  try{const u=new URL(response.url());if(u.origin==='https://groupweb.chaoxing.com'&&u.pathname===`/pc/invitation/${identity.topicId}/addReplys`&&response.request().method()==='POST')receipt=await response.json();}catch{}
 };
 page.on('response',onResponse);
 try{
  const button=page.locator('.topicDetail_editContainer .addReply').filter({visible:true});
  if(await button.count()!==1)throw new Error('找不到唯一的讨论发布按钮');
  await beforePublish();attempted=true;
  await button.click({timeout:8000});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   throwIfStopped(shouldStop);
   if(receipt?.status===false)return {ok:false,pending:false,error:String(receipt.msg||'平台未接受讨论回复')};
   if(receipt?.status===true){
    if(!receipt.datas)return {ok:false,pending:true,moderation:true,error:'平台已接收回复，等待审核；暂不重复发布'};
    state=await readDiscussionPage(page);
    const returned=receipt.datas.reply;
    // The site's native append renders the new reply without updating
    // Topic_Invitation.replyList. Its author is established by the receipt;
    // the DOM must independently contain that exact new ID and text.
    const reply=returned&&state.comments.find(c=>String(returned.uuid)===c.id&&!before.has(c.id)&&discussionText(c.text)===discussionText(text));
    if(reply&&String(returned.createrPuid)===String(userId))return {ok:true,replyId:reply.id};
   }
   await interruptibleSleep(250,shouldStop);
  }
  return {ok:false,pending:true,error:'讨论发布结果尚未确认，草稿已保留；请核对页面，暂不重复发布'};
 }catch(error){return {ok:false,pending:attempted,error:error.message};}
 finally{page.off('response',onResponse);}
}
