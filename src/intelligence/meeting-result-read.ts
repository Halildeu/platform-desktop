import type { MeetingIntelligenceCanonicalResponse } from '../../electron/services/meeting/meeting-client';
import type { IntelligenceCitation, MeetingIntelligenceResult } from './meeting-intelligence';

export type CanonicalMeetingIntelligenceResponse = MeetingIntelligenceCanonicalResponse;
type CanonicalMeetingIntelligenceCitation =
  MeetingIntelligenceCanonicalResponse['citations'][number];

function normalizeClaim(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function citationsForClaim(
  citations: CanonicalMeetingIntelligenceCitation[],
  claim: string,
): CanonicalMeetingIntelligenceCitation[] {
  const normalizedClaim = normalizeClaim(claim);
  if (!normalizedClaim) {
    return [];
  }
  return citations.filter((citation) => {
    const normalizedCandidate = normalizeClaim(citation.claim);
    if (normalizedCandidate === normalizedClaim) {
      return true;
    }
    const shorter =
      normalizedCandidate.length < normalizedClaim.length ? normalizedCandidate : normalizedClaim;
    const longer =
      normalizedCandidate.length < normalizedClaim.length ? normalizedClaim : normalizedCandidate;
    return shorter.length >= 12 && longer.includes(shorter);
  });
}

function toProductCitations(
  citations: CanonicalMeetingIntelligenceCitation[],
): IntelligenceCitation[] {
  const seen = new Set<string>();
  return citations.flatMap((citation) => {
    const key = `${citation.source_hash}:${citation.quote_hash}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        segmentId: `meeting-ai:${citation.source_index}`,
        sourceIndex: citation.source_index,
        sourceHash: citation.source_hash,
        startedAtMs:
          typeof citation.start_sec === 'number' && Number.isFinite(citation.start_sec)
            ? Math.max(0, Math.round(citation.start_sec * 1000))
            : null,
      },
    ];
  });
}

function providerLabel(response: CanonicalMeetingIntelligenceResponse): string {
  const parts = [response.backend, response.model, response.schema_version].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  return parts.length > 0 ? `${parts.join(' / ')} / kalıcı` : 'Kalıcı Meeting Intelligence';
}

function citationCoverage(response: CanonicalMeetingIntelligenceResponse): number {
  const summaryClaimCount = response.summary.trim() ? 1 : 0;
  const totalClaims = summaryClaimCount + response.decisions.length + response.action_items.length;
  if (totalClaims === 0) {
    return 0;
  }

  const normalizedSummaryStatus = response.summaryGroundingStatus?.trim().toLowerCase() ?? '';
  const summaryIsGrounded =
    response.summary_citations.length > 0 ||
    ['verified', 'grounded', 'passed'].includes(normalizedSummaryStatus);
  let citedClaims = summaryClaimCount > 0 && summaryIsGrounded ? 1 : 0;
  citedClaims += response.decisions.filter(
    (decision) => citationsForClaim(response.citations, decision).length > 0,
  ).length;
  citedClaims += response.action_items.filter(
    (action) => citationsForClaim(response.citations, action.text).length > 0,
  ).length;
  return citedClaims / totalClaims;
}

export function meetingIntelligenceResultFromCanonicalResponse(
  response: CanonicalMeetingIntelligenceResponse,
): MeetingIntelligenceResult {
  return {
    summaryMarkdown: response.summary.trim() || '_Doğrulanmış özet üretilmedi._',
    generatedAtMs: Date.parse(response.generatedAt),
    providerLabel: providerLabel(response),
    citationCoverage: citationCoverage(response),
    analysisRunId: response.analysisRunId,
    canonicalSessionId: response.sessionId,
    storageMode: 'canonical',
    decisions: response.decisions.map((title, index) => ({
      id: `${response.analysisRunId}:decision:${index}`,
      title,
      status: 'proposed',
      citations: toProductCitations(citationsForClaim(response.citations, title)),
    })),
    actionItems: response.action_items.map((item, index) => ({
      id: `${response.analysisRunId}:action:${index}`,
      title: item.text,
      assignee: item.owner ?? undefined,
      dueDate: item.due_date ?? undefined,
      status: 'open',
      citations: toProductCitations(citationsForClaim(response.citations, item.text)),
    })),
  };
}

export function isNewCanonicalAnalysisRun(
  response: CanonicalMeetingIntelligenceResponse,
  previousAnalysisRunId: string | null,
  generatedNotBeforeMs: number | null = null,
): boolean {
  if (previousAnalysisRunId !== null && response.analysisRunId === previousAnalysisRunId) {
    return false;
  }
  return generatedNotBeforeMs === null || Date.parse(response.generatedAt) >= generatedNotBeforeMs;
}

export function canonicalAnalysisRunBaseline(
  displayedAnalysisRunId: string | null,
  analysisRunBeforeRecording: string | null,
): string | null {
  return displayedAnalysisRunId ?? analysisRunBeforeRecording;
}
