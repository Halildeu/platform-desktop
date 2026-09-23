// @vitest-environment jsdom

/**
 * LiveAnalysisPanel rendering + interaction tests.
 *
 * Uses the same stub API as the hook tests so we exercise the render
 * tree end-to-end without depending on `window.electronAPI`.
 */

import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveAnalysisPanel } from './LiveAnalysisPanel';
import type {
  LiveAnalysisApi,
  LiveAnalysisFrame,
  LiveAnalysisStatus,
} from '../intelligence/use-live-analysis';

const MEETING_A = '11111111-1111-4111-8111-111111111111';

interface StubApi extends LiveAnalysisApi {
  fireFrame(meetingId: string, frame: LiveAnalysisFrame): void;
  fireStatus(meetingId: string, status: LiveAnalysisStatus): void;
}

function makeStubApi(): StubApi {
  let frameCb: ((f: { meetingId: string } & LiveAnalysisFrame) => void) | null = null;
  let statusCb: ((s: { meetingId: string; status: LiveAnalysisStatus }) => void) | null = null;
  return {
    async startLiveAnalysis() {
      return { started: true };
    },
    async stopLiveAnalysis() {
      return { stopped: true };
    },
    onLiveAnalysisFrame(cb) {
      frameCb = cb;
      return () => {
        frameCb = null;
      };
    },
    onLiveAnalysisStatus(cb) {
      statusCb = cb;
      return () => {
        statusCb = null;
      };
    },
    fireFrame(meetingId, frame) {
      frameCb?.({ meetingId, ...frame });
    },
    fireStatus(meetingId, status) {
      statusCb?.({ meetingId, status });
    },
  };
}

describe('<LiveAnalysisPanel />', () => {
  afterEach(() => cleanup());

  it('renders an empty-state prompt when no meetingId is provided', () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={null} api={api} />);
    expect(screen.getByText(/aktif toplantı yok/i)).toBeInTheDocument();
  });

  it('renders the waiting state while no frames have arrived', async () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} />);
    // h3 title inside the section — level:3 disambiguates from an aria-label
    // that also matches /canlı/i.
    expect(screen.getByRole('heading', { level: 3, name: /canlı analiz/i })).toBeInTheDocument();
    // Turkish dotted `İ` does not case-fold to ASCII `i` under a plain
    // `/i` regex flag; match the literal capitalised string.
    expect(screen.getByText(/İlk canlı analiz bekleniyor/)).toBeInTheDocument();
  });

  it('shows a live partial with a version badge and summary text', async () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} />);

    act(() => {
      api.fireStatus(MEETING_A, { kind: 'open', connectedAt: '2026-07-20T22:00:00Z' });
      api.fireFrame(MEETING_A, {
        payload: {
          is_partial: true,
          version: 7,
          summary: 'Bütçe konuşuldu',
          decisions: ['Bütçe onaylandı'],
          action_items: [{ text: 'Ali hazırlayacak' }],
          redaction_count: 2,
        },
        receivedAt: '2026-07-20T22:00:05Z',
      });
    });

    await waitFor(() => expect(screen.getByText(/Bütçe konuşuldu/)).toBeInTheDocument());
    expect(screen.getByText(/Kısmi \(v7\)/)).toBeInTheDocument();
    expect(screen.getByText('Bütçe onaylandı')).toBeInTheDocument();
    expect(screen.getByText('Ali hazırlayacak')).toBeInTheDocument();
    expect(screen.getByText(/KVKK redaction: 2/)).toBeInTheDocument();
    expect(screen.getByText('Canlı')).toBeInTheDocument();
  });

  it('hides the partial badge on the final (non-partial) frame', async () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} />);

    act(() => {
      api.fireFrame(MEETING_A, {
        payload: {
          is_partial: false,
          version: 9,
          summary: 'Final özet',
        },
        receivedAt: '2026-07-20T22:00:20Z',
      });
    });

    await waitFor(() => expect(screen.getByText('Final özet')).toBeInTheDocument());
    expect(screen.queryByText(/Kısmi/)).not.toBeInTheDocument();
  });

  it('surfaces a helpful copy on an error status', async () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} />);

    act(() => {
      api.fireStatus(MEETING_A, { kind: 'error', error: 'network down' });
    });

    await waitFor(() => expect(screen.getByText(/Hata — network down/)).toBeInTheDocument());
    expect(screen.getByText(/Bağlantı kurulamadı/)).toBeInTheDocument();
  });
});

// ── Faz 24 Görevler dilim-3 (gitops#3486): aksiyon → görev atama ────────────

import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { LiveTasksApi } from './LiveAnalysisPanel';

