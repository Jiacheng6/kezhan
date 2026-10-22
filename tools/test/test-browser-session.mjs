// Synthetic cookie values only. Test native-session restore ordering without
// loading an account, opening a website or exporting any real credentials.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),dir=fs.mkdtempSync(path.resolve('.desktop-test/session-restore-'));
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(b=>b^0x5a),decryptString:b=>Buffer.from(b).map(b=>b^0x5a).toString()};
const persistent={domain:'example.test',path:'/',name:'persistent',value:'fresh-native',hostOnly:true,secure:true,httpOnly:true};
const snapshot=[{...persistent,value:'stale-backup'},...['session-one','session-two'].map(name=>({...persistent,name,value:'dummy-session-value'})),{...persistent,name:'expired',expirationDate:1}];
fs.writeFileSync(path.join(dir,'browser-session.bin'),safeStorage.encryptString(JSON.stringify(snapshot)));
const cookies=new EventEmitter(),current=[persistent],set=[];let browser;
cookies.get=async()=>current;cookies.flushStore=async()=>{};cookies.set=async cookie=>{await new Promise(r=>setTimeout(r,10));set.push(cookie.name);current.push({...cookie,domain:'example.test'});cookies.emit('changed');assert.equal(browser.timer,null,'恢复中不能触发覆盖备份的定时保存');};
const session={cookies,getUserAgent:()=>'',setUserAgent(){},setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
const module={exports:{}};const source=fs.readFileSync('desktop/embedded-browser.cjs','utf8');
vm.runInNewContext('(function(require,module){'+source+'\n})',{setTimeout,clearTimeout,URL,Buffer})(id=>id==='electron'?{session:{fromPartition:()=>session},safeStorage}:require(id==='../src/atomic-file.cjs'?'../../src/atomic-file.cjs':id),module);
browser=new module.exports.EmbeddedBrowser({getContentSize:()=>[1000,700],on(){}},{dataDir:dir});
let writeAt=-1;const original=browser.writeCookies.bind(browser);browser.writeCookies=async()=>{writeAt=set.length;await original();};
await Promise.all([browser.restoreCookies(),browser.saveCookies()]);
assert.deepEqual(set,['session-one','session-two'],'只恢复缺少的会话 Cookie，不能用旧备份覆盖有效 Cookie');assert.equal(browser.cookiesReady,true);assert.equal(writeAt,2,'保存必须等整个恢复操作结束');
const backup=fs.readFileSync(path.join(dir,'browser-session.bin'));assert.equal(backup.includes(Buffer.from('dummy-session-value')),false);assert.ok(JSON.parse(safeStorage.decryptString(backup)).some(c=>c.value==='fresh-native'));
console.log('✓ 加密会话：恢复期间不写半份备份、保留原生较新登录、补回会话 Cookie、忽略过期项、退出保存等待恢复结束');
