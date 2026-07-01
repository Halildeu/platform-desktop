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

export type TranscriptSourceReadinessLevel = 'empty' | 'collecting' | 'review' | 'ready';

export interface TranscriptSourceReadiness {
  level: TranscriptSourceReadinessLevel;
  label: string;
  detail: string;
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
    ? state.segments.map((item) => (item.id === segment.id ? { ...item, ...segment } : item))
    : [...state.segments, segment];

  return {
    ...state,
    segments: segments.sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id)),
  };
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

export function analyzeTranscriptSourceReadiness(
  state: TranscriptSessionState,
): TranscriptSourceReadiness {
  const segments = sourceSegments(state);
  if (segments.length === 0) {
    return {
      level: 'empty',
      label: 'Kaynak bekleniyor',
      detail: 'Transkript satırı oluşmadan çıktı üretimi başlamaz.',
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
  const warnings = [
    ...(finalCount === 0 ? ['Final satır bekleniyor.'] : []),
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
      detail: 'Transkript kaynağı meeting output üretimi için yeterli görünüyor.',
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
    label: finalCount > 0 ? 'Gözden geçirilmeli' : 'Taslak kaynak',
    detail:
      finalCount > 0
        ? 'Kaynak var; rapor/özet öncesi kapsam ve final oranı kontrol edilmeli.'
        : 'Yalnız taslak satır var; final transcript beklenmeli.',
    wordCount,
    durationMs,
    finalCount,
    draftCount,
    finalRatio,
    warnings,
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildTranscriptMarkdown(
  state: TranscriptSessionState,
  segments: TranscriptSegment[],
): string {
  const lines = [
    '# Meeting Transcript',
    '',
    `- Meeting: ${state.meetingId ?? '-'}`,
    `- Oturum: ${state.sessionId ?? '-'}`,
    `- Kaynak: ${state.hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon'}`,
    `- Başlangıç: ${formatTimestamp(state.startedAtMs)}`,
    `- Bitiş: ${formatTimestamp(state.finishedAtMs)}`,
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
  const lines = [
    'Meeting Transcript',
    '',
    `Meeting: ${state.meetingId ?? '-'}`,
    `Oturum: ${state.sessionId ?? '-'}`,
    `Kaynak: ${state.hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon'}`,
    `Başlangıç: ${formatTimestamp(state.startedAtMs)}`,
    `Bitiş: ${formatTimestamp(state.finishedAtMs)}`,
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

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
}
