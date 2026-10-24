'use strict';

(function () {
  const HANDLE_SIZE = 7;
  const HIT_RADIUS = 8;
  const MIN_SIZE = 10;

  const state = {
    canvas: null,
    ctx: null,
    mode: null, // 'draw' | 'move' | 'resize'
    dir: null,
    start: null,
    startRect: null,
    pendingWindow: null,
  };

  const DEFAULT_HINT = '拖动选择区域 · Alt 放大镜 · Esc 取消';

  /** 找到光标所在的最上层（面积最小）窗口，用于窗口识别 */
  function windowAt(x, y) {
    const list = (App.init && App.init.windows) || [];
    let match = null;
    for (const item of list) {
      if (x < item.x || y < item.y || x > item.x + item.w || y > item.y + item.h) continue;
      if (!match || item.w * item.h < match.w * match.h) match = item;
    }
    return match;
  }

  function init() {
    state.canvas = document.getElementById('mask-canvas');
    state.ctx = state.canvas.getContext('2d');
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    state.canvas.addEventListener('dblclick', onDoubleClick);
  }

  /**
   * 选区上双击 = 直接完成（对应设置中的“截图完成后动作”），与 Snipaste 一致。
   */
  function onDoubleClick(event) {
    if (App.state !== 'selected' || !App.rect) return;
    if (Editor.getTool() || TextBox.isOpen()) return;
    if (event.target.closest && event.target.closest('#toolbar')) return;
    if (!insideRect(event.clientX, event.clientY, App.rect)) return;
    event.preventDefault();
    App.confirm();
  }

  function clampPoint(x, y) {
    const bounds = App.boundsRect || { x: 0, y: 0, w: App.dipW, h: App.dipH };
    return {
      x: Math.min(Math.max(x, bounds.x), bounds.x + bounds.w),
      y: Math.min(Math.max(y, bounds.y), bounds.y + bounds.h),
    };
  }

  function handlePoints(rect) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return {
      nw: [rect.x, rect.y],
      n: [cx, rect.y],
      ne: [rect.x + rect.w, rect.y],
      e: [rect.x + rect.w, cy],
      se: [rect.x + rect.w, rect.y + rect.h],
      s: [cx, rect.y + rect.h],
      sw: [rect.x, rect.y + rect.h],
      w: [rect.x, cy],
    };
  }

  function handleAt(x, y) {
    const rect = App.rect;
    if (!rect) return null;
    const points = handlePoints(rect);
    for (const [dir, point] of Object.entries(points)) {
      if (Math.abs(x - point[0]) <= HIT_RADIUS && Math.abs(y - point[1]) <= HIT_RADIUS) {
        return dir;
      }
    }
    return null;
  }

  function insideRect(x, y, rect) {
    return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  function clampRect(rect) {
    const bounds = App.boundsRect || { x: 0, y: 0, w: App.dipW, h: App.dipH };
    const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.w - MIN_SIZE));
    const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.h - MIN_SIZE));
    const w = Math.max(MIN_SIZE, Math.min(rect.w, bounds.x + bounds.w - x));
    const h = Math.max(MIN_SIZE, Math.min(rect.h, bounds.y + bounds.h - y));
    return { x, y, w, h };
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest && event.target.closest('#toolbar')) return;
    if (event.target === document.getElementById('textbox')) return;
    // 文字输入框会通过 blur 自行提交，这里不打断
    if (TextBox.isOpen()) return;
    // 识图文字层激活时，让文字选择优先
    if (window.TextLayer && TextLayer.isActive()) return;
    // 正在使用编辑工具时，交给编辑画布处理
    if (Editor.getTool() && App.state === 'selected') return;

    if (App.state === 'selected' && App.rect) {
      const dir = handleAt(event.clientX, event.clientY);
      if (dir) {
        state.mode = 'resize';
        state.dir = dir;
        state.start = clampPoint(event.clientX, event.clientY);
        state.startRect = { ...App.rect };
        App.setHint('拖动控制点调整选区 · Enter 保存');
        capture(event);
        return;
      }
      if (insideRect(event.clientX, event.clientY, App.rect)) {
        state.mode = 'move';
        state.start = clampPoint(event.clientX, event.clientY);
        state.startRect = { ...App.rect };
        App.setHint('拖动移动选区 · Enter 保存');
        capture(event);
        return;
      }
      App.resetSelection();
    }

    state.mode = 'draw';
    state.start = clampPoint(event.clientX, event.clientY);
    state.pendingWindow = windowAt(event.clientX, event.clientY);
    App.hoverWindow = null;
    App.rect = { x: state.start.x, y: state.start.y, w: 0, h: 0 };
    App.setHint('');
    redraw();
    capture(event);
  }

  function capture(event) {
    try {
      state.canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // ignore
    }
  }

  function onPointerMove(event) {
    if (!state.mode) {
      updateHover(event.clientX, event.clientY);
      updateCursor(event.clientX, event.clientY);
      return;
    }

    const point = clampPoint(event.clientX, event.clientY);

    if (state.mode === 'draw') {
      App.rect = {
        x: Math.min(state.start.x, point.x),
        y: Math.min(state.start.y, point.y),
        w: Math.abs(point.x - state.start.x),
        h: Math.abs(point.y - state.start.y),
      };
    } else if (state.mode === 'move') {
      const rect = state.startRect;
      const bounds = App.boundsRect || { x: 0, y: 0, w: App.dipW, h: App.dipH };
      const x = Math.max(
        bounds.x,
        Math.min(rect.x + (point.x - state.start.x), bounds.x + bounds.w - rect.w)
      );
      const y = Math.max(
        bounds.y,
        Math.min(rect.y + (point.y - state.start.y), bounds.y + bounds.h - rect.h)
      );
      App.rect = { x, y, w: rect.w, h: rect.h };
    } else if (state.mode === 'resize') {
      App.rect = clampRect(resizeRect(state.startRect, state.dir, point));
    }

    redraw();
    App.showSizeLabel(App.rect);
    Editor.previewRect(App.rect);
    Toolbar.position();
  }

  function resizeRect(rect, dir, point) {
    const next = { ...rect };
    if (dir.includes('w')) {
      const right = rect.x + rect.w;
      next.x = Math.min(point.x, right - MIN_SIZE);
      next.w = right - next.x;
    }
    if (dir.includes('e')) {
      next.w = Math.max(MIN_SIZE, point.x - rect.x);
    }
    if (dir.includes('n')) {
      const bottom = rect.y + rect.h;
      next.y = Math.min(point.y, bottom - MIN_SIZE);
      next.h = bottom - next.y;
    }
    if (dir.includes('s')) {
      next.h = Math.max(MIN_SIZE, point.y - rect.y);
    }
    return next;
  }

  function onPointerUp() {
    if (!state.mode) return;
    const mode = state.mode;
    const pendingWindow = state.pendingWindow;
    state.mode = null;
    state.dir = null;
    state.pendingWindow = null;

    const rect = App.rect;

    // 在小窗口上轻点（几乎没拖动）→ 直接选取整个窗口
    if (mode === 'draw' && pendingWindow && rect && rect.w < 6 && rect.h < 6) {
      App.rect = {
        x: pendingWindow.x,
        y: pendingWindow.y,
        w: pendingWindow.w,
        h: pendingWindow.h,
      };
      App.hoverWindow = null;
      App.attachSelection();
      return;
    }

    if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
      if (mode === 'draw') {
        App.rect = null;
        redraw();
        App.hideSizeLabel();
        App.setHint(DEFAULT_HINT);
        App.state = 'selecting';
      }
      return;
    }

    if (mode === 'draw') {
      App.attachSelection();
    } else {
      App.adjustSelection();
    }
  }

  const CURSORS = {
    nw: 'nwse-resize',
    se: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
  };

  /** 悬停时识别窗口并高亮，提示可单击选取整窗 */
  function updateHover(x, y) {
    if (Editor.getTool() || TextBox.isOpen() || App.state === 'selected') {
      if (App.hoverWindow) {
        App.hoverWindow = null;
        redraw();
        App.setHint(DEFAULT_HINT);
      }
      return;
    }

    const match = windowAt(x, y);
    const changed =
      (!!match !== !!App.hoverWindow) ||
      (match && App.hoverWindow && (match.x !== App.hoverWindow.x || match.y !== App.hoverWindow.y));
    if (!changed) return;

    App.hoverWindow = match;
    redraw();
    if (match) {
      App.setHint(`单击选取窗口 · ${match.title || '未命名窗口'}`);
    } else {
      App.setHint(DEFAULT_HINT);
    }
  }

  function updateCursor(x, y) {
    if (!state.canvas) return;
    if (App.state !== 'selected' || !App.rect || Editor.getTool() || TextBox.isOpen()) {
      state.canvas.style.cursor = 'crosshair';
      return;
    }
    const dir = handleAt(x, y);
    if (dir) {
      state.canvas.style.cursor = CURSORS[dir];
    } else if (insideRect(x, y, App.rect)) {
      state.canvas.style.cursor = 'move';
    } else {
      state.canvas.style.cursor = 'crosshair';
    }
  }

  function redraw() {
    if (!state.ctx) return;
    const ctx = state.ctx;
    ctx.setTransform(App.maskScaleX, 0, 0, App.maskScaleY, 0, 0);
    ctx.clearRect(0, 0, App.dipW, App.dipH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, App.dipW, App.dipH);

    // 窗口识别高亮
    const hover = App.hoverWindow;
    if (hover && !Editor.getTool()) {
      ctx.fillStyle = 'rgba(47, 128, 237, 0.12)';
      ctx.fillRect(hover.x, hover.y, hover.w, hover.h);
      ctx.strokeStyle = 'rgba(47, 128, 237, 0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(hover.x + 1, hover.y + 1, Math.max(0, hover.w - 2), Math.max(0, hover.h - 2));

      // 四角加粗标记
      const len = Math.min(18, hover.w / 4, hover.h / 4);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hover.x, hover.y + len);
      ctx.lineTo(hover.x, hover.y);
      ctx.lineTo(hover.x + len, hover.y);
      ctx.moveTo(hover.x + hover.w - len, hover.y);
      ctx.lineTo(hover.x + hover.w, hover.y);
      ctx.lineTo(hover.x + hover.w, hover.y + len);
      ctx.moveTo(hover.x + hover.w, hover.y + hover.h - len);
      ctx.lineTo(hover.x + hover.w, hover.y + hover.h);
      ctx.lineTo(hover.x + hover.w - len, hover.y + hover.h);
      ctx.moveTo(hover.x + len, hover.y + hover.h);
      ctx.lineTo(hover.x, hover.y + hover.h);
      ctx.lineTo(hover.x, hover.y + hover.h - len);
      ctx.stroke();
    }

    const rect = App.rect;
    if (rect && rect.w > 0 && rect.h > 0) {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);

      ctx.strokeStyle = 'rgba(47, 128, 237, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x + 0.75, rect.y + 0.75, Math.max(0, rect.w - 1.5), Math.max(0, rect.h - 1.5));

      // 选区确定且未使用工具时显示调整控制点
      if (App.state === 'selected' && !Editor.getTool()) {
        const half = HANDLE_SIZE / 2;
        for (const point of Object.values(handlePoints(rect))) {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = 'rgba(47, 128, 237, 0.95)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.rect(point[0] - half, point[1] - half, HANDLE_SIZE, HANDLE_SIZE);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  window.Selection = { init, redraw };
})();
