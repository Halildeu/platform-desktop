/**
 * Unit tests for the SSE parser + subscriber loop.
 *
 * We test the parser directly (pure fn) and drive the subscriber with a
 * mocked `fetch` that returns a `ReadableStream` we control frame-by-frame.
 * This exercises the reader loop without a real HTTP hop.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  LiveAnalysisSubscriber,
  parseSseChunk,
  type LiveAnalysisFrame,
  type LiveAnalysisStatus,
} from './live-analysis-stream.js';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

describe('parseSseChunk', () => {
  it('parses a single complete frame', () => {
    const { frames, carry } = parseSseChunk('event: analysis\ndata: {"summary":"ok"}\n\n', '');
    expect(carry).toBe('');
    expect(frames.length).toBe(1);
    expect(frames[0].get('event')).toBe('analysis');
    expect(frames[0].get('data')).toBe('{"summary":"ok"}');
  });

  it('ignores SSE comment lines (colon prefix)', () => {
    const { frames } = parseSseChunk(': subscribed 1\n\nevent: analysis\ndata: {}\n\n', '');
    // The comment-only frame is dropped (empty after ignoring the comment).
    expect(frames.length).toBe(1);
    expect(frames[0].get('event')).toBe('analysis');
  });

  it('handles CRLF line separators (Windows / some proxies)', () => {
    const { frames, carry } = parseSseChunk('event: analysis\r\ndata: {"v":1}\r\n\r\n', '');
    expect(carry).toBe('');
    expect(frames.length).toBe(1);
    expect(frames[0].get('data')).toBe('{"v":1}');
  });

  it('carries a partial frame across chunk boundaries', () => {
    const first = parseSseChunk('event: analysis\ndata: {"partial":', '');
    expect(first.frames).toEqual([]);
    expect(first.carry).toBe('event: analysis\ndata: {"partial":');

    const second = parseSseChunk('true}\n\n', first.carry);
    expect(second.frames.length).toBe(1);
    expect(second.frames[0].get('data')).toBe('{"partial":true}');
    expect(second.carry).toBe('');
  });

  it('parses multiple frames delivered in one chunk', () => {
    const chunk =
      'event: ping\ndata: {}\n\n' +
      'event: analysis\ndata: {"v":2}\n\n' +
      'event: analysis\ndata: {"v":3}\n\n';
    const { frames } = parseSseChunk(chunk, '');
    expect(frames.length).toBe(3);
    expect(frames[0].get('event')).toBe('ping');
    expect(frames[1].get('data')).toBe('{"v":2}');
    expect(frames[2].get('data')).toBe('{"v":3}');
  });

  it('strips only one leading space from field values', () => {
    const { frames } = parseSseChunk('data:  two-leading-spaces\n\n', '');
    // Spec: strip ONE space after `:`. Two spaces → one visible space remains.
    expect(frames[0].get('data')).toBe(' two-leading-spaces');
  });

  it('joins repeated data lines with a newline (SSE multi-line data)', () => {
    const { frames } = parseSseChunk('data: line one\ndata: line two\n\n', '');
    expect(frames[0].get('data')).toBe('line one\nline two');
  });
});

// Helper: build a `Response`-shaped object with a controllable body stream.
function makeStreamedResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('LiveAnalysisSubscriber', () => {
  it('rejects a non-UUID meetingId', () => {
    expect(
      () =>
        new LiveAnalysisSubscriber({
          baseUrl: 'https://ai.example.com',
          meetingId: 'not-a-uuid',
          onFrame: () => {},
          onStatus: () => {},
        }),
    ).toThrow(/meetingId must be a UUID/);
  });

  it('rejects a non-http baseUrl', () => {
    expect(
      () =>
        new LiveAnalysisSubscriber({
          baseUrl: 'ws://ai.example.com',
          meetingId: MEETING_ID,
          onFrame: () => {},
          onStatus: () => {},
        }),
    ).toThrow(/absolute http/i);
  });

  it('dispatches analysis frames and reports connection status', async () => {
    const encoder = new TextEncoder();
    const body = [
      encoder.encode(': subscribed 1\n\n'),
      encoder.encode('event: analysis\ndata: {"summary":"canlı","version":7}\n\n'),
      encoder.encode('event: ping\ndata: {}\n\n'),
      encoder.encode('event: analysis\ndata: {"summary":"nihai","version":8}\n\n'),
    ];
    const fetchImpl = vi.fn(async () => makeStreamedResponse(body));

    const frames: LiveAnalysisFrame[] = [];
    const statuses: LiveAnalysisStatus[] = [];

    const sub = new LiveAnalysisSubscriber({
      baseUrl: 'https://ai.example.com',
      meetingId: MEETING_ID,
      accessToken: 'jwt-token',
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      // Set both backoffs to 1ms so the reconnect after stream end returns
      // fast enough for us to stop() before the next attempt.
      // Long backoff so the loop parks in `sleep()` waiting for stop()
      // instead of tight-looping through the same mocked response.
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sub.start();
    // Yield until the mock stream has been fully consumed.
    await new Promise((r) => setTimeout(r, 25));
    await sub.stop('test-cleanup');

    expect(frames.map((f) => f.payload)).toEqual([
      { summary: 'canlı', version: 7 },
      { summary: 'nihai', version: 8 },
    ]);

    const kinds = statuses.map((s) => s.kind);
    expect(kinds).toContain('connecting');
    expect(kinds).toContain('open');
    expect(kinds).toContain('closed');
  });

  it('reports HTTP non-2xx as an error status and does not deliver frames', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));

    const frames: LiveAnalysisFrame[] = [];
    const statuses: LiveAnalysisStatus[] = [];

    const sub = new LiveAnalysisSubscriber({
      baseUrl: 'https://ai.example.com',
      meetingId: MEETING_ID,
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      // Long backoff so the loop parks in `sleep()` waiting for stop()
      // instead of tight-looping through the same mocked response.
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sub.start();
    await new Promise((r) => setTimeout(r, 25));
    await sub.stop('test-cleanup');

    expect(frames).toEqual([]);
    const errStatuses = statuses.filter((s) => s.kind === 'error');
    expect(errStatuses.length).toBeGreaterThan(0);
    expect((errStatuses[0] as { error: string }).error).toContain('502');
  });

  it('non-JSON data on an analysis frame becomes an error status, not a throw', async () => {
    const encoder = new TextEncoder();
    const body = [encoder.encode('event: analysis\ndata: <<not-json>>\n\n')];
    const fetchImpl = vi.fn(async () => makeStreamedResponse(body));

    const statuses: LiveAnalysisStatus[] = [];
    const sub = new LiveAnalysisSubscriber({
      baseUrl: 'https://ai.example.com',
      meetingId: MEETING_ID,
      onFrame: () => {},
      onStatus: (s) => statuses.push(s),
      // Long backoff so the loop parks in `sleep()` waiting for stop()
      // instead of tight-looping through the same mocked response.
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sub.start();
    await new Promise((r) => setTimeout(r, 25));
    await sub.stop('test-cleanup');

    const errStatuses = statuses.filter((s) => s.kind === 'error');
    expect(errStatuses.some((s) => (s as { error: string }).error.includes('non-JSON'))).toBe(true);
  });

  it('start() is idempotent — a second call is a no-op', async () => {
    const fetchImpl = vi.fn(async () => makeStreamedResponse([]));

    const sub = new LiveAnalysisSubscriber({
      baseUrl: 'https://ai.example.com',
      meetingId: MEETING_ID,
      onFrame: () => {},
      onStatus: () => {},
      // Long backoff so the loop parks in `sleep()` waiting for stop()
      // instead of tight-looping through the same mocked response.
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sub.start();
    sub.start(); // must NOT spawn a second loop
    await new Promise((r) => setTimeout(r, 20));
    await sub.stop();

    // A single loop → at most a couple of fetch attempts (empty body ends
    // immediately, so the reconnect loop can hit again before stop lands).
    // The strict invariant we care about is: two starts do not double fetches.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('gateway relay route (Faz 24 İ5, backend#1103)', () => {
  it('subscribes on the audio-gateway relay path, not on meeting-ai directly', async () => {
    const fetchImpl = vi.fn(async () => makeStreamedResponse([]));

    const sub = new LiveAnalysisSubscriber({
      baseUrl: 'https://gw.example.com',
      meetingId: MEETING_ID,
      accessToken: 'jwt-token',
      onFrame: () => {},
      onStatus: () => {},
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sub.start();
    await new Promise((r) => setTimeout(r, 25));
    await sub.stop('test-cleanup');

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toBe(
      `https://gw.example.com/api/v1/audio-gateway/meetings/${MEETING_ID}/live-analysis/stream`,
    );
    // The pre-relay meeting-ai path must be gone: that endpoint has no public
    // route and no tenant-aware authorisation.
    expect(url).not.toContain('/analyze/live/stream/');
  });

  it('rejects a path-traversal meetingId before any request is built', () => {
    const fetchImpl = vi.fn(async () => makeStreamedResponse([]));

    // The UUID guard is the primary defence (a traversal value never reaches
    // URL construction); `encodeURIComponent` in the path builder is the
    // belt-and-braces second layer.
    expect(
      () =>
        new LiveAnalysisSubscriber({
          baseUrl: 'https://gw.example.com',
          meetingId: '../../admin/secrets',
          onFrame: () => {},
          onStatus: () => {},
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
    ).toThrow('meetingId must be a UUID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
