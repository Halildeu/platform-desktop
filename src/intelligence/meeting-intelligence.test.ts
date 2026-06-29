import { describe, expect, it } from 'vitest';

import {
  bindMeetingIntelligenceTarget,
  buildIntelligenceExport,
  failMeetingIntelligence,
  initialMeetingIntelligence,
  markIntelligenceRecording,
  markIntelligenceWaiting,
  setMeetingIntelligenceResult,
} from './meeting-intelligence';

const RESULT = {
  summaryMarkdown: 'Güvenli pilot için recorder akışı ve direct-STT kanıtı ayrıldı.',
  generatedAtMs: 1782741600000,
  providerLabel: 'meeting-ai pilot',
  citationCoverage: 1,
  decisions: [
    {
      id: 'dec-1',
      title: 'Desktop recorder fresh login ile tekrar denenecek',
      owner: 'Zeynep',
      status: 'accepted' as const,
      citations: [{ segmentId: 'seg-1', startedAtMs: 30_000, endedAtMs: 42_000 }],
    },
  ],
  actionItems: [
    {
      id: 'act-1',
      title: 'audio_record rolü yeni token claim özetinde doğrulanacak',
      assignee: 'Zeynep',
      dueDate: '2026-06-30',
      status: 'open' as const,
      priority: 'high' as const,
      citations: [{ segmentId: 'seg-2', startedAtMs: 64_000 }],
    },
  ],
};

describe('meeting intelligence state and exports', () => {
  it('tracks recorder lifecycle without inventing an intelligence result', () => {
    const bound = bindMeetingIntelligenceTarget(initialMeetingIntelligence(), {
      meetingId: '22222222-2222-4222-8222-222222222222',
    });
    expect(bound).toMatchObject({
      status: 'idle',
      meetingId: '22222222-2222-4222-8222-222222222222',
      result: null,
    });

    const recording = markIntelligenceRecording(bound, {
      meetingId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'SES-1',
    });
    expect(recording).toMatchObject({ status: 'recording', sessionId: 'SES-1' });

    const waiting = markIntelligenceWaiting(recording);
    expect(waiting).toMatchObject({ status: 'waiting', result: null });

    const failed = failMeetingIntelligence(waiting, 'meeting-ai unavailable');
    expect(failed).toMatchObject({ status: 'error', error: 'meeting-ai unavailable' });
  });

  it('builds markdown and CSV exports from approved intelligence output', () => {
    const ready = setMeetingIntelligenceResult(
      {
        ...initialMeetingIntelligence(),
        meetingId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'SES-1',
      },
      RESULT,
    );

    const bundle = buildIntelligenceExport(ready, 1782741700000);

    expect(bundle.markdownFileName).toMatch(
      /^meeting-intelligence-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.csvFileName).toMatch(
      /^meeting-intelligence-actions-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.markdown).toContain('# Meeting Intelligence');
    expect(bundle.markdown).toContain('Citation coverage: 100%');
    expect(bundle.markdown).toContain(
      'Desktop recorder fresh login ile tekrar denenecek',
    );
    expect(bundle.markdown).toContain('[0:30-0:42]');
    expect(bundle.csv).toContain(
      'action,act-1,audio_record rolü yeni token claim özetinde doğrulanacak,Zeynep,2026-06-30,Açık,high,1:04',
    );
  });

  it('rejects exports before intelligence output is ready', () => {
    expect(() => buildIntelligenceExport(initialMeetingIntelligence())).toThrow(
      'Meeting intelligence output is not ready',
    );
  });
});
