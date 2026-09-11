import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { createHash } from 'node:crypto';
import { parseCanonicalTranscript } from '../electron/services/meeting/canonical-transcript';

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
    const request = {
      meetingId: '33333333-3333-4333-8333-333333333333',
      analysisRunId: '55555555-5555-4555-8555-555555555555',
      sessionId: '66666666-6666-4666-8666-666666666666',
    };
    const transcript = 'Test\nplan\napproved\n.\nFollow up\ntomorrow!';
    const parsed = parseCanonicalTranscript(
      {
        ...request,
        state: 'FINALIZED',
        finalizationVersion: 1,
        transcript,
        transcriptSha256: createHash('sha256').update(transcript).digest('hex'),
        segments: transcript.split('\n').map((text) => ({ text })),
        segmentCount: 6,
      },
      request,
    );
    await page.addInitScript((source) => {
      Object.defineProperty(window, 'electronAPI', {
        value: {
          meeting: {
            getCanonicalTranscript: async () => source,
          },
        },
      });
    }, parsed);
    await page.goto(url);
    const link = page.getByRole('link', { name: 'Kaynak #1' });
    await expect(link).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Kaynak #1', exact: true })).toHaveText(
      'Test plan approved.',
    );
    await expect(page.locator('.canonical-source-lines > li')).toHaveCount(2);
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
