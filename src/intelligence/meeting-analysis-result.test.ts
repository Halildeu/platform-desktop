import { describe, expect, it } from 'vitest';

import { meetingIntelligenceResultFromSnapshot } from './meeting-analysis-result';

describe('meetingIntelligenceResultFromSnapshot', () => {
  it('returns null when no canonical run has been persisted yet', () => {
    expect(
      meetingIntelligenceResultFromSnapshot({ result: null, decisions: [], actions: [] }),
    ).toBeNull();
  });

  it('maps a canonical result with decisions/actions into MeetingIntelligenceResult', () => {
    const mapped = meetingIntelligenceResultFromSnapshot({
      result: {
        meetingId: '33333333-3333-4333-8333-333333333333',
        analysisRunId: 'run-1',
        status: 'CANONICAL',
        summary: 'Bütçe onaylandı.',
        groundingStatus: 'verified',
        analyzerContractVersion: '5-adr0043',
        modelVersion: 'llama3.1:8b',
        promptVersion: 'ollama-v1',
        generatedAt: '2026-07-10T10:00:00.000Z',
      },
      decisions: [
        {
          id: 'd-1',
          title: 'Bütçe onaylandı',
          detail: null,
          decidedBySubject: 'zeynep',
          decidedAt: null,
        },
      ],
      actions: [
        {
          id: 'a-1',
          description: 'Kanıt eklenecek',
          assigneeSubject: 'zeynep',
          status: 'IN_PROGRESS',
          dueAt: '2026-07-15T00:00:00.000Z',
        },
        {
          id: 'a-2',
          description: 'İptal edilen iş',
          assigneeSubject: null,
          status: 'CANCELLED',
          dueAt: null,
        },
      ],
    });

    expect(mapped).not.toBeNull();
    expect(mapped?.summaryMarkdown).toBe('Bütçe onaylandı.');
    expect(mapped?.generatedAtMs).toBe(Date.parse('2026-07-10T10:00:00.000Z'));
    expect(mapped?.providerLabel).toBe('llama3.1:8b / ollama-v1');
    expect(mapped?.citationCoverage).toBe(1);
    expect(mapped?.decisions).toEqual([
      { id: 'd-1', title: 'Bütçe onaylandı', owner: 'zeynep', status: 'accepted', citations: [] },
    ]);
    expect(mapped?.actionItems).toEqual([
      {
        id: 'a-1',
        title: 'Kanıt eklenecek',
        assignee: 'zeynep',
        dueDate: '2026-07-15T00:00:00.000Z',
        status: 'in_progress',
        citations: [],
      },
      {
        id: 'a-2',
        title: 'İptal edilen iş',
        assignee: undefined,
        dueDate: undefined,
        status: 'blocked',
        citations: [],
      },
    ]);
  });

  it('falls back to a withheld-summary message and zero coverage when nothing was grounded', () => {
    const mapped = meetingIntelligenceResultFromSnapshot({
      result: {
        meetingId: '33333333-3333-4333-8333-333333333333',
        analysisRunId: 'run-2',
        status: 'CANONICAL',
        summary: '',
        groundingStatus: 'withheld',
        analyzerContractVersion: null,
        modelVersion: null,
        promptVersion: null,
        generatedAt: '2026-07-10T10:00:00.000Z',
      },
      decisions: [],
      actions: [],
    });

    expect(mapped?.summaryMarkdown).toBe('_Doğrulanmış özet üretilmedi._');
    expect(mapped?.citationCoverage).toBe(0);
    expect(mapped?.providerLabel).toBe('meeting-service');
  });

  it('treats partial_verified grounding as half coverage', () => {
    const mapped = meetingIntelligenceResultFromSnapshot({
      result: {
        meetingId: '33333333-3333-4333-8333-333333333333',
        analysisRunId: 'run-3',
        status: 'CANONICAL',
        summary: 'Kısmi özet.',
        groundingStatus: 'partial_verified',
        analyzerContractVersion: null,
        modelVersion: null,
        promptVersion: null,
        generatedAt: '2026-07-10T10:00:00.000Z',
      },
      decisions: [],
      actions: [],
    });

    expect(mapped?.citationCoverage).toBe(0.5);
  });

  it('falls back to Date.now() when generatedAt is unparseable', () => {
    const before = Date.now();
    const mapped = meetingIntelligenceResultFromSnapshot({
      result: {
        meetingId: '33333333-3333-4333-8333-333333333333',
        analysisRunId: 'run-4',
        status: 'CANONICAL',
        summary: 'Özet',
        groundingStatus: 'verified',
        analyzerContractVersion: null,
        modelVersion: null,
        promptVersion: null,
        generatedAt: 'not-a-date',
      },
      decisions: [],
      actions: [],
    });

    expect(mapped?.generatedAtMs).toBeGreaterThanOrEqual(before);
  });
});
