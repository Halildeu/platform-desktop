import { desktopFetch, withDesktopFetchDeadline } from '../net/desktop-fetch.js';
import {
  type PublicRuntimeConfigLoadOptions,
  resolvePublicRuntimeEnvironment,
} from '../public-runtime-config.js';

const API = '/api/v1/admin/meetings';
const CREATE_CONTRACT_MAX_ATTEMPTS = 3;
const CREATE_CONTRACT_RETRY_DELAY_MS = 250;
const RECORDING_LIFECYCLE_ATTEMPT_TIMEOUT_MS = 4_000;
const INTELLIGENCE_RESULT_ATTEMPT_TIMEOUT_MS = 8_000;
const RECENT_MEETINGS_DEFAULT_SIZE = 20;
const RECENT_MEETINGS_MAX_SIZE = 50;
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
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface RecentMeetingSummary {
  id: string;
  title: string;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecentMeetingsPage {
  meetings: RecentMeetingSummary[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface CreateMeetingContractArgs {
  title?: string;
  description?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  /**
   * Faz 24 STT (platform-backend#1024): consent-bound speech-context terms persisted on the
   * canonical meeting contract. The audio gateway later merges these ahead of the recorder's
   * own session terms before Speechmatics additional_vocab, so setting them here biases live
   * transcription for every recording of this meeting. Bounded to 32 terms of <=64 chars.
   */
  speechContextTerms?: string[];
}

/** Mirrors meeting-service SpeechContextTerms + the gateway merger: NFKC, whitespace collapse,
 *  drop blank/oversized, case-sensitive exact dedupe, cap 32. Case matters (STT spelling hint). */
export const MAX_SPEECH_CONTEXT_TERMS = 32;
export const MAX_SPEECH_CONTEXT_TERM_LENGTH = 64;
export function normalizeSpeechContextTerms(terms: readonly string[] | undefined): string[] {
  if (!terms) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    if (out.length >= MAX_SPEECH_CONTEXT_TERMS) {
      break;
    }
    if (typeof raw !== 'string') {
      continue;
    }
    const term = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!term || term.length > MAX_SPEECH_CONTEXT_TERM_LENGTH || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}

export interface RecordingLifecycleSyncArgs {
  meetingId: string;
  externalSessionId: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface RecordingLifecycleResponse {
  meetingId: string;
  sessionId: string;
  externalSessionId: string;
  meetingStatus: string;
  transcriptStatus: string;
  startedAt: string;
  endedAt: string | null;
}

const RECORDING_MEETING_STATUSES = new Set(['IN_PROGRESS', 'COMPLETED']);
const TRANSCRIPT_STATUSES = new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);

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

export interface MeetingIntelligenceCitationResponse {
  claim: string;
  source_index: number;
  start_sec: number | null;
  source_hash: string;
  quote_hash: string;
}

export interface MeetingIntelligenceActionItemResponse {
  text: string;
  owner: string | null;
  due_date: string | null;
}

export interface MeetingIntelligenceCanonicalResponse {
  analysisRunId: string;
  meetingId: string;
  sessionId: string;
  schema_version: string;
  model: string | null;
  backend: string | null;
  summary: string;
  summaryGroundingStatus: string | null;
  summary_citations: MeetingIntelligenceCitationResponse[];
  decisions: string[];
  action_items: MeetingIntelligenceActionItemResponse[];
  citations: MeetingIntelligenceCitationResponse[];
  generatedAt: string;
  persisted: true;
  storageMode: 'canonical';
}

export type MeetingIntelligenceReadOutcome =
  | { status: 'ready'; result: MeetingIntelligenceCanonicalResponse }
  | { status: 'not_ready' };

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

export function loadMeetingConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: PublicRuntimeConfigLoadOptions = {},
): MeetingClientConfig {
  const resolvedEnv = resolvePublicRuntimeEnvironment(env, options).env;
  const raw = (
    resolvedEnv.MEETING_BASE_URL ??
    resolvedEnv.GATEWAY_BASE_URL ??
    resolvedEnv.KEYCLOAK_BASE_URL ??
    ''
  ).replace(/\/+$/, '');
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

export const RECENT_MEETINGS_MAX_PAGE = 1_000;
export const RECENT_MEETINGS_MAX_TITLE_QUERY = 100;

export interface RecentMeetingsQuery {
  /** Zero-based page; later pages reach meetings beyond the first 20 (desktop list). */
  page?: number;
  /** Case-insensitive title search, served by meeting-service `title=`. */
  title?: string;
}

export function normalizeRecentMeetingsQuery(query: RecentMeetingsQuery = {}): {
  page: number;
  title: string | null;
} {
  const rawPage = Number.isFinite(query.page) ? Math.trunc(query.page as number) : 0;
  const page = Math.min(RECENT_MEETINGS_MAX_PAGE, Math.max(0, rawPage));
  const title = typeof query.title === 'string' ? query.title.trim() : '';
  if (title.length > RECENT_MEETINGS_MAX_TITLE_QUERY) {
    throw new Error('meeting title search is too long');
  }
  return { page, title: title === '' ? null : title };
}

export function recentMeetingsUrl(
  cfg: MeetingClientConfig,
  size = RECENT_MEETINGS_DEFAULT_SIZE,
  query: RecentMeetingsQuery = {},
): string {
  const normalizedSize = Number.isFinite(size) ? Math.trunc(size) : RECENT_MEETINGS_DEFAULT_SIZE;
  const boundedSize = Math.min(RECENT_MEETINGS_MAX_SIZE, Math.max(1, normalizedSize));
  const { page, title } = normalizeRecentMeetingsQuery(query);
  const titleParam = title === null ? '' : `&title=${encodeURIComponent(title)}`;
  return `${meetingsUrl(cfg)}?page=${page}&size=${boundedSize}${titleParam}`;
}

export function meetingIntelligenceAnalyzeUrl(cfg: MeetingClientConfig, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return `${meetingsUrl(cfg)}/${meetingId}/intelligence/analyze`;
}

export function meetingIntelligenceResultUrl(cfg: MeetingClientConfig, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return `${meetingsUrl(cfg)}/${meetingId}/intelligence/result`;
}

export function recordingLifecycleUrl(cfg: MeetingClientConfig, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return `${meetingsUrl(cfg)}/${meetingId}/recording-lifecycle`;
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
  if (
    error &&
    typeof error === 'object' &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error as { name?: unknown }).name === 'TimeoutError')
  ) {
    return true;
  }
  return error instanceof TypeError && error.message === 'fetch failed';
}

function retryableNetworkLabel(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
  ) {
    const name = (error as { name: string }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return 'REQUEST_TIMEOUT';
    }
  }
  return errorCode(error) ?? 'FETCH_FAILED';
}

