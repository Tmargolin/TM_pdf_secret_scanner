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

**Known Chrome behaviour – removing a site:** when you remove a site from the
list, the extension gives Chrome's access to that site back
(`chrome.permissions.remove`) and Chrome confirms it – but the site may still
appear under `chrome://extensions` → Details → *Site access*, and adding the
same site again later may not show Chrome's permission prompt. This is how
Chrome keeps track of sites you once approved; it is not controlled by the
extension. Scanning stops either way: PDFs are only checked on sites that are
on the extension's list **and** granted. To clear the entry, remove the site
in Chrome's *Site access* list yourself.

**Known issue – restoring access to a revoked site:** if you revoke a site's
access in Chrome (`chrome://extensions` → Details → *Site access*), the site
stays on the extension's list but is no longer scanned, and the options page
does not show this. Adding it again answers "already on the list". To restore
scanning, **Remove** the site in the options page and **add** it again. To be
addressed by the planned per-site access status (see Future options).

## How uploads are detected – hooks in the page's MAIN world

> **The detection code runs inside the web page's own JavaScript world
> (Chrome's `MAIN` world), not in the extension's usual isolated world.
> This is deliberate, and it is the only place where it can work.**

**What it does.** However a file reaches a website – file picker, hidden or
detached input, input inside a shadow DOM, drag & drop, paste, folder drop,
File System Access API – the site's own code must obtain the `File` object
through a handful of browser APIs (`HTMLInputElement.files`,
`DataTransfer.files`, `DataTransferItem.getAsFile`, the folder-drop entries'
`file()` (reached through `webkitGetAsEntry`),
`FileSystemFileHandle.getFile`). The extension wraps these APIs **once, on
their prototypes**, before any page script runs (`document_start`). The
wrapper calls the original, notes the file, and returns **exactly** the
original result. We catch the **hand-off of the file to the page**, not a
particular event or element – so every way of adding a file is covered,
including ways a site invents itself.

**Why we wrap the hand-off instead of watching events.** Two reasons:

1. **"Hidden" upload paths that event listeners cannot see.** Listening for
   `change` / `drop` / `paste` events on the page misses common real-world
   cases:
   - **detached inputs** – `document.createElement('input').click()`: the
     input is never in the page, so its events never reach a listener there;
   - **inputs inside shadow DOM** – `change` does not cross a shadow-root
     boundary, and a *closed* shadow root cannot be looked into at all;
   - the **File System Access API** (`showOpenFilePicker()`, file handles
     from drag & drop) – there is no input element and no `change` event;
   - **folder drops** (`webkitGetAsEntry()` → entries → `file()`) and
     `dataTransfer.items[i].getAsFile()` – the files are produced by an API
     call, not delivered by an event.

   Every one of these still has to call one of the wrapped APIs to get the
   `File` – so the wrappers see them all.
2. **Warning before the file is sent.** The wrapper sees the file at the
   moment the site's code **receives it** – which is usually **before** the
   site uploads it (when the form is submitted, the message is sent, the
   "Upload" button is pressed). The alert can therefore arrive while the user
   can still remove the file and **avoid the leak**, not only report it
   afterwards. Sites that start uploading immediately may already have sent
   it; the alert then still tells the user to rotate the credentials. (The
   extension only alerts – it never blocks an upload.)

**Why it must be the MAIN world.** A content script normally runs in an
*isolated world*: it sees the same page, but has its **own copy** of every
JavaScript built-in. Wrapping `HTMLInputElement.prototype` there would change
only the extension's copy – the site's code would never pass through it, and
nothing would be detected. Only code in the page's own world can wrap the
prototypes the site actually uses.

**What this implies.**
- The MAIN world has **no `chrome.*` APIs**. The hooks therefore only
  forward each `File` to the extension's isolated content script over a
  private `MessageChannel`; everything else (reading the file, scanning,
  alerts) happens outside the page.
- The hooks **never** change what the page gets, never throw, never delay
  the page, and never read file contents. Nothing about results is ever put
  into the page.
- Code in the page's world is visible to the page. A site that deliberately
  undoes the wrappers can hide its own files from the extension – outside the
  threat model, which is protecting users from **accidental** leaks
  (DESIGN.md §8). The site can never read the APP-ID, scan results or
  notifications.

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
