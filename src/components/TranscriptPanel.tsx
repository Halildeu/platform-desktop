import { useEffect, useRef, type ReactElement } from 'react';

import {
  lifecycleLabel,
  transcriptStatusLabel,
  type TranscriptSessionState,
} from '../transcript/session-transcript';

export interface TranscriptPanelProps {
  session: TranscriptSessionState;
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

export function TranscriptPanel({ session }: TranscriptPanelProps): ReactElement {
  const hasSegments = session.segments.length > 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const visibleSegments = [...session.segments].reverse();

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

      {session.error ? <p className="inline-error">{session.error}</p> : null}

      <div className="transcript-list" aria-live="polite" ref={listRef}>
        {hasSegments ? (
          visibleSegments.map((segment) => (
            <article className={`transcript-segment segment-${segment.status}`} key={segment.id}>
              <div className="segment-meta">
                <span>{segment.speakerLabel}</span>
                <time dateTime={new Date(segment.startedAtMs).toISOString()}>
                  {formatClock(segment.startedAtMs)}
                </time>
                <span>{transcriptStatusLabel(segment.status)}</span>
              </div>
              <p>{segment.text}</p>
            </article>
          ))
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
