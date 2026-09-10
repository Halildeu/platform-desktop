import { createHash } from 'node:crypto';
import { withDesktopFetchDeadline } from '../net/desktop-fetch.js';
import { meetingsUrl, type MeetingClientConfig } from './meeting-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export interface CanonicalTranscriptRequest {
  meetingId: string;
  analysisRunId: string;
  sessionId: string;
}
export interface CanonicalTranscriptSource extends CanonicalTranscriptRequest {
  finalizationVersion: number;
  transcriptSha256: string;
  sentences: Array<{ index: number; text: string; sha256: string }>;
}

export function parseTranscriptRequest(value: unknown): CanonicalTranscriptRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid transcript request');
  const row = value as Record<string, unknown>;
  for (const key of ['meetingId', 'analysisRunId', 'sessionId']) {
    if (typeof row[key] !== 'string' || !UUID.test(row[key]))
      throw new Error(`Invalid transcript ${key}`);
  }
  return {
    meetingId: (row.meetingId as string).toLowerCase(),
    analysisRunId: (row.analysisRunId as string).toLowerCase(),
    sessionId: (row.sessionId as string).toLowerCase(),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseCanonicalTranscript(
  value: unknown,
  request: CanonicalTranscriptRequest,
): CanonicalTranscriptSource {
  if (!value || typeof value !== 'object') throw new Error('Invalid canonical transcript');
  const row = value as Record<string, unknown>;
  const actual = parseTranscriptRequest(row);
  const expected = parseTranscriptRequest(request);
  if (
    actual.meetingId !== expected.meetingId ||
    actual.analysisRunId !== expected.analysisRunId ||
    actual.sessionId !== expected.sessionId
  ) {
    throw new Error('Canonical transcript scope mismatch');
  }
  if (
    !Number.isSafeInteger(row.finalizationVersion) ||
    (row.finalizationVersion as number) < 1 ||
    !['FINALIZED', 'LEGAL_HOLD'].includes(String(row.state)) ||
    typeof row.transcript !== 'string' ||
    row.transcript.length > 500_000 ||
    typeof row.transcriptSha256 !== 'string' ||
    !SHA256.test(row.transcriptSha256) ||
    sha256(row.transcript) !== row.transcriptSha256 ||
    !Array.isArray(row.segments) ||
    row.segmentCount !== row.segments.length
  )
    throw new Error('Canonical transcript integrity mismatch');
  // Same boundaries as meeting-ai citation.py. Hash matching remains mandatory:
  // a tokenizer change must never silently link another sentence.
  const sentences = row.transcript
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((text) => text.trim())
    .filter(Boolean);
  return {
    ...actual,
    finalizationVersion: row.finalizationVersion as number,
    transcriptSha256: row.transcriptSha256,
    sentences: sentences.map((text, index) => ({ index, text, sha256: sha256(text) })),
  };
}

export async function readCanonicalTranscript(
  cfg: MeetingClientConfig,
  jwt: string,
  request: CanonicalTranscriptRequest,
): Promise<CanonicalTranscriptSource> {
  const args = parseTranscriptRequest(request);
  const url = `${meetingsUrl(cfg)}/${args.meetingId}/intelligence/results/${args.analysisRunId}/transcript`;
  return withDesktopFetchDeadline(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
    },
    8_000,
    'readCanonicalTranscript',
    async (response) => {
      // Never propagate service bodies: they may contain transcript or PII.
      if (!response.ok)
        throw new Error(`Canonical transcript unavailable (HTTP ${response.status})`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Invalid canonical transcript response');
      }
      return parseCanonicalTranscript(payload, args);
    },
  );
}
