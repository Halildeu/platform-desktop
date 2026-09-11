import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseCanonicalTranscript,
  parseTranscriptRequest,
  readCanonicalTranscript,
} from './canonical-transcript';

const request = {
  meetingId: '33333333-3333-4333-8333-333333333333',
  analysisRunId: '55555555-5555-4555-8555-555555555555',
  sessionId: '66666666-6666-4666-8666-666666666666',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(transcript = 'Plan kabul edildi.\nTakip yarin yapilacak! Son satir') {
  return {
    ...request,
    state: 'FINALIZED',
    finalizationVersion: 2,
    transcript,
    transcriptSha256: hash(transcript),
    segmentCount: 1,
    segments: [{ text: transcript, start: 1789046520.809 }],
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('canonical transcript readback', () => {
  it.each([
    [
      'Plan\nkabul\nedildi\n.\nTakip\nyarin yapilacak!',
      ['Plan kabul edildi.', 'Takip yarin yapilacak!'],
    ],
    [
      'Plan kabul edildi.\n\nTakip\n  yarin\t yapilacak\n!\nSon satir',
      ['Plan kabul edildi.', 'Takip yarin yapilacak!', 'Son satir'],
    ],
    ['Birinci\nplan\n; ikinci\nplan\n…\nSon satir', ['Birinci plan; ikinci plan…', 'Son satir']],
    ['  Tek\t  satir.  ', ['Tek\t  satir.']],
    ['\u0085Plan\u001c\nkabul\u3000edildi\n.\u0085', ['Plan kabul edildi.']],
    ['\ufeffPlan\nkabul edildi.', ['\ufeffPlan kabul edildi.']],
    ['', []],
  ])('matches meeting-ai fragment merging for %j', (transcript, sentences) => {
    const source = parseCanonicalTranscript(fixture(transcript as string), request);
    expect(source.sentences).toEqual(
      (sentences as string[]).map((text, index) => ({
        text,
        index,
        sha256: hash(text),
      })),
    );
    expect(source.transcriptSha256).toBe(hash(transcript as string));
  });
  it('retains the producer 40-word boundary for unpunctuated fragments', () => {
    const first = Array.from({ length: 40 }, () => 'iş_2').join('\n');
    const source = parseCanonicalTranscript(fixture(`${first}\nSon\nsatir.`), request);
    expect(source.sentences.map((row) => row.text)).toEqual([
      first.replaceAll('\n', ' '),
      'Son satir.',
    ]);
  });
  it('keeps occurrence identity and exact sentence hashes without inferred timings', () => {
    const source = parseCanonicalTranscript(fixture(), request);
    expect(source.sentences).toEqual(
      ['Plan kabul edildi.', 'Takip yarin yapilacak!', 'Son satir'].map((text, index) => ({
        text,
        index,
        sha256: hash(text),
      })),
    );
    expect(source.analysisRunId).toBe(request.analysisRunId);
    expect(source.finalizationVersion).toBe(2);
  });
  it.each(['meetingId', 'analysisRunId', 'sessionId'])('rejects another %s', (key) => {
    expect(() =>
      parseCanonicalTranscript(
        { ...fixture(), [key]: '77777777-7777-4777-8777-777777777777' },
        request,
      ),
    ).toThrow('scope mismatch');
  });
  it.each([
    { transcript: 'modified' },
    { transcriptSha256: 'a'.repeat(64) },
    { finalizationVersion: 0 },
    { segmentCount: 9 },
    { state: 'DRAFT' },
  ])('fails closed on corrupt snapshot %j', (change) => {
    expect(() => parseCanonicalTranscript({ ...fixture(), ...change }, request)).toThrow(
      'integrity mismatch',
    );
  });
  it('rejects path injection before a request', () => {
    expect(() => parseTranscriptRequest({ ...request, analysisRunId: '../latest' })).toThrow(
      'Invalid transcript analysisRunId',
    );
  });
  it('uses the authenticated exact-run route and no-store', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fixture()), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await readCanonicalTranscript({ baseUrl: 'https://test.example' }, 'synthetic-token', request);
    expect(fetch).toHaveBeenCalledWith(
      `https://test.example/api/v1/admin/meetings/${request.meetingId}/intelligence/results/${request.analysisRunId}/transcript`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer synthetic-token',
          'Cache-Control': 'no-store',
        }),
      }),
    );
  });
  it.each([401, 403, 404, 409, 410, 423, 503])(
    'does not retry, bypass or leak response bodies on HTTP %i',
    async (status) => {
      const fetch = vi.fn().mockResolvedValue(new Response('sensitive-server-content', { status }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        readCanonicalTranscript({ baseUrl: 'https://test.example' }, 'synthetic-token', request),
      ).rejects.toThrow(`Canonical transcript unavailable (HTTP ${status})`);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
