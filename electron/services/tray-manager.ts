/**
 * System tray — #6. Meeting-active indicator + quick controls (show window,
 * stop the active recording, quit). Actual recording start/stop lives in the
 * renderer (App.tsx state machine); the tray only requests it via IPC event
 * and reflects the state it's told about (`setRecordingActive`).
 */

import { Menu, Tray, app } from 'electron';
import path from 'node:path';

export interface TrayCallbacks {
  onShowWindow: () => void;
  onStopRecording: () => void;
  onQuit: () => void;
}

const ICON_DIR = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(app.getAppPath(), 'public', 'icons');

function iconPath(active: boolean): string {
  const name = active ? 'tray-active-32.png' : 'tray-32.png';
  return path.join(ICON_DIR(), name);
}

export class TrayManager {
  private tray: Tray | null = null;
  private recordingActive = false;

  constructor(private readonly callbacks: TrayCallbacks) {}

  create(): void {
    this.tray = new Tray(iconPath(false));
    this.tray.setToolTip('Meeting Intelligence');
    this.tray.on('click', () => this.callbacks.onShowWindow());
    this.rebuildMenu();
  }

  setRecordingActive(active: boolean): void {
    this.recordingActive = active;
    if (!this.tray) {
      return;
    }
    this.tray.setImage(iconPath(active));
    this.tray.setToolTip(active ? 'Meeting Intelligence — kayıt sürüyor' : 'Meeting Intelligence');
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray) {
      return;
    }
    const menu = Menu.buildFromTemplate([
      { label: 'Göster', click: () => this.callbacks.onShowWindow() },
      {
        label: 'Kaydı Bitir',
        enabled: this.recordingActive,
        click: () => this.callbacks.onStopRecording(),
      },
      { type: 'separator' },
      { label: 'Çıkış', click: () => this.callbacks.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
