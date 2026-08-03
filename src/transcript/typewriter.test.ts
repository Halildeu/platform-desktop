import { describe, expect, it } from 'vitest';

import { advanceTypewriter, typewriterBudget } from './typewriter';

describe('typewriterBudget', () => {
  it('accelerates with backlog so the display never falls behind the speaker', () => {
    expect(typewriterBudget(4)).toBe(1);
    expect(typewriterBudget(30)).toBe(3);
    expect(typewriterBudget(60)).toBe(6);
    expect(typewriterBudget(200)).toBe(12);
  });
});

describe('advanceTypewriter', () => {
  it('types forward one step at a time toward the target', () => {
    expect(advanceTypewriter('', 'merhaba', 3)).toBe('mer');
    expect(advanceTypewriter('mer', 'merhaba', 3)).toBe('merhab');
    expect(advanceTypewriter('merhab', 'merhaba', 3)).toBe('merhaba');
  });

  it('is stable once caught up', () => {
    expect(advanceTypewriter('merhaba', 'merhaba', 3)).toBe('merhaba');
  });

  it('snaps back to the common prefix immediately when the partial is revised', () => {
    expect(advanceTypewriter('bütçe planı k', 'bütçe planı hazır', 3)).toBe('bütçe planı ');
    // Sonraki adım yeni kuyruğu yazmaya devam eder.
    expect(advanceTypewriter('bütçe planı ', 'bütçe planı hazır', 3)).toBe('bütçe planı haz');
  });

  it('clears instantly when the final swallowed the tail', () => {
    expect(advanceTypewriter('devam eden hipotez', '', 3)).toBe('');
  });

  it('never exceeds the target length even with a large budget', () => {
    expect(advanceTypewriter('a', 'ab', 50)).toBe('ab');
  });
});
