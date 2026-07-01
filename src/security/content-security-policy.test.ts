import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Content-Security-Policy', () => {
  it('allows the local direct-STT websocket used by desktop dev/runtime smoke', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(html).toContain('connect-src');
    expect(html).toContain('wss://*.acik.com');
    expect(html).toContain('ws://127.0.0.1:*');
    expect(html).toContain('ws://localhost:*');
  });
});
