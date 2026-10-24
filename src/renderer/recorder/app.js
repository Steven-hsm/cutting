'use strict';

(function () {
  const state = {
    init: null,
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    writer: null,
    timer: 0,
    startedAt: 0,
    elapsed: 0,
    finishing: false,
    thumbDataUrl: null,
    width: 0,
    height: 0,
    skippedFrames: 0,
  };

  const timerEl = document.getElementById('timer');
  const sizeEl = document.getElementById('size');
  const statusEl = document.getElementById('status');
  const stopBtn = document.getElementById('btn-stop');

  function formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
    statusEl.classList.remove('hidden');
    stopBtn.disabled = true;
  }

  async function start() {
    try {
      state.init = await window.api.recorder.getInit();
    } catch (err) {
      state.init = null;
    }
    if (!state.init) {
      window.api.recorder.cancel();
      return;
    }

    const { region, displayBounds, fps, maxSeconds } = state.init;
    const video = document.getElementById('video');
    state.video = video;

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: Math.min(30, fps + 5) },
        audio: false,
      });
    } catch (err) {
      showStatus(`无法开始屏幕捕获：${err && err.message ? err.message : err}`, true);
      setTimeout(() => window.api.recorder.cancel(), 1800);
      return;
    }

    state.stream = stream;
    video.srcObject = stream;
    await video.play();

    const scaleX = video.videoWidth / displayBounds.width;
    const scaleY = video.videoHeight / displayBounds.height;

    // 源区域（物理像素）
    const sx = Math.round(region.x * scaleX);
    const sy = Math.round(region.y * scaleY);
    const sw = Math.max(2, Math.round(region.w * scaleX));
    const sh = Math.max(2, Math.round(region.h * scaleY));

    // 限制最大宽度，避免 GIF 过大
    const maxWidth = 1000;
    const ratio = Math.min(1, maxWidth / sw);
    const width = Math.max(2, Math.round((sw * ratio) / 2) * 2);
    const height = Math.max(2, Math.round((sh * ratio) / 2) * 2);

    state.width = width;
    state.height = height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d', { willReadFrequently: true });

    sizeEl.textContent = `${width}×${height}`;
    state.writer = new GifEncoder.GifWriter(width, height, { fps });
    state.startedAt = performance.now();
    state.elapsed = 0;

    const frameInterval = 1000 / fps;
    let lastFrameAt = 0;

    state.timer = setInterval(() => {
      if (state.finishing) return;

      const now = performance.now();
      state.elapsed = now - state.startedAt;
      timerEl.textContent = formatDuration(state.elapsed);

      if (state.elapsed >= maxSeconds * 1000) {
        finish('达到最长录制时间');
        return;
      }

      if (now - lastFrameAt < frameInterval * 0.85) return;
      lastFrameAt = now;

      try {
        state.ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
        const imageData = state.ctx.getImageData(0, 0, width, height);
        if (!state.thumbDataUrl) {
          state.thumbDataUrl = makeThumb(canvas);
        }
        state.writer.addFrame(GifEncoder.quantize(imageData));
      } catch (err) {
        state.skippedFrames += 1;
      }
    }, 16);
  }

  function makeThumb(canvas) {
    const maxWidth = 320;
    const ratio = Math.min(1, maxWidth / canvas.width);
    const thumb = document.createElement('canvas');
    thumb.width = Math.max(1, Math.round(canvas.width * ratio));
    thumb.height = Math.max(1, Math.round(canvas.height * ratio));
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/png');
  }

  async function finish(reason) {
    if (state.finishing || !state.writer) return;
    state.finishing = true;
    stopBtn.disabled = true;
    clearInterval(state.timer);
    timerEl.textContent = formatDuration(performance.now() - state.startedAt);
    showStatus(reason || '正在生成 GIF…');

    try {
      if (state.stream) {
        for (const track of state.stream.getTracks()) track.stop();
      }

      if (!state.writer.frameCount) {
        showStatus('没有捕获到画面', true);
        setTimeout(() => window.api.recorder.cancel(), 1500);
        return;
      }

      const blob = state.writer.finish();
      const buffer = await blob.arrayBuffer();

      showStatus(`正在保存 GIF（${state.writer.frameCount} 帧）…`);

      const result = await window.api.recorder.finish({
        gif: buffer,
        thumb: state.thumbDataUrl,
        width: state.width,
        height: state.height,
        durationMs: Math.round(performance.now() - state.startedAt),
        frames: state.writer.frameCount,
      });

      if (!result || !result.ok) {
        showStatus(`保存失败：${(result && result.error) || '未知错误'}`, true);
        setTimeout(() => window.api.recorder.cancel(), 2200);
      }
    } catch (err) {
      showStatus(`生成失败：${err && err.message ? err.message : err}`, true);
      setTimeout(() => window.api.recorder.cancel(), 2200);
    }
  }

  function stop() {
    finish('正在生成 GIF…');
  }

  stopBtn.addEventListener('click', stop);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      stop();
    }
  });

  start().catch((err) => {
    showStatus(`录制失败：${err && err.message ? err.message : err}`, true);
    setTimeout(() => window.api.recorder.cancel(), 2000);
  });
})();
