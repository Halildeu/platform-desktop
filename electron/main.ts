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

import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAudioIpc } from './ipc/audio';
import { registerAuthIpc } from './ipc/auth';
import { registerMeetingIpc } from './ipc/meeting';
import {
  canGrantDisplayMedia,
  shouldGrantDisplayMediaRequest,
} from './services/display-media-lease';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primary = sources[0];
    if (!primary) {
      callback({});
      return;
    }
    callback({ video: primary, audio: 'loopback', enableLocalEcho: false });
  });

  registerAuthIpc(); // #1 auth:login / auth:status / auth:logout
  registerMeetingIpc(); // Faz 24 meeting-service contract create
  registerAudioIpc(); // #2 audio:start / audio:chunk / audio:finish
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
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
