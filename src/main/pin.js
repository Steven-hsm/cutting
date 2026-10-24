'use strict';

const { BrowserWindow, screen, nativeImage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const clipboardHelper = require('./clipboard');
const ocr = require('./ocr');

// webContents.id -> { dataUrl, kind, text, color }
const inits = new Map();
// 所有贴图窗口，用于边缘吸附对齐
const pinWindows = new Set();

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function pinHtml() {
  return path.join(__dirname, '..', 'renderer', 'pin', 'index.html');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 设置窗口尺寸并校验；部分 Windows 环境下的首次 setSize 可能只应用了一个方向，
 * 这里做几次重试，确保宽高都生效。
 */
async function resizeWindow(win, width, height) {
  for (let i = 0; i < 3; i += 1) {
    win.setSize(width, height);
    await delay(70);
    const [w, h] = win.getSize();
    if (w === width && h === height) return true;
  }
  return false;
}

function clampToDisplay(display, x, y, width, height) {
  const bounds = display.bounds;
  return {
    x: Math.min(Math.max(Math.round(x), bounds.x), bounds.x + Math.max(0, bounds.width - width)),
    y: Math.min(Math.max(Math.round(y), bounds.y), bounds.y + Math.max(0, bounds.height - height)),
    width: Math.min(Math.round(width), bounds.width),
    height: Math.min(Math.round(height), bounds.height),
  };
}

/**
 * 在屏幕顶层创建一个贴图窗口。
 * x/y/width/height 均为 DIP（与 display.bounds 同一坐标系）。
 */
function create({
  dataUrl,
  fileUrl,
  filePath,
  x,
  y,
  width,
  height,
  kind = 'image',
  text = '',
  color = '',
}) {
  if (kind === 'image' && (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/'))) {
    return { ok: false, error: '图片数据无效' };
  }
  if (kind === 'gif' && typeof fileUrl !== 'string') {
    return { ok: false, error: 'GIF 数据无效' };
  }

  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const rect = clampToDisplay(
    display,
    x,
    y,
    Math.max(40, width || 200),
    Math.max(30, height || 150)
  );

  const win = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    frame: false,
    // 保持可调整，否则部分 Windows 环境会拒绝程序化 setSize（旋转/缩放/缩略图失效）
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    backgroundColor: '#101114',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility(false);
  // Windows 对无边框窗口有默认最小宽度限制，解除后才能切换到竖向贴图
  win.setMinimumSize(60, 40);

  const key = win.webContents.id;
  inits.set(key, { dataUrl, fileUrl, filePath, kind, text, color });
  pinWindows.add(win);
  win.on('closed', () => {
    inits.delete(key);
    thumbnailState.delete(key);
    pinWindows.delete(win);
  });

  win.loadFile(pinHtml());
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  return { ok: true };
}

function getInit(sender) {
  return inits.get(sender.id) || null;
}

function windowOf(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return win && !win.isDestroyed() ? win : null;
}

async function ocrFromWindow(sender) {
  const init = getInit(sender);
  if (!init) return { ok: false, error: '贴图数据已丢失' };
  if (init.kind !== 'image') return { ok: false, error: '仅支持识别图片贴图' };

  // 行坐标返回给贴图窗口，由界面在原图上叠加可选文字
  return ocr.recognizeDataUrl(init.dataUrl);
}

async function copyFromWindow(sender) {
  const init = getInit(sender);
  if (!init) return { ok: false, error: '贴图数据已丢失' };

  try {
    if (init.kind === 'text') {
      await clipboard.writeText(init.text || '');
      return { ok: true };
    }
    if (init.kind === 'color') {
      await clipboard.writeText(init.color || '');
      return { ok: true };
    }
    if (init.kind === 'gif') {
      const ok = await clipboardHelper.writeFileToClipboard(init.filePath);
      return ok ? { ok: true, kind: 'file' } : { ok: false, error: '复制 GIF 文件失败' };
    }
    const image = nativeImage.createFromDataURL(init.dataUrl);
    if (image.isEmpty()) return { ok: false, error: '图片解析失败' };
    await clipboardHelper.writeNativeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '复制失败' };
  }
}

/**
 * 滚轮缩放：保持窗口中心不变。
 */
async function zoomWindow(sender, factor) {
  const win = windowOf(sender);
  if (!win) return { ok: false };
  const value = Number(factor);
  if (!Number.isFinite(value)) return { ok: false };

  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const ratio = Math.min(1.5, Math.max(0.5, value));
  const nextW = Math.round(Math.min(4000, Math.max(60, w * ratio)));
  const nextH = Math.round(Math.min(4000, Math.max(40, h * ratio)));
  const cx = x + w / 2;
  const cy = y + h / 2;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const rect = clampToDisplay(display, cx - nextW / 2, cy - nextH / 2, nextW, nextH);
  await resizeWindow(win, rect.width, rect.height);
  win.setPosition(rect.x, rect.y);
  return { ok: true, size: win.getSize() };
}

function setOpacity(sender, opacity) {
  const win = windowOf(sender);
  if (!win) return { ok: false };
  const value = Math.min(1, Math.max(0.2, Number(opacity) || 1));
  win.setOpacity(value);
  return { ok: true, opacity: value };
}

/**
 * 旋转 90°（顺时针）：交换窗口宽高，保持中心不变。
 */
async function rotateWindow(sender) {
  const win = windowOf(sender);
  if (!win) return { ok: false };

  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const cx = x + w / 2;
  const cy = y + h / 2;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const rect = clampToDisplay(display, cx - h / 2, cy - w / 2, h, w);
  await resizeWindow(win, rect.width, rect.height);
  win.setPosition(rect.x, rect.y);
  return { ok: true, size: win.getSize() };
}

// webContents.id -> 缩略图模式前的窗口几何信息
const thumbnailState = new Map();

/**
 * 缩略图模式：缩小到 240px 以内，再次调用恢复原尺寸与位置。
 */
async function toggleThumbnail(sender) {
  const win = windowOf(sender);
  if (!win) return { ok: false };

  const saved = thumbnailState.get(sender.id);
  if (saved) {
    thumbnailState.delete(sender.id);
    await resizeWindow(win, saved.width, saved.height);
    win.setPosition(saved.x, saved.y);
    return { ok: true, thumbnail: false, size: win.getSize() };
  }

  const bounds = win.getBounds();
  thumbnailState.set(sender.id, bounds);

  const ratio = Math.min(1, 240 / Math.max(1, bounds.width), 200 / Math.max(1, bounds.height));
  const width = Math.max(60, Math.round(bounds.width * ratio));
  const height = Math.max(40, Math.round(bounds.height * ratio));

  await resizeWindow(win, width, height);
  return { ok: true, thumbnail: true, size: win.getSize() };
}

function setMouseThrough(sender, ignore) {
  const win = windowOf(sender);
  if (!win) return { ok: false };
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
  return { ok: true, ignore: !!ignore };
}

/**
 * 从剪贴板创建贴图：优先图片，其次颜色，最后文本。
 */
async function fromClipboard() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  // 1) 剪贴板中是文件（例如刚录制的 GIF）：GIF 贴为动画，其他图片按静态图贴
  // 刚保存 GIF 时剪贴板可能尚未就绪，读取为空则稍等重试一次
  try {
    let files = await clipboardHelper.readFilePathsFromClipboard();
    if (!files.length) {
      await delay(180);
      files = await clipboardHelper.readFilePathsFromClipboard();
    }
    for (const filePath of files) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.gif') {
        let size = { width: 400, height: 300 };
        try {
          const image = nativeImage.createFromPath(filePath);
          if (!image.isEmpty()) size = image.getSize();
        } catch (err) {
          // 用默认尺寸
        }
        return pinGifFile(filePath, size.width, size.height);
      }
      if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
        const image = nativeImage.createFromPath(filePath);
        if (image && !image.isEmpty()) return pinImage(image, cursor, display);
      }
    }
  } catch (err) {
    // ignore，继续尝试图像/文本
  }

  try {
    const items = await clipboard.read();
    for (const item of items) {
      if (item.types && item.types.includes('image/png')) {
        const blob = await item.getType('image/png');
        const buffer = Buffer.from(await blob.arrayBuffer());
        const image = nativeImage.createFromBuffer(buffer);
        if (image && !image.isEmpty()) {
          return pinImage(image, cursor, display);
        }
      }
    }
  } catch (err) {
    // ignore，继续尝试文本
  }

  let text = '';
  try {
    text = await clipboard.readText();
  } catch (err) {
    text = '';
  }
  text = String(text || '').trim();

  if (!text) {
    return { ok: false, error: '剪贴板中没有可贴的内容' };
  }

  const colorMatch = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text);
  if (colorMatch) {
    const normalized = `#${colorMatch[1]}`.toUpperCase();
    return create({
      kind: 'color',
      color: normalized,
      x: cursor.x + 16,
      y: cursor.y + 16,
      width: 180,
      height: 120,
    });
  }

  const lines = text.split(/\r?\n/).slice(0, 30);
  // 按字符实际宽度估算（中日韩字符约 14px，其他约 8px）
  const longest = lines.reduce((max, line) => {
    let width = 0;
    for (const char of line) width += char.charCodeAt(0) > 255 ? 14 : 8;
    return Math.max(max, width);
  }, 0);
  const width = Math.min(display.bounds.width * 0.8, Math.max(180, longest + 32));
  const height = Math.min(display.bounds.height * 0.8, Math.max(80, lines.length * 21 + 28));

  return create({
    kind: 'text',
    text: lines.join('\n'),
    x: cursor.x + 16,
    y: cursor.y + 16,
    width,
    height,
  });
}

