'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 旧版默认快捷键，用于升级时自动迁移到新默认值
const LEGACY_CAPTURE = 'Ctrl+Alt+A';
const LEGACY_HISTORY = 'Ctrl+Alt+H';

const DEFAULTS = {
  version: 3,
  shortcuts: {
    capture: 'F1',
    pinClipboard: 'F3',
    history: LEGACY_HISTORY,
    historyDir: 'Ctrl+Alt+D',
  },
  autoStart: false,
  historyLimit: 200,
  historyOnTop: true,
  captureDelay: 0,
  afterCapture: 'save-copy',
  imageFormat: 'png',
  imageQuality: 90,
  fileNameTemplate: 'screenshot_{yyyy}{MM}{dd}_{HH}{mm}{ss}',
  scrollNotches: 3,
  scrollDelayMs: 400,
  beautify: {
    enabled: false,
    background: 'gradient',
    gradient: 'ocean',
    color: '#1f2937',
    padding: 24,
    radius: 12,
    shadow: true,
    watermark: '',
  },
  lastRegion: null,
};

const BEAUTIFY_BACKGROUNDS = new Set(['transparent', 'solid', 'gradient']);
const GRADIENTS = new Set(['ocean', 'sunset', 'forest', 'grape', 'graphite']);

function normalizeBeautify(raw, base) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const fallback = base || DEFAULTS.beautify;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    background: BEAUTIFY_BACKGROUNDS.has(source.background)
      ? source.background
      : fallback.background,
    gradient: GRADIENTS.has(source.gradient) ? source.gradient : fallback.gradient,
    color: typeof source.color === 'string' ? source.color : fallback.color,
    padding: Number.isFinite(source.padding)
      ? Math.min(200, Math.max(0, Math.round(source.padding)))
      : fallback.padding,
    radius: Number.isFinite(source.radius)
      ? Math.min(64, Math.max(0, Math.round(source.radius)))
      : fallback.radius,
    shadow: typeof source.shadow === 'boolean' ? source.shadow : fallback.shadow,
    watermark:
      typeof source.watermark === 'string'
        ? source.watermark.slice(0, 80)
        : fallback.watermark,
  };
}

const AFTER_CAPTURE = new Set(['save-copy', 'save', 'copy', 'pin']);
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp']);

let cache = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSaveDir() {
  let base;
  try {
    base = app.getPath('pictures');
  } catch (err) {
    base = app.getPath('home');
  }
  return path.join(base, 'Cutting');
}

function defaults() {
  return {
    ...DEFAULTS,
    shortcuts: { ...DEFAULTS.shortcuts },
    saveDir: defaultSaveDir(),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;

  const out = { ...base };

  if (raw.shortcuts && typeof raw.shortcuts === 'object') {
    out.shortcuts = {
      capture: typeof raw.shortcuts.capture === 'string' ? raw.shortcuts.capture : base.shortcuts.capture,
      pinClipboard:
        typeof raw.shortcuts.pinClipboard === 'string'
          ? raw.shortcuts.pinClipboard
          : base.shortcuts.pinClipboard,
      history: typeof raw.shortcuts.history === 'string' ? raw.shortcuts.history : base.shortcuts.history,
      historyDir:
        typeof raw.shortcuts.historyDir === 'string'
          ? raw.shortcuts.historyDir
          : base.shortcuts.historyDir,
    };

    // 升级迁移：仍为旧默认值的配置切换到新默认快捷键
    if (
      !Object.prototype.hasOwnProperty.call(raw.shortcuts, 'pinClipboard') &&
      out.shortcuts.capture === LEGACY_CAPTURE &&
      out.shortcuts.history === LEGACY_HISTORY
    ) {
      out.shortcuts.capture = base.shortcuts.capture;
      out.shortcuts.pinClipboard = base.shortcuts.pinClipboard;
    }
  }
  if (typeof raw.saveDir === 'string' && raw.saveDir.trim()) {
    out.saveDir = raw.saveDir.trim();
  }
  out.autoStart = !!raw.autoStart;
  if (Number.isFinite(raw.historyLimit)) {
    out.historyLimit = Math.min(2000, Math.max(10, Math.round(raw.historyLimit)));
  }
  if (typeof raw.historyOnTop === 'boolean') {
    out.historyOnTop = raw.historyOnTop;
  }

  if (Number.isFinite(raw.captureDelay)) {
    out.captureDelay = Math.min(30, Math.max(0, Math.round(raw.captureDelay)));
  }
  if (AFTER_CAPTURE.has(raw.afterCapture)) {
    out.afterCapture = raw.afterCapture;
  }
  if (IMAGE_FORMATS.has(raw.imageFormat)) {
    out.imageFormat = raw.imageFormat;
  }
  if (Number.isFinite(raw.imageQuality)) {
    out.imageQuality = Math.min(100, Math.max(30, Math.round(raw.imageQuality)));
  }
  if (typeof raw.fileNameTemplate === 'string' && raw.fileNameTemplate.trim()) {
    out.fileNameTemplate = raw.fileNameTemplate.trim().slice(0, 120);
  }
  if (Number.isFinite(raw.scrollNotches)) {
    out.scrollNotches = Math.min(10, Math.max(1, Math.round(raw.scrollNotches)));
  }
  if (Number.isFinite(raw.scrollDelayMs)) {
    out.scrollDelayMs = Math.min(3000, Math.max(150, Math.round(raw.scrollDelayMs)));
  }
  out.beautify = normalizeBeautify(raw.beautify, base.beautify);
  if (
    raw.lastRegion &&
    typeof raw.lastRegion === 'object' &&
    Number.isFinite(raw.lastRegion.displayId) &&
    raw.lastRegion.rect &&
    ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(raw.lastRegion.rect[key]))
  ) {
    out.lastRegion = {
      displayId: raw.lastRegion.displayId,
      rect: {
        x: raw.lastRegion.rect.x,
        y: raw.lastRegion.rect.y,
        w: raw.lastRegion.rect.w,
        h: raw.lastRegion.rect.h,
      },
    };
  }

  out.version = 3;
  return out;
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err) {
    raw = null;
  }
  cache = normalize(raw);

  // 旧配置（缺少新字段/旧版默认快捷键）迁移后写回磁盘
  const needsMigration =
    raw &&
    (raw.version !== DEFAULTS.version ||
      !raw.shortcuts ||
      !Object.prototype.hasOwnProperty.call(raw.shortcuts, 'pinClipboard') ||
      !Object.prototype.hasOwnProperty.call(raw.shortcuts, 'historyDir'));
  if (needsMigration) {
    try {
      persist(cache);
    } catch (err) {
      console.error('[settings] 迁移写回失败:', err);
    }
  }

  return cache;
}

