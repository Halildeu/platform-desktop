import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  assertReleaseEnvironment,
  createMacReleaseManifest,
  verifyMacUpdateMetadata,
  writeMacReleaseManifest,
} from '../../scripts/macos-release-contract.mjs';

const repositoryRoot = new URL('../../', import.meta.url);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'platform-desktop-macos-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha512Base64(content: Buffer): string {
  return createHash('sha512').update(content).digest('base64');
}

function writeReleaseFixture(directory: string, version = '0.1.4') {
  const dmg = join(directory, `Meeting-Intelligence-${version}-universal.dmg`);
  const pkg = join(directory, `Meeting-Intelligence-${version}-universal.pkg`);
  const zip = join(directory, `Meeting-Intelligence-${version}-universal.zip`);
  const zipBlockmap = `${zip}.blockmap`;
  const metadata = join(directory, 'latest-mac.yml');
  const dmgNotary = join(directory, 'dmg-notary.json');
  const pkgNotary = join(directory, 'pkg-notary.json');
  const zipContent = Buffer.from('signed update zip fixture');
  const zipSha512 = sha512Base64(zipContent);

  writeFileSync(dmg, 'notarized dmg fixture');
  writeFileSync(pkg, 'signed installer fixture');
  writeFileSync(zip, zipContent);
  writeFileSync(zipBlockmap, 'zip blockmap fixture');
  writeFileSync(
    metadata,
    stringifyYaml({
      version,
      files: [
        {
          url: `Meeting-Intelligence-${version}-universal.zip`,
          sha512: zipSha512,
          size: zipContent.length,
        },
      ],
      path: `Meeting-Intelligence-${version}-universal.zip`,
      sha512: zipSha512,
      releaseDate: '2026-07-17T10:00:00.000Z',
    }),
  );
  writeFileSync(dmgNotary, JSON.stringify({ id: 'dmg-notary-submission-id', status: 'Accepted' }));
  writeFileSync(pkgNotary, JSON.stringify({ id: 'pkg-notary-submission-id', status: 'Accepted' }));

  return { dmg, dmgNotary, metadata, pkg, pkgNotary, zip, zipBlockmap, zipContent };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('macOS release credential contract', () => {
  it('fails closed without every protected credential and identity variable', () => {
    expect(() => assertReleaseEnvironment({})).toThrow(
      'Missing required macOS release environment',
    );
  });

  it('accepts temporary credential paths without returning their values', () => {
    const directory = temporaryDirectory();
    const appCertificate = join(directory, 'application.p12');
    const installerCertificate = join(directory, 'installer.p12');
    const apiKey = join(directory, 'AuthKey.p8');
    for (const path of [appCertificate, installerCertificate, apiKey]) {
      writeFileSync(path, 'credential fixture');
    }

    expect(
      assertReleaseEnvironment({
        CSC_LINK: appCertificate,
        CSC_KEY_PASSWORD: 'not-logged-app-password',
        CSC_INSTALLER_LINK: installerCertificate,
        CSC_INSTALLER_KEY_PASSWORD: 'not-logged-installer-password',
        APPLE_API_KEY: apiKey,
        APPLE_API_KEY_ID: 'KEYID12345',
        APPLE_API_ISSUER: 'issuer-id',
        EXPECTED_APPLE_TEAM_ID: 'TEAMID1234',
      }),
    ).toBeUndefined();
  });
});

describe('macOS updater and provenance contract', () => {
  it('binds latest-mac.yml to the exact update ZIP hash, size, and version', () => {
    const fixture = writeReleaseFixture(temporaryDirectory());

    expect(
      verifyMacUpdateMetadata({
        metadataPath: fixture.metadata,
        zipPath: fixture.zip,
        expectedVersion: '0.1.4',
      }),
    ).toEqual({
      sha512: sha512Base64(fixture.zipContent),
      size: fixture.zipContent.length,
      zipName: 'Meeting-Intelligence-0.1.4-universal.zip',
    });
  });

  it('rejects stale or altered update metadata', () => {
    const fixture = writeReleaseFixture(temporaryDirectory());
    writeFileSync(fixture.zip, 'changed after metadata generation');

    expect(() =>
      verifyMacUpdateMetadata({
        metadataPath: fixture.metadata,
        zipPath: fixture.zip,
        expectedVersion: '0.1.4',
      }),
    ).toThrow('digest or size does not match');
  });

  it('writes exact-source SHA-256 and notarization provenance', () => {
    const directory = temporaryDirectory();
    const fixture = writeReleaseFixture(directory);
    const options = {
      releaseDir: directory,
      packageName: 'Meeting Intelligence',
      appId: 'com.acik.platform.meeting-intelligence',
      version: '0.1.4',
      repository: 'Halildeu/platform-desktop',
      sourceSha: '2e0935a1345de3762fa0ac694443a2a9062c61a3',
      sourceRef: 'refs/heads/main',
      workflowRef: 'Halildeu/platform-desktop/.github/workflows/package-macos.yml@refs/heads/main',
      runId: '1234',
      runAttempt: '1',
      expectedTeamId: 'TEAMID1234',
      dmgNotaryResultPath: fixture.dmgNotary,
      pkgNotaryResultPath: fixture.pkgNotary,
      generatedAt: '2026-07-17T10:05:00.000Z',
    };

    const { manifest } = createMacReleaseManifest(options);
    const output = writeMacReleaseManifest(options);

    expect(manifest.source.commit).toBe(options.sourceSha);
    expect(manifest.application.version).toBe('0.1.4');
    expect(manifest.notarization).toMatchObject({
      tool: 'notarytool',
      dmgSubmissionId: 'dmg-notary-submission-id',
      pkgSubmissionId: 'pkg-notary-submission-id',
      stapledAndValidated: ['app', 'dmg', 'pkg'],
    });
    expect(manifest.updateContract).toMatchObject({
      implementation: 'electron-updater',
      directSparkleSdkDependency: false,
      payload: 'Meeting-Intelligence-0.1.4-universal.zip',
      blockmap: 'Meeting-Intelligence-0.1.4-universal.zip.blockmap',
    });
    expect(manifest.artifacts.map(({ kind }) => kind)).toEqual([
      'dmg',
      'pkg',
      'mac-update-zip',
      'update-blockmap',
      'update-metadata',
    ]);

    const persistedManifest = JSON.parse(readFileSync(output.manifestPath, 'utf8'));
    const sums = readFileSync(output.sumsPath, 'utf8');
    expect(persistedManifest).toEqual(manifest);
    expect(sums).toContain('Meeting-Intelligence-0.1.4-universal.dmg');
    expect(sums).toContain('Meeting-Intelligence-0.1.4-universal.pkg');
    expect(sums).not.toContain('not-logged');
  });
});

describe('macOS package workflow contract', () => {
  it('requires signed distribution config and a patch version beyond v0.1.3', () => {
    const packageJson = JSON.parse(readFileSync(new URL('package.json', repositoryRoot), 'utf8'));
    const releaseContractTypes = readFileSync(
      new URL('scripts/macos-release-contract.d.mts', repositoryRoot),
      'utf8',
    );
    const packageLock = JSON.parse(
      readFileSync(new URL('package-lock.json', repositoryRoot), 'utf8'),
    );

    expect(packageJson.version).toBe('0.1.4');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(packageJson.scripts['package:mac']).toContain('release:mac:assert-env');
    expect(packageJson.scripts['package:mac:unsigned']).toContain(
      'CSC_IDENTITY_AUTO_DISCOVERY=false',
    );
    expect(packageJson.scripts['package:mac:unsigned']).toContain(
      '--config.mac.forceCodeSigning=false',
    );
    expect(packageJson.build).toMatchObject({
      mac: {
        artifactName: 'Meeting-Intelligence-${version}-${arch}.${ext}',
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
        forceCodeSigning: true,
        hardenedRuntime: true,
        notarize: true,
        strictVerify: true,
        type: 'distribution',
        target: ['dmg', 'pkg', 'zip'],
      },
      dmg: {
        sign: false,
        writeUpdateInfo: false,
      },
    });
    expect(packageJson.build.mac.identity).not.toBe('-');
    expect(releaseContractTypes).toContain('pkgNotaryResultPath: string');
    expect(releaseContractTypes).toContain('pkgSubmissionId: string');
  });

  it('keeps capture rights off helper processes and forbids DYLD environment access', () => {
    const appEntitlements = readFileSync(
      new URL('build/entitlements.mac.plist', repositoryRoot),
      'utf8',
    );
    const inheritedEntitlements = readFileSync(
      new URL('build/entitlements.mac.inherit.plist', repositoryRoot),
      'utf8',
    );

    expect(appEntitlements).toContain('com.apple.security.device.audio-input');
    expect(appEntitlements).not.toContain('com.apple.security.screen-recording');
    expect(appEntitlements).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
    expect(inheritedEntitlements).toContain('com.apple.security.cs.allow-jit');
    expect(inheritedEntitlements).not.toContain('com.apple.security.device.audio-input');
    expect(inheritedEntitlements).not.toContain('com.apple.security.screen-recording');
  });

  it('isolates unsigned PR validation from the protected manual release job', () => {
    const workflowText = readFileSync(
      new URL('.github/workflows/package-macos.yml', repositoryRoot),
      'utf8',
    );
    const workflow = parseYaml(workflowText);
    const releaseJob = workflow.jobs['package-signed-release-candidate'];

    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    expect(releaseJob.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(releaseJob.environment).toBe('macos-production-release');
    expect(releaseJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflowText).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflowText).toContain('scripts/notarize-macos-artifacts.sh');
    expect(workflowText).toContain("'scripts/macos-release-contract.d.mts'");
    expect(workflowText).toContain('scripts/verify-macos-release.sh');
    expect(workflowText).toContain('cosign verify-blob');
    expect(workflowText).toContain('if-no-files-found: error');
    expect(workflowText).not.toContain('pull_request_target:');
    expect(workflowText).not.toContain('identity: "-"');
  });

  it('never passes the notarization password or private key value on the command line', () => {
    const notarizeScript = readFileSync(
      new URL('scripts/notarize-macos-artifacts.sh', repositoryRoot),
      'utf8',
    );

    expect(notarizeScript).toContain('--key "$APPLE_API_KEY"');
    expect(notarizeScript).toContain('--wait');
    expect(notarizeScript).not.toContain('--password');
    expect(notarizeScript).not.toContain('APPLE_API_KEY_P8_BASE64');
  });
});
