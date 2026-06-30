import {
  readTranscriptEvents,
  type GatewayConfig,
  type TranscriptGatewayEvent,
} from './gateway-client';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ERROR_RETRY_MS = 3_000;
const DEFAULT_LIMIT = 50;
const MAX_IMMEDIATE_DRAIN_POLLS = 20;
const DRAIN_BACKOFF_MS = 25;

export interface TranscriptEventSubscriptionArgs {
  cfg: GatewayConfig;
  sessionId: string;
  getJwt: () => string | Promise<string>;
  onEvent: (event: TranscriptGatewayEvent) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
  errorRetryMs?: number;
  limit?: number;
}

export class TranscriptEventSubscription {
  private cursor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private stopped = true;
  private lastErrorMessage: string | null = null;
  private consecutiveDrainPolls = 0;

  constructor(private readonly args: TranscriptEventSubscriptionArgs) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
    this.abortController?.abort();
    this.abortController = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const page = await readTranscriptEvents(
        this.args.cfg,
        await this.args.getJwt(),
        this.args.sessionId,
        {
          after: this.cursor,
          limit: this.args.limit ?? DEFAULT_LIMIT,
          signal: controller.signal,
        },
      );
      this.cursor = page.nextCursor ?? this.cursor;
      this.lastErrorMessage = null;
      for (const event of page.events) {
        this.args.onEvent(event);
      }
      this.schedule(this.nextPollDelay(page.hasMore));
    } catch (err) {
      if (this.stopped || controller.signal.aborted) {
        return;
      }
      this.consecutiveDrainPolls = 0;
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message !== this.lastErrorMessage) {
        this.lastErrorMessage = error.message;
        this.args.onError?.(error);
      }
      this.schedule(this.args.errorRetryMs ?? DEFAULT_ERROR_RETRY_MS);
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private nextPollDelay(hasMore: boolean): number {
    if (!hasMore) {
      this.consecutiveDrainPolls = 0;
      return this.args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    }
    this.consecutiveDrainPolls += 1;
    if (this.consecutiveDrainPolls <= MAX_IMMEDIATE_DRAIN_POLLS) {
      return 0;
    }
    return DRAIN_BACKOFF_MS;
  }
}
