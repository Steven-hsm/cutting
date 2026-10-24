'use strict';

/**
 * Snipaste 风格的放大镜与取色器：
 * - 跟随光标显示，靠近屏幕边缘时自动翻到另一侧
 * - Alt 显示/隐藏，Shift 切换 HEX / RGB，C 复制颜色
 */
(function () {
  const ZOOM = 10; // 放大倍数
  const SAMPLE = 12; // 取样像素范围（物理像素）
  const state = {
    el: null,
    canvas: null,
    ctx: null,
    swatch: null,
    valueEl: null,
    formatEl: null,
    color: '#000000',
    rgb: { r: 0, g: 0, b: 0 },
    format: 'HEX',
    pixel: { x: 0, y: 0 },
    raf: 0,
    pending: null,
    bgCanvas: null,
    bgCtx: null,
    enabled: true,
    lastPointer: null,
  };

  function init() {
    state.el = document.getElementById('picker');
    state.canvas = document.getElementById('picker-canvas');
    state.ctx = state.canvas.getContext('2d');
    state.swatch = document.getElementById('picker-swatch');
    state.valueEl = document.getElementById('picker-hex');
    state.formatEl = document.getElementById('picker-format');
    state.canvas.width = SAMPLE * ZOOM;
    state.canvas.height = SAMPLE * ZOOM;
    state.bgCanvas = App.bgCanvas;
    state.bgCtx = App.bgCanvas.getContext('2d', { willReadFrequently: true });

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', hide);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  function hide() {
    // 取消未执行的刷新，避免隐藏后被上一帧的调度重新显示
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    state.pending = null;
    state.el.classList.add('hidden');
  }

  function setEnabled(enabled) {
    state.enabled = !!enabled;
    if (!state.enabled) hide();
    else if (state.lastPointer) update(state.lastPointer.x, state.lastPointer.y);
  }

  function toggle() {
    setEnabled(!state.enabled);
    return state.enabled;
  }

  function toggleFormat() {
    state.format = state.format === 'HEX' ? 'RGB' : 'HEX';
    state.formatEl.textContent = state.format;
    renderReadout();
  }

  function onPointerMove(event) {
    if (!state.canvas) return;
    state.lastPointer = { x: event.clientX, y: event.clientY };

    // 使用标注工具或输入文字时隐藏放大镜，避免遮挡
    if (!state.enabled || TextBox.isOpen() || Editor.getTool()) {
      hide();
      return;
    }

    state.pending = state.lastPointer;
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      if (state.pending) update(state.pending.x, state.pending.y);
    });
  }

  function update(clientX, clientY) {
    const x = Math.min(Math.max(clientX, 0), App.dipW - 1);
    const y = Math.min(Math.max(clientY, 0), App.dipH - 1);

    const px = Math.floor(x * App.imageScaleX);
    const py = Math.floor(y * App.imageScaleY);
    if (px < 0 || py < 0 || px >= state.bgCanvas.width || py >= state.bgCanvas.height) {
      hide();
      return;
    }

    let data = null;
    try {
      data = state.bgCtx.getImageData(px, py, 1, 1).data;
    } catch (err) {
      hide();
      return;
    }

    const [r, g, b] = data;
    state.rgb = { r, g, b };
    state.color = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    state.pixel = { x: px, y: py };

    drawMagnifier(px, py);
    state.swatch.style.background = state.color;
    renderReadout();
    position(clientX, clientY);
  }

  function renderReadout() {
    if (state.format === 'RGB') {
      const { r, g, b } = state.rgb;
      state.valueEl.textContent = `${r}, ${g}, ${b}`;
    } else {
      state.valueEl.textContent = state.color.toUpperCase();
    }
  }

  function drawMagnifier(px, py) {
    const half = Math.floor(SAMPLE / 2);
    const sx = px - half;
    const sy = py - half;
    const ctx = state.ctx;
    const size = SAMPLE * ZOOM;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14151a';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(state.bgCanvas, sx, sy, SAMPLE, SAMPLE, 0, 0, size, size);

    // 像素网格
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < SAMPLE; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * ZOOM + 0.5, 0);
      ctx.lineTo(i * ZOOM + 0.5, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * ZOOM + 0.5);
      ctx.lineTo(size, i * ZOOM + 0.5);
      ctx.stroke();
    }

    // 中心像素高亮
    ctx.strokeStyle = 'rgba(47, 128, 237, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(half * ZOOM + 1, half * ZOOM + 1, ZOOM - 2, ZOOM - 2);

    // 十字准星
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
  }

  function position(clientX, clientY) {
    const width = state.el.offsetWidth || 132;
    const height = state.el.offsetHeight || 172;
    const gap = 20;
    const margin = 8;

    let left = clientX + gap;
    let top = clientY + gap;
    if (left + width > App.dipW - margin) left = clientX - width - gap;
    if (top + height > App.dipH - margin) top = clientY - height - gap;

    state.el.style.left = `${Math.max(margin, left)}px`;
    state.el.style.top = `${Math.max(margin, top)}px`;
    state.el.classList.remove('hidden');
  }

  function toHex(value) {
    return Number(value).toString(16).padStart(2, '0');
  }

  function onKeyDown(event) {
    if (TextBox.isOpen()) return;

    if (event.key === 'Alt' && !event.repeat) {
      event.preventDefault();
      const enabled = toggle();
      App.toast(enabled ? '放大镜已开启' : '放大镜已隐藏');
      return;
    }

    if (event.key === 'Shift' && !event.repeat && !state.el.classList.contains('hidden')) {
      toggleFormat();
      return;
    }

    const key = String(event.key).toLowerCase();
    if (key !== 'c' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (state.el.classList.contains('hidden')) return;
    event.preventDefault();
    event.stopPropagation();
    copyColor();
  }

  function onKeyUp(event) {
    // 避免 Alt 组合键（如 Alt+Tab）反复触发；单独按下 Alt 才切换
    if (event.key === 'Alt') event.preventDefault();
  }

  async function copyColor() {
    const value =
      state.format === 'RGB'
        ? `rgb(${state.rgb.r}, ${state.rgb.g}, ${state.rgb.b})`
        : state.color.toUpperCase();
    let result = null;
    try {
      result = await window.api.app.copyText(value);
    } catch (err) {
      result = { ok: false };
    }
    App.toast(result && result.ok ? `已复制颜色 ${value}` : '复制颜色失败');
  }

  window.Picker = {
    init,
    hide,
    copyColor,
    toggle,
    toggleFormat,
    getColor: () => state.color,
  };
})();
