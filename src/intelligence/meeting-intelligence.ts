import {
  MEETING_OUTPUT_ADAPTER_CAPABILITIES,
  MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION,
  MEETING_OUTPUT_ADAPTER_KIND,
  MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
  MEETING_OUTPUT_ADAPTER_PROFILE_ID,
  MEETING_OUTPUT_ADAPTER_TARGET,
  MEETING_OUTPUT_SUPPORTED_OBJECTS,
} from './meeting-output-contract';

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

export type MeetingOutputHandoffReadinessStatus = 'ready' | 'needs_review';

export type MeetingOutputHandoffIssueSeverity = 'blocker' | 'warning';

export type MeetingOutputHandoffIssueCode =
  | 'missing_summary'
  | 'missing_action_assignee'
  | 'missing_action_due_date'
  | 'missing_decision_owner'
  | 'missing_source_reference'
  | 'unknown_citation_coverage'
  | 'low_citation_coverage'
  | 'stale_source_evidence';

export interface MeetingOutputHandoffIssue {
  code: MeetingOutputHandoffIssueCode;
  severity: MeetingOutputHandoffIssueSeverity;
  label: string;
  count?: number;
}

export interface MeetingOutputHandoffReadiness {
  status: MeetingOutputHandoffReadinessStatus;
  canHandoff: boolean;
  blockers: MeetingOutputHandoffIssue[];
  warnings: MeetingOutputHandoffIssue[];
}

export type MeetingOutputHandoffObjectStatus = 'ready' | 'needs_review';

export type MeetingOutputHandoffObject = (typeof MEETING_OUTPUT_SUPPORTED_OBJECTS)[number];

export interface MeetingOutputHandoffObjectPlan {
  object: MeetingOutputHandoffObject;
  label: string;
  operation: 'upsert';
  records: number;
  externalKey: string;
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  status: MeetingOutputHandoffObjectStatus;
  issues: MeetingOutputHandoffIssue[];
}

export interface MeetingIntelligenceState {
  status: IntelligenceStatus;
  meetingId: string | null;
  sessionId: string | null;
  error: string | null;
  result: MeetingIntelligenceResult | null;
}

export interface MeetingOutputSourceEvidence {
  transcript: {
    source_level: string;
    source_label: string;
    lifecycle: string;
    segment_count: number;
    word_count: number;
    duration_ms: number;
    final_count: number;
    draft_count: number;
    final_ratio: number;
    reviewed_count: number;
    reviewed_ratio: number;
    result_freshness: {
      status: string;
      label: string;
      result_generated_at_ms: number;
      latest_source_at_ms: number | null;
      stale_by_ms: number;
      raw_transcript_included: false;
    } | null;
    raw_transcript_included: false;
  } | null;
}

export interface ExportBundle {
  markdown: string;
  csv: string;
  integrationJson: string;
  markdownFileName: string;
  csvFileName: string;
  integrationJsonFileName: string;
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

const HANDOFF_OBJECT_LABELS: Record<MeetingOutputHandoffObject, string> = {
  meeting_note: 'Toplantı notu',
  decision_record: 'Karar kayıtları',
  action_task: 'Aksiyon görevleri',
};

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
  sourceEvidence: MeetingOutputSourceEvidence | null = null,
): ExportBundle {
  if (!state.result) {
    throw new Error('Meeting intelligence output is not ready');
  }

  const safeMeetingId = safeFilePart(state.meetingId ?? 'meeting');
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return {
    markdown: buildMarkdown(state),
    csv: buildCsv(state.result),
    integrationJson: buildIntegrationJson(state, nowMs, sourceEvidence),
    markdownFileName: `meeting-intelligence-${safeMeetingId}-${stamp}.md`,
    csvFileName: `meeting-intelligence-actions-${safeMeetingId}-${stamp}.csv`,
    integrationJsonFileName: `meeting-output-integration-${safeMeetingId}-${stamp}.json`,
  };
}

