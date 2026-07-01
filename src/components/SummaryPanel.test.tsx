// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { SummaryPanel, type ExportAdapter } from './SummaryPanel';
import {
  initialMeetingIntelligence,
  setMeetingIntelligenceResult,
  type MeetingIntelligenceState,
} from '../intelligence/meeting-intelligence';
import {
  initialTranscriptSession,
  startTranscriptSession,
  upsertTranscriptSegment,
  type TranscriptSessionState,
} from '../transcript/session-transcript';

function readyState(): MeetingIntelligenceState {
  return setMeetingIntelligenceResult(
    {
      ...initialMeetingIntelligence(),
      meetingId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'SES-1',
    },
    {
      summaryMarkdown: 'Toplantıda direct-STT kanıtı ve recorder tekrar denemesi ayrıştırıldı.',
      generatedAtMs: 1782741600000,
      providerLabel: 'meeting-ai pilot',
      citationCoverage: 1,
      decisions: [
        {
          id: 'dec-1',
          title: 'Recorder fresh login sonrası tekrar denenecek',
          owner: 'Zeynep',
          status: 'accepted',
          citations: [{ segmentId: 'seg-1', startedAtMs: 30_000, endedAtMs: 42_000 }],
        },
      ],
      actionItems: [
        {
          id: 'act-1',
          title: 'audio_record rolü yeni token claim özetinde doğrulanacak',
          assignee: 'Zeynep',
          dueDate: '2026-06-30',
          status: 'open',
          priority: 'high',
          citations: [{ segmentId: 'seg-2', startedAtMs: 64_000 }],
        },
      ],
    },
  );
}

function transcriptState(): TranscriptSessionState {
  const recording = startTranscriptSession(initialTranscriptSession(), {
    sessionId: 'SES-1',
    meetingId: '22222222-2222-4222-8222-222222222222',
    deviceId: 'desktop-1',
    hasLoopback: false,
    startedAtMs: 1781820000000,
  });

  const withFinalSegment = upsertTranscriptSegment(recording, {
    id: 'seg-1',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820003000,
    status: 'final',
    source: 'direct-stream',
    text: 'Direct STT bağlantısı kaynak olarak doğrulandı.',
  });

  return upsertTranscriptSegment(withFinalSegment, {
    id: 'seg-2',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820013000,
    status: 'draft',
    source: 'direct-stream',
    text: 'Toplantı notu kaynak transcript olarak hazır.',
  });
}

function reportReadyTranscriptState(): TranscriptSessionState {
  const recording = startTranscriptSession(initialTranscriptSession(), {
    sessionId: 'SES-2',
    meetingId: '33333333-3333-4333-8333-333333333333',
    deviceId: 'desktop-1',
    hasLoopback: false,
    startedAtMs: 1781820000000,
  });

  const withFirstSegment = upsertTranscriptSegment(recording, {
    id: 'seg-1',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820003000,
    status: 'final',
    source: 'direct-stream',
    text: 'Canlı toplantı kaydı sırasında transkript kaynağı final satırlarla doğrulandı ve çıktı üretimi için hazırlandı.',
  });

  const withSecondSegment = upsertTranscriptSegment(withFirstSegment, {
    id: 'seg-2',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820021000,
    status: 'final',
    source: 'direct-stream',
    text: 'Toplantı sonrasında özet karar ve aksiyon üretimi transkript kanıtına bağlı şekilde ilerleyecek.',
  });

  return {
    ...withSecondSegment,
    lifecycle: 'finished',
    finishedAtMs: 1781820025000,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SummaryPanel', () => {
  it('renders an honest empty state before intelligence output exists', () => {
    render(<SummaryPanel intelligence={initialMeetingIntelligence()} />);

    expect(screen.getByRole('heading', { name: 'Toplantı Çıktısı' })).toBeInTheDocument();
    expect(screen.getByText('Toplantı çıktısı bekleniyor')).toBeInTheDocument();
    expect(screen.queryByText('örnek özet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Markdown' })).not.toBeInTheDocument();
  });

  it('renders summary, decisions, actions and citation timestamps', () => {
    render(<SummaryPanel intelligence={readyState()} />);

    expect(
      screen.getByText('Toplantıda direct-STT kanıtı ve recorder tekrar denemesi ayrıştırıldı.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Recorder fresh login sonrası tekrar denenecek')).toBeInTheDocument();
    expect(
      screen.getByText('audio_record rolü yeni token claim özetinde doğrulanacak'),
    ).toBeInTheDocument();
    expect(screen.getByText('0:30-0:42')).toBeInTheDocument();
    expect(screen.getByText('1:04')).toBeInTheDocument();
  });

  it('uses export adapter for copy and file downloads', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(<SummaryPanel intelligence={readyState()} exportAdapter={adapter} />);

    await userEvent.click(screen.getByRole('button', { name: 'Kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('# Meeting Intelligence'),
      );
    });
    expect(screen.getByText('Markdown panoya kopyalandı.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    expect(adapter.downloadText).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-intelligence-actions-.*\.csv$/),
      expect.stringContaining('audio_record rolü yeni token claim özetinde doğrulanacak'),
      'text/csv',
    );
  });

  it('offers source transcript export while meeting intelligence is still waiting', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={transcriptState()}
        exportAdapter={adapter}
      />,
    );

    expect(screen.getByText('Kaynak transkript')).toBeInTheDocument();
    const readiness = screen.getByLabelText('Kaynak hazırlık durumu');
    expect(within(readiness).getByText('Kaynak toplanıyor')).toBeInTheDocument();
    expect(
      within(readiness).getByText('Canlı transkript rapor kaynağına ekleniyor.'),
    ).toBeInTheDocument();
    const sourceSummary = screen.getByLabelText('Kaynak transkript özeti');
    expect(within(sourceSummary).getByText('Satır')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('2')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('1 final / 1 taslak')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Direct STT')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Kelime')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Final oranı')).toBeInTheDocument();
    expect(screen.getByText('Son satır · Taslak · Direct STT')).toBeInTheDocument();
    expect(screen.getByText('"Toplantı notu kaynak transcript olarak hazır."')).toBeInTheDocument();
    expect(screen.queryByText('Toplantı çıktısı bekleniyor')).not.toBeInTheDocument();
    expect(screen.queryByText('örnek özet')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Transkript kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('Toplantı notu kaynak transcript olarak hazır.'),
      );
    });

    await userEvent.click(screen.getByRole('button', { name: 'Transkript TXT' }));
    expect(adapter.downloadText).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-transcript-22222222-2222-4222-8222-222222222222-/),
      expect.stringContaining('Toplantı notu kaynak transcript olarak hazır.'),
      'text/plain',
    );
  });

  it('shows when transcript source is suitable for meeting output generation', () => {
    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={reportReadyTranscriptState()}
      />,
    );

    const readiness = screen.getByLabelText('Kaynak hazırlık durumu');
    expect(within(readiness).getByText('Çıktıya uygun')).toBeInTheDocument();
    expect(
      within(readiness).getByText(
        'Transkript kaynağı meeting output üretimi için yeterli görünüyor.',
      ),
    ).toBeInTheDocument();

    const sourceSummary = screen.getByLabelText('Kaynak transkript özeti');
    expect(within(sourceSummary).getByText('2 final / 0 taslak')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('18 sn')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('%100')).toBeInTheDocument();
  });
});
