import { useEffect, useState } from 'react';
import type { CanonicalTranscriptSource } from '../../electron/services/meeting/canonical-transcript';
import type { MeetingIntelligenceResult } from './meeting-intelligence';

export function useCanonicalSource(
  meetingId: string | null,
  result: MeetingIntelligenceResult | null,
) {
  const analysisRunId = result?.analysisRunId;
  const sessionId = result?.canonicalSessionId;
  const key = [meetingId, analysisRunId, sessionId].join(':');
  const [generation, setGeneration] = useState(0);
  const [read, setRead] = useState<{
    key: string;
    source: CanonicalTranscriptSource | null;
    status: 'loading' | 'ready' | 'error';
  } | null>(null);
  useEffect(() => {
    if (!meetingId || !analysisRunId || !sessionId) return;
    let active = true;
    setRead({ key, source: null, status: 'loading' });
    const load = async () => {
      try {
        const source = await window.electronAPI?.meeting.getCanonicalTranscript({
          meetingId,
          analysisRunId,
          sessionId,
        });
        if (
          !source ||
          source.meetingId.toLowerCase() !== meetingId.toLowerCase() ||
          source.analysisRunId.toLowerCase() !== analysisRunId.toLowerCase() ||
          source.sessionId.toLowerCase() !== sessionId.toLowerCase()
        )
          throw new Error('Source scope mismatch');
        if (active) setRead({ key, source, status: 'ready' });
      } catch {
        if (active) setRead({ key, source: null, status: 'error' });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [meetingId, analysisRunId, sessionId, key, generation]);
  // Never render the previous meeting/run, even before effect cleanup runs.
  const current = read?.key === key ? read : null;
  return {
    source: current?.status === 'ready' ? current.source : null,
    status: !meetingId || !analysisRunId || !sessionId ? 'error' : (current?.status ?? 'loading'),
    retry: () => setGeneration((value) => value + 1),
  };
}
