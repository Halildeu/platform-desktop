/**
 * platform-desktop main process — Electron 33 + secure defaults.
 *
 * 3-AI mutabakat (Codex `019e879c` + Mavis msg `78` AGREE + Claude):
 * - contextIsolation: true + nodeIntegration: false
 * - Preload bridge ile sandboxed renderer
 * - CSP (Content Security Policy) HTML üzerinden
 * - Audio capture renderer'da (getUserMedia) → IPC → WebSocket main'de
 *
 * KVKK boundary (ADR-0030):
 * - Audio buffer disk'e yazılmaz default
 * - Transcript clipboard copy → audit log
 * - Crash report PII redacted
 */

import 'dotenv/config'; // .env → process.env (Keycloak/gateway config), en başta

import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAudioIpc } from './ipc/audio';
import { registerAuthIpc } from './ipc/auth';
import { registerMeetingIpc } from './ipc/meeting';
import { isAutoLaunchEnabled, setAutoLaunchEnabled } from './services/auto-launch';
import { initAutoUpdate } from './services/auto-update';
import {
  canGrantDisplayMedia,
  shouldGrantDisplayMediaRequest,
} from './services/display-media-lease';
import { notifyRecordingFinished, notifyRecordingStarted } from './services/notifications';
import { TrayManager } from './services/tray-manager';
import { resolveWindowBounds, type WindowBounds } from './services/window-bounds';
import { WindowStateStore } from './services/window-state-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let tray: TrayManager | null = null;
let recordingActive = false;
const windowStateStore = new WindowStateStore();
let isQuitting = false;

const DEFAULT_BOUNDS: WindowBounds = { x: 0, y: 0, width: 1280, height: 800 };

function saveCurrentBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return;
  }
  const [x, y] = mainWindow.getPosition();
  const [width, height] = mainWindow.getSize();
  windowStateStore.save({ x, y, width, height });
}

function createMainWindow(): void {
  const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds }));
  const saved = windowStateStore.load();
  const bounds = resolveWindowBounds(saved, displays, DEFAULT_BOUNDS);

  mainWindow = new BrowserWindow({
    ...(saved ? bounds : { width: bounds.width, height: bounds.height }),
    minWidth: 1024,
    minHeight: 700,
    title: 'Meeting Intelligence',
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });

  // Open external links in default browser (security)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('move', saveCurrentBounds);
  mainWindow.on('resize', saveCurrentBounds);

  // Tray varken kapatma düğmesi pencereyi gizler, kaydı kesmez (#6: quick
  // controls kaydı sürdürsün diye). Gerçek çıkış "Çıkış" tray menüsünden.
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers (sample — extend in electron/ipc/*)
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('audio:permission-status', async () => {
  // macOS TCC / Windows / Linux permission check (extend per-platform)
  return { granted: true };
});

ipcMain.handle('app:get-auto-launch', () => isAutoLaunchEnabled());
ipcMain.handle('app:set-auto-launch', (_event, enabled: boolean) => {
  setAutoLaunchEnabled(enabled);
  return isAutoLaunchEnabled();
});

ipcMain.on('tray:set-recording-active', (_event, active: boolean) => {
  if (active === recordingActive) {
    return;
  }
  recordingActive = active;
  tray?.setRecordingActive(active);
  if (active) {
    notifyRecordingStarted();
  } else {
    notifyRecordingFinished();
  }
});

void app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (req, callback) => {
    const allowed = shouldGrantDisplayMediaRequest({
      canGrantLease: canGrantDisplayMedia(),
      requestProcessId: req.frame?.processId,
      mainFrameProcessId: mainWindow?.webContents.mainFrame.processId ?? null,
    });
    if (!allowed) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primary = sources[0];
      if (!primary) {
        callback({});
        return;
      }
      callback({ video: primary, audio: 'loopback', enableLocalEcho: false });
    } catch {
      callback({});
    }
  });

  registerAuthIpc(); // #1 auth:login / auth:status / auth:logout
  registerMeetingIpc(); // Faz 24 meeting-service contract create
  registerAudioIpc(); // #2 audio:start / audio:chunk / audio:finish
  createMainWindow();
  initAutoUpdate(); // #11 — no-op outside a packaged build

  tray = new TrayManager({
    onShowWindow: () => {
      if (!mainWindow) {
        createMainWindow();
        return;
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    },
    onStopRecording: () => {
      mainWindow?.webContents.send('tray:stop-requested');
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  tray.create();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  saveCurrentBounds();
});

app.on('window-all-closed', () => {
  // Tray varken pencere kapatma zaten 'close' handler'ında hide'a çevriliyor;
  // buraya sadece tray oluşturulamadıysa (nadiren) düşer.
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});

// Security: prevent new window/navigation outside whitelist
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    const allowed = ['http://localhost:5173', 'file://'];
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      event.preventDefault();
    }
  });
});
