/**
 * Auto-launch on system startup — #6. Opsiyonel kullanıcı tercihi (default
 * kapalı); OS'nin kendi login-item mekanizmasını kullanır (ayrı bir
 * persistence katmanı gerekmez, `app.getLoginItemSettings()` source of truth).
 */

import { app } from 'electron';

export function isAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutoLaunchEnabled(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
}
