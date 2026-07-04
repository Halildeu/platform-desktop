import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

import {
  lifecycleLabel,
  transcriptStatusLabel,
  type TranscriptSegmentStatus,
  type TranscriptSessionState,
} from '../transcript/session-transcript';
import type { LiveSttPreflightState } from '../audio/live-stt-preflight';
import type { LiveSttStreamStatusEvent } from '../audio/live-stt-stream';
import type { AudioCapturePreflightState } from '../audio/capture';

const TRANSCRIPT_LAG_WARN_MS = 5_000;
const SPEAKER_COLORS = ['#0f766e', '#2563eb', '#b45309', '#7c3aed', '#be123c', '#0f766e'];

type TranscriptFilter = 'all' | 'draft' | 'final' | 'revised' | 'direct' | 'gateway';

const TRANSCRIPT_FILTERS: Array<{ key: TranscriptFilter; label: string }> = [
  { key: 'all', label: 'Tümü' },
  { key: 'draft', label: 'Taslaklar' },
  { key: 'final', label: 'Finaller' },
  { key: 'revised', label: 'Revizeler' },
  { key: 'direct', label: 'Direct kaynak' },
  { key: 'gateway', label: 'Gateway kaynak' },
];

export interface TranscriptPanelProps {
  session: TranscriptSessionState;
  onSegmentTextChange?: (segmentId: string, text: string) => void;
  stream?: {
    directConfigured: boolean;
    directReady?: boolean;
    directStatus?: LiveSttStreamStatusEvent | null;
    directActive: boolean;
    audioRms?: number | null;
    audioActive?: boolean;
    lastAudioAtMs?: number | null;
    disabledReason: string | null;
    preflight?: LiveSttPreflightState;
    capturePreflight?: AudioCapturePreflightState;
    onPreflight?: () => void;
  };
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function captureMode(hasLoopback: boolean): string {
  return hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon';
}

function streamModeLabel(stream: TranscriptPanelProps['stream'], recordingActive: boolean): string {
  if (!recordingActive) {
    return stream?.directConfigured ? 'Direct stream' : 'Gateway event';
  }
  if (stream?.directStatus?.status === 'reconnecting') {
    return 'Direct stream';
  }
  if (stream?.directActive) {
    return 'Direct stream';
  }
  if (stream?.directReady) {
    return 'Direct stream';
  }
  if (stream?.directConfigured) {
    return 'Direct stream bekleniyor';
  }
  if (stream?.disabledReason) {
    return 'Gateway event';
  }
  return 'Gateway event';
}

function streamLoadingStageLabel(stage: string | undefined): string {
  if (stage === 'live_model') {
    return 'canlı model';
  }
  if (stage === 'final_model') {
    return 'final model';
  }
  return 'model';
}

function streamLagMs(
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): number | null {
  if (
    !recordingActive ||
    !stream?.audioActive ||
    typeof stream.lastAudioAtMs !== 'number' ||
    !Number.isFinite(stream.lastAudioAtMs) ||
    typeof lastTranscriptAtMs !== 'number' ||
    !Number.isFinite(lastTranscriptAtMs)
  ) {
    return null;
  }

  return Math.max(0, stream.lastAudioAtMs - lastTranscriptAtMs);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return '<1 sn';
  }
  return `${Math.round(ms / 1000)} sn`;
}

function transcriptLagLabel(
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): string {
  if (
    !recordingActive ||
    !stream?.directConfigured ||
    !stream.audioActive ||
    typeof stream.lastAudioAtMs !== 'number' ||
    !Number.isFinite(stream.lastAudioAtMs)
  ) {
    return '-';
  }
  if (typeof lastTranscriptAtMs !== 'number' || !Number.isFinite(lastTranscriptAtMs)) {
    return stream.audioActive ? 'İlk metin bekleniyor' : '-';
  }

  const lagMs = Math.max(0, stream.lastAudioAtMs - lastTranscriptAtMs);
  if (lagMs >= TRANSCRIPT_LAG_WARN_MS) {
    return `Gecikiyor · ${formatDuration(lagMs)}`;
  }
  return formatDuration(lagMs);
}

