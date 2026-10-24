'use strict';

const { desktopCapturer } = require('electron');

/**
 * 抓取指定显示器（鼠标所在屏）的全屏图像。
 * thumbnailSize 必须是物理像素（DIP × scaleFactor），否则高 DPI 屏会得到模糊小图。
 */
async function captureDisplay(display) {
  const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
  const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    throw new Error('没有可用的屏幕捕获源');
  }

  // display_id 在部分驱动/虚拟机上可能为空，退化为第一个屏幕源
  const source =
    sources.find((s) => s.display_id && String(s.display_id) === String(display.id)) ||
    sources[0];

  const image = source.thumbnail;
  if (!image || image.isEmpty()) {
    throw new Error('屏幕捕获为空（可能处于锁屏或显示器休眠状态）');
  }
  return image;
}

/**
 * 按窗口标题抓取窗口内容（使用 desktopCapturer 的 window 源）。
 */
async function captureWindow(title, physicalSize) {
  const width = Math.max(1, Math.min(4096, Math.round((physicalSize && physicalSize.width) || 3840)));
  const height = Math.max(1, Math.min(4096, Math.round((physicalSize && physicalSize.height) || 2160)));

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    throw new Error('没有可用的窗口捕获源');
  }

  const normalized = String(title || '').trim();
  let source = null;
  if (normalized) {
    source = sources.find((s) => s.name === normalized);
    if (!source) {
      source = sources.find(
        (s) => s.name && (s.name.includes(normalized) || normalized.includes(s.name))
      );
    }
  }

  if (!source) {
    throw new Error('未找到活动窗口的捕获源');
  }

  const image = source.thumbnail;
  if (!image || image.isEmpty()) {
    throw new Error('窗口捕获为空');
  }
  return image;
}

module.exports = { captureDisplay, captureWindow };
