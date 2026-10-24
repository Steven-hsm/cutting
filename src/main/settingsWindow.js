'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

let win = null;

function open() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 700,
    height: 820,
    minWidth: 620,
    minHeight: 560,
    resizable: true,
    maximizable: false,
    title: 'Cutting 设置',
    show: false,
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  // 窗口重新获得焦点时同步一次设置，避免显示过期值
  win.on('focus', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('settings:reload');
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

module.exports = { open };
