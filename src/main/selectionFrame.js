'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

/**
 * 在选区「外侧」绘制一圈边框，用于 GIF 录制与滚动截图期间标示范围。
 * 边框窗口全部不覆盖录制区域，因此不会出现在截图或录屏画面里。
 * 返回一个句柄，调用 destroy() 关闭全部边框窗口。
 */
function create({ left, top, width, height, label = 'REC', tone = 'red' }) {
  const edgeSize = 40;
  const l = Math.round(left);
  const t = Math.round(top);
  const w = Math.max(20, Math.round(width));
  const h = Math.max(20, Math.round(height));

  // 每侧窗口本身保持 40px（规避 Windows 最小窗口尺寸），
  // 但只渲染与选区边长完全一致的 4px 细线，四条边首尾相接、不多伸也不外扩。
  const specs = [
    { x: l, y: t - edgeSize, width: Math.max(edgeSize, w), height: edgeSize, variant: 'top', len: w },
    { x: l, y: t + h, width: Math.max(edgeSize, w), height: edgeSize, variant: 'bottom', len: w },
    { x: l - edgeSize, y: t, width: edgeSize, height: Math.max(edgeSize, h), variant: 'left', len: h },
    { x: l + w, y: t, width: edgeSize, height: Math.max(edgeSize, h), variant: 'right', len: h },
  ];

  const wins = [];

  for (const spec of specs) {
    const win = new BrowserWindow({
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'frame', 'index.html'), {
      hash: spec.variant,
      query: { label, tone, len: String(spec.len) },
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    wins.push(win);
  }

  return {
    destroy() {
      for (const win of wins) {
        try {
          win.destroy();
        } catch (err) {
          // ignore
        }
      }
      wins.length = 0;
    },
  };
}

module.exports = { create };
