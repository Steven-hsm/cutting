'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

let win = null;
let current = null;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function create() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  win = new BrowserWindow({
    width: 520,
    height: 460,
    minWidth: 360,
    minHeight: 260,
    title: '文字识别结果',
    show: false,
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'ocr', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    win = null;
  });
}

function push() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ocr:result', current);
  }
}

function show(result) {
  current = {
    text: String(result && result.text ? result.text : ''),
    language: (result && result.language) || '',
    source: (result && result.source) || '截图',
  };

  if (!win) {
    create();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    push();
  }
  return { ok: true };
}

function getInit() {
  return current;
}

function close() {
  if (win) win.close();
  return { ok: true };
}

module.exports = { show, getInit, close };
