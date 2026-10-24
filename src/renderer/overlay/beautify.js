'use strict';

/**
 * 截图美化（借鉴 PixPin / Snipaste）：圆角、投影、纯色/渐变背景与文字水印。
 * 所有尺寸参数均为 DIP，内部按物理像素比例缩放。
 */
(function () {
  const GRADIENTS = {
    ocean: ['#2f80ed', '#56ccf2'],
    sunset: ['#ff7e5f', '#feb47b'],
    forest: ['#11998e', '#38ef7d'],
    grape: ['#6a11cb', '#2575fc'],
    graphite: ['#232526', '#414345'],
  };

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function roundedPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.beginPath();
    if (r <= 0) {
      ctx.rect(x, y, width, height);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function isPlain(options) {
    if (!options || !options.enabled) return true;
    return (
      !options.padding &&
      !options.radius &&
      !options.shadow &&
      !options.watermark &&
      options.background === 'transparent'
    );
  }

  function drawBackground(ctx, options, width, height) {
    if (options.background === 'transparent') return;

    if (options.background === 'gradient') {
      const pair = GRADIENTS[options.gradient] || GRADIENTS.ocean;
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, pair[0]);
      gradient.addColorStop(1, pair[1]);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = options.color || '#1f2937';
    }
    ctx.fillRect(0, 0, width, height);
  }

  function drawWatermark(ctx, text, width, height, scale) {
    if (!text) return;
    const fontSize = Math.max(11, Math.round(13 * scale));
    const margin = Math.round(14 * scale);
    ctx.save();
    ctx.font = `500 ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.round(4 * scale);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, width - margin, height - margin);
    ctx.restore();
  }

  /**
   * 生成美化后的画布；未启用或参数全为默认时直接返回原画布。
   */
  function apply(source, options, scale) {
    const factor = Number(scale) || 1;
    if (isPlain(options)) return source;

    const padding = Math.round((Number(options.padding) || 0) * factor);
    const radius = Math.round((Number(options.radius) || 0) * factor);
    const shadow = !!options.shadow && options.background !== 'transparent';
    const shadowPad = shadow ? Math.round(22 * factor) : 0;
    const watermark = options.watermark ? String(options.watermark).slice(0, 80) : '';

    const offset = padding + shadowPad;
    const width = source.width + offset * 2;
    const height = source.height + offset * 2;

    const out = makeCanvas(width, height);
    const ctx = out.getContext('2d');

    drawBackground(ctx, options, width, height);

    // 先把内容画到带圆角的临时画布，再整体投影
    const content = makeCanvas(source.width, source.height);
    const contentCtx = content.getContext('2d');
    roundedPath(contentCtx, 0, 0, source.width, source.height, radius);
    contentCtx.clip();
    contentCtx.drawImage(source, 0, 0);

    if (shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
      ctx.shadowBlur = Math.round(20 * factor);
      ctx.shadowOffsetY = Math.round(6 * factor);
      ctx.drawImage(content, offset, offset);
      ctx.restore();
    } else {
      ctx.drawImage(content, offset, offset);
    }

    drawWatermark(ctx, watermark, width, height, factor);
    return out;
  }

  window.Beautify = { apply, gradients: Object.keys(GRADIENTS) };
})();
