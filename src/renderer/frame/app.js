'use strict';

// 同一个页面用于四种形态：上方提示条 + 顶边线、左/右/下三条 4px 边框
(function () {
  const variant = location.hash.replace('#', '');
  const params = new URLSearchParams(location.search);
  const label = params.get('label') || 'REC';
  const tone = params.get('tone') || 'red';
  const len = Number(params.get('len')) || 0;

  document.body.classList.add(`tone-${tone}`);

  if (variant === 'top') {
    document.getElementById('badge').classList.remove('hidden');
    const line = document.getElementById('topline');
    line.classList.remove('hidden');
    if (len > 0) line.style.width = `${len}px`;
    document.getElementById('badge-label').textContent = label;
    return;
  }

  const allowed = ['left', 'right', 'bottom'];
  if (allowed.includes(variant)) {
    const el = document.getElementById(variant);
    el.classList.remove('hidden');
    if (len > 0) {
      if (variant === 'bottom') el.style.width = `${len}px`;
      else el.style.height = `${len}px`;
    }
  }
})();
