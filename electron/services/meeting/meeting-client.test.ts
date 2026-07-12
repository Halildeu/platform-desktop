import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeMeetingIntelligence,
  createMeetingContract,
  listRecentMeetings,
  loadMeetingConfig,
  meetingIntelligenceAnalyzeUrl,
  meetingIntelligenceResultUrl,
  meetingsUrl,
  parseMeetingIntelligenceCanonicalResponse,
  parseRecentMeetingsPage,
  recentMeetingsUrl,
  readMeetingIntelligenceResult,
} from './meeting-client';

const MEETING_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '55555555-5555-4555-8555-555555555555';

function canonicalResultFixture(): Record<string, unknown> {
  return {
    analysisRunId: RUN_ID,
    meetingId: MEETING_ID,
    sessionId: 'SES-1',
    schema_version: '5-adr0043',
    model: 'qwen',
    backend: 'ollama',
    promptVersion: 'ollama-v1',
    summary: 'Canonical özet.',
    summary_grounding_status: 'verified',
    summary_citations: [
      {
        claim: 'Canonical özet.',
        source_index: 0,
        source_text: 'Canonical kaynak.',
        similarity: 0.97,
        grounded: true,
        status: 'PASSED',
        reason: 'verified',
        start_sec: 2.5,
        source_char_start: 0,
        source_char_end: 18,
        source_hash: 'A'.repeat(64),
        quote_hash: 'b'.repeat(64),
      },
    ],
    decisions: ['Canonical karar'],
    action_items: [{ text: 'Canonical aksiyon', owner: 'user-42', due_date: null }],
    citations: [
      {
        claim: 'Canonical karar',
        source_index: 1,
        source_text: 'Karar kaynağı.',
        similarity: 0.92,
        grounded: true,
        status: 'PASSED',
        reason: 'verified',
        start_sec: null,
        source_char_start: 19,
        source_char_end: 33,
        source_hash: 'c'.repeat(64),
        quote_hash: 'D'.repeat(64),
      },
    ],
    rejected_claims: [],
    ungrounded_count: 0,
    redacted: true,
    redaction_count: 1,
    generatedAt: '2026-07-11T20:00:00Z',
    supersedesAnalysisRunId: null,
    persisted: true,
    storageMode: 'canonical',
  };
}

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

  it('builds a bounded first-page recent meetings URL', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(recentMeetingsUrl(cfg)).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20',
    );
    expect(recentMeetingsUrl(cfg, 500)).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=50',
    );
    expect(recentMeetingsUrl(cfg, 0)).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=1',
    );
    expect(recentMeetingsUrl(cfg, Number.NaN)).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20',
    );
    expect(recentMeetingsUrl(cfg, Number.POSITIVE_INFINITY)).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20',
    );
  });

  it('lists allowlisted recent meeting metadata with bearer auth and no-store', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            id: MEETING_ID,
            title: 'Haftalık ürün toplantısı',
            status: 'COMPLETED',
            scheduledStart: '2026-07-11T12:00:00Z',
            scheduledEnd: null,
            createdAt: '2026-07-11T11:55:00Z',
            updatedAt: '2026-07-11T13:05:00Z',
            orgId: 'must-not-cross-preload',
            organizerSubject: 'must-not-cross-preload',
            description: 'must-not-cross-preload',
          },
        ],
        page: 0,
        size: 20,
        totalElements: 1,
        totalPages: 1,
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await listRecentMeetings({ baseUrl: 'https://testai.acik.com' }, 'JWT');

    expect(page).toEqual({
      meetings: [
        {
          id: MEETING_ID,
          title: 'Haftalık ürün toplantısı',
          status: 'COMPLETED',
          scheduledStart: '2026-07-11T12:00:00.000Z',
          scheduledEnd: null,
          createdAt: '2026-07-11T11:55:00.000Z',
          updatedAt: '2026-07-11T13:05:00.000Z',
        },
      ],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    });
    expect(JSON.stringify(page)).not.toContain('orgId');
    expect(JSON.stringify(page)).not.toContain('organizerSubject');
    expect(JSON.stringify(page)).not.toContain('description');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer JWT',
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
      }),
    );
  });

  it('fails closed on malformed or oversized meeting list metadata', () => {
    const fixture = {
      content: [
        {
          id: MEETING_ID,
          title: 'Toplantı',
          status: 'COMPLETED',
          scheduledStart: null,
          scheduledEnd: null,
          createdAt: '2026-07-11T11:55:00Z',
          updatedAt: '2026-07-11T13:05:00Z',
        },
      ],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    };

    expect(() => parseRecentMeetingsPage({ ...fixture, page: 1 })).toThrow(
      'pagination metadata is invalid',
    );
    expect(() =>
      parseRecentMeetingsPage({
        ...fixture,
        content: [{ ...fixture.content[0], updatedAt: 'not-an-instant' }],
      }),
    ).toThrow('updatedAt is not an ISO instant');
    expect(() =>
      parseRecentMeetingsPage({
        ...fixture,
        content: Array.from({ length: 51 }, () => fixture.content[0]),
      }),
    ).toThrow('exceeds the client limit');
    expect(() =>
      parseRecentMeetingsPage({
        ...fixture,
        content: [fixture.content[0], fixture.content[0]],
        totalElements: 2,
      }),
    ).toThrow('contains duplicate meeting ids');
  });

  it('builds the Meeting AI analyze URL behind the admin meeting route', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(meetingIntelligenceAnalyzeUrl(cfg, '33333333-3333-4333-8333-333333333333')).toBe(
      'https://testai.acik.com/api/v1/admin/meetings/33333333-3333-4333-8333-333333333333/intelligence/analyze',
    );
    expect(() => meetingIntelligenceAnalyzeUrl(cfg, 'MTG-1')).toThrow('canonical UUID');
  });

  it('builds the canonical Meeting Intelligence result URL', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(meetingIntelligenceResultUrl(cfg, MEETING_ID)).toBe(
      `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/intelligence/result`,
    );
    expect(() => meetingIntelligenceResultUrl(cfg, 'MTG-1')).toThrow('canonical UUID');
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

  it('fails closed when a created meeting contract contains invalid bounded metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: MEETING_ID,
          title: 'Desktop contract',
          status: 'SCHEDULED',
          createdAt: 'not-an-instant',
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      createMeetingContract({ baseUrl: 'https://testai.acik.com' }, 'JWT'),
    ).rejects.toThrow('createdAt is not an ISO instant');
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

  it('reads one allowlisted canonical snapshot with bearer auth and no-store', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...canonicalResultFixture(),
        transcriptSha256: 'must-not-cross-the-preload-bridge',
        tenantId: 'must-not-cross-the-preload-bridge',
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await readMeetingIntelligenceResult(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
      MEETING_ID,
    );

    expect(outcome).toMatchObject({
      status: 'ready',
      result: {
        analysisRunId: RUN_ID,
        meetingId: MEETING_ID,
        summaryGroundingStatus: 'verified',
        generatedAt: '2026-07-11T20:00:00.000Z',
        persisted: true,
        storageMode: 'canonical',
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('transcriptSha256');
    expect(JSON.stringify(outcome)).not.toContain('tenantId');
    expect(JSON.stringify(outcome)).not.toContain('Canonical kaynak.');
    expect(JSON.stringify(outcome)).not.toContain('Karar kaynağı.');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/intelligence/result`,
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer JWT',
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
      }),
    );
  });

  it('maps only ANALYSIS_RESULT_NOT_FOUND to the not-ready product state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: 'ANALYSIS_RESULT_NOT_FOUND', traceId: 'trace-123' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      readMeetingIntelligenceResult({ baseUrl: 'https://testai.acik.com' }, 'JWT', MEETING_ID),
    ).resolves.toEqual({ status: 'not_ready' });
  });

  it('does not hide a foreign or unknown meeting behind the not-ready state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: 'MEETING_NOT_FOUND', traceId: 'trace-456' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      readMeetingIntelligenceResult({ baseUrl: 'https://testai.acik.com' }, 'JWT', MEETING_ID),
    ).rejects.toThrow(
      'readMeetingIntelligenceResult failed: 404 code=MEETING_NOT_FOUND correlationId=trace-456',
    );
  });

  it('surfaces authorization failures instead of treating them as not-ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'MEETING_FORBIDDEN', traceId: 'trace-403' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      readMeetingIntelligenceResult({ baseUrl: 'https://testai.acik.com' }, 'JWT', MEETING_ID),
    ).rejects.toThrow(
      'readMeetingIntelligenceResult failed: 403 code=MEETING_FORBIDDEN correlationId=trace-403',
    );
  });

  it('fails closed on a mismatched meeting or non-grounded persisted evidence', () => {
    expect(() =>
      parseMeetingIntelligenceCanonicalResponse(
        { ...canonicalResultFixture(), meetingId: '66666666-6666-4666-8666-666666666666' },
        MEETING_ID,
      ),
    ).toThrow('meetingId does not match request');

    const invalid = canonicalResultFixture();
    invalid.citations = [
      {
        ...((invalid.citations as Array<Record<string, unknown>>)[0] ?? {}),
        grounded: false,
      },
    ];
    expect(() => parseMeetingIntelligenceCanonicalResponse(invalid, MEETING_ID)).toThrow(
      'is not grounded evidence',
    );
  });
});
