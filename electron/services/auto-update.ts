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

import { app, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

let initialized = false;

async function checkForUpdatesSafely(): Promise<void> {
  let updateCheck;

  try {
    updateCheck = await autoUpdater.checkForUpdates();
  } catch {
    console.warn('Auto-update check failed');
    return;
  }

  if (!updateCheck?.downloadPromise) {
    return;
  }

  try {
    await updateCheck.downloadPromise;
  } catch {
    console.warn('Auto-update download failed');
    return;
  }

  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update ready',
        body: 'Meeting Intelligence will install the update when you quit.',
      }).show();
    }
  } catch {
    console.warn('Auto-update notification failed');
  }
}

export function initAutoUpdate(): void {
  if (initialized || !app.isPackaged) {
    return;
  }
  initialized = true;

  // electron-updater defaults to console and may log response headers or URLs.
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', () => {
    console.warn('Auto-update error');
  });

  void checkForUpdatesSafely();
}
