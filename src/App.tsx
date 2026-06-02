import { useEffect, useState } from 'react';

/**
 * App — Workcube Meeting Intelligence root component.
 *
 * Faz 24 M6 Integration — PR-desktop-01 skeleton. Sonraki PR'larda:
 * - Keycloak SSO PKCE login
 * - Meeting list + create
 * - Audio capture (mikrofon)
 * - Live transcript view
 * - Speaker diarization timeline
 * - Summary + actions panel
 */
function App(): JSX.Element {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    void window.electronAPI?.app
      .getVersion()
      .then((v: string) => setVersion(v))
      .catch(() => setVersion('unknown'));
  }, []);

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Workcube Meeting Intelligence</h1>
        <span className="version">v{version}</span>
      </header>
      <main className="app-main">
        <p>Faz 24 M6 Integration — skeleton.</p>
        <p>Next: Keycloak SSO + audio capture + live transcript.</p>
      </main>
    </div>
  );
}

export default App;