function pinImage(image, cursor, display) {
  const scale = display.scaleFactor || 1;
  const size = image.getSize();
  let width = size.width / scale;
  let height = size.height / scale;

  const maxWidth = display.bounds.width * 0.9;
  const maxHeight = display.bounds.height * 0.9;
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  width *= ratio;
  height *= ratio;

  return create({
    dataUrl: image.toDataURL(),
    x: cursor.x + 16,
    y: cursor.y + 16,
    width,
    height,
  });
}

function closeWindow(sender) {
  const win = windowOf(sender);
  if (win) win.close();
  return { ok: true };
}

function beginDrag(sender) {
  const win = windowOf(sender);
  if (!win) return null;
  const [x, y] = win.getPosition();
  return { x, y };
}

/**
 * 贴图边缘吸附：靠近屏幕边缘或其他贴图的边缘时自动对齐（借鉴 Snipaste）。
 * 返回吸附后的坐标。
 */
function snapPosition(win, x, y, width, height) {
  const threshold = 12;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
  const bounds = display.bounds;

  const targets = [{ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }];
  for (const other of pinWindows) {
    if (other === win || other.isDestroyed()) continue;
    targets.push(other.getBounds());
  }

  let snappedX = x;
  let snappedY = y;
  let bestX = threshold + 1;
  let bestY = threshold + 1;

  for (const target of targets) {
    // X：左对齐 / 右对齐 / 贴到目标右侧 / 贴到目标左侧
    const xCandidates = [
      target.x,
      target.x + target.width - width,
      target.x + target.width,
      target.x - width,
    ];
    for (const candidate of xCandidates) {
      const distance = Math.abs(candidate - x);
      if (distance <= threshold && distance < bestX) {
        bestX = distance;
        snappedX = candidate;
      }
    }

    // Y：上对齐 / 下对齐 / 贴到目标下方 / 贴到目标上方
    const yCandidates = [
      target.y,
      target.y + target.height - height,
      target.y + target.height,
      target.y - height,
    ];
    for (const candidate of yCandidates) {
      const distance = Math.abs(candidate - y);
      if (distance <= threshold && distance < bestY) {
        bestY = distance;
        snappedY = candidate;
      }
    }
  }

  return { x: snappedX, y: snappedY, snapped: bestX <= threshold || bestY <= threshold };
}

