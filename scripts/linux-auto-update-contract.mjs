#!/usr/bin/env node
/* global Buffer, console, process, URL */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const LINUX_STAGED_ROLLOUT_PERCENTAGES = Object.freeze([5, 25, 100]);

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function assertCanonicalVersion(versionInput) {
  const version = requireValue(versionInput, 'version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('version must be canonical semantic version');
  }
  return version;
}

export function digestFile(path, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function assertRolloutPercentage(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('stagingPercentage must be an integer from 0 through 100');
  }
  return value;
}

function assertArtifactUrl(value) {
  const artifactUrl = requireValue(value, 'artifactUrl');
  if (
    artifactUrl !== basename(artifactUrl) ||
    artifactUrl.includes('\0') ||
    !artifactUrl.endsWith('.AppImage')
  ) {
    throw new Error('artifactUrl must be a local AppImage basename');
  }
  return artifactUrl;
}

export function createLinuxUpdateMetadata({
  artifactPath: artifactPathInput,
  artifactUrl: artifactUrlInput,
  version: versionInput,
  stagingPercentage: stagingPercentageInput,
  releaseDate = '1970-01-01T00:00:00.000Z',
}) {
  const artifactPath = resolve(requireValue(artifactPathInput, 'artifactPath'));
  const artifactUrl = assertArtifactUrl(artifactUrlInput ?? basename(artifactPath));
  const version = assertCanonicalVersion(versionInput);
  const stagingPercentage =
    stagingPercentageInput === undefined
      ? undefined
      : assertRolloutPercentage(stagingPercentageInput);
  const sha512 = digestFile(artifactPath, 'sha512', 'base64');
  const size = statSync(artifactPath).size;

  return {
    version,
    files: [{ url: artifactUrl, sha512, size }],
    path: artifactUrl,
    sha512,
    releaseDate,
    ...(stagingPercentage === undefined ? {} : { stagingPercentage }),
  };
}

export function writeLinuxUpdateMetadata({ outputPath: outputPathInput, ...options }) {
  const outputPath = resolve(requireValue(outputPathInput, 'outputPath'));
  const metadata = createLinuxUpdateMetadata(options);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, stringifyYaml(metadata), { mode: 0o644 });
  renameSync(temporaryPath, outputPath);
  return metadata;
}

