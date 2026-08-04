import { describe, expect, it } from 'vitest';

import { combinedLiveSttContextTerms, meetingTitleContextTerms } from './live-stt-context';

describe('meetingTitleContextTerms', () => {
  it('keeps bounded name-like phrases without generic meeting-title words', () => {
    expect(meetingTitleContextTerms('Zeynep Akkılıç - Halil Koçoğlu Faz 24')).toEqual([
      'Zeynep Akkılıç',
      'Zeynep',
      'Akkılıç',
      'Halil Koçoğlu',
      'Halil',
      'Koçoğlu',
    ]);
  });

  it('normalizes duplicates without locale-sensitive collisions', () => {
    expect(meetingTitleContextTerms('İpek İPEK')).toEqual(['İpek']);
  });

  it('does not turn generic or mixed-alphanumeric titles into hotwords', () => {
    expect(meetingTitleContextTerms('Faz 24 Test4 Bütçe Review')).toEqual([]);
    expect(meetingTitleContextTerms('ACIK Platform - Q3 weekly')).toEqual(['ACIK']);
  });

  it('rejects control characters and overlong titles', () => {
    expect(meetingTitleContextTerms('Zeynep\u0000Akkılıç')).toEqual([]);
    expect(meetingTitleContextTerms('A'.repeat(65))).toEqual([]);
  });

  it('returns no context for missing or punctuation-only titles', () => {
    expect(meetingTitleContextTerms(null)).toEqual([]);
    expect(meetingTitleContextTerms('---')).toEqual([]);
  });
});

describe('combinedLiveSttContextTerms', () => {
  it('puts user dictionary entries before title-derived terms', () => {
    expect(
      combinedLiveSttContextTerms('Zeynep Akkılıç - Faz 24', ['Sevil Karakaş', 'Sergen Bediroğlu']),
    ).toEqual(['Sevil Karakaş', 'Sergen Bediroğlu', 'Zeynep Akkılıç', 'Zeynep', 'Akkılıç']);
  });

  it('accepts lowercase dictionary entries the title heuristic would reject', () => {
    expect(combinedLiveSttContextTerms(null, ['sevil karakaş'])).toEqual(['sevil karakaş']);
  });

  it('skips invalid dictionary lines silently and dedupes against the title', () => {
    expect(
      combinedLiveSttContextTerms('Sevil Karakaş sunumu', ['', '  ', 'x', 'a{b}', 'SEVİL KARAKAŞ']),
    ).toEqual(['SEVİL KARAKAŞ', 'Sevil', 'Karakaş']);
  });

  it('caps the combined budget so oversized dictionaries cannot flood the stream', () => {
    const flood = Array.from({ length: 40 }, (_, index) => `Aday ${'X'.repeat(10)}${index}`);
    const terms = combinedLiveSttContextTerms(null, flood);
    expect(terms.length).toBeLessThanOrEqual(16);
    expect(terms.join('').length).toBeLessThanOrEqual(256);
  });
});
