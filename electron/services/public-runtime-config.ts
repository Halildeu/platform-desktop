import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_FILE_NAME = 'public-runtime-config.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const FORBIDDEN_FIELD_NAME = /(secret|password|token|credential|private.?key|api.?key)/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REALM_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SCOPE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type PublicRuntimeConfigSource = 'packaged' | 'system' | 'user' | 'env';

export interface PublicRuntimeConfigValues {
  keycloakBaseUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  keycloakRedirectPort?: number;
  keycloakScope?: string;
  gatewayBaseUrl?: string;
  meetingBaseUrl?: string;
  gatewayLiveStreamEnabled?: boolean;
  liveSttStreamUrl?: string | null;
  recorderDeviceId?: string;
}

export type PublicRuntimeConfigKey = keyof PublicRuntimeConfigValues;

export interface PublicRuntimeConfigPaths {
  packaged: string | null;
  system: string | null;
  user: string | null;
}

export interface PublicRuntimeConfigLoadOptions {
  paths?: Partial<PublicRuntimeConfigPaths>;
  requirePackaged?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
  resourcesPath?: string;
  packaged?: boolean;
}

export interface ResolvedPublicRuntimeConfig {
  env: NodeJS.ProcessEnv;
  sources: Readonly<Partial<Record<PublicRuntimeConfigKey, PublicRuntimeConfigSource>>>;
  paths: Readonly<PublicRuntimeConfigPaths>;
}

export type PublicRuntimeConfigErrorCode =
  | 'MISSING_PACKAGED_CONFIG'
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA';

export class PublicRuntimeConfigError extends Error {
  readonly code: PublicRuntimeConfigErrorCode;
  readonly source: Exclude<PublicRuntimeConfigSource, 'env'>;
  readonly configPath: string;

  constructor(
    code: PublicRuntimeConfigErrorCode,
    source: Exclude<PublicRuntimeConfigSource, 'env'>,
    configPath: string,
    detail: string,
  ) {
    super(`[PUBLIC_RUNTIME_CONFIG_${code}] ${source} config ${detail}: ${configPath}`);
    this.name = 'PublicRuntimeConfigError';
    this.code = code;
    this.source = source;
    this.configPath = configPath;
  }
}

interface KeycloakDocument {
  baseUrl?: string;
  realm?: string;
  clientId?: string;
  redirectPort?: number;
  scope?: string;
}

interface ServicesDocument {
  gatewayBaseUrl?: string;
  meetingBaseUrl?: string;
  gatewayLiveStreamEnabled?: boolean;
  liveSttStreamUrl?: string | null;
}

interface RecorderDocument {
  deviceId?: string;
}

interface PublicRuntimeConfigDocument {
  schemaVersion: 1;
  environment: 'test';
  keycloak?: KeycloakDocument;
  services?: ServicesDocument;
  recorder?: RecorderDocument;
}

const ENV_BINDINGS: ReadonlyArray<readonly [PublicRuntimeConfigKey, keyof NodeJS.ProcessEnv]> = [
  ['keycloakBaseUrl', 'KEYCLOAK_BASE_URL'],
  ['keycloakRealm', 'KEYCLOAK_REALM'],
  ['keycloakClientId', 'KEYCLOAK_CLIENT_ID'],
  ['keycloakRedirectPort', 'KEYCLOAK_REDIRECT_PORT'],
  ['keycloakScope', 'KEYCLOAK_SCOPE'],
  ['gatewayBaseUrl', 'GATEWAY_BASE_URL'],
  ['meetingBaseUrl', 'MEETING_BASE_URL'],
  ['gatewayLiveStreamEnabled', 'GATEWAY_LIVE_STREAM_ENABLED'],
  ['liveSttStreamUrl', 'LIVE_STT_STREAM_URL'],
  ['recorderDeviceId', 'RECORDER_DEVICE_ID'],
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaError(
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
  detail: string,
): never {
  throw new PublicRuntimeConfigError(
    'INVALID_SCHEMA',
    source,
    configPath,
    `failed schema validation (${detail})`,
  );
}

function assertNoForbiddenFields(
  value: unknown,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoForbiddenFields(entry, source, configPath);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAME.test(key)) {
      schemaError(source, configPath, `secret field is forbidden: ${key}`);
    }
    assertNoForbiddenFields(child, source, configPath);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  location: string,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    schemaError(source, configPath, `${location} has unknown field: ${unknown[0]}`);
  }
}

