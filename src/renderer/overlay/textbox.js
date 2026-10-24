'use strict';

(function () {
  const state = { el: null, open: false, pos: null, suppressBlur: false };

  function init() {
    state.el = document.getElementById('textbox');
    state.el.addEventListener('keydown', onKeyDown);
    state.el.addEventListener('input', autoSize);
    state.el.addEventListener('blur', () => {
      if (state.suppressBlur) return;
      if (state.open) submit();
    });
  }

  function autoSize() {
    if (!state.open) return;
    state.el.style.height = 'auto';
    state.el.style.height = `${Math.max(28, state.el.scrollHeight)}px`;

    const minWidth = 220;
    const maxWidth = Math.max(
      minWidth,
      Math.min(900, App.dipW - App.rect.x - state.pos.x - 20)
    );
    state.el.style.width = `${minWidth}px`;
    const needed = state.el.scrollWidth + 10;
    state.el.style.width = `${Math.max(minWidth, Math.min(maxWidth, needed))}px`;
  }

  function openAt(x, y) {
    if (state.open) submit();
    state.open = true;
    state.pos = { x, y };
    state.el.value = '';

    // 跟随工具栏选择的文字颜色与字号
    const style = Editor.getTextStyle();
    state.el.style.color = style.color;
    state.el.style.caretColor = style.color;
    state.el.style.fontSize = `${style.fontSize}px`;
    state.el.style.lineHeight = `${style.lineHeight}px`;

    state.el.classList.remove('hidden');
    state.el.style.left = `${App.rect.x + x}px`;
    state.el.style.top = `${App.rect.y + y}px`;
    state.el.style.width = '220px';
    state.el.style.height = '28px';
    autoSize();
    setTimeout(() => state.el.focus(), 0);
  }

  function submit() {
    if (!state.open) return;
    const text = state.el.value.replace(/\r/g, '');
    const pos = state.pos;
    state.open = false;
    state.pos = null;
    state.el.classList.add('hidden');
    state.el.value = '';
    if (text.trim() && pos) {
      const style = Editor.getTextStyle();
      Editor.addOp({
        type: 'text',
        x: pos.x,
        y: pos.y,
        text,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
      });
    }
  }

  function cancel() {
    if (!state.open) return;
    state.suppressBlur = true;
    state.open = false;
    state.pos = null;
    state.el.classList.add('hidden');
    state.el.value = '';
    requestAnimationFrame(() => {
      state.suppressBlur = false;
    });
  }

  function isOpen() {
    return state.open;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    event.stopPropagation();
  }

  window.TextBox = { init, openAt, submit, cancel, isOpen };
})();
