# PDF Secret Scanner

A Chrome extension (Manifest V3) that warns you when a PDF you add to a website
on your allow list contains secrets – API keys, tokens, private keys and
similar. The PDF's text is checked by the Prompt Security API; results appear
as Chrome notifications. **Uploads are never blocked** – the extension only
alerts.

> **Status:** in development (v0.1.0). This README is a skeleton and is
> completed in step 9 of the plan. Design and plan: [DESIGN.md](DESIGN.md).

## Requirements

- Google Chrome 120 or later
- **Notifications enabled for Google Chrome in the operating system.** All
  alerts are Chrome notifications; if they are blocked, the extension still
  scans but you will not see any alert.
  - Windows: Settings → System → Notifications – Notifications on, **Google
    Chrome** on; Do not disturb / Focus Assist off (otherwise alerts only go
    to the notification center, Win+N).
  - macOS: System Settings → Notifications → Google Chrome – Allow
    notifications.
  - In Chrome itself, notifications of this extension must not be turned off.
- Node.js 24 or later (for building and testing)

## Setup

```powershell
npm install
npx playwright install chromium   # browser for the test suite
```

## Build

| Command | Output |
|---|---|
| `npm run build` | Release build in `dist/` |
| `npm run build:dev` | Development build in `dist/` – additionally allows `http://localhost` (local test pages, mock API) |

## Load in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist` folder.
3. After rebuilding, click the reload icon on the extension card.

## Configuration

*Completed in step 3 (options page):* APP-ID, API URL, site allow list and all
settings with their defaults.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit tests – Node (`tests/unit`) and real Chromium (`tests/browser`) |
| `npm run test:coverage` | Tests with coverage; fails below 80 % for `src/scanner` and `src/shared` |
| `npm run audit` | Fails on high or critical dependency vulnerabilities |

CI (GitHub Actions) runs all of the above plus both builds on every push.

Manual tests (real Chrome, OS notifications; later the real API and real
websites) follow [docs/manual-tests.md](docs/manual-tests.md). They use a local
test page with the **dev build**:

| Command | What it runs |
|---|---|
| `npm run serve:test-pages` | Test pages on `http://localhost:8080/upload.html` (`PAGES_PORT` to change; loopback only) |
| `npm run mock-api` | Local mock of the Prompt Security API on `http://localhost:8787` |

**Planned:** automated end-to-end tests with Playwright – Chromium launched
with the extension loaded, local test pages and a mock API.

### Known gaps in test coverage

**Service worker – settings reply when storage fails**
(`src/background/service-worker.ts`, `OFFSCREEN_READY` handler)

- *Scenario not covered:* the offscreen document sends `OFFSCREEN_READY`,
  and reading the settings from `chrome.storage.local` fails. The service
  worker then answers with no settings (`sendResponse(undefined)`), and the
  offscreen document retries after 0.5 s, 2 s and 5 s. The retries are
  tested (`settings-client`); the service worker's failure reply is not.
  Coverage shows this as one uncovered function in `service-worker.ts`.
- *Needed for a future fix:* let the chrome fake
  (`tests/helpers/chrome-fake.ts`) make `storage.local.get` reject on demand
  (for example a `failNextGet` option); then, in `service-worker.test.ts`,
  send `OFFSCREEN_READY` from the offscreen document's sender and check that
  `sendResponse` is called with `undefined`.

**Content script entry – page wiring** (`src/content/index.ts`)

- *Scenario not covered:* the `change` listener on `<input type="file">`,
  turning the selected files into a batch and calling `chrome.runtime`. The
  modules it uses (`encode.ts`, `scan-sender.ts`) are fully tested; the wiring
  itself is checked manually (`docs/manual-tests.md`, step 2).
- *Needed for a future fix:* a browser-mode test (`tests/browser/`) that
  loads the entry with the chrome fake installed, selects files in a real
  input and checks the batch sent on the port. Planned with step 4, which
  replaces this entry with the hand-off hooks.

**Options page – page wiring** (`src/options/options.ts`)

- *Scenario not covered:* building the inputs, filling them, showing errors
  under the fields, "Restore defaults", the show-APP-ID toggle and the
  not-configured banner. The logic behind them (`form.ts`) is fully tested;
  the wiring is checked manually (`docs/manual-tests.md`).
- *Needed for a future fix:* a browser-mode test that loads `options.html`
  with the chrome fake installed and drives the form (type, Save, read the
  error texts and stored settings).

**Scan sender – double finish guard** (`src/content/scan-sender.ts`,
`if (settled) return`)

- *Scenario not covered:* one try finishing twice (e.g. `BATCH_DONE` and a
  disconnect both reported). Chrome never fires `onDisconnect` on the end that
  called `disconnect()`, so this cannot happen with the real API or the
  faithful port fake; the guard is defensive.
- *Needed for a future fix:* none unless the port behaviour changes; a test
  would need a port fake that breaks Chrome's rules.

## Privacy and security (summary)

- The full text of PDFs added to allow-listed sites is sent to the Prompt
  Security API. Vendor-side retention is unknown.
- Incognito windows are not supported.
- Secrets and PDF text are kept in memory only; never stored or logged.
- Never commit your APP-ID.

*Full details completed in step 9.*

## Future options

- Event-listener safety net for upload detection
- Text clean-up before chunking
- Details page / recent-scans history
- Enterprise deployment via managed storage
- Per-tab rate limiting
- OCR for scanned PDFs, other file types
- Automated end-to-end tests with Playwright
- Toolbar badge ("!" on the extension icon) when notifications are blocked in
  Chrome (blocking by the operating system cannot be detected)
- Per-site access status in the options page. A site is scanned only when it
  is on the allow list **and** Chrome access is granted. If access is revoked
  (e.g. in `chrome://extensions`) or the permission prompt was declined, the
  site stays on the list but is silently not scanned. Future: show each site
  as "active" or "access not granted" with a button that requests access again

## For developers and AI agents

- [DESIGN.md](DESIGN.md) – architecture, decisions, plan
- [AGENTS.md](AGENTS.md) – entry point for AI coding agents
