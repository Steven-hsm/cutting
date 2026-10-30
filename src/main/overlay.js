'use strict';

const { app, BrowserWindow, screen, nativeImage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { captureDisplays, captureWindow } = require('./capture');
const { findTopWindow, listWindows } = require('./win32');
const settings = require('./settings');
const historyStore = require('./historyStore');
const pinWindow = require('./pin');
const clipboardHelper = require('./clipboard');
const recording = require('./recording');
const scrollCapture = require('./scrollCapture');
const naming = require('./naming');

// 一次截图会话可能包含多个覆盖窗（每个显示器一个），这些窗口共享同一个 session
let session = null;
let shownAt = 0;
let opening = false;
let saving = false;
let windowListTimer = 0;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function overlayHtml() {
  return path.join(__dirname, '..', 'renderer', 'overlay', 'index.html');
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

function entryFor(sender) {
  if (!session || !sender) return null;
  return session.byWebContents.get(sender.id) || null;
}

/**
 * 抓取屏幕/窗口并创建覆盖窗。
 * mode: 'region'（默认）| 'full' | 'last' | 'window'
 */
async function open(mode = 'region') {
  if (session) {
    focusActiveWindow();
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

/** 将物理像素坐标换算成 DIP 坐标（兼容混合 DPI 的多显示器） */
function physicalPointToDip(x, y) {
  try {
    const point = screen.screenToDipPoint({ x: Math.round(x), y: Math.round(y) });
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
  } catch (err) {
    // 旧版本/非 Windows 平台回退到主屏缩放
  }
  const scale = (screen.getPrimaryDisplay().scaleFactor || 1);
  return { x: x / scale, y: y / scale };
}

/** 把 Win32 物理像素窗口列表拆分到各显示器的本地 DIP 坐标 */
function windowsByDisplay(raw, displays) {
  const result = new Map();
  for (const display of displays) result.set(String(display.id), []);

  for (const item of raw || []) {
    const topLeft = physicalPointToDip(item.left, item.top);
    const bottomRight = physicalPointToDip(item.left + item.width, item.top + item.height);
    const rect = {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
    if (rect.w < 40 || rect.h < 30) continue;

    for (const display of displays) {
      const b = display.bounds;
      const overlapX = Math.min(rect.x + rect.w, b.x + b.width) - Math.max(rect.x, b.x);
      const overlapY = Math.min(rect.y + rect.h, b.y + b.height) - Math.max(rect.y, b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;

      result.get(String(display.id)).push({
        title: item.title,
        x: Math.round(rect.x - b.x),
        y: Math.round(rect.y - b.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      });
    }
  }

  return result;
}

/**
 * 窗口识别需要在后台跑 PowerShell，放在覆盖窗显示之后再通知渲染进程，
 * 避免把 0.6~2 秒的枚举时间加进 F1 的响应延迟。
 */
function loadWindowList(target) {
  listWindows(process.pid)
    .then((raw) => {
      if (session !== target) return;
      const displays = target.entries.map((entry) => entry.display);
      const byDisplay = windowsByDisplay(raw, displays);
      for (const entry of target.entries) {
        if (entry.win.isDestroyed()) continue;
        entry.win.webContents.send('overlay:windows', byDisplay.get(String(entry.display.id)) || []);
      }
    })
    .catch(() => {
      // 窗口识别失败不影响截图
    });
}

function buildInit({
  dataUrl,
  display,
  imageRect,
  imageWidth,
  imageHeight,
  autoSelect,
  autoAction,
  mode,
  source,
  windows,
}) {
  const current = settings.get();
  const bounds = display.bounds;
  return {
    dataUrl,
    dipWidth: bounds.width,
    dipHeight: bounds.height,
    displayX: bounds.x,
    displayY: bounds.y,
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    imageRect,
    imageWidth,
    imageHeight,
    boundsRect: { x: 0, y: 0, w: bounds.width, h: bounds.height },
    autoSelect: autoSelect || null,
    autoAction: autoAction || null,
    mode,
    source,
    windows: Array.isArray(windows) ? windows : [],
    exportFormat: current.imageFormat,
    exportQuality: current.imageQuality,
    afterCapture: current.afterCapture,
    beautify: current.beautify,
  };
}

/**
 * 创建覆盖窗（每个显示器一个）。
 * entriesData: [{ display, init }]
 */
function presentSession(entriesData, meta) {
  if (!entriesData.length) return { ok: false, error: '没有可用的屏幕捕获源' };

  const target = {
    mode: meta.mode,
    source: meta.source,
    cursorDisplayId: meta.cursorDisplayId,
    autoAction: meta.autoAction || null,
    entries: [],
    byWebContents: new Map(),
    shown: false,
  };

  saving = false;

  for (const data of entriesData) {
    const bounds = data.display.bounds;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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

    const entry = {
      win,
      webContentsId: win.webContents.id,
      display: data.display,
      init: data.init,
      ready: false,
      skipped: false,
    };
    target.entries.push(entry);
    target.byWebContents.set(entry.webContentsId, entry);

    // 覆盖窗意外关闭时，结束整个会话，避免另一个显示器残留遮罩
    win.on('closed', () => {
      if (session !== target || entry.skipped) return;
      cancel();
    });
  }

  session = target;

  for (const entry of target.entries) {
    entry.win.loadFile(overlayHtml());
  }

  // 渲染进程异常（脚本报错/卡死）时兜底关闭，避免不可见的置顶窗口卡住 F1
  setTimeout(() => {
    if (session === target && !target.shown) cancel();
  }, 6000);

  return { ok: true, session: target };
}

/** 某块屏幕抓取失败：销毁它的覆盖窗，其余屏幕继续工作 */
function skipEntry(entry) {
  if (!entry || entry.skipped) return;
  entry.skipped = true;
  if (session) {
    session.byWebContents.delete(entry.webContentsId);
    const index = session.entries.indexOf(entry);
    if (index >= 0) session.entries.splice(index, 1);
  }
  try {
    if (!entry.win.isDestroyed()) entry.win.destroy();
  } catch (err) {
    // ignore
  }
  if (!session) return;
  if (session.entries.length === 0) {
    cancel();
    return;
  }
  // 失败的那块屏可能是最后一个未就绪的窗口，移除后其余屏幕可以立即显示
  showSessionIfReady(session);
}

function autoSelectFor(display, mode, current, cursorDisplay) {
  const bounds = display.bounds;
  if (mode === 'full') {
    if (String(display.id) !== String(cursorDisplay.id)) return null;
    return { x: 0, y: 0, w: bounds.width, h: bounds.height };
  }
  if (mode === 'last' && current.lastRegion) {
    if (String(display.id) !== String(current.lastRegion.displayId)) return null;
    return clampRectToBounds(current.lastRegion.rect, {
      x: 0,
      y: 0,
      w: bounds.width,
      h: bounds.height,
    });
  }
  return null;
}

/** 所有显示器都完成首帧绘制后再统一显示，避免逐屏闪黑 */
function showSessionIfReady(target) {
  if (!target || target.shown || session !== target) return;
  if (target.entries.some((entry) => !entry.ready)) return;

  target.shown = true;

  const cursorId = String(target.cursorDisplayId);
  const ordered = [...target.entries].sort(
    (a, b) =>
      (String(b.display.id) === cursorId ? 1 : 0) - (String(a.display.id) === cursorId ? 1 : 0)
  );

  for (const entry of ordered) {
    if (entry.win.isDestroyed()) continue;
    if (String(entry.display.id) === cursorId) {
      entry.win.show();
    } else {
      // 非鼠标所在屏不抢焦点
      entry.win.showInactive();
    }
    entry.win.setAlwaysOnTop(true, 'screen-saver');
  }

  const active =
    target.entries.find(
      (entry) => String(entry.display.id) === cursorId && !entry.win.isDestroyed()
    ) || target.entries.find((entry) => !entry.win.isDestroyed());
  if (active) {
    try {
      active.win.focus();
    } catch (err) {
      // ignore
    }
  }

  shownAt = Date.now();
  windowListTimer = setTimeout(() => {
    windowListTimer = 0;
    loadWindowList(target);
  }, 200);
}

function focusActiveWindow() {
  if (!session) return;
  const cursorId = String(session.cursorDisplayId);
  const entry =
    session.entries.find(
      (item) => String(item.display.id) === cursorId && !item.win.isDestroyed()
    ) || session.entries.find((item) => !item.win.isDestroyed());
  if (entry) {
    try {
      entry.win.focus();
    } catch (err) {
      // ignore
    }
  }
}

async function createOverlay(mode) {
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const current = settings.get();

  // 活动窗口仍使用单屏流程
  if (mode === 'window') {
    let info = null;
    let image = null;
    try {
      info = await findTopWindow(process.pid);
      if (!info) throw new Error('未找到活动窗口');
      image = await captureWindow(info.title, { width: info.width, height: info.height });
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }

    const center = physicalPointToDip(info.left + info.width / 2, info.top + info.height / 2);
    const display = screen.getDisplayNearestPoint(center) || cursorDisplay;
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

    return presentSession(
      [
        {
          display,
          init: buildInit({
            dataUrl: image.toDataURL(),
            display,
            imageRect,
            imageWidth: size.width,
            imageHeight: size.height,
            autoSelect: { ...imageRect },
            autoAction: null,
            mode,
            source: 'window',
            windows: [],
          }),
        },
      ],
      { mode, source: 'window', cursorDisplayId: display.id }
    );
  }

  const displays = screen.getAllDisplays();
  if (!displays.length) return { ok: false, error: '没有可用的显示器' };

  // 先创建覆盖窗、开始加载页面，再并行执行抓屏与 PNG 编码：
  // 页面启动（~190ms）和抓屏编码（~200ms）重叠，F1 响应时间明显缩短。
  const pending = displays.map((display) => {
    let resolve = null;
    const init = new Promise((settle) => {
      resolve = settle;
    });
    return { display, init, resolve, entry: null };
  });

  const created = presentSession(
    pending.map((item) => ({ display: item.display, init: item.init })),
    { mode, source: 'screen', cursorDisplayId: cursorDisplay.id }
  );
  if (!created.ok) {
    for (const item of pending) item.resolve(null);
    return created;
  }
  for (const item of pending) {
    item.entry =
      created.session.entries.find(
        (entry) => String(entry.display.id) === String(item.display.id)
      ) || null;
  }

  let captured = [];
  try {
    captured = await captureDisplays(displays);
  } catch (err) {
    for (const item of pending) item.resolve(null);
    cancel();
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  const byDisplay = new Map(captured.map((item) => [String(item.display.id), item]));
  for (const item of pending) {
    const shot = byDisplay.get(String(item.display.id));
    if (!shot || !item.entry) {
      item.resolve(null);
      if (item.entry) skipEntry(item.entry);
      continue;
    }

    const display = item.display;
    const bounds = display.bounds;
    const init = buildInit({
      dataUrl: shot.dataUrl,
      display,
      imageRect: { x: 0, y: 0, w: bounds.width, h: bounds.height },
      imageWidth: shot.width,
      imageHeight: shot.height,
      autoSelect: autoSelectFor(display, mode, current, cursorDisplay),
      autoAction: mode === 'gif' || mode === 'scroll' ? mode : null,
      mode,
      source: 'screen',
      windows: [],
    });
    // 保存/贴图/GIF 等后续操作要读取真实坐标，替换掉占位的 Promise
    if (item.entry) item.entry.init = init;
    item.resolve(init);
  }

  if (!session) {
    return { ok: false, error: '屏幕捕获为空（可能处于锁屏或显示器休眠状态）' };
  }
  return { ok: true };
}

/**
 * 用任意图片（剪贴板/文件）打开编辑器。
 */
function openImage(image, source) {
  if (session) {
    focusActiveWindow();
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
    return presentSession(
      [
        {
          display,
          init: buildInit({
            dataUrl: image.toDataURL(),
            display,
            imageRect,
            imageWidth: size.width,
            imageHeight: size.height,
            autoSelect: { ...imageRect },
            autoAction: null,
            mode: 'image',
            source: source || 'image',
            windows: [],
          }),
        },
      ],
      { mode: 'image', source: source || 'image', cursorDisplayId: display.id }
    );
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

function getInit(sender) {
  const entry = entryFor(sender);
  if (!entry) return null;
  if (entry.init && typeof entry.init.then === 'function') {
    return entry.init.then((init) => init || null).catch(() => null);
  }
  return entry.init;
}

function ready(sender) {
  const entry = entryFor(sender);
  if (!entry || !session) return { ok: false };
  entry.ready = true;
  showSessionIfReady(session);
  return { ok: true };
}

function cancel() {
  if (!session) return;
  const target = session;
  session = null;
  if (windowListTimer) {
    clearTimeout(windowListTimer);
    windowListTimer = 0;
  }
  for (const entry of target.entries) {
    try {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    } catch (err) {
      // ignore
    }
  }
}

function close() {
  cancel();
}

/**
 * 用户在某块屏幕上开始新的操作时，重置其他屏幕上残留的选区。
 */
function activate(sender) {
  const entry = entryFor(sender);
  if (!entry || !session) return;
  for (const other of session.entries) {
    if (other === entry || other.win.isDestroyed()) continue;
    other.win.webContents.send('overlay:deactivate');
  }
  if (!entry.win.isDestroyed()) {
    try {
      entry.win.focus();
    } catch (err) {
      // ignore
    }
  }
}

/**
 * 将当前选区贴到屏幕顶层（不写文件、不写历史）。
 * 贴图窗口真正显示后才关闭覆盖窗，避免中间露出桌面造成闪烁。
 */
function pin(payload, sender) {
  const entry = entryFor(sender);
  if (!entry) return { ok: false, error: '截图窗口已关闭' };
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

  const context = entry.init;
  const data = {
    dataUrl: payload.dataUrl,
    x: context.displayX + rect.x,
    y: context.displayY + rect.y,
    width: rect.w,
    height: rect.h,
  };

  const result = pinWindow.create(data, () => cancel());
  return result;
}

/**
 * 用当前选区开始 GIF 录制。
 */
function startGif(payload, sender) {
  const entry = entryFor(sender);
  if (!entry) return { ok: false, error: '截图窗口已关闭' };
  const context = entry.init;
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return { ok: false, error: '选区数据无效' };
  }

  cancel();
  return recording.start({
    rect,
    displayBounds: {
      x: context.displayX,
      y: context.displayY,
      width: context.dipWidth,
      height: context.dipHeight,
    },
    displayId: context.displayId,
    displayX: context.displayX,
    displayY: context.displayY,
  });
}

/**
 * 用当前选区开始自动滚动截图。
 */
function startScroll(payload, sender) {
  const entry = entryFor(sender);
  if (!entry) return { ok: false, error: '截图窗口已关闭' };
  const context = entry.init;
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return { ok: false, error: '选区数据无效' };
  }

  cancel();
  return scrollCapture.start({
    rect,
    displayBounds: {
      x: context.displayX,
      y: context.displayY,
      width: context.dipWidth,
      height: context.dipHeight,
    },
    displayId: context.displayId,
    displayX: context.displayX,
    displayY: context.displayY,
    scaleFactor: context.scaleFactor,
  });
}

/**
 * 保存截图：写文件 + 复制到剪贴板 + 写入历史。
 */
async function confirm(payload, sender) {
  const entry = entryFor(sender);
  // 截图窗口已关闭（例如重复提交）时忽略
  if (!entry) return { ok: false, error: '截图窗口已关闭' };
  // 防止回车与按钮重复触发导致保存两份
  if (saving) return { ok: false, error: '正在保存' };
  saving = true;
  try {
    return await saveScreenshot(payload, entry);
  } finally {
    saving = false;
  }
}

function rememberLastRegion(payload, entry) {
  if (!entry) return;
  if (payload && payload.remember === false) return;
  const rect = payload && payload.dipRect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((value) => Number.isFinite(value))) {
    return;
  }
  try {
    settings.save({ lastRegion: { displayId: entry.init.displayId, rect } });
  } catch (err) {
    // ignore
  }
}

/**
 * 按设置执行：保存文件 / 复制剪贴板 / 贴图。
 */
async function saveScreenshot(payload, entry) {
  if (!payload) return { ok: false, error: '图片数据无效' };

  const context = entry ? entry.init : null;
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
    return pinWindow.create(data, () => cancel());
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

  rememberLastRegion(payload, entry);
  cancel();

  const actionLabel =
    afterCapture === 'save'
      ? '已保存到目录'
      : afterCapture === 'copy'
        ? '已复制到剪贴板'
        : '已保存并复制到剪贴板';
  return { ok: true, filePath, action: afterCapture, actionLabel };
}

function openDevTools() {
  if (!session) return false;
  const entry = session.entries.find((item) => !item.win.isDestroyed());
  if (!entry) return false;
  entry.win.webContents.openDevTools({ mode: 'detach' });
  return true;
}

function isOpen() {
  return !!session;
}

function debugState() {
  return {
    open: !!session,
    opening,
    saving,
    mode: session ? session.mode : null,
    source: session ? session.source : null,
    displays: session ? session.entries.length : 0,
    shownAt,
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
  activate,
  openDevTools,
  isOpen,
  openImageFile,
  openClipboardImage,
  debugState,
};
