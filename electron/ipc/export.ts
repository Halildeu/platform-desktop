/**
 * Export IPC (desktop#5): renders the meeting output as a real PDF file.
 *
 * The renderer builds a self-contained, escaped HTML document of the output
 * only (summary, decisions, actions). The main process loads it in a hidden,
 * sandboxed window with JavaScript disabled, prints it to PDF and writes the
 * file to the user's Downloads folder, like the other exports. Before this the
 * PDF button called window.print(): the whole app window went to the system
 * print dialog, the preview stayed empty and no file was produced.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const PDF_FILE_NAME_PATTERN = /^meeting-intelligence-[A-Za-z0-9._-]{1,160}\.pdf$/;
const MAX_PDF_HTML_BYTES = 2 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 30_000;

export interface SavePdfRequest {
  fileName: string;
  html: string;
}

export interface SavePdfResult {
  fileName: string;
}

export function requireSavePdfRequest(payload: unknown): SavePdfRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PDF export request is invalid');
  }
  const { fileName, html } = payload as Record<string, unknown>;
  if (typeof fileName !== 'string' || !PDF_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error('PDF file name is invalid');
  }
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('PDF content is empty');
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_PDF_HTML_BYTES) {
    throw new Error('PDF content is too large');
  }
  return { fileName, html };
}

async function renderPdf(html: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  try {
    const load = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF render timed out')), PDF_RENDER_TIMEOUT_MS);
    });
    try {
      await Promise.race([load, timeout]);
      return await Promise.race([
        window.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    window.destroy();
  }
}

export function registerExportIpc(): void {
  ipcMain.handle('export:save-pdf', async (_event, payload: unknown): Promise<SavePdfResult> => {
    const request = requireSavePdfRequest(payload);
    const pdf = await renderPdf(request.html);
    const target = path.join(app.getPath('downloads'), request.fileName);
    // 'wx': never overwrite an existing file; names carry a millisecond stamp.
    await writeFile(target, pdf, { flag: 'wx' });
    return { fileName: request.fileName };
  });
}
