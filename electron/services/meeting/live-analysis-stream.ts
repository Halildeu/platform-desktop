/**
 * Faz 24 live-analysis SSE consumer (main process).
 *
 * Subscribes to meeting-ai `GET /analyze/live/stream/{meeting_id}` and
 * dispatches each `event: analysis` frame + a coarse connection status
 * signal into the renderer via IPC. Runs entirely in the main process so
 * the renderer never has to hold long-lived HTTP handles.
 *
 * Design:
 *   - Native Node.js `fetch()` streaming (Node 22+, native undici under
 *     the hood). No extra dependency vs. an `eventsource` npm package,
 *     and the manual parser is <60 lines because SSE framing is
 *     dead-simple (LF/CRLF-terminated lines, blank line = frame boundary).
 *   - Bounded reconnect (default cap 30s) with exponential backoff so a
 *     meeting-ai restart does not busy-loop.
 *   - Backpressure comes free: `ReadableStream.getReader()` awaits `read()`
 *     between frames, so we never buffer beyond one chunk.
 *   - `stop()` aborts the fetch via AbortController; the reader loop
 *     exits cleanly and the finally block flips status to `closed`.
 *   - NEVER throws to the caller: an unexpected error is emitted as an
 *     `error` status frame; the renderer decides how to surface it.
 *
 * Ephemeral by design (see meeting-ai PR #270): the hub does not persist,
 * so a mid-session restart of meeting-ai loses in-flight partials —
 * subscribers only see events published after they connect.
 */

import { setTimeout as sleep } from 'node:timers/promises';

export type LiveAnalysisStatus =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'open'; connectedAt: string }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; error: string };

export interface LiveAnalysisFrame {
  /** JSON payload sent by meeting-ai on an `event: analysis` frame.
   *  Shape mirrors the `AnalyzeResponse` schema; kept as `unknown` here so
   *  the main process does not have to re-declare the analyzer contract.
   */
  payload: unknown;
  /** Wall-clock reception timestamp (main process). */
  receivedAt: string;
}

export interface LiveAnalysisSubscriberOptions {
  /** Base URL for meeting-ai (gateway-fronted, e.g. https://ai.acik.com). */
  baseUrl: string;
  /** Meeting UUID; forms the SSE path parameter. */
  meetingId: string;
  /** Access token for the Authorization header; omitted → no header. */
  accessToken?: string;
  /** Called for every `event: analysis` frame. MUST NOT throw. */
  onFrame: (frame: LiveAnalysisFrame) => void;
  /** Coarse-grained connection state changes. MUST NOT throw. */
  onStatus: (status: LiveAnalysisStatus) => void;
  /** fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** First reconnect delay in ms (default 500). Doubles up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  /** Reconnect delay cap in ms (default 30_000). */
  maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Parse a raw SSE chunk buffer into complete frames, returning the frames
 * and the leftover partial-frame suffix that the caller feeds back on the
 * next call. Handles both LF-only and CRLF line separators.
 *
 * A frame is a sequence of `field: value` lines followed by a blank line
 * (double LF or double CRLF). Comment lines (`:` prefix) are recognised
 * and ignored — they are the SSE keep-alive marker.
 */
export function parseSseChunk(
  chunk: string,
  carry: string,
): { frames: Array<Map<string, string>>; carry: string } {
  const buffer = carry + chunk;
  const parts = buffer.split(/\r?\n\r?\n/);
  const nextCarry = parts.pop() ?? '';
  const frames: Array<Map<string, string>> = [];
  for (const raw of parts) {
    if (!raw.length) continue;
    const frame = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.length) continue;
      if (line.startsWith(':')) continue; // SSE comment
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      // Per spec, a single leading space after `:` is stripped.
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      const prev = frame.get(field);
      frame.set(field, prev == null ? value : `${prev}\n${value}`);
    }
    if (frame.size > 0) frames.push(frame);
  }
  return { frames, carry: nextCarry };
}

export class LiveAnalysisSubscriber {
  private readonly opts: Required<
    Omit<LiveAnalysisSubscriberOptions, 'accessToken' | 'fetchImpl'>
  > &
    Pick<LiveAnalysisSubscriberOptions, 'accessToken' | 'fetchImpl'>;
  private controller: AbortController | null = null;
  private stopped = false;
  private task: Promise<void> | null = null;

  constructor(options: LiveAnalysisSubscriberOptions) {
    if (!MEETING_ID_PATTERN.test(options.meetingId)) {
      throw new Error('meetingId must be a UUID');
    }
    if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
      throw new Error('baseUrl must be an absolute http(s) URL');
    }
    this.opts = {
      ...options,
      initialBackoffMs: options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
  }

  /** Start the subscription loop. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.task) return;
    this.stopped = false;
    this.task = this.runLoop();
  }

  /** Signal stop. Resolves once the loop has fully unwound. */
  async stop(reason: string = 'stopped'): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    if (this.task) {
      try {
        await this.task;
      } catch {
        // The loop swallows its own errors into onStatus already.
      }
    }
    this.task = null;
    this.safeStatus({ kind: 'closed', reason });
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    let backoff = this.opts.initialBackoffMs;
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/analyze/live/stream/${this.opts.meetingId}`;
    const fetchFn = this.opts.fetchImpl ?? fetch;

    while (!this.stopped) {
      attempt += 1;
      this.safeStatus({ kind: 'connecting', attempt });
      this.controller = new AbortController();
      try {
        const res = await fetchFn(url, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: this.controller.signal,
        });
        if (!res.ok) {
          this.safeStatus({
            kind: 'error',
            error: `SSE upstream returned ${res.status}`,
          });
        } else if (!res.body) {
          this.safeStatus({ kind: 'error', error: 'SSE response had no body' });
        } else {
          this.safeStatus({ kind: 'open', connectedAt: new Date().toISOString() });
          attempt = 0;
          backoff = this.opts.initialBackoffMs;
          await this.consume(res.body);
        }
      } catch (err) {
        if (this.stopped) return;
        this.safeStatus({
          kind: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (this.stopped) return;
      const delay = Math.min(backoff, this.opts.maxBackoffMs);
      try {
        await sleep(delay, undefined, { signal: this.controller?.signal });
      } catch {
        if (this.stopped) return;
      }
      backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let carry = '';
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) return;
        const chunk = decoder.decode(value, { stream: true });
        const { frames, carry: nextCarry } = parseSseChunk(chunk, carry);
        carry = nextCarry;
        for (const frame of frames) {
          const eventName = frame.get('event');
          const data = frame.get('data');
          if (eventName !== 'analysis' || data == null) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            this.safeStatus({
              kind: 'error',
              error: 'SSE analysis frame had non-JSON data',
            });
            continue;
          }
          this.safeFrame({ payload, receivedAt: new Date().toISOString() });
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released on abort; safe to ignore.
      }
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    };
    if (this.opts.accessToken) {
      headers.authorization = `Bearer ${this.opts.accessToken}`;
    }
    return headers;
  }

  private safeStatus(status: LiveAnalysisStatus): void {
    try {
      this.opts.onStatus(status);
    } catch {
      // A subscriber listener is not allowed to break the loop.
    }
  }

  private safeFrame(frame: LiveAnalysisFrame): void {
    try {
      this.opts.onFrame(frame);
    } catch {
      // As above — never break the reader loop on a listener throw.
    }
  }
}
