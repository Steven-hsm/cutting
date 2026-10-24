'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 使用 Windows 自带的离线 OCR（Windows.Media.Ocr）识别图片文字。
 * 无需联网、无需额外模型；中文需系统安装「中文(简体) OCR」语言功能。
 */
function ocrScript(imagePath) {
  const safePath = imagePath.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${safePath}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = $null
foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'en-US')) {
  try {
    $lang = New-Object Windows.Globalization.Language $tag
    $candidate = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -ne $candidate) { $engine = $candidate; break }
  } catch { }
}
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
  Write-Output '{"ok":false,"error":"系统未安装 OCR 语言包，请在 Windows 设置 > 应用 > 可选功能 中添加「中文(简体) OCR」或「English OCR」"}'
  exit 0
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
$detail = @()
foreach ($line in $result.Lines) {
  $lines += $line.Text
  # 合并该行所有词的包围盒，供界面在原图上叠加可选择的文字
  $minX = [double]::MaxValue
  $minY = [double]::MaxValue
  $maxX = 0.0
  $maxY = 0.0
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    if ($r.X -lt $minX) { $minX = $r.X }
    if ($r.Y -lt $minY) { $minY = $r.Y }
    if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
  }
  if ($maxX -gt $minX -and $maxY -gt $minY) {
    $detail += [pscustomobject]@{
      text = $line.Text
      x = [math]::Round($minX, 1)
      y = [math]::Round($minY, 1)
      w = [math]::Round($maxX - $minX, 1)
      h = [math]::Round($maxY - $minY, 1)
    }
  }
}
$payload = @{
  ok = $true
  language = $engine.RecognizerLanguage.LanguageTag
  text = ($lines -join "\`n")
  lines = @($detail)
}
$payload | ConvertTo-Json -Compress -Depth 4
`;
}

function runOcr(imagePath) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        ocrScript(imagePath),
      ],
      { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: `识别失败：${(stderr || error.message || '').toString().trim().slice(0, 300)}`,
          });
          return;
        }
        const output = String(stdout || '').trim();
        const start = output.indexOf('{');
        if (start < 0) {
          resolve({ ok: false, error: '识别失败：未返回结果' });
          return;
        }
        try {
          const parsed = JSON.parse(output.slice(start));
          if (!parsed.ok) {
            resolve({ ok: false, error: parsed.error || '识别失败' });
            return;
          }
          const text = String(parsed.text || '').trim();
          if (!text) {
            resolve({ ok: false, error: '未识别到文字' });
            return;
          }
          const rawLines = Array.isArray(parsed.lines)
            ? parsed.lines
            : parsed.lines
              ? [parsed.lines]
              : [];
          const lines = rawLines
            .map((line) => ({
              text: String(line.text || ''),
              x: Number(line.x) || 0,
              y: Number(line.y) || 0,
              w: Number(line.w) || 0,
              h: Number(line.h) || 0,
            }))
            .filter((line) => line.text && line.w > 0 && line.h > 0);
          resolve({ ok: true, text, language: parsed.language || '', lines });
        } catch (err) {
          resolve({ ok: false, error: '识别失败：结果解析错误' });
        }
      }
    );
  });
}

/**
 * 识别 base64 PNG 数据。
 */
async function recognizeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { ok: false, error: '图片数据无效' };
  }

  const tempFile = path.join(
    os.tmpdir(),
    `cutting-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`
  );

  try {
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    fs.writeFileSync(tempFile, buffer);
    return await runOcr(tempFile);
  } catch (err) {
    return { ok: false, error: err.message || '识别失败' };
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (err) {
      // ignore
    }
  }
}

/**
 * 识别本地图片文件。
 */
async function recognizeFile(filePath) {
  let image = null;
  try {
    image = nativeImage.createFromPath(filePath);
  } catch (err) {
    image = null;
  }
  if (!image || image.isEmpty()) return { ok: false, error: '图片读取失败' };
  return recognizeDataUrl(image.toDataURL());
}

module.exports = { recognizeDataUrl, recognizeFile };
