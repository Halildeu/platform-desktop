import { desktopFetch } from '../net/desktop-fetch.js';

const API = '/api/v1/admin/meetings';
const CREATE_CONTRACT_MAX_ATTEMPTS = 3;
const CREATE_CONTRACT_RETRY_DELAY_MS = 250;
const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);
const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface MeetingClientConfig {
  baseUrl: string;
}

export interface MeetingContract {
  id: string;
  title: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

export interface CreateMeetingContractArgs {
  title?: string;
  description?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
}

export interface MeetingAiAnalyzeSegment {
  text: string;
  start: number;
  end?: number;
}

export interface MeetingAiAnalyzeRequest {
  transcript: string;
  meeting_id: string;
  session_id?: string | null;
  segments: MeetingAiAnalyzeSegment[];
}

export interface MeetingAiAnalyzeArgs {
  meetingId: string;
  request: MeetingAiAnalyzeRequest;
}

export type MeetingAiAnalyzeResponse = Record<string, unknown> & {
  summary?: string | null;
  decisions?: unknown[] | null;
  action_items?: unknown[] | null;
  citations?: unknown[] | null;
  summary_citations?: unknown[] | null;
};

/** GET .../summary read projection — #244 DT-1 (canonical, persisted analysis run). */
export interface MeetingAnalysisResult {
  meetingId: string;
  analysisRunId: string;
  status: string;
  summary: string | null;
  groundingStatus: string | null;
  analyzerContractVersion: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  generatedAt: string;
}

export interface MeetingDecisionRecord {
  id: string;
  title: string;
  detail: string | null;
  decidedBySubject: string | null;
  decidedAt: string | null;
}

export interface MeetingActionRecord {
  id: string;
  description: string;
  assigneeSubject: string | null;
  status: string;
  dueAt: string | null;
}

export interface MeetingAnalysisSnapshot {
  result: MeetingAnalysisResult | null;
  decisions: MeetingDecisionRecord[];
  actions: MeetingActionRecord[];
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

export function loadMeetingConfig(env: NodeJS.ProcessEnv = process.env): MeetingClientConfig {
  const raw = (env.MEETING_BASE_URL ?? env.GATEWAY_BASE_URL ?? env.KEYCLOAK_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!raw) {
    throw new Error('MEETING_BASE_URL or GATEWAY_BASE_URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('MEETING_BASE_URL must be an absolute URL');
  }

  if (parsed.protocol !== 'https:' && !isLocalHttp(parsed)) {
    throw new Error('MEETING_BASE_URL must use https, except local development URLs');
  }

  return { baseUrl: raw };
}

export function meetingsUrl(cfg: MeetingClientConfig): string {
  return `${cfg.baseUrl}${API}`;
}

export function meetingIntelligenceAnalyzeUrl(cfg: MeetingClientConfig, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return `${meetingsUrl(cfg)}/${meetingId}/intelligence/analyze`;
}

function requireCanonicalMeetingId(meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return meetingId;
}

export function meetingSummaryUrl(cfg: MeetingClientConfig, meetingId: string): string {
  return `${meetingsUrl(cfg)}/${requireCanonicalMeetingId(meetingId)}/summary`;
}

export function meetingDecisionsUrl(cfg: MeetingClientConfig, meetingId: string): string {
  return `${meetingsUrl(cfg)}/${requireCanonicalMeetingId(meetingId)}/decisions`;
}

export function meetingActionsUrl(cfg: MeetingClientConfig, meetingId: string): string {
  return `${meetingsUrl(cfg)}/${requireCanonicalMeetingId(meetingId)}/actions`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(record.code)) {
      return record.code;
    }
    current = record.cause;
  }
  return null;
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }
  return error instanceof TypeError && error.message === 'fetch failed';
}

function retryableNetworkLabel(error: unknown): string {
  return errorCode(error) ?? 'FETCH_FAILED';
}

async function retryDelay(attempt: number): Promise<void> {
  await delay(CREATE_CONTRACT_RETRY_DELAY_MS * attempt);
}

