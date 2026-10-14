# PDF Secret Scanner – Design & Implementation Plan

A Chrome extension (Manifest V3) that notices when the user adds a PDF to a
website on the user's allow list, extracts its text, sends the text to the Prompt Security API, and shows
a notification if secrets are found or if the scan could not be completed.

Status: **design approved – ready for implementation (step 0)**

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Version control | **Git**, hosted on **GitHub**; small, logically coherent commits (see §10) |
| Language | **TypeScript**, compiled with **esbuild**; unit tests with **Vitest** |
| PDF text extraction | **pdf.js** (`pdfjs-dist`) |
| On secret found | **Alert only** (notification, §7). The upload is **not** blocked. *Requirement – not open for change.* |
| On API / scan failure | Informative alert stating what failed |
| Scope | **Allow list:** the scanner runs only on sites the user adds (§3.1). Empty by default – nothing is scanned until sites are added. Limits exposure of document text to the vendor. |
| Upload detection | **Hand-off hooks**: wrap the browser APIs through which a page obtains a `File` (§3). Event-listener safety net: future option, not in v1. |
| Alerts | **Chrome system notifications only** – one place that works whether the page is still open, the upload was in an iframe, or the tab is gone (§7) |
| What triggers a scan | A PDF **handed to the page** (the page's JavaScript obtained the `File`), not a network upload |
| Threat model | Protects the user from **accidental** leaks; does not defend against a site deliberately evading the extension (§8) |
| API size limit | The API **silently stops scanning** somewhere between 128k and 256k characters (HTTP 200, no error) – measured in step 1 (§5). Chunks default to **32,000 characters** (max 50,000); bounded automatic shrinking if the API reports fewer characters than sent (§4.2) |
| Very large text | Scan the first `maxTextChars` and warn "partially scanned" (§4.2) |
| Where pdf.js runs | **Offscreen document** (not the service worker, not the content script) – see §13 |
| Offscreen lifecycle | v1: **always present** while the extension runs; lazy creation + idle close is a later step (step 10) |
| Concurrency | Must be **resilient to concurrent uploads** (multi-file, multi-tab) – see §4.1 |
| Offscreen responsibility | **Whole scan pipeline** in the offscreen document; content script talks to it directly; service worker never on the scan path – see §2, §13 |

**Consequence of "alert, don't block":** the extension only *observes* upload
events, it never stops or re-dispatches them. Sites keep working exactly as
before. The alert may appear after the upload has finished; its purpose is to
tell the user to remove the file / rotate the secret.

---

## 2. Architecture

**Principle: the service worker is never on the scan path.** Chrome may stop the
service worker at any time and we don't control that, so everything that
matters for a scan runs in the **offscreen document**, whose lifetime we
control. The service worker only (re)creates the offscreen document, bridges
settings to it, and displays notifications – each a single short event that
wakes it if needed; it never holds scan state, so if it is stopped mid-scan,
nothing is lost.

```
 Web page (allow-listed site)
 ┌────────────────────────────────────────────┐
 │ hand-off hooks (MAIN world)                │
 │  • wrap .files / getAsFile / getFile / …   │
 │  • WeakSet de-dup, forward File objects    │
 └───────┬────────────────────────────────────┘
         │ MessageChannel (File objects)
         ▼
 ┌────────────────────────────────────────────┐
 │ content script (isolated world)            │
 │  • PDF check (%PDF- magic bytes), size cap │
 │  • batching, port to offscreen             │
 └───────┬────────────────────────────────────┘
         │ port per batch (direct)
         │ SCAN_REQUEST {scanId, batchId, fileName, size, base64 | skipped}
         ▼
 ┌────────────────────────────────────────────┐
 │ offscreen document  – owns ALL scan work   │
 │  • job registry, limits, queues (§4.1)     │
 │  • pdf.js + one shared pdf.js worker       │
 │  • chunker → API client → parser →         │
 │    aggregator                              │
 │  • settings cache (from service worker)    │
 └───────┬───────────────────────────▲──┬─────┘
         │ fetch POST                │  │ SHOW_RESULT (one per batch)
         ▼                           │  ▼
 eu.prompt.security/api/protect      │ OFFSCREEN_READY → settings
                                     │ SETTINGS_UPDATED (push)
 ┌────────────────────────────────────────────┐
 │ service worker – NOT on the scan path      │
 │  • creates offscreen doc: onInstalled,     │
 │    onStartup, ENSURE_OFFSCREEN (single-    │
 │    flight)                                 │
 │  • settings bridge: chrome.storage →       │
 │    offscreen (reply to READY, push on      │
 │    storage.onChanged)                      │
 │  • shows chrome.notifications (display     │
 │    only; click → options page if needed)   │
 └────────────────────────────────────────────┘
                     │
                     ▼
        OS notification (Windows / macOS / Linux)
```

### Responsibilities

| Context | Does | Lifetime |
|---|---|---|
| Hand-off hooks (MAIN world) | Notice every `File` the page obtains; forward it to the content script | Tab/frame |
| Content script (isolated world) | Filter PDFs, read file bytes, open a port to the offscreen document. **No UI.** | Tab/frame |
| Offscreen document | Everything in a scan: jobs, limits, extraction, chunking, API calls, parsing, aggregation, masking | We control it (v1: always open) |
| Service worker | Create/re-create the offscreen document; pass settings to it; show notifications | Chrome controls it – may stop any time |
| Options page | Edit settings in `chrome.storage.local` | While open |

### Message flows

1. **Startup:** `runtime.onInstalled` / `onStartup` → service worker creates the
   offscreen document.
2. **Settings handshake:** offscreen document loads → sends `OFFSCREEN_READY` →
   service worker (woken by the message if it was stopped) replies with the
   settings. Jobs that arrive earlier wait for this. On
   `chrome.storage.onChanged` (which also wakes the service worker) it pushes
   `SETTINGS_UPDATED`.
3. **Scan:** content script → `chrome.runtime.connect({name: 'scan-batch'})`.
   Only the offscreen document listens for these ports; it reads `tabId`,
   `frameId` and the site's origin from `port.sender` and runs the jobs. After
   the last file the content script sends `BATCH_END { fileCount }`, so the
   offscreen document knows when the batch is complete. The offscreen document
   answers on the same port with `BATCH_ACCEPTED` (all files received) and,
   when every job has ended, `BATCH_DONE`, then closes the port (D35). Neither
   carries results.
4. **Result:** when all jobs of a batch end, the offscreen document sends one
   `SHOW_RESULT` message (masked findings only) to the service worker (woken
   by it if stopped), which calls `chrome.notifications.create`. The result
   never travels back to the page.
5. **Self-healing:** if the port closes before `BATCH_ACCEPTED` (e.g. no
   offscreen document: "Receiving end does not exist"), the files never
   arrived: the content script sends `ENSURE_OFFSCREEN` to the service worker,
   waits for the reply, and resends the batch once. If that fails too, or the
   port closes after `BATCH_ACCEPTED` but before `BATCH_DONE` (offscreen
   document died mid-scan), the content script sends `SCAN_INTERRUPTED` to the
   service worker → failure notification. No matching of Chrome's error text.

**Verified in step 2 (2026-10-14, Chrome on Windows, `docs/manual-tests.md`
checks 2.3–2.7):** (a) content-script ports reach the offscreen document's
`runtime.onConnect` **directly** – the service worker is not involved; after
the offscreen document was closed, `ENSURE_OFFSCREEN` re-created it and the
resent batch completed. (b) Extension messaging **still JSON-serialises**
payloads: a `Uint8Array` arrives as `{"0":1,"1":2,"2":3}` and an `ArrayBuffer`
as `{}` – bytes therefore keep travelling as base64. The planned fallback
(service worker relaying scan messages) is not needed.

Notifications are shown by the service worker because the offscreen document
can only use `chrome.runtime`. This is display only: one short event per
batch, after the scan is complete.

### Why this split

- pdf.js needs a Web Worker – available in the offscreen document, not in the
  service worker.
- The offscreen document doesn't get stopped by Chrome; the service worker can.
  With the service worker off the scan path, its termination cannot interrupt
  or lose a scan.
- All concurrency state (jobs, queues, limits) lives in **one** context – no
  cross-context coordination.
- The offscreen document only has `chrome.runtime`, so it can't read
  `chrome.storage`; settings come via the handshake + push above.
- The APP-ID lives in the offscreen document's memory and in
  `chrome.storage.local` – never in a web page.

Why bytes travel as **base64**: runtime messaging JSON-serialises its payload
(ArrayBuffers don't survive). With the 25 MB file cap, base64 (~33 MB) stays
under Chrome's 64 MB message limit. Going directly content script → offscreen
means one hop, one copy.

Offscreen lifecycle (v1): always present while the extension runs (ensured on
install, browser start and every service-worker start – e.g. after the
extension is re-enabled – and re-created on demand by step 5 of the flows). Lazy creation and
closing after an idle timeout are added in step 10.

Rejected alternatives (see §13): all-in-service-worker, pdf.js in the content
script, extraction-only offscreen document.

---

## 3. Upload detection

### Principle: catch the hand-off, not the event

However a file reaches a website – file picker, hidden input, shadow DOM, drag
& drop, paste, folder drop, File System Access API – the page's JavaScript must
obtain the `File` object through one of a few browser APIs. We wrap those APIs
on their prototypes, so we see **every file handed to the page**, regardless of
UI framework or how the picker was opened.

What we detect is "the page received the file", not "the file was sent over
the network". Once the page's JavaScript holds the file it can upload it at any
time, so this is the right moment to check. If the user selects a PDF and then
cancels, it is still scanned. Alerts are worded accordingly ("You added
*file.pdf* to this site…").

### 3.1 Site allow list

The scanner runs **only on sites the user has added**. This limits which
documents are ever sent to the vendor.

**Mechanism – dynamic content scripts + optional permissions**
- The manifest declares **no static `content_scripts`** and no host access to
  websites. Sites are `optional_host_permissions` (`*://*/*`); the `scripting`
  permission is used to register scripts.
- **Options page** (user gesture) – only edits the list and permissions:
  1. normalise the input (`mail.google.com` → `*://mail.google.com/*`;
     `*.slack.com` → `*://*.slack.com/*`); reject anything else
  2. `chrome.permissions.request({ origins: [pattern] })` – Chrome asks the user
     for **that site only**; on grant, save the updated `allowedSites`
  3. removing a site: save the updated list, then `chrome.permissions.remove`
- **Service worker – single owner of script registration.** One idempotent
  `reconcile()` computes the sites that are both in `allowedSites` **and**
  granted, and calls `chrome.scripting.registerContentScripts` /
  `updateContentScripts` / `unregisterContentScripts` for the MAIN-world hooks
  and the isolated content script with those `matches`, `runAt:
  document_start`, `allFrames: true`, `matchOriginAsFallback: true`,
  `persistAcrossSessions: true`. Triggers: `runtime.onInstalled`,
  `runtime.onStartup`, `storage.onChanged` (`allowedSites`),
  `permissions.onAdded`, `permissions.onRemoved` (e.g. revoked in
  `chrome://extensions`). Configuration-time only – not on the scan path.

**Behaviour to know (documented in the README)**
- Matching is per **frame URL**: an upload widget in a cross-origin iframe is
  scanned only if the iframe's site is also on the list. `about:blank` /
  `srcdoc` frames inherit their parent's origin (`matchOriginAsFallback`).
- Tabs already open when a site is added must be **reloaded** before scanning
  starts there (the options page says so).
- Empty list = nothing scanned. On install the options page opens so the user
  can set the APP-ID and add sites.

**Benefit:** Chrome's install warning no longer says "read and change all your
data on all websites"; the user grants access per site.

**Development build** (`npm run build:dev`): the generated manifest adds
`http://localhost/*` to `host_permissions` and the allow list is pre-filled
with it, so `test-pages/` (served by `npm run serve:test-pages`) work without
the options flow. The release build (`npm run build`) contains neither; the
manifest test checks both builds.

### Hooked APIs (MAIN-world script)

| Wrapped API | File sources covered |
|---|---|
| `HTMLInputElement.prototype.files` (getter) | File inputs – in the DOM, detached (`createElement('input').click()`), inside open or closed shadow roots, opened via label or `showPicker()`; `webkitdirectory` folder pickers |
| `DataTransfer.prototype.files` (getter) | Drag & drop, paste (`clipboardData`) |
| `DataTransferItem.prototype.getAsFile` | Drag & drop / paste via `dataTransfer.items` |
| `FileSystemFileEntry.prototype.file` | Folder drops (`webkitGetAsEntry()` → entries) |
| `FileSystemFileHandle.prototype.getFile` | File System Access API (`showOpenFilePicker()`, drag-and-drop handles) |

Wrapper rules:
- Call the original, **return exactly its result**, never throw (all our logic
  in `try/catch`), never change timing (forwarding is fire-and-forget).
- Registered for allow-listed sites (§3.1), injected at `document_start` in
  every matching frame (`allFrames`, `matchOriginAsFallback`), before page
  scripts run.
- **De-duplication:** a `WeakSet` of `File` objects already forwarded. Pages
  (e.g. React) read `.files` many times; each `File` object is forwarded once.
  Re-selecting the same file creates a new `File` object and is scanned again.
- Keep the MAIN-world code minimal: no parsing, no reading of bytes.

### MAIN world ↔ content script channel

Content scripts in the MAIN world share the page's JavaScript context and have
no `chrome.*` APIs, so the hooks forward files to the isolated-world content
script over a `MessageChannel`:
- At `document_start` the isolated content script creates a `MessageChannel`
  and posts one port to the window with a marker message; the MAIN-world script
  takes it. Files detected before the port arrives are buffered.
- `File` objects are structured-cloned across the port (cheap – the data is not
  copied).
- Per the threat model (§8) a page could observe or use this channel; the worst
  it can do is make us scan a file it supplies.

### Content script (isolated world)

For each forwarded file:
1. **PDF check** – first 5 bytes are `%PDF-` (MIME type / extension are only hints).
2. **Size check** – larger than `maxFileSizeMB` → still sent in the batch, but
   as name + size only (no bytes, `skipped: 'FILE_TOO_LARGE'`), so the
   offscreen document reports it in the batch's notification (the content
   script has no UI).
3. **Batching** – files forwarded within the same task / 300 ms window form a
   batch (`batchId`), e.g. a multi-select or multi-file drop.
4. Read bytes, open a port to the offscreen document, send the jobs (§2).

### Future option (not in v1): event-listener safety net

Capture-phase `change` / `drop` / `paste` listeners in the isolated world,
independent of the MAIN-world hooks, as a fallback if a site breaks or bypasses
the hooks. Decided to leave it out of v1 and reassess after real-site testing
(step 8). If added, both layers feed one de-duplication keyed on
name + size + lastModified + hash of the first bytes.

### Remaining gaps

- Files created entirely by page code (e.g. `new File([...])` from generated
  data) – not user uploads, out of scope.
- A site that deliberately bypasses the hooks (e.g. pristine prototypes from a
  fresh iframe) – out of scope per the threat model.

---

## 4. Scan pipeline (offscreen document)

1. **Extract** – load PDF with pdf.js, get text per page (`page → string`).
   - Encrypted PDF (`PasswordException`) → error `PDF_ENCRYPTED`.
   - No text at all (scanned/image PDF) → error `NO_TEXT_LAYER` (OCR is out of scope).
2. **Chunk** – see §4.2.
3. **Call API** – one POST per chunk, at most `maxConcurrency` in flight,
   `requestTimeoutMs` per request, `retries` with exponential backoff on
   network errors / HTTP 429 / 5xx; "too large" responses → bounded split (§4.2).
4. **Parse** – see §5.
5. **Aggregate** – de-duplicate findings (same `entity_type` + entity, e.g. from
   overlapping chunks), locate each entity in the page texts to report page
   numbers (if the API's entity text can't be found verbatim, the finding is
   kept without page numbers), mask entity values.

### Result model

```ts
type ScanResult = {
  scanId: string;
  batchId: string;
  status: 'clean' | 'secrets' | 'error';
  fileName: string;
  findings: Array<{
    entityType: string;   // "AWS credentials"
    category: string;     // "Access Tokens"
    masked: string;       // "AKIA…B1" (first 4 + last 2, §8)
    pages: number[];      // [3]; empty if the entity text can't be located
  }>;
  errors: Array<{ code: ErrorCode; detail?: string }>;   // text comes from _locales by code
  stats?: { pages: number; chunks: number; failedChunks: number;   // absent if never scanned
           textChars: number; scannedChars: number; truncated: boolean; ms: number };
};

type ErrorCode =
  | 'NOT_CONFIGURED' | 'FILE_TOO_LARGE' | 'PDF_ENCRYPTED' | 'PDF_INVALID'
  | 'NO_TEXT_LAYER' | 'API_UNREACHABLE' | 'API_TIMEOUT' | 'API_HTTP_ERROR'
  | 'API_BAD_RESPONSE' | 'API_UNAUTHORIZED' | 'SCAN_INTERRUPTED' | 'SCAN_TIMEOUT'
  | 'TEXT_TRUNCATED' | 'CHUNK_TOO_LARGE' | 'QUEUE_FULL';
```

Status rules:
- Any secret found → `secrets` (alert also mentions "N of M parts could not be
  scanned" if some chunks failed, and "only the first X characters were
  scanned" if truncated).
- No secrets, every chunk scanned, not truncated → `clean` (no notification).
- No secrets and (≥1 chunk failed, or truncated, or extraction failed) →
  `error` – a clean result is never claimed for text we did not check.

### 4.1 Concurrency & resilience

Scenarios that must work: several PDFs in one action (multi-select, multi-file
drop); uploads in several tabs/frames at the same time; the same file reported
twice; a tab closed or navigated mid-scan; the service worker or offscreen
document restarted mid-scan; one bad PDF among good ones.

**Jobs.** Every file becomes a job:
`{ scanId (UUID), batchId, tabId, frameId, fileName, size, state }` with states
`queued → extracting → scanning → done | failed` (a timeout is a failure). Files from one
user action share a `batchId`. A job registry in the scan coordinator tracks
all jobs (it lives in the offscreen document); each job is isolated – an exception in one never affects another.

**Limits (all global, across every tab):**

| Limit | Default | Protects against |
|---|---|---|
| `maxConcurrency` – API calls in flight | 4 | API rate limiting; 5 files × 4 ≠ 20 calls |
| `maxParallelExtractions` – PDFs parsed at once | 2 | CPU and memory spikes |
| `maxInFlightMB` – total size of jobs being processed | 60 MB | CPU/memory of parsing many large files at once; extra jobs wait in a FIFO queue |
| `maxQueuedMB` – total size of files received and not yet finished (processing + waiting) | 200 MB | Memory: bytes arrive with the request (they must, so scans survive the page closing – D17), so the queue itself needs a cap. Files above it are not scanned → `QUEUE_FULL` in the batch notification |
| `jobTimeoutMs` – max time per job | 120 s | Stuck jobs; ends with `SCAN_TIMEOUT` |

**Scheduling.** One semaphore for API calls shared by all jobs; chunks are
taken **round-robin across jobs**, so a 300-page PDF does not starve a 1-page
PDF uploaded a moment later. pdf.js uses **one shared PDFWorker**; each loading
task is destroyed when its job ends, freeing memory.

**Offscreen single-flight (service worker).** `ensureOffscreen()` checks
`chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})` and keeps
the in-flight creation promise, so concurrent callers share one creation; an
"already exists" error is treated as success.

**Lifetime tracking with ports.** The content script opens a
`chrome.runtime.connect` port per batch, directly to the offscreen document:
- Page closed / navigated → port disconnects → **the scan continues**. All file
  data was already sent, and the notification doesn't need the page. This
  covers "upload and leave" (form submit, tab closed), where cancelling would
  silently drop a positive result.
- Offscreen document crashed / reloaded → port disconnects on the page side →
  content script sends `SCAN_INTERRUPTED` to the service worker → failure
  notification for unfinished files. (If the page is also gone at that moment,
  the interruption cannot be reported – accepted edge case.)
- Service worker stopped → **no effect** on running scans.
- Jobs end early only through `jobTimeoutMs` (`AbortController` for
  fetches, `loadingTask.destroy()` for pdf.js).

**Batched notification.** The offscreen document groups results by `batchId`
and sends one `SHOW_RESULT` per batch when all its jobs end ("2 of 3 files
contain secrets").

**Tests (deterministic, fake timers + mocked fetch):** WeakSet de-duplication of repeated `.files` reads; N jobs × M chunks never
exceed `maxConcurrency`; round-robin fairness; concurrent `ensureOffscreen()`
creates exactly one document; connect-fail → `ENSURE_OFFSCREEN` → retry; a timed-out job leaves others intact; a page disconnect does not stop the scan; admission
control queues jobs above `maxInFlightMB` and rejects above `maxQueuedMB`; job timeout; port disconnect in both
directions.

### 4.2 Chunking

**Input:** the text of all pages joined with `\n`, plus a table of page start
offsets (binary search maps any offset back to a page number). Chunking across
pages avoids many tiny calls for short pages.

**Truncation:** if the joined text is longer than `maxTextChars`, only the
first `maxTextChars` characters are scanned; the result carries
`TEXT_TRUNCATED` and the alert says "partially scanned – only the first X of Y
characters were checked".

**Where a chunk may end** (best first, searching backwards from `chunkSize`):
1. a blank line (paragraph break)
2. a line break
3. any whitespace

Never inside a run of non-whitespace characters (a token, i.e. where a secret
would be), and **never inside a PEM block** (`-----BEGIN …-----` …
`-----END …-----`, found by regex before chunking and treated as unbreakable).
Only an unbroken span longer than `chunkSize` (e.g. a huge base64 blob or an
oversized PEM block) is cut by force, at `chunkSize`.

**Overlap:** each chunk starts `chunkOverlap` (200) characters before the
previous chunk's end, snapped to a whitespace boundary. Its purpose is
**context** – keeping a label ("password:") with its value on the next line –
not covering long secrets, which are never split by rule above.

**Size accounting:** `chunkSize` counts code points (surrogate pairs are never
split). Each request is also checked against `maxRequestBytes` (UTF-8 size of
the JSON body); a chunk over it is split before sending. This keeps Hebrew and
other multi-byte text safe.

**Bounded automatic shrinking** (the API never reports "too large" – §5):
- A chunk counts as **cut short** if the response's
  `Token Limitation[0].characters` is smaller than the number of characters we
  sent, or the API answers HTTP 413. A cut-short chunk is split in half at the
  best boundary and both halves are retried.
- The **effective chunk size** for the rest of the session becomes the smaller
  size, so later chunks don't fail the same way. It resets to `chunkSize` when
  settings change or the offscreen document restarts.
- **It only ever shrinks – never grows** beyond the configured `chunkSize`.
- **Floor:** never below `MIN_CHUNK_CHARS` (500). A chunk that is still rejected
  at the floor fails with `CHUNK_TOO_LARGE` (counted in `failedChunks`).
- Splitting depth is therefore bounded (≤ log₂(`chunkSize` / 500) levels),
  and each split counts against the job's API calls and `jobTimeoutMs`.
- `chunkSize` set in options is validated to 500 … 50,000
  (`MAX_CHUNK_CHARS`) – well below the size where the API stops scanning.
- **Empty or whitespace-only chunks are never sent** (the API returns
  `result.prompt: null` for them).

**Telemetry:** `Token Limitation[0].chunks_required > 1` in a response → console
warning (our chunk is larger than the server prefers) – used for tuning.

**Defaults (from the step-1 probe, §5):** `chunkSize` **32,000** characters –
4× below the largest English size proven to be scanned completely (128k);
`maxRequestBytes` **64 KB** – keeps Hebrew chunks (≈ 2 bytes per character)
at ≈ 35k characters, below the 64k proven for Hebrew.

---

## 5. API contract (as observed 2026-10-13)

Request:
```
POST https://eu.prompt.security/api/protect
APP-ID: <app id>
Content-Type: application/json

{"prompt": "<text to inspect>"}
```

Response: **HTTP 200** for both clean and dirty text; the verdict is in the body.
Full samples are in `tests/fixtures/`.

```jsonc
{
  "status": "success",
  "result": {
    "action": "block",                      // "log" when clean – depends on server policy
    "prompt": {
      "passed": false,
      "violations": ["Secrets"],
      "findings": {
        "Secrets": [
          { "category": "Access Tokens",
            "entity": "AKIAIOSFODNN7EXAMPLE",   // the secret itself, in plain text
            "entity_type": "AWS credentials",
            "sanitized_entity": null }
        ],
        "Token Limitation": [ { "characters": 34, "tokens": 12,
                                "tokens_limit": 0, "chunks_required": 1 } ]
      },
      "protection_actions": { "Secrets": "block", "Sensitive Data": "log", ... }
    }
  }
}
```

Parsing rules:
- **Secret detected ⇔ `result.prompt.findings.Secrets` is a non-empty array.**
  We deliberately do *not* rely on `action`/`passed`, because those reflect the
  server-side policy (e.g. "Sensitive Data" could also cause a block, or Secrets
  could be switched to "log").
- `status !== "success"` or missing `result.prompt` → `API_BAD_RESPONSE`.
- `Token Limitation[0].chunks_required > 1` → log a warning (our chunk is larger
  than the server prefers); useful for tuning the default.
- Other finding groups (e.g. "Sensitive Data") are ignored in v1.

### Probing results (2026-10-14, `scripts/probe-api.mjs`)

Raw output (no secrets): `tests/fixtures/probe-2026-10-14.txt`.

**Size – the API silently stops scanning long texts.** A fake AWS key placed
at the end of the text:

| Text | Key found | `characters` reported |
|---|---|---|
| ASCII 4k – 128k | yes | full length |
| ASCII 256k | **no** (HTTP 200, `passed: true`) | full length (255,967) |
| ASCII 512k, 1M | **no** | capped at **262,144** (2¹⁸) |
| Hebrew 4k – 64k | yes | full length |
| Hebrew 256k | **no** | full length |

No error is ever returned for size. Consequences: chunks far below 128k
(§4.2); "cut short" detected by comparing `characters` with what we sent.

**Detection with random fake values:** AWS key → `Secrets` ("AWS credentials",
"Access Tokens"). GitHub token, JWT and PEM private key → **not** detected
(GitHub tokens carry a checksum, so random ones are likely rejected as fake;
JWT/PEM may also be validated). Vendor detection quality is out of scope (§15);
realistic but inactive keys can be tried in step 8.

**Other detectors confirm D15:** PII-only text → `action: "block"`,
`violations: ["Sensitive Data"]`, no `Secrets`. URL-only text → finding group
"URLs Detector", `action: "log"`.

**Errors:**

| Case | Response |
|---|---|
| Invalid or missing APP-ID | **401** `{"message":"Unauthorized"}` → `API_UNAUTHORIZED` |
| Malformed JSON body | **400** `{"error": "Body is not valid JSON…", "statusCode": 400}` |
| Wrong field name | **200** `{"status":"failed","reason":"Validation error: …","result":null}` → `API_BAD_RESPONSE` |
| Empty prompt | **200** `status: "success"` with `result.prompt: null` → never sent (§4.2) |

**Latency and rate limiting:** English ≈ 100–350 ms per request regardless of
size; Hebrew ≈ 750–1,100 ms. 20 concurrent requests: all 200, median 253 ms –
no rate limiting observed (`maxConcurrency` stays 4).

---

## 6. Settings (options page, `chrome.storage.local`)

| Key | Default | Notes |
|---|---|---|
| `allowedSites` | `[]` (empty) | Site patterns the scanner runs on (§3.1); each needs the user's permission grant |
| `apiUrl` | `https://eu.prompt.security/api/protect` | Region-specific; must be `https://` on a host in `host_permissions` |
| `appId` | *(empty)* | Required. Never hard-coded, never committed. |
| `chunkSize` | 32,000 chars | Allowed 500–50,000 (§4.2, §5) |
| `chunkOverlap` | 200 chars | Context between chunks (secrets are never split) |
| `maxRequestBytes` | 64 KB | UTF-8 size of a request body (§4.2, §5) |
| `maxTextChars` | 2,000,000 | Beyond this: partial scan + warning |
| `maxConcurrency` | 4 | Global – API calls in flight across all scans |
| `maxParallelExtractions` | 2 | PDFs parsed at the same time |
| `maxInFlightMB` | 60 | Total size of jobs being processed; more jobs wait |
| `maxQueuedMB` | 200 | Total size received and not finished; above it → `QUEUE_FULL` |
| `jobTimeoutMs` | 120000 | Per file, end to end |
| `requestTimeoutMs` | 15000 | |
| `retries` | 2 | Exponential backoff |
| `maxFileSizeMB` | 25 | Allowed 1–45: files travel base64-encoded in one message (64 MB limit) |
| `offscreenIdleTimeoutSec` | 60 | Added in step 10 only |

All defaults are documented in the README (see §14 for everything the README
must contain).

---

## 7. Alerts (Chrome system notifications)

**One place for every case:** all alerts are `chrome.notifications`, shown by the
service worker. This works the same whether the page is still open, the upload
happened in a small iframe, the page navigated after a form submit, or the tab
was closed. No UI is injected into web pages.

One notification per **batch** (user action). `requireInteraction: true` for
secrets and failures, so it stays until the user dismisses it (where the OS
supports it).

| Case | Title | Message |
|---|---|---|
| Secrets found | "Secrets found in file.pdf" (or "2 of 3 files contain secrets") | "You added it to example.com. AWS credentials (p. 3) AKIA…B1, GitHub token (p. 5) ghp_…9x. Remove the file and rotate the credentials." – max 3 findings listed, then "+N more" |
| Scan failed / partial | "Couldn't fully scan file.pdf" | Reason per `ErrorCode`, e.g. "The scanning service could not be reached – the file was not checked." / "Only the first 2,000,000 characters were checked." |
| Not configured | "PDF Secret Scanner isn't set up" | "Click to add your APP-ID." – click opens the options page |
| APP-ID rejected (`API_UNAUTHORIZED`) | "Couldn't scan file.pdf" | "Your APP-ID was rejected – check the extension settings." – click opens the options page |
| Clean | – | No notification |

Notes:
- Notification text is short by nature (the OS truncates long messages), hence
  the compact format and the 3-finding limit.
- All strings live in `_locales/en/messages.json` (`chrome.i18n`,
  `default_locale: "en"` in the manifest) from the start, so other languages (e.g. Hebrew) can be added without code changes.
- **OS settings matter:** if the user has disabled notifications for Chrome or
  enabled Focus Assist / Do Not Disturb, notifications may be hidden. Two
  levels:
  - *Blocked in Chrome* (for this extension) – detectable:
    `chrome.notifications.getPermissionLevel()` is `"denied"`. The options page
    shows a warning, and the service worker logs it at start-up and on
    `onPermissionLevelChanged` (step 3.5).
  - *Blocked by the operating system* – **not detectable**: Chrome hands the
    notification to the OS and `create()` succeeds. Seen in step 2 on Windows.
    The README lists enabled Chrome notifications as a requirement.
  - Future option: a toolbar badge ("!" on the extension icon) when blocked in
    Chrome – the only alert visible without opening anything.
- No "scanning…" indicator in v1.

---

## 8. Security & privacy

**Threat model.** The extension protects the user from **accidentally**
exposing secrets by giving a PDF to a website. The website is not treated as an
adversary: a site that deliberately evades detection (restoring original
prototypes, spoofing or intercepting the MAIN-world channel) is out of scope.
The worst a hostile page can do to the extension is trigger scans of files it
supplies or suppress its own detection; it can never read the APP-ID, scan
results, or notification contents (no UI or result is ever injected into the
page).

**Data leaving the machine**
- Only PDFs handed to **allow-listed sites** are scanned (§3.1) – the user
  decides which sites' documents may reach the vendor.
- The full text of every PDF handed to an allow-listed site is sent to the Prompt Security
  API (EU endpoint) – by design. This includes PDFs the user selected and then
  cancelled (D9). Vendor-side retention/logging is unknown (responses carry
  `action: "log"` and a `conversation_id`) – stated in the README.
- **Incognito is not supported** in this version: `"incognito": "not_allowed"`
  in the manifest, stated in the README.
- No analytics or telemetry of our own.

**The APP-ID**
- Stored in `chrome.storage.local` – unencrypted on disk in the Chrome profile
  (accepted, documented). Entered in a password field on the options page.
- Never in the repository, never in a web page, never in logs.
- Enterprise deployment via `chrome.storage.managed` is not supported in this
  version (future option).

**Secrets passing through the extension**
- Secret values (returned in plain text by the API) and PDF text live **only in
  the offscreen document's memory** and are dropped when the job ends. Never
  stored, never shown unmasked. Mask = first 4 + `…` + last 2 (`AKIA…B1`);
  values shorter than 12 characters are shown as `••••••` (notifications may
  persist in OS history). Receivers accept only these two forms
  (`isMaskedValue`), so an unmasked value can never reach a notification.
- **Logging rule:** a single `safeLogger` is the only way to log. It never
  outputs PDF text, request/response bodies, secret values or the APP-ID – also
  not in debug builds. API error bodies are never shown raw (they may echo our
  text). A unit test asserts redaction.

**pdf.js parses untrusted files with extension privileges**
- `isEvalSupported: false`; keep the MV3 default CSP (no `unsafe-eval`, no
  remote code).
- pdf.js version pinned in `package-lock.json`; `npm audit` runs in the build;
  Dependabot enabled on GitHub. (Reference: CVE-2024-4367, code execution via
  crafted fonts in older pdf.js.)

**Message validation**
- Offscreen document accepts only ports named `scan-batch` from content
  scripts (`sender.tab` set); every field is type- and size-checked.
- Service worker accepts `SHOW_RESULT` and `OFFSCREEN_READY` only from the
  offscreen document's URL;
  `ENSURE_OFFSCREEN` / `SCAN_INTERRUPTED` only from content scripts.
- No `externally_connectable` – web pages cannot message the extension.
- Data from the MAIN world is untrusted input: must be a `File`, size-checked,
  magic-byte-checked.
- File names are page-controlled: in notifications they are truncated to 60
  characters with control and bidi characters stripped; the site shown is
  always the origin from `port.sender`, never a page-supplied value.

**Known, not handled in this version**
- A hostile page can flood the extension with files (API quota, CPU,
  notification spam) – no per-tab rate limit yet; global limits (§4.1) only
  bound concurrency. Documented in the README.

**Permissions:** `storage`, `offscreen`, `notifications`, `scripting`;
`host_permissions`: `https://eu.prompt.security/*`;
`optional_host_permissions`: `*://*/*`, granted **per site** when the user adds
it to the allow list (§3.1). No install-time access to websites. One runtime
dependency (pdf.js), committed lockfile, no remotely loaded code.

**Minimum Chrome version:** `minimum_chrome_version` in the manifest (expected
120; exact value confirmed in step 0) – needed for the offscreen API (109),
`runtime.getContexts` (116) and registered MAIN-world content scripts with
`matchOriginAsFallback`.

**API URL:** accepted only if it is `https://` and its host is covered by
`host_permissions`; anything else is rejected on the options page.
**Development builds only** also accept `http://localhost:<port>` so the local
mock API can be used; the release build rejects it (covered by tests).

---

## 9. Project layout

```
TM_Chrome_ext/                     ← Git repository root (GitHub remote: origin)
├─ .git/
├─ .gitignore                      node_modules/, dist/, *.zip, coverage/, .env*, OS/editor junk
├─ .gitattributes                  * text=auto eol=lf  (consistent line endings on Windows)
├─ manifest.json
├─ _locales/en/messages.json
├─ icons/          icon-16/32/48/128.png (toolbar, extensions page, notifications)
├─ .github/        dependabot.yml, workflows/ci.yml
├─ package.json, package-lock.json, tsconfig.json, vitest.config.ts
├─ build.ts                        esbuild build script (Node runs TypeScript directly)
├─ src/
│  ├─ main-world/   handoff-hooks.ts            (wrapped APIs, WeakSet, channel)
│  ├─ content/      bridge.ts, batcher.ts, index.ts, encode.ts, scan-sender.ts
│  ├─ background/   service-worker.ts, offscreen-manager.ts, settings-bridge.ts, script-registry.ts,
│  │                notifications.ts
│  ├─ offscreen/    offscreen.html, offscreen.ts, settings-client.ts, batch-receiver.ts, results.ts
│  ├─ scanner/      extract.ts, chunker.ts, api-client.ts, parse.ts, aggregate.ts, mask.ts
│  ├─ options/      options.html, options.ts, form.ts
│  └─ shared/       settings.ts, messages.ts, types.ts, safe-logger.ts, scan-port.ts
├─ tests/
│  ├─ fixtures/     api-*.json, sample PDFs
│  ├─ helpers/      chrome-fake.ts, port-pair.ts
│  ├─ unit/         *.test.ts        (Node)
│  └─ browser/      *.test.ts        (Vitest browser mode, Chromium)
├─ scripts/        manifest.ts, probe-api.mjs, make-fixtures.mjs, serve-test-pages.mjs, mock-api.mjs
├─ docs/           manual-tests.md
│  └─ agents/       one guide per component + protocol, testing, build (for AI agents)
├─ test-pages/      upload.html (input, detached input, shadow DOM, drop, paste,
│                   folder drop, showOpenFilePicker, multi-file)
├─ dist/            build output → "Load unpacked" from here   (git-ignored)
├─ AGENTS.md                       agent guide – master (index, global rules, commands)
├─ CLAUDE.md                       `@AGENTS.md` (Claude Code import)
├─ README.md
└─ DESIGN.md
```

Never committed: `node_modules/`, `dist/`, release zips, and anything containing
the APP-ID (it lives only in the browser's `chrome.storage`).

---

## 10. Version control (Git + GitHub)

- The project folder is a Git repository, pushed to a GitHub repository
  (`origin`, branch `main`).
- **Small, logically coherent commits.** Each commit does one thing (one
  feature, one module, the tests for it, one doc update) and leaves the project in a
  working state: `npm run build` and `npm test` pass at every commit.
- **Commit messages** follow Conventional Commits:
  `<type>(<scope>): <summary>` – types `feat`, `fix`, `test`, `docs`, `chore`,
  `build`, `ci`, `refactor`. Summary in imperative mood, ≤ 72 chars; body explains
  *why* when it is not obvious.
- **Implementation and tests are separate commits.** Every implementation
  commit (`feat`/`fix`) is immediately followed by a `test` commit that covers
  it; the next implementation commit starts only after that. The implementation
  commit must already build and keep existing tests green; the test commit adds
  the tests for the new code (and any fixtures it needs).
- Each `test` commit uses the cheapest level from §15 that proves the change
  (Node unit test → Vitest browser mode → fake `chrome.*` wiring test); it may
  also add a scenario to `test-pages/` and `docs/manual-tests.md`.
- `docs`, `chore`, `build` and `ci` commits don't need a test commit.
- **Each completed step is tagged** (`step-0` … `step-10`) and pushed, so any
  stage can be checked out and reviewed on its own.
- Work goes directly on `main` (single developer). Feature branches + pull
  requests can be introduced later if others join.
- Commits made by Claude carry a `Co-Authored-By` trailer.
- **Agent guide:** `AGENTS.md` + `docs/agents/*.md` hold only where-to-read /
  where-to-write facts and rules (no reasoning; rationale stays here). A commit
  that changes a component's paths, interfaces, settings or rules updates its
  agent guide in the same commit.

The planned commits for each step are listed in §11; the list may be refined
while implementing, but the granularity stays the same.

---

## 11. Implementation plan

**Ordering principles:** settle the unknowns first (API behaviour, messaging
architecture); build dependencies before the code that uses them; every step
leaves something runnable and manually checkable. **Each step is gated by the
developer's manual check** (the step's section of `docs/manual-tests.md`)
before it is tagged and pushed.

| # | Step | Content | Done when (incl. developer's manual check) |
|---|---|---|---|
| 0 | **Repository & tooling** | git, `.gitignore`/`.gitattributes`, npm, TypeScript, esbuild, Vitest (Node + browser mode, coverage), dev/release manifests, Dependabot + audit, GitHub Actions CI, README skeleton | CI green on GitHub; both builds load unpacked in Chrome without errors |
| 1 | **API probing** | Probe script; developer runs it; results recorded in §5; mock API mirroring the real behaviour (incl. the exact "too large" response) | §5 holds real data; chunk defaults set; mock API usable |
| 2 | **Walking skeleton** | Settings model (defaults + validation), safe logger, message types, offscreen document always present (single-flight), settings handshake, content-script registration (`reconcile()`, dev localhost seed), minimal content script sending any selected file **directly** to the offscreen document, which triggers a basic notification via the service worker | Selecting a file on the test page shows a notification; both architecture assumptions (§2: direct port, JSON serialisation) verified and recorded |
| 3 | **Options & allow list** | Options page (APP-ID, API URL incl. dev localhost exception, settings), allow-list editing with per-site permissions, `reconcile()` triggers on list/permission changes, warning when notifications are blocked | Real APP-ID configured and a site added through the UI; revoking in `chrome://extensions` stops scanning there |
| 4 | **Hand-off detection** | Five API hooks, MAIN ↔ content channel, WeakSet de-dup, PDF magic-byte filter, oversized files (name + size only), batching | Every source on the test page detected exactly once; non-PDFs ignored |
| 5 | **Extraction & job system** | pdf.js (`isEvalSupported:false`) + fixture generator + sample PDFs, encrypted/invalid/text-less errors, job registry, `maxParallelExtractions`, `maxInFlightMB`, `maxQueuedMB` (`QUEUE_FULL`), `jobTimeoutMs`, shared pdf.js worker | Correct text per page in tests (text never logged); many files at once stay within limits |
| 6 | **Scanning** | Chunker (safe boundaries, PEM, overlap, page map), truncation, response parser, API client + retries, bounded splitting, global round-robin limiter, aggregation + masking, end-to-end pipeline | A PDF with a key on the test page reports secrets against the mock **and** the real API |
| 7 | **Notifications** | All cases, one per batch, i18n catalogue, file-name sanitising, not-configured, `SCAN_INTERRUPTED`, partial / failed / `QUEUE_FULL` / too large | Every case in the manual checklist shows the right notification, incl. tab closed mid-scan |
| 8 | **Real-site testing** | Developer tests Gmail / Drive / Slack / WhatsApp Web / ChatGPT; fixes with regression tests; safety-net decision | Results and safety-net decision recorded in §13 |
| 9 | **Hardening & docs** | Edge cases, README complete per §14, release packaging | Every §14 item ticked; zip ready → `v1.0.0` |
| 10 | **Offscreen lifecycle** | Lazy creation (via connect-fail → `ENSURE_OFFSCREEN`), close after `offscreenIdleTimeoutSec` (offscreen reports idle, service worker closes it), measurements | No offscreen document while idle; startup cost and memory saving recorded → `v1.1.0` |

Sample PDFs: clean; one AWS key; secret on page 3 of 5; secret split across a
line break; several secret types; PEM private key; Hebrew text with a key;
encrypted; scanned image; ~20 MB. Generated by `scripts/make-fixtures.mjs`
with `pdf-lib` (dev dependency only); the encrypted and scanned-image samples
are created once and committed as binaries.

**Who tests what:** automated tests run in the build and CI (§15). Tests against
the real API (step 1, step 6) and real sites (step 8) are **run by the
developer on their machine** – the API is not reachable from Claude's
environment. `scripts/probe-api.mjs` reads the APP-ID from the environment
variable `PSS_APP_ID` (never committed), runs the probes (sizes 4k–64k ASCII
and Hebrew, invalid APP-ID, malformed body, burst for 429, PII-only / URL-only
texts) and prints a summary **without echoing secrets or the APP-ID**; the
output is pasted back and recorded in §5.

### Planned commits

`feat`/`fix` → `test` pairs share a number (a / b). Every commit builds and
passes all tests.

**Step 0 – repository & tooling**
1. `chore: initialize repository with .gitignore and .gitattributes`
2. `docs: add design document and observed API response fixtures`
3. `docs: add agent guide (AGENTS.md, CLAUDE.md, docs/agents/)`
4. `build: set up npm project with TypeScript, esbuild and Vitest (Node + browser mode, coverage thresholds)`
5. a. `feat: add Manifest V3 skeleton with dev and release builds`
   b. `test: verify both manifests – permissions, localhost only in dev, incognito, CSP, minimum Chrome version`
6. `chore: enable Dependabot and run npm audit in the build`
7. `ci: run type check, tests, coverage, audit and both builds on GitHub Actions`
8. `docs: add README skeleton (setup, build, load unpacked, testing, future options)`
→ create GitHub repo, `git push -u origin main`, tag `step-0`

**Step 1 – API probing**
1. `chore: add API probing script (APP-ID from env, no secrets in output)`
2. `docs: record API probing results and set chunk defaults` (after the developer runs the script)
3. `chore: add local mock API mirroring the observed behaviour`
→ tag `step-1`

**Step 2 – walking skeleton**
1. a. `feat(shared): add settings model with defaults and validation`
   b. `test(shared): cover defaults, validation and dev-only localhost API URL`
2. a. `feat(shared): add safe logger that never outputs sensitive data`
   b. `test(shared): logger redacts text, bodies, secrets and APP-ID`
3. a. `feat(shared): define typed messages between contexts`
   b. `test(shared): message validators accept valid and reject malformed messages`
4. a. `feat(background): keep offscreen document alive with single-flight creation`
   b. `test(background): add chrome.* fake; concurrent ensureOffscreen creates one document`
5. a. `feat: pass settings to offscreen document via ready handshake and push`
   b. `test: cover handshake, early jobs waiting and updates`
6. a. `feat(background): reconcile content-script registration with the allow list`
   b. `test(background): registers granted allow-listed sites only; idempotent; dev seed`
7. a. `feat(shared): add BATCH_ACCEPTED and BATCH_DONE replies on the scan port`
   b. `test(shared): reply validators accept valid and reject malformed replies`
8. a. `feat(content): send selected files directly to the offscreen document over a port`
   b. `test(content): cover port connect, self-healing ENSURE_OFFSCREEN retry and sender validation`
9. a. `feat: show a basic notification for each received batch`
   b. `test: offscreen → service worker SHOW_RESULT → notification`
10. `docs: record verification of direct ports and message serialisation; add test page, local server and manual checklist`
→ tag `step-2`

**Step 3 – options & allow list**
1. a. `feat(options): add options page for APP-ID, API URL and settings`
   b. `test(options): cover loading, validation errors and saving`
2. a. `feat(options): edit site allow list with per-site permission requests`
   b. `test(options): cover pattern normalisation, permission grant/deny and saved list`
3. a. `feat(background): trigger reconciliation on startup, list changes and permission changes`
   b. `test(background): cover revoke in chrome://extensions, restart and list edits`
4. a. `feat: open options page on install`
   b. `test: options page opens on first install only`
5. a. `feat: warn and log when notifications are blocked in Chrome`
   b. `test: cover permission-level warning and log`
→ tag `step-3`

**Step 4 – hand-off detection**
1. a. `feat(main-world): hook file input and DataTransfer file getters`
   b. `test(main-world): browser-mode tests for inputs (attached, detached, shadow DOM), drop and paste`
2. a. `feat(main-world): hook getAsFile, FileSystemFileEntry.file and FileSystemFileHandle.getFile`
   b. `test(main-world): cover items, OPFS file handles and entry hook logic`
3. a. `feat(main-world): de-duplicate forwarded files with a WeakSet`
   b. `test(main-world): repeated .files reads forward each file once`
4. a. `feat(content): receive files over MessageChannel with buffering`
   b. `test(content): cover channel handshake and early-file buffering`
5. a. `feat(content): filter PDFs by magic bytes, mark oversized files, group into batches`
   b. `test(content): cover PDF filter, oversized files sent without bytes, batching`
→ tag `step-4`

**Step 5 – extraction & job system**
1. a. `feat(offscreen): extract text per page with pdf.js (isEvalSupported off)`
   b. `test(offscreen): add fixture generator, sample PDFs and extraction tests`
2. a. `feat(offscreen): report encrypted, invalid and text-less PDFs`
   b. `test(offscreen): cover encrypted, invalid and text-less PDFs`
3. a. `feat(offscreen): add job registry with admission control, queue cap and timeout`
   b. `test(offscreen): cover queueing, QUEUE_FULL, too-large reports, timeout and job isolation`
4. a. `feat(offscreen): limit parallel extractions and share one pdf.js worker`
   b. `test(offscreen): cover extraction limit and worker reuse`
→ tag `step-5`

**Step 6 – scanning**
1. a. `feat(scanner): split text at safe boundaries with overlap and page mapping`
   b. `test(scanner): cover boundaries, PEM blocks, overlap, multi-byte text and page mapping`
2. a. `feat(scanner): truncate text above maxTextChars and report partial scans`
   b. `test(scanner): cover truncation and partial-scan status`
3. a. `feat(scanner): parse API responses into findings`
   b. `test(scanner): parse recorded API fixtures and malformed responses`
4. a. `feat(scanner): call API with timeout and retries`
   b. `test(scanner): cover API client with mocked fetch`
5. a. `feat(scanner): shrink oversized chunks with bounded splitting`
   b. `test(scanner): cover split on the observed "too large" response, shrink-only, floor and depth limit`
6. a. `feat(scanner): add global API call limiter with round-robin across jobs`
   b. `test(scanner): limit never exceeded across jobs; fair scheduling`
7. a. `feat(scanner): aggregate, de-duplicate and mask findings`
   b. `test(scanner): cover aggregation, de-duplication and masking`
8. a. `feat: wire scan pipeline end to end`
   b. `test: pipeline test with concurrent jobs and mocked API`
→ tag `step-6`

**Step 7 – notifications**
1. a. `feat: add i18n message catalogue for notification texts`
   b. `test: every message key used in code exists in the catalogue`
2. a. `feat(background): show batch result notifications for all outcomes`
   b. `test(background): cover secrets, partial, failed, QUEUE_FULL, too large, multi-file and file-name sanitising`
3. a. `feat(background): add not-configured and interrupted notifications`
   b. `test(background): cover not-configured click and SCAN_INTERRUPTED`
→ tag `step-7`

**Step 8 – real-site testing**
1. a. `fix: …` (one per issue found on real sites)
   b. `test: …` (regression test for that fix)
2. `docs: record real-site results and safety-net decision`
3. (only if decided) a. `feat(content): add event-listener safety net` / b. `test(content): cover safety net and cross-layer de-duplication`
→ tag `step-8`

**Step 9 – hardening & docs**
1. a. `fix: …` (one per edge case found)
   b. `test: …` (regression test for that fix)
2. `build: add release packaging script`
3. `docs: complete README per §14`
→ tag `step-9` / `v1.0.0`

**Step 10 – offscreen lifecycle**
1. a. `feat(background): create offscreen document lazily on first scan`
   b. `test(background): cover lazy creation`
2. a. `feat: close offscreen document after idle timeout`
   b. `test: idle timer runs only with zero active jobs; scan during close self-heals`
3. `docs: record measured startup cost and memory saving`
→ tag `step-10` / `v1.1.0`

---

## 12. Known limitations / future work

- Alerts only – no blocking (requirement).
- Only allow-listed sites are protected; cross-origin upload iframes need their
  own entry; already-open tabs need a reload after a site is added.
- The API silently stops scanning texts somewhere between 128k and 256k
  characters; mitigated by 32k chunks and the "cut short" check (§4.2, §5).
- With random fake values only AWS keys were detected; detection of other
  secret types depends on the vendor (§5).
- Only `Secrets` findings are used; other detectors (e.g. Sensitive Data) are
  ignored.
- Incognito windows not supported.
- No per-tab rate limit: a hostile page could flood scans (DoS of quota/CPU).
- Enterprise policy deployment (`chrome.storage.managed`) – future option.
- OS-level notification blocking cannot be detected (§7); Chrome-level blocking
  is warned about. Future option: toolbar badge when blocked in Chrome.
- Notifications only: no in-page UI, no details view. Future options: a
  details page opened by clicking the notification, and a recent-scans history
  in the extension popup.
- **Text clean-up before chunking** (future feature, may only stay documented):
  normalise non-breaking spaces, remove zero-width characters, re-join
  hyphenated line breaks, collapse spacing that pdf.js inserts inside tokens.
  Would improve detection of secrets broken by PDF layout.
- (Done in step 10) Lazy offscreen creation and idle close.
- OCR for scanned PDFs.
- Automated end-to-end tests with Playwright (planned – see §15).
- Secrets broken by PDF layout (hyphenation, line wrap inside a token) may be missed.
- Other file types (DOCX, TXT…).
- Event-listener safety net for detection (see §3) – decided at step 8.
- Files a site deliberately hides from the hooks (out of scope by threat model).
- A site on the allow list whose Chrome access was revoked or never granted is
  silently not scanned (§3.1: scripts run on allow list ∩ granted). Future
  feature: per-site status in the options page ("active" / "access not
  granted") with a button that requests access again.

---

## 13. Decision log

Decisions challenged before implementation (2026-10-14).

| # | Decision | Alternatives considered | Outcome & reason |
|---|---|---|---|
| R1 | **Alert, don't block** | – | Requirement from the task definition; not a design decision and not open for change. |
| D1 | Language: **TypeScript** | C++ via WebAssembly; plain JavaScript; JS + JSDoc `@ts-check` | A build step is needed anyway (content scripts can't use `import`, pdf.js via npm). TS adds compile-time checking of messages between the three contexts, `chrome.*` and pdf.js types; familiar model coming from C++. |
| D2 | PDF engine: **pdf.js** | unpdf, PDFium (WASM), MuPDF.js (AGPL), own parser, server-side extraction | Mature, permissive license, best JS API. Own parser would silently miss text (dangerous for a security tool). |
| D3 | pdf.js runs in an **offscreen document** | All in the service worker; in the content script | Content script: can't call the API (CORS), loads pdf.js into every page, freezes pages. Service worker: no Web Worker, unsupported pdf.js setup, parsing blocks the worker, idle termination. Offscreen cost (~15–30 MB while open, ~0.1–0.3 s startup) is acceptable. |
| D4 | Offscreen document **always present** in v1 | Lazy creation + idle close | Simpler and avoids creation races early on; the optimisation is planned as step 10. |
| D5 | **Resilient concurrency** (§4.1) | Per-scan limits only | Multi-file and multi-tab uploads would multiply API calls and memory, race on offscreen creation, and flood alerts. |
| D6 | **Whole scan pipeline in the offscreen document**; content script ↔ offscreen directly; service worker only creates the document, bridges settings and shows notifications | Extraction-only offscreen with API calls/jobs in the service worker | We don't control the service worker's lifetime; keeping it off the scan path means its termination can never interrupt or lose a scan. Also: all concurrency state in one context, one data hop instead of two. Cost: a settings handshake (offscreen can't read `chrome.storage`). |
| D7 | Detection by **hand-off hooks** on the five APIs that give a page a `File` | Event listeners (`change`/`drop`/`paste`) + special hook for detached inputs; network observation (`webRequest`); wrapping `fetch`/XHR/`FormData` | Covers all file sources incl. shadow DOM, detached inputs, folder drops and File System Access API; precise WeakSet de-dup. Network approaches miss chunked/worker/WebSocket uploads; webRequest would also put the service worker on the scan path. |
| D8 | Event-listener **safety net left out of v1** | Add it now | Keep v1 simple; reassess after real-site testing (step 8). Documented as a future option in DESIGN and README. |
| D9 | Scan on **hand-off**, alert wording "added to this site" | Scan only on actual network upload | Once the page holds the file it can upload it any time; network upload can't be observed reliably. Cost: a PDF selected then cancelled is still scanned. |
| D10 | **Threat model**: accidental leaks only | Also defend against evasive sites | A malicious site can always evade client-side hooks; the target is user mistakes. |
| D11 | Chunks end only at whitespace (paragraph > line > space); PEM blocks unbreakable; overlap 200 for context | Fixed-size cuts with large overlap to cover long secrets | Secrets are never split, so overlap stays small (fewer extra calls); PEM keys (~1.7–3.2k chars) stay whole. |
| D12 | **Bounded** automatic shrinking when a chunk is cut short (reported `characters` < sent, or 413); default size set by probing (updated after step 1) | Fixed size only; adaptive grow-and-shrink | Robust to the unknown limit. Shrink-only, floor 500, bounded depth, never grows past configured size – no runaway behaviour. |
| D13 | Text above `maxTextChars` (2M): **scan the first part and warn** | Refuse to scan | A partial scan still catches most leaks; the warning makes the gap explicit and the result is never reported as clean. |
| D14 | Text clean-up before chunking: **future feature** | Add in step 2 | Keep v1 scope tight; documented in §12 and README future options. |
| D15 | Verdict = `result.prompt.findings.Secrets` non-empty | `action` / `passed` / `violations` | `action` reflects the server-side policy across all detectors: Sensitive Data or Token Limitation set to block would cause false alarms, Secrets set to log would silently miss secrets. Findings are also needed for the alert content. |
| D16 | Alerts = **Chrome system notifications only** | In-page overlay; overlay with fallbacks (top frame / notification) | One mechanism that works in every case (page open, iframe, navigated, tab closed) – simple and consistent. Cost: less contextual, short text, depends on OS notification settings (checked and documented). |
| D17 | **Don't cancel** scans when the page disconnects | Cancel on disconnect | "Upload and leave" would otherwise silently drop a positive result. Scans end only on completion or `jobTimeoutMs`. |
| D18 | Mask = first 4 + `…` + last 2; < 12 chars → `••••••`; enforced by `isMaskedValue` | First 4 + last 4 | Notifications may show on the lock screen and persist in OS history; 6 visible characters still identify which key to rotate. |
| D19 | Security hardening: safe logger, pdf.js `isEvalSupported:false` + pinned version + audit + Dependabot, sender/message validation, file-name sanitising, no `externally_connectable` | – | Small, concrete mitigations for the main attack surfaces. |
| D20 | Documented, not implemented in v1: incognito (disabled), managed storage, per-tab rate limiting (DoS), first-run notice | Implement now | Keep v1 scope; risks are stated in the README (§14). |
| D21 | **Site allow list** in v1 (empty by default), via dynamic content scripts + optional per-site host permissions | Scan all sites; block list | Limits which documents ever reach the vendor; the user consents per site; removes the "all websites" install warning. Cost: sites not on the list are unprotected; iframes need their own entry; open tabs need a reload. Supersedes the earlier "all websites" scope decision. |
| D22 | `maxQueuedMB` cap (200 MB) on received-but-unfinished bytes → `QUEUE_FULL` | Pull bytes only when admitted | Bytes must arrive immediately so scans survive the page closing (D17); the cap bounds memory instead. |
| D23 | Oversized files reported via the batch (name + size only) | Content-script notice | Content script has no UI (D16); one path for all outcomes. |
| D24 | Service worker is the **single owner** of content-script registration (`reconcile()`); options page only edits list + permissions | Options page registers, service worker re-syncs | One writer, idempotent, can't drift. |
| D25 | Dev build adds `http://localhost/*` and seeds the allow list; release build doesn't | Manual permission grant during development | Test pages work without the options flow; release stays minimal (checked by test). |
| D26 | `minimum_chrome_version` set (≈120, confirmed in step 0) | None | Offscreen, `getContexts`, registered MAIN-world scripts need recent Chrome. |
| D27 | Real-API and real-site testing **run by the developer**; probing script + fixture generator provided | Claude runs them | The API is not reachable from Claude's environment. |
| D28 | v1 testing = **automated unit tests + manual checklist**; Playwright E2E planned for later | E2E in v1 | Keep v1 scope; E2E plan documented in §15 and README. |
| D29 | **Vitest browser mode** (real Chromium) for page-level tests | jsdom | jsdom lacks `DataTransfer`, File System Access API and a real `FileList` – exactly what the hooks use. |
| D30 | **GitHub Actions CI** from step 0; coverage threshold 80 % for `scanner/` and `shared/` | No CI / no threshold | Every commit verified the same way; core logic stays well tested. |
| D31 | Dev builds accept `http://localhost` API URL (mock API); release builds don't | Mock via fetch interception only | Allows manual end-to-end runs without the real API; release rule unchanged and tested. |
| D32 | **Step order:** repo → API probing → walking skeleton → options & allow list → detection → extraction & jobs → scanning → notifications → real-site testing → hardening (v1.0.0) → offscreen lifecycle (v1.1.0); each step gated by the developer's manual check | Original 0–7 order (detection first, probing at end of step 3) | Unknowns (API behaviour, messaging architecture) settled first; no step uses code built later; smaller steps; something runnable from step 2. |
| D33 | **Agent guide graph:** `AGENTS.md` master + `docs/agents/*.md` per component; `CLAUDE.md` imports `AGENTS.md`; facts and rules only, kept in sync per commit | Single large file; no agent docs | Agents read only the part they need; no redundancy with DESIGN.md; `AGENTS.md` is the name most coding agents look for. |
| D34 | From probing: `chunkSize` 32,000 (max 50,000), `maxRequestBytes` 64 KB, "cut short" = reported `characters` < sent, new `API_UNAUTHORIZED`, never send empty chunks | Keep 4,000 / 64,000; rely on 413 | The API returns 200 "clean" while silently not scanning text beyond ~128–256k characters; 32k gives a 4× margin with few calls. |
| D35 | Offscreen document replies on the scan port: `BATCH_ACCEPTED` (all files received) and `BATCH_DONE` (all jobs ended, then port closed); the content script retries only before `BATCH_ACCEPTED` and reports `SCAN_INTERRUPTED` for a close after it | One-way port; infer from `onDisconnect` / Chrome's error text | `onDisconnect` looks the same for "never connected", "finished" and "crashed"; explicit replies make retry vs interrupted unambiguous. Replies carry no results (results never reach the page). |

---

## 14. README content checklist

Created in step 0 (skeleton), completed in step 9. Every item below must be in
the README:

- [ ] Install, build, load unpacked; configuration (APP-ID, API URL) and all
      setting defaults (§6)
- [ ] **Privacy notice:** the full text of every PDF handed to a site is sent to
      Prompt Security (EU endpoint); this includes files selected and then
      cancelled
- [ ] **API behaviour:** silently stops scanning very long texts (why chunks are
      32k), and secret types detected depend on the vendor (§5)
- [ ] **Vendor data handling:** retention/logging on the vendor side is unknown;
      responses indicate requests are logged
- [ ] **Incognito windows are not supported** in this version
- [ ] APP-ID is stored unencrypted in the Chrome profile; never commit it
- [ ] Enterprise deployment via managed storage is **not supported** – possible
      future feature
- [ ] Secret values and PDF text are kept in memory only, never stored or
      logged; masking rule for notifications
- [ ] pdf.js hardening (eval disabled, strict CSP, pinned version, npm audit,
      Dependabot)
- [ ] **DoS:** a hostile page could flood the extension with files; no per-tab
      rate limit in this version
- [ ] File names in notifications come from the website (truncated and
      sanitised); the site name comes from Chrome
- [ ] Dependencies: one runtime dependency (pdf.js), lockfile committed, no
      remote code
- [ ] No analytics or telemetry
- [ ] **Site allow list:** empty by default (nothing scanned), how to add sites,
      per-site permission prompt, reload already-open tabs, iframe origins must
      be added separately
- [ ] Threat model: protects against accidental leaks, not evasive sites
- [ ] Known gaps in test coverage: the scenario not covered and what a future
      test needs
- [ ] OS notification settings (Windows notifications / Focus Assist)
- [ ] Minimum Chrome version
- [ ] Development: `build:dev`, `serve:test-pages`, `mock-api` (dev builds accept an
      `http://localhost` API URL; release builds don't), fixture generator,
      running `probe-api.mjs` with `PSS_APP_ID`
- [ ] Testing: how to run the tests, coverage thresholds, the manual checklist,
      what is out of scope, and the **plan for future end-to-end tests with
      Playwright**
- [ ] Known limitations and **Future options** (event-listener safety net,
      text clean-up, details page / history, managed storage, rate limiting,
      OCR, other file types)

---

## 15. Testing strategy

**v1 = automated unit tests + manual tests.** End-to-end automation is planned
for later (below).

| Level | What | Tool | Run by |
|---|---|---|---|
| Static | Type check, both manifests (permissions, localhost only in dev, incognito, CSP, minimum Chrome version), dependency audit | `tsc --noEmit`, manifest test, `npm audit` | Build + CI |
| Unit – Node | Chunker, page mapping, truncation, response parser (recorded fixtures), masking, aggregation, safe logger, settings validation, allow-list patterns, API limiter / round-robin, job registry, queue cap, timeouts, bounded splitting, notification text, file-name sanitising, i18n keys | Vitest (Node), fake timers, mocked `fetch` | Build + CI |
| Unit – PDF extraction | pdf.js on generated sample PDFs: text per page, encrypted, no text layer, Hebrew, PEM key, ~20 MB | Vitest (Node) + pdf.js | Build + CI |
| Unit – browser | Hand-off hooks, MAIN ↔ content channel, WeakSet de-dup, PDF filter, batching – in **real Chromium** (jsdom lacks `DataTransfer`, File System Access API, real `FileList`). `FileSystemFileHandle` via OPFS; `FileSystemFileEntry` hook logic with a stand-in (real behaviour: manual) | **Vitest browser mode** (Playwright provider, headless Chromium) | Build + CI |
| Unit – wiring | Content script ↔ offscreen ↔ service worker: settings handshake, self-healing, registration reconcile, sender validation, notifications | Vitest + `tests/helpers/chrome-fake.ts` (in-memory `chrome.*`) | Build + CI |
| Manual – real API | Size limit, error responses, rate limit, PII-only / URL-only texts | `scripts/probe-api.mjs` | **Developer** |
| Manual – extension | Dev build on `test-pages/` with the **local mock API** (clean / secrets / 413 / 429 / 500 / timeout / malformed); real sites (Gmail, Drive, Slack, WhatsApp Web, ChatGPT); OS notifications incl. Focus Assist; permission prompts; real file dialogs and folder drops; memory/startup measurements (step 10) | `docs/manual-tests.md` checklist | **Developer** |

**Coverage:** Vitest coverage (v8). Threshold **80 %** (lines and branches) for
`src/scanner/` and `src/shared/`; no threshold for wiring code. CI fails below.

**CI (GitHub Actions, from step 0):** on every push – install, Playwright
Chromium, type check, all Vitest projects with coverage, `npm audit`, dev and
release builds.

**Infrastructure:** Node.js LTS + npm; dev dependencies `typescript`,
`esbuild`, `vitest`, `@vitest/browser-playwright`, `playwright`, `@vitest/coverage-v8`,
`@types/chrome`, `pdf-lib` (none ship in the extension); Playwright Chromium;
local scripts `serve-test-pages`, `mock-api`, `make-fixtures`, `probe-api`.

**Out of scope**
- Quality of the vendor's detection (which secrets the API finds or misses) –
  we test our handling of its answers.
- Automated tests against the real API (secret APP-ID, network,
  non-deterministic) – manual probe only.
- Automated real-site tests (logins, sites change, terms of service) – manual.
- Automating real file dialogs and OS notification rendering.
- Other browsers (Edge, Brave untested; Firefox unsupported).
- Load testing, fuzzing pdf.js, penetration testing, accessibility of OS
  notifications, languages other than English.

**Future: end-to-end tests with Playwright** (documented in the README). Launch
Chromium with the dev build (`--load-extension`), use `test-pages/` and the mock
API, and cover: file select, drop, multi-file batch, tab closed mid-scan, site
not on the allow list, API errors (413 / 429 / 500 / timeout). Notifications
verified via `chrome.notifications.getAll()` from the service worker. Would run
in CI.
