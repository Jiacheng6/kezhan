export function platformSkipReason(task={}){
 if(task.platform==='welearn'&&(task.type==='welearn-manual'||/需本人|录音|口语/.test(task.blockedReason||'')))return task.blockedReason||'需本人处理，按设置跳过';
 if(task.platform==='ucampus'&&/听力|listening/i.test([task.tutorialName,task.courseInstanceId,task.sectionName,task.name].filter(Boolean).join(' ')))return '听力任务，按设置跳过';
 return null;
}
