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
    expect(screen.getByText('Gateway event')).toBeInTheDocument();
    expect(screen.getByText('Batch/poll akışı')).toBeInTheDocument();
    expect(screen.getByText('Transkript akışı bekleniyor')).toBeInTheDocument();
    expect(screen.queryByText('örnek transcript')).not.toBeInTheDocument();
  });

  it('renders newest transcript segment first while keeping statuses visible', () => {
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
      source: 'direct-stream',
      elapsedMs: 180,
    });
    const withEarlierFinal = upsertTranscriptSegment(withLaterDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820030000,
      status: 'final',
      text: 'İlk karar kaydedildi',
      source: 'gateway-events',
    });

    render(
      <TranscriptPanel
        session={withEarlierFinal}
        stream={{ directConfigured: true, directActive: true, disabledReason: null }}
      />,
    );

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Kelime akışı aktif')).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent('İkinci cümle işleniyor');
    expect(articles[0]).toHaveTextContent('Taslak');
    expect(articles[0]).toHaveTextContent('Direct STT');
    expect(articles[0]).toHaveTextContent('180 ms');
    expect(articles[1]).toHaveTextContent('İlk karar kaydedildi');
    expect(articles[1]).toHaveTextContent('Final');
    expect(articles[1]).toHaveTextContent('Gateway');
  });

  it('distinguishes direct stream ready from first transcript event', () => {
    const session = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });

    render(
      <TranscriptPanel
        session={session}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: false,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Bağlı, ses bekleniyor')).toBeInTheDocument();
  });
});
