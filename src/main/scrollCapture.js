'use strict';

const { app, BrowserWindow, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const settings = require('./settings');
const historyStore = require('./historyStore');
const naming = require('./naming');
const selectionFrame = require('./selectionFrame');
const clipboardHelper = require('./clipboard');
const { wheelAt } = require('./scrollInput');

let win = null;
let frameHandle = null;
let state = null;

const MAX_STEPS = 40;
const MAX_HEIGHT = 16000;
// 内容行不一致比例上限（0-1），超过则认为无法找到可靠对齐位置
const NO_MATCH_SCORE = 0.45;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createControlWindow(rect, displayX, displayY, displayBounds) {
  const width = 246;
  const height = 48;
  const gap = 8;
  const edge = 8;
  const left = displayX + rect.x;
  const top = displayY + rect.y;
  const bottom = top + rect.h;

  const minX = displayBounds.x + edge;
  const maxX = displayBounds.x + displayBounds.width - width - edge;
  const minY = displayBounds.y + edge;
  const maxY = displayBounds.y + displayBounds.height - height - edge;

  const centerX = Math.min(Math.max(left + (rect.w - width) / 2, minX), maxX);
  let pos = null;
  if (bottom + gap + height <= displayBounds.y + displayBounds.height - edge) {
    pos = { x: centerX, y: bottom + gap };
  } else {
    pos = { x: centerX, y: Math.max(minY, top - height - gap) };
  }

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width,
    height,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1f2127',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 控制条位于选区之外，不启用内容保护（避免部分环境下窗口不可见）
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    raiseControlBar();
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'scroll', 'index.html'));
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
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    try {
      win.moveTop();
    } catch (err) {
      // ignore
    }
  }, 350);
}

function progress(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('scroll:progress', payload);
  }
}

async function captureFrame(session) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(session.displayBounds.width * session.scaleFactor),
      height: Math.round(session.displayBounds.height * session.scaleFactor),
    },
    fetchWindowIcons: false,
  });

  const source =
    sources.find(
      (item) => item.display_id && String(item.display_id) === String(session.displayId)
    ) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('屏幕捕获为空');
  }

  const image = source.thumbnail;
  const size = image.getSize();
  const scaleX = size.width / session.displayBounds.width;
  const scaleY = size.height / session.displayBounds.height;

  let x = Math.round(session.rect.x * scaleX);
  let y = Math.round(session.rect.y * scaleY);
  let width = Math.round(session.rect.w * scaleX);
  let height = Math.round(session.rect.h * scaleY);

  x = Math.max(0, Math.min(x, size.width - 1));
  y = Math.max(0, Math.min(y, size.height - 1));
  width = Math.max(1, Math.min(width, size.width - x));
  height = Math.max(1, Math.min(height, size.height - y));

  const cropped = image.crop({ x, y, width, height });
  const bitmap = cropped.toBitmap();

  return {
    width: cropped.getSize().width,
    height: cropped.getSize().height,
    bitmap,
  };
}

/**
 * 通过「中间带匹配」求滚动距离：
 * 取当前帧中部的一条横带，在上一帧中寻找它出现的位置，
 * 位置偏移量即为本次滚动的像素数。这样可忽略固定表头/悬浮按钮。
 */
function roughlyEqual(a, b) {
  if (a.length !== b.length) return false;
  // 较密集地采样，避免平滑滚动动画被误判为静止
  for (let i = 0; i < a.length; i += 61) {
    if (Math.abs(a[i] - b[i]) > 3) return false;
  }
  return true;
}

/**
 * 等待画面停止变化后再返回该帧。
 * 浏览器滚轮是平滑滚动，立即截帧会截到动画中间态，导致拼接错位。
 * 需要连续两帧一致才认为滚动结束。
 */
