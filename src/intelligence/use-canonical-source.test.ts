// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanonicalTranscriptSource } from '../../electron/services/meeting/canonical-transcript';
import { useCanonicalSource } from './use-canonical-source';
import type { MeetingIntelligenceResult } from './meeting-intelligence';

const result: MeetingIntelligenceResult = {
  analysisRunId: 'run-a',
  canonicalSessionId: 'session-a',
  summaryMarkdown: 'Synthetic summary',
  decisions: [],
  actionItems: [],
  generatedAtMs: 1,
  citationCoverage: 0,
  storageMode: 'canonical',
};
const source: CanonicalTranscriptSource = {
  meetingId: 'meeting-a',
  analysisRunId: 'run-a',
  sessionId: 'session-a',
  finalizationVersion: 1,
  transcriptSha256: 'hash',
  sentences: [],
};
const get = vi.fn();
function bridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { meeting: { getCanonicalTranscript: get } },
  });
}
afterEach(() => {
  cleanup();
  get.mockReset();
  delete window.electronAPI;
});
it('rereads the server on remount instead of caching source content', async () => {
  bridge();
  get.mockResolvedValue(source);
  const first = renderHook(() => useCanonicalSource('meeting-a', result));
  await waitFor(() => expect(first.result.current.source).toEqual(source));
  first.unmount();
  const second = renderHook(() => useCanonicalSource('meeting-a', result));
  await waitFor(() => expect(second.result.current.source).toEqual(source));
  expect(get).toHaveBeenCalledTimes(2);
});
it('drops a late response from another session or run', async () => {
  bridge();
  let resolveOld!: (value: CanonicalTranscriptSource) => void;
  get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...source, analysisRunId: 'run-b', sessionId: 'session-b' });
  const hook = renderHook(({ value }) => useCanonicalSource('meeting-a', value), {
    initialProps: { value: result },
  });
  hook.rerender({ value: { ...result, analysisRunId: 'run-b', canonicalSessionId: 'session-b' } });
  await waitFor(() => expect(hook.result.current.source?.analysisRunId).toBe('run-b'));
  await act(async () => resolveOld(source));
  expect(hook.result.current.source?.analysisRunId).toBe('run-b');
});
it('clears source on loss of displayed result and rejects incorrect bridge scope', async () => {
  bridge();
  get.mockResolvedValue({ ...source, sessionId: 'wrong' });
  const hook = renderHook(({ value }) => useCanonicalSource('meeting-a', value), {
    initialProps: { value: result as MeetingIntelligenceResult | null },
  });
  await waitFor(() => expect(hook.result.current.status).toBe('error'));
  expect(hook.result.current.source).toBeNull();
  get.mockResolvedValue(source);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.source).toEqual(source));
  hook.rerender({ value: null });
  expect(hook.result.current.source).toBeNull();
});
