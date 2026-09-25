// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('./audio/capture', () => ({
  RECORDER_START_OPERATION_TIMEOUT_MS: 515_000,
  initialAudioCapturePreflightState: {
    status: 'idle',
    message: null,
    checkedAtMs: null,
    elapsedMs: null,
    moduleUrl: null,
  },
  startRecording: vi.fn(),
  testAudioCaptureWorklet: vi.fn(),
}));

vi.mock('./audio/live-stt-preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audio/live-stt-preflight')>();
  return {
    ...actual,
    testLiveSttStreamConnection: vi.fn(),
  };
});

import { startRecording, testAudioCaptureWorklet } from './audio/capture';
import { testLiveSttStreamConnection } from './audio/live-stt-preflight';
import type { MeetingIntelligenceReadOutcome } from '../electron/services/meeting/meeting-client';
import App, {
  CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS,
  CANONICAL_RESULT_FOLLOW_UP_TIMEOUT_MS,
  CANONICAL_RESULT_POLL_DELAYS_MS,
  CANONICAL_RESULT_REQUEST_TIMEOUT_MS,
  LIFECYCLE_RECONCILIATION_DURABLE_RETRY_MS,
  canonicalResultDurableRetryDelayMs,
  transcriptSegmentIdFromGateway,
  transcriptTimelineEndedAtMs,
  transcriptTimelineTimingBasis,
} from './App';

interface TestTranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  windowSeq?: number | null;
  firstChunkSeq?: number | null;
  lastChunkSeq?: number | null;
  windowStartedAtMs?: number | null;
  windowEndedAtMs?: number | null;
  audioDurationMs?: number | null;
  flushReason?: string | null;
  receivedAtMs?: number | null;
  text: string;
  textLength: number;
  status: string;
  correlationId?: string | null;
}

interface TestTranscriptGatewayError {
  sessionId: string;
  message: string;
}

let transcriptEventHandler: ((event: TestTranscriptGatewayEvent) => void) | null = null;
let trayStopHandler: (() => void) | null = null;
let trayPauseHandler: (() => void) | null = null;
let trayResumeHandler: (() => void) | null = null;

const CANONICAL_MEETING_ID = '33333333-3333-4333-8333-333333333333';

function canonicalMeetingResult(
  overrides: Partial<{
    meetingId: string;
    analysisRunId: string;
    summary: string;
    generatedAt: string;
  }> = {},
) {
  const meetingId = overrides.meetingId ?? CANONICAL_MEETING_ID;
  const analysisRunId = overrides.analysisRunId ?? '55555555-5555-4555-8555-555555555555';
  const summary = overrides.summary ?? 'Kalıcı toplantı özeti yüklendi.';
  return {
    analysisRunId,
    meetingId,
    sessionId: 'SES-CANONICAL',
    schema_version: '5-adr0043',
    model: 'qwen',
    backend: 'ollama',
    summary,
    summaryGroundingStatus: 'verified',
    summary_citations: [
      {
        claim: summary,
        source_index: 0,
        start_sec: 1,
        source_hash: 'a'.repeat(64),
        quote_hash: 'b'.repeat(64),
      },
    ],
    decisions: ['Canonical read kullanılacak'],
    action_items: [{ text: 'Runtime kanıtı eklenecek', owner: 'Zeynep', due_date: null }],
    citations: [
      {
        claim: 'Canonical read kullanılacak',
        source_index: 1,
        start_sec: 3,
        source_hash: 'c'.repeat(64),
        quote_hash: 'd'.repeat(64),
      },
    ],
    generatedAt: overrides.generatedAt ?? '2026-07-11T20:00:00.000Z',
    persisted: true as const,
    storageMode: 'canonical' as const,
  };
}

function recentMeeting(id: string, title: string, updatedAt = '2026-07-11T20:00:00.000Z') {
  return {
    id,
    title,
    status: 'COMPLETED',
    scheduledStart: '2026-07-11T19:00:00.000Z',
    scheduledEnd: '2026-07-11T20:00:00.000Z',
    createdAt: '2026-07-11T18:55:00.000Z',
    updatedAt,
  };
}

function installElectronApiMock(recorderConfig: {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
  gatewayLiveStreamEnabled?: boolean;
  liveSttStreamUrl?: string | null;
  liveSttStreamReason?: string | null;
}): void {
  transcriptEventHandler = null;
  trayStopHandler = null;
  trayPauseHandler = null;
  trayResumeHandler = null;
  window.electronAPI = {
    export: {
      savePdf: vi.fn(),
    },
    app: {
      getVersion: vi.fn().mockResolvedValue('0.1.0-test'),
      getAutoLaunch: vi.fn().mockResolvedValue(false),
      setAutoLaunch: vi.fn().mockResolvedValue(false),
    },
    tray: {
      setRecordingActive: vi.fn(),
      setPaused: vi.fn(),
      onStopRequested: vi.fn((callback: () => void) => {
        trayStopHandler = callback;
        return vi.fn();
      }),
      onPauseRequested: vi.fn((callback: () => void) => {
        trayPauseHandler = callback;
        return vi.fn();
      }),
      onResumeRequested: vi.fn((callback: () => void) => {
        trayResumeHandler = callback;
        return vi.fn();
      }),
    },
    auth: {
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue({ loggedIn: false, claims: null }),
      status: vi.fn().mockResolvedValue({ loggedIn: true, claims: null }),
    },
    meeting: {
      listRecent: vi.fn().mockResolvedValue({
        meetings: [],
        page: 0,
        size: 20,
        totalElements: 0,
        totalPages: 0,
      }),
      createContract: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Faz 24 desktop recording',
        status: 'SCHEDULED',
      }),
      analyze: vi.fn(),
      getIntelligenceResult: vi.fn().mockResolvedValue({ status: 'not_ready' }),
      getCanonicalTranscript: vi.fn().mockRejectedValue(new Error('Source unavailable')),
      startLiveAnalysis: vi.fn().mockResolvedValue({ started: true }),
      stopLiveAnalysis: vi.fn().mockResolvedValue({ stopped: true }),
      onLiveAnalysisFrame: vi.fn(() => (): void => {}),
      onLiveAnalysisStatus: vi.fn(() => (): void => {}),
      createAction: vi.fn(async () => ({
        id: 'stub-action',
        meetingId: 'stub',
        description: 'stub',
        assigneeSubject: null,
        status: 'OPEN',
        dueAt: null,
        version: 0,
      })),
      searchAssignees: vi.fn(async () => []),
    },
    audio: {
      recorderConfig: vi.fn().mockResolvedValue({
        gatewayLiveStreamEnabled: false,
        liveSttStreamUrl: null,
        liveSttStreamReason: null,
        ...recorderConfig,
      }),
      reconcileLifecycle: vi
        .fn()
        .mockResolvedValue({ ok: true, processed: 0, remaining: 0, terminalized: 0 }),
      permissionStatus: vi.fn().mockResolvedValue({
        status: 'granted',
        granted: true,
        canRequest: false,
      }),
      requestPermission: vi.fn().mockResolvedValue({
        status: 'granted',
        granted: true,
        canRequest: false,
      }),
      prepareCapture: vi.fn(),
      cancelCapture: vi.fn(),
      consent: vi.fn(),
      start: vi.fn(),
      sendChunk: vi.fn(),
      sendLiveFrame: vi.fn(),
      finish: vi.fn(),
      abort: vi.fn(),
      rendererUnloaded: vi.fn(),
      onTranscriptEvent: vi.fn((callback: (event: TestTranscriptGatewayEvent) => void) => {
        transcriptEventHandler = callback;
        return vi.fn();
      }),
      onTranscriptError: vi.fn((_callback: (event: TestTranscriptGatewayError) => void) => {
        return vi.fn();
      }),
      onTranscriptRecovered: vi.fn((_callback: (event: { sessionId: string }) => void) => {
        return vi.fn();
      }),
      onLiveLag: vi.fn(() => vi.fn()),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete window.electronAPI;
});

