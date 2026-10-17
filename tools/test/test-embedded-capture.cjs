// Real Electron surfaces. No accounts, external sites, AI calls or submissions.
const {app,BrowserWindow,webContents,nativeImage,desktopCapturer}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../..');fs.mkdirSync(path.join(root,'.desktop-test'),{recursive:true});
const data=fs.mkdtempSync(path.join(root,'.desktop-test/embedded-capture-'));
app.setPath('userData',data);app.commandLine.appendSwitch('remote-debugging-port','0');
app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-background-timer-throttling');
const {EmbeddedBrowser}=require('../../desktop/embedded-browser.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,ms=8000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capture regression timed out')),ms)})])}finally{clearTimeout(timer)}}
let window,cover,manager,server;const results=[];
app.whenReady().then(async()=>{try{
 server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{margin:0}.TiMu{position:relative;width:600px;height:350px;background:#ecf3f7;margin:25px;font:24px sans-serif}.swatch{position:absolute;left:30px;top:100px;width:90px;height:90px;background:#c93926}</style>'+Array.from({length:10},(_,i)=>'<div class="TiMu">Question '+(i+1)+'<div class="swatch"></div></div>').join(''))});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 window=new BrowserWindow({width:1224,height:840,show:true,title:'学习通助手 · 遮挡截图回归（无需登录）'});await window.loadURL('about:blank');
 let port;for(let i=0;i<100;i++){try{port=+fs.readFileSync(path.join(data,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{await sleep(30)}}assert.ok(port);
 manager=new EmbeddedBrowser(window,{dataDir:data,debugPort:port});const created=await manager.create({url:'http://127.0.0.1:'+server.address().port,show:false});
 const c=webContents.fromDevToolsTargetId(created.targetId);for(let i=0;i<100&&(c.isLoading()||c.getURL()==='about:blank');i++)await sleep(40);await sleep(200);
 for(const mode of ['front','occluded','hidden','minimized']){
  if(mode==='occluded'){cover=new BrowserWindow({width:1600,height:1100,alwaysOnTop:true,show:true,title:'遮挡测试 · 无需操作'});await cover.loadURL('data:text/html,<body style="background:gray">Screenshot occlusion test');cover.focus()}
  if(mode==='hidden')window.hide();if(mode==='minimized'){window.showInactive();window.minimize()}
  await sleep(900);const before={visible:window.isVisible(),minimized:window.isMinimized(),focused:window.isFocused()};
  let previous;
  for(let index=0;index<4;index++){
   const rect=await c.executeJavaScript(`(()=>{const e=document.querySelectorAll('.TiMu')[${index}];e.scrollIntoView({block:'start',behavior:'instant'});e.querySelector('.swatch').style.background='${index%2?'#246be8':'#c93926'}';const r=e.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
   const viewport=await c.executeJavaScript('({w:innerWidth,h:innerHeight})');
   const result=await bounded(manager.request({method:'capture',targetId:created.targetId,rect}));const image=nativeImage.createFromBuffer(Buffer.from(result.data,'base64'));
   assert.deepEqual(image.getSize(),{width:600,height:350});const bitmap=image.toBitmap();const pixel=(120*600+50)*4;
   assert.equal(bitmap[pixel+2],index%2?0x24:0xc9,'capture must contain the current question red channel');
   assert.equal(bitmap[pixel],index%2?0xe8:0x26,'capture must contain the current question blue channel');
   if(previous)assert.notEqual(result.data,previous,'consecutive questions must produce fresh pixels');previous=result.data;
   assert.deepEqual(await c.executeJavaScript('({w:innerWidth,h:innerHeight})'),viewport,'capture must preserve viewport');
   assert.deepEqual({visible:window.isVisible(),minimized:window.isMinimized(),focused:window.isFocused()},before,'capture must not show, restore or focus the host');
   assert.ok(manager.captureWindow.contentView.children.includes(manager.views.get(c.id).view),'inactive page must use the isolated capture host');assert.equal(manager.captureWindow.getOpacity(),0);assert.equal(manager.captureWindow.isFocused(),false);assert.equal(window.contentView.children.includes(manager.views.get(c.id).view),false,'inactive page must never cover workspace');
   fs.writeFileSync(path.join(data,mode+'-'+index+'.png'),Buffer.from(result.data,'base64'));
  }
  results.push({mode,consecutive:4,viewportStable:true,pixelsFresh:true,windowUnchanged:true});console.log('PASS '+JSON.stringify(results.at(-1)));
 }
 const state=manager.snapshot();assert.equal(state.visible,false);assert.equal(state.active,created.id);
 console.log('PASS full viewport native capture, precise crop, fresh pixels, occlusion/hidden/minimized, no browser CDP connection');
 fs.writeFileSync(path.join(data,'result.json'),JSON.stringify(results,null,2));
}catch(error){console.error(error);process.exitCode=1}finally{cover?.destroy();await manager?.close().catch(()=>{});window?.destroy();server?.close();app.exit(process.exitCode||0)}});
