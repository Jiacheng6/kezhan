// Preserve appearance, archive and selection preferences after the prefix rename.
(() => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('xxt-')) continue;
      const target = 'kebo-' + key.slice(4);
      if (localStorage.getItem(target) === null) localStorage.setItem(target, localStorage.getItem(key));
    }
  } catch { /* storage may be unavailable */ }
})();
