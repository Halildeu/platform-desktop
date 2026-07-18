import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeReleaseSmokeEvidence } from './release-smoke-evidence.js';

describe('writeReleaseSmokeEvidence', () => {
  it('does nothing outside the explicit release smoke gate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-smoke-disabled-'));
    const evidencePath = join(directory, 'restart.json');

    expect(
      writeReleaseSmokeEvidence({
        enabled: false,
        evidencePath,
        runNonce: undefined,
        version: '0.1.4',
        pid: 42,
        appImagePath: '/tmp/Meeting-Intelligence-0.1.4-x86_64.AppImage',
      }),
    ).toBeNull();
    expect(() => lstatSync(evidencePath)).toThrow();
  });

  it('writes only the version, PID, and AppImage basename with owner-only permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-smoke-enabled-'));
    const evidencePath = join(directory, 'restart.json');

    const evidence = writeReleaseSmokeEvidence({
      enabled: true,
      evidencePath,
      runNonce: '0123456789abcdef0123456789abcdef',
      version: '0.1.4',
      pid: 4242,
      appImagePath: '/tmp/private-path/Meeting-Intelligence-0.1.4-x86_64.AppImage',
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      runNonce: '0123456789abcdef0123456789abcdef',
      observedAt: expect.any(String),
      version: '0.1.4',
      pid: 4242,
      appImage: 'Meeting-Intelligence-0.1.4-x86_64.AppImage',
    });
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toEqual(evidence);
    expect(lstatSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(evidencePath, 'utf8')).not.toContain('private-path');
  });

  it('refuses stale files and symlink destinations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'release-smoke-exclusive-'));
    const targetPath = join(directory, 'target.json');
    const symlinkEvidencePath = join(directory, 'restart-link.json');
    const staleEvidencePath = join(directory, 'restart-stale.json');
    symlinkSync(targetPath, symlinkEvidencePath);
    writeFileSync(staleEvidencePath, '{"stale":true}\n');

    expect(() =>
      writeReleaseSmokeEvidence({
        enabled: true,
        evidencePath: symlinkEvidencePath,
        runNonce: '0123456789abcdef0123456789abcdef',
        version: '0.1.4',
        pid: 42,
        appImagePath: '/tmp/Meeting-Intelligence-0.1.4-x86_64.AppImage',
      }),
    ).toThrow();
    expect(() =>
      writeReleaseSmokeEvidence({
        enabled: true,
        evidencePath: staleEvidencePath,
        runNonce: 'fedcba9876543210fedcba9876543210',
        version: '0.1.4',
        pid: 43,
        appImagePath: '/tmp/Meeting-Intelligence-0.1.4-x86_64.AppImage',
      }),
    ).toThrow();
  });
});
