'use strict';

const { spawn } = require('child_process');
const { app } = require('electron');

/**
 * 常驻 PowerShell 辅助进程。
 * 每步滚动都新起 PowerShell + Add-Type 会把 C# 重新编译一遍（实测 0.6~2 秒），
 * 这里只编译一次，后续通过 stdin 命令复用。
 */
const WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @"
using System;
using System.Text;
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  static string Sanitize(string value) {
    if (value == null) return "";
    return value.Replace("|", " ").Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " ");
  }

  static string Title(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return Sanitize(sb.ToString());
  }

  public static string Wheel(int x, int y, int delta) {
    SetProcessDPIAware();
    SetCursorPos(x, y);
    POINT p = new POINT();
    p.X = x;
    p.Y = y;
    IntPtr child = WindowFromPoint(p);
    IntPtr target = GetAncestor(child, 2);
    IntPtr fg = GetForegroundWindow();
    bool focused = target != IntPtr.Zero && target == fg;

    // 只在目标不是前台窗口时激活，避免每一步都模拟 Alt / 抢焦点
    if (target != IntPtr.Zero && !focused) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(target);
      Thread.Sleep(80);
      fg = GetForegroundWindow();
      focused = target == fg;
    }

    string targetTitle = Title(target);
    string foregroundTitle = Title(fg);

    if (focused) {
      mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    } else {
      // 激活失败时退化为直接向鼠标下的窗口发送 WM_MOUSEWHEEL
      int mouseParam = ((p.Y & 0xFFFF) << 16) | (p.X & 0xFFFF);
      SendMessage(child, 0x020A, new IntPtr(delta << 16), new IntPtr(mouseParam));
      Thread.Sleep(30);
    }

    return targetTitle + "|" + foregroundTitle + "|" + (focused ? "1" : "0");
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'PING') {
    [Console]::Out.WriteLine('PONG')
    [Console]::Out.Flush()
    continue
  }
  if ($line.StartsWith('W ')) {
    $parts = $line.Split(' ')
    try {
      $r = [CuttingScroll]::Wheel([int]$parts[1], [int]$parts[2], [int]$parts[3])
      [Console]::Out.WriteLine('OK|' + $r)
    } catch {
      [Console]::Out.WriteLine('ERR|' + $_.Exception.Message)
    }
    [Console]::Out.Flush()
  }
}
`;

let child = null;
let outputBuffer = '';
let pending = null;
let requestChain = Promise.resolve();
let hasCompiled = false;

function rejectPending(message) {
  if (!pending) return;
  const task = pending;
  pending = null;
  if (task.timer) clearTimeout(task.timer);
  task.reject(new Error(message));
}

function handleLine(line) {
  if (!line) return;
  if (line === 'PONG') {
    hasCompiled = true;
  }
  if (!pending) return;
  if (line.startsWith('OK|')) {
    const task = pending;
    pending = null;
    if (task.timer) clearTimeout(task.timer);
    hasCompiled = true;
    task.resolve(line.slice(3));
    return;
  }
  if (line.startsWith('ERR|')) {
    const task = pending;
    pending = null;
    if (task.timer) clearTimeout(task.timer);
    task.reject(new Error(line.slice(4) || '滚动输入失败'));
  }
}

function startWorker() {
  if (child) return child;
  hasCompiled = false;
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WORKER_SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
  );
  child = proc;
  outputBuffer = '';

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    outputBuffer += chunk;
    let index = outputBuffer.indexOf('\n');
    while (index >= 0) {
      const line = outputBuffer.slice(0, index).replace(/\r$/, '');
      outputBuffer = outputBuffer.slice(index + 1);
      handleLine(line);
      index = outputBuffer.indexOf('\n');
    }
  });

  proc.on('error', () => {
    if (child === proc) {
      child = null;
      hasCompiled = false;
    }
    rejectPending('滚动输入进程启动失败');
  });

  proc.on('exit', () => {
    if (child === proc) {
      child = null;
      hasCompiled = false;
    }
    rejectPending('滚动输入进程已退出');
  });

  proc.stdin.on('error', () => {
    // ignore，由 exit 事件统一处理
  });

  return proc;
}

function sendCommand(command, timeout) {
  const proc = startWorker();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending) return;
      pending = null;
      try {
        proc.kill();
      } catch (err) {
        // ignore
      }
      if (child === proc) {
        child = null;
        hasCompiled = false;
      }
      reject(new Error('滚动输入超时'));
    }, timeout);

    pending = { resolve, reject, timer };
    try {
      proc.stdin.write(`${command}\n`);
    } catch (err) {
      if (pending) {
        pending = null;
        clearTimeout(timer);
      }
      reject(err);
    }
  });
}

function request(command, timeout) {
  const task = requestChain.then(() => sendCommand(command, timeout));
  requestChain = task.catch(() => {});
  return task;
}

let warmed = false;

/** 预编译辅助进程（第一次滚动前调用，避免把编译时间计入第一步） */
function warmup() {
  if (warmed) return;
  warmed = true;
  const proc = startWorker();
  try {
    proc.stdin.write('PING\n');
  } catch (err) {
    // 下次 wheelAt 会重新启动
  }
}

/**
 * 把鼠标移到物理像素坐标 (x, y)，激活该位置的窗口并滚动滚轮。
 * delta 为负值表示向下滚动（每格 120）。
 */
function wheelAt(x, y, delta) {
  const command = `W ${Math.round(x)} ${Math.round(y)} ${Math.round(delta)}`;
  return request(command, hasCompiled ? 5000 : 15000).then((info) => {
    hasCompiled = true;
    const [targetTitle = '', foregroundTitle = '', focused = '0'] = String(info).split('|');
    return {
      ok: true,
      targetTitle,
      foregroundTitle,
      focused: focused === '1',
      info,
    };
  });
}

function shutdown() {
  rejectPending('应用退出');
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.stdin.end();
  } catch (err) {
    // ignore
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill();
    } catch (err) {
      // ignore
    }
  }, 300);
}

try {
  app.on('will-quit', shutdown);
} catch (err) {
  // ignore
}

module.exports = { warmup, wheelAt, shutdown };