function transcriptLagClass(
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): string {
  const lagMs = streamLagMs(stream, lastTranscriptAtMs, recordingActive);
  return lagMs !== null && lagMs >= TRANSCRIPT_LAG_WARN_MS ? 'stream-lag-warning' : '';
}

function streamModeDetail(
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): string {
  if (!recordingActive) {
    return stream?.directConfigured ? 'Kayıt başlayınca bağlanacak' : 'Kayıt başlayınca batch/poll';
  }

  const status = stream?.directStatus;
  if (status?.status === 'reconnecting') {
    const attempt =
      typeof status.attempt === 'number' && typeof status.maxAttempts === 'number'
        ? ` (${status.attempt}/${status.maxAttempts})`
        : '';
    return `Yeniden bağlanıyor${attempt}`;
  }
  if (status?.status === 'connecting') {
    return 'Bağlantı kuruluyor';
  }
  if (status?.status === 'loading') {
    return `Model yükleniyor: ${streamLoadingStageLabel(status.stage)}`;
  }
  if (status?.status === 'error') {
    return 'Bağlantı hatası';
  }
  if (status?.status === 'closed') {
    return 'Kapalı';
  }
  if (stream?.directActive) {
    return 'Kelime akışı aktif';
  }
  if (stream?.directReady) {
    const lagMs = streamLagMs(stream, lastTranscriptAtMs, recordingActive);
    if (lagMs !== null && lagMs >= TRANSCRIPT_LAG_WARN_MS) {
      return `Metin gecikiyor (${formatDuration(lagMs)})`;
    }
    return stream.audioActive ? 'Ses alınıyor, kelime bekleniyor' : 'Bağlı, ses bekleniyor';
  }
  if (stream?.directConfigured) {
    return 'Bağlantı kuruluyor';
  }
  return 'Batch/poll akışı';
}

function audioStatusLabel(stream: TranscriptPanelProps['stream']): string {
  if (typeof stream?.audioRms !== 'number' || !Number.isFinite(stream.audioRms)) {
    return '-';
  }
  const level = stream.audioActive ? 'Alınıyor' : 'Sessiz';
  return `${level} · RMS ${stream.audioRms.toFixed(3)}`;
}

function latestTranscriptReceivedAtMs(session: TranscriptSessionState): number | null {
  return session.segments.reduce<number | null>((latest, segment) => {
    const candidate =
      typeof segment.receivedAtMs === 'number' && Number.isFinite(segment.receivedAtMs)
        ? segment.receivedAtMs
        : segment.startedAtMs;
    return latest === null || candidate > latest ? candidate : latest;
  }, null);
}

function streamTimestampLabel(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return formatClock(value);
}

function preflightStatusLabel(
  preflight: LiveSttPreflightState | undefined,
  stream: TranscriptPanelProps['stream'],
  recordingActive: boolean,
): string | null {
  if (!preflight || preflight.status === 'idle') {
    return null;
  }
  if (
    recordingActive &&
    (stream?.directActive || stream?.directReady || stream?.directStatus?.status === 'ready')
  ) {
    return null;
  }
  if (preflight.status === 'checking') {
    return preflight.message ?? 'Direct STT stream kontrol ediliyor...';
  }
  const elapsed =
    typeof preflight.elapsedMs === 'number' && Number.isFinite(preflight.elapsedMs)
      ? ` · ${preflight.elapsedMs} ms`
      : '';
  return `${preflight.message ?? 'Direct STT test sonucu alindi.'}${elapsed}`;
}

function preflightMessageClass(preflight: LiveSttPreflightState | undefined): string {
  if (preflight?.status === 'error') {
    return 'inline-error';
  }
  return 'export-message';
}

function capturePreflightStatusLabel(preflight: AudioCapturePreflightState | undefined): string {
  if (!preflight || preflight.status === 'idle') {
    return 'Test edilmedi';
  }
  if (preflight.status === 'checking') {
    return 'Kontrol ediliyor';
  }
  if (preflight.status === 'ready') {
    return 'Hazır';
  }
  return 'Hata';
}

