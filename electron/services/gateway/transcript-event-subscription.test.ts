import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readTranscriptEvents: vi.fn(),
  streamTranscriptEvents: vi.fn(),
}));

vi.mock('./gateway-client', () => ({
  readTranscriptEvents: mocks.readTranscriptEvents,
  streamTranscriptEvents: mocks.streamTranscriptEvents,
}));

import { TranscriptEventSubscription } from './transcript-event-subscription';

const cfg = { baseUrl: 'https://gw.example.com' };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.readTranscriptEvents.mockReset();
  mocks.streamTranscriptEvents.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TranscriptEventSubscription', () => {
  it('uses the gateway SSE stream before polling and keeps the cursor current', async () => {
    const onEvent = vi.fn();
    mocks.streamTranscriptEvents.mockImplementation(
      async (
        _cfg: unknown,
        _jwt: unknown,
        _sessionId: unknown,
        args: {
          onEvent: (event: unknown) => void;
          onCursor: (cursor: string) => void;
        },
      ) => {
        args.onCursor('1781820000000-0');
        args.onEvent({
          eventId: '1781820000000-0',
          sessionId: 'SES-1',
          meetingId: 'M-1',
          chunkSeq: 0,
          chunkStartedAtMs: 1781820000000,
          text: 'merhaba',
          textLength: 7,
          status: 'DRAFT',
        });
      },
    );
    mocks.readTranscriptEvents.mockResolvedValue({
      sessionId: 'SES-1',
      correlationId: 'corr-1',
      events: [],
      nextCursor: '1781820000000-0',
      hasMore: false,
    });

    const subscription = new TranscriptEventSubscription({
      cfg,
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent,
      pollIntervalMs: 250,
    });

    subscription.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.streamTranscriptEvents).toHaveBeenCalledWith(
      cfg,
      'JWT',
      'SES-1',
      expect.objectContaining({ after: null }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '1781820000000-0', text: 'merhaba' }),
    );
    expect(mocks.readTranscriptEvents).toHaveBeenCalledWith(
      cfg,
      'JWT',
      'SES-1',
      expect.objectContaining({ after: '1781820000000-0' }),
    );
  });

  it('polls transcript events, emits them, and advances the cursor', async () => {
    const onEvent = vi.fn();
    mocks.readTranscriptEvents
      .mockResolvedValueOnce({
        sessionId: 'SES-1',
        correlationId: 'corr-1',
        events: [
          {
            eventId: '1781820000000-0',
            sessionId: 'SES-1',
            meetingId: 'M-1',
            chunkSeq: 0,
            chunkStartedAtMs: 1781820000000,
            text: 'merhaba',
            textLength: 7,
            status: 'DRAFT',
          },
        ],
        nextCursor: '1781820000000-0',
        hasMore: false,
      })
      .mockResolvedValueOnce({
        sessionId: 'SES-1',
        correlationId: 'corr-2',
        events: [],
        nextCursor: '1781820000000-0',
        hasMore: false,
      });

    const subscription = new TranscriptEventSubscription({
      cfg,
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent,
      pollIntervalMs: 250,
      limit: 2,
      streamPreferred: false,
    });

    subscription.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '1781820000000-0', text: 'merhaba' }),
    );
    expect(mocks.readTranscriptEvents).toHaveBeenNthCalledWith(
      1,
      cfg,
      'JWT',
      'SES-1',
      expect.objectContaining({ after: null, limit: 2 }),
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.readTranscriptEvents).toHaveBeenNthCalledWith(
      2,
      cfg,
      'JWT',
      'SES-1',
      expect.objectContaining({ after: '1781820000000-0', limit: 2 }),
    );
  });

  it('backs off slightly when the gateway reports endless backlog', async () => {
    mocks.readTranscriptEvents.mockResolvedValue({
      sessionId: 'SES-1',
      correlationId: 'corr-drain',
      events: [],
      nextCursor: '1781820000000-0',
      hasMore: true,
    });

    const subscription = new TranscriptEventSubscription({
      cfg,
      sessionId: 'SES-1',
      getJwt: () => 'JWT',
      onEvent: vi.fn(),
      streamPreferred: false,
    });

    subscription.start();
    for (let i = 0; i < 21; i += 1) {
      await vi.runOnlyPendingTimersAsync();
    }

    expect(mocks.readTranscriptEvents).toHaveBeenCalledTimes(21);

    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.readTranscriptEvents).toHaveBeenCalledTimes(21);

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.readTranscriptEvents).toHaveBeenCalledTimes(22);
  });

  it('aborts an in-flight poll when stopped', async () => {
    let signal: AbortSignal | null = null;
    mocks.readTranscriptEvents.mockImplementation(
      async (_cfg: unknown, _jwt: unknown, _sessionId: unknown, args: { signal?: AbortSignal }) => {
        signal = args.signal ?? null;
        return await new Promise(() => undefined);
      },
    );

    const subscription = new TranscriptEventSubscription({
      cfg,
      sessionId: 'SES-1',
      getJwt: () => 'JWT',
      onEvent: vi.fn(),
      streamPreferred: false,
    });

    subscription.start();
    await vi.advanceTimersByTimeAsync(0);
    subscription.stop();

    expect(signal?.aborted).toBe(true);
  });
});
