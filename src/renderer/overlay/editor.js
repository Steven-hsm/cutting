'use strict';

(function () {
  const state = {
    el: null,
    wrap: null,
    ctx: null,
    rect: null,
    scaleX: 1,
    scaleY: 1,
    ops: [],
    redoStack: [],
    draft: null,
    tool: null,
    mosaicSource: null,
    temp: null,
    dragging: false,
    rafId: 0,
    drawRaf: 0,
    drawnIndex: 0,
    brushSize: 24,
    color: '#ff3b30',
    textColor: '#ff3b30',
    textSize: 18,
    shapeColor: '#ff3b30',
    shapeWidth: 3,
    blurStrength: 12,
    blurSource: null,
  };

  const MAX_OPS = 100;

  function init() {
    state.el = document.getElementById('edit-canvas');
    state.wrap = document.getElementById('edit-wrap');
    state.ctx = state.el.getContext('2d');
    state.el.addEventListener('pointerdown', onPointerDown);
    state.el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  // 右键结束当前正在绘制的图形
  function onContextMenu(event) {
    event.preventDefault();
    if (state.dragging) onPointerUp();
  }

  function setSelection(rect, options) {
    const keepOps = !!(options && options.keepOps);
    if (state.drawRaf) {
      cancelAnimationFrame(state.drawRaf);
      state.drawRaf = 0;
    }
    state.rect = { ...rect };
    if (!keepOps) {
      state.ops = [];
      state.tool = null;
    }
    state.redoStack = [];
    state.draft = null;
    state.dragging = false;
    state.drawnIndex = 0;

    state.wrap.classList.remove('hidden');
    state.wrap.style.left = `${rect.x}px`;
    state.wrap.style.top = `${rect.y}px`;
    state.wrap.style.width = `${rect.w}px`;
    state.wrap.style.height = `${rect.h}px`;

    state.el.width = Math.max(1, Math.round(rect.w * App.imageScaleX));
    state.el.height = Math.max(1, Math.round(rect.h * App.imageScaleY));
    state.el.style.width = `${rect.w}px`;
    state.el.style.height = `${rect.h}px`;

    state.scaleX = state.el.width / rect.w;
    state.scaleY = state.el.height / rect.h;

    state.temp = null;
    state.mosaicSource = Mosaic.build(
      App.bgCanvas,
      rect,
      App.imageScaleX,
      App.imageScaleY,
      state.el.width,
      state.el.height,
      12,
      state.scaleX
    );
    state.blurSource = Mosaic.buildBlur(
      App.bgCanvas,
      rect,
      App.imageScaleX,
      App.imageScaleY,
      state.el.width,
      state.el.height,
      state.blurStrength
    );

    setPointerMode();
    renderAll();
  }

  /**
   * 拖动选区时快速预览：只更新 DOM 尺寸，不重建画布内容。
   */
  function previewRect(rect) {
    if (!state.wrap || !state.rect) return;
    state.wrap.style.left = `${rect.x}px`;
    state.wrap.style.top = `${rect.y}px`;
    state.wrap.style.width = `${rect.w}px`;
    state.wrap.style.height = `${rect.h}px`;
    state.el.style.width = `${rect.w}px`;
    state.el.style.height = `${rect.h}px`;
  }

  function clear() {
    if (state.drawRaf) {
      cancelAnimationFrame(state.drawRaf);
      state.drawRaf = 0;
    }
    state.rect = null;
    state.ops = [];
    state.draft = null;
    state.tool = null;
    state.mosaicSource = null;
    state.blurSource = null;
    state.temp = null;
    state.dragging = false;
    if (state.wrap) state.wrap.classList.add('hidden');
    if (state.el) {
      state.el.width = 1;
      state.el.height = 1;
    }
  }

  function setPointerMode() {
    if (!state.wrap) return;
    state.wrap.style.pointerEvents = state.tool ? 'auto' : 'none';
    state.el.style.cursor =
      state.tool === 'text' ? 'text' : state.tool === 'mosaic' ? 'crosshair' : 'default';
  }

  function setTool(tool) {
    state.tool = tool || null;
    if (state.tool) state.draft = null;
    setPointerMode();
    if (state.tool === 'text') {
      App.setHint('点击选区输入文字（Ctrl+Enter 完成，Esc 取消）');
    } else if (state.tool === 'mosaic') {
      App.setHint('在选区上按住拖动涂抹马赛克');
    } else if (state.tool === 'rect') {
      App.setHint('在选区上拖拽绘制矩形');
    } else if (state.tool === 'arrow') {
      App.setHint('在选区上拖拽绘制箭头');
    } else if (state.tool === 'ellipse') {
      App.setHint('在选区上拖拽绘制椭圆');
    } else if (state.tool === 'line') {
      App.setHint('在选区上拖拽绘制直线');
    } else if (state.tool === 'pen') {
      App.setHint('按住拖动自由绘制');
    } else if (state.tool === 'highlight') {
      App.setHint('按住拖动涂抹荧光标记');
    } else if (state.tool === 'step') {
      App.setHint('点击选区放置序号（自动递增）');
    } else if (state.tool === 'blur') {
      App.setHint('拖拽框选需要高斯模糊的区域');
    } else if (App.state === 'selected') {
      App.setHint('可用工具编辑 · Enter 保存 · Esc 重选');
    }
  }

  function getTool() {
    return state.tool;
  }

  function setBrushSize(size) {
    const value = Number(size);
    if (Number.isFinite(value)) state.brushSize = Math.min(80, Math.max(6, value));
  }

  function getBrushSize() {
    return state.brushSize;
  }

  // 文字与图形共用一个当前颜色，切换工具时保持一致
  function setColor(color) {
    if (typeof color !== 'string') return;
    state.color = color;
    state.textColor = color;
    state.shapeColor = color;
  }

  function getColor() {
    return state.color;
  }

  function setTextColor(color) {
    setColor(color);
  }

  function setTextSize(size) {
    const value = Number(size);
    if (Number.isFinite(value)) state.textSize = Math.min(48, Math.max(12, value));
  }

  function getTextStyle() {
    return {
      color: state.textColor,
      fontSize: state.textSize,
      lineHeight: Math.round(state.textSize * 1.4),
    };
  }

  function setShapeColor(color) {
    setColor(color);
  }

  /**
   * 滚轮 / 方括号调整当前工具的粗细或字号，返回用于提示的说明。
   */
  function adjustWidth(direction) {
    const step = direction > 0 ? 1 : -1;
    const tool = state.tool;
    if (!tool) return null;

    if (tool === 'mosaic') {
      state.brushSize = Math.min(80, Math.max(6, state.brushSize + step * 4));
      return `笔刷 ${state.brushSize}`;
    }
    if (tool === 'blur') {
      state.blurStrength = Math.min(40, Math.max(2, state.blurStrength + step * 3));
      if (state.rect) {
        state.blurSource = Mosaic.buildBlur(
          App.bgCanvas,
          state.rect,
          App.imageScaleX,
          App.imageScaleY,
          state.el.width,
          state.el.height,
          state.blurStrength
        );
        renderAll();
      }
      return `模糊强度 ${state.blurStrength}`;
    }
    if (tool === 'text') {
      state.textSize = Math.min(48, Math.max(12, state.textSize + step * 2));
      return `字号 ${state.textSize}`;
    }
    state.shapeWidth = Math.min(12, Math.max(1, state.shapeWidth + step));
    return `粗细 ${state.shapeWidth}`;
  }

  function setShapeWidth(width) {
    const value = Number(width);
    if (Number.isFinite(value)) state.shapeWidth = Math.min(12, Math.max(1, value));
  }

  function getShapeStyle() {
    return { color: state.shapeColor, lineWidth: state.shapeWidth };
  }

  function setBlurStrength(strength) {
    const value = Number(strength);
    if (!Number.isFinite(value)) return;
    state.blurStrength = Math.min(40, Math.max(2, value));
    if (state.rect) {
      state.blurSource = Mosaic.buildBlur(
        App.bgCanvas,
        state.rect,
        App.imageScaleX,
        App.imageScaleY,
        state.el.width,
        state.el.height,
        state.blurStrength
      );
      renderAll();
    }
  }

  function getBlurStrength() {
    return state.blurStrength;
  }

  function nextStepIndex() {
    return state.ops.filter((op) => op.type === 'step').length + 1;
  }

  // 供诊断/测试查看当前操作列表摘要
  function getOpsSummary() {
    return state.ops.map((op) => ({
      type: op.type,
      index: op.index,
      points: op.points ? op.points.length : undefined,
    }));
  }

  function commitOp(op) {
    state.ops.push(op);
    if (state.ops.length > MAX_OPS) state.ops.shift();
    state.redoStack = [];
    renderAll();
    Toolbar.refresh();
  }

  function addOp(op) {
    commitOp(op);
  }

  function undo() {
    if (state.draft) {
      cancelDraft();
      renderAll();
      Toolbar.refresh();
      return;
    }
    if (!state.ops.length) return;
    state.redoStack.push(state.ops.pop());
    renderAll();
    Toolbar.refresh();
  }

  function redo() {
    if (state.draft || !state.redoStack.length) return;
    state.ops.push(state.redoStack.pop());
    renderAll();
    Toolbar.refresh();
  }

  function canUndo() {
    return !!state.draft || state.ops.length > 0;
  }

  function canRedo() {
    return !state.draft && state.redoStack.length > 0;
  }

  function cancelDraft() {
    state.draft = null;
    state.dragging = false;
    if (state.drawRaf) {
      cancelAnimationFrame(state.drawRaf);
      state.drawRaf = 0;
    }
  }

  function toLocal(event) {
    const x = Math.min(Math.max(event.clientX - state.rect.x, 0), state.rect.w);
    const y = Math.min(Math.max(event.clientY - state.rect.y, 0), state.rect.h);
    return { x, y };
  }

  function onPointerDown(event) {
    if (!state.tool || !state.rect || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const point = toLocal(event);

    if (state.tool === 'text') {
      TextBox.openAt(point.x, point.y);
      return;
    }

    if (state.tool === 'mosaic') {
      state.dragging = true;
      state.draft = { type: 'mosaic', points: [point], size: state.brushSize };
      state.drawnIndex = 0;
      scheduleRender();
      try {
        state.el.setPointerCapture(event.pointerId);
      } catch (err) {
        // ignore
      }
      return;
    }

    if (state.tool === 'step') {
      commitOp({
        type: 'step',
        x: point.x,
        y: point.y,
        index: nextStepIndex(),
        color: state.shapeColor,
        radius: 13,
      });
      return;
    }

    if (state.tool === 'pen' || state.tool === 'highlight') {
      state.dragging = true;
      const highlight = state.tool === 'highlight';
      state.draft = {
        type: 'pen',
        points: [point],
        color: state.shapeColor,
        lineWidth: highlight ? state.shapeWidth * 8 : state.shapeWidth * 2,
        alpha: highlight ? 0.35 : 1,
      };
      state.drawnIndex = 0;
      scheduleRender();
      try {
        state.el.setPointerCapture(event.pointerId);
      } catch (err) {
        // ignore
      }
      return;
    }

    if (
      state.tool === 'rect' ||
      state.tool === 'arrow' ||
      state.tool === 'ellipse' ||
      state.tool === 'line' ||
      state.tool === 'blur'
    ) {
      state.dragging = true;
      state.draft = {
        type: state.tool,
        start: point,
        end: point,
        color: state.shapeColor,
        lineWidth: state.shapeWidth,
        strength: state.blurStrength,
      };
      scheduleRender();
      try {
        state.el.setPointerCapture(event.pointerId);
      } catch (err) {
        // ignore
      }
    }
  }

  function onPointerMove(event) {
    if (!state.dragging || !state.draft) return;
    const point = toLocal(event);
    const draft = state.draft;

    if (draft.type !== 'mosaic' && draft.type !== 'pen') {
      draft.end = point;
      scheduleRender();
      return;
    }

    // 按住 Shift 时画笔/荧光笔只画直线（水平、垂直或 45°）
    if (draft.type === 'pen' && event.shiftKey) {
      const start = draft.points[0];
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      draft.points = [
        start,
        { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length },
      ];
      state.drawnIndex = 0;
      renderAll();
      return;
    }

    const points = draft.points;
    const last = points[points.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy < 1.5) return;
    points.push(point);
    scheduleDraftDraw();
  }

  // 高频 pointermove 合并到每一帧绘制一次，只增量绘制尚未绘制的点
  function scheduleDraftDraw() {
    if (state.drawRaf) return;
    state.drawRaf = requestAnimationFrame(() => {
      state.drawRaf = 0;
      const draft = state.draft;
      if (!draft || !draft.points) return;
      const end = draft.points.length - 1;
      if (end <= state.drawnIndex) return;
      if (draft.type === 'mosaic') {
        drawMosaicSegment(draft, end, state.drawnIndex);
      } else if (draft.type === 'pen') {
        drawPenSegment(draft, end, state.drawnIndex);
      }
      state.drawnIndex = end;
    });
  }

  function drawPenSegment(op, toIndex, fromIndex) {
    const ctx = state.ctx;
    const start = Math.max(0, fromIndex === undefined ? 0 : fromIndex);
    const end = Math.min(op.points.length - 1, toIndex);
    if (end < start) return;

    ctx.save();
    ctx.globalAlpha = op.alpha === undefined ? 1 : op.alpha;
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.fillStyle = op.color || '#ff3b30';
    ctx.lineWidth = op.lineWidth || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (start === end) {
      ctx.beginPath();
      ctx.arc(op.points[start].x, op.points[start].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(op.points[start].x, op.points[start].y);
      for (let i = start + 1; i <= end; i += 1) {
        ctx.lineTo(op.points[i].x, op.points[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function onPointerUp() {
    if (!state.dragging) return;
    state.dragging = false;
    if (state.drawRaf) {
      cancelAnimationFrame(state.drawRaf);
      state.drawRaf = 0;
    }

    const draft = state.draft;
    let commit = false;
    if (draft) {
      if (draft.type === 'mosaic' || draft.type === 'pen') {
        commit = draft.points.length > 0;
      } else if (
        draft.type === 'rect' ||
        draft.type === 'ellipse' ||
        draft.type === 'blur'
      ) {
        commit =
          Math.abs(draft.end.x - draft.start.x) >= 4 && Math.abs(draft.end.y - draft.start.y) >= 4;
      } else if (draft.type === 'arrow' || draft.type === 'line') {
        const dx = draft.end.x - draft.start.x;
        const dy = draft.end.y - draft.start.y;
        commit = dx * dx + dy * dy >= 16;
      }
    }

    state.draft = null;
    if (commit) {
      commitOp(draft);
      return;
    }
    // 以完整重放校准，保证落笔结果与撤销/重放一致
    renderAll();
    Toolbar.refresh();
  }

  function scheduleRender() {
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      renderAll();
    });
  }

  function renderAll() {
    if (!state.ctx || !state.rect) return;
    const { ctx, el } = state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.setTransform(state.scaleX, 0, 0, state.scaleY, 0, 0);
    for (const op of state.ops) drawOp(op);
    if (state.draft) drawOp(state.draft);
  }

  function drawOp(op) {
    if (op.type === 'text') drawText(op);
    else if (op.type === 'mosaic') drawMosaic(op);
    else if (op.type === 'rect') drawRect(op);
    else if (op.type === 'arrow') drawArrow(op);
    else if (op.type === 'ellipse') drawEllipse(op);
    else if (op.type === 'line') drawLine(op);
    else if (op.type === 'pen') drawPenSegment(op, op.points.length - 1, 0);
    else if (op.type === 'step') drawStep(op);
    else if (op.type === 'blur') drawBlur(op);
  }

  function drawEllipse(op) {
    const ctx = state.ctx;
    const rx = Math.abs(op.end.x - op.start.x) / 2;
    const ry = Math.abs(op.end.y - op.start.y) / 2;
    if (rx < 1 || ry < 1) return;
    const cx = Math.min(op.start.x, op.end.x) + rx;
    const cy = Math.min(op.start.y, op.end.y) + ry;

    ctx.save();
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.lineWidth = op.lineWidth || 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawLine(op) {
    const ctx = state.ctx;
    const dx = op.end.x - op.start.x;
    const dy = op.end.y - op.start.y;
    if (dx * dx + dy * dy < 2) return;

    ctx.save();
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.lineWidth = op.lineWidth || 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(op.start.x, op.start.y);
    ctx.lineTo(op.end.x, op.end.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawStep(op) {
    const ctx = state.ctx;
    const radius = op.radius || 13;

    ctx.save();
    ctx.fillStyle = op.color || '#ff3b30';
    ctx.beginPath();
    ctx.arc(op.x, op.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(radius * 1.1)}px "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(op.index), op.x, op.y + 0.5);
    ctx.restore();
  }

  function drawBlur(op) {
    if (!state.blurSource) return;
    const x = Math.min(op.start.x, op.end.x);
    const y = Math.min(op.start.y, op.end.y);
    const w = Math.abs(op.end.x - op.start.x);
    const h = Math.abs(op.end.y - op.start.y);
    if (w < 1 || h < 1) return;

    const ctx = state.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(state.blurSource, 0, 0, state.rect.w, state.rect.h);
    ctx.restore();
  }

  function drawRect(op) {
    const ctx = state.ctx;
    const x = Math.min(op.start.x, op.end.x);
    const y = Math.min(op.start.y, op.end.y);
    const w = Math.abs(op.end.x - op.start.x);
    const h = Math.abs(op.end.y - op.start.y);
    if (w < 1 || h < 1) return;

    ctx.save();
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.lineWidth = op.lineWidth || 3;
    ctx.lineJoin = 'round';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawArrow(op) {
    const ctx = state.ctx;
    const x1 = op.start.x;
    const y1 = op.start.y;
    const x2 = op.end.x;
    const y2 = op.end.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 2) return;

    const lineWidth = op.lineWidth || 3;
    const headLength = Math.max(10, lineWidth * 4.5);
    const headAngle = Math.PI / 7;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.fillStyle = op.color || '#ff3b30';
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 箭杆（略微回缩，避免线帽顶出箭头尖端）
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(angle) * headLength * 0.6, y2 - Math.sin(angle) * headLength * 0.6);
    ctx.stroke();

    // 实心箭头
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - Math.cos(angle - headAngle) * headLength,
      y2 - Math.sin(angle - headAngle) * headLength
    );
    ctx.lineTo(
      x2 - Math.cos(angle + headAngle) * headLength,
      y2 - Math.sin(angle + headAngle) * headLength
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawText(op) {
    const ctx = state.ctx;
    const size = op.fontSize || 18;
    const lineHeight = op.lineHeight || Math.round(size * 1.4);
    ctx.save();
    ctx.font = `${size}px "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillStyle = op.color || '#ff3b30';

    const lines = String(op.text).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line) return;
      const y = op.y + index * lineHeight;
      ctx.strokeText(line, op.x, y);
      ctx.fillText(line, op.x, y);
    });
    ctx.restore();
  }

  // 复用一个与编辑画布同尺寸的临时画布，避免每个笔画都分配大块内存
  function getTemp() {
    const { el } = state;
    if (!state.temp || state.temp.width !== el.width || state.temp.height !== el.height) {
      state.temp = Mosaic.makeCanvas(el.width, el.height);
    }
    return state.temp;
  }

  function mosaicStroke(tmpCtx, op, start, end, offsetX, offsetY) {
    const { el, rect } = state;
    const sx = el.width / rect.w;
    const sy = el.height / rect.h;
    const lineWidth = Math.max(2, (op.size || 24) * sx);

    tmpCtx.lineWidth = lineWidth;
    tmpCtx.lineCap = 'round';
    tmpCtx.lineJoin = 'round';
    tmpCtx.strokeStyle = '#000';
    tmpCtx.fillStyle = '#000';

    if (start === end) {
      const p = op.points[start];
      tmpCtx.beginPath();
      tmpCtx.arc(p.x * sx - offsetX, p.y * sy - offsetY, lineWidth / 2, 0, Math.PI * 2);
      tmpCtx.fill();
      return;
    }

    tmpCtx.beginPath();
    tmpCtx.moveTo(op.points[start].x * sx - offsetX, op.points[start].y * sy - offsetY);
    for (let i = start + 1; i <= end; i += 1) {
      tmpCtx.lineTo(op.points[i].x * sx - offsetX, op.points[i].y * sy - offsetY);
    }
    tmpCtx.stroke();
  }

  function drawMosaic(op) {
    const source = state.mosaicSource;
    if (!source || !op.points.length) return;
    drawMosaicSegment(op, op.points.length - 1, 0);
  }

  /**
   * 将马赛克笔刷的 [fromIndex, toIndex] 段绘制到编辑画布。
   * 只重绘该线段的包围盒，因此拖动增量绘制与大选区重放的代价都很低。
   */
  function drawMosaicSegment(op, toIndex, fromIndex) {
    const source = state.mosaicSource;
    if (!source || !op.points.length) return;

    const { ctx, el, rect } = state;
    const sx = el.width / rect.w;
    const sy = el.height / rect.h;
    const lineWidth = Math.max(2, (op.size || 24) * sx);
    const pad = lineWidth / 2 + 2;

    const start = Math.max(0, fromIndex === undefined ? 0 : fromIndex);
    const end = Math.min(op.points.length - 1, toIndex);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = start; i <= end; i += 1) {
      const p = op.points[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const bx = Math.max(0, Math.floor(minX * sx - pad));
    const by = Math.max(0, Math.floor(minY * sy - pad));
    const bw = Math.min(el.width - bx, Math.ceil(maxX * sx + pad) - bx);
    const bh = Math.min(el.height - by, Math.ceil(maxY * sy + pad) - by);
    if (bw <= 0 || bh <= 0) return;

    const tmp = getTemp();
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    tmpCtx.globalCompositeOperation = 'source-over';
    tmpCtx.clearRect(0, 0, bw, bh);
    tmpCtx.drawImage(source, bx, by, bw, bh, 0, 0, bw, bh);
    tmpCtx.globalCompositeOperation = 'destination-in';

    mosaicStroke(tmpCtx, op, start, end, bx, by);

    tmpCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0, bw, bh, bx / sx, by / sy, bw / sx, bh / sy);
  }

  function exportCanvas() {
    if (!state.rect || !state.ctx) return null;
    const out = Mosaic.makeCanvas(state.el.width, state.el.height);
    const outCtx = out.getContext('2d');
    // 背景画布坐标 = DIP × imageScale（与 setupCanvases 的绘制保持一致）
    const sx = state.rect.x * App.imageScaleX;
    const sy = state.rect.y * App.imageScaleY;
    const sw = state.rect.w * App.imageScaleX;
    const sh = state.rect.h * App.imageScaleY;
    outCtx.drawImage(App.bgCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    outCtx.drawImage(state.el, 0, 0);
    return out;
  }

  // 美化配置由主进程传入，保存/复制时应用（贴图与 OCR 保持原图）
  let beautifyOptions = null;

  function setBeautify(options) {
    beautifyOptions = options || null;
  }

  function beautified() {
    const raw = exportCanvas();
    if (!raw || !beautifyOptions) return raw;
    try {
      return Beautify.apply(raw, beautifyOptions, App.imageScaleX || 1);
    } catch (err) {
      console.error('[editor] 美化失败，使用原图:', err);
      return raw;
    }
  }

  function exportDataUrl() {
    const out = beautified();
    return out ? out.toDataURL('image/png') : null;
  }

  function exportEncoded(format, quality) {
    const out = beautified();
    if (!out) return null;
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    // JPEG 不支持透明：透明背景时铺白底
    let target = out;
    if (mime === 'image/jpeg' && beautifyOptions && beautifyOptions.background === 'transparent') {
      target = Mosaic.makeCanvas(out.width, out.height);
      const ctx = target.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(out, 0, 0);
    }
    const q = mime === 'image/png' ? undefined : Math.min(1, Math.max(0.3, (Number(quality) || 90) / 100));
    return target.toDataURL(mime, q);
  }

  window.Editor = {
    init,
    setSelection,
    previewRect,
    clear,
    setTool,
    getTool,
    setBrushSize,
    getBrushSize,
    setColor,
    getColor,
    setTextColor,
    setTextSize,
    getTextStyle,
    setShapeColor,
    setShapeWidth,
    getShapeStyle,
    adjustWidth,
    setBlurStrength,
    getBlurStrength,
    getOpsSummary,
    addOp,
    undo,
    redo,
    canUndo,
    canRedo,
    setBeautify,
    exportDataUrl,
    exportEncoded,
    exportCanvas,
  };
})();
