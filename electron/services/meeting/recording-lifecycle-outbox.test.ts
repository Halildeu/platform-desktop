import { describe, expect, it } from 'vitest';

import {
  RecordingLifecycleOutbox,
  type PendingRecordingLifecycle,
  type UnreconcilableRecordingLifecycle,
} from './recording-lifecycle-outbox';

class MemoryStore {
  pending: PendingRecordingLifecycle[] | undefined;
  snapshot:
    | {
        generation: number;
        pending: PendingRecordingLifecycle[];
        unreconcilable?: UnreconcilableRecordingLifecycle[];
      }
    | undefined;
  failWrites = false;

  get(key: 'snapshot' | 'pending'): unknown {
    return key === 'snapshot' ? this.snapshot : this.pending;
  }

  set(
    _key: 'snapshot',
    value: {
      generation: number;
      pending: PendingRecordingLifecycle[];
      unreconcilable?: UnreconcilableRecordingLifecycle[];
    },
  ): void {
    if (this.failWrites) {
      throw new Error('store write failed');
    }
    this.snapshot = structuredClone(value);
  }
}

const active: PendingRecordingLifecycle = {
  meetingId: '22222222-2222-4222-8222-222222222222',
  externalSessionId: 'SES-1',
  startedAt: '2026-07-17T08:43:20Z',
  endedAt: null,
  gatewayFinishPending: true,
  gatewayFinishIdempotencyKey: '0123456789abcdef0123456789abcdef',
};

