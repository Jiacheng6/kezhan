import assert from 'node:assert/strict';
import {ensurePlayer} from '../../src/platforms/ucampus/runner.mjs';
import {isWelearnContentPage,runWelearnSelectedTask} from '../../src/platforms/welearn/dispatch.mjs';
let creates=0,goto='';const existing={isClosed:()=>false,url:()=> 'https://ucontent.unipus.com/pc.html#/instance-old'};
const fresh={goto:async url=>{goto=url;},waitForTimeout:async()=>{}};
const context={pages:()=>[existing],newPage:async()=>{creates++;return fresh;}};
assert.equal(await ensurePlayer(context,{instanceId:'instance-old'}),existing);
assert.equal(creates,0);
assert.equal(await ensurePlayer(context,{instanceId:'instance-new',continueUrl:'https://ucontent.unipus.cn/pc.html#/instance-new'}),fresh);
assert.equal(creates,1);assert.ok(goto.endsWith('instance-new'));
await assert.rejects(()=>ensurePlayer(context,{continueUrl:'https://ucontent.unipus.cn.evil.test/'}));
await assert.rejects(()=>ensurePlayer(context,{}));assert.equal(creates,1);
for(const name of ['Unit 01 > Unit Goals > 01. Unit Goals','Unit 02 > 02. Quotation']){
 assert.equal(isWelearnContentPage({name}),true);
 assert.equal(await runWelearnSelectedTask({task:{name}},{native:async()=> 'native',protocol:async()=> 'protocol'}),'native');
}
for(const name of ['05. Task 1','07. Pronunciation Skill','Unit Goals quiz','Unit 01 > Unit Goals > 03. Lead-in']){
 assert.equal(isWelearnContentPage({name}),false);
 assert.equal(await runWelearnSelectedTask({task:{name}},{native:async()=> 'native',protocol:async()=> 'protocol'}),'protocol');
}
console.log('✓ U校园关闭后重建正确播放器、跨域兼容与身份隔离；WeLearn 无题内容分流，练习/口语不扩大处理范围');
