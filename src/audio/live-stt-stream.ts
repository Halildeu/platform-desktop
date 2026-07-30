export type LiveSttSegmentStatus = 'draft' | 'final';

export interface LiveSttTranscriptEvent {
  id: string;
  startedAtMs: number;
  text: string;
  status: LiveSttSegmentStatus;
  elapsedMs?: number | null;
  rms?: number | null;
  source?: string | null;
}

export type LiveSttStreamStatus =
  | 'connecting'
  | 'loading'
  | 'ready'
  | 'reconnecting'
  | 'draining'
  | 'degraded'
  | 'closed'
  | 'error';

export interface LiveSttStreamStatusEvent {
  status: LiveSttStreamStatus;
  attempt?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  reason?: string;
  stage?: string;
}

export interface LiveSttStreamCallbacks {
  onReady?: () => void;
  onStatus?: (event: LiveSttStreamStatusEvent) => void;
  onTranscriptEvent?: (event: LiveSttTranscriptEvent) => void;
  onError?: (error: Error) => void;
}

export interface LiveSttStreamConnection {
  send: (samples: Float32Array) => void;
  stop: () => Promise<LiveSttStopResult>;
  close: () => void;
}

export type LiveSttStopReason =
  | 'no-audio'
  | 'final-ack'
  | 'eof-ack'
  | 'drained'
  | 'quiet'
  | 'timeout'
  | 'socket-close'
  | 'socket-error'
  | 'server-error'
  | 'unavailable'
  | 'closed';

export interface LiveSttStopResult {
  state: 'drained' | 'degraded';
  reason: LiveSttStopReason;
  acknowledged: boolean;
}

interface LiveSttServerPartial {
  type: 'partial';
  seq: number;
  confirmed: string;
  tentative: string;
  elapsed_ms?: number;
  rms?: number;
  source?: string;
}

interface LiveSttServerFinal {
  type: 'final';
  seq: number;
  text: string;
  elapsed_ms?: number;
  rms?: number;
}

interface LiveSttServerError {
  type: 'error';
  msg: string;
}

type LiveSttServerEvent =
  | { type: 'loading'; stage?: string }
  | {
      type: 'ready';
      partial_mode?: 'stable-v1';
      capabilities?: string[];
      supports_eof?: boolean;
      terminal_timeout_ms?: number;
    }
  | { type: 'eof_ack' | 'drained' }
  | { type: 'debug' }
  | LiveSttServerPartial
  | LiveSttServerFinal
  | LiveSttServerError;

const MAX_BUFFERED_STREAM_MS = 60_000;
const SAMPLE_RATE = 16_000;
const MAX_BUFFERED_SAMPLES = Math.floor((SAMPLE_RATE * MAX_BUFFERED_STREAM_MS) / 1000);
const PARTIAL_REVEAL_STEP_MS = 70;
const MAX_PROGRESSIVE_PARTIAL_STEPS = 12;
const MAX_RECONNECT_ATTEMPTS = 60;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 2_000;
const ACTIVE_AUDIO_RMS = 0.0008;
const ACTIVE_AUDIO_TRANSCRIPT_STALL_MS = 12_000;
const STOP_DRAIN_AUDIO_RMS = 0.0005;
const STOP_DRAIN_TIMEOUT_FALLBACK_MS = 8_000;
const STOP_DRAIN_TIMEOUT_MAX_MS = 120_000;
const STOP_DRAIN_TRANSPORT_MARGIN_MS = 5_000;
const STOP_FINAL_QUIET_MS = 1_250;
const EOF_CAPABILITY = 'eof';
const MIN_FALLBACK_DRAFT_WORDS = 2;
const MAX_RECENT_FINAL_WORDS = 24;
const ROLLING_CONTINUATION_MIN_PREVIOUS_WORDS = 4;
const ROLLING_CONTINUATION_MIN_NEXT_WORDS = 1;
const CARRY_OVER_DROP_MIN_NEW_WORDS = 3;
const SHORT_FINAL_PRESERVE_MIN_PREVIOUS_WORDS = 8;
const SHORT_FINAL_PRESERVE_MAX_RATIO = 0.55;
const SHORT_FINAL_PRESERVE_MAX_SHARED_RATIO = 0.35;
const SHORT_FINAL_MERGE_MIN_PREVIOUS_WORDS = 5;
const SHORT_FINAL_MERGE_MAX_RATIO = 0.75;
const SHORT_FINAL_MERGE_MIN_SHARED_RATIO = 0.5;
const SAME_OPENER_APPEND_MIN_PREVIOUS_WORDS = 4;
const SAME_OPENER_APPEND_MAX_PREVIOUS_WORDS = 14;
const SAME_OPENER_APPEND_MIN_NEXT_TAIL_WORDS = 3;
const SAME_OPENER_APPEND_MAX_SHARED_RATIO = 0.4;
const SAME_OPENER_TAIL_OVERLAP_MIN_WORDS = 2;
const OVERLAP_SUFFIXES = [
  'lerinizden',
  'larınızdan',
  'lerinizde',
  'larınızda',
  'lerinizin',
  'larınızın',
  'leriniz',
  'larınız',
  'lerimin',
  'larımın',
  'lerimi',
  'larımı',
  'lerim',
  'larım',
  'sının',
  'sinin',
  'sunun',
  'sünün',
  'ının',
  'inin',
  'unun',
  'ünün',
  'sını',
  'sini',
  'sunu',
  'sünü',
  'ımız',
  'imiz',
  'umuz',
  'ümüz',
  'imin',
  'ımın',
  'umun',
  'ümün',
  'nın',
  'nin',
  'nun',
  'nün',
  'mın',
  'min',
  'mun',
  'mün',
  'ını',
  'ini',
  'unu',
  'ünü',
  'nı',
  'ni',
  'nu',
  'nü',
  'yı',
  'yi',
  'yu',
  'yü',
  'sı',
  'si',
  'su',
  'sü',
  'ı',
  'i',
  'u',
  'ü',
];

