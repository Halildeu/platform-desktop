const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_DEVICE_ID = 'desktop-1';

export interface RecorderRuntimeConfig {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
  liveSttStreamUrl: string | null;
  liveSttStreamReason: string | null;
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim();
}

function isLocalWs(url: URL): boolean {
  return (
    url.protocol === 'ws:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

function normalizeLiveSttStreamUrl(raw: string): {
  liveSttStreamUrl: string | null;
  liveSttStreamReason: string | null;
} {
  if (!raw) {
    return { liveSttStreamUrl: null, liveSttStreamReason: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      liveSttStreamUrl: null,
      liveSttStreamReason: 'LIVE_STT_STREAM_URL absolute ws/wss URL olmali.',
    };
  }

  if (parsed.protocol !== 'wss:' && !isLocalWs(parsed)) {
    return {
      liveSttStreamUrl: null,
      liveSttStreamReason:
        'LIVE_STT_STREAM_URL wss olmali; local dev icin ws localhost kabul edilir.',
    };
  }

  return {
    liveSttStreamUrl: parsed.toString(),
    liveSttStreamReason: null,
  };
}

export function loadRecorderRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RecorderRuntimeConfig {
  const meetingId = normalize(env.RECORDER_MEETING_ID);
  const deviceId = normalize(env.RECORDER_DEVICE_ID) || DEFAULT_DEVICE_ID;
  const liveStream = normalizeLiveSttStreamUrl(normalize(env.LIVE_STT_STREAM_URL));

  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return {
      meetingId: null,
      deviceId,
      ready: false,
      reason: 'RECORDER_DEVICE_ID audio-gateway deviceId formatina uymuyor.',
      ...liveStream,
    };
  }

  if (!meetingId) {
    return {
      meetingId: null,
      deviceId,
      ready: false,
      reason:
        'RECORDER_MEETING_ID tanimli degil; kayit icin meeting-service MeetingResponse.id gerekli.',
      ...liveStream,
    };
  }

  if (!MEETING_ID_PATTERN.test(meetingId)) {
    return {
      meetingId,
      deviceId,
      ready: false,
      reason: 'RECORDER_MEETING_ID meeting-service UUID formatina uymuyor.',
      ...liveStream,
    };
  }

  return {
    meetingId,
    deviceId,
    ready: true,
    reason: null,
    ...liveStream,
  };
}
