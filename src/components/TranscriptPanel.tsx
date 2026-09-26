import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import {
  compareTranscriptSegments,
  lifecycleLabel,
  transcriptSpeechSpan,
  transcriptStatusLabel,
  type SpeechSpan,
  type TranscriptSegment,
  type TranscriptSegmentStatus,
  type TranscriptSessionState,
} from '../transcript/session-transcript';
import { buildTurnFlow } from '../transcript/turn-flow';
import { advanceTypewriter, typewriterBudget } from '../transcript/typewriter';
import type { LiveSttPreflightState } from '../audio/live-stt-preflight';
import type { LiveSttStreamStatusEvent } from '../audio/live-stt-stream';
import type { AudioCapturePreflightState } from '../audio/capture';

const TRANSCRIPT_LAG_WARN_MS = 5_000;
const TRANSCRIPT_DENSITY_READY_MIN_MS = 10_000;
const TRANSCRIPT_LOW_DENSITY_WARN_MS = 15_000;
const TRANSCRIPT_LOW_DENSITY_SEGMENTS_PER_MINUTE = 1;
const TRANSCRIPT_LOW_WORD_RATE_WARN_MS = 20_000;
const TRANSCRIPT_LOW_WORDS_PER_MINUTE = 35;
/** Konuşma süresi bundan kısaysa kapsam hakkında hüküm verilmez. */
const TRANSCRIPT_SPEECH_WINDOW_MIN_MS = 20_000;
const TRANSCRIPT_TURN_GAP_MS = 30_000;
const TRANSCRIPT_TURN_MAX_SPAN_MS = 120_000;
const TRANSCRIPT_TURN_MAX_SEGMENTS = 40;
const SPEAKER_COLORS = ['#0f766e', '#2563eb', '#b45309', '#7c3aed', '#be123c', '#0f766e'];

type TranscriptFilter =
  | 'all'
  | 'review-pending'
  | 'reviewed'
  | 'draft'
  | 'final'
  | 'revised'
  | 'direct'
  | 'gateway';

const TRANSCRIPT_FILTERS: Array<{ key: TranscriptFilter; label: string }> = [
  { key: 'all', label: 'Tümü' },
  { key: 'review-pending', label: 'Kontrol bekleyen' },
  { key: 'reviewed', label: 'İncelenen' },
  { key: 'draft', label: 'Taslaklar' },
  { key: 'final', label: 'Finaller' },
  { key: 'revised', label: 'Revizeler' },
  { key: 'direct', label: 'Direct kaynak' },
  { key: 'gateway', label: 'Gateway kaynak' },
];