function requiredSection(
  value: unknown,
  location: string,
  required: boolean,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): Record<string, unknown> | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (!isObject(value)) {
    schemaError(source, configPath, `${location} must be an object`);
  }
  return value;
}

function stringField(
  value: unknown,
  location: string,
  required: boolean,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    schemaError(source, configPath, `${location} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHttpsBaseUrl(
  value: unknown,
  location: string,
  required: boolean,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): string | undefined {
  const raw = stringField(value, location, required, source, configPath);
  if (raw === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    schemaError(source, configPath, `${location} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    schemaError(source, configPath, `${location} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    schemaError(source, configPath, `${location} must not contain credentials, query, or fragment`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function normalizeWssUrl(
  value: unknown,
  location: string,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const raw = stringField(value, location, true, source, configPath) as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    schemaError(source, configPath, `${location} must be an absolute WSS URL`);
  }
  if (parsed.protocol !== 'wss:') {
    schemaError(source, configPath, `${location} must use WSS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    schemaError(source, configPath, `${location} must not contain credentials, query, or fragment`);
  }
  return parsed.toString();
}

function identifierField(
  value: unknown,
  location: string,
  required: boolean,
  pattern: RegExp,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): string | undefined {
  const normalized = stringField(value, location, required, source, configPath);
  if (normalized !== undefined && !pattern.test(normalized)) {
    schemaError(source, configPath, `${location} has an invalid format`);
  }
  return normalized;
}

function redirectPortField(
  value: unknown,
  required: boolean,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): number | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    schemaError(source, configPath, 'keycloak.redirectPort must be an integer from 1 to 65535');
  }
  return value as number;
}

function booleanField(
  value: unknown,
  location: string,
  defaultValue: boolean | undefined,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): boolean | undefined {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    schemaError(source, configPath, `${location} must be a boolean`);
  }
  return value;
}

function scopeField(
  value: unknown,
  required: boolean,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): string | undefined {
  const scope = stringField(value, 'keycloak.scope', required, source, configPath);
  if (scope === undefined) {
    return undefined;
  }
  const tokens = scope.split(/\s+/);
  if (scope.length > 512 || tokens.some((token) => !SCOPE_TOKEN_PATTERN.test(token))) {
    schemaError(source, configPath, 'keycloak.scope has an invalid format');
  }
  return tokens.join(' ');
}

