/**
 * Faz 24 İ3 — live-analysis viewer panel.
 *
 * Renders the latest partial/final analysis published by meeting-ai's
 * `/analyze/live/stream/{meetingId}` SSE relay. Consumers pass a
 * `meetingId` when the meeting is active; the panel handles
 * subscribe/teardown via `useLiveAnalysis`.
 *
 * Design notes:
 *   - Analysis CONTENT stays read-only: `is_partial=true` marks live content
 *     with a subtle badge so users know a later delivery may supersede; the
 *     analyzer's canonical final result still comes via the durable /analyze
 *     path (see `SummaryPanel` for the final view).
 *   - No decision/action shape polishing — we render the raw fields from the
 *     analyzer response so a schema drift becomes visible instead of being
 *     silently coerced.
 *   - Faz 24 Görevler dilim-3 (gitops#3486): each action item carries an
 *     "Ata" affordance that turns it into a platform task through the same
 *     admin CRUD the web Görevler panel uses (IPC `meeting:action-create`).
 *     Creating a task does NOT mutate the analyzer payload — a later partial
 *     may re-render the list; created rows are keyed by action text so the
 *     "Görev oluşturuldu" state survives re-renders of identical items.
 *   - Status bar surfaces connecting/open/closed/error so a broken relay
 *     is diagnosable in-app without console spelunking.
 */

import { useState, type FC, type JSX } from 'react';

import {
  useLiveAnalysis,
  type LiveAnalysisApi,
  type LiveAnalysisPayload,
  type LiveAnalysisStatus,
} from '../intelligence/use-live-analysis';

export interface LiveTasksApi {
  createAction(payload: {
    meetingId: string;
    description: string;
    assigneeUserId?: number | null;
    dueAt?: string | null;
  }): Promise<{ id: string }>;
  searchAssignees(payload: { query: string }): Promise<Array<{ userId: number; label: string }>>;
}

export interface LiveAnalysisPanelProps {
  meetingId: string | null;
  /** Optional injection point for tests. Defaults to `window.electronAPI.meeting`. */
  api?: LiveAnalysisApi;
  /** Optional injection point for tests. Defaults to `window.electronAPI.meeting`. */
  tasksApi?: LiveTasksApi;
}

function defaultTasksApi(): LiveTasksApi | undefined {
  return (globalThis as { electronAPI?: { meeting?: LiveTasksApi } }).electronAPI?.meeting;
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

function itemText(item: unknown): string {
  return typeof item === 'string'
    ? item
    : typeof item === 'object' && item !== null && 'text' in item
      ? String((item as { text: unknown }).text ?? '')
      : JSON.stringify(item);
}

function renderList(items: unknown[] | undefined, label: string): JSX.Element | null {
  if (!items || !items.length) return null;
  return (
    <section className="live-analysis-panel__section">
      <h4 className="live-analysis-panel__section-title">{label}</h4>
      <ul className="live-analysis-panel__list">
        {items.map((item, i) => (
          <li key={i} className="live-analysis-panel__item">
            {itemText(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}

type AssignPhase =
  | { kind: 'idle' }
  | { kind: 'form' }
  | { kind: 'saving' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

function ActionItemRow({
  meetingId,
  text,
  api,
}: {
  meetingId: string;
  text: string;
  api: LiveTasksApi | undefined;
}): JSX.Element {
  const [phase, setPhase] = useState<AssignPhase>({ kind: 'idle' });
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Array<{ userId: number; label: string }>>([]);
  const [selected, setSelected] = useState<{ userId: number; label: string } | null>(null);
  const [dueDate, setDueDate] = useState('');

  const search = (): void => {
    if (!api || !query.trim()) return;
    api
      .searchAssignees({ query: query.trim() })
      .then((rows) => setOptions(rows))
      .catch(() => setOptions([]));
  };

  const createTask = (): void => {
    if (!api) return;
    setPhase({ kind: 'saving' });
    api
      .createAction({
        meetingId,
        description: text,
        assigneeUserId: selected?.userId ?? null,
        dueAt: dueDate ? new Date(`${dueDate}T17:00:00`).toISOString() : null,
      })
      .then(() => setPhase({ kind: 'done' }))
      .catch((error: unknown) =>
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  };

  return (
    <li className="live-analysis-panel__item live-analysis-panel__item--action">
      <span className="live-analysis-panel__action-text">{text}</span>
      {phase.kind === 'done' ? (
        <span className="live-analysis-panel__task-done" role="status">
          ✓ Görev oluşturuldu{selected ? ` — ${selected.label}` : ''}
        </span>
      ) : phase.kind === 'idle' ? (
        api ? (
          <button
            type="button"
            className="live-analysis-panel__assign-btn"
            onClick={() => setPhase({ kind: 'form' })}
          >
            Göreve ata
          </button>
        ) : null
      ) : (
        <div className="live-analysis-panel__assign-form">
          {phase.kind === 'error' ? (
            <p className="live-analysis-panel__assign-error" role="alert">
              Görev oluşturulamadı: {phase.message}
            </p>
          ) : null}
          <div className="live-analysis-panel__assign-row">
            <input
              type="text"
              value={query}
              placeholder="Kişi ara (ad veya e-posta)"
              aria-label="Atanacak kişiyi ara"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search();
              }}
              disabled={phase.kind === 'saving'}
            />
            <button
              type="button"
              onClick={search}
              disabled={phase.kind === 'saving' || !query.trim()}
            >
              Ara
            </button>
          </div>
          {options.length > 0 && !selected ? (
            <ul className="live-analysis-panel__assign-options">
              {options.map((o) => (
                <li key={o.userId}>
                  <button type="button" onClick={() => setSelected(o)}>
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {selected ? (
            <p className="live-analysis-panel__assign-selected">
              Atanan: <strong>{selected.label}</strong>{' '}
              <button type="button" onClick={() => setSelected(null)}>
                değiştir
              </button>
            </p>
          ) : null}
          <div className="live-analysis-panel__assign-row">
            <input
              type="date"
              value={dueDate}
              aria-label="Termin (opsiyonel)"
              onChange={(e) => setDueDate(e.target.value)}
              disabled={phase.kind === 'saving'}
            />
            <button
              type="button"
              className="live-analysis-panel__assign-btn"
              onClick={createTask}
              disabled={phase.kind === 'saving'}
            >
              {phase.kind === 'saving' ? 'Oluşturuluyor…' : 'Görev oluştur'}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: 'idle' })}
              disabled={phase.kind === 'saving'}
            >
              Vazgeç
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function renderActions(
  items: unknown[] | undefined,
  meetingId: string,
  api: LiveTasksApi | undefined,
): JSX.Element | null {
  if (!items || !items.length) return null;
  return (
    <section className="live-analysis-panel__section">
      <h4 className="live-analysis-panel__section-title">Aksiyonlar</h4>
      <ul className="live-analysis-panel__list">
        {items.map((item) => {
          const text = itemText(item);
          return <ActionItemRow key={text} meetingId={meetingId} text={text} api={api} />;
        })}
      </ul>
    </section>
  );
}

export const LiveAnalysisPanel: FC<LiveAnalysisPanelProps> = ({ meetingId, api, tasksApi }) => {
  const { latest, status } = useLiveAnalysis(meetingId, api);
  const payload: LiveAnalysisPayload | null = latest?.payload ?? null;
  const isPartial = payload?.is_partial === true;
  const effectiveTasksApi = tasksApi ?? defaultTasksApi();

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
          {renderActions(payload.action_items, meetingId, effectiveTasksApi)}
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
