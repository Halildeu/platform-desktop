import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  assertLoopbackFeedUrl,
  isRolloutEligible,
  rolloutBucket,
  verifyLinuxUpdateMetadata,
  verifyStagedRolloutSnapshots,
  writeLinuxUpdateMetadata,
  writeStagedRolloutSnapshots,
} from '../../scripts/linux-auto-update-contract.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'linux-update-contract-'));
  const artifactPath = join(directory, 'Meeting-Intelligence-0.1.4-x86_64.AppImage');
  writeFileSync(artifactPath, 'immutable-appimage-payload');
  return { artifactPath, directory };
}

describe('Linux auto-update acceptance contract', () => {
  it('binds latest-linux.yml to the exact AppImage bytes and rollout percentage', () => {
    const { artifactPath, directory } = fixture();
    const metadataPath = join(directory, 'latest-linux.yml');
    writeLinuxUpdateMetadata({
      artifactPath,
      outputPath: metadataPath,
      stagingPercentage: 25,
      version: '0.1.4',
    });

    expect(
      verifyLinuxUpdateMetadata({
        metadataPath,
        artifactPath,
        expectedStagingPercentage: 25,
        expectedVersion: '0.1.4',
      }),
    ).toMatchObject({ artifactName: 'Meeting-Intelligence-0.1.4-x86_64.AppImage' });

    appendFileSync(artifactPath, '-tampered');
    expect(() =>
      verifyLinuxUpdateMetadata({
        metadataPath,
        artifactPath,
        expectedStagingPercentage: 25,
        expectedVersion: '0.1.4',
      }),
    ).toThrow(/digest or size/);
  });

  it('requires the monotonic 5%-25%-100% snapshots to promote one immutable identity', () => {
    const { artifactPath, directory } = fixture();
    const metadataPaths = writeStagedRolloutSnapshots({
      artifactPath,
      outputDirectory: join(directory, 'rollout'),
      version: '0.1.4',
    });

    expect(
      metadataPaths.map((path) => parseYaml(readFileSync(path, 'utf8')).stagingPercentage),
    ).toEqual([5, 25, 100]);
    expect(
      verifyStagedRolloutSnapshots({
        artifactPath,
        expectedVersion: '0.1.4',
        metadataPaths,
      }),
    ).toHaveLength(3);

    const wrongOrder = [metadataPaths[1], metadataPaths[0], metadataPaths[2]];
    expect(() =>
      verifyStagedRolloutSnapshots({
        artifactPath,
        expectedVersion: '0.1.4',
        metadataPaths: wrongOrder,
      }),
    ).toThrow(/percentage/);
  });

  it('omits stagingPercentage for the true universal rollout metadata', () => {
    const { artifactPath, directory } = fixture();
    const metadataPath = join(directory, 'latest-linux.yml');
    writeLinuxUpdateMetadata({
      artifactPath,
      outputPath: metadataPath,
      version: '0.1.4',
    });

    const metadata = parseYaml(readFileSync(metadataPath, 'utf8'));
    expect(metadata).not.toHaveProperty('stagingPercentage');
    expect(
      verifyLinuxUpdateMetadata({
        metadataPath,
        artifactPath,
        expectedVersion: '0.1.4',
      }),
    ).toMatchObject({ artifactName: 'Meeting-Intelligence-0.1.4-x86_64.AppImage' });
  });

  it('uses the same deterministic cohort boundary as electron-updater', () => {
    const fiveIn = '00000000-0000-4000-8000-00000ccccccc';
    const fiveOut = '00000000-0000-4000-8000-00000ccccccd';
    const quarterIn = '00000000-0000-4000-8000-00003fffffff';
    const quarterOut = '00000000-0000-4000-8000-000040000000';
    const hundredIn = '00000000-0000-4000-8000-0000fffffffe';
    const hundredOut = '00000000-0000-4000-8000-0000ffffffff';

    expect(rolloutBucket(fiveIn)).toBeLessThan(5);
    expect(rolloutBucket(fiveOut)).toBeGreaterThanOrEqual(5);
    expect(isRolloutEligible(fiveIn, 5)).toBe(true);
    expect(isRolloutEligible(fiveOut, 5)).toBe(false);
    expect(isRolloutEligible(quarterIn, 25)).toBe(true);
    expect(isRolloutEligible(quarterOut, 25)).toBe(false);
    expect(isRolloutEligible(hundredIn, 100)).toBe(true);
    expect(isRolloutEligible(hundredOut, 100)).toBe(false);
  });

  it('allows only an ephemeral loopback HTTP feed for the acceptance runtime', () => {
    expect(assertLoopbackFeedUrl('http://127.0.0.1:42137/')).toBe('http://127.0.0.1:42137/');
    expect(() => assertLoopbackFeedUrl('https://127.0.0.1:42137/')).toThrow();
    expect(() => assertLoopbackFeedUrl('http://example.com:42137/')).toThrow();
    expect(() => assertLoopbackFeedUrl('http://token@127.0.0.1:42137/')).toThrow();
  });
});
