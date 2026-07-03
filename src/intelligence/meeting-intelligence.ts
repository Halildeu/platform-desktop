export type IntelligenceStatus = 'idle' | 'recording' | 'waiting' | 'ready' | 'blocked' | 'error';

export type ActionStatus = 'open' | 'in_progress' | 'done' | 'blocked';

export type DecisionStatus = 'proposed' | 'accepted' | 'revised';

export interface IntelligenceCitation {
  segmentId: string;
  startedAtMs: number;
  endedAtMs?: number;
}

export interface ActionItem {
  id: string;
  title: string;
  assignee?: string;
  dueDate?: string;
  status: ActionStatus;
  priority?: 'low' | 'medium' | 'high';
  citations: IntelligenceCitation[];
}

export interface DecisionItem {
  id: string;
  title: string;
  owner?: string;
  status: DecisionStatus;
  citations: IntelligenceCitation[];
}

export interface MeetingIntelligenceResult {
  summaryMarkdown: string;
  decisions: DecisionItem[];
  actionItems: ActionItem[];
  generatedAtMs: number;
  providerLabel?: string;
  citationCoverage: number;
}

export interface MeetingIntelligenceState {
  status: IntelligenceStatus;
  meetingId: string | null;
  sessionId: string | null;
  error: string | null;
  result: MeetingIntelligenceResult | null;
}

export interface ExportBundle {
  markdown: string;
  csv: string;
  markdownFileName: string;
  csvFileName: string;
}

const STATUS_LABELS: Record<IntelligenceStatus, string> = {
  idle: 'Beklemede',
  recording: 'Kayıt',
  waiting: 'Çıktı bekliyor',
  ready: 'Hazır',
  blocked: 'Blokeli',
  error: 'Hata',
};

const ACTION_LABELS: Record<ActionStatus, string> = {
  open: 'Açık',
  in_progress: 'İlerliyor',
  done: 'Tamamlandı',
  blocked: 'Blokeli',
};

const DECISION_LABELS: Record<DecisionStatus, string> = {
  proposed: 'Öneri',
  accepted: 'Karar',
  revised: 'Revize',
};

const MISSING_MEETING_ID_ERROR = 'Meeting intelligence için canonical meetingId yok.';

export function initialMeetingIntelligence(): MeetingIntelligenceState {
  return {
    status: 'idle',
    meetingId: null,
    sessionId: null,
    error: null,
    result: null,
  };
}

export function bindMeetingIntelligenceTarget(
  state: MeetingIntelligenceState,
  args: { meetingId: string | null; sessionId?: string | null },
): MeetingIntelligenceState {
  if (!args.meetingId) {
    return {
      ...state,
      meetingId: null,
      sessionId: args.sessionId ?? state.sessionId,
      status: 'blocked',
      error: MISSING_MEETING_ID_ERROR,
    };
  }

  const wasBlockedOnlyByMissingMeetingId =
    state.status === 'blocked' && state.error === MISSING_MEETING_ID_ERROR;

  return {
    ...state,
    meetingId: args.meetingId,
    sessionId: args.sessionId ?? state.sessionId,
    status: wasBlockedOnlyByMissingMeetingId ? 'idle' : state.status,
    error: wasBlockedOnlyByMissingMeetingId ? null : state.error,
  };
}

export function markIntelligenceRecording(
  state: MeetingIntelligenceState,
  args: { meetingId: string; sessionId: string },
): MeetingIntelligenceState {
  return {
    ...state,
    meetingId: args.meetingId,
    sessionId: args.sessionId,
    status: 'recording',
    error: null,
    result: null,
  };
}

export function markIntelligenceWaiting(state: MeetingIntelligenceState): MeetingIntelligenceState {
  return {
    ...state,
    status: 'waiting',
    error: null,
  };
}

export function failMeetingIntelligence(
  state: MeetingIntelligenceState,
  error: string,
): MeetingIntelligenceState {
  return {
    ...state,
    status: 'error',
    error,
  };
}

