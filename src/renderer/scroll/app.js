'use strict';

(function () {
  const statusEl = document.getElementById('status');
  const detailEl = document.getElementById('detail');
  const dot = document.getElementById('dot');
  const stopBtn = document.getElementById('btn-stop');
  let finished = false;

  function renderProgress(payload) {
    if (finished) return;
    statusEl.textContent = payload.status || '滚动截图中…';
    const parts = [];
    if (payload.steps) parts.push(`第 ${payload.steps} 屏`);
    if (payload.height) parts.push(`已拼接 ${payload.height} px`);
    detailEl.textContent = parts.join(' · ');
  }

  function renderDone(result) {
    if (finished) return;
    finished = true;
    stopBtn.disabled = true;
    if (result && result.ok) {
      dot.classList.add('done');
      statusEl.textContent = '滚动截图完成，已保存';
      detailEl.textContent = `${result.height} px · ${result.steps} 屏 · ${result.stopReason}`;
    } else {
      dot.classList.add('error');
      statusEl.textContent = '滚动截图未完成';
      detailEl.textContent = (result && result.error) || '未知错误';
    }
  }

  window.api.scroll.onProgress(renderProgress);
  window.api.scroll.onDone(renderDone);

  stopBtn.addEventListener('click', () => {
    if (finished) return;
    stopBtn.disabled = true;
    statusEl.textContent = '正在停止并保存…';
    window.api.scroll.stop();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !finished) {
      event.preventDefault();
      stopBtn.disabled = true;
      statusEl.textContent = '正在停止并保存…';
      window.api.scroll.stop();
    }
  });
})();
