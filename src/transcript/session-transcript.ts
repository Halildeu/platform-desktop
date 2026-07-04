export type TranscriptSegmentStatus = 'draft' | 'stabilizing' | 'final' | 'revised';

export type TranscriptLifecycle =
  | 'idle'
  | 'ready'
  | 'recording'
  | 'processing'
  | 'finished'
  | 'blocked'
  | 'error';

export interface TranscriptSegment {
  id: string;
  speakerLabel: string;
  startedAtMs: number;
  endedAtMs?: number | null;
  status: TranscriptSegmentStatus;
  text: string;
  revisedFromId?: string;
  source?: 'direct-stream' | 'gateway-events';
  elapsedMs?: number | null;
  rms?: number | null;
  receivedAtMs?: number | null;
}

export interface TranscriptSessionState {
  lifecycle: TranscriptLifecycle;
  sessionId: string | null;
  meetingId: string | null;
  deviceId: string | null;
  hasLoopback: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  error: string | null;
  segments: TranscriptSegment[];
}

export interface TranscriptSourceExportBundle {
  markdown: string;
  text: string;
  markdownFileName: string;
  textFileName: string;
}

export interface MeetingAiAnalyzeSegment {
  text: string;
  start: number;
  end?: number;
}

export interface MeetingAiAnalyzeRequest {
  transcript: string;
  meeting_id: string | null;
  session_id: string | null;
  segments: MeetingAiAnalyzeSegment[];
}

export type MeetingAiSourceGateStatus = 'blocked' | 'collecting' | 'review' | 'ready';

export interface MeetingAiSourceGate {
  status: MeetingAiSourceGateStatus;
  can_submit: boolean;
  label: string;
  next_action: string;
  blocked_by: string[];
  contract: {
    submit_via: 'backend-gateway';
    endpoint: 'meeting-ai /analyze';
    direct_platform_ai_allowed: false;
  };
}

export interface MeetingAiSourcePackageOptions {
  consentVersion?: string | null;
  consentTextHash?: string | null;
  consentLocale?: string | null;
}

export interface MeetingAiSourcePrivacy {
  classification: 'confidential_transcript';
  transcript_included: true;
  raw_audio_included: false;
  local_raw_audio_cache: false;
  export_requires_user_action: true;
  kvkk_boundary: 'desktop-source-export';
  consent: {
    required: true;
    version: string | null;
    text_hash: string | null;
    locale: string | null;
  };
}

export interface MeetingAiSourcePackage {
  schema_version: 'platform-desktop.meeting-ai-source.v1';
  generated_at: string;
  route: {
    target: 'backend-gateway -> meeting-ai /analyze';
    client_direct_platform_ai: false;
  };
  gate: MeetingAiSourceGate;
  privacy: MeetingAiSourcePrivacy;
  source_quality: {
    level: TranscriptSourceReadinessLevel;
    label: string;
    word_count: number;
    duration_ms: number;
    final_count: number;
    draft_count: number;
    final_ratio: number;
    warnings: string[];
  };
  meeting_id: string | null;
  session_id: string | null;
  device_id: string | null;
  source: 'microphone' | 'microphone_loopback';
  request: MeetingAiAnalyzeRequest;
}

export interface MeetingAiSourcePackageBundle {
  json: string;
  jsonFileName: string;
  package: MeetingAiSourcePackage;
}

export type TranscriptSourceReadinessLevel = 'empty' | 'collecting' | 'review' | 'ready';

export interface TranscriptSourceReadiness {
  level: TranscriptSourceReadinessLevel;
  label: string;
  detail: string;
  nextStepLabel: string;
  nextStepDetail: string;
  wordCount: number;
  durationMs: number;
  finalCount: number;
  draftCount: number;
  finalRatio: number;
  warnings: string[];
}

const STATUS_RANK: Record<TranscriptSegmentStatus, number> = {
  draft: 0,
  stabilizing: 1,
  final: 2,
  revised: 3,
};

const REPORT_READY_MIN_WORDS = 20;
const REPORT_READY_MIN_DURATION_MS = 15_000;