function capturePreflightLabel(preflight: AudioCapturePreflightState | undefined): string | null {
  if (!preflight || preflight.status === 'idle') {
    return null;
  }
  if (preflight.status === 'checking') {
    return preflight.message ?? 'Ses işleyici kontrol ediliyor...';
  }
  const elapsed =
    typeof preflight.elapsedMs === 'number' && Number.isFinite(preflight.elapsedMs)
      ? ` · ${preflight.elapsedMs} ms`
      : '';
  return `${preflight.message ?? 'Ses işleyici test sonucu alındı.'}${elapsed}`;
}

function capturePreflightMessageClass(preflight: AudioCapturePreflightState | undefined): string {
  if (preflight?.status === 'error') {
    return 'inline-error';
  }
  return 'export-message';
}

function segmentSourceLabel(source: string | undefined): string {
  if (source === 'direct-stream') {
    return 'Direct STT';
  }
  if (source === 'gateway-events') {
    return 'Gateway';
  }
  return 'Kaynak bekleniyor';
}

function segmentMetricLabel(segment: TranscriptSessionState['segments'][number]): string | null {
  if (typeof segment.elapsedMs === 'number' && Number.isFinite(segment.elapsedMs)) {
    return `${segment.elapsedMs} ms`;
  }
  if (typeof segment.rms === 'number' && Number.isFinite(segment.rms)) {
    return `RMS ${segment.rms.toFixed(3)}`;
  }
  return null;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

function formatSpeakerDuration(ms: number): string {
  if (ms <= 0) {
    return '-';
  }
  if (ms < 1000) {
    return '<1 sn';
  }
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} dk ${rest} sn` : `${seconds} sn`;
}

function speakerLabelFor(sourceLabel: string, labels: Record<string, string>): string {
  const draft = labels[sourceLabel]?.trim();
  return draft || sourceLabel;
}

function speakerInputValue(sourceLabel: string, labels: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(labels, sourceLabel)
    ? (labels[sourceLabel] ?? '')
    : sourceLabel;
}

interface SpeakerTimelineEntry {
  id: string;
  sourceLabel: string;
  label: string;
  color: string;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number;
  turnWords: number;
  leftPct: number;
  widthPct: number;
}

interface SpeakerSummary {
  sourceLabel: string;
  label: string;
  color: string;
  turns: number;
  durationMs: number;
  words: number;
  sharePct: number;
}

interface InterruptionSignal {
  id: string;
  atMs: number;
  label: string;
  previousLabel: string;
  overlapMs: number;
}

function explicitSegmentEnd(segment: TranscriptSessionState['segments'][number]): number | null {
  if (
    typeof segment.endedAtMs === 'number' &&
    Number.isFinite(segment.endedAtMs) &&
    segment.endedAtMs > segment.startedAtMs
  ) {
    return segment.endedAtMs;
  }
  return null;
}

function buildSpeakerTimeline(
  session: TranscriptSessionState,
  speakerLabels: Record<string, string>,
): SpeakerTimelineEntry[] {
  if (session.segments.length === 0) {
    return [];
  }

  const segments = [...session.segments].sort(
    (a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id),
  );
  const labelIndexes = new Map<string, number>();
  const firstStart = segments[0].startedAtMs;

  const entries = segments.map((segment, index) => {
    if (!labelIndexes.has(segment.speakerLabel)) {
      labelIndexes.set(segment.speakerLabel, labelIndexes.size);
    }
    const sourceIndex = labelIndexes.get(segment.speakerLabel) ?? 0;
    const explicitEnd = explicitSegmentEnd(segment);
    const nextStart = segments[index + 1]?.startedAtMs;
    const fallbackEnd =
      typeof nextStart === 'number' && nextStart > segment.startedAtMs
        ? nextStart
        : typeof session.finishedAtMs === 'number' && session.finishedAtMs > segment.startedAtMs
          ? session.finishedAtMs
          : null;
    const endedAtMs = explicitEnd ?? fallbackEnd;
    const durationMs = endedAtMs === null ? 0 : Math.max(0, endedAtMs - segment.startedAtMs);

    return {
      id: segment.id,
      sourceLabel: segment.speakerLabel,
      label: speakerLabelFor(segment.speakerLabel, speakerLabels),
      color: speakerColor(sourceIndex),
      startedAtMs: segment.startedAtMs,
      endedAtMs,
      durationMs,
      turnWords: wordCount(segment.text),
      leftPct: 0,
      widthPct: 0,
    };
  });

  const lastEnd = entries.reduce(
    (latest, entry) => Math.max(latest, entry.endedAtMs ?? entry.startedAtMs),
    firstStart,
  );
  const spanMs = Math.max(1, lastEnd - firstStart);

  return entries.map((entry) => ({
    ...entry,
    leftPct: ((entry.startedAtMs - firstStart) / spanMs) * 100,
    widthPct: Math.max(2, (Math.max(entry.durationMs, 1) / spanMs) * 100),
  }));
}

function buildSpeakerSummaries(entries: SpeakerTimelineEntry[]): SpeakerSummary[] {
  const bySource = new Map<string, SpeakerSummary>();
  for (const entry of entries) {
    const existing = bySource.get(entry.sourceLabel);
    if (existing) {
      existing.turns += 1;
      existing.durationMs += entry.durationMs;
      existing.words += entry.turnWords;
    } else {
      bySource.set(entry.sourceLabel, {
        sourceLabel: entry.sourceLabel,
        label: entry.label,
        color: entry.color,
        turns: 1,
        durationMs: entry.durationMs,
        words: entry.turnWords,
        sharePct: 0,
      });
    }
  }

  const summaries = [...bySource.values()];
  const totalDuration = summaries.reduce((total, item) => total + item.durationMs, 0);
  const totalTurns = summaries.reduce((total, item) => total + item.turns, 0);
  return summaries.map((item) => ({
    ...item,
    sharePct:
      totalDuration > 0
        ? (item.durationMs / totalDuration) * 100
        : totalTurns > 0
          ? (item.turns / totalTurns) * 100
          : 0,
  }));
}

function speakerDistributionGradient(summaries: SpeakerSummary[]): string {
  if (summaries.length === 0) {
    return '#e2e8f0';
  }

  let cursor = 0;
  const slices = summaries.map((speaker) => {
    const start = cursor;
    cursor += speaker.sharePct;
    return `${speaker.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  return `conic-gradient(${slices.join(', ')})`;
}

function buildInterruptionSignals(entries: SpeakerTimelineEntry[]): InterruptionSignal[] {
  const signals: InterruptionSignal[] = [];
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous.sourceLabel === current.sourceLabel || previous.endedAtMs === null) {
      continue;
    }
    const overlapMs = previous.endedAtMs - current.startedAtMs;
    if (overlapMs > 0) {
      signals.push({
        id: `${previous.id}-${current.id}`,
        atMs: current.startedAtMs,
        label: current.label,
        previousLabel: previous.label,
        overlapMs,
      });
    }
  }
  return signals;
}