async function captureStable(session, maxTries = 15) {
  let previous = await captureFrame(session);
  let stableCount = 0;
  for (let i = 0; i < maxTries; i += 1) {
    await delay(90);
    const next = await captureFrame(session);
    if (roughlyEqual(previous.bitmap, next.bitmap)) {
      stableCount += 1;
      if (stableCount >= 2) return next;
    } else {
      stableCount = 0;
    }
    previous = next;
  }
  return previous;
}

/**
 * 计算每行的指纹与「是否有内容」标记。
 * 空白行在所有偏移下都相同，只有内容行能用于判断对齐位置。
 */
function buildRowProfile(bitmap, width, height) {
  const hashes = new Uint32Array(height);
  const content = new Uint8Array(height);
  const rowBytes = width * 4;

  for (let y = 0; y < height; y += 1) {
    const base = y * rowBytes;
    let hash = 2166136261;
    let ink = 0;
    for (let x = 0; x < width; x += 1) {
      const i = base + x * 4;
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      hash ^= (r << 16) | (g << 8) | b;
      hash = Math.imul(hash, 16777619) >>> 0;
      if (r < 240 || g < 240 || b < 240) ink += 1;
    }
    hashes[y] = hash;
    content[y] = ink > Math.max(2, Math.floor(width * 0.006)) ? 1 : 0;
  }

  return { hashes, content };
}

/**
 * 计算两帧之间的滚动距离（像素）。
 * 使用行指纹对齐内容行：正确偏移下内容行几乎全部一致，
 * 空白区域不参与判断，因此对稀疏文本页面同样可靠。
 */
function findScrollDelta(prev, next, width, height) {
  const topGuard = Math.max(4, Math.round(height * 0.1));
  const bottomGuard = Math.max(2, Math.round(height * 0.03));
  const minOverlap = Math.max(60, Math.round(height * 0.25));
  const maxDelta = height - topGuard - bottomGuard - minOverlap;

  const profilePrev = buildRowProfile(prev, width, height);
  const profileNext = buildRowProfile(next, width, height);

  const scoreAt = (delta) => {
    const end = height - bottomGuard - delta;
    if (end - topGuard < minOverlap) return { score: Infinity, considered: 0 };

    let considered = 0;
    let mismatched = 0;
    for (let y = topGuard; y < end; y += 1) {
      const isContent = profilePrev.content[y + delta] || profileNext.content[y];
      if (!isContent) continue;
      considered += 1;
      if (profilePrev.hashes[y + delta] !== profileNext.hashes[y]) mismatched += 1;
    }
    if (!considered) return { score: Infinity, considered: 0 };
    return { score: mismatched / considered, considered };
  };

  let best = { delta: 0, score: Infinity, considered: 0 };
  for (let delta = 0; delta <= maxDelta; delta += 1) {
    const result = scoreAt(delta);
    if (result.score < best.score) {
      best = { delta, score: result.score, considered: result.considered };
    }
  }

  if (process.env.CUTTING_DEBUG_SCROLL) {
    console.log(
      `[scroll] match delta=${best.delta} mismatch=${best.score.toFixed(3)} rows=${best.considered}`
    );
  }

  return { delta: best.delta, score: best.score };
}

