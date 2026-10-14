# Content script (isolated world)

Purpose: turn forwarded files into scan batches and send them to the offscreen
document. No UI.
Files: `src/content/index.ts` (entry, built to `content/content.js`, classic script), `encode.ts` (File → `SCAN_REQUEST`, base64), `scan-sender.ts` (port, replies, retry, `SCAN_INTERRUPTED`), `bridge.ts` (`openBridge`: MessageChannel, posts port2 with the marker, accepts only `File` instances), `batcher.ts`
Until 4.5: `index.ts` sends files from `<input type=file>` `change` events (capture phase); files from the bridge are only logged. 4.5 sends from the bridge and removes the change listener.
Design: `DESIGN.md` §3, §2 (message flows)

## Input
`File` objects from `main-world-hooks` over `MessageChannel`.

## Output
Port `chrome.runtime.connect({ name: 'scan-batch' })` → `SCAN_REQUEST` per file
(`docs/agents/protocol.md`).

## Behaviour
1. PDF = first 5 bytes `%PDF-`; others ignored.
2. Size > `maxFileSizeMB` → send name + size only, `skipped: 'FILE_TOO_LARGE'`.
3. Files within the same task / 300 ms → one batch (`batchId`), one port.
4. Bytes sent as base64.
5. Port closes before `BATCH_ACCEPTED` → `ENSURE_OFFSCREEN` to service worker →
   resend the batch once. Closes again before `BATCH_ACCEPTED`, or closes after
   `BATCH_ACCEPTED` but before `BATCH_DONE` → `SCAN_INTERRUPTED` to service
   worker. `BATCH_DONE` → finished. Never match Chrome's error text.

## Rules
- Treat data from the MAIN world as untrusted (must be `File`, size-checked).
- Never display anything in the page.

## Tests
`tests/browser/` (filter, batching), `tests/unit/` with `chrome-fake` (port, retry).
