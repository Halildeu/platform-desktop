#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const REQUIRED_RELEASE_ENV = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_INSTALLER_LINK',
  'CSC_INSTALLER_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'EXPECTED_APPLE_TEAM_ID',
];

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('PACKAGE_VERSION must be a canonical semantic version');
  }
  return version;
}

export function assertReleaseEnvironment(env, fileExists = existsSync) {
  const missing = REQUIRED_RELEASE_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required macOS release environment: ${missing.join(', ')}`);
  }

  for (const name of ['CSC_LINK', 'CSC_INSTALLER_LINK', 'APPLE_API_KEY']) {
    if (!fileExists(env[name])) {
      throw new Error(`${name} must point to a readable temporary credential file`);
    }
  }

  if (!/^[A-Z0-9]{10}$/.test(env.EXPECTED_APPLE_TEAM_ID)) {
    throw new Error('EXPECTED_APPLE_TEAM_ID must be a 10-character Apple Team ID');
  }
}

function digestFile(path, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function singleFile(releaseDir, predicate, label) {
  const matches = readdirSync(releaseDir).filter(predicate).sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}`);
  }
  return join(releaseDir, matches[0]);
}

export function discoverMacReleaseArtifacts(releaseDirInput) {
  const releaseDir = resolve(releaseDirInput);
  return {
    dmg: singleFile(releaseDir, (name) => name.endsWith('.dmg'), 'DMG'),
    pkg: singleFile(releaseDir, (name) => name.endsWith('.pkg'), 'PKG'),
    updateMetadata: singleFile(releaseDir, (name) => name === 'latest-mac.yml', 'latest-mac.yml'),
    zip: singleFile(releaseDir, (name) => name.endsWith('.zip'), 'macOS update ZIP'),
    zipBlockmap: singleFile(
      releaseDir,
      (name) => name.endsWith('.zip.blockmap'),
      'macOS update ZIP blockmap',
    ),
  };
}

export function verifyMacUpdateMetadata({ metadataPath, zipPath, expectedVersion }) {
  const version = assertVersion(requireValue(expectedVersion, 'expectedVersion'));
  const metadata = parseYaml(readFileSync(metadataPath, 'utf8'));
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('latest-mac.yml must contain a YAML object');
  }
  if (metadata.version !== version) {
    throw new Error('latest-mac.yml version does not match package version');
  }

  const zipName = basename(zipPath);
  const expectedSha512 = digestFile(zipPath, 'sha512', 'base64');
  const expectedSize = statSync(zipPath).size;
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  if (files.length !== 1) {
    throw new Error('latest-mac.yml must reference only the immutable update ZIP');
  }
  const zipEntry = files.find((entry) => entry && entry.url === zipName);

  if (!zipEntry) {
    throw new Error('latest-mac.yml does not reference the exact update ZIP');
  }
  if (zipEntry.sha512 !== expectedSha512 || zipEntry.size !== expectedSize) {
    throw new Error('latest-mac.yml ZIP digest or size does not match the artifact');
  }
  if (metadata.path !== zipName || metadata.sha512 !== expectedSha512) {
    throw new Error('latest-mac.yml primary update pointer does not match the artifact');
  }

  return { sha512: expectedSha512, size: expectedSize, zipName };
}

function artifactRecord(path, kind, version) {
  const name = basename(path);
  if (!name.includes(version) && kind !== 'update-metadata') {
    throw new Error(`${kind} artifact name is not bound to package version ${version}`);
  }
  return {
    kind,
    file: name,
    bytes: statSync(path).size,
    sha256: digestFile(path, 'sha256', 'hex'),
  };
}