function get() {
  return clone(load());
}

function persist(data) {
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function save(patch) {
  const current = load();
  const merged = clone(current);

  if (patch && typeof patch === 'object') {
    if (patch.shortcuts && typeof patch.shortcuts === 'object') {
      merged.shortcuts = {
        capture: typeof patch.shortcuts.capture === 'string' ? patch.shortcuts.capture : current.shortcuts.capture,
        pinClipboard:
          typeof patch.shortcuts.pinClipboard === 'string'
            ? patch.shortcuts.pinClipboard
            : current.shortcuts.pinClipboard,
        history: typeof patch.shortcuts.history === 'string' ? patch.shortcuts.history : current.shortcuts.history,
        historyDir:
          typeof patch.shortcuts.historyDir === 'string'
            ? patch.shortcuts.historyDir
            : current.shortcuts.historyDir,
      };
    }
    if (typeof patch.saveDir === 'string' && patch.saveDir.trim()) {
      merged.saveDir = patch.saveDir.trim();
    }
    if (typeof patch.autoStart === 'boolean') {
      merged.autoStart = patch.autoStart;
    }
    if (Number.isFinite(patch.historyLimit)) {
      merged.historyLimit = patch.historyLimit;
    }
    if (typeof patch.historyOnTop === 'boolean') {
      merged.historyOnTop = patch.historyOnTop;
    }
    if (Number.isFinite(patch.captureDelay)) {
      merged.captureDelay = patch.captureDelay;
    }
    if (typeof patch.afterCapture === 'string') {
      merged.afterCapture = patch.afterCapture;
    }
    if (typeof patch.imageFormat === 'string') {
      merged.imageFormat = patch.imageFormat;
    }
    if (Number.isFinite(patch.imageQuality)) {
      merged.imageQuality = patch.imageQuality;
    }
    if (typeof patch.fileNameTemplate === 'string') {
      merged.fileNameTemplate = patch.fileNameTemplate;
    }
    if (Number.isFinite(patch.scrollNotches)) {
      merged.scrollNotches = patch.scrollNotches;
    }
    if (Number.isFinite(patch.scrollDelayMs)) {
      merged.scrollDelayMs = patch.scrollDelayMs;
    }
    if (patch.beautify && typeof patch.beautify === 'object') {
      merged.beautify = normalizeBeautify(patch.beautify, merged.beautify);
    }
    if (patch.lastRegion === null) {
      merged.lastRegion = null;
    } else if (patch.lastRegion && typeof patch.lastRegion === 'object') {
      merged.lastRegion = patch.lastRegion;
    }
  }

  cache = normalize(merged);
  persist(cache);
  return get();
}

function exists() {
  return fs.existsSync(settingsPath());
}

module.exports = {
  load,
  get,
  save,
  normalizeBeautify,
  exists,
  normalize,
  defaultSaveDir,
  settingsPath,
};
