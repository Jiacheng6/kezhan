/**
 * 主题切换：模式（白天/黑夜）+ 配色（绿/粉/黄/蓝/白）。
 * 只写 <html data-mode data-accent>，颜色由 theme.css 决定。
 */
import { motionEnabled } from './motion.js';

const KEY = 'kebo-theme';
const MODES = ['light', 'dark'];
const ACCENTS = ['green', 'pink', 'yellow', 'blue', 'mono'];

const DEFAULT = { mode: 'light', accent: 'green' };
let transition;
let revision = 0;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      mode: MODES.includes(raw.mode) ? raw.mode : DEFAULT.mode,
      accent: ACCENTS.includes(raw.accent) ? raw.accent : DEFAULT.accent,
    };
  } catch {
    return { ...DEFAULT };
  }
}

function save(theme) {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    /* 隐私模式忽略 */
  }
}

export function applyTheme(theme, animated = false, origin) {
  const root = document.documentElement;
  const mode = MODES.includes(theme.mode) ? theme.mode : DEFAULT.mode;
  const accent = ACCENTS.includes(theme.accent) ? theme.accent : DEFAULT.accent;
  const request = ++revision;
  transition?.skipTransition();
  if (root.dataset.mode === mode && root.dataset.accent === accent) return;
  const reveal = root.dataset.mode !== mode;
  const animate = animated && motionEnabled() && !document.hidden;
  const update = () => {
    if (request !== revision) return;
    root.dataset.mode = mode;
    root.dataset.accent = accent;
    document.dispatchEvent(new CustomEvent('kebo-theme-change'));
  };
  if (!animate || !document.startViewTransition) {
    update();
    return;
  }
  if (reveal) {
    const rect = origin?.getBoundingClientRect();
    const x = rect?.width ? rect.left + rect.width / 2 : innerWidth / 2;
    const y = rect?.height ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.style.setProperty('--theme-reveal-origin', `${x}px ${y}px`);
    root.style.setProperty('--theme-reveal-radius', `${radius}px`);
  }
  root.toggleAttribute('data-theme-reveal', reveal);
  root.toggleAttribute('data-theme-wipe', !reveal);
  root.removeAttribute('data-theme-capture');
  const current = document.startViewTransition(() => {
    if (request !== revision) return;
    // Capture the final colors so the moving mask supplies the only blend.
    root.toggleAttribute('data-theme-capture', !reveal);
    update();
  });
  transition = current;
  const finishCapture = () => {
    if (transition === current) root.removeAttribute('data-theme-capture');
  };
  current.ready.then(finishCapture, finishCapture);
  const cleanup = () => {
    if (transition !== current) return;
    transition = undefined;
    root.removeAttribute('data-theme-reveal');
    root.removeAttribute('data-theme-wipe');
    root.removeAttribute('data-theme-capture');
    root.style.removeProperty('--theme-reveal-origin');
    root.style.removeProperty('--theme-reveal-radius');
  };
  current.finished.then(cleanup, cleanup);
}

export function initTheme() {
  const theme = load();
  applyTheme(theme);

  const menu = document.querySelector('#themeMenu');
  const modeToggle = document.querySelector('#modeToggle');
  const syncMode = () => {
    modeToggle?.setAttribute('aria-pressed', String(theme.mode === 'dark'));
    modeToggle?.setAttribute('aria-label', theme.mode === 'dark' ? '切换到白天' : '切换到黑夜');
    if(modeToggle)modeToggle.title = theme.mode === 'dark' ? '切换到白天' : '切换到黑夜';
  };
  syncMode();
  const toggleMode = (origin = modeToggle) => {
    theme.mode = theme.mode === 'dark' ? 'light' : 'dark';
    applyTheme(theme, true, origin);
    save(theme);
    syncMode();
  };
  modeToggle?.addEventListener('click', () => toggleMode());
  document.addEventListener('kebo-toggle-mode', event => toggleMode(event.detail));
  const selectAccent = accent => {
    if (!ACCENTS.includes(accent)) return;
    theme.accent = accent;
    applyTheme(theme, true);
    save(theme);
  };
  document.addEventListener('kebo-select-accent', event => selectAccent(event.detail));
  if (menu) {
    const sync = () => {
      for (const btn of menu.querySelectorAll('.theme-mode')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === theme.mode));
      }
      for (const btn of menu.querySelectorAll('.theme-accent')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.accent === theme.accent));
      }
    };
    sync();
    document.addEventListener('kebo-theme-change', sync);

    menu.addEventListener('click', (event) => {
      const modeBtn = event.target.closest?.('.theme-mode');
      const accentBtn = event.target.closest?.('.theme-accent');
      if (modeBtn) {
        theme.mode = modeBtn.dataset.mode;
        applyTheme(theme, true, modeBtn);
        save(theme);
        syncMode();
        return;
      }
      if (accentBtn) selectAccent(accentBtn.dataset.accent);
    });

    // 点空白处收起面板
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  }

  return theme;
}

initTheme();
