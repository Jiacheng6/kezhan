import assert from 'node:assert/strict';
import { taskProgressModel } from '../../src/ui/task-progress.js';
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
const pages = [{ id: 1, role: 'verify-point', busy: true }, { id: 2, role: 'video', busy: false }, { id: 3, role: 'video', busy: true }, { id: 4, url: 'https://chat.deepseek.com/' }];
assert.equal(currentTaskPage(pages).id, 3);assert.equal(sortedPages(pages)[0].id, 3);
assert.equal(currentTaskPage(pages.filter(t => t.id !== 3)), null);
assert.equal(pageKind(pages[3]), 'AI 网页');assert.equal(pageKind({ url: 'https://deepseek.com.evil.example/' }), '网页');
assert.equal(pageKind(pages[0]), '课程检查');
console.log('✓ 当前任务真实进度、题数、核对/停止/未知状态、网页分类与当前任务定位通过');
