// Platform data only. No fabricated time, score, or completion payloads.
export const WELEARN_ORIGIN='https://welearn.sflep.com';
export const WELEARN_HOME=WELEARN_ORIGIN+'/student/index.aspx';
export function platformId(value){
  const id=String(value??'');
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw Error('WeLearn 返回无效的课程或任务标识，原清单保留');
  return id;
}
export function courseIdentity({uid,cid,classid}){
  return {uid:platformId(uid),cid:platformId(cid),classid:platformId(classid)};
}
export function courseKey(meta){const m=courseIdentity(meta);return `welearn:${m.uid}:${m.cid}:${m.classid}`;}
export function lessonKey(meta,scoid){return courseKey(meta)+':'+platformId(scoid);}
export function studyUrl(meta,scoid){const m=courseIdentity(meta);return WELEARN_ORIGIN+'/Student/StudyCourse.aspx?'+new URLSearchParams({cid:m.cid,classid:m.classid,sco:platformId(scoid)});}
export function readMeta(html,cid){
  // Read literal object values only, not uid:function(), uid:stuid, etc.
  const values=name=>[...String(html).matchAll(new RegExp('(?:^|[\\s,{])["\\\']?'+name+'["\\\']?\\s*:\\s*(?:"([A-Za-z0-9_-]+)"|\\\'([A-Za-z0-9_-]+)\\\'|(\\d+)(?=\\s*[,}]))','g'))].map(m=>m[1]||m[2]||m[3]);
  const uid=[...new Set(values('uid'))],clazz=[...new Set(values('classid'))];
  if(uid.length!==1||clazz.length!==1)throw Error('WeLearn 课程身份不完整或有冲突，未扫描任务');
  return courseIdentity({uid:uid[0],cid,classid:clazz[0]});
}
export function normalizeLessons(rows,unitIndex){
  if(!Array.isArray(rows))throw Error('WeLearn 小节目录格式改变，原清单保留');
  const seen=new Set();
  return rows.map(row=>{
    const id=platformId(row?.id);if(seen.has(id))throw Error('WeLearn 小节编号重复，原清单保留');seen.add(id);
    const completion=String(row.iscomplete??'').trim();
    return {scoid:id,unitIndex,name:String(row.location||row.name||'学习小节'),
      visible:row.isvisible!==false&&String(row.isvisible).toLowerCase()!=='false',
      finished:completion==='已完成',completionText:completion,learnTime:String(row.learntime??''),scoreLabel:String(row.crate??'')};
  });
}
export function makeCourse(card,meta,units){
  const key=courseKey(meta),seen=new Set(),points=[];
  const sections=units.map((unit,index)=>{
    const sid=key+':unit:'+index,name=String(unit.unitname||unit.name||`Unit ${index+1}`);
    for(const [i,lesson]of unit.lessons.entries()){
      if(seen.has(lesson.scoid))throw Error('WeLearn 不同单元出现重复任务标识，未保存目录');seen.add(lesson.scoid);
      const oral=/口语|录音|朗读|pronunciation|oral practice|spoken english|read\s*aloud/i.test(lesson.name);
      const blocked=!lesson.visible?'平台尚未开放':oral?'需本人录音或口语作答':null;
      points.push({platform:'welearn',knowledgeId:sid,platformTaskKey:lessonKey(meta,lesson.scoid),platformNumber:`${index+1}.${i+1}`,
        secNo:`${index+1}.${i+1}`,sectionName:name,name:lesson.name,type:blocked?'welearn-manual':'study',typeName:blocked?'需本人处理':'课内学习',
        blockedReason:blocked,finished:lesson.finished,welearn:{...meta,scoid:lesson.scoid,unitIndex:index,learnTime:lesson.learnTime,scoreLabel:lesson.scoreLabel}});
    }
    return {knowledgeId:sid,secNo:String(index+1),name,taskCount:unit.lessons.length};
  });
  return {platform:'welearn',courseId:key,clazzId:meta.classid,name:String(card.name||'WeLearn 课程'),studyUrl:WELEARN_ORIGIN+'/student/course_info.aspx?cid='+encodeURIComponent(meta.cid),sectionTreeKnown:true,sections,taskPoints:points};
}