describe('RecordingLifecycleOutbox', () => {
  it('persists only bounded lifecycle metadata and removes acknowledged records', () => {
    const storage = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingLifecycleOutbox(storage, recovery);

    outbox.upsert(active);
    expect(outbox.list()).toEqual([{ ...active, startedAt: '2026-07-17T08:43:20.000Z' }]);

    outbox.markEnded(active, '2026-07-17T08:44:20Z');
    expect(outbox.list()[0].endedAt).toBe('2026-07-17T08:44:20.000Z');
    outbox.markGatewayFinished(active);
    expect(outbox.list()[0].gatewayFinishPending).toBe(false);

    outbox.remove(active);
    expect(outbox.list()).toEqual([]);
  });

  it('keeps startedAt and endedAt monotonic for one gateway identity', () => {
    const outbox = new RecordingLifecycleOutbox(new MemoryStore(), new MemoryStore());
    outbox.upsert(active);
    outbox.markEnded(active, '2026-07-17T08:44:20Z');

    expect(() => outbox.upsert({ ...active, startedAt: '2026-07-17T08:43:19Z' })).toThrow(
      'conflicting startedAt',
    );
    expect(() => outbox.markEnded(active, '2026-07-17T08:44:21Z')).toThrow('conflicting endedAt');
  });

  it('fails closed on malformed persisted metadata', () => {
    const storage = new MemoryStore();
    storage.pending = [{ ...active, externalSessionId: '../foreign' }];

    expect(() => new RecordingLifecycleOutbox(storage, new MemoryStore()).list()).toThrow(
      'externalSessionId is invalid',
    );
  });

  it('allowlists durable fields instead of preserving unknown payload data', () => {
    const storage = new MemoryStore();
    const outbox = new RecordingLifecycleOutbox(storage, new MemoryStore());
    const runtimePayload = {
      ...active,
      transcript: 'must-not-persist',
      token: 'must-not-persist',
      consent: { accepted: true },
    };

    outbox.upsert(runtimePayload as PendingRecordingLifecycle);

    expect(storage.snapshot?.pending).toEqual([
      {
        meetingId: active.meetingId,
        externalSessionId: active.externalSessionId,
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: null,
        gatewayFinishPending: true,
        gatewayFinishIdempotencyKey: active.gatewayFinishIdempotencyKey,
      },
    ]);
  });

  it('keeps the gateway identity in a separate durable store when the primary write fails', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    primary.failWrites = true;
    const outbox = new RecordingLifecycleOutbox(primary, recovery);

    expect(outbox.upsert(active)).toEqual({
      ...active,
      startedAt: '2026-07-17T08:43:20.000Z',
    });
    expect(recovery.snapshot?.pending).toEqual([
      {
        ...active,
        startedAt: '2026-07-17T08:43:20.000Z',
      },
    ]);
    expect(outbox.list()).toEqual(recovery.snapshot?.pending);
  });

  it('fails closed before acknowledging a lifecycle when recovery persistence fails', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    primary.snapshot = { generation: 2, pending: [{ ...active }] };
    recovery.snapshot = { generation: 1, pending: [{ ...active }] };
    recovery.failWrites = true;

    expect(() => new RecordingLifecycleOutbox(primary, recovery).remove(active)).toThrow(
      'recovery snapshot could not be persisted',
    );

    expect(new RecordingLifecycleOutbox(primary, recovery).list()).toEqual([
      { ...active, startedAt: '2026-07-17T08:43:20.000Z' },
    ]);
    expect(primary.snapshot).toEqual({ generation: 2, pending: [{ ...active }] });
    expect(recovery.snapshot?.generation).toBe(1);
  });

  it('uses and preserves a healthy primary snapshot when recovery metadata is malformed', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    primary.snapshot = { generation: 4, pending: [{ ...active }] };
    recovery.snapshot = { generation: 0, pending: [{ ...active }] };
    const outbox = new RecordingLifecycleOutbox(primary, recovery);

    expect(outbox.list()).toEqual([{ ...active, startedAt: '2026-07-17T08:43:20.000Z' }]);
    outbox.markEnded(active, '2026-07-17T08:44:20Z');

    expect(primary.snapshot?.generation).toBe(5);
    expect(recovery.snapshot).toEqual({
      generation: 5,
      pending: [
        {
          ...active,
          startedAt: '2026-07-17T08:43:20.000Z',
          endedAt: '2026-07-17T08:44:20.000Z',
        },
      ],
      unreconcilable: [],
    });
    expect(outbox.list()[0].endedAt).toBe('2026-07-17T08:44:20.000Z');
  });

  it('recovers the full latest lifecycle snapshot when the primary copy is corrupted', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingLifecycleOutbox(primary, recovery);

    outbox.upsert(active);
    outbox.markEnded(active, '2026-07-17T08:44:20Z');
    primary.snapshot = {
      generation: 2,
      pending: [{ ...active, externalSessionId: '../corrupt' }],
    };

    expect(new RecordingLifecycleOutbox(primary, recovery).list()).toEqual([
      {
        ...active,
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
      },
    ]);
  });

  it('fails closed when malformed metadata has no durable peer snapshot', () => {
    const primary = new MemoryStore();
    primary.snapshot = { generation: 0, pending: [{ ...active }] };

    expect(() => new RecordingLifecycleOutbox(primary, new MemoryStore()).list()).toThrow(
      'without a durable recovery snapshot',
    );
  });

  it('rejects conflicting finish idempotency keys for the same gateway identity', () => {
    const outbox = new RecordingLifecycleOutbox(new MemoryStore(), new MemoryStore());
    outbox.upsert(active);

    expect(() =>
      outbox.upsert({
        ...active,
        gatewayFinishIdempotencyKey: 'fedcba9876543210fedcba9876543210',
      }),
    ).toThrow('conflicting gateway finish idempotency key');
  });

  it('moves a verified missing gateway session to durable terminal evidence atomically', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingLifecycleOutbox(primary, recovery);
    outbox.upsert(active);
    const ended = outbox.markEnded(active, '2026-07-17T08:44:20Z');

    expect(
      outbox.markGatewaySessionNotFound(ended, {
        recordedAt: '2026-07-20T08:30:00Z',
        attemptCount: 1,
      }),
    ).toEqual(expect.objectContaining({ gatewayFinishPending: false }));
    expect(outbox.list()).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-1', gatewayFinishPending: false }),
    ]);
    expect(outbox.listUnreconcilable()).toEqual([
      {
        meetingId: active.meetingId,
        externalSessionId: active.externalSessionId,
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishIdempotencyKey: active.gatewayFinishIdempotencyKey,
        terminalReason: 'gateway-session-not-found',
        gatewayStatus: 404,
        gatewayCode: 'AUDIO_GATEWAY_SESSION_NOT_FOUND',
        retryable: false,
        recordedAt: '2026-07-20T08:30:00.000Z',
        attemptCount: 1,
      },
    ]);

    outbox.remove(active);
    const restarted = new RecordingLifecycleOutbox(primary, recovery);
    expect(restarted.list()).toEqual([]);
    expect(restarted.listUnreconcilable()).toHaveLength(1);
  });

  it('keeps the lifecycle blocking when terminal evidence cannot be persisted', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingLifecycleOutbox(primary, recovery);
    outbox.upsert(active);
    const ended = outbox.markEnded(active, '2026-07-17T08:44:20Z');
    recovery.failWrites = true;

    expect(() =>
      outbox.markGatewaySessionNotFound(ended, {
        recordedAt: '2026-07-20T08:30:00Z',
        attemptCount: 1,
      }),
    ).toThrow('recovery snapshot could not be persisted');
    expect(new RecordingLifecycleOutbox(primary, recovery).list()).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-1', gatewayFinishPending: true }),
    ]);
    expect(new RecordingLifecycleOutbox(primary, recovery).listUnreconcilable()).toEqual([]);
  });
});
