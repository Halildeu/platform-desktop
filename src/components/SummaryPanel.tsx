import { useState, type ReactElement } from 'react';

import { CONSENT_LOCALE, CONSENT_TEXT_HASH, CONSENT_VERSION } from './ConsentDialog';
import {
  actionStatusLabel,
  buildIntelligenceExport,
  decisionStatusLabel,
  formatCitationTime,
  intelligenceStatusLabel,
  type IntelligenceCitation,
  type MeetingIntelligenceResult,
  type MeetingIntelligenceState,
  setMeetingIntelligenceResult,
} from '../intelligence/meeting-intelligence';
import {
  meetingAiResultFromAnalyzeResponse,
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
}

export interface MeetingAiSubmitAdapter {
  analyze(payload: MeetingAiSubmitPayload): Promise<MeetingAiAnalyzeResponse>;
}

export interface SummaryPanelProps {
  intelligence: MeetingIntelligenceState;
  transcript?: TranscriptSessionState;
  exportAdapter?: ExportAdapter;
  meetingAiSubmitAdapter?: MeetingAiSubmitAdapter;
  onMeetingAiResult?: (result: MeetingIntelligenceResult) => void;
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

export function SummaryPanel({
  intelligence,
  transcript,
  exportAdapter = browserExportAdapter,
  meetingAiSubmitAdapter = electronMeetingAiSubmitAdapter,
  onMeetingAiResult,
  onMeetingAiError,
}: SummaryPanelProps): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const [localSubmittedResult, setLocalSubmittedResult] = useState<{
    meetingId: string | null;
    sessionId: string | null;
    result: MeetingIntelligenceResult;
  } | null>(null);
  const [isSubmittingMeetingAi, setIsSubmittingMeetingAi] = useState(false);
  const transcriptSourceSegments = transcriptSegments(transcript);
  const hasTranscriptSource = transcriptSourceSegments.length > 0;
  const transcriptReadiness = transcript
    ? analyzeTranscriptSourceReadiness(transcript)
    : analyzeTranscriptSourceReadiness(initialTranscriptSessionFallback);
  const meetingAiGate = transcript
    ? buildMeetingAiSourceGate(transcript, transcriptReadiness)
    : buildMeetingAiSourceGate(initialTranscriptSessionFallback, transcriptReadiness);
  const latestTranscriptSegment =
    transcriptSourceSegments.length > 0
      ? transcriptSourceSegments[transcriptSourceSegments.length - 1]
      : null;
  const visibleIntelligence = localSubmittedResult
    ? setMeetingIntelligenceResult(
        {
          ...intelligence,
          meetingId: localSubmittedResult.meetingId,
          sessionId: localSubmittedResult.sessionId,
        },
        localSubmittedResult.result,
      )
    : intelligence;
  const result = visibleIntelligence.status === 'ready' ? visibleIntelligence.result : null;

  const runExport = async (kind: 'copy' | 'markdown' | 'csv' | 'print'): Promise<void> => {
    setMessage(null);
    try {
      const bundle = buildIntelligenceExport(visibleIntelligence);
      if (kind === 'copy') {
        await exportAdapter.copyText(bundle.markdown);
        setMessage('Markdown panoya kopyalandı.');
      } else if (kind === 'markdown') {
        exportAdapter.downloadText(bundle.markdownFileName, bundle.markdown, 'text/markdown');
        setMessage('Markdown indirildi.');
      } else if (kind === 'csv') {
        exportAdapter.downloadText(bundle.csvFileName, bundle.csv, 'text/csv');
        setMessage('CSV indirildi.');
      } else {
        exportAdapter.print();
        setMessage('PDF için yazdırma penceresi açıldı.');
      }
    } catch (error) {
      setMessage(`Export hazır değil: ${(error as Error).message}`);
    }
  };

