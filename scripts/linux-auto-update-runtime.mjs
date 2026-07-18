#!/usr/bin/env node
/* global console, process, setTimeout, URL */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { arch as osArchitecture, release as osRelease, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  assertCanonicalVersion,
  assertLoopbackFeedUrl,
  digestFile,
  isRolloutEligible,
  writeLinuxUpdateMetadata,
  writeStagedRolloutSnapshots,
  verifyStagedRolloutSnapshots,
} from './linux-auto-update-contract.mjs';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor.js');
const { AppImageUpdater } = require('electron-updater/out/AppImageUpdater.js');
const electronVersion = require('electron/package.json').version;
const electronUpdaterVersion = require('electron-updater/package.json').version;

const COHORTS = Object.freeze({
  fiveIn: '00000000-0000-4000-8000-00000ccccccc',
  fiveOut: '00000000-0000-4000-8000-00000ccccccd',
  quarterIn: '00000000-0000-4000-8000-00003fffffff',
  quarterOut: '00000000-0000-4000-8000-000040000000',
  hundredIn: '00000000-0000-4000-8000-0000fffffffe',
  hundredOut: '00000000-0000-4000-8000-0000ffffffff',
});

const COHORTS_BY_PERCENTAGE = new Map([
  [5, { in: COHORTS.fiveIn, out: COHORTS.fiveOut }],
  [25, { in: COHORTS.quarterIn, out: COHORTS.quarterOut }],
  [100, { in: COHORTS.hundredIn, out: COHORTS.hundredOut }],
]);

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
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

function assertLinux() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('the AppImageUpdater runtime acceptance requires a Linux x64 runner');
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitFor(predicate, label, timeoutMilliseconds = 45_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await sleep(250);
  }
  throw new Error(`${label} was not observed within ${timeoutMilliseconds} ms`);
}

function killProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
}

function scanProcessesByAppImage(appImagePath) {
  const expected = `APPIMAGE=${appImagePath}`;
  const processRoot = '/proc';
  if (!existsSync(processRoot)) {
    return [];
  }
  return readdirSync(processRoot)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      try {
        const environment = readFileSync(join(processRoot, String(pid), 'environ'));
        return environment.toString('utf8').split('\0').includes(expected);
      } catch {
        return false;
      }
    });
}

function readProcessEnvironment(pid) {
  const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
  return new Map(
    entries.map((entry) => {
      const separatorIndex = entry.indexOf('=');
      return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
    }),
  );
}

function readRunningPackagedVersion(pids) {
  for (const pid of pids) {
    try {
      const appDirectory = readProcessEnvironment(pid).get('APPDIR');
      if (!appDirectory) continue;
      const appAsar = join(appDirectory, 'resources', 'app.asar');
      if (!existsSync(appAsar)) continue;
      const packageJson = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'));
      return { pid, version: assertCanonicalVersion(packageJson.version) };
    } catch {
      // A short-lived helper can disappear while /proc is inspected.
    }
  }
  throw new Error('no running APPIMAGE process exposed a readable packaged app.asar');
}

function processGroupRoot(pids) {
  const pidSet = new Set(pids);
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
      if (!pidSet.has(parent)) {
        return pid;
      }
    } catch {
      // The process can exit between discovery and status inspection.
    }
  }
  return pids[0];
}

function copyExecutable(source, destination) {
  mkdirSync(resolve(destination, '..'), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function configureLaunchEnvironment(scenarioDirectory, runNonce) {
  const configDirectory = join(scenarioDirectory, 'xdg-config');
  const cacheDirectory = join(scenarioDirectory, 'xdg-cache');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  process.env.XDG_CONFIG_HOME = configDirectory;
  process.env.XDG_CACHE_HOME = cacheDirectory;
  process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE_NONCE = runNonce;
  process.env.APPIMAGE_EXTRACT_AND_RUN = '1';
}

function serveDirectory(directoryInput) {
  const directory = resolve(directoryInput);
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      const filePath = resolve(directory, relativePath);
      if (!relativePath || (filePath !== directory && !filePath.startsWith(`${directory}${sep}`))) {
        response.writeHead(404).end();
        return;
      }
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Length', stat.size);
      response.setHeader(
        'Content-Type',
        filePath.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
      );
      response.writeHead(200);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('loopback acceptance server did not expose a TCP port'));
        return;
      }
      const url = assertLoopbackFeedUrl(`http://127.0.0.1:${address.port}/`);
      resolvePromise({
        close: () =>
          new Promise((done, closeReject) =>
            server.close((error) => (error ? closeReject(error) : done())),
          ),
        url,
      });
    });
  });
}

