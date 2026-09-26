// 'utterance' = gateway cumle birlestiricisinin (backend PR #918) urettigi
// OKUNABILIR satir. Ham akustik parcalar 'draft' olarak gelir ve bir cumle
// tamamlaninca UTTERANCE ile degistirilir. Bu ayrim olmadan kullanici ayni
// metni hem parcali hem butun gorur (cift satir).
export type TranscriptSegmentStatus = 'draft' | 'stabilizing' | 'final' | 'revised' | 'utterance';

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
  timingBasis?: 'source' | 'delivery';
  elapsedMs?: number | null;
  rms?: number | null;
  receivedAtMs?: number | null;
  reviewedAtMs?: number | null;
}

export interface TranscriptSessionState {
  lifecycle: TranscriptLifecycle;
  sessionId: string | null;
  gatewaySessionId: string | null;
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

export type TranscriptQualityGateStatus = 'blocked' | 'collecting' | 'review' | 'ready';

export type TranscriptQualityGateRisk =
  | 'none'
  | 'empty_source'
  | 'recording_active'
  | 'low_word_coverage'
  | 'low_word_count'
  | 'short_duration'
  | 'draft_only';

export interface TranscriptQualityGate {
  status: TranscriptQualityGateStatus;
  risk: TranscriptQualityGateRisk;
  label: string;
  action: string;
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
    word_rate_per_minute: number | null;
    reviewed_count: number;
    reviewed_ratio: number;
    quality_gate: TranscriptQualityGate;
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
  wordRatePerMinute: number | null;
  reviewedCount: number;
  reviewedRatio: number;
  qualityGate: TranscriptQualityGate;
  warnings: string[];
}

const STATUS_RANK: Record<TranscriptSegmentStatus, number> = {
  draft: 0,
  stabilizing: 1,
  // 'utterance' ham parcalari (draft/stabilizing) gecersiz kilar, ancak
  // final/revised'i EZMEZ: cumle birlestirici okunabilirlik saglar, batch STT
  // ise dogruluk saglar — dogruluk daha yuksek otoritedir.
  utterance: 2,
  final: 3,
  revised: 4,
};

const REPORT_READY_MIN_WORDS = 20;
const REPORT_READY_MIN_DURATION_MS = 15_000;
const REPORT_WORD_RATE_WARN_MIN_DURATION_MS = 20_000;
const REPORT_LOW_WORDS_PER_MINUTE = 35;

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
    !assessWordRate(state, readiness.wordCount, readiness.durationMs).lowWordRate &&
    hasMinimumMeetingAiSource(readiness) &&
    isSubmitLifecycle(state)
  );
}

function buildTranscriptQualityGate(args: {
  state: TranscriptSessionState;
  segmentCount: number;
  finalCount: number;
  wordCount: number;
  durationMs: number;
  lowWordRate: boolean;
  draftOnlyCanBeReviewed: boolean;
}): TranscriptQualityGate {
  if (args.segmentCount === 0) {
    return {
      status: 'blocked',
      risk: 'empty_source',
      label: 'Kaynak kapısı kapalı',
      action:
        'Kayıt başlayınca transkript satırları oluşmadan Meeting AI veya ERP/CRM aktarımı açılmaz.',
    };
  }

  if (args.state.lifecycle === 'recording') {
    return {
      status: 'collecting',
      risk: 'recording_active',
      label: 'Kaynak toplanıyor',
      action: 'Kayıt bitince kaynak kapsamı ve final oranı yeniden ölçülür.',
    };
  }

  if (args.lowWordRate) {
    return {
      status: 'review',
      risk: 'low_word_coverage',
      label: 'Kapsam riski',
      action:
        'Mikrofon/direct STT zinciri doğrulanmadan Meeting AI veya ERP/CRM aktarımı yapılmaz.',
    };
  }

  if (args.wordCount < REPORT_READY_MIN_WORDS) {
    return {
      status: 'review',
      risk: 'low_word_count',
      label: 'Kelime eşiği eksik',
      action: `En az ${REPORT_READY_MIN_WORDS} kelimelik transcript kaynağı beklenir.`,
    };
  }

  if (args.durationMs < REPORT_READY_MIN_DURATION_MS) {
    return {
      status: 'review',
      risk: 'short_duration',
      label: 'Süre eşiği eksik',
      action: 'Toplantı penceresi yeterli olmadan çıktı paketi review seviyesinde kalır.',
    };
  }

  if (args.finalCount === 0) {
    if (args.draftOnlyCanBeReviewed) {
      return {
        status: 'ready',
        risk: 'draft_only',
        label: 'Taslak kaliteyle açık',
        action:
          'Backend gateway üzerinden taslak kalite etiketiyle gönderilebilir; final kanıt gibi değerlendirilmez.',
      };
    }

    return {
      status: 'review',
      risk: 'draft_only',
      label: 'Final satır bekleniyor',
      action: 'Taslak satırlar final veya revize satıra dönmeden standart çıktı kapısı açılmaz.',
    };
  }

  return {
    status: 'ready',
    risk: 'none',
    label: 'Kalite kapısı açık',
    action: 'Kaynak backend gateway üzerinden meeting-ai /analyze kontratına iletilebilir.',
  };
}

