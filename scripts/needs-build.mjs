// Prints "1" when the compiled service (dist/) is older than its sources, otherwise nothing.
//
//   node scripts/needs-build.mjs <service-folder>
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function newestModified(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestModified(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

try {
  const service = process.argv[2];
  const entry = path.join(service, 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.log('1');
  } else {
    const built = statSync(entry).mtimeMs;
    const sources = newestModified(path.join(service, 'src'));
    const manifest = Math.max(statSync(path.join(service, 'package.json')).mtimeMs, existsSync(path.join(service, 'tsconfig.build.json')) ? statSync(path.join(service, 'tsconfig.build.json')).mtimeMs : 0);
    if (Math.max(sources, manifest) > built) console.log('1');
  }
} catch {
  // If the check itself fails, building is the safe choice.
  console.log('1');
}
