# Manual tests

Run before tagging a step: what only real Chrome shows (script injection,
messaging between contexts, OS notifications, real API, real sites). The logic
is covered by automated tests. What each notification says: README
"Notifications – what each one means".

## Preparation

1. `npm run build:dev`, then `chrome://extensions` → Developer mode → **Load
   unpacked** → `dist/` (or the reload icon if already loaded).
2. `npm run serve:test-pages` → open **http://localhost:8080/upload.html**
   (`localhost`, not `127.0.0.1` – only `localhost` is on the dev allow list).
3. `npm run mock-api`; Options → API URL `http://localhost:8787/api/protect`,
   APP-ID `mock-app-id` → Save (from step 3 on).
4. Consoles, log level **Verbose** (debug lines are hidden by default):
   **service worker** and **offscreen document** (extension card → Inspect
   views), **page** (DevTools on the test page).
5. Notifications enabled for Google Chrome in the OS (README → Requirements).
   No notification but no error → check Windows Settings → System →
   Notifications (Chrome on, Do not disturb off) and the notification center
   (Win+N).

Each batch logs `batch received { files: N }` in the offscreen console and
`batch done { files: N }` on the page. PDFs: `tests/fixtures/`.

## Step 2 – architecture

| # | Do | Expect |
|---|---|---|
| 2.1 | Reload the extension | No errors on the card. Service worker: `content scripts reconciled { allowed: 1, active: 1 }`. Offscreen: `offscreen document loaded`, `settings received`. |
| 2.2 | Open the test page | Page: `[PSS:content] content script loaded`. |
| 2.3 | Section 2: three PDFs | One batch: `batch received { files: 3 }`, page `batch done { files: 3 }`. |
| 2.4 | Offscreen console: `window.close()`, then pick a PDF | Page: `scan port not accepted, asking for the offscreen document`, then `batch done`. Service worker: `offscreen document created`. |
| 2.5 | Release build (`npm run build`), reload, reload the test page | Service worker: `allowed: 0, active: 0`; no content-script line on the page. Rebuild with `npm run build:dev`. |

## Step 3 – options page and allow list

Options page: `chrome://extensions` → Details → *Extension options*. Keep the
service worker console open.

| # | Do | Expect |
|---|---|---|
| 3.1 | Remove the extension, **Load unpacked** again (dev build) | Options page opens by itself; yellow "Not set up yet" banner; site list `http://localhost/*`; help line about OS notifications. |
| 3.2 | Reload the extension | **No** options tab opens. |
| 3.3 | APP-ID `mock-app-id` → Save | "Saved."; banner gone. Offscreen: `settings updated { configured: true, … }`; service worker: **no** new `reconciled` line. |
| 3.4 | API URL `http://evil.com` → Save; reload the page | Error under API URL, "Not saved…"; after reload the old URL is back. |
| 3.5 | Advanced: Chunk size `abc` → Save | Section opens; "Chunk size must be a whole number". |
| 3.6 | Restore defaults → Save | Defaults back; APP-ID unchanged. |
| 3.7 | Add site `example.com` → Allow in Chrome's prompt | Listed as `*://example.com/*`, "Reload tabs already open on it."; service worker `reconciled { allowed: 2, active: 2 }` without reloading the extension. |
| 3.8 | On `https://example.com`, page console: `const i = Object.assign(document.createElement('input'), { type: 'file' }); i.onchange = () => i.files; document.body.append(i);` – pick a PDF | Content script loaded; offscreen `batch received { files: 1 }`. |
| 3.9 | Add `example.org` → **Deny** | "…was not granted – the site was not added." |
| 3.10 | Add `example.com` again; add `google` | "already on the list"; "not a site" with the hint; no Chrome prompt. |
| 3.11 | `chrome://extensions` → Site access: remove example.com | Service worker `active: 1`; example.com no longer scanned (still listed – README known issue). |
| 3.12 | Options: Remove example.com, add it again | Listed; `active: 2` (Chrome may skip the prompt – README). |
| 3.13 | Remove example.com | `active: 1`. |
| 3.14 | Restart Chrome; pick a PDF on the test page | `batch received` – registration and settings survived the restart. |
| 3.15 | *(Optional)* turn off this extension's notifications in Chrome | Red banner on the open options page; service worker warns `notifications are blocked in Chrome …`. Turn them on again → banner gone. |

