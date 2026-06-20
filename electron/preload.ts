/**
 * Preload bridge — sandboxed renderer ↔ main process secure IPC.
 *
 * contextIsolation: true sayesinde renderer Node API'lere doğrudan
 * erişemez. Bu dosya whitelist'li IPC methods sunar.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { AuthStatus } from './ipc/auth';

const electronAPI = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  },
  audio: {
    permissionStatus: (): Promise<{ granted: boolean }> =>
      ipcRenderer.invoke('audio:permission-status'),
    // Extend: start/stop/chunk-stream/transcript-listener
  },
  auth: {
    // Token RENDERER'a verilmez — yalnız durum (loggedIn/expiresAt) döner.
    login: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:login'),
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    logout: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:logout'),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