function parseEvent(data: unknown): LiveSttServerEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    return typeof parsed.type === 'string' ? (parsed as LiveSttServerEvent) : null;
  } catch {
    return null;
  }
}

function negotiatedStopDrainTimeoutMs(terminalTimeoutMs: unknown): number {
  if (
    typeof terminalTimeoutMs !== 'number' ||
    !Number.isFinite(terminalTimeoutMs) ||
    terminalTimeoutMs <= 0
  ) {
    return STOP_DRAIN_TIMEOUT_FALLBACK_MS;
  }
  return Math.min(
    STOP_DRAIN_TIMEOUT_MAX_MS,
    Math.max(
      STOP_DRAIN_TIMEOUT_FALLBACK_MS,
      Math.ceil(terminalTimeoutMs) + STOP_DRAIN_TRANSPORT_MARGIN_MS,
    ),
  );
}

function segmentText(event: LiveSttServerPartial): string {
  return [event.confirmed, event.tentative]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase('tr-TR').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function normalizedWords(words: string[]): string[] {
  return words.map(normalizeWord).filter(Boolean);
}

function sameNormalizedText(left: string, right: string): boolean {
  return (
    normalizedWords(splitWords(left)).join('\u0000') ===
    normalizedWords(splitWords(right)).join('\u0000')
  );
}

function wordFamily(word: string): string {
  let family = word;
  const suffixes = [
    'siniz',
    'sınız',
    'sunuz',
    'sünüz',
    'sin',
    'sın',
    'sun',
    'sün',
    'tim',
    'tım',
    'tum',
    'tüm',
    'dim',
    'dım',
    'dum',
    'düm',
  ];

  for (const suffix of suffixes) {
    if (family.length > suffix.length + 3 && family.endsWith(suffix)) {
      family = family.slice(0, -suffix.length);
      break;
    }
  }

  if (family.length >= 5 && /[aeıioöuü]$/u.test(family)) {
    family = family.slice(0, -1);
  }

  return family;
}

function normalizedFamilies(words: string[]): string[] {
  return normalizedWords(words).map(wordFamily).filter(Boolean);
}

function sharedTokenRatio(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const denominator = Math.min(leftSet.size, rightSet.size);
  if (denominator === 0) {
    return 0;
  }

  let shared = 0;
  leftSet.forEach((word) => {
    if (rightSet.has(word)) {
      shared += 1;
    }
  });

  return shared / denominator;
}

function repeatedFamilyCount(families: string[]): number {
  const counts = new Map<string, number>();
  for (const family of families) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  return counts.size === 0 ? 0 : Math.max(...counts.values());
}

function dominantFamilyCountByFragment(fragments: string[][], dominantFamily: string): number {
  return fragments.filter((fragment) => fragment.includes(dominantFamily)).length;
}

function sentenceFragments(text: string): string[][] {
  return text
    .split(/[.!?…]+|\b(?:ya|yani)\b/giu)
    .map((fragment) => normalizedFamilies(splitWords(fragment)))
    .filter((words) => words.length >= 2);
}

function isLowInformationRepetition(text: string): boolean {
  const words = normalizedWords(splitWords(text));
  if (words.length < 8) {
    return false;
  }

  const uniqueRatio = new Set(words).size / words.length;
  if (uniqueRatio <= 0.45) {
    return true;
  }

  const families = normalizedFamilies(splitWords(text));
  const familyUniqueRatio = new Set(families).size / families.length;
  if (familyUniqueRatio <= 0.5) {
    return true;
  }

  const ngramSizes = words.length < 12 ? [2] : [2, 3];
  return [words, families].some((tokens) =>
    ngramSizes.some((ngramSize) => {
      if (tokens.length < ngramSize) {
        return false;
      }

      const counts = new Map<string, number>();
      for (let index = 0; index <= tokens.length - ngramSize; index += 1) {
        const key = tokens.slice(index, index + ngramSize).join('\u0000');
        const nextCount = (counts.get(key) ?? 0) + 1;
        if (nextCount >= 3) {
          return true;
        }
        counts.set(key, nextCount);
      }
      return false;
    }),
  );
}

function isShortRepeatedDecodeChain(text: string): boolean {
  const families = normalizedFamilies(splitWords(text));
  if (families.length < 6 || families.length >= 8) {
    return false;
  }

  if (new Set(families).size / families.length > 0.75) {
    return false;
  }

  const bigramCounts = new Map<string, number>();
  for (let index = 0; index < families.length - 1; index += 1) {
    const key = families.slice(index, index + 2).join('\u0000');
    const nextCount = (bigramCounts.get(key) ?? 0) + 1;
    if (nextCount >= 2) {
      return true;
    }
    bigramCounts.set(key, nextCount);
  }

  return false;
}

function isRepeatedDecodeChain(text: string): boolean {
  const words = normalizedWords(splitWords(text));
  if (words.length < 8) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const topWordCount = Math.max(...counts.values());
  if (topWordCount >= 4 && topWordCount / words.length >= 0.22) {
    return true;
  }

  const families = normalizedFamilies(splitWords(text));
  const familyCounts = new Map<string, number>();
  for (const family of families) {
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  const topFamilyCount = Math.max(...familyCounts.values());
  const familyUniqueRatio = new Set(families).size / families.length;
  if (topFamilyCount >= 4 && familyUniqueRatio <= 0.65) {
    return true;
  }

  const repeatedBigrams = new Map<string, number>();
  for (let index = 0; index < words.length - 1; index += 1) {
    const key = words.slice(index, index + 2).join('\u0000');
    repeatedBigrams.set(key, (repeatedBigrams.get(key) ?? 0) + 1);
  }

  return [...repeatedBigrams.values()].some((count) => count >= 2) && topFamilyCount >= 3;
}

function isRepeatedAlternativeChain(text: string): boolean {
  const families = normalizedFamilies(splitWords(text));
  const topFamilyCount = repeatedFamilyCount(families);
  if (families.length < 8 || topFamilyCount < 3) {
    return false;
  }

  const fragments = sentenceFragments(text);
  if (fragments.length < 2) {
    return false;
  }

  let similarPairs = 0;
  for (let leftIndex = 0; leftIndex < fragments.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < fragments.length; rightIndex += 1) {
      const left = fragments[leftIndex];
      const right = fragments[rightIndex];
      const shared = sharedTokenRatio(left, right);
      if (shared >= 0.6) {
        similarPairs += 1;
      }
      if (similarPairs >= (fragments.length >= 3 ? 2 : 1)) {
        return true;
      }
    }
  }

  const counts = new Map<string, number>();
  for (const family of families) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return Boolean(
    dominant &&
    topFamilyCount >= 4 &&
    dominantFamilyCountByFragment(fragments, dominant) >= 2 &&
    fragments.some((fragment) => fragment.length <= 4),
  );
}

function isKnownShortArtifact(text: string): boolean {
  const normalized = normalizedWords(splitWords(text)).join(' ');
  return normalized === 'neroba';
}

function isUnstableFinalText(text: string): boolean {
  return (
    isKnownShortArtifact(text) ||
    isLowInformationRepetition(text) ||
    isShortRepeatedDecodeChain(text) ||
    isRepeatedDecodeChain(text) ||
    isRepeatedAlternativeChain(text)
  );
}

function hasSamePrefix(previousText: string, nextText: string): boolean {
  return nextText.toLocaleLowerCase('tr-TR').startsWith(previousText.toLocaleLowerCase('tr-TR'));
}

function contiguousIndex(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    const matches = needle.every((word, index) => haystack[start + index] === word);
    if (matches) {
      return start;
    }
  }

  return -1;
}