function hasMinimumMeetingAiSource(readiness: TranscriptSourceReadiness): boolean {
  return (
    readiness.wordCount >= REPORT_READY_MIN_WORDS &&
    readiness.durationMs >= REPORT_READY_MIN_DURATION_MS
  );
}

function isSubmitLifecycle(state: TranscriptSessionState): boolean {
  return state.lifecycle === 'finished' || state.lifecycle === 'processing';
}

function canSubmitReviewSource(
  state: TranscriptSessionState,
  readiness: TranscriptSourceReadiness,
): boolean {
  return (
    readiness.level === 'review' &&
    readiness.finalCount === 0 &&
    hasMinimumMeetingAiSource(readiness) &&
    isSubmitLifecycle(state)
  );
}

export function initialTranscriptSession(): TranscriptSessionState {
  return {
    lifecycle: 'idle',
    sessionId: null,
    meetingId: null,
    deviceId: null,
    hasLoopback: false,
    startedAtMs: null,
    finishedAtMs: null,
    error: null,
    segments: [],
  };
}

export function markTranscriptReady(
  state: TranscriptSessionState,
  args: { meetingId: string; deviceId: string },
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'ready',
    meetingId: args.meetingId,
    deviceId: args.deviceId,
    error: null,
  };
}

export function markTranscriptBlocked(
  state: TranscriptSessionState,
  args: { reason: string },
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'blocked',
    sessionId: null,
    error: args.reason,
    segments: [],
  };
}

export function markTranscriptWaitingForContract(
  state: TranscriptSessionState,
  args: { deviceId: string },
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'idle',
    sessionId: null,
    meetingId: null,
    deviceId: args.deviceId,
    error: null,
    segments: [],
  };
}

export function startTranscriptSession(
  state: TranscriptSessionState,
  args: {
    sessionId: string;
    meetingId: string;
    deviceId: string;
    hasLoopback: boolean;
    startedAtMs: number;
  },
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'recording',
    sessionId: args.sessionId,
    meetingId: args.meetingId,
    deviceId: args.deviceId,
    hasLoopback: args.hasLoopback,
    startedAtMs: args.startedAtMs,
    finishedAtMs: null,
    error: null,
    segments: [],
  };
}

export function finishTranscriptSession(
  state: TranscriptSessionState,
  finishedAtMs: number,
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'finished',
    finishedAtMs,
    error: null,
  };
}

export function failTranscriptSession(
  state: TranscriptSessionState,
  error: string,
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'error',
    error,
  };
}

export function upsertTranscriptSegment(
  state: TranscriptSessionState,
  segment: TranscriptSegment,
): TranscriptSessionState {
  const existing = state.segments.find((item) => item.id === segment.id);
  if (existing && STATUS_RANK[segment.status] < STATUS_RANK[existing.status]) {
    return state;
  }

  const segments = existing
    ? state.segments.map((item) =>
        item.id === segment.id ? mergeTranscriptSegment(item, segment) : item,
      )
    : [...state.segments, segment];

  return {
    ...state,
    segments: segments.sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id)),
  };
}

export function reviewTranscriptSegmentText(
  state: TranscriptSessionState,
  args: { id: string; text: string; reviewedAtMs?: number },
): TranscriptSessionState {
  const reviewedText = args.text.trim();
  if (!reviewedText) {
    return state;
  }

  let changed = false;
  const segments = state.segments.map((segment) => {
    if (segment.id !== args.id) {
      return segment;
    }
    if (segment.text.trim() === reviewedText && segment.status === 'revised') {
      return segment;
    }

    changed = true;
    return {
      ...segment,
      status: 'revised' as const,
      text: reviewedText,
      revisedFromId: segment.revisedFromId ?? segment.id,
      receivedAtMs: args.reviewedAtMs ?? segment.receivedAtMs ?? segment.startedAtMs,
    };
  });

  return changed ? { ...state, segments } : state;
}

function mergeTranscriptSegment(
  existing: TranscriptSegment,
  incoming: TranscriptSegment,
): TranscriptSegment {
  if (shouldPreserveDirectDraftText(existing, incoming)) {
    return {
      ...existing,
      ...incoming,
      text: existing.text,
      startedAtMs: existing.startedAtMs,
    };
  }

  return { ...existing, ...incoming };
}

