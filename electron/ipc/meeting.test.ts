import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  getValidAccessToken: vi.fn(async () => 'JWT'),
  loadMeetingConfig: vi.fn(() => ({ baseUrl: 'https://testai.acik.com' })),
  createMeetingContract: vi.fn(),
  analyzeMeetingIntelligence: vi.fn(),
  readMeetingIntelligenceResult: vi.fn(async () => ({ status: 'not_ready' as const })),
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
  createMeetingContract: mocks.createMeetingContract,
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
});
