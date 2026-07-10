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
    expect(cfg.liveSttStreamUrl).toBeNull();
    expect(cfg.liveSttStreamReason).toBeNull();
  });

  it('rejects meetingId values that do not satisfy audio-gateway contract v1', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: 'not-a-meeting',
    });

    expect(cfg.ready).toBe(false);
    expect(cfg.meetingId).toBe('not-a-meeting');
    expect(cfg.reason).toContain('meeting-service UUID formatina uymuyor');
    expect(cfg.liveSttStreamUrl).toBeNull();
  });

  it('rejects invalid device identifiers', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: meetingId,
      RECORDER_DEVICE_ID: 'bad device',
    });

    expect(cfg.ready).toBe(false);
    expect(cfg.reason).toContain('RECORDER_DEVICE_ID');
    expect(cfg.liveSttStreamUrl).toBeNull();
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
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
    });
  });

  it('returns optional direct live STT stream URL for word-level partial transcript', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: meetingId,
      LIVE_STT_STREAM_URL: 'ws://127.0.0.1:18220/ws/stream',
    });

    expect(cfg.ready).toBe(true);
    expect(cfg.liveSttStreamUrl).toBe('ws://127.0.0.1:18220/ws/stream');
    expect(cfg.liveSttStreamReason).toBeNull();
  });

  it('keeps recorder ready but disables invalid optional live STT stream URL', () => {
    const cfg = loadRecorderRuntimeConfig({
      RECORDER_MEETING_ID: meetingId,
      LIVE_STT_STREAM_URL: 'http://stt.example.com/ws/stream',
    });

    expect(cfg.ready).toBe(true);
    expect(cfg.liveSttStreamUrl).toBeNull();
    expect(cfg.liveSttStreamReason).toContain('LIVE_STT_STREAM_URL');
  });
});