async function httpErrorMessage(res: Response, operation: string): Promise<string> {
  const contentType = res.headers?.get('content-type') ?? '';
  let body = '';
  try {
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch {
    body = '';
  }

  const fields: string[] = [];
  if (contentType.toLowerCase().includes('application/json') && body.trim()) {
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown;
        correlationId?: unknown;
        retryable?: unknown;
      };
      if (typeof parsed.code === 'string' && /^[A-Z_]{1,64}$/.test(parsed.code)) {
        fields.push(`code=${parsed.code}`);
      }
      if (
        typeof parsed.correlationId === 'string' &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(parsed.correlationId)
      ) {
        fields.push(`correlationId=${parsed.correlationId}`);
      }
      if (typeof parsed.retryable === 'boolean') {
        fields.push(`retryable=${String(parsed.retryable)}`);
      }
    } catch {
      fields.push('response=unparseable');
    }
  } else if (contentType) {
    fields.push(`contentType=${contentType}`);
  }

  const suffix = fields.length > 0 ? ` ${fields.join(' ')}` : '';
  return `${operation} failed: ${res.status}${suffix}`;
}

function normalizeTitle(title: string | undefined): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return trimmed.slice(0, 512);
  }
  return `Desktop recorder ${new Date().toISOString()}`;
}

function parseMeetingContract(value: unknown): MeetingContract {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting-service response is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !MEETING_ID_PATTERN.test(record.id)) {
    throw new Error('meeting-service response id is not a canonical UUID');
  }
  if (typeof record.title !== 'string' || !record.title.trim()) {
    throw new Error('meeting-service response title is missing');
  }
  if (typeof record.status !== 'string' || !record.status.trim()) {
    throw new Error('meeting-service response status is missing');
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    scheduledStart: typeof record.scheduledStart === 'string' ? record.scheduledStart : null,
    scheduledEnd: typeof record.scheduledEnd === 'string' ? record.scheduledEnd : null,
  };
}

function parseMeetingAiAnalyzeResponse(value: unknown): MeetingAiAnalyzeResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting-ai response is not an object');
  }
  const record = value as Record<string, unknown>;
  const arrayFields = [
    'decisions',
    'action_items',
    'citations',
    'summary_citations',
    'rejected_claims',
  ];
  for (const field of arrayFields) {
    if (record[field] !== undefined && record[field] !== null && !Array.isArray(record[field])) {
      throw new Error(`meeting-ai response ${field} is not an array`);
    }
  }
  if (
    record.summary !== undefined &&
    record.summary !== null &&
    typeof record.summary !== 'string'
  ) {
    throw new Error('meeting-ai response summary is not a string');
  }
  return record as MeetingAiAnalyzeResponse;
}

function parseMeetingAnalysisResult(value: unknown): MeetingAnalysisResult {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting-service summary response is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.meetingId !== 'string' || typeof record.analysisRunId !== 'string') {
    throw new Error('meeting-service summary response is missing meetingId/analysisRunId');
  }
  if (typeof record.status !== 'string' || typeof record.generatedAt !== 'string') {
    throw new Error('meeting-service summary response is missing status/generatedAt');
  }
  const optionalString = (field: unknown): string | null =>
    typeof field === 'string' ? field : null;
  return {
    meetingId: record.meetingId,
    analysisRunId: record.analysisRunId,
    status: record.status,
    summary: optionalString(record.summary),
    groundingStatus: optionalString(record.groundingStatus),
    analyzerContractVersion: optionalString(record.analyzerContractVersion),
    modelVersion: optionalString(record.modelVersion),
    promptVersion: optionalString(record.promptVersion),
    generatedAt: record.generatedAt,
  };
}

function parseMeetingDecisionRecord(value: unknown): MeetingDecisionRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    detail: typeof record.detail === 'string' ? record.detail : null,
    decidedBySubject: typeof record.decidedBySubject === 'string' ? record.decidedBySubject : null,
    decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : null,
  };
}

function parseMeetingActionRecord(value: unknown): MeetingActionRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.description !== 'string') {
    return null;
  }
  return {
    id: record.id,
    description: record.description,
    assigneeSubject: typeof record.assigneeSubject === 'string' ? record.assigneeSubject : null,
    status: typeof record.status === 'string' ? record.status : 'OPEN',
    dueAt: typeof record.dueAt === 'string' ? record.dueAt : null,
  };
}

/** GET .../summary — canonical analysis run, or null if the meeting has none persisted yet. */
export async function getMeetingAnalysisResult(
  cfg: MeetingClientConfig,
  jwt: string,
  meetingId: string,
): Promise<MeetingAnalysisResult | null> {
  const res = await desktopFetch(meetingSummaryUrl(cfg, meetingId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'getMeetingAnalysisResult'));
  }
  return parseMeetingAnalysisResult(await res.json());
}

