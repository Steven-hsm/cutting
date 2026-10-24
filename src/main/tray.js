'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

let tray = null;

function fallbackIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buffer[i * 4] = 0xed; // B
    buffer[i * 4 + 1] = 0x80; // G
    buffer[i * 4 + 2] = 0x2f; // R
    buffer[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function loadIcon() {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) {
        return image.resize({ width: 16, height: 16 });
      }
    }
  } catch (err) {
    // ignore
  }
  return fallbackIcon();
}

/**
 * 托盘菜单：截图相关操作全部平铺在顶级，右侧显示对应的全局快捷键。
 * 菜单项上的 accelerator 仅用于展示（托盘菜单不会重复注册全局热键）。
 */
function buildTemplate(actions) {
  const capture = (mode) => () => actions.capture(mode);
  const accelerator = actions.acceleratorFor || (() => undefined);
  const delay = Number(actions.getDelay ? actions.getDelay() : 0) || 0;

  const template = [
    {
      label: '区域截图',
      accelerator: accelerator('capture'),
      registerAccelerator: false,
      click: capture('region'),
    },
    { label: '全屏截图', click: capture('full') },
    { label: '活动窗口', click: capture('window') },
    { label: '上次区域', click: capture('last') },
    {
      label: delay > 0 ? `延时截图（${delay} 秒）` : '延时截图',
      click: capture('delayed'),
    },
    {
      label: '贴剪贴板内容',
      accelerator: accelerator('pinClipboard'),
      registerAccelerator: false,
      click: actions.pinClipboard,
    },
    { type: 'separator' },
    {
      label: '截图历史',
      accelerator: accelerator('history'),
      registerAccelerator: false,
      click: actions.history,
    },
    {
      label: '打开历史目录',
      accelerator: accelerator('historyDir'),
      registerAccelerator: false,
      click: actions.openHistoryDir,
    },
    { label: '打开保存目录', click: actions.openSaveDir },
    { label: '设置', click: actions.settings },
  ];

  if (actions.devTools) {
    template.push({ type: 'separator' }, { label: '截图窗口调试', click: actions.devTools });
  }

  template.push({ type: 'separator' }, { label: '退出', click: actions.quit });
  return template;
}

function create(actions) {
  if (tray) return tray;

  tray = new Tray(loadIcon());
  tray.setToolTip('Cutting 截图工具');

  const menu = Menu.buildFromTemplate(buildTemplate(actions));
  tray.setContextMenu(menu);
  tray.on('double-click', actions.capture.bind(null, 'region'));

  return tray;
}

/** 设置变更后刷新菜单（快捷键/延时可能变化） */
function refresh(actions) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate(buildTemplate(actions));
  tray.setContextMenu(menu);
}

function notify(title, content) {
  if (!tray) return;
  try {
    tray.displayBalloon({ title, content });
  } catch (err) {
    // ignore
  }
}

/** 仅用于开发期截图验证：主动弹出托盘菜单 */
function popupForDebug() {
  if (tray) tray.popUpContextMenu();
}

module.exports = { create, refresh, notify, buildTemplate, popupForDebug };
