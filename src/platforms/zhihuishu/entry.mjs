import {newTaskPage,adoptTaskPage,releasePage} from '../../browser/pages.mjs';
import {throwIfStopped} from '../../control.mjs';
import {readZhihuishuPage,isZhihuishuUrl} from './read-page.mjs';
import {dismissZhihuishuNotices} from './notices.mjs';
async function readEntry(page){
 try{return await readZhihuishuPage(page);}
 catch(error){if(/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(error.message))return null;throw error;}
}

// Launch through the real portal course handler. A stored study URL is a
// directory locator, not evidence of a newly initialized learning session.
export async function openZhihuishuStudy(context,task,{shouldStop,timeoutMs=45000,loginGraceMs=8000}={}){
 const entry=await newTaskPage(context,'video-entry'),children=[];let page=entry;
 const onPopup=child=>children.push(child);entry.on('popup',onPopup);
 try{
  await entry.goto('https://onlineweb.zhihuishu.com/onlinestuh5',{waitUntil:'domcontentloaded',timeout:45000});
  const deadline=Date.now()+timeoutMs;let clicked=false,studyStarted=0,stableSince=0,signature='',loginSince=0,portalRetried=false;
  while(Date.now()<deadline){
   throwIfStopped(shouldStop);
   for(const child of children){
    if(child.isClosed()||child.url()==='about:blank')continue;
    if(!isZhihuishuUrl(child.url()))throw Error('课程入口打开了未知页面，未控制该页面');
    if(['studyvideoh5.zhihuishu.com','login.zhihuishu.com','passport.zhihuishu.com','www.zhihuishu.com'].includes(new URL(child.url()).hostname)){page=child;break;}
   }
   if(!isZhihuishuUrl(page.url()))throw Error('智慧树入口已离开课程平台，未继续');
   let state=await readEntry(page);
   if(!state){await entry.waitForTimeout(150);continue;}
   // SSO briefly renders the login centre even for a valid session. Judge the
   // settled destination, and once a study child exists stop judging its parent.
   if(state.loginState==='signed-out'){
    loginSince||=Date.now();
    if(Date.now()-loginSince>=loginGraceMs)throw Object.assign(Error('智慧树登录页持续未恢复，请在保留的软件内网页确认登录后继续'),{code:'LOGIN_REQUIRED'});
    await entry.waitForTimeout(150);continue;
   }
   loginSince=0;
   if(state.blockers.includes('progress-save-failed'))throw Object.assign(Error('智慧树提示学习进度提交失败，需要通过学堂重新进入，已有进度保留'),{code:'PROGRESS_SAVE_FAILED'});
   if(state.blockers.length)throw Object.assign(Error('智慧树入口需要本人处理验证或承诺书，请查看保留页面'),{code:state.blockers.includes('user-consent')?'USER_CONSENT_REQUIRED':'VERIFICATION_REQUIRED'});
   // The site's SSO can finish at its public homepage, losing the return URL.
   // Re-enter our own portal once; never refresh a user's course/quiz page.
   if(page===entry&&!clicked&&!portalRetried&&new URL(page.url()).hostname==='www.zhihuishu.com'){
    portalRetried=true;
    await entry.goto('https://onlineweb.zhihuishu.com/onlinestuh5',{waitUntil:'domcontentloaded',timeout:45000});continue;
   }
   if(!clicked&&state.pageKind==='home'&&state.courses.length){
    const indices=state.courses.map((c,i)=>c.key===task.courseId?i:-1).filter(i=>i>=0);
    if(indices.length!==1)throw Error('智慧树学堂中无法唯一匹配这门课程，请重新扫描');
    if(state.courses[indices[0]].kind!=='shared')throw Error('此课程类型的播放入口尚未适配');
    await dismissZhihuishuNotices(entry);
    await entry.locator('#sharingClassed dl,#flipLessoned dl').filter({has:entry.locator('.courseName')}).nth(indices[0]).locator('.courseName').click({timeout:10000});
    clicked=true;
   }
   if(isZhihuishuUrl(page.url())&&new URL(page.url()).hostname==='studyvideoh5.zhihuishu.com'){
    state=await readEntry(page);
    if(!state){await entry.waitForTimeout(150);continue;}
    if(state.pageKind==='study'&&state.videos.length){
     if(state.course?.key!==task.courseId)throw Error('打开的智慧树课程与选择不一致');
     // The directory skeleton precedes server progress. Waiting for it avoids
     // treating completed videos as pending and selecting a stale task index.
     const now=Date.now(),next=JSON.stringify(state.videos.map(v=>[v.key,v.completion]));
     if(!studyStarted)studyStarted=now;
     if(next!==signature){signature=next;stableSince=now;}
     if(!state.blockers.length&&(now-studyStarted<2000||now-stableSince<1000)){await entry.waitForTimeout(150);continue;}
     if(page!==entry)await adoptTaskPage(page,'video');
     return {page,entryPage:page!==entry?entry:null};
    }
   }
   await entry.waitForTimeout(150);
  }
  throw Error('智慧树未通过学堂入口打开课程，请查看保留的网页');
 }catch(error){
  for(const child of children)releasePage(child);
  releasePage(entry);throw Object.assign(error,{taskPage:page,entryPage:entry});
 }finally{entry.off('popup',onPopup);}
}
