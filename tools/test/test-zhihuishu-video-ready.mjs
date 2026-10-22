import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {findEdge} from '../../src/browser/launch.mjs';import {waitZhihuishuVideoReady} from '../../src/platforms/zhihuishu/video.mjs';
const b=await chromium.launch({executablePath:findEdge(),headless:true});
try{
 const p=await b.newPage();await p.route('https://studyvideoh5.zhihuishu.com/**',r=>r.fulfill({contentType:'text/html',body:`<a href="https://stuonline.zhihuishu.com/report?courseId=c&recruitId=t">report</a><li class="video current_play"><b class="hour">1.1</b></li><video></video><script>window.media={source:'old',duration:100,ready:4};const v=document.querySelector('video');Object.defineProperties(v,{currentSrc:{get:()=>media.source},duration:{get:()=>media.duration},readyState:{get:()=>media.ready}});window.plays=0;v.play=()=>window.plays++;setTimeout(()=>{media.source='new';media.duration=300;media.ready=0},400);setTimeout(()=>media.ready=4,900);</script>`}));await p.goto('https://studyvideoh5.zhihuishu.com/stuStudy');
 const started=Date.now();await waitZhihuishuVideoReady(p,{expectedKey:'zhihuishu:c:t:video:1.1',previousSource:'old',timeoutMs:4000});assert.ok(Date.now()-started>=1500,'选中项已更新时仍须等待新媒体和稳定元数据');assert.equal(await p.evaluate(()=>window.plays),0,'只做就绪核对，不操作旧视频');
 await assert.rejects(waitZhihuishuVideoReady(p,{expectedKey:'different',timeoutMs:200}),/尚未加载就绪/);
 await assert.rejects(waitZhihuishuVideoReady(p,{expectedKey:'zhihuishu:c:t:video:1.1',shouldStop:()=>true}),e=>e.code==='STOPPED');
 console.log('✓ 智慧树切片：旧源与旧时长不作准、等待新源加载稳定、身份不符停止、支持取消、零播放操作');
}finally{await b.close();}
