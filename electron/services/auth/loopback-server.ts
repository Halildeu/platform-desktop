/**
 * Loopback OAuth callback server (RFC 8252, Codex hardening).
 *
 * - Yalnız 127.0.0.1'e bind (dış arayüze AÇILMAZ).
 * - state doğrular (CSRF); code yakalar; **callback sonrası listener'ı hemen kapatır.**
 * - Sabit port 8123 (Halil config) — Keycloak redirect: http://127.0.0.1:8123/callback.
 *
 * parseCallback saf/test-edilebilir; waitForCallback node http ile (fetch ile test edilir).
 */

import { createServer } from 'node:http';

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
}

/** Callback isteğinin URL'inden code/state/error çıkar (saf). */
export function parseCallback(reqUrl: string): CallbackParams {
  const u = new URL(reqUrl, 'http://127.0.0.1');
  return {
    code: u.searchParams.get('code') ?? undefined,
    state: u.searchParams.get('state') ?? undefined,
    error: u.searchParams.get('error') ?? undefined,
  };
}

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML =
  '<!doctype html><html lang="tr"><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:3rem">' +
  '<h2>Giriş başarılı ✓</h2><p>Bu pencereyi kapatıp uygulamaya dönebilirsiniz.</p></body></html>';

/**
 * 127.0.0.1:port'ta tek-seferlik OAuth callback bekler; code'u döner, sonra kapanır.
 * state beklenenle eşleşmezse veya error gelirse reject (+ server kapanır).
 */
export function waitForCallback(
  port: number,
  expectedState: string,
  timeoutMs = 120_000,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;

    const server = createServer((req, res) => {
      const p = parseCallback(req.url ?? '');
      if (p.error) {
        res.statusCode = 400;
        res.end('OAuth error');
        finish(() => reject(new Error(`oauth error: ${p.error}`)));
        return;
      }
      if (!p.code || p.state !== expectedState) {
        res.statusCode = 400;
        res.end('Invalid callback (state/code)');
        finish(() => reject(new Error('callback state mismatch or missing code')));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SUCCESS_HTML);
      finish(() => resolve({ code: p.code as string, state: p.state as string }));
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error('login callback timeout')));
    }, timeoutMs);

    function finish(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      action();
    }

    server.on('error', (err) => finish(() => reject(err)));
    server.listen(port, '127.0.0.1'); // yalnız loopback
  });
}