function shouldPreserveDirectDraftText(
  existing: TranscriptSegment,
  incoming: TranscriptSegment,
): boolean {
  if (
    existing.source !== 'direct-stream' ||
    incoming.source !== 'direct-stream' ||
    existing.status !== 'draft' ||
    (incoming.status !== 'draft' && incoming.status !== 'final')
  ) {
    return false;
  }

  const existingWords = normalizedTranscriptWords(existing.text);
  const incomingWords = normalizedTranscriptWords(incoming.text);
  if (existingWords.length < 4 || incomingWords.length === 0) {
    return false;
  }
  if (incomingWords.length >= existingWords.length) {
    return false;
  }

  const incomingCoversMostExisting = incomingWords.length / existingWords.length >= 0.75;
  if (incomingCoversMostExisting) {
    return false;
  }

  return (
    hasContiguousWordWindow(existingWords, incomingWords) ||
    sharedWordRatio(existingWords, incomingWords) >= 0.6
  );
}

function normalizedTranscriptWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.toLocaleLowerCase('tr-TR').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

function hasContiguousWordWindow(words: string[], window: string[]): boolean {
  if (window.length > words.length) {
    return false;
  }
  for (let index = 0; index <= words.length - window.length; index += 1) {
    if (window.every((word, offset) => words[index + offset] === word)) {
      return true;
    }
  }
  return false;
}

function sharedWordRatio(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const denominator = Math.min(leftSet.size, rightSet.size);
  if (denominator === 0) {
    return 0;
  }

  let shared = 0;
  rightSet.forEach((word) => {
    if (leftSet.has(word)) {
      shared += 1;
    }
  });

  return shared / denominator;
}

export function transcriptStatusLabel(status: TranscriptSegmentStatus): string {
  switch (status) {
    case 'draft':
      return 'Taslak';
    case 'stabilizing':
      return 'Netleşiyor';
    case 'final':
      return 'Final';
    case 'revised':
      return 'Revize';
  }
}

export function lifecycleLabel(lifecycle: TranscriptLifecycle): string {
  switch (lifecycle) {
    case 'idle':
      return 'Beklemede';
    case 'ready':
      return 'Hazır';
    case 'recording':
      return 'Kayıt';
    case 'processing':
      return 'İşleniyor';
    case 'finished':
      return 'Gönderildi';
    case 'blocked':
      return 'Blokeli';
    case 'error':
      return 'Hata';
  }
}

export function buildTranscriptSourceExport(
  state: TranscriptSessionState,
  nowMs: number = Date.now(),
): TranscriptSourceExportBundle {
  const segments = sourceSegments(state);
  if (segments.length === 0) {
    throw new Error('Transcript source is not ready');
  }

  const safeMeetingId = safeFilePart(state.meetingId ?? 'meeting');
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return {
    markdown: buildTranscriptMarkdown(state, segments),
    text: buildTranscriptText(state, segments),
    markdownFileName: `meeting-transcript-${safeMeetingId}-${stamp}.md`,
    textFileName: `meeting-transcript-${safeMeetingId}-${stamp}.txt`,
  };
}

