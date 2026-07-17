import Store from 'electron-store';

const MAX_PENDING_STARTS = 32;
const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CAPTURE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{32}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export interface PendingRecordingStart {
  meetingId: string;
  captureId: string;
  deviceId: string;
  language: string;
  startedAt: string;
  idempotencyKey: string;
  gatewayFinishIdempotencyKey: string;
}

interface PersistedSnapshot {
  generation: number;
  pending: PendingRecordingStart[];
}

interface PersistShape {
  snapshot?: PersistedSnapshot;
}

interface StoreLike {
  get(key: 'snapshot'): unknown;
  set(key: 'snapshot', value: PersistedSnapshot): void;
}

function validate(value: unknown): PendingRecordingStart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pending recording start entry is invalid');
  }
  const record = value as Partial<PendingRecordingStart>;
  if (typeof record.meetingId !== 'string' || !MEETING_ID_PATTERN.test(record.meetingId)) {
    throw new Error('pending recording start meetingId is invalid');
  }
  if (typeof record.captureId !== 'string' || !CAPTURE_ID_PATTERN.test(record.captureId)) {
    throw new Error('pending recording start captureId is invalid');
  }
  if (typeof record.deviceId !== 'string' || !IDENTIFIER_PATTERN.test(record.deviceId)) {
    throw new Error('pending recording start deviceId is invalid');
  }
  if (typeof record.language !== 'string' || !LANGUAGE_PATTERN.test(record.language)) {
    throw new Error('pending recording start language is invalid');
  }
  if (
    typeof record.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(record.idempotencyKey)
  ) {
    throw new Error('pending recording start idempotencyKey is invalid');
  }
  if (
    typeof record.gatewayFinishIdempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(record.gatewayFinishIdempotencyKey)
  ) {
    throw new Error('pending recording start gatewayFinishIdempotencyKey is invalid');
  }
  if (typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) {
    throw new Error('pending recording start startedAt is invalid');
  }
  return {
    meetingId: record.meetingId,
    captureId: record.captureId,
    deviceId: record.deviceId,
    language: record.language,
    startedAt: new Date(record.startedAt).toISOString(),
    idempotencyKey: record.idempotencyKey,
    gatewayFinishIdempotencyKey: record.gatewayFinishIdempotencyKey,
  };
}

export class RecordingStartOutbox {
  constructor(
    private readonly store: StoreLike = new Store<PersistShape>({
      name: 'recording-start-outbox',
      clearInvalidConfig: false,
    }),
    private readonly recoveryStore: StoreLike = new Store<PersistShape>({
      name: 'recording-start-recovery-outbox',
      clearInvalidConfig: false,
    }),
  ) {}

  private read(store: StoreLike): PersistedSnapshot {
    const value = store.get('snapshot');
    if (value === undefined) {
      return { generation: 0, pending: [] };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pending recording start snapshot is invalid');
    }
    const snapshot = value as Partial<PersistedSnapshot>;
    if (
      typeof snapshot.generation !== 'number' ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation <= 0 ||
      !Array.isArray(snapshot.pending) ||
      snapshot.pending.length > MAX_PENDING_STARTS
    ) {
      throw new Error('pending recording start snapshot is invalid');
    }
    const pending = snapshot.pending.map(validate);
    if (new Set(pending.map((entry) => entry.captureId)).size !== pending.length) {
      throw new Error('pending recording start snapshot contains duplicate captureId');
    }
    return { generation: snapshot.generation, pending };
  }

  private available(): { primary: PersistedSnapshot; recovery: PersistedSnapshot } {
    let primary: PersistedSnapshot | null = null;
    let recovery: PersistedSnapshot | null = null;
    let primaryError: unknown = null;
    let recoveryError: unknown = null;
    try {
      primary = this.read(this.store);
    } catch (error) {
      primaryError = error;
    }
    try {
      recovery = this.read(this.recoveryStore);
    } catch (error) {
      recoveryError = error;
    }
    if (!primary && !recovery) {
      throw new AggregateError(
        [primaryError, recoveryError],
        'pending recording start stores are invalid',
      );
    }
    if ((!primary && recovery?.generation === 0) || (!recovery && primary?.generation === 0)) {
      throw new AggregateError(
        [primaryError, recoveryError],
        'pending recording start store is invalid without a durable peer snapshot',
      );
    }
    return {
      primary: primary ?? { generation: 0, pending: [] },
      recovery: recovery ?? { generation: 0, pending: [] },
    };
  }

  list(): PendingRecordingStart[] {
    const { primary, recovery } = this.available();
    return primary.generation >= recovery.generation ? primary.pending : recovery.pending;
  }

  private persist(pending: PendingRecordingStart[]): void {
    const { primary, recovery } = this.available();
    const generation = Math.max(primary.generation, recovery.generation) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error('pending recording start generation is exhausted');
    }
    const snapshot = { generation, pending: pending.map(validate) };
    try {
      this.recoveryStore.set('snapshot', snapshot);
    } catch (error) {
      throw new AggregateError([error], 'pending recording start recovery could not be persisted');
    }
    try {
      this.store.set('snapshot', snapshot);
    } catch {
      // Recovery has the complete newer snapshot and remains authoritative.
    }
  }

  upsert(value: PendingRecordingStart): PendingRecordingStart {
    const record = validate(value);
    const pending = this.list();
    const index = pending.findIndex((entry) => entry.captureId === record.captureId);
    if (index >= 0) {
      if (JSON.stringify(pending[index]) !== JSON.stringify(record)) {
        throw new Error('pending recording start captureId has conflicting metadata');
      }
      return pending[index];
    }
    if (pending.length >= MAX_PENDING_STARTS) {
      throw new Error('pending recording start outbox capacity exceeded');
    }
    pending.push(record);
    this.persist(pending);
    return record;
  }

  remove(captureId: string): void {
    if (!CAPTURE_ID_PATTERN.test(captureId)) {
      throw new Error('pending recording start captureId is invalid');
    }
    this.persist(this.list().filter((entry) => entry.captureId !== captureId));
  }
}
