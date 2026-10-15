# PDF Secret Scanner – agent guide

Chrome MV3 extension (TypeScript). Detects PDFs handed to allow-listed sites,
extracts text (pdf.js), checks it with the Prompt Security API, shows a Chrome
notification on secrets or scan failure. Alerts only – never blocks uploads.

Spec, rationale, decisions: `DESIGN.md` (not repeated here).

## Components
| Context | Path | Doc |
|---|---|---|
| MAIN-world hooks | `src/main-world/` | `docs/agents/main-world-hooks.md` |
| Content script (isolated world) | `src/content/` | `docs/agents/content-script.md` |
| Offscreen document – owns all scan work | `src/offscreen/` | `docs/agents/offscreen.md` |
| Scanner library (runs in offscreen) | `src/scanner/` | `docs/agents/scanner.md` |
| Service worker | `src/background/` | `docs/agents/service-worker.md` |
| Options page | `src/options/` | `docs/agents/options.md` |
| Shared modules | `src/shared/` | `docs/agents/shared.md` |

Cross-cutting: messages `docs/agents/protocol.md` · tests `docs/agents/testing.md` ·
build, manifests, CI, scripts `docs/agents/build.md`.

## Data flow
hooks →(MessageChannel: `File`)→ content script →(port `scan-batch`:
`SCAN_REQUEST`)→ offscreen →(fetch)→ API · offscreen →(`SHOW_RESULT`)→
service worker → `chrome.notifications`

## Global rules
- Service worker is never on the scan path and holds no scan state.
- No UI in web pages; all alerts are `chrome.notifications`.
- Never log, store or display: PDF text, request/response bodies, unmasked
  secrets, APP-ID. Log only via `src/shared/safe-logger.ts`.
- Hooks return the original result unchanged and never throw.
- Secret verdict = `result.prompt.findings.Secrets` is non-empty.
- Scans continue after the page disconnects; they end only on completion or
  `jobTimeoutMs`.
- No remote code, no eval; pdf.js `isEvalSupported: false`.
- Release build: no localhost permission or API URL. Incognito not allowed.

## Working rules
- Commits: Conventional Commits; each `feat`/`fix` commit followed by its own
  `test` commit; every commit builds and passes tests – `DESIGN.md` §10.
- Steps and planned commits: `DESIGN.md` §11; current step = latest `step-N` tag.
- Decisions: `DESIGN.md` §13 – do not reverse without the user's approval.
- Changing a component's paths, interfaces, settings or rules → update its
  `docs/agents/*.md` in the same commit.

## Commands
`npm run build` · `build:dev` · `typecheck` · `test` · `test:coverage` ·
`serve:test-pages` · `mock-api` · `fixtures` · `audit` ·
`node scripts/probe-api.mjs` (needs `PSS_APP_ID`; developer only).

## Where to look
| Task | Read |
|---|---|
| Add or change a setting | `shared.md`, `options.md` |
| Add a message type | `protocol.md` |
| Detect a new file source | `main-world-hooks.md` |
| Batching, PDF filter | `content-script.md` |
| Jobs, limits, extraction | `offscreen.md` |
| Chunking, API calls, findings | `scanner.md` |
| Notifications, script registration | `service-worker.md` |
| Texts (i18n), error codes | `shared.md` |
| Tests, fixtures, fakes | `testing.md` |
