'use strict';

const { globalShortcut } = require('electron');

let handlers = {};
let current = {};

function init(handlerMap) {
  handlers = handlerMap || {};
}

function unregister(name) {
  if (current[name]) {
    try {
      globalShortcut.unregister(current[name]);
    } catch (err) {
      // ignore
    }
    delete current[name];
  }
}

function restore(snapshot) {
  for (const name of Object.keys(current)) unregister(name);
  for (const [name, accelerator] of Object.entries(snapshot)) {
    const handler = handlers[name];
    if (!handler) continue;
    try {
      if (globalShortcut.register(accelerator, handler)) {
        current[name] = accelerator;
      }
    } catch (err) {
      // ignore
    }
  }
}

/**
 * 注册一组快捷键。
 * 先整体注销再统一注册：这样支持两个快捷键互换；任何一步失败都会回滚到之前的注册状态。
 */
function applyAll(accelerators) {
  const accels = accelerators || {};

  const seen = new Map();
  for (const name of Object.keys(handlers)) {
    const raw = accels[name];
    const accelerator = typeof raw === 'string' ? raw.trim() : '';
    if (!accelerator) continue;
    if (seen.has(accelerator)) {
      return { ok: false, error: `快捷键 ${accelerator} 重复，请为不同功能设置不同按键` };
    }
    seen.set(accelerator, name);
  }

  const snapshot = { ...current };
  for (const name of Object.keys(current)) unregister(name);

  for (const name of Object.keys(handlers)) {
    const raw = accels[name];
    const accelerator = typeof raw === 'string' ? raw.trim() : '';
    if (!accelerator) continue;

    const handler = handlers[name];
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, handler);
    } catch (err) {
      registered = false;
    }

    if (!registered) {
      restore(snapshot);
      return { ok: false, error: `无法注册 ${accelerator}（可能已被其他程序占用）` };
    }
    current[name] = accelerator;
  }

  return { ok: true };
}

function unregisterAll() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    // ignore
  }
  current = {};
}

function getRegistered() {
  return { ...current };
}

module.exports = { init, applyAll, unregisterAll, getRegistered };
