import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  getValidAccessToken: vi.fn(async () => 'JWT'),
  loadMeetingConfig: vi.fn(() => ({ baseUrl: 'https://testai.acik.com' })),
  createMeetingContract: vi.fn(),
  listRecentMeetings: vi.fn(async () => ({
    meetings: [],
    page: 0,
    size: 20,
    totalElements: 0,
    totalPages: 0,
  })),
  analyzeMeetingIntelligence: vi.fn(),
  readMeetingIntelligenceResult: vi.fn(async () => ({ status: 'not_ready' as const })),
  createMeetingAction: vi.fn(async () => ({
    id: 'a-1',
    meetingId: '33333333-3333-4333-8333-333333333333',
    description: 'stub',
    assigneeSubject: null,
    status: 'OPEN',
    dueAt: null,
    version: 0,
  })),
  searchAssignees: vi.fn(async () => [{ userId: 30, label: 'Ali Veli' }]),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../services/meeting/meeting-client', () => ({
  analyzeMeetingIntelligence: mocks.analyzeMeetingIntelligence,
  createMeetingAction: mocks.createMeetingAction,
  createMeetingContract: mocks.createMeetingContract,
  searchAssignees: mocks.searchAssignees,
  listRecentMeetings: mocks.listRecentMeetings,
  loadMeetingConfig: mocks.loadMeetingConfig,
  readMeetingIntelligenceResult: mocks.readMeetingIntelligenceResult,
}));

vi.mock('./auth', () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));

async function registerFreshMeetingIpc(): Promise<void> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.getValidAccessToken.mockClear();
  mocks.listRecentMeetings.mockClear();
  mocks.readMeetingIntelligenceResult.mockClear();
  const { registerMeetingIpc } = await import('./meeting');
  registerMeetingIpc();
}

describe('meeting result IPC boundary', () => {
  beforeEach(async () => {
    await registerFreshMeetingIpc();
  });

  it('rejects a non-canonical meetingId before token or network access', async () => {
    const handler = mocks.handlers.get('meeting:get-intelligence-result');

    await expect(handler?.({}, { meetingId: '../foreign-meeting' })).rejects.toThrow(
      'meetingId must be a canonical UUID',
    );
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
    expect(mocks.readMeetingIntelligenceResult).not.toHaveBeenCalled();
  });

  it('passes only a validated meetingId and main-process token to the client', async () => {
    const handler = mocks.handlers.get('meeting:get-intelligence-result');
    const meetingId = '33333333-3333-4333-8333-333333333333';

    await expect(handler?.({}, { meetingId })).resolves.toEqual({ status: 'not_ready' });
    expect(mocks.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.readMeetingIntelligenceResult).toHaveBeenCalledWith(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
      meetingId,
    );
  });

  it('lists recent meeting metadata with a main-process token and no renderer input', async () => {
    const handler = mocks.handlers.get('meeting:list-recent');

    await expect(handler?.({})).resolves.toMatchObject({ meetings: [], totalElements: 0 });
    expect(mocks.getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.listRecentMeetings).toHaveBeenCalledWith(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
    );
  });
});

// ── Faz 24 Görevler dilim-3 (gitops#3486): action-create / assignee-search ──

describe('meeting action IPC boundary', () => {
  beforeEach(async () => {
    await registerFreshMeetingIpc();
    mocks.createMeetingAction.mockClear();
    mocks.searchAssignees.mockClear();
  });

  it('rejects an action create with a bad meetingId before token access', async () => {
    const handler = mocks.handlers.get('meeting:action-create');

    await expect(handler?.({}, { meetingId: 'nope', description: 'Rapor' })).rejects.toThrow(
      'meetingId must be a canonical UUID',
    );
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
    expect(mocks.createMeetingAction).not.toHaveBeenCalled();
  });

  it('trims and forwards a validated action create with the main-process token', async () => {
    const handler = mocks.handlers.get('meeting:action-create');
    const meetingId = '33333333-3333-4333-8333-333333333333';

    await expect(
      handler?.(
        {},
        {
          meetingId,
          description: '  Raporu hazırla  ',
          assigneeSubject: ' kc-9 ',
          assigneeUserId: 42,
          dueAt: '',
        },
      ),
    ).resolves.toMatchObject({ id: 'a-1' });
    expect(mocks.createMeetingAction).toHaveBeenCalledWith(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
      {
        meetingId,
        description: 'Raporu hazırla',
        assigneeSubject: 'kc-9',
        assigneeUserId: 42,
        dueAt: null,
      },
    );
  });

  it('requires a non-empty assignee search query', async () => {
    const handler = mocks.handlers.get('meeting:assignee-search');

    await expect(handler?.({}, { query: '   ' })).rejects.toThrow('query is required');
    expect(mocks.searchAssignees).not.toHaveBeenCalled();

    await expect(handler?.({}, { query: ' zeynep ' })).resolves.toEqual([
      { userId: 30, label: 'Ali Veli' },
    ]);
    expect(mocks.searchAssignees).toHaveBeenCalledWith(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
      'zeynep',
    );
  });

  it('parses and forwards speechContextTerms on create-contract', async () => {
    mocks.createMeetingContract.mockClear();
    mocks.createMeetingContract.mockResolvedValueOnce({
      id: '77777777-7777-4777-8777-777777777777',
      title: 'Kayıt',
      status: 'SCHEDULED',
      scheduledStart: null,
      scheduledEnd: null,
    });
    const handler = mocks.handlers.get('meeting:create-contract');
    expect(handler).toBeDefined();

    await handler?.({}, { title: 'Kayıt', speechContextTerms: ['Açık Holding', 'OpenFGA'] });

    expect(mocks.createMeetingContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ speechContextTerms: ['Açık Holding', 'OpenFGA'] }),
    );
  });

  it('rejects a create-contract whose speechContextTerms is not an array of strings', async () => {
    const handler = mocks.handlers.get('meeting:create-contract');
    await expect(handler?.({}, { title: 'Kayıt', speechContextTerms: 'OpenFGA' })).rejects.toThrow(
      'speechContextTerms must be an array of strings',
    );
    await expect(handler?.({}, { title: 'Kayıt', speechContextTerms: [1, 2] })).rejects.toThrow(
      'speechContextTerms entries must be strings',
    );
  });
});
