export interface MacUpdateMetadataOptions {
  metadataPath: string;
  zipPath: string;
  expectedVersion: string;
}

export interface MacReleaseManifestOptions {
  releaseDir: string;
  packageName: string;
  appId: string;
  version: string;
  repository: string;
  sourceSha: string;
  sourceRef: string;
  workflowRef: string;
  runId: string;
  runAttempt: string;
  expectedTeamId: string;
  dmgNotaryResultPath: string;
  pkgNotaryResultPath: string;
  generatedAt?: string;
}

export interface MacReleaseArtifactRecord {
  kind: 'dmg' | 'pkg' | 'mac-update-zip' | 'update-blockmap' | 'update-metadata';
  file: string;
  bytes: number;
  sha256: string;
}

export interface MacReleaseManifest {
  schemaVersion: number;
  generatedAt: string;
  application: {
    name: string;
    appId: string;
    version: string;
  };
  source: {
    repository: string;
    commit: string;
    ref: string;
  };
  build: {
    workflowRef: string;
    runId: string;
    runAttempt: string;
    architecture: 'universal';
  };
  signing: {
    applicationCertificate: 'Developer ID Application';
    installerCertificate: 'Developer ID Installer';
    expectedTeamId: string;
    hardenedRuntime: true;
  };
  notarization: {
    tool: 'notarytool';
    stapledAndValidated: string[];
    dmgSubmissionId: string;
    pkgSubmissionId: string;
  };
  updateContract: {
    implementation: 'electron-updater';
    directSparkleSdkDependency: false;
    payload: string;
    blockmap: string;
    metadata: string;
    sha512: string;
    bytes: number;
  };
  artifacts: MacReleaseArtifactRecord[];
}

export function assertReleaseEnvironment(
  env: Record<string, string | undefined>,
  fileExists?: (path: string) => boolean,
): void;

export function discoverMacReleaseArtifacts(releaseDir: string): {
  dmg: string;
  pkg: string;
  updateMetadata: string;
  zip: string;
  zipBlockmap: string;
};

export function verifyMacUpdateMetadata(options: MacUpdateMetadataOptions): {
  sha512: string;
  size: number;
  zipName: string;
};

export function createMacReleaseManifest(options: MacReleaseManifestOptions): {
  artifactRecords: MacReleaseArtifactRecord[];
  manifest: MacReleaseManifest;
  releaseDir: string;
};

export function writeMacReleaseManifest(options: MacReleaseManifestOptions): {
  manifestPath: string;
  sumsPath: string;
};