function isLiveDirectDraft(segment: TranscriptSessionState['segments'][number]): boolean {
  return segment.source === 'direct-stream' && segment.status === 'draft';
}

function formatDiagnosticTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return new Date(value).toISOString();
}

function formatDiagnosticNumber(value: number | null | undefined, precision = 3): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(precision);
}

function transcriptStatusCounts(
  session: TranscriptSessionState,
): Record<TranscriptSegmentStatus, number> {
  return session.segments.reduce<Record<TranscriptSegmentStatus, number>>(
    (counts, segment) => {
      counts[segment.status] += 1;
      return counts;
    },
    { draft: 0, stabilizing: 0, final: 0, revised: 0 },
  );
}

function transcriptSourceCounts(session: TranscriptSessionState): {
  direct: number;
  gateway: number;
  unknown: number;
} {
  return session.segments.reduce(
    (counts, segment) => {
      if (segment.source === 'direct-stream') {
        counts.direct += 1;
      } else if (segment.source === 'gateway-events') {
        counts.gateway += 1;
      } else {
        counts.unknown += 1;
      }
      return counts;
    },
    { direct: 0, gateway: 0, unknown: 0 },
  );
}

function normalizeTranscriptQuery(value: string): string {
  return value.trim().toLocaleLowerCase('tr-TR');
}

function matchesTranscriptFilter(
  segment: TranscriptSessionState['segments'][number],
  filter: TranscriptFilter,
): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'draft') {
    return segment.status === 'draft' || segment.status === 'stabilizing';
  }
  if (filter === 'final') {
    return segment.status === 'final';
  }
  if (filter === 'revised') {
    return segment.status === 'revised';
  }
  if (filter === 'direct') {
    return segment.source === 'direct-stream';
  }
  return segment.source === 'gateway-events';
}