function readMetadata(metadataPathInput) {
  const metadataPath = resolve(requireValue(metadataPathInput, 'metadataPath'));
  const metadata = parseYaml(readFileSync(metadataPath, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('latest-linux.yml must contain a YAML object');
  }
  return metadata;
}

export function verifyLinuxUpdateMetadata({
  metadataPath,
  artifactPath: artifactPathInput,
  expectedVersion: expectedVersionInput,
  expectedStagingPercentage,
}) {
  const artifactPath = resolve(requireValue(artifactPathInput, 'artifactPath'));
  const expectedVersion = assertCanonicalVersion(expectedVersionInput);
  const expectedPercentage =
    expectedStagingPercentage === undefined
      ? undefined
      : assertRolloutPercentage(expectedStagingPercentage);
  const metadata = readMetadata(metadataPath);
  const artifactName = basename(artifactPath);
  const sha512 = digestFile(artifactPath, 'sha512', 'base64');
  const size = statSync(artifactPath).size;

  if (metadata.version !== expectedVersion) {
    throw new Error('latest-linux.yml version does not match the expected version');
  }
  if (expectedPercentage !== undefined && metadata.stagingPercentage !== expectedPercentage) {
    throw new Error('latest-linux.yml staged rollout percentage does not match');
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error('latest-linux.yml must reference at least one update payload');
  }
  const appImageEntries = metadata.files.filter(
    (entry) => entry && typeof entry.url === 'string' && entry.url.endsWith('.AppImage'),
  );
  if (appImageEntries.length !== 1) {
    throw new Error('latest-linux.yml must reference exactly one AppImage update payload');
  }
  const entry = appImageEntries[0];
  if (entry.url !== artifactName) {
    throw new Error('latest-linux.yml does not reference the exact AppImage basename');
  }
  if (entry.sha512 !== sha512 || entry.size !== size) {
    throw new Error('latest-linux.yml AppImage digest or size does not match the payload');
  }
  if (metadata.path !== artifactName || metadata.sha512 !== sha512) {
    throw new Error('latest-linux.yml primary pointer does not match the AppImage payload');
  }

  return { artifactName, metadata, sha512, size };
}

export function writeStagedRolloutSnapshots({
  artifactPath: artifactPathInput,
  version: versionInput,
  outputDirectory: outputDirectoryInput,
}) {
  const artifactPath = resolve(requireValue(artifactPathInput, 'artifactPath'));
  const version = assertCanonicalVersion(versionInput);
  const outputDirectory = resolve(requireValue(outputDirectoryInput, 'outputDirectory'));

  return LINUX_STAGED_ROLLOUT_PERCENTAGES.map((stagingPercentage) => {
    const directory = resolve(
      outputDirectory,
      `rollout-${String(stagingPercentage).padStart(3, '0')}`,
    );
    const metadataPath = resolve(directory, 'latest-linux.yml');
    writeLinuxUpdateMetadata({
      artifactPath,
      outputPath: metadataPath,
      stagingPercentage,
      version,
    });
    return metadataPath;
  });
}

export function verifyStagedRolloutSnapshots({
  artifactPath: artifactPathInput,
  expectedVersion: expectedVersionInput,
  metadataPaths,
}) {
  if (!Array.isArray(metadataPaths) || metadataPaths.length !== 3) {
    throw new Error('staged rollout requires exactly the 5%, 25%, and 100% snapshots');
  }
  const artifactPath = resolve(requireValue(artifactPathInput, 'artifactPath'));
  const expectedVersion = assertCanonicalVersion(expectedVersionInput);
  const verified = metadataPaths.map((metadataPath, index) =>
    verifyLinuxUpdateMetadata({
      metadataPath,
      artifactPath,
      expectedVersion,
      expectedStagingPercentage: LINUX_STAGED_ROLLOUT_PERCENTAGES[index],
    }),
  );
  const identities = new Set(
    verified.map(({ artifactName, sha512, size }) => `${artifactName}:${sha512}:${size}`),
  );
  if (identities.size !== 1) {
    throw new Error('staged rollout snapshots must promote one immutable AppImage identity');
  }
  return verified;
}

export function rolloutBucket(uuidInput) {
  const uuid = requireValue(uuidInput, 'uuid').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error('uuid must be canonical');
  }
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  return (bytes.readUInt32BE(12) / 0xffffffff) * 100;
}

export function isRolloutEligible(uuid, stagingPercentage) {
  return rolloutBucket(uuid) < assertRolloutPercentage(stagingPercentage);
}

export function assertLoopbackFeedUrl(urlInput) {
  const url = new URL(requireValue(urlInput, 'feedUrl'));
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port === ''
  ) {
    throw new Error('acceptance feed must be an unauthenticated http://127.0.0.1:<port>/ URL');
  }
  return url.toString();
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('arguments must use --name value pairs');
    }
    result.set(key.slice(2), value);
  }
  return result;
}

function main(command, argv) {
  const args = parseArguments(argv);
  if (command === 'create-snapshots') {
    const metadataPaths = writeStagedRolloutSnapshots({
      artifactPath: args.get('artifact'),
      version: args.get('version'),
      outputDirectory: args.get('output'),
    });
    verifyStagedRolloutSnapshots({
      artifactPath: args.get('artifact'),
      expectedVersion: args.get('version'),
      metadataPaths,
    });
    console.log('Linux 5%-25%-100% rollout snapshots bind one immutable AppImage');
    return;
  }
  if (command === 'verify-metadata') {
    verifyLinuxUpdateMetadata({
      metadataPath: args.get('metadata'),
      artifactPath: args.get('artifact'),
      expectedVersion: args.get('version'),
      expectedStagingPercentage: args.has('percentage')
        ? Number(args.get('percentage'))
        : undefined,
    });
    console.log('Linux update metadata binds the exact immutable AppImage');
    return;
  }
  throw new Error(
    'Usage: linux-auto-update-contract.mjs <create-snapshots|verify-metadata> --artifact PATH --version VERSION [--output DIR|--metadata PATH] [--percentage N]',
  );
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    main(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Linux update contract failed');
    process.exitCode = 1;
  }
}