function parseDocument(
  value: unknown,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  configPath: string,
): PublicRuntimeConfigDocument {
  if (!isObject(value)) {
    schemaError(source, configPath, 'root must be an object');
  }
  assertNoForbiddenFields(value, source, configPath);
  assertAllowedKeys(
    value,
    new Set(['schemaVersion', 'environment', 'keycloak', 'services', 'recorder']),
    'root',
    source,
    configPath,
  );
  if (value.schemaVersion !== 1) {
    schemaError(source, configPath, 'schemaVersion must equal 1');
  }
  if (value.environment !== 'test') {
    schemaError(source, configPath, 'environment must equal test');
  }

  const packaged = source === 'packaged';
  const keycloak = requiredSection(value.keycloak, 'keycloak', packaged, source, configPath);
  const services = requiredSection(value.services, 'services', packaged, source, configPath);
  const recorder = requiredSection(value.recorder, 'recorder', packaged, source, configPath);

  let normalizedKeycloak: KeycloakDocument | undefined;
  if (keycloak) {
    assertAllowedKeys(
      keycloak,
      new Set(['baseUrl', 'realm', 'clientId', 'redirectPort', 'scope']),
      'keycloak',
      source,
      configPath,
    );
    normalizedKeycloak = {
      baseUrl: normalizeHttpsBaseUrl(
        keycloak.baseUrl,
        'keycloak.baseUrl',
        packaged,
        source,
        configPath,
      ),
      realm: identifierField(
        keycloak.realm,
        'keycloak.realm',
        packaged,
        REALM_PATTERN,
        source,
        configPath,
      ),
      clientId: identifierField(
        keycloak.clientId,
        'keycloak.clientId',
        packaged,
        IDENTIFIER_PATTERN,
        source,
        configPath,
      ),
      redirectPort: redirectPortField(keycloak.redirectPort, packaged, source, configPath),
      scope: scopeField(keycloak.scope, packaged, source, configPath),
    };
  }

  let normalizedServices: ServicesDocument | undefined;
  if (services) {
    assertAllowedKeys(
      services,
      new Set(['gatewayBaseUrl', 'meetingBaseUrl', 'gatewayLiveStreamEnabled', 'liveSttStreamUrl']),
      'services',
      source,
      configPath,
    );
    normalizedServices = {
      gatewayBaseUrl: normalizeHttpsBaseUrl(
        services.gatewayBaseUrl,
        'services.gatewayBaseUrl',
        packaged,
        source,
        configPath,
      ),
      meetingBaseUrl: normalizeHttpsBaseUrl(
        services.meetingBaseUrl,
        'services.meetingBaseUrl',
        packaged,
        source,
        configPath,
      ),
      gatewayLiveStreamEnabled: booleanField(
        services.gatewayLiveStreamEnabled,
        'services.gatewayLiveStreamEnabled',
        packaged ? false : undefined,
        source,
        configPath,
      ),
      liveSttStreamUrl: normalizeWssUrl(
        services.liveSttStreamUrl,
        'services.liveSttStreamUrl',
        source,
        configPath,
      ),
    };
  }

  let normalizedRecorder: RecorderDocument | undefined;
  if (recorder) {
    assertAllowedKeys(recorder, new Set(['deviceId']), 'recorder', source, configPath);
    normalizedRecorder = {
      deviceId: identifierField(
        recorder.deviceId,
        'recorder.deviceId',
        packaged,
        DEVICE_ID_PATTERN,
        source,
        configPath,
      ),
    };
  }

  return {
    schemaVersion: 1,
    environment: 'test',
    keycloak: normalizedKeycloak,
    services: normalizedServices,
    recorder: normalizedRecorder,
  };
}

