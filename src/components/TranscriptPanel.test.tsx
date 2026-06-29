// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { TranscriptPanel } from './TranscriptPanel';
import {
  initialTranscriptSession,
  startTranscriptSession,
  upsertTranscriptSegment,
} from '../transcript/session-transcript';

afterEach(() => {
  cleanup();
});

describe('TranscriptPanel', () => {
  it('renders recorder session metadata without fake transcript content', () => {
    const session = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
    });

    render(<TranscriptPanel session={session} />);

    expect(screen.getByRole('heading', { name: 'Canlı Transkript' })).toBeInTheDocument();
    expect(screen.getByText('Oturum SES-1')).toBeInTheDocument();
    expect(screen.getByText('Kayıt')).toBeInTheDocument();
    expect(screen.getByText('Mikrofon + sistem sesi')).toBeInTheDocument();
    expect(screen.getByText('Transkript akışı bekleniyor')).toBeInTheDocument();
    expect(screen.queryByText('örnek transcript')).not.toBeInTheDocument();
  });

  it('renders draft and final transcript segment statuses in timeline order', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withLaterDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820060000,
      status: 'draft',
      text: 'İkinci cümle işleniyor',
    });
    const withEarlierFinal = upsertTranscriptSegment(withLaterDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820030000,
      status: 'final',
      text: 'İlk karar kaydedildi',
    });

    render(<TranscriptPanel session={withEarlierFinal} />);

    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent('İlk karar kaydedildi');
    expect(articles[0]).toHaveTextContent('Final');
    expect(articles[1]).toHaveTextContent('İkinci cümle işleniyor');
    expect(articles[1]).toHaveTextContent('Taslak');
  });
});
