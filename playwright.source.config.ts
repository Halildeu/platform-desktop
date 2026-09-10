import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'canonical-source.spec.ts',
  workers: 1,
  use: { browserName: 'chromium', headless: true },
});