export function buildMeetingAiSourcePackage(
  state: TranscriptSessionState,
  nowMs: number = Date.now(),
  options: MeetingAiSourcePackageOptions = {},
): MeetingAiSourcePackageBundle {
  const segments = sourceSegments(state);
  if (segments.length === 0) {
    throw new Error('Transcript source is not ready');
  }

  const readiness = analyzeTranscriptSourceReadiness(state);
  const request: MeetingAiAnalyzeRequest = {
    transcript: segments.map((segment) => segment.text.trim()).join('\n'),
    meeting_id: state.meetingId,
    session_id: state.sessionId,
    segments: buildAnalyzeSegments(segments),
  };
  const generatedAt = new Date(nowMs).toISOString();
  const payload: MeetingAiSourcePackage = {
    schema_version: 'platform-desktop.meeting-ai-source.v1',
    generated_at: generatedAt,
    route: {
      target: 'backend-gateway -> meeting-ai /analyze',
      client_direct_platform_ai: false,
    },
    gate: buildMeetingAiSourceGate(state, readiness),
    privacy: buildMeetingAiSourcePrivacy(options),
    source_quality: {
      level: readiness.level,
      label: readiness.label,
      word_count: readiness.wordCount,
      duration_ms: readiness.durationMs,
      final_count: readiness.finalCount,
      draft_count: readiness.draftCount,
      final_ratio: readiness.finalRatio,
      warnings: readiness.warnings,
    },
    meeting_id: state.meetingId,
    session_id: state.sessionId,
    device_id: state.deviceId,
    source: state.hasLoopback ? 'microphone_loopback' : 'microphone',
    request,
  };
  const safeMeetingId = safeFilePart(state.meetingId ?? 'meeting');
  const stamp = generatedAt.replace(/[:.]/g, '-');

  return {
    json: `${JSON.stringify(payload, null, 2)}\n`,
    jsonFileName: `meeting-ai-source-${safeMeetingId}-${stamp}.json`,
    package: payload,
  };
}

export function analyzeTranscriptSourceReadiness(
  state: TranscriptSessionState,
): TranscriptSourceReadiness {
  const segments = sourceSegments(state);
  if (segments.length === 0) {
    return {
      level: 'empty',
      label: 'Kaynak bekleniyor',
      detail: 'Transkript satırı oluşmadan çıktı üretimi başlamaz.',
      nextStepLabel: 'Kayıt kaynağı',
      nextStepDetail: 'Toplantı kaydı başlayınca canlı transkript satırları değerlendirilecek.',
      wordCount: 0,
      durationMs: 0,
      finalCount: 0,
      draftCount: 0,
      finalRatio: 0,
      warnings: ['Transkript satırı yok.'],
    };
  }

  const finalCount = segments.filter(isFinalSegment).length;
  const draftCount = segments.length - finalCount;
  const wordCount = segments.reduce((total, segment) => total + countWords(segment.text), 0);
  const durationMs = Math.max(
    0,
    segments[segments.length - 1].startedAtMs - segments[0].startedAtMs,
  );
  const finalRatio = finalCount / segments.length;
  const hasMinimumSource =
    wordCount >= REPORT_READY_MIN_WORDS && durationMs >= REPORT_READY_MIN_DURATION_MS;
  const draftOnlyCanBeReviewed = finalCount === 0 && hasMinimumSource && isSubmitLifecycle(state);
  const warnings = [
    ...(finalCount === 0
      ? [
          draftOnlyCanBeReviewed
            ? 'Final satır yok; Meeting AI sonucu taslak kaliteyle değerlendirilir.'
            : 'Final satır bekleniyor.',
        ]
      : []),
    ...(wordCount < REPORT_READY_MIN_WORDS
      ? [`En az ${REPORT_READY_MIN_WORDS} kelimelik kaynak hedefleniyor.`]
      : []),
    ...(durationMs < REPORT_READY_MIN_DURATION_MS
      ? ['Toplantı penceresi rapor için kısa görünüyor.']
      : []),
    ...(state.lifecycle === 'recording' ? ['Kayıt sürüyor; çıktı henüz sabit değil.'] : []),
  ];

  if (state.lifecycle === 'recording') {
    return {
      level: 'collecting',
      label: 'Kaynak toplanıyor',
      detail: 'Canlı transkript rapor kaynağına ekleniyor.',
      nextStepLabel: 'Kayıt bitişi',
      nextStepDetail:
        'Toplantı çıktısı için kayıt bitişi ve final transkript satırları bekleniyor.',
      wordCount,
      durationMs,
      finalCount,
      draftCount,
      finalRatio,
      warnings,
    };
  }

  if (
    finalCount > 0 &&
    wordCount >= REPORT_READY_MIN_WORDS &&
    durationMs >= REPORT_READY_MIN_DURATION_MS
  ) {
    return {
      level: 'ready',
      label: 'Çıktıya uygun',
      detail: 'Transkript kaynağı toplantı çıktısı üretimi için yeterli görünüyor.',
      nextStepLabel: 'Meeting AI',
      nextStepDetail:
        'Kaynak hazır; özet, karar ve aksiyon üretimi için meeting-ai sonucu bekleniyor.',
      wordCount,
      durationMs,
      finalCount,
      draftCount,
      finalRatio,
      warnings,
    };
  }

  return {
    level: 'review',
    label:
      finalCount > 0
        ? 'Gözden geçirilmeli'
        : draftOnlyCanBeReviewed
          ? 'Taslak kaynak kullanılabilir'
          : 'Taslak kaynak',
    detail:
      finalCount > 0
        ? 'Kaynak var; rapor/özet öncesi kapsam ve final oranı kontrol edilmeli.'
        : draftOnlyCanBeReviewed
          ? 'Yeterli taslak satır var; çıktı taslak kalite etiketiyle üretilebilir.'
          : 'Yalnız taslak satır var; final transcript beklenmeli.',
    nextStepLabel:
      finalCount > 0
        ? 'Kaynak kalite kontrolü'
        : draftOnlyCanBeReviewed
          ? 'Meeting AI taslak gönderimi'
          : 'Final transkript',
    nextStepDetail:
      finalCount > 0
        ? 'Meeting AI öncesi kaynak kapsamı, süre ve final oranı netleştirilmeli.'
        : draftOnlyCanBeReviewed
          ? 'Final satır gelmediyse kaynak backend gateway üzerinden taslak kaliteyle gönderilebilir.'
          : 'Taslak satırlar final veya revize satıra dönmeden çıktı kapısı açılmıyor.',
    wordCount,
    durationMs,
    finalCount,
    draftCount,
    finalRatio,
    warnings,
  };
}