export function initialTranscriptSession(): TranscriptSessionState {
  return {
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
    gatewaySessionId: null,
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
    gatewaySessionId: null,
    meetingId: null,
    deviceId: args.deviceId,
    error: null,
    segments: [],
  };
}

export function startTranscriptSession(
  state: TranscriptSessionState,
  args: {
    sessionId: string | null;
    gatewaySessionId?: string | null;
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
    gatewaySessionId: args.gatewaySessionId ?? args.sessionId,
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

export function markTranscriptProcessing(
  state: TranscriptSessionState,
  finishedAtMs: number,
  warning: string,
): TranscriptSessionState {
  return {
    ...state,
    lifecycle: 'processing',
    finishedAtMs,
    error: warning,
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

/**
 * Bir UTTERANCE geldiginde, ondan olusturulan ham parcalari ekrandan kaldirir.
 *
 * NEDEN: gateway cumle birlestiricisi (backend PR #918) parcalari YENI bir
 * eventId altinda yayinlar. Parcalar silinmezse kullanici ayni metni iki kez
 * gorur — once bolunmus, sonra butun. Kullanicinin bildirdigi asil sikayet
 * ("ayni cumleyi on satirda okuyorsun") tam olarak budur.
 *
 * `sourceEventIds` bos ise hicbir sey silinmez (fail-safe): yanlislikla
 * alakasiz satir kaldirmaktansa gecici bir tekrar gostermek yeglenir.
 */
export function collapseAssembledFragments(
  state: TranscriptSessionState,
  sourceEventIds: readonly string[] | undefined,
): TranscriptSessionState {
  if (!sourceEventIds || sourceEventIds.length === 0) {
    return state;
  }
  const collapsed = new Set(sourceEventIds);
  const remaining = state.segments.filter((segment) => {
    if (!collapsed.has(segment.id)) {
      return true;
    }
    // Yalniz HAM parcalar kaldirilir. Bir parca bu arada final/revised'e
    // yukseldiyse korunur — dogruluk otoritesi okunabilirligi yener.
    return segment.status === 'final' || segment.status === 'revised';
  });
  if (remaining.length === state.segments.length) {
    return state;
  }
  return { ...state, segments: remaining };
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
    : [...state.segments, normalizeInsertedSegmentTiming(segment)];

  return {
    ...state,
    segments: segments.sort(compareTranscriptSegments),
  };
}

export function gatewayTranscriptWindowOrder(
  id: string,
): { session: string; sequenceSpace: string; sequence: number } | null {
  const match = /^(gateway:.+?)(?::(live:\d+))?:window:(\d+)$/.exec(id);
  if (!match) {
    return null;
  }
  const sequence = Number(match[3]);
  return Number.isSafeInteger(sequence)
    ? { session: match[1], sequenceSpace: match[2] ?? 'durable', sequence }
    : null;
}

export function compareTranscriptSegments(
  left: TranscriptSegment,
  right: TranscriptSegment,
): number {
  const timestampOrder = left.startedAtMs - right.startedAtMs;
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  const leftWindow = gatewayTranscriptWindowOrder(left.id);
  const rightWindow = gatewayTranscriptWindowOrder(right.id);
  if (
    leftWindow &&
    rightWindow &&
    leftWindow.session === rightWindow.session &&
    leftWindow.sequenceSpace === rightWindow.sequenceSpace
  ) {
    return leftWindow.sequence - rightWindow.sequence;
  }
  // Array#sort is stable: unrelated equal-timestamp events retain arrival order.
  return 0;
}

export function markTranscriptSegmentReviewed(
  state: TranscriptSessionState,
  args: { id: string; reviewedAtMs?: number },
): TranscriptSessionState {
  let changed = false;
  const segments = state.segments.map((segment) => {
    if (segment.id !== args.id || !isReviewableTranscriptSegment(state, segment)) {
      return segment;
    }

    const reviewedAtMs =
      args.reviewedAtMs ?? segment.reviewedAtMs ?? segment.receivedAtMs ?? segment.startedAtMs;
    if (segment.reviewedAtMs === reviewedAtMs) {
      return segment;
    }

    changed = true;
    return {
      ...segment,
      reviewedAtMs,
    };
  });

  return changed ? { ...state, segments } : state;
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
    const reviewedAtMs =
      args.reviewedAtMs ?? segment.reviewedAtMs ?? segment.receivedAtMs ?? segment.startedAtMs;
    if (
      segment.text.trim() === reviewedText &&
      segment.status === 'revised' &&
      segment.reviewedAtMs === reviewedAtMs
    ) {
      return segment;
    }

    changed = true;
    return {
      ...segment,
      status: 'revised' as const,
      text: reviewedText,
      revisedFromId: segment.revisedFromId ?? segment.id,
      receivedAtMs: reviewedAtMs,
      reviewedAtMs,
    };
  });

  return changed ? { ...state, segments } : state;
}

function mergeTranscriptSegment(
  existing: TranscriptSegment,
  incoming: TranscriptSegment,
): TranscriptSegment {
  const hasIncomingEnd =
    typeof incoming.endedAtMs === 'number' && Number.isFinite(incoming.endedAtMs);
  if (shouldPreserveDirectDraftText(existing, incoming)) {
    return {
      ...existing,
      ...incoming,
      text: existing.text,
      startedAtMs: existing.startedAtMs,
      endedAtMs: existing.endedAtMs,
      timingBasis: existing.timingBasis,
    };
  }

  const sameStart = incoming.startedAtMs === existing.startedAtMs;
  const hasExistingSourceEnd =
    existing.timingBasis === 'source' &&
    typeof existing.endedAtMs === 'number' &&
    Number.isFinite(existing.endedAtMs);
  const shouldPreserveExistingEnd =
    sameStart && (!hasIncomingEnd || (!incoming.timingBasis && hasExistingSourceEnd));
  const endedAtMs = shouldPreserveExistingEnd
    ? existing.endedAtMs
    : hasIncomingEnd
      ? incoming.endedAtMs
      : null;
  const timingBasis = shouldPreserveExistingEnd
    ? existing.timingBasis
    : hasIncomingEnd
      ? (incoming.timingBasis ?? 'delivery')
      : undefined;

  return { ...existing, ...incoming, endedAtMs, timingBasis };
}

function normalizeInsertedSegmentTiming(segment: TranscriptSegment): TranscriptSegment {
  const hasEnd = typeof segment.endedAtMs === 'number' && Number.isFinite(segment.endedAtMs);
  if (!hasEnd || segment.timingBasis) {
    return segment;
  }
  return { ...segment, timingBasis: 'delivery' };
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

function isReviewableTranscriptSegment(
  state: TranscriptSessionState,
  segment: TranscriptSegment,
): boolean {
  if (!segment.text.trim()) {
    return false;
  }

  return !(
    state.lifecycle === 'recording' &&
    segment.source === 'direct-stream' &&
    segment.status === 'draft'
  );
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
    case 'utterance':
      return 'Cümle';
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
      word_rate_per_minute: readiness.wordRatePerMinute,
      reviewed_count: readiness.reviewedCount,
      reviewed_ratio: readiness.reviewedRatio,
      quality_gate: readiness.qualityGate,
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
    const qualityGate = buildTranscriptQualityGate({
      state,
      segmentCount: 0,
      finalCount: 0,
      wordCount: 0,
      durationMs: 0,
      lowWordRate: false,
      draftOnlyCanBeReviewed: false,
    });
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
      wordRatePerMinute: null,
      reviewedCount: 0,
      reviewedRatio: 0,
      qualityGate,
      warnings: ['Transkript satırı yok.'],
    };
  }

  const finalCount = segments.filter(isFinalSegment).length;
  const draftCount = segments.length - finalCount;
  const reviewedCount = segments.filter(isReviewedSegment).length;
  const wordCount = segments.reduce((total, segment) => total + countWords(segment.text), 0);
  const durationMs = transcriptSourceDurationMs(state, segments);
  const { wordRatePerMinute, lowWordRate } = assessWordRate(state, wordCount, durationMs);
  const finalRatio = finalCount / segments.length;
  const reviewedRatio = reviewedCount / segments.length;
  const hasMinimumSource =
    wordCount >= REPORT_READY_MIN_WORDS && durationMs >= REPORT_READY_MIN_DURATION_MS;
  const draftOnlyCanBeReviewed = finalCount === 0 && hasMinimumSource && isSubmitLifecycle(state);
  const qualityGate = buildTranscriptQualityGate({
    state,
    segmentCount: segments.length,
    finalCount,
    wordCount,
    durationMs,
    lowWordRate,
    draftOnlyCanBeReviewed,
  });
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
    ...(lowWordRate
      ? [
          'Kelime üretim hızı düşük; konuşmanın önemli kısmı transcript kaynağına düşmemiş olabilir.',
        ]
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
      wordRatePerMinute,
      reviewedCount,
      reviewedRatio,
      qualityGate,
      warnings,
    };
  }

  if (
    finalCount > 0 &&
    wordCount >= REPORT_READY_MIN_WORDS &&
    durationMs >= REPORT_READY_MIN_DURATION_MS &&
    !lowWordRate
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
      wordRatePerMinute,
      reviewedCount,
      reviewedRatio,
      qualityGate,
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
    wordRatePerMinute,
    reviewedCount,
    reviewedRatio,
    qualityGate,
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
    .sort(compareTranscriptSegments);
}

function isFinalSegment(segment: TranscriptSegment): boolean {
  return segment.status === 'final' || segment.status === 'revised';
}

function isReviewedSegment(segment: TranscriptSegment): boolean {
  return segment.status === 'revised' || typeof segment.reviewedAtMs === 'number';
}

function buildAnalyzeSegments(segments: TranscriptSegment[]): MeetingAiAnalyzeSegment[] {
  const firstStartedAtMs = segments[0]?.startedAtMs ?? 0;
  return segments.map((segment, index) => {
    const start = toSeconds(segment.startedAtMs - firstStartedAtMs);
    const next = segments[index + 1];
    const explicitEnd =
      segment.timingBasis === 'source' &&
      typeof segment.endedAtMs === 'number' &&
      Number.isFinite(segment.endedAtMs) &&
      segment.endedAtMs > segment.startedAtMs
        ? toSeconds(segment.endedAtMs - firstStartedAtMs)
        : undefined;
    const end = explicitEnd ?? (next ? toSeconds(next.startedAtMs - firstStartedAtMs) : undefined);
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

/**
 * Konuşulan süre: motorun zamanladığı segment aralıklarının birleşimi.
 *
 * Kapsam göstergesinin paydası kayıt penceresi olamaz — kimse konuşmazken de
 * saat işler ve sessizlik "kelime üretilmiyor" gibi görünür. Sessizlik kapsamın
 * ölçüsü değil; ölçü, konuşulan sürede kaç kelime çıktığıdır. Örtüşen aralıklar
 * birleştirilir, böylece aynı saniye iki konuşmacıdan iki kez sayılmaz.
 *
 * Satırların yalnız bir kısmı zamanlanmışsa payda eksik kalır ve oran şişer: 24
 * Eylül attended koşusunda 54 satırın kapsadığı süre 13,7 sn ölçüldü ve ekran
 * 241 kelime/dk gösterdi. Bu yanlış uyarı üretmez ama gerçek bir kapsam
 * düşüklüğünü gizler. Bu yüzden ölçüm ancak final satırların çoğu zamanlıysa
 * kabul edilir; değilse gösterge "ölçülemiyor" der, uydurma bir sayı vermez.
 *
 * Tek yerde durur: canlı paneldeki kapsam göstergesi ve toplantı çıktısının
 * kaynak hazırlık kontrolü aynı hesabı kullanır.
 */
export const SPEECH_SPAN_MIN_TIMED_SHARE = 0.6;

export type SpeechSpan =
  /** Zamanlama hiç yok: eski kayıt penceresi davranışı geçerli. */
  | { kind: 'absent' }
  /** Zamanlama kısmi: oran güvenilir değil, sayı gösterilmez. */
  | { kind: 'unmeasurable' }
  | { kind: 'measured'; ms: number };

export function transcriptSpeechSpan(session: TranscriptSessionState): SpeechSpan {
  const intervals: Array<[number, number]> = [];
  let finalCount = 0;
  let timedFinalCount = 0;
  for (const segment of session.segments) {
    const isFinal = segment.status === 'final' || segment.status === 'revised';
    if (isFinal) {
      finalCount += 1;
    }
    if (segment.timingBasis !== 'source') {
      continue;
    }
    const start = segment.startedAtMs;
    const end = segment.endedAtMs;
    if (
      typeof start !== 'number' ||
      !Number.isFinite(start) ||
      typeof end !== 'number' ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }
    if (isFinal) {
      timedFinalCount += 1;
    }
    intervals.push([start, end]);
  }
  if (intervals.length === 0) {
    return { kind: 'absent' };
  }
  if (finalCount > 0 && timedFinalCount / finalCount < SPEECH_SPAN_MIN_TIMED_SHARE) {
    return { kind: 'unmeasurable' };
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [currentStart, currentEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = start;
    currentEnd = end;
  }
  total += currentEnd - currentStart;
  return { kind: 'measured', ms: total };
}

function calculateWordRatePerMinute(wordCount: number, durationMs: number): number | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return wordCount / (durationMs / 60_000);
}

function transcriptSourceDurationMs(
  state: TranscriptSessionState,
  segments: TranscriptSegment[],
): number {
  const segmentSpanMs = transcriptSegmentSpanMs(segments);
  const recordingSpanMs = transcriptRecordingSpanMs(state);

  return recordingSpanMs === null ? segmentSpanMs : Math.max(segmentSpanMs, recordingSpanMs);
}

function transcriptSegmentSpanMs(segments: TranscriptSegment[]): number {
  const firstStartedAtMs = segments[0]?.startedAtMs;
  if (typeof firstStartedAtMs !== 'number') {
    return 0;
  }

  const lastSegment = segments[segments.length - 1];
  const lastEndedAtMs =
    typeof lastSegment.endedAtMs === 'number' && lastSegment.endedAtMs > lastSegment.startedAtMs
      ? lastSegment.endedAtMs
      : lastSegment.startedAtMs;

  return Math.max(0, lastEndedAtMs - firstStartedAtMs);
}

function transcriptRecordingSpanMs(state: TranscriptSessionState): number | null {
  if (
    typeof state.startedAtMs !== 'number' ||
    typeof state.finishedAtMs !== 'number' ||
    state.finishedAtMs <= state.startedAtMs
  ) {
    return null;
  }

  return state.finishedAtMs - state.startedAtMs;
}

interface WordRateAssessment {
  wordRatePerMinute: number | null;
  lowWordRate: boolean;
}

/**
 * Kelime hızı ve "kapsam düşük" kararı, canlı paneldeki göstergeyle aynı paydayla.
 *
 * Eski hesap kelimeleri kaydın tamamına bölüyordu; kayıt açıkken beklenen her
 * sessiz saniye oranı düşürdü. 26 Eylül attended (toplantı d9680cf3): ~45 sn
 * konuşma, kayıt 3 dk 27 sn açık → 68 kelime / 3,5 dk = 20 kelime/dk → "Kapsam
 * riski" ve "Engel: kaynak kalite kontrolü gerekiyor", oysa transkript eksiksizdi.
 *
 * Konuşma süresi ölçülebiliyorsa oran ona göre; zamanlama hiç yoksa eski kayıt
 * penceresi davranışı; zamanlama kısmi ise oran verilmez ve kapsam hükmü kurulmaz.
 */
function assessWordRate(
  state: TranscriptSessionState,
  wordCount: number,
  recordingWindowMs: number,
): WordRateAssessment {
  const speech = transcriptSpeechSpan(state);
  if (speech.kind === 'measured') {
    const rate = calculateWordRatePerMinute(wordCount, speech.ms);
    return { wordRatePerMinute: rate, lowWordRate: isLowWordRateValue(rate, speech.ms) };
  }
  if (speech.kind === 'unmeasurable') {
    return { wordRatePerMinute: null, lowWordRate: false };
  }
  const rate = calculateWordRatePerMinute(wordCount, recordingWindowMs);
  return { wordRatePerMinute: rate, lowWordRate: isLowWordRateValue(rate, recordingWindowMs) };
}

function isLowWordRateValue(wordRatePerMinute: number | null, durationMs: number): boolean {
  return (
    typeof wordRatePerMinute === 'number' &&
    Number.isFinite(wordRatePerMinute) &&
    durationMs >= REPORT_WORD_RATE_WARN_MIN_DURATION_MS &&
    wordRatePerMinute < REPORT_LOW_WORDS_PER_MINUTE
  );
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
    `- Kalite kapısı: ${readiness.qualityGate.label}`,
    `- Kalite riski: ${readiness.qualityGate.risk}`,
    `- Kalite aksiyonu: ${readiness.qualityGate.action}`,
    `- Satır: ${segments.length}`,
    `- Kelime: ${readiness.wordCount}`,
    `- Kelime/dk: ${formatWordRate(readiness.wordRatePerMinute)}`,
    `- Süre: ${formatDuration(readiness.durationMs)}`,
    `- Final oranı: ${formatPercent(readiness.finalRatio)}`,
    `- İncelenen: ${readiness.reviewedCount}/${segments.length}`,
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
    `Kalite kapısı: ${readiness.qualityGate.label}`,
    `Kalite riski: ${readiness.qualityGate.risk}`,
    `Kalite aksiyonu: ${readiness.qualityGate.action}`,
    `Satır: ${segments.length}`,
    `Kelime: ${readiness.wordCount}`,
    `Kelime/dk: ${formatWordRate(readiness.wordRatePerMinute)}`,
    `Süre: ${formatDuration(readiness.durationMs)}`,
    `Final oranı: ${formatPercent(readiness.finalRatio)}`,
    `İncelenen: ${readiness.reviewedCount}/${segments.length}`,
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

function formatWordRate(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  if (value >= 10) {
    return `${Math.round(value)} kelime/dk`;
  }
  return `${value.toFixed(1)} kelime/dk`;
}

function toSeconds(valueMs: number): number {
  return Math.max(0, Math.round(valueMs) / 1000);
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
}
