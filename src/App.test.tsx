// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  it('canonical meetingId yoksa kayıt butonunu fail-closed tutar', async () => {
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

    const button = screen.getByRole('button', {
      name: 'Meeting contract bekleniyor',
    });
    expect(button).toBeDisabled();
  });

  it('canonical meetingId geldiginde kayit butonunu acar', async () => {
    installElectronApiMock({
      meetingId: 'MTG-2026-24',
      deviceId: 'desktop-1',
      ready: true,
      reason: null,
    });

    render(<App />);

    expect(await screen.findByText('Giriş yapıldı. Toplantı kaydına hazır.')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kaydet' })).toBeEnabled();
    });
  });
});
