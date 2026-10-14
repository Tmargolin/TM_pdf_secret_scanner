# Build, manifests, CI, scripts

Design: `DESIGN.md` §8 (permissions), §9, §10, §15

| Item | Path |
|---|---|
| Build (esbuild) | `build.ts` (run by Node directly) → `dist/`; `npm run build` release, `npm run build:dev` dev |
| Bundled entry points | ES modules: `background/service-worker`, `offscreen/offscreen`, `options/options` (+ `offscreen.html`, `options.html` copied next to them; pdf.js worker `pdfjs-dist/legacy/build/pdf.worker.mjs` copied to `offscreen/pdf.worker.mjs`); classic scripts (`iife`): `content/content` ← `src/content/index.ts`, `main-world/hooks` ← `src/main-world/index.ts` |
| Manifest generation | `scripts/manifest.ts` (`createManifest`; dev adds `http://localhost/*`) |
| Dev flag in code | `__DEV__` (esbuild `define`; declared in `src/globals.d.ts`) |
| Manifest | `manifest.json` (template; dev adds `http://localhost/*` + allow-list seed) |
| Strings | `_locales/en/messages.json` |
| Icons | `icons/icon-{16,32,48,128}.png` → `dist/icons/` (manifest `icons`; notifications use 128) |
| CI | `.github/workflows/ci.yml` |
| Dependabot | `.github/dependabot.yml` |
| Scripts | `scripts/probe-api.mjs`, `mock-api.mjs`, `make-fixtures.ts`, `serve-test-pages.mjs` |

## Manifest rules
- Permissions: `storage`, `offscreen`, `notifications`, `scripting`;
  `host_permissions`: API host; `optional_host_permissions`: `*://*/*`.
- No static `content_scripts`; `incognito: not_allowed`;
  `minimum_chrome_version`; `default_locale: en`; default MV3 CSP.
- Release build must not contain localhost entries (tested).

## Rules
- Never commit `dist/`, `node_modules/`, zips, or any APP-ID.
- `probe-api.mjs` reads `PSS_APP_ID` from the environment; prints no secrets.
- `make-fixtures.ts` (`npm run fixtures`): writes `tests/fixtures/*.pdf` by hand
  (no library); re-run and commit after changing it.
- `serve-test-pages.mjs` (`npm run serve:test-pages`): serves `test-pages/` on
  `127.0.0.1:8080` (`PAGES_PORT`); open as `http://localhost:…` (dev allow list).
- `mock-api.mjs` (`npm run mock-api`): `http://localhost:8787/api/protect`; env
  `MOCK_PORT`, `MOCK_APP_ID` (only accepted APP-ID, default `mock-app-id`;
  others → 401), `MOCK_SCAN_WINDOW` (default 131072, text beyond is
  silently ignored like the real API), `MOCK_MODE` (`normal` | `413` | `429` |
  `500` | `timeout` | `malformed`), `MOCK_LATENCY_MS`. Behaviour must match
  `DESIGN.md` §5.
