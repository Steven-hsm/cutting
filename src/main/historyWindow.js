'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const settings = require('./settings');

let win = null;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function historyHtml() {
  return path.join(__dirname, '..', 'renderer', 'history', 'index.html');
}

function create() {
  win = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 560,
    minHeight: 400,
    title: '截图历史',
    show: false,
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(historyHtml());
  win.on('closed', () => {
    win = null;
  });
}

function applyTop() {
  if (!win) return;
  const onTop = !!settings.get().historyOnTop;
  win.setAlwaysOnTop(onTop, 'floating');
}

function show() {
  if (!win) create();
  applyTop();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hide() {
  if (win) win.hide();
}

function toggle() {
  if (win && win.isVisible()) hide();
  else show();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function applySettings() {
  applyTop();
}

module.exports = { show, hide, toggle, send, applySettings };
