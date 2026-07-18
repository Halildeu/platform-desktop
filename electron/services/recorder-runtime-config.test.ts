import { describe, expect, it } from 'vitest';

import { loadRecorderRuntimeConfig } from './recorder-runtime-config';

describe('loadRecorderRuntimeConfig', () => {
  const meetingId = '22222222-2222-4222-8222-222222222222';
  const packagedOnly = { paths: { system: null, user: null } } as const;

  it('fails closed when no canonical meetingId is configured', () => {
    const cfg = loadRecorderRuntimeConfig({}, packagedOnly);

    expect(cfg.ready).toBe(false);
    expect(cfg.meetingId).toBeNull();
    expect(cfg.deviceId).toBe('desktop-1');
    expect(cfg.reason).toContain('RECORDER_MEETING_ID');
    expect(cfg.gatewayLiveStreamEnabled).toBe(true);
    expect(cfg.liveSttStreamUrl).toBeNull();
    expect(cfg.liveSttStreamReason).toBeNull();
  });

  it('rejects meetingId values that do not satisfy audio-gateway contract v1', () => {
    const cfg = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: 'not-a-meeting',
      },
      packagedOnly,
    );

    expect(cfg.ready).toBe(false);
    expect(cfg.meetingId).toBe('not-a-meeting');
    expect(cfg.reason).toContain('meeting-service UUID formatina uymuyor');
    expect(cfg.liveSttStreamUrl).toBeNull();
  });

  it('rejects invalid device identifiers', () => {
    const cfg = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        RECORDER_DEVICE_ID: 'bad device',
      },
      packagedOnly,
    );

    expect(cfg.ready).toBe(false);
    expect(cfg.reason).toContain('RECORDER_DEVICE_ID');
    expect(cfg.liveSttStreamUrl).toBeNull();
  });

  it('returns ready config for a canonical gateway meetingId', () => {
    const cfg = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        RECORDER_DEVICE_ID: 'desktop-halil',
      },
      packagedOnly,
    );

    expect(cfg).toEqual({
      meetingId,
      deviceId: 'desktop-halil',
      ready: true,
      reason: null,
      gatewayLiveStreamEnabled: true,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
    });
  });

  it.each(['false', 'TRUE', ' true ', 'true ', ' true', '\ttrue\n'])(
    'fails the env gate closed for malformed override %j',
    (override) => {
      const cfg = loadRecorderRuntimeConfig(
        {
          RECORDER_MEETING_ID: meetingId,
          GATEWAY_LIVE_STREAM_ENABLED: override,
        },
        packagedOnly,
      );

      expect(cfg.gatewayLiveStreamEnabled).toBe(false);
    },
  );

  it('allows only the exact env value true to enable the gateway stream', () => {
    const disabled = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        GATEWAY_LIVE_STREAM_ENABLED: 'false',
      },
      packagedOnly,
    );
    const enabled = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        GATEWAY_LIVE_STREAM_ENABLED: 'true',
      },
      packagedOnly,
    );

    expect(disabled.gatewayLiveStreamEnabled).toBe(false);
    expect(enabled.gatewayLiveStreamEnabled).toBe(true);
  });

  it('returns optional direct live STT stream URL for word-level partial transcript', () => {
    const cfg = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        LIVE_STT_STREAM_URL: 'ws://127.0.0.1:18220/ws/stream',
      },
      packagedOnly,
    );

    expect(cfg.ready).toBe(true);
    expect(cfg.liveSttStreamUrl).toBe('ws://127.0.0.1:18220/ws/stream');
    expect(cfg.liveSttStreamReason).toBeNull();
  });

  it('keeps recorder ready but disables invalid optional live STT stream URL', () => {
    const cfg = loadRecorderRuntimeConfig(
      {
        RECORDER_MEETING_ID: meetingId,
        LIVE_STT_STREAM_URL: 'http://stt.example.com/ws/stream',
      },
      packagedOnly,
    );

    expect(cfg.ready).toBe(true);
    expect(cfg.liveSttStreamUrl).toBeNull();
    expect(cfg.liveSttStreamReason).toContain('LIVE_STT_STREAM_URL');
  });
});
