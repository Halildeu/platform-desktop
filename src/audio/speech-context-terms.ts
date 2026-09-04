/**
 * Renderer-safe mirror of the meeting-contract speech-context normalization.
 *
 * The authoritative copy lives in the main process
 * (electron/services/meeting/meeting-client.ts → normalizeSpeechContextTerms),
 * which re-normalizes at the boundary before it POSTs the contract. This copy
 * exists because the renderer cannot import the main-process module (it pulls in
 * the Node-only desktop fetch), yet the meeting planner needs the SAME rules to
 * (a) show the user the exact terms that will be persisted (chip preview) and
 * (b) enforce the caps as they type.
 *
 * Rules (kept byte-identical with the main-process copy — the drift-guard test
 * in speech-context-terms.test.ts pins the shared cases):
 *   - NFKC normalize, collapse internal whitespace to a single space, trim ends
 *   - drop blank entries and entries longer than MAX_SPEECH_CONTEXT_TERM_LENGTH
 *   - case-SENSITIVE exact dedupe (case is a spelling hint for the STT engine)
 *   - cap at MAX_SPEECH_CONTEXT_TERMS
 */

export const MAX_SPEECH_CONTEXT_TERMS = 32;
export const MAX_SPEECH_CONTEXT_TERM_LENGTH = 64;

/**
 * NFKC + internal-whitespace collapse + trim, with NO length cap or dedupe.
 * Callers use this when they need to see the canonical form before deciding why
 * a term is unusable (e.g. blank vs. too long) — the chip input branches on it
 * to give a specific hint.
 */
export function canonicalizeSpeechContextTerm(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize a single raw term and reject it (return '') when it is blank
 * after canonicalization or longer than MAX_SPEECH_CONTEXT_TERM_LENGTH.
 */
export function normalizeSpeechContextTerm(raw: string): string {
  const term = canonicalizeSpeechContextTerm(raw);
  if (!term || term.length > MAX_SPEECH_CONTEXT_TERM_LENGTH) {
    return '';
  }
  return term;
}

/**
 * Normalize a list of raw terms exactly as the meeting contract will: drop
 * blank/oversized entries, case-sensitive exact dedupe, cap at
 * MAX_SPEECH_CONTEXT_TERMS. Non-string entries are skipped defensively.
 */
export function normalizeSpeechContextTerms(terms: readonly string[] | undefined): string[] {
  if (!terms) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    if (out.length >= MAX_SPEECH_CONTEXT_TERMS) {
      break;
    }
    if (typeof raw !== 'string') {
      continue;
    }
    const term = normalizeSpeechContextTerm(raw);
    if (!term || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}
