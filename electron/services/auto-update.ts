/**
 * Auto-update — #11. Thin wrapper around electron-updater; GitHub Releases
 * publish target already configured (package.json build.publish). Signature/
 * hash verification is electron-updater's own built-in behavior (it refuses
 * an update whose signature doesn't match the published latest.yml/-mac.yml/
 * -linux.yml hash) — not re-implemented here.
 *
 * Staged rollout (5% -> 25% -> 100%) is a release-metadata concern
 * (electron-builder writes `stagingPercentage` into the published
 * latest*.yml when `--publish` is run with that option), not application
 * code — nothing to wire here beyond checking for updates.
 *
 * No-ops outside a packaged build (isPackaged=false) so `npm run dev` never
 * tries to hit GitHub Releases.
 */

import { app } from 'electron';
// electron-updater is CommonJS; under Electron 42 / Node ESM ("type":"module")
// a named import (`import { autoUpdater }`) fails at runtime with
// "does not provide an export named 'autoUpdater'". The CJS module.exports is
// only reachable via the default import, so destructure autoUpdater from it (#44).
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

let initialized = false;

export function initAutoUpdate(): void {
  if (initialized || !app.isPackaged) {
    return;
  }
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err: Error) => {
    // KVKK-safe: class/message only, no user/meeting data ever touches this path.
    console.warn('Auto-update error', err.name, err.message);
  });

  void autoUpdater.checkForUpdatesAndNotify();
}
