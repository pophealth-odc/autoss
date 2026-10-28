#!/usr/bin/env node
// Copies the files that the service and the web page share from the service (the source of truth) into the frontend.
//
//   node scripts/sync-shared.mjs          copy the files
//   node scripts/sync-shared.mjs --check  only report differences (exit code 1 when the copies differ)
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [source in service, copy in frontend] */
export const SHARED_FILES = [
  ['service/src/shared/contract.ts', 'frontend/src/api/contract.ts'],
  ['service/src/shared/url-input.ts', 'frontend/src/api/url-input.ts'],
];

export function findDifferences() {
  const differences = [];
  for (const [from, to] of SHARED_FILES) {
    const source = path.join(root, from);
    const copy = path.join(root, to);
    if (!existsSync(copy) || !readFileSync(source).equals(readFileSync(copy))) differences.push({ from, to });
  }
  return differences;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const differences = findDifferences();
  if (check) {
    if (differences.length > 0) {
      for (const d of differences) console.error(`Out of date: ${d.to} (copy of ${d.from})`);
      console.error('Run "node scripts/sync-shared.mjs" to update the copies.');
      process.exit(1);
    }
    console.log('Shared files are in sync.');
  } else {
    for (const [from, to] of SHARED_FILES) {
      copyFileSync(path.join(root, from), path.join(root, to));
      console.log(`Copied ${from} -> ${to}`);
    }
  }
}
