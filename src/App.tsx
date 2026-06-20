import { useEffect, useState } from 'react';

/**
 * App — Meeting Intelligence root (Faz 24, bağımsız ürün).
 *
 * PR-desktop-01: Keycloak SSO PKCE login UI. Token RENDERER'da TUTULMAZ —
 * yalnız `loggedIn` durumu (gerçek OAuth + token main-process'te).
 * Sonraki: audio capture (loopback+mic), live transcript, summary.
 */
function App() {
  const [version, setVersion] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.electronAPI?.app
      .getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion('unknown'));
    void window.electronAPI?.auth
      .status()
      .then((s) => setLoggedIn(s.loggedIn))
      .catch(() => undefined);
  }, []);

  const handleLogin = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const s = await window.electronAPI?.auth.login();
      setLoggedIn(s?.loggedIn ?? false);
    } catch (e) {
      setError(`Giriş başarısız: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    const s = await window.electronAPI?.auth.logout();
    setLoggedIn(s?.loggedIn ?? false);
  };

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Meeting Intelligence</h1>
        <span className="version">v{version}</span>
      </header>
      <main className="app-main">
        {loggedIn ? (
          <>
            <p>✓ Giriş yapıldı. Toplantı kaydına hazır.</p>
            <button type="button" onClick={() => void handleLogout()}>
              Çıkış
            </button>
          </>
        ) : (
          <>
            <p>Toplantı kaydı için giriş yapın.</p>
            <button type="button" onClick={() => void handleLogin()} disabled={busy}>
              {busy ? 'Giriş açılıyor…' : 'Giriş (Keycloak)'}
            </button>
          </>
        )}
        {error ? <p className="error">{error}</p> : null}
      </main>
    </div>
  );
}

export default App;
