'use strict';

const { app, BrowserWindow, screen, nativeImage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { captureDisplay, captureWindow } = require('./capture');
const { findTopWindow, listWindows } = require('./win32');
const settings = require('./settings');
const historyStore = require('./historyStore');
const pinWindow = require('./pin');
const clipboardHelper = require('./clipboard');
const recording = require('./recording');
const scrollCapture = require('./scrollCapture');
const naming = require('./naming');

let win = null;
let pending = null;
let shownAt = 0;
let closing = false;
let opening = false;
let saving = false;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function overlayHtml() {
  return path.join(__dirname, '..', 'renderer', 'overlay', 'index.html');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clampRectToBounds(rect, bounds) {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.w - 10));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.h - 10));
  const w = Math.max(10, Math.min(rect.w, bounds.x + bounds.w - x));
  const h = Math.max(10, Math.min(rect.h, bounds.y + bounds.h - y));
  return { x, y, w, h };
}

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;
  if (dataUrl.length > 100 * 1024 * 1024) return null;
  try {
    return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
  } catch (err) {
    return null;
  }
}

/**
 * 抓取屏幕/窗口并创建覆盖窗。
 * mode: 'region'（默认）| 'full' | 'last' | 'window'
 */
async function open(mode = 'region') {
  if (win) {
    try {
      win.focus();
    } catch (err) {
      // ignore
    }
    return { ok: true };
  }
  // 抓屏是异步的，防止快捷键连按创建多个覆盖窗
  if (opening) return { ok: true };
  opening = true;

  try {
    return await createOverlay(mode);
  } finally {
    opening = false;
  }
}

async function createOverlay(mode) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.bounds;
  const current = settings.get();

  let image = null;
  let imageRect = { x: 0, y: 0, w: bounds.width, h: bounds.height };
  let source = 'screen';

  try {
    if (mode === 'window') {
      const info = await findTopWindow(process.pid);
      if (!info) throw new Error('未找到活动窗口');
      image = await captureWindow(info.title, { width: info.width, height: info.height });

      const size = image.getSize();
      const scale = display.scaleFactor || 1;
      let w = size.width / scale;
      let h = size.height / scale;

      // 窗口可能大于屏幕，等比缩放到 90% 以内
      const maxW = bounds.width * 0.9;
      const maxH = bounds.height * 0.9;
      const ratio = Math.min(1, maxW / w, maxH / h);
      w *= ratio;
      h *= ratio;

      imageRect = {
        x: Math.round((bounds.width - w) / 2),
        y: Math.round((bounds.height - h) / 2),
        w: Math.round(w),
        h: Math.round(h),
      };
      source = 'window';
    } else {
      image = await captureDisplay(display);
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  const size = image.getSize();
  let autoSelect = null;
  if (mode === 'full' || mode === 'window') {
    autoSelect = { ...imageRect };
  } else if (mode === 'last' && current.lastRegion) {
    if (String(current.lastRegion.displayId) === String(display.id)) {
      autoSelect = clampRectToBounds(current.lastRegion.rect, imageRect);
    } else {
      autoSelect = { ...imageRect };
    }
  }

  // 枚举可见窗口，供截图界面做窗口识别与点击选取（失败不影响截图）
  let windows = [];
  try {
    const raw = await listWindows(process.pid);
    const scale = display.scaleFactor || 1;
    windows = raw
      .map((item) => ({
        title: item.title,
        x: (item.left - bounds.x * scale) / scale,
        y: (item.top - bounds.y * scale) / scale,
        w: item.width / scale,
        h: item.height / scale,
      }))
      .filter(
        (item) =>
          item.x + item.w > 0 &&
          item.y + item.h > 0 &&
          item.x < bounds.width &&
          item.y < bounds.height &&
          item.w >= 80 &&
          item.h >= 60
      )
      .map((item) => ({
        title: item.title,
        x: Math.max(0, Math.round(item.x)),
        y: Math.max(0, Math.round(item.y)),
        w: Math.min(bounds.width, Math.round(item.w)),
        h: Math.min(bounds.height, Math.round(item.h)),
      }));
  } catch (err) {
    windows = [];
  }

  return presentOverlay({ image, display, imageRect, autoSelect, mode, source, windows });
}

/**
 * 用任意图片（剪贴板/文件）打开编辑器。
 */
function openImage(image, source) {
  if (win) {
    try {
      win.focus();
    } catch (err) {
      // ignore
    }
    return { ok: true };
  }
  if (opening) return { ok: true };

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.bounds;
  const size = image.getSize();
  const scale = display.scaleFactor || 1;

  let w = size.width / scale;
  let h = size.height / scale;
  const ratio = Math.min(1, (bounds.width * 0.9) / w, (bounds.height * 0.9) / h);
  w *= ratio;
  h *= ratio;

  const imageRect = {
    x: Math.round((bounds.width - w) / 2),
    y: Math.round((bounds.height - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };

  opening = true;
  try {
    return presentOverlay({
      image,
      display,
      imageRect,
      autoSelect: { ...imageRect },
      mode: 'image',
      source: source || 'image',
    });
  } finally {
    opening = false;
  }
}

function openImageFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: '文件路径无效' };
  }

  let image = null;
  try {
    image = nativeImage.createFromPath(filePath);
  } catch (err) {
    image = null;
  }
  if (!image || image.isEmpty()) {
    return { ok: false, error: '无法读取该图片文件' };
  }
  return openImage(image, 'file');
}

