// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('./audio/capture', () => ({
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
import App from './App';

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

function canonicalMeetingResult() {
  return {
    analysisRunId: '55555555-5555-4555-8555-555555555555',
    meetingId: CANONICAL_MEETING_ID,
    sessionId: 'SES-CANONICAL',
    schema_version: '5-adr0043',
    model: 'qwen',
    backend: 'ollama',
    summary: 'Kalıcı toplantı özeti yüklendi.',
    summaryGroundingStatus: 'verified',
    summary_citations: [
      {
        claim: 'Kalıcı toplantı özeti yüklendi.',
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
    generatedAt: '2026-07-11T20:00:00.000Z',
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
  liveSttStreamUrl?: string | null;
  liveSttStreamReason?: string | null;
}): void {
  transcriptEventHandler = null;
  trayStopHandler = null;
  trayPauseHandler = null;
  trayResumeHandler = null;
  window.electronAPI = {
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
    },
    audio: {
      recorderConfig: vi.fn().mockResolvedValue({
        liveSttStreamUrl: null,
        liveSttStreamReason: null,
        ...recorderConfig,
      }),
      permissionStatus: vi.fn(),
      prepareCapture: vi.fn(),
      cancelCapture: vi.fn(),
      consent: vi.fn(),
      start: vi.fn(),
      sendChunk: vi.fn(),
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
  it('canonical meetingId yoksa meeting contract oluşturma aksiyonunu açar', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });

    render(<App />);

    expect(
      await screen.findByText('Giriş yapıldı. Kayıt için canonical meetingId bekleniyor.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Beklemede')).toHaveLength(2);
    expect(screen.queryByText('Blokeli')).not.toBeInTheDocument();
    expect(screen.queryByText('RECORDER_MEETING_ID tanimli degil.')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Meeting intelligence için canonical meetingId yok.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Toplantı çıktısı bekleniyor')).toBeInTheDocument();

    const button = screen.getByRole('button', {
      name: 'Meeting contract oluştur',
    });
    expect(button).toBeEnabled();
  });

  it('meeting-service contract olusturunca recorder config hazir olur', async () => {
    installElectronApiMock({
      meetingId: null,
      deviceId: 'desktop-1',
      ready: false,
      reason: 'RECORDER_MEETING_ID tanimli degil.',
    });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Meeting contract oluştur' }));

    await waitFor(() => {
      expect(window.electronAPI?.meeting.createContract).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Faz 24 desktop recording'),
          description: 'Faz 24 desktop recorder live contract.',
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

    const button = await screen.findByRole('button', { name: 'Meeting contract oluştur' });
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
      await vi.advanceTimersByTimeAsync(45_000);
      await Promise.resolve();
    });
    vi.useRealTimers();

    const timeoutErrors = screen.getAllByText(
      'Kayıt başlatılamadı: Recorder başlatma 45 sn içinde yanıt vermedi; izin/gateway zinciri kontrol edilmeli.',
    );
    expect(timeoutErrors.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
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
        chunkSeq: 4,
        chunkStartedAtMs: 1781820000400,
        windowSeq: 0,
        firstChunkSeq: 0,
        lastChunkSeq: 4,
        windowStartedAtMs: 1781820000000,
        windowEndedAtMs: 1781820000500,
        audioDurationMs: 500,
        flushReason: 'partial',
        text: 'Merhaba',
        textLength: 7,
        status: 'DRAFT',
      });
    });
    expect(await screen.findByText('Merhaba')).toBeInTheDocument();

    act(() => {
      transcriptEventHandler?.({
        eventId: '1781820001000-0',
        sessionId: 'SES-1',
        meetingId: '22222222-2222-4222-8222-222222222222',
        chunkSeq: 8,
        chunkStartedAtMs: 1781820000800,
        windowSeq: 0,
        firstChunkSeq: 0,
        lastChunkSeq: 8,
        windowStartedAtMs: 1781820000000,
        windowEndedAtMs: 1781820001000,
        audioDurationMs: 1000,
        flushReason: 'partial',
        text: 'Merhaba nasılsın',
        textLength: 16,
        status: 'DRAFT',
      });
    });

    expect(await screen.findByText('Merhaba nasılsın')).toBeInTheDocument();
    expect(screen.queryByText('Merhaba')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
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
      options?.onAudioActivity?.({ rms: 0.02, capturedAtMs: 1781820000000 });
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
    expect(screen.getAllByRole('article')).toHaveLength(3);
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
      summary: 'Yeni kayıt için kalıcı toplantı özeti.',
      summary_citations: [
        {
          ...canonicalMeetingResult().summary_citations[0],
          claim: 'Yeni kayıt için kalıcı toplantı özeti.',
        },
      ],
      generatedAt: '2026-07-11T20:01:00.000Z',
    };
    vi.mocked(window.electronAPI!.meeting.getIntelligenceResult)
      .mockResolvedValueOnce({ status: 'ready', result: previous })
      .mockResolvedValueOnce({ status: 'ready', result: previous })
      .mockResolvedValue({ status: 'ready', result: replacement });
    vi.mocked(window.electronAPI!.meeting.analyze).mockResolvedValue({});
    vi.mocked(startRecording).mockResolvedValue({
      sessionId: 'SES-REANALYZE',
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

    await waitFor(() => {
      expect(window.electronAPI?.meeting.analyze).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText('Yeni kayıt için kalıcı toplantı özeti.', {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    expect(window.electronAPI?.meeting.getIntelligenceResult).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Kalıcı toplantı özeti yüklendi.')).not.toBeInTheDocument();
  });
});

describe('App recent meeting result navigation', () => {
  const RECORDER_MEETING_ID = '22222222-2222-4222-8222-222222222222';

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
