// npm run package – builds the release and zips it for the Chrome Web Store
// or for sharing (DESIGN.md §11 step 9):
//   1. release build (node build.ts) into dist/
//   2. checks (scripts/release.ts): version, no localhost, no source maps, all files
//   3. release/pdf-secret-scanner-<version>.zip, manifest.json at the root
// Never contains an APP-ID: the build has none, it lives only in chrome.storage.

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { checkRelease, createZip, type PackageFile } from './release.ts';

const DIST = 'dist';
const OUT_DIR = 'release';

async function readTree(root: string): Promise<PackageFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return Promise.all(
    files.map(async (path) => ({ path: relative(root, path).split(sep).join('/'), data: new Uint8Array(await readFile(path)) })),
  );
}

const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };

execFileSync(process.execPath, ['build.ts'], { stdio: 'inherit' });

const files = await readTree(DIST);
const problems = checkRelease(files, version);
if (problems.length > 0) {
  console.error(`Not packaged:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `pdf-secret-scanner-${version}.zip`);
const zip = createZip(files);
await writeFile(zipPath, zip);
console.log(`Packaged ${files.length} files (${(zip.length / 1024 / 1024).toFixed(1)} MB) → ${zipPath}`);
