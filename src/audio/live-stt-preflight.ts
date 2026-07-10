export type LiveSttPreflightStatus = 'idle' | 'checking' | 'ready' | 'error';

export interface LiveSttPreflightState {
  status: LiveSttPreflightStatus;
  message: string | null;
  checkedAtMs: number | null;
  elapsedMs: number | null;
  stage: string | null;
}

export interface LiveSttPreflightResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  stage: string | null;
}

interface LiveSttPreflightServerEvent {
  type?: unknown;
  stage?: unknown;
  msg?: unknown;
}

export const initialLiveSttPreflightState: LiveSttPreflightState = {
  status: 'idle',
  message: null,
  checkedAtMs: null,
  elapsedMs: null,
  stage: null,
};

function parsePreflightEvent(data: unknown): LiveSttPreflightServerEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as LiveSttPreflightServerEvent;
    return typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function stageLabel(stage: string | null): string {
  if (stage === 'live_model') {
    return 'canli model';
  }
  if (stage === 'final_model') {
    return 'final model';
  }
  return 'model';
}

export function testLiveSttStreamConnection(
  streamUrl: string,
  timeoutMs = 8_000,
): Promise<LiveSttPreflightResult> {
  const startedAtMs = Date.now();
  let latestStage: string | null = null;
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const elapsed = (): number => Math.max(0, Date.now() - startedAtMs);

  return new Promise<LiveSttPreflightResult>((resolve) => {
    const finish = (result: Omit<LiveSttPreflightResult, 'elapsedMs' | 'stage'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const currentSocket = socket;
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.OPEN ||
          currentSocket.readyState === WebSocket.CONNECTING)
      ) {
        currentSocket.close();
      }
      resolve({
        ...result,
        elapsedMs: elapsed(),
        stage: latestStage,
      });
    };

    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        message: `${stageLabel(latestStage)} ${timeoutMs} ms icinde hazir olmadi.`,
      });
    }, timeoutMs);

    try {
      socket = new WebSocket(streamUrl);
    } catch (error) {
      finish({
        ok: false,
        message: `Direct STT baglantisi acilamadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    socket.addEventListener('message', (message) => {
      const event = parsePreflightEvent(message.data);
      if (!event) {
        return;
      }
      if (event.type === 'loading') {
        latestStage = typeof event.stage === 'string' ? event.stage : latestStage;
        return;
      }
      if (event.type === 'ready') {
        finish({
          ok: true,
          message: 'Direct STT stream hazir.',
        });
        return;
      }
      if (event.type === 'error') {
        finish({
          ok: false,
          message:
            typeof event.msg === 'string' && event.msg.trim()
              ? `Direct STT server hatasi: ${event.msg.trim()}`
              : 'Direct STT server hatasi.',
        });
      }
    });

    socket.addEventListener('error', () => {
      finish({
        ok: false,
        message: 'Direct STT baglanti hatasi.',
      });
    });

    socket.addEventListener('close', () => {
      finish({
        ok: false,
        message: 'Direct STT baglantisi hazir olmadan kapandi.',
      });
    });
  });
}
