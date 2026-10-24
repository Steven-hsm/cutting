'use strict';

(function () {
  const TOOLS = [
    'text',
    'rect',
    'ellipse',
    'arrow',
    'line',
    'pen',
    'highlight',
    'step',
    'mosaic',
    'blur',
  ];

  // 需要显示颜色选项的工具
  const colorTools = new Set(['text', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'step']);
  const shapeTools = new Set(['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'step']);

  const state = {
    el: null,
    panel: null,
    buttons: {},
    colorGroup: null,
    segShape: null,
    segText: null,
    segBrush: null,
    segBlur: null,
    customColor: null,
  };

  function init() {
    state.el = document.getElementById('toolbar');
    state.panel = document.getElementById('style-panel');
    state.colorGroup = document.getElementById('color-group');
    state.segShape = document.getElementById('seg-shape');
    state.segText = document.getElementById('seg-text');
    state.segBrush = document.getElementById('seg-brush');
    state.segBlur = document.getElementById('seg-blur');
    state.customColor = document.getElementById('custom-color');

    for (const tool of TOOLS) {
      state.buttons[tool] = document.getElementById(`btn-${tool}`);
      state.buttons[tool].addEventListener('click', () => toggleTool(tool));
    }

    state.buttons.undo = document.getElementById('btn-undo');
    state.buttons.redo = document.getElementById('btn-redo');
    state.buttons.ocr = document.getElementById('btn-ocr');
    state.buttons.gif = document.getElementById('btn-gif');
    state.buttons.scroll = document.getElementById('btn-scroll');
    state.buttons.pin = document.getElementById('btn-pin');
    state.buttons.save = document.getElementById('btn-save');
    state.buttons.cancel = document.getElementById('btn-cancel');

    state.buttons.undo.addEventListener('click', () => Editor.undo());
    state.buttons.redo.addEventListener('click', () => Editor.redo());
    state.buttons.ocr.addEventListener('click', () => App.recognizeText());
    state.buttons.gif.addEventListener('click', () => App.startGif());
    state.buttons.scroll.addEventListener('click', () => App.startScroll());
    state.buttons.pin.addEventListener('click', () => App.pin());
    state.buttons.save.addEventListener('click', () => App.confirm());
    state.buttons.cancel.addEventListener('click', () => App.cancelAll());

    for (const swatch of state.el.querySelectorAll('#color-group [data-color]')) {
      swatch.addEventListener('click', () => applyColor(swatch.dataset.color));
    }

    state.customColor.addEventListener('input', () => applyColor(state.customColor.value));

    bindSegments(state.segShape, 'width', (value) => Editor.setShapeWidth(Number(value)));
    bindSegments(state.segText, 'font', (value) => Editor.setTextSize(Number(value)));
    bindSegments(state.segBrush, 'brush', (value) => Editor.setBrushSize(Number(value)));
    bindSegments(state.segBlur, 'blur', (value) => Editor.setBlurStrength(Number(value)));
  }

  function bindSegments(group, attr, onPick) {
    for (const button of group.querySelectorAll(`[data-${attr}]`)) {
      button.addEventListener('click', () => {
        onPick(button.dataset[attr]);
        setGroupActive(group, attr, button.dataset[attr]);
      });
    }
  }

  function setGroupActive(group, attr, value) {
    const active = group.querySelector(`[data-${attr}="${value}"]`);
    for (const button of group.querySelectorAll(`[data-${attr}]`)) {
      button.classList.toggle('active', button === active);
    }
  }

  function applyColor(color) {
    Editor.setColor(color);
    syncColor(color);
    const tool = Editor.getTool();
    if (tool && (tool === 'text' || shapeTools.has(tool))) {
      App.setHint(toolHint(tool));
    }
  }

  function syncColor(color) {
    const target = String(color || '').toLowerCase();
    let matched = false;
    for (const swatch of state.colorGroup.querySelectorAll('[data-color]')) {
      const isActive = swatch.dataset.color.toLowerCase() === target;
      swatch.classList.toggle('active', isActive);
      if (isActive) matched = true;
    }
    if (!matched) {
      state.customColor.value = target.startsWith('#') ? target : '#ff3b30';
    }
  }

  function toggleTool(tool) {
    const next = Editor.getTool() === tool ? null : tool;
    setActive(next);
    Editor.setTool(next);
    if (next) App.setHint(toolHint(next));
    Selection.redraw();
    position();
  }

  /** 供快捷键调用：激活指定工具（同工具再次触发则关闭） */
  function activate(tool) {
    if (!TOOLS.includes(tool)) return;
    toggleTool(tool);
  }

  function setActive(tool) {
    for (const name of TOOLS) {
      state.buttons[name].classList.toggle('active', tool === name);
    }

    const showStyle = !!tool;
    state.panel.classList.toggle('hidden', !showStyle);
    if (!showStyle) return;

    // 使用标注工具时收起放大镜，避免遮挡编辑区域
    if (window.Picker) Picker.hide();

    state.colorGroup.classList.toggle('hidden', !colorTools.has(tool));
    state.segShape.classList.toggle('hidden', !shapeTools.has(tool));
    state.segText.classList.toggle('hidden', tool !== 'text');
    state.segBrush.classList.toggle('hidden', tool !== 'mosaic');
    state.segBlur.classList.toggle('hidden', tool !== 'blur');

    syncColor(Editor.getColor());
    position();
  }

  function toolHint(tool) {
    switch (tool) {
      case 'text':
        return '点击选区输入文字 · Ctrl+Enter 完成 · Esc 取消';
      case 'rect':
        return '拖拽绘制矩形 · 滚轮/[ ] 调粗细 · 右键结束';
      case 'ellipse':
        return '拖拽绘制椭圆 · 滚轮/[ ] 调粗细';
      case 'arrow':
        return '拖拽绘制箭头 · Tab 切换直线';
      case 'line':
        return '拖拽绘制直线 · Tab 切换箭头';
      case 'pen':
        return '按住拖动画笔 · Shift 画直线 · 滚轮调笔宽';
      case 'highlight':
        return '按住拖动荧光笔 · Shift 画直线';
      case 'step':
        return '点击放置序号（自动递增）';
      case 'mosaic':
        return '按住拖动涂抹马赛克 · 滚轮调笔刷';
      case 'blur':
        return '拖拽框选模糊区域 · 滚轮调强度';
      default:
        return '可用工具编辑 · Enter 保存 · Esc 重选';
    }
  }

  function refresh() {
    if (state.buttons.undo) state.buttons.undo.disabled = !Editor.canUndo();
    if (state.buttons.redo) state.buttons.redo.disabled = !Editor.canRedo();
  }

  function show() {
    state.el.classList.remove('hidden');
    position();
    refresh();
  }

  function hide() {
    state.el.classList.add('hidden');
  }

  function position() {
    const rect = App.rect;
    if (!rect || !state.el) return;
    const tw = state.el.offsetWidth;
    const th = state.el.offsetHeight;
    const margin = 10;

    // 工具栏优先放在选区下方，空间不足则放上方
    let left = rect.x + rect.w - tw;
    let top = rect.y + rect.h + margin;
    if (top + th > App.dipH - margin) top = rect.y - th - margin;

    // 最后兜底：保证工具栏始终完整可见（全屏选区时尤为重要）
    left = Math.max(margin, Math.min(left, App.dipW - tw - margin));
    top = Math.max(margin, Math.min(top, App.dipH - th - margin));

    state.el.style.left = `${left}px`;
    state.el.style.top = `${top}px`;

    if (!state.panel || state.panel.classList.contains('hidden')) return;

    // 样式浮层贴近工具栏，右对齐，箭头指向工具栏
    const pw = state.panel.offsetWidth;
    const ph = state.panel.offsetHeight;
    const gap = 9;

    let pleft = left + tw - pw;
    let ptop = top - ph - gap;

    if (ptop < margin) ptop = top + th + gap;
    pleft = Math.max(margin, Math.min(pleft, App.dipW - pw - margin));
    ptop = Math.max(margin, Math.min(ptop, App.dipH - ph - margin));

    // 浮层在工具栏下方时箭头朝上，否则朝下
    const arrowTop = ptop >= top + th - 1;

    // 箭头位置跟随工具栏的水平中心
    const arrowLeft = Math.min(pw - 20, Math.max(14, left + tw / 2 - pleft - 4));
    state.panel.style.setProperty('--arrow-left', `${arrowLeft}px`);
    state.panel.classList.toggle('arrow-top', arrowTop);
    state.panel.style.left = `${pleft}px`;
    state.panel.style.top = `${ptop}px`;
  }

  window.Toolbar = {
    init,
    show,
    hide,
    position,
    refresh,
    setActive,
    activate,
    toolHint,
  };
})();
