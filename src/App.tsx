import { useEffect, useRef, useState } from 'react';

import { type Recorder, startRecording } from './audio/capture';
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
  startTranscriptSession,
} from './transcript/session-transcript';

const MEETING_ID_MISSING_MESSAGE =
  'Geçerli meetingId bulunamadı; kayıt başlatılamaz. (meetingId kaynağı henüz belirlenmedi)';
const RECORDER_START_TIMEOUT_MS = 45_000;

interface RecorderRuntimeConfig {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
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

async function startRecordingWithTimeout(meetingId: string, deviceId: string): Promise<Recorder> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const pendingRecorder = startRecording(meetingId, deviceId);

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
  const recorderRef = useRef<Recorder | null>(null);
  const contractPendingRef = useRef(false);

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
    const cfg = {
      meetingId: contract.id,
      deviceId: recorderConfig?.deviceId ?? 'desktop-1',
      ready: true,
      reason: null,
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
      const rec = await startRecordingWithTimeout(meetingId, deviceId);
      rec.onError((err) => {
        recorderRef.current = null;
        setRecording(false);
        const message = `Kayıt hatası (ses kaybı): ${err.message}`;
        setError(message);
        setStatus('');
        setTranscriptSession((current) => failTranscriptSession(current, message));
        setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
      });
      recorderRef.current = rec;
      setRecording(true);
      setTranscriptSession((current) =>
        startTranscriptSession(current, {
          sessionId: rec.sessionId,
          meetingId,
          deviceId,
          hasLoopback: rec.hasLoopback,
          startedAtMs: Date.now(),
        }),
      );
      setMeetingIntelligence((current) =>
        markIntelligenceRecording(current, { meetingId, sessionId: rec.sessionId }),
      );
      const mode = rec.hasLoopback ? 'mikrofon + sistem sesi' : 'yalnız mikrofon';
      setStatus(`Kayıt başladı (${mode}, oturum ${rec.sessionId})`);
    } catch (e) {
      const message = `Kayıt başlatılamadı: ${(e as Error).message}`;
      setError(message);
      setTranscriptSession((current) => failTranscriptSession(current, message));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      setStartPending(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await recorderRef.current?.stop();
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
            <TranscriptPanel session={transcriptSession} />
            <SummaryPanel intelligence={meetingIntelligence} />
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
