import {readZhihuishuPage} from './read-page.mjs';
import {throwIfStopped} from '../../control.mjs';

export async function waitZhihuishuVideoReady(page,{expectedKey,previousSource,shouldStop,timeoutMs=20000}={}){
 const deadline=Date.now()+timeoutMs;let signature='',stableSince=0;
 while(Date.now()<deadline){
  throwIfStopped(shouldStop);const state=await readZhihuishuPage(page);
  if(state.blockers.length)throw Error(state.blockers.includes('progress-save-failed')?'智慧树提示学习进度提交失败，已停止播放，请查看原网页':'智慧树需要本人处理验证，已停止播放');
  if(state.videos.find(v=>v.active)?.key!==expectedKey){await page.waitForTimeout(100);continue;}
  const media=await page.locator('video').evaluateAll(vs=>vs.length===1?{source:vs[0].currentSrc,duration:vs[0].duration,readyState:vs[0].readyState,seeking:vs[0].seeking,error:vs[0].error?.code}:null);
  if(media?.error)throw Error('智慧树播放器报告媒体错误');
  if(!media?.source||!Number.isFinite(media.duration)||media.duration<=0||media.readyState<2||media.seeking||previousSource&&media.source===previousSource){signature='';await page.waitForTimeout(100);continue;}
  const next=JSON.stringify([expectedKey,media.source,media.duration]);if(next!==signature){signature=next;stableSince=Date.now();}
  if(Date.now()-stableSince>=700)return {ready:true};
  await page.waitForTimeout(100);
 }throw Error('所选智慧树视频尚未加载就绪，未操作旧播放器，请稍后继续');
}
// The SPA can keep hidden copies of old dialogs in the DOM.
const popup=page=>page.getByRole('dialog',{name:'弹题测验',exact:true}).filter({visible:true});
/** Only the observed, non-graded in-video dialog. Never handles coursework/exams. */
export async function readZhihuishuVideoPrompt(page){
 const state=await readZhihuishuPage(page);if(state.pageKind!=='study')return null;
 const d=popup(page);if(await d.count()!==1||!await d.isVisible())return null;
 return d.evaluate(root=>{
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const title=root.querySelector('.topic-title'),copy=title?.cloneNode(true);
  copy?.querySelectorAll('.right,.wrong,.title-tit').forEach(e=>e.remove());
  const options=[...root.querySelectorAll('.topic-list .topic-item')].map((e,index)=>({index,letter:text(e.querySelector('.topic-option-item')).replace(/[.．、]$/,''),text:text(e.querySelector('.item-topic')),selected:!!e.querySelector('.topic-option-item.active')}));
  const type=text(root.querySelector('.title-tit'));
  const multiple=/多选题/.test(type);
  const feedback=root.querySelector('.answer'),rect=feedback?.getBoundingClientRect();
  const feedbackShown=!!(rect?.width&&rect?.height)&&getComputedStyle(feedback).visibility!=='hidden';
  // The observed multi-select UI records a selection without showing .answer
  // when it is only part of the correct set. It still permits closing. This is
  // selection evidence only; task completion remains the platform's marker.
  return {nonGraded:/不会影响.*作业.*考试.*成绩/.test(text(root.querySelector('.el-dialog__header'))),type,multiple,feedbackShown,stem:text(copy),options,answered:(multiple||feedbackShown)&&options.some(o=>o.selected),page:text(root.querySelector('.el-pager .active')),pages:[...root.querySelectorAll('.el-pager .number')].map(text),supported:/判断题|单选题|多选题/.test(type)&&!!root.querySelector('.radio')};
 });
}
export async function resumeZhihuishuVideo(page,{expectedKey,timeoutMs=10000}={}){
 const state=await readZhihuishuPage(page),active=state.videos.find(v=>v.active);
 if(!expectedKey||active?.key!==expectedKey)throw Error('当前视频与指定任务不一致，已停止恢复播放');
 if(state.blockers.length) return {ok:false,phase:'needs-human',reason:'human-verification'};
 if(await readZhihuishuVideoPrompt(page))return {ok:false,phase:'needs-human',reason:'video-question-open'};
 const video=page.locator('video');if(await video.count()!==1)throw Error('无法唯一定位当前视频');
 const before=await video.evaluate(v=>({time:v.currentTime,paused:v.paused,ended:v.ended,error:v.error?.code||null}));
 if(before.error)throw Error('播放器报告媒体错误');if(before.ended)return {ok:true,phase:'ended'};
 if(before.paused){const area=page.locator('#vjs_container .videoArea');await area.waitFor({state:'visible',timeout:timeoutMs});if(await area.count()!==1)throw Error('无法唯一定位原生播放控件');await area.click({timeout:timeoutMs});}
 await page.waitForFunction(time=>{const v=document.querySelector('video');return v&&!v.error&&(!v.paused&&v.currentTime>time+0.25||v.ended);},before.time,{timeout:timeoutMs});
 return {ok:true,phase:'playing',before:before.time,after:await video.evaluate(v=>v.currentTime)};
}
export async function handleZhihuishuVideoPrompt(page,{expectedKey,choose=question=>question.options[0]?.letter,maxQuestions=20}={}){
 const state=await readZhihuishuPage(page);if(state.videos.find(v=>v.active)?.key!==expectedKey||!expectedKey)throw Error('弹题不属于当前指定视频');
 if(state.blockers.length)return {ok:false,phase:'needs-human',reason:'human-verification'};
 let current=await readZhihuishuVideoPrompt(page);if(!current)return {ok:false,phase:'no-prompt'};
 if(!current.nonGraded)return {ok:false,phase:'needs-human',reason:'unrecognized-question-context'};
 const pages=current.pages.length?current.pages:[''];if(pages.length>maxQuestions)return {ok:false,phase:'needs-human',reason:'too-many-questions'};
 const answered=[];
 for(const number of pages){
  if(number&&current.page!==number){await popup(page).locator('.el-pager .number').filter({hasText:new RegExp('^'+number+'$')}).click();current=await readZhihuishuVideoPrompt(page);}
  if(!current?.nonGraded||!current.supported)return {ok:false,phase:'needs-human',reason:'unsupported-question-type',answered};
  if(!current.answered){
   const selected=await choose(current),letters=Array.isArray(selected)?[...new Set(selected)]:[selected];
   const options=letters.map(letter=>current.options.find(o=>o.letter===letter));
   if(!letters.length||options.some(o=>!o)||(!current.multiple&&letters.length!==1))return {ok:false,phase:'needs-human',reason:'invalid-option',answered};
   const signature=q=>q?JSON.stringify([q.type,q.stem,q.page,q.options.map(o=>[o.letter,o.text])]):null;
   const expected=signature(current);
   for(const option of options){
    const check=await readZhihuishuVideoPrompt(page);if(signature(check)!==expected)throw Error('弹题内容变化，未继续点击');
    if(check.options.find(o=>o.letter===option.letter)?.selected)continue;
    const active=await readZhihuishuPage(page);
    if(active.blockers.length)return {ok:false,phase:'needs-human',reason:'human-verification',answered};
    if(active.videos.find(v=>v.active)?.key!==expectedKey)throw Error('弹题不属于当前指定视频');
    await popup(page).locator('.topic-list .topic-item').nth(option.index).click();
    const deadline=Date.now()+5000;let confirmed=false;
    while(Date.now()<deadline){
     const r=await readZhihuishuVideoPrompt(page);if(signature(r)!==expected)throw Error('弹题内容变化，未继续点击');
     if(r.answered&&r.options.some(o=>o.letter===option.letter&&o.selected)){current=r;confirmed=true;break;}
     await page.waitForTimeout(100);
    }
    if(!confirmed)return {ok:false,phase:'needs-human',reason:'answer-not-confirmed',answered};
   }
  }
  answered.push({page:current.page,letters:current.options.filter(o=>o.selected).map(o=>o.letter)});
 }
 const close=popup(page).locator('.el-dialog__footer .btn').filter({hasText:/^关闭$/});if(await close.count()!==1)return {ok:false,phase:'needs-human',reason:'close-button-missing',answered};
 try { await close.click({timeout:1500}); }
 catch(error){
  // A fixed-height dialog footer may fall below the embedded viewport. Only
  // activate this exact non-graded close control after all answers are confirmed.
  const check=await readZhihuishuVideoPrompt(page);
  if(!check?.nonGraded||!check.answered||await close.count()!==1||!await close.isVisible())throw error;
  const refreshed=await readZhihuishuPage(page);
  if(refreshed.blockers.length||refreshed.videos.find(v=>v.active)?.key!==expectedKey)throw error;
  await close.evaluate(element=>element.click());
 }
 await popup(page).waitFor({state:'hidden',timeout:5000});
 const resumed=await resumeZhihuishuVideo(page,{expectedKey});return {...resumed,answered};
}
