// Release checks and zip writing for `npm run package` (scripts/package.ts,
// README "Build"). Pure functions over a list of files, so they can be
// tested without building.
//
// The zip is written by hand (no dependency): deflate from node:zlib, entries
// sorted, fixed timestamps (1980-01-01) – the same dist/ gives the same bytes.

import { crc32, deflateRawSync } from 'node:zlib';

export interface PackageFile {
  /** Path inside the package, with "/" separators, e.g. "background/service-worker.js". */
  path: string;
  data: Uint8Array;
}

/** Files every release must contain (besides what the manifest names). */
export const REQUIRED_FILES = [
  'manifest.json',
  '_locales/en/messages.json',
  'background/service-worker.js',
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'offscreen/pdf.worker.mjs',
  'options/options.html',
  'options/options.js',
  'content/content.js',
  'main-world/hooks.js',
];

const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Every path the manifest refers to: icons, service worker, options page. */
function manifestPaths(manifest: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const icons = manifest['icons'];
  if (icons && typeof icons === 'object') paths.push(...Object.values(icons as Record<string, string>));
  const background = manifest['background'] as { service_worker?: string } | undefined;
  if (background?.service_worker) paths.push(background.service_worker);
  const options = manifest['options_ui'] as { page?: string } | undefined;
  if (options?.page) paths.push(options.page);
  return paths;
}

/**
 * Problems that make dist/ unfit for release; empty when it is fine.
 * A release must be a release build of this version: no localhost access, no
 * source maps, every file the extension loads present.
 */
export function checkRelease(files: readonly PackageFile[], version: string): string[] {
  const problems: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestFile = byPath.get('manifest.json');
  if (!manifestFile) return ['manifest.json is missing – run the build first'];

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text(manifestFile.data)) as Record<string, unknown>;
  } catch {
    return ['manifest.json is not valid JSON'];
  }
  if (manifest['version'] !== version) problems.push(`manifest version ${String(manifest['version'])} ≠ package.json version ${version}`);
  if (text(manifestFile.data).includes('localhost')) problems.push('manifest.json grants localhost – this is a dev build (use npm run build)');

  for (const path of new Set([...REQUIRED_FILES, ...manifestPaths(manifest)])) {
    if (!byPath.has(path)) problems.push(`missing ${path}`);
  }
  for (const file of files) {
    if (file.path.endsWith('.map')) problems.push(`source map in the package: ${file.path}`);
    if (/\.(m?js)$/.test(file.path) && text(file.data).includes('sourceMappingURL=data:')) {
      problems.push(`inline source map in ${file.path} – this is a dev build`);
    }
  }
  return problems;
}

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

/** A standard zip (deflate), entries sorted by path, fixed timestamps. */
export function createZip(files: readonly PackageFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of sorted) {
    const name = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(file.data, { level: 9 });
    const stored = deflated.length >= file.data.length; // incompressible: store as is
    const body = stored ? Buffer.from(file.data) : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time 00:00
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal/external attributes: 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
