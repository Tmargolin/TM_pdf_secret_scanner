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

await esbuild.build({
  entryPoints: {
    'background/service-worker': 'src/background/service-worker.ts',
    'offscreen/offscreen': 'src/offscreen/offscreen.ts',
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: false,
  sourcemap: mode === 'dev' ? 'inline' : false,
  define: { __DEV__: JSON.stringify(mode === 'dev') },
  logLevel: 'warning',
});

await cp('_locales', `${outdir}/_locales`, { recursive: true });
await cp('src/offscreen/offscreen.html', `${outdir}/offscreen/offscreen.html`);

const manifest = createManifest(template, { mode, version: pkg.version });
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${mode} extension v${pkg.version} in ${outdir}/`);
