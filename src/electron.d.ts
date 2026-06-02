/**
 * TypeScript declaration for the preload bridge — see electron/preload.ts.
 */

import type { ElectronAPI } from '../electron/preload';

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
