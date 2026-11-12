'use strict';

const { app, Menu, globalShortcut, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// 确保开发模式与正式版本使用同一个数据目录（%APPDATA%\Cutting），
// 避免开发模式下回落到公共的 %APPDATA%\Electron 目录。
app.setName('Cutting');
app.setAppUserModelId('com.cutting.screenshot');

// 可选：通过环境变量指定独立的数据目录（便携/测试用）
if (process.env.CUTTING_USER_DATA) {
  app.setPath('userData', process.env.CUTTING_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已在托盘常驻时不弹窗，只做轻提示
    try {
      const settings = require('./settings').get();
      require('./tray').notify(
        'Cutting 已在运行',
        `截图 ${settings.shortcuts.capture} · 贴剪贴板 ${settings.shortcuts.pinClipboard} · 历史 ${settings.shortcuts.history}`
      );
    } catch (err) {
      // ignore
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    const settings = require('./settings');
    const historyStore = require('./historyStore');
    const overlay = require('./overlay');
    const shortcuts = require('./shortcuts');
    const historyWindow = require('./historyWindow');
    const settingsWindow = require('./settingsWindow');
    const pinWindow = require('./pin');
    const tray = require('./tray');
    const ipc = require('./ipc');
    const clipboardHelper = require('./clipboard');

    historyStore.init();

    // F3 连按状态：上一次贴出的历史记录 id + 当时的剪贴板指纹。
    // 剪贴板不变时继续往前贴更早的截图；剪贴板变化则重新从对应内容开始。
    let lastPinFingerprint = '';
    let lastPinHistoryId = '';

    historyStore.onChanged(() => {
      // 新增/删除历史后重新开始倒序，避免按旧索引贴错
      lastPinFingerprint = '';
      lastPinHistoryId = '';
    });

    const openSaveDir = async () => {
      const dir = settings.get().saveDir;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        // ignore
      }
      try {
        await shell.openPath(dir);
      } catch (err) {
        // ignore
      }
    };

    const startCapture = async (requestedMode = 'region') => {
      if (overlay.isOpen()) return;

      const current = settings.get();
      const mode = requestedMode === 'delayed' ? 'region' : requestedMode;
      const delay = current.captureDelay || 0;
      const applyDelay = delay > 0 && mode !== 'window';

      if (applyDelay) {
        tray.notify('延时截图', `${delay} 秒后开始截图`);
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }

      const result = await overlay.open(mode);
      if (result && !result.ok) {
        tray.notify('截图失败', result.error || '未知错误');
      }
    };

    const pinHistoryEntry = (entry) => {
      if (!entry || !entry.fileExists) return { ok: false, error: '原图已被移动或删除' };
      return entry.type === 'gif'
        ? pinWindow.pinGifFile(entry.filePath, entry.width, entry.height, entry.region)
        : pinWindow.pinFromFile(entry.filePath);
    };

    const listHistory = () => historyStore.list().filter((entry) => entry.fileExists);

    /** 从 fromId 之后继续往前贴，贴到最旧一张后回到最新一张循环 */
    const pinNextOlder = (list, fromId) => {
      if (!list.length) return null;
      let index = list.findIndex((entry) => entry.id === fromId);
      if (index < 0) index = -1;
      for (let step = 1; step <= list.length; step += 1) {
        const entry = list[(index + step) % list.length];
        const result = pinHistoryEntry(entry);
        if (result && result.ok) {
          lastPinHistoryId = entry.id;
          return result;
        }
      }
      return null;
    };

    const pinClipboard = async () => {
      const list = listHistory();
      const fingerprint = await clipboardHelper.readFingerprint();
      const signature = `${fingerprint.type}:${fingerprint.hash}`;
      // 剪贴板中的图片若与某条历史截图一致，说明是刚截的图或从历史复制的图
      let ownedEntry =
        fingerprint.type === 'image'
          ? list.find((entry) => entry.imageHash && entry.imageHash === fingerprint.hash)
          : null;

      // 兼容升级前保存的历史记录：按需补算最近几条的图片指纹
      if (fingerprint.type === 'image' && !ownedEntry) {
        const candidates = list.filter((entry) => !entry.imageHash).slice(0, 5);
        for (const candidate of candidates) {
          if (historyStore.ensureImageHash(candidate.id) === fingerprint.hash) {
            ownedEntry = candidate;
            break;
          }
        }
      }

      // 1) 连续按 F3 且剪贴板内容没变：接着往前贴更早的一张
      if (signature === lastPinFingerprint && lastPinHistoryId && list.length) {
        const result = pinNextOlder(list, lastPinHistoryId);
        if (result) return;
      }

      // 2) 刚录完 GIF（8 秒内）时，优先贴这条最新 GIF：
      // 避免剪贴板尚未来得及更新或被其他内容占用时贴出旧内容
      const latest = historyStore.list()[0];
      if (
        latest &&
        latest.type === 'gif' &&
        latest.fileExists &&
        Date.now() - latest.createdAt < 8000
      ) {
        const result = pinWindow.pinGifFile(
          latest.filePath,
          latest.width,
          latest.height,
          latest.region
        );
        if (result && result.ok) {
          lastPinFingerprint = signature;
          lastPinHistoryId = latest.id;
          return;
        }
      }

      // 3) 剪贴板里的截图对应某条历史记录：从这张开始，下一次继续往前
      if (ownedEntry) {
        const result = pinHistoryEntry(ownedEntry);
        if (result && result.ok) {
          lastPinFingerprint = signature;
          lastPinHistoryId = ownedEntry.id;
          return;
        }
      }

      // 4) 普通剪贴板内容（外部图片 / 文字 / 颜色 / 文件）
      let result = await pinWindow.fromClipboard();

      // 5) 剪贴板暂无可用内容时，回退到最近一条历史记录。
      // 这一路径覆盖「刚保存 GIF/截图后立刻按 F3」的场景：即使剪贴板写入/读取
      // 出现延迟或被其他程序占用，也能贴出最新一张。
      if (!result || !result.ok) {
        const recent = list[0];
        if (recent) {
          const pinned = pinHistoryEntry(recent);
          if (pinned && pinned.ok) {
            lastPinFingerprint = signature;
            lastPinHistoryId = recent.id;
            return;
          }
          result = pinned || result;
        }
      }

      if (result && result.ok) {
        // 外部剪贴板内容：重复按 F3 仍贴剪贴板，不进入历史倒序
        lastPinFingerprint = signature;
        lastPinHistoryId = '';
        return;
      }

      if (result && !result.ok) {
        tray.notify('贴图失败', result.error || '剪贴板中没有可贴的内容');
      }
    };

    const openHistoryDir = async () => {
      const dir = historyStore.getDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        // ignore
      }
      const error = await shell.openPath(dir);
      if (error) {
        tray.notify('无法打开历史目录', error);
      }
    };

    shortcuts.init({
      capture: () => {
        startCapture('region');
      },
      pinClipboard: () => {
        pinClipboard();
      },
      history: () => historyWindow.toggle(),
      historyDir: () => {
        openHistoryDir();
      },
    });

    const trayActions = {
      capture: (mode) => {
        startCapture(mode || 'region');
      },
      history: () => historyWindow.toggle(),
      pinClipboard,
      settings: () => settingsWindow.open(),
      openSaveDir,
      openHistoryDir,
      devTools: app.isPackaged ? null : () => overlay.openDevTools(),
      quit: () => app.quit(),
      // 菜单右侧展示的快捷键与当前延时
      acceleratorFor: (name) => settings.get().shortcuts[name],
      getDelay: () => settings.get().captureDelay,
    };

    ipc.register({
      settings,
      historyStore,
      overlay,
      shortcuts,
      historyWindow,
      settingsWindow,
      notify: tray.notify,
      capture: startCapture,
      refreshTray: () => tray.refresh(trayActions),
    });

    tray.create(trayActions);

    // 开发期验证托盘菜单排版：设置 CUTTING_DEBUG_MENU=1 启动后自动弹出菜单
    if (process.env.CUTTING_DEBUG_MENU) {
      setTimeout(() => tray.popupForDebug(), 900);
    }

    const registration = shortcuts.applyAll(settings.get().shortcuts);
    if (!registration.ok) {
      console.error('[cutting] 快捷键注册失败:', registration.error);
      tray.notify('快捷键注册失败', `${registration.error}，请在设置中修改`);
    } else {
      console.log('[cutting] 快捷键已注册:', JSON.stringify(shortcuts.getRegistered()));
    }

    if (app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!settings.get().autoStart });
      } catch (err) {
        // ignore
      }
    }

    // 启动后静默驻留托盘，不打开任何窗口，快捷键即可直接使用
  });

  // 关闭所有窗口后仍保持托盘常驻
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch (err) {
      // ignore
    }
  });
}