export interface TranscriptPanelProps {
  session: TranscriptSessionState;
  onSegmentTextChange?: (segmentId: string, text: string) => void;
  onSegmentReviewed?: (segmentId: string) => void;
  stream?: {
    directConfigured: boolean;
    mode?: 'gateway-live' | 'direct-live' | 'gateway-events';
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

const TYPEWRITER_TICK_MS = 30;

/**
 * Canlı kuyruğu daktilo gibi akıtır (gitops#3419): partial'lar ağdan 2-4
 * kelimelik paketlerle gelir; hedefi bir anda basmak "toplu düşme" algısı
 * yaratıyordu. Görünen metin hedefi 30ms adımlarla kovalar, birikim artarsa
 * hızlanır (typewriterBudget), partial revize olursa ortak öneke anında
 * döner. Aynı değerle setState React tarafından ucuza atlanır; interval
 * yalnız kuyruk bileşeni yaşarken çalışır.
 */
function TypewriterText({ text }: { text: string }): ReactElement {
  const [displayed, setDisplayed] = useState('');
  const targetRef = useRef(text);

  useEffect(() => {
    targetRef.current = text;
  }, [text]);

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayed((current) => {
        const target = targetRef.current;
        return advanceTypewriter(
          current,
          target,
          typewriterBudget(Math.max(0, target.length - current.length)),
        );
      });
    }, TYPEWRITER_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <>{displayed}</>;
}

function captureMode(hasLoopback: boolean): string {
  return hasLoopback ? 'Mikrofon + sistem sesi' : 'Mikrofon';
}

function streamModeLabel(stream: TranscriptPanelProps['stream'], recordingActive: boolean): string {
  const liveLabel = stream?.mode === 'gateway-live' ? 'Gateway canlı' : 'Direct stream';
  if (!recordingActive) {
    return stream?.directConfigured ? liveLabel : 'Gateway event';
  }
  if (stream?.directStatus?.status === 'reconnecting') {
    return liveLabel;
  }
  if (stream?.directActive) {
    return liveLabel;
  }
  if (stream?.directReady) {
    return liveLabel;
  }
  if (stream?.directConfigured) {
    return `${liveLabel} bekleniyor`;
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
  turnContribution: boolean;
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
  hasSourceTiming: boolean;
}

interface InterruptionSignal {
  id: string;
  atMs: number;
  label: string;
  previousLabel: string;
  overlapMs: number;
}

interface TranscriptTurn {
  id: string;
  speakerLabel: string;
  segments: TranscriptSegment[];
}

function transcriptTurnStatus(
  segments: readonly TranscriptSegment[],
): TranscriptSegmentStatus | 'mixed' {
  const statuses = new Set(segments.map((segment) => segment.status));
  if (statuses.size > 1) {
    return 'mixed';
  }
  return segments[0]?.status ?? 'final';
}

export function buildTranscriptTurns(segments: readonly TranscriptSegment[]): TranscriptTurn[] {
  const ordered = [...segments].sort(compareTranscriptSegments);
  const turns: TranscriptTurn[] = [];

  for (const segment of ordered) {
    const activeTurn = turns.at(-1);
    const previousSegment = activeTurn?.segments.at(-1);
    const previousEndMs = previousSegment
      ? (explicitSegmentEnd(previousSegment) ?? previousSegment.startedAtMs)
      : segment.startedAtMs;
    const gapMs = Math.max(0, segment.startedAtMs - previousEndMs);
    const turnSpanMs = activeTurn ? segment.startedAtMs - activeTurn.segments[0].startedAtMs : 0;
    const extendsTurn = Boolean(
      previousSegment &&
      previousSegment.source === segment.source &&
      activeTurn?.speakerLabel === segment.speakerLabel &&
      gapMs <= TRANSCRIPT_TURN_GAP_MS &&
      turnSpanMs <= TRANSCRIPT_TURN_MAX_SPAN_MS &&
      (activeTurn?.segments.length ?? 0) < TRANSCRIPT_TURN_MAX_SEGMENTS,
    );

    if (activeTurn && extendsTurn) {
      activeTurn.segments.push(segment);
      continue;
    }

    turns.push({
      id: `turn:${segment.source ?? 'unknown'}:${segment.id}`,
      speakerLabel: segment.speakerLabel,
      segments: [segment],
    });
  }

  return turns;
}

export function reconcileTranscriptTurnIds(
  previousTurns: readonly TranscriptTurn[],
  nextTurns: readonly TranscriptTurn[],
): TranscriptTurn[] {
  const availablePrevious = new Set(previousTurns.map((turn) => turn.id));

  return nextTurns.map((turn) => {
    const nextSegmentIds = new Set(turn.segments.map((segment) => segment.id));
    const firstNext = turn.segments[0];
    const candidates = previousTurns
      .filter((previous) => availablePrevious.has(previous.id))
      .map((previous) => {
        const overlap = previous.segments.reduce(
          (count, segment) => count + Number(nextSegmentIds.has(segment.id)),
          0,
        );
        const firstPrevious = previous.segments[0];
        const sameBoundary = Boolean(
          firstPrevious &&
          firstNext &&
          firstPrevious.source === firstNext.source &&
          previous.speakerLabel === turn.speakerLabel &&
          firstPrevious.startedAtMs === firstNext.startedAtMs,
        );
        return { previous, overlap, sameBoundary };
      })
      .filter((candidate) => candidate.overlap > 0 || candidate.sameBoundary)
      .sort(
        (left, right) =>
          right.overlap - left.overlap || Number(right.sameBoundary) - Number(left.sameBoundary),
      );
    const matched = candidates[0]?.previous;
    if (!matched) {
      return turn;
    }
    availablePrevious.delete(matched.id);
    return { ...turn, id: matched.id };
  });
}

type TranscriptFlowHealthLevel = 'idle' | 'ok' | 'watch' | 'warn';
type TranscriptFlowRisk =
  | 'none'
  | 'connection_error'
  | 'no_text'
  | 'lagging'
  | 'low_word_coverage'
  | 'low_segment_density'
  | 'waiting_audio';

interface TranscriptFlowHealth {
  label: string;
  detail: string;
  nextAction: string;
  level: TranscriptFlowHealthLevel;
  risk: TranscriptFlowRisk;
  words: number;
  spanMs: number | null;
  /** Oranların paydası olan konuşma süresi; ölçülemiyorsa null. */
  speechSpanMs: number | null;
  rateBasis: SpeechSpan['kind'];
  segmentsPerMinute: number | null;
  wordsPerMinute: number | null;
  directCount: number;
  gatewayCount: number;
}

function explicitSegmentEnd(segment: TranscriptSessionState['segments'][number]): number | null {
  if (
    segment.timingBasis === 'source' &&
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
  projectedTurns?: readonly TranscriptTurn[],
): SpeakerTimelineEntry[] {
  if (session.segments.length === 0) {
    return [];
  }

  const turns = projectedTurns ?? buildTranscriptTurns(session.segments);
  const labelIndexes = new Map<string, number>();
  const firstStart = turns[0].segments[0].startedAtMs;

  const entries = turns.flatMap((turn) =>
    turn.segments.map((segment, segmentIndex) => {
      if (!labelIndexes.has(turn.speakerLabel)) {
        labelIndexes.set(turn.speakerLabel, labelIndexes.size);
      }
      const sourceIndex = labelIndexes.get(turn.speakerLabel) ?? 0;
      const endedAtMs = explicitSegmentEnd(segment);
      const durationMs = endedAtMs === null ? 0 : endedAtMs - segment.startedAtMs;

      return {
        id: `${turn.id}:segment:${segment.id}`,
        sourceLabel: turn.speakerLabel,
        label: speakerLabelFor(turn.speakerLabel, speakerLabels),
        color: speakerColor(sourceIndex),
        startedAtMs: segment.startedAtMs,
        endedAtMs,
        durationMs,
        turnWords: wordCount(segment.text),
        turnContribution: segmentIndex === 0,
        leftPct: 0,
        widthPct: 0,
      };
    }),
  );

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
      existing.turns += Number(entry.turnContribution);
      existing.durationMs += entry.durationMs;
      existing.words += entry.turnWords;
      existing.hasSourceTiming ||= entry.endedAtMs !== null;
    } else {
      bySource.set(entry.sourceLabel, {
        sourceLabel: entry.sourceLabel,
        label: entry.label,
        color: entry.color,
        turns: Number(entry.turnContribution),
        durationMs: entry.durationMs,
        words: entry.turnWords,
        sharePct: 0,
        hasSourceTiming: entry.endedAtMs !== null,
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

function isReviewedSegment(segment: TranscriptSessionState['segments'][number]): boolean {
  return segment.status === 'revised' || typeof segment.reviewedAtMs === 'number';
}

function isReviewPendingSegment(
  session: TranscriptSessionState,
  segment: TranscriptSessionState['segments'][number],
): boolean {
  return Boolean(
    segment.text.trim() &&
    !isReviewedSegment(segment) &&
    !(session.lifecycle === 'recording' && isLiveDirectDraft(segment)),
  );
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
    { draft: 0, stabilizing: 0, final: 0, revised: 0, utterance: 0 },
  );
}

function transcriptWordTotal(session: TranscriptSessionState): number {
  return session.segments.reduce((total, segment) => total + wordCount(segment.text), 0);
}

function transcriptObservationEndMs(
  session: TranscriptSessionState,
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
): number | null {
  const candidates = [
    session.finishedAtMs,
    stream?.lastAudioAtMs,
    lastTranscriptAtMs,
    ...session.segments.map((segment) => segment.startedAtMs),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

function transcriptObservationSpanMs(
  session: TranscriptSessionState,
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
): number | null {
  if (typeof session.startedAtMs !== 'number' || !Number.isFinite(session.startedAtMs)) {
    return null;
  }
  const endMs = transcriptObservationEndMs(session, stream, lastTranscriptAtMs);
  if (endMs === null || endMs <= session.startedAtMs) {
    return null;
  }
  return endMs - session.startedAtMs;
}

function transcriptSegmentsPerMinute(segmentCount: number, spanMs: number | null): number | null {
  if (spanMs === null || spanMs < TRANSCRIPT_DENSITY_READY_MIN_MS) {
    return null;
  }
  return segmentCount / (spanMs / 60_000);
}

function transcriptWordsPerMinute(words: number, spanMs: number | null): number | null {
  if (spanMs === null || spanMs < TRANSCRIPT_DENSITY_READY_MIN_MS) {
    return null;
  }
  return words / (spanMs / 60_000);
}

function formatTranscriptDensity(value: number | null): string {
  if (value === null) {
    return 'Ölçüm başlıyor';
  }
  if (value >= 10) {
    return `${Math.round(value)} satır/dk`;
  }
  return `${value.toFixed(1)} satır/dk`;
}

function formatTranscriptWordRate(value: number | null): string {
  if (value === null) {
    return 'Ölçüm başlıyor';
  }
  if (value >= 10) {
    return `${Math.round(value)} kelime/dk`;
  }
  return `${value.toFixed(1)} kelime/dk`;
}

function transcriptFlowHealth(
  session: TranscriptSessionState,
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
  recordingActive: boolean,
): TranscriptFlowHealth {
  const sourceCounts = transcriptSourceCounts(session);
  const words = transcriptWordTotal(session);
  const spanMs = transcriptObservationSpanMs(session, stream, lastTranscriptAtMs);
  // Oranların paydası: ölçülebiliyorsa konuşulan süre; hiç zamanlama yoksa eski
  // kayıt penceresi; zamanlama kısmi ise oran gösterilmez (şişmiş sayı, gerçek
  // kapsam düşüklüğünü gizler).
  const speechSpan = transcriptSpeechSpan(session);
  const speechSpanMs = speechSpan.kind === 'measured' ? speechSpan.ms : null;
  const rateSpanMs =
    speechSpan.kind === 'measured' ? speechSpan.ms : speechSpan.kind === 'absent' ? spanMs : null;
  const segmentsPerMinute = transcriptSegmentsPerMinute(session.segments.length, rateSpanMs);
  const wordsPerMinute = transcriptWordsPerMinute(words, rateSpanMs);
  const lagMs = streamLagMs(stream, lastTranscriptAtMs, recordingActive);
  const coverageWindowActive = Boolean(
    recordingActive &&
    session.segments.length > 0 &&
    (stream?.audioActive ||
      stream?.directActive ||
      stream?.directReady ||
      stream?.directConfigured),
  );

  if (!recordingActive) {
    return {
      label: session.segments.length > 0 ? 'Kayıt dışı' : 'Akış bekleniyor',
      detail:
        session.segments.length > 0
          ? 'Kayıt aktif değil; mevcut satırlar incelenebilir.'
          : 'Kayıt başlayınca ses ve metin akışı izlenir.',
      nextAction:
        session.segments.length > 0
          ? 'Mevcut satırları inceleyin veya toplantı çıktısı üretimine geçin.'
          : 'Kayıt başlatılınca akış kalitesi otomatik ölçülür.',
      level: 'idle',
      risk: 'none',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  if (stream?.directStatus?.status === 'error' || stream?.directStatus?.status === 'closed') {
    const gatewayLive = stream.mode === 'gateway-live';
    return {
      label: 'Bağlantı hatası',
      detail: gatewayLive
        ? 'Yetkili Gateway canlı akışı kapandı veya hata verdi; kalıcı ses gönderimi ve tanı kaydı kontrol edilmeli.'
        : 'Direct stream kapalı veya hata verdi; gateway fallback ve tanı snapshotı kontrol edilmeli.',
      nextAction: gatewayLive
        ? 'Tanıyı kopyalayın; Gateway oturum yetkisi, bağlantı ve kalıcı ses gönderimi kayıtlarını eşleştirin.'
        : 'Tanıyı kopyalayın; direct STT URL, sertifika ve gateway fallback loglarını eşleştirin.',
      level: 'warn',
      risk: 'connection_error',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  if (stream?.audioActive && session.segments.length === 0) {
    return {
      label: 'Ses var, metin yok',
      detail: 'Mikrofon sesi görülüyor ancak henüz transcript satırı alınmadı.',
      nextAction:
        stream?.mode === 'gateway-live'
          ? 'Mikrofon girişini ve Gateway canlı bağlantısını kontrol edin; durum sürerse tanıyı kopyalayın.'
          : 'Mikrofon girişini ve direct STT bağlantısını kontrol edin; durum sürerse tanıyı kopyalayın.',
      level: 'warn',
      risk: 'no_text',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  if (lagMs !== null && lagMs >= TRANSCRIPT_LAG_WARN_MS) {
    return {
      label: 'Metin gecikiyor',
      detail: 'Ses zamanı metinden önde; stream backlog, ağ veya model kuyruğu kontrol edilmeli.',
      nextAction:
        'Tanıyı kopyalayın; direct STT backlog, ağ gecikmesi ve model kuyruğu metrikleriyle karşılaştırın.',
      level: 'warn',
      risk: 'lagging',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  // Kapsam hükmü yeterli konuşma biriktikten sonra verilir: konuşulan süre
  // ölçülebiliyorsa onun üzerinden, ölçülemiyorsa eski kayıt penceresinden.
  const coverageWindowReady =
    speechSpan.kind === 'measured'
      ? speechSpan.ms >= TRANSCRIPT_SPEECH_WINDOW_MIN_MS
      : speechSpan.kind === 'absent' &&
        spanMs !== null &&
        spanMs >= TRANSCRIPT_LOW_WORD_RATE_WARN_MS;

  if (
    coverageWindowActive &&
    coverageWindowReady &&
    wordsPerMinute !== null &&
    wordsPerMinute < TRANSCRIPT_LOW_WORDS_PER_MINUTE
  ) {
    return {
      label: 'Metin kapsamı düşük',
      detail:
        'Kayıt penceresine göre kelime üretim hızı düşük; konuşmanın önemli kısmı transcript akışına düşmüyor olabilir.',
      nextAction:
        'Tanıyı kopyalayın; kaynak kalite gate’i bu transcripti review’da tutar, çıktı üretimi öncesi mikrofon/direct STT zinciri doğrulanmalı.',
      level: 'warn',
      risk: 'low_word_coverage',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  // Satır yoğunluğu da aynı paydayı kullanır: sessizlik seyreklik sayılmaz.
  const densityWindowReady =
    speechSpan.kind === 'measured'
      ? speechSpan.ms >= TRANSCRIPT_SPEECH_WINDOW_MIN_MS
      : speechSpan.kind === 'absent' && spanMs !== null && spanMs >= TRANSCRIPT_LOW_DENSITY_WARN_MS;

  if (
    stream?.audioActive &&
    densityWindowReady &&
    segmentsPerMinute !== null &&
    segmentsPerMinute < TRANSCRIPT_LOW_DENSITY_SEGMENTS_PER_MINUTE
  ) {
    return {
      label: 'Metin seyrek',
      detail:
        'Ses var ama satır yoğunluğu düşük; mikrofon seçimi ve direct stream teslimi kontrol edilmeli.',
      nextAction:
        'Mikrofon seçimi, capture worklet ve direct stream teslim aralığını kontrol edin.',
      level: 'watch',
      risk: 'low_segment_density',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  if ((stream?.audioActive || stream?.directActive) && session.segments.length > 0) {
    return {
      label: 'Akış takipte',
      detail: 'Ses ve transcript zamanı birlikte ilerliyor.',
      nextAction: 'Kayıt sonrası toplantı çıktısını kaynak kanıtıyla review’a alın.',
      level: 'ok',
      risk: 'none',
      words,
      spanMs,
      speechSpanMs,
      rateBasis: speechSpan.kind,
      segmentsPerMinute,
      wordsPerMinute,
      directCount: sourceCounts.direct,
      gatewayCount: sourceCounts.gateway,
    };
  }

  return {
    label: 'Ses bekleniyor',
    detail:
      session.segments.length > 0
        ? 'Transcript var; yeni ses sinyali bekleniyor.'
        : 'Mikrofon sinyali bekleniyor.',
    nextAction:
      session.segments.length > 0
        ? 'Yeni konuşma bekleniyor; mevcut satırlar korunur.'
        : 'Mikrofon girişini ve kayıt kaynağını kontrol edin.',
    level: 'watch',
    risk: 'waiting_audio',
    words,
    spanMs,
    speechSpanMs,
    rateBasis: speechSpan.kind,
    segmentsPerMinute,
    wordsPerMinute,
    directCount: sourceCounts.direct,
    gatewayCount: sourceCounts.gateway,
  };
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
  session: TranscriptSessionState,
  segment: TranscriptSessionState['segments'][number],
  filter: TranscriptFilter,
): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'review-pending') {
    return isReviewPendingSegment(session, segment);
  }
  if (filter === 'reviewed') {
    return isReviewedSegment(segment);
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
    isReviewedSegment(segment) ? 'İncelendi' : '',
  ]
    .join(' ')
    .toLocaleLowerCase('tr-TR');

  return haystack.includes(query);
}

function transcriptReviewSummary(session: TranscriptSessionState, visibleCount: number): string {
  const statusCounts = transcriptStatusCounts(session);
  const sourceCounts = transcriptSourceCounts(session);
  const reviewedCount = session.segments.filter(isReviewedSegment).length;
  const reviewPendingCount = session.segments.filter((segment) =>
    isReviewPendingSegment(session, segment),
  ).length;
  return [
    `Görünen ${visibleCount}/${session.segments.length}`,
    `Final ${statusCounts.final}`,
    `Revize ${statusCounts.revised}`,
    `İncelenen ${reviewedCount}`,
    `Kontrol bekleyen ${reviewPendingCount}`,
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
  const health = transcriptFlowHealth(session, stream, lastTranscriptAtMs, recordingActive);

  return [
    'meeting-intelligence.transcript.diagnostics.v1',
    `generatedAt=${new Date().toISOString()}`,
    `lifecycle=${session.lifecycle}`,
    `meetingId=${session.meetingId ?? '-'}`,
    `sessionId=${session.sessionId ?? '-'}`,
    `gatewaySessionId=${session.gatewaySessionId ?? '-'}`,
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
    `flow.health=${health.label}`,
    `flow.risk=${health.risk}`,
    `flow.nextAction=${health.nextAction}`,
    `flow.segmentDensityPerMinute=${formatDiagnosticNumber(health.segmentsPerMinute, 2)}`,
    `flow.wordsPerMinute=${formatDiagnosticNumber(health.wordsPerMinute, 2)}`,
    `flow.rateBasis=${health.rateBasis === 'absent' ? 'recording-window' : health.rateBasis}`,
    `flow.speechSpanMs=${health.speechSpanMs ?? '-'}`,
    `segments.total=${session.segments.length}`,
    `segments.draft=${statusCounts.draft}`,
    `segments.stabilizing=${statusCounts.stabilizing}`,
    `segments.final=${statusCounts.final}`,
    `segments.revised=${statusCounts.revised}`,
    `segments.reviewed=${session.segments.filter(isReviewedSegment).length}`,
    `segments.reviewPending=${
      session.segments.filter((segment) => isReviewPendingSegment(session, segment)).length
    }`,
    `segments.direct=${sourceCounts.direct}`,
    `segments.gateway=${sourceCounts.gateway}`,
    `segments.unknown=${sourceCounts.unknown}`,
    `words.total=${health.words}`,
    `errorPresent=${Boolean(session.error)}`,
  ].join('\n');
}

export function TranscriptPanel({
  session,
  stream,
  onSegmentTextChange,
  onSegmentReviewed,
}: TranscriptPanelProps): ReactElement {
  const hasSegments = session.segments.length > 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoFollowLatestRef = useRef(true);
  const turnHistoryRef = useRef<{ sessionKey: string; turns: TranscriptTurn[] }>({
    sessionKey: '',
    turns: [],
  });
  const [diagnosticMessage, setDiagnosticMessage] = useState('');
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segmentTextDrafts, setSegmentTextDrafts] = useState<Record<string, string>>({});
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [transcriptFilter, setTranscriptFilter] = useState<TranscriptFilter>('all');
  // Akıcı görünüm default (gitops#3419): kelime-kelime canlı akış + cümle
  // sınırına kadar tek paragraf. 'rows' = mevcut satır-inceleme kartları
  // (düzeltme/İncelendi aksiyonları orada yaşamaya devam eder).
  const [transcriptView, setTranscriptView] = useState<'fluent' | 'rows'>('fluent');
  const normalizedTranscriptQuery = normalizeTranscriptQuery(transcriptQuery);
  const transcriptSessionKey = [
    session.gatewaySessionId ?? '',
    session.meetingId ?? '',
    session.sessionId ?? '',
  ].join(':');
  const transcriptTurns = useMemo(() => {
    const grouped = buildTranscriptTurns(session.segments);
    const previousTurns =
      turnHistoryRef.current.sessionKey === transcriptSessionKey
        ? turnHistoryRef.current.turns
        : [];
    return reconcileTranscriptTurnIds(previousTurns, grouped);
  }, [session.segments, transcriptSessionKey]);
  useEffect(() => {
    turnHistoryRef.current = { sessionKey: transcriptSessionKey, turns: transcriptTurns };
  }, [transcriptSessionKey, transcriptTurns]);
  const filteredTurns = useMemo(
    () =>
      transcriptTurns
        .map((turn) => {
          const visibleSegments = turn.segments.filter(
            (segment) =>
              matchesTranscriptFilter(session, segment, transcriptFilter) &&
              matchesTranscriptQuery(segment, normalizedTranscriptQuery, speakerLabels),
          );
          return {
            ...turn,
            segments: visibleSegments,
            hiddenSegmentCount: turn.segments.length - visibleSegments.length,
          };
        })
        .filter((turn) => turn.segments.length > 0),
    [normalizedTranscriptQuery, session, speakerLabels, transcriptFilter, transcriptTurns],
  );
  const filteredSegmentCount = filteredTurns.reduce(
    (count, turn) => count + turn.segments.length,
    0,
  );
  const visibleContentRevision = filteredTurns
    .flatMap((turn) =>
      turn.segments.map(
        (segment) =>
          `${turn.id}:${segment.id}:${segment.status}:${segment.text}:${segment.receivedAtMs ?? ''}`,
      ),
    )
    .join('|');
  const speakerTimeline = useMemo(
    () => buildSpeakerTimeline(session, speakerLabels, transcriptTurns),
    [session, speakerLabels, transcriptTurns],
  );
  const hasReliableSpeakerTiming = speakerTimeline.some((entry) => entry.endedAtMs !== null);
  const speakerSummaries = buildSpeakerSummaries(speakerTimeline);
  const sourceTimedSpeakerTimeline = speakerTimeline.filter((entry) => entry.endedAtMs !== null);
  const interruptionSignals = buildInterruptionSignals(sourceTimedSpeakerTimeline);
  const hasSpeakerOverrides = Object.entries(speakerLabels).some(
    ([sourceLabel, label]) => label.trim() && label.trim() !== sourceLabel,
  );
  const lastTranscriptAtMs = latestTranscriptReceivedAtMs(session);
  const recordingActive = session.lifecycle === 'recording';
  const lagClass = transcriptLagClass(stream, lastTranscriptAtMs, recordingActive);
  const flowHealth = transcriptFlowHealth(session, stream, lastTranscriptAtMs, recordingActive);
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

  const handleTranscriptScroll = (): void => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const distanceFromLatest = list.scrollHeight - list.scrollTop - list.clientHeight;
    autoFollowLatestRef.current = distanceFromLatest <= 48;
  };

  useEffect(() => {
    setSpeakerLabels({});
    setEditingSegmentId(null);
    setSegmentTextDrafts({});
    setTranscriptQuery('');
    setTranscriptFilter('all');
    autoFollowLatestRef.current = true;
  }, [session.gatewaySessionId, session.meetingId, session.sessionId]);

  useLayoutEffect(() => {
    if (!visibleContentRevision || !autoFollowLatestRef.current) {
      return;
    }
    const list = listRef.current;
    if (list) {
      list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    }
  }, [visibleContentRevision]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (autoFollowLatestRef.current) {
        list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      }
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="transcript-panel" aria-labelledby="transcript-title">
      <div className="panel-header">
        <div>
          <h2 id="transcript-title">Canlı Transkript</h2>
          <p className="panel-subtitle">
            {(session.sessionId ?? session.gatewaySessionId)
              ? `Oturum ${session.sessionId ?? session.gatewaySessionId}`
              : 'Recorder oturumu yok'}
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

      <div
        className={`transcript-flow-health transcript-flow-${flowHealth.level}`}
        aria-label="Transkript akış kalitesi"
      >
        <div>
          <span>Sinyal</span>
          <strong>{flowHealth.label}</strong>
        </div>
        <div>
          <span>Yoğunluk</span>
          <strong>
            {flowHealth.rateBasis === 'unmeasurable'
              ? 'Ölçülemiyor'
              : formatTranscriptDensity(flowHealth.segmentsPerMinute)}
          </strong>
        </div>
        <div>
          <span>Kelime</span>
          <strong>{flowHealth.words}</strong>
        </div>
        <div>
          <span>Kelime/dk</span>
          <strong>
            {flowHealth.rateBasis === 'unmeasurable'
              ? 'Ölçülemiyor'
              : formatTranscriptWordRate(flowHealth.wordsPerMinute)}
          </strong>
        </div>
        <div>
          <span>Kaynak</span>
          <strong>
            Direct {flowHealth.directCount} / Gateway {flowHealth.gatewayCount}
          </strong>
        </div>
        <p>{flowHealth.detail}</p>
        <p className="flow-next-action">
          <span>Sonraki aksiyon</span>
          <strong>{flowHealth.nextAction}</strong>
        </p>
      </div>

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
            {hasReliableSpeakerTiming ? (
              <div
                className="speaker-distribution-chart"
                aria-label="Konuşma dağılımı pasta grafiği"
                style={{ background: speakerDistributionGradient(speakerSummaries) }}
              />
            ) : null}
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
                      {speaker.hasSourceTiming
                        ? `${Math.round(speaker.sharePct)}% · ${speaker.turns} tur · ${formatSpeakerDuration(speaker.durationMs)}`
                        : `${speaker.turns} tur · kaynak zamanlaması bekleniyor`}
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

          {hasReliableSpeakerTiming ? (
            <div className="speaker-timeline" role="img" aria-label="Konuşmacı zaman çizgisi">
              {sourceTimedSpeakerTimeline.map((entry) => (
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
          ) : (
            <p className="speaker-timing-unavailable" role="status">
              Konuşmacı süreleri ve söz kesme sinyali için kaynak zamanlaması bekleniyor.
            </p>
          )}

          <div className="speaker-interruptions" aria-live="polite">
            <strong>Söz kesme sinyali</strong>
            {!hasReliableSpeakerTiming ? (
              <span>Kaynak zamanlaması olmadan overlap sonucu üretilmez.</span>
            ) : interruptionSignals.length > 0 ? (
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
          <div
            className="transcript-view-toggle"
            role="group"
            aria-label="Transkript görünümü"
            data-testid="transcript-view-toggle"
          >
            <button
              className={`transcript-filter-button${
                transcriptView === 'fluent' ? ' transcript-filter-button-active' : ''
              }`}
              type="button"
              aria-pressed={transcriptView === 'fluent'}
              onClick={() => setTranscriptView('fluent')}
            >
              Akıcı
            </button>
            <button
              className={`transcript-filter-button${
                transcriptView === 'rows' ? ' transcript-filter-button-active' : ''
              }`}
              type="button"
              aria-pressed={transcriptView === 'rows'}
              onClick={() => setTranscriptView('rows')}
            >
              Satırlar
            </button>
          </div>
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
            {transcriptReviewSummary(session, filteredSegmentCount)}
          </p>
        </section>
      ) : null}

      <div
        className="transcript-list"
        aria-live="polite"
        ref={listRef}
        onScroll={handleTranscriptScroll}
      >
        {hasSegments && filteredTurns.length > 0 ? (
          filteredTurns.map((turn) => {
            const turnIsLive = turn.segments.some(isLiveDirectDraft);
            const turnStatus = transcriptTurnStatus(turn.segments);

            return (
              <article
                className={`transcript-segment segment-${turnStatus}${
                  turnIsLive ? ' segment-live' : ''
                }`}
                key={turn.id}
              >
                <div className="segment-meta transcript-turn-meta">
                  <span>{speakerLabelFor(turn.speakerLabel, speakerLabels)}</span>
                  {turn.segments.length > 1 || turn.hiddenSegmentCount > 0 ? (
                    <span>{turn.segments.length} paragraf</span>
                  ) : null}
                  {turn.hiddenSegmentCount > 0 ? (
                    <span>{turn.hiddenSegmentCount} filtrelenmiş paragraf</span>
                  ) : null}
                </div>
                <div className="transcript-turn-body">
                  {transcriptView === 'fluent'
                    ? (() => {
                        const flow = buildTurnFlow(turn.segments);
                        const tail = flow.tailText ? (
                          <span className="turn-flow-tail" data-testid="turn-flow-tail">
                            {flow.paragraphs.length > 0 ? ' ' : ''}
                            <TypewriterText text={flow.tailText} />
                            <span className="live-caret" aria-hidden="true">
                              |
                            </span>
                          </span>
                        ) : null;
                        return (
                          <div className="turn-flow" data-testid="turn-flow">
                            {flow.paragraphs.map((paragraph, index) => (
                              <p
                                className={`turn-flow-paragraph${
                                  paragraph.pending ? ' turn-flow-pending' : ''
                                }`}
                                key={paragraph.id}
                              >
                                {paragraph.text}
                                {index === flow.paragraphs.length - 1 ? tail : null}
                              </p>
                            ))}
                            {flow.paragraphs.length === 0 && tail ? (
                              <p className="turn-flow-paragraph">{tail}</p>
                            ) : null}
                          </div>
                        );
                      })()
                    : turn.segments.map((segment) => {
                        const metricLabel = segmentMetricLabel(segment);
                        const liveDirectDraft = isLiveDirectDraft(segment);
                        const reviewedSegment = isReviewedSegment(segment);
                        const editableSegment = Boolean(onSegmentTextChange) && !liveDirectDraft;
                        const canMarkReviewed =
                          Boolean(onSegmentReviewed) && !liveDirectDraft && !reviewedSegment;
                        const editingSegment = editingSegmentId === segment.id;
                        const segmentDraftText = segmentTextDrafts[segment.id] ?? segment.text;
                        const reviewedText = segmentDraftText.trim();
                        const reviewChanged = reviewedText !== segment.text.trim();

                        return (
                          <div
                            className={`transcript-turn-paragraph transcript-paragraph-status-${segment.status}`}
                            key={segment.id}
                          >
                            <div className="segment-meta transcript-turn-paragraph-meta">
                              <time dateTime={new Date(segment.startedAtMs).toISOString()}>
                                {formatClock(segment.startedAtMs)}
                              </time>
                              <span>{transcriptStatusLabel(segment.status)}</span>
                              <span>{segmentSourceLabel(segment.source)}</span>
                              {metricLabel ? <span>{metricLabel}</span> : null}
                              {reviewedSegment ? <span>İncelendi</span> : null}
                              {liveDirectDraft ? <span>Canlı</span> : null}
                            </div>
                            {editingSegment ? (
                              <div className="segment-editor">
                                <label htmlFor={`segment-editor-${segment.id}`}>
                                  Transkript metni
                                </label>
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
                                {editableSegment || canMarkReviewed ? (
                                  <div className="segment-actions">
                                    {canMarkReviewed ? (
                                      <button
                                        className="secondary-action compact-action segment-review-action"
                                        type="button"
                                        onClick={() => onSegmentReviewed?.(segment.id)}
                                      >
                                        İncelendi
                                      </button>
                                    ) : null}
                                    {editableSegment ? (
                                      <button
                                        className="secondary-action compact-action segment-review-action"
                                        type="button"
                                        onClick={() => beginSegmentReview(segment.id, segment.text)}
                                      >
                                        Metni düzelt
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                        );
                      })}
                </div>
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
