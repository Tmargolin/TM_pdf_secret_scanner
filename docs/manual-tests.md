# Manual tests

Run before tagging a step. Automated tests cover the logic; these checks cover
what only real Chrome shows: script injection, messaging between contexts and
OS notifications. Extended in later steps (sources in step 4, real API in
step 6, real sites in step 8).

## Preparation

1. `npm run build:dev`, then `chrome://extensions` → Developer mode → **Load
   unpacked** → `dist/` (or the reload icon if already loaded).
2. `npm run serve:test-pages` → open **http://localhost:8080/upload.html**
   (`localhost`, not `127.0.0.1` – only `localhost` is on the dev allow list).
3. Consoles you will need:
   - **Service worker:** extension card → "service worker".
   - **Offscreen document:** extension card → "Inspect views: offscreen.html".
   - **Page:** DevTools on the test page, log level **Verbose** (debug lines
     are hidden by default).
4. Notifications enabled for Google Chrome in the OS (README → Requirements).

## Step 2 – walking skeleton

| # | Do | Expect |
|---|---|---|
| 2.1 | Reload the extension | No errors on the extension card; the icon (document + magnifier) is shown. Service worker: `content scripts reconciled { allowed: 1, active: 1 }`. Offscreen: `offscreen document loaded`, `settings received`. |
| 2.2 | Open the test page | Page console: `[PSS:content] content script loaded`. |
| 2.3 | Section 1: pick one **PDF** (since step 4 only PDFs are sent) | Offscreen: `batch received { files: 1 }`. Page: `batch done { files: 1 }`. A notification **"PDF Secret Scanner (preview)" – "Received 1 file(s) from localhost:8080. Scanning is not implemented yet – nothing was checked."** |
| 2.4 | Section 2: pick three PDFs | One notification, "Received 3 file(s)…". |
| 2.5 | Offscreen console: `window.close()`, then pick a PDF | Page: `scan port not accepted, asking for the offscreen document`, then `batch done`. Service worker: `offscreen document created`. Notification shown. |
| 2.6 | Release build: `npm run build`, reload, reload the test page | Service worker: `allowed: 0, active: 0`; no content-script line on the page; no notification. Rebuild with `npm run build:dev` afterwards. |
| 2.7 | Serialisation check (DESIGN §2): in the **service worker** console run `chrome.runtime.onMessage.addListener((m) => { if (m?.probe) console.log(JSON.stringify(m)); })`; in the **offscreen** console run `chrome.runtime.sendMessage({ probe: 1, bytes: new Uint8Array([1, 2, 3]), buffer: new Uint8Array([1, 2, 3]).buffer })` | Service worker prints `{"probe":1,"bytes":{"0":1,"1":2,"2":3},"buffer":{}}` – bytes are JSON-serialised, so base64 is still needed. Anything else: record it, base64 may be droppable. |

If no notification appears but the service worker shows no error, Windows is
hiding it: check Settings → System → Notifications (Google Chrome on, Do not
disturb off) and the notification center (Win+N).

## Step 3 – options page and allow list

Open the **options page** from `chrome://extensions` → extension card →
Details → *Extension options*. Keep the **service worker** console open.

