import { useEffect, useRef, useState } from "react";

import { type Recorder, startRecording } from "./audio/capture";

const MEETING_ID_MISSING_MESSAGE =
  "Geçerli meetingId bulunamadı; kayıt başlatılamaz. (meetingId kaynağı henüz belirlenmedi)";

interface RecorderRuntimeConfig {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
}

interface SafeJwtClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  scope?: string;
  exp?: number;
  tenantId?: number | string;
}

function App() {
  const [version, setVersion] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [claims, setClaims] = useState<SafeJwtClaims | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [recorderConfig, setRecorderConfig] =
    useState<RecorderRuntimeConfig | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const recorderRef = useRef<Recorder | null>(null);

  useEffect(() => {
    void window.electronAPI?.app
      .getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion("unknown"));
    void window.electronAPI?.auth
      .status()
      .then((s) => {
        setLoggedIn(s.loggedIn);
        setClaims(s.claims ?? null);
      })
      .catch(() => undefined);
    void window.electronAPI?.audio
      .recorderConfig()
      .then((cfg) => setRecorderConfig(cfg))
      .catch(() =>
        setRecorderConfig({
          meetingId: null,
          deviceId: "desktop-1",
          ready: false,
          reason: "Recorder runtime config okunamadi.",
        }),
      );
  }, []);

  const handleLogin = async (): Promise<void> => {
    setBusy(true);
    setError("");
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

  const handleLogout = async (): Promise<void> => {
    setError("");
    try {
      const s = await window.electronAPI?.auth.logout();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(null);
      setStatus("Çıkış yapıldı; Keycloak logout/revoke isteği gönderildi.");
    } catch (e) {
      setError(`Çıkış başarısız: ${(e as Error).message}`);
    }
  };

  const handleStart = async (): Promise<void> => {
    setError("");
    setStartPending(true);
    try {
      if (!recorderConfig?.ready || !recorderConfig.meetingId) {
        throw new Error(recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE);
      }
      const rec = await startRecording(
        recorderConfig.meetingId,
        recorderConfig.deviceId,
      );
      rec.onError((err) => {
        recorderRef.current = null;
        setRecording(false);
        setError(`Kayıt hatası (ses kaybı): ${err.message}`);
        setStatus("");
      });
      recorderRef.current = rec;
      setRecording(true);
      setStatus(`Kayıt başladı (oturum ${rec.sessionId})`);
    } catch (e) {
      setError(`Kayıt başlatılamadı: ${(e as Error).message}`);
    } finally {
      setStartPending(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await recorderRef.current?.stop();
      setStatus("Kayıt tamamlandı, gönderildi.");
    } catch (e) {
      setError(`Kayıt durdurulamadı: ${(e as Error).message}`);
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
        {!loggedIn ? (
          <>
            <p>Toplantı kaydı için giriş yapın.</p>
            <button
              type="button"
              onClick={() => void handleLogin()}
              disabled={busy}
            >
              {busy ? "Giriş açılıyor..." : "Giriş (Keycloak)"}
            </button>
          </>
        ) : recording ? (
          <>
            <p>Kayıt sürüyor...</p>
            <button type="button" onClick={() => void handleStop()}>
              Bitir
            </button>
          </>
        ) : (
          <>
            {recorderConfig?.ready ? (
              <p>Giriş yapıldı. Toplantı kaydına hazır.</p>
            ) : (
              <p>Giriş yapıldı. Kayıt için canonical meetingId bekleniyor.</p>
            )}
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={startPending || !recorderConfig?.ready}
            >
              {startPending
                ? "Başlatılıyor..."
                : recorderConfig?.ready
                  ? "Kaydet"
                  : "Meeting contract bekleniyor"}
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              style={{ marginLeft: 8 }}
            >
              Çıkış
            </button>
            {claims ? (
              <section className="claims">
                <h2>JWT claim özeti</h2>
                <dl>
                  <dt>iss</dt>
                  <dd>{claims.iss ?? "-"}</dd>
                  <dt>aud</dt>
                  <dd>
                    {Array.isArray(claims.aud)
                      ? claims.aud.join(", ")
                      : (claims.aud ?? "-")}
                  </dd>
                  <dt>azp</dt>
                  <dd>{claims.azp ?? "-"}</dd>
                  <dt>scope</dt>
                  <dd>{claims.scope ?? "-"}</dd>
                  <dt>tenantId</dt>
                  <dd>{claims.tenantId ?? "-"}</dd>
                  <dt>exp</dt>
                  <dd>
                    {claims.exp
                      ? new Date(claims.exp * 1000).toLocaleString()
                      : "-"}
                  </dd>
                </dl>
              </section>
            ) : null}
          </>
        )}
        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </main>
    </div>
  );
}

export default App;