function createAppAdapter({ version, scenarioDirectory }) {
  const userDataPath = join(scenarioDirectory, 'user-data');
  const baseCachePath = join(scenarioDirectory, 'cache');
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(baseCachePath, { recursive: true });
  return {
    version,
    name: 'platform-desktop-linux-update-acceptance',
    isPackaged: true,
    appUpdateConfigPath: join(scenarioDirectory, 'unused-app-update.yml'),
    userDataPath,
    baseCachePath,
    whenReady: async () => undefined,
    quit: () => undefined,
    relaunch: () => undefined,
    onQuit: () => undefined,
  };
}

function createUpdater({ currentAppImage, currentVersion, feedUrl, scenarioDirectory, userId }) {
  process.env.APPIMAGE = currentAppImage;
  const appAdapter = createAppAdapter({ version: currentVersion, scenarioDirectory });
  if (userId) {
    writeFileSync(join(appAdapter.userDataPath, '.updaterId'), userId, { mode: 0o600 });
  }
  const updater = new AppImageUpdater(null, appAdapter);
  updater.httpExecutor = new NodeHttpExecutor();
  updater.setFeedURL({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false });
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.on('error', () => undefined);
  return updater;
}

async function runStagedRollout({
  baselinePath,
  baselineVersion,
  candidatePath,
  candidateVersion,
  root,
}) {
  const snapshotRoot = join(root, 'rollout-snapshots');
  const metadataPaths = writeStagedRolloutSnapshots({
    artifactPath: candidatePath,
    outputDirectory: snapshotRoot,
    version: candidateVersion,
  });
  verifyStagedRolloutSnapshots({
    artifactPath: candidatePath,
    expectedVersion: candidateVersion,
    metadataPaths,
  });

  const actual = [];
  for (const [index, percentage] of [5, 25, 100].entries()) {
    const feedDirectory = join(root, `stage-${percentage}`, 'feed');
    mkdirSync(feedDirectory, { recursive: true });
    copyExecutable(candidatePath, join(feedDirectory, basename(candidatePath)));
    copyFileSync(metadataPaths[index], join(feedDirectory, 'latest-linux.yml'));
    const server = await serveDirectory(feedDirectory);
    try {
      const boundaryCohorts = COHORTS_BY_PERCENTAGE.get(percentage);
      for (const [cohort, userId] of Object.entries(boundaryCohorts)) {
        const scenarioDirectory = join(root, `stage-${percentage}`, cohort);
        const updater = createUpdater({
          currentAppImage: baselinePath,
          currentVersion: baselineVersion,
          feedUrl: server.url,
          scenarioDirectory,
          userId,
        });
        const result = await updater.checkForUpdates();
        const expected = isRolloutEligible(userId, percentage);
        if (result?.isUpdateAvailable !== expected) {
          throw new Error(
            `electron-updater cohort decision disagreed at ${percentage}% for ${cohort}`,
          );
        }
        actual.push({ cohort, eligible: expected, percentage });
      }
    } finally {
      await server.close();
    }
  }

  const universalDirectory = join(root, 'stage-universal');
  const universalFeed = join(universalDirectory, 'feed');
  mkdirSync(universalFeed, { recursive: true });
  const universalCandidate = join(universalFeed, basename(candidatePath));
  copyExecutable(candidatePath, universalCandidate);
  writeLinuxUpdateMetadata({
    artifactPath: universalCandidate,
    outputPath: join(universalFeed, 'latest-linux.yml'),
    version: candidateVersion,
  });
  const universalServer = await serveDirectory(universalFeed);
  try {
    const universalScenarioDirectory = join(universalDirectory, 'maximum-cohort');
    const updater = createUpdater({
      currentAppImage: baselinePath,
      currentVersion: baselineVersion,
      feedUrl: universalServer.url,
      scenarioDirectory: universalScenarioDirectory,
      userId: COHORTS.hundredOut,
    });
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      throw new Error('metadata without stagingPercentage did not include the maximum UUID cohort');
    }
    actual.push({ cohort: 'maximum', eligible: true, percentage: 'field-omitted' });
  } finally {
    await universalServer.close();
  }
  return actual;
}

