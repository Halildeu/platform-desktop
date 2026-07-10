import { ipcMain } from 'electron';

import {
  analyzeMeetingIntelligence,
  createMeetingContract,
  loadMeetingConfig,
  type CreateMeetingContractArgs,
  type MeetingAiAnalyzeArgs,
  type MeetingAiAnalyzeRequest,
  type MeetingAiAnalyzeResponse,
  type MeetingContract,
} from '../services/meeting/meeting-client.js';
import { getValidAccessToken } from './auth.js';

const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long`);
  }
  return trimmed;
}

function optionalIsoInstant(value: unknown, label: string): string | undefined {
  const text = optionalText(value, label, 64);
  if (!text) {
    return undefined;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function parseCreateArgs(value: unknown): CreateMeetingContractArgs {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object') {
    throw new Error('meeting contract payload must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    title: optionalText(record.title, 'title', 512),
    description: optionalText(record.description, 'description', 4000),
    scheduledStart: optionalIsoInstant(record.scheduledStart, 'scheduledStart'),
    scheduledEnd: optionalIsoInstant(record.scheduledEnd, 'scheduledEnd'),
  };
}

function requiredCanonicalMeetingId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MEETING_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical UUID`);
  }
  return value;
}

function requiredTranscript(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('transcript must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('transcript is required');
  }
  if (trimmed.length > 200_000) {
    throw new Error('transcript is too long');
  }
  return trimmed;
}

function optionalSessionId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('session_id must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 64) {
    throw new Error('session_id is too long');
  }
  return trimmed;
}

function boundedNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function parseSegments(value: unknown): MeetingAiAnalyzeRequest['segments'] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('segments must be an array');
  }
  if (value.length > 5_000) {
    throw new Error('segments is too long');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`segments[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const text = optionalText(record.text, `segments[${index}].text`, 20_000);
    if (!text) {
      throw new Error(`segments[${index}].text is required`);
    }
    const start = boundedNonNegativeNumber(record.start, `segments[${index}].start`);
    const end =
      record.end === undefined || record.end === null
        ? undefined
        : boundedNonNegativeNumber(record.end, `segments[${index}].end`);
    return {
      text,
      start,
      ...(end !== undefined && end > start ? { end } : {}),
    };
  });
}

function parseAnalyzeRequest(value: unknown, meetingId: string): MeetingAiAnalyzeRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting-ai request must be an object');
  }
  const record = value as Record<string, unknown>;
  const requestMeetingId = record.meeting_id ?? record.meetingId ?? meetingId;
  const canonicalRequestMeetingId = requiredCanonicalMeetingId(requestMeetingId, 'meeting_id');
  if (canonicalRequestMeetingId !== meetingId) {
    throw new Error('meeting_id must match meetingId');
  }

  return {
    transcript: requiredTranscript(record.transcript),
    meeting_id: meetingId,
    session_id: optionalSessionId(record.session_id ?? record.sessionId),
    segments: parseSegments(record.segments),
  };
}

function parseAnalyzeArgs(value: unknown): MeetingAiAnalyzeArgs {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting-ai payload must be an object');
  }
  const record = value as Record<string, unknown>;
  const meetingId = requiredCanonicalMeetingId(record.meetingId, 'meetingId');
  return {
    meetingId,
    request: parseAnalyzeRequest(record.request, meetingId),
  };
}

export function registerMeetingIpc(): void {
  ipcMain.handle(
    'meeting:create-contract',
    async (_e, payload: unknown): Promise<MeetingContract> => {
      const args = parseCreateArgs(payload);
      return createMeetingContract(loadMeetingConfig(), await getValidAccessToken(), args);
    },
  );
  ipcMain.handle(
    'meeting:analyze',
    async (_e, payload: unknown): Promise<MeetingAiAnalyzeResponse> => {
      const args = parseAnalyzeArgs(payload);
      return analyzeMeetingIntelligence(loadMeetingConfig(), await getValidAccessToken(), args);
    },
  );
}
