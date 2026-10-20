// Isolated persistence + fake OS delivery; never accesses installed app data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const root=process.cwd();fs.mkdirSync('.desktop-test',{recursive:true});
const data=fs.mkdtempSync(path.join(root,'.desktop-test/notice-unit-'));process.env.XXT_DATA_DIR=data;
const {NotificationCenter,catalog}=createRequire(import.meta.url)('../../desktop/notifications.cjs');
const shown=[];
class FakeNotification extends EventEmitter {
  static isSupported(){return true;}
  constructor(options){super();this.options=options;}
  show(){shown.push(this);}
  close(){this.emit('close');}
}
const opens=[],attention=[];
const center=new NotificationCenter({dataDir:data,Notification:FakeNotification,onOpen:n=>opens.push(n.action),onAttention:n=>attention.push(n)});
for(const kind of Object.keys(catalog))assert.ok(center.push({kind,key:kind}));
assert.equal(shown.length,Object.keys(catalog).length);
const first=center.push({kind:'ai-verification'});
assert.equal(shown.length,Object.keys(catalog).length,'重复探测不重复弹窗');
shown.find(n=>n.options.title===first.title).emit('close');
assert.equal(center.snapshot().items.find(n=>n.id===first.id).read,false,'系统弹窗消失不等于已读');
const restored=new NotificationCenter({dataDir:data,Notification:FakeNotification});
assert.equal(restored.snapshot().unread,Object.keys(catalog).length,'重启保留未读');
const toast=shown.find(n=>n.options.title===first.title);toast.emit('click');
assert.deepEqual(opens,['ai']);assert.equal(center.snapshot().unread,Object.keys(catalog).length-1);
assert.equal(center.push({kind:'unknown'}),null);
const unsupported=new NotificationCenter({dataDir:fs.mkdtempSync(path.join(root,'.desktop-test/notice-no-os-')),Notification:class {static isSupported(){return false;}}});
assert.equal(unsupported.push({kind:'ai-verification'}).delivery,'in-app');assert.equal(unsupported.snapshot().unread,1);
class BrokenNotification extends FakeNotification {show(){throw Error('OS blocked');}}
const broken=new NotificationCenter({dataDir:fs.mkdtempSync(path.join(root,'.desktop-test/notice-failed-')),Notification:BrokenNotification});
assert.equal(broken.push({kind:'task-failed'}).delivery,'failed');assert.equal(broken.snapshot().unread,1);
shown.at(-1).emit('failed');assert.equal(center.snapshot().items[0].delivery,'failed');
console.log(`✓ ${Object.keys(catalog).length} 种关键通知、系统投递、失败/不支持回退、去重、点击跳转、关闭未读及重启保留`);

const zhsNotice=center.snapshot().items.find(n=>n.kind==='zhihuishu-login');assert.ok(zhsNotice);assert.match(zhsNotice.title,/智慧树/);center.activate(zhsNotice.id);assert.equal(opens.at(-1),'zhihuishu','智慧树登录通知不能跳到学习通');
const {BatchRunner,classifyTaskResult}=await import('../../src/batch.mjs');
const {queueUnanswered,AI_BLOCK_CODES}=await import('../../src/chaoxing/quiz-outcome.mjs');
for(const code of ['editor-unavailable','upload-failed','upload-not-ready','send-failed','exception'])assert.ok(AI_BLOCK_CODES.has(code),'本地网页操作失败必须立即停批并保留原始错误，不能继续冒充 AI 限流');
const {loadState,mutateState}=await import('../../src/state.mjs');
const {bus}=await import('../../src/logbus.mjs');
mutateState(s=>{s.settings={maxRetries:1};});
const notices=[];const listener=n=>notices.push(n);bus.on('notice',listener);
const task=k=>({key:k,name:'演示作业',courseId:'fixture-course',clazzId:'fixture-class',knowledgeId:'fixture-section',type:'work',willHandle:true,finished:false});
const questions=[1,2].map((index)=>({index,domIndex:index-1,qtype:'essay',qtypeRaw:'简答题',options:[]}));
const calls=[];
const runner=new BatchRunner({runQuiz:async({task:t})=>{
  calls.push(t.key);
  const r={...t,ok:false,phase:'blocked-verification',aiErrorCode:'verification-required',needsHuman:'验证',error:'验证',answered:0,queued:0,totalQuestions:2,submitted:false,items:[]};
  queueUnanswered(r,t,questions,r.error);return r;
}});
try{
 const result=await runner.start({ctx:{},tasks:[task('first'),task('must-not-run')],command:{personId:'fixture'}});
 assert.deepEqual(calls,['first']);assert.equal(result.stats.done,0);assert.equal(result.stats.paused,true);assert.equal(result.stats.failed,0);
 assert.equal(result.stats.review,1,'阻塞作业的待审组也必须显示');
 assert.equal(loadState().taskPoints.first.status,'manual');assert.equal(loadState().reviewQueue.length,2);
 assert.ok(loadState().reviewQueue.every(q=>q.status==='pending-review'&&!q.textAnswer&&!q.aiAnswer));
 assert.ok(notices.some(n=>n.kind==='ai-verification'));assert.ok(!notices.some(n=>n.kind==='batch-complete'));
 assert.equal(classifyTaskResult({ok:true,phase:'awaiting-review',needsHuman:'旧错误'}),'blocked');
 runner.executors.runQuiz=async({task:t})=>({...t,ok:true,phase:'awaiting-review',items:[],answered:1,queued:1,submitted:false});
 notices.length=0;
 const next=await runner.start({ctx:{},tasks:[task('review')],command:{personId:'fixture'}});
 assert.equal(next.stats.done,0);assert.equal(next.stats.review,1);assert.equal(next.stats.paused,false);assert.equal(next.stats.handbook,0);
 assert.ok(notices.some(n=>n.kind==='batch-review'));assert.ok(!notices.some(n=>n.kind==='batch-complete'));
 notices.length=0;
 const stopped=await runner.start({ctx:{},tasks:[task('stop-before-execution')],command:{personId:'fixture'},onUpdate:s=>{if(s.running&&s.stats.current)runner.requestStop();}});
 assert.equal(stopped.stats.failed,0);assert.equal(stopped.stats.handbook,0);
 assert.equal(loadState().taskPoints['stop-before-execution'].status,'pending');
 assert.ok(notices.some(n=>n.kind==='batch-stopped'));assert.ok(!notices.some(n=>n.kind==='task-failed'));
 runner.executors.runQuiz=async()=>{throw Error('模拟执行器异常');};notices.length=0;
 await assert.rejects(runner.start({ctx:{},tasks:[task('throws')],command:{personId:'fixture'}}),/模拟执行器异常/);
 assert.ok(!notices.some(n=>n.kind==='batch-complete'));
 console.log('✓ 首题验证立即停批、未作答题进入待审、零完成、阻塞优先级、待审独立计数及再次启动清空旧暂停状态');
}finally{bus.off('notice',listener);}
