/**
 * Preload bridge — sandboxed renderer ↔ main process secure IPC.
 *
 * contextIsolation: true sayesinde renderer Node API'lere doğrudan
 * erişemez. Bu dosya whitelist'li IPC methods sunar.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { AuthStatus } from './ipc/auth.js';
import type { AudioFinishResult } from './ipc/audio.js';
import type {
  LiveAnalysisFrame,
  LiveAnalysisStatus,
} from './services/meeting/live-analysis-stream.js';
import type {
  MeetingIntelligenceReadOutcome,
  RecentMeetingsPage,
} from './services/meeting/meeting-client.js';

/** Every live-analysis IPC payload carries the meetingId so the renderer can
 *  filter for its currently-open meeting (multiple subscriptions may coexist).
 */
export interface LiveAnalysisFramePayload extends LiveAnalysisFrame {
  meetingId: string;
}
export interface LiveAnalysisStatusPayload {
  meetingId: string;
  status: LiveAnalysisStatus;
}

export interface TranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  transportEpoch?: number | null;
  windowSeq?: number | null;
  firstChunkSeq?: number | null;
  lastChunkSeq?: number | null;
  windowStartedAtMs?: number | null;
  windowEndedAtMs?: number | null;
  audioDurationMs?: number | null;
  flushReason?: string | null;
  text: string;
  textLength: number;
  status: string;
  receivedAtMs?: number | null;
  sttLanguage?: string | null;
  durationSeconds?: number | null;
  correlationId?: string | null;
  /**
   * Gateway cumle birlestirici (backend PR #918) alanlari.
   * UTTERANCE olaylarinda dolu gelir; DRAFT'ta bos kalir.
   * `sourceEventIds` hangi ham parcalarin bu cumleye katlandigini
   * soyler — istemci o parcalari ekrandan kaldirmak icin kullanir,
   * aksi halde ayni metin hem parcali hem butun gorunur.
   */
  assemblyReason?: string | null;
  sourceEventIds?: string[];
}

export interface TranscriptGatewayError {
  sessionId: string;
  message: string;
}

