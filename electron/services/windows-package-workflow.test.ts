import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const workflow = parseYaml(
  readFileSync(new URL('../../.github/workflows/package-windows.yml', import.meta.url), 'utf8'),
);
const job = workflow.jobs['package-windows-x64'];
const roots: string[] = [];

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'windows-package-source-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Package Test');
  git('config', 'user.email', 'package@example.test');
  git('config', 'commit.gpgsign', 'false');
  return { cwd, git };
}

function run(cwd: string, name: string, env: Record<string, string> = {}) {
  const step = job.steps.find((entry: { name?: string }) => entry.name === name);
  expect(step, `missing workflow step: ${name}`).toBeDefined();
  return spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', step.run], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ENV: join(cwd, 'github-env'), ...env },
  });
}

afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('Windows package source identity', () => {
  it('binds directory, metadata and artifact name to checkout, not dispatch SHA', () => {
    const { cwd, git } = fixture();
    git('commit', '--allow-empty', '-qm', 'workflow revision');
    const workflowSha = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-qm', 'requested source');
    const source = git('rev-parse', 'HEAD');
    git('checkout', '--detach', source);
    expect(source).not.toBe(workflowSha);
    const capture = run(cwd, 'Capture checked-out source identity', { GITHUB_SHA: workflowSha });
    expect(capture.status, capture.stderr).toBe(0);
    const env = Object.fromEntries(
      readFileSync(join(cwd, 'github-env'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    expect(env).toEqual({ SOURCE_COMMIT: source, PACKAGE_DIR: `release/windows-x64-${source}` });
    mkdirSync(join(cwd, env.PACKAGE_DIR), { recursive: true });
    const metadata = run(cwd, 'Emit build metadata', {
      ...env,
      GITHUB_SHA: workflowSha,
      PACKAGE_VERSION: '0.1.4',
    });
    expect(metadata.status, metadata.stderr).toBe(0);
    const text = readFileSync(join(cwd, env.PACKAGE_DIR, 'BUILD_METADATA.txt'), 'utf8');
    expect(text).toContain(`commit=${source}\n`);
    expect(text).not.toContain(workflowSha);
    expect(text).toContain('signing=unsigned-dev-smoke');
    expect(job.env?.PACKAGE_DIR).toBeUndefined();
    const upload = job.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.with.name).toBe(
      'windows-x64-${{ env.PACKAGE_VERSION }}-${{ env.SOURCE_COMMIT }}',
    );
    expect(job.steps[1].name).toBe('Capture checked-out source identity');
  });

  it('refuses an unborn checkout even when workflow SHA exists', () => {
    const { cwd } = fixture();
    expect(
      run(cwd, 'Capture checked-out source identity', { GITHUB_SHA: 'a'.repeat(40) }).status,
    ).not.toBe(0);
  });

  it.each(['', 'a'.repeat(40)])('refuses missing or changed captured source: %s', (source) => {
    const { cwd, git } = fixture();
    git('commit', '--allow-empty', '-qm', 'source');
    mkdirSync(join(cwd, 'package'));
    expect(
      run(cwd, 'Emit build metadata', {
        SOURCE_COMMIT: source,
        PACKAGE_DIR: 'package',
        PACKAGE_VERSION: '0.1.4',
      }).status,
    ).not.toBe(0);
  });
});
