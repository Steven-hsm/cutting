'use strict';

const { app, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const settings = require('./settings');
const clipboardHelper = require('./clipboard');

let dir = '';
let thumbDir = '';
let indexPath = '';
let index = { version: 1, entries: [] };
let listeners = [];
let writeChain = Promise.resolve();

function init() {
  dir = path.join(app.getPath('userData'), 'history');
  thumbDir = path.join(dir, 'thumbs');
  indexPath = path.join(dir, 'index.json');
  fs.mkdirSync(thumbDir, { recursive: true });
  loadIndex();
}

function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (raw && Array.isArray(raw.entries)) {
      index = {
        version: raw.version || 1,
        entries: raw.entries.map((entry) => ({
          ...entry,
          favorite: !!entry.favorite,
          note: typeof entry.note === 'string' ? entry.note : '',
        })),
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try {
        fs.renameSync(indexPath, `${indexPath}.bak`);
      } catch (renameErr) {
        // ignore
      }
    }
    index = { version: 1, entries: [] };
  }
}

function persist() {
  const data = JSON.stringify(index, null, 2);
  writeChain = writeChain
    .then(async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${indexPath}.tmp`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, indexPath);
    })
    .catch((err) => {
      console.error('[historyStore] 写入索引失败:', err);
    });
  return writeChain;
}

function emitChange() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // ignore
    }
  }
}

function onChanged(listener) {
  listeners.push(listener);
}

function trim() {
  const limit = Math.max(10, settings.get().historyLimit || 200);
  while (index.entries.length > limit) {
    const removed = index.entries.pop();
    if (removed && removed.thumbPath) {
      try {
        fs.unlinkSync(removed.thumbPath);
      } catch (err) {
        // ignore
      }
    }
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    return 0;
  }
}

/**
 * 按当前设置的上限裁剪历史（用于用户调低上限后立即生效）。
 */
function applyLimit() {
  const before = index.entries.length;
  trim();
  if (index.entries.length !== before) {
    persist();
    emitChange();
  }
  return { removed: before - index.entries.length };
}

function add({ image, filePath, width, height, scaleFactor, note, type, region }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Date.now();

  let thumbPath = '';
  try {
    const size = image.getSize();
    const thumb = size.width > 320 ? image.resize({ width: 320, quality: 'good' }) : image;
    thumbPath = path.join(thumbDir, `${id}.png`);
    fs.writeFileSync(thumbPath, thumb.toPNG());
  } catch (err) {
    console.error('[historyStore] 生成缩略图失败:', err);
    thumbPath = '';
  }

  const entry = {
    id,
    createdAt,
    filePath,
    width: width || image.getSize().width,
    height: height || image.getSize().height,
    bytes: fileSize(filePath),
    thumbPath,
    scaleFactor: Number(scaleFactor) || 1,
    note: typeof note === 'string' ? note : '',
    type: type === 'gif' ? 'gif' : 'image',
    // 截图/录制区域（屏幕 DIP 坐标），用于贴图时贴回原位置
    region:
      region && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(region[key]))
        ? { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) }
        : null,
    favorite: false,
  };

  index.entries.unshift(entry);
  trim();
  persist();
  emitChange();
  return entry;
}

function list() {
  return index.entries.map((entry) => ({
    ...entry,
    type: entry.type === 'gif' ? 'gif' : 'image',
    thumbUrl:
      entry.thumbPath && fs.existsSync(entry.thumbPath)
        ? pathToFileURL(entry.thumbPath).href
        : '',
    fileExists: !!entry.filePath && fs.existsSync(entry.filePath),
  }));
}

function find(id) {
  return index.entries.find((entry) => entry.id === id) || null;
}

async function copy(id) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '记录不存在' };
  if (!entry.filePath || !fs.existsSync(entry.filePath)) {
    return { ok: false, error: '原图已被移动或删除' };
  }
  try {
    if (entry.type === 'gif') {
      const ok = await clipboardHelper.writeFileToClipboard(entry.filePath);
      return ok
        ? { ok: true, kind: 'file' }
        : { ok: false, error: '复制 GIF 文件失败' };
    }

    const image = nativeImage.createFromPath(entry.filePath);
    if (image.isEmpty()) return { ok: false, error: '图片读取失败' };

    const isJpeg = /\.jpe?g$/i.test(entry.filePath);
    const mime = isJpeg ? 'image/jpeg' : 'image/png';
    const buffer = fs.readFileSync(entry.filePath);
    await clipboardHelper.writeImageBuffer(buffer, mime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '复制失败' };
  }
}

function reveal(id) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '记录不存在' };
  if (!entry.filePath || !fs.existsSync(entry.filePath)) {
    return { ok: false, error: '原图已被移动或删除' };
  }
  shell.showItemInFolder(entry.filePath);
  return { ok: true };
}

function setFavorite(id, favorite) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '记录不存在' };
  entry.favorite = !!favorite;
  persist();
  emitChange();
  return { ok: true, favorite: entry.favorite };
}

function remove(id) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '记录不存在' };
  index.entries = index.entries.filter((item) => item.id !== id);
  if (entry.thumbPath) {
    try {
      fs.unlinkSync(entry.thumbPath);
    } catch (err) {
      // ignore
    }
  }
  persist();
  emitChange();
  return { ok: true };
}

module.exports = {
  init,
  getDir: () => dir,
  add,
  applyLimit,
  find,
  list,
  copy,
  reveal,
  remove,
  setFavorite,
  onChanged,
};
