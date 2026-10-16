import { requestTestExit, enterTestWorkspace, revealTestTools, openTestArchive } from './desktop-test-helpers.mjs';
// Local UI review only: isolated synthetic records and mocked account/task status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=process.cwd();
const output=process.env.XXT_UI_CAPTURE_DIR || path.join(root,'.desktop-test','ui-workspace');
fs.mkdirSync(output,{recursive:true});
const round=process.argv.find(x=>x.startsWith('--round='))?.split('=')[1] || '1';
const data=fs.mkdtempSync(path.join(root,'.desktop-test','design-'));
fs.mkdirSync(path.join(data,'data/probe-out'),{recursive:true});
const names=['设计入门','英语听说练习','信息与媒介'];
const sections=['观察日常空间','从物品到设计','材料与表达'];
const tasks={};
const courses=names.map((name,c)=>{
  const courseId='demo-course-'+c;
  const taskPoints=[];
  for(let s=0;s<3;s++){
    const knowledgeId='demo-section-'+c+'-'+s;
    for(let t=0;t<2;t++){
      taskPoints.push({knowledgeId,secNo:'1.'+(s+1),sectionName:sections[s],type:t?'work':'video',typeName:t?'章节测验':'视频',name:t?'章节测验':sections[s]+' · 视频',finished:false,sizeText:t?null:'32 MB',cardNum:t,idx:0});
      if((c===0&&s<2&&t===0)||(c===1&&s<2)||(c===2&&s===0&&t===0))tasks[courseId+':'+knowledgeId+':t'+t]={status:'done'};
    }
  }
  return {courseId,clazzId:'demo-class-'+c,name,taskPoints};
});
tasks['demo-course-0:demo-section-0-0:t1']={status:'manual'};
const reviewQueue=[{id:'demo-essay',taskKey:'demo-course-0:demo-section-0-0:t1',course:names[0],secNo:'1.1',sectionName:sections[0],questionIndex:1,qtype:'essay',qtypeRaw:'简答题',confidence:'medium',confidenceLabel:'需要核对',status:'pending-review',autoFilled:true,textAnswer:'好的设计首先回应真实的使用需求。在日常空间中，清晰的动线、合适的照明和容易理解的标识，都能帮助人们更自然地完成活动。\n\n因此，观察使用者的行为，比先决定装饰风格更重要。',aiAnswer:'从实际使用场景出发，分析空间如何帮助人们行动与理解。',parseReason:'简答草稿已填写，仍需人工核对后提交。',validation:{safe:false,errors:['简答题需人工确认']}}];
fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({version:3,taskPoints:tasks,reviewQueue}));
fs.writeFileSync(path.join(data,'data/probe-out/task-report.json'),JSON.stringify({at:'2026-01-01T00:00:00Z',courses}));
const application=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
const errors=[];
let keepOpen=false;
try{
  const page=await application.firstWindow();
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await openTestArchive(page);await page.locator('#libraryHome #appearance').click();
  await page.locator('#libraryHome #showOnStartup').uncheck();
  await enterTestWorkspace(page);
  const initial=await page.evaluate(async()=>fetch('/api/status').then(r=>r.json()));
  const status={...initial,ready:true,bootError:null,edge:{connected:true,launched:true,version:'演示浏览器'},login:{loggedIn:true,reason:'演示账号已连接'},qianwen:{loggedIn:true},account:{},running:false,reviewCount:1,progress:{done:0,total:0,current:null},runStats:null};
  const sockets=new Set();
  const sendStatus=()=>{for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:status}));};
  await page.route('**/api/status',route=>route.fulfill({json:status}));
  await page.routeWebSocket('**/ws',ws=>{sockets.add(ws);ws.send(JSON.stringify({type:'status',data:status}));ws.onClose(()=>sockets.delete(ws));});
  const actions=[];
  await page.route('**/api/action/*',async route=>{
    const action=new URL(route.request().url()).pathname.split('/').pop();actions.push(action);
    if(action==='startRun'){status.running=true;status.progress={done:2,total:8,current:'设计入门 · 1.2 从物品到设计',playbackRate:2,taskType:'video',percent:.642,currentTime:385,duration:600};status.runStats={done:2,total:8};}
    if(action==='stopRun')status.running=false;
    if(action==='startRecon')status.reconRunning=true;
    await route.fulfill({json:{ok:true,result:{started:true}}});sendStatus();
  });
  await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setContentSize(1240,800);win.setTitle('学习通助手 · 本地界面预览（演示数据）');win.showInactive();});
  await page.reload();await revealTestTools(page);await page.locator('[data-tab=overview]').click();
  await revealTestTools(page);await page.locator('[data-tab=overview]').click();
  await page.locator('#overviewTaskCount').filter({hasText:'18'}).waitFor();
  await page.locator('#kLoginState').filter({hasText:'已登录'}).waitFor();
  const capture=async name=>page.screenshot({path:path.join(output,'round-'+round+'-'+name+'.png'),fullPage:false,animations:'disabled'});
  await revealTestTools(page);await page.locator('[data-tab=overview]').click();await capture('overview');
  await revealTestTools(page);await page.locator('#toggleClassicUi').click();
  assert.equal(await page.locator('#workspaceDesign').evaluate(el=>el.disabled),true);
  await revealTestTools(page);await page.locator('#toggleClassicUi').click();
  assert.equal(await page.locator('#workspaceDesign').evaluate(el=>el.disabled),false);
  await page.waitForTimeout(250); // Read steady colours after the appearance transition.
  // 键盘焦点与核心文字对比度。
  await revealTestTools(page);await page.locator('.tab[data-tab=overview]').focus();
  await page.keyboard.press('Tab');
  const focus=await page.evaluate(()=>({width:getComputedStyle(document.activeElement).outlineWidth,style:getComputedStyle(document.activeElement).outlineStyle}));
  assert.equal(focus.width,'2px');assert.equal(focus.style,'solid');
  const contrasts=await page.evaluate(()=>{
    const luminance=color=>{const rgb=color.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
    return ['body','.hero-description','.hint','.tab.active','button.primary'].map(selector=>{
      const e=document.querySelector(selector),foreground=getComputedStyle(e).color;let ancestor=e,background;
      while(ancestor){background=getComputedStyle(ancestor).backgroundColor;if(background!=='rgba(0, 0, 0, 0)'&&background!=='transparent')break;ancestor=ancestor.parentElement;}
      const a=luminance(foreground),b=luminance(background);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    });
  });
  for(const check of contrasts)assert.ok(check.ratio>=4.5,JSON.stringify(check));
  await page.locator('.tab[data-tab=courses]').click();
  await page.locator('#deskLegacy').click();
  await page.locator('.treehead').first().click();
  await page.locator('.tprow .task-status').first().filter({hasText:'已完成'}).waitFor();
  await capture('courses');
  const courseMenu=page.locator('.course-actions').first();
  await courseMenu.locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await courseMenu.getAttribute('open'),'');
  await page.keyboard.press('Escape');assert.equal(await courseMenu.getAttribute('open'),null);
  const caret=page.locator('.treehead .caret').first();
  await caret.focus();await page.keyboard.press('Enter');assert.equal(await caret.getAttribute('aria-expanded'),'false');
  await page.keyboard.press('Enter');assert.equal(await caret.getAttribute('aria-expanded'),'true');
  // Keyboard, selection, search, advanced tools, persisted choices.
  await page.locator('#treeSearch').fill('英语');
  assert.equal(await page.locator('.treecourse').count(),1);
  await page.locator('#treeSearch').fill('');
  await page.locator('.selection-tools summary').click();
  await page.locator('[data-tree=deselect]').click();
  assert.match(await page.locator('#treeWillSummary').innerText(),/尚未选择|0/);
  await page.locator('[data-tree=unfinished]').click();
  await page.locator('.selection-tools summary').click();
  await page.locator('#panel-courses [data-action=saveSelection]').click();
  await page.locator('#treeDirty').waitFor({state:'hidden'});
  await page.locator('#panel-courses [data-action=startRun]').click();
  await page.locator('#runBar').waitFor({state:'visible'});
  assert.equal(await page.locator('#panel-courses [data-action=stopRun]').isEnabled(),true);
  assert.match(await page.locator('#runSub').innerText(),/实际 2×/);
  assert.equal(await page.locator('#runTaskProgress [role=progressbar]').getAttribute('aria-valuenow'),'64.2');
  assert.equal(await page.locator('#runProg').innerText(),'2 / 8');
  await capture('running');
  await page.locator('#panel-courses [data-action=stopRun]').click();
  assert.equal(status.running,false);
  await page.locator('.tab[data-tab=review]').click();
  await page.locator('.qedit textarea').waitFor();
  assert.match(await page.locator('.qedit textarea').inputValue(),/好的设计/);
  await capture('review');
  await revealTestTools(page);await page.locator('.tab[data-tab=settings]').click();
  await page.locator('.setrow').first().waitFor();
  await capture('settings');
  assert.equal(await page.locator('#settingsAdvanced').isVisible(),false);
  await page.locator('[data-setting=muted]').uncheck();
  await page.locator('[data-setting=playbackSpeed]').selectOption('2');
  await page.locator('[data-setting=videoCompletionMode]').selectOption('check90');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='POST');
  await page.locator('#saveSettings').click();await saved;
  await page.locator('#settingsDirty').filter({hasText:'已改'}).waitFor();
  const savedSettings=JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8')).settings;
  assert.equal(savedSettings.muted,false);assert.equal(savedSettings.playbackSpeed,'2');assert.equal(savedSettings.videoCompletionMode,'check90');
  await revealTestTools(page);await page.locator('.tab[data-tab=overview]').click();
  status.running=true;status.progress={done:2,total:8,current:'设计入门 · 1.2 从物品到设计',playbackRate:2,taskType:'video',percent:.642,currentTime:385,duration:600};sendStatus();
  await page.locator('#overviewActivity').filter({hasText:'学习进行中'}).waitFor();
  assert.match(await page.locator('#kCurrent').innerText(),/实际 2×/);
  assert.equal(await page.locator('#overviewTaskProgress [role=progressbar]').getAttribute('aria-valuenow'),'64.2');
  await capture('overview-running');
  status.progress.phase='verifying';status.progress.percent=.9;sendStatus();
  await page.locator('#overviewTaskProgress [data-tp=label]').filter({hasText:'核对平台状态'}).waitFor();await capture('overview-verifying');
  status.progress={...status.progress,taskType:'work',questionIndex:1,questionTotal:4,phase:'asking',percent:null,currentTime:null,duration:null};sendStatus();
  await page.locator('#overviewTaskProgress [data-tp=percent]').filter({hasText:'25.0'}).waitFor();await capture('overview-quiz');
  status.progress={...status.progress,taskType:'video',questionIndex:null,questionTotal:null,phase:'playing',percent:.642,currentTime:385,duration:600};sendStatus();
  status.running=false;sendStatus();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,660));
  await capture('compact');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'960px 不应横向溢出');
  await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(360,540);win.setContentSize(390,760);});
  await capture('narrow');
  const narrow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+2&&getComputedStyle(e).display!=='none').map(e=>e.className).slice(0,12)}));
  assert.equal(narrow.scroll<=narrow.width,true,JSON.stringify(narrow));
  for(const tab of ['courses','review','settings']){
    await page.locator('.tab[data-tab='+tab+']').click();
    if(tab==='review')await page.locator('.qedit textarea').waitFor();
    if(tab==='settings')await page.locator('.setrow').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'窄窗口 '+tab+' 溢出');
    await capture('narrow-'+tab);
  }
  await revealTestTools(page);await page.locator('.tab[data-tab=overview]').click();
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#overviewProgressFill').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  assert.equal(await page.locator('#overviewTaskProgress .tp-fill').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(960,660);win.setContentSize(1240,800);});
  await page.emulateMedia({reducedMotion:'no-preference'});
  // 首次使用：无清单时主按钮扫描，扫描结束自动加载清单。
  status.progress={done:0,total:0,current:null};status.runStats=null;
  await page.route('**/api/checklist',route=>route.fulfill({json:{ok:true,result:null}}));
  await page.reload();await revealTestTools(page);await page.locator('[data-tab=overview]').click();await page.locator('#overviewStart').filter({hasText:'扫描课程'}).waitFor();
  await capture('first-use');await page.locator('#overviewStart').click();
  await page.waitForFunction(()=>document.querySelector('#overviewActivity').textContent==='正在扫描');
  assert.ok(actions.includes('startRecon'));
  await page.unroute('**/api/checklist');status.reconRunning=false;sendStatus();
  await page.locator('#overviewTaskCount').filter({hasText:'18'}).waitFor();
  status.login={loggedIn:false};sendStatus();
  await page.locator('#overviewHeadline').filter({hasText:'先登录'}).waitFor();
  assert.equal(await page.locator('#overviewStart').isDisabled(),true);
  await capture('logged-out');
  status.login={loggedIn:true};sendStatus();
  fs.writeFileSync(path.join(data,'recon-selection.json'),JSON.stringify({courseOrder:[],courses:{},taskOrder:{},excluded:[]}));
  await page.reload();await revealTestTools(page);await page.locator('[data-tab=overview]').click();await page.locator('#overviewTaskCount').filter({hasText:'18'}).waitFor();
  const workspaceUrl=page.url();
  await application.evaluate(async({app,BrowserWindow})=>{const path=process.getBuiltinModule('path');await BrowserWindow.getAllWindows()[0].loadFile(path.join(app.getAppPath(),'desktop','loading.html'));});
  await page.locator('#message').waitFor();await capture('loading');
  await page.goto(workspaceUrl);await revealTestTools(page);await page.locator('[data-tab=overview]').click();await page.locator('#overviewTaskCount').filter({hasText:'18'}).waitFor();
  assert.deepEqual(errors,[]);
  assert.ok(actions.includes('startRun')&&actions.includes('stopRun'));
  fs.writeFileSync(path.join(output,'round-'+round+'-checks.json'),JSON.stringify({navigation:true,search:true,selectionSaved:true,startStopWiring:true,essayEditor:true,compactNoOverflow:true,narrowNoOverflow:true,reducedMotion:true,keyboardFocus:true,menuEscape:true,courseKeyboardExpand:true,settingsSaved:true,firstScanAutoLoads:true,loggedOutDisabled:true,contrasts,pageErrors:errors,data},null,2));
  console.log('UI 验证通过；截图目录：'+output);
  if(process.argv.includes('--hold')){
    keepOpen=true;
    await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setTitle('学习通助手 · 本地界面预览（演示数据）');win.show();});
    console.log('演示窗口已打开，使用隔离数据。');
    await new Promise(resolve=>application.process().once('exit',resolve));
  }
}finally{
  if(!keepOpen){
    const exited=new Promise(resolve=>application.process().once('exit',resolve));
    await requestTestExit(application).catch(()=>{});
    let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,15000)})]);clearTimeout(timer);
    await application.close().catch(()=>{});
  }
}
