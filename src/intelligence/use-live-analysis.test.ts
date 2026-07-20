// @vitest-environment jsdom

/**
 * Renderer hook unit tests. We drive `useLiveAnalysis` with a stub
 * LiveAnalysisApi that lets us fire fake IPC events synchronously.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  useLiveAnalysis,
  type LiveAnalysisApi,
  type LiveAnalysisFrame,
  type LiveAnalysisStatus,
} from './use-live-analysis';

const MEETING_A = '11111111-1111-4111-8111-111111111111';
const MEETING_B = '22222222-2222-4222-8222-222222222222';

interface StubApi extends LiveAnalysisApi {
  fireFrame(meetingId: string, frame: LiveAnalysisFrame): void;
  fireStatus(meetingId: string, status: LiveAnalysisStatus): void;
  startCalls: string[];
  stopCalls: string[];
}

function makeStubApi(): StubApi {
  let frameCb: ((f: { meetingId: string } & LiveAnalysisFrame) => void) | null = null;
  let statusCb: ((s: { meetingId: string; status: LiveAnalysisStatus }) => void) | null = null;
  const startCalls: string[] = [];
  const stopCalls: string[] = [];

  return {
    async startLiveAnalysis(payload) {
      startCalls.push(payload.meetingId);
      return { started: true };
    },
    async stopLiveAnalysis(payload) {
      stopCalls.push(payload.meetingId);
      return { stopped: true };
    },
    onLiveAnalysisFrame(cb) {
      frameCb = cb;
      return () => {
        frameCb = null;
      };
    },
    onLiveAnalysisStatus(cb) {
      statusCb = cb;
      return () => {
        statusCb = null;
      };
    },
    fireFrame(meetingId, frame) {
      frameCb?.({ meetingId, ...frame });
    },
    fireStatus(meetingId, status) {
      statusCb?.({ meetingId, status });
    },
    startCalls,
    stopCalls,
  };
}

describe('useLiveAnalysis', () => {
  it('starts on mount and stops on unmount for the current meetingId', async () => {
    const api = makeStubApi();
    const { unmount } = renderHook(() => useLiveAnalysis(MEETING_A, api));

    await waitFor(() => expect(api.startCalls).toEqual([MEETING_A]));

    unmount();
    // stop is fire-and-forget — the microtask has to settle first.
    await waitFor(() => expect(api.stopCalls).toEqual([MEETING_A]));
  });

  it('surfaces status transitions to the caller', async () => {
    const api = makeStubApi();
    const { result } = renderHook(() => useLiveAnalysis(MEETING_A, api));

    expect(result.current.status.kind).toBe('idle');
    await waitFor(() => expect(api.startCalls.length).toBe(1));

    act(() => {
      api.fireStatus(MEETING_A, { kind: 'connecting', attempt: 1 });
    });
    expect(result.current.status).toEqual({ kind: 'connecting', attempt: 1 });

    act(() => {
      api.fireStatus(MEETING_A, { kind: 'open', connectedAt: '2026-07-20T22:00:00Z' });
    });
    expect(result.current.status.kind).toBe('open');
  });

  it('keeps the highest-version frame and drops stale partials', async () => {
    const api = makeStubApi();
    const { result } = renderHook(() => useLiveAnalysis(MEETING_A, api));
    await waitFor(() => expect(api.startCalls.length).toBe(1));

    act(() => {
      api.fireFrame(MEETING_A, {
        payload: { is_partial: true, version: 5, summary: 'v5' },
        receivedAt: '2026-07-20T22:00:05Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('v5');

    // A late-arriving lower-version frame MUST NOT overwrite the highest.
    act(() => {
      api.fireFrame(MEETING_A, {
        payload: { is_partial: true, version: 3, summary: 'v3-stale' },
        receivedAt: '2026-07-20T22:00:06Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('v5');

    // A higher version replaces it.
    act(() => {
      api.fireFrame(MEETING_A, {
        payload: { is_partial: false, version: 9, summary: 'final' },
        receivedAt: '2026-07-20T22:00:10Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('final');
  });

  it('ignores frames scoped to a different meetingId', async () => {
    const api = makeStubApi();
    const { result } = renderHook(() => useLiveAnalysis(MEETING_A, api));
    await waitFor(() => expect(api.startCalls.length).toBe(1));

    act(() => {
      api.fireFrame(MEETING_B, {
        payload: { is_partial: true, version: 1, summary: 'other' },
        receivedAt: '2026-07-20T22:00:00Z',
      });
    });
    expect(result.current.latest).toBeNull();
  });

  it('tears down when meetingId flips to null', async () => {
    const api = makeStubApi();
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useLiveAnalysis(id, api),
      { initialProps: { id: MEETING_A as string | null } },
    );
    await waitFor(() => expect(api.startCalls).toEqual([MEETING_A]));

    act(() => {
      api.fireFrame(MEETING_A, {
        payload: { is_partial: true, version: 2, summary: 'v2' },
        receivedAt: '2026-07-20T22:00:00Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('v2');

    rerender({ id: null });

    // New meeting=null means the effect cleanup runs stop() and resets state.
    await waitFor(() => expect(api.stopCalls).toEqual([MEETING_A]));
    expect(result.current.latest).toBeNull();
    expect(result.current.status.kind).toBe('idle');
  });

  it('resets version tracking on meetingId change (no cross-meeting leak)', async () => {
    const api = makeStubApi();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLiveAnalysis(id, api), {
      initialProps: { id: MEETING_A },
    });
    await waitFor(() => expect(api.startCalls).toEqual([MEETING_A]));

    act(() => {
      api.fireFrame(MEETING_A, {
        payload: { is_partial: true, version: 10, summary: 'A-v10' },
        receivedAt: '2026-07-20T22:00:00Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('A-v10');

    // Switch to a different meeting; its version=1 frame MUST be accepted
    // even though the previous meeting was at version 10.
    rerender({ id: MEETING_B });
    await waitFor(() => expect(api.startCalls).toEqual([MEETING_A, MEETING_B]));

    act(() => {
      api.fireFrame(MEETING_B, {
        payload: { is_partial: true, version: 1, summary: 'B-v1' },
        receivedAt: '2026-07-20T22:00:05Z',
      });
    });
    expect(result.current.latest?.payload.summary).toBe('B-v1');
  });
});
