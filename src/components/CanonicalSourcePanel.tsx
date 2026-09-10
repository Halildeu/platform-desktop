import type { ReactElement } from 'react';
import type { CanonicalTranscriptSource } from '../../electron/services/meeting/canonical-transcript';
import {
  formatCitationTime,
  type IntelligenceCitation,
} from '../intelligence/meeting-intelligence';
import './canonical-source.css';

function sourceId(source: CanonicalTranscriptSource, index: number): string {
  return `canonical-source-${source.analysisRunId}-${index}`;
}

export function CitationLinks({
  citations,
  source,
}: {
  citations: IntelligenceCitation[];
  source: CanonicalTranscriptSource | null;
}): ReactElement {
  return (
    <span className="citation-links">
      {citations.length === 0
        ? '-'
        : citations.map((citation, index) => {
            const sentence = source?.sentences.find(
              (row) => row.index === citation.sourceIndex && row.sha256 === citation.sourceHash,
            );
            return sentence && source ? (
              <a
                key={index}
                href={`#${sourceId(source, sentence.index)}`}
                onClick={(event) => {
                  event.preventDefault();
                  const target = document.getElementById(sourceId(source, sentence.index));
                  target?.focus({ preventScroll: true });
                  target?.scrollIntoView({ block: 'center' });
                }}
              >
                {formatCitationTime(citation)}
              </a>
            ) : (
              <span key={index} title="Kaynak henüz okunamadı veya referans eşleşmedi">
                {formatCitationTime(citation)}
              </span>
            );
          })}
    </span>
  );
}

export function CanonicalSourcePanel({
  source,
  status,
  onRetry,
}: {
  source: CanonicalTranscriptSource | null;
  status: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <section className="canonical-source" aria-label="Analizin kaynak transkripti">
      <h3>Analizin kaynak transkripti</h3>
      <p role="status">
        {source
          ? `Sunucudan doğrulandı · Sürüm ${source.finalizationVersion} · ${source.sentences.length} kaynak cümlesi`
          : status === 'error'
            ? 'Kaynak okunamadı. Yetki, saklama veya bağlantı koşulları uygun olmayabilir.'
            : 'Kaynak yükleniyor…'}
      </p>
      {!source && status === 'error' ? (
        <button type="button" onClick={onRetry}>
          Kaynağı yeniden yükle
        </button>
      ) : null}
      {source ? (
        <ol className="canonical-source-lines">
          {source.sentences.map((sentence) => (
            <li
              key={sentence.index}
              id={sourceId(source, sentence.index)}
              tabIndex={-1}
              aria-label={`Kaynak #${sentence.index + 1}`}
            >
              {sentence.text}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
