'use strict';

(function () {
  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  /**
   * 从冻结截图中裁出选区，降采样后再无平滑放大，生成块状马赛克源。
   * 源图基于原始截图像素，与绘制顺序无关，撤销重放时结果稳定。
   */
  function build(
    bgCanvas,
    rect,
    imgScaleX,
    imgScaleY,
    outWidth,
    outHeight,
    blockDip,
    displayScale,
    offsetX = 0,
    offsetY = 0
  ) {
    const blockPx = Math.max(2, Math.round(blockDip * displayScale));
    const smallWidth = Math.max(1, Math.ceil(outWidth / blockPx));
    const smallHeight = Math.max(1, Math.ceil(outHeight / blockPx));

    const small = makeCanvas(smallWidth, smallHeight);
    const smallCtx = small.getContext('2d');
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.imageSmoothingQuality = 'high';
    smallCtx.drawImage(
      bgCanvas,
      (rect.x - offsetX) * imgScaleX,
      (rect.y - offsetY) * imgScaleY,
      rect.w * imgScaleX,
      rect.h * imgScaleY,
      0,
      0,
      small.width,
      small.height
    );

    const source = makeCanvas(outWidth, outHeight);
    const sourceCtx = source.getContext('2d');
    sourceCtx.imageSmoothingEnabled = false;
    sourceCtx.drawImage(small, 0, 0, source.width, source.height);
    return source;
  }

  /**
   * 基于原始截图生成高斯模糊源（整块选区），供模糊标注按矩形裁剪使用。
   */
  function buildBlur(
    bgCanvas,
    rect,
    imgScaleX,
    imgScaleY,
    outWidth,
    outHeight,
    strength,
    offsetX = 0,
    offsetY = 0
  ) {
    const source = makeCanvas(outWidth, outHeight);
    const ctx = source.getContext('2d');
    const blurPx = Math.max(2, Math.round((Number(strength) || 12) * (outWidth / Math.max(1, rect.w))));
    if (typeof ctx.filter === 'string') {
      ctx.filter = `blur(${blurPx}px)`;
    }
    // 略微放大绘制范围，避免边缘出现透明衰减
    ctx.drawImage(
      bgCanvas,
      (rect.x - offsetX) * imgScaleX,
      (rect.y - offsetY) * imgScaleY,
      rect.w * imgScaleX,
      rect.h * imgScaleY,
      -blurPx,
      -blurPx,
      source.width + blurPx * 2,
      source.height + blurPx * 2
    );
    return source;
  }

  window.Mosaic = { makeCanvas, build, buildBlur };
})();
