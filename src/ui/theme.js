/**
 * 主题切换：模式（白天/黑夜）+ 配色（绿/粉/黄/蓝/白）。
 * 只写 <html data-mode data-accent>，颜色由 theme.css 决定。
 */
const KEY = 'kebo-theme';
const MODES = ['light', 'dark'];
const ACCENTS = ['green', 'pink', 'yellow', 'blue', 'mono'];

const DEFAULT = { mode: 'light', accent: 'green' };

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

export function applyTheme(theme, animated = false) {
  const root = document.documentElement;
  const update = () => {
    root.dataset.mode = MODES.includes(theme.mode) ? theme.mode : DEFAULT.mode;
    root.dataset.accent = ACCENTS.includes(theme.accent) ? theme.accent : DEFAULT.accent;
    document.dispatchEvent(new CustomEvent('kebo-theme-change'));
  };
  // One short crossfade, rather than repainting hundreds of transitioning controls.
  const useTransition = animated && document.startViewTransition &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches && root.dataset.input !== 'keyboard';
  if (useTransition) {
    window.__themeTransition?.skipTransition();
    window.__themeTransition = document.startViewTransition(update);
    window.__themeTransition.ready.then(() => {
      const button = document.querySelector('#modeToggle');
      const rect = button?.getBoundingClientRect();
      const x = rect ? rect.x + rect.width / 2 : innerWidth / 2, y = rect ? rect.y + rect.height / 2 : 0;
      const radius = Math.hypot(Math.max(x, innerWidth-x), Math.max(y, innerHeight-y));
      document.documentElement.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${radius}px at ${x}px ${y}px)`]}, {duration:440,easing:'cubic-bezier(.22,1,.36,1)',pseudoElement:'::view-transition-new(root)'});
    }).catch(()=>{});
  } else update();
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
  modeToggle?.addEventListener('click', () => {
    theme.mode = theme.mode === 'dark' ? 'light' : 'dark';
    applyTheme(theme,true); save(theme); syncMode();
  });
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

    menu.addEventListener('click', (event) => {
      const modeBtn = event.target.closest?.('.theme-mode');
      const accentBtn = event.target.closest?.('.theme-accent');
      if (modeBtn) {
        theme.mode = modeBtn.dataset.mode;
        applyTheme(theme, true);
        save(theme);
        sync();
        return;
      }
      if (accentBtn) {
        theme.accent = accentBtn.dataset.accent;
        applyTheme(theme, true);
        save(theme);
        sync();
      }
    });

    // 点空白处收起面板
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  }

  return theme;
}

initTheme();
