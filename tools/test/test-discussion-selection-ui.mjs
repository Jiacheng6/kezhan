// Real desktop UI with isolated fictional courses; no platform access or task execution.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {_electron as electron} from 'playwright-core';
import {enterTestWorkspace,requestTestExit} from './desktop-test-helpers.mjs';
const data=fs.mkdtempSync(path.resolve('.desktop-test/discussion-selection-'));
fs.mkdirSync(path.join(data,'data/probe-out'),{recursive:true});
fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({onboarding:{version:2,completedAt:new Date().toISOString()},settings:{}}));
fs.writeFileSync(path.join(data,'data/probe-out/task-report.json'),JSON.stringify({at:new Date().toISOString(),courses:[{courseId:'course',clazzId:'class',name:'示例课程',taskPoints:[{knowledgeId:'section',secNo:'1.1',sectionName:'示例章节',type:'video',name:'示例视频',finished:false},...['甲','乙'].map((n,i)=>({knowledgeId:'section',secNo:'1.1',sectionName:'示例章节',type:'discuss',name:'示例讨论'+n,discussionId:'topic-'+i,tracking:true,finished:false}))]}]}));
const app=await electron.launch({executablePath:process.env.XXT_SELECTION_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:process.env.XXT_SELECTION_TEST_EXE?['--test-mode']:[process.cwd(),'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
try{
 const ui=await app.firstWindow();await ui.waitForURL('http://127.0.0.1:*/');await enterTestWorkspace(ui);await ui.locator('[data-tab="courses"]').click();
 const first=ui.getByRole('checkbox',{name:'选择任务 示例讨论甲',exact:true});await first.waitFor();assert.equal(await first.isDisabled(),true);
 assert.equal(await ui.getByText('需开启讨论草稿',{exact:true}).count(),2);
 await ui.getByRole('button',{name:'开启讨论草稿 →',exact:true}).first().click();
 const setting=ui.getByRole('checkbox',{name:'生成讨论草稿',exact:true});await setting.waitFor();await setting.check();await ui.locator('#saveSettings').click();
 await ui.locator('[data-tab="courses"]').click();await first.waitFor();await ui.waitForFunction(()=>!document.querySelector('#deskTasks input[aria-label="选择任务 示例讨论甲"]').disabled);
 assert.equal(await first.isChecked(),false,'开启功能不能自动勾选所有讨论');
 assert.equal(await ui.getByRole('checkbox',{name:'选择任务 示例讨论乙',exact:true}).isChecked(),false);
 await first.check();assert.equal(await first.isChecked(),true);await ui.locator('#deskSave').click();
 await ui.reload();await enterTestWorkspace(ui);await ui.locator('[data-tab="courses"]').click();assert.equal(await first.isChecked(),true);
 assert.equal(await ui.getByRole('checkbox',{name:'选择任务 示例讨论乙',exact:true}).isChecked(),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'))).settings.discussionDrafts,true);
 await ui.screenshot({path:path.join(data,'discussion-selectable.png')});
 console.log('✓ 讨论未开启原因可见、直达开关、保存即解锁、保留原范围、不自动全选、逐项选择持久化通过');
}finally{await requestTestExit(app).catch(()=>{});await app.close().catch(()=>{});}
