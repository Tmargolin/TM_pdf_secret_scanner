# PDF Secret Scanner

A Chrome extension (Manifest V3) that warns you when a PDF you add to a website
on your allow list contains secrets – API keys, tokens, private keys and
similar. The PDF's text is checked by the Prompt Security API; results appear
as Chrome notifications. **Uploads are never blocked** – the extension only
alerts.

> **Status:** in development (v0.1.0) – scanning and notifications work;
> real-site testing next. This README is completed in step 9 of the plan.
> Design and plan: [DESIGN.md](DESIGN.md).

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
| `npm run package` | Release build, checked (version, no localhost, no source maps, all files) and zipped to `release/pdf-secret-scanner-<version>.zip` |

## Load in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist` folder.
3. After rebuilding, click the reload icon on the extension card.

## Configuration

Open the options page (`chrome://extensions` → Details → *Extension options*;
it also opens on first install):

1. Enter your **APP-ID** (Prompt Security) and Save. The API URL defaults to
   the EU endpoint.
2. **Add the sites** whose PDFs should be checked (e.g. `mail.google.com`,
   `*.slack.com`). Chrome asks for access to each site; nothing is scanned
   until a site is added.

**Reload open tabs after changing the list.** Adding or removing a site takes
effect in a tab only when the tab is (re)loaded: a site you add is not scanned
in tabs that were already open, and a site you remove is still scanned in tabs
that stay open, until you reload them. (Chrome injects the extension's scripts
when a page loads; changing the list cannot add them to, or remove them from,
a page that is already running.)
3. *Advanced settings* hold the limits (chunk size, timeouts, file size …);
   each field shows its default. All settings and defaults:
   [DESIGN.md §6](DESIGN.md).

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

## Notifications – what each one means

**When.** One Chrome notification per user action (one batch – e.g. three PDFs
picked at once give one notification), only for PDFs added to sites on the
allow list. A file that was checked completely and contains no secret gives
**no** notification. Notifications about secrets and failures stay on screen
until you dismiss them (where the operating system allows it). If Chrome's
notifications are switched off in the operating system, nothing is shown
(see Requirements). All texts live in `_locales/en/messages.json`.

**Secret values are never shown in full.** A value of 12 characters or more is
shown as its first 4 and last 2 characters (`AKIA…LE`); a shorter one, or one
the service did not return, as `••••••`.

### By result status

Every file ends in one of three statuses; the notification follows from them.

| Status | When | Title | Message |
|---|---|---|---|
| `clean` | Every part of the text was checked and no secret was found | – | No notification |
| `secrets` | At least one secret was found (even if other parts could not be checked) | **Secrets found in report.pdf** – or, for several files, **2 of 3 files contain secrets** | **You added it to mail.google.com.** (*them* for several files), then up to 3 findings – **AWS credentials (p. 3) AKIA…LE** – then **+N more** if there are more, any notes on unchecked text (below), and **Remove the file and rotate the credentials.** |
| `error` | No secret was found, but some or all of the text could **not** be checked – it is never reported as clean | **Couldn't fully scan report.pdf** – or **Couldn't fully scan 2 of 3 files** | The reason (table below); for several files one line per file: **report.pdf: The PDF is password-protected – it was not checked.** |

Notes added to a secrets message when part of the file was not checked:
**1 of 4 parts could not be scanned.** and/or **Only the first 2,000,000 of
3,500,000 characters were checked.**

**A batch with both kinds gives two notifications:** one about the files with
secrets, and one about the files that could not be (fully) checked, so the
urgent alert is never mixed with failures and no failure is hidden. (A single
file with secrets whose text was only partly checked gives one secrets
notification with the notes above.)

### Special notifications

| Case | Title | Message | Click |
|---|---|---|---|
| No APP-ID entered yet | **PDF Secret Scanner isn't set up** | **Click to add your APP-ID.** | Opens the settings |
| The scanning service rejected the APP-ID | **Couldn't scan report.pdf** | **Your APP-ID was rejected – check the extension settings.** | Opens the settings |
| The scan stopped before a result (the extension's scanning page was closed or restarted) | **The scan of report.pdf was interrupted** | **The scan was interrupted – the file was not checked.** | – |

### Reasons (error codes)

| Code | Text | What it means / what to do |
|---|---|---|
| `NOT_CONFIGURED` | PDF Secret Scanner has no APP-ID yet – the file was not checked. | Enter the APP-ID in the settings. |
| `FILE_TOO_LARGE` | The file is larger than the size limit – it was not checked. | Above *Maximum PDF size* (settings, default 25 MB). |
| `PDF_ENCRYPTED` | The PDF is password-protected – it was not checked. | The text cannot be read without the password. |
| `PDF_INVALID` | The PDF could not be read – it was not checked. | Damaged, truncated or not really a PDF. |
| `NO_TEXT_LAYER` | The PDF has no text (for example a scan) – it was not checked. | Images only; text recognition (OCR) is not supported. |
| `API_UNREACHABLE` | The scanning service could not be reached – the file was not checked. | No connection to the API (after retries). |
| `API_TIMEOUT` | The scanning service did not answer in time – the file was not fully checked. | Above *Time limit per request*, after retries. |
| `API_HTTP_ERROR` | The scanning service returned an error – the file was not fully checked. | The API answered with an error status (e.g. 500, 429) after retries. |
| `API_BAD_RESPONSE` | The scanning service gave an unexpected answer – the file was not fully checked. | The answer was not in the expected format. |
| `API_UNAUTHORIZED` | Your APP-ID was rejected – check the extension settings. | Wrong or revoked APP-ID. |
| `SCAN_INTERRUPTED` | The scan was interrupted – the file was not checked. | The scanning page stopped mid-scan, or the scan failed unexpectedly. |
| `SCAN_TIMEOUT` | The scan took too long and was stopped – the file was not fully checked. | Above *Time limit per file* (default 120 s). |
| `TEXT_TRUNCATED` | Only the first X of Y characters were checked. | The text is longer than *Maximum text per file* (default 2,000,000). |
| `CHUNK_TOO_LARGE` | Part of the text could not be scanned. | The service kept cutting a part short, even at the smallest size. |
| `QUEUE_FULL` | Too many files at once – this file was not checked. Try again in a moment. | More files waiting than *Files waiting* allows (default 200 MB). |

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
| `npm run fixtures` | Regenerates the sample PDFs in `tests/fixtures/` (a test checks they match) |

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

**Content script entry** (`src/content/index.ts`)

- *Scenario not covered:* the few lines that build the real `chrome.*`
  dependencies (scan port, `ENSURE_OFFSCREEN`, `SCAN_INTERRUPTED`,
  `chrome.storage.local`) and call `startContentScript`. The whole path behind
  it – page files → batch → PDF check → size check → scan requests – is tested
  in a real browser (`tests/browser/content-pipeline.test.ts`), and the scan
  sender with a fake port.
- *Needed for a future fix:* an end-to-end test with the extension loaded in
  Chromium (planned Playwright E2E tests).

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