export function buildMeetingOutputAdapterManifestJson(nowMs: number = Date.now()): string {
  return `${JSON.stringify(
    {
      schema_version: 'platform-desktop.meeting-output-adapter-manifest.v1',
      profile_id: MEETING_OUTPUT_ADAPTER_PROFILE_ID,
      adapter_kind: MEETING_OUTPUT_ADAPTER_KIND,
      contract_version: MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION,
      target_family: 'erp_crm',
      target: MEETING_OUTPUT_ADAPTER_TARGET,
      vendor_specific: false,
      source_system: 'platform-meeting-intelligence',
      generated_at: new Date(nowMs).toISOString(),
      write_policy: 'review_before_write',
      desktop_direct_backend_mutation: false,
      required_capabilities: MEETING_OUTPUT_ADAPTER_CAPABILITIES,
      supported_objects: MEETING_OUTPUT_SUPPORTED_OBJECTS,
      object_contracts: MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
      privacy_guards: {
        raw_audio_included: false,
        raw_transcript_included: false,
        requires_human_review: true,
      },
    },
    null,
    2,
  )}\n`;
}

export function analyzeMeetingOutputHandoffReadiness(
  result: MeetingIntelligenceResult,
): MeetingOutputHandoffReadiness {
  const blockers: MeetingOutputHandoffIssue[] = [];
  const warnings: MeetingOutputHandoffIssue[] = [];
  const openActions = result.actionItems.filter((item) => item.status !== 'done');
  const missingActionAssigneeCount = openActions.filter(
    (item) => !hasMeaningfulText(item.assignee),
  ).length;
  const missingActionDueDateCount = openActions.filter(
    (item) => !hasMeaningfulText(item.dueDate),
  ).length;
  const missingDecisionOwnerCount = result.decisions.filter(
    (decision) => !hasMeaningfulText(decision.owner),
  ).length;
  const uncitedRecordCount =
    result.decisions.filter((decision) => decision.citations.length === 0).length +
    result.actionItems.filter((item) => item.citations.length === 0).length;
  const citationCoverage = normalizedHandoffCitationCoverage(result.citationCoverage);

  if (!hasMeaningfulText(result.summaryMarkdown)) {
    blockers.push({
      code: 'missing_summary',
      severity: 'blocker',
      label: 'Toplantı özeti boş',
    });
  }
  if (missingActionAssigneeCount > 0) {
    blockers.push({
      code: 'missing_action_assignee',
      severity: 'blocker',
      label: `${missingActionAssigneeCount} açık aksiyonda sahip eksik`,
      count: missingActionAssigneeCount,
    });
  }
  if (missingActionDueDateCount > 0) {
    warnings.push({
      code: 'missing_action_due_date',
      severity: 'warning',
      label: `${missingActionDueDateCount} açık aksiyonda tarih eksik`,
      count: missingActionDueDateCount,
    });
  }
  if (missingDecisionOwnerCount > 0) {
    blockers.push({
      code: 'missing_decision_owner',
      severity: 'blocker',
      label: `${missingDecisionOwnerCount} kararda sahip eksik`,
      count: missingDecisionOwnerCount,
    });
  }
  if (uncitedRecordCount > 0) {
    warnings.push({
      code: 'missing_source_reference',
      severity: 'warning',
      label: `${uncitedRecordCount} karar/aksiyonda kaynak referansı eksik`,
      count: uncitedRecordCount,
    });
  }
  if (citationCoverage === null) {
    warnings.push({
      code: 'unknown_citation_coverage',
      severity: 'warning',
      label: 'Kaynak kapsamı bilinmiyor',
    });
  } else if (citationCoverage < 0.5) {
    warnings.push({
      code: 'low_citation_coverage',
      severity: 'warning',
      label: 'Kaynak kapsamı %50 altında',
    });
  }

  const canHandoff = blockers.length === 0 && warnings.length === 0;
  return {
    status: canHandoff ? 'ready' : 'needs_review',
    canHandoff,
    blockers,
    warnings,
  };
}

