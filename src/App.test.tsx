// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('./audio/capture', () => ({
  startRecording: vi.fn(),
}));

import { startRecording } from './audio/capture';
import App from './App';

interface TestTranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  text: string;
  textLength: number;
  status: string;
}

interface TestTranscriptGatewayError {
  sessionId: string;
  message: string;
}

let transcriptEventHandler: ((event: TestTranscriptGatewayEvent) => void) | null = null;

function installElectronApiMock(recorderConfig: {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
}): void {
  transcriptEventHandler = null;
  window.electronAPI = {
    app: {
      getVersion: vi.fn().mockResolvedValue('0.1.0-test'),
    },
    auth: {
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue({ loggedIn: false, claims: null }),
      status: vi.fn().mockResolvedValue({ loggedIn: true, claims: null }),
    },
    meeting: {
      createContract: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Faz 24 desktop recording',
        status: 'SCHEDULED',
      }),
    },
    audio: {
      recorderConfig: vi.fn().mockResolvedValue(recorderConfig),
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
    expect(screen.getAllByText('Blokeli')).toHaveLength(2);
    expect(screen.getByText('RECORDER_MEETING_ID tanimli degil.')).toBeInTheDocument();
    expect(
      screen.getByText('Meeting intelligence için canonical meetingId yok.'),
    ).toBeInTheDocument();
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
    expect(screen.getByText('Beklemede')).toBeInTheDocument();
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
    expect(screen.getByText('Beklemede')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
    });
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
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler) => {
      if (typeof handler === 'function') {
        queueMicrotask(() => handler());
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum — Kaydı Başlat' }));

    await Promise.resolve();
    await Promise.resolve();
    expect(startRecording).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'desktop-1',
    );
    timeoutSpy.mockRestore();

    const timeoutErrors = await screen.findAllByText(
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
    });

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
});
