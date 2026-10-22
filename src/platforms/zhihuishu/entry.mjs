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
export async function openZhihuishuStudy(context,task,{shouldStop}={}){
 const entry=await newTaskPage(context,'video-entry'),children=[];let page=entry;
 const onPopup=child=>children.push(child);entry.on('popup',onPopup);
 try{
  await entry.goto('https://onlineweb.zhihuishu.com/onlinestuh5',{waitUntil:'domcontentloaded',timeout:45000});
  const deadline=Date.now()+35000;let clicked=false,studyStarted=0,stableSince=0,signature='';
  while(Date.now()<deadline){
   throwIfStopped(shouldStop);
   if(!isZhihuishuUrl(entry.url()))throw Error('智慧树入口已离开课程平台，未继续');
   let state=await readEntry(entry);
   if(!state){await entry.waitForTimeout(150);continue;}
   if(state.loginState==='signed-out')throw Error('智慧树登录已失效，请在软件内重新登录');
   if(state.blockers.length)throw Error('智慧树入口需要本人处理验证或承诺书，请查看保留页面');
   if(!clicked&&state.pageKind==='home'&&state.courses.length){
    const indices=state.courses.map((c,i)=>c.key===task.courseId?i:-1).filter(i=>i>=0);
    if(indices.length!==1)throw Error('智慧树学堂中无法唯一匹配这门课程，请重新扫描');
    if(state.courses[indices[0]].kind!=='shared')throw Error('此课程类型的播放入口尚未适配');
    await dismissZhihuishuNotices(entry);
    await entry.locator('#sharingClassed dl,#flipLessoned dl').filter({has:entry.locator('.courseName')}).nth(indices[0]).locator('.courseName').click({timeout:10000});
    clicked=true;
   }
   for(const child of children){
    if(child.isClosed())continue;
    if(child.url()==='about:blank')continue;
    if(!isZhihuishuUrl(child.url()))throw Error('课程入口打开了未知页面，未控制该页面');
    if(new URL(child.url()).hostname==='studyvideoh5.zhihuishu.com'){page=child;break;}
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
