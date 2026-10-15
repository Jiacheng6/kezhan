// Real Edge + synthetic question only. No accounts, AI requests, or submissions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {ROOT, EDGE_FLAGS} from '../../src/config.mjs';
import {findEdge} from '../../src/browser/launch.mjs';
import {shootQuestion} from '../../src/chaoxing/quiz.mjs';
import {waitForRead} from '../../src/control.mjs';
const output=fs.mkdtempSync(path.join(ROOT,'.desktop-test/question-capture-'));
const context=await chromium.launchPersistentContext(path.join(output,'profile'),{
  executablePath:findEdge(),headless:true,
  args:EDGE_FLAGS.filter(flag=>!flag.startsWith('--user-data-dir=')&&!flag.startsWith('--remote-debugging-port=')&&flag!=='--restore-last-session'),
});
const held=[];
try {
  await context.route('https://capture.invalid/**', route=>new Promise(resolve=>held.push({route,resolve})));
  const page=context.pages()[0];
  await page.setContent('<iframe style="width:800px;height:600px;border:0"></iframe>');
  const frame=page.frames()[1];
  await frame.setContent(`<style>@font-face{font-family:EditorOnly;src:url('https://capture.invalid/editor.woff2')}.toolbar{font-family:EditorOnly}.TiMu{width:600px;padding:20px;background:#e5f1ed}.Zy_TItle{font:24px Arial}</style><div class="TiMu"><div class="Zy_TItle">Describe a reliable capture pipeline.</div><div class="toolbar">EDITOR TOOLBAR</div></div>`);
  await frame.waitForFunction(()=>document.fonts.status==='loading');
  await assert.rejects(()=>waitForRead(()=>frame.evaluate(()=>document.fonts.ready.then(()=>true)),{timeoutMs:250,message:'global fonts blocked'}),/global fonts blocked/);
  const file=await shootQuestion(frame,0,output,{readTimeoutMs:1200});
  assert.ok(fs.statSync(file).size>1000);
  assert.equal(await frame.evaluate(()=>document.fonts.status),'loading','unrelated editor font must still be pending');
  console.log('✓ 复现全局字体等待阻塞；题干字体已就绪时仍可正确截图');

  await frame.addStyleTag({content:".Zy_TItle{font-family:EditorOnly}"});
  const before=fs.readdirSync(output).filter(name=>name.endsWith('.png')).length;
  await assert.rejects(()=>shootQuestion(frame,0,output,{readTimeoutMs:250}),error=>error.captureStage==='题目字体'&&/字体尚未加载/.test(error.message));
  assert.equal(fs.readdirSync(output).filter(name=>name.endsWith('.png')).length,before,'must not save a potentially unreadable encrypted question');
  console.log('✓ 题干本身的字体未就绪时明确报错，不产生可能乱码的图片');
  await frame.addStyleTag({content:'.Zy_TItle{font-family:Arial}'});

  let captures=0,sessions=0,recovered=0;const commands=[];
  const proxiedPage=new Proxy(page,{get(target,key){
    if(key==='context')return()=>({newCDPSession:async()=>{
      sessions++;const session=await context.newCDPSession(page);
      return new Proxy(session,{get(t,k){if(k==='send')return(method,...args)=>{
        commands.push(method);
        if(method==='Page.captureScreenshot'&&++captures===1)return new Promise(()=>{});
        return t.send(method,...args);
      };return typeof t[k]==='function'?t[k].bind(t):t[k];}});
    }});
    return typeof target[key]==='function'?target[key].bind(target):target[key];
  }});
  const proxiedFrame=new Proxy(frame,{get(target,key){if(key==='page')return()=>proxiedPage;return typeof target[key]==='function'?target[key].bind(target):target[key];}});
  const recoveredFile=await shootQuestion(proxiedFrame,0,output,{readTimeoutMs:350,onRecovery:()=>recovered++});
  assert.equal(captures,2);assert.equal(sessions,2);assert.equal(recovered,1);
  assert.ok(commands.includes('Page.setWebLifecycleState'));assert.ok(commands.includes('Emulation.setFocusEmulationEnabled'));
  assert.ok(fs.statSync(recoveredFile).size>1000);
  await assert.rejects(()=>shootQuestion(frame,0,output,{shouldStop:()=>true}),{code:'STOPPED'});
  console.log('✓ 成像超时后独立会话恢复一次并取得真实截图；中止可立即响应');
} finally {
  for(const {route,resolve}of held){await route.abort().catch(()=>{});resolve();}
  await context.close();
}
