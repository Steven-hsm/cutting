'use strict';

(function () {
  const state = {
    dragging: false,
    startX: 0,
    startY: 0,
    winX: 0,
    winY: 0,
    toastTimer: 0,
    opacity: 1,
    mouseThrough: false,
    kind: 'image',
    rotation: 0,
    flipX: 1,
    flipY: 1,
    swapped: false,
  };

  function toast(message, isError) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      state.toastTimer = 0;
    }, 1500);
  }

  const layer = { el: null, actions: null, count: null, active: false, text: '' };

  function initOcrLayer() {
    layer.el = document.getElementById('ocr-layer');
    layer.actions = document.getElementById('ocr-actions');
    layer.count = document.getElementById('ocr-count');

    document.getElementById('ocr-copy-all').addEventListener('click', copyAllText);
    document.getElementById('ocr-exit').addEventListener('click', closeOcrLayer);
    // 在文字层上按下时不触发窗口拖动
    layer.el.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  /** 把同一水平线上的 OCR 片段合并成一行 */
  function mergeOcrLines(lines) {
    const groups = [];
    for (const line of lines) {
      const centerY = line.y + line.h / 2;
      const group = groups.find(
        (item) => Math.abs(item.centerY - centerY) <= Math.max(4, line.h * 0.6)
      );
      if (group) {
        group.x = Math.min(group.x, line.x);
        group.y = Math.min(group.y, line.y);
        group.right = Math.max(group.right, line.x + line.w);
        group.bottom = Math.max(group.bottom, line.y + line.h);
        group.h = group.bottom - group.y;
        group.centerY = group.y + group.h / 2;
        group.parts.push(line);
      } else {
        groups.push({
          x: line.x,
          y: line.y,
          h: line.h,
          centerY,
          right: line.x + line.w,
          bottom: line.y + line.h,
          parts: [line],
        });
      }
    }
    return groups.map((group) => {
      group.parts.sort((a, b) => a.x - b.x);
      return {
        text: group.parts.map((part) => part.text).join(' '),
        x: group.x,
        y: group.y,
        w: group.right - group.x,
        h: group.bottom - group.y,
      };
    });
  }

  /** 把 OCR 行坐标（原图像素）映射到窗口坐标，并沿用图片的旋转/翻转 */
  function openOcrLayer(rawLines) {
    const lines = mergeOcrLines(rawLines);
    const image = document.getElementById('image');
    const scaleX = (image.naturalWidth || innerWidth) / Math.max(1, innerWidth);
    const scaleY = (image.naturalHeight || innerHeight) / Math.max(1, innerHeight);

    layer.el.textContent = '';
    for (const line of lines) {
      const span = document.createElement('div');
      span.className = 'ocr-line';
      const width = Math.max(4, line.w / scaleX);
      const height = Math.max(4, line.h / scaleY);
      span.style.left = `${line.x / scaleX}px`;
      span.style.top = `${line.y / scaleY}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      span.style.fontSize = `${Math.max(7, Math.min(36, height * 0.82))}px`;
      span.style.lineHeight = `${height}px`;
      span.textContent = line.text;
      layer.el.appendChild(span);
    }

    layer.text = lines.map((line) => line.text).join('\n');
    layer.count.textContent = `已识别 ${lines.length} 行`;
    layer.el.style.transform = image.style.transform;
    layer.el.classList.remove('hidden');
    layer.actions.classList.remove('hidden');
    layer.active = true;
    toast('拖动选择文字 · Ctrl+C 复制');
  }

  function closeOcrLayer() {
    if (!layer.active) return;
    layer.active = false;
    layer.el.classList.add('hidden');
    layer.actions.classList.add('hidden');
    layer.el.textContent = '';
    layer.text = '';
    window.getSelection().removeAllRanges();
  }

  async function copyAllText() {
    if (!layer.text.trim()) {
      toast('没有可复制的文字', true);
      return;
    }
    try {
      const result = await window.api.app.copyText(layer.text);
      toast(result && result.ok ? '已复制全部文字' : '复制失败', !(result && result.ok));
    } catch (err) {
      toast('复制失败', true);
    }
  }

  async function recognize() {
    if (state.kind !== 'image') {
      toast('仅支持识别图片贴图', true);
      return;
    }

    toast('正在识别文字…');
    let result = null;
    try {
      result = await window.api.pin.ocr();
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : '识别失败' };
    }
    if (result && result.ok) {
      if (result.lines && result.lines.length) openOcrLayer(result.lines);
      else toast('未识别到文字', true);
    } else {
      toast((result && result.error) || '识别失败', true);
    }
  }

  async function copy() {
    let result = null;
    try {
      result = await window.api.pin.copy();
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : '复制失败' };
    }
    if (result && result.ok) {
      if (state.kind === 'image') toast('已复制图片');
      else if (state.kind === 'gif') toast('已复制 GIF 文件');
      else toast('已复制内容');
    } else {
      toast((result && result.error) || '复制失败', true);
    }
  }

  function close() {
    window.api.pin.close();
  }

  function dragSurface() {
    if (state.kind === 'text') return document.getElementById('text-body');
    if (state.kind === 'color') return document.getElementById('color-body');
    return document.getElementById('image');
  }

  async function onPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest && event.target.closest('#controls')) return;
    if (event.target.closest && event.target.closest('#ocr-layer')) return;
    event.preventDefault();
    const pos = await window.api.pin.beginDrag();
    if (!pos) return;
    state.dragging = true;
    state.startX = event.screenX;
    state.startY = event.screenY;
    state.winX = pos.x;
    state.winY = pos.y;
    try {
      dragSurface().setPointerCapture(event.pointerId);
    } catch (err) {
      // ignore
    }
  }

  function onPointerMove(event) {
    if (!state.dragging) return;
    const x = state.winX + (event.screenX - state.startX);
    const y = state.winY + (event.screenY - state.startY);
    window.api.pin.move(x, y);
  }

  function onPointerUp() {
    state.dragging = false;
  }

  async function onWheel(event) {
    event.preventDefault();
    if (event.ctrlKey) {
      // Ctrl + 滚轮：调整不透明度
      const step = event.deltaY < 0 ? 0.05 : -0.05;
      const next = Math.min(1, Math.max(0.2, Math.round((state.opacity + step) * 100) / 100));
      const result = await window.api.pin.setOpacity(next);
      if (result && result.ok) {
        state.opacity = result.opacity;
        toast(`不透明度 ${Math.round(state.opacity * 100)}%`);
      }
      return;
    }

    // 滚轮：缩放
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const result = await window.api.pin.zoom(factor);
    if (result && result.ok) {
      toast(`${result.size[0]} × ${result.size[1]}`);
    }
  }

  function applyTransform() {
    const surface = dragSurface();
    if (!surface) return;
    const transform = `rotate(${state.rotation}deg) scale(${state.flipX}, ${state.flipY})`;
    surface.style.transform = transform;
    // 文字层跟随图片一起旋转/翻转，保证选字位置对齐
    if (layer.el) layer.el.style.transform = transform;
  }

  /**
   * 设置旋转角度；横竖切换时才交换窗口宽高，避免多次按键把窗口缩成一条。
   */
  async function setRotation(degrees) {
    state.rotation = ((degrees % 360) + 360) % 360;
    applyTransform();

    const needSwap = state.rotation % 180 !== 0;
    if (needSwap !== state.swapped) {
      const result = await window.api.pin.rotate();
      if (result && result.ok) {
        state.swapped = needSwap;
        await waitForSize(result.size);
        toast(`旋转 ${state.rotation}° · ${result.size[0]} × ${result.size[1]}`);
        return;
      }
    }
    toast(`旋转 ${state.rotation}°`);
  }

  function rotate90() {
    return setRotation(state.rotation + 90);
  }

  function flip(axis) {
    if (axis === 'x') state.flipX *= -1;
    else state.flipY *= -1;
    applyTransform();
    toast(axis === 'x' ? '水平翻转' : '垂直翻转');
  }

  // 等待窗口尺寸真正生效，避免紧随其后的旋转读到旧尺寸
  async function waitForSize(size) {
    if (!size) return;
    for (let i = 0; i < 20; i += 1) {
      if (innerWidth === size[0] && innerHeight === size[1]) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function toggleThumbnail() {
    const result = await window.api.pin.toggleThumbnail();
    if (result && result.ok) {
      await waitForSize(result.size);
      toast(result.thumbnail ? '缩略图模式（Shift+双击恢复）' : '已恢复原尺寸');
    }
  }

  async function toggleMouseThrough() {
    state.mouseThrough = !state.mouseThrough;
    const result = await window.api.pin.setMouseThrough(state.mouseThrough);
    if (result && result.ok) {
      toast(state.mouseThrough ? '已开启鼠标穿透（按 X 恢复）' : '已关闭鼠标穿透');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    let init = null;
    try {
      init = await window.api.pin.getInit();
    } catch (err) {
      init = null;
    }
    if (!init) {
      close();
      return;
    }

    state.kind = init.kind || 'image';
    initOcrLayer();
    const image = document.getElementById('image');
    const textBody = document.getElementById('text-body');
    const colorBody = document.getElementById('color-body');

    if (state.kind === 'text') {
      image.classList.add('hidden');
      textBody.textContent = init.text || '';
      textBody.classList.remove('hidden');
    } else if (state.kind === 'color') {
      image.classList.add('hidden');
      document.getElementById('color-swatch').style.background = init.color;
      document.getElementById('color-hex').textContent = init.color;
      colorBody.classList.remove('hidden');
    } else if (state.kind === 'gif') {
      // 直接用文件 URL，浏览器会播放 GIF 动画
      image.src = init.fileUrl;
    } else {
      image.src = init.dataUrl;
    }

    const surface = dragSurface();
    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onPointerUp);

    // 对齐 Snipaste：双击关闭，Shift+双击切换缩略图
    surface.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (event.shiftKey) toggleThumbnail();
      else close();
    });

    window.addEventListener('wheel', onWheel, { passive: false });

    // 贴图窗口内不显示普通文字选择光标行为，但仍允许复制文本
    window.addEventListener('contextmenu', (event) => {
      if (state.kind !== 'text') event.preventDefault();
    });

    document.getElementById('btn-copy').addEventListener('click', copy);
    document.getElementById('btn-ocr').addEventListener('click', recognize);
    document.getElementById('btn-close').addEventListener('click', close);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (layer.active) {
          closeOcrLayer();
          return;
        }
        close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'c') {
        // 有选中文字时复制文字，否则复制整张贴图
        const selected = String(window.getSelection()).trim();
        if (selected) {
          event.preventDefault();
          window.api.app
            .copyText(selected)
            .then((result) => toast(result && result.ok ? '已复制选中文字' : '复制失败', !(result && result.ok)))
            .catch(() => toast('复制失败', true));
          return;
        }
        event.preventDefault();
        copy();
        return;
      }
      // 识图模式下不响应旋转、穿透等快捷键，避免干扰文字选择
      if (layer.active) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key;
      if (String(key).toLowerCase() === 'x') {
        event.preventDefault();
        toggleMouseThrough();
        return;
      }
      if (String(key).toLowerCase() === 'o') {
        event.preventDefault();
        recognize();
        return;
      }
      if (key === ' ') {
        event.preventDefault();
        window.api.pin.close();
        return;
      }
      // 数字键：1-4 旋转、5 水平翻转、6 垂直翻转（与 Snipaste 一致）
      if (key === '1' || key === '2' || key === '3' || key === '4') {
        event.preventDefault();
        setRotation((Number(key) - 1) * 90);
        return;
      }
      if (String(key).toLowerCase() === 'r') {
        event.preventDefault();
        rotate90();
        return;
      }
      if (key === '5') {
        event.preventDefault();
        flip('x');
        return;
      }
      if (key === '6') {
        event.preventDefault();
        flip('y');
      }
    });
  });
})();
