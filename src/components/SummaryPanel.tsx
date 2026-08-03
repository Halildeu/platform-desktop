import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { CONSENT_LOCALE, CONSENT_TEXT_HASH, CONSENT_VERSION } from './ConsentDialog';
import {
  MEETING_OUTPUT_ADAPTER_CAPABILITIES,
  MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION,
  MEETING_OUTPUT_ADAPTER_KIND,
  MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
  MEETING_OUTPUT_ADAPTER_PROFILE_ID,
  MEETING_OUTPUT_ADAPTER_TARGET,
  MEETING_OUTPUT_SUPPORTED_OBJECTS,
} from '../intelligence/meeting-output-contract';
import {
  analyzeMeetingOutputHandoffReadiness,
  actionStatusLabel,
  applyMeetingOutputSourceEvidenceObjectPlan,
  applyMeetingOutputSourceEvidenceReadiness,
  buildIntelligenceExport,
  buildMeetingOutputHandoffObjectPlan,
  buildMeetingOutputAdapterManifestJson,
  decisionStatusLabel,
  formatCitationTime,
  intelligenceStatusLabel,
  type ActionItem,
  type ActionStatus,
  type DecisionItem,
  type DecisionStatus,
  type IntelligenceCitation,
  type MeetingIntelligenceResult,
  type MeetingIntelligenceState,
  type MeetingOutputHandoffIssue,
  type MeetingOutputHandoffObjectPlan,
  type MeetingOutputSourceEvidence,
  type MeetingOutputHandoffReadiness,
  setMeetingIntelligenceResult,
} from '../intelligence/meeting-intelligence';
import {
  type MeetingAiAnalyzeResponse,
  type MeetingAiSubmitPayload,
} from '../intelligence/meeting-ai-submit';
import {
  analyzeTranscriptSourceReadiness,
  buildMeetingAiSourceGate,
  buildMeetingAiSourcePackage,
  buildTranscriptSourceExport,
  transcriptStatusLabel,
  type TranscriptSegment,
  type TranscriptSessionState,
} from '../transcript/session-transcript';

export interface ExportAdapter {
  copyText(text: string): Promise<void>;
  downloadText(fileName: string, content: string, mimeType: string): void;
  print(): void;
  openExternal?(url: string): void;
}

export interface MeetingAiSubmitAdapter {
  analyze(payload: MeetingAiSubmitPayload): Promise<MeetingAiAnalyzeResponse>;
}

export type CanonicalResultLoadStatus = 'idle' | 'loading' | 'not_ready' | 'ready' | 'error';

export interface SummaryPanelProps {
  intelligence: MeetingIntelligenceState;
  transcript?: TranscriptSessionState;
  exportAdapter?: ExportAdapter;
  meetingAiSubmitAdapter?: MeetingAiSubmitAdapter;
  autoSubmitMeetingAi?: boolean;
  canonicalResultStatus?: CanonicalResultLoadStatus;
  canonicalResultError?: string | null;
  canonicalResultAutoRetrying?: boolean;
  onCanonicalResultRetry?: () => void;
  onMeetingAiSubmitted?: () => void;
  onMeetingAiError?: (message: string) => void;
}

const browserExportAdapter: ExportAdapter = {
  async copyText(text: string) {
    await navigator.clipboard.writeText(text);
  },
  downloadText(fileName: string, content: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noreferrer';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
  print() {
    window.print();
  },
  openExternal(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};

const electronMeetingAiSubmitAdapter: MeetingAiSubmitAdapter = {
  async analyze(payload) {
    const response = await window.electronAPI?.meeting.analyze(payload);
    if (!response || typeof response !== 'object') {
      throw new Error('Meeting AI response is empty');
    }
    return response as MeetingAiAnalyzeResponse;
  },
};

const ACTION_STATUS_OPTIONS: ActionStatus[] = ['open', 'in_progress', 'done', 'blocked'];
const DECISION_STATUS_OPTIONS: DecisionStatus[] = ['proposed', 'accepted', 'revised'];

type ActionReviewDraft = Partial<Pick<ActionItem, 'assignee' | 'dueDate' | 'status'>>;
type DecisionReviewDraft = Partial<Pick<DecisionItem, 'owner' | 'status'>>;

type ShareChannel = 'clipboard' | 'email' | 'teams';
type OutputFreshnessStatus = 'current' | 'source_changed' | 'no_source' | 'unknown';

interface OutputFreshness {
  status: OutputFreshnessStatus;
  label: string;
  detail: string;
  resultGeneratedAtMs: number;
  latestSourceAtMs: number | null;
  staleByMs: number;
}

function transcriptSegments(transcript: TranscriptSessionState | undefined): TranscriptSegment[] {
  return (
    transcript?.segments
      .filter((segment) => segment.text.trim().length > 0)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id)) ?? []
  );
}

function segmentSourceLabel(segment: TranscriptSegment): string {
  if (segment.source === 'direct-stream') {
    return 'Direct STT';
  }
  if (segment.source === 'gateway-events') {
    return 'Gateway';
  }
  return 'Kaynak bekleniyor';
}

function transcriptSourceMode(segments: TranscriptSegment[]): string {
  const sources = new Set(segments.map(segmentSourceLabel));
  if (sources.size === 0) {
    return '-';
  }
  if (sources.size === 1) {
    return [...sources][0];
  }
  return 'Karma';
}

