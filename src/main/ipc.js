'use strict';

const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const pin = require('./pin');
const recording = require('./recording');
const scrollCapture = require('./scrollCapture');
const ocr = require('./ocr');
const ocrWindow = require('./ocrWindow');

function register(deps) {
  const {
    settings,
    historyStore,
    overlay,
    shortcuts,
    historyWindow,
    settingsWindow,
    notify,
    capture,
    refreshTray,
  } = deps;

  historyStore.onChanged(() => historyWindow.send('history:changed'));

  // ---------- 截图覆盖窗 ----------
  ipcMain.handle('overlay:get-init', () => overlay.getInit());

  ipcMain.handle('overlay:ready', () => {
    overlay.ready();
    return { ok: true };
  });

  ipcMain.handle('overlay:confirm', async (event, payload) => {
    const result = await overlay.confirm(payload);
    if (result && result.ok) {
      notify('截图完成', result.actionLabel || (result.filePath ? '已保存' : '已复制'));
    } else if (result) {
      notify('截图保存失败', result.error || '未知错误');
    }
    return result;
  });

  ipcMain.handle('overlay:pin', (event, payload) => overlay.pin(payload));
  ipcMain.handle('overlay:start-gif', (event, payload) => {
    const result = overlay.startGif(payload);
    if (result && result.ok) {
      notify('开始录制 GIF', '按控制条上的「停止」或 Esc 结束');
    } else if (result) {
      notify('无法开始录制', result.error || '未知错误');
    }
    return result;
  });
  ipcMain.handle('overlay:start-scroll', (event, payload) => {
    try {
      const result = overlay.startScroll(payload);
      if (result && !result.ok) {
        notify('无法开始滚动截图', result.error || '未知错误');
      }
      return result;
    } catch (err) {
      console.error('[scroll] ipc error:', err);
      return { ok: false, error: err.message || '滚动截图启动失败' };
    }
  });

  ipcMain.on('overlay:cancel', () => overlay.cancel());

  // ---------- GIF 录制 ----------
  ipcMain.handle('recorder:get-init', (event) => recording.getInit(event.sender));
  ipcMain.handle('recorder:cancel', () => {
    recording.close();
    return { ok: true };
  });
  ipcMain.handle('recorder:finish', async (event, payload) => {
    const result = await recording.saveGif(payload);
    if (result && result.ok) {
      notify(
        'GIF 已保存',
        result.copied
          ? `${result.frames} 帧 · 已复制到剪贴板，按 F3 可贴图`
          : `${result.frames} 帧 · ${result.filePath}`
      );
    } else if (result) {
      notify('GIF 保存失败', result.error || '未知错误');
    }
    return result;
  });

  // ---------- 滚动截图 ----------
  ipcMain.handle('scroll:stop', () => scrollCapture.abort());

  // ---------- OCR 文字识别 ----------
  // 截图/贴图界面拿到行坐标后直接在原图上叠加文字层，因此这里不打开结果窗口
  ipcMain.handle('ocr:recognize', async (event, dataUrl) => ocr.recognizeDataUrl(dataUrl));
  ipcMain.handle('ocr:get-init', () => ocrWindow.getInit());
  ipcMain.handle('ocr:close', () => ocrWindow.close());

  ipcMain.handle('history:ocr', async (event, id) => {
    const entry = historyStore.find(id);
    if (!entry) return { ok: false, error: '记录不存在' };
    if (entry.type === 'gif') return { ok: false, error: 'GIF 记录暂不支持识图' };
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      return { ok: false, error: '原图已被移动或删除' };
    }
    const result = await ocr.recognizeFile(entry.filePath);
    if (result && result.ok) {
      ocrWindow.show({ text: result.text, language: result.language, source: '历史截图' });
    }
    return result;
  });

  // ---------- 历史记录 ----------
  ipcMain.handle('history:hide', () => {
    historyWindow.hide();
    return { ok: true };
  });
  ipcMain.handle('history:list', () => historyStore.list());
  ipcMain.handle('history:copy', (event, id) => historyStore.copy(id));
  ipcMain.handle('history:pin', (event, id) => {
    const entry = historyStore.find(id);
    if (!entry) return { ok: false, error: '记录不存在' };
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      return { ok: false, error: '原图已被移动或删除' };
    }
    if (entry.type === 'gif') {
      return pin.pinGifFile(entry.filePath, entry.width, entry.height, entry.region);
    }
    return pin.pinFromFile(entry.filePath);
  });
  ipcMain.handle('history:remove', (event, id) => historyStore.remove(id));
  ipcMain.handle('history:set-favorite', (event, payload) => {
    const id = payload && payload.id;
    if (typeof id !== 'string') return { ok: false, error: '参数无效' };
    return historyStore.setFavorite(id, !!(payload && payload.favorite));
  });
  ipcMain.handle('history:reveal', (event, id) => historyStore.reveal(id));

  // ---------- 贴图窗口 ----------
  ipcMain.handle('pin:get-init', (event) => pin.getInit(event.sender));
  ipcMain.handle('pin:copy', (event) => pin.copyFromWindow(event.sender));
  ipcMain.handle('pin:ocr', async (event) => {
    const result = await pin.ocrFromWindow(event.sender);
    if (result && result.ok) {
      notify('文字识别完成', '结果已在识别窗口中显示');
    } else if (result) {
      notify('文字识别失败', result.error || '未知错误');
    }
    return result;
  });
  ipcMain.handle('pin:close', (event) => pin.closeWindow(event.sender));
  ipcMain.handle('pin:begin-drag', (event) => pin.beginDrag(event.sender));
  ipcMain.handle('pin:move', (event, payload) => {
    const x = Number(payload && payload.x);
    const y = Number(payload && payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
    return pin.moveWindow(event.sender, x, y);
  });
  ipcMain.handle('pin:zoom', (event, factor) => pin.zoomWindow(event.sender, factor));
  ipcMain.handle('pin:rotate', (event) => pin.rotateWindow(event.sender));
  ipcMain.handle('pin:toggle-thumbnail', (event) => pin.toggleThumbnail(event.sender));
  ipcMain.handle('pin:set-opacity', (event, opacity) => pin.setOpacity(event.sender, opacity));
  ipcMain.handle('pin:set-mouse-through', (event, ignore) =>
    pin.setMouseThrough(event.sender, ignore)
  );
  ipcMain.handle('pin:from-clipboard', () => pin.fromClipboard());

  // ---------- 设置 ----------
  ipcMain.handle('settings:get', () => ({
    settings: settings.get(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('settings:save', (event, patch) => {
    const current = settings.get();
    const incoming = patch && typeof patch === 'object' ? patch : {};
    const incomingShortcuts =
      incoming.shortcuts && typeof incoming.shortcuts === 'object' ? incoming.shortcuts : {};

    const candidate = {
      shortcuts: {
        capture:
          typeof incomingShortcuts.capture === 'string'
            ? incomingShortcuts.capture.trim()
            : current.shortcuts.capture,
        pinClipboard:
          typeof incomingShortcuts.pinClipboard === 'string'
            ? incomingShortcuts.pinClipboard.trim()
            : current.shortcuts.pinClipboard,
        history:
          typeof incomingShortcuts.history === 'string'
            ? incomingShortcuts.history.trim()
            : current.shortcuts.history,
        historyDir:
          typeof incomingShortcuts.historyDir === 'string'
            ? incomingShortcuts.historyDir.trim()
            : current.shortcuts.historyDir,
      },
      saveDir: typeof incoming.saveDir === 'string' ? incoming.saveDir.trim() : current.saveDir,
      autoStart: typeof incoming.autoStart === 'boolean' ? incoming.autoStart : current.autoStart,
      historyLimit: Number.isFinite(incoming.historyLimit)
        ? incoming.historyLimit
        : current.historyLimit,
      historyOnTop:
        typeof incoming.historyOnTop === 'boolean' ? incoming.historyOnTop : current.historyOnTop,
      captureDelay: Number.isFinite(incoming.captureDelay)
        ? incoming.captureDelay
        : current.captureDelay,
      afterCapture:
        typeof incoming.afterCapture === 'string' ? incoming.afterCapture : current.afterCapture,
      imageFormat:
        typeof incoming.imageFormat === 'string' ? incoming.imageFormat : current.imageFormat,
      imageQuality: Number.isFinite(incoming.imageQuality)
        ? incoming.imageQuality
        : current.imageQuality,
      fileNameTemplate:
        typeof incoming.fileNameTemplate === 'string'
          ? incoming.fileNameTemplate
          : current.fileNameTemplate,
      scrollNotches: Number.isFinite(incoming.scrollNotches)
        ? incoming.scrollNotches
        : current.scrollNotches,
      scrollDelayMs: Number.isFinite(incoming.scrollDelayMs)
        ? incoming.scrollDelayMs
        : current.scrollDelayMs,
      beautify:
        incoming.beautify && typeof incoming.beautify === 'object'
          ? settings.normalizeBeautify(incoming.beautify, current.beautify)
          : current.beautify,
    };

    const values = Object.values(candidate.shortcuts).filter(Boolean);
    if (new Set(values).size !== values.length) {
      return { ok: false, error: '不同功能的快捷键不能相同' };
    }

    // 仅在快捷键变化时重新注册，避免修改保存目录等设置时受快捷键占用影响
    const shortcutsChanged =
      JSON.stringify(candidate.shortcuts) !== JSON.stringify(current.shortcuts);
    if (shortcutsChanged) {
      const registration = shortcuts.applyAll(candidate.shortcuts);
      if (!registration.ok) {
        return { ok: false, error: registration.error };
      }
    }

    const saved = settings.save(candidate);

    // 调低上限后立即清理多余的历史记录
    historyStore.applyLimit();

    if (app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!saved.autoStart });
      } catch (err) {
        console.error('[ipc] 设置开机自启失败:', err);
      }
    }

    historyWindow.applySettings();
    if (refreshTray) refreshTray();
    return { ok: true, settings: saved };
  });

  ipcMain.handle('shortcuts:set', (event, payload) => {
    const name = payload && payload.name;
    if (
      name !== 'capture' &&
      name !== 'history' &&
      name !== 'pinClipboard' &&
      name !== 'historyDir'
    ) {
      return { ok: false, error: '未知的快捷键名称' };
    }
    const accelerator = typeof payload.accelerator === 'string' ? payload.accelerator.trim() : '';
    const next = { ...settings.get().shortcuts, [name]: accelerator };
    const values = Object.values(next).filter(Boolean);
    if (new Set(values).size !== values.length) {
      return { ok: false, error: '不同功能的快捷键不能相同' };
    }
    const registration = shortcuts.applyAll(next);
    if (!registration.ok) {
      return { ok: false, error: registration.error };
    }
    settings.save({ shortcuts: next });
    if (refreshTray) refreshTray();
    return { ok: true };
  });

  ipcMain.handle('settings:choose-dir', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent || undefined, {
      title: '选择截图保存目录',
      defaultPath: settings.get().saveDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  // ---------- 应用 ----------
  ipcMain.handle('app:open-save-dir', async () => {
    const dir = settings.get().saveDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: err.message || '目录不存在且无法创建' };
    }
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('app:open-settings', () => {
    settingsWindow.open();
    return { ok: true };
  });

  ipcMain.handle('app:copy-text', async (event, text) => {
    if (typeof text !== 'string' || text.length > 1000) {
      return { ok: false, error: '文本无效' };
    }
    try {
      await require('electron').clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || '复制失败' };
    }
  });

  ipcMain.handle('app:capture', (event, mode) => {
    if (typeof capture === 'function') capture(mode || 'region');
    return { ok: true };
  });

  ipcMain.handle('app:overlay-state', () => overlay.debugState());
  ipcMain.handle('app:edit-image-file', (event, filePath) => overlay.openImageFile(filePath));
  ipcMain.handle('app:edit-clipboard-image', () => overlay.openClipboardImage());

  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });
}

module.exports = { register };
