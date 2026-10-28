import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The service is the source of truth for the API contract and the address parser; the web page keeps identical copies
// so that it can be built and deployed on its own.
const SHARED: Array<[string, string]> = [
  ['service/src/shared/contract.ts', 'frontend/src/api/contract.ts'],
  ['service/src/shared/url-input.ts', 'frontend/src/api/url-input.ts'],
];

describe('shared files', () => {
  it.each(SHARED)('%s is identical to its frontend copy %s', (source, copy) => {
    const a = readFileSync(path.join(repoRoot, source));
    const b = readFileSync(path.join(repoRoot, copy));
    expect(
      a.equals(b),
      `${copy} differs from ${source}. Run "node scripts/sync-shared.mjs" from the repository root.`,
    ).toBe(true);
  });
});
