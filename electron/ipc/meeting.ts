import { BrowserWindow, ipcMain } from 'electron';

import { loadGatewayConfig } from '../services/gateway/gateway-client.js';
import {
  LiveAnalysisSubscriber,
  type LiveAnalysisFrame,
  type LiveAnalysisStatus,
} from '../services/meeting/live-analysis-stream.js';
import {
  analyzeMeetingIntelligence,
  createMeetingAction,
  createMeetingContract,
  listRecentMeetings,
  loadMeetingConfig,
  readMeetingIntelligenceResult,
  searchAssignees,
  type AssigneeOption,
  type CreateMeetingActionArgs,
  type CreateMeetingContractArgs,
  type MeetingActionRecord,
  type MeetingAiAnalyzeArgs,
  type MeetingAiAnalyzeRequest,
  type MeetingAiAnalyzeResponse,
  type MeetingContract,
  type MeetingIntelligenceReadOutcome,
  type RecentMeetingsPage,
} from '../services/meeting/meeting-client.js';
import { getValidAccessToken } from './auth.js';

// Faz 24 İ3 — live-analysis SSE subscribers, keyed by meetingId. One
// subscriber per meeting; a second start for the same meeting is idempotent
// and returns the existing handle. The map is process-wide so a renderer
// window that goes away without calling stop() does not leak the loop
// forever — see stopAllLiveAnalysisSubscribers() below.
const liveAnalysisSubscribers = new Map<string, LiveAnalysisSubscriber>();

/** Broadcast an SSE-derived event to every renderer window. */
function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/** Stop and drop all active live-analysis subscribers. Called on app quit. */
export async function stopAllLiveAnalysisSubscribers(): Promise<void> {
  const subs = Array.from(liveAnalysisSubscribers.values());
  liveAnalysisSubscribers.clear();
  await Promise.allSettled(subs.map((s) => s.stop('shutdown')));
}

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

function parseResultReadArgs(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting intelligence result payload must be an object');
  }
  const record = value as Record<string, unknown>;
  return requiredCanonicalMeetingId(record.meetingId, 'meetingId');
}

function parseActionCreateArgs(value: unknown): CreateMeetingActionArgs {
  if (!value || typeof value !== 'object') {
    throw new Error('meeting action payload must be an object');
  }
  const record = value as Record<string, unknown>;
  const meetingId = requiredCanonicalMeetingId(record.meetingId, 'meetingId');
  if (typeof record.description !== 'string' || !record.description.trim()) {
    throw new Error('description is required');
  }
  const assigneeSubject =
    typeof record.assigneeSubject === 'string' && record.assigneeSubject.trim()
      ? record.assigneeSubject.trim().slice(0, 256)
      : null;
  const assigneeUserId =
    typeof record.assigneeUserId === 'number' && Number.isInteger(record.assigneeUserId)
      ? record.assigneeUserId
      : null;
  const dueAt =
    typeof record.dueAt === 'string' && record.dueAt.trim() ? record.dueAt.trim() : null;
  return {
    meetingId,
    description: record.description.trim().slice(0, 2000),
    assigneeSubject,
    assigneeUserId,
    dueAt,
  };
}

function parseAssigneeSearchArgs(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('assignee search payload must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.query !== 'string' || !record.query.trim()) {
    throw new Error('query is required');
  }
  return record.query.trim().slice(0, 128);
}

export function registerMeetingIpc(): void {
  ipcMain.handle(
    'meeting:create-contract',
    async (_e, payload: unknown): Promise<MeetingContract> => {
      const args = parseCreateArgs(payload);
      return createMeetingContract(loadMeetingConfig(), await getValidAccessToken(), args);
    },
  );
  ipcMain.handle('meeting:list-recent', async (): Promise<RecentMeetingsPage> => {
    return listRecentMeetings(loadMeetingConfig(), await getValidAccessToken());
  });
  ipcMain.handle(
    'meeting:analyze',
    async (_e, payload: unknown): Promise<MeetingAiAnalyzeResponse> => {
      const args = parseAnalyzeArgs(payload);
      return analyzeMeetingIntelligence(loadMeetingConfig(), await getValidAccessToken(), args);
    },
  );
  ipcMain.handle(
    'meeting:get-intelligence-result',
    async (_e, payload: unknown): Promise<MeetingIntelligenceReadOutcome> => {
      const meetingId = parseResultReadArgs(payload);
      return readMeetingIntelligenceResult(
        loadMeetingConfig(),
        await getValidAccessToken(),
        meetingId,
      );
    },
  );

  // ── Faz 24 İ3: live-analysis SSE subscribe/unsubscribe ──────────────────
  // The renderer starts a subscription for a meetingId when the live panel
  // opens and stops it when the meeting closes (or on nav/exit). Each SSE
  // frame is broadcast as `meeting:live-analysis-frame` to every window;
  // status transitions (connecting/open/closed/error) are broadcast as
  // `meeting:live-analysis-status`. The renderer filters on meetingId.
  // ── Faz 24 Görevler dilim-3 (gitops#3486): live-panel task assignment ───
  ipcMain.handle(
    'meeting:action-create',
    async (_e, payload: unknown): Promise<MeetingActionRecord> => {
      const args = parseActionCreateArgs(payload);
      return createMeetingAction(loadMeetingConfig(), await getValidAccessToken(), args);
    },
  );
  ipcMain.handle(
    'meeting:assignee-search',
    async (_e, payload: unknown): Promise<AssigneeOption[]> => {
      const query = parseAssigneeSearchArgs(payload);
      return searchAssignees(loadMeetingConfig(), await getValidAccessToken(), query);
    },
  );

  ipcMain.handle(
    'meeting:live-analysis-start',
    async (_e, payload: unknown): Promise<{ started: boolean }> => {
      const meetingId = parseResultReadArgs(payload);
      if (liveAnalysisSubscribers.has(meetingId)) {
        return { started: false }; // already subscribed — idempotent
      }
      // The live-analysis SSE relay lives on the audio-gateway (backend#1103),
      // NOT on meeting-service — meeting-ai has no public route of its own.
      const cfg = loadGatewayConfig();
      const token = await getValidAccessToken();
      const subscriber = new LiveAnalysisSubscriber({
        baseUrl: cfg.baseUrl,
        meetingId,
        accessToken: token ?? undefined,
        onFrame: (frame: LiveAnalysisFrame) => {
          broadcastToRenderers('meeting:live-analysis-frame', {
            meetingId,
            ...frame,
          });
        },
        onStatus: (status: LiveAnalysisStatus) => {
          broadcastToRenderers('meeting:live-analysis-status', {
            meetingId,
            status,
          });
        },
      });
      liveAnalysisSubscribers.set(meetingId, subscriber);
      subscriber.start();
      return { started: true };
    },
  );
  ipcMain.handle(
    'meeting:live-analysis-stop',
    async (_e, payload: unknown): Promise<{ stopped: boolean }> => {
      const meetingId = parseResultReadArgs(payload);
      const subscriber = liveAnalysisSubscribers.get(meetingId);
      if (!subscriber) {
        return { stopped: false };
      }
      liveAnalysisSubscribers.delete(meetingId);
      await subscriber.stop('renderer-stop');
      return { stopped: true };
    },
  );
}