function suffixPrefixOverlap(previousWords: string[], nextWords: string[]): number {
  const maxOverlap = Math.min(previousWords.length, nextWords.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const previousTail = previousWords.slice(previousWords.length - size);
    const nextHead = nextWords.slice(0, size);
    if (previousTail.every((word, index) => word === nextHead[index])) {
      return size;
    }
  }

  return 0;
}

function overlapWordFamily(word: string): string {
  let family = word;
  for (let pass = 0; pass < 2; pass += 1) {
    const suffix = OVERLAP_SUFFIXES.find(
      (candidate) => family.length > candidate.length + 2 && family.endsWith(candidate),
    );
    if (!suffix) {
      break;
    }
    family = family.slice(0, -suffix.length);
  }

  return family;
}

function normalizedOverlapFamilies(words: string[]): string[] {
  return normalizedWords(words).map(overlapWordFamily).filter(Boolean);
}

function suffixPrefixSpeechOverlap(previousWords: string[], nextWords: string[]): number {
  const exactOverlap = suffixPrefixOverlap(previousWords, nextWords);
  if (exactOverlap > 0) {
    return exactOverlap;
  }

  // Direct Whisper windows can repeat the previous segment head with Turkish
  // case or possessive suffixes changed. Keep this fuzzy rule multi-word only
  // so intentional single-word repeats stay visible.
  const fuzzyOverlap = suffixPrefixOverlap(
    normalizedOverlapFamilies(previousWords),
    normalizedOverlapFamilies(nextWords),
  );
  return fuzzyOverlap >= 2 ? fuzzyOverlap : 0;
}