function fireActionFrame(api: StubApi): void {
  act(() => {
    api.fireStatus(MEETING_A, { kind: 'open', connectedAt: '2026-08-29T10:00:00Z' });
    api.fireFrame(MEETING_A, {
      payload: {
        is_partial: true,
        version: 1,
        summary: 'Plan konuşuldu',
        action_items: [{ text: 'Raporu Zeynep hazırlayacak' }],
      },
      receivedAt: '2026-08-29T10:00:05Z',
    });
  });
}

describe('<LiveAnalysisPanel /> görev atama', () => {
  afterEach(() => cleanup());

  it('creates a task from an action item with assignee and due date', async () => {
    const api = makeStubApi();
    const createAction = vi.fn().mockResolvedValue({ id: 't-1' });
    const searchAssignees = vi
      .fn()
      .mockResolvedValue([{ userId: 77, label: 'Zeynep Akkılıç (zeynep@acik.com)' }]);
    const tasksApi: LiveTasksApi = { createAction, searchAssignees };
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} tasksApi={tasksApi} />);
    fireActionFrame(api);
    await waitFor(() => expect(screen.getByText('Raporu Zeynep hazırlayacak')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Göreve ata' }));
    await userEvent.type(screen.getByLabelText('Atanacak kişiyi ara'), 'zeynep');
    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));
    await waitFor(() =>
      expect(screen.getByText('Zeynep Akkılıç (zeynep@acik.com)')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByText('Zeynep Akkılıç (zeynep@acik.com)'));
    await userEvent.click(screen.getByRole('button', { name: 'Görev oluştur' }));

    await waitFor(() => expect(screen.getByText(/Görev oluşturuldu/)).toBeInTheDocument());
    expect(searchAssignees).toHaveBeenCalledWith({ query: 'zeynep' });
    expect(createAction).toHaveBeenCalledWith({
      meetingId: MEETING_A,
      description: 'Raporu Zeynep hazırlayacak',
      assigneeUserId: 77,
      dueAt: null,
    });
  });

  it('surfaces a create failure without losing the form', async () => {
    const api = makeStubApi();
    const tasksApi: LiveTasksApi = {
      createAction: vi.fn().mockRejectedValue(new Error('createMeetingAction failed: 403')),
      searchAssignees: vi.fn().mockResolvedValue([]),
    };
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} tasksApi={tasksApi} />);
    fireActionFrame(api);
    await waitFor(() => expect(screen.getByText('Raporu Zeynep hazırlayacak')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Göreve ata' }));
    await userEvent.click(screen.getByRole('button', { name: 'Görev oluştur' }));

    await waitFor(() =>
      expect(screen.getByText(/Görev oluşturulamadı: .*403/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Görev oluştur' })).toBeInTheDocument();
  });

  // gitops#3587: a lookup that fails and a lookup that matches nobody used to
  // render the same empty form, which is how the reported regression stayed
  // undiagnosed.
  it('separates a failed assignee lookup from an empty one', async () => {
    const api = makeStubApi();
    const tasksApi: LiveTasksApi = {
      createAction: vi.fn(),
      searchAssignees: vi.fn().mockRejectedValue(new Error('searchAssignees failed: 403')),
    };
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} tasksApi={tasksApi} />);
    fireActionFrame(api);
    await waitFor(() => expect(screen.getByText('Raporu Zeynep hazırlayacak')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Göreve ata' }));
    await userEvent.type(screen.getByLabelText('Atanacak kişiyi ara'), 'sevil');
    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));

    await waitFor(() =>
      expect(screen.getByText(/Kişi araması yapılamadı: .*403/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/kişi bulunamadı/i)).not.toBeInTheDocument();
    // The action stays assignable without an owner.
    expect(screen.getByRole('button', { name: 'Görev oluştur' })).toBeInTheDocument();
  });

  it('says so when the directory matches nobody', async () => {
    const api = makeStubApi();
    const tasksApi: LiveTasksApi = {
      createAction: vi.fn(),
      searchAssignees: vi.fn().mockResolvedValue([]),
    };
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} tasksApi={tasksApi} />);
    fireActionFrame(api);
    await waitFor(() => expect(screen.getByText('Raporu Zeynep hazırlayacak')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Göreve ata' }));
    await userEvent.type(screen.getByLabelText('Atanacak kişiyi ara'), 'sevil');
    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));

    await waitFor(() => expect(screen.getByText(/kişi bulunamadı/i)).toBeInTheDocument());
    expect(screen.queryByText(/Kişi araması yapılamadı/)).not.toBeInTheDocument();
  });

  it('hides the assign affordance when no tasks API bridge exists', async () => {
    const api = makeStubApi();
    render(<LiveAnalysisPanel meetingId={MEETING_A} api={api} />);
    fireActionFrame(api);
    await waitFor(() => expect(screen.getByText('Raporu Zeynep hazırlayacak')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Göreve ata' })).not.toBeInTheDocument();
  });
});
