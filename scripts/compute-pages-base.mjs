#!/usr/bin/env node
// Works out the base path the web page must be built with for GitHub Pages.
//
//   node scripts/compute-pages-base.mjs <owner/repository> [override]
//
// * A project site lives at https://<owner>.github.io/<repository>/   -> base "/<repository>/"
// * A user/organisation site (repository named <owner>.github.io)      -> base "/"
// * A custom domain serves the site from its root                       -> pass "/" as the override
//
// The result is printed on stdout, so a workflow can capture it:  BASE=$(node scripts/compute-pages-base.mjs "$GITHUB_REPOSITORY" "$PAGES_BASE")
import { fileURLToPath } from 'node:url';

/** @param {string} repository "owner/name"  @param {string|undefined} override */
export function computePagesBase(repository, override) {
  const trimmedOverride = (override ?? '').trim();
  if (trimmedOverride !== '') {
    if (trimmedOverride === '/') return '/';
    const cleaned = trimmedOverride.replace(/^\/+|\/+$/g, '');
    const segments = cleaned.split('/');
    if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(cleaned) || segments.some((s) => s === '.' || s === '..')) {
      throw new Error(`The base path override "${override}" is not a valid path (use letters, digits and - _ . ~ between slashes; no "." or ".." parts).`);
    }
    return `/${cleaned}/`;
  }

  const parts = repository.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected "owner/repository", got "${repository}".`);
  }
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unexpected characters in the repository name "${name}".`);
  // Host names are case-insensitive, so "Owner.github.io" and "owner.github.io" are the same site.
  if (name.toLowerCase() === `${owner.toLowerCase()}.github.io`) return '/';
  return `/${name}/`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [repository, override] = process.argv.slice(2);
    if (!repository) throw new Error('Usage: node scripts/compute-pages-base.mjs <owner/repository> [override]');
    process.stdout.write(computePagesBase(repository, override));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