async function retryDelay(attempt: number): Promise<void> {
  await delay(CREATE_CONTRACT_RETRY_DELAY_MS * attempt);
}

function discardResponseBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => undefined);
  } catch {
    // Retry remains authoritative; a best-effort body close must not mask it.
  }
}

interface SafeHttpErrorMetadata {
  code: string | null;
  suffix: string;
}

async function safeHttpErrorMetadata(res: Response): Promise<SafeHttpErrorMetadata> {
  const contentType = res.headers?.get('content-type') ?? '';
  let body = '';
  try {
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch {
    body = '';
  }

  const fields: string[] = [];
  let code: string | null = null;
  if (contentType.toLowerCase().includes('application/json') && body.trim()) {
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown;
        error?: unknown;
        correlationId?: unknown;
        traceId?: unknown;
        retryable?: unknown;
      };
      const parsedCode = parsed.code ?? parsed.error;
      if (typeof parsedCode === 'string' && /^[A-Z_]{1,64}$/.test(parsedCode)) {
        code = parsedCode;
        fields.push(`code=${parsedCode}`);
      }
      const parsedCorrelationId = parsed.correlationId ?? parsed.traceId;
      if (
        typeof parsedCorrelationId === 'string' &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(parsedCorrelationId)
      ) {
        fields.push(`correlationId=${parsedCorrelationId}`);
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

  return {
    code,
    suffix: fields.length > 0 ? ` ${fields.join(' ')}` : '',
  };
}

async function httpErrorMessage(res: Response, operation: string): Promise<string> {
  const metadata = await safeHttpErrorMetadata(res);
  return `${operation} failed: ${res.status}${metadata.suffix}`;
}

function normalizeTitle(title: string | undefined): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return trimmed.slice(0, 512);
  }
  return `Desktop recorder ${new Date().toISOString()}`;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is not a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function canonicalIsoInstant(value: unknown, label: string): string {
  const instant = boundedString(value, label, 64);
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) {
    throw new Error(`${label} is not an ISO instant`);
  }
  return new Date(epoch).toISOString();
}

