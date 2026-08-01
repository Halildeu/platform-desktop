import { describe, expect, it } from 'vitest';

import { meetingTitleContextTerms } from './live-stt-context';

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
