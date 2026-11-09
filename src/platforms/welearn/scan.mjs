import {newTaskPage,releasePage} from '../../browser/pages.mjs';
import {throwIfStopped,interruptibleSleep} from '../../control.mjs';
import {savePlatformCourses} from '../catalog.mjs';
import {readCourses,readUnits,readLessons} from './api.mjs';
import {WELEARN_HOME,WELEARN_ORIGIN,readMeta,makeCourse} from './policy.mjs';
export async function ensureWelearnPage(context){
  if(!context)throw Error('内置网页尚未就绪');
  let page=context.pages().find(p=>!p.isClosed()&&p.url().startsWith(WELEARN_ORIGIN+'/')&&!/StudyCourse\.aspx/i.test(p.url()));
  if(!page){page=await context.newPage();await page.goto(WELEARN_HOME,{waitUntil:'domcontentloaded',timeout:45000});}
  return page;
}
export async function readCourseIdentity(page,cid,{shouldStop}={}){
  throwIfStopped(shouldStop);
  await page.goto(WELEARN_ORIGIN+'/student/course_info.aspx?cid='+encodeURIComponent(cid),{waitUntil:'domcontentloaded',timeout:45000});
  if(new URL(page.url()).origin!==WELEARN_ORIGIN||/login|passport|signin/i.test(new URL(page.url()).pathname))throw Object.assign(Error('WeLearn 需要重新登录，原清单保留'),{code:'AUTH_EXPIRED',retryable:false});
  return readMeta(await page.content(),cid);
}
export async function scanWelearnCourses(context,{shouldStop=()=>false,onProgress=()=>{}}={}){
  const home=await ensureWelearnPage(context),cards=await readCourses(home,{shouldStop});
  if(!cards.length)throw Error('WeLearn 当前账号没有可读取的课程，原清单保留');
  const page=await newTaskPage(context,'recon-course'),courses=[];let keep=false;
  try{
    // Course information only; never open StudyCourse or simulate completion.
    await page.addInitScript(()=>{HTMLMediaElement.prototype.play=()=>Promise.resolve();});
    for(const [index,card]of cards.entries()){
      throwIfStopped(shouldStop);onProgress({index:index+1,total:cards.length,detail:'读取课程与单元'});
      const meta=await readCourseIdentity(page,card.cid,{shouldStop}),units=await readUnits(page,meta,{shouldStop}),full=[];
      for(const [unitIndex,unit]of units.entries()){
        throwIfStopped(shouldStop);onProgress({index:index+1,total:cards.length,unitIndex:unitIndex+1,unitTotal:units.length,detail:'读取小节完成状态'});
        full.push({...unit,lessons:await readLessons(page,meta,unitIndex,{shouldStop})});await interruptibleSleep(150,shouldStop);
      }
      courses.push(makeCourse(card,meta,full));
    }
    throwIfStopped(shouldStop);savePlatformCourses('welearn',courses);
    return {courses:courses.length,nodes:courses.reduce((n,c)=>n+c.taskPoints.length,0)};
  }catch(error){keep=error.code==='AUTH_EXPIRED';throw error;}
  finally{releasePage(page);if(!keep)await page.close().catch(()=>{});}
}
