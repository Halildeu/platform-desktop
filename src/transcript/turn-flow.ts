import type { TranscriptSegment } from './session-transcript';

/**
 * Akıcı görünüm (fluent view) — bir konuşma turunun segmentlerini okunabilir
 * akış paragraflarına katlar (Faz 24 RT revizyonu, gitops#3419).
 *
 * Sektör konvansiyonu (Speechmatics/Deepgram/Azure — bkz. gitops
 * docs/faz24-realtime-stt-industry-survey.md §7): commit edilmiş parçalar
 * cümle-sonu noktalama KESİNLEŞENE kadar aynı görsel paragrafta akar; süre
 * doldu diye satır kırılmaz. Konuşmacı/tur sınırı zaten üst katmanda
 * (buildTranscriptTurns) — burada yalnız tur İÇİ satır disiplini kurulur.
 *
 * Kuyruk (tail): turun SONUNDAKİ ardışık draft/stabilizing segmentler henüz
 * commit edilmemiş canlı hipotezdir; ayrı paragraf değil, son paragrafın
 * devamı olarak soluk stilde yerinde-güncellenerek gösterilir (partial
 * replace-in-place). Aradaki draft'lar (REST fallback pencereleri) içerik
 * kaybetmemek için akışa katılır, paragraf yalnız "pending" işaretlenir.
 */

export interface TurnFlowParagraph {
  /** İlk segmentin id'sinden türetilen kararlı anahtar. */
  id: string;
  text: string;
  segmentIds: string[];
  /** Paragrafta commit edilmemiş (draft/stabilizing) içerik var. */
  pending: boolean;
}

export interface TurnFlow {
  paragraphs: TurnFlowParagraph[];
  /** Canlı hipotez — boş string ise kuyruk yok. */
  tailText: string;
  tailSegmentIds: string[];
}

/**
 * Cümle-sonu: nokta/ünlem/soru/üç-nokta + opsiyonel kapanış tırnak/parantez.
 * Kısaltma noktaları ("Sn." gibi) burada cümle sonu SAYILIR — asistan değil
 * verbatim akış; yanlış-birleştirmektense yanlış-bölmek güvenli taraftır ve
 * assembler zaten noktalama üretimini STT'ye bırakır.
 */
const SENTENCE_TERMINATOR = /[.!?…]["'”’»)\]]*$/u;

export function endsWithSentenceTerminator(text: string): boolean {
  return SENTENCE_TERMINATOR.test(text.trim());
}

const COMMITTED_STATUSES: ReadonlySet<TranscriptSegment['status']> = new Set([
  'utterance',
  'final',
  'revised',
]);

function isPendingStatus(status: TranscriptSegment['status']): boolean {
  return !COMMITTED_STATUSES.has(status);
}

export function buildTurnFlow(segments: readonly TranscriptSegment[]): TurnFlow {
  const body = [...segments];
  const tail: TranscriptSegment[] = [];
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (isPendingStatus(last.status)) {
      tail.unshift(body.pop() as TranscriptSegment);
    } else {
      break;
    }
  }

  const paragraphs: TurnFlowParagraph[] = [];
  let texts: string[] = [];
  let ids: string[] = [];
  let pending = false;

  const flush = (): void => {
    if (texts.length > 0) {
      paragraphs.push({
        id: `flow:${ids[0]}`,
        text: texts.join(' '),
        segmentIds: [...ids],
        pending,
      });
    }
    texts = [];
    ids = [];
    pending = false;
  };

  for (const segment of body) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }
    texts.push(text);
    ids.push(segment.id);
    pending = pending || isPendingStatus(segment.status);
    if (endsWithSentenceTerminator(text)) {
      flush();
    }
  }
  flush();

  return {
    paragraphs,
    tailText: tail
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(' '),
    tailSegmentIds: tail.map((segment) => segment.id),
  };
}