function optionalCanonicalIsoInstant(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return canonicalIsoInstant(value, label);
}

function boundedInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function parseMeetingContract(value: unknown): MeetingContract {
  const record = requiredRecord(value, 'meeting-service response');
  const id = boundedString(record.id, 'meeting-service response id', 36);
  if (!MEETING_ID_PATTERN.test(id)) {
    throw new Error('meeting-service response id is not a canonical UUID');
  }
  return {
    id,
    title: boundedString(record.title, 'meeting-service response title', 512),
    status: boundedString(record.status, 'meeting-service response status', 64),
    scheduledStart: optionalCanonicalIsoInstant(
      record.scheduledStart,
      'meeting-service response scheduledStart',
    ),
    scheduledEnd: optionalCanonicalIsoInstant(
      record.scheduledEnd,
      'meeting-service response scheduledEnd',
    ),
    createdAt: optionalCanonicalIsoInstant(record.createdAt, 'meeting-service response createdAt'),
    updatedAt: optionalCanonicalIsoInstant(record.updatedAt, 'meeting-service response updatedAt'),
  };
}

function parseRecordingLifecycleResponse(
  value: unknown,
  expected: RecordingLifecycleSyncArgs,
): RecordingLifecycleResponse {
  const label = 'recording lifecycle response';
  const record = requiredRecord(value, label);
  const meetingId = requiredCanonicalUuid(record.meetingId, `${label}.meetingId`);
  if (meetingId !== expected.meetingId) {
    throw new Error(`${label} meetingId does not match request`);
  }
  const externalSessionId = boundedString(
    record.externalSessionId,
    `${label}.externalSessionId`,
    128,
  );
  if (externalSessionId !== expected.externalSessionId) {
    throw new Error(`${label} externalSessionId does not match request`);
  }

  const meetingStatus = boundedString(record.meetingStatus, `${label}.meetingStatus`, 64);
  if (!RECORDING_MEETING_STATUSES.has(meetingStatus)) {
    throw new Error(`${label}.meetingStatus is invalid`);
  }
  const transcriptStatus = boundedString(record.transcriptStatus, `${label}.transcriptStatus`, 64);
  if (!TRANSCRIPT_STATUSES.has(transcriptStatus)) {
    throw new Error(`${label}.transcriptStatus is invalid`);
  }
  const startedAt = canonicalIsoInstant(record.startedAt, `${label}.startedAt`);
  if (Date.parse(startedAt) !== Date.parse(expected.startedAt)) {
    throw new Error(`${label}.startedAt does not match request`);
  }
  const endedAt = optionalCanonicalIsoInstant(record.endedAt, `${label}.endedAt`);
  if (expected.endedAt === null) {
    if (endedAt !== null || meetingStatus !== 'IN_PROGRESS') {
      throw new Error(`${label} does not confirm an active recording`);
    }
  } else {
    if (
      endedAt === null ||
      Date.parse(endedAt) !== Date.parse(expected.endedAt ?? '') ||
      meetingStatus !== 'COMPLETED'
    ) {
      throw new Error(`${label} does not confirm the requested finish`);
    }
    if (transcriptStatus !== 'PROCESSING' && transcriptStatus !== 'COMPLETED') {
      throw new Error(`${label} does not confirm transcript processing`);
    }
  }

  return {
    meetingId,
    sessionId: requiredCanonicalUuid(record.sessionId, `${label}.sessionId`),
    externalSessionId,
    meetingStatus,
    transcriptStatus,
    startedAt,
    endedAt,
  };
}

