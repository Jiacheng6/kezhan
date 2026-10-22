import assert from 'node:assert/strict';
import { taskProgressModel, platformTaskStatus, totalProgressModel,runSummaryLabel } from '../../src/ui/task-progress.js';
import { currentTaskPage, pageKind, sortedPages } from '../../src/ui/web-pages.js';
const video = { running: true, progress: { total: 8, done: 2, current: '演示课程 · 视频', taskType: 'video', percent: .642, currentTime: 385, duration: 600, playbackRate: 2 } };
let model = taskProgressModel(video);
assert.equal(model.percent, '64.2');assert.match(model.detail, /06:25 \/ 10:00 · 实际 2×/);
assert.equal(taskProgressModel({ ...video, progress: { ...video.progress, percent: 1.5 } }).fraction, 1);
assert.equal(taskProgressModel({ ...video, progress: { ...video.progress, percent: -1 } }).fraction, 0);
assert.equal(taskProgressModel({ running: true, progress: { percent: null } }).fraction, null);
assert.equal(taskProgressModel({ running: true, progress: { percent: '0.5' } }).fraction, null);
assert.equal(taskProgressModel({ reconRunning: true, progress: { percent: .9 } }).fraction, null);
assert.equal(taskProgressModel({ ...video, running: false }).percent, '64.2');
assert.equal(taskProgressModel({ ...video, running: false }).label, '已停止');
assert.equal(taskProgressModel({ ...video, progress: { ...video.progress, phase: 'verifying', percent: .9 } }).label, '核对平台状态');
assert.equal(taskProgressModel({ ...video, progress: { ...video.progress, phase: 'verifying', percent: .9 } }).percent, '90.0');
for (const [phase, expected] of [['asking', '25.0'], ['done', '50.0']]) {
  const quiz = taskProgressModel({ running: true, progress: { taskType: 'work', questionIndex: 1, questionTotal: 4, phase } });
  assert.equal(quiz.percent, expected);assert.match(quiz.detail, /题/);
}
assert.equal(taskProgressModel({}).visible, false);
const dual = { running:true, progress:{current:'aggregate must not leak',percent:.99}, platforms:{
  chaoxing:{running:true,total:4,done:1,current:'学习通视频',progress:{taskType:'video',percent:.642,currentTime:385,duration:600}},
  zhihuishu:{running:true,total:3,done:1,review:1,current:'智慧树测验',progress:{taskType:'work',phase:'ask-ai',questionIndex:2,questionTotal:4}}
}};
assert.equal(taskProgressModel(platformTaskStatus(dual,'chaoxing')).percent,'64.2');
assert.equal(taskProgressModel(platformTaskStatus(dual,'zhihuishu')).percent,'25.0');
assert.equal(taskProgressModel(platformTaskStatus(dual,'zhihuishu')).label,'正在读取 AI 回答');
assert.deepEqual(totalProgressModel(dual),{total:7,done:2,review:1,running:true,fraction:2/7});
assert.equal(totalProgressModel({}).fraction,0);
const finishedRun={running:false,phase:'completed',done:1,total:1,current:'已完成视频',progress:{taskType:'video',percent:254/312,currentTime:254,duration:312}};
const finished=taskProgressModel(platformTaskStatus({platforms:{zhihuishu:finishedRun}},'zhihuishu'));
assert.equal(finished.label,'平台已确认完成');assert.equal(finished.kind,'任务完成进度');assert.equal(finished.percent,'100.0');assert.match(finished.detail,/播放记录 04:14 \/ 05:12/);
assert.equal(finishedRun.progress.currentTime,254,'任务完成不能虚构实际播放位置');
assert.equal(runSummaryLabel({platforms:{chaoxing:{running:false,total:0,phase:'idle'},zhihuishu:finishedRun}}),'已完成','智慧树执行不能依赖学习通的 runStats 判断是否开始');
assert.equal(runSummaryLabel({platforms:{zhihuishu:{...finishedRun,running:true,phase:'running'}}}),'进行中');
assert.equal(runSummaryLabel({platforms:{zhihuishu:{...finishedRun,phase:'needs-human',error:'验证'}}}),'已暂停 · 待处理');
assert.equal(runSummaryLabel({platforms:{zhihuishu:{...finishedRun,phase:'awaiting-review',review:1}}}),'待你核对');
assert.equal(runSummaryLabel({}),'尚未开始');
for(const phase of ['stopped','needs-human','failed','awaiting-review']){
 const model=taskProgressModel(platformTaskStatus({platforms:{zhihuishu:{...finishedRun,phase}}},'zhihuishu'));
 assert.notEqual(model.label,'平台已确认完成');assert.equal(model.percent,'81.4','仅有停止或待审状态不能显示任务完成');
}
assert.equal(taskProgressModel(platformTaskStatus({running:true,platforms:{chaoxing:{running:false},zhihuishu:dual.platforms.zhihuishu},progress:dual.progress},'chaoxing')).visible,false);
assert.equal(totalProgressModel({platforms:{a:{total:2,done:5},b:{total:3,done:-2}}}).fraction,.4);
const pages = [{ id: 1, role: 'verify-point', busy: true }, { id: 2, role: 'video', busy: false }, { id: 3, role: 'video', busy: true }, { id: 4, url: 'https://chat.deepseek.com/' }];
assert.equal(currentTaskPage(pages).id, 3);assert.equal(sortedPages(pages)[0].id, 3);
assert.equal(currentTaskPage(pages.filter(t => t.id !== 3)), null);
assert.equal(pageKind(pages[3]), 'AI 网页');assert.equal(pageKind({ url: 'https://deepseek.com.evil.example/' }), '网页');
assert.equal(pageKind(pages[0]), '课程检查');
console.log('✓ 当前任务真实进度、题数、核对/停止/未知状态、网页分类与当前任务定位通过');
const scan=taskProgressModel({reconRunning:true,reconProgress:{index:6,total:15,course:'示例扫描课程',section:2,sections:8},progress:{taskType:'video',current:'旧视频',currentTime:12,duration:60,playbackRate:2,playbackPhase:'旧播放阶段'},runStats:{paused:true}});
assert.equal(scan.label,'正在读取课程');assert.equal(scan.title,'示例扫描课程');assert.equal(scan.fraction,null);assert.match(scan.detail,/课程 6\/15 · 小节 2\/8/);assert.doesNotMatch(scan.detail,/实际|旧播放阶段|00:12/,'扫描不能沿用上次视频的进度、速度或暂停提示');
