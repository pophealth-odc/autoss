// Prints the path of the installed Microsoft Edge and exits 0, or exits 1 when it cannot be found.
// Honors the same environment variables the service uses, so it can be tested against an "Edge-less" environment.
import { existsSync } from 'node:fs';
import path from 'node:path';

const explicit = process.env.EDGE_PATH;
if (explicit) {
  if (existsSync(explicit)) {
    console.log(`  Microsoft Edge: ${explicit}`);
    process.exit(0);
  }
  console.log(`  [!] EDGE_PATH points to a file that does not exist: ${explicit}`);
  process.exit(1);
}

const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
for (const root of roots) {
  const candidate = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  if (existsSync(candidate)) {
    console.log(`  Microsoft Edge: ${candidate}`);
    process.exit(0);
  }
}
process.exit(1);
