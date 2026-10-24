'use strict';

(function () {
  const textEl = document.getElementById('text');
  const metaEl = document.getElementById('meta');
  const statusEl = document.getElementById('status');
  let statusTimer = 0;

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('error', !!isError);
    if (statusTimer) clearTimeout(statusTimer);
    if (message) {
      statusTimer = setTimeout(() => {
        statusEl.textContent = '';
        statusTimer = 0;
      }, 2600);
    }
  }

  function render(result) {
    if (!result) return;
    textEl.value = result.text || '';
    const parts = [];
    if (result.source) parts.push(result.source);
    if (result.language) parts.push(result.language);
    parts.push(`${(result.text || '').length} 字符`);
    metaEl.textContent = parts.join(' · ');
    textEl.focus();
    textEl.setSelectionRange(0, 0);
  }

  async function copyAll() {
    const value = textEl.value;
    if (!value) {
      setStatus('没有可复制的内容', true);
      return;
    }
    try {
      const result = await window.api.app.copyText(value);
      setStatus(result && result.ok ? '已复制到剪贴板' : '复制失败', !(result && result.ok));
    } catch (err) {
      setStatus('复制失败', true);
    }
  }

  document.getElementById('btn-copy').addEventListener('click', copyAll);
  document.getElementById('btn-close').addEventListener('click', () => window.api.ocr.close());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      window.api.ocr.close();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'c') {
      event.preventDefault();
      copyAll();
    }
  });

  window.api.ocr.onResult(render);

  (async () => {
    try {
      const init = await window.api.ocr.getInit();
      render(init);
    } catch (err) {
      // ignore
    }
  })();
})();
