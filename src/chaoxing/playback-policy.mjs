// Playback policy does not infer completion from a local percentage.
export async function watchWithCheckpoint({ settings, watch, verify, resume, shouldStop = () => false, needsHuman = () => false, onPhase = () => {} }) {
  const interrupted = () => shouldStop() || needsHuman();
  const stopped = previous => ({ ...previous, ok: false, stopped: true, reason: needsHuman() ? 'quiz-needs-human' : 'user-stop' });
  if (settings.videoCompletionMode !== 'check90') return { watch: await watch(settings), checkpoint: null };
  let current = await watch({ ...settings, progressThreshold: 0.9, finishMarginSec: 0 });
  if (!current.ok) return { watch: current, checkpoint: null };
  if (interrupted()) return { watch: stopped(current), checkpoint: null };
  onPhase('checkpoint');
  let checkpoint;
  try { checkpoint = await verify(); }
  catch (error) { checkpoint = { done: false, error: error.message }; }
  if (checkpoint.done) return { watch: current, checkpoint };
  if (interrupted() || checkpoint.stopped) return { watch: stopped(current), checkpoint };
  onPhase('continue');
  const resumed = await resume();
  if (!resumed.ok) return { watch: { ...current, ok: false, reason: 'resume-failed' }, checkpoint };
  const final = await watch(settings);
  return { watch: { ...final, resumes: (current.resumes || 0) + (final.resumes || 0), events: [...(current.events || []), ...(final.events || [])] }, checkpoint };
}

// Activate only the site's visible native control. Never add rates to a player.
export async function applyNativeSpeed(frame, preferred = '1', shouldStop = () => false) {
  const requested = Number(preferred);
  const rate = () => frame.evaluate(() => document.querySelector('video')?.playbackRate || 1);
  const normal = async reason => {
    await frame.evaluate(() => { const video = document.querySelector('video'); if (video) video.playbackRate = 1; }).catch(() => {});
    return { requested, actual: await rate().catch(() => 1), fallback: requested !== 1, reason };
  };
  if (![1, 1.5, 2].includes(requested) || requested === 1) return normal('normal');
  if (shouldStop()) return normal('stopped');
  try {
    const player = frame.locator('.video-js').first();
    // Native views can be detached while work continues. Let the site's own
    // pointer handler reveal controls without requiring a foreground window.
    await player.evaluate(el => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    const control = frame.locator('button.vjs-playback-rate').first();
    if (!await control.isVisible() || await control.isDisabled()) return normal('unavailable');
    const seen = new Set();
    for (let attempt = 0; attempt < 8; attempt++) {
      if (shouldStop()) return normal('stopped');
      const before = await rate();
      if (Math.abs(before - requested) < 0.01) return { requested, actual: before, fallback: false };
      if (seen.has(before)) break;
      seen.add(before);
      await control.evaluate(button => button.click());
      await frame.waitForTimeout(250);
      // Some players open a menu instead of cycling their button.
      if (Math.abs(await rate() - before) < 0.01) {
        const item = frame.locator('.vjs-playback-rate .vjs-menu-item').filter({ hasText: new RegExp('^\\s*' + String(requested).replace('.', '\\.') + '\\s*[x×]?\\s*$') }).first();
        if (await item.isVisible() && !await item.isDisabled()) { await item.evaluate(button => button.click()); await frame.waitForTimeout(250); }
      }
    }
    const actual = await rate();
    if (Math.abs(actual - requested) < 0.01) return { requested, actual, fallback: false };
    return normal('unsupported');
  } catch { return normal('unavailable'); }
}
