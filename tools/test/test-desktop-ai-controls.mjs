// Isolated Electron profile, local mock API, no real coursework or paid requests.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {fixturePng} from './fixture-png.mjs';
import {_electron as electron} from 'playwright-core';import {requestTestExit,enterTestWorkspace,revealTestTools} from './desktop-test-helpers.mjs';
fs.mkdirSync('.desktop-test',{recursive:true});const root=process.cwd(),data=fs.mkdtempSync(path.resolve('.desktop-test/ai-controls-'));
fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({onboarding:{version:2,completedAt:new Date().toISOString()},settings:{ai:{provider:'api'}}}));
const imagePath=path.join(data,'fixture.png');fs.writeFileSync(imagePath,fixturePng());
const calls=[];const site=http.createServer(async(req,res)=>{if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;calls.push(JSON.parse(body));res.setHeader('content-type','application/json');return res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));}res.setHeader('content-type','text/html');res.end('<title>本地演示网页</title><p>独立网页测试</p>');});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));const home=`http://127.0.0.1:${site.address().port}/chaoxing.com/home`;let app;
try{
 app=await electron.launch({executablePath:process.env.XXT_TEST_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.XXT_TEST_EXECUTABLE?['--embedded-test']:[root,'--embedded-test'],env:{...process.env,XXT_TEST_DATA_DIR:data,XXT_EMBEDDED_TEST_HOME:home},timeout:30000});
 const runtimeRoot=await app.evaluate(({app})=>app.getAppPath());
 const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:*/');await page.waitForFunction(()=>window.desktopApp?.apiStatus);await enterTestWorkspace(page);
 const secret='mock-desktop-key';assert.equal((await page.evaluate(()=>window.desktopApp.apiStatus())).configured,false);
 await revealTestTools(page);await page.locator('[data-tab="settings"]').click();await page.locator('#apiSettings').evaluate(e=>e.open=true);
 await page.locator('#apiBaseUrl').fill(`http://127.0.0.1:${site.address().port}/v1`);await page.locator('#apiModel').fill('mock-vision');await page.locator('#apiKey').fill(secret);await page.locator('#apiSave').click();
 await page.locator('#apiMessage').filter({hasText:'密钥已加密保存'}).waitFor();assert.equal(await page.locator('#apiKey').inputValue(),'','保存后必须清空密钥输入框');
 assert.equal((await page.evaluate(()=>window.desktopApp.apiStatus())).configured,true);assert.equal((await page.evaluate(()=>window.desktopApp.apiTest())).ok,true);assert.equal(calls.length,1);
 assert.equal(fs.readFileSync(path.join(data,'api-config.bin')).includes(Buffer.from(secret)),false,'Electron safeStorage 必须实际加密');
 const status=await page.evaluate(()=>fetch('/api/action/checkQianwen',{method:'POST'}).then(r=>r.json()));assert.equal(status.result.loggedIn,true,'worker 无 AI 网页时也能识别 API 配置');
 const workerFile=path.join(data,'api-image-worker.mjs');fs.writeFileSync(workerFile,`import {askImage,checkLogin} from ${JSON.stringify(pathToFileURL(path.join(runtimeRoot,'src/ai/ai.mjs')).href)};try{const login=await checkLogin(null);const result=await askImage({page:null,imagePath:${JSON.stringify(imagePath)},prompt:'本地模拟图片请求'});process.parentPort.postMessage({type:'proof',login:login.loggedIn,result});}catch(error){process.parentPort.postMessage({type:'proof',error:error.message});}`);
 const workerProof=await app.evaluate(async({app,utilityProcess},{workerFile,data})=>{
  const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),handle=require('./desktop/main.cjs').handleBrowserRequest;
  const child=utilityProcess.fork(workerFile,[],{env:{...process.env,XXT_DATA_DIR:data,XXT_EMBEDDED_BROWSER:'1'},stdio:'pipe'});
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('API worker 测试超时')),15000);child.on('message',async message=>{if(message.type==='proof'){clearTimeout(timer);resolve(message);}if(message.type==='browser-request'){try{child.postMessage({type:'browser-response',id:message.id,result:await handle(message.request)});}catch(error){child.postMessage({type:'browser-response',id:message.id,error:error.message});}}});child.once('exit',code=>{if(code)reject(Error('API worker 退出 '+code));});});}finally{child.kill();}
 },{workerFile,data});assert.equal(workerProof.login,true);assert.equal(workerProof.result?.ok,true,JSON.stringify(workerProof));assert.equal(workerProof.result.answer,'OK');assert.equal(calls.length,2);assert.ok(Array.isArray(calls.at(-1).messages[0].content),'真实 utility worker 应发送截图消息');
 const result=await app.evaluate(async({app})=>{const req=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),browser=req('./desktop/main.cjs').embeddedBrowser;
  const busy=await browser.create('about:blank');await browser.request({method:'annotate',targetId:busy.targetId,role:'work',busy:true});
  let protectedBusy=false;try{await browser.command({action:'close',id:busy.id});}catch{protectedBusy=true;}
  const pages=[];for(let i=0;i<16;i++){const page=await browser.create('about:blank');pages.push(page.id);await browser.request({method:'annotate',targetId:page.targetId,role:'review',busy:false});}
  const snapshot=browser.snapshot();const alive=snapshot.tabs.map(t=>t.id);const latest=pages.at(-1);await browser.command({action:'close',id:latest});
  return {protectedBusy,busyKept:alive.includes(busy.id),total:alive.length,retired:pages.filter(id=>!alive.includes(id)).length,manualClosed:!browser.snapshot().tabs.some(t=>t.id===latest)};
 });assert.equal(result.protectedBusy,true);assert.equal(result.busyKept,true);assert.ok(result.total<=12);assert.ok(result.retired>0);assert.equal(result.manualClosed,true);
 await page.screenshot({path:path.join(data,'api-settings.png')});assert.equal(await page.locator('#apiKey').inputValue(),'');
 console.log('✓ 独立 Electron：API IPC/真实本机加密/worker 就绪、超过网页阈值清退空闲页、保护忙页与手动关闭通过');console.log('截图：'+path.join(data,'api-settings.png'));
}finally{if(app){await requestTestExit(app).catch(()=>{});await app.close().catch(()=>{});}site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
