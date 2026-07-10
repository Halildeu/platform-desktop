import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeMeetingIntelligence,
  createMeetingContract,
  getMeetingAnalysisResult,
  listMeetingActions,
  listMeetingDecisions,
  loadMeetingConfig,
  meetingActionsUrl,
  meetingDecisionsUrl,
  meetingIntelligenceAnalyzeUrl,
  meetingSummaryUrl,
  meetingsUrl,
  readMeetingAnalysisSnapshot,
} from './meeting-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('meeting-client', () => {
  it('loads meeting base URL from MEETING_BASE_URL with gateway/keycloak fallback', () => {
    expect(loadMeetingConfig({ MEETING_BASE_URL: 'https://meeting.example.com/' }).baseUrl).toBe(
      'https://meeting.example.com',
    );
    expect(loadMeetingConfig({ GATEWAY_BASE_URL: 'https://testai.acik.com' }).baseUrl).toBe(
      'https://testai.acik.com',
    );
    expect(loadMeetingConfig({ KEYCLOAK_BASE_URL: 'https://testai.acik.com' }).baseUrl).toBe(
      'https://testai.acik.com',
    );
    expect(() => loadMeetingConfig({})).toThrow('MEETING_BASE_URL or GATEWAY_BASE_URL');
    expect(() => loadMeetingConfig({ MEETING_BASE_URL: '/meeting' })).toThrow(
      'MEETING_BASE_URL must be an absolute URL',
    );
    expect(() => loadMeetingConfig({ MEETING_BASE_URL: 'http://meeting.example.com' })).toThrow(
      'MEETING_BASE_URL must use https',
    );
  });

  it('builds the admin meetings URL', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(meetingsUrl(cfg)).toBe('https://testai.acik.com/api/v1/admin/meetings');
  });

  it('builds the Meeting AI analyze URL behind the admin meeting route', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(meetingIntelligenceAnalyzeUrl(cfg, '33333333-3333-4333-8333-333333333333')).toBe(
      'https://testai.acik.com/api/v1/admin/meetings/33333333-3333-4333-8333-333333333333/intelligence/analyze',
    );
    expect(() => meetingIntelligenceAnalyzeUrl(cfg, 'MTG-1')).toThrow('canonical UUID');
  });

  it('creates a meeting contract with the bearer token in main process', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Desktop contract',
        status: 'SCHEDULED',
        scheduledStart: '2026-06-29T14:30:00.000Z',
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    const contract = await createMeetingContract(cfg, 'JWT', {
      title: 'Desktop contract',
      description: 'Recorder test',
      scheduledStart: '2026-06-29T14:30:00.000Z',
    });

    expect(contract.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://testai.acik.com/api/v1/admin/meetings',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer JWT',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Desktop contract',
          description: 'Recorder test',
          scheduledStart: '2026-06-29T14:30:00.000Z',
        }),
      }),
    );
  });

  it('retries transient socket failures before failing the meeting contract flow', async () => {
    const retryableError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '44444444-4444-4444-8444-444444444444',
          title: 'Desktop contract',
          status: 'SCHEDULED',
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler) => {
      if (typeof handler === 'function') {
        queueMicrotask(() => handler());
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    const contract = await createMeetingContract({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
      title: 'Desktop contract',
    });

    expect(contract.id).toBe('44444444-4444-4444-8444-444444444444');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-canonical meeting-service responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'MTG-1', title: 'bad', status: 'SCHEDULED' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      createMeetingContract({ baseUrl: 'https://testai.acik.com' }, 'JWT'),
    ).rejects.toThrow('canonical UUID');
  });

  it('submits Meeting AI analyze requests through the backend gateway with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: 'Toplantı özeti üretildi.',
        decisions: ['Gateway rotası kullanılacak'],
        action_items: [{ text: 'Kanıt eklenecek', owner: 'Zeynep' }],
        citations: [{ claim: 'Gateway rotası kullanılacak', source_index: 0, start_sec: 2 }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeMeetingIntelligence({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
      meetingId: '33333333-3333-4333-8333-333333333333',
      request: {
        meeting_id: '33333333-3333-4333-8333-333333333333',
        session_id: 'SES-1',
        transcript: 'Canlı toplantı transkripti',
        segments: [{ text: 'Canlı toplantı transkripti', start: 0 }],
      },
    });

    expect(result.summary).toBe('Toplantı özeti üretildi.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://testai.acik.com/api/v1/admin/meetings/33333333-3333-4333-8333-333333333333/intelligence/analyze',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer JWT',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          meeting_id: '33333333-3333-4333-8333-333333333333',
          session_id: 'SES-1',
          transcript: 'Canlı toplantı transkripti',
          segments: [{ text: 'Canlı toplantı transkripti', start: 0 }],
        }),
      }),
    );
  });

  it('keeps Meeting AI HTTP errors redacted from transcript content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            code: 'MEETING_AI_FORBIDDEN',
            correlationId: 'cid-123',
            retryable: false,
            transcript: 'raw transcript must not appear',
          }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      analyzeMeetingIntelligence({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: '33333333-3333-4333-8333-333333333333',
        request: {
          meeting_id: '33333333-3333-4333-8333-333333333333',
          session_id: 'SES-1',
          transcript: 'raw transcript must not appear',
          segments: [],
        },
      }),
    ).rejects.toThrow(
      'analyzeMeetingIntelligence failed: 403 code=MEETING_AI_FORBIDDEN correlationId=cid-123 retryable=false',
    );
  });

  describe('#244 DT-1 — meeting-service read-path', () => {
    const MEETING_ID = '33333333-3333-4333-8333-333333333333';
    const cfg = { baseUrl: 'https://testai.acik.com' };

    it('builds summary/decisions/actions URLs', () => {
      expect(meetingSummaryUrl(cfg, MEETING_ID)).toBe(
        `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/summary`,
      );
      expect(meetingDecisionsUrl(cfg, MEETING_ID)).toBe(
        `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/decisions`,
      );
      expect(meetingActionsUrl(cfg, MEETING_ID)).toBe(
        `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/actions`,
      );
      expect(() => meetingSummaryUrl(cfg, 'MTG-1')).toThrow('canonical UUID');
    });

    it('returns null when the meeting has no canonical analysis run yet (404)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      await expect(getMeetingAnalysisResult(cfg, 'JWT', MEETING_ID)).resolves.toBeNull();
    });

    it('parses a canonical analysis result', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          meetingId: MEETING_ID,
          analysisRunId: 'run-1',
          status: 'CANONICAL',
          summary: 'Bütçe onaylandı.',
          groundingStatus: 'verified',
          analyzerContractVersion: '5-adr0043',
          modelVersion: 'llama3.1:8b',
          promptVersion: 'ollama-v1',
          generatedAt: '2026-07-10T10:00:00.000Z',
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await getMeetingAnalysisResult(cfg, 'JWT', MEETING_ID);

      expect(result?.summary).toBe('Bütçe onaylandı.');
      expect(fetchMock).toHaveBeenCalledWith(
        `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/summary`,
        expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer JWT' } }),
      );
    });

    it('throws on non-404 HTTP errors from the summary endpoint', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: async () => '',
          headers: new Headers(),
        }),
      );

      await expect(getMeetingAnalysisResult(cfg, 'JWT', MEETING_ID)).rejects.toThrow(
        'getMeetingAnalysisResult failed: 403',
      );
    });

    it('lists decisions and drops malformed entries', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [
            { id: 'd-1', title: 'Bütçe onaylandı', decidedBySubject: 'zeynep' },
            { id: 'd-2' },
            'not-an-object',
          ],
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      );

      const decisions = await listMeetingDecisions(cfg, 'JWT', MEETING_ID);
      expect(decisions).toEqual([
        {
          id: 'd-1',
          title: 'Bütçe onaylandı',
          detail: null,
          decidedBySubject: 'zeynep',
          decidedAt: null,
        },
      ]);
    });

    it('lists actions and drops malformed entries', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [
            {
              id: 'a-1',
              description: 'Kanıt eklenecek',
              assigneeSubject: 'zeynep',
              status: 'OPEN',
              dueAt: '2026-07-15T00:00:00.000Z',
            },
            { id: 'a-2' },
          ],
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      );

      const actions = await listMeetingActions(cfg, 'JWT', MEETING_ID);
      expect(actions).toEqual([
        {
          id: 'a-1',
          description: 'Kanıt eklenecek',
          assigneeSubject: 'zeynep',
          status: 'OPEN',
          dueAt: '2026-07-15T00:00:00.000Z',
        },
      ]);
    });

    it('readMeetingAnalysisSnapshot skips decisions/actions calls when no canonical run exists', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fetchMock);

      const snapshot = await readMeetingAnalysisSnapshot(cfg, 'JWT', MEETING_ID);

      expect(snapshot).toEqual({ result: null, decisions: [], actions: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('readMeetingAnalysisSnapshot fetches decisions/actions once a canonical run exists', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/summary')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              meetingId: MEETING_ID,
              analysisRunId: 'run-1',
              status: 'CANONICAL',
              summary: 'Özet',
              groundingStatus: 'verified',
              analyzerContractVersion: '5-adr0043',
              modelVersion: 'llama3.1:8b',
              promptVersion: 'ollama-v1',
              generatedAt: '2026-07-10T10:00:00.000Z',
            }),
            headers: new Headers({ 'content-type': 'application/json' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [],
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const snapshot = await readMeetingAnalysisSnapshot(cfg, 'JWT', MEETING_ID);

      expect(snapshot.result?.analysisRunId).toBe('run-1');
      expect(snapshot.decisions).toEqual([]);
      expect(snapshot.actions).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
