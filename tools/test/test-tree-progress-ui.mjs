// 隔离软件实例验证真实课程树，不连接真实账号，不启动课程任务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = process.cwd();
fs.mkdirSync(path.join(root, '.desktop-test'), { recursive: true });
const data = fs.mkdtempSync(path.join(root, '.desktop-test', 'tree-ui-'));
const report = { at: '2026-01-01T00:00:00Z', courses: [{ courseId: 'example-course', clazzId: 'example-class', name: '示例课程甲', taskPoints: [
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', name: '示例视频', type: 'video', finished: false },
  { knowledgeId: 'example-section', secNo: '1.2', sectionName: '示例章节', name: '章节测验', type: 'work', finished: false },
] }] };
report.courses[0].sectionTreeKnown=true;
report.courses[0].sections=[
  {knowledgeId:'example-section',secNo:'1.2',name:'示例章节',done:false,probed:true,pending:1},
  {knowledgeId:'earlier-section',secNo:'1.1',name:'扫描前完成的小节',done:true,probed:false},
];
report.courses.push(
  {courseId:'already-done',clazzId:'done-class',name:'示例已完成课程',sectionTreeKnown:true,sections:[{knowledgeId:'done-section',secNo:'2.1',name:'已完成小节示例',done:true,probed:false}],taskPoints:[]},
  {courseId:'unknown',clazzId:'unknown-class',name:'示例待确认课程',sectionTreeKnown:true,sections:[{knowledgeId:'unknown-section',secNo:'3.1',name:'未读取小节',done:false,probed:false,pending:1}],taskPoints:[]},
);
const state = { version: 3, taskPoints: {
  'example-course:example-section:t0': { status: 'done' },
  'example-course:example-section:t1': { status: 'manual' },
} };
fs.mkdirSync(path.join(data, 'data/probe-out'), { recursive: true });
fs.writeFileSync(path.join(data, 'data/probe-out/task-report.json'), JSON.stringify(report));
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(state));
const executablePath = process.env.XXT_TREE_TEST_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
const application = await electron.launch({ executablePath,
  args: [...(process.env.XXT_TREE_TEST_EXE ? [] : [root]), '--test-mode'],
  env: { ...process.env, XXT_TEST_DATA_DIR: data } });
