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

async function httpErrorMessage(res: Response): Promise<string> {
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
  return `createMeetingContract failed: ${res.status}${suffix}`;
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
      throw new Error(await httpErrorMessage(res));
    }
    return parseMeetingContract(await res.json());
  }

  throw new Error('createMeetingContract failed: retry loop exhausted');
}
