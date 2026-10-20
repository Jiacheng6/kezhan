/** Read-only Zhihuishu compatibility probe. Not wired to the Chaoxing runner. */
export function isZhihuishuUrl(value) {
  try { const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='zhihuishu.com'||u.hostname.endsWith('.zhihuishu.com')); } catch {return false;}
}
// Serializable DOM reader: no cookies, application internals, requests or mutations.
export function readZhihuishuDocument() {
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const visible=e=>{for(let n=e;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0||n.hidden)return false;}const r=e?.getBoundingClientRect();return !!(r?.width&&r?.height);};
  const siteURL=value=>{try{const u=new URL(value,location.href);return u.protocol==='https:'&&(u.hostname==='zhihuishu.com'||u.hostname.endsWith('.zhihuishu.com'))?u:null;}catch{return null;}};
  const identity=container=>{for(const a of container.querySelectorAll('a[href]')){const u=siteURL(a.getAttribute('href'));if(u?.searchParams.has('courseId')&&u.searchParams.has('recruitId'))return {courseId:u.searchParams.get('courseId'),recruitId:u.searchParams.get('recruitId')};}return null;};
  const key=id=>id?`zhihuishu:${encodeURIComponent(id.courseId)}:${encodeURIComponent(id.recruitId)}`:null;
  const inViewport=e=>{const r=e.getBoundingClientRect();return visible(e)&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
  const blockers=[];
  if([...document.querySelectorAll('div,h1,h2,h3,span')].some(e=>text(e)==='在线学习诚信承诺书'&&visible(e)))blockers.push('user-consent');
  if([...document.querySelectorAll('iframe')].some(e=>/captcha/i.test(e.src)&&inViewport(e)))blockers.push('human-verification');
  const courses=[...document.querySelectorAll('#sharingClassed dl,#flipLessoned dl')].filter(e=>e.querySelector('.courseName')).map(e=>{
    const id=identity(e),raw=text(e.querySelector('.processNum')),n=/^(\d+(?:\.\d+)?)%$/.exec(raw);
    return {platform:'zhihuishu',key:key(id),...id,name:text(e.querySelector('.courseName')),kind:e.closest('#sharingClassed')?'shared':'flipped',progress:n&&Number(n[1])<=100?Number(n[1]):null};
  });
  const course=identity(document),courseKey=key(course);
  const videos=[...document.querySelectorAll('li.video')].map((e,index)=>({platform:'zhihuishu',key:courseKey?`${courseKey}:video:${text(e.querySelector('.hour'))||index}`:null,type:'video',number:text(e.querySelector('.hour')),name:text(e.querySelector('.catalogue_title')),durationText:text(e.querySelector('.time')),completion:e.querySelector('.time_icofinish')?'completed':'pending',active:e.classList.contains('current_play')}));
  const chapterTests=[...document.querySelectorAll('li.chapter-test')].map((e,index)=>{
    let chapter=e.previousElementSibling;while(chapter&&!chapter.matches('li.chapter'))chapter=chapter.previousElementSibling;
    const number=text(chapter?.querySelector('.catalogue_title3')),chapterName=text(chapter?.querySelector('.catalogue_title'));
    const name=text(e.querySelector('.name'));
    return {index,number,chapterName,name,key:courseKey&&number&&name?`${courseKey}:test:${encodeURIComponent(number)}:${encodeURIComponent(name)}`:null};
  });
  const submittedList=!!document.querySelector('#examStateTabYsj.cur')&&!document.querySelector('#examStateTabWsj.cur');
  const assignments=[...document.querySelectorAll('.examItemWrap')].filter(visible).map(e=>{
    const action=text(e.querySelector('.examChartBox1'))||text(e.querySelector('.jobExamComBtn'));
    const grade=text(e.querySelector('.examProgress2 .font55 > span'));const score=submittedList&&/^\d+(?:\.\d+)?$/.test(grade)?Number(grade):null;
    const fields={};for(const row of e.querySelectorAll('.examInfoList li')){const label=text(row.querySelector('label'));if(label)fields[label.replace(/\s/g,'')]=text(row.querySelector('span'));}
    return {platform:'zhihuishu',name:text(e.querySelector('.course_ewname')),kind:text(e.querySelector('.percentage_number,.course_ewstateb')),action,score,submissionState:submittedList?'submitted':/开始答题|继续答题/.test(action)?'not-submitted':/查看成绩|查看试卷|已提交/.test(action)?'submitted':'unknown',fields};
  });
  const players=[...document.querySelectorAll('video')].map(v=>({paused:v.paused,currentTime:Number.isFinite(v.currentTime)?v.currentTime:null,duration:Number.isFinite(v.duration)?v.duration:null,readyState:v.readyState,rate:v.playbackRate,error:v.error?.code||null}));
  let pageKind='unknown';
  if(['login.zhihuishu.com','passport.zhihuishu.com'].includes(location.hostname))pageKind='login';
  else if(document.querySelector('#student-page'))pageKind='home';
  else if(videos.length)pageKind='study';
  else if(location.hostname==='onlineexamh5new.zhihuishu.com'&&document.querySelector('.examBox'))pageKind='assignments';
  return {platform:'zhihuishu',pageKind,loginState:pageKind==='login'?'signed-out':['home','study','assignments'].includes(pageKind)?'signed-in':'unknown',blockers,courses,course:course?{...course,key:courseKey}:null,videos,chapterTests,chapterTestCount:chapterTests.length,assignments,players};
}
export async function readZhihuishuPage(page) {
  if(!isZhihuishuUrl(page.url()))throw new Error('仅允许读取智慧树 HTTPS 页面');
  const result=await page.evaluate(readZhihuishuDocument);
  if(!isZhihuishuUrl(page.url()))throw new Error('页面已离开智慧树，忽略此次结果');
  return result;
}
