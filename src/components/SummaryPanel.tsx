import { useState, type ReactElement } from 'react';

import {
  actionStatusLabel,
  buildIntelligenceExport,
  decisionStatusLabel,
  formatCitationTime,
  intelligenceStatusLabel,
  type IntelligenceCitation,
  type MeetingIntelligenceState,
} from '../intelligence/meeting-intelligence';

export interface ExportAdapter {
  copyText(text: string): Promise<void>;
  downloadText(fileName: string, content: string, mimeType: string): void;
  print(): void;
}

export interface SummaryPanelProps {
  intelligence: MeetingIntelligenceState;
  exportAdapter?: ExportAdapter;
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

export function SummaryPanel({
  intelligence,
  exportAdapter = browserExportAdapter,
}: SummaryPanelProps): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const result = intelligence.status === 'ready' ? intelligence.result : null;

  const runExport = async (kind: 'copy' | 'markdown' | 'csv' | 'print'): Promise<void> => {
    setMessage(null);
    try {
      const bundle = buildIntelligenceExport(intelligence);
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

  return (
    <section className="summary-panel" aria-labelledby="summary-title">
      <div className="panel-header">
        <div>
          <h2 id="summary-title">Toplantı Çıktısı</h2>
          <p className="panel-subtitle">
            {intelligence.meetingId ? `Meeting ${intelligence.meetingId}` : 'Meeting seçilmedi'}
          </p>
        </div>
        <span className={`state-pill state-${intelligence.status}`}>
          {intelligenceStatusLabel(intelligence.status)}
        </span>
      </div>

      {intelligence.error ? <p className="inline-error">{intelligence.error}</p> : null}

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
      ) : (
        <div className="summary-empty">
          <strong>Toplantı çıktısı bekleniyor</strong>
          <span>{emptyStateText(intelligence.status)}</span>
        </div>
      )}
    </section>
  );
}

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
