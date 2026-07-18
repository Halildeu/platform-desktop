import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultPublicRuntimeConfigPaths,
  hydratePublicRuntimeEnvironment,
  PublicRuntimeConfigError,
  resolvePublicRuntimeEnvironment,
  type PublicRuntimeConfigPaths,
} from './public-runtime-config';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'platform-desktop-public-config-'));
  tempRoots.push(root);
  return root;
}

function fullDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    environment: 'test',
    keycloak: {
      baseUrl: 'https://packaged.example.com/',
      realm: 'packaged-realm',
      clientId: 'packaged-client',
      redirectPort: 8123,
      scope: 'openid profile email',
    },
    services: {
      gatewayBaseUrl: 'https://packaged-gateway.example.com/',
      meetingBaseUrl: 'https://packaged-meeting.example.com/',
      gatewayLiveStreamEnabled: false,
      liveSttStreamUrl: null,
    },
    recorder: {
      deviceId: 'packaged-device',
    },
  };
}

function writeDocument(filePath: string, document: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function writeRaw(filePath: string, raw: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, raw, 'utf8');
}

function configPaths(root: string): PublicRuntimeConfigPaths {
  return {
    packaged: path.join(root, 'packaged.json'),
    system: path.join(root, 'system.json'),
    user: path.join(root, 'user.json'),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('public-runtime-config', () => {
  it('loads the committed non-secret packaged test endpoints without an env wrapper', () => {
    const resolved = resolvePublicRuntimeEnvironment(
      {},
      {
        paths: { system: null, user: null },
      },
    );

    expect(resolved.env).toMatchObject({
      KEYCLOAK_BASE_URL: 'https://testai.acik.com',
      KEYCLOAK_REALM: 'platform-test',
      KEYCLOAK_CLIENT_ID: 'platform-desktop',
      KEYCLOAK_REDIRECT_PORT: '8123',
      KEYCLOAK_SCOPE: 'openid profile email',
      GATEWAY_BASE_URL: 'https://testai.acik.com',
      MEETING_BASE_URL: 'https://testai.acik.com',
      GATEWAY_LIVE_STREAM_ENABLED: 'true',
      RECORDER_DEVICE_ID: 'desktop-1',
    });
    expect(resolved.env.LIVE_STT_STREAM_URL).toBeUndefined();
    expect(resolved.sources.gatewayLiveStreamEnabled).toBe('packaged');
    expect(new Set(Object.values(resolved.sources))).toEqual(new Set(['packaged']));

    const raw = readFileSync(resolved.paths.packaged as string, 'utf8');
    expect(raw).not.toMatch(/secret|password|token|credential|private.?key|api.?key/i);
    expect(raw).not.toContain('RECORDER_MEETING_ID');
  });

  it('applies env > user > system > packaged precedence to the gateway stream gate', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.system as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { gatewayLiveStreamEnabled: true },
    });
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { gatewayLiveStreamEnabled: false },
    });

    const packaged = resolvePublicRuntimeEnvironment(
      {},
      { paths: { ...paths, system: null, user: null } },
    );
    expect(packaged.env.GATEWAY_LIVE_STREAM_ENABLED).toBe('false');
    expect(packaged.sources.gatewayLiveStreamEnabled).toBe('packaged');

    const system = resolvePublicRuntimeEnvironment({}, { paths: { ...paths, user: null } });
    expect(system.env.GATEWAY_LIVE_STREAM_ENABLED).toBe('true');
    expect(system.sources.gatewayLiveStreamEnabled).toBe('system');

    const managed = resolvePublicRuntimeEnvironment({}, { paths });
    expect(managed.env.GATEWAY_LIVE_STREAM_ENABLED).toBe('false');
    expect(managed.sources.gatewayLiveStreamEnabled).toBe('user');

    const environment = resolvePublicRuntimeEnvironment(
      { GATEWAY_LIVE_STREAM_ENABLED: 'true' },
      { paths },
    );
    expect(environment.env.GATEWAY_LIVE_STREAM_ENABLED).toBe('true');
    expect(environment.sources.gatewayLiveStreamEnabled).toBe('env');
  });

  it('applies field precedence env > user > system > packaged', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.system as string, {
      schemaVersion: 1,
      environment: 'test',
      keycloak: { realm: 'system-realm' },
      services: {
        gatewayBaseUrl: 'https://system-gateway.example.com',
        meetingBaseUrl: 'https://system-meeting.example.com',
      },
    });
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      keycloak: {
        baseUrl: 'https://user-auth.example.com/',
        realm: 'user-realm',
      },
      services: { gatewayBaseUrl: 'https://user-gateway.example.com' },
    });

    const resolved = resolvePublicRuntimeEnvironment(
      { GATEWAY_BASE_URL: 'https://env-gateway.example.com/' },
      { paths },
    );

    expect(resolved.env).toMatchObject({
      KEYCLOAK_BASE_URL: 'https://user-auth.example.com',
      KEYCLOAK_REALM: 'user-realm',
      KEYCLOAK_CLIENT_ID: 'packaged-client',
      KEYCLOAK_SCOPE: 'openid profile email',
      GATEWAY_BASE_URL: 'https://env-gateway.example.com/',
      MEETING_BASE_URL: 'https://system-meeting.example.com',
      RECORDER_DEVICE_ID: 'packaged-device',
    });
    expect(resolved.sources).toMatchObject({
      keycloakBaseUrl: 'user',
      keycloakRealm: 'user',
      keycloakClientId: 'packaged',
      gatewayBaseUrl: 'env',
      meetingBaseUrl: 'system',
      recorderDeviceId: 'packaged',
    });
  });

  it('accepts a public WSS managed endpoint and keeps it out of lower layers', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { liveSttStreamUrl: 'wss://stream.example.com/ws/stream' },
    });

    const resolved = resolvePublicRuntimeEnvironment({}, { paths });

    expect(resolved.env.LIVE_STT_STREAM_URL).toBe('wss://stream.example.com/ws/stream');
    expect(resolved.sources.liveSttStreamUrl).toBe('user');
  });

  it('hydrates only missing process env fields so gateway env consumers keep working', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    const env: NodeJS.ProcessEnv = {
      KEYCLOAK_BASE_URL: 'https://env-auth.example.com',
      GATEWAY_BASE_URL: '',
    };

    hydratePublicRuntimeEnvironment(env, { paths });
    hydratePublicRuntimeEnvironment(env, { paths });

    expect(env.KEYCLOAK_BASE_URL).toBe('https://env-auth.example.com');
    expect(env.GATEWAY_BASE_URL).toBe('');
    expect(env.MEETING_BASE_URL).toBe('https://packaged-meeting.example.com');
    expect(env.GATEWAY_LIVE_STREAM_ENABLED).toBe('false');
    expect(env.RECORDER_DEVICE_ID).toBe('packaged-device');
  });

  it('fails closed on secret-shaped or unknown fields without echoing values', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      keycloak: {
        clientSecret: 'must-never-appear-in-diagnostics',
      },
    });

    let thrown: unknown;
    try {
      resolvePublicRuntimeEnvironment({}, { paths });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PublicRuntimeConfigError);
    expect((thrown as PublicRuntimeConfigError).code).toBe('INVALID_SCHEMA');
    expect((thrown as Error).message).toContain('secret field is forbidden');
    expect((thrown as Error).message).not.toContain('must-never-appear-in-diagnostics');

    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { unsupportedEndpoint: 'https://unknown.example.com' },
    });
    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrow(
      'services has unknown field: unsupportedEndpoint',
    );
  });

  it('requires HTTPS and WSS in packaged and managed documents', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.system as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { meetingBaseUrl: 'http://meeting.example.com' },
    });
    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrow(
      'services.meetingBaseUrl must use HTTPS',
    );

    rmSync(paths.system as string);
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { liveSttStreamUrl: 'ws://stt.example.com/ws/stream' },
    });
    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrow(
      'services.liveSttStreamUrl must use WSS',
    );
  });

  it.each([
    ['schema version', { schemaVersion: 2, environment: 'test' }, 'schemaVersion must equal 1'],
    ['environment', { schemaVersion: 1, environment: 'production' }, 'environment must equal test'],
    [
      'redirect port',
      { schemaVersion: 1, environment: 'test', keycloak: { redirectPort: 0 } },
      'keycloak.redirectPort must be an integer from 1 to 65535',
    ],
    [
      'realm',
      { schemaVersion: 1, environment: 'test', keycloak: { realm: 'bad realm' } },
      'keycloak.realm has an invalid format',
    ],
    [
      'scope',
      { schemaVersion: 1, environment: 'test', keycloak: { scope: 'openid bad/scope' } },
      'keycloak.scope has an invalid format',
    ],
    [
      'device id',
      { schemaVersion: 1, environment: 'test', recorder: { deviceId: 'bad device' } },
      'recorder.deviceId has an invalid format',
    ],
    [
      'gateway stream flag',
      {
        schemaVersion: 1,
        environment: 'test',
        services: { gatewayLiveStreamEnabled: 'true' },
      },
      'services.gatewayLiveStreamEnabled must be a boolean',
    ],
    [
      'URL credentials',
      {
        schemaVersion: 1,
        environment: 'test',
        services: { gatewayBaseUrl: 'https://user:pass@gateway.example.com' },
      },
      'services.gatewayBaseUrl must not contain credentials, query, or fragment',
    ],
    [
      'URL query',
      {
        schemaVersion: 1,
        environment: 'test',
        services: { meetingBaseUrl: 'https://meeting.example.com?tenant=1' },
      },
      'services.meetingBaseUrl must not contain credentials, query, or fragment',
    ],
  ])('rejects invalid strict-schema %s values', (_label, userDocument, message) => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeDocument(paths.user as string, userDocument);

    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrow(message);
  });

  it('reports invalid JSON and oversized documents with stable fail-closed codes', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    writeDocument(paths.packaged as string, fullDocument());
    writeRaw(paths.user as string, '{not-json');

    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON', source: 'user' }),
    );

    writeRaw(paths.user as string, ' '.repeat(64 * 1024 + 1));
    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_TOO_LARGE', source: 'user' }),
    );
  });

  it('allows a managed null to disable a lower-layer optional WSS endpoint', () => {
    const root = tempRoot();
    const paths = configPaths(root);
    const packaged = fullDocument();
    (packaged.services as Record<string, unknown>).liveSttStreamUrl =
      'wss://packaged-stream.example.com/ws/stream';
    writeDocument(paths.packaged as string, packaged);
    writeDocument(paths.user as string, {
      schemaVersion: 1,
      environment: 'test',
      services: { liveSttStreamUrl: null },
    });

    const resolved = resolvePublicRuntimeEnvironment({}, { paths });
    expect(resolved.env.LIVE_STT_STREAM_URL).toBeUndefined();
    expect(resolved.sources.liveSttStreamUrl).toBe('user');
  });

  it('fails with a stable diagnostic when the required packaged config is absent', () => {
    const root = tempRoot();
    const paths = configPaths(root);

    expect(() => resolvePublicRuntimeEnvironment({}, { paths })).toThrowError(
      expect.objectContaining({
        code: 'MISSING_PACKAGED_CONFIG',
        source: 'packaged',
        configPath: paths.packaged,
      }),
    );
  });

  it('resolves packaged and managed paths for normal macOS launches', () => {
    expect(
      defaultPublicRuntimeConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/tester',
        cwd: '/repo',
        resourcesPath: '/Applications/Meeting Intelligence.app/Contents/Resources',
        packaged: true,
      }),
    ).toEqual({
      packaged:
        '/Applications/Meeting Intelligence.app/Contents/Resources/config/public-runtime-config.json',
      system: '/Library/Application Support/Meeting Intelligence/config/public-runtime-config.json',
      user: '/Users/tester/Library/Application Support/Meeting Intelligence/config/public-runtime-config.json',
    });
  });
});
