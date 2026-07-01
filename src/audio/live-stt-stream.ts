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

export interface LiveSttStreamCallbacks {
  onReady?: () => void;
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
  | { type: 'loading' }
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

function progressivePartialSteps(previousText: string, nextText: string): string[] {
  if (!nextText || previousText === nextText) {
    return [];
  }

  if (previousText && !nextText.startsWith(previousText)) {
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
  const ws = new WebSocket(streamUrl);
  const pendingFrames: Float32Array[] = [];
  let ready = false;
  let closedByClient = false;
  const segmentStartedAt = new Map<number, number>();
  const segmentDraftText = new Map<number, string>();
  const pendingPartialTimers = new Map<number, Array<ReturnType<typeof setTimeout>>>();

  const emitError = (message: string): void => {
    callbacks.onError?.(new Error(message));
  };

  const flushPending = (): void => {
    if (!ready || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (pendingFrames.length > 0) {
      const frame = pendingFrames.shift();
      if (frame) {
        ws.send(frameBuffer(frame));
      }
    }
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
      id: `stream:${event.seq}`,
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
    const previousText = segmentDraftText.get(event.seq) ?? '';
    const steps = progressivePartialSteps(previousText, text);
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

  ws.addEventListener('message', (message) => {
    const event = parseEvent(message.data);
    if (!event) {
      return;
    }

    if (event.type === 'ready') {
      ready = true;
      callbacks.onReady?.();
      flushPending();
      return;
    }

    if (event.type === 'partial') {
      const text = segmentText(event);
      if (!text) {
        return;
      }
      const startedAtMs = segmentStartedAt.get(event.seq) ?? Date.now();
      segmentStartedAt.set(event.seq, startedAtMs);
      emitProgressivePartial(event, text, startedAtMs);
      return;
    }

    if (event.type === 'final') {
      const text = event.text.trim();
      if (!text) {
        return;
      }
      const startedAtMs = segmentStartedAt.get(event.seq) ?? Date.now();
      segmentStartedAt.set(event.seq, startedAtMs);
      clearPendingPartials(event.seq);
      segmentDraftText.delete(event.seq);
      callbacks.onTranscriptEvent?.({
        id: `stream:${event.seq}`,
        startedAtMs,
        text,
        status: 'final',
        elapsedMs: event.elapsed_ms ?? null,
        rms: event.rms ?? null,
      });
      return;
    }

    if (event.type === 'error') {
      emitError(`Live STT stream error: ${event.msg}`);
    }
  });

  ws.addEventListener('error', () => {
    emitError('Live STT stream bağlantı hatası.');
  });

  ws.addEventListener('close', () => {
    if (!closedByClient) {
      emitError('Live STT stream kapandı.');
    }
  });

  return {
    send: (samples: Float32Array): void => {
      if (closedByClient || samples.length === 0) {
        return;
      }
      if (ready && ws.readyState === WebSocket.OPEN) {
        ws.send(frameBuffer(samples));
        return;
      }
      pushBounded(pendingFrames, samples);
    },
    close: (): void => {
      closedByClient = true;
      pendingFrames.length = 0;
      clearAllPendingPartials();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
