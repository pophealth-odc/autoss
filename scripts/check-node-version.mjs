// Prints "OK <version>" when the running Node.js satisfies the "engines.node" range of a package.json, otherwise a sentence
// describing the problem. Used by the Windows scripts so the version rule lives in one place (service/package.json).
//
//   node scripts/check-node-version.mjs <path-to-package.json>
import { readFileSync } from 'node:fs';

/** Supports the range forms used in this repository: ">=22.12.0", "^20.19.0 || >=22.12.0" and ">=18". */
export function satisfies(version, range) {
  const parse = (text) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
  };
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const current = parse(version);
  if (!current) return false;
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => {
        const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(term);
        if (!m) return false;
        const op = m[1] ?? '=';
        const target = parse(m[2]);
        const cmp = compare(current, target);
        switch (op) {
          case '>=': return cmp >= 0;
          case '>': return cmp > 0;
          case '<=': return cmp <= 0;
          case '<': return cmp < 0;
          case '^': return cmp >= 0 && current[0] === target[0];
          case '~': return cmp >= 0 && current[0] === target[0] && current[1] === target[1];
          default: return cmp === 0;
        }
      }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  try {
    const pkg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const range = pkg?.engines?.node ?? '>=22.12.0';
    const current = process.versions.node;
    console.log(satisfies(current, range) ? `OK ${current}` : `Node.js ${current} is too old. This project needs ${range}.`);
  } catch (error) {
    console.log(`Could not read the Node.js requirement: ${error instanceof Error ? error.message : String(error)}`);
  }
}
