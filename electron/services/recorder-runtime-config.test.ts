import { describe, expect, it } from 'vitest';

import { loadRecorderRuntimeConfig } from './recorder-runtime-config';

describe('loadRecorderRuntimeConfig', () => {
  const meetingId = '22222222-2222-4222-8222-222222222222';

  it('fails closed when no canonical meetingId is configured', () => {
    const cfg = loadRecorderRuntimeConfig({});

    expect(cfg.ready).toBe(false);
    expect(cfg.meetingId).toBeNull();
    expect(cfg.deviceId).toBe('desktop-1');
    expect(cfg.reason).toContain('RECORDER_MEETING_ID');
  });

  it('rejects meetingId values that do not satisfy audio-gateway contract v1', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: 'not-a-meeting',
    });

    expect(cfg.ready).toBe(false);
    expect(cfg.meetingId).toBe('not-a-meeting');
    expect(cfg.reason).toContain('meeting-service UUID formatina uymuyor');
  });

  it('rejects invalid device identifiers', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: meetingId,
      RECORDER_DEVICE_ID: 'bad device',
    });

    expect(cfg.ready).toBe(false);
    expect(cfg.reason).toContain('RECORDER_DEVICE_ID');
  });

  it('returns ready config for a canonical gateway meetingId', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: meetingId,
      RECORDER_DEVICE_ID: 'desktop-halil',
    });

    expect(cfg).toEqual({
      meetingId,
      deviceId: 'desktop-halil',
      ready: true,
      reason: null,
    });
  });
});
