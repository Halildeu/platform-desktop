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

const STATUS_RANK: Record<TranscriptSegmentStatus, number> = {
  draft: 0,
  stabilizing: 1,
  final: 2,
  revised: 3,
};

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
  const segments = state.segments
    .filter((segment) => segment.text.trim().length > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id));
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
