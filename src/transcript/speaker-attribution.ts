// Anonim konuşmacı ayrımı (platform-backend direct-stt-speaker-attribution-v2).
//
// Gateway, Speechmatics `diarization: speaker` sonucunu final olaylarına
// `speakerAttribution = { scope, turns[] }` olarak ekler. Etiketler anonimdir
// (S1, S2, UU); ses izi ya da isim eşleştirmesi YOKTUR. `scope` her bağlantı
// için yenidir: iki farklı scope'taki "S1" aynı kişi DEĞİLDİR, bu yüzden
// etiketler scope:speaker çiftine göre numaralanır.
//
// Geçersiz atıf transkripti gizlemez ve konuşmacı tahmin etmez; satır
// atıfsız ("Konuşmacı") görünür. Doğrulama platform-web
// apps/mfe-meeting/src/speaker-attribution.ts ile aynı kuralları uygular.

export const DEFAULT_SPEAKER_LABEL = 'Konuşmacı';
export const UNKNOWN_SPEAKER_LABEL = 'Konuşmacı belirsiz';
export const MIXED_SPEAKER_LABEL = 'Birden çok konuşmacı';

const UNKNOWN_SPEAKER = 'UU';
const SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPEAKER_PATTERN = /^(S[1-9][0-9]{0,2}|SPEAKER_[0-9]{2,3}|UU)$/;
const MAX_TURNS = 512;

export interface SpeakerAttributionTurn {
  speaker: string;
  textStart: number;
  textEnd: number;
  startMs: number;
  endMs: number;
}

export interface SpeakerAttribution {
  scope: string;
  turns: SpeakerAttributionTurn[];
}

/** Bir segment içindeki ardışık aynı konuşmacı aralığı (metin ofsetleri UTF-16). */
export interface SegmentSpeakerTurn {
  label: string;
  textStart: number;
  textEnd: number;
  startMs: number;
  endMs: number;
}

export interface ResolvedSpeakerAttribution {
  speakerLabel: string;
  /** Segmentin tamamı tek konuşmacıya aitse scope:speaker anahtarı. */
  speakerKey?: string;
  /** Segment birden çok konuşmacı içeriyorsa gösterimde bölünecek aralıklar. */
  speakerTurns?: SegmentSpeakerTurn[];
  /** Güncellenmiş scope:speaker → görünen etiket tablosu. */
  speakerKeys: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitsSurrogate(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}

export function parseSpeakerAttribution(
  value: unknown,
  text: string,
): SpeakerAttribution | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.scope !== 'string' ||
    !SCOPE_PATTERN.test(value.scope) ||
    !Array.isArray(value.turns) ||
    value.turns.length === 0 ||
    value.turns.length > MAX_TURNS
  ) {
    return undefined;
  }
  const turns: SpeakerAttributionTurn[] = [];
  let previousEnd = 0;
  for (const turn of value.turns as unknown[]) {
    if (
      !isRecord(turn) ||
      Object.keys(turn).length !== 5 ||
      typeof turn.speaker !== 'string' ||
      !SPEAKER_PATTERN.test(turn.speaker)
    ) {
      return undefined;
    }
    const numbers = [turn.textStart, turn.textEnd, turn.startMs, turn.endMs];
    if (!numbers.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
      return undefined;
    }
    const candidate = turn as unknown as SpeakerAttributionTurn;
    if (
      candidate.textStart < previousEnd ||
      candidate.textEnd <= candidate.textStart ||
      candidate.textEnd > text.length ||
      candidate.endMs < candidate.startMs ||
      text.slice(previousEnd, candidate.textStart).trim() ||
      splitsSurrogate(text, candidate.textStart) ||
      splitsSurrogate(text, candidate.textEnd)
    ) {
      return undefined;
    }
    turns.push({
      speaker: candidate.speaker,
      textStart: candidate.textStart,
      textEnd: candidate.textEnd,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
    });
    previousEnd = candidate.textEnd;
  }
  if (text.slice(previousEnd).trim()) {
    return undefined;
  }
  return { scope: value.scope, turns };
}

