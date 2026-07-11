import type { MeetingAiAnalyzeRequest } from '../transcript/session-transcript';

export interface MeetingAiSubmitPayload {
  meetingId: string;
  request: MeetingAiAnalyzeRequest;
}

export type MeetingAiAnalyzeResponse = Record<string, unknown>;