function moveWindow(sender, x, y) {
  const win = windowOf(sender);
  if (!win) return { ok: false };
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const [width, height] = win.getSize();
  const snapped = snapPosition(win, x, y, width, height);
  const rect = clampToDisplay(display, snapped.x, snapped.y, width, height);
  win.setPosition(rect.x, rect.y);
  return { ok: true, snapped: snapped.snapped };
}

/**
 * 从 GIF 文件头解析逻辑屏幕宽高（Electron 的 nativeImage 不能解码 GIF）。
 */
function readGifSize(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(10);
    fs.readSync(fd, buffer, 0, 10, 0);
    fs.closeSync(fd);
    const signature = buffer.toString('ascii', 0, 6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height };
  } catch (err) {
    // ignore
  }
  return null;
}

/**
 * 将 GIF 文件贴到屏幕顶层（保持动画播放）。
 */
function pinGifFile(filePath, width, height, region) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: '文件路径无效' };
  }

  const cursor = screen.getCursorScreenPoint();
  const scale = screen.getDisplayNearestPoint(cursor).scaleFactor || 1;

  // GIF 头部尺寸最可靠，优先使用
  const parsed = readGifSize(filePath);
  const naturalW = ((parsed && parsed.width) || Number(width) || 400) / scale;
  const naturalH = ((parsed && parsed.height) || Number(height) || 300) / scale;

  const hasRegion =
    region && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(region[key])) && region.w > 0 && region.h > 0;

  if (hasRegion) {
    // 贴回录制时的原位置与原尺寸
    const display = screen.getDisplayNearestPoint({
      x: Math.round(region.x + region.w / 2),
      y: Math.round(region.y + region.h / 2),
    });
    return create({
      kind: 'gif',
      fileUrl: pathToFileURL(filePath).href,
      filePath,
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
    });
  }

  const display = screen.getDisplayNearestPoint(cursor);
  let w = naturalW;
  let h = naturalH;
  const maxW = display.bounds.width * 0.9;
  const maxH = display.bounds.height * 0.9;
  const ratio = Math.min(1, maxW / w, maxH / h);
  w *= ratio;
  h *= ratio;

  return create({
    kind: 'gif',
    fileUrl: pathToFileURL(filePath).href,
    filePath,
    x: cursor.x + 16,
    y: cursor.y + 16,
    width: w,
    height: h,
  });
}

/**
 * 将历史记录中的图片贴到屏幕顶层。
 */
function pinFromFile(filePath) {
  let image = null;
  try {
    image = nativeImage.createFromPath(filePath);
  } catch (err) {
    image = null;
  }
  if (!image || image.isEmpty()) {
    return { ok: false, error: '图片读取失败' };
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return pinImage(image, cursor, display);
}

module.exports = {
  create,
  getInit,
  copyFromWindow,
  ocrFromWindow,
  closeWindow,
  beginDrag,
  moveWindow,
  pinFromFile,
  pinGifFile,
  zoomWindow,
  rotateWindow,
  toggleThumbnail,
  setOpacity,
  setMouseThrough,
  fromClipboard,
};