beforeEach(() => {
  vi.resetAllMocks();
  // Sağlayıcı/mod seçimi artık localStorage'da kalıcı (mi.* anahtarları);
  // jsdom aynı dosyadaki testler arasında paylaşıldığı için temizlenmezse
  // bir testin seçimi sonrakinin varsayılan-akış varsayımını bozar.
  window.localStorage.clear();
  mockReadyCaptureWorklet();
});

function mockReadyCaptureWorklet(): void {
  vi.mocked(testAudioCaptureWorklet).mockResolvedValue({
    ok: true,
    message: 'Ses işleyici hazır.',
    elapsedMs: 12,
    moduleUrl: 'file:///app/dist/pcm-worklet.js',
  });
}

function mockReadyLiveSttStream(): void {
  vi.mocked(testLiveSttStreamConnection).mockResolvedValue({
    ok: true,
    message: 'Direct STT stream hazir.',
    elapsedMs: 120,
    stage: 'ready',
  });
}

describe('App recorder readiness', () => {
  it('does not mix source and client clock domains when gateway duration is unavailable', () => {
    const sourceStart = 1781821000000;
    const receivedAt = 1781820000000;

    expect(
      transcriptTimelineEndedAtMs({
        chunkStartedAtMs: sourceStart,
        windowStartedAtMs: sourceStart,
        windowEndedAtMs: sourceStart + 60_000,
        audioDurationMs: null,
        receivedAtMs: receivedAt,
      }),
    ).toBeNull();
    expect(
      transcriptTimelineEndedAtMs({
        chunkStartedAtMs: sourceStart,
        windowStartedAtMs: sourceStart,
        windowEndedAtMs: sourceStart + 60_000,
        audioDurationMs: 900,
        receivedAtMs: receivedAt,
      }),
    ).toBe(receivedAt + 900);

    expect(
      transcriptTimelineEndedAtMs({
        chunkStartedAtMs: receivedAt + 400,
        windowStartedAtMs: receivedAt,
        windowEndedAtMs: receivedAt + 60_000,
        audioDurationMs: null,
        receivedAtMs: receivedAt + 500,
      }),
    ).toBe(receivedAt + 60_000);
    expect(
      transcriptTimelineEndedAtMs({
        chunkStartedAtMs: receivedAt,
        windowStartedAtMs: receivedAt,
        windowEndedAtMs: receivedAt + 60_000,
        audioDurationMs: 500,
        receivedAtMs: receivedAt + 500,
      }),
    ).toBe(receivedAt + 500);
    expect(
      transcriptTimelineTimingBasis({
        chunkStartedAtMs: sourceStart,
        windowStartedAtMs: sourceStart,
        windowEndedAtMs: sourceStart + 900,
        audioDurationMs: 900,
        receivedAtMs: receivedAt,
      }),
    ).toBe('delivery');
    expect(
      transcriptTimelineTimingBasis({
        chunkStartedAtMs: receivedAt,
        windowStartedAtMs: receivedAt,
        windowEndedAtMs: receivedAt + 900,
        audioDurationMs: 900,
        receivedAtMs: receivedAt + 1000,
      }),
    ).toBe('source');
  });

  it('maps gateway window sequence to the canonical numeric-order segment identity', () => {
    expect(
      transcriptSegmentIdFromGateway({
        eventId: 'provider-event-id',
        sessionId: 'SES-ORDER',
        windowSeq: 10,
      }),
    ).toBe('gateway:SES-ORDER:window:10');
    expect(
      transcriptSegmentIdFromGateway({
        eventId: 'live-SES-ORDER-4-10',
        sessionId: 'SES-ORDER',
        transportEpoch: 4,
        windowSeq: 10,
      }),
    ).toBe('gateway:SES-ORDER:live:4:window:10');
  });

  it('keeps retrying a durable lifecycle after the bounded startup window', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });
    vi.useFakeTimers();
    vi.mocked(window.electronAPI!.audio.reconcileLifecycle)
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValueOnce({ ok: false, processed: 1, remaining: 1, terminalized: 0 })
      .mockResolvedValue({ ok: true, processed: 1, remaining: 0, terminalized: 0 });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
      });
    }

    expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(6);
    expect(
      screen.getByText('Bekleyen 1 kayıt durumu arka planda yeniden denenecek.'),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFECYCLE_RECONCILIATION_DURABLE_RETRY_MS);
    });

    expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(7);
    expect(screen.queryByText(/Bekleyen 1 kayıt durumu/)).not.toBeInTheDocument();
  });

  it('retries lifecycle reconciliation immediately when the network returns', async () => {
    let online = false;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.electronAPI?.audio.reconcileLifecycle).not.toHaveBeenCalled();

    online = true;
    act(() => window.dispatchEvent(new Event('online')));

    await waitFor(() => {
      expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(1);
  });

  it('coalesces visibility and online retries while reconciliation is in flight', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });
    let resolveFirst: (value: {
      ok: boolean;
      processed: number;
      remaining: number;
      terminalized: number;
    }) => void = () => undefined;
    vi.mocked(window.electronAPI!.audio.reconcileLifecycle)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, processed: 1, remaining: 0, terminalized: 0 });

    render(<App />);
    await waitFor(() => {
      expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: false, processed: 1, remaining: 1, terminalized: 0 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.electronAPI?.audio.reconcileLifecycle).toHaveBeenCalledTimes(2);
    });
  });

  it('canonical meetingId yoksa meeting contract oluşturma aksiyonunu açar', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });

    render(<App />);

    expect(
      await screen.findByText('Mevcut bir toplantıyı seçin veya yeni bir toplantı planlayın.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Canlı Transkript' })).not.toBeInTheDocument();
    expect(screen.queryByText('Kelime/dk')).not.toBeInTheDocument();
    expect(screen.queryByText('JWT claim özeti')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Toplantı planla' }));
    expect(screen.getByRole('textbox', { name: 'Toplantı başlığı' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toplantıyı oluştur' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Kaydet' })).not.toBeInTheDocument();
  });

  it('meeting-service contract olusturunca recorder config hazir olur', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Toplantı planla' }));
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Toplantı başlığı' }),
      'Faz 24 haftalık ürün toplantısı',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Açıklama' }),
      'Haftalık ürün gündemi',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Toplantıyı oluştur' }));

    await waitFor(() => {
      expect(window.electronAPI?.meeting.createContract).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Faz 24 haftalık ürün toplantısı',
          description: 'Haftalık ürün gündemi',
          scheduledStart: expect.any(String),
          scheduledEnd: expect.any(String),
        }),
      );
    });
    expect(
      await screen.findByText('Meeting contract hazır: 33333333-3333-4333-8333-333333333333'),
    ).toBeInTheDocument();
    expect(screen.getByText('33333333-3333-4333-8333-333333333333')).toBeInTheDocument();
    expect(
      screen.queryByText('Meeting intelligence için canonical meetingId yok.'),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('Hazırlanıyor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
  });

  it('Speechmatics secimini anlik gateway oturumuna tasir ve direct streami acmaz', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      gatewayLiveStreamEnabled: true,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-SPEECHMATICS',
      transcriptSessionId: 'SES-SPEECHMATICS',
      sttProvider: 'speechmatics',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);
    const provider = await screen.findByRole('combobox', {
      name: 'Transkripsiyon sağlayıcısı',
    });
    await userEvent.selectOptions(provider, 'speechmatics');
    fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Transkripsiyon: Speechmatics · Anlık');
    expect(startRecording).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'desktop-1',
      expect.objectContaining({
        sttProvider: 'speechmatics',
        transcriptionMode: 'realtime',
        liveSttStreamUrl: null,
      }),
    );
  });

  it('Speechmatics anlik modu gateway canli tasima yoksa fail closed davranir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      gatewayLiveStreamEnabled: false,
      liveSttStreamUrl: null,
      liveSttStreamReason: 'Gateway live stream disabled',
    });

    render(<App />);
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Transkripsiyon sağlayıcısı' }),
      'speechmatics',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    await userEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findAllByText(
        /Speechmatics Anlık modu için yetkili Gateway canlı akışı kullanılabilir değil\./,
      ),
    ).not.toHaveLength(0);
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('meeting contract olusturma cagrilarini hizli tekrar tiklamada tekillestirir', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });
    let resolveContract: (value: { id: string; title: string; status: string }) => void = () =>
      undefined;
    const pendingContract = new Promise<{ id: string; title: string; status: string }>(
      (resolve) => {
        resolveContract = resolve;
      },
    );
    vi.mocked(window.electronAPI!.meeting.createContract).mockReturnValue(pendingContract);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Toplantı planla' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Toplantı başlığı' }), {
      target: { value: 'Faz 24 karar toplantısı' },
    });
    const button = screen.getByRole('button', { name: 'Toplantıyı oluştur' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(window.electronAPI?.meeting.createContract).toHaveBeenCalledTimes(1);

    resolveContract({
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Faz 24 desktop recording',
      status: 'SCHEDULED',
    });
    expect(
      await screen.findByText('Meeting contract hazır: 33333333-3333-4333-8333-333333333333'),
    ).toBeInTheDocument();
  });

  it('canonical meetingId geldiginde kayit butonunu acar', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });

    render(<App />);

    expect(await screen.findByText('Giriş yapıldı. Toplantı kaydına hazır.')).toBeInTheDocument();
    expect(screen.getByText('Hazır')).toBeInTheDocument();
    expect(screen.getByText('22222222-2222-4222-8222-222222222222')).toBeInTheDocument();
    expect(screen.getByText('Transkript akışı bekleniyor')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Toplantı Çıktısı' })).toBeInTheDocument();
    expect(await screen.findByText('Hazırlanıyor')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
    });
  });

  it('direct STT baglanti testini kayit oncesi calistirir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(testLiveSttStreamConnection).mockResolvedValue({
      ok: true,
      message: 'Direct STT stream hazir.',
      elapsedMs: 240,
      stage: 'live_model',
    });
    mockReadyCaptureWorklet();

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantı testi' }));

    expect(testAudioCaptureWorklet).toHaveBeenCalledTimes(1);
    expect(testLiveSttStreamConnection).toHaveBeenCalledWith('ws://127.0.0.1:18220/ws/stream');
    expect(await screen.findByText('Ses işleyici hazır. · 12 ms')).toBeInTheDocument();
    expect(await screen.findByText('Direct STT stream hazir. · 240 ms')).toBeInTheDocument();
  });

  it('direct STT hazir degilse uyari gosterir ama mikrofon kaydini baslatir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(testLiveSttStreamConnection).mockResolvedValue({
      ok: false,
      message: 'Direct STT baglanti hatasi.',
      elapsedMs: 500,
      stage: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantı testi' }));

    expect(await screen.findByText('Direct STT baglanti hatasi. · 500 ms')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Direct STT baglanti hatasi. · 500 ms')).not.toBeInTheDocument();
    expect(screen.getByText('Direct STT kayıt sırasında bağlanacak...')).toBeInTheDocument();
    expect(startRecording).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'desktop-1',
      expect.objectContaining({
        liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      }),
    );
    expect(testLiveSttStreamConnection).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Kayıt başlatılamadı:/)).not.toBeInTheDocument();
  });

  it('kayit baslatirken direct STT preflight retry beklemeden mikrofona gecer', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(testLiveSttStreamConnection)
      .mockResolvedValueOnce({
        ok: false,
        message: 'Direct STT baglanti hatasi.',
        elapsedMs: 2,
        stage: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Direct STT stream hazir.',
        elapsedMs: 70,
        stage: 'live_model',
      });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)'),
    ).toBeInTheDocument();
    expect(testLiveSttStreamConnection).not.toHaveBeenCalled();
    expect(screen.getByText('Direct STT kayıt sırasında bağlanacak...')).toBeInTheDocument();
    expect(startRecording).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'desktop-1',
      expect.objectContaining({
        liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      }),
    );
    expect(screen.queryByText(/Kayıt başlatılamadı:/)).not.toBeInTheDocument();
  });

  it('direct STT baglanti testi toparlaninca eski baglanti hatasini temizler', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(testLiveSttStreamConnection)
      .mockResolvedValueOnce({
        ok: false,
        message: 'Direct STT baglanti hatasi.',
        elapsedMs: 500,
        stage: null,
      })
      .mockResolvedValueOnce({
        ok: false,
        message: 'Direct STT baglanti hatasi.',
        elapsedMs: 500,
        stage: null,
      })
      .mockResolvedValueOnce({
        ok: false,
        message: 'Direct STT baglanti hatasi.',
        elapsedMs: 500,
        stage: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Direct STT stream hazir.',
        elapsedMs: 80,
        stage: 'live_model',
      });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantı testi' }));
    expect(await screen.findByText('Direct STT baglanti hatasi. · 500 ms')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Bağlantı testi' }));

    expect(await screen.findByText('Direct STT stream hazir. · 80 ms')).toBeInTheDocument();
    expect(screen.queryByText('Direct STT baglanti hatasi. · 500 ms')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
  });

  it('eszamanli UI + tray stop tek finalizasyon uretir (re-entrancy guard)', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    mockReadyCaptureWorklet();
    let resolveStop: () => void = () => {};
    const stopMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-STOP-1',
      transcriptSessionId: 'SES-STOP-1',
      hasLoopback: false,
      stop: stopMock,
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-STOP-1)'),
    ).toBeInTheDocument();

    const stopButton = screen.getByRole('button', { name: 'Bitir' });
    fireEvent.click(stopButton);
    fireEvent.click(stopButton);
    trayStopHandler?.();

    // İlk stop hâlâ upload/finish bekliyor: erken "tamamlandı" ilan edilmemeli.
    expect(screen.queryByText('Kayıt tamamlandı, gönderildi.')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Bitiriliyor...' })).toBeDisabled();

    resolveStop();
    expect(await screen.findByText('Kayıt tamamlandı, gönderildi.')).toBeInTheDocument();
    expect(stopMock).toHaveBeenCalledTimes(1);
    const trayMock = vi.mocked(window.electronAPI!.tray.setRecordingActive);
    const deactivations = trayMock.mock.calls.filter(([active]) => active === false);
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0]).toEqual([false, 'finished', undefined]);
  });

  it('tray duraklat/sürdür kaydı pause/resume eder ve durumu yansıtır (#37)', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    mockReadyCaptureWorklet();
    let pausedFlag = false;
    const pauseMock = vi.fn(() => {
      pausedFlag = true;
    });
    const resumeMock = vi.fn(() => {
      pausedFlag = false;
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-PAUSE-1',
      transcriptSessionId: 'SES-PAUSE-1',
      hasLoopback: false,
      stop: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      pause: pauseMock,
      resume: resumeMock,
      isPaused: vi.fn(() => pausedFlag),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-PAUSE-1)'),
    ).toBeInTheDocument();

    const trayPausedMock = vi.mocked(window.electronAPI!.tray.setPaused);

    // Tray "Kaydı Duraklat" — benzersiz "Sürdür" butonu paused durumu gösterir.
    act(() => trayPauseHandler?.());
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(trayPausedMock).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole('button', { name: 'Sürdür' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Duraklat' })).not.toBeInTheDocument();

    // Tray "Kaydı Sürdür" — "Duraklat" butonu geri döner.
    act(() => trayResumeHandler?.());
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(trayPausedMock).toHaveBeenLastCalledWith(false);
    expect(await screen.findByRole('button', { name: 'Duraklat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sürdür' })).not.toBeInTheDocument();
  });

  it('stop hatasi tray outcome olarak error tasir — sahte tamamlandi bildirimi yok', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-STOP-2',
      transcriptSessionId: 'SES-STOP-2',
      hasLoopback: false,
      stop: vi.fn().mockRejectedValue(new Error('upload finish patladi')),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-STOP-2)'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Bitir' }));

    const errorNodes = await screen.findAllByText(/Kayıt durdurulamadı: upload finish patladi/);
    expect(errorNodes.length).toBeGreaterThan(0);
    const trayMock = vi.mocked(window.electronAPI!.tray.setRecordingActive);
    const deactivations = trayMock.mock.calls.filter(([active]) => active === false);
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0][1]).toBe('error');
    expect(String(deactivations[0][2])).toContain('Kayıt durdurulamadı');
  });

  it('canli transkript drain degrade olursa kalici kaydi basari diye gizlemez', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    mockReadyCaptureWorklet();
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-DEGRADED-1',
      transcriptSessionId: 'SES-DEGRADED-1',
      hasLoopback: false,
      stop: vi.fn().mockResolvedValue(undefined),
      getStopResult: vi.fn(() => ({
        gatewayLive: {
          state: 'degraded' as const,
          reason: 'timeout' as const,
          acknowledged: false,
        },
        liveStt: null,
      })),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-DEGRADED-1)');
    fireEvent.click(screen.getByRole('button', { name: 'Bitir' }));

    expect(
      (await screen.findAllByText(/Kayıt gönderildi; canlı transkriptin son onayı alınamadı/))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Kayıt tamamlandı, gönderildi.')).not.toBeInTheDocument();
    const trayMock = vi.mocked(window.electronAPI!.tray.setRecordingActive);
    await waitFor(() =>
      expect(trayMock).toHaveBeenCalledWith(
        false,
        'degraded',
        expect.stringContaining('Kalıcı sonuç işleniyor'),
      ),
    );
  });

  it('kayit baslatma cevapsiz kalirsa butonu serbest birakir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(startRecording).mockReturnValue(new Promise<never>(() => undefined));

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startRecording).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'desktop-1',
      expect.objectContaining({
        liveSttStreamUrl: null,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(515_000);
      await Promise.resolve();
    });
    vi.useRealTimers();

    const timeoutErrors = screen.getAllByText(
      'Kayıt başlatılamadı: Recorder başlatma 515 sn içinde yanıt vermedi; izin/gateway zinciri kontrol edilmeli.',
    );
    expect(timeoutErrors.length).toBeGreaterThan(0);
    expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
  });

  it('mikrofon izni reddedildiyse ses yakalamayi baslatmaz', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.audio.permissionStatus).mockResolvedValue({
      status: 'denied',
      granted: false,
      canRequest: false,
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    const permissionErrors = await screen.findAllByText(
      'Kayıt başlatılamadı: Mikrofon izni verilmedi. Sistem Ayarları > Gizlilik ve Güvenlik > Mikrofon bölümünden Meeting Intelligence erişimini açın.',
    );
    expect(permissionErrors.length).toBeGreaterThan(0);
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('es zamanli kayit baslatma olaylarini tek mikrofon izin isteginde birlestirir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.audio.permissionStatus).mockResolvedValue({
      status: 'not-determined',
      granted: false,
      canRequest: true,
    });
    let resolvePermission: (value: {
      status: 'granted';
      granted: true;
      canRequest: false;
    }) => void = () => {
      throw new Error('permission resolver was not initialized');
    };
    vi.mocked(window.electronAPI!.audio.requestPermission).mockReturnValue(
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    const consentButton = screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' });
    fireEvent.click(consentButton);
    fireEvent.click(consentButton);

    await waitFor(() =>
      expect(window.electronAPI!.audio.requestPermission).toHaveBeenCalledTimes(1),
    );
    expect(startRecording).not.toHaveBeenCalled();

    resolvePermission({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
  });

  it('gateway transcript eventlerini canli transcript zaman cizelgesine yazar', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });
    mockReadyCaptureWorklet();
    mockReadyLiveSttStream();

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)'),
    ).toBeInTheDocument();
    expect(transcriptEventHandler).not.toBeNull();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820000000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 0,
        chunkStartedAtMs: 1781820000000,
        text: 'merhaba halil',
        textLength: 13,
        status: 'DRAFT',
      });
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Satırlar' }));
    expect(await screen.findByText('merhaba halil')).toBeInTheDocument();
    expect(screen.getByText('Taslak')).toBeInTheDocument();
  });

  it('gateway window eventleri ayni canli satiri gunceller', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)');

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820000000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 599,
        chunkStartedAtMs: 1781820000400,
        windowSeq: 0,
        firstChunkSeq: 0,
        lastChunkSeq: 599,
        windowStartedAtMs: 1781820000000,
        windowEndedAtMs: 1781820060000,
        audioDurationMs: 60_000,
        flushReason: 'partial',
        text: 'Merhaba',
        textLength: 7,
        status: 'DRAFT',
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Satırlar' }));
    expect(await screen.findByText('Merhaba')).toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820001000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 599,
        chunkStartedAtMs: 1781820000800,
        windowSeq: 0,
        firstChunkSeq: 0,
        lastChunkSeq: 599,
        windowStartedAtMs: 1781820000000,
        windowEndedAtMs: 1781820060000,
        audioDurationMs: 60_000,
        flushReason: 'partial',
        text: 'Merhaba nasılsın',
        textLength: 16,
        status: 'DRAFT',
      });
    });

    expect(await screen.findByText('Merhaba nasılsın')).toBeInTheDocument();
    expect(screen.queryByText('Merhaba')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820060100-1',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 9,
        chunkStartedAtMs: 1781820060100,
        windowSeq: 1,
        firstChunkSeq: 9,
        lastChunkSeq: 9,
        windowStartedAtMs: 1781820060100,
        windowEndedAtMs: 1781820061000,
        audioDurationMs: 900,
        flushReason: 'partial',
        text: 'Gündeme devam',
        textLength: 14,
        status: 'FINAL',
      });
    });

    expect(await screen.findByText('Gündeme devam')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('2 paragraf')).toBeInTheDocument();
  });

  it('yetkili Gateway canlı eventini direct URL olmadan görünür ve aktif yapar', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      gatewayLiveStreamEnabled: true,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)');
    expect(vi.mocked(startRecording).mock.calls[0]?.[2]?.liveSttStreamUrl).toBeNull();
    expect(screen.getByText('Gateway canlı bekleniyor')).toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: 'live-SES-1-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 0,
        chunkStartedAtMs: 1781820000000,
        text: 'Gateway canlı metni',
        textLength: 20,
        status: 'DRAFT',
        correlationId: 'gateway-live',
      });
    });

    expect(await screen.findByText('Gateway canlı metni')).toBeInTheDocument();
    expect(screen.getByText('Gateway canlı')).toBeInTheDocument();
    expect(screen.getByText('Kelime akışı aktif')).toBeInTheDocument();
  });

  it('direct live STT partial eventleri ayni satiri kelime kelime gunceller', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)');
    const options = vi.mocked(startRecording).mock.calls[0]?.[2];
    expect(options?.liveSttStreamUrl).toBe('ws://127.0.0.1:18220/ws/stream');
    expect(screen.getByText('Direct stream bekleniyor')).toBeInTheDocument();
    expect(screen.getByText('Bağlantı kuruluyor')).toBeInTheDocument();

    act(() => {
      options?.onLiveStreamReady?.();
    });
    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Bağlı, ses bekleniyor')).toBeInTheDocument();

    act(() => {
      options?.onAudioActivity?.({ rms: 0.02, capturedAtMs: 1781820000000, speechRatio: null });
    });
    expect(screen.getByText('Ses alınıyor, kelime bekleniyor')).toBeInTheDocument();
    expect(screen.getByText('Alınıyor · RMS 0.020')).toBeInTheDocument();
    expect(
      screen.getByText(
        new Date(1781820000000).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      ),
    ).toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820000000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 0,
        chunkStartedAtMs: 1781820000000,
        text: 'gateway cümle paketi',
        textLength: 19,
        status: 'DRAFT',
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Satırlar' }));

    expect(screen.getByText('gateway cümle paketi')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);

    act(() => {
      options?.onLiveTranscriptEvent?.({
        id: 'stream:0',
        startedAtMs: 1781820000000,
        text: 'Merhaba',
        status: 'draft',
      });
    });
    expect(await screen.findByText('Merhaba')).toBeInTheDocument();
    expect(screen.getByText('gateway cümle paketi')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);

    act(() => {
      options?.onLiveTranscriptEvent?.({
        id: 'stream:0',
        startedAtMs: 1781820000000,
        text: 'Merhaba nasılsın',
        status: 'draft',
      });
    });
    expect(await screen.findByText('Merhaba nasılsın')).toBeInTheDocument();
    expect(screen.queryByText('Merhaba')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820000000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 0,
        chunkStartedAtMs: 1781820000000,
        text: 'gateway cümle paketi',
        textLength: 19,
        status: 'DRAFT',
      });
    });

    expect(screen.getByText('gateway cümle paketi')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('passes trusted current meeting-title context to the direct STT stream', async () => {
    const meetingId = '22222222-2222-4222-8222-222222222222';
    installElectronApiMock({
      meetingId,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(window.electronAPI!.meeting.listRecent).mockResolvedValue({
      meetings: [recentMeeting(meetingId, 'Zeynep Akkılıç - Halil Koçoğlu Faz 24')],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-CONTEXT',
      transcriptSessionId: 'SES-CONTEXT',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    await screen.findByText(/Zeynep Akkılıç - Halil Koçoğlu Faz 24/);
    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-CONTEXT)');
    expect(vi.mocked(startRecording).mock.calls[0]?.[2]?.liveSttContextTerms).toEqual([
      'Zeynep Akkılıç',
      'Zeynep',
      'Akkılıç',
      'Halil Koçoğlu',
      'Halil',
      'Koçoğlu',
    ]);
  });

  it('direct stream seyrek kaldiginda gateway final fallback satirini kabul eder', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)');
    const options = vi.mocked(startRecording).mock.calls[0]?.[2];

    act(() => {
      options?.onLiveTranscriptEvent?.({
        id: 'stream:0',
        startedAtMs: 1781820000000,
        text: 'Merhaba sesim geliyor mu',
        status: 'draft',
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Satırlar' }));
    expect(await screen.findByText('Merhaba sesim geliyor mu')).toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820001000-draft',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 4,
        chunkStartedAtMs: 1781820001000,
        text: 'gateway taslak atlanmalı',
        textLength: 23,
        status: 'DRAFT',
      });
    });
    expect(screen.queryByText('gateway taslak atlanmalı')).not.toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820002000-final',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 8,
        chunkStartedAtMs: 1781820002000,
        text: 'Merhaba sesim geliyor mu bir sürü eksik var yine. Veriler gelmiyor sanki.',
        textLength: 74,
        status: 'FINAL',
      });
    });

    expect(
      await screen.findByText(
        'Merhaba sesim geliyor mu bir sürü eksik var yine. Veriler gelmiyor sanki.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Final')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820003000-final-replay',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 12,
        chunkStartedAtMs: 1781820003000,
        text: 'Merhaba sesim geliyor mu bir sürü eksik var yine. Veriler gelmiyor sanki.',
        textLength: 74,
        status: 'FINAL',
      });
    });

    expect(screen.getAllByRole('article')).toHaveLength(2);

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820004000-revised',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 16,
        chunkStartedAtMs: 1781820004000,
        text: 'Revize gateway final satırı da fallback olarak kabul edilir.',
        textLength: 61,
        status: 'REVISED',
      });
    });

    expect(
      await screen.findByText('Revize gateway final satırı da fallback olarak kabul edilir.'),
    ).toBeInTheDocument();
    const turns = screen.getAllByRole('article');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toHaveTextContent(
      'Merhaba sesim geliyor mu bir sürü eksik var yine. Veriler gelmiyor sanki.',
    );
    expect(turns[1]).toHaveTextContent(
      'Revize gateway final satırı da fallback olarak kabul edilir.',
    );
  });

  it('direct live STT ilk partial eventini recorder session hazirlanana kadar tamponlar', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(startRecording).mockImplementation(async (_meetingId, _deviceId, options) => {
      options?.onLiveTranscriptEvent?.({
        id: 'stream:0',
        startedAtMs: 1781820000000,
        text: 'Merhaba',
        status: 'draft',
      });
      return {
        sessionId: 'SES-1',
        transcriptSessionId: 'SES-1',
        hasLoopback: false,
        stop: vi.fn(),
        onError: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        isPaused: vi.fn(() => false),
      };
    });
    mockReadyCaptureWorklet();
    mockReadyLiveSttStream();

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Merhaba')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('gateway baslangici direct-STT hatasi verirse kaydi direct stream modunda baslatir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      liveSttStreamReason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'LOCAL-1',
      transcriptSessionId: 'LOCAL-1',
      hasLoopback: false,
      gatewayActive: false,
      gatewayError: 'Direct STT baglanti hatasi',
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, direct stream, oturum LOCAL-1)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Kayıt başlatılamadı/)).not.toBeInTheDocument();
  });

  it('client saati serverdan ilerideyse transcript satirinda server zamanini kullanir', async () => {
    installElectronApiMock({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-1',
      transcriptSessionId: 'SES-1',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-1)');

    const receivedAtMs = 1781820000000;
    const futureClientStartedAtMs = receivedAtMs + 95_000;
    const serverClockLabel = new Date(receivedAtMs).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const clientClockLabel = new Date(futureClientStartedAtMs).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820000000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 0,
        chunkStartedAtMs: futureClientStartedAtMs,
        receivedAtMs,
        text: 'clock skew segment',
        textLength: 18,
        status: 'DRAFT',
      });
    });

    expect(await screen.findByText('clock skew segment')).toBeInTheDocument();
    expect(screen.getAllByText(serverClockLabel).length).toBeGreaterThan(0);
    expect(screen.queryByText(clientClockLabel)).not.toBeInTheDocument();
  });
});

