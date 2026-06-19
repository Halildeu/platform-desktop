import { defineConfig } from 'vitest/config';

/**
 * Vitest config — vite.config.ts'ten ayrı tutulur ki testler Electron build
 * plugin'ine (vite-plugin-electron) bağımlı olmasın. Unit testler saf Node/
 * TS mantığını koşar; renderer DOM testleri gerekince ayrı `environment` eklenir.
 *
 * passWithNoTests: bu CI-altyapı dalında henüz test yok (login/audio ayrı
 * dallarda); onlar merge olunca gerçek testler koşar.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'dist-electron', 'release'],
    passWithNoTests: true,
  },
});