function parseRecentMeetingSummary(value: unknown, index: number): RecentMeetingSummary {
  const record = requiredRecord(value, `meeting list content[${index}]`);
  const id = boundedString(record.id, `meeting list content[${index}].id`, 36);
  if (!MEETING_ID_PATTERN.test(id)) {
    throw new Error(`meeting list content[${index}].id is not a canonical UUID`);
  }
  return {
    id,
    title: boundedString(record.title, `meeting list content[${index}].title`, 512),
    status: boundedString(record.status, `meeting list content[${index}].status`, 64),
    scheduledStart: optionalCanonicalIsoInstant(
      record.scheduledStart,
      `meeting list content[${index}].scheduledStart`,
    ),
    scheduledEnd: optionalCanonicalIsoInstant(
      record.scheduledEnd,
      `meeting list content[${index}].scheduledEnd`,
    ),
    createdAt: canonicalIsoInstant(record.createdAt, `meeting list content[${index}].createdAt`),
    updatedAt: canonicalIsoInstant(record.updatedAt, `meeting list content[${index}].updatedAt`),
  };
}

export function parseRecentMeetingsPage(value: unknown, expectedPage = 0): RecentMeetingsPage {
  const record = requiredRecord(value, 'meeting list response');
  if (!Array.isArray(record.content)) {
    throw new Error('meeting list response content is not an array');
  }
  if (record.content.length > RECENT_MEETINGS_MAX_SIZE) {
    throw new Error('meeting list response content exceeds the client limit');
  }

  const page = boundedInteger(record.page, 'meeting list response page', 0);
  const size = boundedInteger(record.size, 'meeting list response size', 1);
  const totalElements = boundedInteger(
    record.totalElements,
    'meeting list response totalElements',
    0,
  );
  const totalPages = boundedInteger(record.totalPages, 'meeting list response totalPages', 0);
  if (page !== expectedPage || size > RECENT_MEETINGS_MAX_SIZE || record.content.length > size) {
    throw new Error('meeting list response pagination metadata is invalid');
  }

  const meetings = record.content.map(parseRecentMeetingSummary);
  if (new Set(meetings.map((meeting) => meeting.id)).size !== meetings.length) {
    throw new Error('meeting list response contains duplicate meeting ids');
  }

  return {
    meetings,
    page,
    size,
    totalElements,
    totalPages,
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

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function requiredCanonicalUuid(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!MEETING_ID_PATTERN.test(text)) {
    throw new Error(`${label} is not a canonical UUID`);
  }
  return text;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is not a non-negative integer`);
  }
  return value as number;
}

function requiredUnitNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} is not between 0 and 1`);
  }
  return value;
}

function parseCanonicalCitation(
  value: unknown,
  label: string,
): MeetingIntelligenceCitationResponse {
  const record = requiredRecord(value, label);
  const sourceCharStart = requiredNonNegativeInteger(
    record.source_char_start,
    `${label}.source_char_start`,
  );
  const sourceCharEnd = requiredNonNegativeInteger(
    record.source_char_end,
    `${label}.source_char_end`,
  );
  if (sourceCharEnd <= sourceCharStart) {
    throw new Error(`${label}.source_char_end must be greater than source_char_start`);
  }
  const sourceHash = requiredString(record.source_hash, `${label}.source_hash`);
  const quoteHash = requiredString(record.quote_hash, `${label}.quote_hash`);
  if (!/^[0-9a-fA-F]{64}$/.test(sourceHash) || !/^[0-9a-fA-F]{64}$/.test(quoteHash)) {
    throw new Error(`${label} hashes are not SHA-256 hex`);
  }
  const startSec = record.start_sec;
  if (
    startSec !== undefined &&
    startSec !== null &&
    (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0)
  ) {
    throw new Error(`${label}.start_sec is invalid`);
  }
  if (record.grounded !== true || record.status !== 'PASSED') {
    throw new Error(`${label} is not grounded evidence`);
  }

  return {
    claim: requiredString(record.claim, `${label}.claim`),
    source_index: requiredNonNegativeInteger(record.source_index, `${label}.source_index`),
    start_sec: typeof startSec === 'number' ? startSec : null,
    source_hash: sourceHash,
    quote_hash: quoteHash,
  };
}