async function openClipboardImage() {
  try {
    const items = await clipboard.read();
    for (const item of items) {
      if (item.types && item.types.includes('image/png')) {
        const blob = await item.getType('image/png');
        const buffer = Buffer.from(await blob.arrayBuffer());
        const image = nativeImage.createFromBuffer(buffer);
        if (image && !image.isEmpty()) {
          return openImage(image, 'clipboard');
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err.message || '读取剪贴板失败' };
  }
  return { ok: false, error: '剪贴板中没有图片' };
}

function presentOverlay({ image, display, imageRect, autoSelect, mode, source, windows }) {
  const bounds = display.bounds;
  const current = settings.get();
  const size = image.getSize();

  pending = {
    dataUrl: image.toDataURL(),
    dipWidth: bounds.width,
    dipHeight: bounds.height,
    displayX: bounds.x,
    displayY: bounds.y,
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    imageRect,
    imageWidth: size.width,
    imageHeight: size.height,
    boundsRect: { x: 0, y: 0, w: bounds.width, h: bounds.height },
    autoSelect,
    autoAction: mode === 'gif' || mode === 'scroll' ? mode : null,
    mode,
    source,
    windows: Array.isArray(windows) ? windows : [],
    exportFormat: current.imageFormat,
    exportQuality: current.imageQuality,
    afterCapture: current.afterCapture,
    beautify: current.beautify,
  };
  closing = false;
  saving = false;

  win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);


  // 说明：不在失焦时自动取消。系统通知、其他程序抢焦点等情况会误触发，
  // 而覆盖窗本身置顶显示，用户可用 Esc 或「取消」按钮退出。

  // 注意：使用局部引用，避免旧窗口延迟触发的 closed 事件清掉新窗口状态
  const createdWin = win;
  createdWin.on('closed', () => {
    if (win === createdWin) {
      win = null;
      pending = null;
    }
  });

  win.loadFile(overlayHtml());
  return { ok: true };
}

function getInit() {
  return pending;
}

function ready() {
  if (!win) return;
  win.show();
  win.focus();
  win.setAlwaysOnTop(true, 'screen-saver');
  shownAt = Date.now();
}

function cancel() {
  if (!win) return;
  closing = true;
  const target = win;
  win = null;
  pending = null;
  try {
    target.destroy();
  } catch (err) {
    // ignore
  }
}

function close() {
  cancel();
}

/**
 * 将当前选区贴到屏幕顶层（不写文件、不写历史）。
 */
function pin(payload) {
  if (!win || !pending) return { ok: false, error: '截图窗口已关闭' };
  if (
    !payload ||
    typeof payload.dataUrl !== 'string' ||
    !payload.dataUrl.startsWith('data:image/png;base64,')
  ) {
    return { ok: false, error: '图片数据无效' };
  }
  const rect = payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return { ok: false, error: '选区数据无效' };
  }

  const data = {
    dataUrl: payload.dataUrl,
    x: pending.displayX + rect.x,
    y: pending.displayY + rect.y,
    width: rect.w,
    height: rect.h,
  };

  // 先关闭截图窗口，避免贴图窗口与截图窗口互相干扰
  close();
  return pinWindow.create(data);
}

function selectionContext() {
  if (!win || !pending) return null;
  return {
    ...pending,
    displayBounds: {
      x: pending.displayX,
      y: pending.displayY,
      width: pending.dipWidth,
      height: pending.dipHeight,
    },
  };
}

/**
 * 用当前选区开始 GIF 录制。
 */
function startGif(payload) {
  const context = selectionContext();
  if (!context) return { ok: false, error: '截图窗口已关闭' };
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return { ok: false, error: '选区数据无效' };
  }

  close();
  return recording.start({
    rect,
    displayBounds: context.displayBounds,
    displayId: context.displayId,
    displayX: context.displayX,
    displayY: context.displayY,
  });
}

/**
 * 用当前选区开始自动滚动截图。
 */
function startScroll(payload) {
  const context = selectionContext();
  if (!context) return { ok: false, error: '截图窗口已关闭' };
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return { ok: false, error: '选区数据无效' };
  }

  close();
  return scrollCapture.start({
    rect,
    displayBounds: context.displayBounds,
    displayId: context.displayId,
    displayX: context.displayX,
    displayY: context.displayY,
    scaleFactor: context.scaleFactor,
  });
}

