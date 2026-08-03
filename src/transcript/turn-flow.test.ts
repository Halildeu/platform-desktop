import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from './session-transcript';
import { buildTurnFlow, endsWithSentenceTerminator } from './turn-flow';

function segment(
  id: string,
  text: string,
  status: TranscriptSegment['status'],
  startedAtMs = 0,
): TranscriptSegment {
  return { id, speakerLabel: 'Konuşmacı', startedAtMs, status, text };
}

describe('endsWithSentenceTerminator', () => {
  it('accepts Turkish sentence enders with closing quotes', () => {
    expect(endsWithSentenceTerminator('Bütçe onaylandı.')).toBe(true);
    expect(endsWithSentenceTerminator('Onaylıyor musunuz?')).toBe(true);
    expect(endsWithSentenceTerminator('"Tamamdır."')).toBe(true);
    expect(endsWithSentenceTerminator('Şöyle dedi…')).toBe(true);
  });

  it('rejects mid-sentence tails', () => {
    expect(endsWithSentenceTerminator('bütçe ve proje planını')).toBe(false);
    expect(endsWithSentenceTerminator('')).toBe(false);
    expect(endsWithSentenceTerminator('virgülle biter,')).toBe(false);
  });
});

describe('buildTurnFlow', () => {
  it('keeps unterminated commits in ONE flowing paragraph — no time-based break', () => {
    const flow = buildTurnFlow([
      segment('a', 'Bu toplantıda bütçe ve', 'final', 0),
      segment('b', 'proje planını', 'final', 2000),
      segment('c', 'değerlendiriyoruz.', 'final', 4000),
    ]);
    expect(flow.paragraphs).toHaveLength(1);
    expect(flow.paragraphs[0].text).toBe('Bu toplantıda bütçe ve proje planını değerlendiriyoruz.');
    expect(flow.paragraphs[0].segmentIds).toEqual(['a', 'b', 'c']);
    expect(flow.tailText).toBe('');
  });

  it('opens a new paragraph only after a sentence terminator', () => {
    const flow = buildTurnFlow([
      segment('a', 'Karar bugün kaydedilecektir.', 'utterance', 0),
      segment('b', 'Görev için sorumlu kişi', 'final', 3000),
      segment('c', 'rapor hazırlayacak.', 'final', 6000),
    ]);
    expect(flow.paragraphs.map((p) => p.text)).toEqual([
      'Karar bugün kaydedilecektir.',
      'Görev için sorumlu kişi rapor hazırlayacak.',
    ]);
  });

  it('extracts trailing drafts as the live tail (replace-in-place lane)', () => {
    const flow = buildTurnFlow([
      segment('a', 'İlk cümle tamam.', 'final', 0),
      segment('b', 'şimdi konuşmaya devam', 'draft', 2000),
    ]);
    expect(flow.paragraphs).toHaveLength(1);
    expect(flow.tailText).toBe('şimdi konuşmaya devam');
    expect(flow.tailSegmentIds).toEqual(['b']);
  });

  it('joins consecutive trailing drafts into one tail', () => {
    const flow = buildTurnFlow([
      segment('a', 'Cümle bitti.', 'utterance', 0),
      segment('b', 'devam eden', 'stabilizing', 2000),
      segment('c', 'canlı hipotez', 'draft', 2500),
    ]);
    expect(flow.tailText).toBe('devam eden canlı hipotez');
    expect(flow.tailSegmentIds).toEqual(['b', 'c']);
  });

  it('folds mid-turn drafts (REST fallback windows) into the flow as pending text', () => {
    const flow = buildTurnFlow([
      segment('a', 'Canlı hat kesildi', 'draft', 0),
      segment('b', 'ama kayıt sürdü.', 'draft', 2000),
      segment('c', 'Sonra canlı hat döndü.', 'final', 5000),
    ]);
    expect(flow.paragraphs.map((p) => p.text)).toEqual([
      'Canlı hat kesildi ama kayıt sürdü.',
      'Sonra canlı hat döndü.',
    ]);
    expect(flow.paragraphs[0].pending).toBe(true);
    expect(flow.paragraphs[1].pending).toBe(false);
    expect(flow.tailText).toBe('');
  });

  it('ignores blank segments and returns empty flow for empty input', () => {
    expect(buildTurnFlow([]).paragraphs).toHaveLength(0);
    const flow = buildTurnFlow([segment('a', '   ', 'final', 0)]);
    expect(flow.paragraphs).toHaveLength(0);
    expect(flow.tailText).toBe('');
  });

  it('flushes an unterminated trailing committed group as an open paragraph', () => {
    const flow = buildTurnFlow([segment('a', 'nokta olmadan biten akış', 'final', 0)]);
    expect(flow.paragraphs).toHaveLength(1);
    expect(flow.paragraphs[0].text).toBe('nokta olmadan biten akış');
  });
});