export function buildMeetingAiSourceGate(
  state: TranscriptSessionState,
  readiness: TranscriptSourceReadiness = analyzeTranscriptSourceReadiness(state),
): MeetingAiSourceGate {
  const reviewCanSubmit = canSubmitReviewSource(state, readiness);
  const blockedBy = [
    ...(!state.meetingId ? ['canonical meetingId yok'] : []),
    ...(!state.sessionId ? ['recorder sessionId yok'] : []),
    ...(!isSubmitLifecycle(state) && readiness.level !== 'empty' && readiness.level !== 'collecting'
      ? ['kayıt bitişi bekleniyor']
      : []),
    ...(readiness.level === 'empty' ? ['transkript satırı yok'] : []),
    ...(readiness.level === 'collecting' ? ['kayıt sürüyor'] : []),
    ...(readiness.level === 'review' && !reviewCanSubmit
      ? ['kaynak kalite kontrolü gerekiyor']
      : []),
  ];
  const canSubmit = (readiness.level === 'ready' || reviewCanSubmit) && blockedBy.length === 0;

  return {
    status: canSubmit
      ? 'ready'
      : readiness.level === 'collecting' || readiness.level === 'review'
        ? readiness.level
        : 'blocked',
    can_submit: canSubmit,
    label: canSubmit
      ? readiness.level === 'review'
        ? 'Meeting AI taslak gönderimine hazır'
        : 'Meeting AI gönderimine hazır'
      : 'Meeting AI kapısı bekliyor',
    next_action: canSubmit
      ? readiness.level === 'review'
        ? 'Yeterli taslak kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir; çıktı final transcript yerine taslak kalite etiketiyle değerlendirilir.'
        : 'Kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir.'
      : readiness.nextStepDetail,
    blocked_by: blockedBy,
    contract: {
      submit_via: 'backend-gateway',
      endpoint: 'meeting-ai /analyze',
      direct_platform_ai_allowed: false,
    },
  };
}

export function buildMeetingAiSourcePrivacy(
  options: MeetingAiSourcePackageOptions = {},
): MeetingAiSourcePrivacy {
  return {
    classification: 'confidential_transcript',
    transcript_included: true,
    raw_audio_included: false,
    local_raw_audio_cache: false,
    export_requires_user_action: true,
    kvkk_boundary: 'desktop-source-export',
    consent: {
      required: true,
      version: options.consentVersion ?? null,
      text_hash: options.consentTextHash ?? null,
      locale: options.consentLocale ?? null,
    },
  };
}

