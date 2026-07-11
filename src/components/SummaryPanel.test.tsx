// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { CONSENT_TEXT_HASH, CONSENT_VERSION } from './ConsentDialog';
import { SummaryPanel, type ExportAdapter, type MeetingAiSubmitAdapter } from './SummaryPanel';
import {
  MEETING_OUTPUT_ADAPTER_CAPABILITIES,
  MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION,
  MEETING_OUTPUT_ADAPTER_KIND,
  MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
  MEETING_OUTPUT_ADAPTER_PROFILE_ID,
  MEETING_OUTPUT_ADAPTER_TARGET,
} from '../intelligence/meeting-output-contract';
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

const FORBIDDEN_ERP_BRAND_MARKER = ['work', 'cube'].join('');

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
      providerLabel: 'meeting-ai gateway',
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
    reviewedAtMs: 1781820009000,
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

function reviewedHandoffTranscriptState(): TranscriptSessionState {
  const recording = startTranscriptSession(initialTranscriptSession(), {
    sessionId: 'SES-1',
    meetingId: '22222222-2222-4222-8222-222222222222',
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
    text: 'Direct STT kaynağı karar ve aksiyon üretimine temel olacak şekilde incelendi.',
    reviewedAtMs: 1781820009000,
  });

  const withSecondSegment = upsertTranscriptSegment(withFirstSegment, {
    id: 'seg-2',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820021000,
    status: 'final',
    source: 'direct-stream',
    text: 'Toplantı çıktısı vendor bağımsız ERP CRM adaptörüne review sonrası taşınacak.',
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

function sparseTranscriptState(): TranscriptSessionState {
  const recording = startTranscriptSession(initialTranscriptSession(), {
    sessionId: 'SES-4',
    meetingId: '55555555-5555-4555-8555-555555555555',
    deviceId: 'desktop-1',
    hasLoopback: false,
    startedAtMs: 1781820000000,
  });

  const withFirstSegment = upsertTranscriptSegment(recording, {
    id: 'seg-1',
    speakerLabel: 'Konuşmacı',
    startedAtMs: 1781820000000,
    status: 'final',
    source: 'direct-stream',
    text: 'Toplantı başladı müşteri ihtiyaçları ve entegrasyon riskleri kısa şekilde not edildi',
  });

  return finishTranscriptSession(
    upsertTranscriptSegment(withFirstSegment, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820240000,
      status: 'final',
      source: 'direct-stream',
      text: 'Aksiyon sahipleri belirlendi ancak kayıt kapsamı beklenen konuşmayı taşımıyor',
    }),
    1781820245000,
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

  it('renders explicit canonical loading and not-ready states', async () => {
    const intelligence = {
      ...initialMeetingIntelligence(),
      meetingId: '22222222-2222-4222-8222-222222222222',
    };
    const { rerender } = render(
      <SummaryPanel intelligence={intelligence} canonicalResultStatus="loading" />,
    );

    expect(screen.getByText('Yükleniyor')).toBeInTheDocument();
    expect(screen.getByText('Kalıcı toplantı çıktısı yükleniyor')).toBeInTheDocument();
    expect(
      screen.getByText('Meeting-service üzerindeki canonical snapshot kontrol ediliyor.'),
    ).toBeInTheDocument();

    const onRetry = vi.fn();
    rerender(
      <SummaryPanel
        intelligence={intelligence}
        canonicalResultStatus="not_ready"
        onCanonicalResultRetry={onRetry}
      />,
    );

    expect(screen.getByText('Hazırlanıyor')).toBeInTheDocument();
    expect(screen.getByText('Analiz sonucu hazırlanıyor')).toBeInTheDocument();
    expect(
      screen.getByText('Kalıcı sonuç henüz hazır değil; durumu yeniden kontrol edebilirsiniz.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Kalıcı sonuç henüz hazır değil. Önceki snapshot varsa ekranda tutulur.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sonucu yenile' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps transient canonical read errors visible and retryable', async () => {
    const onRetry = vi.fn();
    render(
      <SummaryPanel
        intelligence={{
          ...initialMeetingIntelligence(),
          meetingId: '22222222-2222-4222-8222-222222222222',
        }}
        canonicalResultStatus="error"
        canonicalResultError="Kalıcı toplantı çıktısı alınamadı: bağlantı kesildi"
        onCanonicalResultRetry={onRetry}
      />,
    );

    expect(screen.getByText('Bağlantı hatası')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('bağlantı kesildi');
    await userEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('labels a canonical persisted result without changing review semantics', () => {
    const state = readyState();
    if (!state.result) {
      throw new Error('readyState fixture must include a result');
    }
    render(
      <SummaryPanel
        intelligence={setMeetingIntelligenceResult(state, {
          ...state.result,
          analysisRunId: '55555555-5555-4555-8555-555555555555',
          storageMode: 'canonical',
        })}
        canonicalResultStatus="ready"
      />,
    );

    expect(screen.getByText('Kalıcı sonuç')).toBeInTheDocument();
    expect(screen.getByText('Kalıcı snapshot')).toBeInTheDocument();
    expect(screen.getByText('Kontrol bekliyor')).toBeInTheDocument();
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
    const outputQuality = screen.getByLabelText('Toplantı çıktısı kalite durumu');
    expect(within(outputQuality).getByText('Kaynak güçlü')).toBeInTheDocument();
    expect(within(outputQuality).getByText('%100')).toBeInTheDocument();
    expect(within(outputQuality).getByText('meeting-ai gateway')).toBeInTheDocument();
    expect(within(outputQuality).getByText('Kontrol bekliyor')).toBeInTheDocument();
    const freshness = screen.getByLabelText('Çıktı güncelliği');
    expect(within(freshness).getByText('Kaynak yok')).toBeInTheDocument();
    expect(
      within(freshness).getByText('Çıktı için karşılaştırılabilir transkript kaynağı yok.'),
    ).toBeInTheDocument();
    const readiness = screen.getByLabelText('ERP/CRM entegrasyon hazırlığı');
    expect(within(readiness).getByText('Review gerekli')).toBeInTheDocument();
    expect(within(readiness).getByText('Review paketi')).toBeInTheDocument();
    expect(
      within(readiness).getAllByText('Transkript kaynak kanıtı yok').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders safe output quality fallbacks and confidence bands', () => {
    const base = readyState();
    if (!base.result) {
      throw new Error('readyState fixture must include a result');
    }
    const lowCoverage = setMeetingIntelligenceResult(base, {
      ...base.result,
      citationCoverage: 0.4,
      providerLabel: undefined,
    });
    const { rerender } = render(<SummaryPanel intelligence={lowCoverage} />);

    let outputQuality = screen.getByLabelText('Toplantı çıktısı kalite durumu');
    expect(within(outputQuality).getByText('Kaynak zayıf')).toBeInTheDocument();
    expect(within(outputQuality).getByText('%40')).toBeInTheDocument();
    expect(within(outputQuality).getByText('AI üretimi')).toBeInTheDocument();

    rerender(
      <SummaryPanel
        intelligence={setMeetingIntelligenceResult(base, {
          ...base.result,
          citationCoverage: 0.65,
        })}
      />,
    );
    outputQuality = screen.getByLabelText('Toplantı çıktısı kalite durumu');
    expect(within(outputQuality).getByText('Kısmi kaynaklı')).toBeInTheDocument();
    expect(within(outputQuality).getByText('%65')).toBeInTheDocument();

    rerender(
      <SummaryPanel
        intelligence={setMeetingIntelligenceResult(base, {
          ...base.result,
          citationCoverage: Number.NaN,
          generatedAtMs: undefined as unknown as number,
        })}
      />,
    );
    outputQuality = screen.getByLabelText('Toplantı çıktısı kalite durumu');
    expect(within(outputQuality).getByText('Bilinmiyor')).toBeInTheDocument();
    expect(within(outputQuality).getAllByText('-')).toHaveLength(2);
  });

  it('marks stale meeting output as review-only before ERP CRM handoff', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    const submitAdapter: MeetingAiSubmitAdapter = {
      analyze: vi.fn().mockResolvedValue({
        schema_version: '5-adr0043',
        summary: 'Yenilenmiş çıktı son transkript kaynağına göre üretildi.',
        decisions: ['Stale paket Meeting AI yenilemesi sonrası review edilecek'],
        action_items: [
          {
            text: 'ERP CRM handoff paketi güncel kaynakla tekrar kontrol edilecek',
            owner: 'Zeynep',
            due_date: '2026-07-04',
          },
        ],
        citations: [
          {
            claim: 'Stale paket Meeting AI yenilemesi sonrası review edilecek',
            source_index: 0,
            start_sec: 3,
            grounded: true,
          },
        ],
        backend: 'mock-meeting-ai',
        model: 'unit-test',
      }),
    };
    const transcript = reportReadyTranscriptState();
    const onMeetingAiSubmitted = vi.fn();
    const base = readyState();
    if (!base.result) {
      throw new Error('readyState fixture must include a result');
    }

    render(
      <SummaryPanel
        intelligence={setMeetingIntelligenceResult(
          {
            ...initialMeetingIntelligence(),
            meetingId: transcript.meetingId,
            sessionId: transcript.sessionId,
          },
          {
            ...base.result,
            generatedAtMs: 1781820005000,
          },
        )}
        transcript={transcript}
        exportAdapter={adapter}
        meetingAiSubmitAdapter={submitAdapter}
        onMeetingAiSubmitted={onMeetingAiSubmitted}
      />,
    );

    const freshness = screen.getByLabelText('Çıktı güncelliği');
    expect(within(freshness).getByText('Kaynak değişti')).toBeInTheDocument();
    expect(
      within(freshness).getByText(
        'Transkript AI çıktısından sonra değişti; Meeting AI yeniden gönderilmeli.',
      ),
    ).toBeInTheDocument();
    const readiness = screen.getByLabelText('ERP/CRM entegrasyon hazırlığı');
    expect(within(readiness).getByText('Review gerekli')).toBeInTheDocument();
    expect(within(readiness).getByText('Review paketi')).toBeInTheDocument();
    expect(
      within(readiness).getAllByText('Transkript AI çıktısından sonra değişti').length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Review paketi kopyala' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review JSON' })).toBeInTheDocument();
    const objectPreview = within(readiness).getByLabelText('ERP/CRM nesne önizlemesi');
    expect(within(objectPreview).getAllByText('Kontrol gerekli')).toHaveLength(3);

    await userEvent.click(screen.getByRole('button', { name: 'Review paketi kopyala' }));

    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('platform-desktop.meeting-output-integration.v1'),
      );
    });
    const integrationPackage = JSON.parse(
      String(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0]),
    ) as {
      handoff_readiness: {
        status: string;
        can_handoff: boolean;
        blockers: Array<Record<string, unknown>>;
      };
      object_plan: Array<{ status: string; issues: Array<Record<string, unknown>> }>;
      source_evidence: {
        transcript: {
          result_freshness: {
            status: string;
            raw_transcript_included: boolean;
          };
        };
      };
    };

    expect(integrationPackage.handoff_readiness).toMatchObject({
      status: 'needs_review',
      can_handoff: false,
      blockers: [
        expect.objectContaining({
          code: 'stale_source_evidence',
          severity: 'blocker',
          label: 'Transkript AI çıktısından sonra değişti',
        }),
      ],
    });
    expect(integrationPackage.object_plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'needs_review',
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'stale_source_evidence' }),
          ]),
        }),
      ]),
    );
    expect(integrationPackage.source_evidence.transcript.result_freshness).toMatchObject({
      status: 'source_changed',
      raw_transcript_included: false,
    });
    expect(screen.getByText('Review paketi panoya kopyalandı.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Meeting AI yenile' }));

    await waitFor(() => {
      expect(submitAdapter.analyze).toHaveBeenCalledWith({
        meetingId: '33333333-3333-4333-8333-333333333333',
        request: expect.objectContaining({
          meeting_id: '33333333-3333-4333-8333-333333333333',
          session_id: 'SES-2',
          transcript: expect.stringContaining('Canlı toplantı kaydı sırasında transkript'),
        }),
      });
    });
    expect(
      await screen.findByText('Analiz tetiklendi; kalıcı sonuç hazırlanıyor.'),
    ).toBeInTheDocument();
    expect(onMeetingAiSubmitted).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText('Yenilenmiş çıktı son transkript kaynağına göre üretildi.'),
    ).not.toBeInTheDocument();
  });

  it('surfaces ERP CRM handoff review blockers before adapter export', async () => {
    const base = readyState();
    if (!base.result) {
      throw new Error('readyState fixture must include a result');
    }
    const decisionTitle = 'Recorder fresh login sonrası tekrar denenecek';
    const actionTitle = 'audio_record rolü yeni token claim özetinde doğrulanacak';

    render(
      <SummaryPanel
        intelligence={setMeetingIntelligenceResult(base, {
          ...base.result,
          citationCoverage: 0.4,
          decisions: [
            {
              ...base.result.decisions[0],
              owner: undefined,
            },
          ],
          actionItems: [
            {
              ...base.result.actionItems[0],
              assignee: undefined,
              dueDate: undefined,
            },
          ],
        })}
      />,
    );

    const readiness = screen.getByLabelText('ERP/CRM entegrasyon hazırlığı');
    expect(within(readiness).getByText('Review gerekli')).toBeInTheDocument();
    expect(within(readiness).getByText('Review paketi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review paketi kopyala' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review JSON' })).toBeInTheDocument();
    const packageStatus = within(readiness).getByLabelText('ERP/CRM aktarım paketi durumu');
    expect(within(packageStatus).getByText('Backend adapter')).toBeInTheDocument();
    expect(within(packageStatus).getByText('Review-before-write')).toBeInTheDocument();
    expect(within(packageStatus).getByText('Fail-closed')).toBeInTheDocument();
    expect(
      within(packageStatus).getByText(
        "Genel amaçlı ERP/CRM aktarım paketi; ERP/CRM'ye özel hedefler yalnızca backend adapter eşlemesiyle bağlanır.",
      ),
    ).toBeInTheDocument();
    const adapterManifest = within(readiness).getByLabelText('Genel ERP/CRM adapter manifesti');
    expect(within(adapterManifest).getByText(MEETING_OUTPUT_ADAPTER_KIND)).toBeInTheDocument();
    expect(within(adapterManifest).getByText(MEETING_OUTPUT_ADAPTER_TARGET)).toBeInTheDocument();
    const capabilities = within(adapterManifest).getByLabelText('Adapter kabiliyetleri');
    expect(within(capabilities).getByText('Toplantı notu upsert')).toBeInTheDocument();
    expect(within(capabilities).getByText('Karar kaydı upsert')).toBeInTheDocument();
    expect(within(capabilities).getByText('Aksiyon görevi upsert')).toBeInTheDocument();
    expect(within(capabilities).getByText('Kaynak referansı eşleme')).toBeInTheDocument();
    expect(within(capabilities).getByText('Idempotent yazım')).toBeInTheDocument();
    expect(within(capabilities).getByText('İnsan review kapısı')).toBeInTheDocument();
    for (const capability of MEETING_OUTPUT_ADAPTER_CAPABILITIES) {
      expect(within(capabilities).getByText(capability)).toBeInTheDocument();
    }
    expect(within(readiness).getAllByText(/1 açık aksiyonda sahip eksik/)).toHaveLength(3);
    expect(within(readiness).getAllByText(/1 kararda sahip eksik/)).toHaveLength(3);
    expect(within(readiness).getAllByText(/1 açık aksiyonda tarih eksik/)).toHaveLength(3);
    expect(within(readiness).getByText(/\+2 daha/)).toBeInTheDocument();
    const reviewDetails = within(readiness).getByLabelText('Aktarım review detayları');
    expect(within(reviewDetails).getAllByText('Blokaj')).toHaveLength(2);
    expect(within(reviewDetails).getAllByText('Uyarı')).toHaveLength(3);
    expect(within(reviewDetails).getByText('Kaynak kapsamı %50 altında')).toBeInTheDocument();
    expect(within(reviewDetails).getByText('Transkript kaynak kanıtı yok')).toBeInTheDocument();
    const objectPreview = within(readiness).getByLabelText('ERP/CRM nesne önizlemesi');
    expect(within(objectPreview).getByText('Toplantı notu')).toBeInTheDocument();
    expect(within(objectPreview).getByText('Karar kayıtları')).toBeInTheDocument();
    expect(within(objectPreview).getByText('Aksiyon görevleri')).toBeInTheDocument();
    expect(within(objectPreview).getAllByText('Kontrol gerekli')).toHaveLength(3);
    expect(within(objectPreview).getByText(/Kaynak kapsamı %50 altında/)).toBeInTheDocument();
    expect(within(objectPreview).getByText(/1 kararda sahip eksik/)).toBeInTheDocument();
    expect(within(objectPreview).getAllByText(/Transkript kaynak kanıtı yok/)).toHaveLength(3);
    expect(
      within(objectPreview).getByText(
        /1 açık aksiyonda sahip eksik · 1 açık aksiyonda tarih eksik/,
      ),
    ).toBeInTheDocument();

    const decisionTable = screen.getByRole('table', { name: 'Kararlar' });
    expect(within(decisionTable).getByText('Sahip eksik')).toBeInTheDocument();
    const actionTable = screen.getByRole('table', { name: 'Aksiyonlar' });
    expect(within(actionTable).getByText('Sahip eksik')).toBeInTheDocument();
    expect(within(actionTable).getByText('Tarih eksik')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`), 'Halil');
    await userEvent.type(screen.getByLabelText(`Sahip: ${actionTitle}`), 'Zeynep Akkılıç');
    fireEvent.change(screen.getByLabelText(`Tarih: ${actionTitle}`), {
      target: { value: '2026-07-05' },
    });

    expect(within(decisionTable).getAllByText('Hazır')).toHaveLength(1);
    expect(within(actionTable).getAllByText('Hazır')).toHaveLength(1);
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

  it('edits decision owner and status and exports reviewed decisions', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(<SummaryPanel intelligence={readyState()} exportAdapter={adapter} />);

    const decisionTitle = 'Recorder fresh login sonrası tekrar denenecek';
    await userEvent.clear(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`));
    await userEvent.type(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`), 'Halil');
    await userEvent.selectOptions(
      screen.getByLabelText(`Karar durumu: ${decisionTitle}`),
      'revised',
    );

    expect(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`)).toHaveValue('Halil');
    expect(screen.getByLabelText(`Karar durumu: ${decisionTitle}`)).toHaveValue('revised');

    await userEvent.click(screen.getByRole('button', { name: 'Kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(expect.stringContaining('@Halil'));
    });
    const markdown = String(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0]);
    expect(markdown).toContain('Recorder fresh login sonrası tekrar denenecek');
    expect(markdown).toContain('Revize');

    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    const csv = String(vi.mocked(adapter.downloadText).mock.calls.at(-1)?.[1]);
    expect(csv).toContain('decision,dec-1');
    expect(csv).toContain('Halil');
    expect(csv).toContain('Revize');

    await userEvent.click(screen.getByRole('button', { name: 'Orijinal kararlar' }));
    expect(screen.getByText('Kararlar orijinal haline döndü.')).toBeInTheDocument();
    expect(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`)).toHaveValue('Zeynep');
    expect(screen.getByLabelText(`Karar durumu: ${decisionTitle}`)).toHaveValue('accepted');
  });

  it('edits action owner due date and status and exports reviewed actions', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(<SummaryPanel intelligence={readyState()} exportAdapter={adapter} />);

    const actionTitle = 'audio_record rolü yeni token claim özetinde doğrulanacak';
    await userEvent.clear(screen.getByLabelText(`Sahip: ${actionTitle}`));
    await userEvent.type(screen.getByLabelText(`Sahip: ${actionTitle}`), 'Halil');
    fireEvent.change(screen.getByLabelText(`Tarih: ${actionTitle}`), {
      target: { value: '2026-07-04' },
    });
    await userEvent.selectOptions(screen.getByLabelText(`Durum: ${actionTitle}`), 'in_progress');

    expect(screen.getByLabelText(`Sahip: ${actionTitle}`)).toHaveValue('Halil');
    expect(screen.getByLabelText(`Tarih: ${actionTitle}`)).toHaveValue('2026-07-04');
    expect(screen.getByLabelText(`Durum: ${actionTitle}`)).toHaveValue('in_progress');

    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    expect(adapter.downloadText).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-intelligence-actions-.*\.csv$/),
      expect.stringContaining('Halil'),
      'text/csv',
    );
    const csv = String(vi.mocked(adapter.downloadText).mock.calls.at(-1)?.[1]);
    expect(csv).toContain('2026-07-04');
    expect(csv).toContain('İlerliyor');

    await userEvent.click(screen.getByRole('button', { name: 'Orijinal aksiyonlar' }));
    expect(screen.getByText('Aksiyonlar orijinal haline döndü.')).toBeInTheDocument();
    expect(screen.getByLabelText(`Sahip: ${actionTitle}`)).toHaveValue('Zeynep');
    expect(screen.getByLabelText(`Durum: ${actionTitle}`)).toHaveValue('open');
  });

  it('exports reviewed output as a generic ERP/CRM handoff package', async () => {
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
    };
    render(
      <SummaryPanel
        intelligence={readyState()}
        transcript={reviewedHandoffTranscriptState()}
        exportAdapter={adapter}
      />,
    );

    const decisionTitle = 'Recorder fresh login sonrası tekrar denenecek';
    await userEvent.clear(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`));
    await userEvent.type(screen.getByLabelText(`Karar sahibi: ${decisionTitle}`), 'Halil');
    await userEvent.selectOptions(
      screen.getByLabelText(`Karar durumu: ${decisionTitle}`),
      'revised',
    );

    const actionTitle = 'audio_record rolü yeni token claim özetinde doğrulanacak';
    await userEvent.clear(screen.getByLabelText(`Sahip: ${actionTitle}`));
    await userEvent.type(screen.getByLabelText(`Sahip: ${actionTitle}`), 'Zeynep Akkılıç');
    await userEvent.selectOptions(screen.getByLabelText(`Durum: ${actionTitle}`), 'blocked');

    await userEvent.click(screen.getByRole('button', { name: 'Aktarım paketi kopyala' }));

    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('platform-desktop.meeting-output-integration.v1'),
      );
    });
    const integrationPackage = JSON.parse(
      String(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0]),
    ) as {
      privacy: Record<string, unknown>;
      route: Record<string, unknown>;
      adapter_manifest: Record<string, unknown>;
      object_plan: Array<Record<string, unknown>>;
      source_evidence: {
        transcript: Record<string, unknown> | null;
      } | null;
      decisions: Array<Record<string, unknown>>;
      action_items: Array<Record<string, unknown>>;
    };

    expect(integrationPackage.privacy).toMatchObject({
      raw_audio_included: false,
      raw_transcript_included: false,
      classification: 'confidential_meeting_intelligence',
    });
    expect(integrationPackage.route).toMatchObject({
      target: 'Generic ERP/CRM meeting workspace',
      expected_authority: 'backend-gateway / meeting-service integration adapter',
      desktop_direct_backend_mutation: false,
    });
    expect(integrationPackage.adapter_manifest).toMatchObject({
      profile_id: MEETING_OUTPUT_ADAPTER_PROFILE_ID,
      target_family: 'erp_crm',
      vendor_specific: false,
      required_capabilities: MEETING_OUTPUT_ADAPTER_CAPABILITIES,
      object_contracts: MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
    });
    expect(integrationPackage.object_plan).toEqual([
      expect.objectContaining({
        object: 'meeting_note',
        label: 'Toplantı notu',
        records: 1,
        external_key: 'meeting_id',
        status: 'ready',
      }),
      expect.objectContaining({
        object: 'decision_record',
        label: 'Karar kayıtları',
        records: 1,
        external_key: 'decision.id',
        status: 'ready',
      }),
      expect.objectContaining({
        object: 'action_task',
        label: 'Aksiyon görevleri',
        records: 1,
        external_key: 'action.id',
        status: 'ready',
      }),
    ]);
    expect(integrationPackage.source_evidence?.transcript).toMatchObject({
      source_level: 'ready',
      source_label: 'Çıktıya uygun',
      lifecycle: 'finished',
      segment_count: 2,
      final_count: 2,
      draft_count: 0,
      reviewed_count: 1,
      reviewed_ratio: 0.5,
      quality_gate: {
        status: 'ready',
        risk: 'none',
        label: 'Kalite kapısı açık',
        action: 'Kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir.',
      },
      result_freshness: {
        status: 'current',
        label: 'Güncel',
        latest_source_at_ms: 1781820021000,
        stale_by_ms: 0,
        raw_transcript_included: false,
      },
      raw_transcript_included: false,
    });
    expect(JSON.stringify(integrationPackage.source_evidence)).not.toContain('Direct STT kaynağı');
    expect(integrationPackage.decisions[0]).toMatchObject({
      owner: 'Halil',
      status: 'revised',
      status_label: 'Revize',
    });
    expect(integrationPackage.action_items[0]).toMatchObject({
      assignee: 'Zeynep Akkılıç',
      status: 'blocked',
      status_label: 'Blokeli',
    });
    const outputQuality = screen.getByLabelText('Toplantı çıktısı kalite durumu');
    expect(within(outputQuality).getByText('Revizyonlu')).toBeInTheDocument();
    expect(within(outputQuality).getByText('Güncel')).toBeInTheDocument();
    expect(within(outputQuality).getByText('Transkript review')).toBeInTheDocument();
    expect(within(outputQuality).getByText('1/2 · %50')).toBeInTheDocument();
    const readiness = screen.getByLabelText('ERP/CRM entegrasyon hazırlığı');
    expect(within(readiness).getByText('Hedef')).toBeInTheDocument();
    expect(within(readiness).getByText('ERP/CRM adaptör hedefi')).toBeInTheDocument();
    expect(
      within(readiness).getByText(MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION),
    ).toBeInTheDocument();
    expect(within(readiness).getByText('Marka bağımsız')).toBeInTheDocument();
    expect(within(readiness).getByText('Adapter profili')).toBeInTheDocument();
    expect(within(readiness).getByText(MEETING_OUTPUT_ADAPTER_PROFILE_ID)).toBeInTheDocument();
    expect(within(readiness).getByText('Manifest')).toBeInTheDocument();
    expect(within(readiness).getByText('Aktarım paketi hazır')).toBeInTheDocument();
    expect(
      within(readiness).getByText(
        `${MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS.length} nesne / ${MEETING_OUTPUT_ADAPTER_CAPABILITIES.length} kabiliyet`,
      ),
    ).toBeInTheDocument();
    expect(within(readiness).getByText('Kaynak kanıtı')).toBeInTheDocument();
    expect(within(readiness).getByText('Review metrikli')).toBeInTheDocument();
    expect(within(readiness).getByText('Toplantı notu / 1 karar / 1 aksiyon')).toBeInTheDocument();
    expect(within(readiness).getByText('Onaydan sonra')).toBeInTheDocument();
    expect(within(readiness).getByText('Ham ses/transkript yok')).toBeInTheDocument();
    expect(
      within(readiness).getByText('meeting_note, decision_record, action_task'),
    ).toBeInTheDocument();
    const packageStatus = within(readiness).getByLabelText('ERP/CRM aktarım paketi durumu');
    expect(within(packageStatus).getByText('Backend adapter')).toBeInTheDocument();
    expect(within(packageStatus).getByText('Review-before-write')).toBeInTheDocument();
    expect(within(packageStatus).getByText('Fail-closed')).toBeInTheDocument();
    expect(
      within(packageStatus).getByText(
        "Genel amaçlı ERP/CRM aktarım paketi; ERP/CRM'ye özel hedefler yalnızca backend adapter eşlemesiyle bağlanır.",
      ),
    ).toBeInTheDocument();
    const objectPreview = within(readiness).getByLabelText('ERP/CRM nesne önizlemesi');
    expect(within(objectPreview).getByText('Toplantı notu')).toBeInTheDocument();
    expect(within(objectPreview).getByText('Karar kayıtları')).toBeInTheDocument();
    expect(within(objectPreview).getByText('Aksiyon görevleri')).toBeInTheDocument();
    expect(within(objectPreview).getAllByText('1 kayıt')).toHaveLength(3);
    expect(within(objectPreview).getByText('meeting_id')).toBeInTheDocument();
    expect(within(objectPreview).getByText('decision.id')).toBeInTheDocument();
    expect(within(objectPreview).getByText('action.id')).toBeInTheDocument();
    expect(within(objectPreview).getAllByText('Hazır')).toHaveLength(3);
    expect(within(objectPreview).getAllByText('Eksik yok')).toHaveLength(3);
    expect(screen.getByText('Aktarım paketi panoya kopyalandı.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Aktarım JSON' }));
    expect(adapter.downloadText).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-output-integration-22222222-2222-4222-8222-222222222222-/),
      expect.stringContaining('"import_targets": ['),
      'application/json',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Manifest kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(
        expect.stringContaining('platform-desktop.meeting-output-adapter-manifest.v1'),
      );
    });
    const manifest = JSON.parse(String(vi.mocked(adapter.copyText).mock.calls.at(-1)?.[0])) as {
      profile_id: string;
      target_family: string;
      vendor_specific: boolean;
      required_capabilities: string[];
      object_contracts: Array<Record<string, unknown>>;
      privacy_guards: Record<string, unknown>;
    };
    expect(manifest).toMatchObject({
      profile_id: MEETING_OUTPUT_ADAPTER_PROFILE_ID,
      target_family: 'erp_crm',
      vendor_specific: false,
      required_capabilities: MEETING_OUTPUT_ADAPTER_CAPABILITIES,
      object_contracts: MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
      privacy_guards: {
        raw_audio_included: false,
        raw_transcript_included: false,
        requires_human_review: true,
      },
    });
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain(FORBIDDEN_ERP_BRAND_MARKER);
    expect(screen.getByText('Adapter manifesti panoya kopyalandı.')).toBeInTheDocument();
  });

  it('shares reviewed meeting output through clipboard email and Teams drafts', async () => {
    const openExternal = vi.fn();
    const adapter: ExportAdapter = {
      copyText: vi.fn().mockResolvedValue(undefined),
      downloadText: vi.fn(),
      print: vi.fn(),
      openExternal,
    };
    render(<SummaryPanel intelligence={readyState()} exportAdapter={adapter} />);

    const actionTitle = 'audio_record rolü yeni token claim özetinde doğrulanacak';
    await userEvent.clear(screen.getByLabelText(`Sahip: ${actionTitle}`));
    await userEvent.type(screen.getByLabelText(`Sahip: ${actionTitle}`), 'Halil');
    await userEvent.selectOptions(screen.getByLabelText(`Durum: ${actionTitle}`), 'in_progress');

    await userEvent.click(screen.getByRole('button', { name: 'Paylaş' }));

    const dialog = screen.getByRole('dialog', { name: 'Çıktıyı paylaş' });
    expect(dialog).toBeInTheDocument();
    const shareBody = screen.getByLabelText('Paylaşım metni');
    const shareText = String((shareBody as HTMLTextAreaElement).value);
    expect(shareText).toContain('@Halil');
    expect(shareText).toContain('İlerliyor');

    await userEvent.type(screen.getByLabelText('Paylaşım alıcıları'), 'zeynep@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Panoya kopyala' }));
    await waitFor(() => {
      expect(adapter.copyText).toHaveBeenCalledWith(expect.stringContaining('@Halil'));
    });
    expect(screen.getByText('Paylaşım metni panoya kopyalandı.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'E-posta taslağı' }));
    const emailUrl = String(openExternal.mock.calls.at(-1)?.[0]);
    expect(emailUrl).toContain('mailto:zeynep@example.com?');
    expect(emailUrl).toContain('subject=Meeting+Intelligence');
    expect(emailUrl).toContain('body=');

    await userEvent.click(screen.getByRole('button', { name: 'Teams taslağı' }));
    const teamsUrl = String(openExternal.mock.calls.at(-1)?.[0]);
    expect(teamsUrl).toContain('https://teams.microsoft.com/l/chat/0/0');
    expect(teamsUrl).toContain('message=');
    expect(teamsUrl).toContain('users=zeynep%40example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByRole('dialog', { name: 'Çıktıyı paylaş' })).not.toBeInTheDocument();
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
    const qualityGate = screen.getByLabelText('Kaynak kalite kapısı');
    expect(within(qualityGate).getByText('Kaynak toplanıyor')).toBeInTheDocument();
    expect(
      within(qualityGate).getByText('Kayıt bitince kaynak kapsamı ve final oranı yeniden ölçülür.'),
    ).toBeInTheDocument();
    const sourceSummary = screen.getByLabelText('Kaynak transkript özeti');
    expect(within(sourceSummary).getByText('Satır')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('2')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('1 final / 1 taslak')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Direct STT')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Kelime')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Kelime/dk')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('72 kelime/dk')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Final oranı')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('İnceleme')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('0/2 · %0')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('Kalite riski')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('recording_active')).toBeInTheDocument();
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
    expect(copiedPackage).toContain('"word_rate_per_minute": 72');
    expect(copiedPackage).toContain('"quality_gate":');
    expect(copiedPackage).toContain('"risk": "recording_active"');
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
    const qualityGate = screen.getByLabelText('Kaynak kalite kapısı');
    expect(within(qualityGate).getByText('Kalite kapısı açık')).toBeInTheDocument();
    expect(
      within(qualityGate).getByText(
        'Kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir.',
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
    expect(within(sourceSummary).getByText('25 sn')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('62 kelime/dk')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('%100')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('İnceleme')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('1/2 · %50')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('none')).toBeInTheDocument();
  });

  it('keeps low-coverage transcript sources behind the source quality gate', () => {
    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={sparseTranscriptState()}
      />,
    );

    const readiness = screen.getByLabelText('Kaynak hazırlık durumu');
    expect(within(readiness).getByText('Gözden geçirilmeli')).toBeInTheDocument();
    expect(
      within(readiness).getByText(
        'Kelime üretim hızı düşük; konuşmanın önemli kısmı transcript kaynağına düşmemiş olabilir.',
      ),
    ).toBeInTheDocument();
    const qualityGate = screen.getByLabelText('Kaynak kalite kapısı');
    expect(within(qualityGate).getByText('Kapsam riski')).toBeInTheDocument();
    expect(
      within(qualityGate).getByText(
        'Mikrofon/direct STT zinciri doğrulanmadan Meeting AI veya ERP/CRM aktarımı yapılmaz.',
      ),
    ).toBeInTheDocument();
    const sourceSummary = screen.getByLabelText('Kaynak transkript özeti');
    expect(within(sourceSummary).getByText('4.9 kelime/dk')).toBeInTheDocument();
    expect(within(sourceSummary).getByText('low_word_coverage')).toBeInTheDocument();
    const aiGate = screen.getByLabelText('Meeting AI kapı kontrolü');
    expect(within(aiGate).getByText('Meeting AI kapısı bekliyor')).toBeInTheDocument();
    expect(within(aiGate).getByText('kaynak kalite kontrolü gerekiyor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meeting AI gönder' })).toBeDisabled();
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
    const qualityGate = screen.getByLabelText('Kaynak kalite kapısı');
    expect(within(qualityGate).getByText('Taslak kaliteyle açık')).toBeInTheDocument();
    expect(
      within(qualityGate).getByText(
        'Backend gateway üzerinden taslak kalite etiketiyle gönderilebilir; final kanıt gibi değerlendirilmez.',
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
    expect(
      await screen.findByText('Analiz tetiklendi; kalıcı sonuç hazırlanıyor.'),
    ).toBeInTheDocument();
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
    const onMeetingAiSubmitted = vi.fn();

    render(
      <SummaryPanel
        intelligence={{ ...initialMeetingIntelligence(), status: 'waiting' }}
        transcript={reportReadyTranscriptState()}
        meetingAiSubmitAdapter={adapter}
        onMeetingAiSubmitted={onMeetingAiSubmitted}
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
    expect(
      await screen.findByText('Analiz tetiklendi; kalıcı sonuç hazırlanıyor.'),
    ).toBeInTheDocument();
    expect(onMeetingAiSubmitted).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(
        'Transkript kaynağı doğrulandı; toplantı çıktısı gateway üzerinden üretildi.',
      ),
    ).not.toBeInTheDocument();
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
    const onMeetingAiSubmitted = vi.fn();
    const intelligence = { ...initialMeetingIntelligence(), status: 'waiting' as const };
    const transcript = reportReadyTranscriptState();

    const { rerender } = render(
      <SummaryPanel
        intelligence={intelligence}
        transcript={transcript}
        meetingAiSubmitAdapter={adapter}
        autoSubmitMeetingAi
        onMeetingAiSubmitted={onMeetingAiSubmitted}
      />,
    );

    await waitFor(() => {
      expect(adapter.analyze).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText('Analiz tetiklendi; kalıcı sonuç hazırlanıyor.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Otomatik toplantı çıktısı kayıt bitince üretildi.'),
    ).not.toBeInTheDocument();

    rerender(
      <SummaryPanel
        intelligence={intelligence}
        transcript={transcript}
        meetingAiSubmitAdapter={adapter}
        autoSubmitMeetingAi
        onMeetingAiSubmitted={onMeetingAiSubmitted}
      />,
    );

    expect(adapter.analyze).toHaveBeenCalledTimes(1);
    expect(onMeetingAiSubmitted).toHaveBeenCalledTimes(1);
  });
});
