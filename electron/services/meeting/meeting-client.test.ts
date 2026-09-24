import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeMeetingIntelligence,
  createMeetingContract,
  normalizeSpeechContextTerms,
  listRecentMeetings,
  loadMeetingConfig,
  meetingIntelligenceAnalyzeUrl,
  meetingIntelligenceResultUrl,
  meetingsUrl,
  parseMeetingIntelligenceCanonicalResponse,
  parseRecentMeetingsPage,
  recentMeetingsUrl,
  recordingLifecycleUrl,
  searchAssignees,
  readMeetingIntelligenceResult,
  syncRecordingLifecycle,
} from './meeting-client';

const MEETING_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const NO_PUBLIC_CONFIG = {
  paths: { packaged: null, system: null, user: null },
} as const;
const PACKAGED_ONLY_CONFIG = {
  paths: { system: null, user: null },
} as const;

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('meeting-client', () => {
  it('loads meeting base URL from MEETING_BASE_URL with gateway/keycloak fallback', () => {
    expect(loadMeetingConfig({}, PACKAGED_ONLY_CONFIG).baseUrl).toBe('https://testai.acik.com');
    expect(
      loadMeetingConfig({ MEETING_BASE_URL: 'https://meeting.example.com/' }, PACKAGED_ONLY_CONFIG)
        .baseUrl,
    ).toBe('https://meeting.example.com');
    expect(
      loadMeetingConfig({ GATEWAY_BASE_URL: 'https://testai.acik.com' }, PACKAGED_ONLY_CONFIG)
        .baseUrl,
    ).toBe('https://testai.acik.com');
    expect(
      loadMeetingConfig({ KEYCLOAK_BASE_URL: 'https://testai.acik.com' }, PACKAGED_ONLY_CONFIG)
        .baseUrl,
    ).toBe('https://testai.acik.com');
    expect(() => loadMeetingConfig({}, NO_PUBLIC_CONFIG)).toThrow(
      'MEETING_BASE_URL or GATEWAY_BASE_URL',
    );
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

  it('reaches later pages and searches titles (list stopped at the newest 20)', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(recentMeetingsUrl(cfg, 20, { page: 3 })).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=3&size=20',
    );
    expect(recentMeetingsUrl(cfg, 20, { title: '  test2 perşembe & ?x ' })).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20&title=test2%20per%C5%9Fembe%20%26%20%3Fx',
    );
    expect(recentMeetingsUrl(cfg, 20, { page: -4, title: '   ' })).toBe(
      'https://testai.acik.com/api/v1/admin/meetings?page=0&size=20',
    );
    expect(() => recentMeetingsUrl(cfg, 20, { title: 'x'.repeat(101) })).toThrow(
      'meeting title search is too long',
    );
  });

  it('accepts the requested page and rejects a mismatched one', () => {
    const fixture = {
      content: [],
      page: 2,
      size: 20,
      totalElements: 287,
      totalPages: 15,
    };
    expect(parseRecentMeetingsPage(fixture, 2)).toMatchObject({ page: 2, totalElements: 287 });
    expect(() => parseRecentMeetingsPage(fixture)).toThrow(
      'meeting list response pagination metadata is invalid',
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

  it('builds the canonical recording lifecycle URL', () => {
    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    expect(recordingLifecycleUrl(cfg, MEETING_ID)).toBe(
      `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/recording-lifecycle`,
    );
    expect(() => recordingLifecycleUrl(cfg, 'MTG-1')).toThrow('canonical UUID');
  });

  it('syncs one allowlisted recording lifecycle projection with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        meetingId: MEETING_ID,
        sessionId: RUN_ID,
        externalSessionId: 'SES-1',
        meetingStatus: 'COMPLETED',
        transcriptStatus: 'PROCESSING',
        startedAt: '2026-07-17T08:43:20Z',
        endedAt: '2026-07-17T08:44:20Z',
        tenantId: 'must-not-cross-main-process',
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
      meetingId: MEETING_ID,
      externalSessionId: 'SES-1',
      startedAt: '2026-07-17T08:43:20Z',
      endedAt: '2026-07-17T08:44:20Z',
    });

    expect(result).toEqual({
      meetingId: MEETING_ID,
      sessionId: RUN_ID,
      externalSessionId: 'SES-1',
      meetingStatus: 'COMPLETED',
      transcriptStatus: 'PROCESSING',
      startedAt: '2026-07-17T08:43:20.000Z',
      endedAt: '2026-07-17T08:44:20.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('tenantId');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://testai.acik.com/api/v1/admin/meetings/${MEETING_ID}/recording-lifecycle`,
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer JWT',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          externalSessionId: 'SES-1',
          startedAt: '2026-07-17T08:43:20.000Z',
          endedAt: '2026-07-17T08:44:20.000Z',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('fails closed when lifecycle success does not confirm the requested state', async () => {
    const response = {
      meetingId: MEETING_ID,
      sessionId: RUN_ID,
      externalSessionId: 'SES-1',
      meetingStatus: 'IN_PROGRESS',
      transcriptStatus: 'PENDING',
      startedAt: '2026-07-17T08:43:20Z',
      endedAt: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => response,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:20Z',
        endedAt: '2026-07-17T08:44:20Z',
      }),
    ).rejects.toThrow('does not confirm the requested finish');

    await expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:19Z',
      }),
    ).rejects.toThrow('startedAt does not match request');
  });

  it('keeps a finish pending when canonical status or transcript processing is unconfirmed', async () => {
    const response = {
      meetingId: MEETING_ID,
      sessionId: RUN_ID,
      externalSessionId: 'SES-1',
      meetingStatus: 'COMPLETED',
      transcriptStatus: 'PENDING',
      startedAt: '2026-07-17T08:43:20Z',
      endedAt: '2026-07-17T08:44:20Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => response,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:20Z',
        endedAt: '2026-07-17T08:44:20Z',
      }),
    ).rejects.toThrow('does not confirm transcript processing');

    response.transcriptStatus = 'PROCESSING';
    response.meetingStatus = 'IN_PROGRESS';
    await expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:20Z',
        endedAt: '2026-07-17T08:44:20Z',
      }),
    ).rejects.toThrow('does not confirm the requested finish');
  });

  it('rejects unknown lifecycle status enums', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          meetingId: MEETING_ID,
          sessionId: RUN_ID,
          externalSessionId: 'SES-1',
          meetingStatus: 'SCHEDULED',
          transcriptStatus: 'PENDING',
          startedAt: '2026-07-17T08:43:20Z',
          endedAt: null,
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );

    await expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:20Z',
      }),
    ).rejects.toThrow('meetingStatus is invalid');
  });

  it('retries transient recording lifecycle errors and keeps error bodies redacted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ transcript: 'must not appear' }),
        body: { cancel: vi.fn() },
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            code: 'MEETING_FORBIDDEN',
            correlationId: 'cid-lifecycle',
            transcript: 'must not appear',
          }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const rejection = expect(
      syncRecordingLifecycle({ baseUrl: 'https://testai.acik.com' }, 'JWT', {
        meetingId: MEETING_ID,
        externalSessionId: 'SES-1',
        startedAt: '2026-07-17T08:43:20Z',
      }),
    ).rejects.toThrow(
      'syncRecordingLifecycle failed: 403 code=MEETING_FORBIDDEN correlationId=cid-lifecycle',
    );
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('normalizes and sends consent-bound speech-context terms in the create body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Desktop contract',
        status: 'SCHEDULED',
        scheduledStart: '2026-06-29T14:30:00.000Z',
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    await createMeetingContract(cfg, 'JWT', {
      title: 'Desktop contract',
      description: 'Recorder test',
      scheduledStart: '2026-06-29T14:30:00.000Z',
      // duplicate spelling collapses, padding trims, case is preserved (STT hint).
      speechContextTerms: ['Açık Holding', 'OpenFGA', '  OpenFGA ', 'openfga', '   '],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://testai.acik.com/api/v1/admin/meetings',
      expect.objectContaining({
        body: JSON.stringify({
          title: 'Desktop contract',
          description: 'Recorder test',
          scheduledStart: '2026-06-29T14:30:00.000Z',
          speechContextTerms: ['Açık Holding', 'OpenFGA', 'openfga'],
        }),
      }),
    );
  });

  it('omits speechContextTerms from the body when no usable term remains', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Desktop contract',
        status: 'SCHEDULED',
        scheduledStart: '2026-06-29T14:30:00.000Z',
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cfg = loadMeetingConfig({ MEETING_BASE_URL: 'https://testai.acik.com' });
    await createMeetingContract(cfg, 'JWT', {
      title: 'Desktop contract',
      description: 'Recorder test',
      scheduledStart: '2026-06-29T14:30:00.000Z',
      speechContextTerms: ['   ', ''],
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse((requestInit as { body: string }).body)).not.toHaveProperty(
      'speechContextTerms',
    );
  });

  it('normalizeSpeechContextTerms caps at 32 terms with first-seen precedence', () => {
    const many = Array.from({ length: 40 }, (_, i) => `term-${i}`);
    const result = normalizeSpeechContextTerms([...many, 'term-0']);
    expect(result).toHaveLength(32);
    expect(result[0]).toBe('term-0');
    expect(result[31]).toBe('term-31');
    expect(normalizeSpeechContextTerms(undefined)).toEqual([]);
    expect(normalizeSpeechContextTerms(['x'.repeat(65)])).toEqual([]);
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

  it('bounds canonical result response body reads and retries the GET safely', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = readMeetingIntelligenceResult(
      { baseUrl: 'https://testai.acik.com' },
      'JWT',
      MEETING_ID,
    );
    const rejection = expect(pending).rejects.toThrow(
      'readMeetingIntelligenceResult failed before response after 3 attempts: network=REQUEST_TIMEOUT',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

// gitops#3587: the reported symptom was "assignee search returns nothing" with
// no way to tell an authorization failure or a contract drift from a genuine
// no-match, because every case produced the same empty list.
describe('assignee directory lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns readable options when the directory answers with numeric ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ id: 42, name: 'Sevil Karakaş', email: 'sevil@acik.com' }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchAssignees({ baseUrl: 'https://testai.acik.com' }, 'JWT', 'sevil'),
    ).resolves.toEqual([{ userId: 42, label: 'Sevil Karakaş (sevil@acik.com)' }]);
  });

  it('keeps a genuine no-match as an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchAssignees({ baseUrl: 'https://testai.acik.com' }, 'JWT', 'yokboyle'),
    ).resolves.toEqual([]);
  });

  it('fails loudly when the directory answers with rows this client cannot read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ id: 'kc-subject-uuid', name: 'Sevil Karakaş' }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchAssignees({ baseUrl: 'https://testai.acik.com' }, 'JWT', 'sevil'),
    ).rejects.toThrow('1 kayıt döndü ancak beklenen alanlar (sayısal id) okunamadı');
  });

  it('surfaces an authorization failure instead of an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"code":"FORBIDDEN"}',
      json: async () => ({ code: 'FORBIDDEN' }),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchAssignees({ baseUrl: 'https://testai.acik.com' }, 'JWT', 'sevil'),
    ).rejects.toThrow(/403/);
  });
});
