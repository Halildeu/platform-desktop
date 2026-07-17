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

export async function withDesktopFetchDeadline<T>(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const callerSignal = init.signal;
  const abortFromCaller = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
  }

  try {
    const response = await desktopFetch(input, { ...init, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
        name: 'TimeoutError',
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