async function runDisabledMarkerNegative({ candidatePath, root }) {
  const scenarioDirectory = join(root, 'smoke-gate-disabled');
  const markerPath = join(scenarioDirectory, 'must-not-exist.json');
  const installedCandidate = join(scenarioDirectory, basename(candidatePath));
  const runNonce = randomBytes(16).toString('hex');
  copyExecutable(candidatePath, installedCandidate);
  configureLaunchEnvironment(scenarioDirectory, runNonce);
  delete process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE;
  process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE_EVIDENCE = markerPath;
  process.env.APPIMAGE = installedCandidate;

  const child = spawn(installedCandidate, [], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  try {
    await waitFor(() => {
      const pids = scanProcessesByAppImage(installedCandidate);
      return pids.length > 0 ? pids : null;
    }, 'candidate process with release smoke gate disabled');
    await sleep(3_000);
    if (existsSync(markerPath)) {
      throw new Error(
        'release smoke evidence was written while the explicit smoke gate was disabled',
      );
    }
    return { markerAbsent: true, runNonceWasUnique: true };
  } finally {
    killProcessGroup(child.pid);
  }
}

async function runUpgrade({
  baselinePath,
  baselineVersion,
  candidatePath,
  candidateVersion,
  root,
}) {
  const scenarioDirectory = join(root, 'upgrade');
  const feedDirectory = join(scenarioDirectory, 'feed');
  const installDirectory = join(scenarioDirectory, 'install');
  mkdirSync(feedDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  const installedBaseline = join(installDirectory, basename(baselinePath));
  const feedCandidate = join(feedDirectory, basename(candidatePath));
  copyExecutable(baselinePath, installedBaseline);
  copyExecutable(candidatePath, feedCandidate);
  writeLinuxUpdateMetadata({
    artifactPath: feedCandidate,
    outputPath: join(feedDirectory, 'latest-linux.yml'),
    version: candidateVersion,
  });
  const markerPath = join(scenarioDirectory, 'restart-evidence.json');
  const runNonce = randomBytes(16).toString('hex');
  const server = await serveDirectory(feedDirectory);
  let launchedPid;
  try {
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE = '1';
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE_EVIDENCE = markerPath;
    configureLaunchEnvironment(scenarioDirectory, runNonce);
    const updater = createUpdater({
      currentAppImage: installedBaseline,
      currentVersion: baselineVersion,
      feedUrl: server.url,
      scenarioDirectory,
      userId: COHORTS.fiveIn,
    });
    updater.autoDownload = true;
    let destination;
    updater.on('appimage-filename-updated', (value) => {
      destination = value;
    });
    const beforeDigest = digestFile(installedBaseline, 'sha256', 'hex');
    const update = await updater.checkForUpdates();
    if (!update?.isUpdateAvailable || !update.downloadPromise) {
      throw new Error('upgrade check did not expose a downloadable update');
    }
    await update.downloadPromise;
    if (digestFile(installedBaseline, 'sha256', 'hex') !== beforeDigest) {
      throw new Error('the installed baseline changed before the install step');
    }
    if (!updater.install(false, true)) {
      throw new Error('AppImageUpdater refused the downloaded upgrade install');
    }
    const marker = await waitFor(() => {
      if (!existsSync(markerPath)) return null;
      return JSON.parse(readFileSync(markerPath, 'utf8'));
    }, 'upgraded application restart marker');
    launchedPid = marker.pid;
    if (
      marker.schemaVersion !== 1 ||
      marker.runNonce !== runNonce ||
      Number.isNaN(Date.parse(marker.observedAt)) ||
      marker.version !== candidateVersion ||
      marker.pid === process.pid ||
      !processExists(marker.pid)
    ) {
      throw new Error('the upgraded process marker does not prove a running candidate version');
    }
    const installedCandidate = destination ?? join(installDirectory, basename(candidatePath));
    if (!existsSync(installedCandidate) || existsSync(installedBaseline)) {
      throw new Error('upgrade did not replace the old versioned AppImage');
    }
    if (
      digestFile(installedCandidate, 'sha256', 'hex') !== digestFile(candidatePath, 'sha256', 'hex')
    ) {
      throw new Error('installed upgrade bytes do not match the candidate AppImage');
    }
    await sleep(2_000);
    if (!processExists(marker.pid)) {
      throw new Error('the upgraded process exited during the restart stability window');
    }
    return {
      check: true,
      download: true,
      install: true,
      restart: { observed: true, pidRecorded: true, version: marker.version },
    };
  } finally {
    if (launchedPid) killProcessGroup(launchedPid);
    await server.close();
  }
}

async function runChecksumFailure({
  baselinePath,
  baselineVersion,
  candidatePath,
  candidateVersion,
  root,
}) {
  const scenarioDirectory = join(root, 'checksum-failure');
  const feedDirectory = join(scenarioDirectory, 'feed');
  const installDirectory = join(scenarioDirectory, 'install');
  mkdirSync(feedDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  const installedBaseline = join(installDirectory, basename(baselinePath));
  const corruptName = `tampered-${basename(candidatePath)}`;
  const corruptCandidate = join(feedDirectory, corruptName);
  copyExecutable(baselinePath, installedBaseline);
  copyExecutable(candidatePath, corruptCandidate);
  appendFileSync(corruptCandidate, 'intentional-checksum-corruption');
  writeLinuxUpdateMetadata({
    artifactPath: candidatePath,
    artifactUrl: corruptName,
    outputPath: join(feedDirectory, 'latest-linux.yml'),
    version: candidateVersion,
  });
  const baselineDigest = digestFile(installedBaseline, 'sha256', 'hex');
  const markerPath = join(scenarioDirectory, 'must-not-exist.json');
  const server = await serveDirectory(feedDirectory);
  try {
    const runNonce = randomBytes(16).toString('hex');
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE = '1';
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE_EVIDENCE = markerPath;
    configureLaunchEnvironment(scenarioDirectory, runNonce);
    const updater = createUpdater({
      currentAppImage: installedBaseline,
      currentVersion: baselineVersion,
      feedUrl: server.url,
      scenarioDirectory,
      userId: COHORTS.fiveIn,
    });
    const update = await updater.checkForUpdates();
    if (!update?.isUpdateAvailable) {
      throw new Error('tampered-payload scenario did not reach the download gate');
    }
    let rejected = false;
    try {
      await updater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejected = /sha512|checksum/i.test(message);
    }
    if (!rejected) {
      throw new Error('tampered AppImage was not rejected by the updater SHA-512 gate');
    }
    if (
      !existsSync(installedBaseline) ||
      digestFile(installedBaseline, 'sha256', 'hex') !== baselineDigest ||
      existsSync(markerPath)
    ) {
      throw new Error('checksum failure modified or relaunched the installed baseline');
    }
    return { downloadRejected: true, installAttempted: false, oldVersionPreserved: true };
  } finally {
    await server.close();
  }
}

function readPackagedMetadata(appImagePath) {
  const extractDirectory = mkdtempSync(join(tmpdir(), 'linux-update-appimage-'));
  try {
    const extraction = spawnSync(appImagePath, ['--appimage-extract'], {
      cwd: extractDirectory,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 120_000,
    });
    if (extraction.error || extraction.status !== 0) {
      throw new Error('installed rollback AppImage could not be extracted');
    }
    const appAsar = join(extractDirectory, 'squashfs-root', 'resources', 'app.asar');
    const packageJson = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'));
    const updaterPackage = JSON.parse(
      extractFile(appAsar, 'node_modules/electron-updater/package.json').toString('utf8'),
    );
    return {
      version: assertCanonicalVersion(packageJson.version),
      electronUpdaterVersion: assertCanonicalVersion(updaterPackage.version),
    };
  } finally {
    rmSync(extractDirectory, { force: true, recursive: true });
  }
}

async function runRollback({
  baselinePath,
  baselineVersion,
  candidatePath,
  candidateVersion,
  root,
}) {
  const scenarioDirectory = join(root, 'rollback');
  const feedDirectory = join(scenarioDirectory, 'feed');
  const installDirectory = join(scenarioDirectory, 'install');
  mkdirSync(feedDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  const installedCandidate = join(installDirectory, basename(candidatePath));
  const feedBaseline = join(feedDirectory, basename(baselinePath));
  copyExecutable(candidatePath, installedCandidate);
  copyExecutable(baselinePath, feedBaseline);
  writeLinuxUpdateMetadata({
    artifactPath: feedBaseline,
    outputPath: join(feedDirectory, 'latest-linux.yml'),
    version: baselineVersion,
  });
  const server = await serveDirectory(feedDirectory);
  let launchedRootPid;
  try {
    const runNonce = randomBytes(16).toString('hex');
    const legacyMarkerPath = join(scenarioDirectory, 'legacy-structured-marker-not-expected.json');
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE = '1';
    process.env.MEETING_INTELLIGENCE_RELEASE_SMOKE_EVIDENCE = legacyMarkerPath;
    configureLaunchEnvironment(scenarioDirectory, runNonce);
    const updater = createUpdater({
      currentAppImage: installedCandidate,
      currentVersion: candidateVersion,
      feedUrl: server.url,
      scenarioDirectory,
      userId: COHORTS.fiveIn,
    });
    updater.allowDowngrade = true;
    updater.autoDownload = true;
    let destination;
    updater.on('appimage-filename-updated', (value) => {
      destination = value;
    });
    const update = await updater.checkForUpdates();
    if (!update?.isUpdateAvailable || !update.downloadPromise) {
      throw new Error('rollback check did not expose the pinned older AppImage');
    }
    await update.downloadPromise;
    if (!updater.install(false, true)) {
      throw new Error('AppImageUpdater refused the downloaded rollback install');
    }
    const installedBaseline = destination ?? join(installDirectory, basename(baselinePath));
    if (!existsSync(installedBaseline) || existsSync(installedCandidate)) {
      throw new Error('rollback did not replace the candidate with the pinned baseline');
    }
    if (
      digestFile(installedBaseline, 'sha256', 'hex') !== digestFile(baselinePath, 'sha256', 'hex')
    ) {
      throw new Error('installed rollback bytes do not match the immutable baseline');
    }
    const pids = await waitFor(() => {
      const matches = scanProcessesByAppImage(installedBaseline);
      return matches.length > 0 ? matches : null;
    }, 'rolled-back AppImage process');
    launchedRootPid = processGroupRoot(pids);
    await sleep(2_000);
    if (!scanProcessesByAppImage(installedBaseline).some(processExists)) {
      throw new Error('rolled-back process exited during the restart stability window');
    }
    const runningVersion = readRunningPackagedVersion(pids);
    const packagedMetadata = readPackagedMetadata(installedBaseline);
    if (
      runningVersion.version !== baselineVersion ||
      packagedMetadata.version !== baselineVersion ||
      existsSync(legacyMarkerPath)
    ) {
      throw new Error('rolled-back AppImage package version does not match the baseline');
    }
    return {
      downgradeCheck: true,
      download: true,
      install: true,
      restart: {
        observedViaProcessEnvironment: true,
        runningAppDirectoryVersion: runningVersion.version,
        packagedVersion: packagedMetadata.version,
      },
    };
  } finally {
    if (launchedRootPid) killProcessGroup(launchedRootPid);
    await server.close();
  }
}

async function main(argv) {
  assertLinux();
  const args = parseArguments(argv);
  const baselinePath = resolve(requireValue(args.get('baseline'), 'baseline'));
  const candidatePath = resolve(requireValue(args.get('candidate'), 'candidate'));
  const baselineVersion = assertCanonicalVersion(args.get('baseline-version'));
  const candidateVersion = assertCanonicalVersion(args.get('candidate-version'));
  const root = resolve(requireValue(args.get('workspace'), 'workspace'));
  const evidencePath = resolve(requireValue(args.get('evidence'), 'evidence'));
  if (baselineVersion === candidateVersion) {
    throw new Error('baseline and candidate versions must differ');
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(evidencePath, '..'), { recursive: true });

  // A loopback acceptance must never inherit a corporate proxy route.
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) {
    delete process.env[name];
  }

  const baselinePackage = readPackagedMetadata(baselinePath);
  const candidatePackage = readPackagedMetadata(candidatePath);
  if (
    baselinePackage.version !== baselineVersion ||
    candidatePackage.version !== candidateVersion ||
    baselinePackage.electronUpdaterVersion !== electronUpdaterVersion ||
    candidatePackage.electronUpdaterVersion !== electronUpdaterVersion
  ) {
    throw new Error('packaged versions do not match the pinned acceptance engine inputs');
  }

  const stagedRollout = await runStagedRollout({
    baselinePath,
    baselineVersion,
    candidatePath,
    candidateVersion,
    root,
  });
  const smokeGateNegative = await runDisabledMarkerNegative({ candidatePath, root });
  const upgrade = await runUpgrade({
    baselinePath,
    baselineVersion,
    candidatePath,
    candidateVersion,
    root,
  });
  const checksumFailure = await runChecksumFailure({
    baselinePath,
    baselineVersion,
    candidatePath,
    candidateVersion,
    root,
  });
  const rollback = await runRollback({
    baselinePath,
    baselineVersion,
    candidatePath,
    candidateVersion,
    root,
  });

  const evidence = {
    schemaVersion: 1,
    gates: {
      gateA: {
        status: 'exercised-by-this-workflow',
        scope: 'electron-updater AppImageUpdater engine with ephemeral loopback GenericProvider',
      },
      gateB: {
        status: 'tracked-pending',
        scope: 'shipped initAutoUpdate wiring and real end-user authenticated update provider',
      },
    },
    runner: {
      imageOS: process.env.ImageOS ?? 'unknown',
      imageVersion: process.env.ImageVersion ?? 'unknown',
      kernel: osRelease(),
      architecture: osArchitecture(),
      electronVersion,
      electronUpdaterVersion,
      appImageLaunchStrategy: 'APPIMAGE_EXTRACT_AND_RUN=1',
    },
    baseline: {
      version: baselineVersion,
      sha256: digestFile(baselinePath, 'sha256', 'hex'),
      packagedElectronUpdaterVersion: baselinePackage.electronUpdaterVersion,
    },
    candidate: {
      version: candidateVersion,
      sha256: digestFile(candidatePath, 'sha256', 'hex'),
      packagedElectronUpdaterVersion: candidatePackage.electronUpdaterVersion,
    },
    smokeGateNegative,
    upgrade,
    checksumFailure,
    stagedRollout,
    rollback,
    boundaries: [
      'GitHubProvider authentication and redirect delivery are not exercised by this loopback GenericProvider acceptance.',
      'Sigstore verification is enforced separately by the workflow release-intake preflight.',
      'The immutable 0.1.3 rollback target predates structured restart markers; its running version is bound by APPIMAGE process environment plus extracted package.json.',
      'The harness invokes the updater engine install API; it does not prove the shipped autoInstallOnAppQuit policy or v0.1.3 initAutoUpdate wiring.',
      'Full-download mode is covered; differential AppImage update is disabled and not covered.',
      'APPIMAGE_EXTRACT_AND_RUN avoids FUSE and therefore does not prove distro-specific FUSE behavior.',
      'Wayland, arm64, other Linux distributions, external TLS, and certificate pinning are not covered.',
    ],
  };
  const temporaryEvidencePath = `${evidencePath}.tmp`;
  writeFileSync(temporaryEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryEvidencePath, evidencePath);
  console.log(
    'Linux AppImageUpdater upgrade, fail-closed download, rollout, and rollback rehearsal passed',
  );
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Linux updater runtime acceptance failed',
    );
    process.exitCode = 1;
  });
}