function sourceSegments(state: TranscriptSessionState): TranscriptSegment[] {
  return state.segments
    .filter((segment) => segment.text.trim().length > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id));
}

function isFinalSegment(segment: TranscriptSegment): boolean {
  return segment.status === 'final' || segment.status === 'revised';
}

function buildAnalyzeSegments(segments: TranscriptSegment[]): MeetingAiAnalyzeSegment[] {
  const firstStartedAtMs = segments[0]?.startedAtMs ?? 0;
  return segments.map((segment, index) => {
    const start = toSeconds(segment.startedAtMs - firstStartedAtMs);
    const next = segments[index + 1];
    const end = next ? toSeconds(next.startedAtMs - firstStartedAtMs) : undefined;
    return {
      text: segment.text.trim(),
      start,
      ...(end !== undefined && end > start ? { end } : {}),
    };
  });
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildTranscriptMarkdown(
  state: TranscriptSessionState,
  segments: TranscriptSegment[],
): string {
  const readiness = analyzeTranscriptSourceReadiness(state);
  const lines = [
    '# Meeting Transcript',
    '',
    `- Meeting: ${state.meetingId ?? '-'}`,
    `- Oturum: ${state.sessionId ?? '-'}`,
    `- Kaynak: ${state.hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon'}`,
    `- Başlangıç: ${formatTimestamp(state.startedAtMs)}`,
    `- Bitiş: ${formatTimestamp(state.finishedAtMs)}`,
    '',
    '## Kaynak Hazırlık',
    '',
    `- Durum: ${readiness.label}`,
    `- Sonraki kapı: ${readiness.nextStepLabel}`,
    `- Detay: ${readiness.nextStepDetail}`,
    `- Satır: ${segments.length}`,
    `- Kelime: ${readiness.wordCount}`,
    `- Süre: ${formatDuration(readiness.durationMs)}`,
    `- Final oranı: ${formatPercent(readiness.finalRatio)}`,
    `- Uyarı: ${readiness.warnings.length > 0 ? readiness.warnings.join(' ') : '-'}`,
    '',
    '## Transkript',
    '',
  ];

  for (const segment of segments) {
    lines.push(`- ${formatSegmentPrefix(segment)} ${segment.speakerLabel}: ${segment.text.trim()}`);
  }

  return `${lines.join('\n')}\n`;
}

function buildTranscriptText(state: TranscriptSessionState, segments: TranscriptSegment[]): string {
  const readiness = analyzeTranscriptSourceReadiness(state);
  const lines = [
    'Meeting Transcript',
    '',
    `Meeting: ${state.meetingId ?? '-'}`,
    `Oturum: ${state.sessionId ?? '-'}`,
    `Kaynak: ${state.hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon'}`,
    `Başlangıç: ${formatTimestamp(state.startedAtMs)}`,
    `Bitiş: ${formatTimestamp(state.finishedAtMs)}`,
    '',
    'Kaynak Hazırlık',
    `Durum: ${readiness.label}`,
    `Sonraki kapı: ${readiness.nextStepLabel}`,
    `Detay: ${readiness.nextStepDetail}`,
    `Satır: ${segments.length}`,
    `Kelime: ${readiness.wordCount}`,
    `Süre: ${formatDuration(readiness.durationMs)}`,
    `Final oranı: ${formatPercent(readiness.finalRatio)}`,
    `Uyarı: ${readiness.warnings.length > 0 ? readiness.warnings.join(' ') : '-'}`,
    '',
  ];

  for (const segment of segments) {
    lines.push(`${formatSegmentPrefix(segment)} ${segment.speakerLabel}: ${segment.text.trim()}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatSegmentPrefix(segment: TranscriptSegment): string {
  return `[${formatTimestamp(segment.startedAtMs)} ${transcriptStatusLabel(segment.status)}]`;
}

function formatTimestamp(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return new Date(value).toISOString();
}

function formatDuration(value: number): string {
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

function toSeconds(valueMs: number): number {
  return Math.max(0, Math.round(valueMs) / 1000);
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
}
