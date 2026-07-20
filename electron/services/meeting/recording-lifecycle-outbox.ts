import Store from 'electron-store';

const MAX_PENDING_LIFECYCLES = 32;
const MAX_UNRECONCILABLE_LIFECYCLES = 128;
const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EXTERNAL_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface PendingRecordingLifecycle {
  meetingId: string;
  externalSessionId: string;
  startedAt: string;
  endedAt: string | null;
  gatewayFinishPending: boolean;
  gatewayFinishIdempotencyKey?: string | null;
}

export interface UnreconcilableRecordingLifecycle {
  meetingId: string;
  externalSessionId: string;
  startedAt: string;
  endedAt: string;
  gatewayFinishIdempotencyKey: string | null;
  terminalReason: 'gateway-session-not-found';
  gatewayStatus: 404;
  gatewayCode: 'AUDIO_GATEWAY_SESSION_NOT_FOUND';
  retryable: false;
  recordedAt: string;
  attemptCount: number;
}

interface PersistShape {
  snapshot?: PersistedSnapshot;
  pending?: PendingRecordingLifecycle[];
}

interface PersistedSnapshot {
  generation: number;
  pending: PendingRecordingLifecycle[];
  unreconcilable?: UnreconcilableRecordingLifecycle[];
}

interface StoreLike {
  get(key: 'snapshot' | 'pending'): unknown;
  set(key: 'snapshot', value: PersistedSnapshot): void;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not an ISO instant`);
  }
  return new Date(value).toISOString();
}

function validate(value: unknown): PendingRecordingLifecycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pending recording lifecycle entry is invalid');
  }
  const record = value as Partial<PendingRecordingLifecycle>;
  if (typeof record.meetingId !== 'string' || !MEETING_ID_PATTERN.test(record.meetingId)) {
    throw new Error('pending recording lifecycle meetingId is invalid');
  }
  if (
    typeof record.externalSessionId !== 'string' ||
    !EXTERNAL_SESSION_ID_PATTERN.test(record.externalSessionId)
  ) {
    throw new Error('pending recording lifecycle externalSessionId is invalid');
  }
  const startedAt = canonicalInstant(record.startedAt, 'pending recording lifecycle startedAt');
  const endedAt = record.endedAt
    ? canonicalInstant(record.endedAt, 'pending recording lifecycle endedAt')
    : null;
  const gatewayFinishPending =
    record.gatewayFinishPending === undefined ? true : record.gatewayFinishPending;
  if (typeof gatewayFinishPending !== 'boolean') {
    throw new Error('pending recording lifecycle gatewayFinishPending is invalid');
  }
  const gatewayFinishIdempotencyKey = record.gatewayFinishIdempotencyKey ?? null;
  if (
    gatewayFinishIdempotencyKey !== null &&
    (typeof gatewayFinishIdempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(gatewayFinishIdempotencyKey))
  ) {
    throw new Error('pending recording lifecycle gatewayFinishIdempotencyKey is invalid');
  }
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error('pending recording lifecycle endedAt precedes startedAt');
  }
  return {
    meetingId: record.meetingId,
    externalSessionId: record.externalSessionId,
    startedAt,
    endedAt,
    gatewayFinishPending,
    gatewayFinishIdempotencyKey,
  };
}

function validateUnreconcilable(value: unknown): UnreconcilableRecordingLifecycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('unreconcilable recording lifecycle entry is invalid');
  }
  const record = value as Partial<UnreconcilableRecordingLifecycle>;
  const lifecycle = validate({
    meetingId: record.meetingId,
    externalSessionId: record.externalSessionId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    gatewayFinishPending: false,
    gatewayFinishIdempotencyKey: record.gatewayFinishIdempotencyKey,
  });
  if (!lifecycle.endedAt) {
    throw new Error('unreconcilable recording lifecycle endedAt is required');
  }
  if (record.terminalReason !== 'gateway-session-not-found') {
    throw new Error('unreconcilable recording lifecycle terminalReason is invalid');
  }
  if (record.gatewayStatus !== 404) {
    throw new Error('unreconcilable recording lifecycle gatewayStatus is invalid');
  }
  if (record.gatewayCode !== 'AUDIO_GATEWAY_SESSION_NOT_FOUND') {
    throw new Error('unreconcilable recording lifecycle gatewayCode is invalid');
  }
  if (record.retryable !== false) {
    throw new Error('unreconcilable recording lifecycle retryable is invalid');
  }
  const recordedAt = canonicalInstant(
    record.recordedAt,
    'unreconcilable recording lifecycle recordedAt',
  );
  if (
    typeof record.attemptCount !== 'number' ||
    !Number.isSafeInteger(record.attemptCount) ||
    record.attemptCount <= 0
  ) {
    throw new Error('unreconcilable recording lifecycle attemptCount is invalid');
  }
  return {
    meetingId: lifecycle.meetingId,
    externalSessionId: lifecycle.externalSessionId,
    startedAt: lifecycle.startedAt,
    endedAt: lifecycle.endedAt,
    gatewayFinishIdempotencyKey: lifecycle.gatewayFinishIdempotencyKey ?? null,
    terminalReason: 'gateway-session-not-found',
    gatewayStatus: 404,
    gatewayCode: 'AUDIO_GATEWAY_SESSION_NOT_FOUND',
    retryable: false,
    recordedAt,
    attemptCount: record.attemptCount,
  };
}

function sameIdentity(
  left: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId'>,
  right: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId'>,
): boolean {
  return left.meetingId === right.meetingId && left.externalSessionId === right.externalSessionId;
}

/**
 * Metadata-only durable handoff for canonical recording lifecycle writes.
 * Audio, transcript text, tokens and consent content are never persisted here.
 */
export class RecordingLifecycleOutbox {
  private readonly store: StoreLike;
  private readonly recoveryStore: StoreLike;

  constructor(
    store: StoreLike = new Store<PersistShape>({
      name: 'recording-lifecycle-outbox',
      clearInvalidConfig: false,
    }),
    recoveryStore: StoreLike = new Store<PersistShape>({
      name: 'recording-lifecycle-recovery-outbox',
      clearInvalidConfig: false,
    }),
  ) {
    this.store = store;
    this.recoveryStore = recoveryStore;
  }

  list(): PendingRecordingLifecycle[] {
    return this.currentSnapshot().pending;
  }

  listUnreconcilable(): UnreconcilableRecordingLifecycle[] {
    return this.currentSnapshot().unreconcilable ?? [];
  }

  private currentSnapshot(): PersistedSnapshot {
    const { primary, recovery } = this.readAvailableSnapshots();
    if (primary.generation > 0 || recovery.generation > 0) {
      return primary.generation >= recovery.generation ? primary : recovery;
    }
    return {
      generation: 0,
      pending: this.mergeLegacy(primary.pending, recovery.pending),
      unreconcilable: [],
    };
  }

  private mergeLegacy(
    primary: PendingRecordingLifecycle[],
    recovery: PendingRecordingLifecycle[],
  ): PendingRecordingLifecycle[] {
    const merged: PendingRecordingLifecycle[] = [];
    for (const entry of [...primary, ...recovery]) {
      const index = merged.findIndex((candidate) => sameIdentity(candidate, entry));
      if (index < 0) {
        merged.push(entry);
        continue;
      }
      const existing = merged[index];
      if (existing.startedAt !== entry.startedAt) {
        throw new Error('pending recording lifecycle identity has conflicting startedAt');
      }
      if (existing.endedAt && entry.endedAt && existing.endedAt !== entry.endedAt) {
        throw new Error('pending recording lifecycle identity has conflicting endedAt');
      }
      if (
        existing.gatewayFinishIdempotencyKey &&
        entry.gatewayFinishIdempotencyKey &&
        existing.gatewayFinishIdempotencyKey !== entry.gatewayFinishIdempotencyKey
      ) {
        throw new Error(
          'pending recording lifecycle identity has conflicting gateway finish idempotency key',
        );
      }
      merged[index] = {
        ...existing,
        endedAt: existing.endedAt ?? entry.endedAt,
        gatewayFinishPending: existing.gatewayFinishPending && entry.gatewayFinishPending,
        gatewayFinishIdempotencyKey:
          existing.gatewayFinishIdempotencyKey ?? entry.gatewayFinishIdempotencyKey ?? null,
      };
    }
    if (merged.length > MAX_PENDING_LIFECYCLES) {
      throw new Error('pending recording lifecycle outbox is invalid');
    }
    return merged;
  }

  private readSnapshot(store: StoreLike): PersistedSnapshot {
    const value = store.get('snapshot');
    if (value === undefined) {
      return { generation: 0, pending: this.readLegacy(store) };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pending recording lifecycle snapshot is invalid');
    }
    const snapshot = value as Partial<PersistedSnapshot>;
    if (
      !Number.isSafeInteger(snapshot.generation) ||
      typeof snapshot.generation !== 'number' ||
      snapshot.generation <= 0
    ) {
      throw new Error('pending recording lifecycle generation is invalid');
    }
    if (!Array.isArray(snapshot.pending) || snapshot.pending.length > MAX_PENDING_LIFECYCLES) {
      throw new Error('pending recording lifecycle outbox is invalid');
    }
    return {
      generation: snapshot.generation,
      pending: snapshot.pending.map((entry) => validate(entry)),
      unreconcilable: (() => {
        if (snapshot.unreconcilable === undefined) {
          return [];
        }
        if (
          !Array.isArray(snapshot.unreconcilable) ||
          snapshot.unreconcilable.length > MAX_UNRECONCILABLE_LIFECYCLES
        ) {
          throw new Error('unreconcilable recording lifecycle outbox is invalid');
        }
        return snapshot.unreconcilable.map((entry) => validateUnreconcilable(entry));
      })(),
    };
  }

  private readLegacy(store: StoreLike): PendingRecordingLifecycle[] {
    const value = store.get('pending');
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.length > MAX_PENDING_LIFECYCLES) {
      throw new Error('pending recording lifecycle outbox is invalid');
    }
    return value.map((entry) => validate(entry));
  }

  private readAvailableSnapshots(): {
    primary: PersistedSnapshot;
    recovery: PersistedSnapshot;
  } {
    let primary: PersistedSnapshot | null = null;
    let recovery: PersistedSnapshot | null = null;
    let primaryError: unknown = null;
    let recoveryError: unknown = null;
    try {
      primary = this.readSnapshot(this.store);
    } catch (error) {
      primaryError = error;
    }
    try {
      recovery = this.readSnapshot(this.recoveryStore);
    } catch (error) {
      recoveryError = error;
    }
    if (!primary && !recovery) {
      throw new AggregateError(
        [primaryError, recoveryError],
        'pending recording lifecycle stores are invalid',
      );
    }
    if (
      (!primary && recovery?.generation === 0 && recovery.pending.length === 0) ||
      (!recovery && primary?.generation === 0 && primary.pending.length === 0)
    ) {
      const invalidStoreError = primaryError ?? recoveryError;
      const detail = invalidStoreError instanceof Error ? `: ${invalidStoreError.message}` : '';
      throw new AggregateError(
        [primaryError, recoveryError],
        `pending recording lifecycle store is invalid without a durable recovery snapshot${detail}`,
      );
    }
    return {
      primary: primary ?? { generation: 0, pending: [] },
      recovery: recovery ?? { generation: 0, pending: [] },
    };
  }

  private persist(
    pending: PendingRecordingLifecycle[],
    unreconcilable: UnreconcilableRecordingLifecycle[],
  ): void {
    const { primary, recovery } = this.readAvailableSnapshots();
    const generation = Math.max(primary.generation, recovery.generation) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error('pending recording lifecycle generation is exhausted');
    }
    const snapshot: PersistedSnapshot = {
      generation,
      pending: pending.map((entry) => validate(entry)),
      unreconcilable: unreconcilable.map((entry) => validateUnreconcilable(entry)),
    };
    try {
      // Recovery is written first. A crash between the two writes leaves the
      // newer full snapshot authoritative instead of resurrecting stale data.
      this.recoveryStore.set('snapshot', snapshot);
    } catch (recoveryError) {
      throw new AggregateError(
        [recoveryError],
        'pending recording lifecycle recovery snapshot could not be persisted',
      );
    }
    try {
      this.store.set('snapshot', snapshot);
    } catch {
      // The full recovery snapshot is already durable and has the newest
      // generation. A later write will heal the primary copy.
    }
  }

  upsert(record: PendingRecordingLifecycle): PendingRecordingLifecycle {
    const normalized = validate(record);
    const current = this.currentSnapshot();
    const pending = [...current.pending];
    const index = pending.findIndex((entry) => sameIdentity(entry, normalized));
    if (index >= 0) {
      const existing = pending[index];
      if (existing.startedAt !== normalized.startedAt) {
        throw new Error('pending recording lifecycle identity has conflicting startedAt');
      }
      if (existing.endedAt && normalized.endedAt && existing.endedAt !== normalized.endedAt) {
        throw new Error('pending recording lifecycle identity has conflicting endedAt');
      }
      if (
        existing.gatewayFinishIdempotencyKey &&
        normalized.gatewayFinishIdempotencyKey &&
        existing.gatewayFinishIdempotencyKey !== normalized.gatewayFinishIdempotencyKey
      ) {
        throw new Error(
          'pending recording lifecycle identity has conflicting gateway finish idempotency key',
        );
      }
      pending[index] = {
        ...existing,
        endedAt: existing.endedAt ?? normalized.endedAt,
        gatewayFinishPending: existing.gatewayFinishPending && normalized.gatewayFinishPending,
        gatewayFinishIdempotencyKey:
          existing.gatewayFinishIdempotencyKey ?? normalized.gatewayFinishIdempotencyKey ?? null,
      };
    } else {
      if (pending.length >= MAX_PENDING_LIFECYCLES) {
        throw new Error('pending recording lifecycle outbox capacity exceeded');
      }
      pending.push(normalized);
    }
    this.persist(pending, current.unreconcilable ?? []);
    return pending[index >= 0 ? index : pending.length - 1];
  }

  markEnded(
    identity: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId' | 'startedAt'> &
      Partial<Pick<PendingRecordingLifecycle, 'gatewayFinishIdempotencyKey'>>,
    endedAt: string,
  ): PendingRecordingLifecycle {
    const existing = this.list().find((entry) => sameIdentity(entry, identity));
    return this.upsert({
      ...identity,
      endedAt,
      gatewayFinishPending: existing?.gatewayFinishPending ?? true,
      gatewayFinishIdempotencyKey:
        existing?.gatewayFinishIdempotencyKey ?? identity.gatewayFinishIdempotencyKey ?? null,
    });
  }

  markGatewayFinished(
    identity: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId' | 'startedAt'>,
  ): PendingRecordingLifecycle {
    const existing = this.list().find((entry) => sameIdentity(entry, identity));
    if (!existing) {
      throw new Error('pending recording lifecycle identity was not found');
    }
    return this.upsert({ ...existing, gatewayFinishPending: false });
  }

  markGatewaySessionNotFound(
    identity: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId'>,
    args: { recordedAt?: string; attemptCount: number },
  ): PendingRecordingLifecycle {
    const current = this.currentSnapshot();
    const pending = [...current.pending];
    const pendingIndex = pending.findIndex((entry) => sameIdentity(entry, identity));
    if (pendingIndex < 0) {
      throw new Error('pending recording lifecycle identity was not found');
    }
    const lifecycle = pending[pendingIndex];
    if (!lifecycle.endedAt) {
      throw new Error('pending recording lifecycle must be ended before terminal classification');
    }

    const unreconcilable = [...(current.unreconcilable ?? [])];
    const existing = unreconcilable.find((entry) => sameIdentity(entry, identity));
    if (existing) {
      if (lifecycle.gatewayFinishPending) {
        pending[pendingIndex] = { ...lifecycle, gatewayFinishPending: false };
        this.persist(pending, unreconcilable);
      }
      return pending[pendingIndex];
    }
    if (unreconcilable.length >= MAX_UNRECONCILABLE_LIFECYCLES) {
      throw new Error('unreconcilable recording lifecycle outbox capacity exceeded');
    }

    const terminal = validateUnreconcilable({
      meetingId: lifecycle.meetingId,
      externalSessionId: lifecycle.externalSessionId,
      startedAt: lifecycle.startedAt,
      endedAt: lifecycle.endedAt,
      gatewayFinishIdempotencyKey: lifecycle.gatewayFinishIdempotencyKey ?? null,
      terminalReason: 'gateway-session-not-found',
      gatewayStatus: 404,
      gatewayCode: 'AUDIO_GATEWAY_SESSION_NOT_FOUND',
      retryable: false,
      recordedAt: args.recordedAt ?? new Date().toISOString(),
      attemptCount: args.attemptCount,
    });
    pending[pendingIndex] = { ...lifecycle, gatewayFinishPending: false };
    unreconcilable.push(terminal);
    this.persist(pending, unreconcilable);
    return pending[pendingIndex];
  }

  remove(identity: Pick<PendingRecordingLifecycle, 'meetingId' | 'externalSessionId'>): void {
    const current = this.currentSnapshot();
    const pending = current.pending.filter((entry) => !sameIdentity(entry, identity));
    this.persist(pending, current.unreconcilable ?? []);
  }
}
