import assert from 'node:assert/strict';
import { watchWithCheckpoint, applyNativeSpeed } from '../../src/chaoxing/playback-policy.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
const settings = { videoCompletionMode: 'check90', progressThreshold: .999, finishMarginSec: 1 };
async function scenario({ done = false, error = false, stop = false, human = false, watchFails = false, full = false } = {}) {
  const calls = []; let halted = false;
  const result = await watchWithCheckpoint({ settings: full ? { ...settings, videoCompletionMode: 'full' } : settings,
    shouldStop: () => halted && stop, needsHuman: () => halted && human,
    watch: async cfg => { calls.push(cfg.progressThreshold); return { ok: !watchFails, progress: cfg.progressThreshold, events: [], resumes: 0 }; },
    verify: async () => { calls.push('verify'); halted = true; if (error) throw Error('network'); return { done }; },
    resume: async () => { calls.push('resume'); return { ok: true }; },
  }); return { calls, result };
}
assert.deepEqual((await scenario({ done: true })).calls, [.9, 'verify']);
assert.deepEqual((await scenario()).calls, [.9, 'verify', 'resume', .999]);
assert.deepEqual((await scenario({ error: true })).calls, [.9, 'verify', 'resume', .999]);
for (const mode of ['stop', 'human']) { const s = await scenario({ [mode]: true }); assert.equal(s.result.watch.ok, false); assert.equal(s.result.watch.stopped, true); assert.deepEqual(s.calls, [.9, 'verify']); }
assert.deepEqual((await scenario({ full: true })).calls, [.999]);
assert.deepEqual((await scenario({ watchFails: true })).calls, [.9]);
const invalid = normalizeSettings({ playbackSpeed: '4', videoCompletionMode: 'skip' }); assert.equal(invalid.ok, false);
const valid = normalizeSettings({ playbackSpeed: '2', videoCompletionMode: 'check90' }); assert.equal(valid.ok, true);
// Native-control fixture: only clicking the offered control changes rate above 1.
function native(rates, { visible = true, disabled = false, throws = false } = {}) {
  let actual = 1, clicks = 0;
  const control = { first() { return this; }, isVisible: async () => visible, isDisabled: async () => disabled,
    click: async () => { clicks++; if (throws) throw Error('removed'); actual = rates[(rates.indexOf(actual) + 1) % rates.length]; },
    evaluate: async fn => { if (String(fn).includes('button.click()')) await control.click(); },
    filter() { return { first: () => ({ isVisible: async () => false }) }; } };
  return { locator: () => control, waitForTimeout: async () => {}, evaluate: async fn => { if (String(fn).includes('video.playbackRate = 1')) actual = 1; return actual; }, get clicks() { return clicks; } };
}
let frame = native([1, 1.5, 2]); assert.equal((await applyNativeSpeed(frame, '2')).actual, 2); assert.equal(frame.clicks, 2);
frame = native([1, 1.25, 1.5]); let result = await applyNativeSpeed(frame, '2'); assert.equal(result.actual, 1); assert.equal(result.fallback, true); assert.ok(frame.clicks <= 4);
for (const options of [{ visible: false }, { disabled: true }, { throws: true }]) { frame = native([1, 2], options); assert.equal((await applyNativeSpeed(frame, '2')).actual, 1); }
frame = native([1, 2]); assert.equal((await applyNativeSpeed(frame, '2', () => true)).actual, 1); assert.equal(frame.clicks, 0);
console.log('✓ Playback policy: platform verdict, 90% continuation, cancellation/manual, native speed and unsupported fallback.');
