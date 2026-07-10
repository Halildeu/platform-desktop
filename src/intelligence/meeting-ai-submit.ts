import type { IntelligenceCitation, MeetingIntelligenceResult } from './meeting-intelligence';
import type { MeetingAiAnalyzeRequest } from '../transcript/session-transcript';

export interface MeetingAiSubmitPayload {
  meetingId: string;
  request: MeetingAiAnalyzeRequest;
}

export interface MeetingAiActionItemResponse {
  text?: string | null;
  owner?: string | null;
  due_date?: string | null;
}

export interface MeetingAiCitationResponse {
  claim?: string | null;
  source_index?: number | null;
  source_text?: string | null;
  similarity?: number | null;
  grounded?: boolean | null;
  status?: string | null;
  reason?: string | null;
  start_sec?: number | null;
}

export interface MeetingAiAnalyzeResponse {
  schema_version?: string | null;
  grounding_policy?: string | null;
  summary?: string | null;
  summary_grounding_status?: string | null;
  summary_citations?: MeetingAiCitationResponse[] | null;
  decisions?: string[] | null;
  action_items?: Array<MeetingAiActionItemResponse | string> | null;
  citations?: MeetingAiCitationResponse[] | null;
  rejected_claims?: string[] | null;
  ungrounded_count?: number | null;
  redacted?: boolean | null;
  redaction_count?: number | null;
  backend?: string | null;
  model?: string | null;
  elapsed_ms?: number | null;
  meetingId?: string | null;
  sessionId?: string | null;
  persisted?: boolean | null;
  storageMode?: string | null;
}

interface NormalizedActionItem {
  text: string;
  owner?: string | null;
  due_date?: string | null;
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(safeText).filter(Boolean);
}

function safeCitations(value: unknown): MeetingAiCitationResponse[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is MeetingAiCitationResponse =>
    Boolean(item && typeof item === 'object'),
  );
}

function safeActionItems(value: unknown): NormalizedActionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): NormalizedActionItem | null => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text } : null;
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as MeetingAiActionItemResponse;
      const text = safeText(record.text);
      if (!text) {
        return null;
      }
      return {
        text,
        owner: safeText(record.owner) || null,
        due_date: safeText(record.due_date) || null,
      };
    })
    .filter((item): item is NormalizedActionItem => item !== null);
}

function normalizeClaim(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function citationToIntelligenceCitation(
  citation: MeetingAiCitationResponse,
  fallbackIndex: number,
): IntelligenceCitation {
  const startedAtMs =
    typeof citation.start_sec === 'number' && Number.isFinite(citation.start_sec)
      ? Math.max(0, Math.round(citation.start_sec * 1000))
      : 0;
  const sourceIndex =
    typeof citation.source_index === 'number' && Number.isFinite(citation.source_index)
      ? citation.source_index
      : fallbackIndex;

  return {
    segmentId: `meeting-ai:${sourceIndex}`,
    startedAtMs,
  };
}

function citationsForClaim(
  citations: MeetingAiCitationResponse[],
  claim: string,
): IntelligenceCitation[] {
  const normalizedClaim = normalizeClaim(claim);
  const matched = citations.filter((citation) => {
    const candidate = safeText(citation.claim);
    if (!candidate) {
      return false;
    }
    const normalizedCandidate = normalizeClaim(candidate);
    return (
      normalizedCandidate === normalizedClaim ||
      normalizedCandidate.includes(normalizedClaim) ||
      normalizedClaim.includes(normalizedCandidate)
    );
  });

  return (matched.length > 0 ? matched : citations.slice(0, 1)).map(citationToIntelligenceCitation);
}

function providerLabel(response: MeetingAiAnalyzeResponse): string {
  const parts = [response.backend, response.model, response.schema_version]
    .map(safeText)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'meeting-ai';
}

function citationCoverage(response: MeetingAiAnalyzeResponse): number {
  const decisions = safeStringArray(response.decisions);
  const actionItems = safeActionItems(response.action_items);
  const summary = safeText(response.summary);
  const totalClaims = decisions.length + actionItems.length + (summary ? 1 : 0);
  if (totalClaims === 0) {
    return 0;
  }

  const citations = safeCitations(response.citations);
  const summaryCitations = safeCitations(response.summary_citations);
  const groundedCount =
    citations.filter((citation) => citation.grounded !== false && safeText(citation.claim)).length +
    summaryCitations.length;

  return Math.max(0, Math.min(1, groundedCount / totalClaims));
}

export function meetingAiResultFromAnalyzeResponse(
  response: MeetingAiAnalyzeResponse,
  nowMs: number = Date.now(),
): MeetingIntelligenceResult {
  const citations = safeCitations(response.citations);
  const decisions = safeStringArray(response.decisions);
  const actionItems = safeActionItems(response.action_items);
  const summary = safeText(response.summary);

  return {
    summaryMarkdown: summary || '_Doğrulanmış özet üretilmedi._',
    generatedAtMs: nowMs,
    providerLabel: providerLabel(response),
    citationCoverage: citationCoverage(response),
    decisions: decisions.map((title, index) => ({
      id: `decision-${index + 1}`,
      title,
      status: 'accepted',
      citations: citationsForClaim(citations, title),
    })),
    actionItems: actionItems.map((item, index) => ({
      id: `action-${index + 1}`,
      title: item.text,
      assignee: item.owner ?? undefined,
      dueDate: item.due_date ?? undefined,
      status: 'open',
      citations: citationsForClaim(citations, item.text),
    })),
  };
}