function formatClock(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return new Date(value).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function transcriptWindowLabel(segments: TranscriptSegment[]): string {
  if (segments.length === 0) {
    return '-';
  }
  return `${formatClock(segments[0].startedAtMs)} - ${formatClock(
    segments[segments.length - 1].startedAtMs,
  )}`;
}

function finalityLabel(segments: TranscriptSegment[]): string {
  const finalCount = segments.filter(
    (segment) => segment.status === 'final' || segment.status === 'revised',
  ).length;
  const draftCount = segments.length - finalCount;
  return `${finalCount} final / ${draftCount} taslak`;
}

function transcriptReviewCoverageLabel(
  readiness: ReturnType<typeof analyzeTranscriptSourceReadiness>,
  totalSegments: number,
): string {
  return `${readiness.reviewedCount}/${totalSegments} · ${formatPercent(readiness.reviewedRatio)}`;
}

function latestSourceAtMs(segments: TranscriptSegment[]): number | null {
  const values = segments
    .map((segment) => segment.receivedAtMs ?? segment.startedAtMs)
    .filter((value): value is number => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function buildOutputFreshness(
  result: MeetingIntelligenceResult,
  transcript: TranscriptSessionState | undefined,
  segments: TranscriptSegment[],
): OutputFreshness {
  if (!transcript || segments.length === 0) {
    return {
      status: 'no_source',
      label: 'Kaynak yok',
      detail: 'Çıktı için karşılaştırılabilir transkript kaynağı yok.',
      resultGeneratedAtMs: result.generatedAtMs,
      latestSourceAtMs: null,
      staleByMs: 0,
    };
  }

  const sourceAtMs = latestSourceAtMs(segments);
  if (sourceAtMs === null) {
    return {
      status: 'unknown',
      label: 'Zaman bilinmiyor',
      detail: 'Transkript zaman damgası okunamadı; çıktı güncelliği kanıtlanamadı.',
      resultGeneratedAtMs: result.generatedAtMs,
      latestSourceAtMs: null,
      staleByMs: 0,
    };
  }

  const staleByMs = Math.max(0, sourceAtMs - result.generatedAtMs);
  if (staleByMs > 500) {
    return {
      status: 'source_changed',
      label: 'Kaynak değişti',
      detail: 'Transkript AI çıktısından sonra değişti; Meeting AI yeniden gönderilmeli.',
      resultGeneratedAtMs: result.generatedAtMs,
      latestSourceAtMs: sourceAtMs,
      staleByMs,
    };
  }

  return {
    status: 'current',
    label: 'Güncel',
    detail: 'AI çıktısı mevcut transkript kaynağıyla uyumlu görünüyor.',
    resultGeneratedAtMs: result.generatedAtMs,
    latestSourceAtMs: sourceAtMs,
    staleByMs: 0,
  };
}

function buildOutputSourceEvidence(
  transcript: TranscriptSessionState | undefined,
  readiness: ReturnType<typeof analyzeTranscriptSourceReadiness>,
  segmentCount: number,
  freshness: OutputFreshness | null,
): MeetingOutputSourceEvidence | null {
  if (!transcript || segmentCount === 0) {
    return null;
  }

  return {
    transcript: {
      source_level: readiness.level,
      source_label: readiness.label,
      lifecycle: transcript.lifecycle,
      segment_count: segmentCount,
      word_count: readiness.wordCount,
      duration_ms: readiness.durationMs,
      final_count: readiness.finalCount,
      draft_count: readiness.draftCount,
      final_ratio: readiness.finalRatio,
      reviewed_count: readiness.reviewedCount,
      reviewed_ratio: readiness.reviewedRatio,
      quality_gate: {
        status: readiness.qualityGate.status,
        risk: readiness.qualityGate.risk,
        label: readiness.qualityGate.label,
        action: readiness.qualityGate.action,
      },
      result_freshness: freshness
        ? {
            status: freshness.status,
            label: freshness.label,
            result_generated_at_ms: freshness.resultGeneratedAtMs,
            latest_source_at_ms: freshness.latestSourceAtMs,
            stale_by_ms: freshness.staleByMs,
            raw_transcript_included: false,
          }
        : null,
      raw_transcript_included: false,
    },
  };
}

function integrationObjectCountLabel(result: MeetingIntelligenceResult): string {
  return `Toplantı notu / ${result.decisions.length} karar / ${result.actionItems.length} aksiyon`;
}

function integrationSupportedObjectLabel(): string {
  return MEETING_OUTPUT_SUPPORTED_OBJECTS.join(', ');
}

function adapterManifestSummaryLabel(): string {
  return `${MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS.length} nesne / ${MEETING_OUTPUT_ADAPTER_CAPABILITIES.length} kabiliyet`;
}

function adapterCapabilityLabel(capability: string): string {
  switch (capability) {
    case 'upsert_meeting_note':
      return 'Toplantı notu upsert';
    case 'upsert_decision_record':
      return 'Karar kaydı upsert';
    case 'upsert_action_task':
      return 'Aksiyon görevi upsert';
    case 'source_reference_mapping':
      return 'Kaynak referansı eşleme';
    case 'idempotent_write':
      return 'Idempotent yazım';
    case 'human_review_gate':
      return 'İnsan review kapısı';
    default:
      return capability.replaceAll('_', ' ');
  }
}

function handoffStatusLabel(readiness: MeetingOutputHandoffReadiness): string {
  return readiness.canHandoff ? 'Aktarıma hazır' : 'Review gerekli';
}

function handoffPackageStatusLabel(readiness: MeetingOutputHandoffReadiness | null): string {
  if (!readiness) {
    return 'Paket bekliyor';
  }
  return readiness.canHandoff ? 'Aktarım paketi hazır' : 'Review paketi';
}

function handoffPackageCopyButtonLabel(readiness: MeetingOutputHandoffReadiness | null): string {
  return readiness?.canHandoff ? 'Aktarım paketi kopyala' : 'Review paketi kopyala';
}

function handoffPackageJsonButtonLabel(readiness: MeetingOutputHandoffReadiness | null): string {
  return readiness?.canHandoff ? 'Aktarım JSON' : 'Review JSON';
}

function handoffPackageCopyMessage(readiness: MeetingOutputHandoffReadiness | null): string {
  return readiness?.canHandoff
    ? 'Aktarım paketi panoya kopyalandı.'
    : 'Review paketi panoya kopyalandı.';
}

function handoffPackageDownloadMessage(readiness: MeetingOutputHandoffReadiness | null): string {
  return readiness?.canHandoff ? 'Aktarım JSON indirildi.' : 'Review JSON indirildi.';
}

function handoffIssueLabel(readiness: MeetingOutputHandoffReadiness): string {
  const issues = [...readiness.blockers, ...readiness.warnings];
  if (issues.length === 0) {
    return 'Eksik alan yok';
  }
  const visibleIssues = issues.slice(0, 3).map((issue) => issue.label);
  const hiddenIssueCount = issues.length - visibleIssues.length;
  if (hiddenIssueCount <= 0) {
    return visibleIssues.join(' · ');
  }
  return `${visibleIssues.join(' · ')} · +${hiddenIssueCount} daha`;
}

function handoffIssueSeverityLabel(issue: MeetingOutputHandoffIssue): string {
  return issue.severity === 'blocker' ? 'Blokaj' : 'Uyarı';
}

function handoffObjectStatusLabel(entry: MeetingOutputHandoffObjectPlan): string {
  return entry.status === 'ready' ? 'Hazır' : 'Kontrol gerekli';
}

function handoffObjectRecordLabel(entry: MeetingOutputHandoffObjectPlan): string {
  return `${entry.records} kayıt`;
}

function handoffObjectIssueLabel(entry: MeetingOutputHandoffObjectPlan): string {
  if (entry.issues.length === 0) {
    return 'Eksik yok';
  }
  return entry.issues.map((issue) => issue.label).join(' · ');
}

function decisionReviewIssues(decision: DecisionItem): string[] {
  return [
    ...(!decision.owner?.trim() ? ['Sahip eksik'] : []),
    ...(decision.citations.length === 0 ? ['Kaynak yok'] : []),
  ];
}

function actionReviewIssues(item: ActionItem): string[] {
  const openAction = item.status !== 'done';
  return [
    ...(openAction && !item.assignee?.trim() ? ['Sahip eksik'] : []),
    ...(openAction && !item.dueDate?.trim() ? ['Tarih eksik'] : []),
    ...(item.citations.length === 0 ? ['Kaynak yok'] : []),
  ];
}

function normalizedCitationCoverage(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function outputSourceConfidenceLabel(value: number | null | undefined): string {
  const coverage = normalizedCitationCoverage(value);
  if (coverage === null) {
    return 'Bilinmiyor';
  }
  if (coverage >= 0.85) {
    return 'Kaynak güçlü';
  }
  if (coverage >= 0.5) {
    return 'Kısmi kaynaklı';
  }
  return 'Kaynak zayıf';
}

function outputCitationCoverageLabel(value: number | null | undefined): string {
  const coverage = normalizedCitationCoverage(value);
  return coverage === null ? '-' : formatPercent(coverage);
}

function hasReviewDraftChanges(
  result: MeetingIntelligenceResult | null,
  summaryOverride: string | null,
  decisionDrafts: Record<string, DecisionReviewDraft>,
  actionDrafts: Record<string, ActionReviewDraft>,
): boolean {
  if (!result) {
    return false;
  }
  if (summaryOverride !== null && summaryOverride !== result.summaryMarkdown) {
    return true;
  }
  const decisionMap = new Map(result.decisions.map((decision) => [decision.id, decision]));
  const hasDecisionChange = Object.entries(decisionDrafts).some(([id, draft]) => {
    const original = decisionMap.get(id);
    return (
      original &&
      ((draft.owner !== undefined && draft.owner !== original.owner) ||
        (draft.status !== undefined && draft.status !== original.status))
    );
  });
  if (hasDecisionChange) {
    return true;
  }
  const actionMap = new Map(result.actionItems.map((item) => [item.id, item]));
  return Object.entries(actionDrafts).some(([id, draft]) => {
    const original = actionMap.get(id);
    return (
      original &&
      ((draft.assignee !== undefined && draft.assignee !== original.assignee) ||
        (draft.dueDate !== undefined && draft.dueDate !== original.dueDate) ||
        (draft.status !== undefined && draft.status !== original.status))
    );
  });
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds} sn`;
  }
  return `${minutes} dk ${seconds} sn`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `%${Math.round(value * 100)}`;
}

function formatWordRate(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  if (value >= 10) {
    return `${Math.round(value)} kelime/dk`;
  }
  return `${value.toFixed(1)} kelime/dk`;
}

function applyActionReviewDrafts(
  actionItems: ActionItem[],
  drafts: Record<string, ActionReviewDraft>,
): ActionItem[] {
  return actionItems.map((item) => {
    const draft = drafts[item.id];
    if (!draft) {
      return item;
    }
    return {
      ...item,
      assignee: draft.assignee ?? item.assignee,
      dueDate: draft.dueDate ?? item.dueDate,
      status: draft.status ?? item.status,
    };
  });
}

function applyDecisionReviewDrafts(
  decisions: DecisionItem[],
  drafts: Record<string, DecisionReviewDraft>,
): DecisionItem[] {
  return decisions.map((item) => {
    const draft = drafts[item.id];
    if (!draft) {
      return item;
    }
    return {
      ...item,
      owner: draft.owner ?? item.owner,
      status: draft.status ?? item.status,
    };
  });
}

function shareSubject(meetingId: string | null): string {
  return `Meeting Intelligence - ${meetingId ?? 'meeting'}`;
}

function normalizedShareRecipients(value: string): string {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',');
}

function buildMailtoUrl(args: { recipients: string; subject: string; body: string }): string {
  const recipients = normalizedShareRecipients(args.recipients);
  const query = new URLSearchParams({
    subject: args.subject,
    body: args.body,
  });
  return `mailto:${recipients}?${query.toString()}`;
}

function buildTeamsShareUrl(args: { recipients: string; body: string }): string {
  const url = new URL('https://teams.microsoft.com/l/chat/0/0');
  url.searchParams.set('message', args.body);
  const recipients = normalizedShareRecipients(args.recipients);
  if (recipients) {
    url.searchParams.set('users', recipients);
  }
  return url.toString();
}

export function SummaryPanel({
  intelligence,
  transcript,
  exportAdapter = browserExportAdapter,
  meetingAiSubmitAdapter = electronMeetingAiSubmitAdapter,
  autoSubmitMeetingAi = false,
  canonicalResultStatus = 'idle',
  canonicalResultError = null,
  canonicalResultAutoRetrying = false,
  onCanonicalResultRetry,
  onMeetingAiSubmitted,
  onMeetingAiError,
}: SummaryPanelProps): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmittingMeetingAi, setIsSubmittingMeetingAi] = useState(false);
  const [summaryEditMode, setSummaryEditMode] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [summaryOverride, setSummaryOverride] = useState<string | null>(null);
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, DecisionReviewDraft>>({});
  const [actionDrafts, setActionDrafts] = useState<Record<string, ActionReviewDraft>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [shareText, setShareText] = useState('');
  const [shareRecipients, setShareRecipients] = useState('');
  const autoSubmitKeyRef = useRef<string | null>(null);
  const shareDialogRef = useRef<HTMLDivElement>(null);
  const transcriptMeetingMismatch = Boolean(
    intelligence.meetingId &&
    transcript?.meetingId &&
    intelligence.meetingId !== transcript.meetingId,
  );
  const boundTranscript = transcriptMeetingMismatch ? undefined : transcript;
  const transcriptSourceSegments = transcriptSegments(boundTranscript);
  const hasTranscriptSource = transcriptSourceSegments.length > 0;
  const transcriptReadiness = boundTranscript
    ? analyzeTranscriptSourceReadiness(boundTranscript)
    : analyzeTranscriptSourceReadiness(initialTranscriptSessionFallback);
  const meetingAiGate = boundTranscript
    ? buildMeetingAiSourceGate(boundTranscript, transcriptReadiness)
    : buildMeetingAiSourceGate(initialTranscriptSessionFallback, transcriptReadiness);
  const latestTranscriptSegment =
    transcriptSourceSegments.length > 0
      ? transcriptSourceSegments[transcriptSourceSegments.length - 1]
      : null;
  const visibleIntelligence = intelligence;
  const result = visibleIntelligence.status === 'ready' ? visibleIntelligence.result : null;
  const resultKey = result
    ? [
        visibleIntelligence.meetingId ?? '',
        visibleIntelligence.sessionId ?? '',
        result.analysisRunId ?? '',
        result.generatedAtMs,
        result.providerLabel,
      ].join('|')
    : '';
  const effectiveSummaryMarkdown = result ? (summaryOverride ?? result.summaryMarkdown) : '';
  const displayResult = result
    ? {
        ...result,
        summaryMarkdown: effectiveSummaryMarkdown,
        decisions: applyDecisionReviewDrafts(result.decisions, decisionDrafts),
        actionItems: applyActionReviewDrafts(result.actionItems, actionDrafts),
      }
    : null;
  const outputFreshness = result
    ? buildOutputFreshness(result, boundTranscript, transcriptSourceSegments)
    : null;
  const outputSourceEvidence = buildOutputSourceEvidence(
    boundTranscript,
    transcriptReadiness,
    transcriptSourceSegments.length,
    outputFreshness,
  );
  const baseHandoffReadiness = displayResult
    ? analyzeMeetingOutputHandoffReadiness(displayResult)
    : null;
  const handoffReadiness = baseHandoffReadiness
    ? applyMeetingOutputSourceEvidenceReadiness(baseHandoffReadiness, outputSourceEvidence)
    : null;
  const handoffIssues = handoffReadiness
    ? [...handoffReadiness.blockers, ...handoffReadiness.warnings]
    : [];
  const baseHandoffObjectPlan = displayResult
    ? buildMeetingOutputHandoffObjectPlan(displayResult)
    : [];
  const handoffObjectPlan = applyMeetingOutputSourceEvidenceObjectPlan(
    baseHandoffObjectPlan,
    outputSourceEvidence,
  );
  const exportIntelligence = displayResult
    ? setMeetingIntelligenceResult(visibleIntelligence, displayResult)
    : visibleIntelligence;
  const latestTranscriptKey = latestTranscriptSegment
    ? `${latestTranscriptSegment.id}:${latestTranscriptSegment.status}:${latestTranscriptSegment.text.length}`
    : '-';
  const hasUserReviewChanges = hasReviewDraftChanges(
    result,
    summaryOverride,
    decisionDrafts,
    actionDrafts,
  );
  const canRefreshStaleOutput =
    outputFreshness?.status === 'source_changed' && meetingAiGate.can_submit;
  const autoSubmitKey =
    boundTranscript && meetingAiGate.can_submit
      ? [
          boundTranscript.meetingId ?? '',
          boundTranscript.sessionId ?? '',
          boundTranscript.finishedAtMs ?? '',
          transcriptSourceSegments.length,
          latestTranscriptKey,
        ].join('|')
      : null;

  useEffect(() => {
    setSummaryEditMode(false);
    setSummaryOverride(null);
    setSummaryDraft(result?.summaryMarkdown ?? '');
    setDecisionDrafts({});
    setActionDrafts({});
    setShareOpen(false);
    setShareText('');
    setShareRecipients('');
  }, [resultKey, result?.summaryMarkdown]);

  const runExport = async (
    kind:
      | 'copy'
      | 'markdown'
      | 'csv'
      | 'print'
      | 'integration-copy'
      | 'integration-json'
      | 'adapter-manifest-copy',
  ): Promise<void> => {
    setMessage(null);
    try {
      if (kind === 'adapter-manifest-copy') {
        await exportAdapter.copyText(buildMeetingOutputAdapterManifestJson(Date.now()));
        setMessage('Adapter manifesti panoya kopyalandı.');
        return;
      }
      const bundle = buildIntelligenceExport(exportIntelligence, Date.now(), outputSourceEvidence);
      if (kind === 'copy') {
        await exportAdapter.copyText(bundle.markdown);
        setMessage('Markdown panoya kopyalandı.');
      } else if (kind === 'markdown') {
        exportAdapter.downloadText(bundle.markdownFileName, bundle.markdown, 'text/markdown');
        setMessage('Markdown indirildi.');
      } else if (kind === 'csv') {
        exportAdapter.downloadText(bundle.csvFileName, bundle.csv, 'text/csv');
        setMessage('CSV indirildi.');
      } else if (kind === 'integration-copy') {
        await exportAdapter.copyText(bundle.integrationJson);
        setMessage(handoffPackageCopyMessage(handoffReadiness));
      } else if (kind === 'integration-json') {
        exportAdapter.downloadText(
          bundle.integrationJsonFileName,
          bundle.integrationJson,
          'application/json',
        );
        setMessage(handoffPackageDownloadMessage(handoffReadiness));
      } else {
        exportAdapter.print();
        setMessage('PDF için yazdırma penceresi açıldı.');
      }
    } catch (error) {
      setMessage(`Export hazır değil: ${(error as Error).message}`);
    }
  };

  const openShareDialog = (): void => {
    setMessage(null);
    try {
      const bundle = buildIntelligenceExport(exportIntelligence, Date.now(), outputSourceEvidence);
      setShareText(bundle.markdown);
      setShareOpen(true);
    } catch (error) {
      setMessage(`Paylaşım hazır değil: ${(error as Error).message}`);
    }
  };

  const runShare = async (channel: ShareChannel): Promise<void> => {
    setMessage(null);
    const body = shareText.trim();
    if (!body) {
      setMessage('Paylaşım metni boş bırakılamaz.');
      return;
    }

    try {
      if (channel === 'clipboard') {
        await exportAdapter.copyText(body);
        setMessage('Paylaşım metni panoya kopyalandı.');
        return;
      }

      const subject = shareSubject(visibleIntelligence.meetingId);
      const url =
        channel === 'email'
          ? buildMailtoUrl({ recipients: shareRecipients, subject, body })
          : buildTeamsShareUrl({ recipients: shareRecipients, body });
      if (!exportAdapter.openExternal) {
        throw new Error('External share adapter is not available');
      }
      exportAdapter.openExternal(url);
      setMessage(channel === 'email' ? 'E-posta taslağı açıldı.' : 'Teams taslağı açıldı.');
    } catch (error) {
      setMessage(`Paylaşım hazır değil: ${(error as Error).message}`);
    }
  };

  const runTranscriptExport = async (kind: 'copy' | 'markdown' | 'text'): Promise<void> => {
    setMessage(null);
    try {
      if (!boundTranscript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildTranscriptSourceExport(boundTranscript);
      if (kind === 'copy') {
        await exportAdapter.copyText(bundle.text);
        setMessage('Transkript panoya kopyalandı.');
      } else if (kind === 'markdown') {
        exportAdapter.downloadText(bundle.markdownFileName, bundle.markdown, 'text/markdown');
        setMessage('Transkript Markdown indirildi.');
      } else {
        exportAdapter.downloadText(bundle.textFileName, bundle.text, 'text/plain');
        setMessage('Transkript TXT indirildi.');
      }
    } catch (error) {
      setMessage(`Transkript export hazır değil: ${(error as Error).message}`);
    }
  };

  const runMeetingAiPackageExport = async (kind: 'copy' | 'json'): Promise<void> => {
    setMessage(null);
    try {
      if (!boundTranscript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildMeetingAiSourcePackage(boundTranscript, Date.now(), {
        consentVersion: CONSENT_VERSION,
        consentTextHash: CONSENT_TEXT_HASH,
        consentLocale: CONSENT_LOCALE,
      });
      if (kind === 'copy') {
        await exportAdapter.copyText(bundle.json);
        setMessage('Meeting AI kaynak paketi panoya kopyalandı.');
      } else {
        exportAdapter.downloadText(bundle.jsonFileName, bundle.json, 'application/json');
        setMessage('Meeting AI kaynak paketi indirildi.');
      }
    } catch (error) {
      setMessage(`Meeting AI paketi hazır değil: ${(error as Error).message}`);
    }
  };

  const runMeetingAiSubmit = useCallback(async (): Promise<void> => {
    setMessage(null);
    setIsSubmittingMeetingAi(true);
    try {
      if (!boundTranscript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildMeetingAiSourcePackage(boundTranscript, Date.now(), {
        consentVersion: CONSENT_VERSION,
        consentTextHash: CONSENT_TEXT_HASH,
        consentLocale: CONSENT_LOCALE,
      });
      if (!bundle.package.gate.can_submit || !bundle.package.meeting_id) {
        throw new Error(
          bundle.package.gate.blocked_by.join(', ') || 'Meeting AI kapısı hazır değil',
        );
      }
      await meetingAiSubmitAdapter.analyze({
        meetingId: bundle.package.meeting_id,
        request: bundle.package.request,
      });
      setSummaryEditMode(false);
      setSummaryOverride(null);
      onMeetingAiSubmitted?.();
      setMessage('Analiz tetiklendi; kalıcı sonuç hazırlanıyor.');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/failed: 422\b/.test(text)) {
        // meeting-ai (gitops#3399) durable modda /analyze doğrudan teslimini
        // bilinçli reddeder; analiz kanonik transcript.ready hattında zaten
        // üretiliyor. Bu red bir hata değil kalıcı-akış onayıdır: sonuç
        // poll'unu başlat, kullanıcıya kırmızı banner gösterme.
        onMeetingAiSubmitted?.();
        setMessage(
          'Kalıcı analiz akışı aktif: sonuç sunucuda otomatik üretiliyor, hazır olunca bu ekrana gelecek. (Doğrudan gönderim bu modda kapalı.)',
        );
        return;
      }
      onMeetingAiError?.(text);
      setMessage(`Meeting AI gönderimi hazır değil: ${text}`);
    } finally {
      setIsSubmittingMeetingAi(false);
    }
  }, [boundTranscript, meetingAiSubmitAdapter, onMeetingAiError, onMeetingAiSubmitted]);

  useEffect(() => {
    if (
      !autoSubmitMeetingAi ||
      !autoSubmitKey ||
      !meetingAiGate.can_submit ||
      result ||
      isSubmittingMeetingAi ||
      autoSubmitKeyRef.current === autoSubmitKey
    ) {
      return;
    }

    autoSubmitKeyRef.current = autoSubmitKey;
    void runMeetingAiSubmit();
  }, [
    autoSubmitMeetingAi,
    autoSubmitKey,
    isSubmittingMeetingAi,
    meetingAiGate.can_submit,
    result,
    runMeetingAiSubmit,
  ]);

  useEffect(() => {
    if (!shareOpen) {
      return undefined;
    }

    shareDialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShareOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [shareOpen]);

  const startSummaryEdit = (): void => {
    setMessage(null);
    setSummaryDraft(effectiveSummaryMarkdown);
    setSummaryEditMode(true);
  };

  const saveSummaryEdit = (): void => {
    const nextSummary = summaryDraft.trim();
    if (!nextSummary) {
      setMessage('Özet boş bırakılamaz.');
      return;
    }
    setSummaryOverride(nextSummary);
    setSummaryDraft(nextSummary);
    setSummaryEditMode(false);
    setMessage('Özet düzenlendi.');
  };

  const cancelSummaryEdit = (): void => {
    setSummaryDraft(effectiveSummaryMarkdown);
    setSummaryEditMode(false);
    setMessage(null);
  };

  const resetSummaryEdit = (): void => {
    const originalSummary = result?.summaryMarkdown ?? '';
    setSummaryOverride(null);
    setSummaryDraft(originalSummary);
    setSummaryEditMode(false);
    setMessage('Özet orijinal haline döndü.');
  };

  const updateDecisionDraft = (decisionId: string, draft: DecisionReviewDraft): void => {
    setDecisionDrafts((current) => ({
      ...current,
      [decisionId]: {
        ...current[decisionId],
        ...draft,
      },
    }));
    setMessage(null);
  };

  const resetDecisionDrafts = (): void => {
    setDecisionDrafts({});
    setMessage('Kararlar orijinal haline döndü.');
  };

  const updateActionDraft = (actionId: string, draft: ActionReviewDraft): void => {
    setActionDrafts((current) => ({
      ...current,
      [actionId]: {
        ...current[actionId],
        ...draft,
      },
    }));
    setMessage(null);
  };

  const resetActionDrafts = (): void => {
    setActionDrafts({});
    setMessage('Aksiyonlar orijinal haline döndü.');
  };

  const hasDecisionDrafts = Object.keys(decisionDrafts).length > 0;
  const hasActionDrafts = Object.keys(actionDrafts).length > 0;

  return (
    <section className="summary-panel" aria-labelledby="summary-title">
      <div className="panel-header">
        <div>
          <h2 id="summary-title">Toplantı Çıktısı</h2>
          <p className="panel-subtitle">
            {visibleIntelligence.meetingId
              ? `Meeting ${visibleIntelligence.meetingId}`
              : 'Meeting seçilmedi'}
          </p>
        </div>
        <span
          className={`state-pill ${canonicalResultStateClass(canonicalResultStatus, visibleIntelligence.status)}`}
        >
          {canonicalResultStatusLabel(
            canonicalResultStatus,
            visibleIntelligence.status,
            canonicalResultAutoRetrying,
          )}
        </span>
      </div>
      {transcriptMeetingMismatch ? (
        <p className="source-warning" role="status">
          Bu toplantının kalıcı transkripti henüz yüklenmedi; önceki toplantının transkripti bu
          sonuçla birleştirilmiyor veya dışa aktarılmıyor.
        </p>
      ) : null}

      {visibleIntelligence.error ? (
        <p className="inline-error">{visibleIntelligence.error}</p>
      ) : null}
      {canonicalResultStatus === 'error' && canonicalResultError ? (
        <div className="canonical-result-error" role="alert">
          <p className="inline-error">{canonicalResultError}</p>
          <p>
            {canonicalResultAutoRetrying
              ? 'Geçici hata; bağlantı ve pencere yeniden etkin olduğunda otomatik kontrol sürecek.'
              : 'Bu hata otomatik yeniden denenmeyecek. Yetki veya istek ayrıntısını düzeltip yeniden deneyin.'}
          </p>
          {onCanonicalResultRetry ? (
            <button className="secondary-action" type="button" onClick={onCanonicalResultRetry}>
              Tekrar dene
            </button>
          ) : null}
        </div>
      ) : null}
      {canonicalResultStatus === 'not_ready' ? (
        <div className="canonical-result-pending" role="status">
          <p>Kalıcı sonuç henüz hazır değil. Önceki snapshot varsa ekranda tutulur.</p>
          {canonicalResultAutoRetrying ? (
            <p>Arka planda düşük sıklıkta ve kontrollü olarak yeniden okunacak.</p>
          ) : null}
          {onCanonicalResultRetry ? (
            <button className="secondary-action" type="button" onClick={onCanonicalResultRetry}>
              Sonucu yenile
            </button>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="summary-toolbar" aria-label="Çıktı araçları">
            {canRefreshStaleOutput ? (
              <button
                className="primary-action"
                type="button"
                disabled={isSubmittingMeetingAi}
                onClick={() => void runMeetingAiSubmit()}
              >
                {isSubmittingMeetingAi ? 'Yenileniyor...' : 'Meeting AI yenile'}
              </button>
            ) : null}
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('copy')}
            >
              Kopyala
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('markdown')}
            >
              Markdown
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('csv')}
            >
              CSV
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('integration-copy')}
            >
              {handoffPackageCopyButtonLabel(handoffReadiness)}
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('integration-json')}
            >
              {handoffPackageJsonButtonLabel(handoffReadiness)}
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('adapter-manifest-copy')}
            >
              Manifest kopyala
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runExport('print')}
            >
              PDF
            </button>
            <button className="secondary-action" type="button" onClick={openShareDialog}>
              Paylaş
            </button>
          </div>
          {message ? <p className="export-message">{message}</p> : null}
          {shareOpen ? (
            <div className="share-overlay">
              <div
                ref={shareDialogRef}
                className="share-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="share-title"
                tabIndex={-1}
              >
                <div className="share-dialog-header">
                  <div>
                    <h3 id="share-title">Çıktıyı paylaş</h3>
                    <p>Review edilmiş çıktı paylaşılır; ham ses dosyası eklenmez.</p>
                  </div>
                  <button
                    className="secondary-action compact-action"
                    type="button"
                    onClick={() => setShareOpen(false)}
                  >
                    Kapat
                  </button>
                </div>
                <label className="share-field">
                  <span>Alıcılar</span>
                  <input
                    aria-label="Paylaşım alıcıları"
                    value={shareRecipients}
                    placeholder="zeynep@example.com"
                    onChange={(event) => setShareRecipients(event.target.value)}
                  />
                </label>
                <label className="share-field">
                  <span>Metin</span>
                  <textarea
                    aria-label="Paylaşım metni"
                    value={shareText}
                    onChange={(event) => setShareText(event.target.value)}
                  />
                </label>
                <div className="share-actions">
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void runShare('clipboard')}
                  >
                    Panoya kopyala
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => void runShare('email')}
                  >
                    E-posta taslağı
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => void runShare('teams')}
                  >
                    Teams taslağı
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {displayResult ? (
            <div className="output-quality" aria-label="Toplantı çıktısı kalite durumu">
              <div>
                <span>Kaynak</span>
                <strong>{outputSourceConfidenceLabel(displayResult.citationCoverage)}</strong>
              </div>
              <div>
                <span>Kapsam</span>
                <strong>{outputCitationCoverageLabel(displayResult.citationCoverage)}</strong>
              </div>
              <div>
                <span>Üretici</span>
                <strong>{displayResult.providerLabel ?? 'AI üretimi'}</strong>
              </div>
              <div>
                <span>Üretim</span>
                <strong>{formatClock(displayResult.generatedAtMs)}</strong>
              </div>
              {displayResult.storageMode === 'canonical' ? (
                <div title={displayResult.analysisRunId}>
                  <span>Sonuç kaydı</span>
                  <strong>Kalıcı snapshot</strong>
                </div>
              ) : null}
              <div>
                <span>İnsan kontrolü</span>
                <strong>{hasUserReviewChanges ? 'Revizyonlu' : 'Kontrol bekliyor'}</strong>
              </div>
              {outputFreshness ? (
                <div
                  className={`output-freshness output-freshness-${outputFreshness.status}`}
                  aria-label="Çıktı güncelliği"
                >
                  <span>Çıktı güncelliği</span>
                  <strong>{outputFreshness.label}</strong>
                  <small>{outputFreshness.detail}</small>
                </div>
              ) : null}
              {outputSourceEvidence?.transcript ? (
                <div>
                  <span>Transkript review</span>
                  <strong>
                    {transcriptReviewCoverageLabel(
                      transcriptReadiness,
                      transcriptSourceSegments.length,
                    )}
                  </strong>
                </div>
              ) : null}
            </div>
          ) : null}
          {displayResult ? (
            <div className="integration-readiness" aria-label="ERP/CRM entegrasyon hazırlığı">
              <div>
                <span>Hedef</span>
                <strong>ERP/CRM adaptör hedefi</strong>
              </div>
              <div>
                <span>Sözleşme</span>
                <strong>{MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION}</strong>
              </div>
              <div>
                <span>Marka</span>
                <strong>Marka bağımsız</strong>
              </div>
              <div>
                <span>Adapter profili</span>
                <strong>{MEETING_OUTPUT_ADAPTER_PROFILE_ID}</strong>
              </div>
              <div>
                <span>Manifest</span>
                <strong>{adapterManifestSummaryLabel()}</strong>
              </div>
              <div>
                <span>Aktarım kapısı</span>
                <strong>{handoffReadiness ? handoffStatusLabel(handoffReadiness) : '-'}</strong>
              </div>
              <div>
                <span>Paket</span>
                <strong>{handoffPackageStatusLabel(handoffReadiness)}</strong>
              </div>
              <div>
                <span>Kontrol</span>
                <strong>{handoffReadiness ? handoffIssueLabel(handoffReadiness) : '-'}</strong>
              </div>
              <div>
                <span>Nesneler</span>
                <strong>{integrationObjectCountLabel(displayResult)}</strong>
              </div>
              <div>
                <span>Yazım</span>
                <strong>Onaydan sonra</strong>
              </div>
              <div>
                <span>Gizlilik</span>
                <strong>Ham ses/transkript yok</strong>
              </div>
              {outputSourceEvidence?.transcript ? (
                <div>
                  <span>Kaynak kanıtı</span>
                  <strong>Review metrikli</strong>
                </div>
              ) : null}
              <div className="handoff-package" aria-label="ERP/CRM aktarım paketi durumu">
                <div>
                  <span>Yetki</span>
                  <strong>Backend adapter</strong>
                </div>
                <div>
                  <span>Kural</span>
                  <strong>Review-before-write</strong>
                </div>
                <div>
                  <span>Hata modu</span>
                  <strong>Fail-closed</strong>
                </div>
                <p>
                  Genel amaçlı ERP/CRM aktarım paketi; ERP/CRM'ye özel hedefler yalnızca backend
                  adapter eşlemesiyle bağlanır.
                </p>
              </div>
              <div className="adapter-manifest" aria-label="Genel ERP/CRM adapter manifesti">
                <div>
                  <span>Adapter türü</span>
                  <strong>{MEETING_OUTPUT_ADAPTER_KIND}</strong>
                </div>
                <div>
                  <span>Çalışma alanı</span>
                  <strong>{MEETING_OUTPUT_ADAPTER_TARGET}</strong>
                </div>
                <ul className="adapter-capability-list" aria-label="Adapter kabiliyetleri">
                  {MEETING_OUTPUT_ADAPTER_CAPABILITIES.map((capability) => (
                    <li key={capability}>
                      <span>{adapterCapabilityLabel(capability)}</span>
                      <code>{capability}</code>
                    </li>
                  ))}
                </ul>
              </div>
              {handoffIssues.length > 0 ? (
                <ul className="handoff-issue-list" aria-label="Aktarım review detayları">
                  {handoffIssues.map((issue) => (
                    <li
                      className={`handoff-issue handoff-issue-${issue.severity}`}
                      key={issue.code}
                    >
                      <strong>{handoffIssueSeverityLabel(issue)}</strong>
                      <span>{issue.label}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {handoffObjectPlan.length > 0 ? (
                <div className="handoff-object-plan" aria-label="ERP/CRM nesne önizlemesi">
                  <div className="handoff-object-row handoff-object-row-head">
                    <span>Nesne</span>
                    <span>Kayıt</span>
                    <span>Anahtar</span>
                    <span>Durum</span>
                    <span>Kontrol</span>
                  </div>
                  {handoffObjectPlan.map((entry) => (
                    <div className="handoff-object-row" key={entry.object}>
                      <strong>{entry.label}</strong>
                      <span>{handoffObjectRecordLabel(entry)}</span>
                      <span>{entry.externalKey}</span>
                      <span>{handoffObjectStatusLabel(entry)}</span>
                      <span>{handoffObjectIssueLabel(entry)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <p>{integrationSupportedObjectLabel()}</p>
            </div>
          ) : null}
          <div className="summary-content">
            <article className="summary-section">
              <div className="summary-section-heading">
                <h3>Özet</h3>
                <div className="summary-edit-actions">
                  {summaryOverride ? (
                    <button
                      className="secondary-action compact-action"
                      type="button"
                      onClick={resetSummaryEdit}
                    >
                      Orijinal
                    </button>
                  ) : null}
                  <button
                    className="secondary-action compact-action"
                    type="button"
                    onClick={summaryEditMode ? cancelSummaryEdit : startSummaryEdit}
                  >
                    {summaryEditMode ? 'Vazgeç' : 'Düzenle'}
                  </button>
                </div>
              </div>
              {summaryEditMode ? (
                <div className="summary-editor">
                  <textarea
                    aria-label="Özet metni"
                    value={summaryDraft}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                  />
                  <div className="summary-editor-actions">
                    <button
                      className="primary-action compact-action"
                      type="button"
                      disabled={!summaryDraft.trim()}
                      onClick={saveSummaryEdit}
                    >
                      Kaydet
                    </button>
                    <button
                      className="secondary-action compact-action"
                      type="button"
                      onClick={cancelSummaryEdit}
                    >
                      Vazgeç
                    </button>
                  </div>
                </div>
              ) : (
                <p>{displayResult?.summaryMarkdown ?? ''}</p>
              )}
            </article>

            <article className="summary-section">
              <div className="summary-section-heading">
                <h3>Kararlar</h3>
                {hasDecisionDrafts ? (
                  <button
                    className="secondary-action compact-action"
                    type="button"
                    onClick={resetDecisionDrafts}
                  >
                    Orijinal kararlar
                  </button>
                ) : null}
              </div>
              {displayResult && displayResult.decisions.length > 0 ? (
                <div className="decision-table action-table" role="table" aria-label="Kararlar">
                  <div className="action-row action-row-head" role="row">
                    <span role="columnheader">Karar</span>
                    <span role="columnheader">Sahip</span>
                    <span role="columnheader">Durum</span>
                    <span role="columnheader">Kaynak</span>
                    <span role="columnheader">Review</span>
                  </div>
                  {displayResult.decisions.map((decision) => {
                    const issues = decisionReviewIssues(decision);
                    return (
                      <div className="action-row" role="row" key={decision.id}>
                        <span role="cell">
                          <strong>{decision.title}</strong>
                        </span>
                        <span className="action-field" role="cell">
                          <input
                            className="action-input"
                            aria-label={`Karar sahibi: ${decision.title}`}
                            value={decision.owner ?? ''}
                            placeholder="-"
                            onChange={(event) =>
                              updateDecisionDraft(decision.id, { owner: event.target.value })
                            }
                          />
                        </span>
                        <span className="action-field" role="cell">
                          <select
                            className="action-input"
                            aria-label={`Karar durumu: ${decision.title}`}
                            value={decision.status}
                            onChange={(event) =>
                              updateDecisionDraft(decision.id, {
                                status: event.target.value as DecisionStatus,
                              })
                            }
                          >
                            {DECISION_STATUS_OPTIONS.map((status) => (
                              <option key={status} value={status}>
                                {decisionStatusLabel(status)}
                              </option>
                            ))}
                          </select>
                        </span>
                        <span role="cell">{formatCitations(decision.citations)}</span>
                        <span className="row-review" role="cell">
                          {issues.length > 0
                            ? issues.map((issue) => <small key={issue}>{issue}</small>)
                            : 'Hazır'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted-line">Karar yok.</p>
              )}
            </article>

            <article className="summary-section">
              <div className="summary-section-heading">
                <h3>Aksiyonlar</h3>
                {hasActionDrafts ? (
                  <button
                    className="secondary-action compact-action"
                    type="button"
                    onClick={resetActionDrafts}
                  >
                    Orijinal aksiyonlar
                  </button>
                ) : null}
              </div>
              {displayResult && displayResult.actionItems.length > 0 ? (
                <div className="action-table" role="table" aria-label="Aksiyonlar">
                  <div className="action-row action-row-head" role="row">
                    <span role="columnheader">Aksiyon</span>
                    <span role="columnheader">Sahip</span>
                    <span role="columnheader">Tarih</span>
                    <span role="columnheader">Durum</span>
                    <span role="columnheader">Kaynak</span>
                    <span role="columnheader">Review</span>
                  </div>
                  {displayResult.actionItems.map((item) => {
                    const issues = actionReviewIssues(item);
                    return (
                      <div className="action-row" role="row" key={item.id}>
                        <span role="cell">{item.title}</span>
                        <span className="action-field" role="cell">
                          <input
                            className="action-input"
                            aria-label={`Sahip: ${item.title}`}
                            value={item.assignee ?? ''}
                            placeholder="-"
                            onChange={(event) =>
                              updateActionDraft(item.id, { assignee: event.target.value })
                            }
                          />
                        </span>
                        <span className="action-field" role="cell">
                          <input
                            className="action-input"
                            aria-label={`Tarih: ${item.title}`}
                            type="date"
                            value={item.dueDate ?? ''}
                            onChange={(event) =>
                              updateActionDraft(item.id, { dueDate: event.target.value })
                            }
                          />
                        </span>
                        <span className="action-field" role="cell">
                          <select
                            className="action-input"
                            aria-label={`Durum: ${item.title}`}
                            value={item.status}
                            onChange={(event) =>
                              updateActionDraft(item.id, {
                                status: event.target.value as ActionStatus,
                              })
                            }
                          >
                            {ACTION_STATUS_OPTIONS.map((status) => (
                              <option key={status} value={status}>
                                {actionStatusLabel(status)}
                              </option>
                            ))}
                          </select>
                        </span>
                        <span role="cell">{formatCitations(item.citations)}</span>
                        <span className="row-review" role="cell">
                          {issues.length > 0
                            ? issues.map((issue) => <small key={issue}>{issue}</small>)
                            : 'Hazır'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted-line">Aksiyon yok.</p>
              )}
            </article>
          </div>
        </>
      ) : hasTranscriptSource ? (
        <>
          <div className="summary-toolbar" aria-label="Transkript kaynak araçları">
            <button
              className="primary-action"
              type="button"
              disabled={!meetingAiGate.can_submit || isSubmittingMeetingAi}
              onClick={() => void runMeetingAiSubmit()}
            >
              {isSubmittingMeetingAi
                ? 'Gönderiliyor...'
                : transcriptReadiness.level === 'review' && meetingAiGate.can_submit
                  ? 'Taslakla Meeting AI gönder'
                  : 'Meeting AI gönder'}
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runTranscriptExport('copy')}
            >
              Transkript kopyala
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runTranscriptExport('markdown')}
            >
              Transkript MD
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runTranscriptExport('text')}
            >
              Transkript TXT
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runMeetingAiPackageExport('copy')}
            >
              AI paketi kopyala
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runMeetingAiPackageExport('json')}
            >
              AI JSON
            </button>
          </div>
          {message ? <p className="export-message">{message}</p> : null}
          <div className="summary-content">
            <div className="summary-section">
              <h3>Kaynak transkript</h3>
              <div
                className={`source-readiness source-readiness-${transcriptReadiness.level}`}
                aria-label="Kaynak hazırlık durumu"
              >
                <strong>{transcriptReadiness.label}</strong>
                <span>{transcriptReadiness.detail}</span>
                {transcriptReadiness.warnings.length > 0 ? (
                  <small>{transcriptReadiness.warnings.join(' ')}</small>
                ) : null}
              </div>
              <div className="source-next-step" aria-label="Sıradaki kapı">
                <span>Sıradaki kapı</span>
                <strong>{transcriptReadiness.nextStepLabel}</strong>
                <small>{transcriptReadiness.nextStepDetail}</small>
              </div>
              <div
                className={`source-quality-gate source-quality-gate-${transcriptReadiness.qualityGate.status}`}
                aria-label="Kaynak kalite kapısı"
              >
                <span>Kalite kapısı</span>
                <strong>{transcriptReadiness.qualityGate.label}</strong>
                <small>{transcriptReadiness.qualityGate.action}</small>
              </div>
              <div className="source-ai-package" aria-label="Meeting AI kaynak paketi">
                <span>Meeting AI kaynak paketi</span>
                <strong>
                  {meetingAiGate.can_submit
                    ? transcriptReadiness.level === 'review'
                      ? 'Taslak kaynakla gönderilebilir'
                      : 'Gönderime hazır kaynak'
                    : 'Kapı kontrolü bekliyor'}
                </strong>
                <small>
                  Backend gateway -&gt; meeting-ai /analyze kontratı için transcript, meeting_id,
                  session_id ve zamanlı segmentler paketlenir; desktop client doğrudan platform-ai
                  çağırmaz.
                </small>
              </div>
              <div className="source-gate-grid" aria-label="Meeting AI kapı kontrolü">
                <div>
                  <span>Gönderim</span>
                  <strong>{meetingAiGate.label}</strong>
                </div>
                <div>
                  <span>Rota</span>
                  <strong>
                    {meetingAiGate.contract.submit_via} -&gt; {meetingAiGate.contract.endpoint}
                  </strong>
                </div>
                <div>
                  <span>Client sınırı</span>
                  <strong>
                    {meetingAiGate.contract.direct_platform_ai_allowed
                      ? 'Direct platform-ai'
                      : 'Gateway zorunlu'}
                  </strong>
                </div>
                <div>
                  <span>Engel</span>
                  <strong>
                    {meetingAiGate.blocked_by.length > 0
                      ? meetingAiGate.blocked_by.join(', ')
                      : 'Yok'}
                  </strong>
                </div>
                <p>{meetingAiGate.next_action}</p>
              </div>
              <div className="source-privacy-grid" aria-label="KVKK kaynak sınırı">
                <div>
                  <span>Veri</span>
                  <strong>Transcript içerir</strong>
                </div>
                <div>
                  <span>Ses</span>
                  <strong>Raw audio yok</strong>
                </div>
                <div>
                  <span>Yerel cache</span>
                  <strong>Yok</strong>
                </div>
                <div>
                  <span>Rıza</span>
                  <strong>{CONSENT_VERSION}</strong>
                </div>
                <p>
                  Kaynak paketi kullanıcı aksiyonuyla üretilir; desktop ham ses verisini pakete
                  koymaz.
                </p>
              </div>
              <div className="source-metrics" aria-label="Kaynak transkript özeti">
                <div>
                  <span>Satır</span>
                  <strong>{transcriptSourceSegments.length}</strong>
                </div>
                <div>
                  <span>Durum</span>
                  <strong>{finalityLabel(transcriptSourceSegments)}</strong>
                </div>
                <div>
                  <span>Akış</span>
                  <strong>{transcriptSourceMode(transcriptSourceSegments)}</strong>
                </div>
                <div>
                  <span>Zaman</span>
                  <strong>{transcriptWindowLabel(transcriptSourceSegments)}</strong>
                </div>
                <div>
                  <span>Kelime</span>
                  <strong>{transcriptReadiness.wordCount}</strong>
                </div>
                <div>
                  <span>Kelime/dk</span>
                  <strong>{formatWordRate(transcriptReadiness.wordRatePerMinute)}</strong>
                </div>
                <div>
                  <span>Süre</span>
                  <strong>{formatDurationMs(transcriptReadiness.durationMs)}</strong>
                </div>
                <div>
                  <span>Final oranı</span>
                  <strong>{formatPercent(transcriptReadiness.finalRatio)}</strong>
                </div>
                <div>
                  <span>İnceleme</span>
                  <strong>
                    {transcriptReviewCoverageLabel(
                      transcriptReadiness,
                      transcriptSourceSegments.length,
                    )}
                  </strong>
                </div>
                <div>
                  <span>Kalite riski</span>
                  <strong>{transcriptReadiness.qualityGate.risk}</strong>
                </div>
              </div>
              {latestTranscriptSegment ? (
                <div className="source-preview">
                  <span>
                    Son satır · {transcriptStatusLabel(latestTranscriptSegment.status)} ·{' '}
                    {segmentSourceLabel(latestTranscriptSegment)}
                  </span>
                  <p>"{latestTranscriptSegment.text}"</p>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <div className="summary-empty" aria-live="polite">
          <strong>{canonicalResultEmptyTitle(canonicalResultStatus)}</strong>
          <span>{emptyStateText(visibleIntelligence.status, canonicalResultStatus)}</span>
        </div>
      )}
    </section>
  );
}

const initialTranscriptSessionFallback: TranscriptSessionState = {
  lifecycle: 'idle',
  sessionId: null,
  gatewaySessionId: null,
  meetingId: null,
  deviceId: null,
  hasLoopback: false,
  startedAtMs: null,
  finishedAtMs: null,
  error: null,
  segments: [],
};

function formatCitations(citations: IntelligenceCitation[]): string {
  if (citations.length === 0) {
    return '-';
  }
  return citations.map(formatCitationTime).join(', ');
}

function canonicalResultStatusLabel(
  canonicalStatus: CanonicalResultLoadStatus,
  intelligenceStatus: MeetingIntelligenceState['status'],
  autoRetrying: boolean,
): string {
  if (canonicalStatus === 'loading') {
    return 'Yükleniyor';
  }
  if (canonicalStatus === 'not_ready') {
    return 'Hazırlanıyor';
  }
  if (canonicalStatus === 'error') {
    return autoRetrying ? 'Geçici bağlantı hatası' : 'İstek hatası';
  }
  if (canonicalStatus === 'ready') {
    return 'Kalıcı sonuç';
  }
  return intelligenceStatusLabel(intelligenceStatus);
}

function canonicalResultStateClass(
  canonicalStatus: CanonicalResultLoadStatus,
  intelligenceStatus: MeetingIntelligenceState['status'],
): string {
  if (canonicalStatus === 'error') {
    return 'state-error';
  }
  if (canonicalStatus === 'ready') {
    return 'state-ready';
  }
  if (canonicalStatus === 'loading' || canonicalStatus === 'not_ready') {
    return 'state-waiting';
  }
  return `state-${intelligenceStatus}`;
}

function canonicalResultEmptyTitle(status: CanonicalResultLoadStatus): string {
  if (status === 'loading') {
    return 'Kalıcı toplantı çıktısı yükleniyor';
  }
  if (status === 'not_ready') {
    return 'Analiz sonucu hazırlanıyor';
  }
  if (status === 'error') {
    return 'Kalıcı sonuç alınamadı';
  }
  return 'Toplantı çıktısı bekleniyor';
}

function emptyStateText(
  status: MeetingIntelligenceState['status'],
  canonicalStatus: CanonicalResultLoadStatus,
): string {
  if (canonicalStatus === 'loading') {
    return 'Meeting-service üzerindeki canonical snapshot kontrol ediliyor.';
  }
  if (canonicalStatus === 'not_ready') {
    return 'Kalıcı sonuç henüz hazır değil; durumu yeniden kontrol edebilirsiniz.';
  }
  if (canonicalStatus === 'error') {
    return 'Bağlantıyı kontrol edip tekrar deneyin; oturum içi preview sonuç olarak gösterilmez.';
  }
  if (status === 'recording') {
    return 'Kayıt sürüyor.';
  }
  if (status === 'waiting') {
    return 'Gateway çıktısı ve meeting-ai sonucu bekleniyor.';
  }
  if (status === 'blocked') {
    return 'Canonical meetingId olmadan çıktı üretimi başlamaz.';
  }
  if (status === 'error') {
    return 'Son işlem hata verdi.';
  }
  return 'Kayıt tamamlanınca özet, karar ve aksiyonlar burada görünür.';
}
