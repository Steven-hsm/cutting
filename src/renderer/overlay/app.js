'use strict';

const App = (window.App = {
  init: null,
  scale: 1,
  dipW: 0,
  dipH: 0,
  bgCanvas: null,
  bgCtx: null,
  bgImage: null,
  imageScaleX: 1,
  imageScaleY: 1,
  maskScaleX: 1,
  maskScaleY: 1,
  rect: null,
  hoverWindow: null,
  state: 'selecting',
  confirming: false,
  pinning: false,
  recognizing: false,
  autoTimer: 0,
  toastTimer: 0,

  setupCanvases() {
    const bg = document.getElementById('bg-canvas');
    const mask = document.getElementById('mask-canvas');

    this.bgCanvas = bg;
    // 取色器会频繁读取像素，声明 willReadFrequently 以避免浏览器告警与降速
    this.bgCtx = setupCanvas(bg, this.dipW, this.dipH, this.scale, { willReadFrequently: true });
    setupCanvas(mask, this.dipW, this.dipH, this.scale);

    const init = this.init;
    this.imageRect = init.imageRect || { x: 0, y: 0, w: this.dipW, h: this.dipH };
    this.imageOffsetX = this.imageRect.x;
    this.imageOffsetY = this.imageRect.y;
    // 物理像素 / DIP：窗口截图可能被缩放，不能直接用画布尺寸推算
    this.imageScaleX = (init.imageWidth || this.imageRect.w) / this.imageRect.w;
    this.imageScaleY = (init.imageHeight || this.imageRect.h) / this.imageRect.h;
    // 背景画布是物理像素尺寸，绘制到 DIP 坐标
    this.bgCtx.setTransform(this.imageScaleX, 0, 0, this.imageScaleY, 0, 0);
    this.boundsRect = { ...this.imageRect };
    this.maskScaleX = mask.width / this.dipW;
    this.maskScaleY = mask.height / this.dipH;

    this.bgCtx.drawImage(
      this.bgImage,
      this.imageRect.x,
      this.imageRect.y,
      this.imageRect.w,
      this.imageRect.h
    );
  },

  bindGlobalEvents() {
    window.addEventListener('keydown', (event) => {
      if (TextBox.isOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.handleEscape();
        return;
      }
      if (event.key === 'Enter' && this.state === 'selected') {
        event.preventDefault();
        this.confirm();
        return;
      }
      if (event.key === 'Tab' && this.state === 'selected') {
        const tool = Editor.getTool();
        if (tool === 'line' || tool === 'arrow') {
          event.preventDefault();
          Toolbar.activate(tool === 'line' ? 'arrow' : 'line');
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        const key = String(event.key).toLowerCase();
        // 识图模式下优先复制选中的文字
        if (key === 'c' && TextLayer.isActive() && TextLayer.getSelectedText()) {
          event.preventDefault();
          TextLayer.copySelected();
          return;
        }
        if (key === 'p' && !event.shiftKey && this.state === 'selected') {
          event.preventDefault();
          this.pin();
          return;
        }
        if (key === 'z' && !event.shiftKey && this.state === 'selected') {
          event.preventDefault();
          Editor.undo();
          return;
        }
        if ((key === 'y' || (key === 'z' && event.shiftKey)) && this.state === 'selected') {
          event.preventDefault();
          Editor.redo();
          return;
        }
      }
      // 方向键微调选区：Ctrl 扩大、Shift 缩小
      if (
        this.state === 'selected' &&
        !event.altKey &&
        event.key.startsWith('Arrow')
      ) {
        event.preventDefault();
        this.nudgeSelection(event.key, event.ctrlKey || event.metaKey, event.shiftKey);
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) return;

      // 方括号调整当前工具粗细
      if (event.key === '[' || event.key === ']') {
        const message = Editor.adjustWidth(event.key === ']' ? 1 : -1);
        if (message) {
          event.preventDefault();
          this.toast(message);
        }
        return;
      }

      // 工具快捷键
      if (!event.shiftKey && this.state === 'selected') {
        const toolKeys = {
          t: 'text',
          r: 'rect',
          o: 'ellipse',
          a: 'arrow',
          l: 'line',
          p: 'pen',
          h: 'highlight',
          n: 'step',
          m: 'mosaic',
          b: 'blur',
        };
        const tool = toolKeys[String(event.key).toLowerCase()];
        if (tool) {
          event.preventDefault();
          Toolbar.activate(tool);
        }
      }
    });

    // 滚轮调整当前工具的粗细/字号
    window.addEventListener(
      'wheel',
      (event) => {
        if (TextBox.isOpen()) return;
        if (event.target.closest && event.target.closest('#toolbar')) return;
        if (this.state !== 'selected' || !Editor.getTool()) return;
        event.preventDefault();
        const message = Editor.adjustWidth(event.deltaY < 0 ? 1 : -1);
        if (message) this.toast(message);
      },
      { passive: false }
    );

    window.addEventListener('contextmenu', (event) => event.preventDefault());
  },

  /**
   * 方向键微调选区：直接移动，Ctrl 向该方向扩大，Shift 向该方向缩小。
   */
  nudgeSelection(key, expand, shrink) {
    const rect = this.rect;
    if (!rect) return;
    const step = 1;
    const next = { ...rect };

    if (expand) {
      if (key === 'ArrowLeft') {
        next.x -= step;
        next.w += step;
      } else if (key === 'ArrowRight') {
        next.w += step;
      } else if (key === 'ArrowUp') {
        next.y -= step;
        next.h += step;
      } else if (key === 'ArrowDown') {
        next.h += step;
      }
    } else if (shrink) {
      if (key === 'ArrowLeft') {
        next.x += step;
        next.w -= step;
      } else if (key === 'ArrowRight') {
        next.w -= step;
      } else if (key === 'ArrowUp') {
        next.y += step;
        next.h -= step;
      } else if (key === 'ArrowDown') {
        next.h -= step;
      }
    } else {
      if (key === 'ArrowLeft') next.x -= step;
      else if (key === 'ArrowRight') next.x += step;
      else if (key === 'ArrowUp') next.y -= step;
      else if (key === 'ArrowDown') next.y += step;
    }

    const bounds = this.boundsRect || { x: 0, y: 0, w: this.dipW, h: this.dipH };
    const minSize = 10;
    next.w = Math.max(minSize, next.w);
    next.h = Math.max(minSize, next.h);
    next.x = Math.min(Math.max(next.x, bounds.x), bounds.x + bounds.w - next.w);
    next.y = Math.min(Math.max(next.y, bounds.y), bounds.y + bounds.h - next.h);

    if (next.x === rect.x && next.y === rect.y && next.w === rect.w && next.h === rect.h) return;

    this.rect = next;
    Editor.setSelection(next, { keepOps: true });
    this.showSizeLabel(next);
    Toolbar.position();
    Selection.redraw();
  },

  handleEscape() {
    if (TextBox.isOpen()) {
      TextBox.cancel();
      return;
    }
    if (TextLayer.isActive()) {
      TextLayer.close();
      Selection.redraw();
      this.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
      return;
    }
    if (Editor.getTool()) {
      Toolbar.setActive(null);
      Editor.setTool(null);
      Selection.redraw();
      return;
    }
    if (this.state === 'selected') {
      this.resetSelection();
      return;
    }
    this.cancelAll();
  },

  attachSelection() {
    if (!this.rect) return;
    this.state = 'selected';
    Editor.setSelection(this.rect);
    Toolbar.setActive(null);
    Toolbar.show();
    this.showSizeLabel(this.rect);
    this.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
    Selection.redraw();

    if (this.init.autoAction) {
      this.beginAutoAction(this.init.autoAction);
    }
  },

  beginAutoAction(action) {
    if (this.autoTimer) clearInterval(this.autoTimer);
    let seconds = 2;
    const label = action === 'gif' ? '录制 GIF' : '滚动截图';
    const update = () => {
      this.setHint(`${seconds} 秒后自动开始${label} · 拖动选区可重新选择 · Esc 取消`);
    };
    update();

    this.autoTimer = setInterval(() => {
      seconds -= 1;
      if (seconds > 0) {
        update();
        return;
      }
      clearInterval(this.autoTimer);
      this.autoTimer = 0;
      if (action === 'gif') this.startGif();
      else this.startScroll();
    }, 1000);
  },

  clearAutoAction() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = 0;
    }
  },

  /**
   * 移动/调整选区后重建编辑层（保留已有标注，标注随选区一起移动/缩放）。
   */
  adjustSelection() {
    if (!this.rect) return;
    this.state = 'selected';
    Editor.setSelection(this.rect, { keepOps: true });
    Toolbar.setActive(null);
    Toolbar.show();
    this.showSizeLabel(this.rect);
    this.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
    Selection.redraw();
  },

  resetSelection() {
    if (TextBox.isOpen()) TextBox.cancel();
    this.clearAutoAction();
    this.state = 'selecting';
    this.rect = null;
    Editor.clear();
    Toolbar.hide();
    Toolbar.setActive(null);
    this.hideSizeLabel();
    this.setHint('拖动选择区域 · Alt 放大镜 · Esc 取消');
    Selection.redraw();
  },

  async confirm() {
    // 同步守卫：连续按回车/点击保存时只发起一次保存
    if (this.confirming) return;
    if (this.state !== 'selected' || !this.rect) return;
    if (TextBox.isOpen()) TextBox.submit();

    let dataUrl = null;
    let fileDataUrl = null;
    try {
      dataUrl = Editor.exportDataUrl();
      const format = this.init.exportFormat || 'png';
      if (format !== 'png') {
        fileDataUrl = Editor.exportEncoded(format, this.init.exportQuality);
      }
    } catch (err) {
      this.toast(`导出失败：${err && err.message ? err.message : err}`);
      return;
    }
    if (!dataUrl) return;

    this.confirming = true;
    try {
      const result = await window.api.overlay.confirm({
        dataUrl,
        fileDataUrl,
        scaleFactor: this.scale,
        dipRect: this.rect,
      });
      if (result && !result.ok) {
        this.toast(`保存失败：${result.error || '未知错误'}`);
      }
    } catch (err) {
      this.toast(`保存失败：${err && err.message ? err.message : err}`);
    } finally {
      this.confirming = false;
    }
  },

  async recognizeText() {
    if (this.recognizing) return;
    if (this.state !== 'selected' || !this.rect) return;
    if (TextBox.isOpen()) TextBox.submit();

    let dataUrl = null;
    try {
      const raw = Editor.exportCanvas();
      dataUrl = raw ? raw.toDataURL('image/png') : null;
    } catch (err) {
      this.toast(`导出失败：${err && err.message ? err.message : err}`);
      return;
    }
    if (!dataUrl) return;

    this.recognizing = true;
    this.setHint('正在识别文字…');
    try {
      const result = await window.api.ocr.recognize(dataUrl);
      if (result && result.ok) {
        const opened = TextLayer.open(result.lines || [], {
          originX: this.rect.x,
          originY: this.rect.y,
          scaleX: this.imageScaleX,
          scaleY: this.imageScaleY,
        });
        if (!opened) {
          this.toast('未识别到文字');
          this.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
        }
      } else {
        this.toast(`识别失败：${(result && result.error) || '未知错误'}`);
        this.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
      }
    } catch (err) {
      this.toast(`识别失败：${err && err.message ? err.message : err}`);
    } finally {
      this.recognizing = false;
    }
  },

  async startGif() {
    if (this.state !== 'selected' || !this.rect) return;
    this.clearAutoAction();
    if (TextBox.isOpen()) TextBox.submit();
    try {
      const result = await window.api.overlay.startGif({ dipRect: this.rect });
      if (result && !result.ok) this.toast(`无法开始录制：${result.error || '未知错误'}`);
    } catch (err) {
      this.toast(`无法开始录制：${err && err.message ? err.message : err}`);
    }
  },

  async startScroll() {
    if (this.state !== 'selected' || !this.rect) return;
    this.clearAutoAction();
    if (TextBox.isOpen()) TextBox.submit();
    try {
      const result = await window.api.overlay.startScroll({ dipRect: this.rect });
      if (result && !result.ok) this.toast(`无法开始滚动截图：${result.error || '未知错误'}`);
    } catch (err) {
      this.toast(`无法开始滚动截图：${err && err.message ? err.message : err}`);
    }
  },

  async pin() {
    if (this.pinning) return;
    if (this.state !== 'selected' || !this.rect) return;
    if (TextBox.isOpen()) TextBox.submit();

    let dataUrl = null;
    try {
      dataUrl = Editor.exportDataUrl();
    } catch (err) {
      this.toast(`导出失败：${err && err.message ? err.message : err}`);
      return;
    }
    if (!dataUrl) return;

    this.pinning = true;
    try {
      const result = await window.api.overlay.pin({ dataUrl, dipRect: this.rect });
      if (result && !result.ok) {
        this.toast(`贴图失败：${result.error || '未知错误'}`);
      }
    } catch (err) {
      this.toast(`贴图失败：${err && err.message ? err.message : err}`);
    } finally {
      this.pinning = false;
    }
  },

  cancelAll() {
    this.clearAutoAction();
    window.api.overlay.cancel();
  },

  showSizeLabel(rect) {
    const el = document.getElementById('size-label');
    if (!rect) return;
    const width = Math.max(0, Math.round(rect.w * this.imageScaleX));
    const height = Math.max(0, Math.round(rect.h * this.imageScaleY));
    el.textContent = `${width} × ${height}`;
    el.classList.remove('hidden');

    let top = rect.y - 26;
    if (top < 4) top = rect.y + rect.h + 6;
    const left = Math.max(4, Math.min(rect.x, this.dipW - 120));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  },

  hideSizeLabel() {
    const el = document.getElementById('size-label');
    if (el) el.classList.add('hidden');
  },

  setHint(text) {
    const el = document.getElementById('hint');
    if (!el) return;
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
  },

  toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      this.toastTimer = 0;
    }, 2600);
  },
});

