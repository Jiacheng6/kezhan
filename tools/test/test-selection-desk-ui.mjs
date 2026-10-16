import { requestTestExit } from './desktop-test-helpers.mjs';
// Actual desktop UI, isolated synthetic courses, no real account or task execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=process.cwd(), output=path.join(root,'.desktop-test/selection-desk');fs.mkdirSync(output,{recursive:true});
const data=fs.mkdtempSync(path.join(root,'.desktop-test/selection-ui-'));
fs.mkdirSync(path.join(data,'data/probe-out'),{recursive:true});
const names=['设计与日常生活','大学英语 · 听说与表达','计算机系统导论','信息检索与学术写作'];
const sections=['从身边的事物开始','观察、理解与表达','把想法变成实践'];
const courses=names.map((name,c)=>({courseId:'fixture-course-'+c,clazzId:'fixture-class-'+c,name,sectionTreeKnown:true,
  sections:sections.map((name,s)=>({knowledgeId:`fixture-${c}-${s}`,secNo:'1.'+(s+1),name,done:false,probed:true,pending:2})),
  taskPoints:sections.flatMap((sectionName,s)=>['video','work'].map((type,t)=>({knowledgeId:`fixture-${c}-${s}`,secNo:'1.'+(s+1),sectionName,type,typeName:t?'章节测验':'视频',name:t?'章节测验':sectionName+' · 视频',finished:c===0&&t===0&&s<2,cardNum:t}))) }));
courses.push({courseId:'fixture-finished',clazzId:'fixture-finished-class',name:'已修完的示例课程',sectionTreeKnown:true,sections:[{knowledgeId:'finished-sec',secNo:'1.1',name:'已完成小节',done:true,probed:false}],taskPoints:[]},
  {courseId:'fixture-unknown',clazzId:'fixture-unknown-class',name:'待读取的示例课程',sectionTreeKnown:true,sections:[{knowledgeId:'unknown-sec',secNo:'1.1',name:'未读取小节',done:false,probed:false,pending:1}],taskPoints:[]});
