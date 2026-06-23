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
    start: (
      meetingId: string,
      deviceId: string,
    ): Promise<{ sessionId: string; captureId: string }> =>
      ipcRenderer.invoke('audio:start', meetingId, deviceId),
    sendChunk: (payload: {
      captureId: string;
      bytes: Uint8Array;
      startedAtMs: number;
    }): Promise<{ seq: number }> => ipcRenderer.invoke('audio:chunk', payload),
    finish: (captureId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('audio:finish', captureId),
    abort: (captureId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('audio:abort', captureId),
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
