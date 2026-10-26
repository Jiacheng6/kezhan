import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { requestTestExit } from './desktop-test-helpers.mjs';
const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(root,'.desktop-test','update-channels-ui-'));
const body=Buffer.alloc(256*1024,77),sha512=crypto.createHash('sha512').update(body).digest('base64');
let cnbUp=false,cnbDownload=false;const calls=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');calls.push(url.pathname);
  if(url.pathname.startsWith('/cnb/')&&!cnbUp){res.statusCode=503;res.end('temporarily unavailable');return;}
  if(url.pathname.endsWith('/latest.yml')){res.setHeader('Content-Type','application/yaml');res.end(JSON.stringify({version:'9.9.9',releaseNotes:'• 更新测试',files:[{url:'fixture-Setup.exe',sha512,size:body.length}],path:'fixture-Setup.exe',sha512}));}
  else if(url.pathname.endsWith('/fixture-Setup.exe')){
    if(url.pathname.startsWith('/cnb/')&&!cnbDownload){res.statusCode=503;res.end('download unavailable');return;}
    res.setHeader('Content-Length',body.length);res.end(body);
  }else{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const sources=[{id:'cnb',name:'国内下载（CNB）',provider:{provider:'generic',url:base+'/cnb/'}},{id:'github',name:'GitHub',provider:{provider:'generic',url:base+'/github/'}}];
let app;
async function waitStatus(page,phase){
  for(let i=0;i<300;i++){
    try{const status=await page.evaluate(()=>window.desktopApp.updateState());if(status.phase===phase&&!status.busy)return status;}
    catch(error){if(!/Execution context was destroyed/.test(error.message))throw error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`更新未达到 ${phase}：`+JSON.stringify(await page.evaluate(()=>window.desktopApp.updateState())));
}
async function close(){if(!app)return;const current=app;app=null;await requestTestExit(current);await current.close();}
async function launch(name){
  const data=path.join(testRoot,name);fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({version:3,onboarding:{version:2,completedAt:'2026-01-01T00:00:00.000Z'},taskPoints:{sample:{status:'done'}}}));
  const packagedExe=process.env.XXT_UPDATE_TEST_EXE;
  app=await electron.launch({executablePath:packagedExe||path.join(root,'node_modules/electron/dist/electron.exe'),args:[...(packagedExe?[]:[root]),'--test-mode'],env:{...process.env,LOCALAPPDATA:path.join(data,'local-cache'),XXT_TEST_DATA_DIR:data,XXT_TEST_UPDATE_FEED:'',XXT_TEST_UPDATE_SOURCES:JSON.stringify(sources)}});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getOpacity()>0).showInactive());
  const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('#desktopUpdatePanel[open]').waitFor();return {data,page};
}
try{
  let {page}=await launch('online');
  assert.equal((await page.evaluate(()=>window.desktopApp.updateState())).sourceName,'GitHub','真实更新器：主源503时自动切到备用源');
  await page.locator('#updateSource').selectOption('cnb');await page.locator('#updateCheck').click();
  await waitStatus(page,'error');
  assert.equal((await page.evaluate(()=>window.desktopApp.updateState())).nextVersion,null);
  assert.equal(await page.locator('#updateLocal').isEnabled(),true,'联网失败仍可离线更新');
  cnbUp=true;
  await page.locator('#updateSource').selectOption('auto');await page.locator('#updateCheck').click();
  await waitStatus(page,'available');
  assert.equal((await page.evaluate(()=>window.desktopApp.updateState())).sourceName,'国内下载（CNB）');
  await page.locator('#updateDownload').click();
  await waitStatus(page,'ready');
  assert.equal((await page.evaluate(()=>window.desktopApp.updateState())).sourceName,'GitHub','真实下载器：主源下载失败时校验同包再换源');
  assert.equal(await page.locator('#updateInstall').isVisible(),true);
  await page.screenshot({path:path.join(testRoot,'online-fallback.png')});
  assert.ok(calls.includes('/cnb/fixture-Setup.exe')&&calls.includes('/github/fixture-Setup.exe'));
  await close();
  ({page}=await launch('offline'));
  await page.locator('.update-alternatives').evaluate(el=>el.open=true);
  const installer=path.join(testRoot,'XuexitongAssistant-9.9.10-Setup.exe'),manifest=path.join(testRoot,'release-manifest.json');
  fs.writeFileSync(installer,body);fs.writeFileSync(manifest,JSON.stringify({version:'9.9.10',files:[{file:path.basename(installer),bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}]}));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},installer);
  fs.writeFileSync(installer,Buffer.alloc(body.length,1));
  await page.locator('#updateLocal').click();
  await waitStatus(page,'error');
  await page.locator('#updateMessage').filter({hasText:'校验失败'}).waitFor();assert.equal(await page.locator('#updateInstall').isVisible(),false);
  fs.writeFileSync(installer,body);
  await page.locator('#updateLocal').click();
  await waitStatus(page,'ready');
  const status=await page.evaluate(()=>window.desktopApp.updateState());
  assert.equal(status.nextVersion,'9.9.10');assert.equal(status.sourceName,'本地安装包');assert.equal(status.percent,100);
  await page.screenshot({path:path.join(testRoot,'offline-ready.png')});
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  await page.locator('#updateInstall').click();assert.equal((await waitStatus(page,'ready')).downloadReady,true,'用户取消安装仍保留可用的离线包');
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});
  await page.locator('#updateInstall').click();
  assert.match((await waitStatus(page,'error')).message,/测试模式/);
  const info=await page.evaluate(()=>window.desktopApp.info());
  for(let i=0;i<60&&!fs.existsSync(path.join(info.dataDir,'updates','backups'));i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(fs.readdirSync(path.join(info.dataDir,'updates','backups')).length,1,'离线更新也走同一保存备份流程');
  assert.equal(JSON.parse(fs.readFileSync(path.join(info.dataDir,'state.json'),'utf8')).taskPoints.sample.status,'done');
  assert.equal(fs.existsSync(installer),true,'原始安装包保留');
  console.log('✓ 真实 Electron 双源发现/下载切换、失败后的本地入口、损坏拒绝、离线校验与取消/备份安装流程通过');
  console.log('截图目录：'+testRoot);
}catch(error){console.log('本机服务请求：',calls);if(app){const page=await app.firstWindow();console.log('更新状态：',await page.evaluate(()=>window.desktopApp.updateState()));await page.screenshot({path:path.join(testRoot,'failure.png')});}throw error;}
finally{await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
