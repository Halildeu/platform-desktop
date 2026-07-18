import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CancellationToken } from 'builder-util-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { AcceptanceHttpExecutor } from '../../scripts/linux-auto-update-runtime.mjs';

describe('AcceptanceHttpExecutor', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it('downloads an updater artifact to the requested destination', async () => {
    const payload = Buffer.from('platform-desktop-updater-acceptance');
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Length': payload.length,
        'Content-Type': 'application/octet-stream',
      });
      response.end(payload);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));

    try {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe('string');
      if (!address || typeof address === 'string') {
        throw new Error('test server did not expose a TCP port');
      }

      const directory = await mkdtemp(join(tmpdir(), 'platform-desktop-updater-'));
      temporaryDirectories.push(directory);
      const destination = join(directory, 'candidate.AppImage');
      const executor = new AcceptanceHttpExecutor();

      await executor.download(
        new URL(`http://127.0.0.1:${address.port}/candidate.AppImage`),
        destination,
        {
          cancellationToken: new CancellationToken(),
        },
      );

      await expect(readFile(destination)).resolves.toEqual(payload);
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });
});
