import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.KEBO_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/ucampus-identity-'));
const {savePlatformCourses}=await import('../../src/platforms/catalog.mjs');const {buildChecklist}=await import('../../src/chaoxing/checklist.mjs');
const point={platform:'ucampus',knowledgeId:'node-demo',platformTaskKey:'node-demo',courseResourceId:'resource-demo',courseInstanceId:'instance-demo',unitIndex:5,nodeIndex:1,studyUrl:'https://ucontent.unipus.cn/pc.html#/instance-demo',secNo:'U5.1',name:'示例单词卡',type:'vocab-cards',finished:false};
savePlatformCourses('ucampus',[{platform:'ucampus',courseId:'ucampus:course-demo:class-demo',clazzId:'class-demo',name:'示例课程',studyUrl:'https://uai.unipus.cn/portal',taskPoints:[point]}]);
const task=buildChecklist().courses[0].tasks[0];
for(const key of ['courseResourceId','courseInstanceId','unitIndex','nodeIndex','studyUrl','platformTaskKey'])assert.equal(task[key],point[key],key+' 不得在清单转换时丢失或替换');
console.log('✓ U校园扫描 → 执行清单保留原教程、单元、节点和续学入口');
