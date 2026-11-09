// Actual renderer and local APIs, synthetic courses/actions only. No real
// account, coursework, AI message or installed application is touched.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {_electron as electron} from 'playwright-core';
import {requestTestExit} from './desktop-test-helpers.mjs';
const root=process.cwd();fs.mkdirSync('.desktop-test',{recursive:true});const data=fs.mkdtempSync(path.resolve('.desktop-test/platform-guide-')),output=path.resolve('.desktop-test/onboarding');fs.mkdirSync(output,{recursive:true});process.env.KEBO_DATA_DIR=data;
const {PATHS,loadSettings,DEFAULT_SETTINGS}=await import('../../src/config.mjs');const {mutateState}=await import('../../src/state.mjs');const {normalizeSettings,toSparseSettings,describeSettings}=await import('../../src/settings.mjs');
const {patchStatus,bus,getStatus}=await import('../../src/logbus.mjs');const {startServer}=await import('../../src/server.mjs');const {assertPlatformChange}=await import('../../src/ui/platforms.js');
const actions=[],requests=[];let failSave=false;
const service=await startServer({
 getSettings:()=>({rows:describeSettings(loadSettings()),readonly:[],changed:[]}),
 saveSettings:async patch=>{if(failSave)throw Error('示例保存失败');const next=normalizeSettings(patch,loadSettings());assertPlatformChange(loadSettings(),next.settings,getStatus());mutateState(s=>{s.settings=toSparseSettings(next.settings,DEFAULT_SETTINGS);});patchStatus({settings:loadSettings(),ai:{provider:loadSettings().ai.provider,loggedIn:false}});return {ok:true};},
 openAI:async()=>{actions.push('openAI:'+loadSettings().ai.provider);return {ok:true};},openChaoxing:async()=>({ok:true}),openWelearn:async()=>({ok:true}),
 refreshLogin:async()=>({loggedIn:false}),checkQianwen:async()=>({loggedIn:false}),
 startRun:async req=>{let text='';for await(const part of req)text+=part;requests.push(JSON.parse(text));return {ok:true,started:true};}
});
fs.mkdirSync(PATHS.data,{recursive:true});
const courses=[];
for(const [p,id]of ['chaoxing','zhihuishu','ucampus','welearn'].entries())for(let c=0;c<2;c++){
 const courseId=id+':fixture-'+c;
 const name=[['视觉与表达基础','信息与社会'],['从日常看见设计','自然科学入门'],['英语听说与交流','大学英语：理解与表达'],['大学英语视听说 · 从校园到世界的交流与表达（进阶）','英语阅读与思辨']][p][c];
 courses.push({platform:id,courseId,clazzId:'fixture-class',name,sectionTreeKnown:true,sections:[0,1].map(i=>({knowledgeId:courseId+':section-'+i,secNo:'1.'+(i+1),name:['观察与理解','表达与练习'][i]})),taskPoints:[0,1].flatMap(s=>[0,1,2].map(i=>({knowledgeId:courseId+':section-'+s,secNo:'1.'+(s+1),sectionName:['观察与理解','表达与练习'][s],type:id==='welearn'?'study':i===2?'work':'video',typeName:id==='welearn'?'课内学习':i===2?'章节测验':'视频',name:(id==='welearn'?['词汇与表达','听力练习','综合练习']:['从身边开始观察','理解与运用','章节测验'])[i],finished:c===0&&s===0&&i===0,cardNum:i})))});
}
fs.writeFileSync(path.join(PATHS.data,'platform-catalog.json'),JSON.stringify({version:1,courses}));
patchStatus({ready:true,bootError:null,edge:{connected:true},login:{loggedIn:false},settings:loadSettings()});
const electronData=fs.mkdtempSync(path.resolve('.desktop-test/platform-guide-electron-'));const packagedExe=process.env.KEBO_ONBOARDING_TEST_EXE;
const app=await electron.launch({executablePath:packagedExe||path.join(root,'node_modules/electron/dist/electron.exe'),args:[...(packagedExe?[]:[root]),'--test-mode'],env:{...process.env,KEBO_TEST_DATA_DIR:electronData}});
const errors=[],sockets=new Set();const send=()=>{for(const ws of sockets)ws.send(JSON.stringify({type:'status',data:getStatus()}));};bus.on('status',send);let keep=false;
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.waitForURL('http://127.0.0.1:*/');
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());const response=await fetch(new URL(url.pathname+url.search,service.url),{method:req.method(),headers:{'content-type':'application/json'},...(req.method()==='POST'?{body:req.postData()}: {})});await route.fulfill({status:response.status,contentType:response.headers.get('content-type')||'application/json',body:Buffer.from(await response.arrayBuffer())});});
 await page.routeWebSocket('**/ws',ws=>{sockets.add(ws);ws.send(JSON.stringify({type:'status',data:getStatus()}));ws.onClose(()=>sockets.delete(ws));});
 await page.evaluate(()=>localStorage.setItem('kebo-library-startup','skip'));
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getOpacity()>0);w.setMinimumSize(500,500);w.setContentSize(1360,940);w.setTitle('课栈 · 按需平台与选课预览（演示数据）');w.show();w.focus();});
 await page.reload();await page.locator('#onboardingPanel[open]').waitFor();
 const capture=async name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled',timeout:15000});
 assert.equal(await page.locator('#onboardingNext').isDisabled(),true);await capture('01-platform-guide');
 await page.locator('input[name=onboardingPlatform][value=welearn]').check();await capture('02-only-welearn');
 await page.locator('#onboardingNext').click();await page.locator('#onboardingLogin').waitFor({state:'visible'});assert.equal(await page.locator('#onboardingStep').textContent(),'2 / 2');assert.equal(await page.locator('#onboardingConnections .onboarding-connection').count(),1);assert.equal(await page.locator('#onboardingCheckLogin').isVisible(),false);await capture('03-connect-selected');
 await page.locator('#onboardingLater').click();await page.evaluate(async()=>{document.dispatchEvent(new Event('assistant-open-workspace'));(await import('/app.js')).workspace.openSettings('platforms');});await page.locator('#reopenOnboarding').click();assert.equal(await page.locator('input[name=onboardingPlatform][value=welearn]').isChecked(),true,'未完成向导重开保留平台选择');await page.locator('#onboardingNext').click();
 await page.evaluate(()=>document.dispatchEvent(new Event('embedded-browser-show')));await page.locator('#onboardingPanel').waitFor({state:'hidden'});await page.evaluate(()=>document.dispatchEvent(new Event('embedded-browser-hide')));await page.locator('#onboardingPanel[open]').waitFor();
 await page.locator('#onboardingNext').click();await page.locator('#onboardingPanel').waitFor({state:'hidden'});await page.locator('#panel-courses.active').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#deskCourses .sd-course').length===2);
 assert.equal(await page.locator('#onboardingBank').isHidden(),true,'仅 WeLearn 不展示学习通题库');assert.equal(await page.locator('.platform-session').count(),1);assert.equal(await page.locator('.platform-session[data-platform=welearn]').count(),1);assert.equal(await page.locator('#deskRunActions [data-action=startRun]').isEnabled(),true,'没有学习通或 AI 登录也能选 WeLearn');
 await capture('04-selection-light');
 await page.locator('#deskClearCourse').click();await page.locator('#deskSelectPending').click();
 const selected=()=>page.evaluate(async()=>{const {workspace}=await import('/app.js');return workspace.snapshot().checklist.courses.flatMap(c=>c.tasks.filter(t=>t.willHandle).map(t=>t.key));});
 const before=await selected();assert.equal(before.length,11);assert.ok(before.every(k=>k.startsWith('welearn:')));
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/action/startRun')),page.locator('#deskRunActions [data-action=startRun]').click()]);assert.equal(requests.length,1);assert.deepEqual(requests[0].taskKeys.slice().sort(),before.slice().sort(),'实际提交的范围只含启用平台');
 await page.evaluate(async()=>{(await import('/app.js')).workspace.openSettings('platforms');});await capture('05-platform-preferences');
 await page.locator('[data-platform-setting=welearn]').uncheck();await page.waitForFunction(()=>document.querySelector('.platform-preference[data-platform=welearn] .platform-choice-status').textContent==='已关闭');assert.equal(await selected().then(a=>a.length),0);
 await page.locator('[data-platform-setting=welearn]').check();await page.waitForFunction(()=>document.querySelector('.platform-preference[data-platform=welearn] .platform-choice-status').textContent==='已开启');assert.deepEqual((await selected()).slice().sort(),before.slice().sort(),'关闭再开启保留选课范围');
 await page.locator('[data-platform-setting=chaoxing]').check();await page.waitForFunction(()=>document.querySelector('.platform-preference[data-platform=chaoxing] .platform-choice-status').textContent==='已开启');
 patchStatus({platformRuns:{welearn:{running:true,total:1,done:0}}});await page.waitForFunction(()=>document.querySelector('[data-platform-setting=welearn]').disabled);assert.equal(await page.locator('[data-platform-setting=chaoxing]').isEnabled(),true);patchStatus({platformRuns:{}});
 await page.locator('#reopenOnboarding').click();await page.locator('#onboardingPanel[open]').waitFor();assert.equal(await page.locator('input[name=onboardingPlatform][value=welearn]').isChecked(),true);await page.locator('#onboardingNext').click();await page.locator('#onboardingNext').click();await page.locator('#onboardingAI').waitFor({state:'visible'});assert.equal(await page.locator('#onboardingAIOptions').isVisible(),false);
 assert.equal(await page.locator('#onboardingBank').isVisible(),true);await page.locator('#onboardingOpenBank').click();await page.locator('.bank-guide-dialog[open]').waitFor();assert.equal(await page.locator('#onboardingPanel').isVisible(),false);await page.locator('#bankGuideLater').click();await page.locator('#onboardingPanel[open]').waitFor();assert.equal(await page.locator('#onboardingAI').isVisible(),true,'关闭题库向导返回原步骤');await capture('06-bank-and-ai');
 await page.locator('#onboardingAIWanted').check();await page.locator('input[name=onboardingProvider][value=deepseek]').check();failSave=true;await page.locator('#onboardingOpenAI').click();await page.locator('#onboardingError').filter({hasText:'示例保存失败'}).waitFor();failSave=false;await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/action/openAI')),page.locator('#onboardingOpenAI').click()]);assert.ok(actions.includes('openAI:deepseek'));await capture('06-optional-ai');await page.locator('#onboardingNext').click();await page.locator('#onboardingPanel').waitFor({state:'hidden'});
 const saved=JSON.parse(fs.readFileSync(PATHS.state,'utf8'));assert.ok(saved.onboarding.completedAt);assert.equal(saved.onboarding.provider,'deepseek');assert.equal(loadSettings().answerBank.source,'bank','向导保留题库优先设置');
 await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.onboardingPending==='false');assert.equal(await page.locator('#onboardingPanel').evaluate(e=>e.open),false);
 await page.evaluate(()=>document.dispatchEvent(new Event('assistant-open-workspace')));await page.locator('[data-tab=courses]').click();
 await capture('07-selection-multi');
 await page.evaluate(async()=>{(await import('/theme.js')).applyTheme({mode:'dark',accent:'green'});});await capture('09-selection-dark');
 await page.evaluate(async()=>{const {workspace}=await import('/app.js');workspace.openSettings('platforms');});await page.locator('#reopenOnboarding').click();
 await capture('10-guide-dark');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getOpacity()>0).setContentSize(600,760));await capture('08-guide-narrow');assert.equal(await page.locator('#onboardingPanel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await page.keyboard.press('Escape');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getOpacity()>0).setContentSize(1360,940));
 await page.evaluate(async()=>{(await import('/theme.js')).applyTheme({mode:'light',accent:'green'});(await import('/app.js')).workspace.openSettings('platforms');});await page.locator('[data-platform-setting=chaoxing]').uncheck();await page.waitForFunction(()=>document.querySelector('.platform-preference[data-platform=chaoxing] .platform-choice-status').textContent==='已关闭');
 await page.evaluate(()=>document.dispatchEvent(new Event('assistant-open-workspace')));await page.locator('[data-tab=courses]').click();
 await capture('11-final-selection');
 assert.deepEqual(errors,[]);console.log('✓ 真实渲染与接口：按需平台、WeLearn 跳过 AI、可选登录、持久化/重开、关闭保留选择、隐藏范围不启动、运行保护、保存失败反馈、选课快捷操作、窄窗通过');
 if(process.argv.includes('--keep-open')){keep=true;console.log(JSON.stringify({preview:page.url(),artifacts:output}));await new Promise(resolve=>app.process().once('exit',resolve));}
}finally{if(!keep){await requestTestExit(app).catch(()=>{});await app.close().catch(()=>{});}bus.off('status',send);for(const c of service.wss.clients)c.terminate();await new Promise(r=>service.wss.close(r));service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