/** GET .../decisions — all persisted decisions for the meeting. */
export async function listMeetingDecisions(
  cfg: MeetingClientConfig,
  jwt: string,
  meetingId: string,
): Promise<MeetingDecisionRecord[]> {
  const res = await desktopFetch(meetingDecisionsUrl(cfg, meetingId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'listMeetingDecisions'));
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error('meeting-service decisions response is not an array');
  }
  return body
    .map(parseMeetingDecisionRecord)
    .filter((item): item is MeetingDecisionRecord => item !== null);
}

/** GET .../actions — all persisted action items for the meeting. */
export async function listMeetingActions(
  cfg: MeetingClientConfig,
  jwt: string,
  meetingId: string,
): Promise<MeetingActionRecord[]> {
  const res = await desktopFetch(meetingActionsUrl(cfg, meetingId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'listMeetingActions'));
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error('meeting-service actions response is not an array');
  }
  return body
    .map(parseMeetingActionRecord)
    .filter((item): item is MeetingActionRecord => item !== null);
}

/**
 * Combined read of the meeting-service system-of-record — #244 DT-1. If no
 * canonical run has been persisted yet (fresh meeting, ingestion still
 * pending), `result` is null and decisions/actions are not fetched.
 */
export async function readMeetingAnalysisSnapshot(
  cfg: MeetingClientConfig,
  jwt: string,
  meetingId: string,
): Promise<MeetingAnalysisSnapshot> {
  const result = await getMeetingAnalysisResult(cfg, jwt, meetingId);
  if (!result) {
    return { result: null, decisions: [], actions: [] };
  }
  const [decisions, actions] = await Promise.all([
    listMeetingDecisions(cfg, jwt, meetingId),
    listMeetingActions(cfg, jwt, meetingId),
  ]);
  return { result, decisions, actions };
}

export async function createMeetingContract(
  cfg: MeetingClientConfig,
  jwt: string,
  args: CreateMeetingContractArgs = {},
): Promise<MeetingContract> {
  const body = {
    title: normalizeTitle(args.title),
    description: args.description?.slice(0, 4000) ?? 'Faz 24 desktop recorder contract.',
    scheduledStart: args.scheduledStart ?? new Date().toISOString(),
    scheduledEnd: args.scheduledEnd,
  };

  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  for (let attempt = 1; attempt <= CREATE_CONTRACT_MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await desktopFetch(meetingsUrl(cfg), requestInit);
    } catch (error) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && isRetryableNetworkError(error)) {
        await retryDelay(attempt);
        continue;
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `createMeetingContract failed before response after ${attempt} attempts: network=${retryableNetworkLabel(
            error,
          )}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (!res.ok) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && RETRYABLE_HTTP_STATUS.has(res.status)) {
        await retryDelay(attempt);
        continue;
      }
      throw new Error(await httpErrorMessage(res, 'createMeetingContract'));
    }
    return parseMeetingContract(await res.json());
  }

  throw new Error('createMeetingContract failed: retry loop exhausted');
}

export async function analyzeMeetingIntelligence(
  cfg: MeetingClientConfig,
  jwt: string,
  args: MeetingAiAnalyzeArgs,
): Promise<MeetingAiAnalyzeResponse> {
  const body = {
    ...args.request,
    meeting_id: args.meetingId,
    segments: args.request.segments ?? [],
  };
  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  for (let attempt = 1; attempt <= CREATE_CONTRACT_MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await desktopFetch(meetingIntelligenceAnalyzeUrl(cfg, args.meetingId), requestInit);
    } catch (error) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && isRetryableNetworkError(error)) {
        await retryDelay(attempt);
        continue;
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `analyzeMeetingIntelligence failed before response after ${attempt} attempts: network=${retryableNetworkLabel(
            error,
          )}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (!res.ok) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && RETRYABLE_HTTP_STATUS.has(res.status)) {
        await retryDelay(attempt);
        continue;
      }
      throw new Error(await httpErrorMessage(res, 'analyzeMeetingIntelligence'));
    }

    return parseMeetingAiAnalyzeResponse(await res.json());
  }

  throw new Error('analyzeMeetingIntelligence failed: retry loop exhausted');
}
