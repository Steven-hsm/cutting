'use strict';

/**
 * 生成 256x256 的托盘/应用图标（纯 Node，无需额外依赖）。
 * 图形：蓝色圆角方块 + 白色裁剪角标。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function buildImage() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

  const left = 12;
  const top = 12;
  const right = SIZE - 13;
  const bottom = SIZE - 13;
  const radius = 56;

  const arm = 74;
  const thickness = 18;
  const inset = 54;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      if (!insideRoundedRect(x, y, left, top, right, bottom, radius)) continue;

      // 蓝色背景（轻微纵向渐变）
      const t = (y - top) / (bottom - top);
      const r = Math.round(47 + (31 - 47) * t);
      const g = Math.round(128 + (96 - 128) * t);
      const b = Math.round(237 + (210 - 237) * t);
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;

      // 白色裁剪角标：左上 + 右下
      const topLeftH = y >= inset && y < inset + thickness && x >= inset && x < inset + arm;
      const topLeftV = x >= inset && x < inset + thickness && y >= inset && y < inset + arm;
      const bottomRightH =
        y >= SIZE - inset - thickness &&
        y < SIZE - inset &&
        x >= SIZE - inset - arm &&
        x < SIZE - inset;
      const bottomRightV =
        x >= SIZE - inset - thickness &&
        x < SIZE - inset &&
        y >= SIZE - inset - arm &&
        y < SIZE - inset;

      if (topLeftH || topLeftV || bottomRightH || bottomRightV) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
      }
    }
  }

  return pixels;
}

function writePng(filePath) {
  const pixels = buildImage();
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
  return png.length;
}

const target = path.join(__dirname, '..', 'assets', 'icon.png');
const bytes = writePng(target);
console.log(`图标已生成: ${target} (${bytes} bytes)`);
