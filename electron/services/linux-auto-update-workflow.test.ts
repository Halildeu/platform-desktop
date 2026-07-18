import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflowPath = new URL(
  '../../.github/workflows/linux-auto-update-acceptance.yml',
  import.meta.url,
);

describe('Linux auto-update acceptance workflow', () => {
  it('is a read-only non-production rehearsal with pinned immutable inputs', () => {
    const workflowText = readFileSync(workflowPath, 'utf8');
    const runtimeText = readFileSync(
      new URL('../../scripts/linux-auto-update-runtime.mjs', import.meta.url),
      'utf8',
    );
    const contractText = readFileSync(
      new URL('../../scripts/linux-auto-update-contract.mjs', import.meta.url),
      'utf8',
    );
    const workflow = parseYaml(workflowText) as Record<string, unknown>;

    expect(workflow).toBeTruthy();
    expect(workflowText).toContain('workflow_dispatch:');
    expect(workflowText).toContain('pull_request:');
    expect(workflowText).toContain("BASELINE_RELEASE_ID: '355459539'");
    expect(workflowText).toContain('BASELINE_SHA: 0854a63ed2f45a7bf34a1948b65453063b74585b');
    expect(workflowText).toContain('immutable == true');
    expect(workflowText).toContain('permissions:\n  contents: read');
    expect(workflowText).toContain('persist-credentials: false');
    expect(workflowText).toContain('cosign verify-blob');
    expect(workflowText).toContain('tampered AppImage unexpectedly passed');
    expect(runtimeText).toContain('http://127.0.0.1');
    expect(contractText).toContain("url.hostname !== '127.0.0.1'");
    expect(workflowText).toContain('linux-auto-update-runtime.mjs');
    expect(workflowText).toContain('create-snapshots');
    expect(workflowText).toContain('runs-on: ubuntu-24.04');
    expect(workflowText).toContain('Xvfb :99 -screen 0 1280x800x24');
    expect(workflowText).toContain('export DISPLAY=:99');
    expect(workflowText).not.toContain('xvfb-run');
    expect(workflowText).toContain('chmod -R a-w "$baseline_dir"');
    expect(workflowText).not.toContain('pull_request_target:');
    expect(workflowText).not.toContain('contents: write');
    expect(workflowText).not.toContain('secrets.');
    expect(workflowText).not.toContain('gh release create');
    expect(workflowText).not.toContain('gh release upload');
  });
});
