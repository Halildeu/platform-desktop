// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { SummaryPanel, type ExportAdapter } from './SummaryPanel';
import {
  initialMeetingIntelligence,
  setMeetingIntelligenceResult,
  type MeetingIntelligenceState,
} from '../intelligence/meeting-intelligence';

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
});