function parseCanonicalCitations(
  value: unknown,
  label: string,
): MeetingIntelligenceCitationResponse[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((item, index) => parseCanonicalCitation(item, `${label}[${index}]`));
}

function validateCanonicalRejectedClaims(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('meeting intelligence result rejected_claims is not an array');
  }
  value.forEach((item, index) => {
    const label = `meeting intelligence result rejected_claims[${index}]`;
    const record = requiredRecord(item, label);
    requiredString(record.claim, `${label}.claim`);
    requiredString(record.kind, `${label}.kind`);
    requiredString(record.status, `${label}.status`);
    requiredString(record.reason, `${label}.reason`);
    requiredUnitNumber(record.similarity, `${label}.similarity`);
  });
}

function parseCanonicalDecisions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('meeting intelligence result decisions is not an array');
  }
  return value.map((item, index) => requiredString(item, `decisions[${index}]`));
}

function parseCanonicalActions(value: unknown): MeetingIntelligenceActionItemResponse[] {
  if (!Array.isArray(value)) {
    throw new Error('meeting intelligence result action_items is not an array');
  }
  return value.map((item, index) => {
    const label = `meeting intelligence result action_items[${index}]`;
    const record = requiredRecord(item, label);
    return {
      text: requiredString(record.text, `${label}.text`),
      owner: nullableString(record.owner, `${label}.owner`),
      due_date: nullableString(record.due_date, `${label}.due_date`),
    };
  });
}

export function parseMeetingIntelligenceCanonicalResponse(
  value: unknown,
  expectedMeetingId: string,
): MeetingIntelligenceCanonicalResponse {
  const label = 'meeting intelligence result';
  const record = requiredRecord(value, label);
  const meetingId = requiredCanonicalUuid(record.meetingId, `${label}.meetingId`);
  if (meetingId !== expectedMeetingId) {
    throw new Error('meeting intelligence result meetingId does not match request');
  }
  const generatedAt = requiredString(record.generatedAt, `${label}.generatedAt`);
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('meeting intelligence result generatedAt is invalid');
  }
  if (record.persisted !== true || record.storageMode !== 'canonical') {
    throw new Error('meeting intelligence result is not a canonical persisted snapshot');
  }
  if (typeof record.redacted !== 'boolean') {
    throw new Error('meeting intelligence result redacted is not a boolean');
  }
  requiredNonNegativeInteger(record.ungrounded_count, `${label}.ungrounded_count`);
  requiredNonNegativeInteger(record.redaction_count, `${label}.redaction_count`);
  validateCanonicalRejectedClaims(record.rejected_claims);
  nullableString(record.promptVersion, `${label}.promptVersion`);
  const summaryGroundingStatus = nullableString(
    record.summary_grounding_status,
    `${label}.summary_grounding_status`,
  );
  if (record.supersedesAnalysisRunId !== undefined && record.supersedesAnalysisRunId !== null) {
    requiredCanonicalUuid(record.supersedesAnalysisRunId, `${label}.supersedesAnalysisRunId`);
  }

  return {
    analysisRunId: requiredCanonicalUuid(record.analysisRunId, `${label}.analysisRunId`),
    meetingId,
    sessionId: requiredString(record.sessionId, `${label}.sessionId`),
    schema_version: requiredString(record.schema_version, `${label}.schema_version`),
    model: nullableString(record.model, `${label}.model`),
    backend: nullableString(record.backend, `${label}.backend`),
    summary: requiredText(record.summary, `${label}.summary`),
    summaryGroundingStatus,
    summary_citations: parseCanonicalCitations(
      record.summary_citations,
      `${label}.summary_citations`,
    ),
    decisions: parseCanonicalDecisions(record.decisions),
    action_items: parseCanonicalActions(record.action_items),
    citations: parseCanonicalCitations(record.citations, `${label}.citations`),
    generatedAt: new Date(generatedAt).toISOString(),
    persisted: true,
    storageMode: 'canonical',
  };
}

