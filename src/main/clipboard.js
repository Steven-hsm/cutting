'use strict';

const { clipboard, ClipboardItem } = require('electron');
const { execFile } = require('child_process');

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
  writeImageBuffer,
  writeNativeImage,
  writeFileToClipboard,
  readFilePathsFromClipboard,
};
