const DEFAULT_LEASE_MS = 120_000;

export class DisplayMediaLease {
  private recordingActive = false;
  private leaseExpiresAtMs = 0;

  constructor(private readonly leaseMs = DEFAULT_LEASE_MS) {}

  begin(nowMs = Date.now()): number {
    this.leaseExpiresAtMs = nowMs + this.leaseMs;
    return this.leaseExpiresAtMs;
  }

  setRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.leaseExpiresAtMs = 0;
  }

  clear(): void {
    this.leaseExpiresAtMs = 0;
  }

  canGrant(nowMs = Date.now()): boolean {
    return this.recordingActive || this.leaseExpiresAtMs > nowMs;
  }
}

export interface DisplayMediaRequestPolicy {
  canGrantLease: boolean;
  requestProcessId: number | undefined;
  mainFrameProcessId: number | null;
}

export function shouldGrantDisplayMediaRequest(
  policy: DisplayMediaRequestPolicy,
): boolean {
  if (!policy.canGrantLease) {
    return false;
  }
  if (
    policy.mainFrameProcessId !== null &&
    policy.requestProcessId !== policy.mainFrameProcessId
  ) {
    return false;
  }
  return true;
}

const displayMediaLease = new DisplayMediaLease();

export function beginCapturePermissionLease(): number {
  return displayMediaLease.begin();
}

export function clearCapturePermissionLease(): void {
  displayMediaLease.clear();
}

export function setRecordingActive(active: boolean): void {
  displayMediaLease.setRecordingActive(active);
}

export function canGrantDisplayMedia(): boolean {
  return displayMediaLease.canGrant();
}
