import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RELEASE_SMOKE_EVIDENCE_SCHEMA_VERSION = 1;

export interface ReleaseSmokeEvidence {
  schemaVersion: typeof RELEASE_SMOKE_EVIDENCE_SCHEMA_VERSION;
  runNonce: string;
  observedAt: string;
  version: string;
  pid: number;
  appImage: string;
}

interface WriteReleaseSmokeEvidenceOptions {
  enabled: boolean;
  evidencePath: string | undefined;
  runNonce: string | undefined;
  version: string;
  pid: number;
  appImagePath: string | undefined;
}

function assertCanonicalVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Release smoke version must be canonical semver');
  }
}

/**
 * Writes a test-only, local restart marker for the Linux updater acceptance.
 * The destination must not already exist; this prevents a stale or redirected
 * marker from being accepted as evidence for the newly launched process.
 */
export function writeReleaseSmokeEvidence(
  options: WriteReleaseSmokeEvidenceOptions,
): ReleaseSmokeEvidence | null {
  if (!options.enabled || options.evidencePath === undefined) {
    return null;
  }
  if (!path.isAbsolute(options.evidencePath) || options.evidencePath.includes('\0')) {
    throw new Error('Release smoke evidence path must be an absolute local path');
  }
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new Error('Release smoke PID must be a positive integer');
  }
  if (!options.appImagePath || !path.isAbsolute(options.appImagePath)) {
    throw new Error('Release smoke APPIMAGE must be an absolute path');
  }
  if (!options.runNonce || !/^[0-9a-f]{32}$/i.test(options.runNonce)) {
    throw new Error('Release smoke run nonce must be 128-bit hexadecimal');
  }
  assertCanonicalVersion(options.version);

  const evidence: ReleaseSmokeEvidence = {
    schemaVersion: RELEASE_SMOKE_EVIDENCE_SCHEMA_VERSION,
    runNonce: options.runNonce.toLowerCase(),
    observedAt: new Date().toISOString(),
    version: options.version,
    pid: options.pid,
    appImage: path.basename(options.appImagePath),
  };
  const temporaryPath = `${options.evidencePath}.${evidence.runNonce}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporaryPath, options.evidencePath);
  } finally {
    unlinkSync(temporaryPath);
  }
  return evidence;
}