## Step 4 – hand-off detection

Keep a few PDFs, a `.txt` file and a folder with PDFs in a subfolder ready. The
page's own log shows what the "site" received.

| # | Do | Expect |
|---|---|---|
| 4.1 | Service worker: `chrome.scripting.getRegisteredContentScripts().then((s) => console.log(s.map((x) => [x.id, x.world])))` | `[['pss-hooks','MAIN'], ['pss-content','ISOLATED']]` |
| 4.2 | Section 1 – file input: a PDF | `batch received { files: 1 }` |
| 4.3 | Section 2 – 2 PDFs + 1 `.txt` | **One** batch, `files: 2` |
| 4.4 | Section 3 – detached input; section 4 – closed shadow DOM | One batch each |
| 4.5 | Section 5 – drop a PDF and a `.txt` | One batch, `files: 1` |
| 4.6 | Section 5 – drop **a folder** with PDFs, some in a subfolder | One batch counting **all** PDFs at every depth (D36) |
| 4.7 | Section 6 – copy a PDF in the file manager, Ctrl+V on the page | One batch |
| 4.8 | Section 7 – showOpenFilePicker: a PDF | One batch |
| 4.9 | Only a `.txt`; or a `.txt` renamed to `fake.pdf` | **No** batch (the content decides, not the name) |
| 4.10 | The same PDF again in section 1 | A new batch (a new selection is scanned again) |
| 4.11 | Page console during 4.2 | `[PSS:content] batch from the page { files: 1, pdfs: 1 }`; no file names in any extension log line. |

## Step 5 – extraction and job system

Each batch also logs `batch finished { outcomes: [...] }` – one code per file:
`clean`, `secrets:N` or error codes.

