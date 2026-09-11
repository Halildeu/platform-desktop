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

// Python citation.py uses Unicode \s/\w, not JavaScript's whitespace/ASCII \w.
const PY_SPACE =
  '[\\t-\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const SENTENCE_SPLIT = new RegExp(`(?<=[.!?])${PY_SPACE}+|\\n+`, 'u');
const TRIM_SPACE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu');
const SPACE_RUN = new RegExp(`${PY_SPACE}+`, 'gu');
const SPACE_BEFORE_PUNCT = new RegExp(`${PY_SPACE}+(?=[.,!?;:\u2026])`, 'gu');

function canonicalSentences(transcript: string): string[] {
  // Match platform-ai citation.py split_sentences + _merge_unpunctuated_fragments
  // (ff179d9). Never normalize the immutable transcript or bypass citation hashes.
  const sentences: string[] = [];
  let position = 0;
  let carry: { start: number; text: string } | null = null;
  for (const raw of transcript.split(SENTENCE_SPLIT)) {
    const text = raw.replace(TRIM_SPACE, '');
    if (!text) continue;
    const start = transcript.indexOf(text, position);
    const end = start + text.length;
    position = end;
    const sentence: { start: number; text: string } = carry
      ? {
          start: carry.start,
          text: transcript
            .slice(carry.start, end)
            .replace(TRIM_SPACE, '')
            .replace(SPACE_RUN, ' ')
            .replace(SPACE_BEFORE_PUNCT, ''),
        }
      : { start, text };
    carry = null;
    if (
      !/[.!?\u2026]$/u.test(sentence.text) &&
      (sentence.text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) < 40
    ) {
      carry = sentence;
    } else {
      sentences.push(sentence.text);
    }
  }
  if (carry) sentences.push(carry.text);
  return sentences;
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
  const sentences = canonicalSentences(row.transcript);
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
