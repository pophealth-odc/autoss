import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (await import(new URL(`file:///${path.join(repoRoot, 'scripts', 'check-node-version.mjs').replace(/\\/g, '/')}`).href)) as {
  satisfies: (version: string, range: string) => boolean;
};

describe('check-node-version: satisfies()', () => {
  it.each([
    ['24.18.0', '>=22.12.0', true],
    ['22.12.0', '>=22.12.0', true],
    ['22.11.9', '>=22.12.0', false],
    ['20.19.0', '^20.19.0 || >=22.12.0', true],
    ['20.18.0', '^20.19.0 || >=22.12.0', false],
    ['21.7.0', '^20.19.0 || >=22.12.0', false],
    ['23.0.0', '^20.19.0 || >=22.12.0', true],
    ['18.0.0', '>=18', true],
    ['16.20.0', '>=18', false],
    ['20.5.0', '~20.5.0', true],
    ['20.6.0', '~20.5.0', false],
    ['22.12.0', '>=22.12.0 <23', true],
    ['23.1.0', '>=22.12.0 <23', false],
  ])('%s against "%s" -> %s', (version, range, expected) => {
    expect(mod.satisfies(version, range)).toBe(expected);
  });

  it('rejects garbage instead of crashing', () => {
    expect(mod.satisfies('not-a-version', '>=1')).toBe(false);
    expect(mod.satisfies('22.0.0', 'banana')).toBe(false);
  });
});

describe('check-node-version: command line', () => {
  it('prints OK for the running Node and the real package.json', () => {
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'check-node-version.mjs'), path.join(repoRoot, 'service', 'package.json')], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/^OK \d+\.\d+\.\d+$/);
  });

  it('explains what is wrong when the requirement is not met', () => {
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'check-node-version.mjs'), path.join(repoRoot, 'service', 'package.json')], {
      encoding: 'utf8',
    });
    expect(out).not.toMatch(/undefined/);
  });

  it('survives a missing package.json', () => {
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'check-node-version.mjs'), path.join(repoRoot, 'no-such-file.json')], { encoding: 'utf8' });
    expect(out).toMatch(/Could not read/);
  });
});

describe('find-edge', () => {
  const script = path.join(repoRoot, 'scripts', 'find-edge.mjs');
  const run = (env: Record<string, string>) => {
    try {
      const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env } });
      return { code: 0, out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? '' };
    }
  };

  it('finds Edge in the standard location (when installed on this machine)', () => {
    const result = run({ 'PROGRAMFILES(X86)': process.env['PROGRAMFILES(X86)'] ?? '', PROGRAMFILES: process.env['PROGRAMFILES'] ?? '', LOCALAPPDATA: process.env['LOCALAPPDATA'] ?? '' });
    if (result.code === 0) expect(result.out).toMatch(/msedge\.exe/i);
  });

  it('reports failure in an environment without Edge', () => {
    const empty = path.join(repoRoot, 'definitely-not-a-real-folder');
    expect(run({ 'PROGRAMFILES(X86)': empty, PROGRAMFILES: empty, LOCALAPPDATA: empty }).code).toBe(1);
  });

  it('honours EDGE_PATH, and reports a wrong one', () => {
    expect(run({ EDGE_PATH: process.execPath }).code).toBe(0);
    const wrong = run({ EDGE_PATH: path.join(repoRoot, 'nope.exe') });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/does not exist/);
  });
});
