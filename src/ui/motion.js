// Shared, interruptible UI motion. State changes happen immediately; only their
// presentation is animated. No timers delay actions or save/stop requests.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new WeakMap();
const scrollPositions = new Map();
export const motionEnabled = () => !reduced.matches && !document.documentElement.classList.contains('reduce-motion');
export function animate(element, frames, options = {}) {
  if (!element) return;
  animations.get(element)?.cancel();
  if (!motionEnabled() || document.hidden) return;
  const animation = element.animate(frames, { duration: 300, easing: 'cubic-bezier(.22,.8,.25,1)', ...options });
  animations.set(element, animation);
  animation.finished.catch(() => {});
  return animation;
}
export function changePanel(previous, next) {
  if (!next || previous === next) return;
  if (previous) scrollPositions.set(previous.id, window.scrollY);
  window.scrollTo({ top: scrollPositions.get(next.id) || 0, behavior: 'instant' });
  animate(next, [{ opacity: .25, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 340 });
}
export function expandCourse(wrap, open) {
  if (wrap.classList.contains('open') === open) return;
  const body = wrap.querySelector('.treebody');
  if (!body) { wrap.classList.toggle('open', open); return; }
  // Measure the current in-flight height before canceling, so rapid reversals
  // continue from the visible state rather than jump back to an endpoint.
  const from = body.getBoundingClientRect().height;
  animations.get(body)?.cancel();
  wrap.classList.toggle('open', open);
  const to = open ? body.scrollHeight : 0;
  if (!motionEnabled()) return;
  body.style.display = 'block'; body.style.overflow = 'clip';
  const animation = animate(body, [{ height: from + 'px', opacity: open ? .45 : 1 }, { height: to + 'px', opacity: open ? 1 : 0 }], { duration: 290 });
  const clean = () => { if (animations.get(body) !== animation) return; body.style.removeProperty('display'); body.style.removeProperty('overflow'); };
  animation?.finished.then(clean, clean);
}
export function preserveTreeFocus(container, update) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const key = focused?.dataset.motionKey;
  const scroll = window.scrollY;
  update();
  if (key) [...container.querySelectorAll('[data-motion-key]')].find(el => el.dataset.motionKey === key)?.focus({ preventScroll: true });
  if (focused) window.scrollTo({ top: scroll, behavior: 'instant' });
}
document.addEventListener('click', event => {
  const summary = event.target.closest('summary');
  if (!summary || summary.parentElement.open) return;
  requestAnimationFrame(() => { for (const child of summary.parentElement.children) if (child !== summary) animate(child, [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220 }); });
});
reduced.addEventListener('change', () => { if (reduced.matches) for (const animation of document.getAnimations()) animation.finish(); });
