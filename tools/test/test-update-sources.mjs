import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { UpdateController } = require('../../desktop/updates.cjs');
const { prepareOfflineUpdate, readPreference, writePreference, SOURCES } = require('../../desktop/update-sources.cjs');
const root=fs.mkdtempSync(path.join(process.cwd(),'.desktop-test','update-sources-'));
const sources=SOURCES.map(source=>({...source}));
const info=(version='9.9.9',hash='same-hash')=>({version,files:[{url:`XuexitongAssistant-${version}-Setup.exe`,sha512:hash,size:512}]});
class Updater extends EventEmitter {
  calls=[]; checks={}; downloads={}; current='';
  setFeedURL(provider) {this.current=provider.provider==='github'?'github':'cnb';}
  async checkForUpdates() {
    this.calls.push(`check:${this.current}`); this.emit('checking-for-update');
    const action=this.checks[this.current];
    if(action instanceof Error) {this.emit('error',action);throw action;}
    const updateInfo=action||info();
    this.emit(updateInfo.version==='0.6.9'?'update-not-available':'update-available',updateInfo);
    return {updateInfo};
  }
  async downloadUpdate() {
    this.calls.push(`download:${this.current}`);
    const action=this.downloads[this.current];
    if(action instanceof Error) {this.emit('error',action);throw action;}
    this.emit('update-downloaded',this.checks[this.current]||info());
  }
}
const make=(options={})=>{const updater=new Updater();const events=[];const controller=new UpdateController(updater,{version:'0.6.9',sources,onStatus:x=>events.push(x),...options});return {updater,controller,events};};
{
  const {updater,controller,events}=make();updater.checks.cnb=new Error('ECONNRESET');
  const status=await controller.checkAtStartup();assert.equal(status.busy,false,'检查回传时已经释放操作锁');
  assert.deepEqual(updater.calls,['check:cnb','check:github']);
  assert.equal(controller.snapshot().sourceName,'GitHub');assert.equal(controller.snapshot().notificationPending,true);
  assert.equal(events.some(x=>x.phase==='error'),false,'主渠道失败不产生中途失败通知');
}
{
  const {updater,controller}=make();updater.checks.cnb=info('0.6.9');
  await controller.check();assert.equal(controller.snapshot().nextVersion,'9.9.9','国内源尚未同步时仍可从备用源发现新版');
}
{
  const {updater,controller}=make();updater.checks.cnb=info('0.6.9');updater.checks.github=new Error('timeout');
  await controller.check();assert.equal(controller.snapshot().phase,'current');assert.match(controller.snapshot().message,/其他渠道暂时不可用/);
}
{
  const {updater,controller}=make();updater.downloads.cnb=new Error('network unavailable');
  await controller.check();assert.equal((await controller.download()).busy,false,'切换下载回传时已经释放操作锁');
  assert.deepEqual(updater.calls,['check:cnb','download:cnb','check:github','download:github']);
  assert.equal(controller.snapshot().phase,'ready');assert.equal(controller.snapshot().sourceName,'GitHub');
}
for(const [alternate, failure] of [[info('9.9.8'),/版本或校验值不同/],[info('9.9.9','different-hash'),/版本或校验值不同/]]) {
  const {updater,controller}=make();updater.downloads.cnb=new Error('timeout');updater.checks.github=alternate;
  await controller.check();await controller.download();
  assert.equal(controller.snapshot().downloadReady,false);assert.equal(controller.snapshot().nextVersion,null);
  assert.match(controller.snapshot().message,failure);await controller.download();
  assert.equal(updater.calls.includes('download:github'),false,'不能在失败后盲下另一个版本');
}
{
  const {updater,controller}=make();updater.downloads.cnb=new Error('sha512 checksum mismatch');
  await controller.check();await controller.download();assert.deepEqual(updater.calls,['check:cnb','download:cnb'],'坏包停止，不能静默换源掩盖');
}
{
  const {updater,controller}=make({sourcePreference:'github',savePreference:value=>writePreference(root,value)});
  await controller.check();assert.deepEqual(updater.calls,['check:github']);
  controller.setSource('cnb');assert.equal(readPreference(root),'cnb');assert.throws(()=>controller.setSource('other'));
}
{
  const {controller}=make({prepareLocal:()=>{throw new Error('取消后不应准备安装包');}});
  await controller.check();const before=controller.snapshot();
  const after=await controller.importLocal(async()=>null);
  assert.equal(after.busy,false);assert.equal(after.phase,before.phase);assert.equal(after.nextVersion,before.nextVersion);
}
// Copy + checksum + loopback feed is the actual offline path, without executing an installer.
const body=Buffer.alloc(256*1024,77),version='9.9.9';
const installer=path.join(root,`XuexitongAssistant-${version}-Setup.exe`),manifest=path.join(root,'release-manifest.json');
const meta={version,files:[{file:path.basename(installer),bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}]};
fs.writeFileSync(installer,body);fs.writeFileSync(manifest,JSON.stringify(meta));
const local=await prepareOfflineUpdate({installer,manifest},{dataDir:root,currentVersion:'0.6.9'});
try {
  const feed=await(await fetch(local.provider.url+'latest.yml')).json();assert.equal(feed.version,version);
  assert.deepEqual(Buffer.from(await(await fetch(local.provider.url+path.basename(installer))).arrayBuffer()),body);
  assert.equal((await fetch(new URL('/state.json',local.provider.url))).status,404);
  assert.equal((await fetch(new URL('/latest.yml',local.provider.url))).status,404,'无令牌不能读取离线包');
  fs.writeFileSync(installer,Buffer.alloc(body.length,1));
  assert.deepEqual(Buffer.from(await(await fetch(local.provider.url+path.basename(installer))).arrayBuffer()),body,'只读取已经校验过的私有缓存副本');
} finally {await local.close();}
await assert.rejects(()=>prepareOfflineUpdate({installer,manifest},{dataDir:root,currentVersion:'0.6.9'}),/校验失败/);
fs.writeFileSync(installer,body);
await assert.rejects(()=>prepareOfflineUpdate({installer,manifest},{dataDir:root,currentVersion:'9.9.9'}),/比当前版本更新/);
for(const version of ['0.6.8','9.9.9-beta.1','09.9.9']){
  fs.writeFileSync(manifest,JSON.stringify({...meta,version}));
  await assert.rejects(()=>prepareOfflineUpdate({installer,manifest},{dataDir:root,currentVersion:'0.6.9'}),/比当前版本更新/);
}
const nextInstaller=path.join(root,'XuexitongAssistant-0.6.10-Setup.exe');fs.writeFileSync(nextInstaller,body);
fs.writeFileSync(manifest,JSON.stringify({version:'0.6.10',files:[{...meta.files[0],file:path.basename(nextInstaller)}]}));
const numericVersion=await prepareOfflineUpdate({installer:nextInstaller,manifest},{dataDir:root,currentVersion:'0.6.9'});await numericVersion.close();
meta.files[0].file='../arbitrary.exe';fs.writeFileSync(manifest,JSON.stringify(meta));
await assert.rejects(()=>prepareOfflineUpdate({installer,manifest},{dataDir:root,currentVersion:'0.6.9'}),/未包含有效/);
assert.deepEqual(fs.readdirSync(path.join(root,'updates','offline')),[],'测试产生的离线缓存已清理');
console.log('✓ 更新源检查/下载失败自动切换、同版本同校验、手选渠道持久化、离线校验与缓存隔离通过');
