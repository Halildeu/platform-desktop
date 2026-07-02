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
  close: () => void;
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
  | { type: 'ready' }
  | { type: 'debug' }
  | LiveSttServerPartial
  | LiveSttServerFinal
  | LiveSttServerError;

const MAX_BUFFERED_STREAM_MS = 3_000;
const SAMPLE_RATE = 16_000;
const MAX_BUFFERED_SAMPLES = Math.floor((SAMPLE_RATE * MAX_BUFFERED_STREAM_MS) / 1000);
const PARTIAL_REVEAL_STEP_MS = 70;
const MAX_PROGRESSIVE_PARTIAL_STEPS = 12;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 2_000;

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

function isUnstableFinalText(text: string): boolean {
  return isLowInformationRepetition(text) || isRepeatedDecodeChain(text);
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
  const containedAt = contiguousIndex(previousWords, nextWords);
  if (containedAt >= 0) {
    return previous;
  }

  const overlap = suffixPrefixOverlap(previousWords, nextWords);
  if (overlap > 0) {
    return [...previousRawWords, ...nextRawWords.slice(overlap)].join(' ');
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

  const overlap = suffixPrefixOverlap(previousWords, finalWords);
  if (overlap >= 2) {
    return [...previousRawWords, ...finalRawWords.slice(overlap)].join(' ');
  }

  return final;
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
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const segmentStartedAt = new Map<number, number>();
  const segmentDraftText = new Map<number, string>();
  const segmentKnownText = new Map<number, string>();
  const segmentGeneration = new Map<number, number>();
  const segmentFinalText = new Map<number, string>();
  const finalizedSequences = new Set<number>();
  const pendingPartialTimers = new Map<number, Array<ReturnType<typeof setTimeout>>>();

  const emitError = (message: string): void => {
    callbacks.onError?.(new Error(message));
  };

  const emitStatus = (event: LiveSttStreamStatusEvent): void => {
    callbacks.onStatus?.(event);
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
    if (closedByClient) {
      return;
    }

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
      if (closedByClient || ws !== socket || reconnectTimer) {
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

    socket.addEventListener('message', (message) => {
      const event = parseEvent(message.data);
      if (!event) {
        return;
      }

      if (event.type === 'ready') {
        ready = true;
        reconnectAttempts = 0;
        emitStatus({ status: 'ready' });
        callbacks.onReady?.();
        flushPending();
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
          if (!previousText || isUnstableFinalText(previousText)) {
            return;
          }
          finalText = previousText;
        }
        const text = mergeFinalTranscript(previousText, finalText);
        if (!text || isUnstableFinalText(text)) {
          return;
        }
        const startedAtMs = segmentStartedAt.get(event.seq) ?? Date.now();
        segmentStartedAt.set(event.seq, startedAtMs);
        clearPendingPartials(event.seq);
        segmentDraftText.delete(event.seq);
        segmentKnownText.delete(event.seq);
        finalizedSequences.add(event.seq);
        segmentFinalText.set(event.seq, text);
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

      if (event.type === 'error') {
        scheduleReconnect(event.msg);
      }
    });

    socket.addEventListener('error', () => {
      scheduleReconnect('bağlantı hatası');
    });

    socket.addEventListener('close', () => {
      scheduleReconnect('bağlantı kapandı');
    });
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
    const mergedText = mergeRollingPartial(previousKnownText, text);
    segmentKnownText.set(event.seq, mergedText);
    const steps = progressivePartialSteps(previousDisplayText, mergedText);
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
      if (closedByClient || samples.length === 0) {
        return;
      }
      const socket = ws;
      if (ready && socket?.readyState === WebSocket.OPEN) {
        socket.send(frameBuffer(samples));
        return;
      }
      pushBounded(pendingFrames, samples);
    },
    close: (): void => {
      closedByClient = true;
      pendingFrames.length = 0;
      clearAllPendingPartials();
      emitStatus({ status: 'closed' });
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const socket = ws;
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close();
      }
    },
  };
}
