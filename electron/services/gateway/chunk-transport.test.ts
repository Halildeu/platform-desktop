import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from 'vitest';

import { ChunkSender } from './chunk-sender';

it('recovers a real lost HTTP response before sending the next chunk or finish', async () => {
  const requests: { seq: string; key: string; body: string }[] = [];
  const admitted = new Map<string, string>();
  let finished = false;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/sessions')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sessionId: 'SES-transport', sttProvider: 'internal' }));
      return;
    }
    if (req.url?.endsWith('/finish')) {
      finished = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          sessionId: 'SES-transport',
          correlationId: 'test',
          finalState: 'FINISHED',
          finishedAtMs: 1781820000000,
          alreadyFinished: false,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = {
      seq: String(req.headers['x-audio-chunk-seq']),
      key: String(req.headers['idempotency-key']),
      body: Buffer.concat(chunks).toString('hex'),
    };
    requests.push(request);
    const prior = admitted.get(request.seq);
    const identity = `${request.key}:${request.body}`;
    if (prior !== undefined && prior !== identity) {
      res.statusCode = 409;
      res.end();
      return;
    }
    admitted.set(request.seq, identity);
    if (requests.length === 1) {
      // Simulate admission followed by a response lost on the network.
      req.socket.destroy();
      return;
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const sender = new ChunkSender({ baseUrl: `http://127.0.0.1:${port}` }, () => 'synthetic');
    await sender.start('22222222-2222-4222-8222-222222222222', 'synthetic');
    const first = sender.send(new Uint8Array([1, 2]), 0);
    const second = sender.send(new Uint8Array([3, 4]), 10);
    await expect(first).resolves.toBe(0);
    await expect(second).resolves.toBe(1);
    await sender.finish();
    expect(requests.map((request) => request.seq)).toEqual(['0', '0', '1']);
    expect(requests[1]).toEqual(requests[0]);
    expect(admitted.size).toBe(2);
    expect(sender.nextSeq()).toBe(2);
    expect(sender.getState()).toBe('finished');
    expect(finished).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
