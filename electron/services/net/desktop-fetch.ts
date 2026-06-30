import { Agent } from 'undici';

const CONNECT_TIMEOUT_MS = 30_000;

const dispatcher = new Agent({
  connect: {
    timeout: CONNECT_TIMEOUT_MS,
  },
});

/**
 * Electron main-process HTTP calls use Undici's fetch implementation. On the
 * corporate/VPN route to testai.acik.com the default 10s connect timeout can
 * fail even while Node's core https client and curl succeed. Keep one shared
 * dispatcher so auth, meeting, and audio-gateway calls use the same route
 * behavior.
 */
export function desktopFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, dispatcher } as unknown as RequestInit);
}