export function createMacReleaseManifest({
  releaseDir: releaseDirInput,
  packageName,
  appId,
  version: versionInput,
  repository,
  sourceSha,
  sourceRef,
  workflowRef,
  runId,
  runAttempt,
  expectedTeamId,
  dmgNotaryResultPath,
  pkgNotaryResultPath,
  generatedAt = new Date().toISOString(),
}) {
  const releaseDir = resolve(requireValue(releaseDirInput, 'releaseDir'));
  const version = assertVersion(requireValue(versionInput, 'version'));
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('sourceSha must be an exact 40-character Git commit SHA');
  }
  if (!/^[A-Z0-9]{10}$/.test(expectedTeamId)) {
    throw new Error('expectedTeamId must be a 10-character Apple Team ID');
  }

  const artifacts = discoverMacReleaseArtifacts(releaseDir);
  const update = verifyMacUpdateMetadata({
    metadataPath: artifacts.updateMetadata,
    zipPath: artifacts.zip,
    expectedVersion: version,
  });
  const readAcceptedNotaryResult = (path, label) => {
    const result = JSON.parse(readFileSync(path, 'utf8'));
    if (result.status !== 'Accepted' || typeof result.id !== 'string' || result.id.length === 0) {
      throw new Error(`${label} notarytool evidence is not Accepted`);
    }
    return result;
  };
  const dmgNotaryResult = readAcceptedNotaryResult(dmgNotaryResultPath, 'DMG');
  const pkgNotaryResult = readAcceptedNotaryResult(pkgNotaryResultPath, 'PKG');

  const artifactRecords = [
    artifactRecord(artifacts.dmg, 'dmg', version),
    artifactRecord(artifacts.pkg, 'pkg', version),
    artifactRecord(artifacts.zip, 'mac-update-zip', version),
    artifactRecord(artifacts.zipBlockmap, 'update-blockmap', version),
    artifactRecord(artifacts.updateMetadata, 'update-metadata', version),
  ];

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    application: {
      name: requireValue(packageName, 'packageName'),
      appId: requireValue(appId, 'appId'),
      version,
    },
    source: {
      repository: requireValue(repository, 'repository'),
      commit: sourceSha,
      ref: requireValue(sourceRef, 'sourceRef'),
    },
    build: {
      workflowRef: requireValue(workflowRef, 'workflowRef'),
      runId: requireValue(runId, 'runId'),
      runAttempt: requireValue(runAttempt, 'runAttempt'),
      architecture: 'universal',
    },
    signing: {
      applicationCertificate: 'Developer ID Application',
      installerCertificate: 'Developer ID Installer',
      expectedTeamId,
      hardenedRuntime: true,
    },
    notarization: {
      tool: 'notarytool',
      stapledAndValidated: ['app', 'dmg', 'pkg'],
      dmgSubmissionId: dmgNotaryResult.id,
      pkgSubmissionId: pkgNotaryResult.id,
    },
    updateContract: {
      implementation: 'electron-updater',
      directSparkleSdkDependency: false,
      payload: update.zipName,
      blockmap: basename(artifacts.zipBlockmap),
      metadata: basename(artifacts.updateMetadata),
      sha512: update.sha512,
      bytes: update.size,
    },
    artifacts: artifactRecords,
  };

  return { artifactRecords, manifest, releaseDir };
}

export function writeMacReleaseManifest(options) {
  const { artifactRecords, manifest, releaseDir } = createMacReleaseManifest(options);
  const manifestPath = join(releaseDir, 'macos-release-provenance.json');
  const sumsPath = join(releaseDir, 'SHA256SUMS-macos.txt');
  const temporaryManifestPath = `${manifestPath}.tmp`;
  const temporarySumsPath = `${sumsPath}.tmp`;

  writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  writeFileSync(
    temporarySumsPath,
    `${artifactRecords.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n')}\n`,
    { mode: 0o644 },
  );
  renameSync(temporaryManifestPath, manifestPath);
  renameSync(temporarySumsPath, sumsPath);

  return { manifestPath, sumsPath };
}

function packageConfiguration() {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

function main(command, env) {
  if (command === 'assert-env') {
    assertReleaseEnvironment(env);
    console.log('macOS release credential contract is present');
    return;
  }

  const packageJson = packageConfiguration();
  const artifacts = env.MACOS_RELEASE_DIR
    ? discoverMacReleaseArtifacts(env.MACOS_RELEASE_DIR)
    : undefined;

  if (command === 'verify-update') {
    verifyMacUpdateMetadata({
      metadataPath: artifacts.updateMetadata,
      zipPath: artifacts.zip,
      expectedVersion: env.PACKAGE_VERSION,
    });
    console.log('macOS update metadata matches the signed ZIP payload');
    return;
  }

  if (command === 'create-manifest') {
    const output = writeMacReleaseManifest({
      releaseDir: env.MACOS_RELEASE_DIR,
      packageName: packageJson.build?.productName ?? packageJson.productName ?? packageJson.name,
      appId: packageJson.build?.appId,
      version: env.PACKAGE_VERSION,
      repository: env.GITHUB_REPOSITORY,
      sourceSha: env.GITHUB_SHA,
      sourceRef: env.GITHUB_REF,
      workflowRef: env.GITHUB_WORKFLOW_REF,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      expectedTeamId: env.EXPECTED_APPLE_TEAM_ID,
      dmgNotaryResultPath: env.MACOS_DMG_NOTARY_RESULT,
      pkgNotaryResultPath: env.MACOS_PKG_NOTARY_RESULT,
    });
    console.log(`wrote ${basename(output.manifestPath)} and ${basename(output.sumsPath)}`);
    return;
  }

  throw new Error('Usage: macos-release-contract.mjs <assert-env|verify-update|create-manifest>');
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    main(process.argv[2], process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'macOS release contract failed');
    process.exitCode = 1;
  }
}
