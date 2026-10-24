'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  overlay: {
    getInit: () => invoke('overlay:get-init'),
    ready: () => invoke('overlay:ready'),
    confirm: (payload) => invoke('overlay:confirm', payload),
    pin: (payload) => invoke('overlay:pin', payload),
    startGif: (payload) => invoke('overlay:start-gif', payload),
    startScroll: (payload) => invoke('overlay:start-scroll', payload),
    cancel: () => ipcRenderer.send('overlay:cancel'),
  },
  ocr: {
    recognize: (dataUrl) => invoke('ocr:recognize', dataUrl),
    getInit: () => invoke('ocr:get-init'),
    close: () => invoke('ocr:close'),
    onResult: (callback) => {
      const listener = (event, payload) => {
        try {
          callback(payload);
        } catch (err) {
          // ignore
        }
      };
      ipcRenderer.on('ocr:result', listener);
      return () => ipcRenderer.removeListener('ocr:result', listener);
    },
  },
  recorder: {
    getInit: () => invoke('recorder:get-init'),
    finish: (payload) => invoke('recorder:finish', payload),
    cancel: () => invoke('recorder:cancel'),
  },
  scroll: {
    stop: () => invoke('scroll:stop'),
    onProgress: (callback) => {
      const listener = (event, payload) => {
        try {
          callback(payload);
        } catch (err) {
          // ignore
        }
      };
      ipcRenderer.on('scroll:progress', listener);
      return () => ipcRenderer.removeListener('scroll:progress', listener);
    },
    onDone: (callback) => {
      const listener = (event, payload) => {
        try {
          callback(payload);
        } catch (err) {
          // ignore
        }
      };
      ipcRenderer.on('scroll:done', listener);
      return () => ipcRenderer.removeListener('scroll:done', listener);
    },
  },
  pin: {
    getInit: () => invoke('pin:get-init'),
    copy: () => invoke('pin:copy'),
    ocr: () => invoke('pin:ocr'),
    close: () => invoke('pin:close'),
    beginDrag: () => invoke('pin:begin-drag'),
    move: (x, y) => invoke('pin:move', { x, y }),
    zoom: (factor) => invoke('pin:zoom', factor),
    rotate: () => invoke('pin:rotate'),
    toggleThumbnail: () => invoke('pin:toggle-thumbnail'),
    setOpacity: (opacity) => invoke('pin:set-opacity', opacity),
    setMouseThrough: (ignore) => invoke('pin:set-mouse-through', ignore),
    fromClipboard: () => invoke('pin:from-clipboard'),
  },
  history: {
    hide: () => invoke('history:hide'),
    list: () => invoke('history:list'),
    copy: (id) => invoke('history:copy', id),
    pin: (id) => invoke('history:pin', id),
    ocr: (id) => invoke('history:ocr', id),
    remove: (id) => invoke('history:remove', id),
    setFavorite: (id, favorite) => invoke('history:set-favorite', { id, favorite }),
    reveal: (id) => invoke('history:reveal', id),
    onChanged: (callback) => {
      const listener = () => {
        try {
          callback();
        } catch (err) {
          // ignore
        }
      };
      ipcRenderer.on('history:changed', listener);
      return () => ipcRenderer.removeListener('history:changed', listener);
    },
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
    chooseDir: () => invoke('settings:choose-dir'),
    setShortcut: (name, accelerator) => invoke('shortcuts:set', { name, accelerator }),
    onReload: (callback) => {
      const listener = () => {
        try {
          callback();
        } catch (err) {
          // ignore
        }
      };
      ipcRenderer.on('settings:reload', listener);
      return () => ipcRenderer.removeListener('settings:reload', listener);
    },
  },
  files: {
    getPath: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch (err) {
        return '';
      }
    },
  },
  app: {
    openSaveDir: () => invoke('app:open-save-dir'),
    openSettings: () => invoke('app:open-settings'),
    capture: (mode) => invoke('app:capture', mode),
    editImageFile: (filePath) => invoke('app:edit-image-file', filePath),
    overlayState: () => invoke('app:overlay-state'),
    editClipboardImage: () => invoke('app:edit-clipboard-image'),
    copyText: (text) => invoke('app:copy-text', text),
    quit: () => invoke('app:quit'),
  },
});
