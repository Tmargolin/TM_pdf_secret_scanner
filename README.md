# PDF Secret Scanner

A Chrome extension (Manifest V3) that warns you when a PDF you add to a website
on your allow list contains secrets – API keys, tokens, private keys and
similar. The PDF's text is checked by the Prompt Security API; results appear
as operating-system notifications. **Uploads are never blocked** – the
extension only alerts.

> **Status:** feature-complete for v1 – detection, scanning and notifications
> work and were tested on Gmail, Google Drive, ChatGPT and LinkedIn. From
> v1.1 the scanning document runs only while there is work.
> Design, decisions and plan: [DESIGN.md](DESIGN.md).

**How it works, in one line:** the browser hands a file to the site's code →
the extension notices the `File` → if it is a PDF on an allow-listed site, its
text is extracted with [pdf.js](https://mozilla.github.io/pdf.js/) and sent to
the Prompt Security API in parts → if a secret is found (or the file could not
be fully checked), a notification tells you.

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

**Release build – use this one:**

```powershell
npm run package
```

It builds the release into `dist/`, checks it (manifest version matches
`package.json`, no localhost access, no source maps, every file the extension
loads is present) and zips it to `release/pdf-secret-scanner-<version>.zip`.
If a check fails, it lists the problems and writes no zip.

Other builds (development and checks only):

| Command | Output |
|---|---|
| `npm run build` | Release build in `dist/`, without the checks and the zip |
| `npm run build:dev` | Development build in `dist/` – additionally allows `http://localhost` (local test pages, mock API). Not for use on real sites. |

## Load in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist` folder after `npm run package`
   (or the folder you unpacked the release zip into).
3. After rebuilding, click the reload icon on the extension card.

## Configuration

Open the options page (`chrome://extensions` → Details → *Extension options*;
it also opens on first install):

1. Enter your **APP-ID** (Prompt Security) and Save. The API URL defaults to
   the EU endpoint.
2. **Add the sites** whose PDFs should be checked (e.g. `mail.google.com`,
   `*.example.com`). The list is **empty by default – nothing is scanned
   until you add a site.** Chrome asks for access to each site you add; a
   site is scanned only when it is on the list **and** access is granted.
3. *Advanced settings* hold the limits (below); each field shows its default.

**Reload open tabs after changing the list.** Adding or removing a site takes
effect in a tab only when the tab is (re)loaded: a site you add is not scanned
in tabs that were already open, and a site you remove is still scanned in tabs
that stay open, until you reload them. (Chrome injects the extension's scripts
when a page loads; changing the list cannot add them to, or remove them from,
a page that is already running.)

**Upload frames from another site need their own entry.** If a site uploads
through an embedded frame from a different origin, that origin must be added
to the list as well.

### Settings and defaults

| Setting | Default | Allowed | Notes |
|---|---|---|---|
| APP-ID | *(empty)* | | Required; nothing is checked without it |
| API URL | `https://eu.prompt.security/api/protect` | `https://` on the Prompt Security host | Dev builds also accept `http://localhost:<port>` |
| Sites to protect | *(empty)* | Site patterns | Each needs Chrome's permission |
| Chunk size | 32,000 characters | 500–50,000 | The text is sent in parts of this size |
| Chunk overlap | 200 characters | 0–2,000 | Text repeated between parts, for context |
| Maximum request size | 65,536 bytes | 8,192–262,144 | UTF-8 size of one request body |
| Maximum text per file | 2,000,000 characters | 10,000–10,000,000 | Longer texts: the first part is checked, with a warning |
| Parallel API requests | 4 | 1–16 | Across all scans |
| Parallel PDF extractions | 2 | 1–4 | PDFs read at the same time |
| Files in progress | 60 MB | 10–500 | Total size being processed; more files wait |
| Files waiting | 200 MB | 10–1,000 | Total size received and not finished; above it → `QUEUE_FULL` |
| Time limit per file | 120,000 ms | 10,000–600,000 | Counted from when the file starts being processed |
| Time limit per request | 15,000 ms | 1,000–120,000 | |
| Retries per request | 2 | 0–5 | After network errors, timeouts, 429 and 5xx, with growing pauses |
| Maximum PDF size | 25 MB | 1–45 | Files travel in one message (Chrome's 64 MB limit) |
| Close the scanner when idle for | 60 seconds | 0, or 10–3,600 | Frees the scanning document's memory between uploads; the next PDF starts it again. 0 = never close |

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

## Design choices

Three choices shape the whole extension. None of them is the obvious first
idea; each is explained below with what it costs. All decisions, with the
alternatives that were rejected: [DESIGN.md §13](DESIGN.md).

```
web page   hooks (MAIN world) ──MessageChannel──▶ content script (isolated world)
                                                      │ port, file bytes
                                                      ▼
extension  offscreen document: jobs, pdf.js, chunking, API calls, findings ──▶ Prompt Security API
                                                      │ masked result
                                                      ▼
           service worker ──▶ chrome.notifications ──▶ operating-system notification
```

### 1. Detection runs in the page's MAIN world

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

### 2. Alerts are operating-system notifications, not shown in the page

**What it does.** Every alert is a Chrome notification
(`chrome.notifications`), which Chrome hands to the operating system – on
Windows it appears as a Windows notification and stays in the notification
center. The extension never draws anything inside a web page.

**Why.**
- **It works in every case.** The result arrives seconds after the file was
  added. By then the user may have sent the mail, the page may have
  navigated, the upload may have happened in a small iframe, or the tab may
  be closed. An in-page banner would have nowhere to appear in most of these
  cases; a system notification appears in all of them, the same way.
- **The page never sees the result.** Anything drawn in a page can be read,
  hidden or covered by the page's own code. With system notifications, the
  findings (masked secrets, file names) never enter the page at all – a site
  cannot read them, suppress them or fake them.
- **One mechanism.** A banner with fallbacks (top frame, then notification)
  would mean several code paths and several looks for the same alert.

**What it costs.**
- **It depends on the operating system's settings.** If notifications for
  Chrome are off in Windows, or Do not disturb / Focus Assist is on, the
  alert is hidden or only goes to the notification center. Chrome cannot
  tell the extension when the OS blocks it, so this is listed as a
  requirement. Blocking *inside Chrome* is detected and the options page
  warns about it.
- **Short text.** The OS shortens long messages, so a notification shows at
  most three findings and a short reason.
- **Notifications can stay in the OS history and on the lock screen** – one
  reason why secret values are always masked.

### 3. Almost all the logic runs in the offscreen document

**What it does.** A Manifest V3 extension has no permanent background page.
Its parts are the **service worker** (background events), **content scripts**
(inside web pages) and, optionally, an **offscreen document** – a hidden
extension page. Here the offscreen document does all the scan work: the job
queue and limits, PDF parsing with pdf.js, chunking, API calls, reading the
findings and masking them. The content script only passes the file's bytes
to it; the service worker only creates it, passes it the settings and shows
the final notification.

**Why not the content script** (inside the web page):
- The API call would be made from the page's process and is subject to the
  page's cross-origin rules; the APP-ID would have to be there too.
- pdf.js would be loaded into every page of every allow-listed site, and
  parsing a large PDF would slow down the page the user is working in.
- A scan would die when the tab is closed – right after "upload and leave".

**Why not the service worker** (the usual MV3 background):
- **Chrome stops the service worker** when it has been idle for about 30
  seconds, and the extension cannot prevent it. A scan of a large PDF with
  several API calls and retries could be cut off in the middle and its result
  lost.
- pdf.js needs a Web Worker to parse PDFs; a service worker cannot start one.

**Why the offscreen document fits.** Its lifetime is controlled by the
extension, not by Chrome's idle rules, so a running scan is never cut off. It
is a normal page, so pdf.js gets its Web Worker. And all state – jobs,
queues, limits, the API-call round-robin between files – lives in **one**
place, with no coordination across contexts. Because the service worker holds
no scan state, Chrome can stop it at any time without losing anything; it is
woken by single short messages (create the document, read settings, show a
notification).

**What it costs.**
- Memory while the document is open: about 9 MB (measured: the whole
  extension uses about 60 MB with it, 51 MB without). Since v1.1 it is created
  for the first PDF and closed after *Close the scanner when idle for*
  (default 60 s) without work; the next PDF creates it again, with no
  noticeable delay. A PDF added just as it closes is resent automatically to
  the new document.
- An offscreen document can use only `chrome.runtime`: it cannot read
  `chrome.storage` (the service worker sends it the settings) and cannot show
  notifications (it sends the result to the service worker).
- File bytes travel from the content script as base64 text, because
  extension messages are JSON. That is why the maximum PDF size is 45 MB
  (Chrome's 64 MB message limit).

## Privacy and security

**Threat model.** The extension protects you from **accidentally** giving a
website a PDF that contains secrets. It is not a defence against a website
that deliberately evades it: such a site can undo the hooks and hide its own
files. A hostile site can never read the APP-ID, scan results or
notifications.

**What leaves your machine**
- The **full text** of every PDF added to an allow-listed site is sent to the
  Prompt Security API (EU endpoint by default). This includes a PDF you
  select and then cancel: once the page holds the file, it could upload it at
  any time.
- How Prompt Security retains or logs this text is **unknown**; its answers
  indicate that requests are logged.
- No analytics or telemetry of our own.

**On your machine**
- The **APP-ID** is stored unencrypted in the Chrome profile
  (`chrome.storage.local`). Never commit it anywhere.
- PDF text and secret values are kept **in memory only**, for the time of the
  scan; they are never stored or logged. Notifications show secrets masked
  (first 4 and last 2 characters, or `••••••` below 12 characters).
- **Incognito windows are not supported** in this version.
- File names in notifications come from the website: they are shortened to
  60 characters and control and text-direction characters are removed. The
  site name shown comes from Chrome, not from the page.

**Hardening**
- pdf.js parses untrusted files with extension privileges: version pinned
  (6.4.299), `eval` disabled (`isEvalSupported: false`), Chrome's default
  extension CSP (no remote code, no `eval`). `npm audit` runs in CI;
  Dependabot is enabled.
- One runtime dependency (pdf.js), committed lockfile, no remotely loaded
  code. Release builds contain no localhost access and no source maps
  (checked by `npm run package`).
- Messages are accepted only from the expected parts of the extension and
  are type- and size-checked; web pages cannot message the extension.

**Known, not handled in this version**
- A hostile page could flood the extension with files (API quota, CPU,
  notifications); there is no per-tab rate limit.
- Enterprise deployment via managed storage (`chrome.storage.managed`) is not
  supported.

## Known limitations

- **Alerts only** – an upload is never blocked. A site that uploads
  immediately may have sent the file before the alert appears.
- **API behaviour:** the API silently stops checking very long texts
  (somewhere between 128,000 and 256,000 characters) while still answering
  "clean". The extension therefore sends the text in parts of 32,000
  characters and treats an answer that reports fewer characters than were
  sent as "cut short" – the part is split and sent again, down to 500
  characters (`CHUNK_TOO_LARGE`).
- **Which secret types are detected depends on Prompt Security.** In tests,
  AWS keys were detected reliably; other types depend on the vendor.
- Only the API's *Secrets* findings are used; other detectors (e.g. sensitive
  data) are ignored.
- Secrets broken by the PDF's layout (hyphenation, a line break inside a key)
  may be missed.
- Scanned PDFs without a text layer are not checked (no OCR); only PDFs are
  checked.
- Only allow-listed sites are protected; open tabs need a reload after the
  list changes.

## Testing

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit tests – Node (`tests/unit`) and real Chromium (`tests/browser`) |
| `npm run test:coverage` | Tests with coverage; fails below 80 % for `src/scanner` and `src/shared` |
| `npm run audit` | Fails on high or critical dependency vulnerabilities |

CI (GitHub Actions) runs all of the above plus both builds on every push.

Manual tests (real Chrome, OS notifications, the real API and real websites) follow [docs/manual-tests.md](docs/manual-tests.md). They use a local
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

## Development

- **Dev build** (`npm run build:dev`): also allows `http://localhost`, seeds
  the allow list with the local test pages and accepts an
  `http://localhost:<port>` API URL. The release build does neither (checked
  by tests and by `npm run package`).
- **Local test pages** (`npm run serve:test-pages`) and a **mock API**
  (`npm run mock-api`) let you run the whole flow without the real API – see
  [docs/manual-tests.md](docs/manual-tests.md).
- **Sample PDFs** are generated by `npm run fixtures`.
- **Probing the real API** (developer only, needs your APP-ID; the APP-ID,
  texts and secret values are never printed):

  ```powershell
  $env:PSS_APP_ID = "<your APP-ID>"
  node scripts/probe-api.mjs
  ```

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
