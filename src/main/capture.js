'use strict';

const { desktopCapturer } = require('electron');

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

/**
 * 一次抓取全部显示器，返回每屏的图像数据（用于多屏覆盖窗）。
 * 只返回确实匹配到捕获源的显示器；缺失的屏幕（休眠/断开）直接跳过，
 * 避免把错误的屏幕内容画到另一块屏幕上。
 */
async function captureDisplays(displays) {
  if (!displays.length) throw new Error('没有可用的显示器');

  // 一次调用拿全部屏幕源，缩略图按最大物理尺寸请求，保证各屏清晰度
  const maxWidth = Math.max(
    ...displays.map((d) => Math.round(d.size.width * (d.scaleFactor || 1)))
  );
  const maxHeight = Math.max(
    ...displays.map((d) => Math.round(d.size.height * (d.scaleFactor || 1)))
  );

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: maxHeight },
    fetchWindowIcons: false,
  });

  if (!sources.length) throw new Error('没有可用的屏幕捕获源');

  // display_id 在部分驱动/虚拟机上可能为空：先按 id 匹配，剩余屏幕按顺序补齐
  const used = new Set();
  const pairs = displays.map((display) => {
    const source = sources.find(
      (s) => !used.has(s.id) && s.display_id && String(s.display_id) === String(display.id)
    );
    if (source) used.add(source.id);
    return { display, source: source || null };
  });
  const leftovers = sources.filter((s) => !used.has(s.id));
  // 源数量与显示器数量一致时，按顺序补齐最可靠；否则只使用没有 display_id 的源，
  // 避免把已断开显示器的残留源画到当前屏幕上
  const fallbackSources =
    sources.length === displays.length
      ? leftovers
      : leftovers.filter((source) => !source.display_id);
  for (const pair of pairs) {
    if (pair.source || !fallbackSources.length) continue;
    pair.source = fallbackSources.shift();
  }

  const results = [];
  for (const pair of pairs) {
    const source = pair.source;
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) continue;
    const size = source.thumbnail.getSize();
    results.push({
      display: pair.display,
      dataUrl: source.thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
    });
  }

  if (!results.length) {
    throw new Error('屏幕捕获为空（可能处于锁屏或显示器休眠状态）');
  }
  return results;
}

module.exports = { captureDisplays, captureWindow };