function setupCanvas(canvas, dipW, dipH, scale, options) {
  canvas.width = Math.max(1, Math.round(dipW * scale));
  canvas.height = Math.max(1, Math.round(dipH * scale));
  canvas.style.width = `${dipW}px`;
  canvas.style.height = `${dipH}px`;
  const ctx = canvas.getContext('2d', options);
  ctx.setTransform(canvas.width / dipW, 0, 0, canvas.height / dipH, 0, 0);
  return ctx;
}

document.addEventListener('DOMContentLoaded', async () => {
  let init = null;
  try {
    init = await window.api.overlay.getInit();
  } catch (err) {
    init = null;
  }

  if (!init) {
    window.api.overlay.cancel();
    return;
  }

  App.init = init;
  App.scale = init.scaleFactor || 1;
  App.dipW = init.dipWidth;
  App.dipH = init.dipHeight;

  const image = new Image();
  image.onload = () => {
    App.bgImage = image;
    App.setupCanvases();

    Selection.init();
    Editor.init();
    TextBox.init();
    Toolbar.init();
    Picker.init();
    TextLayer.init();
    Editor.setBeautify(init.beautify || null);
    App.bindGlobalEvents();

    App.setHint('拖动选择区域 · Alt 放大镜 · Esc 取消');
    Selection.redraw();

    if (init.autoSelect) {
      App.rect = { ...init.autoSelect };
      App.attachSelection();
    }

    window.api.overlay.ready();
  };
  image.onerror = () => {
    window.api.overlay.cancel();
  };
  image.src = init.dataUrl;
});
