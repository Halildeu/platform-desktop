import { describe, expect, it } from 'vitest';

import { parseCallback, waitForCallback } from './loopback-server';

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('parseCallback (saf)', () => {
  it('code + state çıkarır', () => {
    expect(parseCallback('/callback?code=ABC&state=ST')).toEqual({
      code: 'ABC',
      state: 'ST',
      error: undefined,
    });
  });
  it('error param', () => {
    expect(parseCallback('/callback?error=access_denied').error).toBe('access_denied');
  });
  it('eksik → undefined', () => {
    expect(parseCallback('/callback')).toEqual({
      code: undefined,
      state: undefined,
      error: undefined,
    });
  });
});

describe('waitForCallback (gerçek http, loopback)', () => {
  it('doğru code+state → resolve, sonra kapanır', async () => {
    const port = 18765;
    const expectation = expect(waitForCallback(port, 'ST', 5_000)).resolves.toEqual({
      code: 'ABC',
      state: 'ST',
    });
    await tick();
    await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=ST`).catch(() => undefined);
    await expectation;
  });

  it('state mismatch → reject', async () => {
    const port = 18766;
    const expectation = expect(waitForCallback(port, 'ST', 5_000)).rejects.toThrow(
      'state mismatch',
    );
    await tick();
    await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=WRONG`).catch(() => undefined);
    await expectation;
  });

  it('oauth error param → reject', async () => {
    const port = 18767;
    const expectation = expect(waitForCallback(port, 'ST', 5_000)).rejects.toThrow('oauth error');
    await tick();
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`).catch(() => undefined);
    await expectation;
  });
});
