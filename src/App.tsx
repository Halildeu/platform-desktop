import { useEffect, useRef, useState } from 'react';

import { type Recorder, startRecording } from './audio/capture';

function newMeetingId(): string {
  const year = new Date().getFullYear();
  const n = Math.floor(Math.random() * 100_000_000);
  return `MTG-${year}-${n}`;
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
  const [version, setVersion] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [claims, setClaims] = useState<SafeJwtClaims | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const recorderRef = useRef<Recorder | null>(null);

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

  const handleLogout = async (): Promise<void> => {
    setError('');
    try {
      const s = await window.electronAPI?.auth.logout();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(null);
      setStatus('Çıkış yapıldı; Keycloak logout/revoke isteği gönderildi.');
    } catch (e) {
      setError(`Çıkış başarısız: ${(e as Error).message}`);
    }
  };

  const handleStart = async (): Promise<void> => {
    setError('');
    setStartPending(true);
    try {
      const rec = await startRecording(newMeetingId(), 'desktop-1');
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
      setStatus('Kayıt tamamlandı, gönderildi.');
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
            <button type="button" onClick={() => void handleLogin()} disabled={busy}>
              {busy ? 'Giriş açılıyor...' : 'Giriş (Keycloak)'}
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
            <p>Giriş yapıldı. Toplantı kaydına hazır.</p>
            <button type="button" onClick={() => void handleStart()} disabled={startPending}>
              {startPending ? 'Başlatılıyor...' : 'Kaydet'}
            </button>
            <button type="button" onClick={() => void handleLogout()} style={{ marginLeft: 8 }}>
              Çıkış
            </button>
            {claims ? (
              <section className="claims">
                <h2>JWT claim özeti</h2>
                <dl>
                  <dt>iss</dt>
                  <dd>{claims.iss ?? '-'}</dd>
                  <dt>aud</dt>
                  <dd>{Array.isArray(claims.aud) ? claims.aud.join(', ') : claims.aud ?? '-'}</dd>
                  <dt>azp</dt>
                  <dd>{claims.azp ?? '-'}</dd>
                  <dt>scope</dt>
                  <dd>{claims.scope ?? '-'}</dd>
                  <dt>tenantId</dt>
                  <dd>{claims.tenantId ?? '-'}</dd>
                  <dt>exp</dt>
                  <dd>{claims.exp ? new Date(claims.exp * 1000).toLocaleString() : '-'}</dd>
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
