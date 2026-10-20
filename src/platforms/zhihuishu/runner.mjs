import { readZhihuishuPage, isZhihuishuUrl } from './read-page.mjs';
import { dismissZhihuishuNotices } from './notices.mjs';
import { handleZhihuishuVideoPrompt, readZhihuishuVideoPrompt, resumeZhihuishuVideo } from './video.mjs';
import { newTaskPage, releasePage } from '../../browser/pages.mjs';
import { setTaskStatus } from '../../state.mjs';
import { log, notifyUser } from '../../logbus.mjs';
export async function runZhihuishuVideo({ task, context, shouldStop, onProgress }) {
  if (task.platform !== 'zhihuishu' || task.type !== 'video' || !isZhihuishuUrl(task.studyUrl) || !task.platformTaskKey) throw Error('智慧树视频身份不完整');
  const page = await newTaskPage(context, 'video'); let completed = false;
  try {
    await page.goto(task.studyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('li.video').first().waitFor({ timeout: 20000 });
    let state = await readZhihuishuPage(page);
    if (state.course?.key !== task.courseId) throw Error('打开的智慧树课程与选择不一致');
    await dismissZhihuishuNotices(page);
    const index = state.videos.findIndex(v => v.key === task.platformTaskKey);
    if (index < 0) throw Error('课程目录变化，请重新读取智慧树课程');
    if (state.videos[index].completion === 'completed') { completed = true; return { ok: true }; }
    setTaskStatus(task.key, { status: 'running', platform: 'zhihuishu' });
    if (!state.videos[index].active) await page.locator('li.video').nth(index).click();
    const selectionDeadline = Date.now() + 20000;
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    let resumeFailures = 0;
    while (Date.now() < deadline) {
      if (shouldStop()) { await page.locator('video').evaluateAll(videos => videos.forEach(v => v.pause())).catch(() => {}); return { ok: false, phase: 'stopped' }; }
      // These notices can arrive after the directory and player are ready.
      await dismissZhihuishuNotices(page);
      state = await readZhihuishuPage(page);
      if (state.course?.key !== task.courseId) throw Error('智慧树课程页面已改变');
      if (state.blockers.length) {
        notifyUser('ai-verification', { key: task.key + ':verification', detail: '智慧树需要人工验证，请在软件内网页完成；本平台保留当前进度，其他平台继续。' });
        return { ok: false, phase: 'needs-human', error: '智慧树需要人工验证，完成后可重新开始续播' };
      }
      if (state.videos.find(v => v.key === task.platformTaskKey)?.completion === 'completed') { completed = true; return { ok: true }; }
      const current = state.videos.find(v => v.active);
      if (current?.key !== task.platformTaskKey) {
        if (Date.now() > selectionDeadline) throw Error('当前播放的视频与选择不一致，已暂停本平台');
        await page.waitForTimeout(300); continue;
      }
      if (current.completion === 'completed') { completed = true; return { ok: true }; }
      if (await readZhihuishuVideoPrompt(page)) {
        const answer = await handleZhihuishuVideoPrompt(page, { expectedKey: task.platformTaskKey });
        if (!answer.ok) return { ok: false, phase: 'needs-human', error: '视频弹题需要核对，请查看智慧树网页' };
      } else if (state.players[0]?.paused && !state.players[0]?.error) {
        try { await resumeZhihuishuVideo(page, { expectedKey: task.platformTaskKey }); resumeFailures = 0; }
        catch (error) {
          // A delayed known notice may have intercepted the native play click.
          if ((await dismissZhihuishuNotices(page)).dismissed.length) continue;
          // Switching sources can reset the player after a successful click.
          // Re-read task identity, verification and popup state before retrying.
          if(error.name==='TimeoutError'&&++resumeFailures<3){await page.waitForTimeout(300);continue;}
          throw error;
        }
      }
      const player = state.players[0];
      onProgress({ percent: player?.duration ? player.currentTime / player.duration : null, currentTime: player?.currentTime, duration: player?.duration, taskType: 'video', platform: 'zhihuishu' });
      if (player?.error) throw Error('智慧树播放器报告错误');
      await page.waitForTimeout(1000);
    }
    throw Error('视频长时间未取得平台完成标记，请手动核对');
  } finally {
    await page.locator('video').evaluateAll(videos => videos.forEach(v => v.pause())).catch(() => {});
    setTaskStatus(task.key, { status: completed ? 'done' : 'pending', platform: 'zhihuishu' });
    releasePage(page);
    // Preserve unresolved pages for verification; close only confirmed completion.
    if (completed) await page.close().catch(() => {});
    log(`【智慧树】${task.courseName || ''} · ${task.name}：${completed ? '平台已确认完成' : '保留进度，尚未完成'}`, completed ? 'ok' : 'warn');
  }
}
