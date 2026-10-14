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
| 2.3 | Section 1: pick one file | Offscreen: `batch received { files: 1 }`. Page: `batch done { files: 1 }`. A notification **"PDF Secret Scanner (preview)" – "Received 1 file(s) from localhost:8080. Scanning is not implemented yet – nothing was checked."** |
| 2.4 | Section 2: pick three files | One notification, "Received 3 file(s)…". |
| 2.5 | Offscreen console: `window.close()`, then pick a file | Page: `scan port not accepted, asking for the offscreen document`, then `batch done`. Service worker: `offscreen document created`. Notification shown. |
| 2.6 | Release build: `npm run build`, reload, reload the test page | Service worker: `allowed: 0, active: 0`; no content-script line on the page; no notification. Rebuild with `npm run build:dev` afterwards. |
| 2.7 | Serialisation check (DESIGN §2): in the **service worker** console run `chrome.runtime.onMessage.addListener((m) => { if (m?.probe) console.log(JSON.stringify(m)); })`; in the **offscreen** console run `chrome.runtime.sendMessage({ probe: 1, bytes: new Uint8Array([1, 2, 3]), buffer: new Uint8Array([1, 2, 3]).buffer })` | Service worker prints `{"probe":1,"bytes":{"0":1,"1":2,"2":3},"buffer":{}}` – bytes are JSON-serialised, so base64 is still needed. Anything else: record it, base64 may be droppable. |

If no notification appears but the service worker shows no error, Windows is
hiding it: check Settings → System → Notifications (Google Chrome on, Do not
disturb off) and the notification center (Win+N).