const electronAPI = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
    getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke('app:get-auto-launch'),
    setAutoLaunch: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('app:set-auto-launch', enabled),
  },
  tray: {
    // Renderer, main process'e "kayıt aktif/pasif" durumunu bildirir — tray
    // ikonu/menüsü buna göre güncellenir. Gerçek kayıt state machine'i
    // renderer'da kalır (App.tsx); tray sadece yansıtır + kısayol sunar.
    setRecordingActive: (
      active: boolean,
      outcome?: 'finished' | 'degraded' | 'error',
      errorMessage?: string,
    ): void => {
      ipcRenderer.send('tray:set-recording-active', active, outcome, errorMessage);
    },
    // #37: renderer reflects pause state to the tray (menu/tooltip); the pause
    // state machine itself stays in the renderer (App.tsx + capture pipeline).
    setPaused: (paused: boolean): void => {
      ipcRenderer.send('tray:set-paused', paused);
    },
    onStopRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('tray:stop-requested', listener);
      return () => ipcRenderer.removeListener('tray:stop-requested', listener);
    },
    onPauseRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('tray:pause-requested', listener);
      return () => ipcRenderer.removeListener('tray:pause-requested', listener);
    },
    onResumeRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('tray:resume-requested', listener);
      return () => ipcRenderer.removeListener('tray:resume-requested', listener);
    },
  },
  audio: {
    recorderConfig: (): Promise<{
      meetingId: string | null;
      deviceId: string;
      ready: boolean;
      reason: string | null;
      gatewayLiveStreamEnabled: boolean;
      liveSttStreamUrl: string | null;
      liveSttStreamReason: string | null;
    }> => ipcRenderer.invoke('audio:recorder-config'),
    reconcileLifecycle: (): Promise<{
      ok: boolean;
      processed: number;
      remaining: number;
      terminalized: number;
    }> => ipcRenderer.invoke('audio:reconcile-lifecycle'),
    permissionStatus: (): Promise<{
      status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
      granted: boolean;
      canRequest: boolean;
    }> => ipcRenderer.invoke('audio:permission-status'),
    requestPermission: (): Promise<{
      status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
      granted: boolean;
      canRequest: boolean;
    }> => ipcRenderer.invoke('audio:request-permission'),
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
      contextTerms?: readonly string[],
      sttProvider?: 'internal' | 'speechmatics',
      transcriptionMode?: 'balanced' | 'realtime',
    ): Promise<{
      sessionId: string;
      transcriptSessionId: string;
      captureId: string;
      sttProvider?: 'internal' | 'speechmatics';
      transcriptionMode?: 'balanced' | 'realtime';
    }> =>
      ipcRenderer.invoke(
        'audio:start',
        meetingId,
        deviceId,
        contextTerms,
        sttProvider,
        transcriptionMode,
      ),
    sendChunk: (payload: {
      captureId: string;
      bytes: Uint8Array;
      startedAtMs: number;
    }): Promise<{ seq: number }> => ipcRenderer.invoke('audio:chunk', payload),
    sendLiveFrame: (payload: {
      captureId: string;
      bytes: Uint8Array;
      capturedAtMs: number;
    }): Promise<{ accepted: boolean }> => ipcRenderer.invoke('audio:live-frame', payload),
    finish: (captureId: string): Promise<AudioFinishResult> =>
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
    onTranscriptRecovered: (callback: (event: { sessionId: string }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: { sessionId: string }): void => {
        callback(payload);
      };
      ipcRenderer.on('audio:transcript-recovered', listener);
      return () => ipcRenderer.removeListener('audio:transcript-recovered', listener);
    },
  },
  auth: {
    // Token RENDERER'a verilmez — yalnız durum (loggedIn/expiresAt) döner.
    login: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:login'),
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    logout: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:logout'),
  },
  meeting: {
    listRecent: (): Promise<RecentMeetingsPage> => ipcRenderer.invoke('meeting:list-recent'),
    createContract: (payload?: {
      title?: string;
      description?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      // Faz 24 STT (platform-backend#1024): consent-bound speech-context terms.
      // The meeting:create-contract IPC handler already parses + normalizes this
      // (slice 3); exposing it here lets the renderer set the meeting vocabulary.
      speechContextTerms?: string[];
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
    getIntelligenceResult: (payload: {
      meetingId: string;
    }): Promise<MeetingIntelligenceReadOutcome> =>
      ipcRenderer.invoke('meeting:get-intelligence-result', payload),
    /** Faz 24 Görevler dilim-3: canlı panelden aksiyonu göreve dönüştür. */
    createAction: (payload: {
      meetingId: string;
      description: string;
      assigneeSubject?: string | null;
      assigneeUserId?: number | null;
      dueAt?: string | null;
    }): Promise<{
      id: string;
      meetingId: string;
      description: string;
      assigneeSubject: string | null;
      status: string;
      dueAt: string | null;
      version: number;
    }> => ipcRenderer.invoke('meeting:action-create', payload),
    searchAssignees: (payload: {
      query: string;
    }): Promise<Array<{ userId: number; label: string }>> =>
      ipcRenderer.invoke('meeting:assignee-search', payload),
    /** Start the SSE subscription for a meeting's live analysis stream.
     *  Idempotent (a second start for the same meetingId returns
     *  `{started:false}`). Frames arrive via `onLiveAnalysisFrame`.
     */
    startLiveAnalysis: (payload: { meetingId: string }): Promise<{ started: boolean }> =>
      ipcRenderer.invoke('meeting:live-analysis-start', payload),
    stopLiveAnalysis: (payload: { meetingId: string }): Promise<{ stopped: boolean }> =>
      ipcRenderer.invoke('meeting:live-analysis-stop', payload),
    onLiveAnalysisFrame: (callback: (frame: LiveAnalysisFramePayload) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: LiveAnalysisFramePayload): void => {
        callback(payload);
      };
      ipcRenderer.on('meeting:live-analysis-frame', listener);
      return () => ipcRenderer.removeListener('meeting:live-analysis-frame', listener);
    },
    onLiveAnalysisStatus: (callback: (status: LiveAnalysisStatusPayload) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: LiveAnalysisStatusPayload): void => {
        callback(payload);
      };
      ipcRenderer.on('meeting:live-analysis-status', listener);
      return () => ipcRenderer.removeListener('meeting:live-analysis-status', listener);
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