| # | Do | Expect |
|---|---|---|
| 3.1 | Remove the extension, then **Load unpacked** `dist/` again (dev build) | The options page opens by itself. Yellow "Not set up yet" banner. Site list: `http://localhost/*`. No red banner. Help line about OS notifications under the site list. |
| 3.2 | Reload the extension (reload icon) | **No** options tab opens. |
| 3.3 | APP-ID `mock-app-id` → Save | "Saved."; yellow banner gone. Offscreen console: `settings updated { configured: true, … }`. Service worker: **no** new `content scripts reconciled` line. |
| 3.4 | API URL `http://evil.com` → Save; reload the options page | Error under API URL; "Not saved…". After reload the old URL is shown (nothing stored). |
| 3.5 | Advanced: Chunk size `abc` → Save | "Advanced settings" opens; "Chunk size must be a whole number". |
| 3.6 | Restore defaults → Save | Defaults back; APP-ID unchanged (tick *Show* to see it). |
| 3.7 | Add site `example.com` | Chrome asks for access to example.com → Allow. Listed as `*://example.com/*`; "Added … Reload tabs already open on it." Service worker: `content scripts reconciled { allowed: 2, active: 2 }` – **without** reloading the extension. |
| 3.8 | Open `https://example.com`, page console (Verbose) | `[PSS:content] content script loaded`. Then run `const i = Object.assign(document.createElement('input'), { type: 'file' }); i.onchange = () => i.files; document.body.append(i);` (the page's code must read the file – since step 4 that is what triggers a scan), pick a **PDF** → notification "Received 1 file(s) from example.com …". |
| 3.9 | Add `example.org` → **Deny** in Chrome's prompt | "Access to *://example.org/* was not granted – the site was not added." Not listed. |
| 3.10 | Add `example.com` again; add `google` | "already on the list"; "not a site" with the hint. No Chrome prompt for either. |
| 3.11 | `chrome://extensions` → Details → Site access: remove example.com | Service worker: `reconciled { allowed: 2, active: 1 }`. Reload example.com → no content-script line. (The options list still shows example.com – it is on the list, not granted; see 3.12.) |
| 3.12 | Options page: Remove example.com, then add it again | Listed again; service worker `active: 2`. (Chrome may skip the prompt – README, known Chrome behaviour.) |
| 3.13 | Remove example.com | Service worker `active: 1`; example.com no longer scanned. |
| 3.14 | Restart Chrome; open the test page (`npm run serve:test-pages`) and pick a PDF | Notification as in step 2 – registration and settings survived the restart. |
| 3.15 | *(Optional, if Chrome offers it on a notification)* turn off notifications for the extension | Red banner on the open options page at once; service worker warns `notifications are blocked in Chrome …`. Turn them on again → banner gone. |

## Step 4 – hand-off detection

Dev build loaded, test page open (`http://localhost:8080/upload.html`, reload it
after rebuilding). Keep a few PDFs and a `.txt` file ready, and a folder with
PDFs in a subfolder. Each action below is one batch → **one notification**
("Received N file(s) from localhost:8080 …"); the page's own log shows what the
"site" received.

| # | Do | Expect |
|---|---|---|
| 4.1 | Service worker console: `chrome.scripting.getRegisteredContentScripts().then((s) => console.log(s.map((x) => [x.id, x.world])))` | `[['pss-hooks','MAIN'], ['pss-content','ISOLATED']]` |
| 4.2 | Section 1 – file input: a PDF | One notification, "Received 1 file(s)". |
| 4.3 | Section 2 – several files: 2 PDFs + 1 `.txt` | **One** notification, "Received **2** file(s)". |
| 4.4 | Section 3 – detached input: a PDF | One notification. |
| 4.5 | Section 4 – closed shadow DOM input: a PDF | One notification. |
| 4.6 | Section 5 – drag & drop: a PDF and a `.txt` together | One notification, "Received 1 file(s)". |
| 4.7 | Section 5 – drag & drop **a folder** with PDFs, some in a subfolder | One notification counting **all** PDFs at every depth (D36 – lazy entry hooks). |
| 4.8 | Section 6 – copy a PDF in the file manager, Ctrl+V on the page | One notification. |
| 4.9 | Section 7 – showOpenFilePicker: a PDF | One notification. |
| 4.10 | Any section: only a `.txt` | **No** notification (the page log still shows the file). |
| 4.11 | Rename a `.txt` to `fake.pdf`, pick it | **No** notification – the content decides, not the name. |
| 4.12 | Pick the same PDF again in section 1 | A new notification (a new selection is scanned again). |
| 4.13 | Page console (Verbose) during 4.2 | `[PSS:content] batch from the page { files: 1, pdfs: 1 }`; no file names in any extension log line. |

Oversized PDFs (above *Maximum PDF size*) are sent without bytes; the skeleton
notification does not show it yet (step 7) – covered by automated tests.

## Step 5 – extraction and job system

Dev build loaded, test page open and reloaded. Offscreen console with log
level **Verbose**: each batch logs `batch received { files: N }` and then
`batch finished { outcomes: [...] }` – one code per file, in the order the
page got them (`clean` here only means the text was read; nothing is checked
before step 6). PDFs: `tests/fixtures/`.

| # | Do | Expect (offscreen console) |
|---|---|---|
| 5.1 | Reload the extension | `offscreen document loaded`, `settings received`; no errors, no pdf.js warnings. |
| 5.2 | Section 1: `one-page.pdf` | `outcomes: ['clean']`; notification as before. |
| 5.3 | Section 1: `encrypted.pdf` | `['PDF_ENCRYPTED']` |
| 5.4 | Section 1: `no-text.pdf` | `['NO_TEXT_LAYER']` |
| 5.5 | Section 1: `owner-password-only.pdf` | `['clean']` – opens without a password, so it is read. |
| 5.6 | Section 2: all 9 fixture PDFs at once | **One** `batch received { files: 9 }` and one `batch finished` with 9 codes: `PDF_ENCRYPTED` and `NO_TEXT_LAYER` once each, the rest `clean`. |
| 5.7 | Offscreen DevTools → Sources → **Threads** pane (or the console's context drop-down) | Exactly **one** `pdf.worker.mjs` thread; still one after repeating 5.6. |
| 5.8 | Section 1: a large real PDF of your own (many pages, several MB) | `['clean']` (or a PDF code), within a few seconds; no warnings. |
| 5.9 | Options → Advanced: *Files waiting* 10 MB, *Maximum PDF size* ≥ 10 → Save. Section 2: PDFs of your own totalling > 10 MB (e.g. three of 4–5 MB) | The files that no longer fit → `QUEUE_FULL` (warning `queue full: file not scanned`), the others read. **Restore defaults** afterwards (APP-ID is kept). |
| 5.10 | Look through every extension console | No file names and no PDF text in any line. |
| 5.11 | `npm run build` (release) | `dist/offscreen/pdf.worker.mjs` exists. Reload, repeat 5.2: works; no `batch finished` line (debug lines are dev-only). Rebuild with `npm run build:dev` afterwards. |

Job timeout, the extraction limit and aborting are covered by automated tests
(they need very slow or very large files to see by hand).