export function buildMeetingOutputHandoffObjectPlan(
  result: MeetingIntelligenceResult,
): MeetingOutputHandoffObjectPlan[] {
  const citationCoverage = normalizedHandoffCitationCoverage(result.citationCoverage);
  return MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS.map((contract) => {
    const object = contract.object;
    const issues = handoffObjectIssues(result, object, citationCoverage);
    return {
      object,
      label: HANDOFF_OBJECT_LABELS[object],
      operation: contract.operation,
      records: handoffObjectRecordCount(result, object),
      externalKey: contract.external_key,
      requiredFields: contract.required_fields,
      optionalFields: contract.optional_fields,
      status: issues.length === 0 ? 'ready' : 'needs_review',
      issues,
    };
  });
}

export function applyMeetingOutputSourceEvidenceReadiness(
  readiness: MeetingOutputHandoffReadiness,
  sourceEvidence: MeetingOutputSourceEvidence | null,
): MeetingOutputHandoffReadiness {
  const sourceIssue = staleSourceEvidenceIssue(sourceEvidence);
  if (!sourceIssue) {
    return readiness;
  }

  const blockers = [
    ...readiness.blockers.filter((issue) => issue.code !== sourceIssue.code),
    sourceIssue,
  ];
  return {
    status: 'needs_review',
    canHandoff: false,
    blockers,
    warnings: readiness.warnings,
  };
}

export function applyMeetingOutputSourceEvidenceObjectPlan(
  objectPlan: MeetingOutputHandoffObjectPlan[],
  sourceEvidence: MeetingOutputSourceEvidence | null,
): MeetingOutputHandoffObjectPlan[] {
  const sourceIssue = staleSourceEvidenceIssue(sourceEvidence);
  if (!sourceIssue) {
    return objectPlan;
  }

  return objectPlan.map((entry) => ({
    ...entry,
    status: 'needs_review',
    issues: [...entry.issues.filter((issue) => issue.code !== sourceIssue.code), sourceIssue],
  }));
}

