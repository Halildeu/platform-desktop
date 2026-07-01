import { useEffect, useRef, type ReactElement } from 'react';

import {
  lifecycleLabel,
  transcriptStatusLabel,
  type TranscriptSessionState,
} from '../transcript/session-transcript';
import type { LiveSttStreamStatusEvent } from '../audio/live-stt-stream';

const TRANSCRIPT_LAG_WARN_MS = 5_000;

export interface TranscriptPanelProps {
  session: TranscriptSessionState;
  stream?: {
    directConfigured: boolean;
    directReady?: boolean;
    directStatus?: LiveSttStreamStatusEvent | null;
    directActive: boolean;
    audioRms?: number | null;
    audioActive?: boolean;
    lastAudioAtMs?: number | null;
    disabledReason: string | null;
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

function streamModeLabel(stream: TranscriptPanelProps['stream']): string {
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
): number | null {
  if (
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
): string {
  if (
    !stream?.directConfigured ||
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
): string {
  const lagMs = streamLagMs(stream, lastTranscriptAtMs);
  return lagMs !== null && lagMs >= TRANSCRIPT_LAG_WARN_MS ? 'stream-lag-warning' : '';
}

function streamModeDetail(
  stream: TranscriptPanelProps['stream'],
  lastTranscriptAtMs: number | null,
): string {
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
    const lagMs = streamLagMs(stream, lastTranscriptAtMs);
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

function isLiveDirectDraft(segment: TranscriptSessionState['segments'][number]): boolean {
  return segment.source === 'direct-stream' && segment.status === 'draft';
}

export function TranscriptPanel({ session, stream }: TranscriptPanelProps): ReactElement {
  const hasSegments = session.segments.length > 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const visibleSegments = [...session.segments].reverse();
  const lastTranscriptAtMs = latestTranscriptReceivedAtMs(session);
  const lagClass = transcriptLagClass(stream, lastTranscriptAtMs);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [session.segments]);

  return (
    <section className="transcript-panel" aria-labelledby="transcript-title">
      <div className="panel-header">
        <div>
          <h2 id="transcript-title">Canlı Transkript</h2>
          <p className="panel-subtitle">
            {session.sessionId ? `Oturum ${session.sessionId}` : 'Recorder oturumu yok'}
          </p>
        </div>
        <span className={`state-pill state-${session.lifecycle}`}>
          {lifecycleLabel(session.lifecycle)}
        </span>
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
          <strong>{streamModeLabel(stream)}</strong>
        </div>
        <div>
          <span>Durum</span>
          <strong>{streamModeDetail(stream, lastTranscriptAtMs)}</strong>
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
          <span>Gecikme</span>
          <strong className={lagClass}>{transcriptLagLabel(stream, lastTranscriptAtMs)}</strong>
        </div>
      </div>

      {session.error ? <p className="inline-error">{session.error}</p> : null}

      <div className="transcript-list" aria-live="polite" ref={listRef}>
        {hasSegments ? (
          visibleSegments.map((segment) => {
            const metricLabel = segmentMetricLabel(segment);
            const liveDirectDraft = isLiveDirectDraft(segment);

            return (
              <article
                className={`transcript-segment segment-${segment.status}${
                  liveDirectDraft ? ' segment-live' : ''
                }`}
                key={segment.id}
              >
                <div className="segment-meta">
                  <span>{segment.speakerLabel}</span>
                  <time dateTime={new Date(segment.startedAtMs).toISOString()}>
                    {formatClock(segment.startedAtMs)}
                  </time>
                  <span>{transcriptStatusLabel(segment.status)}</span>
                  <span>{segmentSourceLabel(segment.source)}</span>
                  {metricLabel ? <span>{metricLabel}</span> : null}
                  {liveDirectDraft ? <span>Canlı</span> : null}
                </div>
                <p>
                  {segment.text}
                  {liveDirectDraft ? (
                    <span className="live-caret" aria-hidden="true">
                      |
                    </span>
                  ) : null}
                </p>
              </article>
            );
          })
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
