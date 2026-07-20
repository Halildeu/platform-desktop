/**
 * Faz 24 İ3 — live-analysis viewer panel.
 *
 * Renders the latest partial/final analysis published by meeting-ai's
 * `/analyze/live/stream/{meetingId}` SSE relay. Consumers pass a
 * `meetingId` when the meeting is active; the panel handles
 * subscribe/teardown via `useLiveAnalysis`.
 *
 * Design notes:
 *   - The panel is INTENTIONALLY read-only. `is_partial=true` marks live
 *     content with a subtle badge so users know a later delivery may
 *     supersede; the analyzer's canonical final result still comes via the
 *     durable /analyze path (see `SummaryPanel` for the final view).
 *   - No decision/action shape polishing here — we render the raw fields
 *     from the analyzer response so a schema drift becomes visible instead
 *     of being silently coerced. Advanced formatting (badges, owner chips,
 *     citations) is a follow-up slice once the wire is proven end-to-end.
 *   - Status bar surfaces connecting/open/closed/error so a broken relay
 *     is diagnosable in-app without console spelunking.
 */

import type { FC, JSX } from 'react';

import {
  useLiveAnalysis,
  type LiveAnalysisApi,
  type LiveAnalysisPayload,
  type LiveAnalysisStatus,
} from '../intelligence/use-live-analysis';

export interface LiveAnalysisPanelProps {
  meetingId: string | null;
  /** Optional injection point for tests. Defaults to `window.electronAPI.meeting`. */
  api?: LiveAnalysisApi;
}

function statusLabel(status: LiveAnalysisStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Bekleniyor';
    case 'connecting':
      return `Bağlanıyor (deneme ${status.attempt})`;
    case 'open':
      return 'Canlı';
    case 'closed':
      return `Kapatıldı${status.reason ? ` — ${status.reason}` : ''}`;
    case 'error':
      return `Hata — ${status.error}`;
  }
}

function statusModifier(status: LiveAnalysisStatus): string {
  switch (status.kind) {
    case 'open':
      return 'is-open';
    case 'error':
      return 'is-error';
    case 'closed':
      return 'is-closed';
    default:
      return 'is-idle';
  }
}

function renderList(items: unknown[] | undefined, label: string): JSX.Element | null {
  if (!items || !items.length) return null;
  return (
    <section className="live-analysis-panel__section">
      <h4 className="live-analysis-panel__section-title">{label}</h4>
      <ul className="live-analysis-panel__list">
        {items.map((item, i) => (
          <li key={i} className="live-analysis-panel__item">
            {typeof item === 'string'
              ? item
              : typeof item === 'object' && item !== null && 'text' in item
                ? String((item as { text: unknown }).text ?? '')
                : JSON.stringify(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export const LiveAnalysisPanel: FC<LiveAnalysisPanelProps> = ({ meetingId, api }) => {
  const { latest, status } = useLiveAnalysis(meetingId, api);
  const payload: LiveAnalysisPayload | null = latest?.payload ?? null;
  const isPartial = payload?.is_partial === true;

  return (
    <section className="live-analysis-panel" aria-live="polite" aria-label="Canlı toplantı analizi">
      <header className="live-analysis-panel__header">
        <h3 className="live-analysis-panel__title">Canlı Analiz</h3>
        <span
          className={`live-analysis-panel__status live-analysis-panel__status--${statusModifier(status)}`}
          data-status={status.kind}
        >
          {statusLabel(status)}
        </span>
      </header>

      {!meetingId ? (
        <p className="live-analysis-panel__empty">
          Aktif toplantı yok. Kayıt başladığında canlı analiz burada belirir.
        </p>
      ) : !payload ? (
        <p className="live-analysis-panel__empty">
          {status.kind === 'error'
            ? 'Bağlantı kurulamadı. Ağ veya meeting-ai servisi erişilebilirliğini kontrol et.'
            : 'İlk canlı analiz bekleniyor…'}
        </p>
      ) : (
        <div className="live-analysis-panel__body">
          {isPartial && (
            <div
              className="live-analysis-panel__badge"
              title="Bu içerik canlı bir kısmi analizdir; daha sonra güncellenebilir."
            >
              Kısmi (v{payload.version ?? 0})
            </div>
          )}
          {payload.summary ? (
            <section className="live-analysis-panel__section">
              <h4 className="live-analysis-panel__section-title">Özet</h4>
              <p className="live-analysis-panel__summary">{payload.summary}</p>
            </section>
          ) : null}
          {renderList(payload.decisions, 'Kararlar')}
          {renderList(payload.action_items, 'Aksiyonlar')}
          <footer className="live-analysis-panel__footer">
            <span>Son güncelleme: {latest?.receivedAt ?? '—'}</span>
            {typeof payload.redaction_count === 'number' && payload.redaction_count > 0 ? (
              <span>KVKK redaction: {payload.redaction_count}</span>
            ) : null}
          </footer>
        </div>
      )}
    </section>
  );
};

export default LiveAnalysisPanel;
