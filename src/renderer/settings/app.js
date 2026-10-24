'use strict';

const captureInput = document.getElementById('capture-shortcut');
const pinClipboardInput = document.getElementById('pin-clipboard-shortcut');
const historyInput = document.getElementById('history-shortcut');
const historyDirInput = document.getElementById('history-dir-shortcut');
const saveDirInput = document.getElementById('save-dir');
const historyLimitInput = document.getElementById('history-limit');
const autoStartInput = document.getElementById('auto-start');
const historyOnTopInput = document.getElementById('history-on-top');
const captureDelaySelect = document.getElementById('capture-delay');
const afterCaptureSelect = document.getElementById('after-capture');
const imageFormatSelect = document.getElementById('image-format');
const imageQualityInput = document.getElementById('image-quality');
const fileTemplateInput = document.getElementById('file-template');
const scrollNotchesSelect = document.getElementById('scroll-notches');
const scrollDelaySelect = document.getElementById('scroll-delay');
const beautifyEnabledInput = document.getElementById('beautify-enabled');
const beautifyBackgroundSelect = document.getElementById('beautify-background');
const beautifyGradientSelect = document.getElementById('beautify-gradient');
const beautifyColorInput = document.getElementById('beautify-color');
const beautifyPaddingInput = document.getElementById('beautify-padding');
const beautifyRadiusInput = document.getElementById('beautify-radius');
const beautifyShadowInput = document.getElementById('beautify-shadow');
const beautifyWatermarkInput = document.getElementById('beautify-watermark');
const statusEl = document.getElementById('status');

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

const NAMED_KEYS = {
  ' ': 'Space',
  Spacebar: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
};

const PUNCTUATION = {
  '-': '-',
  '=': '=',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
};

