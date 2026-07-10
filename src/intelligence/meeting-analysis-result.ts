import type { ActionStatus, MeetingIntelligenceResult } from './meeting-intelligence';

export interface PersistedMeetingAnalysisResult {
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

export interface PersistedMeetingDecision {
  id: string;
  title: string;
  detail: string | null;
  decidedBySubject: string | null;
  decidedAt: string | null;
}

export interface PersistedMeetingAction {
  id: string;
  description: string;
  assigneeSubject: string | null;
  status: string;
  dueAt: string | null;
}

export interface MeetingAnalysisSnapshot {
  result: PersistedMeetingAnalysisResult | null;
  decisions: PersistedMeetingDecision[];
  actions: PersistedMeetingAction[];
}

function safeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** meeting-ai groundingStatus (see analyze.py _ground_summary) → 0..1 citation coverage proxy. */
function groundingStatusCoverage(status: string | null): number {
  switch (status) {
    case 'verified':
      return 1;
    case 'partial_verified':
      return 0.5;
    default:
      return 0;
  }
}

/** meeting-service MeetingActionStatus has no desktop 'blocked' analogue for CANCELLED — closest fit. */
function actionStatusFromBackend(status: string): ActionStatus {
  switch (status) {
    case 'IN_PROGRESS':
      return 'in_progress';
    case 'DONE':
      return 'done';
    case 'CANCELLED':
      return 'blocked';
    default:
      return 'open';
  }
}

function providerLabel(result: PersistedMeetingAnalysisResult): string {
  const parts = [result.modelVersion, result.promptVersion].map(safeText).filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'meeting-service';
}

/**
 * Maps the meeting-service read-path (#244 BE-1b) into the same
 * MeetingIntelligenceResult shape the in-session /analyze response uses, so
 * SummaryPanel can render a canonical persisted result the same way.
 *
 * Citations are not reconstructed here — BE-1b's summary/decisions/actions
 * projections carry no per-claim citation data, so decisions/actionItems get
 * empty citation lists (this correctly surfaces as "kaynak referansı eksik"
 * in the handoff-readiness check rather than fabricating sources).
 */
export function meetingIntelligenceResultFromSnapshot(
  snapshot: MeetingAnalysisSnapshot,
): MeetingIntelligenceResult | null {
  if (!snapshot.result) {
    return null;
  }
  const result = snapshot.result;
  const summary = safeText(result.summary);
  const generatedAtMs = Date.parse(result.generatedAt);

  return {
    summaryMarkdown: summary || '_Doğrulanmış özet üretilmedi._',
    generatedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now(),
    providerLabel: providerLabel(result),
    citationCoverage: groundingStatusCoverage(result.groundingStatus),
    decisions: snapshot.decisions.map((decision) => ({
      id: decision.id,
      title: decision.title,
      owner: safeText(decision.decidedBySubject) || undefined,
      status: 'accepted' as const,
      citations: [],
    })),
    actionItems: snapshot.actions.map((action) => ({
      id: action.id,
      title: action.description,
      assignee: safeText(action.assigneeSubject) || undefined,
      dueDate: safeText(action.dueAt) || undefined,
      status: actionStatusFromBackend(action.status),
      citations: [],
    })),
  };
}