export async function createMeetingContract(
  cfg: MeetingClientConfig,
  jwt: string,
  args: CreateMeetingContractArgs = {},
): Promise<MeetingContract> {
  const speechContextTerms = normalizeSpeechContextTerms(args.speechContextTerms);
  const body = {
    title: normalizeTitle(args.title),
    description: args.description?.slice(0, 4000) ?? 'Faz 24 desktop recorder contract.',
    scheduledStart: args.scheduledStart ?? new Date().toISOString(),
    scheduledEnd: args.scheduledEnd,
    // Omit when empty so the meeting contract stays byte-identical for term-less recordings.
    ...(speechContextTerms.length > 0 ? { speechContextTerms } : {}),
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
        discardResponseBody(res);
        await retryDelay(attempt);
        continue;
      }
      throw new Error(await httpErrorMessage(res, 'createMeetingContract'));
    }
    return parseMeetingContract(await res.json());
  }

  throw new Error('createMeetingContract failed: retry loop exhausted');
}

export async function syncRecordingLifecycle(
  cfg: MeetingClientConfig,
  jwt: string,
  args: RecordingLifecycleSyncArgs,
): Promise<RecordingLifecycleResponse> {
  const startedAt = canonicalIsoInstant(args.startedAt, 'recording lifecycle startedAt');
  const endedAt = optionalCanonicalIsoInstant(args.endedAt, 'recording lifecycle endedAt');
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error('recording lifecycle endedAt must not be before startedAt');
  }
  const externalSessionId = boundedString(
    args.externalSessionId,
    'recording lifecycle externalSessionId',
    128,
  );
  if (!/^[A-Za-z0-9._:-]+$/.test(externalSessionId)) {
    throw new Error('recording lifecycle externalSessionId has invalid format');
  }
  const normalizedArgs = {
    ...args,
    externalSessionId,
    startedAt,
    endedAt,
  };
  const requestInit = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ externalSessionId, startedAt, endedAt }),
  };

  for (let attempt = 1; attempt <= CREATE_CONTRACT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withDesktopFetchDeadline(
        recordingLifecycleUrl(cfg, args.meetingId),
        requestInit,
        RECORDING_LIFECYCLE_ATTEMPT_TIMEOUT_MS,
        'syncRecordingLifecycle',
        async (response) => {
          if (!response.ok) {
            if (
              attempt < CREATE_CONTRACT_MAX_ATTEMPTS &&
              RETRYABLE_HTTP_STATUS.has(response.status)
            ) {
              discardResponseBody(response);
              throw Object.assign(new Error('retryable lifecycle response'), {
                code: 'RETRYABLE_LIFECYCLE_RESPONSE',
              });
            }
            throw new Error(await httpErrorMessage(response, 'syncRecordingLifecycle'));
          }
          return parseRecordingLifecycleResponse(await response.json(), normalizedArgs);
        },
      );
    } catch (error) {
      const retryableLifecycleResponse = errorCode(error) === 'RETRYABLE_LIFECYCLE_RESPONSE';
      if (
        attempt < CREATE_CONTRACT_MAX_ATTEMPTS &&
        (isRetryableNetworkError(error) || retryableLifecycleResponse)
      ) {
        await retryDelay(attempt);
        continue;
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `syncRecordingLifecycle failed before response after ${attempt} attempts: network=${retryableNetworkLabel(
            error,
          )}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error('syncRecordingLifecycle failed: retry loop exhausted');
}

export async function listRecentMeetings(
  cfg: MeetingClientConfig,
  jwt: string,
  size = RECENT_MEETINGS_DEFAULT_SIZE,
  query: RecentMeetingsQuery = {},
): Promise<RecentMeetingsPage> {
  const { page } = normalizeRecentMeetingsQuery(query);
  const requestInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      'Cache-Control': 'no-store',
    },
  };

  for (let attempt = 1; attempt <= CREATE_CONTRACT_MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await desktopFetch(recentMeetingsUrl(cfg, size, query), requestInit);
    } catch (error) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && isRetryableNetworkError(error)) {
        await retryDelay(attempt);
        continue;
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `listRecentMeetings failed before response after ${attempt} attempts: network=${retryableNetworkLabel(
            error,
          )}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (!res.ok) {
      if (attempt < CREATE_CONTRACT_MAX_ATTEMPTS && RETRYABLE_HTTP_STATUS.has(res.status)) {
        discardResponseBody(res);
        await retryDelay(attempt);
        continue;
      }
      throw new Error(await httpErrorMessage(res, 'listRecentMeetings'));
    }

    return parseRecentMeetingsPage(await res.json(), page);
  }

  throw new Error('listRecentMeetings failed: retry loop exhausted');
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
        discardResponseBody(res);
        await retryDelay(attempt);
        continue;
      }
      throw new Error(await httpErrorMessage(res, 'analyzeMeetingIntelligence'));
    }

    return parseMeetingAiAnalyzeResponse(await res.json());
  }

  throw new Error('analyzeMeetingIntelligence failed: retry loop exhausted');
}