function keyName(event) {
  const key = event.key;
  if (!key) return null;
  if (key.length === 1) {
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    return PUNCTUATION[key] || null;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return NAMED_KEYS[key] || null;
}

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function beginRecording(input) {
  input.dataset.value = input.dataset.value || '';
  input.dataset.recording = '1';
  input.classList.add('recording');
  input.value = '请按下快捷键…';
  input.focus();
}

function stopRecording(input, restore) {
  delete input.dataset.recording;
  input.classList.remove('recording');
  if (restore) {
    input.value = input.dataset.value || '';
  }
}

function setupRecorder(input) {
  input.readOnly = true;
  input.dataset.value = '';

  input.addEventListener('click', () => {
    if (input.dataset.recording) return;
    beginRecording(input);
  });

  input.addEventListener('blur', () => {
    if (input.dataset.recording) stopRecording(input, true);
  });

  input.addEventListener('keydown', (event) => {
    if (!input.dataset.recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      stopRecording(input, true);
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      input.dataset.value = '';
      input.value = '';
      stopRecording(input, false);
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) return;

    const baseKey = keyName(event);
    if (!baseKey) return;

    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Super');

    const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(baseKey);
    if (!modifiers.length && !isFunctionKey) {
      setStatus('快捷键至少需要包含 Ctrl / Alt / Shift 中的一个', true);
      return;
    }

    const accelerator = [...modifiers, baseKey].join('+');
    input.dataset.value = accelerator;
    input.value = accelerator;
    stopRecording(input, false);
    setStatus('快捷键已记录，点击"保存设置"生效');
  });
}

function setRecorderValue(input, value) {
  input.dataset.value = value || '';
  input.value = value || '';
}

async function load() {
  let result = null;
  try {
    result = await window.api.settings.get();
  } catch (err) {
    setStatus('读取设置失败', true);
    return;
  }

  const settings = result.settings;
  setRecorderValue(captureInput, settings.shortcuts.capture);
  setRecorderValue(pinClipboardInput, settings.shortcuts.pinClipboard);
  setRecorderValue(historyInput, settings.shortcuts.history);
  setRecorderValue(historyDirInput, settings.shortcuts.historyDir);
  saveDirInput.value = settings.saveDir || '';
  historyLimitInput.value = settings.historyLimit || 200;
  autoStartInput.checked = !!settings.autoStart;
  autoStartInput.disabled = !result.isPackaged;
  historyOnTopInput.checked = !!settings.historyOnTop;
  captureDelaySelect.value = String(settings.captureDelay || 0);
  afterCaptureSelect.value = settings.afterCapture || 'save-copy';
  imageFormatSelect.value = settings.imageFormat || 'png';
  imageQualityInput.value = settings.imageQuality || 90;
  fileTemplateInput.value = settings.fileNameTemplate || 'screenshot_{yyyy}{MM}{dd}_{HH}{mm}{ss}';
  scrollNotchesSelect.value = String(settings.scrollNotches || 3);
  scrollDelaySelect.value = String(settings.scrollDelayMs || 400);
  applyBeautify(settings.beautify || {});
  updateQualityState();
  updateBeautifyState();
}

function applyBeautify(beautify) {
  beautifyEnabledInput.checked = !!beautify.enabled;
  beautifyBackgroundSelect.value = beautify.background || 'gradient';
  beautifyGradientSelect.value = beautify.gradient || 'ocean';
  beautifyColorInput.value = beautify.color || '#1f2937';
  beautifyPaddingInput.value = Number.isFinite(beautify.padding) ? beautify.padding : 24;
  beautifyRadiusInput.value = Number.isFinite(beautify.radius) ? beautify.radius : 12;
  beautifyShadowInput.checked = beautify.shadow !== false;
  beautifyWatermarkInput.value = beautify.watermark || '';
}

function updateBeautifyState() {
  const enabled = beautifyEnabledInput.checked;
  const background = beautifyBackgroundSelect.value;
  beautifyGradientSelect.disabled = !enabled || background !== 'gradient';
  beautifyColorInput.disabled = !enabled || background !== 'solid';
  beautifyPaddingInput.disabled = !enabled;
  beautifyRadiusInput.disabled = !enabled;
  beautifyShadowInput.disabled = !enabled || background === 'transparent';
  beautifyWatermarkInput.disabled = !enabled;
}

function collectBeautify() {
  return {
    enabled: beautifyEnabledInput.checked,
    background: beautifyBackgroundSelect.value,
    gradient: beautifyGradientSelect.value,
    color: beautifyColorInput.value,
    padding: Number(beautifyPaddingInput.value) || 0,
    radius: Number(beautifyRadiusInput.value) || 0,
    shadow: beautifyShadowInput.checked,
    watermark: beautifyWatermarkInput.value || '',
  };
}

function updateQualityState() {
  const format = imageFormatSelect.value;
  imageQualityInput.disabled = format === 'png';
}

async function save() {
  const capture = captureInput.dataset.value || '';
  const pinClipboard = pinClipboardInput.dataset.value || '';
  const history = historyInput.dataset.value || '';
  const historyDir = historyDirInput.dataset.value || '';

  const limit = Number(historyLimitInput.value);
  if (!Number.isFinite(limit) || limit < 10 || limit > 2000) {
    setStatus('历史记录上限需在 10 - 2000 之间', true);
    return;
  }

  const quality = Number(imageQualityInput.value);
  if (!Number.isFinite(quality) || quality < 30 || quality > 100) {
    setStatus('压缩质量需在 30 - 100 之间', true);
    return;
  }

  if (!fileTemplateInput.value.trim()) {
    setStatus('文件名模板不能为空', true);
    return;
  }

  setStatus('保存中…');

  let result = null;
  try {
    result = await window.api.settings.save({
      shortcuts: { capture, pinClipboard, history, historyDir },
      saveDir: saveDirInput.value,
      autoStart: autoStartInput.checked,
      historyLimit: Math.round(limit),
      historyOnTop: historyOnTopInput.checked,
      captureDelay: Number(captureDelaySelect.value),
      afterCapture: afterCaptureSelect.value,
      imageFormat: imageFormatSelect.value,
      imageQuality: Math.round(quality),
      fileNameTemplate: fileTemplateInput.value,
      scrollNotches: Number(scrollNotchesSelect.value),
      scrollDelayMs: Number(scrollDelaySelect.value),
      beautify: collectBeautify(),
    });
  } catch (err) {
    setStatus(`保存失败：${err && err.message ? err.message : err}`, true);
    return;
  }

  if (!result || !result.ok) {
    setStatus((result && result.error) || '保存失败', true);
    return;
  }

  const settings = result.settings;
  setRecorderValue(captureInput, settings.shortcuts.capture);
  setRecorderValue(pinClipboardInput, settings.shortcuts.pinClipboard);
  setRecorderValue(historyInput, settings.shortcuts.history);
  setRecorderValue(historyDirInput, settings.shortcuts.historyDir);
  saveDirInput.value = settings.saveDir;
  historyLimitInput.value = settings.historyLimit;
  historyOnTopInput.checked = !!settings.historyOnTop;
  captureDelaySelect.value = String(settings.captureDelay || 0);
  afterCaptureSelect.value = settings.afterCapture || 'save-copy';
  imageFormatSelect.value = settings.imageFormat || 'png';
  imageQualityInput.value = settings.imageQuality || 90;
  fileTemplateInput.value = settings.fileNameTemplate;
  scrollNotchesSelect.value = String(settings.scrollNotches || 3);
  scrollDelaySelect.value = String(settings.scrollDelayMs || 400);
  applyBeautify(settings.beautify || {});
  updateQualityState();
  updateBeautifyState();
  setStatus('已保存');
}

document.getElementById('btn-browse').addEventListener('click', async () => {
  const result = await window.api.settings.chooseDir();
  if (result && result.ok) {
    saveDirInput.value = result.path;
    setStatus('已选择目录，点击"保存设置"生效');
  }
});

document.getElementById('btn-open-dir').addEventListener('click', async () => {
  const result = await window.api.app.openSaveDir();
  if (result && !result.ok) setStatus(result.error || '无法打开目录', true);
});

document.getElementById('btn-save').addEventListener('click', save);

imageFormatSelect.addEventListener('change', updateQualityState);
beautifyEnabledInput.addEventListener('change', updateBeautifyState);
beautifyBackgroundSelect.addEventListener('change', updateBeautifyState);

// 窗口重新聚焦时同步设置；正在录制快捷键时不打断
window.api.settings.onReload(() => {
  if (captureInput.dataset.recording || historyInput.dataset.recording) return;
  if (document.activeElement && document.activeElement.dataset) {
    if (document.activeElement.dataset.recording) return;
  }
  load();
});

setupRecorder(captureInput);
setupRecorder(pinClipboardInput);
setupRecorder(historyInput);
setupRecorder(historyDirInput);
load();
