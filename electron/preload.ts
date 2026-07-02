/**
 * Preload bridge — sandboxed renderer ↔ main process secure IPC.
 *
 * contextIsolation: true sayesinde renderer Node API'lere doğrudan
 * erişemez. Bu dosya whitelist'li IPC methods sunar.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { AuthStatus } from './ipc/auth.js';

export interface TranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  text: string;
  textLength: number;
  status: string;
  receivedAtMs?: number | null;
  sttLanguage?: string | null;
  durationSeconds?: number | null;
  correlationId?: string | null;
}

export interface TranscriptGatewayError {
  sessionId: string;
  message: string;
}

const electronAPI = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  },
  audio: {
    recorderConfig: (): Promise<{
      meetingId: string | null;
      deviceId: string;
      ready: boolean;
      reason: string | null;
      liveSttStreamUrl: string | null;
      liveSttStreamReason: string | null;
    }> => ipcRenderer.invoke('audio:recorder-config'),
    permissionStatus: (): Promise<{ granted: boolean }> =>
      ipcRenderer.invoke('audio:permission-status'),
    prepareCapture: (): Promise<{ ok: boolean; expiresAtMs: number }> =>
      ipcRenderer.invoke('audio:prepare-capture'),
    cancelCapture: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('audio:cancel-capture'),
    consent: (
      consentVersion: string,
      consentTextHash: string,
      locale: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('audio:consent', consentVersion, consentTextHash, locale),
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
    rendererUnloaded: (): void => {
      ipcRenderer.send('audio:renderer-unloaded');
    },
    onTranscriptEvent: (callback: (event: TranscriptGatewayEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: TranscriptGatewayEvent): void => {
        callback(payload);
      };
      ipcRenderer.on('audio:transcript-event', listener);
      return () => ipcRenderer.removeListener('audio:transcript-event', listener);
    },
    onTranscriptError: (callback: (event: TranscriptGatewayError) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: TranscriptGatewayError): void => {
        callback(payload);
      };
      ipcRenderer.on('audio:transcript-error', listener);
      return () => ipcRenderer.removeListener('audio:transcript-error', listener);
    },
  },
  auth: {
    // Token RENDERER'a verilmez — yalnız durum (loggedIn/expiresAt) döner.
    login: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:login'),
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    logout: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:logout'),
  },
  meeting: {
    createContract: (payload?: {
      title?: string;
      description?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
    }): Promise<{
      id: string;
      title: string;
      status: string;
      scheduledStart?: string | null;
      scheduledEnd?: string | null;
    }> => ipcRenderer.invoke('meeting:create-contract', payload),
    analyze: (payload: {
      meetingId: string;
      request: {
        transcript: string;
        meeting_id?: string | null;
        session_id?: string | null;
        segments?: Array<{ text: string; start: number; end?: number }>;
      };
    }): Promise<unknown> => ipcRenderer.invoke('meeting:analyze', payload),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
