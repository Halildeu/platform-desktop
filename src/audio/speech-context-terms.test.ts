import { describe, expect, it } from 'vitest';

import {
  MAX_SPEECH_CONTEXT_TERMS,
  MAX_SPEECH_CONTEXT_TERM_LENGTH,
  canonicalizeSpeechContextTerm,
  normalizeSpeechContextTerm,
  normalizeSpeechContextTerms,
} from './speech-context-terms';

describe('speech-context-terms (renderer mirror of the meeting-contract normalizer)', () => {
  // Drift guard: this is the exact input/output the main-process copy asserts in
  // electron/services/meeting/meeting-client.test.ts. If the two ever diverge,
  // the chip preview would lie about what gets persisted.
  it('matches the main-process normalization on the canonical case', () => {
    expect(
      normalizeSpeechContextTerms(['Açık Holding', 'OpenFGA', '  OpenFGA ', 'openfga', '   ']),
    ).toEqual(['Açık Holding', 'OpenFGA', 'openfga']);
  });

  it('collapses internal whitespace and trims ends (NFKC)', () => {
    expect(normalizeSpeechContextTerm('  Zeynep   Akkılıç  ')).toBe('Zeynep Akkılıç');
    expect(canonicalizeSpeechContextTerm('a\t\tb\n c')).toBe('a b c');
  });

  it('preserves case as a distinct term (case-sensitive dedupe)', () => {
    expect(normalizeSpeechContextTerms(['OpenFGA', 'openfga', 'OPENFGA'])).toEqual([
      'OpenFGA',
      'openfga',
      'OPENFGA',
    ]);
  });

  it('drops blank and oversized terms', () => {
    const tooLong = 'x'.repeat(MAX_SPEECH_CONTEXT_TERM_LENGTH + 1);
    const exactlyMax = 'y'.repeat(MAX_SPEECH_CONTEXT_TERM_LENGTH);
    expect(normalizeSpeechContextTerm('   ')).toBe('');
    expect(normalizeSpeechContextTerm(tooLong)).toBe('');
    expect(normalizeSpeechContextTerm(exactlyMax)).toBe(exactlyMax);
    expect(normalizeSpeechContextTerms(['', '  ', tooLong, 'Kept'])).toEqual(['Kept']);
  });

  it('caps at MAX_SPEECH_CONTEXT_TERMS and keeps the first ones', () => {
    const many = Array.from({ length: MAX_SPEECH_CONTEXT_TERMS + 10 }, (_, i) => `term-${i}`);
    const result = normalizeSpeechContextTerms(many);
    expect(result).toHaveLength(MAX_SPEECH_CONTEXT_TERMS);
    expect(result[0]).toBe('term-0');
    expect(result[MAX_SPEECH_CONTEXT_TERMS - 1]).toBe(`term-${MAX_SPEECH_CONTEXT_TERMS - 1}`);
  });

  it('returns an empty array for undefined and skips non-string entries', () => {
    expect(normalizeSpeechContextTerms(undefined)).toEqual([]);
    expect(
      normalizeSpeechContextTerms([
        'ok',
        42 as unknown as string,
        null as unknown as string,
        'ok2',
      ]),
    ).toEqual(['ok', 'ok2']);
  });
});