export async function readMeetingIntelligenceResult(
  cfg: MeetingClientConfig,
  jwt: string,
  meetingId: string,
): Promise<MeetingIntelligenceReadOutcome> {
  const requestInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      'Cache-Control': 'no-store',
    },
  };

  for (let attempt = 1; attempt <= CREATE_CONTRACT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withDesktopFetchDeadline(
        meetingIntelligenceResultUrl(cfg, meetingId),
        requestInit,
        INTELLIGENCE_RESULT_ATTEMPT_TIMEOUT_MS,
        'readMeetingIntelligenceResult',
        async (response) => {
          if (response.status === 404) {
            const metadata = await safeHttpErrorMetadata(response);
            if (metadata.code === 'ANALYSIS_RESULT_NOT_FOUND') {
              return { status: 'not_ready' };
            }
            throw new Error(`readMeetingIntelligenceResult failed: 404${metadata.suffix}`);
          }
          if (!response.ok) {
            if (
              attempt < CREATE_CONTRACT_MAX_ATTEMPTS &&
              RETRYABLE_HTTP_STATUS.has(response.status)
            ) {
              discardResponseBody(response);
              throw Object.assign(new Error('retryable intelligence result response'), {
                code: 'RETRYABLE_INTELLIGENCE_RESULT_RESPONSE',
              });
            }
            throw new Error(await httpErrorMessage(response, 'readMeetingIntelligenceResult'));
          }
          return {
            status: 'ready',
            result: parseMeetingIntelligenceCanonicalResponse(await response.json(), meetingId),
          };
        },
      );
    } catch (error) {
      const retryableResponse = errorCode(error) === 'RETRYABLE_INTELLIGENCE_RESULT_RESPONSE';
      if (
        attempt < CREATE_CONTRACT_MAX_ATTEMPTS &&
        (isRetryableNetworkError(error) || retryableResponse)
      ) {
        await retryDelay(attempt);
        continue;
      }
      if (isRetryableNetworkError(error)) {
        throw new Error(
          `readMeetingIntelligenceResult failed before response after ${attempt} attempts: network=${retryableNetworkLabel(
            error,
          )}`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error('readMeetingIntelligenceResult failed: retry loop exhausted');
}

// ── Faz 24 Görevler dilim-3 (gitops#3486): live-panel task assignment ───────
//
// The live panel turns an analyzer action item into a platform task by
// calling the same admin CRUD the web Görevler panel uses. Create is NOT
// retried: the endpoint is not idempotent and a duplicated task is worse
// than a surfaced failure.

const ACTION_ATTEMPT_TIMEOUT_MS = 6_000;
const ASSIGNEE_SEARCH_MAX_QUERY = 128;

export interface MeetingActionRecord {
  id: string;
  meetingId: string;
  description: string;
  assigneeSubject: string | null;
  status: string;
  dueAt: string | null;
  version: number;
}

export interface CreateMeetingActionArgs {
  meetingId: string;
  description: string;
  assigneeSubject?: string | null;
  /** gitops#3507: numeric public-directory id; backend resolves it to the KC subject. */
  assigneeUserId?: number | null;
  dueAt?: string | null;
}

export interface AssigneeOption {
  /** Numeric public-directory id (kcSubject is server-to-server by design). */
  userId: number;
  label: string;
}

export function meetingActionsUrl(cfg: MeetingClientConfig, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return `${meetingsUrl(cfg)}/${meetingId}/actions`;
}

export function assigneeSearchUrl(cfg: MeetingClientConfig, query: string): string {
  const params = new URLSearchParams({ search: query, pageSize: '10' });
  return `${cfg.baseUrl}/api/v1/users?${params.toString()}`;
}

function parseMeetingActionRecord(value: unknown): MeetingActionRecord {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting action response must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    id: requiredString(record.id, 'meeting action id'),
    meetingId: requiredCanonicalUuid(record.meetingId, 'meeting action meetingId'),
    description: requiredString(record.description, 'meeting action description'),
    assigneeSubject: nullableString(record.assigneeSubject, 'meeting action assigneeSubject'),
    status: requiredString(record.status, 'meeting action status'),
    dueAt: nullableString(record.dueAt, 'meeting action dueAt'),
    version: typeof record.version === 'number' ? record.version : 0,
  };
}

export async function createMeetingAction(
  cfg: MeetingClientConfig,
  jwt: string,
  args: CreateMeetingActionArgs,
): Promise<MeetingActionRecord> {
  const description = boundedString(args.description, 'meeting action description', 2000);
  // Backend rejects both identity forms at once (400); send exactly one.
  const body = {
    description,
    assigneeSubject: args.assigneeUserId != null ? null : (args.assigneeSubject ?? null),
    assigneeUserId: args.assigneeUserId ?? null,
    dueAt: args.dueAt ? canonicalIsoInstant(args.dueAt, 'meeting action dueAt') : null,
  };
  return withDesktopFetchDeadline(
    meetingActionsUrl(cfg, args.meetingId),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    ACTION_ATTEMPT_TIMEOUT_MS,
    'createMeetingAction',
    async (response) => {
      if (!response.ok) {
        throw new Error(await httpErrorMessage(response, 'createMeetingAction'));
      }
      return parseMeetingActionRecord(await response.json());
    },
  );
}

export async function searchAssignees(
  cfg: MeetingClientConfig,
  jwt: string,
  query: string,
): Promise<AssigneeOption[]> {
  const bounded = boundedString(query, 'assignee search query', ASSIGNEE_SEARCH_MAX_QUERY);
  const payload: unknown = await withDesktopFetchDeadline(
    assigneeSearchUrl(cfg, bounded),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    },
    ACTION_ATTEMPT_TIMEOUT_MS,
    'searchAssignees',
    async (response) => {
      if (!response.ok) {
        throw new Error(await httpErrorMessage(response, 'searchAssignees'));
      }
      return (await response.json()) as unknown;
    },
  );
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { items?: unknown[] }).items)
      ? (payload as { items: unknown[] }).items
      : payload &&
          typeof payload === 'object' &&
          Array.isArray((payload as { content?: unknown[] }).content)
        ? (payload as { content: unknown[] }).content
        : [];
  const options: AssigneeOption[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    // gitops#3507: the directory exposes only the numeric id; the backend
    // resolves id → KC subject at create time.
    if (typeof row.id !== 'number') continue;
    const userId = row.id;
    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : typeof row.displayName === 'string'
          ? row.displayName.trim()
          : '';
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    const label = name && email ? `${name} (${email})` : name || email || String(userId);
    options.push({ userId, label });
  }
  return options;
}
