import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0] + 'e2e/canonical-source.html';
});
test.afterAll(async () => {
  await server?.close();
});

for (const width of [1280, 390]) {
  test(`source navigation and reload at ${width}px (synthetic renderer)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          meeting: {
            getCanonicalTranscript: async (request: object) => ({
              ...request,
              finalizationVersion: 1,
              transcriptSha256: 'synthetic',
              sentences: [{ index: 0, text: 'Test plan approved.', sha256: 'test-hash' }],
            }),
          },
        },
      });
    });
    await page.goto(url);
    const link = page.getByRole('link', { name: 'Kaynak #1' });
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem', { name: 'Kaynak #1', exact: true })).toBeFocused();
    await expect(page.getByText('29817442:00')).toHaveCount(0);
    const source = page.getByRole('region', { name: 'Analizin kaynak transkripti' });
    const box = await source.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`source-${width}.png`), fullPage: true });
    await page.reload();
    await expect(link).toBeVisible();
  });
}
