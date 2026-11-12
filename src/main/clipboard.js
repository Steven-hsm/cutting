'use strict';

const { clipboard, ClipboardItem, nativeImage } = require('electron');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * 生成图片的轻量指纹（32×32 归一化后取 SHA-1）。
 * 用于判断剪贴板中的图片对应哪一条历史截图，以及在连按 F3 时判断剪贴板是否变化。
 */
function fingerprintImage(image) {
  if (!image || image.isEmpty()) return '';
  try {
    const small = image.resize({ width: 32, height: 32, quality: 'good' });
    return crypto.createHash('sha1').update(small.toBitmap()).digest('hex');
  } catch (err) {
    return '';
  }
}

/**
 * 读取当前剪贴板内容指纹。
 * Electron 44 的剪贴板读取是异步 API（clipboard.read()/readText()）。
 * 返回 { type: 'image' | 'text' | 'empty', hash }。
 */
async function readFingerprint() {
  try {
    const items = await clipboard.read();
    for (const item of items || []) {
      const types = Array.isArray(item.types) ? item.types : [];
      for (const imageType of types.filter((type) => type.startsWith('image/'))) {
        try {
          const blob = await item.getType(imageType);
          if (!blob || typeof blob.arrayBuffer !== 'function') continue;
          const buffer = Buffer.from(await blob.arrayBuffer());
          const hash = fingerprintImage(nativeImage.createFromBuffer(buffer));
          if (hash) return { type: 'image', hash };
        } catch (err) {
          // 换下一个 MIME 类型
        }
      }
    }
  } catch (err) {
    // ignore
  }

  let text = '';
  try {
    text = (await clipboard.readText()) || '';
  } catch (err) {
    text = '';
  }
  if (text) {
    return { type: 'text', hash: crypto.createHash('sha1').update(text).digest('hex') };
  }
  return { type: 'empty', hash: '' };
}

/**
 * Electron 44 起剪贴板改为异步 ClipboardItem API。
 */
async function writeImageBuffer(buffer, mime = 'image/png') {
  const blob = new Blob([buffer], { type: mime });
  await clipboard.write([new ClipboardItem({ [mime]: blob })]);
}

async function writeNativeImage(image, mime = 'image/png') {
  return writeImageBuffer(image.toPNG(), mime);
}

/**
 * 把文件本身写入剪贴板（CF_HDROP），可直接粘贴到资源管理器、微信等支持文件的应用。
 * 用于 GIF 这类无法作为静态图片复制的文件。
 */
function writeFileToClipboard(filePath) {
  return new Promise((resolve) => {
    const safePath = String(filePath || '').replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
$files.Add('${safePath}')
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (error) => {
        resolve(!error);
      }
    );
  });
}

/**
 * 读取剪贴板中的文件列表（CF_HDROP），返回绝对路径数组。
 */
function readFilePathsFromClipboard() {
  return new Promise((resolve) => {
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($null -ne $list) { foreach ($p in $list) { Write-Output $p } }
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (process.env.CUTTING_DEBUG_CLIPBOARD) {
            console.log('[clipboard] read files failed:', error && error.message, String(stderr || '').slice(0, 300));
          }
          resolve([]);
          return;
        }
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(paths);
      }
    );
  });
}

module.exports = {
  fingerprintImage,
  readFingerprint,
  writeImageBuffer,
  writeNativeImage,
  writeFileToClipboard,
  readFilePathsFromClipboard,
};
