const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_DEVICE_ID = 'desktop-1';

export interface RecorderRuntimeConfig {
  meetingId: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim();
}

export function loadRecorderRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RecorderRuntimeConfig {
  const meetingId = normalize(env.RECORDER_MEETING_ID);
  const deviceId = normalize(env.RECORDER_DEVICE_ID) || DEFAULT_DEVICE_ID;

  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return {
      meetingId: null,
      deviceId,
      ready: false,
      reason: 'RECORDER_DEVICE_ID audio-gateway deviceId formatina uymuyor.',
    };
  }

  if (!meetingId) {
    return {
      meetingId: null,
      deviceId,
      ready: false,
      reason:
        'RECORDER_MEETING_ID tanimli degil; kayit icin meeting-service MeetingResponse.id gerekli.',
    };
  }

  if (!MEETING_ID_PATTERN.test(meetingId)) {
    return {
      meetingId,
      deviceId,
      ready: false,
      reason: 'RECORDER_MEETING_ID meeting-service UUID formatina uymuyor.',
    };
  }

  return {
    meetingId,
    deviceId,
    ready: true,
    reason: null,
  };
}