const report={at:'2026-01-01T00:00:00Z',courses};
const reportFile=path.join(data,'data/probe-out/task-report.json');fs.writeFileSync(reportFile,JSON.stringify(report));
const packagedExe=process.env.XXT_SELECTION_TEST_EXE;
const application=await electron.launch({executablePath:packagedExe||path.join(root,'node_modules/electron/dist/electron.exe'),args:[...(packagedExe?[]:[root]),'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
const errors=[],actions=[];let holding=false;
try {
  const page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await page.evaluate(()=>localStorage.setItem('xxt-library-startup','skip'));
  const initial=await page.evaluate(()=>fetch('/api/status').then(r=>r.json()));
  const status={...initial,bootError:null,ready:true,edge:{connected:true},login:{loggedIn:true},qianwen:{loggedIn:true},account:{},running:false,reconRunning:false};
  const sockets=new Set();
  await page.route('**/api/status',route=>route.fulfill({json:status}));
  await page.routeWebSocket('**/ws',ws=>{sockets.add(ws);ws.send(JSON.stringify({type:'status',data:status}));ws.onClose(()=>sockets.delete(ws));});
  await page.route('**/api/action/*',async route=>{const action=new URL(route.request().url()).pathname.split('/').pop();actions.push(action);if(action==='startRun'){status.running=true;status.progress={done:2,total:9,current:'示例课程 · 正在处理任务',percent:2/9};status.runStats={done:2,total:9};}if(action==='stopRun')status.running=false;await route.fulfill({json:{ok:true}});for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));});
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1360,940);w.showInactive();});
  await page.reload();await page.locator('[data-tab=courses]').click();
  await page.locator('#deskCourseTitle').filter({hasText:names[0]}).waitFor();
  await page.waitForFunction(()=>!document.getElementById('deskCreatePreset').disabled);
  const selection=()=>page.evaluate(()=>window.__console.tree.data.courses.map(c=>({id:c.courseId,enabled:c.enabled,tasks:c.tasks.filter(t=>t.willHandle).map(t=>t.key)})));
  assert.equal(await page.locator('#deskQuickRules').getAttribute('open'),null);
  assert.equal(await page.locator('#deskPresetsPanel').getAttribute('open'),null);
  assert.equal(await page.locator('#workspaceUtilities').getAttribute('open'),null);
  assert.equal(await page.locator('#deskRunActions [data-action=startRun]').isVisible(),true);
  const before=await selection();
  await page.screenshot({path:path.join(output,'focus-initial.png'),animations:'disabled'});
  await page.locator('#deskQuickRules > summary').click();
  await page.locator('#deskCourses [data-sd-course-id=fixture-course-1] button').click();
  assert.deepEqual(await selection(),before,'切换当前课程不改动勾选');
  await page.locator('#deskCourses [data-sd-course-id=fixture-course-0] button').click();
  await page.locator('#deskRules [data-rule=video]').click();
  await page.locator('#deskRuleScope').selectOption('all');
  assert.deepEqual(await selection(),before,'快捷规则先预览');
  assert.match(await page.locator('#deskRulePreview').innerText(),/保留 10 项/);
  await page.locator('#deskApplyRule').click();assert.equal(await page.locator('#deskTotal').innerText(),'10');
  const videoSelection=await selection();
  await page.locator('#deskUndo').click();assert.deepEqual(await selection(),before);
  await page.locator('#deskApplyRule').click();assert.deepEqual(await selection(),videoSelection);
  await page.locator('#deskPresetsPanel > summary').click();await page.locator('#deskPresetName').fill('示例 · 视频学习');await page.locator('#deskCreatePreset').click();
  await page.locator('#deskPresetCount').filter({hasText:'1 / 20'}).waitFor();
  const presetId=await page.locator('#deskPreset').inputValue();assert.ok(presetId);
  await page.locator('#deskSave').click();await page.locator('#deskDirty').filter({hasText:'开始时会使用当前选课范围'}).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'recon-selection.json'),'utf8')).presets.length,1);
  await page.locator('#deskQuickRules > summary').click();await page.locator('#deskPresetsPanel > summary').click();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'desktop.png'),fullPage:false,animations:'disabled'});
  await page.locator('#deskQuickRules > summary').click();await page.locator('#deskPresetsPanel > summary').click();
  await page.locator('#deskRules [data-rule=work]').click();await page.locator('#deskApplyRule').click();assert.equal(await page.locator('#deskTotal').innerText(),'12');
  await page.locator('#deskLoadPreset').click();assert.deepEqual(await selection(),videoSelection);assert.match(await page.locator('#deskFeedback').innerText(),/已载入/);
  await page.locator('#deskPresetName').fill('示例 · 改名');await page.locator('#deskManage summary').click();await page.locator('#deskRenamePreset').click();
  await page.locator('#deskPreset option:checked').filter({hasText:'示例 · 改名'}).waitFor({state:'attached'});
  // A changed or added task is never silently included by an old snapshot.
  report.courses[0].taskPoints[4].name='示例发生变化的视频';
  report.courses[1].taskPoints.push({knowledgeId:'fixture-1-2',secNo:'1.3',sectionName:sections[2],name:'示例新增视频',type:'video',finished:false});
  fs.writeFileSync(reportFile,JSON.stringify(report));
  await page.reload();await page.locator('[data-tab=courses]').click();await page.waitForFunction(()=>!document.getElementById('deskPreset').disabled);
  await page.locator('#deskPresetsPanel > summary').click();await page.locator('#deskPreset').selectOption(presetId);await page.locator('#deskLoadPreset').click();
  assert.match(await page.locator('#deskFeedback').innerText(),/缺失或变化/);assert.match(await page.locator('#deskFeedback').innerText(),/未自动勾选/);
  assert.equal(await page.locator('#deskTotal').innerText(),'9');
  await page.locator('#deskTaskStatus').selectOption('all');await page.locator('#deskTaskSearch').fill('示例发生变化');
  assert.equal(await page.locator('#deskTasks .sd-task').count(),1);assert.equal(await page.locator('#deskTasks input[type=checkbox]').last().isChecked(),false);
  await page.locator('#deskTaskSearch').fill('');
  await page.locator('.sd-completed-courses > summary').click();await page.locator('#deskCourses [data-sd-course-id=fixture-finished] button').click();await page.locator('#deskTaskStatus').selectOption('all');
  assert.match(await page.locator('#deskTasks').innerText(),/平台已标记完成/);
  await page.locator('#deskCourses [data-sd-course-id=fixture-unknown] button').click();assert.match(await page.locator('#deskTasks').innerText(),/未读取/);
  await page.locator('#deskCourses [data-sd-course-id=fixture-course-0] button').click();
  await page.locator('#deskQuickRules > summary').click();await page.locator('#deskRules [data-rule=range]').click();await page.locator('#deskFrom').fill('bad');assert.equal(await page.locator('#deskApplyRule').isDisabled(),true);
  await page.locator('#deskFrom').fill('1.2');await page.locator('#deskTo').fill('1.3');assert.equal(await page.locator('#deskApplyRule').isEnabled(),true);
  await page.locator('#deskRuleScope').selectOption('current');
  // Running guard keeps inputs and actual selection consistent.
  const priorRun=await selection();status.running=true;for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));
  await page.waitForFunction(()=>document.getElementById('deskApplyRule').disabled);
  assert.equal(await page.locator('#deskLoadPreset').isDisabled(),true);assert.equal(await page.locator('#deskTasks input[type=checkbox]').first().isDisabled(),true);assert.deepEqual(await selection(),priorRun);
  status.running=false;for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));await page.waitForFunction(()=>!document.getElementById('deskApplyRule').disabled);
  await page.locator('#deskRules [data-rule=video]').click();
  await page.locator('#deskLegacy').click();assert.equal(await page.locator('#legacyCourseTree').isVisible(),true);
  assert.equal(await page.locator('#legacySession [data-action=startRun]').isVisible(),true,'树状视图保留开始入口');
  await page.locator('#deskReturn').click();assert.equal(await page.locator('#selectionDesk').isVisible(),true);
  // Failed persistence is visible and must not clear the selection or the name.
  await page.route('**/api/selection/presets',route=>route.request().method()==='POST'?route.fulfill({json:{ok:false,error:'示例磁盘写入失败'}}):route.continue());
  await page.locator('#deskPresetName').fill('示例保存失败');await page.locator('#deskCreatePreset').click();
  await page.locator('#deskFeedback').filter({hasText:'示例磁盘写入失败'}).waitFor();assert.equal(await page.locator('#deskPresetName').inputValue(),'示例保存失败');
  await page.unroute('**/api/selection/presets');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setMinimumSize(600,500));
  for(const width of [1240,1000,760]){
    await application.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,940),width);
    await page.waitForTimeout(120);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow '+width);
    await page.screenshot({path:path.join(output,'width-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1360,940));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#deskCourses input[type=checkbox]').first().focus();assert.ok(parseFloat(await page.locator('#deskCourses input[type=checkbox]').first().evaluate(e=>getComputedStyle(e).outlineWidth))>=2);
  assert.deepEqual(errors,[]);assert.deepEqual(actions,[],'选课与方案操作不得触发任务执行');
  // Exercise the actual moved start/stop controls against mocked task actions.
  for(const id of ['deskQuickRules','deskPresetsPanel'])if(await page.locator('#'+id).evaluate(e=>e.open))await page.locator('#'+id+' > summary').click();
  await page.locator('#deskRunActions [data-action=startRun]').click();
  await page.locator('#deskRunState').filter({hasText:'进行中'}).waitFor();
  assert.equal(await page.locator('#deskRunActions [data-action=startRun]').isVisible(),false);
  assert.equal(await page.locator('#deskRunActions [data-action=stopRun]').isVisible(),true);
  assert.match(await page.locator('#deskProgress').innerText(),/完成 2\/9/);
  await page.screenshot({path:path.join(output,'focus-running.png'),animations:'disabled'});
  await page.locator('#deskRunActions [data-action=stopRun]').click();await page.locator('#deskRunState').filter({hasText:'已停止'}).waitFor();
  assert.deepEqual(actions,['startRun','stopRun']);
  await page.locator('#deskTasks input[type=checkbox]').last().click();
  await page.route('**/api/selection',route=>route.fulfill({json:{ok:false,error:'示例选择保存失败'}}));
  await page.locator('#deskRunActions [data-action=startRun]').click();
  await page.locator('#deskFeedback').filter({hasText:'示例选择保存失败'}).waitFor();
  assert.deepEqual(actions,['startRun','stopRun'],'保存失败不得开始任务');await page.unroute('**/api/selection');
  status.login.loggedIn=false;for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));
  await page.waitForFunction(()=>document.querySelector('#deskRunActions [data-action=startRun]').disabled);
  await page.locator('#deskConnect').click();assert.equal(await page.locator('#panel-overview').isVisible(),true);
  await page.locator('[data-tab=courses]').click();assert.deepEqual(errors,[]);
  status.progress={done:0,total:0,current:null};status.runStats=null;
  await page.route('**/api/checklist',route=>route.fulfill({json:{ok:true,result:null}}));
  await page.reload();await page.locator('#deskScan').waitFor();assert.equal(await page.locator('#deskScan').isDisabled(),true,'首次使用先完成登录');
  status.login.loggedIn=true;for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));
  await page.waitForFunction(()=>!document.getElementById('deskScan').disabled);await page.screenshot({path:path.join(output,'focus-first-use.png'),animations:'disabled'});
  await page.locator('#deskScan').click();assert.deepEqual(actions,['startRun','stopRun','startRecon']);
  fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({switchPreservesSelection:true,previewBeforeApply:true,undo:true,saveAndReload:true,missingTaskProtection:true,completedAndUnknownVisible:true,rangeValidation:true,runningGuard:true,persistenceFailure:true,legacyView:true,selectionNeverStarts:true,startStopMocked:true,saveFailureBlocksStart:true,loginHelp:true,responsive:true,pageErrors:errors,data},null,2));
  console.log('✓ 实际桌面：三栏选课、规则预览与应用、撤销、方案保存/改名/重载、变化任务保护、运行锁定、错误提示及窄屏验证通过；未执行任何课程任务。截图：'+output);
  if(process.argv.includes('--hold')){holding=true;await page.reload();await page.locator('[data-tab=courses]').click();await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setTitle('学习通助手 · 三栏选课预览（隔离演示数据）');w.show();});await new Promise(resolve=>application.process().once('exit',resolve));}
} finally {
  if(!holding){const exited=new Promise(resolve=>application.process().once('exit',resolve));await requestTestExit(application).catch(()=>{});let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,15000)})]);clearTimeout(timer);await application.close().catch(()=>{});}
}