describe('App canonical Meeting Intelligence read', () => {
  it('keeps a bounded canonical follow-up open beyond the former thirty-second window', () => {
    const totalDelayMs = CANONICAL_RESULT_POLL_DELAYS_MS.reduce<number>(
      (total, delay) => total + delay,
      0,
    );

    expect(totalDelayMs).toBeGreaterThan(30_500);
    expect(totalDelayMs).toBeLessThanOrEqual(301_000);
    expect(CANONICAL_RESULT_POLL_DELAYS_MS).toContain(60_000);
    expect(CANONICAL_RESULT_FOLLOW_UP_TIMEOUT_MS).toBe(300_000);
  });

  it('uses bounded jittered exponential delay for durable revalidation', () => {
    expect(canonicalResultDurableRetryDelayMs(0, 0.5)).toBe(
      CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS,
    );
    expect(canonicalResultDurableRetryDelayMs(1, 0.5)).toBe(
      CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS * 2,
    );
    expect(canonicalResultDurableRetryDelayMs(20, 0.5)).toBe(15 * 60_000);
    expect(canonicalResultDurableRetryDelayMs(0, 0)).toBe(
      CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS * 0.8,
    );
    expect(canonicalResultDurableRetryDelayMs(0, 1)).toBe(
      CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS * 1.2,
    );
  });

  it('recovers a canonical result after the bounded five-minute follow-up has expired', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let readCount = 0;
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockImplementation(async () => {
      readCount += 1;
      return readCount >= 13
        ? { status: 'ready', result: canonicalMeetingResult() }
        : { status: 'not_ready' };
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Hazırlanıyor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sonucu yenile' }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(CANONICAL_RESULT_FOLLOW_UP_TIMEOUT_MS);
    });

    expect(screen.queryByText('Kalıcı toplantı özeti yüklendi.')).not.toBeInTheDocument();
    expect(readCount).toBe(12);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS);
    });

    expect(screen.getByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(readCount).toBe(13);
  });

  it('revalidates the selected meeting on remount and login', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'ready', result: canonicalMeetingResult() });

    const firstMount = render(<App />);
    expect(await screen.findByText('Hazırlanıyor')).toBeInTheDocument();
    firstMount.unmount();

    render(<App />);
    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(2);

    cleanup();
    vi.mocked(window.electronAPI!.auth.status).mockResolvedValue({
      loggedIn: false,
      claims: null,
    });
    vi.mocked(window.electronAPI!.auth.login).mockResolvedValue({ loggedIn: true, claims: null });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockClear()
      .mockResolvedValue({ status: 'ready', result: canonicalMeetingResult() });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Giriş' })).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Giriş' }));
    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);
  });

  it('revalidates immediately when the network comes back online', async () => {
    let online = false;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockResolvedValue({
      status: 'ready',
      result: canonicalMeetingResult(),
    });

    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cihaz çevrimdışı');
    expect(screen.getByText('Geçici bağlantı hatası')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'bağlantı ve pencere yeniden etkin olduğunda otomatik kontrol sürecek',
    );
    expect(window.electronAPI?.meeting.getIntelligenceResult).not.toHaveBeenCalled();

    online = true;
    act(() => window.dispatchEvent(new Event('online')));

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);
  });

  it('revalidates immediately when the window becomes visible again', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'ready', result: canonicalMeetingResult() });

    render(<App />);
    expect(await screen.findByText('Hazırlanıyor')).toBeInTheDocument();
    visibilityState = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    visibilityState = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(2);
  });

  it('lets the user refresh a not-ready canonical result immediately', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'ready', result: canonicalMeetingResult() });

    render(<App />);
    expect(await screen.findByText('Hazırlanıyor')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sonucu yenile' }));

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(2);
  });

  it('does not auto-retry terminal authorization errors', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockRejectedValue(
      new Error('readMeetingIntelligenceResult failed: 403 code=MEETING_FORBIDDEN retryable=false'),
    );

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('İstek hatası')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('otomatik yeniden denenmeyecek');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);
  });

  it('cancels a stale canonical response when the user switches meetings', async () => {
    const firstMeetingId = '22222222-2222-4222-8222-222222222222';
    const selectedMeetingResult = canonicalMeetingResult({
      meetingId: CANONICAL_MEETING_ID,
      summary: 'Seçilen toplantının kalıcı sonucu.',
    });
    installElectronApiMock({
      meetingId: firstMeetingId,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.listRecent).mockResolvedValue({
      meetings: [
        recentMeeting(firstMeetingId, 'İlk toplantı'),
        recentMeeting(CANONICAL_MEETING_ID, 'Seçilen toplantı'),
      ],
      page: 0,
      size: 20,
      totalElements: 2,
      totalPages: 1,
    });
    let resolveFirstMeeting: (outcome: MeetingIntelligenceReadOutcome) => void = () => undefined;
    const firstMeetingRead = new Promise<MeetingIntelligenceReadOutcome>((resolve) => {
      resolveFirstMeeting = resolve;
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockImplementation(
      async ({ meetingId }) => {
        if (meetingId === firstMeetingId) {
          return firstMeetingRead;
        }
        return { status: 'ready', result: selectedMeetingResult };
      },
    );

    render(<App />);
    const picker = await screen.findByRole('combobox', { name: 'Görüntülenecek toplantı' });
    await waitFor(() => {
      expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledWith({
        meetingId: firstMeetingId,
      });
    });
    await userEvent.selectOptions(picker, CANONICAL_MEETING_ID);
    expect(await screen.findByText('Seçilen toplantının kalıcı sonucu.')).toBeInTheDocument();

    await act(async () => {
      resolveFirstMeeting({
        status: 'ready',
        result: canonicalMeetingResult({
          meetingId: firstMeetingId,
          summary: 'Geç kalan ilk toplantı sonucu.',
        }),
      });
      await Promise.resolve();
    });

    expect(screen.getByText('Seçilen toplantının kalıcı sonucu.')).toBeInTheDocument();
    expect(screen.queryByText('Geç kalan ilk toplantı sonucu.')).not.toBeInTheDocument();
  });

  it('cancels durable canonical timers when recording starts', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockResolvedValue({
      status: 'not_ready',
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-CANCEL-DURABLE',
      transcriptSessionId: 'SES-CANCEL-DURABLE',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Kayıt başladı .*SES-CANCEL-DURABLE/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);
  });

  it('cleans up the durable retry and request timers on unmount', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockResolvedValue({
      status: 'not_ready',
    });

    const mounted = render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a stalled canonical bridge read within the per-request deadline', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockReturnValue(
      new Promise(() => undefined),
    );
    vi.useFakeTimers();

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledWith({
      meetingId: CANONICAL_MEETING_ID,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_RESULT_REQUEST_TIMEOUT_MS);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Kalıcı toplantı çıktısı isteği zaman aşımına uğradı',
    );
  });

  it('hydrates the product panel from the one persisted canonical snapshot', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockResolvedValue({
      status: 'ready',
      result: canonicalMeetingResult(),
    });

    render(<App />);

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(screen.getByText('Canonical read kullanılacak')).toBeInTheDocument();
    expect(screen.getByText('Kalıcı snapshot')).toBeInTheDocument();
    expect(screen.getByText('Kalıcı sonuç')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledWith({
      meetingId: CANONICAL_MEETING_ID,
    });
  });

  it('exposes a failed canonical read and recovers through the retry action', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockRejectedValueOnce(new Error('network=UND_ERR_SOCKET'))
      .mockResolvedValue({ status: 'ready', result: canonicalMeetingResult() });

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('network=UND_ERR_SOCKET');
    await userEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(2);
  });

  it('durably retries a recoverable canonical read error without manual action', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockRejectedValueOnce(new Error('network=UND_ERR_SOCKET'))
      .mockResolvedValue({ status: 'ready', result: canonicalMeetingResult() });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('network=UND_ERR_SOCKET');
    expect(screen.getByText('Geçici bağlantı hatası')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS);
    });

    expect(screen.getByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(2);
  });

  it('cancels durable canonical retry when the user logs out', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockResolvedValue({
      status: 'not_ready',
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Çıkış' }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS * 2);
    });

    expect(window.electronAPI?.auth.logout).toHaveBeenCalledTimes(1);
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(1);
  });

  it('keeps the pre-recording run as baseline and waits for a replacement snapshot', async () => {
    installElectronApiMock({
      meetingId: CANONICAL_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    const previous = canonicalMeetingResult();
    const replacement = {
      ...canonicalMeetingResult(),
      analysisRunId: '66666666-6666-4666-8666-666666666666',
      sessionId: 'CANONICAL-INTERNAL-SESSION',
      summary: 'Yeni kayıt için kalıcı toplantı özeti.',
      summary_citations: [
        {
          ...canonicalMeetingResult().summary_citations[0],
          claim: 'Yeni kayıt için kalıcı toplantı özeti.',
        },
      ],
      generatedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockResolvedValueOnce({ status: 'ready', result: previous })
      .mockResolvedValueOnce({ status: 'ready', result: previous })
      .mockResolvedValue({ status: 'ready', result: replacement });
    vi.mocked(window.electronAPI!.meeting.analyze).mockResolvedValue({});
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-REANALYZE',
      transcriptSessionId: 'SES-REANALYZE',
      hasLoopback: false,
      stop: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));
    expect(
      await screen.findByText('Kayıt başladı (yalnız mikrofon, oturum SES-REANALYZE)'),
    ).toBeInTheDocument();

    const firstSegmentAtMs = Date.now();
    const secondSegmentAtMs = firstSegmentAtMs + 16_000;
    act(() => {
      transcriptEventHandler?.({
        eventId: 'reanalyze-final-1',
        sessionId: 'SES-REANALYZE',
        meetingId: CANONICAL_MEETING_ID,
        chunkSeq: 0,
        chunkStartedAtMs: firstSegmentAtMs,
        receivedAtMs: firstSegmentAtMs,
        text: 'Bu kayıt yeni analiz koşusunun başlangıç bölümünü güvenilir biçimde doğrulayan anlamlı test metnidir.',
        textLength: 92,
        status: 'FINAL',
      });
      transcriptEventHandler?.({
        eventId: 'reanalyze-final-2',
        sessionId: 'SES-REANALYZE',
        meetingId: CANONICAL_MEETING_ID,
        chunkSeq: 1,
        chunkStartedAtMs: secondSegmentAtMs,
        receivedAtMs: secondSegmentAtMs,
        text: 'Kalıcı ürün yüzeyi yeni sonucu beklemeli ve daha önceki analiz sonucu yeniden gösterilmemelidir.',
        textLength: 90,
        status: 'FINAL',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bitir' }));

    expect(
      await screen.findByText('Yeni kayıt için kalıcı toplantı özeti.', {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    // gitops#3434: Bitir no longer fires the legacy /analyze (always 422 in
    // durable mode); the result comes from polling the durable pipeline.
    expect(window.electronAPI?.meeting.analyze).not.toHaveBeenCalled();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Kalıcı toplantı özeti yüklendi.')).not.toBeInTheDocument();
  });
});

describe('App recent meeting result navigation', () => {
  const RECORDER_MEETING_ID = '22222222-2222-4222-8222-222222222222';

  it('binds a selected meeting as the recorder target when startup has no target', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason:
        'RECORDER_MEETING_ID tanimli degil; kayit icin meeting-service MeetingResponse.id gerekli.',
    });
    vi.mocked(window.electronAPI!.meeting.listRecent).mockResolvedValue({
      meetings: [recentMeeting(CANONICAL_MEETING_ID, 'Planlı toplantı')],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    });
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-SELECTED-TARGET',
      transcriptSessionId: 'SES-SELECTED-TARGET',
      sttProvider: 'speechmatics',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    const picker = await screen.findByRole('combobox', { name: 'Görüntülenecek toplantı' });
    await screen.findByRole('option', { name: /Planlı toplantı/ });
    await userEvent.selectOptions(picker, CANONICAL_MEETING_ID);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Transkripsiyon sağlayıcısı' }),
      'speechmatics',
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Dengeli' }));

    const recordButton = screen.getByRole('button', { name: 'Kaydet' });
    expect(recordButton).toBeEnabled();
    await userEvent.click(recordButton);
    await userEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await waitFor(() => {
      expect(startRecording).toHaveBeenCalledWith(
        CANONICAL_MEETING_ID,
        'desktop-1',
        expect.objectContaining({
          sttProvider: 'speechmatics',
          transcriptionMode: 'balanced',
        }),
      );
    });
  });

  it('opens a persisted historical result without changing the recorder target', async () => {
    installElectronApiMock({
      meetingId: RECORDER_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    vi.mocked(window.electronAPI!.meeting.listRecent).mockResolvedValue({
      meetings: [
        recentMeeting(CANONICAL_MEETING_ID, 'Kalıcı ürün değerlendirmesi'),
        recentMeeting(RECORDER_MEETING_ID, 'Aktif kayıt toplantısı'),
      ],
      page: 0,
      size: 20,
      totalElements: 2,
      totalPages: 1,
    });
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult).mockImplementation(
      async ({ meetingId }) =>
        meetingId === CANONICAL_MEETING_ID
          ? { status: 'ready', result: canonicalMeetingResult() }
          : { status: 'not_ready' },
    );
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-RECORDER-TARGET',
      transcriptSessionId: 'SES-RECORDER-TARGET',
      hasLoopback: false,
      stop: vi.fn(),
      onError: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(() => false),
    });

    render(<App />);

    const picker = await screen.findByRole('combobox', { name: 'Görüntülenecek toplantı' });
    await screen.findByRole('option', { name: /Kalıcı ürün değerlendirmesi/ });
    await userEvent.selectOptions(picker, CANONICAL_MEETING_ID);

    expect(await screen.findByText('Kalıcı toplantı özeti yüklendi.')).toBeInTheDocument();
    expect(screen.getByText('Transkript akışı bekleniyor')).toBeInTheDocument();
    expect(
      screen.getByText('Geçmiş çıktı açık; aktif kayıt hedefi değişmedi.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await waitFor(() => {
      expect(startRecording).toHaveBeenCalledWith(
        RECORDER_MEETING_ID,
        'desktop-1',
        expect.any(Object),
      );
    });
    expect(picker).toBeDisabled();
    expect(
      screen.getByText('Kayıt veya sonuç hazırlama sürerken çıktı seçimi kilitli.'),
    ).toBeInTheDocument();
  });

  it('does not let a late refresh response overwrite the user viewer selection', async () => {
    installElectronApiMock({
      meetingId: RECORDER_MEETING_ID,
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });
    let resolveRefresh: (
      page: Awaited<ReturnType<NonNullable<Window['electronAPI']>['meeting']['listRecent']>>,
    ) => void = () => undefined;
    const pendingRefresh = new Promise<
      Awaited<ReturnType<NonNullable<Window['electronAPI']>['meeting']['listRecent']>>
    >((resolve) => {
      resolveRefresh = resolve;
    });
    vi.mocked(window.electronAPI!.meeting.listRecent)
      .mockResolvedValueOnce({
        meetings: [recentMeeting(CANONICAL_MEETING_ID, 'Seçilen toplantı')],
        page: 0,
        size: 20,
        totalElements: 1,
        totalPages: 1,
      })
      .mockReturnValueOnce(pendingRefresh);

    render(<App />);

    const picker = await screen.findByRole('combobox', { name: 'Görüntülenecek toplantı' });
    await screen.findByRole('option', { name: /Seçilen toplantı/ });
    await userEvent.selectOptions(picker, CANONICAL_MEETING_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Toplantıları yenile' }));
    resolveRefresh({
      meetings: [recentMeeting(RECORDER_MEETING_ID, 'Başka toplantı')],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    });

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLSelectElement>('combobox', { name: 'Görüntülenecek toplantı' }).value,
      ).toBe(CANONICAL_MEETING_ID);
    });
  });
});
