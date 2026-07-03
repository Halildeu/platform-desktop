// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { CONSENT_TEXT_HASH, CONSENT_VERSION } from './ConsentDialog';
import { SummaryPanel, type ExportAdapter, type MeetingAiSubmitAdapter } from './SummaryPanel';
import {
  initialMeetingIntelligence,
  setMeetingIntelligenceResult,
  type MeetingIntelligenceState,
} from '../intelligence/meeting-intelligence';
import {
  finishTranscriptSession,
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

function draftSubmitTranscriptState(): TranscriptSessionState {
  const recording = startTranscriptSession(initialTranscriptSession(), {
    sessionId: 'SES-3',
    meetingId: '44444444-4444-4444-8444-444444444444',
    deviceId: 'desktop-1',
    hasLoopback: false,
    startedAtMs: 1781820000000,
  });

  const withFirstDraft = upsertTranscriptSegment(recording, {
    id: 'seg-1',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820003000,
    status: 'draft',
    source: 'direct-stream',
    text: 'Direct STT final satır üretmese bile kullanıcı uzun toplantı boyunca yeterli taslak kaynak oluşturdu.',
  });

  return finishTranscriptSession(
    upsertTranscriptSegment(withFirstDraft, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820021000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Meeting AI sonucu final kanıt gibi değil taslak kalite etiketiyle preview olarak sunulmalı.',
    }),
    1781820025000,
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

  it('edits the generated summary and uses the edited text in exports', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(<SummaryPanel intelligence={readyState()} exportAdapter={adapter} />);

    await userEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
    const editor = screen.getByLabelText('Özet metni');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Düzenlenmiş toplantı özeti ürün yüzeyinden onaylandı.');
    await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));

    expect(screen.getByText('Özet düzenlendi.')).toBeInTheDocument();
    expect(
      screen.getByText('Düzenlenmiş toplantı özeti ürün yüzeyinden onaylandı.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('Düzenlenmiş toplantı özeti ürün yüzeyinden onaylandı.'),
      );
    });
    expect(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0]).not.toContain(
      'Toplantıda direct-STT kanıtı ve recorder tekrar denemesi ayrıştırıldı.',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Orijinal' }));
    expect(screen.getByText('Özet orijinal haline döndü.')).toBeInTheDocument();
    expect(
      screen.getByText('Toplantıda direct-STT kanıtı ve recorder tekrar denemesi ayrıştırıldı.'),
    ).toBeInTheDocument();
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
    const nextStep = screen.getByLabelText('Sıradaki kapı');
    expect(within(nextStep).getByText('Kayıt bitişi')).toBeInTheDocument();
    expect(
      within(nextStep).getByText(
        'Toplantı çıktısı için kayıt bitişi ve final transkript satırları bekleniyor.',
      ),
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
    const aiPackage = screen.getByLabelText('Meeting AI kaynak paketi');
    expect(within(aiPackage).getByText('Kapı kontrolü bekliyor')).toBeInTheDocument();
    expect(
      within(aiPackage).getByText(/Backend gateway -> meeting-ai \/analyze kontratı/),
    ).toBeInTheDocument();
    expect(within(aiPackage).getByText(/doğrudan platform-ai çağırmaz/)).toBeInTheDocument();
    const aiGate = screen.getByLabelText('Meeting AI kapı kontrolü');
    expect(within(aiGate).getByText('Meeting AI kapısı bekliyor')).toBeInTheDocument();
    expect(within(aiGate).getByText('backend-gateway -> meeting-ai /analyze')).toBeInTheDocument();
    expect(within(aiGate).getByText('Gateway zorunlu')).toBeInTheDocument();
    expect(within(aiGate).getByText('kayıt sürüyor')).toBeInTheDocument();
    const privacy = screen.getByLabelText('KVKK kaynak sınırı');
    expect(within(privacy).getByText('Transcript içerir')).toBeInTheDocument();
    expect(within(privacy).getByText('Raw audio yok')).toBeInTheDocument();
    expect(within(privacy).getByText(CONSENT_VERSION)).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: 'AI paketi kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenLastCalledWith(
        expect.stringContaining('"schema_version": "platform-desktop.meeting-ai-source.v1"'),
      );
    });
    const copiedPackage = String(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0]);
    expect(copiedPackage).toContain('"client_direct_platform_ai": false');
    expect(copiedPackage).toContain('"can_submit": false');
    expect(copiedPackage).toContain('"classification": "confidential_transcript"');
    expect(copiedPackage).toContain('"raw_audio_included": false');
    expect(copiedPackage).toContain(`"text_hash": "${CONSENT_TEXT_HASH}"`);
    expect(copiedPackage).toContain('"meeting_id": "22222222-2222-4222-8222-222222222222"');
    expect(copiedPackage).toContain('"transcript":');
    expect(copiedPackage).not.toContain('summaryMarkdown');

    await userEvent.click(screen.getByRole('button', { name: 'AI JSON' }));
    expect(adapter.downloadText).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-ai-source-22222222-2222-4222-8222-222222222222-/),
      expect.stringContaining('"target": "backend-gateway -> meeting-ai /analyze"'),
      'application/json',
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
        'Transkript kaynağı toplantı çıktısı üretimi için yeterli görünüyor.',
      ),
    ).toBeInTheDocument();
    const nextStep = screen.getByLabelText('Sıradaki kapı');
    expect(within(nextStep).getByText('Meeting AI')).toBeInTheDocument();
    expect(
      within(nextStep).getByText(
        'Kaynak hazır; özet, karar ve aksiyon üretimi için meeting-ai sonucu bekleniyor.',
      ),
    ).toBeInTheDocument();

    const sourceSummary = screen.getByLabelText('Kaynak transkript özeti');
    const aiPackage = screen.getByLabelText('Meeting AI kaynak paketi');
    expect(within(aiPackage).getByText('Gönderime hazır kaynak')).toBeInTheDocument();
    const aiGate = screen.getByLabelText('Meeting AI kapı kontrolü');
    expect(within(aiGate).getByText('Meeting AI gönderimine hazır')).toBeInTheDocument();
    expect(within(aiGate).getByText('Yok')).toBeInTheDocument();
    expect(
      within(aiGate).getByText(
        'Kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir.',
      ),
    ).toBeInTheDocument();
    expect(within(sourceSummary).getByText('2 final / 0 taslak')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('18 sn')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('%100')).toBeInTheDocument();
  });

  it('allows finished draft-only transcript submission while labeling the source as draft quality', async () => {
    const adapter: MeetingAiSubmitAdapter = {
      analyze: vi.fn().mockResolvedValue({
        schema_version: '5-adr0043',
        summary: 'Taslak transcript üzerinden preview toplantı çıktısı üretildi.',
        decisions: ['Taslak kaynak Meeting AI preview akışında kullanılacak'],
        action_items: [],
        citations: [
          {
            claim: 'Taslak kaynak Meeting AI preview akışında kullanılacak',
            source_index: 0,
            start_sec: 3,
            grounded: true,
          },
        ],
      }),
    };

    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={draftSubmitTranscriptState()}
        meetingAiSubmitAdapter={adapter}
      />,
    );

    const readiness = screen.getByLabelText('Kaynak hazırlık durumu');
    expect(within(readiness).getByText('Taslak kaynak kullanılabilir')).toBeInTheDocument();
    expect(
      within(readiness).getByText(
        'Yeterli taslak satır var; çıktı taslak kalite etiketiyle üretilebilir.',
      ),
    ).toBeInTheDocument();
    const aiPackage = screen.getByLabelText('Meeting AI kaynak paketi');
    expect(within(aiPackage).getByText('Taslak kaynakla gönderilebilir')).toBeInTheDocument();
    const aiGate = screen.getByLabelText('Meeting AI kapı kontrolü');
    expect(within(aiGate).getByText('Meeting AI taslak gönderimine hazır')).toBeInTheDocument();
    expect(within(aiGate).getByText('Yok')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Taslakla Meeting AI gönder' }));

    await waitFor(() => {
      expect(adapter.analyze).toHaveBeenCalledWith({
        meetingId: '44444444-4444-4444-8444-444444444444',
        request: expect.objectContaining({
          meeting_id: '44444444-4444-4444-8444-444444444444',
          session_id: 'SES-3',
          transcript: expect.stringContaining('Direct STT final satır üretmese bile'),
        }),
      });
    });
    expect(await screen.findByText('Meeting AI sonucu alındı.')).toBeInTheDocument();
  });

  it('submits the ready transcript to Meeting AI via the backend gateway adapter', async () => {
    const adapter: MeetingAiSubmitAdapter = {
      analyze: vi.fn().mockResolvedValue({
        schema_version: '5-adr0043',
        summary: 'Transkript kaynağı doğrulandı; toplantı çıktısı gateway üzerinden üretildi.',
        decisions: ['Meeting AI gönderimi backend gateway üzerinden yapılacak'],
        action_items: [
          {
            text: 'Kaynak kalitesi ve KVKK sınırı PR kanıtına eklenecek',
            owner: 'Zeynep',
            due_date: '2026-07-03',
          },
        ],
        citations: [
          {
            claim: 'Meeting AI gönderimi backend gateway üzerinden yapılacak',
            source_index: 0,
            start_sec: 3,
            grounded: true,
          },
          {
            claim: 'Kaynak kalitesi ve KVKK sınırı PR kanıtına eklenecek',
            source_index: 1,
            start_sec: 21,
            grounded: true,
          },
        ],
        backend: 'mock-meeting-ai',
        model: 'unit-test',
        redacted: false,
        redaction_count: 0,
        persisted: false,
        storageMode: 'preview',
      }),
    };
    const onMeetingAiResult = vi.fn();

    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={reportReadyTranscriptState()}
        meetingAiSubmitAdapter={adapter}
        onMeetingAiResult={onMeetingAiResult}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Meeting AI gönder' }));

    await waitFor(() => {
      expect(adapter.analyze).toHaveBeenCalledWith({
        meetingId: '33333333-3333-4333-8333-333333333333',
        request: expect.objectContaining({
          meeting_id: '33333333-3333-4333-8333-333333333333',
          session_id: 'SES-2',
          transcript: expect.stringContaining('Canlı toplantı kaydı'),
          segments: expect.any(Array),
        }),
      });
    });
    expect(await screen.findByText('Meeting AI sonucu alındı.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Transkript kaynağı doğrulandı; toplantı çıktısı gateway üzerinden üretildi.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Meeting AI gönderimi backend gateway üzerinden yapılacak'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Kaynak kalitesi ve KVKK sınırı PR kanıtına eklenecek'),
    ).toBeInTheDocument();
    expect(onMeetingAiResult).toHaveBeenCalledWith(
      expect.objectContaining({
        providerLabel: 'mock-meeting-ai / unit-test / 5-adr0043',
      }),
    );
  });

  it('automatically submits a finished waiting transcript once when enabled', async () => {
    const adapter: MeetingAiSubmitAdapter = {
      analyze: vi.fn().mockResolvedValue({
        schema_version: '5-adr0043',
        summary: 'Otomatik toplantı çıktısı kayıt bitince üretildi.',
        decisions: ['Kayıt bitişinde Meeting AI gateway tetiklenecek'],
        action_items: [],
        citations: [
          {
            claim: 'Kayıt bitişinde Meeting AI gateway tetiklenecek',
            source_index: 0,
            start_sec: 3,
            grounded: true,
          },
        ],
        backend: 'mock-meeting-ai',
        model: 'unit-test',
      }),
    };
    const onMeetingAiResult = vi.fn();
    const intelligence = { ...initialMeetingIntelligence(), status: 'waiting' as const };
    const transcript = reportReadyTranscriptState();

    const { rerender } = render(
      <SummaryPanel
        intelligence={intelligence}
        transcript={transcript}
        meetingAiSubmitAdapter={adapter}
        autoSubmitMeetingAi
        onMeetingAiResult={onMeetingAiResult}
      />,
    );

    await waitFor(() => {
      expect(adapter.analyze).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Meeting AI sonucu alındı.')).toBeInTheDocument();
    expect(
      screen.getByText('Otomatik toplantı çıktısı kayıt bitince üretildi.'),
    ).toBeInTheDocument();

    rerender(
      <SummaryPanel
        intelligence={intelligence}
        transcript={transcript}
        meetingAiSubmitAdapter={adapter}
        autoSubmitMeetingAi
        onMeetingAiResult={onMeetingAiResult}
      />,
    );

    expect(adapter.analyze).toHaveBeenCalledTimes(1);
    expect(onMeetingAiResult).toHaveBeenCalledTimes(1);
  });
});
