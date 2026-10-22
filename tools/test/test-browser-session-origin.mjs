// Real Electron cookie engine, synthetic credentials and about:blank only.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.cwd(),data=fs.mkdtempSync(path.resolve('.desktop-test/session-origin-')),probe=path.join(data,'probe.cjs');
fs.writeFileSync(probe,`
const {app,BrowserWindow,safeStorage}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(data)});
app.whenReady().then(async()=>{
 const {EmbeddedBrowser}=require(${JSON.stringify(path.join(root,'desktop/embedded-browser.cjs'))});
 const cookie={domain:'.zhihuishu.com',hostOnly:false,path:'/',name:'CASLOGC',value:'synthetic-only',session:true,secure:false,httpOnly:false,sameSite:'unspecified'};
 fs.writeFileSync(path.join(app.getPath('userData'),'browser-session.bin'),safeStorage.encryptString(JSON.stringify([cookie,{...cookie,name:'CASTGC',secure:true,sameSite:'no_restriction'}])));
 const embedded=new EmbeddedBrowser({getContentSize:()=>[1000,700],on(){}},{dataDir:app.getPath('userData')});
 const win=new BrowserWindow({show:false,webPreferences:{session:embedded.session}});await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
 await embedded.session.cookies.set({url:'http://zhihuishu.com/',domain:'.zhihuishu.com',path:'/',name:'legacy-demo',value:'synthetic-only',secure:false,sameSite:'unspecified'});
 await embedded.restoreCookies();
 const all=(await win.webContents.debugger.sendCommand('Network.getAllCookies')).cookies;
 const legacy=all.find(c=>c.name==='legacy-demo'),auth=all.find(c=>c.name==='CASLOGC'),secure=all.find(c=>c.name==='CASTGC');
 assert.equal(legacy.sourceScheme,'NonSecure');assert.equal(legacy.sourcePort,80);
 assert.equal(auth.sourceScheme,'Secure');assert.equal(auth.sourcePort,443);assert.equal(auth.secure,false);assert.equal(auth.session,true);assert.equal(auth.value,cookie.value);
 assert.equal(secure.sourceScheme,'Secure');assert.equal(secure.secure,true);assert.equal(secure.sameSite,'None');
 fs.writeFileSync(path.join(app.getPath('userData'),'result.json'),JSON.stringify({legacyOrigin:legacy.sourceScheme,restoredOrigin:auth.sourceScheme,restoredPort:auth.sourcePort,sessionCookiePreserved:auth.session,securityFlagsUnchanged:!auth.secure&&secure.secure}));
 await embedded.close();win.destroy();app.quit();
}).catch(e=>{fs.writeFileSync(path.join(app.getPath('userData'),'error.txt'),e.stack);app.exit(1)});
`);
const result=spawnSync(path.join(root,'node_modules/electron/dist/electron.exe'),[probe],{cwd:root,encoding:'utf8',timeout:30000});
assert.equal(result.status,0,result.stderr+(fs.existsSync(path.join(data,'error.txt'))?fs.readFileSync(path.join(data,'error.txt'),'utf8'):''));
const proof=JSON.parse(fs.readFileSync(path.join(data,'result.json'),'utf8'));assert.equal(proof.restoredOrigin,'Secure');
console.log('✓ 真实 Electron：复现旧恢复的 HTTP:80 来源，智慧树恢复为 HTTPS:443；保持会话有效期和原 Secure / SameSite 标记，零网站请求');
