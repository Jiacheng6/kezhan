// Completion classification and legacy recovery use synthetic local files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { courseCompletion, sectionCompletion, mergeTaskCompletion } from '../../src/ui/task-status.js';
fs.mkdirSync('.desktop-test',{recursive:true});
process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/course-groups-'));
const {PATHS,ensureDirs}=await import('../../src/config.mjs');
const {buildChecklist,loadReconReport}=await import('../../src/chaoxing/checklist.mjs');
const {reconToTaskReport}=await import('../../src/chaoxing/recon.mjs');
ensureDirs();
const now=new Date().toISOString();
const original=[
  {courseId:'done',clazzId:'class-done',name:'示例已完成课程',summary:{done:2,total:2},sections:[
    {knowledgeId:'done-section',secNo:'1.1',name:'已完成示例小节',done:true},
  ]},
  {courseId:'pending',clazzId:'class-pending',name:'示例待完成课程',summary:{done:1,total:2},sections:[
    {knowledgeId:'mixed',secNo:'1.2',name:'视频已完成，测验未完成',done:false,jobPending:1,taskPoints:[
      {type:'video',jobid:'video',idx:0,finished:true},
      {type:'work',jobid:'quiz',idx:1,finished:false},
    ]},
    {knowledgeId:'earlier',secNo:'1.1',name:'扫描前完成的小节',done:true},
  ]},
  {courseId:'partial',clazzId:'class-partial',name:'示例未读全课程',summary:{done:0,total:0},sections:[
    {knowledgeId:'unread',secNo:'2.1',name:'未读取小节',done:false,jobPending:1},
  ]},
  {courseId:'failed',clazzId:'class-failed',name:'示例读取失败课程',error:'synthetic scan error',sections:[]},
];
const report=reconToTaskReport(original);
assert.equal(report.courses[0].sections.length,1,'已完成课程的完整小节树保留');
assert.equal(report.courses[0].taskPoints.length,0,'不伪造已跳过任务的类型和数量');
fs.writeFileSync(PATHS.taskReport,JSON.stringify(report));
let checklist=buildChecklist({includeProgress:true});
assert.equal(checklist.courses[1].sections.length,2,'已完成小节与未完成小节都保留');
assert.deepEqual(checklist.courses.map(c=>courseCompletion(c).finished),[true,false,false,false]);
assert.equal(sectionCompletion(checklist.courses[1],checklist.courses[1].sections[0]).done,1);
assert.equal(sectionCompletion(checklist.courses[1],checklist.courses[1].sections[1]).finished,true);
assert.equal(courseCompletion({sections:[],tasks:[]}).finished,false,'0/0 不能判为完成');
assert.equal(courseCompletion({sectionTreeKnown:true,sections:[{knowledgeId:'a',done:true},{knowledgeId:'b',probed:false}],tasks:[]}).finished,false,'部分完成不能代替整门完成');
assert.equal(courseCompletion({sectionsProbed:20,sections:[{knowledgeId:'a'}],tasks:[{knowledgeId:'a',finished:true}]}).finished,false,'旧版不完整清单不能判整门完成');
assert.equal(sectionCompletion({sectionTreeKnown:true,tasks:[{knowledgeId:'a',finished:true}]},{knowledgeId:'a',pending:2,probed:true}).finished,false,'已读取任务少于平台待完成数量时保留待确认');
assert.equal(courseCompletion({...checklist.courses[1],platformSummary:{done:2,total:2}}).finished,false,'未完成明细优先于有冲突的完成汇总');

// Recover metadata from the same local scan, without touching original records.
const legacy=structuredClone(report);
legacy.at=now;
for(const c of legacy.courses)for(const key of ['sections','sectionTreeKnown','platformSummary','scanError'])delete c[key];
fs.writeFileSync(PATHS.taskReport,JSON.stringify(legacy));
const rawPath=path.join(PATHS.logs,'recon-synthetic.json');
fs.writeFileSync(rawPath,JSON.stringify({at:now,courses:original}));
const reportBefore=fs.readFileSync(PATHS.taskReport,'utf8'),rawBefore=fs.readFileSync(rawPath,'utf8');
loadReconReport({force:true});
checklist=buildChecklist({includeProgress:true});
assert.deepEqual(checklist.courses.map(c=>courseCompletion(c).finished),[true,false,false,false]);
assert.equal(checklist.courses[1].sections.length,2);
assert.equal(fs.readFileSync(PATHS.taskReport,'utf8'),reportBefore);
assert.equal(fs.readFileSync(rawPath,'utf8'),rawBefore);
assert.equal(fs.existsSync(PATHS.state),false,'读取展示不创建进度');
assert.equal(fs.existsSync(PATHS.selection),false,'读取展示不创建选择');

const differentClass=structuredClone(original);differentClass[0].clazzId='different';
fs.writeFileSync(rawPath,JSON.stringify({at:now,courses:differentClass}));
assert.equal(loadReconReport({force:true}).courses[0].sections,undefined,'不能跨班级恢复旧状态');
fs.writeFileSync(rawPath,JSON.stringify({at:'2020-01-01T00:00:00Z',courses:original}));
assert.equal(loadReconReport({force:true}).courses[0].sections,undefined,'不能复用不同时间的侦察状态');

// Fresh scans may omit task details for completed sections; preserve user edits.
const current={courses:[{courseId:'a',enabled:false,sections:[{knowledgeId:'s'}],tasks:[{key:'a:s:t0',knowledgeId:'s',finished:false,excluded:true}]}]};
const fresh={courses:[{courseId:'a',enabled:true,sectionTreeKnown:true,sections:[{knowledgeId:'s',done:true}],tasks:[]}]};
assert.equal(mergeTaskCompletion(current,fresh),true);
assert.equal(current.courses[0].enabled,false);
assert.equal(current.courses[0].tasks[0].excluded,true);
assert.equal(courseCompletion(current.courses[0]).finished,true);
assert.equal(current.courses[0].tasks[0].completion.finished,true);
assert.equal(mergeTaskCompletion(current,fresh),false);
console.log('✓ 完成分组：完整小节保留、混合任务状态、未知/失败防误判、旧清单只读恢复、刷新保留选择通过');