function matchesTranscriptQuery(
  segment: TranscriptSessionState['segments'][number],
  query: string,
  speakerLabels: Record<string, string>,
): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    segment.text,
    segment.speakerLabel,
    speakerLabelFor(segment.speakerLabel, speakerLabels),
    transcriptStatusLabel(segment.status),
    segmentSourceLabel(segment.source),
  ]
    .join(' ')
    .toLocaleLowerCase('tr-TR');

  return haystack.includes(query);
}

function transcriptReviewSummary(session: TranscriptSessionState, visibleCount: number): string {
  const statusCounts = transcriptStatusCounts(session);
  const sourceCounts = transcriptSourceCounts(session);
  return [
    `Görünen ${visibleCount}/${session.segments.length}`,
    `Final ${statusCounts.final}`,
    `Revize ${statusCounts.revised}`,
    `Taslak ${statusCounts.draft + statusCounts.stabilizing}`,
    `Direct ${sourceCounts.direct}`,
    `Gateway ${sourceCounts.gateway}`,
  ].join(' · ');
}

function buildTranscriptDiagnostics(
  session: TranscriptSessionState,
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): string {
  const statusCounts = transcriptStatusCounts(session);
  const sourceCounts = transcriptSourceCounts(session);
  const lagMs = streamLagMs(stream, lastTranscriptAtMs, recordingActive);

  return [
    'meeting-intelligence.transcript.diagnostics.v1',
    `generatedAt=${new Date().toISOString()}`,
    `lifecycle=${session.lifecycle}`,
    `meetingId=${session.meetingId ?? '-'}`,
    `sessionId=${session.sessionId ?? '-'}`,
    `deviceId=${session.deviceId ?? '-'}`,
    `captureMode=${captureMode(session.hasLoopback)}`,
    `recordingActive=${recordingActive}`,
    `directConfigured=${Boolean(stream?.directConfigured)}`,
    `directStatus=${stream?.directStatus?.status ?? '-'}`,
    `directReady=${Boolean(stream?.directReady)}`,
    `directActive=${Boolean(stream?.directActive)}`,
    `audioCapturePreflight=${stream?.capturePreflight?.status ?? '-'}`,
    `audioCaptureWorklet=${stream?.capturePreflight?.moduleUrl ?? '-'}`,
    `audioActive=${Boolean(stream?.audioActive)}`,
    `audioRms=${formatDiagnosticNumber(stream?.audioRms)}`,
    `lastAudioAt=${formatDiagnosticTimestamp(stream?.lastAudioAtMs)}`,
    `lastTranscriptAt=${formatDiagnosticTimestamp(lastTranscriptAtMs)}`,
    `lagMs=${lagMs ?? '-'}`,
    `segments.total=${session.segments.length}`,
    `segments.draft=${statusCounts.draft}`,
    `segments.stabilizing=${statusCounts.stabilizing}`,
    `segments.final=${statusCounts.final}`,
    `segments.revised=${statusCounts.revised}`,
    `segments.direct=${sourceCounts.direct}`,
    `segments.gateway=${sourceCounts.gateway}`,
    `segments.unknown=${sourceCounts.unknown}`,
    `errorPresent=${Boolean(session.error)}`,
  ].join('\n');
}

