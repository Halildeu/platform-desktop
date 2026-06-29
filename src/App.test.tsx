// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import App from './App';

function installElectronApiMock(recorderConfig: {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
}): void {
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
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
});
