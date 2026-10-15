# Content script (isolated world)

Purpose: turn forwarded files into scan batches and send them to the offscreen
document. No UI.
Files: `src/content/index.ts` (entry, built to `content/content.js`, classic script; builds the chrome.* deps only), `pipeline.ts` (`startContentScript(deps)`: bridge → batcher → PDF → size → encode → sender; all deps injected), `encode.ts` (File → `SCAN_REQUEST`, base64), `scan-sender.ts` (port, replies, retry, `SCAN_INTERRUPTED`), `bridge.ts` (`openBridge`: MessageChannel, posts port2 with the marker, accepts only `File` instances), `batcher.ts` (`createBatcher`: 300 ms window from the first file, ≤ 100), `pdf-filter.ts` (`isPdf`: first 5 bytes `%PDF-`; `keepPdfs`)
Design: `DESIGN.md` §3, §2 (message flows)

## Input
`File` objects from `main-world-hooks` over `MessageChannel`.

## Output
Port `chrome.runtime.connect({ name: 'scan-batch' })` → `SCAN_REQUEST` per file
(`docs/agents/protocol.md`).

## Behaviour
1. PDF = first 5 bytes `%PDF-`; others ignored.
2. Size > `maxFileSizeMB` (read from `chrome.storage.local` per batch; only
   this number is kept, never the APP-ID) → send name + size only,
   `skipped: 'FILE_TOO_LARGE'`.
3. Files within 300 ms of the first one → one batch (`batchId`), one port;
   a batch with no PDF sends nothing.
4. Bytes sent as base64.
5. Port closes before `BATCH_ACCEPTED`, or `BATCH_REJECTED` (document
   closing, D42) → `ENSURE_OFFSCREEN` to service worker → resend the batch once. Closes again before `BATCH_ACCEPTED`, or closes after
   `BATCH_ACCEPTED` but before `BATCH_DONE` → `SCAN_INTERRUPTED` to service
   worker. `BATCH_DONE` → finished. Never match Chrome's error text.

## Rules
- Treat data from the MAIN world as untrusted (must be `File`, size-checked).
- Never display anything in the page.

## Tests
`tests/browser/` (filter, batching), `tests/unit/` with `chrome-fake` (port, retry).