/**
 * 保存截图：写文件 + 复制到剪贴板 + 写入历史。
 */
async function confirm(payload) {
  // 截图窗口已关闭（例如重复提交）时忽略
  if (!win) return { ok: false, error: '截图窗口已关闭' };
  // 防止回车与按钮重复触发导致保存两份
  if (saving) return { ok: false, error: '正在保存' };
  saving = true;
  try {
    return await saveScreenshot(payload);
  } finally {
    saving = false;
  }
}

function rememberLastRegion(payload) {
  if (!pending) return;
  if (payload && payload.remember === false) return;
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return;
  }
  try {
    settings.save({ lastRegion: { displayId: pending.displayId, rect } });
  } catch (err) {
    // ignore
  }
}

/**
 * 按设置执行：保存文件 / 复制剪贴板 / 贴图。
 */
async function saveScreenshot(payload) {
  if (!payload) return { ok: false, error: '图片数据无效' };

  const context = pending;
  const png = decodeDataUrl(payload.dataUrl);
  if (!png || png.mime !== 'png') {
    return { ok: false, error: '图片数据无效' };
  }

  let image = null;
  try {
    image = nativeImage.createFromDataURL(payload.dataUrl);
  } catch (err) {
    image = null;
  }
  if (!image || image.isEmpty()) {
    return { ok: false, error: '图片解析失败' };
  }

  const current = settings.get();
  const afterCapture = payload.afterCapture || current.afterCapture || 'save-copy';
  const size = image.getSize();
  const pngBuffer = image.toPNG();
  const rect = payload.dipRect;

  // 1) 贴图模式：直接贴到屏幕顶层
  if (afterCapture === 'pin') {
    if (!context) return { ok: false, error: '截图上下文已失效' };
    const data = {
      dataUrl: payload.dataUrl,
      x: context.displayX + rect.x,
      y: context.displayY + rect.y,
      width: rect.w,
      height: rect.h,
    };
    close();
    return pinWindow.create(data);
  }

  // 2) 写文件（save / save-copy）
  let filePath = '';
  if (afterCapture === 'save' || afterCapture === 'save-copy') {
    const encoded = decodeDataUrl(payload.fileDataUrl) || png;
    const format = encoded.mime === 'png' ? 'png' : encoded.mime;
    const extension = naming.formatExtension(format === 'jpeg' ? 'jpeg' : format);

    const targetDirs = [];
    if (current.saveDir) targetDirs.push(current.saveDir);
    targetDirs.push(path.join(app.getPath('userData'), 'pictures'));

    let lastError = null;
    for (const targetDir of targetDirs) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        const candidate = naming.uniquePath(
          targetDir,
          naming.buildBaseName(current.fileNameTemplate),
          extension
        );
        fs.writeFileSync(candidate, encoded.buffer);
        filePath = candidate;
        break;
      } catch (err) {
        lastError = err;
        filePath = '';
      }
    }

    if (!filePath) {
      return {
        ok: false,
        error: `无法写入保存目录：${lastError && lastError.message ? lastError.message : '未知错误'}`,
      };
    }
  }

  // 3) 复制到剪贴板（save-copy / copy）
  if (afterCapture !== 'save') {
    try {
      await clipboardHelper.writeImageBuffer(pngBuffer);
    } catch (err) {
      console.error('[overlay] 写入剪贴板失败:', err);
    }
  }

  try {
    historyStore.add({
      image,
      filePath,
      width: size.width,
      height: size.height,
      scaleFactor: Number(payload.scaleFactor) || 1,
      note: afterCapture === 'copy' ? 'clipboard-only' : '',
    });
  } catch (err) {
    console.error('[overlay] 写入历史失败:', err);
  }

  rememberLastRegion(payload);
  close();

  const actionLabel =
    afterCapture === 'save'
      ? '已保存到目录'
      : afterCapture === 'copy'
        ? '已复制到剪贴板'
        : '已保存并复制到剪贴板';
  return { ok: true, filePath, action: afterCapture, actionLabel };
}

function openDevTools() {
  if (!win) return false;
  win.webContents.openDevTools({ mode: 'detach' });
  return true;
}

function isOpen() {
  return !!win;
}

function debugState() {
  return {
    open: !!win,
    opening,
    closing,
    saving,
    mode: pending ? pending.mode : null,
    source: pending ? pending.source : null,
  };
}

module.exports = {
  open,
  close,
  cancel,
  confirm,
  pin,
  startGif,
  startScroll,
  getInit,
  ready,
  openDevTools,
  isOpen,
  openImageFile,
  openClipboardImage,
  debugState,
};