function mergeRollingPartial(previousText: string, nextText: string): string {
  const previous = previousText.trim();
  const next = nextText.trim();
  if (!previous || !next) {
    return next || previous;
  }
  if (previous === next || hasSamePrefix(previous, next)) {
    return next;
  }
  if (hasSamePrefix(next, previous)) {
    return previous;
  }

  const previousRawWords = splitWords(previous);
  const nextRawWords = splitWords(next);
  const previousWords = normalizedWords(previousRawWords);
  const nextWords = normalizedWords(nextRawWords);
  const sharedFamilyRatio = sharedTokenRatio(
    normalizedFamilies(previousRawWords),
    normalizedFamilies(nextRawWords),
  );
  const containedAt = contiguousIndex(previousWords, nextWords);
  if (containedAt >= 0) {
    return previous;
  }

  const overlap = suffixPrefixSpeechOverlap(previousWords, nextWords);
  if (overlap > 0) {
    return [...previousRawWords, ...nextRawWords.slice(overlap)].join(' ');
  }

  if (previousWords[0] === nextWords[0]) {
    const nextTailRawWords = nextRawWords.slice(1);
    const nextTailWords = normalizedWords(nextTailRawWords);
    const tailOverlapSize = suffixPrefixSpeechOverlap(previousWords, nextTailWords);
    if (tailOverlapSize >= SAME_OPENER_TAIL_OVERLAP_MIN_WORDS) {
      if (tailOverlapSize >= nextTailRawWords.length) {
        return previous;
      }
      return [...previousRawWords, ...nextTailRawWords.slice(tailOverlapSize)].join(' ');
    }

    if (
      previousWords.length >= SAME_OPENER_APPEND_MIN_PREVIOUS_WORDS &&
      previousWords.length <= SAME_OPENER_APPEND_MAX_PREVIOUS_WORDS &&
      nextTailWords.length >= SAME_OPENER_APPEND_MIN_NEXT_TAIL_WORDS &&
      sharedFamilyRatio <= SAME_OPENER_APPEND_MAX_SHARED_RATIO
    ) {
      return [...previousRawWords, ...nextTailRawWords].join(' ');
    }
    return next;
  }

  const nextLooksLikeContinuation =
    previousWords.length >= ROLLING_CONTINUATION_MIN_PREVIOUS_WORDS &&
    nextWords.length >= ROLLING_CONTINUATION_MIN_NEXT_WORDS &&
    sharedFamilyRatio < 0.5;
  const nextLooksLikeGrowingWindow =
    nextWords.length >= 3 &&
    nextWords.length > previousWords.length &&
    (previousWords.length >= 2 || nextWords.length >= previousWords.length + 2);

  if (nextLooksLikeContinuation || nextLooksLikeGrowingWindow) {
    return [...previousRawWords, ...nextRawWords].join(' ');
  }

  return next;
}

function mergeFinalTranscript(previousText: string, finalText: string): string {
  const previous = previousText.trim();
  const final = finalText.trim();
  if (!previous || !final) {
    return final || previous;
  }
  if (previous === final || hasSamePrefix(previous, final)) {
    return final;
  }
  if (hasSamePrefix(final, previous)) {
    return previous;
  }

  const previousRawWords = splitWords(previous);
  const finalRawWords = splitWords(final);
  const previousWords = normalizedWords(previousRawWords);
  const finalWords = normalizedWords(finalRawWords);

  const containedAt = contiguousIndex(previousWords, finalWords);
  if (containedAt >= 0) {
    return [
      ...previousRawWords.slice(0, containedAt),
      ...finalRawWords,
      ...previousRawWords.slice(containedAt + finalRawWords.length),
    ].join(' ');
  }
  if (contiguousIndex(finalWords, previousWords) >= 0) {
    return final;
  }

  const overlap = suffixPrefixSpeechOverlap(previousWords, finalWords);
  if (overlap >= 2) {
    return [...previousRawWords, ...finalRawWords.slice(overlap)].join(' ');
  }

  if (shouldPreserveStableDraftForShortFinal(previousRawWords, finalRawWords)) {
    return previous;
  }

  const draftPreservingMerge = mergeShortFinalWithoutDroppingDraft(previousRawWords, finalRawWords);
  if (draftPreservingMerge) {
    return draftPreservingMerge;
  }

  if (finalWords.length <= previousWords.length + 1 && finalWords.length <= 3) {
    return previous;
  }

  return final;
}

