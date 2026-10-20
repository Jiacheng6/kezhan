// Real Electron output muting; no account or external website is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { _electron as electron } from 'playwright-core';
import { requestTestExit } from './desktop-test-helpers.mjs';
fs.mkdirSync('.desktop-test', {recursive:true});
const data=fs.mkdtempSync(path.resolve('.desktop-test/audio-output-'));
const site=http.createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<video></video><script>document.querySelector("video").muted=false;document.querySelector("video").volume=1;</script>');});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
let app;
try {
 app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd(),'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
 const port=Number(fs.readFileSync(path.join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);
 const result=await app.evaluate(async({BrowserWindow,app},{port,url})=>{
  const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
  const {EmbeddedBrowser}=require('./desktop/embedded-browser.cjs');
  const window=new BrowserWindow({show:false});const browser=new EmbeddedBrowser(window,{dataDir:app.getPath('userData'),debugPort:port});
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  try {
   const tab=await browser.create();const first=browser.views.get(tab.id).view.webContents;
   check(first.isAudioMuted(),'new view must start muted before loading');await first.loadURL(url);
   check(first.isAudioMuted(),'navigation preserves output mute');
   check(await first.executeJavaScript('document.querySelector("video").muted')===false,'DOM video mute must remain unchanged');
   await first.executeJavaScript('void window.open("'+url+'popup","_blank")');
   const deadline=Date.now()+10000;while(browser.views.size<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
   check(browser.views.size===2,'popup registered');check([...browser.views.values()].every(r=>r.view.webContents.isAudioMuted()),'popups must start muted');
   await browser.request({method:'audio-muted',muted:false});check([...browser.views.values()].every(r=>!r.view.webContents.isAudioMuted()),'unmute updates all views');
   const extra=await browser.create();check(!browser.views.get(extra.id).view.webContents.isAudioMuted(),'new tabs inherit saved unmute');
   await browser.request({method:'audio-muted',muted:true});await first.loadURL(url+'reload');
   check(first.isAudioMuted(),'navigation after setting change stays muted');
   check(await first.executeJavaScript('document.querySelector("video").muted')===false,'site player remains untouched');
   let rejected=false;try{await browser.request({method:'audio-muted',muted:'false'});}catch{rejected=true;}check(rejected,'invalid input rejected');
   return {nativeMute:true,videoPropertyUntouched:true,popupInheritance:true,liveSettings:true,navigationPersistence:true};
  }finally{await browser.close();window.destroy();}
 },{port,url:'http://127.0.0.1:'+site.address().port+'/'});
 assert.equal(result.nativeMute,true);console.log('PASS: '+JSON.stringify(result));
}finally{if(app){await requestTestExit(app).catch(()=>{});await app.close().catch(()=>{});}site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
