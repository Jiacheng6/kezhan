// 任务点完成状态与勾选范围分别计算，小节未完成不代表其中的视频未完成。
export function taskCompletion(task, progress = null) {
  if (task.finished === true || (task.sectionDone === true&&task.type!=='discuss') || progress?.status === 'done') {
    return { state: 'done', label: task.type==='discuss'?'已参与':'已完成', finished: true,
      source: task.finished === true || task.sectionDone === true&&task.type!=='discuss' ? 'platform' : 'local' };
  }
  const labels = { running: '执行中', manual: task.type === 'work' ? '待你核对' : '待你处理',
    failed: '执行失败', skipped: '已跳过' };
  const status = progress?.status;
  return { state: labels[status] ? status : task.finished === false ? 'pending' : 'unknown',
    label: labels[status] || (task.finished === false ? '未完成' : '待确认'),
    finished: false, source: status ? 'local' : 'platform' };
}

export function completionOf(task) {
  return task.completion || taskCompletion(task);
}

export function completionCounts(tasks) {
  const total = (tasks || []).length;
  const done = (tasks || []).filter((t) => completionOf(t).finished).length;
  return { total, done, remaining: total - done };
}

export function sectionCompletion(course,section) {
  const tasks=(course.tasks||[]).filter(t=>t.knowledgeId===section.knowledgeId);
  const counts=completionCounts(tasks);
  if(section.done===true)return {finished:true,state:'done',label:'已完成',...counts};
  if(section.scanError)return {finished:false,state:'unknown',label:'读取失败，待确认',...counts};
  if(counts.total&&counts.remaining===0&&!(section.pending>counts.total)&&(section.probed!==false||!course.sectionTreeKnown))return {finished:true,state:'done',label:'已完成',...counts};
  if(section.probed&&counts.total===0&&section.pending===0)return {finished:false,state:'no-tasks',label:'无任务点',...counts};
  return {finished:false,state:counts.total?'pending':'unknown',label:counts.total?'待完成':'任务详情未读取',...counts};
}

export function courseCompletion(course) {
  const counts=completionCounts(course.tasks||[]),sections=course.sections||[];
  const states=sections.map(section=>sectionCompletion(course,section));
  const completedSections=states.filter(state=>state.finished).length;
  const common={...counts,completedSections,totalSections:sections.length};
  if(course.empty)return {...common,finished:false,state:'unknown',label:'无章节内容'};
  if(course.scanError)return {...common,finished:false,state:'unknown',label:'读取失败，待确认'};
  if(course.sectionTreeKnown){
    const allSections=sections.length>0&&completedSections>0&&states.every(state=>state.finished||state.state==='no-tasks');
    const summary=course.platformSummary;
    const platformDone=summary?.total>0&&summary.done===summary.total
      &&!states.some((state,index)=>state.state==='pending'||state.state==='unknown'&&sections[index].pending>0)
      &&!sections.some(section=>section.scanError);
    if(allSections||platformDone)return {...common,finished:true,state:'done',label:'已完成'};
    return {...common,finished:false,state:states.some(state=>state.state==='unknown')?'unknown':'pending',label:states.some(state=>state.state==='unknown')?'待完成／待确认':'待完成'};
  }
  const completeCoverage=course.sectionsProbed==null||course.sectionsProbed<=sections.length;
  const finished=counts.total>0&&counts.remaining===0&&completeCoverage;
  return {...common,finished,state:finished?'done':counts.remaining?'pending':'unknown',label:finished?'已完成':counts.remaining?'待完成':'待确认'};
}

// 刷新时只更新状态，不覆盖用户尚未保存的勾选、排序或课程开关。
export function mergeTaskCompletion(current, fresh) {
  const byCourse=new Map((fresh.courses||[]).map(course=>[course.courseId,course]));
  const byKey = new Map((fresh.courses || []).flatMap((c) => c.tasks || []).map((t) => [t.key, t]));
  let changed = false;
  for (const course of current.courses || []) {
    const nextCourse=byCourse.get(course.courseId);
    if(!nextCourse)continue;
    course.sections??=[];course.tasks??=[];
    for(const key of ['sectionTreeKnown','platformSummary','scanError','sectionsProbed']){
      if(JSON.stringify(course[key])!==JSON.stringify(nextCourse[key])){course[key]=nextCourse[key];changed=true;}
    }
    for(const nextSection of nextCourse.sections||[]){
      const section=course.sections.find(section=>section.knowledgeId===nextSection.knowledgeId);
      if(!section){course.sections.push({...nextSection});changed=true;}
      else if(JSON.stringify(section)!==JSON.stringify(nextSection)){Object.assign(section,nextSection);changed=true;}
    }
    const keys=new Set((course.tasks||[]).map(task=>task.key));
    for(const task of nextCourse.tasks||[])if(!keys.has(task.key)){course.tasks.push({...task,willHandle:course.enabled!==false&&task.policyHandle!==false&&!task.excluded});changed=true;}
    for (const task of course.tasks || []) {
    const next = byKey.get(task.key)||((nextCourse.sections||[]).some(section=>section.knowledgeId===task.knowledgeId&&section.done)?{...task,completion:taskCompletion({...task,sectionDone:true})}:null);
    if (!next) continue;
    for(const field of ['policyHandle','policy','blockedReason'])if(task[field]!==next[field]){
      if(field==='policyHandle'&&task.policyHandle===false&&next.policyHandle!==false)task.excluded=true;
      task[field]=next[field];changed=true;
      task.willHandle=course.enabled!==false&&task.policyHandle!==false&&!task.excluded;
    }
    const completion = completionOf(next);
    if (JSON.stringify(completionOf(task)) !== JSON.stringify(completion)) {
      task.completion = completion;
      changed = true;
    }
    }
  }
  const ids=new Set((current.courses||[]).map(course=>course.courseId));
  for(const course of fresh.courses||[])if(!ids.has(course.courseId)){current.courses.push(course);changed=true;}
  if(changed&&current.summary){current.summary={...fresh.summary,totalCourses:current.courses.length,totalTasks:current.courses.reduce((n,course)=>n+(course.tasks||[]).length,0)};}
  return changed;
}
