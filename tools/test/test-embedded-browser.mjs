// Full real desktop/worker/CDP chain, synthetic local learning site and AI pages.
// No external browser, account, paid service, real coursework or submission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { _electron as electron, chromium } from 'playwright-core';
import { requestTestExit } from './desktop-test-helpers.mjs';
const root = process.cwd(); fs.mkdirSync('.desktop-test', { recursive: true });
const data = fs.mkdtempSync(path.resolve('.desktop-test/embedded-full-'));
process.env.XXT_DATA_DIR = data;
const { askImage, detectVerification, checkLogin } = await import('../../src/ai/ai.mjs');
const { shootQuestion: shootQuestionCore } = await import('../../src/chaoxing/quiz.mjs');
const { watchVideoQuiz: watchVideoQuizCore, handleVideoQuiz: handleVideoQuizCore } = await import('../../src/chaoxing/videoquiz.mjs');
const { watchUntilDone } = await import('../../src/chaoxing/player.mjs');
const { applyNativeSpeed } = await import('../../src/chaoxing/playback-policy.mjs');
const { markAsked } = await import('../../src/ai/throttle.mjs');
const { mutateState } = await import('../../src/state.mjs');
const output = path.resolve('.desktop-test/embedded-browser'); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(data, 'local.json'), JSON.stringify({ personId: 'fixture-user' }));
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ taskPoints: { previous: { status: 'done' } }, settings: { ai: { askRetries: 0 } }, onboarding: { version: 1, completedAt: null } }));
const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const signed = /fixture_session=ready/.test(req.headers.cookie || '');
  if (req.url === '/cookie-check' && req.method === 'POST') return res.end(req.headers.cookie || '');
  res.end(`<meta charset="utf-8"><title>${signed ? '学习空间 · 演示账号' : '学习通登录'}</title><style>body{font:16px sans-serif;margin:50px;color:#263228;background:#f5f7f3}button,input{font:inherit;padding:10px;margin:8px 0}main{max-width:650px}.TiMu{width:600px;height:280px;background:#daf4e7;padding:20px;box-sizing:border-box}.square{width:90px;height:90px;background:#c93926}</style><main><h1>${signed ? '学习空间' : '登录学习通'}</h1><p>独立演示页面，不连接真实账号</p>${signed ? '<p>演示账号已连接。返回设置向导检测登录即可。</p>' : '<input type="password" placeholder="演示密码"><br><button id="fixtureLogin">完成演示登录</button>'}<p><button id="popup">打开课程详情</button></p><div class="TiMu"><b>截图检查</b><p>请识别方块颜色</p><div class="square"></div></div><span id="ticks">0</span></main><script>document.querySelector('#fixtureLogin')?.addEventListener('click',()=>{document.cookie='fixture_session=ready; path=/; SameSite=Lax';location.reload()});document.querySelector('#popup').onclick=()=>window.open('/detail','_blank');window.ticks=0;setInterval(()=>{document.querySelector('#ticks').textContent=++window.ticks},80)</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const home = `http://127.0.0.1:${site.address().port}/chaoxing.com/home`;
let app, browser;
const nativeCapture = async (page, rect) => {
  const session=await page.context().newCDPSession(page);let targetId;
  try{targetId=(await session.send('Target.getTargetInfo')).targetInfo.targetId}finally{await session.detach()}
  return app.evaluate(({BrowserWindow,webContents},{targetId,rect})=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
    const {EmbeddedBrowser}=require('./desktop/embedded-browser.cjs');
    const contents=webContents.fromDevToolsTargetId(targetId);
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(view=>view.webContents===contents);
    return EmbeddedBrowser.prototype.request.call({views:new Map([[contents.id,{targetId,view}]])},{method:'capture',targetId,rect});
  },{targetId,rect});
};
const shootQuestion=(frame,index,out,options={})=>shootQuestionCore(frame,index,out,{...options,nativeCapture});
const watchVideoQuiz=options=>watchVideoQuizCore({...options,nativeCapture});
const handleVideoQuiz=options=>handleVideoQuizCore({...options,nativeCapture});
const errors = []; let fixtureQAI;
async function poll(read, accept, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('等待测试状态超时');
}
async function launch() {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--embedded-test'],
    env: { ...process.env, XXT_TEST_DATA_DIR: data, XXT_EMBEDDED_TEST_HOME: home }, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1320, 900); w.setTitle('学习通助手 · 自动回归（无需登录）'); w.showInactive(); });
  await poll(() => page.evaluate(() => fetch('/api/status').then(r => r.json())), s => s.ready);
  const port = fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  return page;
}
async function exit() {
  if (browser) { await browser.close(); browser = null; }
  if (app) { await requestTestExit(app); await app.close().catch(() => {}); app = null; }
}
async function capture(file) {
  await app.evaluate(async ({ BrowserWindow }, file) => {
    await new Promise(resolve => setTimeout(resolve, 120));
    const win = BrowserWindow.getAllWindows()[0];
    const { desktopCapturer } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1320, height: 940 } });
    const source = sources.find(s => s.id === win.getMediaSourceId());
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法截取真实测试窗口');
    const image = source.thumbnail;
    process.getBuiltinModule('fs').writeFileSync(file, image.toPNG());
  }, path.join(output, file));
}
function aiHTML(id) {
  const q = id === 'qianwen', d = id === 'doubao';
  const editor = q || d ? `<div class="${d ? 'tiptap' : 'editor'}" contenteditable="true" data-placeholder="提问"></div>` : '<textarea placeholder="给 DeepSeek 发送消息"></textarea>';
  const answer = q ? '<div class="chat-answers-card-wrap">红色</div>' : d ? '<div data-testid="receive_message"><div data-testid="message_text_content">红色</div></div>' : '<div class="ds-assistant-message-main-content">红色</div>';
  return `<meta charset="utf-8"><title>${id} · 演示网页</title><style>body{font:16px sans-serif;padding:40px;background:#fff;color:#222}#composer{max-width:700px;margin-top:40px}textarea,[contenteditable]{min-height:100px;border:1px solid #bbb;padding:15px;width:100%;box-sizing:border-box}button{padding:10px;font:inherit;margin-top:12px}#attachment img{width:100px}</style><h1>${id}</h1><p>独立测试页面 · 不连接真实 AI</p><button id="fixtureAiLogin">登录</button><div id="answers"></div><div id="composer" data-testid="chat_input" class="_77cefa5" hidden>${editor}<input type="file" accept="image/png"><div id="attachment"></div><button aria-label="发送消息" data-testid="chat_input_send_button" role="button" class="ds-button--primary ds-button--circle">发送</button></div><script>
  const composer=document.querySelector('#composer'),login=document.querySelector('#fixtureAiLogin'),input=document.querySelector('input'),attachment=document.querySelector('#attachment'),editor=document.querySelector('[contenteditable],textarea');
  function ready(){composer.hidden=false;login.remove()}if(document.cookie.includes('fixture_ai=ready'))ready();else login.onclick=()=>{document.cookie='fixture_ai=ready; path=/; SameSite=Lax';ready()};
  input.onchange=()=>{attachment.innerHTML='<img alt="'+input.files[0].name+'" src="'+URL.createObjectURL(input.files[0])+'">'};
  editor.onpaste=()=>{attachment.innerHTML='<img src="https://workspace-zb-cdn.qianwen.com/fixture.png">'};
  window.sent=0;document.querySelector('#composer button').onclick=()=>{window.sent++;editor.${q || d ? 'innerText' : 'value'}='';input.value='';attachment.innerHTML='';document.querySelector('#answers').insertAdjacentHTML('beforeend',${JSON.stringify(answer)});if(window.fixtureAnswer)document.querySelector('#answers').lastElementChild.textContent=window.fixtureAnswer};</script>`;
}
try {
  let page = await launch();
  const call = async name => {
    const r = await page.evaluate(name => fetch('/api/action/' + name, { method: 'POST' }).then(r => r.json()), name);
    assert.equal(r.ok, true, JSON.stringify(r)); return r.result;
  };
  const status = await page.evaluate(() => fetch('/api/status').then(r => r.json()));
  const metadata=await app.evaluate(async()=>{
    const {EmbeddedBrowser}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('./desktop/embedded-browser.cjs');
    const record={targetId:'owned-task'},fake={views:new Map([[1,record]]),publish(){}};
    const request=params=>EmbeddedBrowser.prototype.request.call(fake,params);
    await request({method:'annotate',targetId:'owned-task',role:'video',busy:true});const started={role:record.role,busy:record.busy};
    await request({method:'annotate',targetId:'owned-task',busy:false});
    let rejected=false;try{await request({method:'annotate',targetId:'outside',busy:true})}catch{rejected=true}
    return {started,finished:record.busy,rejected};
  });
  assert.deepEqual(metadata,{started:{role:'video',busy:true},finished:false,rejected:true});

  assert.equal(status.browserMode, 'embedded'); assert.equal(status.edge.launched, false); assert.equal(status.login.loggedIn, false);
  assert.equal((await page.evaluate(() => window.desktopApp.webState())).tabs.some(tab => tab.url === 'about:blank'), false, '启动复用初始页，不留下多余空白标签');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.locator('#onboardingPanel[open]').waitFor(); await page.locator('#onboardingOpenLogin').click();
  await page.locator('#embeddedBrowser').waitFor({ state: 'visible' }); await page.locator('#onboardingPanel').waitFor({ state: 'hidden' });
  let learning = await poll(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(home)), p => !!p);
  assert.ok(learning); assert.equal(await learning.evaluate(() => typeof window.desktopApp), 'undefined');
  assert.equal(await learning.evaluate(() => typeof require), 'undefined');
  await capture('01-login.png');
  await learning.locator('#fixtureLogin').click(); await learning.getByText('演示账号已连接。', { exact: false }).waitFor();
  await page.locator('#webReturn').click(); await page.locator('#onboardingPanel[open]').waitFor(); await page.locator('#onboardingCheckLogin').click();
  await page.waitForFunction(() => !document.getElementById('onboardingNext').disabled); await page.locator('#onboardingNext').click();
  const raw = browser.contexts()[0];
  const png = fs.readFileSync(await shootQuestion(learning.mainFrame(), 0, output)); const imagePath = path.join(output, 'question.png'); fs.writeFileSync(imagePath, png);
  // Electron's persistent partition has its own network session. Install the
  // fixture there so cross-origin image requests use the same isolated server.
  await app.evaluate(({ session }, fixture) => {
    session.fromPartition('persist:learning-web').protocol.handle('https', request => {
      const host = new URL(request.url).hostname;
      if (host === 'workspace-zb-cdn.qianwen.com') return new Response(Buffer.from(fixture.png, 'base64'), { headers: { 'content-type': 'image/png' } });
      const id = host === 'www.doubao.com' ? 'doubao' : host === 'chat.deepseek.com' ? 'deepseek' : host === 'www.qianwen.com' ? 'qianwen' : null;
      return new Response(id ? fixture.html[id] : 'Fixture blocked unexpected host', { status: id ? 200 : 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
  }, { png: png.toString('base64'), html: Object.fromEntries(['qianwen', 'doubao', 'deepseek'].map(id => [id, aiHTML(id)])) });
  for (const id of (process.argv.includes('--q-only') ? ['qianwen'] : ['doubao', 'deepseek', 'qianwen'])) {
    await page.locator(`input[name=onboardingProvider][value=${id}]`).check(); await page.locator('#onboardingOpenAI').click();
    await page.locator('#embeddedBrowser').waitFor({ state: 'visible' });
    const ai = await (async () => { for (let i = 0; i < 100; i++) { const found = raw.pages().find(p => p.url().includes(id === 'qianwen' ? 'qianwen.com' : id + '.com')); if (found) return found; await new Promise(r => setTimeout(r, 30)); } })();
    assert.ok(ai); await ai.locator('#fixtureAiLogin').click();
    if(id==='qianwen')fixtureQAI=ai;
    if (id === 'qianwen') {
      await ai.evaluate(() => {
        const mask = document.createElement('div'); mask.className = 'baxia-dialog-mask'; mask.id = 'fixtureChallenge';
        mask.style.cssText = 'position:fixed;inset:0;background:#fff';
        mask.innerHTML = '<iframe src="about:blank#punish"></iframe>'; document.body.append(mask);
        const login = document.createElement('button'); login.textContent = '登录'; login.hidden = true; document.body.append(login);
      });
      assert.equal((await detectVerification(ai)).required, true, '真实显示的人工验证必须阻断');
      await ai.evaluate(() => document.getElementById('fixtureChallenge').hidden = true);
      assert.equal((await detectVerification(ai)).required, false, '验证完成后的隐藏节点不能继续阻断');
      assert.equal((await checkLogin(ai)).loggedIn, true, '隐藏登录按钮不应覆盖真实登录态');
    }
    await page.locator('#webReturn').click(); await page.locator('#onboardingPanel[open]').waitFor(); await page.locator('#onboardingCheckAI').click();
    await page.locator('#onboardingAIStatus').filter({ hasText: '已登录' }).waitFor();
    if (id === 'qianwen') assert.equal(await ai.evaluate(() => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = 'https://workspace-zb-cdn.qianwen.com/preflight.png'; setTimeout(() => resolve(false), 5000); })), true, '合成图片路由必须可解码');
    const result = await askImage({ page: ai, imagePath, prompt: '只回答方块颜色', freshChat: false });
    if (!result.ok) console.log('AI fixture state:', await ai.evaluate(() => ({ images: [...document.images].map(i => ({ src: i.src, width: i.naturalWidth, complete: i.complete })), paste: typeof document.querySelector('[contenteditable]')?.onpaste, attachment: document.querySelector('#attachment')?.innerHTML })));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.answer, '红色');
    console.log(`✓ ${id} 内置网页：真实上传/粘贴、发送与新回答读取通过（合成页面）`);
  }
  await page.screenshot({ path: path.join(output, '02-setup.png') });
  await page.locator('#onboardingNext').click(); await page.locator('#onboardingPanel').waitFor({ state: 'hidden' });
  // Native notification click must select the existing AI view, preserving its
  // captcha/conversation; no new AI page or reload is allowed.
  await fixtureQAI.evaluate(() => window.fixtureKeepAI = true);
  await app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('./desktop/main.cjs').notificationCenter.push({kind:'ai-verification',key:'fixture-ai-notice'});
  });
  await page.locator('#notificationPrompt[open]').waitFor();
  await page.locator('#notificationPrompt [data-handle]').click();
  await poll(() => page.evaluate(() => window.desktopApp.webState()), s => s.visible && s.tabs.find(t => t.id === s.active)?.url.includes('qianwen.com'));
  assert.equal(await fixtureQAI.evaluate(() => window.fixtureKeepAI),true,'通知打开 AI 不得重载验证页面');
  await page.locator('#webReturn').click();
  // Exercise a real worker -> main process -> renderer notice, with only the
  // synthetic site's login cookie changed.
  await learning.evaluate(() => {document.cookie='fixture_session=; Max-Age=0; path=/';});
  await call('refreshLogin');
  await page.locator('#notificationPrompt[open]').waitFor();
  assert.match(await page.locator('#notificationPromptTitle').innerText(),/登录学习通/);
  const loginNotice = await page.evaluate(async () => (await window.desktopApp.notifications()).items.find(n => n.kind === 'login-required'));
  assert.ok(loginNotice); await page.evaluate(id => window.desktopApp.readNotification(id),loginNotice.id);
  await page.locator('#notificationPrompt [data-later]').click();
  await learning.locator('#fixtureLogin').click(); await call('refreshLogin');
  console.log('✓ 真实 worker 通知到桌面、登录失效提醒、点击直达原 AI 页面且不重载通过');
  await learning.evaluate(() => window.fixtureKeepDocument = true);
  await call('openChaoxing'); await page.locator('#embeddedBrowser').waitFor();
  assert.equal(await learning.evaluate(() => window.fixtureKeepDocument), true, '打开已有学习通网页不应重载当前页面');
  await learning.locator('#popup').click();
  await poll(() => page.evaluate(() => window.desktopApp.webState()), s => s.tabs.some(t => t.url.endsWith('/detail')));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, '新页面仍留在软件内');
  await page.locator('#viewWebPages').click();await page.locator('#webPagesDialog[open]').waitFor();
  assert.ok(await page.locator('#webPagesList .wp-page').count() >= 4);
  const initialPages=await page.evaluate(()=>window.desktopApp.webState());
  const learningId=initialPages.tabs.find(tab=>tab.url.startsWith(home)).id;
  await app.evaluate(()=>{
    const {EmbeddedBrowser}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('./desktop/embedded-browser.cjs');
    const original=EmbeddedBrowser.prototype.command;
    EmbeddedBrowser.prototype.command=function(command){
      if(command.action==='fixture-annotate')return this.request({method:'annotate',targetId:command.targetId,role:command.role,busy:command.busy});
      return original.call(this,command);
    };
  });
  const taskTarget=initialPages.tabs.find(tab=>tab.id===learningId).targetId;
  await page.evaluate(targetId=>window.desktopApp.webCommand({action:'fixture-annotate',targetId,role:'video',busy:true}),taskTarget);
  await page.locator('#webTaskJump').waitFor({state:'visible'});await capture('05-page-picker.png');
  await page.locator('#webTaskJump').click();
  assert.equal((await page.evaluate(()=>window.desktopApp.webState())).active,learningId,'当前任务入口准确切换到忙碌任务，不选核对页面');
  assert.equal(await learning.evaluate(()=>window.fixtureKeepDocument),true,'查看任务不应重载页面');
  await page.locator('#viewWebPages').click();

  await page.locator(`#webPagesList [data-page-id="${learningId}"]`).click();
  await page.locator('#webPagesDialog').waitFor({state:'hidden'});
  assert.equal((await page.evaluate(()=>window.desktopApp.webState())).active,learningId);
  await page.locator('#webReturn').click();await page.locator('#viewWebPages').click();
  await page.locator('#webPagesDialog[open]').waitFor();await page.keyboard.press('Escape');
  assert.equal((await page.evaluate(()=>window.desktopApp.webState())).visible,false,'关闭列表不应擅自显示或导航网页');
  await page.locator('#viewWebPages').click();await page.locator('#webPagesClose').click();
  await page.evaluate(targetId=>window.desktopApp.webCommand({action:'fixture-annotate',targetId,busy:false}),taskTarget);
  await page.evaluate(()=>window.desktopApp.webCommand({action:'show'}));
  const tabs = await page.evaluate(() => window.desktopApp.webState());
  assert.ok(tabs.tabs.every(t => !t.url.includes('/loading.html') && t.url !== page.url()));
  await page.locator(`#webTabs [data-web-id="${tabs.tabs.find(t => t.url.startsWith(home)).id}"]`).click();
  await capture('03-learning.png');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
  await new Promise(resolve=>setTimeout(resolve,300));
  const remoteBounds = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.map(view=>view.getBounds()));
  assert.ok(remoteBounds.every(bounds=>bounds.width>100&&bounds.height>100),'最小化不能把后台网页缩成1×1');
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.restore();window.showInactive();});
  await learning.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'), stream = canvas.captureStream(20), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const stopped = new Promise(resolve => recorder.onstop = resolve);
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    const draw = setInterval(() => { context.fillStyle = Date.now() % 2 ? '#337b57' : '#c93926'; context.fillRect(0, 0, 160, 90); }, 40);
    await new Promise(resolve => setTimeout(resolve, 1500)); recorder.stop(); await stopped;
    clearInterval(draw); stream.getTracks().forEach(track => track.stop());
    const video = document.createElement('video'); video.id = 'fixtureVideo'; video.muted = true; video.loop = true;
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); document.body.append(video);
    await video.play();
  });
  assert.ok(await learning.locator('#fixtureVideo').evaluate(video => video.videoWidth > 0 && video.canPlayType('video/mp4; codecs="avc1.42E01E"')), '内置引擎解码视频，支持学习通常用 MP4 格式');
  const nativeFixture = async (rates, menu = false) => learning.evaluate(({ rates, menu }) => {
    const video = document.getElementById('fixtureVideo'); video.playbackRate = 1;
    document.body.append(video); document.querySelector('.video-js')?.remove();
    const wrapper = document.createElement('div'); wrapper.className = 'video-js';
    const button = document.createElement('button'); button.className = 'vjs-playback-rate'; button.textContent = '播放速度';
    button.onclick = () => { if (menu) wrapper.querySelector('.vjs-menu-item').hidden = false; else video.playbackRate = rates[(rates.indexOf(video.playbackRate) + 1) % rates.length]; };
    wrapper.append(video, button);
    if (menu) { const item = document.createElement('button'); item.className = 'vjs-menu-item'; item.hidden = true; item.textContent = '1.5x'; item.onclick = () => video.playbackRate = 1.5; button.append(item); }
    document.body.prepend(wrapper);
  }, { rates, menu });
  await nativeFixture([1, 1.5, 2]); assert.equal((await applyNativeSpeed(learning.mainFrame(), '2')).actual, 2, '只通过播放器按钮切到 2×');
  await nativeFixture([1, 1.25, 1.5]); assert.equal((await applyNativeSpeed(learning.mainFrame(), '2')).actual, 1, '没有 2× 的课程恢复 1×');
  await nativeFixture([1, 1.5], true); assert.equal((await applyNativeSpeed(learning.mainFrame(), '1.5')).actual, 1.5, '支持原生菜单选速');
  await applyNativeSpeed(learning.mainFrame(), '1');
  const before = await learning.evaluate(() => window.ticks); await page.locator('#webReturn').click();
  await nativeFixture([1, 1.5, 2]);
  assert.equal((await applyNativeSpeed(learning.mainFrame(), '2')).actual, 2, '网页收起时仍能操作课程原生倍速控件');
  await applyNativeSpeed(learning.mainFrame(), '1');
  await learning.waitForFunction(value => window.ticks > value + 3, before);
  await learning.waitForFunction(() => document.getElementById('fixtureVideo').currentTime > .4);
  assert.equal(await learning.locator('#fixtureVideo').evaluate(video => video.paused), false, '返回工作台后视频继续播放');
  const shot = await shootQuestion(learning.mainFrame(), 0, output);
  assert.ok(fs.statSync(shot).size > 1000); assert.equal(fs.readFileSync(shot).readUInt32BE(16), 600);
  const showQuiz = async (withOptions = true) => learning.evaluate(withOptions => {
    document.querySelector('.ans-videoquiz')?.remove();
    const quiz = document.createElement('div'); quiz.className = 'ans-videoquiz'; quiz.style.cssText = 'width:640px;height:350px;background:white';
    quiz.innerHTML = '<h2 class="tkTopic_title">单选题</h2><p class="tkItem_title">演示问题</p>' + (withOptions ? '<ul><li class="ans-videoquiz-opt"><label style="display:block"><input type="radio" name="quiz">A、示例甲</label></li><li class="ans-videoquiz-opt"><label style="display:block"><input type="radio" name="quiz">B、示例乙</label></li></ul>' : '') + '<button id="videoquiz-submit">提交</button>';
    document.body.append(quiz); window.fixtureQuizSubmits = 0;
    quiz.querySelector('button').onclick = () => window.fixtureQuizSubmits++;
  }, withOptions);
  await showQuiz();
  const shared = {}, manualEvents = [];
  await watchVideoQuiz({ page: learning, qianwenPage: null, shared, intervalMs: 20, onEvent: event => manualEvents.push(event) });
  assert.equal(shared.needsHuman, true, '未连接 AI 的弹窗明确转待人工');
  assert.equal(manualEvents.length, 1); assert.equal(manualEvents[0].needsHuman, true);
  assert.equal((await watchUntilDone({ page: learning, shared })).reason, 'quiz-needs-human');
  assert.equal(await learning.evaluate(() => window.fixtureQuizSubmits), 0, '不能跳过或提交待人工弹窗');
  mutateState(state=>{state.settings.ai.minIntervalMs=0;state.settings.ai.jitterMs=0});
  await learning.evaluate(()=>{
    document.getElementById('fixtureVideo').pause();
    document.getElementById('videoquiz-submit').onclick=()=>{
      window.fixtureQuizSubmits++;document.querySelector('.ans-videoquiz').hidden=true;
      void document.getElementById('fixtureVideo').play();
    };
  });
  await fixtureQAI.evaluate(()=>window.fixtureAnswer='答案：A');
  const solved = await handleVideoQuiz({page:learning,frame:learning.mainFrame(),qianwenPage:fixtureQAI});
  assert.equal(solved.ok,true,'演示弹窗完整链路：截图、AI、点选、提交、平台关闭');
  assert.equal(await learning.evaluate(()=>window.fixtureQuizSubmits),1);
  assert.equal(await learning.locator('#fixtureVideo').evaluate(video=>video.paused),false,'演示站点确认后恢复播放');
  await showQuiz();
  await learning.evaluate(()=>{
    document.querySelector('.tkTopic_title').textContent='多选题';
    document.querySelector('.ans-videoquiz ul').innerHTML=['A','B','C'].map(letter=>`<li class="ans-videoquiz-opt"><label style="display:block"><input type="checkbox" ${letter==='C'?'checked':''}>${letter}、示例选项</label></li>`).join('');
  });
  await fixtureQAI.evaluate(()=>window.fixtureAnswer='答案：AB');
  const inconsistent = await handleVideoQuiz({page:learning,frame:learning.mainFrame(),qianwenPage:fixtureQAI});
  assert.equal(inconsistent.needsHuman,true,'多选题存在额外勾选时不能提交');
  assert.match(inconsistent.error,/回读与预期不一致/);
  assert.equal(await learning.locator('.ans-videoquiz input:checked').count(),3,'A/B已正确点选，仍须拦截额外选中的C');
  assert.equal(await learning.evaluate(()=>window.fixtureQuizSubmits),0);
  mutateState(state=>{state.settings.ai.minIntervalMs=45000});
  markAsked(); const stopAt = Date.now() + 100;
  await assert.rejects(handleVideoQuiz({page:learning,frame:learning.mainFrame(),qianwenPage:{},shouldStop:()=>Date.now() >= stopAt}), error => error.code === 'STOPPED');
  assert.equal(await learning.evaluate(() => window.fixtureQuizSubmits), 0, '停止后不能继续发送或提交');
  await showQuiz(false); const unsupported = {};
  await watchVideoQuiz({page:learning,qianwenPage:null,shared:unsupported,intervalMs:100});
  assert.equal(unsupported.needsHuman,true,'未知弹窗结构限时转待人工，不能无限空转');
  await learning.evaluate(()=>document.querySelector('.ans-videoquiz').remove());
  console.log('✓ 演示弹窗完整提交/续播；多选回读不一致阻止提交；无 AI/结构不兼容转待人工；停止后不提交');
  // Cleanup only sees remote views, never the trusted workspace itself.
  await call('cleanupPages'); assert.equal(await page.locator('#panel-courses').isVisible(), true);
  await page.evaluate(() => window.desktopApp.browser(true));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await page.locator('#desktopClosePanel[open]').waitFor();
  await page.screenshot({ path: path.join(output, '04-close.png') }); await page.locator('#closeCancel').click();
  await page.evaluate(() => window.desktopApp.browser(false));
  assert.deepEqual(errors, []); await exit();
  assert.ok(fs.statSync(path.join(data, 'browser-session.bin')).size > 0);
  assert.equal(fs.readFileSync(path.join(data, 'browser-session.bin')).includes(Buffer.from('fixture_session')), false, '登录快照必须加密');
  page = await launch();
  assert.equal((await page.evaluate(() => fetch('/api/status').then(r => r.json()))).login.loggedIn, true, '重启后保留会话 Cookie');
  assert.equal(await page.locator('#onboardingPanel').evaluate(e => e.open), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).taskPoints.previous.status, 'done');
  console.log('✓ 完整桌面链路：无外部浏览器、内置登录、向导往返、三 AI、原生新页、隐藏后视频持续播放、截图、页面隔离、关闭确认、加密会话与重启进度保留通过');
} finally {
  await exit().catch(() => {}); site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
}