function shouldPreserveStableDraftForShortFinal(
  previousRawWords: string[],
  finalRawWords: string[],
): boolean {
  if (previousRawWords.length < SHORT_FINAL_PRESERVE_MIN_PREVIOUS_WORDS) {
    return false;
  }
  if (finalRawWords.length === 0) {
    return true;
  }
  if (finalRawWords.length / previousRawWords.length > SHORT_FINAL_PRESERVE_MAX_RATIO) {
    return false;
  }

  const sharedFamilyRatio = sharedTokenRatio(
    normalizedFamilies(previousRawWords),
    normalizedFamilies(finalRawWords),
  );
  return sharedFamilyRatio <= SHORT_FINAL_PRESERVE_MAX_SHARED_RATIO;
}

function mergeShortFinalWithoutDroppingDraft(
  previousRawWords: string[],
  finalRawWords: string[],
): string | null {
  if (
    previousRawWords.length < SHORT_FINAL_MERGE_MIN_PREVIOUS_WORDS ||
    finalRawWords.length === 0 ||
    finalRawWords.length >= previousRawWords.length ||
    finalRawWords.length / previousRawWords.length > SHORT_FINAL_MERGE_MAX_RATIO
  ) {
    return null;
  }

  const previousFamilies = normalizedOverlapFamilies(previousRawWords);
  const finalFamilies = normalizedOverlapFamilies(finalRawWords);
  const sharedFamilyRatio = sharedTokenRatio(previousFamilies, finalFamilies);
  if (sharedFamilyRatio < SHORT_FINAL_MERGE_MIN_SHARED_RATIO) {
    return null;
  }

  let lastSharedFinalIndex = -1;
  for (let index = finalFamilies.length - 1; index >= 0; index -= 1) {
    if (previousFamilies.includes(finalFamilies[index])) {
      lastSharedFinalIndex = index;
      break;
    }
  }

  const finalTail = finalRawWords.slice(lastSharedFinalIndex + 1);
  return [...previousRawWords, ...finalTail].join(' ');
}

function dropLeadingTailOverlap(
  previousText: string,
  nextText: string,
  options: { allowSingleWord?: boolean } = {},
): string {
  const previous = previousText.trim();
  const next = nextText.trim();
  if (!previous || !next) {
    return next;
  }

  const previousRawWords = splitWords(previous);
  const nextRawWords = splitWords(next);
  const previousWords = normalizedWords(previousRawWords);
  const nextWords = normalizedWords(nextRawWords);
  const overlap = suffixPrefixSpeechOverlap(previousWords, nextWords);
  if (overlap <= 0) {
    return next;
  }
  if (overlap === 1 && previousWords.length > 1 && !options.allowSingleWord) {
    return next;
  }
  if (overlap >= nextRawWords.length) {
    return next;
  }
  if (overlap > 1 && nextRawWords.length - overlap < CARRY_OVER_DROP_MIN_NEW_WORDS) {
    return next;
  }
  return nextRawWords.slice(overlap).join(' ');
}

function appendRecentFinalText(previousText: string, emittedText: string): string {
  return [...splitWords(previousText), ...splitWords(emittedText)]
    .slice(-MAX_RECENT_FINAL_WORDS)
    .join(' ');
}

function progressivePartialSteps(previousText: string, nextText: string): string[] {
  if (!nextText || previousText === nextText) {
    return [];
  }

  if (previousText && !hasSamePrefix(previousText, nextText)) {
    return [nextText];
  }

  const previousWords = splitWords(previousText);
  const nextWords = splitWords(nextText);
  if (nextWords.length <= previousWords.length + 1) {
    return [nextText];
  }

  const steps = nextWords
    .slice(previousWords.length)
    .map((_word, index) => nextWords.slice(0, previousWords.length + index + 1).join(' '));

  if (steps.length <= MAX_PROGRESSIVE_PARTIAL_STEPS) {
    return steps;
  }

  return [...steps.slice(0, MAX_PROGRESSIVE_PARTIAL_STEPS - 1), nextText];
}

function frameBuffer(samples: Float32Array): ArrayBuffer {
  return samples.buffer.slice(
    samples.byteOffset,
    samples.byteOffset + samples.byteLength,
  ) as ArrayBuffer;
}

