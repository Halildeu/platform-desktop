import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
}));

import { requireSavePdfRequest } from './export';

describe('export:save-pdf request validation (#5)', () => {
  it('accepts an exported meeting file name with HTML content', () => {
    expect(
      requireSavePdfRequest({
        fileName: 'meeting-intelligence-2e41f58c-2026-09-18T10-04-22-000Z.pdf',
        html: '<!doctype html><p>ok</p>',
      }),
    ).toEqual({
      fileName: 'meeting-intelligence-2e41f58c-2026-09-18T10-04-22-000Z.pdf',
      html: '<!doctype html><p>ok</p>',
    });
  });

  it.each([
    '../meeting-intelligence-x.pdf',
    'meeting-intelligence-x.exe',
    'C:\\Users\\x\\meeting-intelligence-x.pdf',
    'other-x.pdf',
    'meeting-intelligence-a/b.pdf',
  ])('rejects the unsafe file name %s', (fileName) => {
    expect(() => requireSavePdfRequest({ fileName, html: '<p>x</p>' })).toThrow(
      'PDF file name is invalid',
    );
  });

  it('rejects empty or oversized content', () => {
    expect(() =>
      requireSavePdfRequest({ fileName: 'meeting-intelligence-x.pdf', html: '' }),
    ).toThrow('PDF content is empty');
    expect(() =>
      requireSavePdfRequest({
        fileName: 'meeting-intelligence-x.pdf',
        html: 'x'.repeat(2 * 1024 * 1024 + 1),
      }),
    ).toThrow('PDF content is too large');
  });
});