export function setMeetingIntelligenceResult(
  state: MeetingIntelligenceState,
  result: MeetingIntelligenceResult,
): MeetingIntelligenceState {
  return {
    ...state,
    status: 'ready',
    error: null,
    result,
  };
}

export function intelligenceStatusLabel(status: IntelligenceStatus): string {
  return STATUS_LABELS[status];
}

export function actionStatusLabel(status: ActionStatus): string {
  return ACTION_LABELS[status];
}

export function decisionStatusLabel(status: DecisionStatus): string {
  return DECISION_LABELS[status];
}

export function formatCitationTime(citation: IntelligenceCitation): string {
  const start = formatDuration(citation.startedAtMs);
  if (citation.endedAtMs === undefined) {
    return start;
  }
  return `${start}-${formatDuration(citation.endedAtMs)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildIntelligenceExport(
  state: MeetingIntelligenceState,
  nowMs: number = Date.now(),
): ExportBundle {
  if (!state.result) {
    throw new Error('Meeting intelligence output is not ready');
  }

  const safeMeetingId = safeFilePart(state.meetingId ?? 'meeting');
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return {
    markdown: buildMarkdown(state),
    csv: buildCsv(state.result),
    markdownFileName: `meeting-intelligence-${safeMeetingId}-${stamp}.md`,
    csvFileName: `meeting-intelligence-actions-${safeMeetingId}-${stamp}.csv`,
  };
}

function buildMarkdown(state: MeetingIntelligenceState): string {
  const result = state.result;
  if (!result) {
    throw new Error('Meeting intelligence output is not ready');
  }

  const lines = [
    '# Meeting Intelligence',
    '',
    `- Meeting: ${state.meetingId ?? '-'}`,
    `- Oturum: ${state.sessionId ?? '-'}`,
    `- Üretim: ${new Date(result.generatedAtMs).toISOString()}`,
    `- Citation coverage: ${Math.round(result.citationCoverage * 100)}%`,
  ];
  if (result.providerLabel) {
    lines.push(`- Provider: ${result.providerLabel}`);
  }
  lines.push('', '## Özet', '', result.summaryMarkdown.trim() || '_Özet yok._', '');

  lines.push('## Kararlar', '');
  if (result.decisions.length === 0) {
    lines.push('_Karar yok._');
  } else {
    for (const decision of result.decisions) {
      const owner = decision.owner ? ` @${decision.owner}` : '';
      lines.push(
        `- **${decision.title}**${owner} (${decisionStatusLabel(decision.status)})` +
          citationSuffix(decision.citations),
      );
    }
  }
  lines.push('', '## Aksiyonlar', '');
  if (result.actionItems.length === 0) {
    lines.push('_Aksiyon yok._');
  } else {
    for (const item of result.actionItems) {
      const assignee = item.assignee ? ` @${item.assignee}` : '';
      const due = item.dueDate ? ` due:${item.dueDate}` : '';
      lines.push(
        `- [${item.status === 'done' ? 'x' : ' '}] ${item.title}${assignee}${due} (${actionStatusLabel(item.status)})` +
          citationSuffix(item.citations),
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildCsv(result: MeetingIntelligenceResult): string {
  const rows = [
    ['type', 'id', 'title', 'owner_or_assignee', 'due_date', 'status', 'priority', 'citations'],
    ...result.decisions.map((decision) => [
      'decision',
      decision.id,
      decision.title,
      decision.owner ?? '',
      '',
      decisionStatusLabel(decision.status),
      '',
      decision.citations.map(formatCitationTime).join('; '),
    ]),
    ...result.actionItems.map((item) => [
      'action',
      item.id,
      item.title,
      item.assignee ?? '',
      item.dueDate ?? '',
      actionStatusLabel(item.status),
      item.priority ?? '',
      item.citations.map(formatCitationTime).join('; '),
    ]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function citationSuffix(citations: IntelligenceCitation[]): string {
  if (citations.length === 0) {
    return ' [kaynak yok]';
  }
  return ` [${citations.map(formatCitationTime).join(', ')}]`;
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
}
