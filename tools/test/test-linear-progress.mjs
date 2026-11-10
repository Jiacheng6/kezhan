import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
import {planProgress,sampleProgress} from '../../src/ui/linear-progress.js';
import {taskProgressForecast,batchProgressForecast} from '../../src/ui/task-progress.js';
const input={key:'one',measured:.2,ceiling:.8,rate:.01,running:true};
const plan=planProgress(null,input,0);assert.ok(Math.abs(sampleProgress(plan,10000)-.3)<1e-9);assert.ok(Math.abs(sampleProgress(plan,20000)-.4)<1e-9);
const paused=planProgress(plan,{...input,running:false},12000);assert.equal(sampleProgress(paused,30000),sampleProgress(plan,12000));
const resumed=planProgress(paused,input,30000);assert.equal(sampleProgress(resumed,30000),sampleProgress(paused,30000));
assert.ok(sampleProgress(resumed,31000)>sampleProgress(resumed,30000));
const ahead=planProgress(plan,{...input,measured:.6},1000);assert.equal(sampleProgress(ahead,1000),sampleProgress(plan,1000));assert.ok(sampleProgress(ahead,1600)<.6);
assert.ok(sampleProgress(planProgress(null,{...input,measured:.99,ceiling:1},0),100000)<1);
const work={running:true,progress:{current:'AI 测验',taskType:'work',questionIndex:1,questionTotal:4,phase:'asking'}};
const f=taskProgressForecast(work);assert.equal(f.measured,.25);assert.ok(f.ceiling>.25&&f.ceiling<.5);assert.ok(f.estimated);
const total=batchProgressForecast({platforms:{ucampus:{running:true,total:10,done:2,current:'AI 测验',progress:work.progress}}});assert.equal(total.measured,.225);assert.ok(total.rate>0);
const {findEdge}=await import('../../src/browser/launch.mjs');const browser=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1050,height:720}});
 await page.route('https://progress.test/**',route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  if(name.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.resolve('src/ui',name),'utf8')});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<style>:root{--acc:#69c6a6;--fg:#e6efea;--line:#314139;--bg3:#18261f;--bg2:#142019;--muted:#92a79b;--ease-out:ease-out;font-family:Segoe UI,Microsoft YaHei;color:var(--fg);background:#0e1712}body{padding:50px;max-width:800px;margin:auto}h1{font-size:24px}#task{margin-top:30px}button{color:inherit} ${fs.readFileSync('src/ui/task-progress.css','utf8')}</style><h1>连续进度 · 本地验证</h1><p>线性推进 / 暂停冻结 / 恢复衔接 / 完成前不走满</p><div id="task"></div><script type="module">import {renderTaskProgress} from '/task-progress.js';window.render=s=>renderTaskProgress(document.querySelector('#task'),s);window.ready=true;</script>`});
 });
 await page.goto('https://progress.test/');await page.waitForFunction(()=>window.ready);
 const video={running:true,progress:{current:'演示视频 · 连续推进',taskType:'video',percent:.2,currentTime:20,duration:100,playbackRate:1}};
 const show=s=>page.evaluate(s=>window.render(s),s),value=()=>page.locator('[role=progressbar]').getAttribute('aria-valuenow').then(Number);
 await show(video);await page.waitForTimeout(300);const a=await value();await page.waitForTimeout(300);const b=await value();await page.waitForTimeout(300);const c=await value();assert.ok(a<b&&b<c);assert.ok(Math.abs((b-a)-(c-b))<.25,'均匀推进');
 await show({...video,progress:{...video.progress,paused:true}});const stopped=await value();await page.waitForTimeout(600);assert.equal(await value(),stopped,'暂停立即冻结');
 await show(video);await page.waitForTimeout(500);assert.ok(await value()>stopped);
 await show(work);await page.waitForTimeout(500);assert.ok(await value()>25&&await value()<50);
 await fs.promises.mkdir('.desktop-test',{recursive:true});await page.screenshot({path:'.desktop-test/linear-progress-verified.png'});
 await page.emulateMedia({reducedMotion:'reduce'});await show({...work,progress:{...work.progress,questionIndex:2}});assert.equal(await value(),50);await page.waitForTimeout(400);assert.equal(await value(),50);
 console.log('✓ 线性连续推进、平滑校正、暂停恢复、不提前满格、总进度部分贡献、减少动态与真实浏览器验证');
}finally{await browser.close();}