try {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('#libraryHome #appearance').click();
  await page.locator('#libraryHome #showOnStartup').uncheck();
  await page.locator('#libraryHome #enterWorkspace').click();
  await page.locator('.tab[data-tab="courses"]').click();
  await page.locator('#treeSource').filter({ hasText: '已加载' }).waitFor();
  const completed=page.locator('[data-completion-group="completed"]');
  const pending=page.locator('[data-completion-group="pending"]');
  assert.equal(await completed.locator('.completion-group-content').isVisible(),false,'已完成默认折叠');
  assert.match(await completed.locator('.completion-group-heading').innerText(),/已完成 1 门/);
  assert.equal(await pending.locator('.treecourse').count(),2,'未知状态仍放入待完成');
  await page.locator('[data-course-id="example-course"] .treehead').click();
  assert.equal(await page.locator('[data-course-id="example-course"] [data-section-completion="completed"] .section-group-content').isVisible(),false,'课程内已完成小节默认折叠');
  assert.equal(await page.locator('[data-course-id="example-course"] [data-section-completion="pending"] .tprow').count(),2);
  assert.equal(await page.locator('.tprow').count(), 2);
  assert.equal(await page.locator('.tprow .task-status').nth(0).innerText(), '已完成');
  assert.equal(await page.locator('.tprow .task-status').nth(1).innerText(), '待你核对');
  assert.match(await page.locator('[data-course-id="example-course"] [data-section-completion="pending"] .sechead').innerText(), /已完成 1\/2/);
  await page.screenshot({ path: path.join(root, '.desktop-test/tree-progress-fixed.png'), fullPage: false });
  await page.locator('.tprow input[type=checkbox]').nth(0).uncheck();
  assert.equal(await page.locator('#treeDirty').isVisible(), true);
  // 模拟后台执行记录更新：真实定时刷新应更新标签、保留未保存勾选与展开状态。
  state.taskPoints['example-course:example-section:t1'].status = 'done';
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(state));
  await page.locator('.sechead').filter({ hasText: '已完成 2/2' }).waitFor({ state:'attached',timeout: 15000 });
  assert.match(await completed.locator('.completion-group-heading').innerText(),/已完成 2 门/);
  assert.equal(await completed.locator('.completion-group-content').isVisible(),false,'后台完成后保持折叠偏好');
  assert.equal(await completed.locator('[data-course-id="example-course"]').count(),1,'新完成课程移入且不重复');
  assert.equal(await pending.locator('.treecourse').count(),1);
  await completed.locator('.completion-group-heading').click();
  assert.equal(await page.locator('.tprow .task-done').count(), 2);
  assert.equal(await page.locator('.tprow input[type=checkbox]').nth(0).isChecked(), false);
  assert.equal(await page.locator('#treeDirty').isVisible(), true);
  assert.equal(await page.locator('.treecourse.open').count(), 1);
  await page.locator('[data-course-id="already-done"] .treehead').click();
  assert.match(await page.locator('[data-course-id="already-done"]').innerText(),/平台已标记此小节完成/);
  await page.screenshot({path:path.join(root,'.desktop-test/course-groups-expanded.png')});
  await completed.locator('.completion-group-heading').click();
  await page.locator('#treeSearch').fill('已完成小节示例');
  await page.locator('[data-course-id="already-done"] .section-coverage-note').waitFor();
  assert.equal(await completed.locator('.completion-group-content').isVisible(),true,'搜索自动展示已完成内容');
  await page.locator('#treeSearch').fill('');
  await page.waitForFunction(()=>document.querySelector('[data-completion-group="completed"] .completion-group-content').hidden);
  await page.evaluate(async()=>{const {workspace}=await import('/app.js');workspace.openCourse('already-done');});
  assert.equal(await page.locator('[data-course-id="already-done"] .section-coverage-note').isVisible(),true,'从档案跳转能打开已完成课程');
  assert.equal(fs.existsSync(path.join(data, 'recon-selection.json')), false, '刷新不自动保存选择');
  await page.locator('#enterLibrary').click();
  const frame=page.locator('#libraryHome #archiveFrame').contentFrame();
  await page.evaluate(async()=>{window.__courseGroupLibrary=(await import('/library/home.js')).libraryDiagnostics;});
  await page.waitForFunction(()=>window.__courseGroupLibrary.snapshot().scene?.ready,null,{timeout:60000});
  await frame.locator('#open-course:not(:disabled)').waitFor({timeout:60000});
  for(let i=0;i<3&&(await frame.locator('#selected-title').innerText())!=='示例已完成课程';i++){
    await frame.locator('#next').click();
  }
  assert.equal(await frame.locator('#selected-progress').innerText(),'已完成','档案页不把完整完成课程显示为 0/0');
  await frame.locator('#open-course').click();
  await frame.locator('#confirm-course:not(:disabled)').waitFor({timeout:15000});
  await frame.locator('#confirm-course').click();
  assert.equal(await frame.locator('.task-row').count(),0,'不伪造跳过读取的单项任务');
  assert.match(await frame.locator('#task-list').innerText(),/已完成小节示例[\s\S]*平台已标记此小节完成/);
  await page.waitForTimeout(400);
  const canvasSize=await frame.locator('canvas').first().evaluate(canvas=>[canvas.width,canvas.height]);
  assert.ok(canvasSize[0]>100&&canvasSize[1]>100,'隐藏时加载、重新打开后恢复三维画布尺寸');
  const sceneStats=await page.evaluate(()=>window.__courseGroupLibrary.snapshot().scene.scene);
  assert.ok([...sceneStats.cameraPosition,...sceneStats.cameraQuaternion,sceneStats.fieldOfView].every(v=>Number.isFinite(v)),'后台加载不能污染相机位置与投影');
  await page.screenshot({path:path.join(root,'.desktop-test/course-groups-archive.png')});
  console.log('✓ 真实桌面课程分组、完成组默认折叠、后台完成迁移、保留选择、已完成小节搜索与跳转通过');
} finally {
  const exited = new Promise((resolve) => application.process().once('exit', resolve));
  await application.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 }); app.quit();
  }).catch(() => {});
  await exited;
  await application.close().catch(() => {});
}
