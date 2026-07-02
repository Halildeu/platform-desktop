import { useEffect, useRef, useState } from 'react';

import {
  initialAudioCapturePreflightState,
  type AudioCapturePreflightState,
  type Recorder,
  startRecording,
  testAudioCaptureWorklet,
} from './audio/capture';
import {
  initialLiveSttPreflightState,
  testLiveSttStreamConnection,
  type LiveSttPreflightState,
} from './audio/live-stt-preflight';
import type { LiveSttStreamStatusEvent, LiveSttTranscriptEvent } from './audio/live-stt-stream';
import {
  ConsentDialog,
  CONSENT_VERSION,
  CONSENT_TEXT_HASH,
  CONSENT_LOCALE,
} from './components/ConsentDialog';
import { SummaryPanel } from './components/SummaryPanel';
import {
  bindMeetingIntelligenceTarget,
  failMeetingIntelligence,
  initialMeetingIntelligence,
  markIntelligenceRecording,
  markIntelligenceWaiting,
} from './intelligence/meeting-intelligence';
import { TranscriptPanel } from './components/TranscriptPanel';
import {
  failTranscriptSession,
  finishTranscriptSession,
  initialTranscriptSession,
  markTranscriptBlocked,
  markTranscriptReady,
  markTranscriptWaitingForContract,
  startTranscriptSession,
  type TranscriptSegmentStatus,
  upsertTranscriptSegment,
} from './transcript/session-transcript';

const MEETING_ID_MISSING_MESSAGE =
  'Geçerli meetingId bulunamadı; kayıt başlatılamaz. (meetingId kaynağı henüz belirlenmedi)';
const RECORDER_MEETING_ID_UNSET_MARKER = 'RECORDER_MEETING_ID tanimli degil';
const RECORDER_START_TIMEOUT_MS = 45_000;
const TRANSCRIPT_CLIENT_CLOCK_SKEW_MS = 30_000;
const MAX_PENDING_LIVE_TRANSCRIPT_EVENTS = 50;
const ACTIVE_AUDIO_RMS = 0.006;

interface RecorderRuntimeConfig {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
  liveSttStreamUrl: string | null;
  liveSttStreamReason: string | null;
}

interface MeetingContract {
  id: string;
  title: string;
  status: string;
}

interface SafeJwtClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  scope?: string;
  exp?: number;
  tenantId?: number | string;
  userId?: number | string;
  companyId?: number | string;
}

