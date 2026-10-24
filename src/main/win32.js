'use strict';

const { execFile } = require('child_process');

/**
 * 通过 PowerShell + User32 查询当前位于最上层的外部窗口（排除本进程）。
 * 用于「活动窗口截图」：既拿到窗口标题（匹配 desktopCapturer 源），也拿到物理像素位置。
 */
function findTopWindow(excludePid) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CuttingWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static string FindTop(uint excludePid) {
    string result = null;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == excludePid || pid == 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      RECT r;
      GetWindowRect(h, out r);
      int w = r.Right - r.Left;
      int ht = r.Bottom - r.Top;
      if (w < 40 || ht < 30) return true;
      result = sb.ToString() + "\\t" + r.Left + "\\t" + r.Top + "\\t" + w + "\\t" + ht;
      return false;
    }, IntPtr.Zero);
    return result;
  }
}
"@
[CuttingWin32]::SetProcessDPIAware() | Out-Null
[CuttingWin32]::FindTop(${Number(excludePid) || 0})
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }
        const parts = String(stdout).trim().split('\t');
        if (parts.length < 5) {
          resolve(null);
          return;
        }
        const [title, left, top, width, height] = parts;
        resolve({
          title,
          left: Number(left),
          top: Number(top),
          width: Number(width),
          height: Number(height),
        });
      }
    );
  });
}

/**
 * 枚举当前可见的顶层窗口（排除本进程），返回物理像素位置。
 * 用于截图界面中的窗口识别与吸附。
 */
function listWindows(excludePid) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CuttingWinList {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static string List(uint excludePid) {
    StringBuilder outSb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == excludePid || pid == 0) return true;
      // 跳过桌面/任务栏等系统窗口（无父窗口且扩展到全屏的 Shell 窗口由尺寸过滤）
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      RECT r;
      GetWindowRect(h, out r);
      int w = r.Right - r.Left;
      int ht = r.Bottom - r.Top;
      if (w < 80 || ht < 60) return true;
      outSb.AppendLine(sb.ToString().Replace("\\t", " ") + "\\t" + r.Left + "\\t" + r.Top + "\\t" + w + "\\t" + ht);
      return true;
    }, IntPtr.Zero);
    return outSb.ToString();
  }
}
"@
[CuttingWinList]::SetProcessDPIAware() | Out-Null
[CuttingWinList]::List(${Number(excludePid) || 0})
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 6000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }
        const windows = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const parts = line.split('\t');
          if (parts.length < 5) continue;
          const [title, left, top, width, height] = parts;
          const rect = {
            title,
            left: Number(left),
            top: Number(top),
            width: Number(width),
            height: Number(height),
          };
          if (
            Number.isFinite(rect.left) &&
            Number.isFinite(rect.top) &&
            rect.width > 0 &&
            rect.height > 0
          ) {
            windows.push(rect);
          }
        }
        resolve(windows);
      }
    );
  });
}

module.exports = { findTopWindow, listWindows };
