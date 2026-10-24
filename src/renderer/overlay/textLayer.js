'use strict';

/**
 * OCR 结果叠加层：把识别出的每行文字按原位置铺在原图上，
 * 文字本身透明，但可以被鼠标拖动选择，Ctrl+C 复制。
 */
(function () {
  const state = {
    el: null,
    actions: null,
    countEl: null,
    active: false,
    text: '',
  };

  function init() {
    state.el = document.getElementById('ocr-layer');
    state.actions = document.getElementById('ocr-actions');
    state.countEl = document.getElementById('ocr-count');

    document.getElementById('ocr-copy-all').addEventListener('click', () => {
      copyText(state.text);
    });
    document.getElementById('ocr-exit').addEventListener('click', () => {
      close();
      App.setHint('拖动移动 · 拖动控制点调整 · 方向键微调 · Enter 保存');
    });

    // 阻止在文字层上的按下事件冒泡到选区/编辑器
    state.el.addEventListener('pointerdown', (event) => event.stopPropagation());
    state.el.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /**
   * OCR 会把同一行拆成多个片段，这里按垂直中心合并成一行，
   * 合并后选择范围与原图的一整行对齐。
   */
  function mergeLines(lines) {
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

  /**
   * lines: [{ text, x, y, w, h }]（物理像素，相对于选区左上角）
   */
  function open(rawLines, options) {
    if (!state.el || !Array.isArray(rawLines) || !rawLines.length) return false;
    const lines = mergeLines(rawLines);

    const originX = (options && options.originX) || 0;
    const originY = (options && options.originY) || 0;
    const scaleX = (options && options.scaleX) || 1;
    const scaleY = (options && options.scaleY) || 1;

    state.el.textContent = '';
    for (const line of lines) {
      const span = document.createElement('div');
      span.className = 'ocr-line';
      const left = originX + line.x / scaleX;
      const top = originY + line.y / scaleY;
      const width = Math.max(4, line.w / scaleX);
      const height = Math.max(4, line.h / scaleY);
      const fontSize = Math.max(8, Math.min(40, height * 0.82));

      span.style.left = `${left}px`;
      span.style.top = `${top}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      span.style.fontSize = `${fontSize}px`;
      span.style.lineHeight = `${height}px`;
      span.textContent = line.text;
      state.el.appendChild(span);
    }

    state.text = lines.map((line) => line.text).join('\n');
    state.countEl.textContent = `已识别 ${lines.length} 行`;
    state.actions.style.left = `${Math.max(8, originX + 8)}px`;
    state.actions.style.top = `${Math.max(8, originY - 44)}px`;
    state.actions.classList.remove('hidden');
    state.el.classList.remove('hidden');
    state.active = true;
    App.setHint('拖动选择文字 · Ctrl+C 复制 · Esc 退出识图');
    return true;
  }

  function close() {
    if (!state.el || !state.active) return;
    state.active = false;
    state.el.classList.add('hidden');
    state.actions.classList.add('hidden');
    state.el.textContent = '';
    state.text = '';
    window.getSelection().removeAllRanges();
  }

  function isActive() {
    return state.active;
  }

  function getSelectedText() {
    const selection = window.getSelection();
    return selection ? String(selection).trim() : '';
  }

  async function copyText(text) {
    const value = String(text || '').trim();
    if (!value) {
      App.toast('没有可复制的文字');
      return;
    }
    let result = null;
    try {
      result = await window.api.app.copyText(value);
    } catch (err) {
      result = { ok: false };
    }
    App.toast(result && result.ok ? '已复制文字' : '复制失败');
  }

  function copySelected() {
    const selected = getSelectedText();
    if (selected) copyText(selected);
    else App.toast('请先拖动选择文字');
  }

  window.TextLayer = { init, open, close, isActive, getSelectedText, copyAll: () => copyText(state.text), copySelected };
})();
