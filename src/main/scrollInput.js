'use strict';

const { execFile } = require('child_process');

function scrollScript(x, y, delta) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class CuttingScroll {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  public static string Title(IntPtr h) {
    System.Text.StringBuilder sb = new System.Text.StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  public static string Wheel(int x, int y, int delta) {
    SetProcessDPIAware();
    SetCursorPos(x, y);
    POINT p = new POINT();
    p.X = x;
    p.Y = y;
    IntPtr hwnd = GetAncestor(WindowFromPoint(p), 2);
    string target = Title(hwnd);
    if (hwnd != IntPtr.Zero) {
      // 解锁前台窗口限制后再激活目标窗口，保证滚轮事件作用于目标应用
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hwnd);
      Thread.Sleep(120);
    }
    mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    return target + " || " + Title(GetForegroundWindow());
  }
}
"@
[CuttingScroll]::Wheel(${Math.round(x)}, ${Math.round(y)}, ${Math.round(delta)})
`;
}

/**
 * 把鼠标移到物理像素坐标 (x, y)，激活该位置的窗口并滚动滚轮。
 * delta 为负值表示向下滚动（每格 120）。
 */
function wheelAt(x, y, delta) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        scrollScript(x, y, delta),
      ],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        resolve({ ok: !error, info: String(stdout || '').trim() });
      }
    );
  });
}

module.exports = { wheelAt };
