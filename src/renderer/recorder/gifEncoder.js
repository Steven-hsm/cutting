'use strict';

/**
 * 轻量 GIF89a 编码器（无第三方依赖）。
 * - 全局调色板：6x6x6 颜色立方（216 色）+ 40 级灰阶
 * - 逐帧增量写入 LZW 数据，录制过程中不会缓存原始帧，内存占用平稳
 */
(function () {
  const PALETTE = new Uint8Array(256 * 3);

  (function buildPalette() {
    let index = 0;
    for (let r = 0; r < 6; r += 1) {
      for (let g = 0; g < 6; g += 1) {
        for (let b = 0; b < 6; b += 1) {
          PALETTE[index * 3] = r * 51;
          PALETTE[index * 3 + 1] = g * 51;
          PALETTE[index * 3 + 2] = b * 51;
          index += 1;
        }
      }
    }
    for (let i = 0; i < 40; i += 1) {
      const v = Math.round((i / 39) * 255);
      PALETTE[index * 3] = v;
      PALETTE[index * 3 + 1] = v;
      PALETTE[index * 3 + 2] = v;
      index += 1;
    }
  })();

  let lut = null;

  // 5bit/通道 → 调色板索引的查找表，避免每帧做大量最近色搜索
  function getLut() {
    if (lut) return lut;
    lut = new Uint8Array(32768);
    for (let r5 = 0; r5 < 32; r5 += 1) {
      const r = (r5 << 3) | (r5 >> 2);
      for (let g5 = 0; g5 < 32; g5 += 1) {
        const g = (g5 << 3) | (g5 >> 2);
        for (let b5 = 0; b5 < 32; b5 += 1) {
          const b = (b5 << 3) | (b5 >> 2);
          let best = 0;
          let bestDistance = Infinity;
          for (let i = 0; i < 256; i += 1) {
            const dr = r - PALETTE[i * 3];
            const dg = g - PALETTE[i * 3 + 1];
            const db = b - PALETTE[i * 3 + 2];
            const distance = dr * dr * 3 + dg * dg * 4 + db * db * 2;
            if (distance < bestDistance) {
              bestDistance = distance;
              best = i;
              if (distance === 0) break;
            }
          }
          lut[(r5 << 10) | (g5 << 5) | b5] = best;
        }
      }
    }
    return lut;
  }

  function quantize(imageData) {
    const data = imageData.data;
    const table = getLut();
    const length = imageData.width * imageData.height;
    const out = new Uint8Array(length);
    for (let i = 0, p = 0; i < length; i += 1, p += 4) {
      out[i] = table[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)];
    }
    return out;
  }

  function lzwChunks(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let table = new Map();
    let bits = 0;
    let bitCount = 0;
    const bytes = [];

    const emit = (code) => {
      bits |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        bytes.push(bits & 0xff);
        bits >>>= 8;
        bitCount -= 8;
      }
    };

    emit(clearCode);
    let prefix = indices[0];

    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = table.get(key);

      if (found !== undefined) {
        prefix = found;
        continue;
      }

      emit(prefix);

      if (nextCode < 4096) {
        table.set(key, nextCode);
        nextCode += 1;
        // 编码器比解码器多一条字典项，因此阈值是 2^codeSize + 1
        if (nextCode === (1 << codeSize) + 1 && codeSize < 12) {
          codeSize += 1;
        }
      } else {
        emit(clearCode);
        table = new Map();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }

    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) bytes.push(bits & 0xff);

    const chunks = [];
    chunks.push(Uint8Array.of(minCodeSize));
    for (let i = 0; i < bytes.length; i += 255) {
      const slice = bytes.slice(i, i + 255);
      chunks.push(Uint8Array.of(slice.length));
      chunks.push(Uint8Array.from(slice));
    }
    chunks.push(Uint8Array.of(0));
    return chunks;
  }

  function u16(value) {
    return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
  }

  function ascii(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  class GifWriter {
    constructor(width, height, options) {
      this.width = width;
      this.height = height;
      const fps = Math.max(2, Math.min(30, (options && options.fps) || 10));
      this.delay = Math.max(2, Math.round(100 / fps));
      this.parts = [];
      this.frameCount = 0;

      this.parts.push(ascii('GIF89a'));
      this.parts.push(u16(width), u16(height));
      // 全局调色板 256 色
      this.parts.push(Uint8Array.of(0xf7, 0x00, 0x00));
      this.parts.push(PALETTE);
      // NETSCAPE 循环扩展
      this.parts.push(
        Uint8Array.of(0x21, 0xff, 0x0b),
        ascii('NETSCAPE2.0'),
        Uint8Array.of(0x03, 0x01),
        u16(0),
        Uint8Array.of(0x00)
      );
    }

    addFrame(indices) {
      if (indices.length !== this.width * this.height) {
        throw new Error('帧尺寸与 GIF 尺寸不一致');
      }
      // 图形控制扩展：处置方式=保留，延迟
      this.parts.push(
        Uint8Array.of(0x21, 0xf9, 0x04, 0x04),
        u16(this.delay),
        Uint8Array.of(0x00, 0x00)
      );
      // 图像描述符
      this.parts.push(
        Uint8Array.of(0x2c),
        u16(0),
        u16(0),
        u16(this.width),
        u16(this.height),
        Uint8Array.of(0x00)
      );
      for (const chunk of lzwChunks(indices, 8)) this.parts.push(chunk);
      this.frameCount += 1;
    }

    finish() {
      this.parts.push(Uint8Array.of(0x3b));
      return new Blob(this.parts, { type: 'image/gif' });
    }
  }

  window.GifEncoder = { GifWriter, quantize, palette: PALETTE };
})();
