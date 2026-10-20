import {readZhihuishuPage} from './read-page.mjs';
const popup=page=>page.getByRole('dialog',{name:'弹题测验',exact:true});
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
  const feedback=root.querySelector('.answer'),rect=feedback?.getBoundingClientRect();
  const feedbackShown=!!(rect?.width&&rect?.height)&&getComputedStyle(feedback).visibility!=='hidden';
  return {nonGraded:/不会影响.*作业.*考试.*成绩/.test(text(root.querySelector('.el-dialog__header'))),type,stem:text(copy),options,answered:feedbackShown&&options.some(o=>o.selected),page:text(root.querySelector('.el-pager .active')),pages:[...root.querySelectorAll('.el-pager .number')].map(text),supported:/判断题|单选题/.test(type)&&!!root.querySelector('.radio')};
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
  if(!current.answered){const selected=await choose(current),option=current.options.find(o=>o.letter===selected);if(!option)return {ok:false,phase:'needs-human',reason:'invalid-option',answered};
   const check=await readZhihuishuVideoPrompt(page);if(check?.stem!==current.stem||check?.page!==current.page)throw Error('弹题内容变化，未继续点击');
   await popup(page).locator('.topic-list .topic-item').nth(option.index).click();
   const deadline=Date.now()+5000;let confirmed=false;while(Date.now()<deadline){const r=await readZhihuishuVideoPrompt(page);if(r?.answered&&r.options.some(o=>o.letter===selected&&o.selected)){current=r;confirmed=true;break;}await page.waitForTimeout(100);}
   if(!confirmed)return {ok:false,phase:'needs-human',reason:'answer-not-confirmed',answered};
  }
  answered.push({page:current.page,letters:current.options.filter(o=>o.selected).map(o=>o.letter)});
 }
 const close=popup(page).locator('.el-dialog__footer .btn').filter({hasText:/^关闭$/});if(await close.count()!==1)return {ok:false,phase:'needs-human',reason:'close-button-missing',answered};
 await close.click();await popup(page).waitFor({state:'hidden',timeout:5000});
 const resumed=await resumeZhihuishuVideo(page,{expectedKey});return {...resumed,answered};
}
