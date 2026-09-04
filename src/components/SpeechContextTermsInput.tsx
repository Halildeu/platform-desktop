import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

import {
  MAX_SPEECH_CONTEXT_TERMS,
  MAX_SPEECH_CONTEXT_TERM_LENGTH,
  canonicalizeSpeechContextTerm,
} from '../audio/speech-context-terms';

export interface SpeechContextTermsInputProps {
  /** Controlled list of already-added terms — every entry is already normalized. */
  terms: string[];
  onChange: (terms: string[]) => void;
  disabled?: boolean;
  /** Overridable for reuse/tests; defaults mirror the meeting-contract caps. */
  maxTerms?: number;
  maxTermLength?: number;
  label?: string;
  /** Explicit id for the text input so an external <label htmlFor> can bind. */
  inputId?: string;
}

/**
 * Faz 24 STT (platform-backend#1024 slice 4): tag/chip entry for the meeting's
 * speech-context vocabulary. The chips ARE the normalized terms — typing a term
 * and pressing Enter (or comma) canonicalizes it (NFKC, whitespace collapse,
 * trim) and adds a chip, so the user sees exactly what will be persisted on the
 * contract. Case is preserved on purpose ("OpenFGA" and "openfga" are distinct
 * spelling hints for the STT engine). Enforces the same <=32 term / <=64 char
 * caps the main process re-applies at the contract boundary.
 */
export function SpeechContextTermsInput({
  terms,
  onChange,
  disabled = false,
  maxTerms = MAX_SPEECH_CONTEXT_TERMS,
  maxTermLength = MAX_SPEECH_CONTEXT_TERM_LENGTH,
  label = 'Toplantı sözlüğü — özel terimler',
  inputId,
}: SpeechContextTermsInputProps) {
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState('');
  const reactId = useId();
  const fieldId = inputId ?? `${reactId}-input`;
  const helpId = `${reactId}-help`;
  const atCapacity = terms.length >= maxTerms;

  /** Try to add one raw term. Returns true when a chip was added. */
  const commit = (raw: string): boolean => {
    const term = canonicalizeSpeechContextTerm(raw);
    if (!term) {
      return false; // blank after normalization — nothing to add, no noise
    }
    if (term.length > maxTermLength) {
      setHint(`Terim en fazla ${maxTermLength} karakter olabilir.`);
      return false;
    }
    if (terms.length >= maxTerms) {
      setHint(`En fazla ${maxTerms} terim ekleyebilirsiniz.`);
      return false;
    }
    if (terms.includes(term)) {
      setHint(`"${term}" zaten ekli.`);
      return false;
    }
    onChange([...terms, term]);
    setHint('');
    return true;
  };

  /** Add several raw terms at once (paste); silently skips blank/oversized/dupes. */
  const commitMany = (rawEntries: string[]): void => {
    let next = terms;
    let overflowed = false;
    for (const raw of rawEntries) {
      if (next.length >= maxTerms) {
        overflowed = true;
        break;
      }
      const term = canonicalizeSpeechContextTerm(raw);
      if (!term || term.length > maxTermLength || next.includes(term)) {
        continue;
      }
      next = [...next, term];
    }
    if (next !== terms) {
      onChange(next);
      setHint(overflowed ? `En fazla ${maxTerms} terim ekleyebilirsiniz.` : '');
    } else if (overflowed) {
      setHint(`En fazla ${maxTerms} terim ekleyebilirsiniz.`);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (commit(draft)) {
        setDraft('');
      }
      return;
    }
    if (event.key === 'Backspace' && draft === '' && terms.length > 0) {
      event.preventDefault();
      onChange(terms.slice(0, -1));
      setHint('');
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text');
    if (!/[\n,]/.test(text)) {
      return; // single token — let it land in the input normally
    }
    event.preventDefault();
    commitMany(text.split(/\r?\n|,/));
    setDraft('');
  };

  const removeTerm = (index: number): void => {
    onChange(terms.filter((_, i) => i !== index));
    setHint('');
  };

  return (
    <div className="speech-context-terms meeting-planner-field--wide">
      <label className="speech-context-terms-label" htmlFor={fieldId}>
        <span>{label}</span>
      </label>
      <p id={helpId} className="speech-context-terms-help">
        Konuşmacı adları, ürün/marka adları ve kısaltmalar — bu toplantının her kaydında
        transkripsiyon motoruna ipucu olarak verilir. Enter veya virgül ile ekleyin.
      </p>
      {terms.length > 0 ? (
        <ul className="speech-context-terms-chips" aria-label="Eklenen terimler">
          {terms.map((term, index) => (
            <li key={term} className="speech-context-terms-chip">
              <span className="speech-context-terms-chip-text">{term}</span>
              <button
                type="button"
                className="speech-context-terms-chip-remove"
                aria-label={`"${term}" terimini kaldır`}
                disabled={disabled}
                onClick={() => removeTerm(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={fieldId}
        type="text"
        className="speech-context-terms-input"
        value={draft}
        autoComplete="off"
        disabled={disabled || atCapacity}
        placeholder={
          atCapacity ? `En fazla ${maxTerms} terim eklendi` : 'Terim yazıp Enter’a basın'
        }
        aria-describedby={helpId}
        onChange={(event) => {
          setDraft(event.target.value);
          if (hint) {
            setHint('');
          }
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => {
          // Commit a term the user typed but did not confirm before moving on
          // (e.g. clicking "Toplantıyı oluştur"): blur fires before that click.
          if (draft.trim() && commit(draft)) {
            setDraft('');
          }
        }}
      />
      <p className="speech-context-terms-footer">
        {hint ? (
          <span className="speech-context-terms-hint" role="status" aria-live="polite">
            {hint}
          </span>
        ) : (
          <span />
        )}
        <span className="speech-context-terms-count">
          {terms.length}/{maxTerms}
        </span>
      </p>
    </div>
  );
}