function staleSourceEvidenceIssue(
  sourceEvidence: MeetingOutputSourceEvidence | null,
): MeetingOutputHandoffIssue | null {
  if (sourceEvidence?.transcript?.result_freshness?.status !== 'source_changed') {
    return null;
  }

  return {
    code: 'stale_source_evidence',
    severity: 'blocker',
    label: 'Transkript AI çıktısından sonra değişti',
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

function buildIntegrationJson(
  state: MeetingIntelligenceState,
  nowMs: number,
  sourceEvidence: MeetingOutputSourceEvidence | null,
): string {
  const result = state.result;
  if (!result) {
    throw new Error('Meeting intelligence output is not ready');
  }
  const contentFingerprint = intelligenceContentFingerprint(result);
  const handoffReadiness = applyMeetingOutputSourceEvidenceReadiness(
    analyzeMeetingOutputHandoffReadiness(result),
    sourceEvidence,
  );
  const objectPlan = applyMeetingOutputSourceEvidenceObjectPlan(
    buildMeetingOutputHandoffObjectPlan(result),
    sourceEvidence,
  );
  const idempotencyKey = [
    'meeting-output',
    state.meetingId ?? 'meeting',
    state.sessionId ?? 'session',
    new Date(result.generatedAtMs).toISOString(),
    contentFingerprint,
  ].join(':');
  const displayTitle = `Meeting Intelligence · ${state.meetingId ?? state.sessionId ?? 'meeting'}`;

  return `${JSON.stringify(
    {
      schema_version: 'platform-desktop.meeting-output-integration.v1',
      package_type: 'reviewed_meeting_intelligence',
      display_title: displayTitle,
      adapter_contract: {
        version: MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION,
        vendor_specific: false,
        idempotency_key: idempotencyKey,
        content_fingerprint: contentFingerprint,
        write_policy: 'review_before_write',
        source_system: 'platform-meeting-intelligence',
        supported_objects: MEETING_OUTPUT_SUPPORTED_OBJECTS,
      },
      adapter_manifest: {
        profile_id: MEETING_OUTPUT_ADAPTER_PROFILE_ID,
        adapter_kind: MEETING_OUTPUT_ADAPTER_KIND,
        target_family: 'erp_crm',
        vendor_specific: false,
        required_capabilities: MEETING_OUTPUT_ADAPTER_CAPABILITIES,
        object_contracts: MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS,
      },
      route: {
        target: MEETING_OUTPUT_ADAPTER_TARGET,
        expected_authority: 'backend-gateway / meeting-service integration adapter',
        desktop_direct_backend_mutation: false,
      },
      privacy: {
        classification: 'confidential_meeting_intelligence',
        raw_audio_included: false,
        raw_transcript_included: false,
        contains_ai_summary: true,
        contains_reviewed_actions: true,
        contains_reviewed_decisions: true,
      },
      source_evidence: sourceEvidence,
      meeting_id: state.meetingId,
      session_id: state.sessionId,
      exported_at: new Date(nowMs).toISOString(),
      generated_at: new Date(result.generatedAtMs).toISOString(),
      provider: result.providerLabel ?? null,
      citation_coverage: result.citationCoverage,
      import_targets: ['meeting.summary', 'meeting.decisions', 'meeting.actions'],
      sync_policy: {
        mode: 'upsert_by_idempotency_key',
        requires_human_review: true,
        desktop_mutates_erp_crm: false,
        failure_mode: 'fail_closed',
      },
      handoff_readiness: {
        status: handoffReadiness.status,
        can_handoff: handoffReadiness.canHandoff,
        blockers: handoffReadiness.blockers,
        warnings: handoffReadiness.warnings,
      },
      object_plan: objectPlan.map((entry) => ({
        object: entry.object,
        label: entry.label,
        operation: entry.operation,
        records: entry.records,
        external_key: entry.externalKey,
        required_fields: entry.requiredFields,
        optional_fields: entry.optionalFields,
        status: entry.status,
        issues: entry.issues,
      })),
      field_mappings: {
        mapping_type: 'field_pointer',
        meeting_note: {
          external_key: 'meeting_id',
          title: 'display_title',
          body: 'summary_markdown',
          source_refs: 'citations',
        },
        decision_record: {
          external_key: 'decision.id',
          title: 'decision.title',
          owner: 'decision.owner',
          status: 'decision.status',
          source_refs: 'decision.citations',
        },
        action_task: {
          external_key: 'action.id',
          title: 'action.title',
          assignee: 'action.assignee',
          due_date: 'action.due_date',
          status: 'action.status',
          priority: 'action.priority',
          source_refs: 'action.citations',
        },
      },
      summary_markdown: result.summaryMarkdown.trim(),
      decisions: result.decisions.map((decision) => ({
        id: decision.id,
        title: decision.title,
        owner: decision.owner ?? null,
        status: decision.status,
        status_label: decisionStatusLabel(decision.status),
        citations: decision.citations.map(integrationCitation),
      })),
      action_items: result.actionItems.map((item) => ({
        id: item.id,
        title: item.title,
        assignee: item.assignee ?? null,
        due_date: item.dueDate ?? null,
        status: item.status,
        status_label: actionStatusLabel(item.status),
        priority: item.priority ?? null,
        citations: item.citations.map(integrationCitation),
      })),
    },
    null,
    2,
  )}\n`;
}

function intelligenceContentFingerprint(result: MeetingIntelligenceResult): string {
  const payload = JSON.stringify({
    summaryMarkdown: result.summaryMarkdown.trim(),
    decisions: result.decisions.map((decision) => ({
      id: decision.id,
      title: decision.title,
      owner: decision.owner ?? null,
      status: decision.status,
      citations: decision.citations,
    })),
    actionItems: result.actionItems.map((item) => ({
      id: item.id,
      title: item.title,
      assignee: item.assignee ?? null,
      dueDate: item.dueDate ?? null,
      status: item.status,
      priority: item.priority ?? null,
      citations: item.citations,
    })),
    providerLabel: result.providerLabel ?? null,
    citationCoverage: result.citationCoverage,
  });
  return `fnv1a64:${fnv1a64(payload)}`;
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedHandoffCitationCoverage(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function handoffObjectRecordCount(
  result: MeetingIntelligenceResult,
  object: MeetingOutputHandoffObject,
): number {
  if (object === 'meeting_note') {
    return 1;
  }
  if (object === 'decision_record') {
    return result.decisions.length;
  }
  return result.actionItems.length;
}

function handoffObjectIssues(
  result: MeetingIntelligenceResult,
  object: MeetingOutputHandoffObject,
  citationCoverage: number | null,
): MeetingOutputHandoffIssue[] {
  if (object === 'meeting_note') {
    return meetingNoteHandoffIssues(result, citationCoverage);
  }
  if (object === 'decision_record') {
    return decisionHandoffIssues(result);
  }
  return actionHandoffIssues(result);
}

function meetingNoteHandoffIssues(
  result: MeetingIntelligenceResult,
  citationCoverage: number | null,
): MeetingOutputHandoffIssue[] {
  const issues: MeetingOutputHandoffIssue[] = [];
  if (!hasMeaningfulText(result.summaryMarkdown)) {
    issues.push({
      code: 'missing_summary',
      severity: 'blocker',
      label: 'Toplantı özeti boş',
    });
  }
  if (citationCoverage === null) {
    issues.push({
      code: 'unknown_citation_coverage',
      severity: 'warning',
      label: 'Kaynak kapsamı bilinmiyor',
    });
  } else if (citationCoverage < 0.5) {
    issues.push({
      code: 'low_citation_coverage',
      severity: 'warning',
      label: 'Kaynak kapsamı %50 altında',
    });
  }
  return issues;
}

function decisionHandoffIssues(result: MeetingIntelligenceResult): MeetingOutputHandoffIssue[] {
  const missingOwnerCount = result.decisions.filter(
    (decision) => !hasMeaningfulText(decision.owner),
  ).length;
  const missingCitationCount = result.decisions.filter(
    (decision) => decision.citations.length === 0,
  ).length;
  return [
    ...(missingOwnerCount > 0
      ? [
          {
            code: 'missing_decision_owner' as const,
            severity: 'blocker' as const,
            label: `${missingOwnerCount} kararda sahip eksik`,
            count: missingOwnerCount,
          },
        ]
      : []),
    ...(missingCitationCount > 0
      ? [
          {
            code: 'missing_source_reference' as const,
            severity: 'warning' as const,
            label: `${missingCitationCount} kararda kaynak referansı eksik`,
            count: missingCitationCount,
          },
        ]
      : []),
  ];
}

function actionHandoffIssues(result: MeetingIntelligenceResult): MeetingOutputHandoffIssue[] {
  const openActions = result.actionItems.filter((item) => item.status !== 'done');
  const missingAssigneeCount = openActions.filter(
    (item) => !hasMeaningfulText(item.assignee),
  ).length;
  const missingDueDateCount = openActions.filter((item) => !hasMeaningfulText(item.dueDate)).length;
  const missingCitationCount = result.actionItems.filter(
    (item) => item.citations.length === 0,
  ).length;
  return [
    ...(missingAssigneeCount > 0
      ? [
          {
            code: 'missing_action_assignee' as const,
            severity: 'blocker' as const,
            label: `${missingAssigneeCount} açık aksiyonda sahip eksik`,
            count: missingAssigneeCount,
          },
        ]
      : []),
    ...(missingDueDateCount > 0
      ? [
          {
            code: 'missing_action_due_date' as const,
            severity: 'warning' as const,
            label: `${missingDueDateCount} açık aksiyonda tarih eksik`,
            count: missingDueDateCount,
          },
        ]
      : []),
    ...(missingCitationCount > 0
      ? [
          {
            code: 'missing_source_reference' as const,
            severity: 'warning' as const,
            label: `${missingCitationCount} aksiyonda kaynak referansı eksik`,
            count: missingCitationCount,
          },
        ]
      : []),
  ];
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function integrationCitation(citation: IntelligenceCitation): {
  segment_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  label: string;
} {
  return {
    segment_id: citation.segmentId,
    started_at_ms: citation.startedAtMs,
    ended_at_ms: citation.endedAtMs ?? null,
    label: formatCitationTime(citation),
  };
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
