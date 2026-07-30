import { describe, expect, it } from 'vitest';

import { meetingTitleContextTerms } from './live-stt-context';

describe('meetingTitleContextTerms', () => {
  it('keeps the bounded meeting title and name-like tokens in memory', () => {
    expect(meetingTitleContextTerms('Zeynep Akkılıç - Halil Koçoğlu Faz 24')).toEqual([
      'Zeynep Akkılıç - Halil Koçoğlu Faz 24',
      'Zeynep',
      'Akkılıç',
      'Halil',
      'Koçoğlu',
      'Faz',
    ]);
  });

  it('normalizes duplicates without locale-sensitive collisions', () => {
    expect(meetingTitleContextTerms('İpek İPEK')).toEqual(['İpek İPEK', 'İpek']);
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
