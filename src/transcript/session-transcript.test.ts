import { describe, expect, it } from 'vitest';

import {
  buildTranscriptSourceExport,
  failTranscriptSession,
  finishTranscriptSession,
  initialTranscriptSession,
  markTranscriptBlocked,
  markTranscriptReady,
  startTranscriptSession,
  transcriptStatusLabel,
  upsertTranscriptSegment,
} from './session-transcript';

describe('session transcript state', () => {
  it('tracks recorder readiness and active session metadata without transcript content persistence', () => {
    const ready = markTranscriptReady(initialTranscriptSession(), {
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
    });

    expect(ready.lifecycle).toBe('ready');
    expect(ready.meetingId).toBe('22222222-2222-4222-8222-222222222222');

    const recording = startTranscriptSession(ready, {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
    });

    expect(recording).toMatchObject({
      lifecycle: 'recording',
      sessionId: 'SES-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
      segments: [],
    });
  });

  it('orders transcript segments and prevents status regression', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });

    const withDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'draft',
      text: 'taslak metin',
    });
    const withEarlierFinal = upsertTranscriptSegment(withDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1500,
      status: 'final',
      text: 'final metin',
    });
    const withStable = upsertTranscriptSegment(withEarlierFinal, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'stabilizing',
      text: 'netleşen metin',
    });
    const rejectedRegression = upsertTranscriptSegment(withStable, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'draft',
      text: 'geri gelen taslak',
    });

    expect(rejectedRegression.segments.map((item) => item.id)).toEqual(['seg-1', 'seg-2']);
    expect(rejectedRegression.segments[1]).toMatchObject({
      status: 'stabilizing',
      text: 'netleşen metin',
    });
  });

  it('keeps terminal and error states explicit', () => {
    const finished = finishTranscriptSession(initialTranscriptSession(), 1781820000999);
    expect(finished.lifecycle).toBe('finished');
    expect(finished.finishedAtMs).toBe(1781820000999);

    const failed = failTranscriptSession(finished, 'upload failed');
    expect(failed.lifecycle).toBe('error');
    expect(failed.error).toBe('upload failed');

    const blocked = markTranscriptBlocked(failed, { reason: 'RECORDER_MEETING_ID yok' });
    expect(blocked.lifecycle).toBe('blocked');
    expect(blocked.error).toBe('RECORDER_MEETING_ID yok');
    expect(blocked.segments).toEqual([]);
  });

  it('returns Turkish status labels for draft to revised transitions', () => {
    expect(transcriptStatusLabel('draft')).toBe('Taslak');
    expect(transcriptStatusLabel('stabilizing')).toBe('Netleşiyor');
    expect(transcriptStatusLabel('final')).toBe('Final');
    expect(transcriptStatusLabel('revised')).toBe('Revize');
  });

  it('builds source transcript markdown and text exports from real segments', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withLaterDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820007000,
      status: 'draft',
      text: 'ikinci satır',
    });
    const withEarlierFinal = upsertTranscriptSegment(withLaterDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'ilk satır',
    });

    const bundle = buildTranscriptSourceExport(withEarlierFinal, 1781820100000);

    expect(bundle.markdownFileName).toMatch(
      /^meeting-transcript-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.textFileName).toMatch(
      /^meeting-transcript-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.markdown).toContain('# Meeting Transcript');
    expect(bundle.markdown.indexOf('ilk satır')).toBeLessThan(
      bundle.markdown.indexOf('ikinci satır'),
    );
    expect(bundle.text).toContain(`[${new Date(1781820002000).toISOString()} Final]`);
    expect(bundle.text).toContain('Konuşmacı: ilk satır');
  });

  it('rejects source export when no transcript segment exists', () => {
    expect(() => buildTranscriptSourceExport(initialTranscriptSession())).toThrow(
      'Transcript source is not ready',
    );
  });
});
