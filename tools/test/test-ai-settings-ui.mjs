import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {_electron as electron} from 'playwright-core';
const root=process.cwd(),data=fs.mkdtempSync(path.join(root,'.desktop-test/ai-settings-'));
fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({version:3,taskPoints:{},reviewQueue:[],settings:{libraryShowOnStartup:false}}));
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForURL('http://127.0.0.1:*/');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1320,900);w.showInactive();});
 if(await page.locator('#libraryHome #enterWorkspace').count())await page.locator('#libraryHome #enterWorkspace').click();
 await page.locator('[data-tab="settings"]').click();const selector=page.getByLabel('AI 网页版答题通道',{exact:true});await selector.waitFor();
 assert.deepEqual(await selector.locator('option').allTextContents(),['千问网页版','豆包网页版','DeepSeek 网页版']);
 for(const [id,label]of [['doubao','豆包'],['deepseek','DeepSeek']]){
  await selector.selectOption(id);await page.locator('#saveSettings').click();
  await page.waitForFunction(async id=>(await fetch('/api/status').then(r=>r.json())).settings?.ai?.provider===id,id);
  const state=JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));assert.equal(state.settings.ai.provider,id);
  await page.waitForFunction(label=>document.querySelector('#pillQuiz').textContent.includes(label),label);
 }
 await page.getByRole('button',{name:'打开所选 AI 网页 ↗'}).waitFor();await page.getByRole('button',{name:'检测 AI 登录',exact:true}).click();
 const output=path.join(root,'.desktop-test/ai-settings-final.png');await page.screenshot({path:output});assert.deepEqual(errors,[]);
 console.log('✓ 三通道选择、保存落盘、通道灯与登录入口通过；未连接真实账号');console.log(output);
}catch(error){console.error(error.message);throw error;}finally{await app.evaluate(({app,dialog})=>{dialog.showMessageBox=async()=>({response:1});app.quit();}).catch(()=>{});await app.close().catch(()=>{});}
