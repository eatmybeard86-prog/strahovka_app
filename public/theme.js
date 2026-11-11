'use strict';
// Тема оформлення: auto (як на пристрої), light, dark, graphite. Зберігається в цьому браузері.
(function () {
  const KEY = 'oblik-theme';
  const THEMES = ['auto', 'light', 'dark', 'graphite'];
  function read() {
    try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'auto'; } catch { return 'auto'; }
  }
  function apply(theme) {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }
  apply(read());
  document.addEventListener('DOMContentLoaded', () => {
    const selects = document.querySelectorAll('.theme-select');
    selects.forEach((sel) => {
      sel.value = read();
      sel.addEventListener('change', () => {
        try { localStorage.setItem(KEY, sel.value); } catch { /* приватний режим */ }
        apply(sel.value);
        selects.forEach((other) => { other.value = sel.value; });
      });
    });
  });
})();