function bufferedSampleCount(frames: Float32Array[]): number {
  return frames.reduce((total, frame) => total + frame.length, 0);
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function pushBounded(frames: Float32Array[], samples: Float32Array): void {
  frames.push(samples.slice());
  while (bufferedSampleCount(frames) > MAX_BUFFERED_SAMPLES && frames.length > 0) {
    frames.shift();
  }
}

export function connectLiveSttStream(
  streamUrl: string,
  callbacks: LiveSttStreamCallbacks = {},
): LiveSttStreamConnection {
  let ws: WebSocket | null = null;
  const pendingFrames: Float32Array[] = [];
  let ready = false;
  let closedByClient = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let stablePartialMode = false;
  let eofSupported = false;
  let stopDrainTimeoutMs = STOP_DRAIN_TIMEOUT_FALLBACK_MS;
  let eofRequested = false;
  let activeAudioSinceLastFinal = false;
  let sentActiveAudio = false;
  let drainedObserved = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let stopQuietTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<LiveSttStopResult> | null = null;
  let resolveStop: ((result: LiveSttStopResult) => void) | null = null;
  let detachSocketListeners: (() => void) | null = null;
  let closeReconnectReason: string | null = null;
  let lastUsableTranscriptAtMs: number | null = null;
  const segmentStartedAt = new Map<number, number>();
  const segmentDraftText = new Map<number, string>();
  const segmentKnownText = new Map<number, string>();
  const segmentGeneration = new Map<number, number>();
  const segmentFinalText = new Map<number, string>();
  const finalizedSequences = new Set<number>();
  const pendingPartialTimers = new Map<number, Array<ReturnType<typeof setTimeout>>>();
  let lastEmittedFinalText = '';
  let recentEmittedFinalText = '';
  let closedStatusEmitted = false;

  const emitError = (message: string): void => {
    callbacks.onError?.(new Error(message));
  };

  const emitStatus = (event: LiveSttStreamStatusEvent): void => {
    callbacks.onStatus?.(event);
  };

  const markUsableTranscript = (): void => {
    lastUsableTranscriptAtMs = Date.now();
  };

  const emitClosed = (reason?: string): void => {
    if (closedStatusEmitted) {
      return;
    }
    closedStatusEmitted = true;
    emitStatus({ status: 'closed', reason });
  };

  const clearStopTimers = (): void => {
    if (stopTimeoutTimer) {
      clearTimeout(stopTimeoutTimer);
      stopTimeoutTimer = null;
    }
    if (stopQuietTimer) {
      clearTimeout(stopQuietTimer);
      stopQuietTimer = null;
    }
  };

  const teardown = (reason?: string): void => {
    closedByClient = true;
    ready = false;
    pendingFrames.length = 0;
    clearAllPendingPartials();
    clearStopTimers();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    detachSocketListeners?.();
    detachSocketListeners = null;
    const socket = ws;
    ws = null;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close();
    }
    emitClosed(reason);
  };

  const settleStop = (result: LiveSttStopResult): void => {
    const settle = resolveStop;
    if (!settle) {
      return;
    }
    resolveStop = null;
    if (result.state === 'degraded') {
      const reason =
        result.reason === 'timeout'
          ? 'Direct STT stop drain zaman aşımına uğradı; geç final doğrulanamadı.'
          : `Direct STT stop drain tamamlanamadı: ${result.reason}`;
      emitStatus({ status: 'degraded', reason });
      emitError(reason);
    }
    teardown(result.reason);
    settle(result);
  };

  const scheduleQuietStop = (): void => {
    if (!stopping || !resolveStop) {
      return;
    }
    if (stopQuietTimer) {
      clearTimeout(stopQuietTimer);
    }
    stopQuietTimer = setTimeout(() => {
      stopQuietTimer = null;
      settleStop({
        state: 'degraded',
        reason: 'quiet',
        acknowledged: false,
      });
    }, STOP_FINAL_QUIET_MS);
  };

  const requestEofIfSupported = (): void => {
    const socket = ws;
    if (
      !stopping ||
      !eofSupported ||
      eofRequested ||
      !ready ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    eofRequested = true;
    socket.send(JSON.stringify({ type: 'eof' }));
  };

  const flushPending = (): void => {
    const socket = ws;
    if (!ready || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    while (pendingFrames.length > 0) {
      const frame = pendingFrames.shift();
      if (frame) {
        socket.send(frameBuffer(frame));
      }
    }
  };

  const reconnectDelay = (): number =>
    Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );

  const connect = (): void => {
    if (closedByClient || stopping) {
      return;
    }

    detachSocketListeners?.();
    detachSocketListeners = null;
    ready = false;
    emitStatus(reconnectAttempts > 0 ? { status: 'reconnecting' } : { status: 'connecting' });
    let socket: WebSocket;
    try {
      socket = new WebSocket(streamUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emitStatus({ status: 'error', reason });
      emitError(`Live STT stream kurulamadı: ${reason}`);
      return;
    }
    ws = socket;

    const scheduleReconnect = (reason: string): void => {
      if (closedByClient || stopping || ws !== socket || reconnectTimer) {
        return;
      }

      ready = false;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        emitStatus({ status: 'error', reason });
        emitError(`Live STT stream yeniden kurulamadı: ${reason}`);
        return;
      }

      reconnectAttempts += 1;
      const retryDelayMs = reconnectDelay();
      emitStatus({
        status: 'reconnecting',
        attempt: reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        retryDelayMs,
        reason,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, retryDelayMs);
    };

    const handleMessage = (message: MessageEvent): void => {
      const event = parseEvent(message.data);
      if (!event) {
        return;
      }

      if (event.type === 'ready') {
        ready = true;
        stablePartialMode = event.partial_mode === 'stable-v1';
        eofSupported =
          event.supports_eof === true || event.capabilities?.includes(EOF_CAPABILITY) === true;
        stopDrainTimeoutMs = negotiatedStopDrainTimeoutMs(event.terminal_timeout_ms);
        reconnectAttempts = 0;
        lastUsableTranscriptAtMs = Date.now();
        if (!stopping) {
          emitStatus({ status: 'ready' });
          callbacks.onReady?.();
        }
        flushPending();
        requestEofIfSupported();
        return;
      }

      if (event.type === 'loading') {
        emitStatus({ status: 'loading', stage: event.stage });
        return;
      }

      if (event.type === 'partial') {
        const text = segmentText(event);
        if (!text) {
          return;
        }
        ensureOpenSegment(event.seq);
        const startedAtMs = segmentStartedAt.get(event.seq) ?? Date.now();
        segmentStartedAt.set(event.seq, startedAtMs);
        emitProgressivePartial(event, text, startedAtMs);
        return;
      }

      if (event.type === 'final') {
        if (stopping && !eofSupported) {
          scheduleQuietStop();
        }
        if (finalizedSequences.has(event.seq)) {
          const previousFinal = segmentFinalText.get(event.seq);
          if (previousFinal && sameNormalizedText(previousFinal, event.text)) {
            return;
          }
          ensureOpenSegment(event.seq);
        }
        const previousText =
          segmentKnownText.get(event.seq) ?? segmentDraftText.get(event.seq) ?? '';
        let finalText = event.text;
        if (isUnstableFinalText(event.text)) {
          const fallbackAllowedForKnownArtifact =
            isKnownShortArtifact(event.text) && Boolean(previousText);
          if (
            !previousText ||
            (!fallbackAllowedForKnownArtifact &&
              splitWords(previousText).length < MIN_FALLBACK_DRAFT_WORDS) ||
            isUnstableFinalText(previousText)
          ) {
            return;
          }
          finalText = previousText;
        }
        let text = mergeFinalTranscript(previousText, finalText);
        const preservesVisibleDraft = Boolean(previousText) && hasSamePrefix(previousText, text);
        if (!text || (isUnstableFinalText(text) && !preservesVisibleDraft)) {
          return;
        }
        text = dropLeadingTailOverlap(recentEmittedFinalText || lastEmittedFinalText, text, {
          allowSingleWord: true,
        });
        if (!text) {
          return;
        }
        const startedAtMs = segmentStartedAt.get(event.seq) ?? Date.now();
        segmentStartedAt.set(event.seq, startedAtMs);
        clearPendingPartials(event.seq);
        segmentDraftText.delete(event.seq);
        segmentKnownText.delete(event.seq);
        finalizedSequences.add(event.seq);
        segmentFinalText.set(event.seq, text);
        lastEmittedFinalText = text;
        recentEmittedFinalText = appendRecentFinalText(recentEmittedFinalText, text);
        activeAudioSinceLastFinal = false;
        markUsableTranscript();
        callbacks.onTranscriptEvent?.({
          id: segmentId(event.seq),
          startedAtMs,
          text,
          status: 'final',
          elapsedMs: event.elapsed_ms ?? null,
          rms: event.rms ?? null,
        });
        return;
      }

      if (event.type === 'drained') {
        drainedObserved = true;
        if (stopping) {
          settleStop({ state: 'drained', reason: 'drained', acknowledged: true });
        }
        return;
      }

      if (event.type === 'eof_ack') {
        return;
      }

      if (event.type === 'error') {
        if (stopping) {
          settleStop({ state: 'degraded', reason: 'server-error', acknowledged: false });
          return;
        }
        scheduleReconnect(event.msg);
      }
    };

    const handleError = (): void => {
      if (stopping) {
        settleStop({ state: 'degraded', reason: 'socket-error', acknowledged: false });
        return;
      }
      scheduleReconnect('bağlantı hatası');
    };

    const handleClose = (): void => {
      if (stopping) {
        if (drainedObserved) {
          settleStop({
            state: 'drained',
            reason: 'drained',
            acknowledged: true,
          });
        } else {
          settleStop({ state: 'degraded', reason: 'socket-close', acknowledged: false });
        }
        return;
      }
      const reason = closeReconnectReason ?? 'bağlantı kapandı';
      closeReconnectReason = null;
      scheduleReconnect(reason);
      detachSocketListeners?.();
      detachSocketListeners = null;
    };

    socket.addEventListener('message', handleMessage);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);
    const detach = (): void => {
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
      if (detachSocketListeners === detach) {
        detachSocketListeners = null;
      }
    };
    detachSocketListeners = detach;
  };

  const shouldRestartForTranscriptStall = (samples: Float32Array): boolean => {
    const socket = ws;
    if (!ready || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (rms(samples) < ACTIVE_AUDIO_RMS) {
      return false;
    }
    const lastUsableAt = lastUsableTranscriptAtMs ?? Date.now();
    return Date.now() - lastUsableAt >= ACTIVE_AUDIO_TRANSCRIPT_STALL_MS;
  };

  const segmentId = (seq: number): string => {
    const generation = segmentGeneration.get(seq) ?? 0;
    return generation === 0 ? `stream:${seq}` : `stream:${seq}:${generation}`;
  };

  const ensureOpenSegment = (seq: number): void => {
    if (!finalizedSequences.has(seq)) {
      return;
    }

    const nextGeneration = (segmentGeneration.get(seq) ?? 0) + 1;
    segmentGeneration.set(seq, nextGeneration);
    finalizedSequences.delete(seq);
    segmentStartedAt.delete(seq);
    segmentDraftText.delete(seq);
    segmentKnownText.delete(seq);
    segmentFinalText.delete(seq);
    clearPendingPartials(seq);
  };

  const clearPendingPartials = (seq: number): void => {
    const timers = pendingPartialTimers.get(seq) ?? [];
    timers.forEach((timer) => clearTimeout(timer));
    pendingPartialTimers.delete(seq);
  };

  const clearAllPendingPartials = (): void => {
    pendingPartialTimers.forEach((timers) => {
      timers.forEach((timer) => clearTimeout(timer));
    });
    pendingPartialTimers.clear();
  };

  const emitPartial = (event: LiveSttServerPartial, text: string, startedAtMs: number): void => {
    segmentDraftText.set(event.seq, text);
    markUsableTranscript();
    callbacks.onTranscriptEvent?.({
      id: segmentId(event.seq),
      startedAtMs,
      text,
      status: 'draft',
      elapsedMs: event.elapsed_ms ?? null,
      rms: event.rms ?? null,
      source: event.source ?? null,
    });
  };

  const emitProgressivePartial = (
    event: LiveSttServerPartial,
    text: string,
    startedAtMs: number,
  ): void => {
    clearPendingPartials(event.seq);
    const previousDisplayText = segmentDraftText.get(event.seq) ?? '';
    const previousKnownText = segmentKnownText.get(event.seq) ?? previousDisplayText;
    const nextKnownText = stablePartialMode ? text : mergeRollingPartial(previousKnownText, text);
    segmentKnownText.set(event.seq, nextKnownText);
    const steps = progressivePartialSteps(previousDisplayText, nextKnownText);
    if (steps.length === 0) {
      return;
    }

    emitPartial(event, steps[0], startedAtMs);
    const scheduledSteps = steps.slice(1);
    const timers = scheduledSteps.map((step, index) =>
      setTimeout(
        () => {
          emitPartial(event, step, startedAtMs);
          if (index === scheduledSteps.length - 1) {
            pendingPartialTimers.delete(event.seq);
          }
        },
        PARTIAL_REVEAL_STEP_MS * (index + 1),
      ),
    );
    if (timers.length > 0) {
      pendingPartialTimers.set(event.seq, timers);
    }
  };

  connect();

  return {
    send: (samples: Float32Array): void => {
      if (closedByClient || stopping || samples.length === 0) {
        return;
      }
      if (rms(samples) >= STOP_DRAIN_AUDIO_RMS) {
        sentActiveAudio = true;
        activeAudioSinceLastFinal = true;
      }
      const socket = ws;
      if (ready && socket?.readyState === WebSocket.OPEN) {
        if (shouldRestartForTranscriptStall(samples)) {
          pushBounded(pendingFrames, samples);
          closeReconnectReason = 'transcript akışı gecikti';
          socket.close();
          return;
        }
        socket.send(frameBuffer(samples));
        return;
      }
      pushBounded(pendingFrames, samples);
    },
    stop: (): Promise<LiveSttStopResult> => {
      if (stopPromise) {
        return stopPromise;
      }

      stopPromise = new Promise<LiveSttStopResult>((resolve) => {
        resolveStop = resolve;
      });
      stopping = true;
      emitStatus({ status: 'draining' });
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const socket = ws;
      if (!socket) {
        settleStop({ state: 'degraded', reason: 'unavailable', acknowledged: false });
        return stopPromise;
      }
      if (socket.readyState === WebSocket.CLOSED) {
        settleStop({ state: 'degraded', reason: 'socket-close', acknowledged: false });
        return stopPromise;
      }
      if (!sentActiveAudio) {
        settleStop({ state: 'drained', reason: 'no-audio', acknowledged: false });
        return stopPromise;
      }

      stopTimeoutTimer = setTimeout(() => {
        stopTimeoutTimer = null;
        settleStop({ state: 'degraded', reason: 'timeout', acknowledged: false });
      }, stopDrainTimeoutMs);

      flushPending();
      requestEofIfSupported();
      if (!activeAudioSinceLastFinal && finalizedSequences.size > 0) {
        scheduleQuietStop();
      }
      return stopPromise;
    },
    close: (): void => {
      if (resolveStop) {
        settleStop({ state: 'degraded', reason: 'closed', acknowledged: false });
        return;
      }
      teardown('closed');
    },
  };
}
