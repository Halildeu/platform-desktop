export const LINUX_STAGED_ROLLOUT_PERCENTAGES: readonly [5, 25, 100];

export interface LinuxUpdateMetadataOptions {
  artifactPath: string;
  artifactUrl?: string;
  version: string;
  stagingPercentage?: number;
  releaseDate?: string;
}

export interface LinuxUpdateMetadata {
  version: string;
  files: Array<{ url: string; sha512: string; size: number }>;
  path: string;
  sha512: string;
  releaseDate: string;
  stagingPercentage?: number;
}

export function assertCanonicalVersion(version: string): string;
export function digestFile(path: string, algorithm: string, encoding: 'hex' | 'base64'): string;
export function createLinuxUpdateMetadata(options: LinuxUpdateMetadataOptions): LinuxUpdateMetadata;
export function writeLinuxUpdateMetadata(
  options: LinuxUpdateMetadataOptions & { outputPath: string },
): LinuxUpdateMetadata;
export function verifyLinuxUpdateMetadata(options: {
  metadataPath: string;
  artifactPath: string;
  expectedVersion: string;
  expectedStagingPercentage?: number;
}): {
  artifactName: string;
  metadata: LinuxUpdateMetadata;
  sha512: string;
  size: number;
};
export function writeStagedRolloutSnapshots(options: {
  artifactPath: string;
  version: string;
  outputDirectory: string;
}): string[];
export function verifyStagedRolloutSnapshots(options: {
  artifactPath: string;
  expectedVersion: string;
  metadataPaths: string[];
}): Array<{
  artifactName: string;
  metadata: LinuxUpdateMetadata;
  sha512: string;
  size: number;
}>;
export function rolloutBucket(uuid: string): number;
export function isRolloutEligible(uuid: string, stagingPercentage: number): boolean;
export function assertLoopbackFeedUrl(url: string): string;
