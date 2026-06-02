/**
 * Preload bridge — sandboxed renderer ↔ main process secure IPC.
 *
 * contextIsolation: true sayesinde renderer Node API'lere doğrudan
 * erişemez. Bu dosya whitelist'li IPC methods sunar.
 */

import { contextBridge, ipcRenderer } from 'electron';

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
    // Extend: login/logout/getToken (OAuth2 PKCE)
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