async function runCapture(session) {
  const current = settings.get();
  const notches = Math.max(1, Math.min(20, current.scrollNotches || 3));
  const waitMs = Math.max(150, Math.min(3000, current.scrollDelayMs || 400));
  const scale = session.scaleFactor || 1;

  // 滚动位置：物理坐标（单显示器 / 同缩放多显示器可用）
  const targetX = Math.round((session.displayX + session.rect.x + session.rect.w / 2) * scale);
  const targetY = Math.round((session.displayY + session.rect.y + session.rect.h / 2) * scale);

  progress({ status: '准备中…', steps: 0, height: 0 });

  await delay(300);

  let first;
  try {
    first = await captureFrame(session);
  } catch (err) {
    return { ok: false, error: err.message || '屏幕捕获失败' };
  }

  const width = first.width;
  const frameHeight = first.height;

  const maxRows = Math.min(MAX_HEIGHT, width * 0 + MAX_HEIGHT);
  const stitched = Buffer.alloc(width * maxRows * 4);
  first.bitmap.copy(stitched, 0);
  let stitchedHeight = frameHeight;
  let previous = first.bitmap;

  progress({ status: '正在滚动…', steps: 0, height: stitchedHeight });

  let steps = 0;
  let stopReason = '达到最大滚动次数';
  let retried = false;

  // 自适应步长：单步滚动不能超过画面高度的一定比例，否则两帧没有重叠、无法拼接。
  // 不同应用每格滚轮的像素数不同，首次按 100px/格 估算，之后用实测值修正。
  let pxPerNotch = 100;
  const computeNotches = () => {
    const safeScroll = frameHeight * 0.4;
    return Math.max(1, Math.min(notches, Math.floor(safeScroll / Math.max(30, pxPerNotch))));
  };
  let effectiveNotches = computeNotches();

  while (steps < MAX_STEPS && stitchedHeight < maxRows) {
    if (state && state.aborted) {
      stopReason = '已手动停止';
      break;
    }

    await wheelAt(targetX, targetY, -120 * effectiveNotches);
    await delay(waitMs);

    let frame;
    try {
      frame = await captureStable(session);
    } catch (err) {
      stopReason = '屏幕捕获失败';
      break;
    }

    if (frame.width !== width || frame.height !== frameHeight) {
      stopReason = '画面尺寸变化，已停止';
      break;
    }

    const { delta, score } = findScrollDelta(previous, frame.bitmap, width, frameHeight);

    if (delta > 2 && score <= NO_MATCH_SCORE) {
      // 用实测结果校准每格滚动的像素数
      const measured = delta / Math.max(1, effectiveNotches);
      if (measured >= 20 && measured <= 600) {
        pxPerNotch = Math.round(pxPerNotch * 0.6 + measured * 0.4);
        effectiveNotches = computeNotches();
      }
    }

    if (delta <= 2 || score > NO_MATCH_SCORE) {
      // 有可能是页面还在渲染，重试一次再判断
      if (!retried) {
        retried = true;
        await delay(Math.max(650, waitMs));
        let retryFrame;
        try {
          retryFrame = await captureStable(session, 4);
        } catch (err) {
          retryFrame = null;
        }
        if (retryFrame && retryFrame.width === width && retryFrame.height === frameHeight) {
          const retry = findScrollDelta(previous, retryFrame.bitmap, width, frameHeight);
          if (retry.delta > 2 && retry.score <= NO_MATCH_SCORE) {
            const newRows = retry.delta;
            const needed = (stitchedHeight + newRows) * width * 4;
            if (needed <= stitched.length) {
              retryFrame.bitmap.copy(
                stitched,
                stitchedHeight * width * 4,
                (frameHeight - newRows) * width * 4
              );
              stitchedHeight += newRows;
              previous = retryFrame.bitmap;
              steps += 1;
              retried = false;
              progress({ status: '正在滚动…', steps, height: stitchedHeight });
              continue;
            }
          }
        }
      }
      stopReason = score > NO_MATCH_SCORE ? '无法识别滚动画面，已停止' : '内容已滚动到底部';
      break;
    }

    const newRows = delta;
    if (newRows <= 0) {
      stopReason = '内容已滚动到底部';
      break;
    }

    if (stitchedHeight + newRows > maxRows) {
      const allowed = maxRows - stitchedHeight;
      if (allowed > 0) {
        frame.bitmap.copy(
          stitched,
          stitchedHeight * width * 4,
          (frameHeight - newRows) * width * 4,
          (frameHeight - newRows + allowed) * width * 4
        );
        stitchedHeight += allowed;
      }
      stopReason = '已达到最大截图高度';
      break;
    }

    frame.bitmap.copy(
      stitched,
      stitchedHeight * width * 4,
      (frameHeight - newRows) * width * 4,
      frameHeight * width * 4
    );
    stitchedHeight += newRows;
    previous = frame.bitmap;
    steps += 1;
    retried = false;
    progress({ status: '正在滚动…', steps, height: stitchedHeight });
  }

  if (stitchedHeight <= frameHeight) {
    return { ok: false, error: stopReason === '内容已滚动到底部' ? '页面没有可滚动的内容' : stopReason };
  }

  const finalBuffer = stitched.subarray(0, stitchedHeight * width * 4);
  let image;
  try {
    image = nativeImage.createFromBitmap(Buffer.from(finalBuffer), {
      width,
      height: stitchedHeight,
    });
  } catch (err) {
    return { ok: false, error: '拼接结果生成失败' };
  }
  if (!image || image.isEmpty()) {
    return { ok: false, error: '拼接结果为空' };
  }

  const png = image.toPNG();
  const dirs = [];
  if (current.saveDir) dirs.push(current.saveDir);
  dirs.push(path.join(app.getPath('userData'), 'pictures'));

  let filePath = '';
  let lastError = null;
  for (const dir of dirs) {
    try {
      const base = naming.buildBaseName(current.fileNameTemplate, 'scroll');
      filePath = naming.writeUnique(dir, base, 'png', png);
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

  try {
    await clipboardHelper.writeImageBuffer(png);
  } catch (err) {
    console.error('[scroll] 写入剪贴板失败:', err);
  }

  try {
    historyStore.add({
      image,
      filePath,
      width,
      height: stitchedHeight,
      scaleFactor: 1,
      note: '滚动截图',
    });
  } catch (err) {
    console.error('[scroll] 写入历史失败:', err);
  }

  return { ok: true, filePath, height: stitchedHeight, steps, stopReason };
}

function start({ rect, displayId, displayBounds, displayX, displayY, scaleFactor }) {
  if (win || (state && state.running)) return { ok: false, error: '滚动截图正在运行' };
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return { ok: false, error: '选区无效' };

  state = { aborted: false, running: true };

  // 滚动期间保留选区边框（位于录制区域外侧，不会进入拼接结果）
  try {
    frameHandle = selectionFrame.create({
      left: displayX + rect.x,
      top: displayY + rect.y,
      width: rect.w,
      height: rect.h,
      label: 'SCROLL',
      tone: 'blue',
    });
  } catch (err) {
    console.error('[scroll] 创建选区边框失败:', err);
    frameHandle = null;
  }

  try {
    createControlWindow(rect, displayX, displayY, displayBounds);
  } catch (err) {
    console.error('[scroll] 创建控制窗口失败:', err);
    destroyFrame();
    state = null;
    return { ok: false, error: err.message || '创建控制窗口失败' };
  }

  const session = { rect: { ...rect }, displayId, displayBounds: { ...displayBounds }, displayX, displayY, scaleFactor };

  runCapture(session)
    .then((result) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('scroll:done', result);
        setTimeout(() => close(), result.ok ? 900 : 1800);
      }
      if (result && !result.ok) {
        console.error('[scroll] 失败:', result.error);
      }
    })
    .catch((err) => {
      console.error('[scroll] 异常:', err);
      if (win && !win.isDestroyed()) {
        win.webContents.send('scroll:done', { ok: false, error: err.message || '滚动截图失败' });
        setTimeout(() => close(), 1800);
      }
    })
    .finally(() => {
      if (state) state.running = false;
    });

  return { ok: true };
}

function abort() {
  if (state) state.aborted = true;
  return { ok: true };
}

function destroyFrame() {
  if (!frameHandle) return;
  frameHandle.destroy();
  frameHandle = null;
}

function close() {
  destroyFrame();
  if (!win) return;
  const target = win;
  win = null;
  try {
    target.destroy();
  } catch (err) {
    // ignore
  }
}

function getInit() {
  return { active: !!win, settings: { notches: settings.get().scrollNotches, delayMs: settings.get().scrollDelayMs } };
}

module.exports = { start, abort, close, getInit, destroyFrame, current: () => ({ active: !!win }) };
