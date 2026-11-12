'use strict';

const {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  globalShortcut,
} = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const historyStore = require('./historyStore');
const naming = require('./naming');
const selectionFrame = require('./selectionFrame');
const clipboardHelper = require('./clipboard');
const tray = require('./tray');
const { warmup, wheelAt } = require('./scrollInput');

let win = null;
let frameHandle = null;
let state = null;
let escRegistered = false;
let controlShown = false;
let controlFallback = false;

const MAX_STEPS = 40;
const MAX_HEIGHT = 16000;
// 第一次内容区匹配可能还包含右侧滚动条（整行指纹会被滚动条拖动影响），
// 允许较高阈值；随后裁掉滚动条会用 MATCH_SCORE 严格复核。
const BAND_MATCH_SCORE = 0.85;
// 排除固定栏、滚动条后，内容区匹配应该非常干净
const MATCH_SCORE = 0.3;

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 失败时写一份简短诊断日志，方便定位不同应用下的匹配问题 */
function writeScrollLog(session, debug, result) {
  if (!process.env.CUTTING_DEBUG_SCROLL && result && result.ok) return;
  try {
    const file = path.join(app.getPath('userData'), 'scroll-debug.log');
    try {
      const stat = fs.statSync(file);
      if (stat.size > 200 * 1024) fs.renameSync(file, `${file}.1`);
    } catch (err) {
      // 文件不存在或重命名失败时忽略
    }
    const entry = {
      time: new Date().toISOString(),
      displayId: session.displayId,
      rect: session.rect,
      scaleFactor: session.scaleFactor,
      debug: debug || {},
      result: result || null,
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // ignore
  }
}

/** 控制条尽量放在选区外侧；放不下时返回 overlap=true，此时不显示控制条 */
function computeControlPlacement(rect, displayX, displayY, displayBounds) {
  const width = 246;
  const height = 48;
  const gap = 8;
  const edge = 8;

  const left = displayX + rect.x;
  const top = displayY + rect.y;
  const right = left + rect.w;
  const bottom = top + rect.h;

  const minX = displayBounds.x + edge;
  const maxX = displayBounds.x + displayBounds.width - width - edge;
  const minY = displayBounds.y + edge;
  const maxY = displayBounds.y + displayBounds.height - height - edge;

  const centerX = Math.min(Math.max(left + (rect.w - width) / 2, minX), maxX);

  if (bottom + gap + height <= displayBounds.y + displayBounds.height - edge) {
    return { x: centerX, y: bottom + gap, overlap: false };
  }
  if (top - height - gap >= minY) {
    return { x: centerX, y: top - height - gap, overlap: false };
  }
  // 上下都放不下时尝试放到选区左右侧
  if (right + gap + width <= displayBounds.x + displayBounds.width - edge) {
    return {
      x: right + gap,
      y: Math.min(Math.max(top + (rect.h - height) / 2, minY), maxY),
      overlap: false,
    };
  }
  if (left - gap - width >= minX) {
    return {
      x: left - gap - width,
      y: Math.min(Math.max(top + (rect.h - height) / 2, minY), maxY),
      overlap: false,
    };
  }

  // 全屏选区等极端情况：控制条会覆盖选区，隐藏它并依赖全局 Esc 停止
  return { x: centerX, y: Math.min(Math.max(top + gap, minY), maxY), overlap: true };
}

function createControlWindow(rect, displayX, displayY, displayBounds) {
  const width = 246;
  const height = 48;
  const placement = computeControlPlacement(rect, displayX, displayY, displayBounds);

  win = new BrowserWindow({
    x: Math.round(placement.x),
    y: Math.round(placement.y),
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

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    if (placement.overlap && !controlFallback) {
      controlShown = false;
      return;
    }
    win.showInactive();
    controlShown = true;
    raiseControlBar();
  });

  win.on('closed', () => {
    win = null;
    controlShown = false;
    if (state && state.running && !state.aborted) {
      state.aborted = true;
    }
    unregisterEsc();
    destroyFrame();
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'scroll', 'index.html'));
  return placement;
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

function registerEsc() {
  if (escRegistered) return true;
  try {
    escRegistered = globalShortcut.register('Escape', () => abort());
  } catch (err) {
    escRegistered = false;
  }
  return escRegistered;
}

function unregisterEsc() {
  if (!escRegistered) return;
  escRegistered = false;
  try {
    globalShortcut.unregister('Escape');
  } catch (err) {
    // ignore
  }
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

  let source = sources.find(
    (item) => item.display_id && String(item.display_id) === String(session.displayId)
  );
  // 只有单屏时才允许回退，避免多屏下截错屏幕
  if (!source && sources.length === 1) source = sources[0];

  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('找不到对应显示器的屏幕捕获源');
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
  return {
    width: cropped.getSize().width,
    height: cropped.getSize().height,
    bitmap: cropped.toBitmap(),
  };
}

/**
 * 比较两帧是否基本一致。
 * region 用于滚动开始后只检查可滚动内容区，避免固定栏里的时钟/动画影响判断。
 */
function roughlyEqual(a, b, width, height, region) {
  if (a.length !== b.length) return false;
  const rowBytes = width * 4;
  const top = region ? Math.max(0, Math.min(height, region.top)) : 0;
  const bottom = region ? Math.max(top, Math.min(height, region.bottom)) : height;
  const left = region ? Math.max(0, Math.min(width, region.left)) : 0;
  const right = region ? Math.max(left + 1, Math.min(width, region.right)) : width;
  const sampleStart = left * 4;
  const sampleEnd = right * 4;

  for (let y = top; y < bottom; y += 2) {
    const base = y * rowBytes;
    for (let i = sampleStart; i < sampleEnd; i += 61) {
      if (Math.abs(a[base + i] - b[base + i]) > 3) return false;
    }
  }
  return true;
}

/**
 * 等待画面停止变化后再返回该帧。
 * 浏览器滚轮是平滑滚动，立即截帧会截到动画中间态，导致拼接错位。
 */
async function captureStable(session, maxTries = 15, region = null) {
  let previous = await captureFrame(session);
  let stableCount = 0;
  for (let i = 0; i < maxTries; i += 1) {
    await delay(90);
    const next = await captureFrame(session);
    if (next.width !== previous.width || next.height !== previous.height) return next;
    if (roughlyEqual(previous.bitmap, next.bitmap, previous.width, previous.height, region)) {
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
 * xStart/xEnd 可只统计内容区，排除右侧滚动条。
 */
function buildRowProfile(bitmap, width, height, xStart, xEnd) {
  const hashes = new Uint32Array(height);
  const content = new Uint8Array(height);
  const rowBytes = width * 4;
  const start = Math.max(0, xStart);
  const end = Math.min(width, xEnd);
  const span = Math.max(1, end - start);

  for (let y = 0; y < height; y += 1) {
    const base = y * rowBytes;
    let hash = 2166136261;
    let ink = 0;
    for (let x = start; x < end; x += 1) {
      const i = base + x * 4;
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      hash ^= (r << 16) | (g << 8) | b;
      hash = Math.imul(hash, 16777619) >>> 0;
      if (r < 240 || g < 240 || b < 240) ink += 1;
    }
    hashes[y] = hash;
    content[y] = ink > Math.max(2, Math.floor(span * 0.006)) ? 1 : 0;
  }

  return { hashes, content };
}

/**
 * 通过「行指纹对齐」计算两帧之间的滚动距离。
 * 只比较 top~bottom 的内容区，固定栏与滚动条在调用前已经排除。
 */
function findScrollDelta(previous, next, top, bottom, expectedDelta = 0) {
  const height = bottom - top;
  if (height <= 20) return { delta: 0, score: Infinity, considered: 0 };

  const minOverlap = Math.max(50, Math.round(height * 0.22));
  const maxDelta = height - minOverlap;
  if (maxDelta <= 0) return { delta: 0, score: Infinity, considered: 0 };

  const scoreAt = (delta) => {
    const end = bottom - delta;
    if (end - top < minOverlap) return { score: Infinity, considered: 0 };

    let considered = 0;
    let mismatched = 0;
    for (let y = top; y < end; y += 1) {
      if (!previous.content[y + delta] && !next.content[y]) continue;
      considered += 1;
      if (previous.hashes[y + delta] !== next.hashes[y]) mismatched += 1;
    }
    if (considered < 8) return { score: Infinity, considered };
    return { score: mismatched / considered, considered };
  };

  // 画面完全没动时直接返回 0，避免空白/重复内容在其它偏移下也匹配出假位移
  const zero = scoreAt(0);
  if (zero.score <= 0.02) return { delta: 0, score: zero.score, considered: zero.considered };

  let best = null;
  for (let delta = 1; delta <= maxDelta; delta += 1) {
    const result = scoreAt(delta);
    if (!Number.isFinite(result.score)) continue;
    if (!best) {
      best = { delta, score: result.score, considered: result.considered };
      continue;
    }
    if (result.score < best.score - 0.01) {
      best = { delta, score: result.score, considered: result.considered };
      continue;
    }
    if (Math.abs(result.score - best.score) <= 0.01) {
      // 分数接近时：已校准时优先接近预期步长，否则优先较大位移（避免漏内容）
      let prefer = delta > best.delta;
      if (expectedDelta > 0) {
        prefer = Math.abs(delta - expectedDelta) < Math.abs(best.delta - expectedDelta);
      }
      if (prefer) {
        best = { delta, score: result.score, considered: result.considered };
      }
    }
  }

  if (!best) return { delta: 0, score: Infinity, considered: 0 };

  if (process.env.CUTTING_DEBUG_SCROLL) {
    console.log(
      `[scroll] delta=${best.delta} mismatch=${best.score.toFixed(3)} rows=${best.considered}`
    );
  }
  return best;
}

/**
 * 识别顶部/底部固定区域：滚动前后同一 y 坐标完全相同的连续行。
 * 固定表头、固定底栏、状态栏等会被排除在拼接内容之外。
 */
function detectFixedBands(previous, next, height) {
  const maxBand = Math.max(4, Math.floor(height * 0.3));
  let top = 0;
  while (top < maxBand && previous.hashes[top] === next.hashes[top]) top += 1;
  let bottom = 0;
  while (bottom < maxBand && previous.hashes[height - 1 - bottom] === next.hashes[height - 1 - bottom]) {
    bottom += 1;
  }

  // 内容区至少保留 30%
  const minContent = Math.max(40, Math.floor(height * 0.3));
  while (top + bottom > height - minContent) {
    if (top >= bottom && top > 0) top -= 1;
    else if (bottom > 0) bottom -= 1;
    else break;
  }

  return { top, bottom };
}

/**
 * 识别左右固定侧栏（聊天列表、文档目录、IDE 侧栏等）。
 * 滚动前后同一 y、同一 x 的像素不变，但该列有明显界面内容时，视为固定侧栏。
 * 纯色空白边距不会被裁掉，保证普通网页仍保留原来的左右留白。
 */
function detectFixedColumns(previous, next, width, height, top, bottom) {
  const rows = bottom - top;
  if (rows < 10) return { left: 0, right: width };

  const rowBytes = width * 4;
  const rowStep = 2;
  const changeCounts = new Uint32Array(width);
  const variationCounts = new Uint32Array(width);
  let samples = 0;
  const topBase = top * rowBytes;

  for (let y = top; y < bottom; y += rowStep) {
    const base = y * rowBytes;
    samples += 1;
    for (let x = 0; x < width; x += 1) {
      const i = base + x * 4;
      if (
        previous[i] !== next[i] ||
        previous[i + 1] !== next[i + 1] ||
        previous[i + 2] !== next[i + 2]
      ) {
        changeCounts[x] += 1;
      }
      const ref = topBase + x * 4;
      if (
        Math.abs(previous[i] - previous[ref]) > 8 ||
        Math.abs(previous[i + 1] - previous[ref + 1]) > 8 ||
        Math.abs(previous[i + 2] - previous[ref + 2]) > 8
      ) {
        variationCounts[x] += 1;
      }
    }
  }

  if (!samples) return { left: 0, right: width };

  let maxChange = 0;
  for (let x = 0; x < width; x += 1) {
    const fraction = changeCounts[x] / samples;
    if (fraction > maxChange) maxChange = fraction;
  }
  // 画面几乎没滚动时无法判断，交给后续匹配逻辑处理
  if (maxChange < 0.05) return { left: 0, right: width };

  const changeThreshold = Math.max(0.03, maxChange * 0.25);
  const variationThreshold = 0.04;
  const isChanging = (x) => changeCounts[x] / samples >= changeThreshold;
  const hasContent = (x) => variationCounts[x] / samples >= variationThreshold;

  let firstChange = -1;
  for (let x = 0; x < width; x += 1) {
    if (isChanging(x)) {
      firstChange = x;
      break;
    }
  }
  let lastChange = -1;
  for (let x = width - 1; x >= 0; x -= 1) {
    if (isChanging(x)) {
      lastChange = x;
      break;
    }
  }
  if (firstChange < 0 || lastChange < firstChange) return { left: 0, right: width };

  let left = 0;
  let right = width;
  let leftSidebar = false;
  for (let x = 0; x < firstChange; x += 1) {
    if (!isChanging(x) && hasContent(x)) {
      leftSidebar = true;
      break;
    }
  }
  if (leftSidebar) left = firstChange;

  let rightSidebar = false;
  for (let x = lastChange + 1; x < width; x += 1) {
    if (!isChanging(x) && hasContent(x)) {
      rightSidebar = true;
      break;
    }
  }
  if (rightSidebar) right = lastChange + 1;

  if (right - left < 40) return { left: 0, right: width };
  return { left, right };
}

/**
 * 识别右侧滚动条：在正确位移下，滚动条所在列会明显比内容列更容易不匹配。
 * 返回需要从宽度中裁掉的物理像素。
 */
function detectRightMargin(
  previous,
  next,
  width,
  height,
  delta,
  top,
  bottom,
  scaleFactor,
  rangeLeft,
  rangeRight
) {
  const left = Math.max(0, Math.min(width - 1, rangeLeft || 0));
  const right = Math.max(left + 1, Math.min(width, rangeRight || width));
  const span = right - left;
  const maxMargin = Math.min(span - 40, Math.max(8, Math.round(30 * (scaleFactor || 1))));
  if (maxMargin <= 8 || bottom - delta - top < 20 || span < 60) return 0;

  const counts = new Uint32Array(width);
  const rowBytes = width * 4;
  const rows = bottom - delta - top;
  if (rows <= 0) return 0;

  for (let y = top; y < bottom - delta; y += 1) {
    const beforeBase = (y + delta) * rowBytes;
    const afterBase = y * rowBytes;
    for (let x = left; x < right; x += 1) {
      const a = beforeBase + x * 4;
      const b = afterBase + x * 4;
      if (
        previous[a] !== next[b] ||
        previous[a + 1] !== next[b + 1] ||
        previous[a + 2] !== next[b + 2]
      ) {
        counts[x] += 1;
      }
    }
  }

  const binSize = 2;
  const contentLimit = right - maxMargin;
  const fractions = [];
  for (let x = left; x < contentLimit; x += binSize) {
    const end = Math.min(x + binSize, contentLimit);
    let sum = 0;
    for (let i = x; i < end; i += 1) sum += counts[i];
    fractions.push(sum / ((end - x) * rows));
  }
  fractions.sort((a, b) => a - b);
  const median = fractions.length ? fractions[Math.floor(fractions.length / 2)] : 0;
  const threshold = Math.max(0.08, median * 3 + 0.03);

  // 找右边缘附近连续的高差异列（允许滚动条右侧有几像素空白轨道）
  const scanStart = Math.max(left, right - maxMargin - 8);
  const bins = [];
  for (let x = scanStart; x < right; x += binSize) {
    const from = Math.max(left, x);
    const end = Math.min(right, from + binSize);
    let sum = 0;
    for (let i = from; i < end; i += 1) sum += counts[i];
    bins.push({ start: from, end, fraction: sum / ((end - from) * rows) });
  }

  let bestBand = null;
  for (let i = 0; i < bins.length; i += 1) {
    if (bins[i].fraction <= threshold) continue;
    let j = i;
    while (j + 1 < bins.length && bins[j + 1].fraction > threshold) j += 1;
    const start = bins[i].start;
    const end = bins[j].end;
    const bandWidth = end - start;
    // 允许滚动条右侧有 <= 8px 的空白轨道，且条带本身不能太宽（避免误裁右侧视频等内容）
    if (bandWidth >= 4 && right - end <= 8) {
      if (!bestBand || bandWidth > bestBand.width) {
        bestBand = { start, width: bandWidth };
      }
    }
    i = j;
  }

  if (!bestBand) return 0;
  const margin = right - bestBand.start;
  return margin >= 4 && margin <= maxMargin + 8 ? margin : 0;
}

/** 从源 bitmap 复制指定行、指定宽度的内容到目标 buffer */
function copyRows(
  source,
  sourceWidth,
  destination,
  destinationWidth,
  destinationY,
  fromY,
  toY,
  copyWidth,
  sourceX = 0
) {
  const rows = toY - fromY;
  if (rows <= 0 || copyWidth <= 0) return;
  if (sourceX === 0 && copyWidth === sourceWidth && destinationWidth === sourceWidth) {
    source.copy(
      destination,
      destinationY * destinationWidth * 4,
      fromY * sourceWidth * 4,
      toY * sourceWidth * 4
    );
    return;
  }
  for (let i = 0; i < rows; i += 1) {
    const sourceOffset = (fromY + i) * sourceWidth * 4 + sourceX * 4;
    const destinationOffset = (destinationY + i) * destinationWidth * 4;
    source.copy(destination, destinationOffset, sourceOffset, sourceOffset + copyWidth * 4);
  }
}

/**
 * 滚动后截一帧并匹配位移，失败时多等一会儿再试一次。
 */
async function captureAfterScroll(session, previous, options) {
  const {
    width,
    height,
    left,
    right,
    top,
    bottom,
    threshold,
    waitMs,
    expectedDelta,
    stableRegion,
  } = options;

  let frame = await captureStable(session, 15, stableRegion);
  if (frame.width !== width || frame.height !== height) {
    return { error: 'size' };
  }

  let profile = buildRowProfile(frame.bitmap, width, height, left, right);
  let match = findScrollDelta(previous, profile, top, bottom, expectedDelta);

  if (!(match.delta > 2) || match.score > threshold) {
    await delay(Math.max(500, waitMs));
    let retryFrame = null;
    try {
      retryFrame = await captureStable(session, 6, stableRegion);
    } catch (err) {
      retryFrame = null;
    }
    if (retryFrame && retryFrame.width === width && retryFrame.height === height) {
      const retryProfile = buildRowProfile(retryFrame.bitmap, width, height, left, right);
      const retryMatch = findScrollDelta(previous, retryProfile, top, bottom, expectedDelta);
      if (retryMatch.delta > 2 && retryMatch.score <= threshold) {
        return { frame: retryFrame, profile: retryProfile, match: retryMatch };
      }
    }
    return { frame, profile, match, failed: true };
  }

  return { frame, profile, match };
}

async function runCapture(session) {
  const current = settings.get();
  const maxNotches = Math.max(1, Math.min(10, current.scrollNotches || 3));
  const waitMs = Math.max(150, Math.min(3000, current.scrollDelayMs || 400));
  const scale = session.scaleFactor || 1;

  // 关键：按显示器做 DIP→物理坐标转换，副屏/混合 DPI 才不会把滚轮发错屏幕
  const dipX = session.displayX + session.rect.x + session.rect.w / 2;
  const dipY = session.displayY + session.rect.y + session.rect.h / 2;
  let target = null;
  try {
    target = screen.dipToScreenPoint({ x: dipX, y: dipY });
  } catch (err) {
    target = null;
  }
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    target = { x: dipX * scale, y: dipY * scale };
  }
  let targetX = Math.round(target.x);
  let targetY = Math.round(target.y);

  const debug = {
    target: { x: targetX, y: targetY },
    wheel: null,
    firstDelta: null,
    firstScore: null,
    bands: null,
    columns: null,
    margin: null,
    steps: 0,
    stopReason: '',
  };
  session.debug = debug;

  progress({ status: '准备中…', steps: 0, height: 0 });
  warmup();
  await delay(300);

  let first;
  try {
    // 先等画面稳定，避免用户刚滑动过、惯性滚动还没结束时取到移动中的第一帧
    first = await captureStable(session, 12, null);
  } catch (err) {
    debug.stopReason = err.message || '屏幕捕获失败';
    return { ok: false, error: err.message || '屏幕捕获失败' };
  }

  const width = first.width;
  const frameHeight = first.height;
  const firstFullProfile = buildRowProfile(first.bitmap, width, frameHeight, 0, width);

  let previousBitmap = first.bitmap;
  let lastFrame = first;
  let bandsKnown = false;
  let contentTop = 0;
  let contentBottom = frameHeight;
  let contentLeft = 0;
  let contentRight = width;
  let contentWidth = width;
  let stitched = null;
  let stitchedHeight = 0;
  let scrolled = false;
  let steps = 0;
  let stopReason = '达到最大滚动次数';
  let pxPerNotch = 100;
  let effectiveNotches = 1;
  let previousProfile = firstFullProfile;

  while (steps < MAX_STEPS) {
    if (state && state.aborted) {
      stopReason = '已手动停止';
      break;
    }

    const notches = bandsKnown ? effectiveNotches : 1;
    const wheel = await wheelAt(targetX, targetY, -120 * notches);
    if (!debug.wheel) debug.wheel = wheel;
    if (!wheel || !wheel.ok) {
      stopReason = '发送滚轮事件失败';
      break;
    }
    await delay(waitMs);

    let frame = null;
    let match = null;
    let profile = null;

    if (!bandsKnown) {
      // 第一次滚动：先识别固定顶部/底部，再在内容区里匹配。
      // 固定栏识别只看同一 y 行是否变化，不依赖位移，避免整帧匹配被固定栏干扰。
      let lastMatch = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          frame = await captureStable(session, attempt === 0 ? 15 : 6, null);
        } catch (err) {
          frame = null;
        }
        if (!frame || frame.width !== width || frame.height !== frameHeight) {
          match = null;
          break;
        }

        const nextFull = buildRowProfile(frame.bitmap, width, frameHeight, 0, width);
        const bands = detectFixedBands(firstFullProfile, nextFull, frameHeight);
        let top = bands.top;
        let bottom = frameHeight - bands.bottom;
        if (bottom - top < 60) {
          top = 0;
          bottom = frameHeight;
        }
        const columns = detectFixedColumns(
          previousBitmap,
          frame.bitmap,
          width,
          frameHeight,
          top,
          bottom
        );
        const contentPrev = buildRowProfile(
          previousBitmap,
          width,
          frameHeight,
          columns.left,
          columns.right
        );
        const contentNext = buildRowProfile(
          frame.bitmap,
          width,
          frameHeight,
          columns.left,
          columns.right
        );
        const attemptMatch = findScrollDelta(contentPrev, contentNext, top, bottom, 0);
        lastMatch = attemptMatch;
        debug.bands = { top: bands.top, bottom: bands.bottom };
        debug.columns = { left: columns.left, right: columns.right };
        debug.firstDelta = attemptMatch.delta;
        debug.firstScore = attemptMatch.score;
        if (process.env.CUTTING_DEBUG_SCROLL) {
          console.log(
            `[scroll] first bands top=${bands.top} bottom=${bands.bottom} columns=${columns.left}..${columns.right}`
          );
        }
        if (attemptMatch.delta > 2 && attemptMatch.score <= BAND_MATCH_SCORE) {
          contentTop = top;
          contentBottom = bottom;
          contentLeft = columns.left;
          contentRight = columns.right;
          match = attemptMatch;
          profile = contentNext;
          break;
        }

        if (attempt === 0) await delay(Math.max(500, waitMs));
      }

      if (!match) {
        if (lastMatch && lastMatch.delta <= 2) {
          stopReason = '内容已滚动到底部';
        } else if (debug.wheel && debug.wheel.focused === false) {
          stopReason = '滚轮未发送到目标窗口，请重试';
        } else if (lastMatch && lastMatch.score > BAND_MATCH_SCORE) {
          stopReason = '画面变化过大，无法匹配（请避开动画区域）';
        } else {
          stopReason = '无法识别滚动画面，已停止';
        }
        break;
      }

      // 识别右侧滚动条，匹配和最终图片都裁掉它
      const margin = detectRightMargin(
        previousBitmap,
        frame.bitmap,
        width,
        frameHeight,
        match.delta,
        contentTop,
        contentBottom,
        scale,
        contentLeft,
        contentRight
      );
      contentWidth = Math.max(40, contentRight - contentLeft - margin);
      debug.margin = margin;
      if (process.env.CUTTING_DEBUG_SCROLL) {
        console.log(
          `[scroll] scrollbar margin=${margin} content=${contentLeft}..${contentLeft + contentWidth}`
        );
      }

      // 用裁掉滚动条后的内容区再确认一次位移
      const croppedPrev = buildRowProfile(
        previousBitmap,
        width,
        frameHeight,
        contentLeft,
        contentLeft + contentWidth
      );
      const croppedNext = buildRowProfile(
        frame.bitmap,
        width,
        frameHeight,
        contentLeft,
        contentLeft + contentWidth
      );
      const croppedMatch = findScrollDelta(
        croppedPrev,
        croppedNext,
        contentTop,
        contentBottom,
        match.delta
      );
      if (croppedMatch.delta > 2 && croppedMatch.score <= MATCH_SCORE) {
        match = croppedMatch;
        profile = croppedNext;
      } else if (margin === 0 && match.score <= BAND_MATCH_SCORE) {
        // 没检测到滚动条时，允许保留原匹配（可能有少量动态内容，但没有可裁的滚动条）
        contentWidth = Math.max(40, contentRight - contentLeft);
        profile = buildRowProfile(frame.bitmap, width, frameHeight, contentLeft, contentRight);
      } else {
        stopReason = '无法识别滚动画面（内容区变化过大）';
        match = null;
      }

      if (!match) break;

      // 后续滚轮目标改为内容区中心，避免鼠标落在固定侧栏上
      const centerFx = (contentLeft + contentWidth / 2) / width;
      const centerFy = (contentTop + (contentBottom - contentTop) / 2) / frameHeight;
      const centerDipX = session.displayX + session.rect.x + centerFx * session.rect.w;
      const centerDipY = session.displayY + session.rect.y + centerFy * session.rect.h;
      let centerPhysical = null;
      try {
        centerPhysical = screen.dipToScreenPoint({ x: centerDipX, y: centerDipY });
      } catch (err) {
        centerPhysical = null;
      }
      if (
        centerPhysical &&
        Number.isFinite(centerPhysical.x) &&
        Number.isFinite(centerPhysical.y)
      ) {
        targetX = Math.round(centerPhysical.x);
        targetY = Math.round(centerPhysical.y);
      } else {
        targetX = Math.round(centerDipX * scale);
        targetY = Math.round(centerDipY * scale);
      }

      const contentHeight = contentBottom - contentTop;
      const fixedBottom = frameHeight - contentBottom;
      const maxContent = Math.max(1, MAX_HEIGHT - contentTop - fixedBottom);
      stitched = Buffer.alloc(contentWidth * maxContent * 4);

      copyRows(
        first.bitmap,
        width,
        stitched,
        contentWidth,
        0,
        contentTop,
        contentBottom,
        contentWidth,
        contentLeft
      );
      stitchedHeight = contentHeight;

      const firstDelta = match.delta;
      copyRows(
        frame.bitmap,
        width,
        stitched,
        contentWidth,
        stitchedHeight,
        contentBottom - firstDelta,
        contentBottom,
        contentWidth,
        contentLeft
      );
      stitchedHeight += firstDelta;
      scrolled = true;

      previousBitmap = frame.bitmap;
      lastFrame = frame;
      previousProfile = profile;
      bandsKnown = true;
      steps += 1;
      pxPerNotch = Math.max(20, Math.min(800, Math.round(firstDelta)));
      effectiveNotches = Math.max(
        1,
        Math.min(maxNotches, Math.floor((contentHeight * 0.35) / Math.max(30, pxPerNotch)))
      );
      progress({
        status: '正在滚动…',
        steps,
        height: contentTop + stitchedHeight + fixedBottom,
      });
      continue;
    }

    // 后续步骤：内容区、滚动条、固定栏都已确定
    let result = null;
    try {
      result = await captureAfterScroll(session, previousProfile, {
        width,
        height: frameHeight,
        left: contentLeft,
        right: contentLeft + contentWidth,
        top: contentTop,
        bottom: contentBottom,
        threshold: MATCH_SCORE,
        waitMs,
        expectedDelta: pxPerNotch * notches,
        stableRegion: {
          left: contentLeft,
          top: contentTop,
          right: contentLeft + contentWidth,
          bottom: contentBottom,
        },
      });
    } catch (err) {
      stopReason = '屏幕捕获失败';
      break;
    }

    if (result.error === 'size') {
      stopReason = '画面尺寸变化，已停止';
      break;
    }
    if (result.failed) {
      stopReason =
        result.match && result.match.delta <= 2 ? '内容已滚动到底部' : '无法识别滚动画面，已停止';
      break;
    }

    // 后续步骤：内容区、滚动条、固定栏都已确定
    const delta = result.match.delta;
    const measured = delta / Math.max(1, notches);
    if (measured >= 20 && measured <= 800) {
      pxPerNotch = Math.round(pxPerNotch * 0.6 + measured * 0.4);
    }
    const contentHeight = contentBottom - contentTop;
    effectiveNotches = Math.max(
      1,
      Math.min(maxNotches, Math.floor((contentHeight * 0.35) / Math.max(30, pxPerNotch)))
    );

    const fixedBottom = frameHeight - contentBottom;
    const maxContent = Math.max(1, MAX_HEIGHT - contentTop - fixedBottom);
    if (stitchedHeight + delta > maxContent) {
      const allowed = Math.max(0, maxContent - stitchedHeight);
      if (allowed > 0) {
        copyRows(
          result.frame.bitmap,
          width,
          stitched,
          contentWidth,
          stitchedHeight,
          contentBottom - delta,
          contentBottom - delta + allowed,
          contentWidth,
          contentLeft
        );
        stitchedHeight += allowed;
      }
      stopReason = '已达到最大截图高度';
      break;
    }

    copyRows(
      result.frame.bitmap,
      width,
      stitched,
      contentWidth,
      stitchedHeight,
      contentBottom - delta,
      contentBottom,
      contentWidth,
      contentLeft
    );
    stitchedHeight += delta;
    scrolled = true;

    previousBitmap = result.frame.bitmap;
    lastFrame = result.frame;
    previousProfile = result.profile;
    steps += 1;
    progress({
      status: '正在滚动…',
      steps,
      height: contentTop + stitchedHeight + fixedBottom,
    });
  }

  debug.steps = steps;
  debug.stopReason = stopReason;

  if (!scrolled || stitchedHeight <= 0) {
    return {
      ok: false,
      error: stopReason === '内容已滚动到底部' ? '页面没有可滚动的内容' : stopReason,
    };
  }

  const fixedTop = contentTop;
  const fixedBottom = frameHeight - contentBottom;
  const finalWidth = contentWidth;
  const finalHeight = fixedTop + stitchedHeight + fixedBottom;
  if (finalHeight <= 0) return { ok: false, error: '拼接结果为空' };

  const finalBuffer = Buffer.alloc(finalWidth * finalHeight * 4);
  if (fixedTop > 0) {
    copyRows(
      first.bitmap,
      width,
      finalBuffer,
      finalWidth,
      0,
      0,
      fixedTop,
      finalWidth,
      contentLeft
    );
  }
  stitched.copy(
    finalBuffer,
    fixedTop * finalWidth * 4,
    0,
    stitchedHeight * finalWidth * 4
  );
  if (fixedBottom > 0 && lastFrame) {
    copyRows(
      lastFrame.bitmap,
      width,
      finalBuffer,
      finalWidth,
      fixedTop + stitchedHeight,
      contentBottom,
      frameHeight,
      finalWidth,
      contentLeft
    );
  }

  let image;
  try {
    image = nativeImage.createFromBitmap(finalBuffer, {
      width: finalWidth,
      height: finalHeight,
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
      width: finalWidth,
      height: finalHeight,
      scaleFactor: 1,
      note: '滚动截图',
    });
  } catch (err) {
    console.error('[scroll] 写入历史失败:', err);
  }

  return {
    ok: true,
    filePath,
    width: finalWidth,
    height: finalHeight,
    steps,
    stopReason,
  };
}

function start({ rect, displayId, displayBounds, displayX, displayY, scaleFactor }) {
  if (win || (state && state.running)) return { ok: false, error: '滚动截图正在运行' };
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return { ok: false, error: '选区无效' };

  state = { aborted: false, running: true };
  controlShown = false;
  controlFallback = false;

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

  let placement;
  try {
    placement = createControlWindow(rect, displayX, displayY, displayBounds);
  } catch (err) {
    console.error('[scroll] 创建控制窗口失败:', err);
    destroyFrame();
    state = null;
    return { ok: false, error: err.message || '创建控制窗口失败' };
  }

  // 控制条会覆盖选区时隐藏它，用全局 Esc 停止
  const escOk = registerEsc();
  if (placement.overlap && !escOk) {
    controlFallback = true;
    tray.notify('滚动截图', '控制条无法避开选区，且 Esc 被占用，请点击控制条停止');
  } else if (placement.overlap) {
    tray.notify('滚动截图', '正在滚动截图，按 Esc 停止');
  }

  const session = {
    rect: { ...rect },
    displayId,
    displayBounds: { ...displayBounds },
    displayX,
    displayY,
    scaleFactor,
  };

  runCapture(session)
    .then((result) => {
      writeScrollLog(session, session.debug, result);
      if (win && !win.isDestroyed()) {
        win.webContents.send('scroll:done', result);
        setTimeout(() => close(), result.ok ? 900 : 1800);
      }
      if (!controlShown) {
        if (result && result.ok) {
          tray.notify('滚动截图完成', `${result.width} × ${result.height} px`);
        } else if (result) {
          tray.notify('滚动截图未完成', result.error || '未知错误');
        }
      }
      if (result && !result.ok) {
        console.error('[scroll] 失败:', result.error);
      }
    })
    .catch((err) => {
      console.error('[scroll] 异常:', err);
      const failure = { ok: false, error: err.message || '滚动截图失败' };
      writeScrollLog(session, session.debug, failure);
      if (win && !win.isDestroyed()) {
        win.webContents.send('scroll:done', failure);
        setTimeout(() => close(), 1800);
      }
      if (!controlShown) {
        tray.notify('滚动截图未完成', err.message || '滚动截图失败');
      }
    })
    .finally(() => {
      if (state) state.running = false;
      state = null;
    });

  return { ok: true };
}

function abort() {
  if (state) state.aborted = true;
  return { ok: true };
}

function destroyFrame() {
  if (!frameHandle) return;
  try {
    frameHandle.destroy();
  } catch (err) {
    // ignore
  }
  frameHandle = null;
}

function close() {
  if (state) state.aborted = true;
  unregisterEsc();
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
  return {
    active: !!win,
    settings: { notches: settings.get().scrollNotches, delayMs: settings.get().scrollDelayMs },
  };
}

module.exports = { start, abort, close, getInit, destroyFrame, current: () => ({ active: !!win }) };
