import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface ElectronBuilderResource {
  from?: string;
  to?: string;
  filter?: string[];
}

interface PlatformDesktopPackage {
  author?: {
    email?: string;
  };
  desktopName?: string;
  homepage?: string;
  scripts?: Record<string, string>;
  build?: {
    extraResources?: ElectronBuilderResource[];
    linux?: {
      artifactName?: string;
      desktop?: {
        entry?: Record<string, string>;
      };
      maintainer?: string;
      syncDesktopName?: boolean;
      target?: string[];
    };
    mac?: {
      extendInfo?: Record<string, string>;
    };
  };
}

function readPackageJson(): PlatformDesktopPackage {
  return JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as PlatformDesktopPackage;
}

describe('packaged runtime resources', () => {
  it('ships tray icons where TrayManager expects them in packaged builds', () => {
    const packageJson = readPackageJson();

    expect(packageJson.build?.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'public/icons',
          to: 'icons',
          filter: expect.arrayContaining(['*.png']),
        }),
      ]),
    );
  });

  it('declares macOS privacy usage strings for audio and system-audio capture', () => {
    const extendInfo = readPackageJson().build?.mac?.extendInfo;

    expect(extendInfo?.NSMicrophoneUsageDescription).toContain('microphone');
    expect(extendInfo?.NSScreenCaptureUsageDescription).toContain('system audio');
  });

  it('keeps Linux package metadata complete for AppImage, deb and rpm output', () => {
    const packageJson = readPackageJson();

    expect(packageJson.author?.email).toBe('ai@acik.com');
    expect(packageJson.homepage).toBe('https://github.com/Halildeu/platform-desktop');
    expect(packageJson.desktopName).toBe('meeting-intelligence.desktop');
    expect(packageJson.scripts?.['package:linux:x64']).toContain('--publish never');
    expect(packageJson.scripts?.['package:linux:arm64']).toContain('--publish never');
    expect(packageJson.build?.linux).toMatchObject({
      artifactName: 'Meeting-Intelligence-${version}-${arch}.${ext}',
      desktop: {
        entry: {
          MimeType: 'x-scheme-handler/meeting-intelligence;',
        },
      },
      maintainer: 'Acik Platform Team <ai@acik.com>',
      syncDesktopName: true,
      target: ['AppImage', 'deb', 'rpm'],
    });
  });
});
