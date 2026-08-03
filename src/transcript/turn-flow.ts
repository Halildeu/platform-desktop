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

  let tailText = tail
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ');
  // Final indiği anda bayat kuyruk kısa süreliğine aynı kelimeleri taşır
  // (Speechmatics final'i partial'ı kapsar; yeni partial gelene dek eski
  // hipotez satırda kalır). Committed metin kuyruğu zaten kapsıyorsa gizle —
  // bir sonraki partial kuyruğu kaldığı yerden tazeler.
  const lastParagraph = paragraphs.at(-1);
  if (tailText && lastParagraph && coversWords(lastParagraph.text, tailText)) {
    tailText = '';
  }

  return {
    paragraphs,
    tailText,
    tailSegmentIds: tailText ? tail.map((segment) => segment.id) : [],
  };
}

function normalizedWords(text: string): string[] {
  return text
    .toLocaleLowerCase('tr-TR')
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

/** Committed metin, kuyruğun kelimelerini bitişik bir pencere olarak içeriyor mu? */
function coversWords(committedText: string, tailCandidate: string): boolean {
  const haystack = normalizedWords(committedText);
  const needle = normalizedWords(tailCandidate);
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => haystack[index + offset] === word)) {
      return true;
    }
  }
  return false;
}
