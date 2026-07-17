import { describe, expect, it } from 'vitest';

import { formatCitationTime } from './meeting-intelligence';
import {
  canonicalAnalysisRunBaseline,
  isNewCanonicalAnalysisRun,
  meetingIntelligenceResultFromCanonicalResponse,
  type CanonicalMeetingIntelligenceResponse,
} from './meeting-result-read';

const RUN_ID = '55555555-5555-4555-8555-555555555555';

function canonicalResponse(): CanonicalMeetingIntelligenceResponse {
  return {
    analysisRunId: RUN_ID,
    meetingId: '33333333-3333-4333-8333-333333333333',
    sessionId: 'SES-CANONICAL',
    schema_version: '5-adr0043',
    model: 'qwen',
    backend: 'ollama',
    summary: 'Gateway rotası doğrulandı.',
    summaryGroundingStatus: 'verified',
    summary_citations: [
      {
        claim: 'Gateway rotası doğrulandı.',
        source_index: 0,
        start_sec: 3,
        source_hash: 'a'.repeat(64),
        quote_hash: 'b'.repeat(64),
      },
    ],
    decisions: ['Canonical endpoint kullanılacak'],
    action_items: [{ text: 'Runtime kanıtı eklenecek', owner: 'Zeynep', due_date: null }],
    citations: [
      {
        claim: 'Canonical endpoint kullanılacak',
        source_index: 1,
        start_sec: null,
        source_hash: 'c'.repeat(64),
        quote_hash: 'd'.repeat(64),
      },
    ],
    generatedAt: '2026-07-11T20:00:00.000Z',
    persisted: true,
    storageMode: 'canonical',
  };
}

describe('canonical Meeting Intelligence result mapper', () => {
  it('maps one run-bound persisted snapshot without fabricating citation matches', () => {
    const result = meetingIntelligenceResultFromCanonicalResponse(canonicalResponse());

    expect(result).toMatchObject({
      analysisRunId: RUN_ID,
      storageMode: 'canonical',
      generatedAtMs: Date.parse('2026-07-11T20:00:00.000Z'),
      providerLabel: 'ollama / qwen / 5-adr0043 / kalıcı',
      citationCoverage: 2 / 3,
    });
    expect(result.decisions).toEqual([
      expect.objectContaining({
        id: `${RUN_ID}:decision:0`,
        status: 'proposed',
        citations: [{ segmentId: 'meeting-ai:1', startedAtMs: null }],
      }),
    ]);
    expect(result.actionItems).toEqual([
      expect.objectContaining({
        id: `${RUN_ID}:action:0`,
        assignee: 'Zeynep',
        status: 'open',
        citations: [],
      }),
    ]);
    expect(formatCitationTime(result.decisions[0].citations[0])).toBe('Kaynak #2');
  });

  it('deduplicates identical source evidence for one claim', () => {
    const response = canonicalResponse();
    response.citations = [response.citations[0], { ...response.citations[0] }];

    const result = meetingIntelligenceResultFromCanonicalResponse(response);

    expect(result.decisions[0].citations).toHaveLength(1);
  });

  it('does not attribute a near-match citation to a different product claim', () => {
    const response = canonicalResponse();
    response.citations[0] = {
      ...response.citations[0],
      claim: 'Canonical endpoint kaldırılacak',
    };

    const result = meetingIntelligenceResultFromCanonicalResponse(response);

    expect(result.decisions[0].citations).toEqual([]);
    expect(result.citationCoverage).toBe(1 / 3);
  });

  it('accepts a bounded citation claim contained in the decision text', () => {
    const response = canonicalResponse();
    response.decisions = ['Canonical endpoint kullanılacak ve rollout kanıtı eklenecek'];

    const result = meetingIntelligenceResultFromCanonicalResponse(response);

    expect(result.decisions[0].citations).toEqual([
      { segmentId: 'meeting-ai:1', startedAtMs: null },
    ]);
    expect(result.citationCoverage).toBe(2 / 3);
  });

  it('uses authoritative summary grounding instead of full-summary string equality', () => {
    const response = canonicalResponse();
    response.summary = 'Gateway rotası doğrulandı. Kalıcı sonuç kaydedildi.';

    const result = meetingIntelligenceResultFromCanonicalResponse(response);

    expect(result.citationCoverage).toBe(2 / 3);
  });

  it('requires a different run id while a re-analysis is pending', () => {
    const previous = canonicalResponse();
    const replacement = {
      ...previous,
      analysisRunId: '66666666-6666-4666-8666-666666666666',
    };

    expect(isNewCanonicalAnalysisRun(previous, RUN_ID)).toBe(false);
    expect(isNewCanonicalAnalysisRun(replacement, RUN_ID)).toBe(true);
    expect(isNewCanonicalAnalysisRun(previous, null)).toBe(true);
    expect(
      isNewCanonicalAnalysisRun(previous, null, Date.parse('2026-07-11T20:00:01.000Z')),
    ).toBe(false);
    expect(
      isNewCanonicalAnalysisRun(previous, null, Date.parse('2026-07-11T19:59:59.000Z')),
    ).toBe(true);
    expect(
      isNewCanonicalAnalysisRun(replacement, RUN_ID, Date.parse('2026-07-11T20:00:01.000Z')),
    ).toBe(false);
  });

  it('falls back to the run captured before recording when product state was cleared', () => {
    expect(canonicalAnalysisRunBaseline(null, RUN_ID)).toBe(RUN_ID);
    expect(canonicalAnalysisRunBaseline('66666666-6666-4666-8666-666666666666', RUN_ID)).toBe(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(canonicalAnalysisRunBaseline(null, null)).toBeNull();
  });
});
