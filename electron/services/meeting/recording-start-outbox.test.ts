import { describe, expect, it } from 'vitest';

import { RecordingStartOutbox, type PendingRecordingStart } from './recording-start-outbox';

class MemoryStore {
  snapshot: { generation: number; pending: PendingRecordingStart[] } | undefined;
  failWrites = false;

  get(_key: 'snapshot'): unknown {
    return this.snapshot;
  }

  set(_key: 'snapshot', value: { generation: number; pending: PendingRecordingStart[] }): void {
    if (this.failWrites) {
      throw new Error('store write failed');
    }
    this.snapshot = structuredClone(value);
  }
}

const intent: PendingRecordingStart = {
  meetingId: '22222222-2222-4222-8222-222222222222',
  captureId: '33333333-3333-4333-8333-333333333333',
  deviceId: 'desktop-1',
  language: 'tr',
  startedAt: '2026-07-17T08:43:20Z',
  idempotencyKey: '0123456789abcdef0123456789abcdef',
  gatewayFinishIdempotencyKey: 'fedcba9876543210fedcba9876543210',
};

describe('RecordingStartOutbox', () => {
  it('persists only bounded metadata before a gateway start can be acknowledged', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingStartOutbox(primary, recovery);

    outbox.upsert({
      ...intent,
      token: 'must-not-persist',
      transcript: 'must-not-persist',
    } as PendingRecordingStart);

    expect(primary.snapshot).toEqual(recovery.snapshot);
    expect(primary.snapshot?.pending).toEqual([
      { ...intent, startedAt: '2026-07-17T08:43:20.000Z' },
    ]);
  });

  it('keeps the complete newer recovery snapshot when the primary write fails', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    primary.failWrites = true;
    const outbox = new RecordingStartOutbox(primary, recovery);

    outbox.upsert(intent);

    expect(primary.snapshot).toBeUndefined();
    expect(new RecordingStartOutbox(primary, recovery).list()).toEqual([
      { ...intent, startedAt: '2026-07-17T08:43:20.000Z' },
    ]);
  });

  it('allows an exact idempotent replay and rejects conflicting capture metadata', () => {
    const outbox = new RecordingStartOutbox(new MemoryStore(), new MemoryStore());
    outbox.upsert(intent);

    expect(outbox.upsert(intent)).toEqual({
      ...intent,
      startedAt: '2026-07-17T08:43:20.000Z',
    });
    expect(() => outbox.upsert({ ...intent, deviceId: 'desktop-2' })).toThrow(
      'captureId has conflicting metadata',
    );
  });

  it('does not acknowledge a start intent when recovery removal cannot be persisted', () => {
    const primary = new MemoryStore();
    const recovery = new MemoryStore();
    const outbox = new RecordingStartOutbox(primary, recovery);
    outbox.upsert(intent);
    recovery.failWrites = true;

    expect(() => outbox.remove(intent.captureId)).toThrow('recovery could not be persisted');
    expect(new RecordingStartOutbox(primary, recovery).list()).toHaveLength(1);
  });
});