async function startRecordingWithTimeout(
  meetingId: string,
  deviceId: string,
  options?: Parameters<typeof startRecording>[2],
): Promise<Recorder> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const pendingRecorder = startRecording(meetingId, deviceId, options);

  void pendingRecorder
    .then((rec) => {
      if (didTimeout) {
        void rec.stop().catch(() => undefined);
      }
    })
    .catch(() => undefined);

  try {
    return await new Promise<Recorder>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        reject(
          new Error(
            `Recorder başlatma ${Math.round(
              RECORDER_START_TIMEOUT_MS / 1000,
            )} sn içinde yanıt vermedi; izin/gateway zinciri kontrol edilmeli.`,
          ),
        );
      }, RECORDER_START_TIMEOUT_MS);

      pendingRecorder.then(
        (rec) => {
          if (!didTimeout) {
            resolve(rec);
          }
        },
        (err: unknown) => {
          if (!didTimeout) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function transcriptStatusFromGateway(status: string): TranscriptSegmentStatus {
  switch (status.toUpperCase()) {
    case 'FINAL':
      return 'final';
    case 'REVISED':
      return 'revised';
    case 'STABILIZING':
      return 'stabilizing';
    default:
      return 'draft';
  }
}

function transcriptStatusFromLiveStream(
  status: LiveSttTranscriptEvent['status'],
): TranscriptSegmentStatus {
  return status === 'final' ? 'final' : 'draft';
}

function transcriptTimelineStartedAtMs(event: {
  chunkStartedAtMs: number;
  windowStartedAtMs?: number | null;
  receivedAtMs?: number | null;
}): number {
  const eventStartedAtMs =
    typeof event.windowStartedAtMs === 'number' && Number.isFinite(event.windowStartedAtMs)
      ? event.windowStartedAtMs
      : event.chunkStartedAtMs;
  const receivedAtMs = event.receivedAtMs;
  if (
    typeof receivedAtMs === 'number' &&
    Number.isFinite(receivedAtMs) &&
    eventStartedAtMs - receivedAtMs > TRANSCRIPT_CLIENT_CLOCK_SKEW_MS
  ) {
    return receivedAtMs;
  }
  return eventStartedAtMs;
}

function transcriptSegmentIdFromGateway(event: {
  eventId: string;
  sessionId: string;
  windowSeq?: number | null;
}): string {
  if (
    typeof event.windowSeq === 'number' &&
    Number.isFinite(event.windowSeq) &&
    event.windowSeq >= 0
  ) {
    return `gateway:${event.sessionId}:window:${event.windowSeq}`;
  }
  return event.eventId;
}

function applyLiveTranscriptEvent(
  current: ReturnType<typeof initialTranscriptSession>,
  event: LiveSttTranscriptEvent,
): ReturnType<typeof initialTranscriptSession> {
  return upsertTranscriptSegment(current, {
    id: event.id,
    speakerLabel: 'Konuşmacı',
    startedAtMs: event.startedAtMs,
    status: transcriptStatusFromLiveStream(event.status),
    text: event.text,
    source: 'direct-stream',
    elapsedMs: event.elapsedMs ?? null,
    rms: event.rms ?? null,
    receivedAtMs: Date.now(),
  });
}

function isContractCreationExpected(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.includes(RECORDER_MEETING_ID_UNSET_MARKER);
}

function markMeetingIntelligenceWaitingForContract(
  current: ReturnType<typeof initialMeetingIntelligence>,
): ReturnType<typeof initialMeetingIntelligence> {
  return {
    ...current,
    meetingId: null,
    sessionId: null,
    status: 'idle',
    error: null,
    result: null,
  };
}

function App() {
  const [version, setVersion] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [claims, setClaims] = useState<SafeJwtClaims | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [contractPending, setContractPending] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [recorderConfig, setRecorderConfig] = useState<RecorderRuntimeConfig | null>(null);
  const [transcriptSession, setTranscriptSession] = useState(initialTranscriptSession);
  const [meetingIntelligence, setMeetingIntelligence] = useState(initialMeetingIntelligence);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [liveStreamActive, setLiveStreamActive] = useState(false);
  const [liveStreamReady, setLiveStreamReady] = useState(false);
  const [liveStreamStatus, setLiveStreamStatus] = useState<LiveSttStreamStatusEvent | null>(null);
  const [liveStreamPreflight, setLiveStreamPreflight] = useState<LiveSttPreflightState>(
    initialLiveSttPreflightState,
  );
  const [audioCapturePreflight, setAudioCapturePreflight] = useState<AudioCapturePreflightState>(
    initialAudioCapturePreflightState,
  );
  const [audioRms, setAudioRms] = useState<number | null>(null);
  const [lastAudioAtMs, setLastAudioAtMs] = useState<number | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const contractPendingRef = useRef(false);
  const liveStreamHasEventsRef = useRef(false);
  const directStreamConfiguredRef = useRef(false);
  const transcriptSessionIdRef = useRef<string | null>(null);
  const pendingLiveTranscriptEventsRef = useRef<LiveSttTranscriptEvent[]>([]);

  const enqueuePendingLiveTranscriptEvent = (event: LiveSttTranscriptEvent): void => {
    pendingLiveTranscriptEventsRef.current = [
      ...pendingLiveTranscriptEventsRef.current,
      event,
    ].slice(-MAX_PENDING_LIVE_TRANSCRIPT_EVENTS);
  };

  useEffect(() => {
    transcriptSessionIdRef.current = transcriptSession.sessionId;
  }, [transcriptSession.sessionId]);

  useEffect(() => {
    directStreamConfiguredRef.current = Boolean(recorderConfig?.liveSttStreamUrl);
  }, [recorderConfig?.liveSttStreamUrl]);

  useEffect(() => {
    setLiveStreamPreflight(initialLiveSttPreflightState);
  }, [recorderConfig?.liveSttStreamUrl]);

  useEffect(() => {
    if (!transcriptSession.sessionId || pendingLiveTranscriptEventsRef.current.length === 0) {
      return;
    }

    const pending = pendingLiveTranscriptEventsRef.current;
    pendingLiveTranscriptEventsRef.current = [];
    setTranscriptSession((current) => {
      if (!current.sessionId) {
        pendingLiveTranscriptEventsRef.current = [
          ...pending,
          ...pendingLiveTranscriptEventsRef.current,
        ].slice(-MAX_PENDING_LIVE_TRANSCRIPT_EVENTS);
        return current;
      }
      return pending.reduce(applyLiveTranscriptEvent, current);
    });
  }, [transcriptSession.sessionId]);

  useEffect(() => {
    void window.electronAPI?.app
      .getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion('unknown'));
    void window.electronAPI?.auth
      .status()
      .then((s) => {
        setLoggedIn(s.loggedIn);
        setClaims(s.claims ?? null);
      })
      .catch(() => undefined);
    void window.electronAPI?.audio
      .recorderConfig()
      .then((cfg) => {
        setRecorderConfig(cfg);
        if (!cfg.ready && isContractCreationExpected(cfg.reason)) {
          setTranscriptSession((current) =>
            markTranscriptWaitingForContract(current, { deviceId: cfg.deviceId }),
          );
          setMeetingIntelligence((current) => markMeetingIntelligenceWaitingForContract(current));
          return;
        }
        setTranscriptSession((current) =>
          cfg.ready && cfg.meetingId
            ? markTranscriptReady(current, { meetingId: cfg.meetingId, deviceId: cfg.deviceId })
            : markTranscriptBlocked(current, {
                reason: cfg.reason ?? MEETING_ID_MISSING_MESSAGE,
              }),
        );
        setMeetingIntelligence((current) =>
          bindMeetingIntelligenceTarget(current, { meetingId: cfg.meetingId }),
        );
      })
      .catch(() => {
        const fallback = {
          meetingId: null,
          deviceId: 'desktop-1',
          ready: false,
          reason: 'Recorder runtime config okunamadi.',
          liveSttStreamUrl: null,
          liveSttStreamReason: null,
        };
        setRecorderConfig(fallback);
        setTranscriptSession((current) =>
          markTranscriptBlocked(current, { reason: fallback.reason }),
        );
        setMeetingIntelligence((current) =>
          bindMeetingIntelligenceTarget(current, { meetingId: fallback.meetingId }),
        );
      });
  }, []);

  useEffect(() => {
    const offTranscriptEvent = window.electronAPI?.audio.onTranscriptEvent?.((event) => {
      setTranscriptSession((current) => {
        if (!current.sessionId || event.sessionId !== current.sessionId) {
          return current;
        }
        if (directStreamConfiguredRef.current || liveStreamHasEventsRef.current) {
          return current;
        }
        if (!event.text.trim() || !Number.isFinite(event.chunkStartedAtMs)) {
          return current;
        }
        return upsertTranscriptSegment(current, {
          id: transcriptSegmentIdFromGateway(event),
          speakerLabel: 'Konuşmacı',
          startedAtMs: transcriptTimelineStartedAtMs(event),
          status: transcriptStatusFromGateway(event.status),
          text: event.text,
          source: 'gateway-events',
          elapsedMs:
            typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds)
              ? Math.round(event.durationSeconds * 1000)
              : null,
          receivedAtMs: event.receivedAtMs ?? null,
        });
      });
    });
    const offTranscriptError = window.electronAPI?.audio.onTranscriptError?.((event) => {
      setTranscriptSession((current) => {
        if (!current.sessionId || event.sessionId !== current.sessionId) {
          return current;
        }
        return { ...current, error: event.message };
      });
    });
    const notifyRendererUnload = (): void => {
      window.electronAPI?.audio.rendererUnloaded?.();
    };

    window.addEventListener('beforeunload', notifyRendererUnload);

    return () => {
      notifyRendererUnload();
      offTranscriptEvent?.();
      offTranscriptError?.();
      window.removeEventListener('beforeunload', notifyRendererUnload);
    };
  }, []);

  const handleLogin = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const s = await window.electronAPI?.auth.login();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(s?.claims ?? null);
    } catch (e) {
      setError(`Giriş başarısız: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const bindReadyMeetingContract = (contract: MeetingContract): void => {
    const cfg: RecorderRuntimeConfig = {
      meetingId: contract.id,
      deviceId: recorderConfig?.deviceId ?? 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: recorderConfig?.liveSttStreamUrl ?? null,
      liveSttStreamReason: recorderConfig?.liveSttStreamReason ?? null,
    };
    setRecorderConfig(cfg);
    setTranscriptSession((current) =>
      markTranscriptReady(current, { meetingId: contract.id, deviceId: cfg.deviceId }),
    );
    setMeetingIntelligence((current) =>
      bindMeetingIntelligenceTarget(current, { meetingId: contract.id }),
    );
    setStatus(`Meeting contract hazır: ${contract.id}`);
  };

  const handleCreateMeetingContract = async (): Promise<void> => {
    if (contractPendingRef.current) {
      return;
    }
    contractPendingRef.current = true;
    setError('');
    setStatus('');
    setContractPending(true);
    try {
      const scheduledStart = new Date().toISOString();
      const contract = await window.electronAPI?.meeting.createContract({
        title: `Faz 24 desktop recording ${scheduledStart}`,
        description: 'Faz 24 desktop recorder live contract.',
        scheduledStart,
      });
      if (!contract) {
        throw new Error('meeting-service response empty');
      }
      bindReadyMeetingContract(contract);
    } catch (e) {
      const message = `Meeting contract oluşturulamadı: ${(e as Error).message}`;
      setError(message);
      setTranscriptSession((current) => markTranscriptBlocked(current, { reason: message }));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      contractPendingRef.current = false;
      setContractPending(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    setError('');
    try {
      const s = await window.electronAPI?.auth.logout();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(null);
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setLiveStreamPreflight(initialLiveSttPreflightState);
      setAudioRms(null);
      setLastAudioAtMs(null);
      setTranscriptSession(initialTranscriptSession());
      setMeetingIntelligence(initialMeetingIntelligence());
      setStatus('Çıkış yapıldı; Keycloak logout/revoke isteği gönderildi.');
    } catch (e) {
      setError(`Çıkış başarısız: ${(e as Error).message}`);
    }
  };

  const handleRecordClick = (): void => {
    if (!recorderConfig?.ready || !recorderConfig.meetingId) {
      setError(recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE);
      setTranscriptSession((current) =>
        markTranscriptBlocked(current, {
          reason: recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE,
        }),
      );
      setMeetingIntelligence((current) =>
        bindMeetingIntelligenceTarget(current, { meetingId: recorderConfig?.meetingId ?? null }),
      );
      return;
    }
    setShowConsent(true);
  };

  const handleConsentAccept = (): void => {
    setShowConsent(false);
    void (async () => {
      try {
        await window.electronAPI?.audio.consent(CONSENT_VERSION, CONSENT_TEXT_HASH, CONSENT_LOCALE);
      } catch (e) {
        const message = `Rıza kaydı başarısız: ${(e as Error).message}`;
        setError(message);
        setTranscriptSession((current) => failTranscriptSession(current, message));
        setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
        return;
      }
      await handleStart();
    })();
  };

  const handleConsentCancel = (): void => {
    setShowConsent(false);
  };

  const handleStart = async (): Promise<void> => {
    setError('');
    setStartPending(true);
    try {
      if (!recorderConfig?.ready || !recorderConfig.meetingId) {
        throw new Error(recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE);
      }
      const meetingId = recorderConfig.meetingId;
      const deviceId = recorderConfig.deviceId;
      liveStreamHasEventsRef.current = false;
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      const rec = await startRecordingWithTimeout(meetingId, deviceId, {
        liveSttStreamUrl: recorderConfig.liveSttStreamUrl,
        onLiveStreamReady: () => {
          setLiveStreamReady(true);
        },
        onLiveStreamStatus: (event) => {
          setLiveStreamStatus(event);
          if (event.status !== 'ready') {
            setLiveStreamReady(false);
          }
        },
        onAudioActivity: (activity) => {
          setAudioRms(activity.rms);
          setLastAudioAtMs(activity.capturedAtMs);
        },
        onLiveTranscriptEvent: (event) => {
          liveStreamHasEventsRef.current = true;
          setLiveStreamReady(true);
          setLiveStreamActive(true);
          if (!transcriptSessionIdRef.current) {
            enqueuePendingLiveTranscriptEvent(event);
            return;
          }
          setTranscriptSession((current) => {
            if (!current.sessionId) {
              enqueuePendingLiveTranscriptEvent(event);
              return current;
            }
            return applyLiveTranscriptEvent(current, event);
          });
        },
        onLiveTranscriptError: (err) => {
          setTranscriptSession((current) => {
            if (!current.sessionId) {
              return current;
            }
            return {
              ...current,
              error: `Live STT stream: ${err.message}`,
            };
          });
        },
      });
      rec.onError((err) => {
        recorderRef.current = null;
        transcriptSessionIdRef.current = null;
        pendingLiveTranscriptEventsRef.current = [];
        setLiveStreamActive(false);
        setLiveStreamReady(false);
        setLiveStreamStatus(null);
        setAudioRms(null);
        setLastAudioAtMs(null);
        setRecording(false);
        const message = `Kayıt hatası (ses kaybı): ${err.message}`;
        setError(message);
        setStatus('');
        setTranscriptSession((current) => failTranscriptSession(current, message));
        setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
      });
      recorderRef.current = rec;
      setRecording(true);
      const pendingLiveTranscriptEvents = pendingLiveTranscriptEventsRef.current;
      pendingLiveTranscriptEventsRef.current = [];
      setTranscriptSession((current) =>
        pendingLiveTranscriptEvents.reduce(
          applyLiveTranscriptEvent,
          startTranscriptSession(current, {
            sessionId: rec.sessionId,
            meetingId,
            deviceId,
            hasLoopback: rec.hasLoopback,
            startedAtMs: Date.now(),
          }),
        ),
      );
      setMeetingIntelligence((current) =>
        markIntelligenceRecording(current, { meetingId, sessionId: rec.sessionId }),
      );
      const mode = rec.hasLoopback ? 'mikrofon + sistem sesi' : 'yalnız mikrofon';
      setStatus(`Kayıt başladı (${mode}, oturum ${rec.sessionId})`);
    } catch (e) {
      const message = `Kayıt başlatılamadı: ${(e as Error).message}`;
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      setError(message);
      setTranscriptSession((current) => failTranscriptSession(current, message));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      setStartPending(false);
    }
  };

  const handleLiveStreamPreflight = async (): Promise<void> => {
    const captureCheck = (async (): Promise<void> => {
      setAudioCapturePreflight({
        status: 'checking',
        message: 'Ses işleyici kontrol ediliyor...',
        checkedAtMs: null,
        elapsedMs: null,
        moduleUrl: null,
      });
      try {
        const result = await testAudioCaptureWorklet();
        setAudioCapturePreflight({
          status: result.ok ? 'ready' : 'error',
          message: result.message,
          checkedAtMs: Date.now(),
          elapsedMs: result.elapsedMs,
          moduleUrl: result.moduleUrl,
        });
      } catch (error) {
        setAudioCapturePreflight({
          status: 'error',
          message: `Ses işleyici test hatası: ${
            error instanceof Error ? error.message : String(error)
          }`,
          checkedAtMs: Date.now(),
          elapsedMs: null,
          moduleUrl: null,
        });
      }
    })();

    const streamUrl = recorderConfig?.liveSttStreamUrl;
    if (!streamUrl) {
      setLiveStreamPreflight({
        status: 'error',
        message: recorderConfig?.liveSttStreamReason ?? 'LIVE_STT_STREAM_URL tanimli degil.',
        checkedAtMs: Date.now(),
        elapsedMs: null,
        stage: null,
      });
      await captureCheck;
      return;
    }

    setLiveStreamPreflight({
      status: 'checking',
      message: 'Direct STT stream kontrol ediliyor...',
      checkedAtMs: null,
      elapsedMs: null,
      stage: null,
    });
    try {
      const result = await testLiveSttStreamConnection(streamUrl);
      setLiveStreamPreflight({
        status: result.ok ? 'ready' : 'error',
        message: result.message,
        checkedAtMs: Date.now(),
        elapsedMs: result.elapsedMs,
        stage: result.stage,
      });
    } catch (error) {
      setLiveStreamPreflight({
        status: 'error',
        message: `Direct STT test hatasi: ${
          error instanceof Error ? error.message : String(error)
        }`,
        checkedAtMs: Date.now(),
        elapsedMs: null,
        stage: null,
      });
    }
    await captureCheck;
  };

  const handleStop = async (): Promise<void> => {
    try {
      await recorderRef.current?.stop();
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      setStatus('Kayıt tamamlandı, gönderildi.');
      setTranscriptSession((current) => finishTranscriptSession(current, Date.now()));
      setMeetingIntelligence((current) => markIntelligenceWaiting(current));
    } catch (e) {
      const message = `Kayıt durdurulamadı: ${(e as Error).message}`;
      setError(message);
      setTranscriptSession((current) => failTranscriptSession(current, message));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      recorderRef.current = null;
      setRecording(false);
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
    }
  };

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Meeting Intelligence</h1>
        <span className="version">v{version}</span>
      </header>
      <main className="app-main">
        <section className="recorder-shell" aria-label="Recorder çalışma alanı">
          <div className="control-panel">
            {!loggedIn ? (
              <>
                <p className="control-copy">Toplantı kaydı için giriş yapın.</p>
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => void handleLogin()}
                  disabled={busy}
                >
                  {busy ? 'Giriş açılıyor...' : 'Giriş'}
                </button>
              </>
            ) : recording ? (
              <>
                <p className="control-copy">Kayıt sürüyor.</p>
                <button className="danger-action" type="button" onClick={() => void handleStop()}>
                  Bitir
                </button>
              </>
            ) : (
              <>
                {recorderConfig?.ready ? (
                  <p className="control-copy">Giriş yapıldı. Toplantı kaydına hazır.</p>
                ) : (
                  <p className="control-copy">
                    Giriş yapıldı. Kayıt için canonical meetingId bekleniyor.
                  </p>
                )}
                <div className="control-actions">
                  <button
                    className="primary-action"
                    type="button"
                    onClick={
                      recorderConfig?.ready
                        ? handleRecordClick
                        : () => void handleCreateMeetingContract()
                    }
                    disabled={startPending || contractPending}
                  >
                    {startPending
                      ? 'Başlatılıyor...'
                      : contractPending
                        ? 'Contract oluşturuluyor...'
                        : recorderConfig?.ready
                          ? 'Kaydet'
                          : 'Meeting contract oluştur'}
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => void handleLogout()}
                  >
                    Çıkış
                  </button>
                </div>
              </>
            )}
            {status ? <p className="status">{status}</p> : null}
            {error ? <p className="error">{error}</p> : null}
            {claims ? (
              <section className="claims">
                <h2>JWT claim özeti</h2>
                <dl>
                  <dt>aud</dt>
                  <dd>{Array.isArray(claims.aud) ? claims.aud.join(', ') : (claims.aud ?? '-')}</dd>
                  <dt>azp</dt>
                  <dd>{claims.azp ?? '-'}</dd>
                  <dt>tenantId</dt>
                  <dd>{claims.tenantId ?? '-'}</dd>
                  <dt>userId</dt>
                  <dd>{claims.userId ?? '-'}</dd>
                  <dt>companyId</dt>
                  <dd>{claims.companyId ?? '-'}</dd>
                  <dt>exp</dt>
                  <dd>{claims.exp ? new Date(claims.exp * 1000).toLocaleString() : '-'}</dd>
                </dl>
              </section>
            ) : null}
          </div>
          <div className="intelligence-workspace">
            <TranscriptPanel
              session={transcriptSession}
              stream={{
                directConfigured: Boolean(recorderConfig?.liveSttStreamUrl),
                directReady: liveStreamReady,
                directStatus: liveStreamStatus,
                directActive: liveStreamActive,
                audioRms,
                audioActive: typeof audioRms === 'number' && audioRms >= ACTIVE_AUDIO_RMS,
                lastAudioAtMs,
                disabledReason: recorderConfig?.liveSttStreamReason ?? null,
                preflight: liveStreamPreflight,
                capturePreflight: audioCapturePreflight,
                onPreflight: recording ? undefined : () => void handleLiveStreamPreflight(),
              }}
            />
            <SummaryPanel intelligence={meetingIntelligence} transcript={transcriptSession} />
          </div>
        </section>
      </main>
      {showConsent ? (
        <ConsentDialog onAccept={handleConsentAccept} onCancel={handleConsentCancel} />
      ) : null}
    </div>
  );
}

export default App;
