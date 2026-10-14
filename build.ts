// Build script – run with Node 24+ (TypeScript is executed directly).
//   node build.ts          → release build in dist/
//   node build.ts --dev    → dev build in dist/ (adds localhost access)
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';
import { createManifest, type BuildMode, type Manifest } from './scripts/manifest.ts';

const mode: BuildMode = process.argv.includes('--dev') ? 'dev' : 'release';
const outdir = 'dist';

const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const template = JSON.parse(await readFile('manifest.json', 'utf8')) as Manifest;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  outdir,
  bundle: true,
  target: 'chrome120',
  minify: false,
  sourcemap: mode === 'dev' ? ('inline' as const) : false,
  define: { __DEV__: JSON.stringify(mode === 'dev') },
  logLevel: 'warning' as const,
};

// Extension pages and the service worker load their scripts as ES modules.
await esbuild.build({
  ...common,
  entryPoints: {
    'background/service-worker': 'src/background/service-worker.ts',
    'offscreen/offscreen': 'src/offscreen/offscreen.ts',
  },
  format: 'esm',
});

// Content scripts are classic scripts (no import/export): wrap each in a function.
await esbuild.build({
  ...common,
  entryPoints: { 'content/content': 'src/content/index.ts' },
  format: 'iife',
});

await cp('_locales', `${outdir}/_locales`, { recursive: true });
await cp('src/offscreen/offscreen.html', `${outdir}/offscreen/offscreen.html`);

const manifest = createManifest(template, { mode, version: pkg.version });
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${mode} extension v${pkg.version} in ${outdir}/`);
