// Real page/controller interaction against local fixtures only.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/zhs-restart-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {runZhihuishuVideo}=await import('../../src/platforms/zhihuishu/runner.mjs');const {PlatformRuns}=await import('../../src/platforms/runs.mjs');const {loadState}=await import('../../src/state.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 for(const mode of ['cleared','persistent']){
  const context=await b.newContext();let opened=0,clicks=0;const oldPages=[];
  await context.exposeBinding('verificationClicked',()=>{clicks++});
  await context.route('https://studyvideoh5.zhihuishu.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="https://stuonline.zhihuishu.com/report?courseId=fixture&recruitId=term">成绩</a><li class="video current_play"><b class="hour">1.1</b>${mode==='cleared'&&opened===2?'<i class="time_icofinish"></i>':''}</li><video></video>${mode==='persistent'||opened===1?'<div class="yidun_popup" style="position:fixed;inset:0" onclick="window.verificationClicked()">人工验证<div class="yidun_popup__mask" style="position:absolute;inset:0"></div></div>':''}`}));
  const task={key:mode,platform:'zhihuishu',type:'video',courseId:'zhihuishu:fixture:term',platformTaskKey:'zhihuishu:fixture:term:video:1.1',studyUrl:'https://studyvideoh5.zhihuishu.com/stuStudy',name:'示例视频'};
  const flags=[];
  const runs=new PlatformRuns({restartDelayMs:0,execute:args=>{flags.push(args.restartTask);return runZhihuishuVideo(args,{openStudy:async()=>{opened++;const page=await context.newPage();oldPages.push(page);await page.goto(task.studyUrl);return {page};}});}});
  runs.start('zhihuishu',[task],context);await runs.wait('zhihuishu');
  assert.equal(opened,2,'不是在验证页反复点播放，而是只重新进入一次');assert.deepEqual(flags,[false,true]);assert.equal(clicks,0,'不得点击或代解验证');assert.equal(oldPages[0].isClosed(),true,'重启时只关闭上次自建任务页');
  const session=runs.snapshot().zhihuishu;
  if(mode==='cleared'){assert.equal(session.phase,'completed');assert.equal(session.done,1);assert.equal(loadState().taskPoints[task.key].status,'done');assert.equal(context.pages().length,0);}
  else{assert.equal(session.phase,'needs-human');assert.equal(session.done,0);assert.equal(loadState().taskPoints[task.key].status,'pending');assert.equal(context.pages().length,1,'第二次仍验证则保留原页');assert.equal(await context.pages()[0].locator('.yidun_popup').isVisible(),true);}
  await context.close();
 }
 console.log('✓ 智慧树原生验证码单次任务重启：重进成功继续、再次验证停下保留、不点击验证、不误记完成、旧任务页清理');
}finally{await b.close();}
