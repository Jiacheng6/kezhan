import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const {renameWithRetry}=createRequire(import.meta.url)('../../src/atomic-file.cjs');
fs.mkdirSync('.desktop-test',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.desktop-test/atomic-file-')),from=path.join(dir,'next.tmp'),to=path.join(dir,'state.json');
fs.writeFileSync(from,'new');fs.writeFileSync(to,'previous');const rename=fs.renameSync;let calls=0;
try{
 fs.renameSync=(a,b)=>{calls++;if(calls<=2){assert.equal(fs.readFileSync(to,'utf8'),'previous');throw Object.assign(Error('temporary sharing lock'),{code:'EPERM'});}return rename(a,b);};
 if(process.platform==='win32'){renameWithRetry(from,to);assert.equal(calls,3);assert.equal(fs.readFileSync(to,'utf8'),'new');}
 else assert.throws(()=>renameWithRetry(from,to),/temporary sharing lock/);
 fs.writeFileSync(from,'newer');const previous=fs.readFileSync(to,'utf8');calls=0;
 fs.renameSync=()=>{calls++;throw Object.assign(Error('persistent sharing lock'),{code:'EACCES'});};
 assert.throws(()=>renameWithRetry(from,to),/persistent sharing lock/);assert.equal(calls,process.platform==='win32'?5:1);assert.equal(fs.readFileSync(to,'utf8'),previous);assert.equal(fs.readFileSync(from,'utf8'),'newer');
}finally{fs.renameSync=rename;}
console.log('✓ 原子替换：Windows 临时占用有限重试，持续失败保留原文件及临时文件');