| # | Do | Expect (offscreen console) |
|---|---|---|
| 5.1 | Reload the extension | `offscreen document loaded`, `settings received`; no errors, no pdf.js warnings. |
| 5.2 | Section 1: `one-page.pdf` | `outcomes: ['clean']` |
| 5.3 | Section 1: `encrypted.pdf` | `['PDF_ENCRYPTED']` |
| 5.4 | Section 1: `no-text.pdf` | `['NO_TEXT_LAYER']` |
| 5.5 | Section 1: `owner-password-only.pdf` | `['clean']` – opens without a password, so it is read. |
| 5.6 | Section 2: all 9 fixture PDFs at once | **One** `batch received { files: 9 }` and one `batch finished` with 9 codes (6.3). |
| 5.7 | Offscreen DevTools → Sources → **Threads** pane (or the console's context drop-down) | Exactly **one** `pdf.worker.mjs` thread; still one after repeating 5.6. |
| 5.8 | Section 1: a large real PDF of your own (many pages, several MB) | `['clean']` (or a PDF code), within a few seconds; no warnings. |
| 5.9 | Options → Advanced: *Files waiting* 10 MB, *Maximum PDF size* ≥ 10 → Save. Section 2: PDFs of your own totalling > 10 MB (e.g. three of 4–5 MB) | The files that no longer fit → `QUEUE_FULL` (warning `queue full: file not scanned`), the others read. **Restore defaults** afterwards (APP-ID is kept). |
| 5.10 | Look through every extension console | No file names and no PDF text in any line. |
| 5.11 | `npm run build` (release) | `dist/offscreen/pdf.worker.mjs` exists. Reload, repeat 5.2: works; no `batch finished` line (debug lines are dev-only). Rebuild with `npm run build:dev` afterwards. |

Job timeout, the extraction limit and aborting are covered by automated tests
(they need very slow or very large files to see by hand).

## Step 6 – scanning

Each file logs `file scanned { pageCount, chunks, failedChunks, calls,
findings, ms }`. Against the mock API (Preparation 3):

| # | Do | Expect (offscreen console) |
|---|---|---|
| 6.1 | Section 1: `multi-page.pdf` | `file scanned { pageCount: 3, … findings: 1 }`, `outcomes: ['secrets:1']`; mock terminal: one request line (sizes only) |
| 6.2 | Section 1: `one-page.pdf` | `['clean']` |
| 6.3 | Section 2: all 9 fixtures | One batch, 9 outcomes: `secrets:1` for `multi-page` and `split-token`, `PDF_ENCRYPTED`, `NO_TEXT_LAYER`, the rest `clean` |
| 6.4 | Options: APP-ID `wrong` → Save; `one-page.pdf` | `['API_UNAUTHORIZED']`; set `mock-app-id` again |
| 6.5 | Restart the mock with `$env:MOCK_MODE="500"; npm run mock-api`; `one-page.pdf` | `API request will be retried` ×2, then `['API_HTTP_ERROR']`. Afterwards `Remove-Item Env:MOCK_MODE` and restart the mock |
| 6.6 | Options: APP-ID empty → Save; `one-page.pdf` | `['NOT_CONFIGURED']`, no request in the mock terminal |

**Against the real API:** stop the mock; Options → Restore defaults (keeps the
APP-ID), enter the real APP-ID → Save.

| # | Do | Expect |
|---|---|---|
| 6.7 | `multi-page.pdf` | `['secrets:1']` |
| 6.8 | `one-page.pdf` | `['clean']` |
| 6.9 | Look through every extension console | No PDF text, key or APP-ID in any line |

Retries with back-off, job timeout, splitting of cut-short chunks and
round-robin across jobs are covered by automated tests.

## Step 7 – notifications

Against the mock API (Preparation 3).

| # | Do | Expect |
|---|---|---|
| 7.1 | Section 1: `multi-page.pdf` | **Secrets found in multi-page.pdf** – You added it to localhost:8080. / AWS credentials (p. 2) AKIA…LE / Remove the file and rotate the credentials. Stays until dismissed |
| 7.2 | Section 1: `one-page.pdf` | No notification (clean) |
| 7.3 | Section 1: `encrypted.pdf` | **Couldn't fully scan encrypted.pdf** – The PDF is password-protected – it was not checked. |
| 7.4 | Section 2: `multi-page.pdf` + `encrypted.pdf` + `one-page.pdf` | **Two** notifications (D39): *Secrets found in multi-page.pdf* and *Couldn't fully scan encrypted.pdf* |
| 7.5 | Section 2: `encrypted.pdf` + `no-text.pdf` | *Couldn't fully scan 2 of 2 files*, one line per file |
| 7.6 | Options: clear the APP-ID → Save; add `one-page.pdf` twice | **One** *PDF Secret Scanner isn't set up*; clicking it opens the settings and closes it |
| 7.7 | APP-ID `wrong` → Save; `one-page.pdf` | *Couldn't scan one-page.pdf* – Your APP-ID was rejected…; clicking opens the settings |
| 7.8 | APP-ID `mock-app-id`; restart the mock with `$env:MOCK_LATENCY_MS="15000"`; add `one-page.pdf`, then `window.close()` in the offscreen console within 15 s | *The scan of one-page.pdf was interrupted*. Afterwards `Remove-Item Env:MOCK_LATENCY_MS`, restart the mock |
| 7.9 | Options → Advanced: *Maximum PDF size* 1 → Save; a PDF of your own > 1 MB | *Couldn't fully scan …* – The file is larger than the size limit. **Restore defaults** afterwards |

## Step 8 – real sites

Real API, dev build. Per site: add it in Options, reload its tab, then add
`multi-page.pdf` and `one-page.pdf` through every path the site offers
(picker, drag & drop, paste). Expect one `batch received` per action, the
secrets notification for `multi-page.pdf`, none for `one-page.pdf`. Results:
DESIGN §3 "Real-site results".

| Site | Status |
|---|---|
| mail.google.com, drive.google.com, chatgpt.com, linkedin.com | Passed (step 8) |
