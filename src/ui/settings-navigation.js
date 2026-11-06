const list = document.querySelector('.settings-categories');
const tabs = [...list.querySelectorAll('[data-settings-category]')];
const narrow = matchMedia('(max-width: 920px)');

export function selectSettingsSection(category, focus = false) {
  const active = tabs.find(tab => tab.dataset.settingsCategory === category);
  if (!active) return;
  const changed = active.getAttribute('aria-selected') !== 'true';
  for (const tab of tabs) {
    const selected = tab === active;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  if (changed && document.body.dataset.panel === 'settings') window.scrollTo({top:0,behavior:'instant'});
  if (focus) active.focus();
}

const updateOrientation = () => list.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
narrow.addEventListener('change', updateOrientation);
updateOrientation();
for (const tab of tabs) tab.addEventListener('click', () => selectSettingsSection(tab.dataset.settingsCategory));
list.addEventListener('keydown', event => {
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const next = narrow.matches ? 'ArrowRight' : 'ArrowDown';
  const previous = narrow.matches ? 'ArrowLeft' : 'ArrowUp';
  const target = { Home: 0, End: tabs.length - 1, [next]: index + 1, [previous]: index - 1 }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  selectSettingsSection(tabs[(target + tabs.length) % tabs.length].dataset.settingsCategory, true);
});
