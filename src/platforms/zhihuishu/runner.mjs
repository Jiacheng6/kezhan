import { readZhihuishuPage, isZhihuishuUrl } from './read-page.mjs';
import { dismissZhihuishuNotices } from './notices.mjs';
import { handleZhihuishuVideoPrompt, readZhihuishuVideoPrompt, resumeZhihuishuVideo, waitZhihuishuVideoReady } from './video.mjs';
import { releasePage, adoptTaskPage } from '../../browser/pages.mjs';
import { setTaskStatus } from '../../state.mjs';
import { log, notifyUser } from '../../logbus.mjs';
import {openZhihuishuStudy} from './entry.mjs';
import {syncZhihuishuVideoCompletions} from './catalog.mjs';
let retainedVideo=null;
export async function runZhihuishuVideo({ task, context, shouldStop=()=>false, onProgress=()=>{} },{openStudy=openZhihuishuStudy}={}) {
  if (task.platform !== 'zhihuishu' || task.type !== 'video' || !isZhihuishuUrl(task.studyUrl) || !task.platformTaskKey) throw Error('智慧树视频身份不完整');
  let page,entryPage,completed = false,completionSignature='';
  const recordCompletions=state=>{
    const signature=JSON.stringify(state.videos.filter(v=>v.completion==='completed').map(v=>v.key).sort());
    if(signature!==completionSignature){syncZhihuishuVideoCompletions(task,state);completionSignature=signature;}
  };
  try {
    if(retainedVideo&&!retainedVideo.page.isClosed()){
      const old=retainedVideo;retainedVideo=null;
      const state=await readZhihuishuPage(old.page).catch(()=>null);
      if(state?.blockers.some(b=>b!=='progress-save-failed')){
        retainedVideo=old;return {ok:false,phase:'needs-human',error:'上次智慧树视频仍需本人完成验证或处理提示，请先处理保留的原页面'};
      }
      if(old.key===task.key&&state?.course?.key===task.courseId&&!state.blockers.length){page=old.page;await adoptTaskPage(page,'video');}
      else{
        // These are exclusively our previous paused task pages. An abandoned
        // progress session must not compete with the fresh native portal entry.
        await old.page.locator('video').evaluateAll(vs=>vs.forEach(v=>v.pause())).catch(()=>{});
        releasePage(old.page);await old.page.close();
      }
    }
    if(!page)({page,entryPage}=await openStudy(context,task,{shouldStop}));
    await page.locator('li.video').first().waitFor({ timeout: 20000 });
    let state = await readZhihuishuPage(page);
    if (state.course?.key !== task.courseId) throw Error('打开的智慧树课程与选择不一致');
    recordCompletions(state);
    await dismissZhihuishuNotices(page);
    const index = state.videos.findIndex(v => v.key === task.platformTaskKey);
    if (index < 0) throw Error('课程目录变化，请重新读取智慧树课程');
    if (state.videos[index].completion === 'completed') { completed = true; return { ok: true }; }
    setTaskStatus(task.key, { status: 'running', platform: 'zhihuishu' });
    let previousSource;
    if (!state.videos[index].active) {previousSource=await page.locator('video').evaluateAll(vs=>vs[0]?.currentSrc||'');await page.locator('li.video').nth(index).click();}
    // The active row changes before the media source and its metadata do.
    // Never resume the old video while the requested one is still loading.
    if(!state.blockers.length)await waitZhihuishuVideoReady(page,{expectedKey:task.platformTaskKey,previousSource,shouldStop});
    const selectionDeadline = Date.now() + 20000;
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    let resumeFailures = 0;
    while (Date.now() < deadline) {
      if (shouldStop()) { await page.locator('video').evaluateAll(videos => videos.forEach(v => v.pause())).catch(() => {}); return { ok: false, phase: 'stopped' }; }
      // These notices can arrive after the directory and player are ready.
      await dismissZhihuishuNotices(page);
      state = await readZhihuishuPage(page);
      if (state.course?.key !== task.courseId) throw Error('智慧树课程页面已改变');
      recordCompletions(state);
      if (state.blockers.length) {
        if (state.blockers.includes('progress-save-failed')) {
          const error = '智慧树提示学习进度提交失败，请在软件内按平台提示返回学堂重新进入；未确认任务完成';
          notifyUser('batch-error', { key: task.key + ':progress-save-failed', detail: error });
          return { ok: false, phase: 'needs-human', error };
        }
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
      const prompt = await readZhihuishuVideoPrompt(page);
      if (prompt) {
        const kind = /判断题|单选题|多选题/.exec(prompt.type)?.[0] || '未知题型';
        log(`【智慧树】检测到视频弹题：${kind}，${prompt.pages.length || 1} 页，${prompt.options.length} 个选项`);
        const answer = await handleZhihuishuVideoPrompt(page, { expectedKey: task.platformTaskKey });
        if (!answer.ok) {
          const reason = answer.reason || answer.phase || 'unknown';
          const descriptions = {
            'unsupported-question-type': '当前弹题题型尚未适配',
            'unrecognized-question-context': '未能确认这是不计分的视频弹题',
            'too-many-questions': '弹题数量超出可处理范围',
            'invalid-option': '无法匹配有效选项',
            'answer-not-confirmed': '页面未确认选项已作答',
            'close-button-missing': '未能唯一定位关闭按钮',
            'human-verification': '页面需要本人处理验证或提示',
          };
          log(`【智慧树】视频弹题处理中断：${reason}`, 'warn');
          return { ok: false, phase: 'needs-human', error: `视频弹题需要核对：${descriptions[reason] || '页面状态发生变化'}，请查看智慧树网页` };
        }
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
      onProgress({ percent: player?.duration ? player.currentTime / player.duration : null, currentTime: player?.currentTime, duration: player?.duration, playbackRate:player?.rate, taskType: 'video', platform: 'zhihuishu' });
      if (player?.error) throw Error('智慧树播放器报告错误');
      await page.waitForTimeout(1000);
    }
    throw Error('视频长时间未取得平台完成标记，请手动核对');
  } catch(error){page||=error.taskPage;throw error;
  } finally {
    if(page&&!page.isClosed())await page.locator('video').evaluateAll(videos => videos.forEach(v => v.pause())).catch(() => {});
    setTaskStatus(task.key, { status: completed ? 'done' : 'pending', platform: 'zhihuishu' });
    if(page)releasePage(page);
    if(!completed&&page&&!page.isClosed()&&await readZhihuishuPage(page).then(s=>s.pageKind==='study'&&s.course?.key===task.courseId).catch(()=>false))retainedVideo={key:task.key,page};
    if(entryPage&&entryPage!==page){releasePage(entryPage);await entryPage.close().catch(()=>{});}
    // Preserve unresolved pages for verification; close only confirmed completion.
    if (completed&&page) await page.close().catch(() => {});
    log(`【智慧树】${task.courseName || ''} · ${task.name}：${completed ? '平台已确认完成' : '保留进度，尚未完成'}`, completed ? 'ok' : 'warn');
  }
}
