/**
 * Faz 24 İ3 — React hook: subscribe to the live-analysis SSE stream for a
 * meeting, receive the latest partial/final analysis, and unsubscribe on
 * unmount or meeting change.
 *
 * Design:
 *   - The hook owns ONE subscription per rendered `meetingId`. Changing the
 *     meetingId prop tears the old subscription down (main-side stop) and
 *     spins up a new one.
 *   - Consumers get the LATEST frame — a `is_partial=true` publish
 *     supersedes any earlier partial with a lower `version`. This mirrors
 *     the meeting-ai contract (client keeps highest version).
 *   - Status is exposed as a stable discriminated union — the panel can
 *     show connecting/open/closed/error UX without leaking the raw main-
 *     side reconnect attempt count.
 *   - The hook does NOT re-render on ping frames; only real `analysis`
 *     frames update state (which is what the IPC layer already filters).
 */

import { useEffect, useRef, useState } from 'react';

// Discriminated union kept in sync with the main-process contract in
// electron/services/meeting/live-analysis-stream.ts. Duplicated here so the
// renderer bundle does not pull in the Electron main types.
export type LiveAnalysisStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'open'; connectedAt: string }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; error: string };

export interface LiveAnalysisPayload {
  is_partial?: boolean;
  version?: number;
  summary?: string;
  decisions?: unknown[];
  action_items?: unknown[];
  redaction_count?: number;
  [key: string]: unknown;
}

export interface LiveAnalysisFrame {
  payload: LiveAnalysisPayload;
  receivedAt: string;
}

// Minimal preload API shape. Kept as an interface (not `typeof
// window.electronAPI`) so the hook can be tested with a stub without
// pulling the whole preload type.
export interface LiveAnalysisApi {
  startLiveAnalysis(payload: { meetingId: string }): Promise<{ started: boolean }>;
  stopLiveAnalysis(payload: { meetingId: string }): Promise<{ stopped: boolean }>;
  onLiveAnalysisFrame(
    callback: (frame: { meetingId: string } & LiveAnalysisFrame) => void,
  ): () => void;
  onLiveAnalysisStatus(
    callback: (status: { meetingId: string; status: LiveAnalysisStatus }) => void,
  ): () => void;
}

export interface UseLiveAnalysisResult {
  latest: LiveAnalysisFrame | null;
  status: LiveAnalysisStatus;
}

/**
 * Subscribe to the live-analysis stream for `meetingId`. Pass `null` to
 * teardown a previous subscription without starting a new one.
 *
 * `api` defaults to `window.electronAPI.meeting`; tests pass a stub.
 */
export function useLiveAnalysis(
  meetingId: string | null,
  api?: LiveAnalysisApi,
): UseLiveAnalysisResult {
  const [latest, setLatest] = useState<LiveAnalysisFrame | null>(null);
  const [status, setStatus] = useState<LiveAnalysisStatus>({ kind: 'idle' });
  const highestVersionRef = useRef<number>(-1);

  useEffect(() => {
    // Reset for a new meeting; the old highest-version tracker MUST NOT
    // leak across meetings or a lower-numbered partial from meeting B
    // would be dropped in favour of meeting A's stale count.
    highestVersionRef.current = -1;
    setLatest(null);
    setStatus({ kind: 'idle' });

    if (!meetingId) return;

    const resolvedApi =
      api ??
      (
        window as unknown as {
          electronAPI: { meeting: LiveAnalysisApi };
        }
      ).electronAPI?.meeting;
    if (!resolvedApi) {
      setStatus({ kind: 'error', error: 'electronAPI.meeting unavailable' });
      return;
    }

    const offFrame = resolvedApi.onLiveAnalysisFrame((frame) => {
      if (frame.meetingId !== meetingId) return;
      const version = typeof frame.payload.version === 'number' ? frame.payload.version : 0;
      // Consumer contract: keep the highest version. A late partial with a
      // stale version is dropped — the panel never regresses to an older
      // summary just because a slow publisher fired late.
      if (version < highestVersionRef.current) return;
      highestVersionRef.current = version;
      setLatest({ payload: frame.payload, receivedAt: frame.receivedAt });
    });

    const offStatus = resolvedApi.onLiveAnalysisStatus((s) => {
      if (s.meetingId !== meetingId) return;
      setStatus(s.status);
    });

    let cancelled = false;
    resolvedApi.startLiveAnalysis({ meetingId }).catch((err: unknown) => {
      if (cancelled) return;
      setStatus({
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      cancelled = true;
      offFrame();
      offStatus();
      void resolvedApi.stopLiveAnalysis({ meetingId }).catch(() => {
        // Stop is best-effort — a failure here should not surface to the
        // user because the subscription may already be gone (window close).
      });
    };
  }, [meetingId, api]);

  return { latest, status };
}