  const runTranscriptExport = async (kind: 'copy' | 'markdown' | 'text'): Promise<void> => {
    setMessage(null);
    try {
      if (!transcript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildTranscriptSourceExport(transcript);
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
      if (!transcript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildMeetingAiSourcePackage(transcript, Date.now(), {
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

  const runMeetingAiSubmit = async (): Promise<void> => {
    setMessage(null);
    setIsSubmittingMeetingAi(true);
    try {
      if (!transcript) {
        throw new Error('Transcript source is not ready');
      }
      const bundle = buildMeetingAiSourcePackage(transcript, Date.now(), {
        consentVersion: CONSENT_VERSION,
        consentTextHash: CONSENT_TEXT_HASH,
        consentLocale: CONSENT_LOCALE,
      });
      if (!bundle.package.gate.can_submit || !bundle.package.meeting_id) {
        throw new Error(
          bundle.package.gate.blocked_by.join(', ') || 'Meeting AI kapısı hazır değil',
        );
      }
      const response = await meetingAiSubmitAdapter.analyze({
        meetingId: bundle.package.meeting_id,
        request: bundle.package.request,
      });
      const submittedResult = meetingAiResultFromAnalyzeResponse(response);
      setLocalSubmittedResult({
        meetingId: bundle.package.meeting_id,
        sessionId: bundle.package.session_id,
        result: submittedResult,
      });
      onMeetingAiResult?.(submittedResult);
      setMessage('Meeting AI sonucu alındı.');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      onMeetingAiError?.(text);
      setMessage(`Meeting AI gönderimi hazır değil: ${text}`);
    } finally {
      setIsSubmittingMeetingAi(false);
    }
  };

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
        <span className={`state-pill state-${visibleIntelligence.status}`}>
          {intelligenceStatusLabel(visibleIntelligence.status)}
        </span>
      </div>

      {visibleIntelligence.error ? (
        <p className="inline-error">{visibleIntelligence.error}</p>
      ) : null}

      {result ? (
        <>
          <div className="summary-toolbar" aria-label="Çıktı araçları">
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
              onClick={() => void runExport('print')}
            >
              PDF
            </button>
          </div>
          {message ? <p className="export-message">{message}</p> : null}
          <div className="summary-content">
            <article className="summary-section">
              <h3>Özet</h3>
              <p>{result.summaryMarkdown}</p>
            </article>

            <article className="summary-section">
              <h3>Kararlar</h3>
              {result.decisions.length > 0 ? (
                <ul className="decision-list">
                  {result.decisions.map((decision) => (
                    <li key={decision.id}>
                      <strong>{decision.title}</strong>
                      <span>{decisionStatusLabel(decision.status)}</span>
                      <small>{formatCitations(decision.citations)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-line">Karar yok.</p>
              )}
            </article>

            <article className="summary-section">
              <h3>Aksiyonlar</h3>
              {result.actionItems.length > 0 ? (
                <div className="action-table" role="table" aria-label="Aksiyonlar">
                  <div className="action-row action-row-head" role="row">
                    <span role="columnheader">Aksiyon</span>
                    <span role="columnheader">Sahip</span>
                    <span role="columnheader">Tarih</span>
                    <span role="columnheader">Durum</span>
                    <span role="columnheader">Kaynak</span>
                  </div>
                  {result.actionItems.map((item) => (
                    <div className="action-row" role="row" key={item.id}>
                      <span role="cell">{item.title}</span>
                      <span role="cell">{item.assignee ?? '-'}</span>
                      <span role="cell">{item.dueDate ?? '-'}</span>
                      <span role="cell">{actionStatusLabel(item.status)}</span>
                      <span role="cell">{formatCitations(item.citations)}</span>
                    </div>
                  ))}
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
                  <span>Süre</span>
                  <strong>{formatDurationMs(transcriptReadiness.durationMs)}</strong>
                </div>
                <div>
                  <span>Final oranı</span>
                  <strong>{formatPercent(transcriptReadiness.finalRatio)}</strong>
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
        <div className="summary-empty">
          <strong>Toplantı çıktısı bekleniyor</strong>
          <span>{emptyStateText(visibleIntelligence.status)}</span>
        </div>
      )}
    </section>
  );
}

const initialTranscriptSessionFallback: TranscriptSessionState = {
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

function formatCitations(citations: IntelligenceCitation[]): string {
  if (citations.length === 0) {
    return '-';
  }
  return citations.map(formatCitationTime).join(', ');
}

function emptyStateText(status: MeetingIntelligenceState['status']): string {
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