export function TranscriptPanel({
  session,
  stream,
  onSegmentTextChange,
}: TranscriptPanelProps): ReactElement {
  const hasSegments = session.segments.length > 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segmentTextDrafts, setSegmentTextDrafts] = useState<Record<string, string>>({});
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [transcriptFilter, setTranscriptFilter] = useState<TranscriptFilter>('all');
  const visibleSegments = [...session.segments].reverse();
  const normalizedTranscriptQuery = normalizeTranscriptQuery(transcriptQuery);
  const filteredSegments = visibleSegments.filter(
    (segment) =>
      matchesTranscriptFilter(segment, transcriptFilter) &&
      matchesTranscriptQuery(segment, normalizedTranscriptQuery, speakerLabels),
  );
  const speakerTimeline = buildSpeakerTimeline(session, speakerLabels);
  const speakerSummaries = buildSpeakerSummaries(speakerTimeline);
  const interruptionSignals = buildInterruptionSignals(speakerTimeline);
  const hasSpeakerOverrides = Object.entries(speakerLabels).some(
    ([sourceLabel, label]) => label.trim() && label.trim() !== sourceLabel,
  );
  const lastTranscriptAtMs = latestTranscriptReceivedAtMs(session);
  const recordingActive = session.lifecycle === 'recording';
  const lagClass = transcriptLagClass(stream, lastTranscriptAtMs, recordingActive);
  const canRunPreflight = Boolean(
    stream?.directConfigured && stream.onPreflight && !recordingActive,
  );
  const preflightLabel = preflightStatusLabel(stream?.preflight, stream, recordingActive);
  const captureLabel = capturePreflightLabel(stream?.capturePreflight);

  const handleCopyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        buildTranscriptDiagnostics(session, stream, lastTranscriptAtMs, recordingActive),
      );
      setDiagnosticMessage('Tanı panoya kopyalandı.');
    } catch {
      setDiagnosticMessage('Tanı kopyalanamadı.');
    }
  };

  const beginSegmentReview = (segmentId: string, text: string): void => {
    setEditingSegmentId(segmentId);
    setSegmentTextDrafts((current) => ({
      ...current,
      [segmentId]: text,
    }));
  };

  const cancelSegmentReview = (): void => {
    setEditingSegmentId(null);
  };

  const saveSegmentReview = (segmentId: string): void => {
    const reviewedText = (segmentTextDrafts[segmentId] ?? '').trim();
    if (!reviewedText) {
      return;
    }
    onSegmentTextChange?.(segmentId, reviewedText);
    setEditingSegmentId(null);
  };

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [filteredSegments.length, session.segments, transcriptFilter, transcriptQuery]);

  useEffect(() => {
    setSpeakerLabels({});
    setEditingSegmentId(null);
    setSegmentTextDrafts({});
    setTranscriptQuery('');
    setTranscriptFilter('all');
  }, [session.meetingId, session.sessionId]);

  return (
    <section className="transcript-panel" aria-labelledby="transcript-title">
      <div className="panel-header">
        <div>
          <h2 id="transcript-title">Canlı Transkript</h2>
          <p className="panel-subtitle">
            {session.sessionId ? `Oturum ${session.sessionId}` : 'Recorder oturumu yok'}
          </p>
        </div>
        <div className="panel-header-actions">
          {canRunPreflight ? (
            <button
              className="secondary-action compact-action"
              type="button"
              onClick={stream?.onPreflight}
              disabled={
                stream?.preflight?.status === 'checking' ||
                stream?.capturePreflight?.status === 'checking'
              }
            >
              {stream?.preflight?.status === 'checking' ||
              stream?.capturePreflight?.status === 'checking'
                ? 'Test ediliyor...'
                : 'Bağlantı testi'}
            </button>
          ) : null}
          <button
            className="secondary-action compact-action"
            type="button"
            onClick={() => void handleCopyDiagnostics()}
          >
            Tanı kopyala
          </button>
          <span className={`state-pill state-${session.lifecycle}`}>
            {lifecycleLabel(session.lifecycle)}
          </span>
        </div>
      </div>

      <div className="session-strip" aria-label="Oturum özeti">
        <div>
          <span>Meeting</span>
          <strong>{session.meetingId ?? '-'}</strong>
        </div>
        <div>
          <span>Cihaz</span>
          <strong>{session.deviceId ?? '-'}</strong>
        </div>
        <div>
          <span>Kaynak</span>
          <strong>{captureMode(session.hasLoopback)}</strong>
        </div>
        <div>
          <span>Başlangıç</span>
          <strong>{session.startedAtMs ? formatClock(session.startedAtMs) : '-'}</strong>
        </div>
      </div>

      <div className="stream-strip" aria-label="Transkript akış durumu">
        <div>
          <span>Akış</span>
          <strong>{streamModeLabel(stream, recordingActive)}</strong>
        </div>
        <div>
          <span>Durum</span>
          <strong>{streamModeDetail(stream, lastTranscriptAtMs, recordingActive)}</strong>
        </div>
        <div>
          <span>Ses</span>
          <strong>{audioStatusLabel(stream)}</strong>
        </div>
        <div>
          <span>Son ses</span>
          <strong>{streamTimestampLabel(stream?.lastAudioAtMs)}</strong>
        </div>
        <div>
          <span>Son metin</span>
          <strong>{streamTimestampLabel(lastTranscriptAtMs)}</strong>
        </div>
        <div>
          <span>Ses işleyici</span>
          <strong>{capturePreflightStatusLabel(stream?.capturePreflight)}</strong>
        </div>
        <div>
          <span>Gecikme</span>
          <strong className={lagClass}>
            {transcriptLagLabel(stream, lastTranscriptAtMs, recordingActive)}
          </strong>
        </div>
      </div>

      {captureLabel ? (
        <p className={capturePreflightMessageClass(stream?.capturePreflight)}>{captureLabel}</p>
      ) : null}
      {preflightLabel ? (
        <p className={preflightMessageClass(stream?.preflight)}>{preflightLabel}</p>
      ) : null}
      {diagnosticMessage ? <p className="export-message">{diagnosticMessage}</p> : null}
      {session.error ? <p className="inline-error">{session.error}</p> : null}

      {hasSegments ? (
        <section className="speaker-panel" aria-labelledby="speaker-panel-title">
          <div className="speaker-panel-header">
            <div>
              <h3 id="speaker-panel-title">Konuşmacı Görünümü</h3>
              <p>Kaynak: transcript speaker etiketi</p>
            </div>
            {hasSpeakerOverrides ? (
              <button
                className="secondary-action compact-action"
                type="button"
                onClick={() => setSpeakerLabels({})}
              >
                Etiketleri sıfırla
              </button>
            ) : null}
          </div>

          <div className="speaker-overview">
            <div
              className="speaker-distribution-chart"
              aria-label="Konuşma dağılımı pasta grafiği"
              style={{ background: speakerDistributionGradient(speakerSummaries) }}
            />
            <div className="speaker-stat-list">
              {speakerSummaries.map((speaker) => (
                <label className="speaker-stat" key={speaker.sourceLabel}>
                  <span
                    className="speaker-color"
                    aria-hidden="true"
                    style={{ backgroundColor: speaker.color }}
                  />
                  <span className="speaker-stat-body">
                    <span className="speaker-stat-meta">
                      {Math.round(speaker.sharePct)}% · {speaker.turns} tur ·{' '}
                      {formatSpeakerDuration(speaker.durationMs)}
                    </span>
                    <input
                      aria-label={`Konuşmacı adı: ${speaker.sourceLabel}`}
                      value={speakerInputValue(speaker.sourceLabel, speakerLabels)}
                      onChange={(event) =>
                        setSpeakerLabels((current) => ({
                          ...current,
                          [speaker.sourceLabel]: event.target.value,
                        }))
                      }
                    />
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="speaker-timeline" role="img" aria-label="Konuşmacı zaman çizgisi">
            {speakerTimeline.map((entry) => (
              <div
                className="speaker-timeline-block"
                key={entry.id}
                style={
                  {
                    '--speaker-color': entry.color,
                    left: `${entry.leftPct}%`,
                    width: `${Math.min(entry.widthPct, 100 - entry.leftPct)}%`,
                  } as CSSProperties
                }
                title={`${entry.label} · ${formatClock(entry.startedAtMs)} · ${formatSpeakerDuration(
                  entry.durationMs,
                )}`}
              >
                <span>{entry.label}</span>
              </div>
            ))}
          </div>

          <div className="speaker-interruptions" aria-live="polite">
            <strong>Söz kesme sinyali</strong>
            {interruptionSignals.length > 0 ? (
              <ul>
                {interruptionSignals.map((signal) => (
                  <li key={signal.id}>
                    {formatClock(signal.atMs)} · {signal.label}, {signal.previousLabel} üzerine{' '}
                    {formatSpeakerDuration(signal.overlapMs)} bindi
                  </li>
                ))}
              </ul>
            ) : (
              <span>Kesin overlap sinyali yok.</span>
            )}
          </div>
        </section>
      ) : null}

      {hasSegments ? (
        <section className="transcript-review-toolbar" aria-label="Transkript inceleme araçları">
          <div className="transcript-search-field">
            <label htmlFor="transcript-search">Ara</label>
            <input
              id="transcript-search"
              type="search"
              placeholder="Transkriptte ara"
              value={transcriptQuery}
              onChange={(event) => setTranscriptQuery(event.target.value)}
            />
          </div>
          <div className="transcript-filter-group" aria-label="Transkript filtreleri">
            {TRANSCRIPT_FILTERS.map((filter) => (
              <button
                className={`transcript-filter-button${
                  transcriptFilter === filter.key ? ' transcript-filter-button-active' : ''
                }`}
                type="button"
                key={filter.key}
                aria-pressed={transcriptFilter === filter.key}
                onClick={() => setTranscriptFilter(filter.key)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <p className="transcript-review-stats">
            {transcriptReviewSummary(session, filteredSegments.length)}
          </p>
        </section>
      ) : null}

      <div className="transcript-list" aria-live="polite" ref={listRef}>
        {hasSegments && filteredSegments.length > 0 ? (
          filteredSegments.map((segment) => {
            const metricLabel = segmentMetricLabel(segment);
            const liveDirectDraft = isLiveDirectDraft(segment);
            const editableSegment = Boolean(onSegmentTextChange) && !liveDirectDraft;
            const editingSegment = editingSegmentId === segment.id;
            const segmentDraftText = segmentTextDrafts[segment.id] ?? segment.text;
            const reviewedText = segmentDraftText.trim();
            const reviewChanged = reviewedText !== segment.text.trim();

            return (
              <article
                className={`transcript-segment segment-${segment.status}${
                  liveDirectDraft ? ' segment-live' : ''
                }`}
                key={segment.id}
              >
                <div className="segment-meta">
                  <span>{speakerLabelFor(segment.speakerLabel, speakerLabels)}</span>
                  <time dateTime={new Date(segment.startedAtMs).toISOString()}>
                    {formatClock(segment.startedAtMs)}
                  </time>
                  <span>{transcriptStatusLabel(segment.status)}</span>
                  <span>{segmentSourceLabel(segment.source)}</span>
                  {metricLabel ? <span>{metricLabel}</span> : null}
                  {liveDirectDraft ? <span>Canlı</span> : null}
                </div>
                {editingSegment ? (
                  <div className="segment-editor">
                    <label htmlFor={`segment-editor-${segment.id}`}>Transkript metni</label>
                    <textarea
                      id={`segment-editor-${segment.id}`}
                      value={segmentDraftText}
                      onChange={(event) =>
                        setSegmentTextDrafts((current) => ({
                          ...current,
                          [segment.id]: event.target.value,
                        }))
                      }
                    />
                    <div className="segment-editor-actions">
                      <button
                        className="primary-action compact-action"
                        type="button"
                        onClick={() => saveSegmentReview(segment.id)}
                        disabled={!reviewedText || !reviewChanged}
                      >
                        Kaydet
                      </button>
                      <button
                        className="secondary-action compact-action"
                        type="button"
                        onClick={cancelSegmentReview}
                      >
                        Vazgeç
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p>
                      {segment.text}
                      {liveDirectDraft ? (
                        <span className="live-caret" aria-hidden="true">
                          |
                        </span>
                      ) : null}
                    </p>
                    {editableSegment ? (
                      <div className="segment-actions">
                        <button
                          className="secondary-action compact-action segment-review-action"
                          type="button"
                          onClick={() => beginSegmentReview(segment.id, segment.text)}
                        >
                          Metni düzelt
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </article>
            );
          })
        ) : hasSegments ? (
          <div className="transcript-empty">
            <strong>Filtreyle eşleşen satır yok</strong>
            <span>Eşleşen kayıt bulunamadı.</span>
          </div>
        ) : (
          <div className="transcript-empty">
            <strong>Transkript akışı bekleniyor</strong>
            <span>
              {session.lifecycle === 'recording'
                ? 'Ses gateway tarafına gönderiliyor.'
                : 'Kayıt oturumu başlayınca zaman çizelgesi burada açılır.'}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
