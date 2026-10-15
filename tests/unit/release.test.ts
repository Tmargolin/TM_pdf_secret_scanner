// Unit tests of the release checks and zip writer (scripts/release.ts,
// README "Build"). In-memory files only – nothing is built.
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkRelease, createZip, type PackageFile, REQUIRED_FILES } from '../../scripts/release.ts';

const VERSION = '1.2.3';
const bytes = (text: string) => new TextEncoder().encode(text);
const file = (path: string, text = `// ${path}`): PackageFile => ({ path, data: bytes(text) });

const MANIFEST = {
  manifest_version: 3,
  version: VERSION,
  icons: { '16': 'icons/icon-16.png', '128': 'icons/icon-128.png' },
  background: { service_worker: 'background/service-worker.js', type: 'module' },
  options_ui: { page: 'options/options.html', open_in_tab: true },
};

/** A release that passes every check; `changes` replaces or adds files by path. */
function release(changes: PackageFile[] = [], manifest: object = MANIFEST): PackageFile[] {
  const files = new Map<string, PackageFile>();
  for (const path of [...REQUIRED_FILES, 'icons/icon-16.png', 'icons/icon-128.png']) files.set(path, file(path));
  files.set('manifest.json', file('manifest.json', JSON.stringify(manifest)));
  for (const change of changes) files.set(change.path, change);
  return [...files.values()];
}
const without = (files: PackageFile[], path: string) => files.filter((f) => f.path !== path);

describe('checkRelease', () => {
  it('a clean release build: no problems', () => {
    expect(checkRelease(release(), VERSION)).toEqual([]);
  });

  it('no manifest: only that problem (run the build first)', () => {
    expect(checkRelease(without(release(), 'manifest.json'), VERSION)).toEqual([
      'manifest.json is missing – run the build first',
    ]);
  });

  it('a manifest that is not JSON: only that problem', () => {
    expect(checkRelease(release([file('manifest.json', '{ not json')]), VERSION)).toEqual([
      'manifest.json is not valid JSON',
    ]);
  });

  it('manifest version differs from package.json', () => {
    expect(checkRelease(release([], { ...MANIFEST, version: '1.2.2' }), VERSION)).toEqual([
      'manifest version 1.2.2 ≠ package.json version 1.2.3',
    ]);
  });

  it('a dev manifest (localhost) is rejected', () => {
    const dev = { ...MANIFEST, host_permissions: ['http://localhost:8787/*'] };
    expect(checkRelease(release([], dev), VERSION)).toEqual([
      'manifest.json grants localhost – this is a dev build (use npm run build)',
    ]);
  });

  it.each(REQUIRED_FILES.filter((path) => path !== 'manifest.json'))('a missing required file: %s', (path) => {
    expect(checkRelease(without(release(), path), VERSION)).toEqual([`missing ${path}`]);
  });

  it('a missing icon named by the manifest', () => {
    expect(checkRelease(without(release(), 'icons/icon-128.png'), VERSION)).toEqual(['missing icons/icon-128.png']);
  });

  it('service worker and options page are taken from the manifest too', () => {
    const moved = {
      ...MANIFEST,
      background: { service_worker: 'sw.js' },
      options_ui: { page: 'settings.html' },
    };
    expect(checkRelease(release([], moved), VERSION)).toEqual(['missing sw.js', 'missing settings.html']);
  });

  it('a manifest without icons, background or options needs only the required files', () => {
    expect(checkRelease(release([], { manifest_version: 3, version: VERSION }), VERSION)).toEqual([]);
  });

  it('a source map file is rejected', () => {
    expect(checkRelease(release([file('content/content.js.map', '{}')]), VERSION)).toEqual([
      'source map in the package: content/content.js.map',
    ]);
  });

  it.each(['offscreen/offscreen.js', 'offscreen/pdf.worker.mjs'])('an inline source map in %s is rejected', (path) => {
    const dev = file(path, 'x();\n//# sourceMappingURL=data:application/json;base64,e30=');
    expect(checkRelease(release([dev]), VERSION)).toEqual([`inline source map in ${path} – this is a dev build`]);
  });

  it('"sourceMappingURL=data:" in a non-script file is not a source map', () => {
    expect(checkRelease(release([file('notes.txt', 'sourceMappingURL=data:')]), VERSION)).toEqual([]);
  });

  it('every problem is listed, not just the first', () => {
    const files = without(release([file('a.js.map', '{}')], { ...MANIFEST, version: '0.0.1' }), 'content/content.js');
    expect(checkRelease(files, VERSION)).toHaveLength(3);
  });
});

/** A minimal zip reader: entries from the central directory, data inflated. */
function readZip(zip: Uint8Array) {
  const buf = Buffer.from(zip);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  const dirSize = buf.readUInt32LE(end + 12);
  const dirOffset = buf.readUInt32LE(end + 16);
  expect(dirOffset + dirSize).toBe(end);

  const entries: { path: string; method: number; flags: number; date: number; data: Buffer }[] = [];
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const localOffset = buf.readUInt32LE(at + 42);
    const path = buf.toString('utf8', at + 46, at + 46 + nameLength);

    // The local header repeats the central one.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buf.readUInt16LE(localOffset + 8)).toBe(method);
    expect(buf.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(buf.toString('utf8', localOffset + 30, localOffset + 30 + nameLength)).toBe(path);

    const start = localOffset + 30 + nameLength + buf.readUInt16LE(localOffset + 28);
    const body = buf.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    entries.push({ path, method, flags, date, data });
    at += 46 + nameLength;
  }
  expect(at).toBe(end);
  return entries;
}

describe('createZip', () => {
  const files: PackageFile[] = [
    file('options/options.js', 'const x = 1;\n'.repeat(200)), // compressible → deflate
    file('manifest.json', JSON.stringify(MANIFEST)),
    { path: 'icons/icon-16.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, // tiny → stored
    file('_locales/en/messages.json', '{"name":{"message":"Scanner – ✓"}}'),
    { path: 'empty.txt', data: new Uint8Array() },
  ];

  it('every entry reads back with its original bytes', () => {
    const entries = readZip(createZip(files));
    expect(entries).toHaveLength(files.length);
    for (const input of files) {
      const entry = entries.find((e) => e.path === input.path);
      expect(entry, input.path).toBeDefined();
      expect(new Uint8Array(entry!.data)).toEqual(input.data);
    }
  });

  it('compressible files are deflated; tiny or incompressible ones are stored', () => {
    const methods = Object.fromEntries(readZip(createZip(files)).map((e) => [e.path, e.method]));
    expect(methods['options/options.js']).toBe(8);
    expect(methods['icons/icon-16.png']).toBe(0);
    expect(methods['empty.txt']).toBe(0);
  });

  it('entries are sorted by path, with UTF-8 names and the fixed date 1980-01-01', () => {
    const entries = readZip(createZip(files));
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.path).sort());
    for (const entry of entries) {
      expect(entry.flags).toBe(0x0800);
      expect(entry.date).toBe((0 << 9) | (1 << 5) | 1);
    }
  });

  it('the same files give the same bytes, whatever their order', () => {
    expect(createZip([...files].reverse())).toEqual(createZip(files));
  });

  it('no files: an empty zip (end record only)', () => {
    const zip = createZip([]);
    expect(zip).toHaveLength(22);
    expect(readZip(zip)).toEqual([]);
  });
});
