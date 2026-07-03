import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface ElectronBuilderResource {
  from?: string;
  to?: string;
  filter?: string[];
}

interface PlatformDesktopPackage {
  build?: {
    extraResources?: ElectronBuilderResource[];
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
});