/**
 * Atfı segment alanlarına çevirir. Etiketler geliş sırasına göre
 * "Konuşmacı 1", "Konuşmacı 2"… diye numaralanır; bilinmeyen (UU) hiçbir
 * zaman numara almaz. Atıf geçersizse null döner ve tablo değişmez.
 */
export function resolveSpeakerAttribution(
  value: unknown,
  text: string,
  known: Readonly<Record<string, string>> | undefined,
): ResolvedSpeakerAttribution | null {
  const attribution = parseSpeakerAttribution(value, text);
  if (!attribution) {
    return null;
  }
  const speakerKeys: Record<string, string> = { ...(known ?? {}) };
  let numbered = Object.values(speakerKeys).length;
  const runs: Array<SegmentSpeakerTurn & { key: string }> = [];
  for (const turn of attribution.turns) {
    const key = `${attribution.scope}:${turn.speaker}`;
    let label = UNKNOWN_SPEAKER_LABEL;
    if (turn.speaker !== UNKNOWN_SPEAKER) {
      if (!Object.prototype.hasOwnProperty.call(speakerKeys, key)) {
        numbered += 1;
        speakerKeys[key] = `${DEFAULT_SPEAKER_LABEL} ${numbered}`;
      }
      label = speakerKeys[key];
    }
    const previous = runs.at(-1);
    if (previous && previous.key === key) {
      previous.textEnd = turn.textEnd;
      previous.endMs = Math.max(previous.endMs, turn.endMs);
      continue;
    }
    runs.push({
      key,
      label,
      textStart: turn.textStart,
      textEnd: turn.textEnd,
      startMs: turn.startMs,
      endMs: turn.endMs,
    });
  }
  if (runs.length === 1) {
    const only = runs[0];
    return {
      speakerLabel: only.label,
      ...(only.label === UNKNOWN_SPEAKER_LABEL ? {} : { speakerKey: only.key }),
      speakerKeys,
    };
  }
  return {
    speakerLabel: MIXED_SPEAKER_LABEL,
    speakerTurns: runs.map(({ label, textStart, textEnd, startMs, endMs }) => ({
      label,
      textStart,
      textEnd,
      startMs,
      endMs,
    })),
    speakerKeys,
  };
}

interface SpeakerSplittableSegment {
  id: string;
  speakerLabel: string;
  startedAtMs: number;
  endedAtMs?: number | null;
  timingBasis?: 'source' | 'delivery';
  text: string;
  speakerTurns?: SegmentSpeakerTurn[];
  speakerParentId?: string;
}

/**
 * Birden çok konuşmacı içeren segmenti GÖSTERİM için parçalara böler.
 * İlk parça segment kimliğini korur (kaynak/inceleme bağlantıları kopmasın);
 * diğerleri `<id>:turn-<n>` alır ve `speakerParentId` ile asıl segmenti
 * gösterir. Durum (state) hiç bölünmez; düzeltme ve inceleme asıl segmente
 * uygulanır.
 */
export function splitSegmentBySpeaker<T extends SpeakerSplittableSegment>(segment: T): T[] {
  const turns = segment.speakerTurns;
  if (!turns || turns.length < 2) {
    return [segment];
  }
  const sourceTimed = segment.timingBasis === 'source';
  let previousStart = segment.startedAtMs;
  return turns.map((turn, index) => {
    const startedAtMs = Math.max(previousStart, segment.startedAtMs + turn.startMs);
    previousStart = startedAtMs;
    const text = segment.text.slice(turn.textStart, turn.textEnd);
    return {
      ...segment,
      id: index === 0 ? segment.id : `${segment.id}:turn-${index}`,
      speakerLabel: turn.label,
      startedAtMs,
      endedAtMs: sourceTimed
        ? Math.max(startedAtMs, segment.startedAtMs + turn.endMs)
        : segment.endedAtMs,
      text,
      speakerTurns: undefined,
      speakerParentId: segment.id,
    };
  });
}
