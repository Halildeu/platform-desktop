import { ipcMain } from 'electron';

import {
  createMeetingContract,
  loadMeetingConfig,
  type CreateMeetingContractArgs,
  type MeetingContract,
} from '../services/meeting/meeting-client';
import { getValidAccessToken } from './auth';

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

export function registerMeetingIpc(): void {
  ipcMain.handle('meeting:create-contract', async (_e, payload: unknown): Promise<MeetingContract> => {
    const args = parseCreateArgs(payload);
    return createMeetingContract(loadMeetingConfig(), await getValidAccessToken(), args);
  });
}
