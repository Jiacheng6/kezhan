// Local mock API only. Never uses a real key or paid endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {createRequire} from 'node:module';import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
const require=createRequire(import.meta.url),{createApiService,endpoint}=require('../../desktop/ai-api.cjs');
fs.mkdirSync('.desktop-test',{recursive:true});const data=fs.mkdtempSync(path.resolve('.desktop-test/api-test-'));
const key=randomBytes(32),safeStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()]);},decryptString(buffer){const cipher=createDecipheriv('aes-256-gcm',key,buffer.subarray(0,12));cipher.setAuthTag(buffer.subarray(-16));return Buffer.concat([cipher.update(buffer.subarray(12,-16)),cipher.final()]).toString();}};
const calls=[];let mode='answer';
const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(body)});
  if(mode==='hang')return; if(mode==='redirect'){res.writeHead(307,{Location:'https://example.invalid/'});return res.end();}
  if(mode==='401'){res.writeHead(401);return res.end('SECRET IN ERROR BODY');}
  if(mode==='empty')return res.end('{}');if(mode==='badjson')return res.end('not-json');
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:[{type:'text',text:'A'}]}}]}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/v1`;
const api=createApiService({dataDir:data,safeStorage}),image=Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
try{
 for(const bad of ['http://example.com/v1','https://user:password@localhost','https://example.com?key=secret','file:///test'])assert.throws(()=>endpoint(bad));
 assert.equal(endpoint(base),base+'/chat/completions');assert.equal(endpoint(base+'/chat/completions/'),base+'/chat/completions');
 assert.equal((await api.ask({prompt:'a',image})).errorCode,'api-not-configured');
 const secret='mock-secret-'+randomBytes(8).toString('hex');api.save({baseUrl:base,model:'mock-vision',apiKey:secret});
 assert.equal(fs.readFileSync(path.join(data,'api-config.bin')).includes(Buffer.from(secret)),false);
 assert.equal(JSON.stringify(api.status()).includes(secret),false);assert.equal(api.status().configured,true);
 api.save({baseUrl:base,model:'mock-vision',apiKey:''});assert.throws(()=>api.save({baseUrl:'https://example.invalid/v1',model:'mock-vision',apiKey:''}),/重新填写密钥/);
 assert.equal((await api.ask({prompt:'question',image})).answer,'A');assert.equal(calls.length,1);assert.equal(calls[0].auth,'Bearer '+secret);
 assert.equal(calls[0].body.messages[0].content[1].image_url.url,'data:image/png;base64,'+image);assert.equal(calls[0].body.stream,false);
 assert.equal((await api.ask({prompt:'question',image:'bad'})).errorCode,'api-invalid-image');assert.equal(calls.length,1);
 await api.test();assert.equal(typeof calls.at(-1).body.messages[0].content,'string');
 for(const errorMode of ['401','redirect','empty','badjson']){mode=errorMode;const result=await api.ask({prompt:'question',image});assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('SECRET'),false);}
 mode='hang';const pending=api.ask({prompt:'question',image,jobId:'cancel-demo'});await new Promise(resolve=>setTimeout(resolve,100));api.cancel('cancel-demo');assert.equal((await pending).ok,false);
 console.log('✓ 本地 API：加密保存、密钥隐藏、地址限制、图片请求、错误隔离、拒绝跳转、取消请求通过');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
