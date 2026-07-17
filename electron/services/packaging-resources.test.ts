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

function readLinuxPackageWorkflow(): string {
  return readFileSync(
    new URL('../../.github/workflows/package-linux.yml', import.meta.url),
    'utf8',
  );
}

function readElectronMain(): string {
  return readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
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

  it('gates Linux releases on package installation and application startup', () => {
    const workflow = readLinuxPackageWorkflow();
    const electronMain = readElectronMain();

    expect(workflow).toContain('group: linux-package-${{ github.ref }}');
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('sudo apt-get install --no-install-recommends --yes rpm cpio');
    expect(workflow).toContain('sigstore/cosign-installer@d7543c93');
    expect(workflow).toContain('cosign sign-blob');
    expect(workflow).toContain('cosign verify-blob');
    expect(workflow).toContain('--certificate-github-workflow-sha "$GITHUB_SHA"');
    expect(workflow).toContain('smoke-linux-x64:');
    expect(workflow).toContain('desktop-file-utils xvfb rpm cpio "./${packages[0]}"');
    expect(workflow).not.toContain('desktop-file-utils xvfb rpm cpio "${packages[0]}"');
    expect(workflow).toContain('MEETING_INTELLIGENCE_RELEASE_SMOKE_READY');
    expect(electronMain).toContain('MEETING_INTELLIGENCE_RELEASE_SMOKE_READY');
    expect(electronMain).toContain("webContents.once('did-finish-load'");
    expect(electronMain).toContain("document.getElementById('root')?.childElementCount > 0");
    expect(workflow).not.toContain('meeting-intelligence --no-sandbox');
    expect(workflow).toContain('assert_renderer_ready deb');
    expect(workflow).toContain('assert_renderer_ready appimage');
    expect(workflow).toContain('assert_renderer_ready rpm');
    expect(workflow).toContain('application exited during renderer stability check');
    expect(workflow).not.toContain('immutable-releases');
    expect(workflow).toContain('-F draft=true');
    expect(workflow).toContain('draft_release_name');
    expect(workflow).toContain('trap on_exit EXIT');
    expect(workflow).toContain('for attempt in 1 2 3 4 5');
    expect(workflow).toContain('was not confirmed deleted with HTTP 404');
    expect(workflow).toContain(
      'draft_release_name="$release_name [run $GITHUB_RUN_ID.$GITHUB_RUN_ATTEMPT]"',
    );
    expect(workflow.indexOf('trap on_exit EXIT')).toBeLessThan(
      workflow.indexOf('"repos/$GITHUB_REPOSITORY/releases"'),
    );
    expect(workflow).toContain('mapfile -t candidate_release_ids < "$candidate_response"');
    expect(workflow).not.toContain('mapfile -t candidate_release_ids < <(');
    expect(workflow).toContain('last_lookup_confirmed_zero=false');
    expect(workflow).toContain('last_lookup_confirmed_zero=true');
    expect(workflow).toContain('if test "$last_lookup_confirmed_zero" != true; then');
    expect(workflow).toContain('Unable to inspect releases while cleaning draft marker');
    expect(workflow).toContain('if test "$exit_code" -eq 0; then');
    expect(workflow).toContain('sleep 2');
    expect(workflow.indexOf('sleep 2')).toBeLessThan(
      workflow.indexOf('application exited during renderer stability check'),
    );
    expect(workflow).toContain(
      '.id == $id and .tag_name == $tag and (.name == $draft_name or .name == $release_name)',
    );
    expect(workflow).toContain('if test "$(jq -r \'.immutable\' "$release_state")" = true');
    expect(workflow).toContain('created_upload_url');
    expect(workflow).toContain('created_release_id');
    expect(workflow).toContain('releases/$created_release_id/assets?per_page=100');
    expect(workflow).toContain('releases/assets/$asset_id');
    expect(workflow).toContain('repos/$GITHUB_REPOSITORY/releases/$created_release_id');
    expect(workflow).toContain('-F draft=false');
    expect(workflow).not.toContain('gh release upload');
    expect(workflow).not.toContain('gh release download');
    expect(workflow).not.toContain('gh release edit');
    expect(workflow).toContain('cmp -- "$asset"');
    expect(workflow).toContain('immutable_state');
    expect(workflow).toContain('exit 1');
    expect(workflow).toContain('- smoke-linux-x64');

    const candidateMatchStart = workflow.indexOf(
      'if test "${#candidate_release_ids[@]}" -eq 1; then',
    );
    const candidateLoopEnd = workflow.indexOf('              done', candidateMatchStart);
    const zeroMatchBranch = workflow.slice(candidateMatchStart, candidateLoopEnd);
    expect(candidateMatchStart).toBeGreaterThan(-1);
    expect(candidateLoopEnd).toBeGreaterThan(candidateMatchStart);
    expect(zeroMatchBranch).toContain('last_lookup_confirmed_zero=true');
    expect(zeroMatchBranch).toContain('sleep "$attempt"');
    expect(zeroMatchBranch).not.toContain('return 0');
  });
});
