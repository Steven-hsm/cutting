'use strict';

const { app, BrowserWindow, screen, session, desktopCapturer, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const historyStore = require('./historyStore');
const naming = require('./naming');
const selectionFrame = require('./selectionFrame');
const clipboardHelper = require('./clipboard');

let win = null;
let frameHandle = null;
let state = null;
let mediaHandlerInstalled = false;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

/**
 * 允许录制窗口通过 getDisplayMedia 获取屏幕流，并自动选择目标显示器。
 * 必须在首次 getDisplayMedia 之前安装。
 */
function ensureMediaHandler() {
  if (mediaHandlerInstalled) return;
  mediaHandlerInstalled = true;

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
        });
        const target =
          (state && state.displayId
            ? sources.find((source) => String(source.display_id) === String(state.displayId))
            : null) || sources[0];
        if (target) callback({ video: target });
        else callback({});
      } catch (err) {
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

/**
 * 录制期间的选区边框（含顶部 REC 标记与顶边线）。
 * 边框全部位于录制区域外侧，不会进入录屏画面。
 */
function createFrameWindows({ rect, displayX, displayY }) {
  frameHandle = selectionFrame.create({
    left: displayX + rect.x,
    top: displayY + rect.y,
    width: rect.w,
    height: rect.h,
    label: 'REC',
    tone: 'red',
  });
}

function destroyFrameWindows() {
  if (frameHandle) {
    frameHandle.destroy();
    frameHandle = null;
  }
}

/**
 * 控制条位置：避开选区外侧 40px 的边框窗口，优先放在选区下方，
 * 其次上方/左右侧，最后兜底放在选区内部右下角。
 */
function barPosition(rect, displayBounds, displayX, displayY, barWidth, barHeight) {
  const gap = 8;
  const edge = 8;
  const left = displayX + rect.x;
  const top = displayY + rect.y;
  const w = rect.w;
  const h = rect.h;
  const right = left + w;
  const bottom = top + h;

  const minX = displayBounds.x + edge;
  const maxX = displayBounds.x + displayBounds.width - barWidth - edge;
  const minY = displayBounds.y + edge;
  const maxY = displayBounds.y + displayBounds.height - barHeight - edge;

  const centerX = Math.min(Math.max(left + (w - barWidth) / 2, minX), maxX);

  // 紧贴选区正下方居中；下方空间不足时放到选区正上方居中
  if (bottom + gap + barHeight <= maxY + barHeight) {
    return { x: centerX, y: Math.min(bottom + gap, maxY) };
  }
  return { x: centerX, y: Math.max(minY, top - barHeight - gap) };
}

/** 确保控制条位于边框窗口之上 */
function raiseControlBar() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  } catch (err) {
    // ignore
  }
  // 边框窗口可能稍后才显示，延迟再抬一次
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    try {
      win.moveTop();
    } catch (err) {
      // ignore
    }
  }, 350);
}

function openWindow({ rect, displayBounds, displayX, displayY, width, height }) {
  const barWidth = 214;
  const barHeight = 46;
  const pos = barPosition(rect, displayBounds, displayX, displayY, barWidth, barHeight);

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: barWidth,
    height: barHeight,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    backgroundColor: '#1f2127',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 控制条位于录制区域之外，本身不会进入录屏画面；
  // 不启用内容保护，避免部分显卡/远程环境下窗口被 DWM 隐藏
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    raiseControlBar();
  });

  win.on('closed', () => {
    win = null;
    state = null;
    destroyFrameWindows();
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'recorder', 'index.html'));
  return { ok: true };
}

/**
 * 开始 GIF 录制。region 为相对显示器左上角的 DIP 矩形。
 */
function start({ rect, displayBounds, displayId, displayX, displayY }) {
  if (win) return { ok: false, error: '正在录制中' };
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) {
    return { ok: false, error: '选区无效' };
  }

  ensureMediaHandler();

  state = {
    region: { ...rect },
    displayBounds: { ...displayBounds },
    displayId,
    displayX,
    displayY,
    fps: 10,
    maxSeconds: 60,
  };

  // 选区边框位于录制区域外侧，不会进入录制画面
  createFrameWindows({ rect, displayX, displayY });

  return openWindow({
    rect,
    displayBounds,
    displayX,
    displayY,
    width: rect.w,
    height: rect.h,
  });
}

function getInit(sender) {
  if (!win || win.webContents.id !== sender.id || !state) return null;
  return {
    region: state.region,
    displayBounds: state.displayBounds,
    fps: state.fps,
    maxSeconds: state.maxSeconds,
  };
}

function current() {
  return {
    active: !!win,
  };
}

function close() {
  destroyFrameWindows();
  if (!win) return;
  const target = win;
  win = null;
  state = null;
  try {
    target.destroy();
  } catch (err) {
    // ignore
  }
}

async function saveGif(payload) {
  if (!state) return { ok: false, error: '录制会话已结束' };

  let buffer = null;
  try {
    buffer = Buffer.from(payload.gif);
  } catch (err) {
    buffer = null;
  }
  if (!buffer || buffer.length < 32) {
    return { ok: false, error: 'GIF 数据无效' };
  }
  // 上限 300MB，避免异常数据写盘
  if (buffer.length > 300 * 1024 * 1024) {
    return { ok: false, error: 'GIF 过大' };
  }

  const currentSettings = settings.get();
  const targetDirs = [];
  if (currentSettings.saveDir) targetDirs.push(currentSettings.saveDir);
  targetDirs.push(path.join(app.getPath('userData'), 'pictures'));

  let filePath = '';
  let lastError = null;
  for (const targetDir of targetDirs) {
    try {
      const base = naming.buildBaseName(currentSettings.fileNameTemplate, 'gif');
      filePath = naming.writeUnique(targetDir, base, 'gif', buffer);
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

  let thumbImage = null;
  try {
    if (payload.thumb) thumbImage = nativeImage.createFromDataURL(payload.thumb);
  } catch (err) {
    thumbImage = null;
  }

  if (thumbImage && !thumbImage.isEmpty()) {
    try {
      historyStore.add({
        image: thumbImage,
        filePath,
        width: payload.width,
        height: payload.height,
        scaleFactor: state.displayBounds ? 1 : 1,
        type: 'gif',
        note: 'GIF',
        // 记录录制区域（屏幕 DIP 坐标），F3 贴图时贴回原位置
        region: state
          ? {
              x: state.displayX + state.region.x,
              y: state.displayY + state.region.y,
              w: state.region.w,
              h: state.region.h,
            }
          : null,
      });
    } catch (err) {
      console.error('[recording] 写入历史失败:', err);
    }
  }

  // 把 GIF 文件写入剪贴板，按 F3 可直接贴出最新录制的动画
  let copied = false;
  try {
    copied = await clipboardHelper.writeFileToClipboard(filePath);
  } catch (err) {
    copied = false;
  }

  close();
  return { ok: true, filePath, frames: payload.frames || 0, copied };
}

module.exports = {
  start,
  getInit,
  current,
  close,
  saveGif,
};