function readDocument(
  configPath: string,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
  required: boolean,
): PublicRuntimeConfigDocument | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !required) {
      return null;
    }
    throw new PublicRuntimeConfigError(
      code === 'ENOENT' ? 'MISSING_PACKAGED_CONFIG' : 'CONFIG_READ_FAILED',
      source,
      configPath,
      code === 'ENOENT' ? 'is missing' : `could not be read (${code ?? 'unknown'})`,
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) {
    throw new PublicRuntimeConfigError(
      'CONFIG_TOO_LARGE',
      source,
      configPath,
      `exceeds ${MAX_CONFIG_BYTES} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PublicRuntimeConfigError('INVALID_JSON', source, configPath, 'is not valid JSON');
  }
  return parseDocument(parsed, source, configPath);
}

function valuesFromDocument(document: PublicRuntimeConfigDocument): PublicRuntimeConfigValues {
  return {
    keycloakBaseUrl: document.keycloak?.baseUrl,
    keycloakRealm: document.keycloak?.realm,
    keycloakClientId: document.keycloak?.clientId,
    keycloakRedirectPort: document.keycloak?.redirectPort,
    keycloakScope: document.keycloak?.scope,
    gatewayBaseUrl: document.services?.gatewayBaseUrl,
    meetingBaseUrl: document.services?.meetingBaseUrl,
    gatewayLiveStreamEnabled: document.services?.gatewayLiveStreamEnabled,
    liveSttStreamUrl: document.services?.liveSttStreamUrl,
    recorderDeviceId: document.recorder?.deviceId,
  };
}

function mergeValues(
  target: PublicRuntimeConfigValues,
  sources: Partial<Record<PublicRuntimeConfigKey, PublicRuntimeConfigSource>>,
  next: PublicRuntimeConfigValues,
  source: Exclude<PublicRuntimeConfigSource, 'env'>,
): void {
  for (const key of Object.keys(next) as PublicRuntimeConfigKey[]) {
    const value = next[key];
    if (value !== undefined) {
      (target as Record<PublicRuntimeConfigKey, string | number | boolean | null | undefined>)[
        key
      ] = value;
      sources[key] = source;
    }
  }
}

export function defaultPublicRuntimeConfigPaths(
  options: Omit<PublicRuntimeConfigLoadOptions, 'paths' | 'requirePackaged'> = {},
): PublicRuntimeConfigPaths {
  const runtimeProcess = process;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const resourcesPath = options.resourcesPath ?? runtimeProcess.resourcesPath;
  const packaged =
    options.packaged ??
    Boolean(process.versions.electron && runtimeProcess.defaultApp !== true && resourcesPath);

  let user: string;
  let system: string;
  if (platform === 'darwin') {
    user = path.join(
      home,
      'Library',
      'Application Support',
      'Meeting Intelligence',
      'config',
      CONFIG_FILE_NAME,
    );
    system = path.join(
      '/Library',
      'Application Support',
      'Meeting Intelligence',
      'config',
      CONFIG_FILE_NAME,
    );
  } else if (platform === 'win32') {
    user = path.join(
      process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
      'Meeting Intelligence',
      'config',
      CONFIG_FILE_NAME,
    );
    system = path.join(
      process.env.PROGRAMDATA ?? 'C:\\ProgramData',
      'Meeting Intelligence',
      'config',
      CONFIG_FILE_NAME,
    );
  } else {
    user = path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
      'meeting-intelligence',
      CONFIG_FILE_NAME,
    );
    system = path.join('/etc', 'meeting-intelligence', CONFIG_FILE_NAME);
  }

  return {
    packaged:
      packaged && resourcesPath
        ? path.join(resourcesPath, 'config', CONFIG_FILE_NAME)
        : path.join(cwd, 'build', 'config', CONFIG_FILE_NAME),
    system,
    user,
  };
}

function resolvePaths(options: PublicRuntimeConfigLoadOptions): PublicRuntimeConfigPaths {
  const defaults = defaultPublicRuntimeConfigPaths(options);
  return {
    packaged: options.paths?.packaged === undefined ? defaults.packaged : options.paths.packaged,
    system: options.paths?.system === undefined ? defaults.system : options.paths.system,
    user: options.paths?.user === undefined ? defaults.user : options.paths.user,
  };
}

export function resolvePublicRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: PublicRuntimeConfigLoadOptions = {},
): ResolvedPublicRuntimeConfig {
  const paths = resolvePaths(options);
  const values: PublicRuntimeConfigValues = {};
  const sources: Partial<Record<PublicRuntimeConfigKey, PublicRuntimeConfigSource>> = {};
  const layers: ReadonlyArray<
    readonly [Exclude<PublicRuntimeConfigSource, 'env'>, string | null, boolean]
  > = [
    ['packaged', paths.packaged, options.requirePackaged !== false],
    ['system', paths.system, false],
    ['user', paths.user, false],
  ];

  for (const [source, configPath, required] of layers) {
    if (!configPath) {
      continue;
    }
    const document = readDocument(configPath, source, required);
    if (document) {
      mergeValues(values, sources, valuesFromDocument(document), source);
    }
  }

  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const [key, envName] of ENV_BINDINGS) {
    const envValue = env[envName];
    if (envValue !== undefined) {
      sources[key] = 'env';
      continue;
    }
    const value = values[key];
    if (value !== undefined && value !== null) {
      resolvedEnv[envName] = String(value);
    }
  }

  return {
    env: resolvedEnv,
    sources: Object.freeze({ ...sources }),
    paths: Object.freeze({ ...paths }),
  };
}

/**
 * Electron main process bootstrap'u icin eksik public env alanlarini hydrate eder.
 * Mevcut env degerleri (bos string dahil) daima daha yuksek onceliklidir.
 */
export function hydratePublicRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: PublicRuntimeConfigLoadOptions = {},
): ResolvedPublicRuntimeConfig {
  const resolved = resolvePublicRuntimeEnvironment(env, options);
  for (const [, envName] of ENV_BINDINGS) {
    if (env[envName] === undefined && resolved.env[envName] !== undefined) {
      env[envName] = resolved.env[envName];
    }
  }
  return resolved;
}
