import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'compute-pages-base.mjs');
const { computePagesBase } = (await import(pathToUrl(script))) as { computePagesBase: (repo: string, override?: string) => string };

function pathToUrl(p: string): string {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

describe('GitHub Pages base path', () => {
  it.each([
    ['octocat/screenshot-gallery', undefined, '/screenshot-gallery/'],
    ['octocat/my-app', '', '/my-app/'],
    ['octocat/Repo_With.Dots', undefined, '/Repo_With.Dots/'],
    ['octocat/octocat.github.io', undefined, '/'],
    ['OctoCat/octocat.github.io', undefined, '/'],
    ['octocat/screenshot-gallery', '/', '/'],
    ['octocat/screenshot-gallery', '/tools/gallery', '/tools/gallery/'],
    ['octocat/screenshot-gallery', 'gallery/', '/gallery/'],
  ])('%s with override %j -> %s', (repo, override, expected) => {
    expect(computePagesBase(repo, override)).toBe(expected);
  });

  it.each(['no-slash', 'a/b/c', '/name', 'owner/', ''])('rejects the malformed repository %j', (repo) => {
    expect(() => computePagesBase(repo)).toThrow();
  });

  it.each(['../evil', 'a b', 'x;rm -rf', '$(id)', 'a\\b'])('rejects the unsafe override %j', (override) => {
    expect(() => computePagesBase('o/r', override)).toThrow();
  });

  it('works as a command line tool (as the workflow uses it)', () => {
    const out = execFileSync(process.execPath, [script, 'octocat/screenshot-gallery', ''], { encoding: 'utf8' });
    expect(out).toBe('/screenshot-gallery/');
  });
});
