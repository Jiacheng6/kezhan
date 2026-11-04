// Real packaged Electron, synthetic data only. No site logins or installer execution.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright-core';import {requestTestExit} from './desktop-test-helpers.mjs';
const require=createRequire(import.meta.url),{migrateProfile}=require('../../desktop/brand.cjs');
const executablePath=path.resolve(process.env.KEBO_BRAND_TEST_EXE || '.desktop-test/kebo-package/win-unpacked/课栈.exe');
const root=fs.mkdtempSync(path.resolve('.desktop-test/brand-cold-')),legacy=path.join(root,'XuexitongAssistant');
const launch=data=>electron.launch({executablePath,args:['--test-mode'],env:{...process.env,KEBO_TEST_DATA_DIR:data}});
let application;
try {
 application=await launch(legacy);let page=await application.firstWindow();await page.waitForURL('http://127.0.0.1:*/');
 assert.match(await page.title(),/^课栈/);
 const identity=await application.evaluate(({app})=>({name:app.getName(),userData:app.getPath('userData'),version:app.getVersion()}));assert.equal(identity.name,'课栈');
 const encrypted=await application.evaluate(async({session,safeStorage})=>{
   const s=session.fromPartition('persist:learning-web');
   await s.cookies.set({url:'https://brand-fixture.invalid',name:'synthetic-login',value:'retained',expirationDate:Date.now()/1000+3600});
   await s.cookies.flushStore();return safeStorage.encryptString('synthetic-api-secret').toString('base64');
 });
 await requestTestExit(application);await application.close();application=null;
 const migrated=migrateProfile(root);assert.equal(migrated.migrated,true);
 application=await launch(migrated.directory);page=await application.firstWindow();await page.waitForURL('http://127.0.0.1:*/');
 const result=await application.evaluate(async({app,session,safeStorage},encrypted)=>({
   name:app.getName(),userData:app.getPath('userData'),
   cookie:(await session.fromPartition('persist:learning-web').cookies.get({name:'synthetic-login'}))[0]?.value,
   secret:safeStorage.decryptString(Buffer.from(encrypted,'base64')),
 }),encrypted);
 assert.equal(result.name,'课栈');assert.equal(result.userData,migrated.directory);assert.equal(result.cookie,'retained');assert.equal(result.secret,'synthetic-api-secret');
 assert.equal(await page.locator('.brand h1').innerText(),'课栈\nKEZHAN');
 fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify({version:identity.version,title:true,dataDirectory:'Kebo',cookieRetained:true,encryptedConfigRetained:true,installerExecuted:false},null,2));
 console.log('✓ 打包后的课栈真实启动：新名称、新数据目录、旧目录复制后的模拟登录Cookie和加密配置均保留，未安装或连接账号');
}finally{if(application){await requestTestExit(application).catch(()=>{});await application.close().catch(()=>{});}}
