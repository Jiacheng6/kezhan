// Reproduce the original Three.js RoomEnvironment once at build time.
// The app loads its exact half-float CubeUV pixels instead of compiling PMREM on startup.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {_electron as electron} from 'playwright-core';
const root=process.cwd(),three=path.join(root,'tools/ui/course-archive/node_modules/three');
const output=path.join(root,'tools/ui/course-archive/public/assets');
const server=http.createServer((req,res)=>{
  const files={'/three/three.module.js':'build/three.module.js','/three/three.core.js':'build/three.core.js','/room.js':'examples/jsm/environments/RoomEnvironment.js'};
  if(files[req.url]){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(three,files[req.url])));return;}
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script><script type="module">
import * as THREE from 'three';import {RoomEnvironment} from '/room.js';
const renderer=new THREE.WebGLRenderer({antialias:false});const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
const target=pmrem.fromScene(room,.04),{width,height}=target;const pixels=new Uint16Array(width*height*4);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
const bytes=new Uint8Array(pixels.buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
window.baked={width,height,format:'rgba-f16-le',threeRevision:THREE.REVISION,base64:btoa(binary)};room.dispose();target.dispose();pmrem.dispose();renderer.dispose();</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const data=fs.mkdtempSync(path.join(root,'.desktop-test/bake-environment-'));
let app;
try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--test-mode'],env:{...process.env,XXT_TEST_DATA_DIR:data}});
  const page=await app.firstWindow();page.on('pageerror',error=>console.error(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.baked,{},{timeout:60000});
  const {base64,...metadata}=await page.evaluate(()=>window.baked),bytes=Buffer.from(base64,'base64');
  if(!bytes.some(value=>value!==0))throw Error('Empty studio bake');
  fs.writeFileSync(path.join(output,'archive-studio.bin.gz'),gzipSync(bytes,{level:9}));
  fs.writeFileSync(path.join(output,'archive-studio.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log({...metadata,rawBytes:bytes.length,compressedBytes:fs.statSync(path.join(output,'archive-studio.bin.gz')).size});
}finally{
  if(app){await app.evaluate(({app,dialog})=>{dialog.showMessageBox=async()=>({response:1});app.quit();}).catch(()=>{});await app.close().catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
