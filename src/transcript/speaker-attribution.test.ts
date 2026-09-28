import { describe, expect, it } from 'vitest';
import {
  MIXED_SPEAKER_LABEL,
  UNKNOWN_SPEAKER_LABEL,
  parseSpeakerAttribution,
  resolveSpeakerAttribution,
  splitSegmentBySpeaker,
} from './speaker-attribution';

const SCOPE_A = '6f1c2b0e-8a4d-3c5b-9e7f-1a2b3c4d5e6f';
const SCOPE_B = '0b1c2d3e-4f50-3a6b-8c7d-9e0f1a2b3c4d';

function turn(speaker: string, textStart: number, textEnd: number, startMs = 0, endMs = 100) {
  return { speaker, textStart, textEnd, startMs, endMs };
}

describe('parseSpeakerAttribution', () => {
  it('accepts the bounded anonymous contract', () => {
    const text = 'Merhaba nasılsın';
    expect(
      parseSpeakerAttribution(
        { scope: SCOPE_A, turns: [turn('S1', 0, 7), turn('S2', 8, 16)] },
        text,
      ),
    ).toEqual({ scope: SCOPE_A, turns: [turn('S1', 0, 7), turn('S2', 8, 16)] });
  });

  it.each([
    ['named speaker', { scope: SCOPE_A, turns: [turn('Zeynep', 0, 5)] }],
    ['extra field', { scope: SCOPE_A, turns: [turn('S1', 0, 5)], name: 'x' }],
    ['non-uuid scope', { scope: 'meeting-1', turns: [turn('S1', 0, 5)] }],
    ['uncovered text', { scope: SCOPE_A, turns: [turn('S1', 0, 3)] }],
    ['out of range', { scope: SCOPE_A, turns: [turn('S1', 0, 9)] }],
    ['overlapping text', { scope: SCOPE_A, turns: [turn('S1', 0, 4), turn('S2', 3, 5)] }],
    ['empty turns', { scope: SCOPE_A, turns: [] }],
  ])('rejects %s instead of guessing a speaker', (_name, value) => {
    expect(parseSpeakerAttribution(value, 'Tamam')).toBeUndefined();
  });
});

describe('resolveSpeakerAttribution', () => {
  it('numbers speakers by first appearance and keeps numbers stable', () => {
    const first = resolveSpeakerAttribution(
      { scope: SCOPE_A, turns: [turn('S2', 0, 5)] },
      'Tamam',
      {},
    );
    expect(first).toMatchObject({ speakerLabel: 'Konuşmacı 1', speakerKey: `${SCOPE_A}:S2` });

    const second = resolveSpeakerAttribution(
      { scope: SCOPE_A, turns: [turn('S1', 0, 4)] },
      'Olur',
      first!.speakerKeys,
    );
    expect(second).toMatchObject({ speakerLabel: 'Konuşmacı 2' });

    const again = resolveSpeakerAttribution(
      { scope: SCOPE_A, turns: [turn('S2', 0, 4)] },
      'Evet',
      second!.speakerKeys,
    );
    expect(again).toMatchObject({ speakerLabel: 'Konuşmacı 1' });
  });

  it('never treats the same label in a new scope as the same person', () => {
    const first = resolveSpeakerAttribution(
      { scope: SCOPE_A, turns: [turn('S1', 0, 5)] },
      'Tamam',
      {},
    );
    const reconnected = resolveSpeakerAttribution(
      { scope: SCOPE_B, turns: [turn('S1', 0, 5)] },
      'Tamam',
      first!.speakerKeys,
    );
    expect(reconnected).toMatchObject({ speakerLabel: 'Konuşmacı 2' });
  });

  it('keeps unknown speakers unnumbered', () => {
    const resolved = resolveSpeakerAttribution(
      { scope: SCOPE_A, turns: [turn('UU', 0, 5)] },
      'Tamam',
      {},
    );
    expect(resolved).toEqual({ speakerLabel: UNKNOWN_SPEAKER_LABEL, speakerKeys: {} });
  });

  it('merges consecutive turns of one speaker and marks mixed windows', () => {
    const text = 'Bugün başlıyoruz. Tamam.';
    const resolved = resolveSpeakerAttribution(
      {
        scope: SCOPE_A,
        turns: [
          turn('S1', 0, 5, 0, 300),
          turn('S1', 6, 17, 350, 900),
          turn('S2', 18, 24, 1_000, 1_400),
        ],
      },
      text,
      {},
    );
    expect(resolved).toEqual({
      speakerLabel: MIXED_SPEAKER_LABEL,
      speakerTurns: [
        { label: 'Konuşmacı 1', textStart: 0, textEnd: 17, startMs: 0, endMs: 900 },
        { label: 'Konuşmacı 2', textStart: 18, textEnd: 24, startMs: 1_000, endMs: 1_400 },
      ],
      speakerKeys: { [`${SCOPE_A}:S1`]: 'Konuşmacı 1', [`${SCOPE_A}:S2`]: 'Konuşmacı 2' },
    });
  });

  it('returns null for invalid attribution and leaves the table untouched', () => {
    expect(resolveSpeakerAttribution(undefined, 'Tamam', {})).toBeNull();
    expect(resolveSpeakerAttribution({ scope: SCOPE_A, turns: [] }, 'Tamam', {})).toBeNull();
  });
});

describe('splitSegmentBySpeaker', () => {
  const segment = {
    id: 'gateway:SES:live:3:window:4',
    speakerLabel: MIXED_SPEAKER_LABEL,
    startedAtMs: 10_000,
    endedAtMs: 11_400,
    timingBasis: 'source' as const,
    text: 'Bugün başlıyoruz. Tamam.',
    speakerTurns: [
      { label: 'Konuşmacı 1', textStart: 0, textEnd: 17, startMs: 0, endMs: 900 },
      { label: 'Konuşmacı 2', textStart: 18, textEnd: 24, startMs: 1_000, endMs: 1_400 },
    ],
  };

  it('splits for display while the first piece keeps the canonical id', () => {
    expect(splitSegmentBySpeaker(segment)).toEqual([
      expect.objectContaining({
        id: segment.id,
        speakerLabel: 'Konuşmacı 1',
        text: 'Bugün başlıyoruz.',
        startedAtMs: 10_000,
        endedAtMs: 10_900,
        speakerParentId: segment.id,
        speakerTurns: undefined,
      }),
      expect.objectContaining({
        id: `${segment.id}:turn-1`,
        speakerLabel: 'Konuşmacı 2',
        text: 'Tamam.',
        startedAtMs: 11_000,
        endedAtMs: 11_400,
        speakerParentId: segment.id,
      }),
    ]);
  });

  it('does not invent source end times for delivery-timed segments', () => {
    const pieces = splitSegmentBySpeaker({ ...segment, timingBasis: 'delivery', endedAtMs: null });
    expect(pieces.map((piece) => piece.endedAtMs)).toEqual([null, null]);
  });

  it('leaves single-speaker segments unchanged', () => {
    const single = { ...segment, speakerTurns: undefined, speakerLabel: 'Konuşmacı 1' };
    expect(splitSegmentBySpeaker(single)).toEqual([single]);
  });
});
