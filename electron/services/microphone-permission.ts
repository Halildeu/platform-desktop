export type MicrophonePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

export interface MicrophonePermissionState {
  status: MicrophonePermissionStatus;
  granted: boolean;
  canRequest: boolean;
}

type ReadPermissionStatus = () => MicrophonePermissionStatus;
type RequestPermission = () => Promise<boolean>;

export class MicrophonePermissionBroker {
  private requestInFlight: Promise<MicrophonePermissionState> | null = null;
  private sessionDecision: MicrophonePermissionState | null = null;

  constructor(
    private readonly platform: string,
    private readonly readPermissionStatus: ReadPermissionStatus,
    private readonly requestPermission: RequestPermission,
  ) {}

  status(): MicrophonePermissionState {
    if (this.platform !== 'darwin') {
      return { status: 'unknown', granted: false, canRequest: true };
    }

    const status = this.readPermissionStatus();
    if (status === 'not-determined' && this.sessionDecision) {
      return this.sessionDecision;
    }
    return {
      status,
      granted: status === 'granted',
      canRequest: status === 'not-determined',
    };
  }

  request(): Promise<MicrophonePermissionState> {
    const current = this.status();
    if (this.platform !== 'darwin' || current.status !== 'not-determined') {
      return Promise.resolve(current);
    }
    if (this.requestInFlight) {
      return this.requestInFlight;
    }

    this.requestInFlight = this.requestPermission()
      .then((granted) => {
        const refreshed = this.status();
        if (refreshed.status !== 'not-determined') {
          return refreshed;
        }

        this.sessionDecision = {
          status: granted ? 'granted' : 'denied',
          granted,
          canRequest: false,
        };
        return this.sessionDecision;
      })
      .finally(() => {
        this.requestInFlight = null;
      });
    return this.requestInFlight;
  }
}
